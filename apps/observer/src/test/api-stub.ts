import { vi } from "vitest";

/**
 * A typed stand-in for the API in tests: each route names an exact contract path (or a pattern), optionally a query
 * condition, and its body. The first matching route answers; anything unexpected answers 404 and is recorded in
 * `unmatched`, so a renamed endpoint fails the test instead of passing silently.
 */
export interface Route {
  path: string | RegExp;
  /** Required query values ("geographyId": "256"), or a predicate on the whole query. */
  query?: Record<string, string> | ((query: URLSearchParams) => boolean);
  body: unknown | ((url: URL) => unknown);
  status?: number;
}

export function stubApi(routes: Route[]) {
  const calls: string[] = [];
  const unmatched: string[] = [];
  let table = routes;
  const matches = (route: Route, url: URL) => {
    if (typeof route.path === "string" ? route.path !== url.pathname : !route.path.test(url.pathname)) return false;
    if (!route.query) return true;
    if (typeof route.query === "function") return route.query(url.searchParams);
    return Object.entries(route.query).every(([key, value]) => url.searchParams.get(key) === value);
  };
  vi.stubGlobal("fetch", vi.fn(async (input: string) => {
    calls.push(input);
    const url = new URL(input, "http://localhost");
    const route = table.find((item) => matches(item, url));
    if (!route) { unmatched.push(input); return { ok: false, status: 404, json: async () => ({}) } as Response; }
    const body = typeof route.body === "function" ? (route.body as (url: URL) => unknown)(url) : route.body;
    return { ok: (route.status ?? 200) < 400, status: route.status ?? 200, json: async () => body } as Response;
  }));
  return {
    calls, unmatched,
    /** Whether any request URL contains this text. */
    fetched: (part: string) => calls.some((url) => url.includes(part)),
    /** Routes checked before the current ones (a test's own answers). */
    prepend: (extra: Route[]) => { table = [...extra, ...table]; },
  };
}

/** Endpoints a page asks for that a test does not care about: an empty list. */
export const emptyLists = (...paths: string[]): Route[] => paths.map((path) => ({ path, body: { items: [], total: 0 } }));
