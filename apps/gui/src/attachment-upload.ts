import {
  AttachmentSource,
  create,
  UploadAttachmentRequestSchema,
  validateUploadAttachmentRequest,
} from '@kairos/contracts';
import {
  type AttachmentMediaType,
  attachmentMetadata,
  maxAttachmentBytes,
  maxAttachmentsPerInput,
  maxAttachmentTotalBytes,
  maxTextAttachmentBytes,
} from './attachments.js';
import type { KairosClients } from './client.js';
import type { DraftAttachment, MessageDraft } from './drafts.js';
import { classifyActionFailure, formatClientError } from './errors.js';
import { randomId } from './random.js';

interface DraftAccess {
  getDraft: () => MessageDraft;
  updateDraft: (draft: MessageDraft) => void;
}

interface PreparedFile {
  bytes: Uint8Array;
  mediaType: AttachmentMediaType;
  sha256: string;
}

export class AttachmentUploader {
  private readonly inFlight = new Map<string, { generation: number; promise: Promise<void> }>();
  private readonly controllers = new Map<
    string,
    { generation: number; controller: AbortController }
  >();
  private generation = 0;
  private active = true;

  constructor(
    private readonly clients: Pick<KairosClients, 'attachments'>,
    private readonly drafts: DraftAccess,
    private readonly identity: { composerOwner: string; threadId: string },
  ) {}

  activate(): void {
    for (const entry of this.controllers.values()) entry.controller.abort();
    ++this.generation;
    this.active = true;
  }

  stop(): void {
    if (!this.active) return;
    this.active = false;
    ++this.generation;
    for (const entry of this.controllers.values()) entry.controller.abort();
  }

  async addFiles(
    files: readonly File[],
    options: { source?: 'clipboard' | undefined } = {},
  ): Promise<void> {
    const generation = this.generation;
    if (!this.isCurrent(generation) || files.length === 0) return;
    const draft = this.drafts.getDraft();
    const current = draft.attachments ?? [];
    if (current.length + files.length > maxAttachmentsPerInput) {
      throw new Error(`每条输入最多添加 ${maxAttachmentsPerInput} 个附件。`);
    }
    const currentBytes = current.reduce((total, item) => total + item.sizeBytes, 0);
    const addedBytes = files.reduce((total, file) => total + file.size, 0);
    if (currentBytes + addedBytes > maxAttachmentTotalBytes) {
      throw new Error(`附件总大小不能超过 ${maxAttachmentTotalBytes} 字节。`);
    }
    const items = files.map((file) => this.reserve(file, draft.id, options.source));
    await Promise.all(items.map((item) => this.prepareAndStart(item.localId, generation)));
  }

  async retry(localId: string): Promise<void> {
    const generation = this.generation;
    if (!this.isCurrent(generation)) return;
    const item = this.find(localId);
    if (!item || item.status === 'ready' || item.status === 'deleting') return;
    if (!item.file) {
      this.patch(localId, {
        status: item.actionId ? 'needs-reselection' : 'error',
        error: 'File 字节不在内存中，请重新选择同一文件。',
      });
      return;
    }
    if (item.actionId) {
      this.patch(localId, { status: 'uploading', error: undefined });
      await this.start(item.actionKey, generation);
      return;
    }
    await this.prepareAndStart(localId, generation);
  }

  async reselect(localId: string, file: File): Promise<void> {
    const generation = this.generation;
    if (!this.isCurrent(generation)) return;
    const item = this.find(localId);
    if (!item) return;
    const prepared = await prepareFile(file);
    if (!this.isCurrent(generation)) return;
    if (
      file.name !== item.fileName ||
      file.type !== item.declaredMediaType ||
      file.size !== item.sizeBytes ||
      (item.sha256 !== undefined && item.sha256 !== prepared.sha256)
    ) {
      throw new Error(
        '重新选择的文件与原文件的名称、声明类型、大小或 SHA-256 不一致，未发出核对请求。',
      );
    }
    this.patch(localId, {
      file,
      sha256: prepared.sha256,
      status: 'uploading',
      error: undefined,
      ...(item.actionId ? {} : { actionId: randomId() }),
    });
    await this.start(item.actionKey, generation);
  }

  removeLocal(localId: string): void {
    if (!this.isCurrent(this.generation)) return;
    const item = this.find(localId);
    if (!item) return;
    if (item.status !== 'error' && item.status !== 'reading') {
      throw new Error('上传结果尚未明确，不能直接移除；请先完成核对。');
    }
    const draft = this.drafts.getDraft();
    this.drafts.updateDraft({
      ...draft,
      attachments: (draft.attachments ?? []).filter((attachment) => attachment.localId !== localId),
    });
  }

  private reserve(file: File, draftId: string, source?: 'clipboard' | undefined): DraftAttachment {
    const draft = this.drafts.getDraft();
    if (draft.id !== draftId) throw new Error('草稿已变化，请重新选择文件。');
    const localId = randomId();
    const item: DraftAttachment = {
      localId,
      actionKey: `upload-attachment:${this.identity.composerOwner}:${this.identity.threadId}:${draft.id}:${localId}`,
      fileName: file.name,
      declaredMediaType: file.type,
      sizeBytes: file.size,
      ...(source === undefined ? {} : { source }),
      status: 'reading',
      file,
    };
    this.drafts.updateDraft({ ...draft, attachments: [...(draft.attachments ?? []), item] });
    return item;
  }

  private async prepareAndStart(localId: string, generation: number): Promise<void> {
    if (!this.isCurrent(generation)) return;
    const item = this.find(localId);
    if (!item?.file) return;
    try {
      const prepared = await prepareFile(item.file);
      if (!this.isCurrent(generation)) return;
      const duplicate = (this.drafts.getDraft().attachments ?? []).find(
        (candidate) => candidate.localId !== localId && candidate.sha256 === prepared.sha256,
      );
      if (duplicate) throw new Error('相同内容的文件在当前草稿中只能添加一次。');
      const actionId = item.actionId ?? randomId();
      const updated = this.patch(
        localId,
        {
          sha256: prepared.sha256,
          actionId,
          status: 'uploading',
          error: undefined,
        },
        undefined,
        generation,
      );
      if (!updated) return;
      await this.start(updated.actionKey, generation);
    } catch (cause) {
      if (!this.isCurrent(generation)) return;
      this.patch(
        localId,
        {
          status: 'error',
          actionId: undefined,
          error: formatClientError(cause),
        },
        undefined,
        generation,
      );
    }
  }

  private start(actionKey: string, generation: number): Promise<void> {
    if (!this.isCurrent(generation)) return Promise.resolve();
    const existing = this.inFlight.get(actionKey);
    if (existing?.generation === generation) return existing.promise;
    const controller = new AbortController();
    const promise = this.perform(actionKey, generation, controller.signal).finally(() => {
      if (this.inFlight.get(actionKey)?.promise !== promise) return;
      this.inFlight.delete(actionKey);
      this.controllers.delete(actionKey);
    });
    this.inFlight.set(actionKey, { generation, promise });
    this.controllers.set(actionKey, { generation, controller });
    return promise;
  }

  private async perform(actionKey: string, generation: number, signal: AbortSignal): Promise<void> {
    if (!this.isCurrent(generation)) return;
    const item = (this.drafts.getDraft().attachments ?? []).find(
      (attachment) => attachment.actionKey === actionKey,
    );
    if (!item) return;
    if (!item.file || !item.actionId || !item.sha256) {
      this.patch(
        item.localId,
        {
          status: item.actionId ? 'needs-reselection' : 'error',
          error: '上传所需的 File 字节或操作编号缺失，未发送请求。',
        },
        undefined,
        generation,
      );
      return;
    }
    const localId = item.localId;
    const actionId = item.actionId;
    try {
      const data = new Uint8Array(await item.file.arrayBuffer());
      if (!this.isCurrent(generation)) return;
      const request = create(UploadAttachmentRequestSchema, {
        clientActionId: actionId,
        fileName: item.fileName,
        declaredMediaType: item.declaredMediaType,
        data,
        source: item.source === 'clipboard' ? AttachmentSource.CLIPBOARD : AttachmentSource.FILE,
      });
      validateUploadAttachmentRequest(request);
      const response = await this.clients.attachments.uploadAttachment(request, { signal });
      if (!this.isCurrent(generation)) return;
      if (response.clientActionId !== actionId || !response.attachment) {
        throw new Error('UploadAttachment 响应缺少匹配的操作编号或附件元数据。');
      }
      const metadata = attachmentMetadata(response.attachment);
      if (metadata.sha256 !== item.sha256 || metadata.sizeBytes !== BigInt(data.length)) {
        throw new Error('UploadAttachment 返回的附件指纹与本地文件不一致。');
      }
      this.patch(
        localId,
        { status: 'ready', metadata, file: undefined, error: undefined },
        actionId,
        generation,
      );
    } catch (cause) {
      if (!this.isCurrent(generation)) return;
      const outcome = classifyActionFailure(cause);
      this.patch(
        localId,
        {
          status: outcome === 'unknown' ? 'unknown' : 'error',
          ...(outcome === 'unknown' ? {} : { actionId: undefined }),
          error:
            outcome === 'unknown'
              ? `${formatClientError(cause)} 上传结果未知；重试沿用原操作编号，刷新后须重新选择同一文件。`
              : formatClientError(cause),
        },
        actionId,
        generation,
      );
    }
  }

  private isCurrent(generation: number): boolean {
    return this.active && generation === this.generation;
  }

  private find(localId: string): DraftAttachment | undefined {
    return (this.drafts.getDraft().attachments ?? []).find((item) => item.localId === localId);
  }

  private patch(
    localId: string,
    patch: Partial<DraftAttachment>,
    actionId?: string,
    generation = this.generation,
  ): DraftAttachment | undefined {
    if (!this.isCurrent(generation)) return undefined;
    const draft = this.drafts.getDraft();
    let updated: DraftAttachment | undefined;
    const attachments = (draft.attachments ?? []).map((item) => {
      if (item.localId !== localId || (actionId !== undefined && item.actionId !== actionId)) {
        return item;
      }
      updated = { ...item, ...patch };
      return updated;
    });
    if (!updated) return undefined;
    this.drafts.updateDraft({ ...draft, attachments });
    return updated;
  }
}

async function prepareFile(file: File): Promise<PreparedFile> {
  validateFileName(file.name);
  if (
    !/^[A-Za-z0-9][A-Za-z0-9!#$&^_.+-]*\/[A-Za-z0-9][A-Za-z0-9!#$&^_.+-]*$/.test(file.type) &&
    file.type !== ''
  ) {
    throw new Error(`文件 ${file.name} 的声明 MIME 类型无效。`);
  }
  if (file.size === 0) throw new Error(`文件 ${file.name} 为空，Server 不接受空附件。`);
  if (file.size > maxAttachmentBytes) {
    throw new Error(`文件 ${file.name} 超过 ${maxAttachmentBytes} 字节限制。`);
  }
  const bytes = new Uint8Array(await file.arrayBuffer());
  if (bytes.length !== file.size)
    throw new Error(`文件 ${file.name} 的字节数发生变化，请重新选择。`);
  const mediaType = detectMediaType(bytes, file.name);
  if (mediaType === 'text/plain' && bytes.length > maxTextAttachmentBytes) {
    throw new Error(`文本附件 ${file.name} 超过 ${maxTextAttachmentBytes} 字节限制。`);
  }
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  const sha256 = Array.from(new Uint8Array(digest), (value) =>
    value.toString(16).padStart(2, '0'),
  ).join('');
  return { bytes, mediaType, sha256 };
}

function detectMediaType(bytes: Uint8Array, fileName: string): AttachmentMediaType {
  const pngSignature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (pngSignature.every((value, index) => bytes[index] === value)) return 'image/png';
  if (bytes[0] === 0xff && bytes[1] === 0xd8) return 'image/jpeg';
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch (cause) {
    throw new Error(`文件 ${fileName} 不是严格 UTF-8 文本、PNG 或 JPEG。`, { cause });
  }
  if (text.includes('\0')) throw new Error(`文本附件 ${fileName} 包含 NUL。`);
  return 'text/plain';
}

function validateFileName(fileName: string): void {
  if (
    !fileName.trim() ||
    fileName.length > 255 ||
    fileName.includes('/') ||
    fileName.includes('\\') ||
    [...fileName].some((character) => {
      const code = character.charCodeAt(0);
      return code <= 0x1f || code === 0x7f;
    })
  ) {
    throw new Error('附件文件名必须是 1–255 个字符的纯文件名，不能包含路径或控制字符。');
  }
}
