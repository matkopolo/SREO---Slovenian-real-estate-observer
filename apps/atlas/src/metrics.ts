/** The measures the atlas can extrude. Every value comes from a published API endpoint. */
export type MetricId = "salePrice" | "saleVolume" | "rentPrice" | "newBuildings";

export interface MetricDefinition {
  id: MetricId;
  label: string;
  short: string;
  unit: string;
  source: string;
  /** Minimum sample before a municipality is extruded (below it the value is shown as withheld). */
  minimumSample: number;
  format: (value: number) => string;
}

const integer = new Intl.NumberFormat("sl-SI", { maximumFractionDigits: 0 });
const oneDecimal = new Intl.NumberFormat("sl-SI", { minimumFractionDigits: 1, maximumFractionDigits: 1 });

export const METRICS: Record<MetricId, MetricDefinition> = {
  salePrice: { id: "salePrice", label: "Mediana cene stanovanj", short: "€/m²", unit: "€/m²",
    source: "GURS ETN · reprezentativni posli", minimumSample: 10, format: (value) => `${integer.format(value)} €/m²` },
  saleVolume: { id: "saleVolume", label: "Število prodaj stanovanj", short: "prodaje", unit: "poslov",
    source: "GURS ETN · vsi evidentirani posli", minimumSample: 1, format: (value) => `${integer.format(value)} poslov` },
  rentPrice: { id: "rentPrice", label: "Mediana najemnine stanovanj", short: "€/m² mesečno", unit: "€/m²/mesec",
    source: "GURS ETN · reprezentativni najemi", minimumSample: 10, format: (value) => `${oneDecimal.format(value)} €/m² / mesec` },
  newBuildings: { id: "newBuildings", label: "Nove vpisane stavbe", short: "stavbe", unit: "stavb",
    source: "GURS kataster stavb · leto izgradnje", minimumSample: 1, format: (value) => `${integer.format(value)} stavb` },
};

export interface MunicipalityValue {
  geographyId: number;
  value: number | null;
  sample: number;
}

/** Extrusion height in scene units; linear from zero so equal values keep equal heights. */
export function heightScale(values: Array<number | null>, maxHeight = 6) {
  const max = Math.max(0, ...values.filter((value): value is number => value != null && Number.isFinite(value)));
  return (value: number | null) => (value == null || max === 0 ? 0.15 : 0.15 + (value / max) * maxHeight);
}

/**
 * Single-hue sequential ramp (light → dark teal) for light themes, reversed lightness for dark themes.
 * Returns a CSS/three-compatible hex. Withheld values use a neutral grey.
 */
export function colorScale(values: Array<number | null>, dark: boolean) {
  const known = values.filter((value): value is number => value != null && Number.isFinite(value)).sort((a, b) => a - b);
  const stops = dark
    ? ["#1d3b45", "#245a63", "#2f7d7d", "#4fa597", "#87cdb5", "#c9f0dc"]
    : ["#d9efe7", "#a8d9c8", "#6fbfaa", "#3b9a89", "#1f7267", "#0e4a45"];
  const withheld = dark ? "#3a4048" : "#c9cdd1";
  return (value: number | null) => {
    if (value == null || known.length === 0) return withheld;
    // Quantile bins keep a skewed distribution (Ljubljana) from flattening every other municipality.
    let rank = 0;
    while (rank < known.length && known[rank] <= value) rank += 1;
    const bin = Math.min(stops.length - 1, Math.floor((rank / known.length) * stops.length - 1e-9));
    return stops[Math.max(0, bin)];
  };
}

export function quantileBreaks(values: Array<number | null>, bins = 6) {
  const known = values.filter((value): value is number => value != null && Number.isFinite(value)).sort((a, b) => a - b);
  if (!known.length) return [];
  return Array.from({ length: bins }, (_, index) => known[Math.min(known.length - 1, Math.floor(((index + 1) / bins) * known.length) - 1)]);
}
