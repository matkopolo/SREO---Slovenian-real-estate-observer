"use client";

import { ArrowLeft, ArrowRight, Building2, ExternalLink, X } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Brand } from "@/components/ui/brand";
import {
  loadConstructionBuilding, loadConstructionSummary, loadPublicWorks, loadRegions, noticeTypeLabel,
  type ConstructionBuilding, type ConstructionFilter, type ConstructionSummaryResponse, type PublicWorksResponse,
} from "@/lib/construction-api";
import { decimal, euro } from "@/lib/display-values";
import type { Geography } from "@/lib/types";
import { ConstructionMap } from "./construction-map";
import styles from "./construction.module.css";

const THIS_YEAR = new Date().getFullYear();
const YEARS = Array.from({ length: THIS_YEAR - 1999 }, (_, index) => 2000 + index);
const PAGE = 10;
const number = (value: number | null | undefined) => value == null ? "—" : Math.round(value).toLocaleString("sl-SI");

function initialFilter(): ConstructionFilter & { building?: string; areaName?: string } {
  const query = new URLSearchParams(window.location.search);
  const year = (name: string, fallback: number) => {
    const value = Number(query.get(name));
    return value >= 2000 && value <= THIS_YEAR ? value : fallback;
  };
  const fromYear = year("fromYear", THIS_YEAR - 5);
  return {
    geographyId: Number(query.get("geographyId")) || undefined,
    areaName: query.get("areaName") ?? undefined,
    fromYear, toYear: Math.max(fromYear, year("toYear", THIS_YEAR)),
    withDwellings: query.get("withDwellings") === "true",
    building: query.get("building") ?? undefined,
  };
}

export function ConstructionExplorer() {
  const initial = useMemo(() => initialFilter(), []);
  const [filter, setFilter] = useState<ConstructionFilter>({
    geographyId: initial.geographyId, fromYear: initial.fromYear, toYear: initial.toYear, withDwellings: initial.withDwellings,
  });
  const [areaName, setAreaName] = useState(initial.areaName ?? "Slovenija");
  const [regions, setRegions] = useState<Geography[]>([]);
  const [summary, setSummary] = useState<ConstructionSummaryResponse>();
  const [summaryError, setSummaryError] = useState(false);
  const [selected, setSelected] = useState<string | undefined>(initial.building);
  const [building, setBuilding] = useState<ConstructionBuilding>();
  const [works, setWorks] = useState<PublicWorksResponse>();
  const [worksOffset, setWorksOffset] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    loadRegions(controller.signal).then((response) => setRegions(response.items)).catch(() => undefined);
    return () => controller.abort();
  }, []);

  useEffect(() => {
    const query = new URLSearchParams({ fromYear: String(filter.fromYear), toYear: String(filter.toYear) });
    if (filter.geographyId) { query.set("geographyId", String(filter.geographyId)); query.set("areaName", areaName); }
    if (filter.withDwellings) query.set("withDwellings", "true");
    if (selected) query.set("building", selected);
    window.history.replaceState(null, "", `${window.location.pathname}?${query}`);
  }, [areaName, filter, selected]);

  useEffect(() => {
    const controller = new AbortController();
    queueMicrotask(() => { if (!controller.signal.aborted) setSummaryError(false); });
    loadConstructionSummary(filter, controller.signal).then((value) => { if (!controller.signal.aborted) setSummary(value); })
      .catch(() => { if (!controller.signal.aborted) setSummaryError(true); });
    return () => controller.abort();
  }, [filter]);

  useEffect(() => {
    const controller = new AbortController();
    loadPublicWorks(filter, worksOffset, PAGE, controller.signal)
      .then((value) => { if (!controller.signal.aborted) setWorks(value); }).catch(() => undefined);
    return () => controller.abort();
  }, [filter, worksOffset]);

  useEffect(() => {
    if (!selected) return;
    const controller = new AbortController();
    loadConstructionBuilding(selected, controller.signal)
      .then((value) => { if (!controller.signal.aborted) setBuilding(value); })
      .catch(() => { if (!controller.signal.aborted) setBuilding(undefined); });
    return () => controller.abort();
  }, [selected]);

  const changeFilter = (next: Partial<ConstructionFilter>) => { setWorksOffset(0); setFilter((current) => ({ ...current, ...next })); };
  const chooseArea = useCallback((geographyId: number | undefined, name: string) => {
    setWorksOffset(0);
    setAreaName(name);
    setFilter((current) => ({ ...current, geographyId }));
  }, []);
  const chooseBuilding = useCallback((eid: string) => setSelected(eid), []);

  const data = summary?.summary;
  const totals = (data?.buildingsByYear ?? []).reduce((sum, row) => ({
    buildings: sum.buildings + row.buildings, dwellings: sum.dwellings + row.dwellings }), { buildings: 0, dwellings: 0 });
  const latestPermit = data?.permits.at(-1);
  const permitsByYear = new Map((data?.permits ?? []).map((row) => [row.year, row]));
  const chartYears = Array.from({ length: filter.toYear - filter.fromYear + 1 }, (_, index) => filter.fromYear + index);
  const builtByYear = new Map((data?.buildingsByYear ?? []).map((row) => [row.year, row]));
  const chartMax = Math.max(1, ...chartYears.map((year) => Math.max(builtByYear.get(year)?.buildings ?? 0,
    permitsByYear.get(String(year))?.buildings ?? 0)));

  return <div className="app-shell">
    <header className="topbar">
      {/* Full page loads on purpose: the market dashboard restores its state from the URL on mount. */}
      {/* eslint-disable-next-line @next/next/no-location-assign-relative-destination */}
      <Brand onHome={() => { window.location.assign("/"); }}/>
      <nav aria-label="Glavna navigacija">
        {/* eslint-disable-next-line @next/next/no-html-link-for-pages */}
        <a href="/">Trg nepremičnin</a>
        <a href="/gradbeni-projekti" className="active" aria-current="page">Gradbeni projekti</a>
      </nav>
    </header>
    <main className={styles.page}>
      <h1 className="sr-only">Gradbeni projekti · gradbena aktivnost po uradnih virih</h1>
      <div className={styles.intro}>
        <span className="section-eyebrow">Gradbena aktivnost · uradni viri</span>
        <p>Vpisane nove stavbe (GURS), izdana gradbena dovoljenja (SURS) in javna gradbena naročila (EU TED).
          Zasebni projekti v gradnji niso javno dostopni, zato jih ne prikazujemo. Vpis v kataster pomeni zgrajeno
          ali izmerljivo stavbo, ne gradnje v teku.</p>
      </div>

      <section className={styles.filters} aria-label="Filtri gradbene aktivnosti">
        <label><span>Območje</span>
          <select value={filter.geographyId ?? ""} onChange={(event) => {
            const region = regions.find((item) => item.id === Number(event.target.value));
            chooseArea(region?.id, region?.name ?? "Slovenija");
          }}>
            <option value="">Slovenija</option>
            {filter.geographyId && !regions.some((item) => item.id === filter.geographyId) &&
              <option value={filter.geographyId}>{areaName}</option>}
            {regions.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
          </select></label>
        <label><span>Leto izgradnje od</span>
          <select value={filter.fromYear} onChange={(event) => changeFilter({ fromYear: Number(event.target.value),
            toYear: Math.max(filter.toYear, Number(event.target.value)) })}>
            {YEARS.map((year) => <option key={year} value={year}>{year}</option>)}
          </select></label>
        <label><span>do</span>
          <select value={filter.toYear} onChange={(event) => changeFilter({ toYear: Number(event.target.value),
            fromYear: Math.min(filter.fromYear, Number(event.target.value)) })}>
            {YEARS.map((year) => <option key={year} value={year}>{year}</option>)}
          </select></label>
        <label className={styles.checkbox}><input type="checkbox" checked={filter.withDwellings}
          onChange={(event) => changeFilter({ withDwellings: event.target.checked })}/>
          <span>Samo stavbe s stanovanji</span></label>
      </section>

      <section className={styles.summary} aria-labelledby="construction-summary-title" aria-busy={!summary && !summaryError}>
        <h2 id="construction-summary-title">{areaName}</h2>
        {summaryError && <p role="alert" className={styles.notice}>Povzetka ni bilo mogoče naložiti.</p>}
        <dl className={styles.tiles}>
          <div><dt>Nove vpisane stavbe {filter.fromYear}–{filter.toYear}</dt><dd>{data ? number(totals.buildings) : "…"}</dd>
            <small>GURS kataster · stanje {data?.sourceDate ?? "…"}</small></div>
          <div><dt>Stanovanja v teh stavbah</dt><dd>{data ? number(totals.dwellings) : "…"}</dd><small>po katastru stavb</small></div>
          <div><dt>Gradbena dovoljenja {latestPermit?.year ?? ""}</dt><dd>{number(latestPermit?.buildings)}</dd>
            <small>SURS · {data?.permitsScope === "slovenia" ? "Slovenija" : "občine območja"} · {number(latestPermit?.dwellings)} stanovanj</small></div>
          <div><dt>Javna gradbena naročila, 12 mesecev</dt><dd>{number(data?.publicWorksLast12Months)}</dd>
            <small>EU TED · {number(data?.publicWorksAwardsLast12Months)} oddanih · {data?.publicWorksScope === "region" ? "regija" : "Slovenija"}</small></div>
        </dl>
        {data && <figure className={styles.chart}>
          <figcaption>Vpisane nove stavbe po letu izgradnje in izdana dovoljenja za gradnjo stavb (SURS) po letih</figcaption>
          <div className={styles.chartLegend}><span><i className={styles.built}/>Vpisane stavbe</span><span><i className={styles.permit}/>Dovoljenja (SURS)</span></div>
          <ol>{chartYears.map((year) => {
            const built = builtByYear.get(year)?.buildings ?? 0;
            const permit = permitsByYear.get(String(year))?.buildings;
            return <li key={year} aria-label={`${year}: ${number(built)} vpisanih stavb, ${permit == null ? "dovoljenja niso objavljena" : `${number(permit)} dovoljenj`}`}>
              <span className={styles.bars} aria-hidden="true">
                <i className={styles.built} style={{ height: `${built / chartMax * 100}%` }}/>
                <i className={styles.permit} style={{ height: `${(permit ?? 0) / chartMax * 100}%` }}/>
              </span>
              <span>{year}{year === THIS_YEAR ? "*" : ""}</span>
            </li>;
          })}</ol>
          <small>* Tekoče leto ni zaključeno. Dovoljenja SURS so objavljena do {data.permits.at(-1)?.year ?? "—"}.
            Dovoljenje in vpis iste stavbe sta lahko več let narazen.</small>
        </figure>}
      </section>

      <div className={styles.workspace}>
        <ConstructionMap filter={filter} selectedEid={selected} onArea={(id, name) => chooseArea(id, name)} onBuilding={chooseBuilding}/>
        <aside className={styles.inspector} aria-live="polite">
          {!selected && <div className={styles.placeholder}><Building2 aria-hidden="true"/>
            <p>Povečajte zemljevid in izberite stavbo za podatke iz katastra in povezavo do dejanskih poslov.</p></div>}
          {selected && !building && <p role="status">Nalagam stavbo …</p>}
          {selected && building && <BuildingDetail building={building} onClose={() => { setSelected(undefined); setBuilding(undefined); }}/>}
        </aside>
      </div>

      <section className={styles.works} aria-labelledby="public-works-title">
        <header><div><span className="section-eyebrow">EU TED · javna naročila gradbenih del</span>
          <h2 id="public-works-title">Javni gradbeni projekti · {data?.publicWorksScope === "region" ? areaName : "Slovenija"}</h2>
          <p>Naročila nad pragom EU. Lokacija je znana le na ravni regije; zasebnih projektov TED ne vsebuje.</p></div></header>
        {!works ? <p role="status">Nalagam objave …</p> : works.items.length === 0 ? <p>Ni objav za izbrano območje.</p> : <>
          <ul>{works.items.map((notice) => <li key={notice.publicationNumber}>
            <div><span className={styles.noticeType}>{noticeTypeLabel(notice.noticeType)}</span>
              <time dateTime={notice.publicationDate}>{new Date(`${notice.publicationDate}T00:00:00`).toLocaleDateString("sl-SI")}</time></div>
            <strong>{notice.title.replace(/^Slovenija – /, "")}</strong>
            <small>{notice.buyer ?? "Naročnik ni naveden"}{notice.winners.length ? ` · izvajalec: ${notice.winners.join(", ")}` : ""}
              {notice.regions.length ? ` · ${notice.regions.join(", ")}` : ""}{notice.value != null ? ` · ${euro.format(notice.value)}` : ""}</small>
            <a href={notice.url} target="_blank" rel="noreferrer">Objava {notice.publicationNumber} <ExternalLink aria-hidden="true" size={13}/></a>
          </li>)}</ul>
          <nav className={styles.pager} aria-label="Strani objav">
            <button type="button" aria-disabled={worksOffset === 0} onClick={() => { if (worksOffset > 0) setWorksOffset(worksOffset - PAGE); }}>
              <ArrowLeft aria-hidden="true" size={15}/> Novejše</button>
            <span aria-live="polite">{worksOffset + 1}–{Math.min(worksOffset + PAGE, works.total)} od {works.total.toLocaleString("sl-SI")}</span>
            <button type="button" aria-disabled={worksOffset + PAGE >= works.total}
              onClick={() => { if (worksOffset + PAGE < works.total) setWorksOffset(worksOffset + PAGE); }}>Starejše <ArrowRight aria-hidden="true" size={15}/></button>
          </nav>
        </>}
      </section>

      <footer className="legal-footer"><div><strong>Viri</strong>
        <p>{(summary?.sources ?? []).map((source) => `${source.name} (${source.licence}): ${source.note}`).join(" ")}</p>
        <p>Podatki so obdelani. Lastniški podatki iz katastra se ne uvažajo.</p></div></footer>
    </main>
  </div>;
}

function BuildingDetail({ building, onClose }: { building: ConstructionBuilding; onClose: () => void }) {
  const marketLink = `/?context=building&cadastralCode=${building.cadastralCode}&buildingNumber=${building.buildingNumber}`;
  const fields: Array<[string, string]> = [
    ["Leto izgradnje", building.yearBuilt == null ? "ni podatka" : String(building.yearBuilt)],
    ["Etaže", building.floors == null ? "ni podatka" : String(building.floors)],
    ["Stanovanja", building.dwellings == null ? "ni podatka" : String(building.dwellings)],
    ["Poslovni prostori", building.businessUnits == null ? "ni podatka" : String(building.businessUnits)],
    ["Bruto tlorisna površina", building.grossFloorArea == null ? "ni podatka" : `${decimal.format(building.grossFloorArea)} m²`],
    ["Tip stavbe", building.buildingType ?? "ni podatka"],
    ["Nosilna konstrukcija", building.loadBearingStructure ?? "ni podatka"],
    ["Status vpisa", building.registrationStatus ?? "ni podatka"],
    ["Zadnja sprememba zapisa", building.recordChangedOn ?? "ni podatka"],
  ];
  return <div className={styles.building}>
    <header><div><span className="section-eyebrow">Stavba v katastru · GURS</span>
      <h3>k. o. {building.cadastralCode} · stavba {building.buildingNumber}</h3>
      <p>{building.municipality ?? "Občina ni znana"}</p></div>
      <button type="button" className="icon-button" aria-label="Zapri stavbo" onClick={onClose}><X aria-hidden="true"/></button></header>
    <dl>{fields.map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}</dl>
    <p className={styles.transactions}>{building.saleTransactions + building.rentalTransactions === 0
      ? "V tej stavbi še ni evidentiranih poslov GURS ETN."
      : `GURS ETN: ${building.saleTransactions} prodaj, ${building.rentalTransactions} najemov v tej stavbi.`}</p>
    {/* Full page load: the market dashboard reads context=building from the URL when it mounts. */}
    <a className={styles.marketLink} href={marketLink}>Odpri stavbo v analitiki trga <ArrowRight aria-hidden="true" size={15}/></a>
    <small>Stanje katastra {building.sourceDate}. Leto izgradnje je vpisani podatek, ne datum začetka gradnje.</small>
  </div>;
}
