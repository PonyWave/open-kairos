import { create, RunExecutionMode, RunStatus, SubagentCallViewSchema } from '@kairos/contracts';
import { describe, expect, it } from 'vitest';
import { validateSubagentView } from './use-subagent-views.js';

function view() {
  return create(SubagentCallViewSchema, {
    call: {
      delegation: { sourceThreadId: 'main', sourceAgentId: 'thread', sourceToolCallId: 'call' },
      sourceMessageId: 'source',
      sourceMessageSeq: 1n,
    },
    threadId: 'main',
    agentId: 'child',
    task: '检查结果',
    status: RunStatus.RUNNING,
    executionMode: RunExecutionMode.BACKGROUND,
  });
}
describe('Subagent view business validation', () => {
  it('accepts an authoritative target before its Run starts', () => {
    expect(() => validateSubagentView(view())).not.toThrow();
  });
  it('rejects unknown or unset execution state and mode', () => {
    expect(() => validateSubagentView({ ...view(), status: RunStatus.UNSPECIFIED })).toThrow(
      '未知',
    );
    expect(() =>
      validateSubagentView({ ...view(), executionMode: RunExecutionMode.UNSPECIFIED }),
    ).toThrow('未知');
  });
  it('rejects a root Agent or a mismatched target Thread', () => {
    expect(() => validateSubagentView({ ...view(), agentId: 'thread' })).toThrow('来源或目标');
    expect(() => validateSubagentView({ ...view(), threadId: 'different-thread' })).toThrow(
      '来源或目标',
    );
  });
});
