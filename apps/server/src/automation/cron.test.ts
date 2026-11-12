import { describe, expect, it } from 'vitest';
import { countOccurrences, nextOccurrence, normalizeSchedule, previousOccurrence } from './cron.js';

describe('Automation cron', () => {
  it('evaluates five-field cron in its explicit time zone', () => {
    const schedule = normalizeSchedule({
      kind: 'cron',
      expression: '0 9 * * 1-5',
      timeZone: 'Asia/Shanghai',
    });
    expect(nextOccurrence(schedule, '2026-11-06T10:00:00.000Z')).toBe('2026-11-09T01:00:00.000Z');
    expect(previousOccurrence(schedule, '2026-11-09T01:00:00.000Z')).toBe(
      '2026-11-09T01:00:00.000Z',
    );
    expect(countOccurrences(schedule, '2026-11-06T10:00:00.000Z', '2026-11-10T01:00:00.000Z')).toBe(
      2,
    );
  });

  it('skips nonexistent local times and preserves both repeated local times', () => {
    const daily = {
      kind: 'cron' as const,
      expression: '30 2 * * *',
      timeZone: 'America/New_York',
    };
    expect(nextOccurrence(daily, '2026-03-08T00:00:00.000Z')).toBe('2026-03-09T06:30:00.000Z');

    const repeated = {
      kind: 'cron' as const,
      expression: '30 1 * * *',
      timeZone: 'America/New_York',
    };
    const first = '2026-11-01T05:30:00.000Z';
    const second = '2026-11-01T06:30:00.000Z';
    expect(nextOccurrence(repeated, first)).toBe(second);
    expect(previousOccurrence(repeated, second)).toBe(second);
    expect(countOccurrences(repeated, '2026-11-01T00:00:00.000Z', second)).toBe(2);
  });

  it('counts coalesced occurrences without evaluating them in the Server time zone', () => {
    const schedule = {
      kind: 'cron' as const,
      expression: '* * * * *',
      timeZone: 'Asia/Shanghai',
    };
    expect(countOccurrences(schedule, '2026-01-01T00:00:00.000Z', '2026-01-01T00:05:00.000Z')).toBe(
      5,
    );
  });

  it('rejects invalid cron, zones and offset-less one-time schedules', () => {
    expect(() =>
      normalizeSchedule({ kind: 'cron', expression: '* * * *', timeZone: 'UTC' }),
    ).toThrow(/five fields/);
    expect(() =>
      normalizeSchedule({ kind: 'cron', expression: '* * * * *', timeZone: 'Mars/Olympus' }),
    ).toThrow(/time_zone/);
    expect(() =>
      normalizeSchedule({ kind: 'once', runAt: '2026-11-09T09:00:00', timeZone: 'UTC' }),
    ).toThrow(/UTC offset/);
  });
});
