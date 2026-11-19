import type { Geometry } from "geojson";
import { api, geoJson } from "./client";
import type { FineLevel, Geography, GeographyLevel } from "./types";

/** West, south, east, north in degrees. */
export type Bbox = [number, number, number, number];
export const bboxText = (bbox: Bbox): string => bbox.map((value) => value.toFixed(5)).join(",");

export interface MunicipalityShape { id: number; name: string; code?: number; geometry: Geometry }
/** An area a transaction lies in, as the sale detail names it. */
export type AreaRef = Pick<Geography, "id" | "level" | "name">;

/**
 * District and local-community names come from the register as "Četrtna skupnost Šiška" / "Krajevna skupnost Kamnik"; the
 * prefix is the common noun, so it is dropped (the level is shown separately) and the name reads "Šiška" in both languages.
 * Every geography-bearing response is cleaned here; benchmark labels (transaction context) use it too.
 */
export const areaLabel = (name: string): string => name.replace(/^(?:Četrtna|Krajevna) skupnost\s+/iu, ""); // i18n-ignore (register prefix)
export const clean = <T extends { name: string }>(item: T): T => typeof item.name === "string" ? { ...item, name: areaLabel(item.name) } : item;

/** All region or municipality outlines in one response. */
export async function loadShapes(level: GeographyLevel, signal?: AbortSignal): Promise<MunicipalityShape[]> {
  const collection = geoJson<Geometry, Geography>(await api("/api/v1/geographies/boundaries", { query: { level, detail: "low" } }, signal), "boundaries");
  return collection.features.map((feature) => ({
    id: feature.properties.id, name: areaLabel(feature.properties.name), code: feature.properties.code, geometry: feature.geometry,
  }));
}

export const loadGeography = (id: number, signal?: AbortSignal): Promise<Geography> => api("/api/v1/geographies/{id}", { params: { id } }, signal).then(clean);
const loadChildren = (id: number, signal?: AbortSignal) => api("/api/v1/geographies/{id}/children", { params: { id } }, signal);

export const loadRegions = (signal?: AbortSignal) => api("/api/v1/geographies", { query: { level: "statistical_region" } }, signal);
export const loadMunicipalityList = (signal?: AbortSignal) => api("/api/v1/geographies", { query: { level: "municipality" } }, signal);
export const loadDistrictList = (signal?: AbortSignal) => api("/api/v1/geographies", { query: { level: "city_district" } }, signal)
  .then((response) => ({ ...response, items: response.items.map(clean) }));

/** The regions and municipalities an area picker offers. */
export async function loadAreaLists(signal?: AbortSignal): Promise<{ regions: Geography[]; municipalities: Geography[] }> {
  const [regions, municipalities] = await Promise.all([loadRegions(signal), loadMunicipalityList(signal)]);
  return { regions: regions.items, municipalities: municipalities.items };
}

/** The bounding box of a (multi)polygon, or undefined for no positions. A loop, not a spread: a detailed outline has more vertices than a call may take arguments. */
export function bboxOf(geometry: Geometry | null | undefined): Bbox | undefined {
  const rings: number[][][] = !geometry ? [] : geometry.type === "Polygon" ? geometry.coordinates
    : geometry.type === "MultiPolygon" ? geometry.coordinates.flat() : [];
  let west = Infinity, south = Infinity, east = -Infinity, north = -Infinity;
  for (const ring of rings) for (const [lon, lat] of ring) {
    if (lon < west) west = lon;
    if (lon > east) east = lon;
    if (lat < south) south = lat;
    if (lat > north) north = lat;
  }
  return west <= east && south <= north ? [west, south, east, north] : undefined;
}

/** The box around several boxes. */
export const unionBbox = (boxes: Bbox[]): Bbox => boxes.reduce<Bbox>((box, next) =>
  [Math.min(box[0], next[0]), Math.min(box[1], next[1]), Math.max(box[2], next[2]), Math.max(box[3], next[3])], [Infinity, Infinity, -Infinity, -Infinity]);

/** Outlines of a fine level (districts or settlements) intersecting the visible map; the API caps them at 400. */
export async function loadBoundariesInView(level: FineLevel, bbox: Bbox, signal?: AbortSignal): Promise<Array<MunicipalityShape & { parentId?: number }>> {
  const collection = geoJson<Geometry, Geography>(await api("/api/v1/geographies/boundaries", { query: { level, detail: "low", bbox: bboxText(bbox) } }, signal), "boundaries");
  return collection.features.map((feature) => ({ id: feature.properties.id, name: areaLabel(feature.properties.name),
    parentId: feature.properties.parentId ?? undefined, geometry: feature.geometry }));
}

/** Sub-areas of a municipality for the map: city districts where they exist (Ljubljana, Maribor …), else settlements. */
export async function loadSubAreas(municipalityId: number, signal?: AbortSignal): Promise<{ level: FineLevel; shapes: MunicipalityShape[] }> {
  const children = (await loadChildren(municipalityId, signal)).items;
  const districts = children.filter((item) => item.level === "city_district");
  const chosen = districts.length ? districts : children.filter((item) => item.level === "settlement");
  const level: FineLevel = districts.length ? "city_district" : "settlement";
  // One bounding-box request for all outlines (Kamnik has 100+ settlements; one call each was 230 requests).
  const boxes = chosen.map((item) => item.bounds).filter((box): box is Bbox => Array.isArray(box) && box.length === 4);
  if (!chosen.length || !boxes.length) return { level, shapes: [] };
  const wanted = new Set(chosen.map((item) => item.id));
  const shapes = (await loadBoundariesInView(level, unionBbox(boxes), signal)).filter((shape) => wanted.has(shape.id))
    .map((shape): MunicipalityShape => ({ id: shape.id, name: shape.name, geometry: shape.geometry }));
  // Outlines the bbox call did not return (its cap) are fetched one by one.
  const found = new Set(shapes.map((shape) => shape.id));
  const missing = await Promise.all(chosen.filter((item) => !found.has(item.id)).map(async (item): Promise<MunicipalityShape | undefined> => {
    try {
      const boundary = await api("/api/v1/geographies/{id}/boundary", { params: { id: item.id }, query: { detail: "low" } }, signal);
      return { id: item.id, name: areaLabel(item.name), geometry: boundary.geometry as Geometry };
    } catch { return undefined; }
  }));
  return { level, shapes: [...shapes, ...missing.filter((item): item is MunicipalityShape => !!item)] };
}

/** Every area a sale lies in (district, settlement, municipality, region), narrowest first. */
export async function loadSaleAreas(id: number, signal?: AbortSignal): Promise<AreaRef[]> {
  const detail = await api("/api/v1/sales/transactions/{id}", { params: { id } }, signal);
  const order = ["city_district", "settlement", "municipality", "statistical_region"];
  return [...detail.geographies].filter((item) => order.includes(item.level)).sort((a, b) => order.indexOf(a.level) - order.indexOf(b.level)).map(clean);
}
