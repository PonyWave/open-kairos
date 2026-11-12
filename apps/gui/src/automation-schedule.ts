export type AutomationRepeat =
  | 'daily'
  | 'weekdays'
  | 'weekends'
  | 'weekly'
  | 'monthly'
  | 'hourly'
  | 'once'
  | 'custom';

export interface AutomationTiming {
  repeat: AutomationRepeat;
  time: string;
  weekdays: number[];
  monthDay: string;
  hourlyMinute: string;
  cronExpression: string;
}

export const automationRepeatOptions = [
  { value: 'daily', label: '每天' },
  { value: 'weekdays', label: '工作日（周一至周五）' },
  { value: 'weekends', label: '周末' },
  { value: 'weekly', label: '每周' },
  { value: 'monthly', label: '每月' },
  { value: 'hourly', label: '每小时' },
  { value: 'once', label: '单次执行' },
] satisfies { value: AutomationRepeat; label: string }[];

export const automationWeekdays = [
  { value: 1, label: '周一' },
  { value: 2, label: '周二' },
  { value: 3, label: '周三' },
  { value: 4, label: '周四' },
  { value: 5, label: '周五' },
  { value: 6, label: '周六' },
  { value: 0, label: '周日' },
];

export function parseAutomationCron(expression: string): AutomationTiming {
  const value: AutomationTiming = {
    repeat: 'custom',
    time: '09:00',
    weekdays: [1],
    monthDay: '1',
    hourlyMinute: '0',
    cronExpression: expression,
  };
  const fields = expression.trim().split(/\s+/);
  if (fields.length !== 5) return value;
  const [minute, hour, day, month, weekday] = fields;
  if (!isIntegerField(minute, 0, 59) || month !== '*') return value;
  value.hourlyMinute = String(Number(minute));
  if (hour === '*' && day === '*' && weekday === '*') {
    value.repeat = 'hourly';
    return value;
  }
  if (!isIntegerField(hour, 0, 23)) return value;
  value.time = `${String(Number(hour)).padStart(2, '0')}:${String(Number(minute)).padStart(2, '0')}`;
  if (isIntegerField(day, 1, 31) && weekday === '*') {
    value.repeat = 'monthly';
    value.monthDay = String(Number(day));
  } else if (day === '*' && weekday === '*') {
    value.repeat = 'daily';
  } else if (day === '*' && weekday) {
    const days = parseWeekdays(weekday);
    if (!days) return value;
    value.weekdays = days;
    const key = days.join(',');
    value.repeat =
      key === '1,2,3,4,5'
        ? 'weekdays'
        : key === '0,6'
          ? 'weekends'
          : key === '0,1,2,3,4,5,6'
            ? 'daily'
            : 'weekly';
  }
  return value;
}

export function automationCronExpression(value: AutomationTiming): string {
  const expression = buildCron(value);
  // 保留等价原文，避免只修改名称或 prompt 时重置 Server 调度游标。
  const original = parseAutomationCron(value.cronExpression);
  if (original.repeat !== 'custom' && buildCron(original) === expression) {
    return value.cronExpression;
  }
  return expression;
}

export function automationRepeatLabel(repeat: AutomationRepeat): string {
  return automationRepeatOptions.find((option) => option.value === repeat)?.label ?? '自定义重复';
}

export function automationCronText(expression: string): string {
  const value = parseAutomationCron(expression);
  switch (value.repeat) {
    case 'hourly':
      return `每小时第 ${value.hourlyMinute} 分钟`;
    case 'weekly':
      return `每周${automationWeekdays
        .filter((day) => value.weekdays.includes(day.value))
        .map((day) => day.label.slice(1))
        .join('、')} ${value.time}`;
    case 'monthly':
      return `每月 ${value.monthDay} 日 ${value.time}`;
    case 'custom':
      return '自定义重复规则';
    default:
      return `${automationRepeatLabel(value.repeat)} ${value.time}`;
  }
}

function buildCron(value: AutomationTiming): string {
  if (value.repeat === 'custom') {
    if (!value.cronExpression.trim()) throw new Error('原重复规则缺失，请重新选择重复方式。');
    return value.cronExpression;
  }
  if (value.repeat === 'hourly') {
    if (!isIntegerField(value.hourlyMinute, 0, 59)) throw new Error('请选择有效的分钟。');
    return `${Number(value.hourlyMinute)} * * * *`;
  }
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(value.time)) {
    throw new Error('请选择有效的执行时间。');
  }
  const [hour, minute] = value.time.split(':').map(Number);
  const prefix = `${minute} ${hour}`;
  switch (value.repeat) {
    case 'daily':
      return `${prefix} * * *`;
    case 'weekdays':
      return `${prefix} * * 1-5`;
    case 'weekends':
      return `${prefix} * * 0,6`;
    case 'weekly': {
      if (
        value.weekdays.length === 0 ||
        value.weekdays.some((day) => !Number.isInteger(day) || day < 0 || day > 6)
      ) {
        throw new Error('请至少选择一个星期。');
      }
      return `${prefix} * * ${[...new Set(value.weekdays)].sort().join(',')}`;
    }
    case 'monthly':
      if (!isIntegerField(value.monthDay, 1, 31)) throw new Error('请选择每月的执行日期。');
      return `${prefix} ${Number(value.monthDay)} * *`;
    default:
      throw new Error('重复方式无效。');
  }
}

function isIntegerField(value: string | undefined, minimum: number, maximum: number): boolean {
  return (
    value !== undefined &&
    /^\d{1,2}$/.test(value) &&
    Number(value) >= minimum &&
    Number(value) <= maximum
  );
}

function parseWeekdays(field: string): number[] | null {
  const days = new Set<number>();
  for (const part of field.split(',')) {
    const range = part.split('-');
    if (range.length > 2 || range.some((item) => !isIntegerField(item, 0, 7))) return null;
    const first = Number(range[0]);
    const last = Number(range[1] ?? first);
    if (first > last) return null;
    for (let day = first; day <= last; day += 1) days.add(day === 7 ? 0 : day);
  }
  return [...days].sort();
}
