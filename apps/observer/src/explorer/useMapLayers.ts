import { useMemo } from "react";
import {
  bboxOf, loadAgreementPoints, loadBoundariesInView, loadBuildingsInView, loadMetric, loadNewBuildingsInView, loadSubAreas, loadSubAreaValues,
  periodWindows, widerPeriods, type Bbox, type PeriodWindows, type MunicipalityShape, type Period, type PropertyGroup, type Segment,
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

type Windows = PeriodWindows;
const windowKey = (windows: Windows) => `${windows.sales.current.from}_${windows.sales.current.to}_${windows.rents.current.from}_${windows.rents.current.to}`;
const boxKey = (bbox: Bbox) => bbox.map((value) => value.toFixed(4)).join(",");

/** The period's windows; buildings always cover five years (one count per building everywhere), a chosen range stays as chosen. */
export function usePeriodWindows(cutoff: string | undefined, years: Period) {
  return useMemo(() => cutoff ? { windows: periodWindows(cutoff, years), buildings: periodWindows(cutoff, typeof years === "string" ? years : 5) } : undefined, [cutoff, years]);
}

/** Municipal and regional values of the map layer; thin municipalities borrow 3 or 5 years (drawn lighter and labelled). */
export function useChoropleth(cutoff: string | undefined, years: Period, layer: MetricId, segment: Segment, windows: Windows | undefined) {
  const definition = METRICS[layer];
  const base = windows ? `${layer}|${JSON.stringify(segment)}|${windowKey(windows)}` : null;
  const municipal = useLoad(base && `municipal|${base}`, (signal) => loadMetric(layer, windows!.sales.current, "municipality", signal, segment, windows!.rents.current));
  const wider = definition.usesYears && definition.minimumSample > 1 ? widerPeriods(years) : [];
  const pooled = useLoad(base && cutoff && wider.length ? `pooled|${base}|${wider.join(",")}` : null, (signal) => Promise.all(wider.map(async (span) => {
    const pooledWindows = periodWindows(cutoff!, span);
    return { years: span, values: await loadMetric(layer, pooledWindows.sales.current, "municipality", signal, segment, pooledWindows.rents.current) };
  })));
  const regional = useLoad(base && definition.regional ? `regional|${base}` : null,
    (signal) => loadMetric(layer, windows!.sales.current, "statistical_region", signal, segment, windows!.rents.current));
  const shown = useMemo<AreaValue[]>(() => pool(municipal.data ?? [], pooled.data ?? [], definition.minimumSample), [definition.minimumSample, municipal.data, pooled.data]);
  const regionShown = useMemo<AreaValue[]>(() => (regional.data ?? []).map((item) => ({ ...item, value: item.sample >= definition.minimumSample ? item.value : null })),
    [definition.minimumSample, regional.data]);
  return { shown, regionShown, failed: municipal.error != null, retry: municipal.retry };
}

/**
 * Everything the map loads for the visible area: from zoom 11 every district in view (settlements where a municipality
 * has none), from street zoom buildings, at the closest zoom single agreements and new buildings. Loads wait until the
 * map has stopped moving, and a layer the zoom no longer shows is dropped at once.
 */
export function useViewLayers({ view, cutoff, years, layer, group, segment, windows, buildingWindows }: {
  view?: MapView; cutoff?: string; years: Period; layer: MetricId; group: PropertyGroup; segment: Segment; windows?: Windows; buildingWindows?: Windows;
}) {
  const settled = useDebounced(view, 250);
  const at = (zoom: number) => !!view && !!settled && view.zoom >= zoom && settled.zoom >= zoom;
  const segmentKey = JSON.stringify(segment);
  const rent = layer === "rentPrice";
  const kind = rent ? "rent" as const : "sale" as const;

  const fineKey = windows && settled && at(FINE_ZOOM) && FINE_LAYERS.includes(layer) ? `fine|${boxKey(settled.bbox)}|${layer}|${segmentKey}|${windowKey(windows)}|${years}` : null;
  const fine = useLoad(fineKey, async (signal) => {
    const bbox = settled!.bbox;
    const window = rent ? windows!.rents.current : windows!.sales.current;
    // Like the panel, thin districts/settlements borrow five years (drawn lighter, labelled).
    const wide = cutoff && widerPeriods(years).length ? periodWindows(cutoff, 5) : undefined;
    const wideWindow = wide ? (rent ? wide.rents.current : wide.sales.current) : undefined;
    const [districts, settlements, districtValues, settlementValues, districtWide, settlementWide] = await Promise.all([
      loadBoundariesInView("city_district", bbox, signal), loadBoundariesInView("settlement", bbox, signal),
      loadSubAreaValues("city_district", bbox, window, segment, signal, kind), loadSubAreaValues("settlement", bbox, window, segment, signal, kind),
      wideWindow ? loadSubAreaValues("city_district", bbox, wideWindow, segment, signal, kind) : Promise.resolve([]),
      wideWindow ? loadSubAreaValues("settlement", bbox, wideWindow, segment, signal, kind) : Promise.resolve([]),
    ]);
    const covered = new Set(districts.map((item) => item.parentId));
    const shapes: MunicipalityShape[] = [...districts, ...settlements.filter((item) => !covered.has(item.parentId))];
    return { shapes, values: pool([...districtValues, ...settlementValues], [{ years: 5, values: [...districtWide, ...settlementWide] }]) };
  }, { keepPrevious: true });

  const street = windows && buildingWindows && settled && at(BUILDING_ZOOM);
  const closest = street && at(AGREEMENT_ZOOM);
  const bbox = settled ? boxKey(settled.bbox) : "";
  // Land has no buildings: its sales are drawn as single points from street zoom on.
  const buildings = useLoad(street && group !== "land" ? `buildings|${bbox}|${kind}|${segmentKey}|${windowKey(buildingWindows)}` : null,
    async (signal) => (await loadBuildingsInView(settled!.bbox, rent ? buildingWindows!.rents.current : buildingWindows!.sales.current, segment, kind, signal)).items);
  const agreementsKey = street && group === "land" ? `agreements|${bbox}|sale|${segmentKey}|${windowKey(buildingWindows)}`
    : closest ? `agreements|${bbox}|${kind}|${segmentKey}|${windowKey(windows)}` : null;
  const agreements = useLoad(agreementsKey, (signal) => group === "land"
    ? loadAgreementPoints(settled!.bbox, buildingWindows!.sales.current, segment, "sale", signal)
    : loadAgreementPoints(settled!.bbox, rent ? windows!.rents.current : windows!.sales.current, segment, kind, signal));
  const newBuildings = useLoad(closest && group !== "land" && layer === "newBuildings" ? `new|${bbox}|${windowKey(windows)}` : null, async (signal) => {
    const response = await loadNewBuildingsInView(settled!.bbox, Number(windows!.sales.current.from.slice(0, 4)), Number(windows!.sales.current.to.slice(0, 4)), signal);
    return response.items.map((item) => ({ id: item.id, at: [item.longitude, item.latitude] as [number, number], year: item.yearBuilt ?? undefined }));
  });

  return {
    fine: (fineKey ? fine.data : undefined) ?? { shapes: [], values: [] },
    buildings: buildings.data ?? [], agreements: agreements.data ?? [], newBuildings: newBuildings.data ?? [],
  };
}

/** Inside a municipality: its districts or settlements with their own medians (a thin one borrows five years). */
export function useSubAreas(municipalityId: number | undefined, municipalShapes: MunicipalityShape[], cutoff: string | undefined, years: Period, segment: Segment, windows?: Windows) {
  const sub = useLoad(municipalityId ? `sub-areas-${municipalityId}` : null, async (signal) => ({ owner: municipalityId!, ...await loadSubAreas(municipalityId!, signal) }));
  const box = useMemo(() => bboxOf(municipalShapes.find((shape) => shape.id === municipalityId)?.geometry), [municipalShapes, municipalityId]);
  const wide = cutoff && widerPeriods(years).length ? periodWindows(cutoff, 5).sales.current : undefined;
  const values = useLoad(sub.data && box && windows ? `sub-values|${sub.data.owner}|${JSON.stringify(segment)}|${windowKey(windows)}|${wide?.from ?? ""}` : null, async (signal) => {
    const [own, pooled] = await Promise.all([loadSubAreaValues(sub.data!.level, box!, windows!.sales.current, segment, signal),
      wide ? loadSubAreaValues(sub.data!.level, box!, wide, segment, signal) : Promise.resolve([])]);
    return pool(own, [{ years: 5, values: pooled }]);
  });
  return { sub: sub.data, values: values.data ?? [] };
}
