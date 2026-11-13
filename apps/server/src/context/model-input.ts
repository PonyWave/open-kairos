import type { ModelMessage } from '@kairos/agent-core';
import { mergeRecapText } from '../recap/selection.js';
import type { Recap } from '../recap/types.js';
import { wrapSystemReminder } from '../sessions/system-reminder.js';
import type { ContextMessage } from './types.js';
import { currentModelMessage } from './types.js';

export function buildModelMessages(input: {
  systemInstructions: readonly string[];
  recaps: readonly Recap[];
  contextMessages: readonly ContextMessage[];
  pendingMessages: readonly ModelMessage[];
}): ModelMessage[] {
  const messages: ModelMessage[] = input.systemInstructions.map((content) => ({
    role: 'system',
    content,
  }));
  if (input.recaps.length > 0) {
    messages.push({ role: 'user', content: mergeRecapText(input.recaps) });
  }
  messages.push(...input.contextMessages.map(currentModelMessageWithMeta));
  messages.push(...input.pendingMessages);
  return messages;
}

export function currentModelMessageWithMeta(record: ContextMessage): ModelMessage {
  const message = currentModelMessage(record);
  if (message.role !== 'user' && message.role !== 'assistant') return message;
  return {
    ...message,
    content: `${wrapSystemReminder(messageMetaTag(record))}\n\n${message.content}`,
  };
}

function xmlEscape(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

export function messageQuoteTag(record: ContextMessage): string | undefined {
  const channel = record.channel;
  if (channel === null || channel === undefined) return undefined;
  if (channel.quoteExcerpt === null || channel.quoteExcerpt === undefined) return undefined;
  const seq =
    channel.quoteSeq === null || channel.quoteSeq === undefined ? '' : ` seq="${channel.quoteSeq}"`;
  return `<ref${seq}>${xmlEscape(channel.quoteExcerpt)}</ref>`;
}

export function messageMetaTag(record: ContextMessage): string {
  const from = messageOrigin(record);
  const quote = messageQuoteTag(record);
  return `<msg seq="${record.seq}" time="${localTimeWithOffset(record.createdAt)}"${from === undefined ? '' : ` from="${from}"`}/>${quote === undefined ? '' : `\n${quote}`}`;
}

export function messageMetaReminder(input: {
  seq: number;
  createdAt: string;
  from?: string;
}): string {
  return wrapSystemReminder(
    `<msg seq="${input.seq}" time="${localTimeWithOffset(input.createdAt)}"${input.from === undefined ? '' : ` from="${input.from}"`}/>`,
  );
}

function messageOrigin(record: ContextMessage): string | undefined {
  if (record.message.role !== 'user') return undefined;
  const source = record.source ?? 'user';
  if (source === 'channel') return record.channel?.channel;
  return source === 'user' ? 'app' : undefined;
}

function localTimeWithOffset(isoTime: string): string {
  const date = new Date(isoTime);
  const offsetMinutes = -date.getTimezoneOffset();
  const sign = offsetMinutes >= 0 ? '+' : '-';
  const absolute = Math.abs(offsetMinutes);
  const pad = (value: number) => String(value).padStart(2, '0');
  const datePart = `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
  const timePart = `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
  return `${datePart}T${timePart}${sign}${pad(Math.floor(absolute / 60))}:${pad(absolute % 60)}`;
}

const messageMetaPattern =
  /^<system-reminder>\n<msg seq="\d+" time="[^"]+"(?: from="(?:app|wechat|feishu)")?\/>\n<\/system-reminder>\n\n/;

export function stripMessageMeta(content: string): string {
  return content.replace(messageMetaPattern, '');
}
