import assert from 'node:assert/strict';
import test from 'node:test';
import { unexpectedBreakingChanges } from '../../scripts/proto-breaking.mjs';

test('protocol removal approval is restricted to its exact baseline and diagnostics', () => {
  const deletion = { path: 'proto/device.proto', type: 'MESSAGE_NO_DELETE', message: 'Remove Old' };
  const approval = { baselineCommit: 'a'.repeat(40), changes: [deletion] };
  assert.deepEqual(unexpectedBreakingChanges([deletion], approval.baselineCommit, approval), []);
  assert.deepEqual(unexpectedBreakingChanges([deletion], 'b'.repeat(40), approval), [deletion]);
  for (const other of [
    { ...deletion, path: 'proto/other.proto' },
    { ...deletion, type: 'FIELD_SAME_TYPE' },
    { ...deletion, message: 'Remove Other' },
  ]) {
    assert.deepEqual(
      unexpectedBreakingChanges([deletion, other], approval.baselineCommit, approval),
      [other],
    );
  }
});
