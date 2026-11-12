import type { Message } from '@kairos/contracts';

function formatTime(date: Date): string {
  return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
}

export function timestampDate(timestamp: Message['createdAt']): Date | null {
  if (!timestamp) return null;
  const seconds = Number(timestamp.seconds);
  if (
    !Number.isSafeInteger(seconds) ||
    !Number.isInteger(timestamp.nanos) ||
    timestamp.nanos < 0 ||
    timestamp.nanos >= 1_000_000_000
  )
    return null;
  const date = new Date(seconds * 1000 + Math.floor(timestamp.nanos / 1_000_000));
  return Number.isFinite(date.getTime()) ? date : null;
}

export function calendarDateKey(date: Date): string {
  return `${date.getFullYear()}-${date.getMonth() + 1}-${date.getDate()}`;
}

export function formatCalendarDate(date: Date, now = new Date()): string {
  if (!Number.isFinite(date.getTime())) return '日期未知';
  // 使用本地日期对应的日序号，避免夏令时把一个日历日变为 23 或 25 小时。
  const day = (value: Date) =>
    Date.UTC(value.getFullYear(), value.getMonth(), value.getDate()) / 86_400_000;
  const elapsedDays = day(now) - day(date);
  if (elapsedDays === 0) return '今天';
  if (elapsedDays === 1) return '昨天';
  if (elapsedDays === 2) return '前天';
  const year = date.getFullYear() === now.getFullYear() ? '' : `${date.getFullYear()}年`;
  return `${year}${date.getMonth() + 1}月${date.getDate()}日`;
}

export function formatDateTime(date: Date, now = new Date()): string {
  if (!Number.isFinite(date.getTime())) return '时间未知';
  const time = formatTime(date);
  return calendarDateKey(date) === calendarDateKey(now)
    ? time
    : `${formatCalendarDate(date, now)} ${time}`;
}

export function formatMessageTime(timestamp: Message['createdAt'], now = new Date()): string {
  const date = timestampDate(timestamp);
  return date ? formatDateTime(date, now) : '时间未知';
}

export function formatAbsoluteDateTime(date: Date): string {
  return Number.isFinite(date.getTime())
    ? `${date.getFullYear()}年${date.getMonth() + 1}月${date.getDate()}日 ${formatTime(date)}`
    : '时间未知';
}
