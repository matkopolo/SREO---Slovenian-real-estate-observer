import { api } from "./client";
import { clean } from "./geographies";
import { range } from "./periods";

export const searchBuildings = (q: string, signal?: AbortSignal) =>
  api("/api/v1/buildings/search", { query: { q, limit: 8 } }, signal);
export const loadBuilding = (cadastralCode: number, buildingNumber: string, signal?: AbortSignal) =>
  api("/api/v1/buildings/{cadastralCode}/{buildingNumber}/statistics",
    { params: { cadastralCode, buildingNumber }, query: { ...range(2007, new Date().getFullYear()) } }, signal);

/** The areas a transaction lies in, with register prefixes dropped. */
function cleanAreas<T extends { geographies?: Array<{ name: string }> }>(result: PromiseSettledResult<T>): PromiseSettledResult<T> {
  return result.status === "fulfilled" && result.value.geographies ? { ...result, value: { ...result.value, geographies: result.value.geographies.map(clean) } } : result;
}

/** A sale with its context, history and model valuation; each part settles on its own, so one failure never hides the rest. */
export async function loadSaleEvidence(id: number, signal?: AbortSignal) {
  const [detail, context, history, valuation] = await Promise.allSettled([
    api("/api/v1/sales/transactions/{id}", { params: { id } }, signal),
    api("/api/v1/sales/transactions/{id}/context", { params: { id } }, signal),
    api("/api/v1/sales/transactions/{id}/history", { params: { id } }, signal),
    api("/api/v1/valuations/{kind}/{id}", { params: { kind: "sale", id } }, signal),
  ]);
  return { detail: cleanAreas(detail), context, history, valuation };
}

export async function loadRentalEvidence(id: number, signal?: AbortSignal) {
  const [detail, context, valuation] = await Promise.allSettled([
    api("/api/v1/rentals/transactions/{id}", { params: { id } }, signal),
    api("/api/v1/rentals/transactions/{id}/context", { params: { id } }, signal),
    api("/api/v1/valuations/{kind}/{id}", { params: { kind: "rent", id } }, signal),
  ]);
  return { detail: cleanAreas(detail), context, valuation };
}
