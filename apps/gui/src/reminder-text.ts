export function stripLeadingReminders(text: string): string {
  let rest = text;
  while (rest.startsWith('<system-reminder>\n')) {
    const end = rest.indexOf('\n</system-reminder>');
    if (end === -1) return rest;
    rest = rest.slice(end + '\n</system-reminder>'.length).replace(/^\n+/, '');
  }
  return rest;
}

// 流式期间的变体：前导提醒块尚未闭合时整体隐藏，避免原文随增量闪现。
export function stripStreamingReminders(text: string): string {
  let rest = text;
  while (rest.startsWith('<system-reminder>\n')) {
    const end = rest.indexOf('\n</system-reminder>');
    if (end === -1) return '';
    rest = rest.slice(end + '\n</system-reminder>'.length).replace(/^\n+/, '');
  }
  return rest;
}
