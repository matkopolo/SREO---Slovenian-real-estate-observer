import { FIRST_SALE_YEAR, type Geography, type Period, type PeriodWindows, type PeriodYears } from "../api";
import { AreaSearch } from "../components/AreaSearch";
import { date, titleCase } from "../format";
import { t, tx } from "../i18n";
import type { ExplorerState } from "../url-state";
import type { Navigate } from "./useUrlState";

const PERIODS: Array<{ id: PeriodYears; label: string; short?: string }> = [{ id: 1, label: t("12 mesecev"), short: t("12 mes.") }, { id: 3, label: t("3 leta") }, { id: 5, label: t("5 let") }];

/** Calendar-year range like the earlier frontend: sales are published from 2007, rents from 2013. */
function YearRange({ period, last, onChange }: { period: `${number}-${number}`; last: number; onChange: (period: Period) => void }) {
  const [from, to] = period.split("-").map(Number);
  const years = Array.from({ length: last - FIRST_SALE_YEAR + 1 }, (_, index) => FIRST_SALE_YEAR + index);
  return <div className="year-range" role="group" aria-label={t("Koledarska leta")}>
    <span className="segmented-label">{t("Koledarska leta:")}</span>
    <label>{tx("od {select}", { select: <select value={from} onChange={(event) => { const next = Number(event.target.value); onChange(`${next}-${Math.max(next, to)}`); }}>
      {years.map((year) => <option key={year} value={year}>{year}</option>)}</select> })}</label>
    <label>{tx("do {select}", { select: <select value={to} onChange={(event) => { const next = Number(event.target.value); onChange(`${Math.min(from, next)}-${next}`); }}>
      {years.map((year) => <option key={year} value={year}>{year}</option>)}</select> })}</label>
  </div>;
}

/** Search, the value check toggle and the period above the map and panel. */
export function ExplorerBar({ state, navigate, cutoff, windows, regions, municipalities, districts }: {
  state: ExplorerState; navigate: Navigate; cutoff?: string; windows?: PeriodWindows;
  regions: Geography[]; municipalities: Geography[]; districts: Geography[];
}) {
  const lastYear = Number((cutoff ?? String(new Date().getFullYear())).slice(0, 4));
  return <div className="explorer-bar">
    {!state.value && <AreaSearch regions={regions} municipalities={municipalities} districts={districts} label={t("Poiščite občino, četrtno skupnost, regijo ali naslov")} placeholder={t("npr. Domžale, Savinjska, Kozje 144")}
      onArea={(option) => navigate({ g: option.id, building: undefined, selected: undefined, street: undefined })}
      onStreet={(street, _settlement, municipalityId) => navigate({ g: municipalityId ?? state.g, street: titleCase(street), building: undefined, selected: undefined, value: false })}
      onAddress={(address) => navigate({ g: undefined, building: { ko: address.cadastralMunicipalityCode, st: address.buildingNumber }, selected: undefined })}/>}
    <button type="button" className="value-button" aria-pressed={state.value} onClick={() => navigate({ value: !state.value })}>{state.value ? t("← Nazaj na pregled trga") : t("Koliko je vredna moja nepremičnina?")}</button>
    {!state.value && <>
      <div className="segmented" role="group" aria-label={t("Obdobje")}>
        {PERIODS.map((item) => <button key={item.id} type="button" aria-pressed={state.years === item.id} onClick={() => navigate({ years: item.id })}>{item.short
          ? <><span className="label-long">{item.label}</span><span className="label-short" aria-hidden="true">{item.short}</span></> : item.label}</button>)}
        <button type="button" aria-pressed={typeof state.years === "string"} onClick={() => {
          if (typeof state.years === "string") return;
          const last = windows ? Number(windows.sales.current.to.slice(0, 4)) : lastYear;
          navigate({ years: `${last - 3}-${last - 1}` });
        }}>{t("Po meri")}</button>
      </div>
      {typeof state.years === "string" && <YearRange period={state.years} last={lastYear} onChange={(years) => navigate({ years })}/>}
      {windows && <p className="period-chip">{t("Prodaje {from}–{to}, najemi {rents}", { from: date(windows.sales.current.from), to: date(windows.sales.current.to), rents: windows.rentYears })}</p>}
    </>}
  </div>;
}
