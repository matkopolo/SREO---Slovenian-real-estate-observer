import { afterEach, expect, it, vi } from "vitest";
import { api, clearApiCache } from "./api";

let resolveFetch: (() => void) | undefined;
const fetchMock = vi.fn((_url: string, init?: RequestInit) => new Promise<Response>((resolve, reject) => {
  init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
  resolveFetch = () => resolve({ ok: true, status: 200, json: async () => ({ total: 1 }) } as Response);
}));
afterEach(() => { vi.unstubAllGlobals(); fetchMock.mockClear(); clearApiCache(); });

it("shares one request between callers and answers again from the recent cache", async () => {
  vi.stubGlobal("fetch", fetchMock);
  const first = api("/api/v1/data-status");
  const second = api("/api/v1/data-status");
  resolveFetch!();
  expect(await first).toEqual({ total: 1 });
  expect(await second).toEqual({ total: 1 });
  expect(await api("/api/v1/data-status")).toEqual({ total: 1 });
  expect(fetchMock).toHaveBeenCalledTimes(1);
});

it("aborts the shared request only when every caller has aborted", async () => {
  vi.stubGlobal("fetch", fetchMock);
  const a = new AbortController(), b = new AbortController();
  const first = api("/api/v1/data-status", {}, a.signal);
  const second = api("/api/v1/data-status", {}, b.signal);
  a.abort();
  await expect(first).rejects.toMatchObject({ name: "AbortError" });
  expect((fetchMock.mock.calls[0][1] as RequestInit).signal!.aborted).toBe(false);   // the other caller still waits
  resolveFetch!();
  expect(await second).toEqual({ total: 1 });
  const c = new AbortController();
  clearApiCache();
  const third = api("/api/v1/data-status", {}, c.signal);
  c.abort();
  await expect(third).rejects.toMatchObject({ name: "AbortError" });
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect((fetchMock.mock.calls[1][1] as RequestInit).signal!.aborted).toBe(true);    // nobody waits any more
});

it("keeps a request that is asked again in the same turn (a remount) instead of starting it twice", async () => {
  vi.stubGlobal("fetch", fetchMock);
  const a = new AbortController();
  const first = api("/api/v1/data-status", {}, a.signal);
  a.abort();
  await expect(first).rejects.toMatchObject({ name: "AbortError" });
  const again = api("/api/v1/data-status");
  resolveFetch!();
  expect(await again).toEqual({ total: 1 });
  expect(fetchMock).toHaveBeenCalledTimes(1);
});

it("never keeps a failure", async () => {
  const failing = vi.fn(async () => ({ ok: false, status: 503, json: async () => ({}) }) as Response);
  vi.stubGlobal("fetch", failing);
  await expect(api("/api/v1/data-status")).rejects.toMatchObject({ status: 503 });
  await expect(api("/api/v1/data-status")).rejects.toMatchObject({ status: 503 });
  expect(failing).toHaveBeenCalledTimes(2);
});
