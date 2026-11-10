import { useCallback, useEffect, useEffectEvent, useState } from "react";
import { isAbort } from "../api";

export interface Load<T> {
  /** The answer for the current key (or, with `keepPrevious`, the last answer while the next one loads). */
  data?: T;
  /** Set when the current key failed; `data` is then undefined (unless kept). */
  error?: unknown;
  /** True while the current key has neither an answer nor an error. */
  loading: boolean;
  /** Load the current key again (after a failure). */
  retry: () => void;
}

/**
 * One way to load data for a view. `key` names the request (null: nothing to load); a new key aborts the previous
 * request, and an answer only counts for the key it was asked for, so a slow answer can never overwrite a newer one.
 * Loading and failure are separate states: a failure is logged and offered a retry instead of "loading" forever.
 * The loader may read the latest props; only `key` decides when it runs.
 */
export function useLoad<T>(key: string | null, loader: (signal: AbortSignal) => Promise<T>, { keepPrevious = false }: { keepPrevious?: boolean } = {}): Load<T> {
  const [attempt, setAttempt] = useState(0);
  const [result, setResult] = useState<{ key: string; data?: T; error?: unknown; last?: T }>();
  const run = useEffectEvent(loader);
  const request = key == null ? null : `${key}#${attempt}`;

  useEffect(() => {
    if (request == null) return;
    const controller = new AbortController();
    let promise: Promise<T>;
    try { promise = run(controller.signal); } catch (error) { promise = Promise.reject(error); }
    promise.then((data) => { if (!controller.signal.aborted) setResult({ key: request, data, last: data }); }, (error: unknown) => {
      if (controller.signal.aborted || isAbort(error)) return;
      console.warn(`[SREO] could not load ${request}`, error); // i18n-ignore (console log, not shown)
      setResult((previous) => ({ key: request, error, last: previous?.last }));
    });
    return () => controller.abort();
  }, [request]);

  const retry = useCallback(() => setAttempt((value) => value + 1), []);
  const current = result && result.key === request ? result : undefined;
  const data = current?.data ?? (keepPrevious && request != null ? result?.last : undefined);
  return { data, error: current?.error, loading: request != null && !current, retry };
}

/** Retry every failed load of a group (one "Poskusi znova" for a whole panel). */
export const retryFailed = (loads: Array<Load<unknown>>) => () => { for (const load of loads) if (load.error) load.retry(); };
