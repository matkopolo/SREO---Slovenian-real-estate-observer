import { getJSON } from "./api";
import type { components } from "./generated/api-schema";
import type { Geography } from "./types";

type Schemas = components["schemas"];
export type ConstructionSummaryResponse = Schemas["ConstructionSummaryResponse"];
export type ConstructionMapResponse = Schemas["ConstructionMapResponse"];
export type ConstructionMapFeature = Schemas["ConstructionMapFeature"];
export type ConstructionBuilding = Schemas["ConstructionBuilding"];
export type PublicWorksResponse = Schemas["PublicWorksResponse"];
export type PublicWorksNotice = Schemas["PublicWorksNotice"];

export interface ConstructionFilter {
  geographyId?: number;
  fromYear: number;
  toYear: number;
  withDwellings: boolean;
}

export function constructionQuery(filter: ConstructionFilter) {
  const query = new URLSearchParams({ fromYear: String(filter.fromYear), toYear: String(filter.toYear) });
  if (filter.geographyId) query.set("geographyId", String(filter.geographyId));
  if (filter.withDwellings) query.set("withDwellings", "true");
  return query;
}

export function loadConstructionSummary(filter: ConstructionFilter, signal: AbortSignal) {
  return getJSON<ConstructionSummaryResponse>(`/api/v1/construction/summary?${constructionQuery(filter)}`, signal);
}

export function loadConstructionMap(filter: ConstructionFilter, bbox: [number, number, number, number],
  zoom: number, signal: AbortSignal) {
  const query = constructionQuery({ ...filter, geographyId: undefined });
  query.set("bbox", bbox.map((value) => value.toFixed(5)).join(","));
  query.set("zoom", zoom.toFixed(2));
  return getJSON<ConstructionMapResponse>(`/api/v1/construction/map?${query}`, signal);
}

export function loadConstructionBuilding(eid: string, signal: AbortSignal) {
  return getJSON<ConstructionBuilding>(`/api/v1/construction/buildings/${encodeURIComponent(eid)}`, signal);
}

export function loadPublicWorks(filter: ConstructionFilter, offset: number, limit: number, signal: AbortSignal) {
  const query = constructionQuery(filter);
  query.set("offset", String(offset));
  query.set("limit", String(limit));
  return getJSON<PublicWorksResponse>(`/api/v1/construction/public-works?${query}`, signal);
}

export function loadRegions(signal: AbortSignal) {
  return getJSON<{ items: Geography[] }>("/api/v1/geographies?level=statistical_region", signal);
}

/** TED notice-type codes → Slovenian labels. */
export function noticeTypeLabel(type: string) {
  if (type.startsWith("cn")) return "Objava naročila";
  if (type === "can-modif") return "Sprememba pogodbe";
  if (type.startsWith("can")) return "Oddano naročilo";
  if (type === "corr") return "Popravek";
  if (type.startsWith("pin")) return "Predhodna objava";
  if (type === "veat") return "Prostovoljna objava";
  return "Obvestilo";
}
