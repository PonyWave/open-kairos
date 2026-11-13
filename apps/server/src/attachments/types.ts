import { z } from 'zod';

export const attachmentMediaTypeSchema = z.enum([
  'text/plain',
  'image/png',
  'image/jpeg',
  'application/octet-stream',
]);
export type AttachmentMediaType = z.infer<typeof attachmentMediaTypeSchema>;

export const attachmentMetadataSchema = z.object({
  attachmentId: z.string().min(1),
  fileName: z.string().min(1),
  mediaType: attachmentMediaTypeSchema,
  byteSize: z.number().int().positive().safe(),
  width: z.number().int().positive().safe().optional(),
  height: z.number().int().positive().safe().optional(),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  createdAt: z.string(),
  source: z.enum(['file', 'clipboard', 'channel']).optional(),
  workspaceRequired: z.boolean().optional(),
  workspaceStatus: z.enum(['pending', 'completed']).optional(),
  envId: z.string().min(1).optional(),
  path: z.string().min(1).optional(),
  operationId: z.string().min(1).optional(),
});

export interface AttachmentMetadata {
  attachmentId: string;
  fileName: string;
  mediaType: AttachmentMediaType;
  byteSize: number;
  width?: number | undefined;
  height?: number | undefined;
  sha256: string;
  createdAt: string;
  source?: 'file' | 'clipboard' | 'channel' | undefined;
  workspaceRequired?: boolean | undefined;
  workspaceStatus?: 'pending' | 'completed' | undefined;
  envId?: string | undefined;
  path?: string | undefined;
  operationId?: string | undefined;
}

export interface AttachmentContent extends AttachmentMetadata {
  ownerId: string;
  bytes: Uint8Array;
  sha256: string;
}
