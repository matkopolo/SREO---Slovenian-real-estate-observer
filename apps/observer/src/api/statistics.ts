import { optional } from "../promise";
import { api } from "./client";
import { FIRST_RENT_YEAR, range, type DateWindow } from "./periods";
import { APARTMENTS, segmentQuery, type PropertyGroup, type RentSegment, type Segment, type TransactionKind } from "./types";

export const loadDataStatus = (signal?: AbortSignal) => api("/api/v1/data-status", {}, signal);

// ------------------------------------------------------------------ time series and indices

export function loadTimeSeries(geographyId: number | undefined, signal?: AbortSignal) {
  return api("/api/v1/statistics/timeseries", { query: { ...range(2010, new Date().getFullYear()), propertyGroup: "apartment",
    interval: "year", geographyId } }, signal);
}
export function loadRentalTimeSeries(geographyId: number | undefined, signal?: AbortSignal) {
  return api("/api/v1/rentals/statistics/timeseries", { query: { ...range(2013, new Date().getFullYear()), propertyGroup: "apartment",
    interval: "year", geographyId } }, signal);
}
export function loadYearlyPrices(geographyId: number | undefined, segment: Segment, signal?: AbortSignal) {
  return api("/api/v1/statistics/timeseries", { query: { ...range(2010, new Date().getFullYear()), ...segmentQuery(segment),
    interval: "year", geographyId } }, signal);
}
export const loadIndices = (signal?: AbortSignal, transactionKind: TransactionKind = "sale") =>
  api("/api/v1/indices", { query: { transactionKind, propertyGroup: "apartment" } }, signal);
/** Quality-adjusted (hedonic) monthly price index for a property type, Slovenia. */
export const loadPriceIndex = (propertyGroup: PropertyGroup, signal?: AbortSignal) =>
  api("/api/v1/indices", { query: { transactionKind: "sale", propertyGroup, method: "hedonic" } }, signal);
export const loadInflation = (signal?: AbortSignal) =>
  api("/api/v1/economy/inflation", { query: { ...range(2010, new Date().getFullYear()), interval: "year" } }, signal);
/** SURS CPI factor between two dates (prices at `from` × factor = prices at `to`). */
export const loadInflationBetween = (from: string, to: string, signal?: AbortSignal) =>
  api("/api/v1/economy/inflation-factor", { query: { from, to } }, signal);
export const loadInflationFactor = (fromYear: number, to: string, signal?: AbortSignal) =>
  api("/api/v1/economy/inflation-factor", { query: { from: `${fromYear}-01-01`, to } }, signal);

// ------------------------------------------------------------------ demography, affordability, construction

export const loadDemographics = (geographyId: number | undefined, signal?: AbortSignal) =>
  api("/api/v1/demographics", { query: { geographyId } }, signal);
export const loadMunicipalDemographics = (signal?: AbortSignal) => api("/api/v1/demographics/municipalities", {}, signal);
/** Borrowing capacity for the user's own income(s); Banka Slovenije limits apply per borrower. */
export const loadHousehold = (geographyId: number | undefined, propertyGroup: "apartment" | "house", netIncome: number,
  coBorrowerIncome: number | undefined, signal?: AbortSignal) =>
  api("/api/v1/affordability", { query: { geographyId, propertyGroup, netIncome, coBorrowerIncome } }, signal);
export const loadAreaAffordability = (geographyId: number | undefined, propertyGroup: "apartment" | "house", signal?: AbortSignal) =>
  api("/api/v1/affordability", { query: { geographyId, propertyGroup } }, signal);
export const loadAreaConstruction = (geographyId: number | undefined, year: number, signal?: AbortSignal) =>
  api("/api/v1/construction/summary", { query: { geographyId, fromYear: year - 4, toYear: year } }, signal);
export const loadNewBuilding = (eid: string, signal?: AbortSignal) =>
  api("/api/v1/construction/buildings/{eid}", { params: { eid } }, signal);

// ------------------------------------------------------------------ sales and rentals of one area

/** Headline sale statistics of one area and window. */
export const loadSaleOverview = (geographyId: number | undefined, segment: Segment, window: DateWindow, signal?: AbortSignal) =>
  api("/api/v1/statistics/overview", { query: { ...window, ...segmentQuery(segment), geographyId } }, signal);
export const loadRentOverview = (geographyId: number | undefined, segment: RentSegment, window: DateWindow, signal?: AbortSignal) =>
  api("/api/v1/rentals/statistics/overview", { query: { ...window, ...segmentQuery(segment), geographyId } }, signal);
export const loadRentTrend = (geographyId: number | undefined, segment: RentSegment, signal?: AbortSignal) =>
  api("/api/v1/rentals/statistics/timeseries", { query: { ...range(FIRST_RENT_YEAR, new Date().getFullYear()), ...segmentQuery(segment), interval: "year", geographyId } }, signal);

/** Price spread (P25–P75) of an area for the range bars. */
export const loadSpread = (geographyId: number | undefined, window: DateWindow, segment: Segment, kind: TransactionKind, signal?: AbortSignal) =>
  kind === "sale"
    ? api("/api/v1/statistics/distribution", { query: { ...window, ...segmentQuery(segment), geographyId, metric: "pricePerSqm", bins: 20 } }, signal)
    : api("/api/v1/rentals/statistics/distribution", { query: { ...window, ...segmentQuery(segment), geographyId, metric: "rentPerSqm", bins: 20 } }, signal);
export const loadRentSpread = (geographyId: number | undefined, segment: RentSegment, window: DateWindow, metric: "rentPerSqm" | "monthlyRent", signal?: AbortSignal) =>
  api("/api/v1/rentals/statistics/distribution", { query: { ...window, ...segmentQuery(segment), geographyId, metric, bins: 20 } }, signal);

/** Newest recorded sales or rentals in an area, with address. */
export type SalesSort = "date" | "price" | "perSqm" | "area";
export interface SalesPage { limit?: number; offset?: number; sort?: SalesSort; order?: "asc" | "desc"; street?: string }
/** One page of an area's agreements (newest first by default) with the total count for paging. */
export const loadRecent = (geographyId: number | undefined, segment: Segment | RentSegment, kind: TransactionKind, window: DateWindow, signal?: AbortSignal, page: SalesPage = {}) =>
  api("/api/v1/transactions/recent", { query: { ...window, ...segmentQuery(segment), geographyId, transactionKind: kind, limit: page.limit ?? 10,
    offset: page.offset, sort: page.sort, order: page.order, street: page.street } }, signal);

// ------------------------------------------------------------------ market and quality pages

/**
 * The distribution page's parts. Each part fails on its own (shown as "—"), but when every part failed the whole load
 * fails, so an outage shows a retry instead of a page of dashes.
 */
export async function loadMarket(geographyId: number | undefined, fromYear: number, toYear: number, signal?: AbortSignal, segment: Segment = APARTMENTS) {
  const sale = { ...range(fromYear, toYear), ...segmentQuery(segment), geographyId };
  const parts = await Promise.allSettled([
    api("/api/v1/statistics/overview", { query: sale }, signal),
    api("/api/v1/rentals/statistics/overview", { query: sale }, signal),
    api("/api/v1/statistics/distribution", { query: { ...sale, metric: "pricePerSqm", bins: 24 } }, signal),
    api("/api/v1/rentals/statistics/distribution", { query: { ...sale, metric: "rentPerSqm", bins: 24 } }, signal),
    api("/api/v1/transactions/extremes", { query: { ...sale, transactionKind: "sale", limit: 5 } }, signal),
    api("/api/v1/sales/statistics/resales", { query: { ...range(fromYear, toYear), propertyGroup: segment.propertyGroup } }, signal),
  ] as const);
  const failure = parts.find((part) => part.status === "rejected");
  if (failure && parts.every((part) => part.status === "rejected")) throw failure.reason;
  return [optional(parts[0]), optional(parts[1]), optional(parts[2]), optional(parts[3]), optional(parts[4]), optional(parts[5])] as const;
}

export function loadQuality(year: number, signal?: AbortSignal) {
  const query = { ...range(year, year), propertyGroup: "apartment", limit: 8 };
  return Promise.all([
    api("/api/v1/anomalies/summary", { query: { transactionKind: "sale" } }, signal),
    api("/api/v1/anomalies", { query: { transactionKind: "sale", limit: 8 } }, signal),
    api("/api/v1/statistics/outliers", { query }, signal),
    api("/api/v1/rentals/statistics/outliers", { query }, signal),
  ]);
}
