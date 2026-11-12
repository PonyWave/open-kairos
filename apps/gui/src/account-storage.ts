import type { Identity } from '@kairos/contracts';
import type { StorageLike } from './actions.js';

export function accountScopeKey(identity: Pick<Identity, 'userId' | 'tenantId'>): string {
  return `${encodeURIComponent(identity.userId)}.${encodeURIComponent(identity.tenantId)}`;
}

export function scopedStorage(
  storage: StorageLike | undefined,
  scopeKey: string | null,
): StorageLike | undefined {
  if (!storage || !scopeKey) return undefined;
  const prefix = `kairos.account.v1.${scopeKey}.`;
  return {
    getItem: (key) => storage.getItem(`${prefix}${key}`),
    setItem: (key, value) => storage.setItem(`${prefix}${key}`, value),
    removeItem: (key) => storage.removeItem(`${prefix}${key}`),
  };
}
