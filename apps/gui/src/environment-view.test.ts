import { EnvironmentBindingStatus, EnvironmentKind } from '@kairos/contracts';
import { describe, expect, it } from 'vitest';
import { workspaceSelectableEnvironments } from './environment-view.js';

function environment(
  envId: string,
  bindingStatus: EnvironmentBindingStatus,
  kind: EnvironmentKind = EnvironmentKind.SELF_HOSTED_LINUX,
) {
  return { envId, bindingStatus, kind } as never;
}

describe('workspaceSelectableEnvironments', () => {
  const active = environment('main', EnvironmentBindingStatus.ACTIVE);
  const pairing = environment('pending', EnvironmentBindingStatus.PAIRING);
  const revoked = environment('revoked', EnvironmentBindingStatus.REVOKED);
  const unknownKind = environment(
    'platform',
    EnvironmentBindingStatus.ACTIVE,
    0 as EnvironmentKind,
  );

  it('keeps only bound self-hosted environments', () => {
    expect(
      workspaceSelectableEnvironments([active, pairing, revoked, unknownKind]).map(
        (value) => value.envId,
      ),
    ).toEqual(['main']);
  });

  it('retains the current workspace device even when it is no longer selectable', () => {
    expect(
      workspaceSelectableEnvironments([active, revoked], 'revoked').map((value) => value.envId),
    ).toEqual(['main', 'revoked']);
    expect(
      workspaceSelectableEnvironments([active, revoked], 'main').map((value) => value.envId),
    ).toEqual(['main']);
  });
});
