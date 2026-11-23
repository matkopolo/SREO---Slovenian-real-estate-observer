import { lazy, Suspense, useMemo, useRef, useState } from "react";
import { loadBuilding, loadNewBuilding, type MarketComparable, type Segment } from "../api";
import { AreaPanel } from "../components/AreaPanel";
import { SLOVENIA, type Scope } from "../components/AreaModules";
import { addressLabel } from "../address";
import { ErrorBoundary } from "../components/ErrorBoundary";
import { LoadFailed } from "../components/LoadState";
import { ValueCheck, type ShownComparables } from "../components/ValueCheck";
import type { MapComparablePoint, MapRadius, MapView } from "../components/ExplorerMap";
import { BUILDING_ZOOM } from "../components/map-zoom";
import { dateCompact, sqm } from "../format";
import { ExplorerBar } from "../explorer/ExplorerBar";
import { ComparablesLegend, MapLegend, type MapLevel } from "../explorer/MapLegend";
import { containsPoint } from "../explorer/paint";
import { useAreaChain, useGeographyLists, useShapes, type GeographyLists } from "../explorer/useAreas";
import { useExplorerRankings, useExplorerScales, useFloodOverlay, useMapFocus } from "../explorer/useExplorerView";
import { FINE_LAYERS, FINE_ZOOM, REGION_ZOOM, useChoropleth, usePeriodWindows, useSubAreas, useViewLayers } from "../explorer/useMapLayers";
import { useUrlState } from "../explorer/useUrlState";
import { useLoad } from "../hooks/useLoad";
import { Name, proper, t, tx } from "../i18n";
import { isPhone } from "../layout";
import { layersFor, METRICS } from "../metrics";
import { sizeBand } from "../nouns";
import { count, form, NOUN_FORMS } from "../plural";
import { buildingKey, hasBadArea, parseBuildingKey, type BuildingRef } from "../url-state";
import { BuildingView } from "./BuildingView";
import { jumpTo } from "../focus";
import { areaTitle, TITLE, useDocumentTitle } from "../title";
import "../explorer/explorer.css";

const ExplorerMap = lazy(() => import("../components/ExplorerMap").then((module) => ({ default: module.ExplorerMap })));

const NO_LISTS: GeographyLists = { regions: [], municipalities: [], districts: [] };
const NO_SHAPES: never[] = [];
/** The default zoom before the map has reported its view: Slovenia as a whole. */
const COUNTRY_ZOOM = 7;

/** The market by area: map navigator, area panel, building and sale evidence, and the value check, all in the address. */
export function ExplorerView({ cutoff }: { cutoff: string }) {
  const panelRef = useRef<HTMLDivElement>(null);
  const { state, navigate } = useUrlState(panelRef);
  const [badArea] = useState(() => hasBadArea());
  const lists = useGeographyLists();
  const { regions, municipalities, districts } = lists.data ?? NO_LISTS;
  const shapes = useShapes();
  const municipalShapes = shapes.municipalities.data ?? NO_SHAPES;
  const regionShapes = shapes.regions.data ?? NO_SHAPES;

  // The selected area and its parents; a deep link shows a loading state (never Slovenija) until they are known.
  const area = useAreaChain(state.g, lists);
  const unit = area.status === "ok" ? area.unit : undefined;
  const chain = area.status === "ok" ? area.chain : NO_SHAPES;
  const scope = useMemo<Scope>(() => unit ? { id: unit.id, name: unit.name, level: unit.level as Scope["level"] } : SLOVENIA, [unit]);
  const municipalityId = unit?.level === "municipality" ? unit.id : chain.find((item) => item.level === "municipality")?.id;
  const parents = useMemo<Scope[]>(() => [...chain.filter((item) => item.level === "municipality" || item.level === "statistical_region")
    .map((item) => ({ id: item.id, name: item.name, level: item.level as Scope["level"] })), ...(unit ? [SLOVENIA] : [])], [chain, unit]);

  const band = sizeBand(state.group, state.size);
  const segment = useMemo<Segment>(() => ({ propertyGroup: state.group, landScope: state.landScope, minArea: band?.min, maxArea: band?.max }), [band?.max, band?.min, state.group, state.landScope]);
  const layers = layersFor(state.group);
  const layer = layers.includes(state.layer) ? state.layer : "salePrice";
  const definition = METRICS[layer];
  const rent = layer === "rentPrice";
  const period = usePeriodWindows(cutoff, state.years);
  const windows = period?.windows;
  const periodShort = typeof state.years === "string" ? state.years.replace("-", "–") : state.years === 1 ? t("12 mes.") : `${state.years} ${form(state.years, NOUN_FORMS.leto)}`;
  const buildingSpan = typeof state.years === "string" ? state.years.replace("-", "–") : t("5 let");

  // ------------------------------------------------------------ map data
  const [view, setView] = useState<MapView>();
  // The value check's evidence on the map: the comparables behind the estimate, their search circle, and the list's hovered row.
  const [reported, setComparables] = useState<ShownComparables | null>(null);
  const [highlight, setHighlight] = useState<number | null>(null);
  // Only while the value check is open: everything else about the map follows this one value.
  const comparables = state.value && reported?.comparables.length ? reported : null;
  const comparablesShown = comparables != null;
  const comparableDots = useMemo<MapComparablePoint[]>(() => (comparables?.comparables ?? []).map((item) => ({
    id: item.transactionId, lon: item.longitude, lat: item.latitude,
    label: [addressLabel(item), t("Prodaja {date}: {value}", { date: dateCompact(item.contractDate), value: METRICS.salePrice.format(item.amountPerSqm) }), sqm(item.area)].filter(Boolean).join(" · ") })),
    [comparables]);
  const radius = useMemo<MapRadius | null>(() => comparables ? { center: comparables.center, meters: comparables.radiusMeters } : null, [comparables]);
  // A comparable opens as a sale page (its own building), leaving the value check; "Nazaj" returns.
  const openComparable = (item: MarketComparable) => navigate({ value: false, selected: { kind: "sale", id: item.transactionId },
    building: item.cadastralMunicipalityCode != null && item.buildingNumber ? { ko: item.cadastralMunicipalityCode, st: item.buildingNumber } : undefined });
  const choropleth = useChoropleth(cutoff, state.years, layer, segment, windows);
  // Under the comparables the map draws no buildings or sales, so it does not load them either.
  const { fine, buildings, agreements, newBuildings } = useViewLayers({ view: comparablesShown ? undefined : view, cutoff, years: state.years, layer, group: state.group, segment, windows, buildingWindows: period?.buildings });
  const subAreas = useSubAreas(municipalityId, municipalShapes, cutoff, state.years, segment, windows);
  const sub = subAreas.sub?.owner === municipalityId ? subAreas.sub : undefined;
  const building = useLoad(state.building ?? null, (ref: BuildingRef) => `building-${buildingKey(ref)}`, (ref, signal) => loadBuilding(ref.ko, ref.st, signal));
  const [newBuildingId, setNewBuildingId] = useState<string>();
  const newBuilding = useLoad(newBuildingId ?? null, (eid) => `new-building-${eid}`, (eid, signal) => loadNewBuilding(eid, signal));

  // ------------------------------------------------------------ scales, paint, lists
  const { shown, regionShown } = choropleth;
  const landPoints = state.group === "land";
  const subShapes = sub?.shapes ?? NO_SHAPES;
  const scales = useExplorerScales({ layer, rent, landPoints, periodShort, buildingSpan, shown, regionShown, municipalShapes, regionShapes,
    subShapes, subValues: subAreas.values, fine, buildings, agreements, newBuildings });
  const zoom = view?.zoom ?? COUNTRY_ZOOM;
  const [floodsOn, setFloodsOn] = useState(false);
  const { floods, floodBox, clamped: floodClamped } = useFloodOverlay(view, floodsOn);
  const mapLevel: MapLevel = zoom < REGION_ZOOM && definition.regional ? "statistical_region" : zoom < FINE_ZOOM || !FINE_LAYERS.includes(layer) ? "municipality" : "fine";
  const streetLevel = zoom >= BUILDING_ZOOM;
  const selectedId = state.selected?.id;
  const { focus, marker } = useMapFocus({ comparables, building: building.data, buildingOpened: !!state.building, selectedId, unit, regionShapes, municipalShapes, sub, agreements });
  const names = useMemo(() => new Map(municipalShapes.map((shape) => [shape.id, shape.name])), [municipalShapes]);
  const { ranking, subRanking } = useExplorerRankings({ scope, layer, group: state.group, municipalityId, regions, municipalities, names, shown, regionShown, sub, subValues: subAreas.values });

  // The area under the middle of the map, when it is not the one in the panel: one tap opens it (its value is in the hover tooltip, not here).
  const inView = useMemo(() => {
    // Only after the user moved the map: right after opening an area its fit may centre on a neighbour.
    if (!view || streetLevel || !view.byUser) return undefined;
    const center: [number, number] = [(view.bbox[0] + view.bbox[2]) / 2, (view.bbox[1] + view.bbox[3]) / 2];
    const areas = mapLevel === "fine" ? fine.shapes : mapLevel === "municipality" ? municipalShapes : regionShapes;
    const hit = areas.find((shape) => containsPoint(shape.geometry, center));
    if (!hit || hit.id === scope.id) return undefined;
    return { id: hit.id, name: hit.name };
  }, [fine.shapes, mapLevel, municipalShapes, regionShapes, scope.id, streetLevel, view]);
  const scrollToPanel = () => { if (isPhone()) requestAnimationFrame(() => document.getElementById("area-title")?.scrollIntoView({ block: "start" })); };
  const openArea = (id: number) => { navigate({ g: id, building: undefined, selected: undefined }); scrollToPanel(); };
  const scopeValue = scope.id == null ? undefined
    : ((mapLevel === "statistical_region" ? scales.regionPaint : scales.paint).get(scope.id) ?? scales.fineAreaPaint.get(scope.id) ?? scales.subPaint.get(scope.id))?.value;
  const fineShown = mapLevel === "fine" && fine.shapes.length > 0;

  // ------------------------------------------------------------ notices
  const notice = area.status === "failed" ? <LoadFailed retry={area.retry}>{t("Območja trenutno ni bilo mogoče naložiti (povezava ali strežnik).")}</LoadFailed> // i18n-ignore (code, not text)
    : area.status === "missing" ? <p className="error" role="alert">{t("Tega območja ni. Prikazujemo Slovenijo; poiščite območje zgoraj.")}</p> // i18n-ignore (code, not text)
    : lists.error ? <LoadFailed retry={lists.retry}/> // i18n-ignore (code, not text)
    : shapes.municipalities.error ? <LoadFailed retry={shapes.municipalities.retry}>{t("Meja občin ni bilo mogoče naložiti.")}</LoadFailed> // i18n-ignore (code, not text)
    : choropleth.failed ? <LoadFailed retry={choropleth.retry}>{t("Vrednosti za zemljevid ni bilo mogoče naložiti.")}</LoadFailed>
    : badArea && !state.g ? <p className="error" role="alert">{t("Povezava ima neveljavno območje. Prikazujemo Slovenijo; poiščite območje zgoraj.")}</p> : null;
  const areaLoading = !!state.g && (area.status === "loading" || (area.status === "none" && !lists.data));
  // The tab names the area (once it is known) and the value check; a building or a transaction names itself (BuildingView).
  useDocumentTitle(areaLoading ? null : areaTitle(scope.name), TITLE.area);
  useDocumentTitle(state.value ? t("Ocena vrednosti · SREO") : null, TITLE.detail);

  // sale-mode: an opened sale or rental (phones put its head above a shorter map, explorer.css).
  return <div className={state.value ? "explorer value-mode" : state.selected ? "explorer sale-mode" : "explorer"}>
    <ExplorerBar state={state} navigate={navigate} cutoff={cutoff} windows={windows} regions={regions} municipalities={municipalities} districts={districts}/>

    <div className="explorer-body">
      {!state.value && !state.building && !state.selected && !areaLoading && <div className="phone-head">
        <strong>{scope.id == null ? scope.name : <Name>{scope.name}</Name>}</strong>
        {scopeValue && <span>{scopeValue}</span>}
        <a href="#area-title" onClick={(event) => { event.preventDefault(); jumpTo(document.getElementById("area-title")); }}>{t("Podrobnosti")} <span aria-hidden="true">↓</span></a>
      </div>}
      <div className="explorer-panel" ref={panelRef}>
        {notice}
        {newBuilding.data && <section className="module open new-building" aria-live="polite">
          <h2>{t("Nova stavba, k. o. {ko}, št. {number}", { ko: newBuilding.data.cadastralCode, number: newBuilding.data.buildingNumber })}</h2>
          <p>{t("Zgrajena {year}; {floors} etaž, {dwellings} stanovanj, {type}.", { year: newBuilding.data.yearBuilt ?? "—", floors: newBuilding.data.floors ?? "—", dwellings: newBuilding.data.dwellings ?? "—", type: newBuilding.data.buildingType ?? t("vrsta ni navedena") })}
            {" "}{t("V stavbi je evidentiranih {sales} in {rentals}.", { sales: count(newBuilding.data.saleTransactions, NOUN_FORMS.prodaja), rentals: count(newBuilding.data.rentalTransactions, NOUN_FORMS.najem) })}</p>
          <button type="button" className="ghost" onClick={() => setNewBuildingId(undefined)}>{t("Zapri")}</button>
        </section>}
        {state.value
          ? <ErrorBoundary name="value check" resetKey={`value-${state.building ? buildingKey(state.building) : ""}-${selectedId ?? ""}`} fallback={() => <div className="module open">
              <p className="error" role="alert">{t("Ocene za to nepremičnino ni bilo mogoče prikazati.")}</p>
              <button type="button" className="ghost" onClick={() => navigate({ value: false })}>{t("Nazaj na trg")}</button></div>}>
            <ValueCheck building={state.building} transactionId={state.selected?.kind === "sale" ? state.selected.id : undefined} municipalityId={municipalityId}
              cutoff={cutoff} municipalities={municipalities}
              onBuilding={(ko, st) => navigate({ building: ko ? { ko, st } : undefined, selected: undefined })}
              onTransaction={(id) => navigate({ selected: id ? { kind: "sale", id } : undefined })}
              onComparables={setComparables} onHighlight={setHighlight} onComparable={openComparable}/>
          </ErrorBoundary> // i18n-ignore (code, not text)
          : state.building || state.selected
          ? <ErrorBoundary name="building" resetKey={`building-${state.building ? buildingKey(state.building) : ""}-${selectedId ?? ""}`}>
            <BuildingView state={state} navigate={navigate} cutoff={cutoff} scope={scope} parents={parents} building={building}/>
          </ErrorBoundary> // i18n-ignore (code, not text)
          : areaLoading ? <article className="area-panel" aria-busy="true"><h1 className="area-title"><span className="muted" role="status">{t("Nalagam območje\u00a0…")}</span></h1></article>
          : <ErrorBoundary name="area panel" resetKey={`${scope.id ?? 0}-${state.group}-${state.years}`} fallback={() => <div className="module open">
              <p className="error" role="alert">{t("Tega območja ni bilo mogoče prikazati.")}</p>
              <button type="button" className="ghost" onClick={() => navigate({ g: parents[0]?.id, building: undefined, selected: undefined })}>{parents[0] ? tx("Nazaj na {area}", { area: parents[0].id == null ? parents[0].name : <Name>{parents[0].name}</Name> }) : t("Nazaj na Slovenijo")}</button>
            </div>}>
            <AreaPanel scope={scope} parents={parents} group={state.group} years={state.years} cutoff={cutoff} regions={regions} municipalities={municipalities}
              landScope={state.landScope} landChosen={state.landChosen}
              onLandScope={(landScope, auto) => navigate({ landScope, landChosen: !auto }, auto)}
              size={band?.id} onSize={(size) => navigate({ size }, true)}
              street={state.street} onClearStreet={() => navigate({ street: undefined })} districts={districts}
              onGroup={(group) => navigate({ group, size: undefined })} ranking={ranking} subRanking={subRanking} onSubArea={(id) => navigate({ g: id })}/>
          </ErrorBoundary>}
      </div>
      <div className="explorer-map-wrap" id="explorer-map" tabIndex={-1}>
        <ErrorBoundary name="map" resetKey="map" fallback={() => <p className="fallback" role="status">{t("Zemljevid v tem brskalniku ni na voljo. Območje izberite z iskalnikom zgoraj.")}</p>}>
          <Suspense fallback={<p className="fallback" role="status">{t("Nalagam zemljevid\u00a0…")}</p>}><ExplorerMap
            municipalities={mapLevel === "statistical_region" ? regionShapes : municipalShapes} regions={regionShapes}
            paint={mapLevel === "statistical_region" ? scales.regionPaint : scales.paint}
            subAreas={comparablesShown ? NO_SHAPES : fineShown ? fine.shapes : subShapes} subPaint={fineShown ? scales.fineAreaPaint : scales.subPaint}
            buildings={comparablesShown ? NO_SHAPES : scales.buildingDots} agreements={comparablesShown ? NO_SHAPES : scales.agreementDots} selected={municipalityId ?? null}
            selectedSub={scope.level === "city_district" ? scope.id ?? null : (unit?.level === "settlement" ? unit.id : null)} focus={focus} marker={marker}
            comparables={comparableDots} muted={comparablesShown} highlight={highlight} radius={radius} floods={floodsOn && floodBox ? floods.data?.features ?? null : null}
            onComparable={(id) => { const item = comparables?.comparables.find((entry) => entry.transactionId === id); if (item) openComparable(item); }}
            onArea={openArea} onSubArea={openArea}
            onBuilding={(key) => { const ref = parseBuildingKey(key); if (ref) navigate({ building: ref, selected: undefined }); }}
            onAgreement={(id) => {
              // A sale opens its own building (from the point), with that sale first.
              const point = agreements.find((item) => item.id === id);
              navigate({ selected: { kind: rent ? "rent" : "sale", id }, building: point?.building ?? state.building });
            }}
            onNewBuilding={setNewBuildingId}
            onView={setView}/></Suspense>
        </ErrorBoundary>
        {inView && <button type="button" className="map-chip" onClick={() => openArea(inView.id)}>
          {tx("V pogledu: {area} · {open}", { area: proper(inView.name), open: <strong>{t("Odpri")} <span aria-hidden="true">→</span></strong> })}</button>}
        {comparables ? <ComparablesLegend count={comparables.comparables.length} radiusMeters={comparables.radiusMeters} trusted={comparables.trusted}/>
        : !(state.value && !state.building) && <MapLegend layer={layer} layers={layers} group={state.group} band={band} windows={windows} level={mapLevel}
          street={streetLevel} land={landPoints} buildingSpan={buildingSpan}
          scales={{ municipal: scales.municipalScale, region: scales.regionScale, fine: scales.fineScale, buildings: scales.buildingScale }}
          pooled={{ municipal: shown.some((item) => item.pooled), fine: fine.values.some((item) => item.pooled) }} fineShown={fine.shapes.length > 0}
          sub={sub && municipalityId ? { level: sub.level, municipality: names.get(municipalityId) ?? "", scale: scales.subScale } : undefined}
          floods={{ on: floodsOn, available: floodBox != null, loading: floods.loading, failed: !!floods.error && !floods.data, truncated: !!floods.data?.truncated || floodClamped, onToggle: () => setFloodsOn(!floodsOn) }}
          onLayer={(next) => navigate({ layer: next }, true)}/>}
      </div>
    </div>
  </div>;
}
