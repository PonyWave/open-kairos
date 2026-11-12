export function unexpectedBreakingChanges(diagnostics, baselineCommit, approval) {
  if (baselineCommit !== approval.baselineCommit) return diagnostics;
  const permitted = new Set(
    approval.changes.map(({ path, type, message }) => JSON.stringify([path, type, message])),
  );
  return diagnostics.filter(
    ({ path, type, message }) => !permitted.has(JSON.stringify([path, type, message])),
  );
}
