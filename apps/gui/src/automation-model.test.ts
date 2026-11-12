import { AutomationScheduleKind, AutomationTargetKind } from '@kairos/contracts';
import { describe, expect, it } from 'vitest';
import {
  type AutomationFormValue,
  automationDefinitionPayload,
  newAutomationForm,
  timestampFromIso,
  zonedDateTimeToIso,
  zonedInputValue,
} from './automation-model.js';

function form(targetKind: AutomationTargetKind): AutomationFormValue {
  return {
    ...newAutomationForm('Asia/Shanghai'),
    name: ' 每日摘要 ',
    prompt: '总结工作',
    targetKind,
    targetThreadId: targetKind === AutomationTargetKind.EXISTING_THREAD ? 'task-1' : '',
    allowedEnv: ['env-1'],
  };
}

describe('Automation form payloads', () => {
  it('supports all four target kinds and preserves an existing environment policy', () => {
    for (const kind of [
      AutomationTargetKind.MAIN,
      AutomationTargetKind.EXISTING_THREAD,
      AutomationTargetKind.NEW_TASK,
      AutomationTargetKind.NEW_AUTOMATION_ONLY,
    ]) {
      const payload = automationDefinitionPayload(form(kind));
      expect(payload.name).toBe('每日摘要');
      expect(payload.schedule).toEqual({
        kind: AutomationScheduleKind.CRON,
        cronExpression: '0 9 * * *',
        timeZone: 'Asia/Shanghai',
      });
      expect(payload.target).toEqual({
        kind,
        ...(kind === AutomationTargetKind.EXISTING_THREAD ? { threadId: 'task-1' } : {}),
        allowedEnv: ['env-1'],
      });
    }
  });

  it('requires an existing ordinary Thread only for that target kind', () => {
    expect(() =>
      automationDefinitionPayload({
        ...form(AutomationTargetKind.EXISTING_THREAD),
        targetThreadId: '',
      }),
    ).toThrow('请选择已有话题');
    expect(() =>
      automationDefinitionPayload({ ...form(AutomationTargetKind.MAIN), name: ' ' }),
    ).toThrow('请输入定时任务名称');
  });

  it('converts a zoned local time to an absolute timestamp and restores the form value', () => {
    const iso = zonedDateTimeToIso('2026-11-10T09:30', 'Asia/Shanghai');
    expect(iso).toBe('2026-11-10T01:30:00.000Z');
    expect(timestampFromIso(iso)).toMatchObject({ seconds: 1_794_274_200n, nanos: 0 });
    expect(zonedInputValue(new Date(iso), 'Asia/Shanghai')).toBe('2026-11-10T09:30');
    expect(
      automationDefinitionPayload({
        ...form(AutomationTargetKind.NEW_TASK),
        repeat: 'once',
        runAtLocal: '2026-11-10T09:30',
      }).schedule,
    ).toEqual({ kind: AutomationScheduleKind.ONCE, runAt: iso, timeZone: 'Asia/Shanghai' });
  });

  it('rejects a nonexistent local time and an invalid IANA zone', () => {
    expect(() => zonedDateTimeToIso('2026-03-08T02:30', 'America/New_York')).toThrow(
      '该时区不存在所选本地时间',
    );
    expect(() => zonedDateTimeToIso('2026-11-10T09:30', 'invalid/zone')).toThrow('时区无效');
  });
});
