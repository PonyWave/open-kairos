import { z } from 'zod';
import type { ChannelReference } from '../context/types.js';

export const channelReferenceSchema = z
  .object({
    channel: z.enum(['wechat', 'feishu']),
    kind: z.enum(['inbound', 'delivery_failure']),
    externalMessageId: z.string().min(1).nullish(),
    deliveryId: z.string().min(1).nullish(),
    quoteSeq: z.number().int().positive().nullish(),
    quoteExcerpt: z.string().min(1).max(500).nullish(),
  })
  .strict();

export function parseChannelJson(value: string | null | undefined): ChannelReference | null {
  if (value === null || value === undefined) return null;
  return channelReferenceSchema.parse(JSON.parse(value));
}

export function channelJsonText(channel: ChannelReference | null | undefined): string | null {
  if (channel === null || channel === undefined) return null;
  return JSON.stringify(channelReferenceSchema.parse(channel));
}
