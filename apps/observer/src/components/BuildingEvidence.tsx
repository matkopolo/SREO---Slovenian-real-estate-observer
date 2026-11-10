import { useEffect, useEffectEvent, useState, type ReactNode } from "react";
import { loadBuilding, loadRentalEvidence, loadSaleEvidence, type BuildingStatistics, type PropertyGroup } from "../api";
import { date, euro, integer, median as medianOf, percent, titleCase, upTo1 } from "../format";
import { useLoad } from "../hooks/useLoad";
import { LANG, Name, t, tx } from "../i18n";
import { TYPE_NAME } from "../nouns";
import { count, form, forms, NOUN_FORMS } from "../plural";
import { hrefWith, type Selected } from "../url-state";
import {
  BuildingComparables, HowCalculated, mainUnit, MapsLink, partialSaleReasons, perSqmText, PriceVerdict, RegisterDetails, TransactionFacts, TransactionHistory,
  TransactionQuality, transactionSubtitle, transactionTitle,
} from "./TransactionDetails";
import { RangeBar } from "./charts";
import "./building-evidence.css"; // i18n-ignore (code)

/** An active size filter from the map ("45–70 m²"); bounds are inclusive. */
type SizeBand = { min?: number; max?: number; label: string };
const GROUPS = TYPE_NAME;
const UNITS = forms(["enota", "enoti", "enote", "enot"], ["unit", "units"]); // i18n-ignore

/** "2 prodaji stanovanj", "1 prodaja stanovanja" / "2 apartment sales". */
function salesOf(group: string, total: number, nouns: typeof NOUN_FORMS.prodaja) {
  const vars = { count: integer(total), noun: form(total, nouns) };
  const one = total === 1;
  switch (group) {
    case "apartment": return one ? t("{count} {noun} stanovanja", vars) : t("{count} {noun} stanovanj", vars);
    case "house": return one ? t("{count} {noun} hiše", vars) : t("{count} {noun} hiš", vars);
    case "garage": return one ? t("{count} {noun} garaže", vars) : t("{count} {noun} garaž", vars);
    case "commercial": return one ? t("{count} {noun} poslovnega prostora", vars) : t("{count} {noun} poslovnih prostorov", vars);
    case "land": return one ? t("{count} {noun} zemljišča", vars) : t("{count} {noun} zemljišč", vars);
    default: return t("{count} {noun} {type}", { ...vars, type: GROUPS[group] ?? group });
  }
}
const YEARS = 5;
/** Genitive after "iz" ("iz istih 3 prodaj"). */
const SALES_OF = forms(["prodaje", "prodaj", "prodaj", "prodaj"], ["sale", "sales"]); // i18n-ignore

/** Whole calendar years: the five years before the data's last year and that year so far ("2021–2026"), the same for count, bars and list. */
const window_ = (last = new Date().getFullYear()) => ({ first: last - YEARS, last, from: `${last - YEARS}-01-01` });
const yearsText = (first: number, last: number) => t("v letih {from}–{to}", { from: first, to: last });

type Agreement = BuildingStatistics["saleTransactions"][number];

/**
 * One selection of a building's agreements, shared by the building page (heading, bars, list, comparison with the area)
 * and the sale page ("Druge prodaje v isti stavbi"): one property type, the size band when it belongs to that type, whole years.
 */
function buildingSelection<T extends Agreement>(items: T[], { group, band, everything = false, lastYear }: { group: string; band?: SizeBand; everything?: boolean; lastYear?: number }) {
  const { first, last, from } = window_(lastYear);
  const ofType = items.filter((item) => item.propertyGroup === group);
  const inBand = (item: { area?: number | null }) => !band || (item.area != null && (band.min == null || item.area >= band.min) && (band.max == null || item.area <= band.max));
  const sized = band ? ofType.filter(inBand) : ofType;
  const recent = (item: T) => (item.contractDate ?? "") >= from;
  const list = (everything ? sized : sized.filter(recent)).sort((a, b) => (b.contractDate ?? "").localeCompare(a.contractDate ?? ""));
  const priced = list.filter((item) => item.representative && item.amountPerSqm != null);
  const dated = list.map((item) => Number(item.contractDate?.slice(0, 4))).filter((year) => year > 0);
  return {
    list, priced, ofType, older: sized.filter((item) => !recent(item)).length, bandCount: ofType.filter(inBand).length,
    median: medianOf(priced.map((item) => item.amountPerSqm!)) ?? undefined,
    first: everything && dated.length ? Math.min(...dated) : first, last,
  };
}

/** "Zgrajena 1967 · 71 enot · zadnja prodaja 4/2026". */
function buildingFacts(building: BuildingStatistics) {
  const latest = building.saleTransactions.map((item) => item.contractDate ?? "").filter(Boolean).sort().at(-1);
  return [building.constructionYear ? t("Zgrajena {year}", { year: building.constructionYear }) : undefined,
    building.knownBuildingPartCount > 0 ? count(building.knownBuildingPartCount, UNITS) : undefined,
    latest ? t("zadnja prodaja {date}", { date: `${Number(latest.slice(5, 7))}/${latest.slice(0, 4)}` }) : undefined].filter(Boolean).join(" · ");
}

/** The area's middle half for the same type and period (P25–P75), to place the building's median against. */
type AreaSpread = { name: ReactNode; p25: number; p50: number; p75: number; p05?: number | null; p95?: number | null };

/**
 * All recorded agreements in a building. The heading, the per-year bars, the list and the comparison with the area share
 * one filter (property type, the active size band when one is passed, and whole calendar years), so the building shows
 * one count and one median everywhere.
 */
export function BuildingStack({ building, onChoose, band: givenBand, group: preferred = "apartment", area, lastYear }: {
  building: BuildingStatistics; onChoose: (selected: Selected) => void; band?: SizeBand;
  /** The type chosen on the map (the band belongs to it). */
  group?: PropertyGroup;
  /** The data's last year (the cutoff's), so the five years match the rest of the page. */
  lastYear?: number;
  /** The area's spread for the same type: drawn as one bar with this building's median from the same list. */
  area?: AreaSpread;
}) {
  const [tab, setTab] = useState<"sale" | "rent">(building.saleTransactions.length || !building.rentalTransactions.length ? "sale" : "rent");
  const all = tab === "sale" ? building.saleTransactions : building.rentalTransactions;
  const groups = [...new Set(all.map((item) => item.propertyGroup))];
  const [group, setGroup] = useState<string>(preferred);
  const [everything, setEverything] = useState(false);
  const [allSizes, setAllSizes] = useState(false);
  const active = groups.includes(group as never) ? group : groups[0] ?? "apartment";
  // A size band belongs to the type it was chosen for (45–70 m² flats never filter garages).
  const band = active === preferred ? givenBand : undefined;
  const selection = buildingSelection(all, { group: active, band: allSizes ? undefined : band, everything, lastYear });
  const { list: agreements, priced, median, older, first, last } = selection;
  const list = agreements.map((item) => ({ ...item, kind: tab }));
  const bandCount = buildingSelection(all, { group: active, band, lastYear }).bandCount;
  const typeCount = selection.ofType.length;
  const years = new Map<number, number>();
  for (const item of list) if (item.contractDate) years.set(Number(item.contractDate.slice(0, 4)), (years.get(Number(item.contractDate.slice(0, 4))) ?? 0) + 1);
  const span = Array.from({ length: Math.max(0, last - first + 1) }, (_, index) => first + index);
  const max = Math.max(1, ...years.values());
  const isRent = tab === "rent";
  const unit = isRent ? t("€/m² na mesec") : "€/m²";
  const nouns = isRent ? NOUN_FORMS.najem : NOUN_FORMS.prodaja;
  const what = salesOf(active, list.length, nouns);
  const period = everything ? t("od leta {year}", { year: first }) : yearsText(first, last);
  const sizeNote = band && !allSizes ? ` ${t("(velikost {size})", { size: band.label })}` : "";
  const shownValue = median != null ? { value: perSqmText(median), unit } : undefined;
  const value = priced.length === 1 && shownValue ? list.length === 1 ? `: ${shownValue.value} ${unit}` : t(", od tega 1 v statistiki: {value} {unit}", shownValue)
    : priced.length > 1 && shownValue ? t(", mediana {value} {unit}", shownValue) : "";
  const label = (year: number) => span.length <= 8 || year % 5 === 0; // i18n-ignore (code)
  const place = [building.street && titleCase(building.street), building.houseNumber && `${building.houseNumber}${building.houseNumberSuffix ?? ""}`].filter(Boolean).join(" ");
  const facts = buildingFacts(building);
  const compare = area && !isRent && !everything ? priced.length >= 3 && median != null : false;
  return <section className="be-stack" aria-labelledby="be-title">
    <h2 className="section-title" id="be-title">{t("V tej stavbi")}</h2>
    <p className="muted be-meta">{facts || (LANG === "sl" ? place : <Name>{place}</Name>)}</p>{/* i18n-ignore (class names, code) */}
    <div className="controls be-controls">
      <div className="segmented small" role="group" aria-label={t("Vrsta poslov")}>
        <button type="button" aria-pressed={tab === "sale"} onClick={() => setTab("sale")}>{t("Prodaje")}</button>
        <button type="button" aria-pressed={tab === "rent"} onClick={() => setTab("rent")}>{t("Najemi")}</button>
      </div>
      {groups.length > 1 && <label className="year">{t("Vrsta nepremičnine")}
        <select value={active} onChange={(event) => setGroup(event.target.value)}>
          {groups.map((item) => <option key={item} value={item}>{GROUPS[item] ?? item} ({integer(all.filter((entry) => entry.propertyGroup === item).length)})</option>)}
        </select></label>}
    </div>
    <p className="stage-sub be-count">{what} {period}{sizeNote}{value}.</p>
    {area && !isRent && !everything && (compare ? <div className="be-area">
      <RangeBar p25={area.p25} p50={area.p50} p75={area.p75} min={Math.min(area.p05 ?? area.p25 * 0.7, median! * 0.95)} max={Math.max(area.p95 ?? 0, area.p75 * 1.2, median! * 1.05)}
        unit="€/m²" label={t("Cena v stavbi glede na razpon območja")} markers={[{ value: median!, name: t("Ta stavba") }]}/>
      <p className="muted">{tx("Mediana stavbe je iz istih {count} kot zgoraj, srednja polovica iz prodaj v območju {area}.",
        { count: count(priced.length, SALES_OF), area: area.name })}</p>
    </div> : <p className="muted">{tx("Za primerjavo z območjem {area} je v tem izboru premalo prodaj v statistiki ({count}).", { area: area.name, count: integer(priced.length) })}</p>)}
    <p className="be-toggles">
      {(older > 0 || everything) && <button type="button" className="link" onClick={() => setEverything(!everything)}>
        {everything ? t("Samo {period}", { period: yearsText(window_(lastYear).first, last) }) : t("Pokaži vse, tudi starejše ({count} več)", { count: count(older, nouns) })}</button>}
      {band && bandCount !== typeCount && <button type="button" className="link" onClick={() => setAllSizes(!allSizes)}>
        {allSizes ? t("Samo velikost {size}", { size: band.label }) : t("Pokaži vse velikosti")}</button>}
    </p>
    {list.length > 0 && span.length > 0 && <figure className="be-years">
      <figcaption className="sr-only">{isRent ? t("Najemi po letih") : t("Prodaje po letih")} ({first}–{last})</figcaption>
      <ol style={{ gridTemplateColumns: `repeat(${span.length}, minmax(0, 1fr))` }}>{span.map((year) => <li key={year} title={`${year}: ${years.get(year) ?? 0}`}>{/* i18n-ignore (class names, code) */}
        <span className="be-count-label" aria-hidden="true">{years.get(year) || ""}</span>
        <span className="be-bar-slot" aria-hidden="true"><span className="be-bar" style={{ height: `${years.get(year) ? Math.max(6, ((years.get(year) ?? 0) / max) * 100) : 0}%` }}/></span>
        <span className="be-year" aria-hidden="true">{label(year) ? (span.length > 8 ? `’${String(year).slice(2)}` : year) : ""}</span>
        <span className="sr-only">{year}: {years.get(year) ?? 0}</span></li>)}</ol>
    </figure>}
    {list.length === 0 ? <p className="muted">{isRent ? t("Ni najemov s tem izborom.") : t("Ni prodaj s tem izborom.")}</p> : <div className="table-scroll be-table"><table className="evidence-table">{/* i18n-ignore (class names, code) */}
      <caption className="sr-only">{isRent ? t("Najemi v stavbi") : t("Prodaje v stavbi")}</caption>
      <thead><tr><th scope="col">{t("Datum")}</th><th scope="col">{t("Površina")}</th><th scope="col">{isRent ? t("Na mesec") : t("Cena")}</th>
        <th scope="col">{unit}</th></tr></thead>
      <tbody>{list.slice(0, 60).map((item) => <tr key={`${item.kind}${item.transactionId}`}>
        <th scope="row"><button type="button" className="link" onClick={() => onChoose({ kind: item.kind, id: item.transactionId })}>{item.contractDate ? date(item.contractDate) : "—"}</button>
          {!item.representative && <span className="chip">{t("ni v statistiki")}</span>}</th>
        <td>{item.area == null ? "—" : `${upTo1(item.area)} m²`}</td>
        <td>{item.amount == null ? "—" : euro(item.amount)}</td><td>{item.amountPerSqm == null ? "—" : perSqmText(item.amountPerSqm)}</td></tr>)}</tbody>
    </table></div>}
    {list.length > 60 && <p className="muted">{t("Prikazanih je 60 najnovejših od {total}.", { total: integer(list.length) })}</p>}
    <details className="td-register be-register"><summary>{t("Podatki iz registra")}</summary>{/* i18n-ignore (class names, code) */}
      <p className="muted">{t("Katastrska občina {code}, stavba {number}.", { code: building.cadastralMunicipalityCode, number: building.buildingNumber })} {t("Vir: GURS, evidenca trga nepremičnin.")}</p>
    </details>
  </section>;
}

/**
 * "Druge prodaje v isti stavbi" on a sale page: the building's list with the same selection as the building section
 * (this sale's type, the map's size band for that type, whole years), minus this sale, so both show the same sales.
 */
function OtherSales({ building, transactionId, group, perSqm, band, kind, onChoose }: {
  building: BuildingStatistics; transactionId: number; group: string; perSqm?: number | null; band?: SizeBand; kind: "sale" | "rent";
  onChoose: (selected: Selected) => void;
}) {
  const isRent = kind === "rent";
  const selection = buildingSelection(isRent ? building.rentalTransactions : building.saleTransactions, { group, band });
  const others = selection.list.filter((item) => item.transactionId !== transactionId);
  const nouns = isRent ? NOUN_FORMS.najem : NOUN_FORMS.prodaja;
  const scope = `${yearsText(selection.first, selection.last)}${band ? ` ${t("(velikost {size})", { size: band.label })}` : ""}`;
  const signed = (value: number) => percent(value / 100, { signed: true, digits: "upTo1" });
  return <section aria-labelledby="td-comparables"><h3 id="td-comparables">{isRent ? t("Drugi najemi v isti stavbi") : t("Druge prodaje v isti stavbi")}</h3>
    {others.length === 0 ? <p className="muted">{isRent ? t("V stavbi ni drugih najemov {scope}.", { scope }) : t("V stavbi ni drugih prodaj {scope}.", { scope })}</p> : <>
      <p className="muted">{salesOf(group, others.length, nouns)} {scope}. {isRent ? t("Razlika v ceni na m² glede na ta najem, brez prilagoditve za čas.")
        : t("Razlika v ceni na m² glede na to prodajo, brez prilagoditve za čas.")}</p>
      <ol className="rows td-comparables">{others.slice(0, 6).map((item) => {
        const difference = perSqm && item.amountPerSqm != null ? 100 * (item.amountPerSqm / perSqm - 1) : undefined;
        return <li key={item.transactionId}>
          <div className="td-comparable-head">
            <button type="button" className="link" onClick={() => onChoose({ kind, id: item.transactionId })}>{item.contractDate ? date(item.contractDate) : "—"}</button>
            {difference != null && <strong className="td-diff" aria-label={isRent ? t("{difference} na m² glede na ta najem", { difference: signed(difference) })
              : t("{difference} na m² glede na to prodajo", { difference: signed(difference) })}>{signed(difference)}</strong>}
          </div>
          <span>{[item.amount == null ? undefined : isRent ? t("{amount} na mesec", { amount: euro(item.amount) }) : euro(item.amount),
            item.amountPerSqm == null ? undefined : `${perSqmText(item.amountPerSqm)} ${isRent ? t("€/m² na mesec") : "€/m²"}`,
            item.area == null ? undefined : `${upTo1(item.area)} m²`, !item.representative ? t("ni v statistiki") : undefined].filter(Boolean).join(" · ")}</span>
        </li>;
      })}</ol>
      {others.length > 6 && <p className="muted">{t("Vseh {count} je v seznamu stavbe.", { count: integer(others.length) })}</p>}</>}
  </section>;
}

type SaleEvidence = Awaited<ReturnType<typeof loadSaleEvidence>>; // i18n-ignore (code)
type RentalEvidence = Awaited<ReturnType<typeof loadRentalEvidence>>;
const settled = <T,>(result: PromiseSettledResult<T> | undefined) => result?.status === "fulfilled" ? result.value : undefined; // i18n-ignore (code)
const VALUE_GROUPS = new Set(["apartment", "house", "commercial", "garage"]);

export function TransactionEvidence({ selected, onChoose, onBuilding, building, group, band, primary = false }: {
  selected: Selected; onChoose: (selected: Selected) => void; onBuilding?: (ko: number, st: string) => void;
  /** The opened sale is the page's subject: its title is the page heading (h1). */
  primary?: boolean;
  /** The building the page already shows; otherwise it is loaded for the address, the other sales and the register section. */
  building?: BuildingStatistics;
  /** The type chosen on the map and its size band: the band filters the other sales only for that type. */
  group?: PropertyGroup; band?: SizeBand;
}) {
  const sale = useLoad<SaleEvidence>(selected.kind === "sale" ? `sale-evidence-${selected.id}` : null, (signal) => loadSaleEvidence(selected.id, signal)).data;
  const rent = useLoad<RentalEvidence>(selected.kind === "rent" ? `rent-evidence-${selected.id}` : null, (signal) => loadRentalEvidence(selected.id, signal)).data;
  const evidence = selected.kind === "sale" ? sale : rent;
  const context = settled(evidence?.context);
  const valuation = settled(evidence?.valuation);
  const history = selected.kind === "sale" ? settled(sale?.history) : undefined;
  const saleDetail = selected.kind === "sale" ? settled(sale?.detail) : undefined;
  const rentDetail = selected.kind === "rent" ? settled(rent?.detail) : undefined;
  const detail = saleDetail ?? rentDetail;
  // The primary part decides the building, the address and the other sales (a flat, not its storage room in another building).
  const unit = detail ? mainUnit(detail) : undefined;
  const ko = unit?.cadastralMunicipalityCode ?? undefined;
  const st = unit?.buildingNumber ?? undefined;
  // A transaction opened on its own brings its building along (shareable link keeps both).
  const reportBuilding = useEffectEvent((code: number, number: string) => onBuilding?.(code, number));
  useEffect(() => { if (ko && st) reportBuilding(ko, st); }, [ko, st]);
  const given = building && building.cadastralMunicipalityCode === ko && building.buildingNumber === st ? building : undefined;
  const buildingLoad = useLoad(!given && ko && st ? `building-${ko}-${st}` : null, (signal) => loadBuilding(ko!, st!, signal));
  // undefined: loading, null: could not be loaded (the API's matched subset is shown instead).
  const loaded = buildingLoad.error ? null : buildingLoad.data;
  const own = given ?? (loaded && loaded.cadastralMunicipalityCode === ko && loaded.buildingNumber === st ? loaded : undefined);
  const buildingYear = given ? given.constructionYear : loaded === undefined ? undefined : loaded?.constructionYear ?? null;
  const isRent = selected.kind === "rent";
  const unitLabel = isRent ? t("€/m² na mesec") : "€/m²";
  const perSqm = saleDetail?.pricePerSqm ?? rentDetail?.monthlyRentPerSqm;
  const title = detail ? transactionTitle(detail) : isRent ? t("Najem") : t("Prodaja");
  const subtitle = detail ? transactionSubtitle(detail, own) : undefined;
  const partial = partialSaleReasons(saleDetail, context, history);
  // The map's size band only filters the other sales when it was chosen for this sale's type.
  const sameBand = detail && (group ?? "apartment") === detail.propertyGroup ? band : undefined;

  return <aside className="panel td-panel" aria-live="polite" aria-label={title}>
    <header><div><p className="eyebrow">{isRent ? t("Najem") : t("Prodaja")}</p>
      {primary ? <h1 className="td-title">{title}</h1> : <h2>{title}</h2>}
      {subtitle && <p className="td-address">{subtitle}</p>}</div></header>
    {!evidence && <p className="muted" role="status">{isRent ? t("Nalagam najem …") : t("Nalagam prodajo …")}</p>}
    {evidence && evidence.detail.status === "rejected" && <p className="error" role="alert">{isRent ? t("Najema ni bilo mogoče naložiti.") : t("Prodaje ni bilo mogoče naložiti.")}</p>}
    {detail && <dl className="facts td-key-facts">
      <div><dt>{isRent ? t("Najemnina na m²") : t("Cena na m²")}</dt><dd>{perSqm == null ? "—" : `${perSqmText(perSqm)} ${unitLabel}`}</dd></div>
      <div><dt>{t("Datum pogodbe")}</dt><dd>{detail.contractDate ? date(detail.contractDate) : "—"}</dd></div>
    </dl>}
    {detail && <PriceVerdict context={context} detail={detail} kind={selected.kind} partial={partial}/>}
    {detail && <HowCalculated context={context} valuation={valuation} detail={detail} kind={selected.kind}/>}
    {saleDetail && ko && st && VALUE_GROUPS.has(saleDetail.propertyGroup) && <p className="td-value-link">
      <a href={hrefWith({ value: true, building: { ko, st }, selected: { kind: "sale", id: selected.id } })}>{t("Je to vaša nepremičnina? Ocena današnje vrednosti →")}</a></p>}
    {detail && <MapsLink detail={detail} building={own}/>}
    {detail && <TransactionFacts sale={saleDetail} rent={rentDetail}/>}
    {detail && <TransactionQuality detail={detail}/>}
    {detail && own ? <OtherSales building={own} transactionId={selected.id} group={detail.propertyGroup} perSqm={perSqm} band={sameBand} kind={selected.kind} onChoose={onChoose}/>
      : context && (!ko || !st || loaded === null) && <BuildingComparables context={context} kind={selected.kind} onChoose={onChoose}/>}
    {history && <TransactionHistory history={history} transactionId={selected.id} onChoose={onChoose}/>}
    {detail && <RegisterDetails detail={detail} buildingYear={buildingYear} building={own}/>}
  </aside>;
}
