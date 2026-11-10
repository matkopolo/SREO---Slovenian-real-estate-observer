import { lazy, Suspense, useMemo, useRef, useState } from "react";
import { bboxOf, loadBuilding, loadNewBuilding, type Bbox, type Segment } from "../api";
import { AreaPanel } from "../components/AreaPanel";
import { SLOVENIA, type Scope } from "../components/AreaModules";
import { ErrorBoundary } from "../components/ErrorBoundary";
import { LoadFailed } from "../components/LoadState";
import { ValueCheck } from "../components/ValueCheck";
import { BUILDING_ZOOM } from "../components/map-zoom";
import type { MapView } from "../components/ExplorerMap";
import { ExplorerBar } from "../explorer/ExplorerBar";
import { MapLegend, type MapLevel, type Scale } from "../explorer/MapLegend";
import { agreementPoints, areaPaint, buildingPoints, containsPoint, finePaint, typedLabel } from "../explorer/paint";
import { useAreaChain, useGeographyLists, useShapes, type GeographyLists } from "../explorer/useAreas";
import { FINE_LAYERS, FINE_ZOOM, REGION_ZOOM, useChoropleth, usePeriodWindows, useSubAreas, useViewLayers } from "../explorer/useMapLayers";
import { useUrlState } from "../explorer/useUrlState";
import { useLoad } from "../hooks/useLoad";
import { Name, t, tx } from "../i18n";
import { classBreaks, colorScale, divergingBreaks, divergingScale, layersFor, METRICS } from "../metrics";
import { sizeBand } from "../nouns";
import { count, form, forms, NOUN_FORMS, type Forms } from "../plural";
import { hasBadArea } from "../url-state";
import { BuildingView } from "./BuildingView";

const ExplorerMap = lazy(() => import("../components/ExplorerMap"));

const REGION_FORMS = forms(["regija", "regiji", "regije", "regij"], ["region", "regions"]); // i18n-ignore (plural forms, both languages)
const DISTRICT_FORMS = forms(["četrtna skupnost", "četrtni skupnosti", "četrtne skupnosti", "četrtnih skupnosti"], ["city district", "city districts"]); // i18n-ignore (plural forms, both languages)
const NO_LISTS: GeographyLists = { regions: [], municipalities: [], districts: [] };
/** Extrusion height of the largest municipal value in 3D (metres). */
const EXTRUDE_TO = 40000;

interface RankItem { id: number; name: string; value: number | null; sample: number; format: (value: number) => string; label: string; pooled?: number; populationSample?: boolean; unit?: Forms }

const scaleOf = (values: Array<number | null>, palette: "teal" | "blue" = "teal"): Scale => ({ breaks: classBreaks(values), ramp: colorScale(values, palette) });

/** The market by area: map navigator, area panel, building and sale evidence, and the value check, all in the address. */
export function ExplorerView({ cutoff }: { cutoff?: string }) {
  const panelRef = useRef<HTMLDivElement>(null);
  const { state, navigate } = useUrlState(panelRef);
  const [badArea] = useState(() => hasBadArea());
  const lists = useGeographyLists();
  const { regions, municipalities, districts } = lists.data ?? NO_LISTS;
  const shapes = useShapes();
  const municipalShapes = useMemo(() => shapes.municipalities.data ?? [], [shapes.municipalities.data]);
  const regionShapes = useMemo(() => shapes.regions.data ?? [], [shapes.regions.data]);

  // The selected area and its parents; a deep link shows a loading state (never Slovenija) until they are known.
  const area = useAreaChain(state.g, lists);
  const unit = area.status === "ok" ? area.unit : undefined;
  const chain = useMemo(() => area.status === "ok" ? area.chain : [], [area]);
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
  const choropleth = useChoropleth(cutoff, state.years, layer, segment, windows);
  const { fine, buildings, agreements, newBuildings } = useViewLayers({ view, cutoff, years: state.years, layer, group: state.group, segment, windows, buildingWindows: period?.buildings });
  const subAreas = useSubAreas(municipalityId, municipalShapes, cutoff, state.years, segment, windows);
  const sub = subAreas.sub?.owner === municipalityId ? subAreas.sub : undefined;
  const building = useLoad(state.building ? `building-${state.building.ko}-${state.building.st}` : null, (signal) => loadBuilding(state.building!.ko, state.building!.st, signal));
  const [newBuildingId, setNewBuildingId] = useState<string>();
  const newBuilding = useLoad(newBuildingId ? `new-building-${newBuildingId}` : null, (signal) => loadNewBuilding(newBuildingId!, signal));

  // ------------------------------------------------------------ scales and paint
  const { shown, regionShown } = choropleth;
  const municipalScale = useMemo<Scale>(() => {
    const numbers = shown.map((item) => item.value);
    return definition.signed ? { breaks: divergingBreaks(numbers), ramp: divergingScale(numbers) } : scaleOf(numbers);
  }, [definition.signed, shown]);
  const regionScale = useMemo<Scale>(() => {
    const numbers = regionShown.map((item) => item.value);
    return { breaks: classBreaks(numbers), ramp: definition.signed ? divergingScale(numbers) : colorScale(numbers) };
  }, [definition.signed, regionShown]);
  const paint = useMemo(() => areaPaint(municipalShapes, shown, { metric: layer, ramp: municipalScale.ramp, period: periodShort, extrudeTo: EXTRUDE_TO, countWithheld: true }),
    [layer, municipalScale, municipalShapes, periodShort, shown]);
  const regionPaint = useMemo(() => areaPaint(regionShapes, regionShown, { metric: layer, ramp: regionScale.ramp, period: periodShort }), [layer, periodShort, regionScale, regionShapes, regionShown]);
  // Districts/settlements get their own scale (they would all share the top municipal class) and their own legend.
  const subScale = useMemo(() => scaleOf(subAreas.values.map((item) => item.value), "blue"), [subAreas.values]);
  const subPaint = useMemo(() => finePaint(sub?.shapes ?? [], subAreas.values, { ramp: subScale.ramp, period: periodShort }), [periodShort, sub, subAreas.values, subScale]);
  const fineScale = useMemo(() => scaleOf(fine.values.map((item) => item.value), "blue"), [fine.values]);
  const fineAreaPaint = useMemo(() => finePaint(fine.shapes, fine.values, { ramp: fineScale.ramp, period: periodShort, metric: layer }), [fine, fineScale, layer, periodShort]);
  // Buildings get their own scale from the buildings in view (the municipal scale would make every city building the darkest class).
  const landPoints = state.group === "land";
  const buildingScale = useMemo(() => scaleOf(landPoints ? agreements.map((item) => item.perSqm) : buildings.map((item) => item.medianAmountPerSqm ?? null)), [agreements, buildings, landPoints]);
  const buildingDots = useMemo(() => buildingPoints(buildings, { ramp: buildingScale.ramp, rent, span: buildingSpan }), [buildingScale, buildingSpan, buildings, rent]);
  const agreementDots = useMemo(() => agreementPoints(agreements, newBuildings, { ramp: buildingScale.ramp, rent }), [agreements, buildingScale, newBuildings, rent]);

  const zoom = view?.zoom ?? 7;
  const mapLevel: MapLevel = zoom < REGION_ZOOM && definition.regional ? "statistical_region" : zoom < FINE_ZOOM || !FINE_LAYERS.includes(layer) ? "municipality" : "fine";
  const streetLevel = zoom >= BUILDING_ZOOM;

  // ------------------------------------------------------------ map focus and marker
  const buildingBox = useMemo<Bbox | null>(() => {
    const { longitude, latitude } = building.data ?? {};
    return longitude != null && latitude != null ? [longitude - 0.003, latitude - 0.002, longitude + 0.003, latitude + 0.002] : null;
  }, [building.data]);
  const focus = useMemo<Bbox | null>(() => {
    if (state.building && buildingBox) return buildingBox;
    if (!unit) return null;
    const shape = unit.level === "statistical_region" ? regionShapes.find((item) => item.id === unit.id)
      : unit.level === "municipality" ? municipalShapes.find((item) => item.id === unit.id) : sub?.shapes.find((item) => item.id === unit.id);
    return bboxOf(shape?.geometry) ?? (unit.bounds as Bbox | undefined) ?? null;
  }, [buildingBox, municipalShapes, regionShapes, state.building, sub, unit]);
  // The opened sale (its own point) or else the opened building: a ring on the map.
  const selectedId = state.selected?.id;
  const marker = useMemo<[number, number] | null>(() => {
    const point = selectedId != null ? agreements.find((item) => item.id === selectedId) : undefined;
    if (point) return point.at;
    if ((state.building || selectedId != null) && buildingBox) return [(buildingBox[0] + buildingBox[2]) / 2, (buildingBox[1] + buildingBox[3]) / 2];
    return null;
  }, [agreements, buildingBox, selectedId, state.building]);

  // ------------------------------------------------------------ lists for the panel
  const names = useMemo(() => new Map(municipalShapes.map((shape) => [shape.id, shape.name])), [municipalShapes]);
  const measure = typedLabel(layer, state.group).toLowerCase();
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
    const values = new Map(subAreas.values.map((item) => [item.geographyId, item]));
    const municipality = names.get(municipalityId) ?? "";
    const label = sub.level === "city_district" ? t("četrtne skupnosti v občini {municipality}", { municipality }) : t("naselja v občini {municipality}", { municipality });
    return sub.shapes.map((shape) => {
      const item = values.get(shape.id);
      return { id: shape.id, name: shape.name, value: item?.value ?? null, sample: item?.sample ?? 0, pooled: item?.pooled,
        format: METRICS.salePrice.format, label, unit: sub.level === "city_district" ? DISTRICT_FORMS : NOUN_FORMS.naselje };
    });
  }, [definition, measure, municipalityId, names, populationSample, regionShown, regions, scope.level, sub, subAreas.values]);

  // The area under the middle of the map, when it is not the one in the panel: one tap opens it.
  const inView = useMemo(() => {
    // Only after the user moved the map: right after opening an area its fit may centre on a neighbour.
    if (!view || streetLevel || !view.byUser) return undefined;
    const center: [number, number] = [(view.bbox[0] + view.bbox[2]) / 2, (view.bbox[1] + view.bbox[3]) / 2];
    const [areas, paints] = mapLevel === "fine" ? [fine.shapes, fineAreaPaint] : mapLevel === "municipality" ? [municipalShapes, paint] : [regionShapes, regionPaint];
    const hit = areas.find((shape) => containsPoint(shape.geometry, center));
    if (!hit || hit.id === scope.id) return undefined;
    return { id: hit.id, label: paints.get(hit.id)?.label ?? hit.name };
  }, [fine.shapes, fineAreaPaint, mapLevel, municipalShapes, paint, regionPaint, regionShapes, scope.id, streetLevel, view]);
  const scrollToPanel = () => { if (window.matchMedia?.("(max-width: 900px)").matches) requestAnimationFrame(() => document.getElementById("area-title")?.scrollIntoView({ block: "start" })); };
  const openArea = (id: number) => { navigate({ g: id, building: undefined, selected: undefined }); scrollToPanel(); };
  const scopeValue = scope.id == null ? undefined
    : ((mapLevel === "statistical_region" ? regionPaint : paint).get(scope.id) ?? fineAreaPaint.get(scope.id) ?? subPaint.get(scope.id))?.value;

  // ------------------------------------------------------------ notices
  const notice = area.status === "failed" ? <LoadFailed retry={area.retry}>{t("Območja trenutno ni bilo mogoče naložiti (povezava ali strežnik).")}</LoadFailed> // i18n-ignore (code, not text)
    : area.status === "missing" ? <p className="error" role="alert">{t("Tega območja ni. Prikazujemo Slovenijo; poiščite območje zgoraj.")}</p> // i18n-ignore (code, not text)
    : lists.error ? <LoadFailed retry={lists.retry}/> // i18n-ignore (code, not text)
    : shapes.municipalities.error ? <LoadFailed retry={shapes.municipalities.retry}>{t("Meja občin ni bilo mogoče naložiti.")}</LoadFailed> // i18n-ignore (code, not text)
    : choropleth.failed ? <LoadFailed retry={choropleth.retry}>{t("Vrednosti za zemljevid ni bilo mogoče naložiti.")}</LoadFailed>
    : badArea && !state.g ? <p className="error" role="alert">{t("Povezava ima neveljavno območje. Prikazujemo Slovenijo; poiščite območje zgoraj.")}</p> : null;
  const areaLoading = !!state.g && (area.status === "loading" || (area.status === "none" && !lists.data));

  return <div className={state.value ? "explorer value-mode" : "explorer"}>
    <ExplorerBar state={state} navigate={navigate} cutoff={cutoff} windows={windows} regions={regions} municipalities={municipalities} districts={districts}/>

    <div className="explorer-body">
      {!state.value && !state.building && !state.selected && !areaLoading && <div className="phone-head">
        <strong>{scope.id == null ? scope.name : <Name>{scope.name}</Name>}</strong>
        {scopeValue && <span>{scopeValue}</span>}
        <a href="#area-title" onClick={(event) => { event.preventDefault(); document.getElementById("area-title")?.scrollIntoView({ block: "start" }); }}>{t("Podrobnosti ↓")}</a>
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
          ? <ErrorBoundary name="value check" resetKey={`value-${state.building?.ko ?? ""}-${state.building?.st ?? ""}-${selectedId ?? ""}`} fallback={() => <div className="module open">
              <p className="error" role="alert">{t("Ocene za to nepremičnino ni bilo mogoče prikazati.")}</p>
              <button type="button" className="ghost" onClick={() => navigate({ value: false })}>{t("Nazaj na trg")}</button></div>}>
            <ValueCheck building={state.building} transactionId={state.selected?.kind === "sale" ? state.selected.id : undefined} municipalityId={municipalityId}
              cutoff={cutoff} municipalities={municipalities}
              onBuilding={(ko, st) => navigate({ building: ko ? { ko, st } : undefined, selected: undefined })}
              onTransaction={(id) => navigate({ selected: id ? { kind: "sale", id } : undefined })}/>
          </ErrorBoundary> // i18n-ignore (code, not text)
          : state.building || state.selected
          ? <ErrorBoundary name="building" resetKey={`building-${state.building?.ko ?? ""}-${state.building?.st ?? ""}-${selectedId ?? ""}`}>
            <BuildingView state={state} navigate={navigate} cutoff={cutoff} scope={scope} parents={parents} building={building}/>
          </ErrorBoundary> // i18n-ignore (code, not text)
          : areaLoading ? <article className="area-panel" aria-busy="true"><p className="muted" role="status">{t("Nalagam območje …")}</p></article>
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
      <div className="explorer-map-wrap">
        <ErrorBoundary name="map" resetKey="map" fallback={() => <p className="fallback" role="status">{t("Zemljevid v tem brskalniku ni na voljo. Območje izberite z iskalnikom zgoraj.")}</p>}>
          <Suspense fallback={<p className="fallback" role="status">{t("Nalagam zemljevid …")}</p>}><ExplorerMap
            municipalities={mapLevel === "statistical_region" ? regionShapes : municipalShapes} regions={regionShapes}
            paint={mapLevel === "statistical_region" ? regionPaint : paint}
            subAreas={mapLevel === "fine" && fine.shapes.length ? fine.shapes : sub?.shapes ?? []} subPaint={mapLevel === "fine" && fine.shapes.length ? fineAreaPaint : subPaint}
            buildings={buildingDots} agreements={agreementDots} selected={municipalityId ?? null}
            selectedSub={scope.level === "city_district" ? scope.id ?? null : (unit?.level === "settlement" ? unit.id : null)} focus={focus} marker={marker} extrude={state.extrude && !definition.signed}
            onArea={openArea} onSubArea={openArea}
            onBuilding={(key) => { const [ko, ...rest] = key.split("-"); navigate({ building: { ko: Number(ko), st: rest.join("-") }, selected: undefined }); }}
            onAgreement={(id) => {
              // A sale opens its own building (from the point), with that sale first.
              if (id > 0) { const point = agreements.find((item) => item.id === id); navigate({ selected: { kind: rent ? "rent" : "sale", id }, building: point?.building ?? state.building }); return; }
              setNewBuildingId(newBuildings[-1 - id]?.id);
            }}
            onView={setView}/></Suspense>
        </ErrorBoundary>
        {inView && <button type="button" className="map-chip" onClick={() => openArea(inView.id)}>
          {tx("V pogledu: {area} · {open}", { area: inView.label, open: <strong>{t("Odpri →")}</strong> })}</button>}
        {!(state.value && !state.building) && <MapLegend layer={layer} layers={layers} group={state.group} band={band} windows={windows} level={mapLevel}
          street={streetLevel} land={landPoints} buildingSpan={buildingSpan}
          scales={{ municipal: municipalScale, region: regionScale, fine: fineScale, buildings: buildingScale }}
          pooled={{ municipal: shown.some((item) => item.pooled), fine: fine.values.some((item) => item.pooled) }} fineShown={fine.shapes.length > 0}
          sub={sub && municipalityId ? { level: sub.level, municipality: names.get(municipalityId) ?? "", scale: subScale } : undefined}
          extrude={state.extrude} onLayer={(next) => navigate({ layer: next }, true)} onExtrude={() => navigate({ extrude: !state.extrude }, true)}/>}
      </div>
    </div>
  </div>;
}
