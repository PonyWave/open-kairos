const leadingReminderBlock = /^<system-reminder>\n[\s\S]*?\n<\/system-reminder>\n\n?/;
const reminderBlock = /^<system-reminder>\n([\s\S]*?)\n<\/system-reminder>/;

// 用户侧消息持久化内容可能带有服务端注入的提醒包装（定时触发说明、投递记录等）。
// 以下两个函数只用于界面展示，不改变存储内容。
export function stripLeadingReminderBlocks(text: string): string {
  let rest = text;
  while (leadingReminderBlock.test(rest)) rest = rest.replace(leadingReminderBlock, '');
  return rest;
}

export function reminderBlockBody(text: string): string | null {
  return reminderBlock.exec(text)?.[1] ?? null;
}
