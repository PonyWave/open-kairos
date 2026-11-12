import { describe, expect, it } from 'vitest';
import {
  automationCronExpression,
  automationCronText,
  parseAutomationCron,
} from './automation-schedule.js';
import { automationTimeZoneOptions } from './automation-time-zone.js';

describe('Automation repeat and time', () => {
  it.each([
    ['daily', '30 8 * * *'],
    ['weekdays', '30 8 * * 1-5'],
    ['weekends', '30 8 * * 0,6'],
    ['weekly', '30 8 * * 1,3,5'],
    ['monthly', '30 8 31 * *'],
    ['hourly', '15 * * * *'],
  ] as const)('serializes %s and restores its controls', (repeat, expression) => {
    const timing = {
      ...parseAutomationCron('0 9 * * *'),
      repeat,
      time: '08:30',
      weekdays: [5, 1, 3, 3],
      monthDay: '31',
      hourlyMinute: '15',
    };
    expect(automationCronExpression(timing)).toBe(expression);
    const restored = parseAutomationCron(expression);
    expect(restored.repeat).toBe(repeat);
    expect(automationCronExpression(restored)).toBe(expression);
  });

  it.each(['05 09 * * 5,1,3', '0 9 * * 6,7', '0 9 * * 0-6', '0 9 * * 1,2,3,4,5'])(
    'preserves equivalent existing syntax when timing is untouched: %s',
    (expression) => {
      expect(automationCronExpression(parseAutomationCron(expression))).toBe(expression);
    },
  );

  it.each(['*/5 * * * *', '0 9 1 * 1', '0 9 * JAN MON', '0 9 * 1 *'])(
    'keeps an existing complex rule until the user chooses a repeat: %s',
    (expression) => {
      const timing = parseAutomationCron(expression);
      expect(timing.repeat).toBe('custom');
      expect(automationCronExpression(timing)).toBe(expression);
      expect(automationCronExpression({ ...timing, repeat: 'daily', time: '10:15' })).toBe(
        '15 10 * * *',
      );
    },
  );

  it('validates the active controls and ignores controls for other repeat modes', () => {
    const timing = parseAutomationCron('0 9 * * *');
    expect(() => automationCronExpression({ ...timing, time: '24:00' })).toThrow('执行时间');
    expect(() => automationCronExpression({ ...timing, repeat: 'weekly', weekdays: [] })).toThrow(
      '至少选择一个星期',
    );
    expect(() =>
      automationCronExpression({ ...timing, repeat: 'monthly', monthDay: '32' }),
    ).toThrow('执行日期');
    expect(() =>
      automationCronExpression({ ...timing, repeat: 'hourly', hourlyMinute: '60' }),
    ).toThrow('分钟');
    expect(automationCronExpression({ ...timing, repeat: 'hourly', time: '', weekdays: [] })).toBe(
      '0 * * * *',
    );
  });

  it.each([
    ['30 8 * * *', '每天 08:30'],
    ['0 9 * * 1-5', '工作日（周一至周五） 09:00'],
    ['0 9 * * 0,6', '周末 09:00'],
    ['0 9 * * 1,3,0', '每周一、三、日 09:00'],
    ['0 9 31 * *', '每月 31 日 09:00'],
    ['15 * * * *', '每小时第 15 分钟'],
    ['*/5 * * * *', '自定义重复规则'],
  ])('displays readable timing for %s', (expression, text) => {
    expect(automationCronText(expression)).toBe(text);
  });

  it('offers localized IANA zones, UTC and an existing valid alias without duplicates', () => {
    const options = automationTimeZoneOptions('Asia/Calcutta');
    const identifiers = options.map((option) => option.value);
    expect(new Set(identifiers).size).toBe(identifiers.length);
    expect(identifiers).toEqual(expect.arrayContaining(['UTC', 'Asia/Shanghai', 'Asia/Calcutta']));
    expect(options.find((option) => option.value === 'Asia/Shanghai')?.label).toContain(
      '中国标准时间',
    );
    expect(options.length).toBeGreaterThan(300);
    for (const option of options) {
      expect(() =>
        new Intl.DateTimeFormat('zh-CN', { timeZone: option.value }).format(0),
      ).not.toThrow();
    }
  });
});
