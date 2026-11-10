import type { FeatureCollection, Geometry, Point } from "geojson";
import type { components, paths } from "./generated/api-schema";
import { MIN_SAMPLE, type MetricId, type MunicipalityValue } from "./metrics";
import { t } from "./i18n";
import { date } from "./format";

type Schemas = components["schemas"];
export type Affordability = Schemas["Affordability"];
export type ConstructionSummary = Schemas["ConstructionSummaryResponse"];
export type TimePoint = Schemas["StatisticsTimeSeriesPoint"];
export type RentalTimePoint = Schemas["RentalStatisticsTimeSeriesPoint"];
export type Geography = Schemas["Geography"];
export type StatisticsOverview = Schemas["StatisticsOverview"];
export type RentalOverview = Schemas["RentalStatisticsOverview"];
export type Distribution = Schemas["Distribution"];
export type MarketIndex = Schemas["MarketIndex"];
export type BuildingStatistics = Schemas["BuildingStatistics"];
export type SaleTransaction = Schemas["SaleTransactionDetail"];
export type RentalTransaction = Schemas["RentalTransactionDetail"];
/** One agreement behind the current-market estimate, with its place on the map. */
export type MarketComparable = Schemas["MarketComparable"];
export type TransactionContext = Schemas["TransactionContext"];
export type PropertyHistory = Schemas["PropertyHistory"];
export type Valuation = Schemas["ValuationPrediction"];
export type Outlier = Schemas["Outlier"];
export type DemographicsResponse = Schemas["DemographicsResponse"];
export type MunicipalDemographics = Schemas["MunicipalDemographics"];
export type MapBuilding = Schemas["MapBuilding"];
type GeographyLevel = "statistical_region" | "municipality";
export type RecentTransaction = Schemas["RecentTransactions"]["items"][number];

/** Property type and optional floor-area band shared by every market call. */
export type PropertyGroup = "apartment" | "house" | "land" | "commercial" | "garage";
/** Land sales by registered use: buildable (ETN 1–2), agricultural, forest, or all land. */
export type LandScope = "strict" | "agricultural" | "forest" | "all";
/** Rentals also have rooms (sobe), which are never sold separately. */
export type RentGroup = "apartment" | "house" | "commercial" | "garage" | "room";
export interface Segment { propertyGroup: PropertyGroup; minArea?: number; maxArea?: number; landScope?: LandScope }
/** A rental segment: like a sale segment, but rooms are allowed. */
export interface RentSegment { propertyGroup: RentGroup; minArea?: number; maxArea?: number }
const APARTMENTS: Segment = { propertyGroup: "apartment" };
/** Affordability (wages, lending rules) only applies to homes. */
export const isDwelling = (group: PropertyGroup): group is "apartment" | "house" => group === "apartment" || group === "house";
const segmentQuery = (segment: Segment | RentSegment) => ({ propertyGroup: segment.propertyGroup, minArea: segment.minArea, maxArea: segment.maxArea,
  landScope: segment.propertyGroup === "land" ? (segment as Segment).landScope ?? "strict" : undefined });

/** Contract paths that have a GET operation. */
type GetPath = { [P in keyof paths]: paths[P] extends { get: { responses: { 200: unknown } } } ? P : never }[keyof paths];
/** The 200 response body of a GET path, whatever its media type. */
type Ok<P extends GetPath> = paths[P] extends { get: { responses: { 200: { content: infer C } } } } ? C[keyof C] : never;
type Query = Record<string, string | number | boolean | undefined | null>;

export class ApiError extends Error {
  constructor(public status: number, path: string) { super(`API ${status}: ${path}`); }
}

/** A request given up by its caller (scope switch, unmount): never an error to show or log. */
export const isAbort = (error: unknown) => (error as { name?: string } | null)?.name === "AbortError";
const aborted = () => new DOMException("The request was aborted.", "AbortError");

/**
 * Identical GETs share one request while it runs, and its answer for a minute after (several panels ask for the same
 * national figures; Back and type toggles return to recent states). A shared request is aborted only when every
 * caller that waits for it has aborted.
 */
const FRESH_MS = 60_000;
interface Shared { promise: Promise<unknown>; controller: AbortController; waiting: number; expires?: number }
const shared = new Map<string, Shared>();
/** Tests start each case without answers from the previous one. */
export const clearApiCache = () => shared.clear();

function request(url: string, signal?: AbortSignal): Promise<unknown> {
  if (signal?.aborted) return Promise.reject(aborted());
  const now = Date.now();
  let entry = shared.get(url);
  if (entry?.expires != null && entry.expires < now) { shared.delete(url); entry = undefined; }
  if (!entry) {
    if (shared.size > 400) for (const [key, item] of shared) if (item.expires != null && item.expires < now) shared.delete(key);
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
    current.promise.then((body) => { if (!done) { leave(); resolve(body); } }, (error: unknown) => { if (!done) { leave(); reject(error); } });
  });
}

/**
 * The only way the observer talks to the API: `path` must be a contract path (checked by tsc),
 * `{name}` segments are filled from `params`, and the result is typed from the contract.
 * The coverage test reads the literal paths passed here.
 */
export async function api<P extends GetPath>(path: P, options: { params?: Record<string, string | number>; query?: Query } = {},
  signal?: AbortSignal): Promise<Ok<P>> {
  const url = path.replace(/\{(\w+)\}/g, (_, name: string) => encodeURIComponent(String(options.params?.[name] ?? "")));
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(options.query ?? {})) {
    if (value !== undefined && value !== null && value !== "") query.set(key, String(value));
  }
  const text = query.toString();
  return request(text ? `${url}?${text}` : url, signal) as Promise<Ok<P>>;
}

/** Each part fails on its own (shown as "—"), so one unavailable statistic never blanks the view. */
const optional = <T,>(promise: Promise<T>) => promise.catch((error: unknown) => {
  if (isAbort(error)) throw error;
  return undefined;
});

const SLOVENIA_BBOX = "13.3,45.4,16.7,46.9";
const range = (fromYear: number, toYear: number) => ({ from: `${fromYear}-01-01`, to: `${toYear}-12-31` });

// ------------------------------------------------------------------ map view

export interface MunicipalityShape { id: number; name: string; code?: number; geometry: Geometry }

/** All region or municipality outlines in one response. */
export async function loadShapes(level: GeographyLevel, signal?: AbortSignal): Promise<MunicipalityShape[]> {
  const collection = await api("/api/v1/geographies/boundaries", { query: { level, detail: "low" } }, signal) as
    unknown as FeatureCollection<Geometry, { id: number; name: string; code?: number }>;
  return collection.features.map((feature) => ({
    id: feature.properties.id, name: areaLabel(feature.properties.name), code: feature.properties.code, geometry: feature.geometry,
  }));
}

type SummaryProperties = {
  geographyId: number; transactionCount?: number; representativeCount?: number;
  medianPricePerSqm?: number | null; medianMonthlyRentPerSqm?: number | null;
};

/** One value per area (region or municipality) for the selected measure over fromYear–toYear (inclusive). */
export async function loadMetric(metric: MetricId, window: Window, level: GeographyLevel = "municipality",
  signal?: AbortSignal, segment: Segment = APARTMENTS, rentWindow: Window = window): Promise<MunicipalityValue[]> {
  const fromYear = Number(window.from.slice(0, 4));
  const toYear = Number(window.to.slice(0, 4));
  if (metric === "grossYield") {
    const [sales, rents] = await Promise.all([loadMetric("salePrice", window, level, signal, segment), loadMetric("rentPrice", rentWindow, level, signal, segment)]);
    const rentById = new Map(rents.map((item) => [item.geographyId, item]));
    return sales.map((sale) => {
      const rent = rentById.get(sale.geographyId);
      const publishable = sale.value != null && rent?.value != null && sale.sample >= MIN_SAMPLE && rent.sample >= MIN_SAMPLE;
      return { geographyId: sale.geographyId, sample: Math.min(sale.sample, rent?.sample ?? 0),
        value: publishable ? (rent!.value! * 12) / sale.value! * 100 : null, rent: rent?.value ?? null, price: sale.value };
    });
  }
  if (metric === "share65" || metric === "netMigration" || metric === "releases") {
    const response = await loadMunicipalDemographics(signal);
    return response.items.map((item) => ({ geographyId: item.geographyId, sample: Math.round(item.population),
      value: metric === "share65" ? item.share65Plus * 100 : metric === "netMigration" ? item.netMigrationPerThousand
        : item.releasesPerThousandDwellings }));
  }
  if (metric === "newBuildings") {
    const response = await api("/api/v1/construction/map",
      { query: { bbox: SLOVENIA_BBOX, zoom: 8, fromYear, toYear } }, signal); // registration years
    return response.items.filter((item) => item.geographyId != null)
      .map((item) => ({ geographyId: item.geographyId!, value: item.buildings, sample: item.buildings }));
  }
  if (metric === "affordableSqm") {
    const lastComplete = new Date().getFullYear() - 1;
    if (!isDwelling(segment.propertyGroup)) return [];
    const response = await api("/api/v1/affordability/municipalities", { query: { fromYear: Math.min(fromYear, lastComplete),
      toYear: Math.min(toYear, lastComplete), propertyGroup: segment.propertyGroup } }, signal);
    return response.items.map((item) => ({
      geographyId: item.geographyId, sample: item.sampleSize,
      value: item.rows.find((row) => row.band.id === "p50")?.affordableSqm ?? null,
    }));
  }
  const query = { ...(metric === "rentPrice" ? rentWindow : window), ...segmentQuery(segment), level, bbox: SLOVENIA_BBOX };
  const response = (metric === "rentPrice"
    ? await api("/api/v1/rentals/map/geographies", { query }, signal)
    : await api("/api/v1/map/geographies", { query }, signal)) as unknown as FeatureCollection<null, SummaryProperties>;
  return response.features.map(({ properties }) => {
    const sample = metric === "saleVolume" ? properties.transactionCount ?? 0 : properties.representativeCount ?? 0;
    const value = metric === "saleVolume" ? properties.transactionCount ?? null
      : metric === "rentPrice" ? properties.medianMonthlyRentPerSqm ?? null : properties.medianPricePerSqm ?? null;
    return { geographyId: properties.geographyId, value, sample };
  });
}

export const loadDataStatus = (signal?: AbortSignal) => api("/api/v1/data-status", {}, signal);
/**
 * District and local-community names come from the register as "Četrtna skupnost Šiška" / "Krajevna skupnost Kamnik"; the
 * prefix is the common noun, so it is dropped (the level is shown separately) and the name reads "Šiška" in both languages.
 * Every geography-bearing response is cleaned here; benchmark labels (transaction context) use it too.
 */
export const areaLabel = (name: string) => name.replace(/^(?:Četrtna|Krajevna) skupnost\s+/iu, ""); // i18n-ignore (register prefix)
const clean = <T extends { name: string }>(item: T): T => typeof item?.name === "string" ? { ...item, name: areaLabel(item.name) } : item;

export const loadGeography = (id: number, signal?: AbortSignal) => api("/api/v1/geographies/{id}", { params: { id } }, signal).then(clean);
const loadChildren = (id: number, signal?: AbortSignal) => api("/api/v1/geographies/{id}/children", { params: { id } }, signal);


export function loadTimeSeries(geographyId: number | undefined, signal?: AbortSignal) {
  return api("/api/v1/statistics/timeseries", { query: { ...range(2010, new Date().getFullYear()), propertyGroup: "apartment",
    interval: "year", geographyId } }, signal);
}
export function loadRentalTimeSeries(geographyId: number | undefined, signal?: AbortSignal) {
  return api("/api/v1/rentals/statistics/timeseries", { query: { ...range(2013, new Date().getFullYear()), propertyGroup: "apartment",
    interval: "year", geographyId } }, signal);
}
export const loadNewBuilding = (eid: string, signal?: AbortSignal) =>
  api("/api/v1/construction/buildings/{eid}", { params: { eid } }, signal);

// ------------------------------------------------------------------ demography and buildings

export const loadDemographics = (geographyId: number | undefined, signal?: AbortSignal) =>
  api("/api/v1/demographics", { query: { geographyId } }, signal);
export const loadMunicipalDemographics = (signal?: AbortSignal) => api("/api/v1/demographics/municipalities", {}, signal);

/** The regions and municipalities an area picker offers. */
export async function loadAreaLists(signal?: AbortSignal) {
  const [regions, municipalities] = await Promise.all([loadRegions(signal), loadMunicipalityList(signal)]);
  return { regions: regions.items, municipalities: municipalities.items };
}
export const loadMunicipalityList = (signal?: AbortSignal) =>
  api("/api/v1/geographies", { query: { level: "municipality" } }, signal);

// ------------------------------------------------------------------ overview

export interface Window { from: string; to: string }

/** Shift a window back by whole months (previous-period comparisons, reporting-lag windows). */
export function shiftWindow(window: Window, months: number): Window {
  const move = (value: string) => {
    const [year, month, day] = value.split("-").map(Number);
    const last = new Date(Date.UTC(year, month - 1 - months + 1, 0)).getUTCDate(); // days in the target month
    return new Date(Date.UTC(year, month - 1 - months, Math.min(day, last))).toISOString().slice(0, 10);
  };
  return { from: move(window.from), to: move(window.to) };
}

interface MarketWindows { sales: { current: Window; previous: Window }; rents: { current: Window; previous: Window; year: number } }

/**
 * Comparable periods despite GURS reporting lag. Sales: the twelve months ending at the last quarter
 * that closed at least three months before the cutoff (the newest quarter is still being filled in).
 * Rentals are reported up to a year late, so rents use the last mostly reported calendar year.
 */
export function marketWindows(cutoff: string): MarketWindows {
  const [year, month, day] = cutoff.split("-").map(Number);
  const lagged = new Date(Date.UTC(year, month - 1 - 3, day));
  const end = new Date(Date.UTC(lagged.getUTCFullYear(), Math.floor(lagged.getUTCMonth() / 3) * 3, 0)); // last day of the previous quarter
  const iso = (value: Date) => value.toISOString().slice(0, 10);
  const start = new Date(Date.UTC(end.getUTCFullYear() - 1, end.getUTCMonth(), end.getUTCDate() + 1));
  const current = { from: iso(start), to: iso(end) };
  const rentYear = new Date(Date.UTC(year, month - 1 - 9, 1)).getUTCFullYear() - 1;
  return { sales: { current, previous: shiftWindow(current, 12) },
    rents: { current: range(rentYear, rentYear), previous: range(rentYear - 1, rentYear - 1), year: rentYear } };
}

export type PeriodYears = 1 | 3 | 5;
/** A trailing window (1, 3 or 5 years to the cutoff) or chosen calendar years, e.g. "2019-2021". */
export type Period = PeriodYears | `${number}-${number}`;
export const FIRST_SALE_YEAR = 2007;
const FIRST_RENT_YEAR = 2013;
export interface PeriodWindows {
  /** `previous` is null when it would start before the data does (sales 2007, rents 2013): no change is shown then. */
  sales: { current: Window; previous: Window | null }; rents: { current: Window; previous: Window | null };
  /** Length in years; custom periods are never widened for thin areas. */
  years: number; custom: boolean; rentYear: number;
  /** "v 12 mesecih do 30. 6. 2026", "v obdobju 1. 1. 2019–31. 12. 2021" */
  label: string;
  /** "2025" or "2023–2025" */
  rentYears: string;
}


/** Wider trailing windows a thin area may borrow (never for a chosen year range: the numbers must match the range). */
export const widerPeriods = (period: Period): PeriodYears[] => typeof period === "number" ? ([3, 5] as const).filter((value) => value > period) : [];

export function parsePeriod(from: string | null, to: string | null): Period | undefined {
  const start = Number(from), end = Number(to), now = new Date().getFullYear();
  if (!Number.isInteger(start) || !Number.isInteger(end) || start < FIRST_SALE_YEAR || end > now || start > end) return undefined;
  return `${start}-${end}`;
}

/** The lag-aware market windows widened to 3 or 5 years (small areas), each with an equally long previous period. */
export function periodWindows(cutoff: string, period: Period): PeriodWindows {
  const base = marketWindows(cutoff);
  if (typeof period === "string") {
    const [fromYear, toYear] = period.split("-").map(Number);
    const length = toYear - fromYear + 1;
    // The newest months are still being reported, so a range never reaches past the lag-aware end.
    const end = `${toYear}-12-31` < base.sales.current.to ? `${toYear}-12-31` : base.sales.current.to;
    const sales = { from: `${fromYear}-01-01`, to: end };
    const rentTo = Math.min(toYear, base.rents.year);
    const rentFrom = Math.max(fromYear, FIRST_RENT_YEAR);
    // A range that ends before rentals were recorded queries its own years and finds no rents: no rent, no yield
    // (never 2013 rents divided by 2008 prices).
    const available = rentFrom <= rentTo;
    const rents = available ? range(rentFrom, rentTo) : range(fromYear, toYear);
    const previousSales = shiftWindow(sales, length * 12);
    const previousRents = available ? shiftWindow(rents, (rentTo - rentFrom + 1) * 12) : null;
    return { sales: { current: sales, previous: previousSales.from >= `${FIRST_SALE_YEAR}-01-01` ? previousSales : null },
      rents: { current: rents, previous: previousRents && previousRents.from >= `${FIRST_RENT_YEAR}-01-01` ? previousRents : null },
      years: length, custom: true, rentYear: rentTo, rentYears: !available ? "—" : rentFrom === rentTo ? String(rentTo) : `${rentFrom}–${rentTo}`,
      // Whole calendar years say so; a range cut at the reporting lag shows its exact dates.
      label: end === `${toYear}-12-31` ? (length === 1 ? t("v koledarskem letu {year}", { year: fromYear }) : t("v koledarskih letih {from}–{to}", { from: fromYear, to: toYear }))
        : length === 1 ? t("v obdobju {from}–{to} (del leta)", { from: date(sales.from), to: date(sales.to) }) : t("v obdobju {from}–{to}", { from: date(sales.from), to: date(sales.to) }) };
  }
  const years = period;
  const months = years * 12;
  const sales = { from: shiftWindow(base.sales.current, months - 12).from, to: base.sales.current.to };
  const rents = range(base.rents.year - years + 1, base.rents.year);
  return { sales: { current: sales, previous: shiftWindow(sales, months) }, rents: { current: rents, previous: shiftWindow(rents, months) },
    years, custom: false, rentYear: base.rents.year, rentYears: years === 1 ? String(base.rents.year) : `${base.rents.year - years + 1}–${base.rents.year}`,
    label: years === 1 ? t("v 12 mesecih do {date}", { date: date(sales.to) }) : t("v {years} letih do {date}", { years, date: date(sales.to) }) };
}

/** The newest calendar year inside the lag-aware sales window (2025 for a cutoff in October 2026 or in January 2027). */
export function lastCompleteYear(cutoff: string) {
  const end = marketWindows(cutoff).sales.current.to;
  return Number(end.slice(0, 4)) - (end.endsWith("-12-31") ? 0 : 1);
}

/** Headline sale statistics of one area and window. */
export const loadSaleOverview = (geographyId: number | undefined, segment: Segment, window: Window, signal?: AbortSignal) =>
  api("/api/v1/statistics/overview", { query: { ...window, ...segmentQuery(segment), geographyId } }, signal);

export function loadYearlyPrices(geographyId: number | undefined, segment: Segment, signal?: AbortSignal) {
  return api("/api/v1/statistics/timeseries", { query: { ...range(2010, new Date().getFullYear()), ...segmentQuery(segment),
    interval: "year", geographyId } }, signal);
}

/** Newest recorded sales or rentals in an area, with address. */
export type SalesSort = "date" | "price" | "perSqm" | "area";
interface SalesPage { limit?: number; offset?: number; sort?: SalesSort; order?: "asc" | "desc"; street?: string }
/** One page of an area's agreements (newest first by default) with the total count for paging. */
export const loadRecent = (geographyId: number | undefined, segment: Segment | RentSegment, kind: "sale" | "rent", window: Window, signal?: AbortSignal, page: SalesPage = {}) =>
  api("/api/v1/transactions/recent", { query: { ...window, ...segmentQuery(segment), geographyId, transactionKind: kind, limit: page.limit ?? 10,
    offset: page.offset, sort: page.sort, order: page.order, street: page.street } }, signal);

/** Borrowing capacity for the user's own income(s); Banka Slovenije limits apply per borrower. */
export const loadHousehold = (geographyId: number | undefined, propertyGroup: "apartment" | "house", netIncome: number,
  coBorrowerIncome: number | undefined, signal?: AbortSignal) =>
  api("/api/v1/affordability", { query: { geographyId, propertyGroup, netIncome, coBorrowerIncome } }, signal);

export const loadAreaAffordability = (geographyId: number | undefined, propertyGroup: "apartment" | "house", signal?: AbortSignal) =>
  api("/api/v1/affordability", { query: { geographyId, propertyGroup } }, signal);

export const loadAreaConstruction = (geographyId: number | undefined, year: number, signal?: AbortSignal) =>
  api("/api/v1/construction/summary", { query: { geographyId, fromYear: year - 4, toYear: year } }, signal);

// ------------------------------------------------------------------ time view

export const loadRegions = (signal?: AbortSignal) =>
  api("/api/v1/geographies", { query: { level: "statistical_region" } }, signal);
export const loadIndices = (signal?: AbortSignal, transactionKind: "sale" | "rent" = "sale") =>
  api("/api/v1/indices", { query: { transactionKind, propertyGroup: "apartment" } }, signal);
export const loadInflation = (signal?: AbortSignal) =>
  api("/api/v1/economy/inflation", { query: { ...range(2010, new Date().getFullYear()), interval: "year" } }, signal);
/** SURS CPI factor between two dates (prices at `from` × factor = prices at `to`). */
export const loadInflationBetween = (from: string, to: string, signal?: AbortSignal) =>
  api("/api/v1/economy/inflation-factor", { query: { from, to } }, signal);
export const loadInflationFactor = (fromYear: number, to: string, signal?: AbortSignal) =>
  api("/api/v1/economy/inflation-factor", { query: { from: `${fromYear}-01-01`, to } }, signal);

// ------------------------------------------------------------------ market view

export function loadMarket(geographyId: number | undefined, fromYear: number, toYear: number, signal?: AbortSignal,
  segment: Segment = APARTMENTS) {
  const sale = { ...range(fromYear, toYear), ...segmentQuery(segment), geographyId };
  return Promise.all([
    optional(api("/api/v1/statistics/overview", { query: sale }, signal)),
    optional(api("/api/v1/rentals/statistics/overview", { query: sale }, signal)),
    optional(api("/api/v1/statistics/distribution", { query: { ...sale, metric: "pricePerSqm", bins: 24 } }, signal)),
    optional(api("/api/v1/rentals/statistics/distribution", { query: { ...sale, metric: "rentPerSqm", bins: 24 } }, signal)),
    optional(api("/api/v1/transactions/extremes", { query: { ...sale, transactionKind: "sale", limit: 5 } }, signal)),
    optional(api("/api/v1/sales/statistics/resales", { query: { ...range(fromYear, toYear), propertyGroup: segment.propertyGroup } }, signal)),
  ]);
}

interface DensityCell { at: [number, number]; count: number }

/** Grid clusters of recorded sales and rentals across Slovenia. */
export async function loadDensity(fromYear: number, toYear: number, signal?: AbortSignal): Promise<{ sales: DensityCell[]; rentals: DensityCell[] }> {
  const query = { ...range(fromYear, toYear), propertyGroup: "apartment", bbox: SLOVENIA_BBOX, zoom: 9 };
  const cells = (collection: FeatureCollection<Point, { count?: number; transactionCount?: number }>) => collection.features.map((feature) => ({
    at: feature.geometry.coordinates as [number, number], count: feature.properties.count ?? feature.properties.transactionCount ?? 0 }));
  const [sales, rentals] = await Promise.all([
    api("/api/v1/map/clusters", { query }, signal) as unknown as Promise<FeatureCollection<Point, { count?: number }>>,
    api("/api/v1/rentals/map/clusters", { query }, signal) as unknown as Promise<FeatureCollection<Point, { count?: number }>>,
  ]);
  return { sales: cells(sales), rentals: cells(rentals) };
}

// ------------------------------------------------------------------ evidence view

export const searchBuildings = (q: string, signal?: AbortSignal) =>
  api("/api/v1/buildings/search", { query: { q, limit: 8 } }, signal);
export const loadBuilding = (cadastralCode: number, buildingNumber: string, signal?: AbortSignal) =>
  api("/api/v1/buildings/{cadastralCode}/{buildingNumber}/statistics",
    { params: { cadastralCode, buildingNumber }, query: { ...range(2007, new Date().getFullYear()) } }, signal);

/** The areas a transaction lies in, with register prefixes dropped. */
function cleanAreas<T extends { geographies?: Array<{ name: string }> }>(result: PromiseSettledResult<T>): PromiseSettledResult<T> {
  return result.status === "fulfilled" && result.value.geographies ? { ...result, value: { ...result.value, geographies: result.value.geographies.map(clean) } } : result;
}

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

// ------------------------------------------------------------------ quality view

export function loadQuality(year: number, signal?: AbortSignal) {
  const query = { ...range(year, year), propertyGroup: "apartment", limit: 8 };
  return Promise.all([
    api("/api/v1/anomalies/summary", { query: { transactionKind: "sale" } }, signal),
    api("/api/v1/anomalies", { query: { transactionKind: "sale", limit: 8 } }, signal),
    api("/api/v1/statistics/outliers", { query }, signal),
    api("/api/v1/rentals/statistics/outliers", { query }, signal),
  ]);
}

// ------------------------------------------------------------------ explorer (map navigator + area panel)

export type Bbox = [number, number, number, number];
const bboxText = (bbox: Bbox) => bbox.map((value) => value.toFixed(5)).join(",");

export function bboxOf(geometry: Geometry | null | undefined): Bbox | undefined {
  const positions = !geometry ? [] : geometry.type === "Polygon" ? geometry.coordinates.flat()
    : geometry.type === "MultiPolygon" ? geometry.coordinates.flat(2) : [];
  if (!positions.length) return undefined;
  const lons = positions.map((position) => position[0]);
  const lats = positions.map((position) => position[1]);
  return [Math.min(...lons), Math.min(...lats), Math.max(...lons), Math.max(...lats)];
}

/** Sub-areas of a municipality for the map: city districts where they exist (Ljubljana, Maribor …), else settlements. */
export async function loadSubAreas(municipalityId: number, signal?: AbortSignal) {
  const children = (await loadChildren(municipalityId, signal)).items;
  const districts = children.filter((item) => item.level === "city_district");
  const chosen = districts.length ? districts : children.filter((item) => item.level === "settlement");
  const level = districts.length ? "city_district" as const : "settlement" as const;
  // One bounding-box request for all outlines (Kamnik has 100+ settlements; one call each was 230 requests).
  const boxes = chosen.map((item) => item.bounds as Bbox | undefined).filter((box): box is Bbox => Array.isArray(box) && box.length === 4);
  if (!chosen.length || !boxes.length) return { level, shapes: [] as MunicipalityShape[] };
  const bbox: Bbox = [Math.min(...boxes.map((box) => box[0])), Math.min(...boxes.map((box) => box[1])), Math.max(...boxes.map((box) => box[2])), Math.max(...boxes.map((box) => box[3]))];
  const wanted = new Set(chosen.map((item) => item.id));
  const shapes = (await loadBoundariesInView(level, bbox, signal)).filter((shape) => wanted.has(shape.id))
    .map((shape) => ({ id: shape.id, name: shape.name, geometry: shape.geometry }) as MunicipalityShape);
  // Outlines the bbox call did not return (its cap) are fetched one by one.
  const found = new Set(shapes.map((shape) => shape.id));
  const missing = await Promise.all(chosen.filter((item) => !found.has(item.id)).map(async (item) => {
    try {
      const boundary = await api("/api/v1/geographies/{id}/boundary", { params: { id: item.id }, query: { detail: "low" } }, signal) as unknown as { geometry: Geometry };
      return { id: item.id, name: areaLabel(item.name), geometry: boundary.geometry } as MunicipalityShape;
    } catch { return undefined; }
  }));
  return { level, shapes: [...shapes, ...missing.filter((item): item is MunicipalityShape => !!item)] };
}

/** Median €/m² and sales per sub-area inside a bounding box. */
export async function loadSubAreaValues(level: "city_district" | "settlement", bbox: Bbox, window: Window, segment: Segment, signal?: AbortSignal, kind: "sale" | "rent" = "sale") {
  const query = { query: { ...window, ...segmentQuery(segment), level, bbox: bboxText(bbox) } };
  // Rents come from the rental summaries (€/m² per month); everything else at this level is the sale median.
  const response = (kind === "rent" ? await api("/api/v1/rentals/map/geographies", query, signal) : await api("/api/v1/map/geographies", query, signal)) as unknown as
    FeatureCollection<null, SummaryProperties & { medianMonthlyRentPerSqm?: number | null }>;
  return response.features.map(({ properties }) => ({ geographyId: properties.geographyId,
    value: (kind === "rent" ? properties.medianMonthlyRentPerSqm : properties.medianPricePerSqm) ?? null, sample: properties.representativeCount ?? 0 }));
}

/** Buildings with agreements inside the visible map (street zoom). */
export const loadBuildingsInView = (bbox: Bbox, window: Window, segment: Segment, kind: "sale" | "rent", signal?: AbortSignal) =>
  api("/api/v1/map/buildings", { query: { bbox: bboxText(bbox), ...window, ...segmentQuery(segment), transactionKind: kind, limit: 3000 } }, signal);

/** Individual agreements at the closest zoom (each point opens its evidence). */
export async function loadAgreementPoints(bbox: Bbox, window: Window, segment: Segment, kind: "sale" | "rent", signal?: AbortSignal) {
  const query = { bbox: bboxText(bbox), ...window, ...segmentQuery(segment), limit: 500 };
  const collection = (kind === "sale" ? await api("/api/v1/map/properties", { query }, signal)
    : await api("/api/v1/rentals/map/properties", { query }, signal)) as unknown as FeatureCollection<Point, { transactionId: number; pricePerSqm?: number | null; monthlyRentPerSqm?: number | null; contractDate?: string | null; area?: number | null; cadastralMunicipalityCode?: number | null; buildingNumber?: string | null }>;
  return collection.features.map((feature) => ({ id: feature.properties.transactionId, at: feature.geometry.coordinates as [number, number],
    building: feature.properties.cadastralMunicipalityCode && feature.properties.buildingNumber ? { ko: feature.properties.cadastralMunicipalityCode, st: feature.properties.buildingNumber } : undefined,
    perSqm: feature.properties.pricePerSqm ?? feature.properties.monthlyRentPerSqm ?? null, date: feature.properties.contractDate ?? null, area: feature.properties.area ?? null }));
}

/** New buildings registered in the visible map. */
export const loadNewBuildingsInView = (bbox: Bbox, fromYear: number, toYear: number, signal?: AbortSignal) =>
  api("/api/v1/construction/map", { query: { bbox: bboxText(bbox), zoom: 15, fromYear, toYear } }, signal);

/** Price spread (P25–P75) of an area for the range bars. */
export const loadSpread = (geographyId: number | undefined, window: Window, segment: Segment, kind: "sale" | "rent", signal?: AbortSignal) =>
  kind === "sale"
    ? api("/api/v1/statistics/distribution", { query: { ...window, ...segmentQuery(segment), geographyId, metric: "pricePerSqm", bins: 20 } }, signal)
    : api("/api/v1/rentals/statistics/distribution", { query: { ...window, ...segmentQuery(segment), geographyId, metric: "rentPerSqm", bins: 20 } }, signal);

/** Every area a sale lies in (district, settlement, municipality, region), narrowest first. */
export async function loadSaleAreas(id: number, signal?: AbortSignal) {
  const detail = await api("/api/v1/sales/transactions/{id}", { params: { id } }, signal);
  const order = ["city_district", "settlement", "municipality", "statistical_region"];
  return [...detail.geographies].filter((item) => order.includes(item.level)).sort((a, b) => order.indexOf(a.level) - order.indexOf(b.level)).map(clean);
}

/** Quality-adjusted (hedonic) monthly price index for a property type, Slovenia. */
export const loadPriceIndex = (propertyGroup: PropertyGroup, signal?: AbortSignal) =>
  api("/api/v1/indices", { query: { transactionKind: "sale", propertyGroup, method: "hedonic" } }, signal);

type FineLevel = "city_district" | "settlement";

/** Outlines of a fine level (districts or settlements) intersecting the visible map; the API caps them at 400. */
export async function loadBoundariesInView(level: FineLevel, bbox: Bbox, signal?: AbortSignal) {
  const collection = await api("/api/v1/geographies/boundaries", { query: { level, detail: "low", bbox: bboxText(bbox) } }, signal) as
    unknown as FeatureCollection<Geometry, { id: number; name: string; parentId?: number | null }>;
  return collection.features.map((feature) => ({ id: feature.properties.id, name: areaLabel(feature.properties.name),
    parentId: feature.properties.parentId ?? undefined, geometry: feature.geometry }));
}

export const loadDistrictList = (signal?: AbortSignal) => api("/api/v1/geographies", { query: { level: "city_district" } }, signal)
  .then((response) => ({ ...response, items: response.items.map(clean) }));

/** Rentals of one type in an area: overview, yearly medians, spread and the latest contracts. */
export const loadRentOverview = (geographyId: number | undefined, segment: RentSegment, window: Window, signal?: AbortSignal) =>
  api("/api/v1/rentals/statistics/overview", { query: { ...window, ...segmentQuery(segment), geographyId } }, signal);
export const loadRentTrend = (geographyId: number | undefined, segment: RentSegment, signal?: AbortSignal) =>
  api("/api/v1/rentals/statistics/timeseries", { query: { ...range(FIRST_RENT_YEAR, new Date().getFullYear()), ...segmentQuery(segment), interval: "year", geographyId } }, signal);
export const loadRentSpread = (geographyId: number | undefined, segment: RentSegment, window: Window, metric: "rentPerSqm" | "monthlyRent", signal?: AbortSignal) =>
  api("/api/v1/rentals/statistics/distribution", { query: { ...window, ...segmentQuery(segment), geographyId, metric, bins: 20 } }, signal);
