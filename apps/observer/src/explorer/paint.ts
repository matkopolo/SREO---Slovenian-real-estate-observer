import { marks } from "../palette";
import type { AgreementPoint, MapBuilding, MunicipalityShape, PropertyGroup } from "../api";
import { addressLabel } from "../components/AreaSearch";
import type { AreaPaint, MapAgreementPoint, MapBuildingPoint } from "../components/ExplorerMap";
import { date, euro, integer, landArea } from "../format";
import { t } from "../i18n";
import { METRICS, type MetricId } from "../metrics";
import { NOUNS } from "../nouns";
import { count, NOUN_FORMS } from "../plural";
import type { AreaValue } from "../pooling";
import { buildingKey } from "../url-state";
import type { NewBuildingPoint } from "./useMapLayers";

/** Pure builders for what the map draws: area colours and labels, building and agreement points. */

/** A building dot's smallest radius and how it grows with its agreements (pixels). */
const BUILDING_DOT_PX = 6;
const BUILDING_DOT_GROWTH_PX = 2;
/** A building without a median (one or two agreements) is drawn white. */
const NO_MEDIAN_COLOR = "#ffffff";

/** The layer label for the chosen property type (sales and rental layers only): "Mediana cene hiš". */
export function typedLabel(id: MetricId, group: PropertyGroup): string {
  const { label, typed } = METRICS[id];
  return typed ? typed(NOUNS[group].genitive) : label;
}

const paintOf = (name: string, value: string, extra: Omit<AreaPaint, "name" | "value" | "label">): AreaPaint => ({ name, value, label: `${name}: ${value}`, ...extra });
const byId = (values: AreaValue[]) => new Map(values.map((item) => [item.geographyId, item]));

/** Municipalities (or regions) coloured by the layer; labels name the period and sample, pooled values say so. */
export function areaPaint(shapes: MunicipalityShape[], values: AreaValue[], { metric, ramp, period, countWithheld = false }: {
  metric: MetricId; ramp: (value: number | null) => string; period: string;
  /** Name the count of a withheld area ("premalo poslov (12)"). */
  countWithheld?: boolean;
}): Map<number, AreaPaint> {
  const definition = METRICS[metric];
  const lookup = byId(values);
  return new Map(shapes.map((shape) => {
    const item = lookup.get(shape.id);
    const value = item?.value ?? null;
    const text = item == null || value == null ? (countWithheld ? t("premalo poslov ({count})", { count: integer(item?.sample ?? 0) }) : t("premalo poslov"))
      : [definition.format(value), item.pooled ? t("združeno {years}", { years: count(item.pooled, NOUN_FORMS.leto) }) : "",
        definition.usesYears ? `n = ${integer(item.sample)}, ${period}` : ""].filter(Boolean).join(", ");
    return [shape.id, paintOf(shape.name, text, { color: ramp(value), pooled: !!item?.pooled })];
  }));
}

/**
 * Districts and settlements: their own classes on the same ramp (on the municipal classes they would all share
 * the top one; the municipalities underneath are drawn neutral meanwhile); sale or rent medians only.
 */
export function finePaint(shapes: MunicipalityShape[], values: AreaValue[], { ramp, period, metric = "salePrice" }: { ramp: (value: number | null) => string; period: string; metric?: MetricId }): Map<number, AreaPaint> {
  const lookup = byId(values);
  return new Map(shapes.map((shape) => {
    const item = lookup.get(shape.id);
    const text = !item || item.value == null ? t("premalo poslov ({count})", { count: integer(item?.sample ?? 0) })
      : `${METRICS[metric === "rentPrice" ? "rentPrice" : "salePrice"].format(item.value)}, n = ${integer(item.sample)}, ${item.pooled ? t("združeno 5 let") : period}`;
    return [shape.id, paintOf(shape.name, text, { color: ramp(item?.value ?? null), pooled: !!item?.pooled })];
  }));
}

/** Buildings with agreements at street zoom: their own scale, size by count. */
export function buildingPoints(buildings: MapBuilding[], { ramp, rent, span }: { ramp: (value: number | null) => string; rent: boolean; span: string }): MapBuildingPoint[] {
  return buildings.map((item) => {
    const key = buildingKey({ ko: item.cadastralMunicipalityCode, st: item.buildingNumber });
    const median = item.medianAmountPerSqm;
    const value = median == null ? t("premalo za mediano") : item.transactionCount === 1 ? `${integer(median)} €/m²` : t("mediana {value}", { value: `${integer(median)} €/m²` });
    const latest = item.latestContractDate ? t("zadnja {date}", { date: `${Number(item.latestContractDate.slice(5, 7))}/${item.latestContractDate.slice(0, 4)}` }) : "";
    const label = [`${addressLabel(item) || t("Stavba {id}", { id: key })}: ${count(item.transactionCount, rent ? NOUN_FORMS.najem : NOUN_FORMS.prodaja)} (${span})`, value, latest].filter(Boolean).join(", ");
    return { key, lon: item.longitude, lat: item.latitude, color: median == null ? NO_MEDIAN_COLOR : ramp(median),
      radius: BUILDING_DOT_PX + Math.sqrt(item.transactionCount) * BUILDING_DOT_GROWTH_PX, label };
  });
}

/** Single agreements at the closest zoom, then new buildings (their cadastre EID as the id). */
export function agreementPoints(agreements: AgreementPoint[], newBuildings: NewBuildingPoint[], { ramp, rent }: { ramp: (value: number | null) => string; rent: boolean }): MapAgreementPoint[] {
  return [
    ...agreements.map((item): MapAgreementPoint => {
      const vars = { date: item.date ? date(item.date) : "", value: item.perSqm == null ? "—" : METRICS[rent ? "rentPrice" : "salePrice"].format(item.perSqm) };
      // Land: the total price says more than €/m² alone ("34.829 € za 2,44 ha").
      const total = !rent && item.perSqm != null && item.area ? t("{price} skupaj", { price: euro(Math.round(item.perSqm * item.area)) }) : "";
      return { kind: "agreement", id: item.id, lon: item.at[0], lat: item.at[1], color: ramp(item.perSqm),
        label: [rent ? t("Najem {date}: {value}", vars) : t("Prodaja {date}: {value}", vars), item.area ? landArea(item.area) : "", total].filter(Boolean).join(", ") };
    }),
    ...newBuildings.map((item): MapAgreementPoint => ({ kind: "new", id: item.id, lon: item.at[0], lat: item.at[1], color: marks().newBuilding, label: t("Nova stavba, zgrajena {year}", { year: item.year ?? "—" }) })),
  ];
}

/** Ray casting on GeoJSON (multi)polygons: is the map centre inside this area? */
export function containsPoint(geometry: MunicipalityShape["geometry"] | undefined, [x, y]: [number, number]): boolean {
  if (!geometry) return false;
  const polygons = geometry.type === "Polygon" ? [geometry.coordinates] : geometry.type === "MultiPolygon" ? geometry.coordinates : [];
  return polygons.some((rings) => {
    let inside = false;
    for (const ring of rings) for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const [xi, yi] = ring[i], [xj, yj] = ring[j];
      if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
    }
    return inside;
  });
}
