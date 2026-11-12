const PREFIX = '<system-reminder>\n';
const SUFFIX = '\n</system-reminder>';

export function wrapSystemReminder(content: string): string {
  return `${PREFIX}${content.trim()}${SUFFIX}`;
}

export function systemReminderContent(text: string): string | undefined {
  if (!text.startsWith(PREFIX) || !text.endsWith(SUFFIX)) return undefined;
  return text.slice(PREFIX.length, text.length - SUFFIX.length);
}
