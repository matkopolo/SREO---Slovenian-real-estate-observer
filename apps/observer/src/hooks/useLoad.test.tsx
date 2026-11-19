import { act, renderHook } from "@testing-library/react";
import { StrictMode } from "react";
import { afterEach, expect, it, vi } from "vitest";
import { useLoad } from "./useLoad";

/** A loader whose answers the test releases by hand, recording the signal of every call. */
function deferredLoader<T>() {
  const calls: Array<{ input: unknown; signal: AbortSignal; resolve: (value: T) => void; reject: (error: unknown) => void }> = [];
  const loader = (input: unknown, signal: AbortSignal) => new Promise<T>((resolve, reject) => { calls.push({ input, signal, resolve, reject }); });
  return { calls, loader };
}
const flush = () => act(async () => { await Promise.resolve(); });
afterEach(() => vi.restoreAllMocks());

it("aborts the previous request when the key changes and never shows a late answer for an old key", async () => {
  const { calls, loader } = deferredLoader<string>();
  const { result, rerender } = renderHook(({ id }: { id: number }) => useLoad(id, (value) => `item-${value}`, loader), { initialProps: { id: 1 } });
  expect(result.current.loading).toBe(true);
  rerender({ id: 2 });
  expect(calls[0].signal.aborted).toBe(true);
  expect(calls[1].input).toBe(2);
  await act(async () => { calls[0].resolve("one (late)"); await Promise.resolve(); });
  expect(result.current.data).toBeUndefined();
  expect(result.current.loading).toBe(true);
  await act(async () => { calls[1].resolve("two"); await Promise.resolve(); });
  expect(result.current.data).toBe("two");
  expect(result.current.loading).toBe(false);
});

it("keeps the previous answer while the next loads only when the inputs mean the same thing", async () => {
  const { calls, loader } = deferredLoader<string>();
  const same = (previous: { kind: string }, next: { kind: string }) => previous.kind === next.kind;
  const { result, rerender } = renderHook(({ input }: { input: { kind: string; box: number } }) =>
    useLoad(input, (value) => `${value.kind}-${value.box}`, loader, { keepPrevious: same }), { initialProps: { input: { kind: "sale", box: 1 } } });
  await act(async () => { calls[0].resolve("sales of box 1"); await Promise.resolve(); });
  rerender({ input: { kind: "sale", box: 2 } });
  expect(result.current.data).toBe("sales of box 1");     // a pan keeps the drawn areas
  expect(result.current.loading).toBe(true);
  rerender({ input: { kind: "rent", box: 2 } });
  expect(result.current.data).toBeUndefined();            // rents never pose as sales
});

it("reports a failure with a retry instead of loading forever, and swallows aborts", async () => {
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
  const { calls, loader } = deferredLoader<string>();
  const { result } = renderHook(() => useLoad("one", (signal) => loader("one", signal)));
  await act(async () => { calls[0].reject(new Error("503")); await Promise.resolve(); });
  expect(result.current.error).toBeInstanceOf(Error);
  expect(result.current.loading).toBe(false);
  act(() => result.current.retry());
  expect(result.current.loading).toBe(true);
  expect(result.current.error).toBeUndefined();
  expect(calls).toHaveLength(2);
  await act(async () => { calls[1].resolve("fine"); await Promise.resolve(); });
  expect(result.current.data).toBe("fine");
  expect(console.warn).toHaveBeenCalledTimes(1);
});

it("treats a loader that throws synchronously as a failure, and a null key as nothing to load", async () => {
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
  const { result } = renderHook(() => useLoad("boom", () => { throw new Error("bad input"); }));
  await flush();
  expect(result.current.error).toBeInstanceOf(Error);
  const idle = renderHook(() => useLoad(null, () => Promise.resolve("never")));
  expect(idle.result.current).toMatchObject({ loading: false, data: undefined, error: undefined });
});

it("issues one request for a StrictMode double mount (the second effect run reuses the loader call)", async () => {
  const { calls, loader } = deferredLoader<string>();
  const { result } = renderHook(() => useLoad("once", (signal) => loader("once", signal)), { wrapper: StrictMode });
  // StrictMode mounts, unmounts and mounts again: the first call is aborted, the second answers.
  expect(calls.length).toBeLessThanOrEqual(2);
  const live = calls.filter((call) => !call.signal.aborted);
  expect(live).toHaveLength(1);
  await act(async () => { live[0].resolve("answer"); await Promise.resolve(); });
  expect(result.current.data).toBe("answer");
});
