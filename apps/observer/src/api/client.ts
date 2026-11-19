import type { FeatureCollection, Geometry } from "geojson";
import type { paths } from "../generated/api-schema";

/** Contract paths that have a GET operation. */
export type GetPath = { [P in keyof paths]: paths[P] extends { get: { responses: { 200: unknown } } } ? P : never }[keyof paths];
/** The 200 response body of a GET path, whatever its media type. */
export type Ok<P extends GetPath> = paths[P] extends { get: { responses: { 200: { content: infer C } } } } ? C[keyof C] : never;
export type Query = Record<string, string | number | boolean | undefined | null>;
export interface RequestOptions { params?: Record<string, string | number>; query?: Query }

export class ApiError extends Error {
  constructor(public status: number, path: string) { super(`API ${status}: ${path}`); }
}

/** A request given up by its caller (scope switch, unmount): never an error to show or log. */
export const isAbort = (error: unknown): boolean => (error as { name?: string } | null)?.name === "AbortError";
const aborted = () => new DOMException("The request was aborted.", "AbortError");

/**
 * Identical GETs share one request while it runs, and its answer for a minute after (several panels ask for the same
 * national figures; Back and type toggles return to recent states). A shared request is aborted only when every
 * caller that waits for it has aborted.
 */
const FRESH_MS = 60_000;
/** Expired answers are swept from the cache once it holds this many. */
const SWEEP_SIZE = 400;
interface Shared { promise: Promise<unknown>; controller: AbortController; waiting: number; expires?: number }
const shared = new Map<string, Shared>();
/** Tests start each case without answers from the previous one. */
export const clearApiCache = (): void => shared.clear();

function request(url: string, signal?: AbortSignal): Promise<unknown> {
  if (signal?.aborted) return Promise.reject(aborted());
  const now = Date.now();
  let entry = shared.get(url);
  if (entry?.expires != null && entry.expires < now) { shared.delete(url); entry = undefined; }
  if (!entry) {
    if (shared.size > SWEEP_SIZE) for (const [key, item] of shared) if (item.expires != null && item.expires < now) shared.delete(key);
    const controller = new AbortController();
    const created: Shared = { controller, waiting: 0, promise: Promise.resolve() };
    created.promise = fetch(url, { signal: controller.signal, headers: { Accept: "application/json" } })
      .then((response) => { if (!response.ok) throw new ApiError(response.status, url); return response.json() as Promise<unknown>; })
      .then((body) => { created.expires = Date.now() + FRESH_MS; return body; },
        (error: unknown) => { if (shared.get(url) === created) shared.delete(url); throw error; }); // failures are never kept
    shared.set(url, created);
    entry = created;
  }
  if (entry.expires != null) return entry.promise; // answered: nothing left to abort
  const current = entry;
  current.waiting += 1;
  return new Promise((resolve, reject) => {
    let done = false;
    const leave = () => { done = true; current.waiting -= 1; signal?.removeEventListener("abort", onAbort); };
    const onAbort = () => {
      if (done) return;
      leave();
      // Given up only if nobody asks again in this turn (a remount, StrictMode, or Back to the same view).
      if (current.waiting === 0) setTimeout(() => {
        if (current.waiting > 0 || current.expires != null) return;
        current.controller.abort();
        if (shared.get(url) === current) shared.delete(url);
      }, 0);
      reject(aborted());
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    current.promise.then((body) => { if (!done) { leave(); resolve(body); } }, (error: unknown) => { if (!done) { leave(); reject(error instanceof Error ? error : new Error(String(error))); } });
  });
}

/**
 * The only way the observer talks to the API: `path` must be a contract path (checked by tsc),
 * `{name}` segments are filled from `params`, and the result is typed from the contract.
 * The coverage test reads the literal paths passed here.
 */
export async function api<P extends GetPath>(path: P, options: RequestOptions = {}, signal?: AbortSignal): Promise<Ok<P>> {
  const url = path.replace(/\{(\w+)\}/g, (_, name: string) => encodeURIComponent(String(options.params?.[name] ?? "")));
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(options.query ?? {})) {
    if (value !== undefined && value !== null && value !== "") query.set(key, String(value));
  }
  const text = query.toString();
  return request(text ? `${url}?${text}` : url, signal) as Promise<Ok<P>>;
}

/**
 * A GeoJSON answer as the geojson types see it. The contract types the feature list loosely (properties are an open
 * object), so this is the one place a response is narrowed: the collection shape is checked at runtime, and `G`/`P`
 * are what the server is known to send for that path (see the Go handlers in apps/real-estate-api/internal/httpapi).
 */
export function geoJson<G extends Geometry | null, P>(body: unknown, path: string): FeatureCollection<G, P> {
  const candidate = body as { type?: unknown; features?: unknown } | null;
  if (!candidate || candidate.type !== "FeatureCollection" || !Array.isArray(candidate.features)) {
    throw new Error(`Malformed GeoJSON from ${path}`);
  }
  return candidate as unknown as FeatureCollection<G, P>;
}
