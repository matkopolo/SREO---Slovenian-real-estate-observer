import { useMemo } from "react";
import {
  bboxOf, loadAgreementPoints, loadBoundariesInView, loadBuildingsInView, loadMetric, loadNewBuildingsInView, loadSubAreas, loadSubAreaValues,
  periodWindows, widerPeriods, type AgreementPoint, type Bbox, type DateWindow, type FineLevel, type PeriodWindows, type MapBuilding, type MunicipalityShape,
  type Period, type PropertyGroup, type Segment, type TransactionKind,
} from "../api";
import { useDebounced } from "../hooks/useDebounced";
import { useLoad } from "../hooks/useLoad";
import { METRICS, type MetricId } from "../metrics";
import { pool, type AreaValue } from "../pooling";
import { AGREEMENT_ZOOM, BUILDING_ZOOM } from "../components/map-zoom";
import type { MapView } from "../components/ExplorerMap";

/** Zoom thresholds of the map levels (the original dashboard used 7.6 / 9.4 / 12). */
export const REGION_ZOOM = 7.8;
export const FINE_ZOOM = 11;
/** Districts and settlements only have sale and rent medians; other layers stay on municipalities when zoomed in. */
export const FINE_LAYERS: MetricId[] = ["salePrice", "rentPrice"];
/** The map waits this long after a move before loading what the view shows. */
const SETTLE_MS = 250;
/** The pooled window thin districts and settlements borrow. */
const POOLED_YEARS = 5;

type Windows = PeriodWindows;
const windowKey = (windows: Windows) => `${windows.sales.current.from}_${windows.sales.current.to}_${windows.rents.current.from}_${windows.rents.current.to}`;
const boxKey = (bbox: Bbox) => bbox.map((value) => value.toFixed(4)).join(",");
const segmentKey = (segment: Segment) => JSON.stringify(segment);

/** Stable empties, so a view without data never re-sends empty data to the map on every render. */
const NO_VALUES: AreaValue[] = [];
const NO_BUILDINGS: MapBuilding[] = [];
const NO_AGREEMENTS: AgreementPoint[] = [];
export interface NewBuildingPoint { id: string; at: [number, number]; year?: number }
const NO_NEW_BUILDINGS: NewBuildingPoint[] = [];
export interface FineAreas { shapes: MunicipalityShape[]; values: AreaValue[] }
const NO_FINE: FineAreas = { shapes: [], values: [] };

/** The period's windows; buildings always cover five years (one count per building everywhere), a chosen range stays as chosen. */
export function usePeriodWindows(cutoff: string | undefined, years: Period) {
  return useMemo(() => cutoff ? { windows: periodWindows(cutoff, years), buildings: periodWindows(cutoff, typeof years === "string" ? years : POOLED_YEARS) } : undefined, [cutoff, years]);
}

/** Municipal and regional values of the map layer; thin municipalities borrow 3 or 5 years (drawn lighter and labelled). */
export function useChoropleth(cutoff: string | undefined, years: Period, layer: MetricId, segment: Segment, windows: Windows | undefined) {
  const definition = METRICS[layer];
  const base = windows ? { layer, segment, windows, cutoff, key: `${layer}|${segmentKey(segment)}|${windowKey(windows)}` } : null;
  const municipal = useLoad(base, (input) => `municipal|${input.key}`,
    (input, signal) => loadMetric(input.layer, input.windows.sales.current, "municipality", signal, input.segment, input.windows.rents.current));
  const wider = definition.usesYears && definition.minimumSample > 1 ? widerPeriods(years) : [];
  const pooled = useLoad(base && base.cutoff && wider.length ? { ...base, cutoff: base.cutoff, wider } : null,
    (input) => `pooled|${input.key}|${input.wider.join(",")}`,
    (input, signal) => Promise.all(input.wider.map(async (span) => {
      const pooledWindows = periodWindows(input.cutoff, span);
      return { years: span, values: await loadMetric(input.layer, pooledWindows.sales.current, "municipality", signal, input.segment, pooledWindows.rents.current) };
    })));
  const regional = useLoad(base && definition.regional ? base : null, (input) => `regional|${input.key}`,
    (input, signal) => loadMetric(input.layer, input.windows.sales.current, "statistical_region", signal, input.segment, input.windows.rents.current));
  const shown = useMemo<AreaValue[]>(() => pool(municipal.data ?? [], pooled.data ?? [], definition.minimumSample), [definition.minimumSample, municipal.data, pooled.data]);
  const regionShown = useMemo<AreaValue[]>(() => (regional.data ?? []).map((item) => ({ ...item, value: item.sample >= definition.minimumSample ? item.value : null })),
    [definition.minimumSample, regional.data]);
  return { shown, regionShown, failed: municipal.error != null, retry: municipal.retry };
}

/** What every load of the visible map has in common: the settled view, the kind drawn and the segment. */
interface ViewInput { bbox: Bbox; kind: TransactionKind; segment: Segment; windows: Windows }
const sameMeaning = (previous: ViewInput, next: ViewInput) => previous.kind === next.kind && segmentKey(previous.segment) === segmentKey(next.segment);

/**
 * Everything the map loads for the visible area: from zoom 11 every district in view (settlements where a municipality
 * has none), from street zoom buildings, at the closest zoom single agreements and new buildings. Loads wait until the
 * map has stopped moving, and a layer the zoom no longer shows is dropped at once.
 */
export function useViewLayers({ view, cutoff, years, layer, group, segment, windows, buildingWindows }: {
  view?: MapView; cutoff?: string; years: Period; layer: MetricId; group: PropertyGroup; segment: Segment; windows?: Windows; buildingWindows?: Windows;
}) {
  const settled = useDebounced(view, SETTLE_MS);
  const at = (zoom: number) => !!view && !!settled && view.zoom >= zoom && settled.zoom >= zoom;
  const kind: TransactionKind = layer === "rentPrice" ? "rent" : "sale";
  const windowOf = (spans: Windows) => kind === "rent" ? spans.rents.current : spans.sales.current;

  const fineInput = windows && settled && at(FINE_ZOOM) && FINE_LAYERS.includes(layer)
    ? { bbox: settled.bbox, kind, segment, windows, years, cutoff } : null;
  // The previous answer stays while the next loads (a pan never blinks), but never an answer for another kind or type.
  const fine = useLoad(fineInput, (input) => `fine|${boxKey(input.bbox)}|${input.kind}|${segmentKey(input.segment)}|${windowKey(input.windows)}|${input.years}`,
    async (input, signal): Promise<FineAreas> => {
      const window = windowOf(input.windows);
      // Like the panel, thin districts/settlements borrow five years (drawn lighter, labelled).
      const wide = input.cutoff && widerPeriods(input.years).length ? windowOf(periodWindows(input.cutoff, POOLED_YEARS)) : undefined;
      const values = (level: FineLevel, span: DateWindow | undefined) => span ? loadSubAreaValues(level, input.bbox, span, input.segment, signal, input.kind) : Promise.resolve([]);
      const [districts, settlements, districtValues, settlementValues, districtWide, settlementWide] = await Promise.all([
        loadBoundariesInView("city_district", input.bbox, signal), loadBoundariesInView("settlement", input.bbox, signal),
        values("city_district", window), values("settlement", window), values("city_district", wide), values("settlement", wide),
      ]);
      const covered = new Set(districts.map((item) => item.parentId));
      const shapes: MunicipalityShape[] = [...districts, ...settlements.filter((item) => !covered.has(item.parentId))];
      return { shapes, values: pool([...districtValues, ...settlementValues], [{ years: POOLED_YEARS, values: [...districtWide, ...settlementWide] }]) };
    }, { keepPrevious: sameMeaning });

  const street = !!windows && !!buildingWindows && !!settled && at(BUILDING_ZOOM);
  const closest = street && at(AGREEMENT_ZOOM);
  const viewInput = (spans: Windows | undefined): ViewInput | null => settled && spans ? { bbox: settled.bbox, kind, segment, windows: spans } : null;
  // Land has no buildings: its sales are drawn as single points from street zoom on.
  const buildings = useLoad(street && group !== "land" ? viewInput(buildingWindows) : null,
    (input) => `buildings|${boxKey(input.bbox)}|${input.kind}|${segmentKey(input.segment)}|${windowKey(input.windows)}`,
    async (input, signal) => (await loadBuildingsInView(input.bbox, windowOf(input.windows), input.segment, input.kind, signal)).items);
  const agreementInput: ViewInput | null = street && group === "land" ? (viewInput(buildingWindows) && { ...viewInput(buildingWindows) as ViewInput, kind: "sale" })
    : closest ? viewInput(windows) : null;
  const agreements = useLoad(agreementInput, (input) => `agreements|${boxKey(input.bbox)}|${input.kind}|${segmentKey(input.segment)}|${windowKey(input.windows)}`,
    (input, signal) => loadAgreementPoints(input.bbox, input.kind === "rent" ? input.windows.rents.current : input.windows.sales.current, input.segment, input.kind, signal));
  const newBuildings = useLoad(closest && group !== "land" && layer === "newBuildings" ? viewInput(windows) : null,
    (input) => `new|${boxKey(input.bbox)}|${windowKey(input.windows)}`, async (input, signal): Promise<NewBuildingPoint[]> => {
      const response = await loadNewBuildingsInView(input.bbox, Number(input.windows.sales.current.from.slice(0, 4)), Number(input.windows.sales.current.to.slice(0, 4)), signal);
      return response.items.map((item) => ({ id: item.id, at: [item.longitude, item.latitude], year: item.yearBuilt ?? undefined }));
    });

  return {
    fine: (fineInput ? fine.data : undefined) ?? NO_FINE,
    buildings: buildings.data ?? NO_BUILDINGS, agreements: agreements.data ?? NO_AGREEMENTS, newBuildings: newBuildings.data ?? NO_NEW_BUILDINGS,
  };
}

/** Inside a municipality: its districts or settlements with their own medians (a thin one borrows five years). */
export function useSubAreas(municipalityId: number | undefined, municipalShapes: MunicipalityShape[], cutoff: string | undefined, years: Period, segment: Segment, windows?: Windows) {
  const sub = useLoad(municipalityId ?? null, (id) => `sub-areas-${id}`, async (id, signal) => ({ owner: id, ...await loadSubAreas(id, signal) }));
  const box = useMemo(() => bboxOf(municipalShapes.find((shape) => shape.id === municipalityId)?.geometry), [municipalShapes, municipalityId]);
  const wide = cutoff && widerPeriods(years).length ? periodWindows(cutoff, POOLED_YEARS).sales.current : undefined;
  const values = useLoad(sub.data && box && windows ? { sub: sub.data, box, windows, segment, wide } : null,
    (input) => `sub-values|${input.sub.owner}|${segmentKey(input.segment)}|${windowKey(input.windows)}|${input.wide?.from ?? ""}`,
    async (input, signal) => {
      const [own, pooled] = await Promise.all([loadSubAreaValues(input.sub.level, input.box, input.windows.sales.current, input.segment, signal),
        input.wide ? loadSubAreaValues(input.sub.level, input.box, input.wide, input.segment, signal) : Promise.resolve([])]);
      return pool(own, [{ years: POOLED_YEARS, values: pooled }]);
    });
  return { sub: sub.data, values: values.data ?? NO_VALUES };
}
