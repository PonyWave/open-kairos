import { useEffect, useMemo, useState } from 'react';
import { AuthController } from './auth.js';
import type { KairosClients } from './client.js';

export function useAuth(clients: Pick<KairosClients, 'auth'>) {
  const controller = useMemo(() => new AuthController({ clients }), [clients]);
  const [state, setState] = useState(controller.state);

  useEffect(() => {
    const unsubscribe = controller.subscribe(setState);
    void controller.restore();
    return () => {
      unsubscribe();
      controller.stop();
    };
  }, [controller]);

  return useMemo(
    () => ({
      state,
      authenticationGeneration: controller.authenticationGeneration,
      restore: () => controller.restore(),
      requestEmailCode: (email: string) => controller.requestEmailCode(email),
      verifyEmailCode: (code: string) => controller.verifyEmailCode(code),
      completeProfile: (username: string) => controller.completeProfile(username),
      restartEmail: () => controller.restartEmail(),
      updateIdentity: (identity: NonNullable<typeof state.identity>) =>
        controller.updateIdentity(identity),
      logout: () => controller.logout(),
      expireSession: (authenticationGeneration?: number) =>
        controller.expireSession(authenticationGeneration),
    }),
    [controller, state],
  );
}

export type AuthView = ReturnType<typeof useAuth>;
