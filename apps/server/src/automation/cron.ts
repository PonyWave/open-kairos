import { SessionError } from '../sessions/errors.js';
import type { AutomationSchedule } from './types.js';

interface CronField {
  values: readonly number[];
  wildcard: boolean;
}

interface ParsedCron {
  minutes: CronField;
  hours: CronField;
  daysOfMonth: CronField;
  months: CronField;
  daysOfWeek: CronField;
}

interface LocalParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  weekday: number;
  naive: number;
}

const minuteMs = 60_000;
const dayMs = 86_400_000;
const maximumLocalSearchDays = 366 * 8;
const monthNames = [
  'JAN',
  'FEB',
  'MAR',
  'APR',
  'MAY',
  'JUN',
  'JUL',
  'AUG',
  'SEP',
  'OCT',
  'NOV',
  'DEC',
];
const weekdayNames = ['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT'];
const formatters = new Map<string, Intl.DateTimeFormat>();
const cronCache = new Map<string, ParsedCron>();

function invalid(message: string): never {
  throw new SessionError('invalid_argument', message);
}

export function requireTimeZone(value: string): string {
  const timeZone = value.trim();
  if (timeZone.length === 0 || timeZone.length > 100) {
    invalid('Automation time_zone must be a non-empty IANA time zone of at most 100 characters.');
  }
  try {
    new Intl.DateTimeFormat('en-US', { timeZone }).format(0);
  } catch (error) {
    throw new SessionError('invalid_argument', `Unsupported Automation time_zone: ${timeZone}.`, {
      cause: error,
    });
  }
  return timeZone;
}

export function requireInstant(value: string, field: string): string {
  if (!/(?:Z|[+-]\d{2}:\d{2})$/i.test(value)) {
    invalid(`${field} must include Z or an explicit UTC offset.`);
  }
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds)) invalid(`${field} must be a valid timestamp.`);
  return new Date(milliseconds).toISOString();
}

function namedValue(value: string, names: readonly string[], offset: number): number | undefined {
  const index = names.indexOf(value.toUpperCase());
  return index < 0 ? undefined : index + offset;
}

function numberValue(
  value: string,
  minimum: number,
  maximum: number,
  names: readonly string[] | undefined,
  nameOffset: number,
): number {
  const named = names ? namedValue(value, names, nameOffset) : undefined;
  const parsed = named ?? (/^\d+$/.test(value) ? Number(value) : Number.NaN);
  if (!Number.isInteger(parsed) || parsed < minimum || parsed > maximum) {
    invalid(`Cron value ${value} is outside ${minimum}..${maximum}.`);
  }
  return parsed;
}

function parseField(
  source: string,
  minimum: number,
  maximum: number,
  names?: readonly string[],
  nameOffset = minimum,
  normalize?: (value: number) => number,
): CronField {
  const values = new Set<number>();
  const wildcard = source.startsWith('*');
  for (const item of source.split(',')) {
    if (item.length === 0) invalid('Cron lists cannot contain empty items.');
    const [rangeSource, stepSource, extra] = item.split('/');
    if (extra !== undefined || (stepSource !== undefined && !/^\d+$/.test(stepSource))) {
      invalid(`Cron item ${item} has an invalid step.`);
    }
    const step = stepSource === undefined ? 1 : Number(stepSource);
    if (!Number.isInteger(step) || step <= 0) invalid('Cron steps must be positive integers.');
    let start = minimum;
    let end = maximum;
    if (rangeSource !== '*') {
      const range = rangeSource?.split('-') ?? [];
      if (range.length > 2 || range.some((part) => part.length === 0)) {
        invalid(`Cron range ${rangeSource} is invalid.`);
      }
      start = numberValue(range[0] ?? '', minimum, maximum, names, nameOffset);
      end =
        range.length === 2
          ? numberValue(range[1] ?? '', minimum, maximum, names, nameOffset)
          : start;
      if (end < start) invalid(`Cron range ${rangeSource} must be ascending.`);
    }
    for (let value = start; value <= end; value += step) {
      values.add(normalize ? normalize(value) : value);
    }
  }
  if (values.size === 0) invalid('Cron fields must select at least one value.');
  return { values: [...values].sort((left, right) => left - right), wildcard };
}

export function parseCron(expression: string): ParsedCron {
  const normalized = expression.trim().replaceAll(/\s+/g, ' ');
  const cached = cronCache.get(normalized);
  if (cached) return cached;
  if (normalized.length === 0 || normalized.length > 200) {
    invalid('Automation cron must contain five fields and at most 200 characters.');
  }
  const fields = normalized.split(' ');
  if (fields.length !== 5) invalid('Automation cron must contain exactly five fields.');
  const parsed = {
    minutes: parseField(fields[0] ?? '', 0, 59),
    hours: parseField(fields[1] ?? '', 0, 23),
    daysOfMonth: parseField(fields[2] ?? '', 1, 31),
    months: parseField(fields[3] ?? '', 1, 12, monthNames),
    daysOfWeek: parseField(fields[4] ?? '', 0, 7, weekdayNames, 0, (value) =>
      value === 7 ? 0 : value,
    ),
  };
  if (cronCache.size >= 256) cronCache.delete(cronCache.keys().next().value ?? '');
  cronCache.set(normalized, parsed);
  return parsed;
}

export function normalizeSchedule(schedule: AutomationSchedule): AutomationSchedule {
  const timeZone = requireTimeZone(schedule.timeZone);
  if (schedule.kind === 'once') {
    return { kind: 'once', runAt: requireInstant(schedule.runAt, 'Automation run_at'), timeZone };
  }
  if (schedule.kind !== 'cron') invalid('Automation schedule kind is not supported.');
  const expression = schedule.expression.trim().replaceAll(/\s+/g, ' ');
  parseCron(expression);
  return { kind: 'cron', expression, timeZone };
}

function formatter(timeZone: string): Intl.DateTimeFormat {
  const cached = formatters.get(timeZone);
  if (cached) return cached;
  const created = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
    weekday: 'short',
  });
  if (formatters.size >= 64) formatters.delete(formatters.keys().next().value ?? '');
  formatters.set(timeZone, created);
  return created;
}

function localParts(milliseconds: number, timeZone: string): LocalParts {
  const parts = formatter(timeZone).formatToParts(new Date(milliseconds));
  const values = new Map(parts.map((part) => [part.type, part.value]));
  const year = Number(values.get('year'));
  const month = Number(values.get('month'));
  const day = Number(values.get('day'));
  const hour = Number(values.get('hour'));
  const minute = Number(values.get('minute'));
  const weekday = weekdayNames.indexOf((values.get('weekday') ?? '').toUpperCase());
  if (![year, month, day, hour, minute, weekday].every(Number.isInteger) || weekday < 0) {
    throw new SessionError('internal', `Unable to resolve Automation time_zone ${timeZone}.`);
  }
  return {
    year,
    month,
    day,
    hour,
    minute,
    weekday,
    naive: Date.UTC(year, month - 1, day, hour, minute),
  };
}

function offsetAt(milliseconds: number, timeZone: string): number {
  const minute = Math.floor(milliseconds / minuteMs) * minuteMs;
  return localParts(minute, timeZone).naive - minute;
}

function localInstants(naive: number, timeZone: string): number[] {
  const offsets = new Set<number>();
  for (const delta of [-2 * dayMs, 0, 2 * dayMs]) {
    offsets.add(offsetAt(naive + delta, timeZone));
  }
  const result = new Set<number>();
  for (let pass = 0; pass < 3; pass += 1) {
    for (const offset of [...offsets]) {
      const actual = naive - offset;
      if (localParts(actual, timeZone).naive === naive) result.add(actual);
      offsets.add(offsetAt(actual, timeZone));
    }
  }
  return [...result].sort((left, right) => left - right);
}

function dayMatches(cron: ParsedCron, localDay: number): boolean {
  const date = new Date(localDay);
  if (!cron.months.values.includes(date.getUTCMonth() + 1)) return false;
  const monthDay = date.getUTCDate();
  const weekday = date.getUTCDay();
  const monthDayMatches = cron.daysOfMonth.values.includes(monthDay);
  const weekdayMatches = cron.daysOfWeek.values.includes(weekday);
  if (cron.daysOfMonth.wildcard && cron.daysOfWeek.wildcard) return true;
  if (cron.daysOfMonth.wildcard) return weekdayMatches;
  if (cron.daysOfWeek.wildcard) return monthDayMatches;
  return monthDayMatches || weekdayMatches;
}

function times(cron: ParsedCron, reverse = false): Array<{ hour: number; minute: number }> {
  const result = cron.hours.values.flatMap((hour) =>
    cron.minutes.values.map((minute) => ({ hour, minute })),
  );
  if (reverse) result.reverse();
  return result;
}

function startOfLocalDay(parts: LocalParts): number {
  return Date.UTC(parts.year, parts.month - 1, parts.day);
}

function nextCron(cron: ParsedCron, timeZone: string, after: number): number | null {
  const local = localParts(after, timeZone);
  const firstDay = startOfLocalDay(local);
  for (let dayIndex = 0; dayIndex <= maximumLocalSearchDays; dayIndex += 1) {
    const day = firstDay + dayIndex * dayMs;
    if (!dayMatches(cron, day)) continue;
    for (const time of times(cron)) {
      const naive = day + time.hour * 60 * minuteMs + time.minute * minuteMs;
      if (naive < local.naive) continue;
      for (const actual of localInstants(naive, timeZone)) {
        if (actual > after) return actual;
      }
    }
  }
  return null;
}

function previousCron(cron: ParsedCron, timeZone: string, before: number): number | null {
  const local = localParts(before, timeZone);
  const firstDay = startOfLocalDay(local);
  for (let dayIndex = 0; dayIndex <= maximumLocalSearchDays; dayIndex += 1) {
    const day = firstDay - dayIndex * dayMs;
    if (!dayMatches(cron, day)) continue;
    for (const time of times(cron, true)) {
      const naive = day + time.hour * 60 * minuteMs + time.minute * minuteMs;
      if (naive > local.naive) continue;
      for (const actual of localInstants(naive, timeZone).reverse()) {
        if (actual <= before) return actual;
      }
    }
  }
  return null;
}

function localDayHasOffsetChange(day: number, timeZone: string): boolean {
  const offsets = new Set<number>();
  for (const hours of [-24, 0, 6, 12, 18, 24, 48]) {
    const instants = localInstants(day + hours * 60 * minuteMs, timeZone);
    if (instants.length !== 1) return true;
    offsets.add(offsetAt(instants[0] ?? 0, timeZone));
  }
  return offsets.size !== 1;
}

function countCandidates(
  cron: ParsedCron,
  timeZone: string,
  day: number,
  after: number,
  before: number,
): number {
  let count = 0;
  for (const time of times(cron)) {
    const naive = day + time.hour * 60 * minuteMs + time.minute * minuteMs;
    for (const actual of localInstants(naive, timeZone)) {
      if (actual > after && actual <= before) count += 1;
    }
  }
  return count;
}

function countCron(cron: ParsedCron, timeZone: string, after: number, before: number): number {
  const firstDay = startOfLocalDay(localParts(after, timeZone));
  const lastDay = startOfLocalDay(localParts(before, timeZone));
  let count = 0;
  for (let day = firstDay; day <= lastDay; day += dayMs) {
    if (!dayMatches(cron, day)) continue;
    const candidateCount = cron.minutes.values.length * cron.hours.values.length;
    if (
      day !== firstDay &&
      day !== lastDay &&
      candidateCount > 64 &&
      !localDayHasOffsetChange(day, timeZone)
    ) {
      count += candidateCount;
    } else {
      count += countCandidates(cron, timeZone, day, after, before);
    }
  }
  return count;
}

export function nextOccurrence(schedule: AutomationSchedule, after: string): string | null {
  const normalized = normalizeSchedule(schedule);
  const afterMs = Date.parse(after);
  if (!Number.isFinite(afterMs)) invalid('Automation cursor must be a valid timestamp.');
  if (normalized.kind === 'once') {
    return Date.parse(normalized.runAt) > afterMs ? normalized.runAt : null;
  }
  const next = nextCron(parseCron(normalized.expression), normalized.timeZone, afterMs);
  return next === null ? null : new Date(next).toISOString();
}

const JITTER_RECURRING_MAX_FRACTION = 0.1;
const JITTER_RECURRING_MAX_MS = 15 * 60_000;
const JITTER_ONE_SHOT_MAX_MS = 90_000;
const MS_PER_MINUTE = 60_000;
const MS_PER_DAY = 24 * 60 * MS_PER_MINUTE;

export function jitterFraction(id: string): number {
  let hash = 5381;
  for (let index = 0; index < id.length; index += 1) {
    hash = ((hash << 5) + hash + id.charCodeAt(index)) | 0;
  }
  return (hash >>> 0) / 0x1_0000_0000;
}

// Deterministic per-schedule offset so simultaneous schedules spread out across
// restarts: recurring fires shift later by up to min(period * 10%, 15 min), and
// one-shot fires landing exactly on the hour or half hour shift earlier by up to 90s.
export function jitteredNextOccurrence(
  schedule: AutomationSchedule,
  after: string,
  id: string,
): string | null {
  const ideal = nextOccurrence(schedule, after);
  if (ideal === null) return null;
  const normalized = normalizeSchedule(schedule);
  const afterMs = Date.parse(after);
  const idealMs = Date.parse(ideal);
  const fraction = jitterFraction(id);
  if (normalized.kind === 'once') {
    if (idealMs % MS_PER_MINUTE !== 0) return ideal;
    const halfHour = idealMs % (30 * MS_PER_MINUTE);
    if (halfHour !== 0) return ideal;
    const shifted = idealMs - Math.round(JITTER_ONE_SHOT_MAX_MS * fraction);
    return shifted > afterMs ? new Date(shifted).toISOString() : ideal;
  }
  const following = nextCron(parseCron(normalized.expression), normalized.timeZone, idealMs);
  const period = following !== null && following > idealMs ? following - idealMs : MS_PER_DAY;
  const cap = Math.min(period * JITTER_RECURRING_MAX_FRACTION, JITTER_RECURRING_MAX_MS);
  if (!(cap > 0)) return ideal;
  return new Date(idealMs + Math.round(cap * fraction)).toISOString();
}

export function previousOccurrence(schedule: AutomationSchedule, before: string): string | null {
  const normalized = normalizeSchedule(schedule);
  const beforeMs = Date.parse(before);
  if (!Number.isFinite(beforeMs)) invalid('Automation current time must be a valid timestamp.');
  if (normalized.kind === 'once') {
    return Date.parse(normalized.runAt) <= beforeMs ? normalized.runAt : null;
  }
  const previous = previousCron(parseCron(normalized.expression), normalized.timeZone, beforeMs);
  return previous === null ? null : new Date(previous).toISOString();
}

export function countOccurrences(
  schedule: AutomationSchedule,
  after: string,
  before: string,
): number {
  const normalized = normalizeSchedule(schedule);
  const afterMs = Date.parse(after);
  const beforeMs = Date.parse(before);
  if (!Number.isFinite(afterMs) || !Number.isFinite(beforeMs) || beforeMs <= afterMs) return 0;
  if (normalized.kind === 'once') {
    const runAt = Date.parse(normalized.runAt);
    return runAt > afterMs && runAt <= beforeMs ? 1 : 0;
  }
  return countCron(parseCron(normalized.expression), normalized.timeZone, afterMs, beforeMs);
}
