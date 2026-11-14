import { type Message, MessageRole, ToolResultStatus } from '@kairos/contracts';

export interface SentDelivery {
  channel: 'wechat' | 'feishu';
  deliveryId: string;
  status: 'queued' | 'failed';
  error?: string;
}

export interface ChannelDeliveryStatusInfo {
  status: 'pending' | 'delivering' | 'succeeded' | 'failed';
  errorMessage: string;
}

export interface SentUserMessage {
  content: string;
  endTurn: boolean;
  deliveries: SentDelivery[];
}

function parseDeliveries(value: unknown): SentDelivery[] {
  if (!Array.isArray(value)) return [];
  const deliveries: SentDelivery[] = [];
  for (const entry of value) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue;
    const channel = Reflect.get(entry, 'channel');
    const deliveryId = Reflect.get(entry, 'delivery_id');
    const status = Reflect.get(entry, 'status');
    if (
      (channel !== 'wechat' && channel !== 'feishu') ||
      typeof deliveryId !== 'string' ||
      deliveryId.length === 0 ||
      (status !== 'queued' && status !== 'failed')
    ) {
      continue;
    }
    const error = Reflect.get(entry, 'error');
    deliveries.push({
      channel,
      deliveryId,
      status,
      ...(typeof error === 'string' && error.length > 0 ? { error } : {}),
    });
  }
  return deliveries;
}

export function sentContentFromArguments(argumentsJson: string): string | undefined {
  try {
    const args: unknown = JSON.parse(argumentsJson);
    if (!args || typeof args !== 'object' || Array.isArray(args)) return undefined;
    const content: unknown = Reflect.get(args, 'content');
    return typeof content === 'string' && content.trim() ? content : undefined;
  } catch {
    return undefined;
  }
}

export function sentUserMessage(
  message: Message,
  argumentsContent?: string,
): SentUserMessage | null {
  if (
    message.role !== MessageRole.TOOL ||
    message.agentId !== 'thread' ||
    message.toolName !== 'send_to_user' ||
    message.toolStatus !== ToolResultStatus.SUCCESS ||
    !message.toolCallId ||
    message.supersededByRunId
  ) {
    return null;
  }
  try {
    const result: unknown = JSON.parse(message.content);
    if (
      !result ||
      typeof result !== 'object' ||
      Array.isArray(result) ||
      Reflect.get(result, 'status') !== 'sent'
    ) {
      return null;
    }
    const resultContent: unknown = Reflect.get(result, 'content');
    const content =
      typeof resultContent === 'string' && resultContent.trim() ? resultContent : argumentsContent;
    const endTurn: unknown = Reflect.get(result, 'end_turn');
    if (typeof content !== 'string' || !content.trim() || typeof endTurn !== 'boolean') {
      return null;
    }
    return { content, endTurn, deliveries: parseDeliveries(Reflect.get(result, 'deliveries')) };
  } catch {
    return null;
  }
}
