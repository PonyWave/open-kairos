import {
  type Automation,
  type AutomationFire,
  AutomationFireStatus,
  AutomationScheduleKind,
  AutomationTargetKind,
  AutomationTrigger,
} from '@kairos/contracts';
import {
  type AutomationTiming,
  automationCronExpression,
  automationCronText,
  parseAutomationCron,
} from './automation-schedule.js';

type ProtoTimestamp = NonNullable<Automation['createdAt']>;

export interface AutomationSchedulePayload {
  kind: AutomationScheduleKind;
  cronExpression?: string;
  timeZone: string;
  runAt?: string;
}

export interface AutomationTargetPayload {
  kind: AutomationTargetKind;
  threadId?: string;
  allowedEnv?: string[];
}

export interface AutomationDefinitionPayload {
  name: string;
  prompt: string;
  schedule: AutomationSchedulePayload;
  target: AutomationTargetPayload;
  enabled: boolean;
}

export interface AutomationFormValue extends AutomationTiming {
  name: string;
  prompt: string;
  timeZone: string;
  runAtLocal: string;
  targetKind: AutomationTargetKind;
  targetThreadId: string;
  allowedEnv?: string[] | undefined;
  enabled: boolean;
}

export function browserTimeZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
}

export function newAutomationForm(timeZone = browserTimeZone()): AutomationFormValue {
  return {
    name: '',
    prompt: '',
    ...parseAutomationCron('0 9 * * *'),
    timeZone,
    runAtLocal: zonedInputValue(new Date(Date.now() + 3_600_000), timeZone),
    targetKind: AutomationTargetKind.MAIN,
    targetThreadId: '',
    enabled: true,
  };
}

export function automationFormValue(automation: Automation): AutomationFormValue {
  const schedule = automation.schedule;
  const timeZone = schedule?.timeZone || browserTimeZone();
  return {
    name: automation.name,
    prompt: automation.prompt,
    ...parseAutomationCron(schedule?.cronExpression ?? '0 9 * * *'),
    ...(schedule?.kind === AutomationScheduleKind.ONCE ? { repeat: 'once' as const } : {}),
    timeZone,
    runAtLocal: schedule?.runAt
      ? zonedInputValue(new Date(timestampMilliseconds(schedule.runAt)), timeZone)
      : zonedInputValue(new Date(Date.now() + 3_600_000), timeZone),
    targetKind: automation.target?.kind ?? AutomationTargetKind.MAIN,
    targetThreadId: automation.target?.threadId ?? '',
    allowedEnv: automation.target?.environmentPolicy
      ? [...automation.target.environmentPolicy.allowedEnv]
      : undefined,
    enabled: automation.enabled,
  };
}

export function automationDefinitionPayload(
  form: AutomationFormValue,
): AutomationDefinitionPayload {
  const name = form.name.trim();
  const timeZone = form.timeZone.trim();
  if (!name) throw new Error('请输入定时任务名称。');
  if (!form.prompt.trim()) throw new Error('请输入每次执行时提交的 prompt。');
  if (!timeZone) throw new Error('请输入 IANA 时区，例如 Asia/Shanghai。');
  assertTimeZone(timeZone);
  const schedule: AutomationSchedulePayload =
    form.repeat === 'once'
      ? {
          kind: AutomationScheduleKind.ONCE,
          runAt: zonedDateTimeToIso(form.runAtLocal, timeZone),
          timeZone,
        }
      : {
          kind: AutomationScheduleKind.CRON,
          cronExpression: automationCronExpression(form),
          timeZone,
        };
  if (
    form.targetKind !== AutomationTargetKind.MAIN &&
    form.targetKind !== AutomationTargetKind.EXISTING_THREAD &&
    form.targetKind !== AutomationTargetKind.NEW_TASK &&
    form.targetKind !== AutomationTargetKind.NEW_AUTOMATION_ONLY
  ) {
    throw new Error('执行目标类型无效。');
  }
  if (form.targetKind === AutomationTargetKind.EXISTING_THREAD && !form.targetThreadId) {
    throw new Error('请选择已有话题。');
  }
  return {
    name,
    prompt: form.prompt,
    schedule,
    target: {
      kind: form.targetKind,
      ...(form.targetKind === AutomationTargetKind.EXISTING_THREAD
        ? { threadId: form.targetThreadId }
        : {}),
      ...(form.allowedEnv ? { allowedEnv: [...form.allowedEnv] } : {}),
    },
    enabled: form.enabled,
  };
}

export function timestampFromIso(value: string): ProtoTimestamp {
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds)) throw new Error('单次执行时间无效。');
  const wholeMilliseconds = Math.trunc(milliseconds);
  return {
    $typeName: 'google.protobuf.Timestamp',
    seconds: BigInt(Math.floor(wholeMilliseconds / 1000)),
    nanos: (wholeMilliseconds - Math.floor(wholeMilliseconds / 1000) * 1000) * 1_000_000,
  };
}

export function zonedDateTimeToIso(localValue: string, timeZone: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/.exec(localValue);
  if (!match) throw new Error('请选择有效的单次执行时间。');
  const values = match.slice(1).map((part) => Number(part ?? 0));
  const [year, month, day, hour, minute, second] = values;
  if (
    year === undefined ||
    month === undefined ||
    day === undefined ||
    hour === undefined ||
    minute === undefined ||
    second === undefined ||
    hour > 23 ||
    minute > 59 ||
    second > 59
  ) {
    throw new Error('单次执行时间无效。');
  }
  const desired = Date.UTC(year, month - 1, day, hour, minute, second);
  const calendar = new Date(desired);
  if (
    calendar.getUTCFullYear() !== year ||
    calendar.getUTCMonth() !== month - 1 ||
    calendar.getUTCDate() !== day
  ) {
    throw new Error('单次执行日期无效。');
  }
  assertTimeZone(timeZone);
  let guess = desired;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const actual = zonedParts(new Date(guess), timeZone);
    const next = desired - (actual - guess);
    if (next === guess) break;
    guess = next;
  }
  if (zonedParts(new Date(guess), timeZone) !== desired) {
    throw new Error('该时区不存在所选本地时间，请调整执行时间。');
  }
  return new Date(guess).toISOString();
}

export function zonedInputValue(date: Date, timeZone: string): string {
  if (!Number.isFinite(date.getTime())) return '';
  assertTimeZone(timeZone);
  const parts = zonedDateTimeParts(date, timeZone);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}T${values.hour}:${values.minute}`;
}

export function automationScheduleText(automation: Automation): string {
  const schedule = automation.schedule;
  if (!schedule) return '定时规则未设置';
  if (schedule.kind === AutomationScheduleKind.CRON) {
    return `${automationCronText(schedule.cronExpression ?? '')} · ${schedule.timeZone}`;
  }
  if (schedule.kind === AutomationScheduleKind.ONCE && schedule.runAt) {
    return `单次执行 ${zonedDisplay(schedule.runAt, schedule.timeZone)} · ${schedule.timeZone}`;
  }
  return '定时规则无效';
}

export function automationTargetText(kind: AutomationTargetKind | undefined): string {
  switch (kind) {
    case AutomationTargetKind.MAIN:
      return '主对话';
    case AutomationTargetKind.EXISTING_THREAD:
      return '已有话题';
    case AutomationTargetKind.NEW_TASK:
      return '每次新建任务对话';
    case AutomationTargetKind.NEW_AUTOMATION_ONLY:
      return '每次新建一次性对话';
    default:
      return '目标未知';
  }
}

export function automationFireStatusText(status: AutomationFireStatus): string {
  switch (status) {
    case AutomationFireStatus.QUEUED:
      return '排队中';
    case AutomationFireStatus.RUNNING:
      return '执行中';
    case AutomationFireStatus.COMPLETED:
      return '已完成';
    case AutomationFireStatus.FAILED:
      return '失败';
    case AutomationFireStatus.CANCELLED:
      return '已取消';
    case AutomationFireStatus.INTERRUPTED:
      return '已中断';
    default:
      return '状态未知';
  }
}

export function automationTriggerText(trigger: AutomationTrigger): string {
  switch (trigger) {
    case AutomationTrigger.SCHEDULED:
      return '定时触发';
    case AutomationTrigger.RUN_NOW:
      return '立即执行';
    default:
      return '来源未知';
  }
}

export function automationTimestampText(timestamp: ProtoTimestamp | undefined): string {
  if (!timestamp) return '时间未知';
  return zonedDisplay(timestamp, browserTimeZone());
}

export function requireAutomation(value: Automation | undefined): Automation {
  if (
    !value?.scheduleId ||
    !value.name ||
    typeof value.prompt !== 'string' ||
    typeof value.seq !== 'bigint' ||
    typeof value.version !== 'bigint' ||
    value.version < 1n ||
    !value.schedule ||
    !value.target
  ) {
    throw new Error('Automation 响应缺少有效定义。');
  }
  if (
    value.schedule.kind !== AutomationScheduleKind.CRON &&
    value.schedule.kind !== AutomationScheduleKind.ONCE
  ) {
    throw new Error('Automation 定时规则未知。');
  }
  if (
    value.target.kind !== AutomationTargetKind.MAIN &&
    value.target.kind !== AutomationTargetKind.EXISTING_THREAD &&
    value.target.kind !== AutomationTargetKind.NEW_TASK &&
    value.target.kind !== AutomationTargetKind.NEW_AUTOMATION_ONLY
  ) {
    throw new Error('Automation 目标类型未知。');
  }
  return value;
}

export function requireAutomationFire(value: AutomationFire | undefined): AutomationFire {
  if (
    !value?.fireId ||
    !value.scheduleId ||
    typeof value.seq !== 'bigint' ||
    !Object.values(AutomationFireStatus).includes(value.status) ||
    value.status === AutomationFireStatus.UNSPECIFIED ||
    !Object.values(AutomationTrigger).includes(value.trigger) ||
    value.trigger === AutomationTrigger.UNSPECIFIED
  ) {
    throw new Error('Automation fire 响应缺少有效执行记录。');
  }
  requireAutomationTargetKind(value.targetKind);
  return value;
}

export function requireAutomationTargetKind(kind: AutomationTargetKind): void {
  if (
    kind !== AutomationTargetKind.MAIN &&
    kind !== AutomationTargetKind.EXISTING_THREAD &&
    kind !== AutomationTargetKind.NEW_TASK &&
    kind !== AutomationTargetKind.NEW_AUTOMATION_ONLY
  ) {
    throw new Error('Automation fire 目标类型未知。');
  }
}

function assertTimeZone(timeZone: string): void {
  try {
    new Intl.DateTimeFormat('zh-CN', { timeZone }).format(0);
  } catch {
    throw new Error('时区无效，请输入 IANA 时区，例如 Asia/Shanghai。');
  }
}

function zonedDisplay(timestamp: ProtoTimestamp, timeZone: string): string {
  const date = new Date(timestampMilliseconds(timestamp));
  if (!Number.isFinite(date.getTime())) return '时间未知';
  try {
    return new Intl.DateTimeFormat('zh-CN', {
      dateStyle: 'medium',
      timeStyle: 'medium',
      timeZone,
    }).format(date);
  } catch {
    return '时间未知';
  }
}

function timestampMilliseconds(timestamp: ProtoTimestamp): number {
  const milliseconds = timestamp.seconds * 1000n + BigInt(Math.floor(timestamp.nanos / 1_000_000));
  if (
    milliseconds > BigInt(Number.MAX_SAFE_INTEGER) ||
    milliseconds < -BigInt(Number.MAX_SAFE_INTEGER)
  ) {
    return Number.NaN;
  }
  return Number(milliseconds);
}

function zonedParts(date: Date, timeZone: string): number {
  const parts = Object.fromEntries(
    zonedDateTimeParts(date, timeZone).map((part) => [part.type, Number(part.value)]),
  );
  return Date.UTC(
    parts.year ?? 0,
    (parts.month ?? 1) - 1,
    parts.day ?? 1,
    parts.hour ?? 0,
    parts.minute ?? 0,
    parts.second ?? 0,
  );
}

function zonedDateTimeParts(date: Date, timeZone: string): Intl.DateTimeFormatPart[] {
  return new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(date);
}
