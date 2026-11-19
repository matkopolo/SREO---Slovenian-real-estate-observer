import { useCallback, useEffect, useEffectEvent, useState } from "react";
import { isAbort } from "../api/client";

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

export interface LoadOptions<I> {
  /**
   * Show the previous answer while the next one loads (a map overlay that never blinks). A predicate limits it to
   * inputs that mean the same thing: an answer for sales is never shown while rents load.
   */
  keepPrevious?: boolean | ((previous: I, next: I) => boolean);
}

type Loader<T> = (signal: AbortSignal) => Promise<T>;
type InputLoader<T, I> = (input: I, signal: AbortSignal) => Promise<T>;

/**
 * One way to load data for a view. The request is named by a key (`null`: nothing to load); a new key aborts the
 * previous request, and an answer only counts for the key it was asked for, so a slow answer can never overwrite a
 * newer one. Loading and failure are separate states: a failure is logged and offered a retry instead of "loading"
 * forever. The loader may read the latest props; only the key decides when it runs.
 *
 * With an input, the key is derived from it and the loader receives it typed, so a caller never has to assert that
 * the values its key depends on exist: `useLoad(cutoff && area ? { cutoff, area } : null, keyOf, loader)`.
 */
export function useLoad<T>(key: string | null | undefined, loader: Loader<T>, options?: LoadOptions<never>): Load<T>;
export function useLoad<T, I>(input: I | null | undefined, keyOf: (input: I) => string, loader: InputLoader<T, I>, options?: LoadOptions<I>): Load<T>;
export function useLoad<T, I>(first: unknown, second: unknown, third?: unknown, fourth?: unknown): Load<T> {
  const keyed = typeof third === "function";
  const input = keyed ? (first as I | null | undefined) ?? undefined : undefined;
  const key = first == null ? null : keyed ? (second as (input: I) => string)(first as I) : (first as string);
  const options = (keyed ? (fourth as LoadOptions<I> | undefined) : (third as LoadOptions<I> | undefined)) ?? {};
  const [attempt, setAttempt] = useState(0);
  const [result, setResult] = useState<{ key: string; data?: T; error?: unknown; last?: { data: T; input: I | undefined } }>();
  const run = useEffectEvent((signal: AbortSignal): Promise<T> =>
    keyed ? (third as InputLoader<T, I>)(input as I, signal) : (second as Loader<T>)(signal));
  // The answer is stored with the input it was asked for (the latest of this key: a changed key aborts before it settles).
  const settle = useEffectEvent((request: string, data: T) => setResult({ key: request, data, last: { data, input } }));
  const request = key == null ? null : `${key}#${attempt}`;

  useEffect(() => {
    if (request == null) return;
    const controller = new AbortController();
    let promise: Promise<T>;
    try { promise = run(controller.signal); } catch (error) { promise = Promise.reject(error instanceof Error ? error : new Error(String(error))); }
    promise.then((data) => { if (!controller.signal.aborted) settle(request, data); }, (error: unknown) => {
      if (controller.signal.aborted || isAbort(error)) return;
      console.warn(`[SREO] could not load ${request}`, error); // i18n-ignore (console log, not shown)
      setResult((previous) => ({ key: request, error, last: previous?.last }));
    });
    return () => controller.abort();
  }, [request]);

  const retry = useCallback(() => setAttempt((value) => value + 1), []);
  const current = result && result.key === request ? result : undefined;
  const keep = options.keepPrevious;
  const previous = request != null && keep && result?.last ? result.last : undefined;
  const kept = previous && (typeof keep !== "function" || (previous.input !== undefined && input != null && keep(previous.input, input))) ? previous.data : undefined;
  return { data: current?.data ?? kept, error: current?.error, loading: request != null && !current, retry };
}

/** Retry every failed load of a group (one "Poskusi znova" for a whole panel). */
export const retryFailed = (loads: Array<Load<unknown>>) => (): void => { for (const load of loads) if (load.error) load.retry(); };
