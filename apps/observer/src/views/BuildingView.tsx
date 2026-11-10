import { useEffect, useEffectEvent } from "react";
import { ApiError, loadSaleAreas, loadSpread, periodWindows, type BuildingStatistics } from "../api";
import { addressLabel } from "../components/AreaSearch";
import type { Scope } from "../components/AreaModules";
import { BuildingStack, TransactionEvidence } from "../components/BuildingEvidence";
import { LoadFailed } from "../components/LoadState";
import type { Navigate } from "../explorer/useUrlState";
import { useLoad, type Load } from "../hooks/useLoad";
import { Name, t, tx } from "../i18n";
import { sizeBand } from "../nouns";
import { areaHref, type ExplorerState } from "../url-state";

const buildingTitle = (building: BuildingStatistics) => addressLabel(building) // i18n-ignore (code, not text)
  ? <Name>{addressLabel(building)}</Name> : t("Stavba {id}", { id: `${building.cadastralMunicipalityCode}-${building.buildingNumber}` });

/** A building (from the map, search or a link) and, when chosen, one transaction with its evidence. */
export function BuildingView({ state, navigate, cutoff, scope, parents, building: load }: {
  state: ExplorerState; navigate: Navigate; cutoff?: string; scope: Scope; parents: Scope[];
  /** The opened building (the explorer loads it once, also to fit the map). */
  building: Load<BuildingStatistics>;
}) {
  const building = load.data;
  const missing = load.error instanceof ApiError && load.error.status === 404;
  // A bare building link has no area yet: the building's own district or municipality, from one of its sales.
  const first = building?.saleTransactions[0]?.transactionId;
  const areas = useLoad(first ? `sale-areas-${first}` : null, (signal) => loadSaleAreas(first!, signal));
  const followArea = useEffectEvent((found: NonNullable<typeof areas.data>) => {
    // Keep the area the user came from when the building lies in it (Šiška stays Šiška).
    if (found.some((item) => item.id === state.g)) return;
    const own = found.find((item) => item.level === "city_district") ?? found.find((item) => item.level === "municipality");
    if (own?.id) navigate({ g: own.id }, true);
  });
  useEffect(() => { if (areas.data) followArea(areas.data); }, [areas.data]);

  // The building against its area: the area's P25–P75 for the same type over five years.
  const spread = useLoad(cutoff && building ? `spread|${scope.id ?? 0}|${state.group}|${state.landScope}|${cutoff}` : null,
    (signal) => loadSpread(scope.id, periodWindows(cutoff!, 5).sales.current, { propertyGroup: state.group, landScope: state.landScope }, "sale", signal));
  const percentiles = spread.data?.isPublishable ? spread.data.percentiles : undefined;
  const band = sizeBand(state.group, state.size);
  const scopeName = scope.id == null ? scope.name : <Name>{scope.name}</Name>;
  const leave = { building: undefined, selected: undefined };

  return <article className="area-panel" aria-label={t("Stavba in posli")}>
    <button type="button" className="back-link" onClick={() => navigate(leave)}>{tx("← Nazaj: {area}", { area: scopeName })}</button>
    <nav className="breadcrumb" aria-label={t("Pot do stavbe")}>
      <ol>{[...parents].reverse().map((item) => <li key={item.id ?? item.level}><a href={areaHref(item.id)} onClick={(event) => { event.preventDefault(); navigate({ g: item.id, ...leave }); }}>{item.id == null ? item.name : <Name>{item.name}</Name>}</a></li>)}
        {scope.id && <li><a href={areaHref(scope.id)} onClick={(event) => { event.preventDefault(); navigate(leave); }}><Name>{scope.name}</Name></a></li>}
        <li aria-current="page">{building ? buildingTitle(building) : state.selected ? t("Posel") : t("Stavba")}</li></ol>
    </nav>
    {missing && <p className="error" role="alert">{t("Stavbe k. o. {ko} / {number} nismo našli. Poiščite naslov zgoraj.", { ko: state.building?.ko, number: state.building?.st })}</p>}
    {load.error != null && !missing && <LoadFailed retry={load.retry}/>}
    {load.loading && <p className="muted" role="status">{t("Nalagam stavbo …")}</p>}
    {building && <>
      {!state.selected && <h1 className="area-title">{buildingTitle(building)}</h1>}
      {state.selected && <TransactionEvidence key={`first${state.selected.kind}${state.selected.id}`} selected={state.selected} building={building} primary
        group={state.group} band={band} onChoose={(selected) => navigate({ selected })}/>}
      {state.selected && <h2 className="section-title">{tx("Stavba: {address}", { address: addressLabel(building) ? <Name>{addressLabel(building)}</Name> : `${building.cadastralMunicipalityCode}-${building.buildingNumber}` })}</h2>}
      <button type="button" className="value-button" onClick={() => navigate({ value: true })}>{t("Imate nepremičnino v tej stavbi? Ocenite, koliko je vredna danes")}</button>
      {/* One list, one count and one median: the building bar is drawn by BuildingStack from the same sales as its table. */}
      <BuildingStack building={building} group={state.group} band={band} lastYear={cutoff ? Number(cutoff.slice(0, 4)) : undefined}
        area={percentiles?.p25 != null && percentiles.p50 != null && percentiles.p75 != null
          ? { name: scopeName, p25: percentiles.p25, p50: percentiles.p50, p75: percentiles.p75, p05: percentiles.p05 ?? undefined, p95: percentiles.p95 ?? undefined } : undefined}
        onChoose={(selected) => navigate({ selected })}/>
    </>}
    {state.selected && !building && <TransactionEvidence key={`${state.selected.kind}${state.selected.id}`} selected={state.selected} primary
      group={state.group} band={band} onChoose={(selected) => navigate({ selected })}
      onBuilding={(ko, st) => { if (!state.building) navigate({ building: { ko, st } }, true); }}/>}
  </article>;
}
