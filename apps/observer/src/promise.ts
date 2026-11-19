import { isAbort } from "./api/client";

/** The value of a fulfilled result, undefined for a rejected (or absent) one. */
export const settled = <T,>(result: PromiseSettledResult<T> | undefined): T | undefined => result?.status === "fulfilled" ? result.value : undefined; // i18n-ignore (generics, not text)

/** The value of a fulfilled result; a rejected one is undefined (shown as "—"), an abort is rethrown so a given-up load never poses as empty. */
export function optional<T>(result: PromiseSettledResult<T>): T | undefined {
  if (result.status === "fulfilled") return result.value;
  if (isAbort(result.reason)) throw result.reason;
  return undefined;
}

/** When every part failed, the first failure (an outage, not thin data); otherwise undefined. */
export function allRejected(parts: Array<PromiseSettledResult<unknown>>): PromiseRejectedResult | undefined {
  const [first] = parts;
  return first && first.status === "rejected" && parts.every((part) => part.status === "rejected") ? first : undefined;
}

/** Whether a settled result is a real failure (not an abort). */
export const failed = (result: PromiseSettledResult<unknown> | undefined): boolean => result?.status === "rejected" && !isAbort(result.reason);
