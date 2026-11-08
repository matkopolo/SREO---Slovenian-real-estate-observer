import type { FeatureCollection, Geometry } from "geojson";
import type { components } from "./generated/api-schema";
import type { MetricId, MunicipalityValue } from "./metrics";

type Schemas = components["schemas"];
export type Affordability = Schemas["Affordability"];
export type ConstructionSummary = Schemas["ConstructionSummaryResponse"];
export type TimePoint = Schemas["StatisticsTimeSeriesPoint"];

export class ApiError extends Error {
  constructor(public status: number, path: string) { super(`API ${status}: ${path}`); }
}

export async function getJSON<T>(path: string, signal?: AbortSignal): Promise<T> {
  const response = await fetch(path, { signal, headers: { Accept: "application/json" } });
  if (!response.ok) throw new ApiError(response.status, path);
  return response.json() as Promise<T>;
}

const SLOVENIA_BBOX = "13.3,45.4,16.7,46.9";

export interface MunicipalityShape {
  id: number;
  name: string;
  code?: number;
  geometry: Geometry;
}

export async function loadMunicipalities(signal?: AbortSignal): Promise<MunicipalityShape[]> {
  const collection = await getJSON<FeatureCollection<Geometry, { id: number; name: string; code?: number }>>(
    "/api/v1/geographies/boundaries?level=municipality&detail=low", signal);
  return collection.features.map((feature) => ({
    id: feature.properties.id, name: feature.properties.name, code: feature.properties.code, geometry: feature.geometry,
  }));
}

type SummaryProperties = {
  geographyId: number; transactionCount?: number; representativeCount?: number;
  medianPricePerSqm?: number | null; medianMonthlyRentPerSqm?: number | null;
};

/** One value per municipality for the selected measure and year. */
export async function loadMetric(metric: MetricId, year: number, signal?: AbortSignal): Promise<MunicipalityValue[]> {
  const from = `${year}-01-01`;
  const to = `${year}-12-31`;
  if (metric === "newBuildings") {
    const response = await getJSON<{ items: Array<{ geographyId?: number; buildings: number }> }>(
      `/api/v1/construction/map?bbox=${SLOVENIA_BBOX}&zoom=8&fromYear=${year}&toYear=${year}`, signal);
    return response.items.filter((item) => item.geographyId != null)
      .map((item) => ({ geographyId: item.geographyId!, value: item.buildings, sample: item.buildings }));
  }
  const prefix = metric === "rentPrice" ? "/api/v1/rentals/map" : "/api/v1/map";
  const response = await getJSON<FeatureCollection<null, SummaryProperties>>(
    `${prefix}/geographies?from=${from}&to=${to}&propertyGroup=apartment&level=municipality&bbox=${SLOVENIA_BBOX}`, signal);
  return response.features.map(({ properties }) => {
    const sample = metric === "saleVolume" ? properties.transactionCount ?? 0 : properties.representativeCount ?? 0;
    const value = metric === "saleVolume" ? properties.transactionCount ?? null
      : metric === "rentPrice" ? properties.medianMonthlyRentPerSqm ?? null : properties.medianPricePerSqm ?? null;
    return { geographyId: properties.geographyId, value, sample };
  });
}

export function loadTimeSeries(geographyId: number, signal?: AbortSignal) {
  const to = new Date().getFullYear();
  return getJSON<{ items: TimePoint[] }>(
    `/api/v1/statistics/timeseries?from=2010-01-01&to=${to}-12-31&propertyGroup=apartment&interval=year&geographyId=${geographyId}`, signal);
}

export function loadAffordability(geographyId: number, signal?: AbortSignal) {
  return getJSON<Affordability>(`/api/v1/affordability?geographyId=${geographyId}&propertyGroup=apartment`, signal);
}

export function loadConstruction(geographyId: number, year: number, signal?: AbortSignal) {
  return getJSON<ConstructionSummary>(
    `/api/v1/construction/summary?geographyId=${geographyId}&fromYear=${year - 5}&toYear=${year}`, signal);
}

export function loadDataStatus(signal?: AbortSignal) {
  return getJSON<Schemas["DataStatus"]>("/api/v1/data-status", signal);
}
