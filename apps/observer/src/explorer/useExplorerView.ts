import { useMemo } from "react";
import { bboxOf, loadFloodZones, type AgreementPoint, type Bbox, type BuildingStatistics, type FloodZones, type Geography, type MapBuilding, type MunicipalityShape } from "../api";
import type { Scope } from "../components/AreaModules";
import type { MapAgreementPoint, MapBuildingPoint, MapView } from "../components/ExplorerMap";
import { radiusBbox } from "../components/map-geometry";
import { FLOOD_ZOOM } from "../components/map-zoom";
import { useLoad } from "../hooks/useLoad";
import { t } from "../i18n";
import type { Scale } from "./MapLegend";
import { classBreaks, colorScale, divergingBreaks, divergingScale, METRICS, type MetricId } from "../metrics";
import { familyOf, type Family } from "../palette";
import { form, forms, NOUN_FORMS, type Forms } from "../plural";
import type { AreaValue } from "../pooling";
import type { ShownComparables } from "../components/ValueCheck";
import { agreementPoints, areaPaint, buildingPoints, finePaint, typedLabel } from "./paint";
import type { FineAreas, NewBuildingPoint } from "./useMapLayers";

/** The hooks behind ExplorerView: scales and paint, rankings for the panel, the map's focus and marker, the flood overlay. */

const REGION_FORMS = forms(["regija", "regiji", "regije", "regij"], ["region", "regions"]); // i18n-ignore (plural forms, both languages)
const DISTRICT_FORMS = forms(["četrtna skupnost", "četrtni skupnosti", "četrtne skupnosti", "četrtnih skupnosti"], ["city district", "city districts"]); // i18n-ignore (plural forms, both languages)

export interface RankItem { id: number; name: string; value: number | null; sample: number; format: (value: number) => string; label: string; pooled?: number; populationSample?: boolean; unit?: Forms }

export const scaleOf = (values: Array<number | null>, family: Family = "price"): Scale => ({ breaks: classBreaks(values), ramp: colorScale(values, family) });

interface ScalesInput {
  layer: MetricId; rent: boolean; landPoints: boolean; periodShort: string; buildingSpan: string;
  shown: AreaValue[]; regionShown: AreaValue[]; municipalShapes: MunicipalityShape[]; regionShapes: MunicipalityShape[];
  subShapes: MunicipalityShape[]; subValues: AreaValue[]; fine: FineAreas;
  buildings: MapBuilding[]; agreements: AgreementPoint[]; newBuildings: NewBuildingPoint[];
}

/** One colour scale per drawn level (municipal, regional, the selected municipality's sub-areas, the view's fine areas, buildings), and the paint built on it. */
export function useExplorerScales({ layer, rent, landPoints, periodShort, buildingSpan, shown, regionShown, municipalShapes, regionShapes, subShapes, subValues, fine, buildings, agreements, newBuildings }: ScalesInput) {
  const definition = METRICS[layer];
  const municipalScale = useMemo<Scale>(() => {
    const numbers = shown.map((item) => item.value);
    return definition.signed ? { breaks: divergingBreaks(numbers), ramp: divergingScale(numbers) } : scaleOf(numbers, familyOf(layer));
  }, [definition.signed, layer, shown]);
  const regionScale = useMemo<Scale>(() => {
    const numbers = regionShown.map((item) => item.value);
    return { breaks: classBreaks(numbers), ramp: definition.signed ? divergingScale(numbers) : colorScale(numbers, familyOf(layer)) };
  }, [definition.signed, layer, regionShown]);
  const paint = useMemo(() => areaPaint(municipalShapes, shown, { metric: layer, ramp: municipalScale.ramp, period: periodShort, countWithheld: true }),
    [layer, municipalScale, municipalShapes, periodShort, shown]);
  const regionPaint = useMemo(() => areaPaint(regionShapes, regionShown, { metric: layer, ramp: regionScale.ramp, period: periodShort }), [layer, periodShort, regionScale, regionShapes, regionShown]);
  // Districts/settlements get their own scale (they would all share the top municipal class) and their own legend.
  const subScale = useMemo(() => scaleOf(subValues.map((item) => item.value), familyOf(layer)), [layer, subValues]);
  const subPaint = useMemo(() => finePaint(subShapes, subValues, { ramp: subScale.ramp, period: periodShort }), [periodShort, subShapes, subValues, subScale]);
  const fineScale = useMemo(() => scaleOf(fine.values.map((item) => item.value), familyOf(layer)), [fine.values, layer]);
  const fineAreaPaint = useMemo(() => finePaint(fine.shapes, fine.values, { ramp: fineScale.ramp, period: periodShort, metric: layer }), [fine, fineScale, layer, periodShort]);
  // Buildings get their own scale from the buildings in view (the municipal scale would make every city building the darkest class).
  const buildingScale = useMemo(() => scaleOf(landPoints ? agreements.map((item) => item.perSqm) : buildings.map((item) => item.medianAmountPerSqm ?? null), rent ? "rent" : "price"), [agreements, buildings, landPoints, rent]);
  const buildingDots = useMemo<MapBuildingPoint[]>(() => buildingPoints(buildings, { ramp: buildingScale.ramp, rent, span: buildingSpan }), [buildingScale, buildingSpan, buildings, rent]);
  const agreementDots = useMemo<MapAgreementPoint[]>(() => agreementPoints(agreements, newBuildings, { ramp: buildingScale.ramp, rent }), [agreements, buildingScale, newBuildings, rent]);
  return { municipalScale, regionScale, paint, regionPaint, subScale, subPaint, fineScale, fineAreaPaint, buildingScale, buildingDots, agreementDots };
}

interface RankingsInput {
  scope: Scope; layer: MetricId; group: Parameters<typeof typedLabel>[1]; municipalityId?: number;
  regions: Geography[]; municipalities: Geography[]; names: Map<number, string>;
  shown: AreaValue[]; regionShown: AreaValue[]; sub?: { level: "city_district" | "settlement"; shapes: MunicipalityShape[] }; subValues: AreaValue[];
}

/** The panel's lists: municipalities of the country or region (ranking) and the regions or the selected municipality's sub-areas (subRanking). */
export function useExplorerRankings({ scope, layer, group, municipalityId, regions, municipalities, names, shown, regionShown, sub, subValues }: RankingsInput) {
  const definition = METRICS[layer];
  const measure = typedLabel(layer, group).toLowerCase();
  const populationSample = !definition.usesYears || layer === "newBuildings";
  const ranking = useMemo<RankItem[] | undefined>(() => {
    if (scope.level !== "country" && scope.level !== "statistical_region" && scope.level !== "municipality") return undefined;
    const regionId = scope.level === "statistical_region" ? scope.id : scope.level === "municipality" ? municipalities.find((item) => item.id === scope.id)?.parentId : undefined;
    const regionName = regions.find((item) => item.id === regionId)?.name;
    const inRegion = regionId ? new Set(municipalities.filter((item) => item.parentId === regionId).map((item) => item.id)) : undefined;
    const label = regionName ? t("{measure}, občine v regiji {region}", { measure, region: regionName }) : t("{measure}, občine", { measure });
    return shown.filter((item) => !inRegion || inRegion.has(item.geographyId)).map((item) => ({ id: item.geographyId, name: names.get(item.geographyId) ?? "", value: item.value,
      sample: item.sample, format: (value: number) => `${definition.format(value)}${item.pooled ? ` (${item.pooled} ${form(item.pooled, NOUN_FORMS.leto)})` : ""}`,
      label, pooled: item.pooled, populationSample }));
  }, [definition, measure, municipalities, names, populationSample, regions, scope, shown]);
  // Districts or settlements of the selected municipality (Slovenija: its regions), so they are reachable without the map.
  const subRanking = useMemo<RankItem[] | undefined>(() => {
    if (scope.level === "country" && regionShown.length) {
      const regionNames = new Map(regions.map((item) => [item.id, item.name]));
      return regionShown.map((item) => ({ id: item.geographyId, name: regionNames.get(item.geographyId) ?? "", value: item.value, sample: item.sample,
        format: definition.format, label: t("{measure}, statistične regije", { measure }), unit: REGION_FORMS, populationSample }));
    }
    if (!sub || !municipalityId) return undefined;
    const values = new Map(subValues.map((item) => [item.geographyId, item]));
    const municipality = names.get(municipalityId) ?? "";
    const label = sub.level === "city_district" ? t("četrtne skupnosti v občini {municipality}", { municipality }) : t("naselja v občini {municipality}", { municipality });
    return sub.shapes.map((shape) => {
      const item = values.get(shape.id);
      return { id: shape.id, name: shape.name, value: item?.value ?? null, sample: item?.sample ?? 0, pooled: item?.pooled,
        format: METRICS.salePrice.format, label, unit: sub.level === "city_district" ? DISTRICT_FORMS : NOUN_FORMS.naselje };
    });
  }, [definition, measure, municipalityId, names, populationSample, regionShown, regions, scope.level, sub, subValues]);
  return { ranking, subRanking, measure };
}

/** Half-widths of the box the map fits to an opened building (degrees): a few streets around it. */
const BUILDING_BOX_DLON = 0.003;
const BUILDING_BOX_DLAT = 0.002;
/** The value check fits the whole search circle, with room for the credit and the strip under it. */
const COMPARABLES_FOCUS_PADDING = 1.15;

interface FocusInput {
  comparables: ShownComparables | null; building?: BuildingStatistics; buildingOpened: boolean; selectedId?: number;
  unit?: Geography; regionShapes: MunicipalityShape[]; municipalShapes: MunicipalityShape[]; sub?: { shapes: MunicipalityShape[] }; agreements: AgreementPoint[];
}

/** What the map fits to (the comparables' circle, the opened building, else the area) and the ring it draws (the opened sale or building). */
export function useMapFocus({ comparables, building, buildingOpened, selectedId, unit, regionShapes, municipalShapes, sub, agreements }: FocusInput) {
  const buildingBox = useMemo<Bbox | null>(() => {
    const { longitude, latitude } = building ?? {};
    return longitude != null && latitude != null ? [longitude - BUILDING_BOX_DLON, latitude - BUILDING_BOX_DLAT, longitude + BUILDING_BOX_DLON, latitude + BUILDING_BOX_DLAT] : null;
  }, [building]);
  const focus = useMemo<Bbox | null>(() => {
    // The value check: the whole search circle, so the circle is the frame and every similar sale (inside it) is in view.
    if (comparables) return radiusBbox(comparables.center, comparables.radiusMeters * COMPARABLES_FOCUS_PADDING);
    if (buildingOpened && buildingBox) return buildingBox;
    if (!unit) return null;
    const shape = unit.level === "statistical_region" ? regionShapes.find((item) => item.id === unit.id)
      : unit.level === "municipality" ? municipalShapes.find((item) => item.id === unit.id) : sub?.shapes.find((item) => item.id === unit.id);
    const bounds = unit.bounds;
    return bboxOf(shape?.geometry) ?? (bounds && bounds.length === 4 ? [bounds[0], bounds[1], bounds[2], bounds[3]] : null);
  }, [buildingBox, buildingOpened, comparables, municipalShapes, regionShapes, sub, unit]);
  // The opened sale (its own point) or else the opened building: a ring on the map.
  const marker = useMemo<[number, number] | null>(() => {
    if (comparables) return comparables.center;
    const point = selectedId != null ? agreements.find((item) => item.id === selectedId) : undefined;
    if (point) return point.at;
    if ((buildingOpened || selectedId != null) && buildingBox) return [(buildingBox[0] + buildingBox[2]) / 2, (buildingBox[1] + buildingBox[3]) / 2];
    return null;
  }, [agreements, buildingBox, buildingOpened, comparables, selectedId]);
  return { focus, marker };
}

/** The widest view (degrees) the flood endpoint serves (0.26 after snapping); a wider view is cut to its centre. */
const FLOOD_VIEW = 0.24;
/** The view is snapped to this grid (degrees), so a small pan reuses the answer. */
const FLOOD_GRID = 0.01;
/** Simplification of the flood polygons by zoom: finer as the streets appear. */
const FLOOD_DETAIL_HIGH_ZOOM = 15.5;
const FLOOD_DETAIL_MEDIUM_ZOOM = 14;
/** The box grown to the enclosing cells of a grid (degrees), so nearby views share one answer. */
const snapBbox = ([west, south, east, north]: Bbox, cell: number): Bbox =>
  [Math.floor(west / cell) * cell, Math.floor(south / cell) * cell, Math.ceil(east / cell) * cell, Math.ceil(north / cell) * cell];
const clampBbox = ([west, south, east, north]: Bbox, size: number): Bbox => {
  const midX = (west + east) / 2, midY = (south + north) / 2;
  const halfX = Math.min(east - west, size) / 2, halfY = Math.min(north - south, size) / 2;
  return [midX - halfX, midY - halfY, midX + halfX, midY + halfY];
};

/** The DRSV flood hazard overlay for the view, on request from town zoom; the previous answer stays while the next loads, so it never blinks. */
export function useFloodOverlay(view: MapView | undefined, on: boolean) {
  const zoom = view?.zoom ?? 0;
  const floodBox = useMemo<Bbox | null>(() => view && view.zoom >= FLOOD_ZOOM ? snapBbox(clampBbox(view.bbox, FLOOD_VIEW), FLOOD_GRID) : null, [view]);
  const clamped = !!view && view.zoom >= FLOOD_ZOOM && (view.bbox[2] - view.bbox[0] > FLOOD_VIEW || view.bbox[3] - view.bbox[1] > FLOOD_VIEW);
  const detail: "low" | "medium" | "high" = zoom >= FLOOD_DETAIL_HIGH_ZOOM ? "high" : zoom >= FLOOD_DETAIL_MEDIUM_ZOOM ? "medium" : "low";
  const floods = useLoad(on && floodBox ? { box: floodBox, detail } : null, (input) => `floods|${input.box.join(",")}|${input.detail}`,
    (input, signal): Promise<FloodZones> => loadFloodZones(input.box, input.detail, signal), { keepPrevious: true });
  return { floods, floodBox, clamped };
}
