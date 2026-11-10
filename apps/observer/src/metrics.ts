import type { PropertyGroup } from "./api";
import { t } from "./i18n";
import { decimal1, integer, percent as percentOf } from "./format";

/** The measures the municipality map can colour. Every value comes from a published API endpoint. */
export type MetricId = "salePrice" | "saleVolume" | "rentPrice" | "newBuildings" | "affordableSqm" | "share65" | "netMigration" | "releases" | "grossYield";

/** The API publishes a median from 30 representative agreements; every view uses the same threshold. */
export const MIN_SAMPLE = 30;

interface MetricDefinition {
  id: MetricId;
  label: string;
  /** The label for another property type (sales and rental layers): the noun is NOUNS[group].genitive. */
  typed?: (noun: string) => string;
  short: string;
  unit: string;
  source: string;
  /** Minimum sample before a municipality is coloured (below it the value is shown as withheld). */
  minimumSample: number;
  format: (value: number) => string;
  /** Whether the value depends on the selected years (demographic values are the latest published). */
  usesYears: boolean;
  /** Region values exist for this metric (others are municipal only). */
  regional: boolean;
  /** Diverging values (net migration) are shown around zero. */
  signed?: boolean;
}

/** Metric values are already in percent (12.3 means 12,3 %). */
const percent = (value: number) => percentOf(value / 100);

export const METRICS: Record<MetricId, MetricDefinition> = {
  salePrice: { id: "salePrice", label: t("Mediana cene stanovanj"), typed: (noun) => t("Mediana cene {noun}", { noun }), short: "€/m²", unit: "€/m²",
    source: t("GURS ETN, reprezentativni posli"), minimumSample: MIN_SAMPLE, format: (value) => `${value < 10 ? decimal1(value) : integer(value)} €/m²`, usesYears: true, regional: true },
  saleVolume: { id: "saleVolume", label: t("Število prodaj stanovanj"), typed: (noun) => t("Število prodaj {noun}", { noun }), short: t("prodaje"), unit: t("poslov"),
    source: t("GURS ETN, vsi evidentirani posli"), minimumSample: 1, format: (value) => t("{count} poslov", { count: integer(value) }), usesYears: true, regional: true },
  rentPrice: { id: "rentPrice", label: t("Mediana najemnine stanovanj"), typed: (noun) => t("Mediana najemnine {noun}", { noun }), short: t("€/m² mesečno"), unit: t("€/m²/mesec"),
    source: t("GURS ETN, reprezentativni najemi"), minimumSample: MIN_SAMPLE, format: (value) => t("{value} €/m² / mesec", { value: decimal1(value) }), usesYears: true, regional: true },
  affordableSqm: { id: "affordableSqm", label: t("m² za mediano plačo"), short: "m²", unit: "m²",
    source: t("SURS plače, Banka Slovenije in GURS ETN mediana, kredit 30 let"), minimumSample: MIN_SAMPLE, format: (value) => `${integer(value)} m²`, usesYears: true, regional: false },
  newBuildings: { id: "newBuildings", label: t("Nove vpisane stavbe"), short: t("stavbe"), unit: t("stavb"),
    source: t("GURS kataster stavb, leto izgradnje"), minimumSample: 1, format: (value) => t("{count} stavb", { count: integer(value) }), usesYears: true, regional: false },
  grossYield: { id: "grossYield", label: t("Bruto donos najema (ocena)"), short: "%", unit: t("% letno"),
    source: t("12 × mediana najemnine / mediana cene, GURS ETN; pred stroški, davki in praznimi meseci"), minimumSample: MIN_SAMPLE,
    format: percent, usesYears: true, regional: true },
  share65: { id: "share65", label: t("Delež prebivalcev 65+"), short: "% 65+", unit: "%",
    source: t("SURS 05C4004S, 1. januar zadnjega leta"), minimumSample: 1, format: percent, usesYears: false, regional: false },
  netMigration: { id: "netMigration", label: t("Neto selitve na 1.000 prebivalcev"), short: "‰", unit: t("‰ letno"),
    source: t("SURS 05I2002S, povprečje zadnjih 5 let brez let z več kot ±100 ‰ (popravki registra)"), minimumSample: 1, format: (value) => `${value > 0 ? "+" : ""}${decimal1(value)} ‰`,
    usesYears: false, regional: false, signed: true },
  releases: { id: "releases", label: t("Sproščena stanovanja starejših (modelno)"), short: t("na 1.000 stan."), unit: t("na 1.000 stanovanj letno"),
    source: t("Modelna ocena iz SURS 05C4004S, 05L2016S, 05E3002S, 0861102S"), minimumSample: 1,
    format: (value) => t("{value} / 1.000 stan.", { value: decimal1(value) }), usesYears: false, regional: false },
};

/** The colour of an area without a published value. */
export const WITHHELD = "#c9cdd1";

export interface MunicipalityValue {
  geographyId: number;
  value: number | null;
  sample: number;
}

/** The one sequential ramp of the map (five teal classes, light → dark): municipalities, districts and buildings alike. */
const TEAL = ["#d4ece3", "#93cfba", "#4fa894", "#24786c", "#0e4a45"];

/** Single-hue sequential ramp (light → dark) on the light map; withheld values use a neutral grey. */
export function colorScale(values: Array<number | null>) {
  // Five classes (ONS guidance for choropleths); the classes are the rounded legend breaks, so colour and legend agree.
  const stops = TEAL;
  const withheld = WITHHELD;
  const breaks = classBreaks(values);
  return (value: number | null) => {
    if (value == null || !breaks.length) return withheld;
    const index = breaks.findIndex((limit) => value <= limit);
    const bin = index < 0 ? breaks.length - 1 : index;
    return stops[breaks.length === 1 ? stops.length - 1 : Math.round((bin * (stops.length - 1)) / (breaks.length - 1))];
  };
}

/** Rounding step for legend values: 100 above 1.000, 10 above 100, 1 above 10, else 0,1. */
const roundingStep = (value: number) => value >= 1000 ? 100 : value >= 100 ? 10 : value >= 10 ? 0.5 : 0.1;

/**
 * Legend classes: quantile upper bounds rounded up to a readable step, merged when less than 3 % apart,
 * so the map never colours differences below the noise ("4.588 / 4.600 / 4.650").
 */
export function classBreaks(values: Array<number | null>, bins = 5) {
  const raw = quantileBreaks(values, bins);
  const rounded = raw.map((value) => { const step = roundingStep(Math.abs(value)); return Math.round(Math.ceil(value / step - 1e-9) * step * 10) / 10; });
  const merged: number[] = [];
  for (const value of rounded) {
    const last = merged.at(-1);
    if (last == null) merged.push(value);
    else if (value > last && (last <= 0 || value / last >= 1.03)) merged.push(value);
    else merged[merged.length - 1] = Math.max(last, value);
  }
  return merged;
}

export function quantileBreaks(values: Array<number | null>, bins = 5) {
  const known = values.filter((value): value is number => value != null && Number.isFinite(value)).sort((a, b) => a - b);
  if (!known.length) return [];
  const breaks = Array.from({ length: bins }, (_, index) => known[Math.max(0, Math.min(known.length - 1, Math.floor(((index + 1) / bins) * known.length) - 1))]);
  return [...new Set(breaks)];
}

/** Diverging ramp around zero (blue = gain, orange = loss), neutral grey at the midpoint. */
export function divergingScale(values: Array<number | null>) {
  const extent = robustExtent(values);
  const known = values.filter((value): value is number => value != null && Number.isFinite(value));
  const gain = ["#dfe7f1", "#a9c6ec", "#5d9be3", "#2a78d6"];
  const loss = ["#f3e3da", "#f4b796", "#ee8a59", "#eb6834"];
  const neutral = "#bfc4c8";
  return (value: number | null) => {
    if (value == null || !known.length) return WITHHELD;
    const t = Math.min(1, Math.abs(value) / extent); // values beyond the 95th percentile are clamped
    if (t < 0.06) return neutral;
    const step = Math.min(3, Math.floor(t * 4));
    return value > 0 ? gain[step] : loss[step];
  };
}

/** Symmetric breaks for the diverging legend. */
export function divergingBreaks(values: Array<number | null>) {
  if (!values.some((value) => value != null && Number.isFinite(value))) return [];
  const extent = robustExtent(values);
  return [-extent, -extent / 2, 0, extent / 2, extent];
}

/** 95th percentile of |value|, so one registry artefact cannot flatten every other area. */
function robustExtent(values: Array<number | null>) {
  const sizes = values.filter((value): value is number => value != null && Number.isFinite(value)).map(Math.abs).sort((a, b) => a - b);
  if (!sizes.length) return 1e-9;
  return Math.max(1e-9, sizes[Math.max(0, Math.ceil(sizes.length * 0.95) - 1)]);
}

const LAYERS: MetricId[] = ["salePrice", "rentPrice", "affordableSqm", "grossYield", "saleVolume", "newBuildings", "share65", "netMigration", "releases"];
/** Map layers for a property type: wage-based layers only for homes; land and garages have only sale prices and counts. */
export function layersFor(group: PropertyGroup): MetricId[] {
  if (group === "land" || group === "garage") return ["salePrice", "saleVolume"];
  return group === "apartment" || group === "house" ? LAYERS : LAYERS.filter((id) => id !== "affordableSqm");
}
