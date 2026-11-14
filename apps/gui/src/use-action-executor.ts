import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import {
  type ActionCompletion,
  ActionExecutor,
  type ActionExecutorState,
} from './action-executor.js';
import type { ActionHandlers } from './action-handlers.js';
import { type ActionKind, ClientActionStore, type StorageLike } from './actions.js';

export function useActionExecutor(
  storage: StorageLike | undefined,
  handlers: ActionHandlers,
  complete: ActionCompletion,
) {
  const store = useMemo(() => new ClientActionStore(storage), [storage]);
  const completionRef = useRef(complete);
  completionRef.current = complete;
  const [executor] = useState(
    () =>
      new ActionExecutor(
        store,
        handlers,
        (record, result) => completionRef.current(record, result),
        { autoRetryDelaysMs: [2_000, 10_000] },
      ),
  );
  const [state, setState] = useState<ActionExecutorState>(executor.state);
  const [readyStore, setReadyStore] = useState(store);

  useEffect(() => executor.subscribe(setState), [executor]);
  useLayoutEffect(() => {
    executor.activate(store);
    setState(executor.state);
    setReadyStore(store);
  }, [executor, store]);

  const ready = readyStore === store;
  return {
    execute: <T>(key: string, kind: ActionKind, payload: unknown) =>
      executor.execute<T>(key, kind, payload),
    retry: (key: string) => executor.retry(key),
    dismiss: (key: string) => executor.dismiss(key),
    busy: !ready || state.busy,
    failures: ready ? state.failures : [],
  };
}

export type ActionExecutorView = ReturnType<typeof useActionExecutor>;
