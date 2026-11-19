import type { FeatureCollection, Geometry, Point } from "geojson";
import { MIN_SAMPLE, type MetricId, type MunicipalityValue } from "../metrics";
import { api, geoJson } from "./client";
import { bboxText, type Bbox } from "./geographies";
import type { DateWindow } from "./periods";
import { loadMunicipalDemographics } from "./statistics";
import { APARTMENTS, isDwelling, segmentQuery, type FineLevel, type GeographyLevel, type Segment, type TransactionKind } from "./types";

export const SLOVENIA_BBOX = "13.3,45.4,16.7,46.9";

/** What the geography map summaries carry (apps/real-estate-api/internal/httpapi/map.go, geographyMap). */
interface SummaryProperties {
  geographyId: number; transactionCount?: number; representativeCount?: number;
  medianPricePerSqm?: number | null; medianMonthlyRentPerSqm?: number | null;
}

/** One value per area (region or municipality) for the selected measure over fromYear–toYear (inclusive). */
export async function loadMetric(metric: MetricId, window: DateWindow, level: GeographyLevel = "municipality",
  signal?: AbortSignal, segment: Segment = APARTMENTS, rentWindow: DateWindow = window): Promise<MunicipalityValue[]> {
  const fromYear = Number(window.from.slice(0, 4));
  const toYear = Number(window.to.slice(0, 4));
  if (metric === "grossYield") {
    const [sales, rents] = await Promise.all([loadMetric("salePrice", window, level, signal, segment), loadMetric("rentPrice", rentWindow, level, signal, segment)]);
    const rentById = new Map(rents.map((item) => [item.geographyId, item]));
    return sales.map((sale) => {
      const rent = rentById.get(sale.geographyId);
      const publishable = sale.value != null && rent?.value != null && sale.sample >= MIN_SAMPLE && rent.sample >= MIN_SAMPLE;
      return { geographyId: sale.geographyId, sample: Math.min(sale.sample, rent?.sample ?? 0),
        value: publishable && rent?.value != null && sale.value != null ? (rent.value * 12) / sale.value * 100 : null, rent: rent?.value ?? null, price: sale.value };
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
    return response.items.flatMap((item) => item.geographyId == null ? [] : [{ geographyId: item.geographyId, value: item.buildings, sample: item.buildings }]);
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
  const response = geoJson<Point, SummaryProperties>(metric === "rentPrice"
    ? await api("/api/v1/rentals/map/geographies", { query }, signal)
    : await api("/api/v1/map/geographies", { query }, signal), "map/geographies");
  return response.features.map(({ properties }) => {
    const sample = metric === "saleVolume" ? properties.transactionCount ?? 0 : properties.representativeCount ?? 0;
    const value = metric === "saleVolume" ? properties.transactionCount ?? null
      : metric === "rentPrice" ? properties.medianMonthlyRentPerSqm ?? null : properties.medianPricePerSqm ?? null;
    return { geographyId: properties.geographyId, value, sample };
  });
}

/** Median €/m² and sales per sub-area inside a bounding box. */
export async function loadSubAreaValues(level: FineLevel, bbox: Bbox, window: DateWindow, segment: Segment, signal?: AbortSignal,
  kind: TransactionKind = "sale"): Promise<MunicipalityValue[]> {
  const query = { query: { ...window, ...segmentQuery(segment), level, bbox: bboxText(bbox) } };
  // Rents come from the rental summaries (€/m² per month); everything else at this level is the sale median.
  const response = geoJson<Point, SummaryProperties>(kind === "rent" ? await api("/api/v1/rentals/map/geographies", query, signal)
    : await api("/api/v1/map/geographies", query, signal), "map/geographies");
  return response.features.map(({ properties }) => ({ geographyId: properties.geographyId,
    value: (kind === "rent" ? properties.medianMonthlyRentPerSqm : properties.medianPricePerSqm) ?? null, sample: properties.representativeCount ?? 0 }));
}

/** Buildings with agreements inside the visible map (street zoom). */
export const loadBuildingsInView = (bbox: Bbox, window: DateWindow, segment: Segment, kind: TransactionKind, signal?: AbortSignal) =>
  api("/api/v1/map/buildings", { query: { bbox: bboxText(bbox), ...window, ...segmentQuery(segment), transactionKind: kind, limit: 3000 } }, signal);

/** What a sale or rental point carries (map.go mapProperties / rentals.go rentalMapProperties: the PropertyPoint structs). */
interface AgreementProperties {
  transactionId: number; pricePerSqm?: number | null; monthlyRentPerSqm?: number | null; contractDate?: string | null; area?: number | null;
  cadastralMunicipalityCode?: number | null; buildingNumber?: string | null;
}
export interface AgreementPoint { id: number; at: [number, number]; perSqm: number | null; date: string | null; area: number | null; building?: { ko: number; st: string } }

/** Individual agreements at the closest zoom (each point opens its evidence). */
export async function loadAgreementPoints(bbox: Bbox, window: DateWindow, segment: Segment, kind: TransactionKind, signal?: AbortSignal): Promise<AgreementPoint[]> {
  const query = { bbox: bboxText(bbox), ...window, ...segmentQuery(segment), limit: 500 };
  const collection = geoJson<Point, AgreementProperties>(kind === "sale" ? await api("/api/v1/map/properties", { query }, signal)
    : await api("/api/v1/rentals/map/properties", { query }, signal), "map/properties");
  return collection.features.map((feature) => ({ id: feature.properties.transactionId, at: [feature.geometry.coordinates[0], feature.geometry.coordinates[1]],
    building: feature.properties.cadastralMunicipalityCode && feature.properties.buildingNumber ? { ko: feature.properties.cadastralMunicipalityCode, st: feature.properties.buildingNumber } : undefined,
    perSqm: feature.properties.pricePerSqm ?? feature.properties.monthlyRentPerSqm ?? null, date: feature.properties.contractDate ?? null, area: feature.properties.area ?? null }));
}

/** New buildings registered in the visible map. */
export const loadNewBuildingsInView = (bbox: Bbox, fromYear: number, toYear: number, signal?: AbortSignal) =>
  api("/api/v1/construction/map", { query: { bbox: bboxText(bbox), zoom: 15, fromYear, toYear } }, signal);

/** One polygon of the DRSV flood hazard overlay: a hazard class, or an area with a hydraulic study. */
export type FloodZoneProperties = { kind: "zone" | "study"; hazardClass: "Pv" | "Ps" | "Pm" | "Pp" | null };
export interface FloodZones { features: FeatureCollection<Geometry, FloodZoneProperties>; truncated: boolean }

/** The flood hazard classes and studied areas inside the visible map (the API serves views up to about one municipality). */
export async function loadFloodZones(bbox: Bbox, detail: "low" | "medium" | "high", signal?: AbortSignal): Promise<FloodZones> {
  const body = await api("/api/v1/hazards/floods", { query: { bbox: bboxText(bbox), detail } }, signal);
  const collection = geoJson<Geometry, FloodZoneProperties>(body, "hazards/floods");
  return { features: { type: "FeatureCollection", features: collection.features }, truncated: body.truncated };
}

interface DensityCell { at: [number, number]; count: number }
/** What a cluster carries (map.go mapClusters / rentals.go rentalMapClusters). */
interface ClusterProperties { transactionCount?: number }

/** Grid clusters of recorded sales and rentals across Slovenia. */
export async function loadDensity(fromYear: number, toYear: number, signal?: AbortSignal): Promise<{ sales: DensityCell[]; rentals: DensityCell[] }> {
  const query = { from: `${fromYear}-01-01`, to: `${toYear}-12-31`, propertyGroup: "apartment", bbox: SLOVENIA_BBOX, zoom: 9 };
  const cells = (body: unknown) => geoJson<Point, ClusterProperties>(body, "map/clusters").features.map((feature): DensityCell => ({
    at: [feature.geometry.coordinates[0], feature.geometry.coordinates[1]], count: feature.properties.transactionCount ?? 0 }));
  const [sales, rentals] = await Promise.all([api("/api/v1/map/clusters", { query }, signal), api("/api/v1/rentals/map/clusters", { query }, signal)]);
  return { sales: cells(sales), rentals: cells(rentals) };
}
