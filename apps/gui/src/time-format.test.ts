import { create, ThreadSchema } from '@kairos/contracts';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MessageAvatar } from './message-avatar.js';
import { TopicCard } from './thread-list-page.js';
import {
  formatAbsoluteDateTime,
  formatCalendarDate,
  formatDateTime,
  formatMessageTime,
  timestampDate,
} from './time-format.js';

const now = new Date(2026, 10, 6, 12, 30);
const timestamp = (date: Date) => ({
  $typeName: 'google.protobuf.Timestamp' as const,
  seconds: BigInt(Math.floor(date.getTime() / 1000)),
  nanos: 0,
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

describe('time display', () => {
  it('shows only hours and minutes today, including midnight', () => {
    expect(formatDateTime(new Date(2026, 10, 6, 9, 5), now)).toBe('09:05');
    expect(formatDateTime(new Date(2026, 10, 6, 0, 0), now)).toBe('00:00');
    expect(formatCalendarDate(now, now)).toBe('今天');
  });

  it('uses yesterday and the day before yesterday with the original time', () => {
    expect(formatDateTime(new Date(2026, 10, 5, 9, 5), now)).toBe('昨天 09:05');
    expect(formatDateTime(new Date(2026, 10, 4, 18, 40), now)).toBe('前天 18:40');
    expect(formatCalendarDate(new Date(2026, 10, 5), now)).toBe('昨天');
    expect(formatCalendarDate(new Date(2026, 10, 4), now)).toBe('前天');
  });

  it('uses a date for earlier days and includes the year across years', () => {
    expect(formatDateTime(new Date(2026, 10, 3, 9, 5), now)).toBe('11月3日 09:05');
    expect(formatDateTime(new Date(2025, 10, 3, 9, 5), now)).toBe('2025年11月3日 09:05');
    expect(formatCalendarDate(new Date(2025, 10, 3), now)).toBe('2025年11月3日');
    expect(formatDateTime(new Date(2026, 10, 7, 9, 5), now)).toBe('11月7日 09:05');
  });

  it('compares local calendar dates across midnight, month and year boundaries', () => {
    const newYear = new Date(2027, 0, 1, 0, 1);
    expect(formatDateTime(new Date(2026, 11, 31, 23, 59), newYear)).toBe('昨天 23:59');
    expect(formatCalendarDate(new Date(2026, 11, 30), newYear)).toBe('前天');
    expect(formatCalendarDate(new Date(2026, 1, 28), new Date(2026, 2, 1))).toBe('昨天');
  });

  it('compares calendar days during both daylight saving transitions', () => {
    vi.stubEnv('TZ', 'America/New_York');
    expect(formatCalendarDate(new Date(2026, 2, 7, 23), new Date(2026, 2, 9, 0))).toBe('前天');
    expect(formatCalendarDate(new Date(2026, 9, 31, 23), new Date(2026, 10, 2, 0))).toBe('前天');
  });

  it('validates timestamps and retains nanosecond precision to milliseconds', () => {
    const value = { ...timestamp(now), nanos: 123_000_000 };
    expect(timestampDate(value)?.getTime()).toBe(now.getTime() + 123);
    expect(formatMessageTime(timestamp(new Date(2026, 10, 6, 9, 5)), now)).toBe('09:05');
    for (const value of [
      undefined,
      { ...timestamp(now), seconds: 10n ** 30n },
      { ...timestamp(now), seconds: 9_000_000_000_000n },
      { ...timestamp(now), nanos: -1 },
      { ...timestamp(now), nanos: 1_000_000_000 },
    ]) {
      expect(timestampDate(value)).toBeNull();
      expect(formatMessageTime(value, now)).toBe('时间未知');
    }
    expect(formatDateTime(new Date('invalid'), now)).toBe('时间未知');
  });

  it('uses the same relative display in message avatars and topic cards with exact tooltips', () => {
    vi.useFakeTimers();
    vi.setSystemTime(now);
    const createdAt = timestamp(new Date(2026, 10, 5, 9, 5));
    const avatar = renderToStaticMarkup(
      createElement(MessageAvatar, { label: '用户', timestamp: createdAt, user: true }),
    );
    const card = renderToStaticMarkup(
      createElement(TopicCard, {
        card: {
          thread: create(ThreadSchema, { threadId: 'topic-1', title: '时间显示' }),
          createdAt,
          lastMessageAt: createdAt,
          replies: [],
          origin: null,
        },
        sort: 'lastMessageAt',
        onOpen: () => {},
      }),
    );
    for (const html of [avatar, card]) {
      expect(html).toContain('昨天 09:05');
      expect(html).toContain('title="2026年11月5日 09:05"');
      expect(html).toContain(`dateTime="${timestampDate(createdAt)?.toISOString()}"`);
    }
    expect(formatAbsoluteDateTime(new Date(2026, 10, 5, 9, 5))).toBe('2026年11月5日 09:05');
  });
});
