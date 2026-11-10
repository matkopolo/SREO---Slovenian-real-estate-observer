import { useState, type ReactNode } from "react";
import {
  isDwelling, loadAreaAffordability, loadDemographics, loadHousehold, loadMunicipalDemographics, loadRentOverview, loadSaleOverview, loadYearlyPrices,
  periodWindows, widerPeriods, type Affordability, type ConstructionSummary, type DemographicsResponse, type Period, type RentalOverview,
  type MunicipalDemographics, type RentGroup, type Segment, type StatisticsOverview, type TimePoint, type Window,
} from "../api";
import type { AreaOption } from "../components/AreaSearch";
import { Pyramid } from "../components/charts";
import { GLOSSARY, Term } from "../components/Term";
import { LoadFailed } from "./LoadState";
import { useDebounced } from "../hooks/useDebounced";
import { retryFailed, useLoad, type Load } from "../hooks/useLoad";
import { change, date, decimal1, euro, instalment, integer, percent } from "../format";
import { MIN_SAMPLE } from "../metrics";
import { NOUNS, type Band, type NounForms } from "../nouns";
import { count, NOUN_FORMS } from "../plural";
import { Name, t, tx } from "../i18n";

export interface Scope { id?: number; name: string; level: AreaOption["level"] }
/** The country as an area: its name is translated ("Slovenia"), unlike register names. */
export const SLOVENIA: Scope = { name: t("Slovenija"), level: "country" };
/** An area name for display: register names stay Slovenian (<Name>), the country is translated. */
export const areaName = (scope: Pick<Scope, "name" | "level">) => scope.level === "country" ? scope.name : <Name>{scope.name}</Name>; // i18n-ignore (code, not text)

/** A sale median and, when the period is too thin, the first wider trailing period (3, then 5 years) that has one. */
export interface PooledSale { sale: StatisticsOverview; fallback: { years: number; sale: StatisticsOverview; window: Window } | null; wide?: StatisticsOverview }
/** Fallback ladder for small areas: three, then five years ending at the cutoff (never for a chosen year range). */
export async function loadPooledSale(id: number | undefined, segment: Segment, cutoff: string, years: Period, signal: AbortSignal): Promise<PooledSale> {
  const sale = await loadSaleOverview(id, segment, periodWindows(cutoff, years).sales.current, signal);
  if (sale.isPublishable) return { sale, fallback: null };
  let wide: StatisticsOverview | undefined;
  for (const wider of widerPeriods(years)) {
    const window = periodWindows(cutoff, wider).sales.current;
    const pooled = await loadSaleOverview(id, segment, window, signal);
    if (wider === 5) wide = pooled;
    if (pooled.isPublishable) return { sale, fallback: { years: wider, sale: pooled, window }, wide };
  }
  return { sale, fallback: null, wide };
}

export interface AreaData {
  sale?: StatisticsOverview; salePrevious?: StatisticsOverview;
  /** null: no rentals for this type (land), or no earlier period. */
  rent?: RentalOverview | null; rentPrevious?: RentalOverview | null;
  fallback?: PooledSale["fallback"];
  affordability?: Affordability; demographics?: DemographicsResponse; prices?: TimePoint[];
  /** Some part could not be loaded (shown as "—", with one retry for the panel). */
  failed: boolean; retry: () => void;
}

/** Everything the overview shows for one area; every part loads (and fails) on its own. */
export function useArea(scope: Scope | undefined, segment: Segment, cutoff: string | undefined, years: Period = 1): AreaData {
  const base = scope && cutoff ? `${scope.id ?? 0}|${JSON.stringify(segment)}|${cutoff}|${years}` : null;
  const windows = cutoff ? periodWindows(cutoff, years) : undefined;
  const id = scope?.id;
  const group = segment.propertyGroup;
  const rentSegment = group === "land" ? undefined : { propertyGroup: group as RentGroup, minArea: segment.minArea, maxArea: segment.maxArea };
  const sale = useLoad(base && `area-sale|${base}`, (signal) => loadPooledSale(id, segment, cutoff!, years, signal));
  const salePrevious = useLoad(base && windows?.sales.previous ? `area-sale-previous|${base}` : null, (signal) => loadSaleOverview(id, segment, windows!.sales.previous!, signal));
  const rent = useLoad(base && `area-rent|${base}`, (signal) => rentSegment ? loadRentOverview(id, rentSegment, windows!.rents.current, signal) : Promise.resolve(null));
  const rentPrevious = useLoad(base && `area-rent-previous|${base}`, (signal) => rentSegment && windows!.rents.previous
    ? loadRentOverview(id, rentSegment, windows!.rents.previous, signal) : Promise.resolve(null));
  const affordability = useLoad(base && isDwelling(group) ? `area-afford|${id ?? 0}|${group}` : null, (signal) => loadAreaAffordability(id, group as "apartment" | "house", signal));
  // SURS demographics exist for Slovenia, regions and municipalities only (not districts or settlements).
  const demographics = useLoad(base && ["country", "statistical_region", "municipality"].includes(scope!.level) ? `area-demographics|${id ?? 0}` : null,
    (signal) => loadDemographics(id, signal));
  const prices = useLoad(base && `area-prices|${id ?? 0}|${JSON.stringify(segment)}`, async (signal) => (await loadYearlyPrices(id, segment, signal)).items);
  const loads: Array<Load<unknown>> = [sale, salePrevious, rent, rentPrevious, affordability, demographics, prices];
  return {
    sale: sale.data?.sale, fallback: sale.data?.fallback, salePrevious: salePrevious.data, rent: rent.data, rentPrevious: rentPrevious.data,
    affordability: affordability.data, demographics: demographics.data, prices: prices.data,
    failed: loads.some((load) => load.error != null), retry: retryFailed(loads),
  };
}

export const publishedPrice = (sale?: StatisticsOverview | null) => sale?.isPublishable ? sale.medianPricePerSqm ?? null : null;
export const publishedRent = (rent?: RentalOverview | null) => rent?.isPublishable ? rent.medianMonthlyRentPerSqm ?? null : null;

/** A personal borrowing estimate: the API applies the Banka Slovenije limits per borrower. */
export function Calculator({ scope, group, data, noun, columns }: {
  scope: Scope; group: "apartment" | "house"; data: AreaData; noun: NounForms; columns: Array<{ scope: Scope; data: AreaData }>;
}) {
  const median = data.affordability?.rows?.find((row) => row.band.id === "p50")?.band.netMonthlyIncome;
  const [income, setIncome] = useState<string>();
  const [second, setSecond] = useState<number | null>(null);
  const [savings, setSavings] = useState<number>();
  const assumed = data.affordability?.rows?.find((row) => row.band.id === "p50")?.downPayment;
  const [term, setTerm] = useState<20 | 30>(30);
  const typed = income === undefined ? undefined : Number(income);
  const own = income === undefined ? (median ? Math.round(median) : undefined) : typed && typed > 0 && typed <= 100000 ? typed : undefined;
  const invalid = income !== undefined && own === undefined && income.trim() !== "";

  // Typing waits for a pause before asking the API.
  const asked = useDebounced({ own, second: second || undefined }, 350);
  const result = useLoad(asked.own ? `household|${scope.id ?? 0}|${group}|${asked.own}|${asked.second ?? ""}` : null,
    (signal) => loadHousehold(scope.id, group, asked.own!, asked.second, signal));
  const household = own && result.data?.household ? result.data.household : undefined;

  const rates = data.affordability?.rates;
  const price = publishedPrice(data.sale) ?? data.fallback?.sale.medianPricePerSqm ?? null;
  const loan = household ? (term === 30 ? household.loan30Years : household.loan20Years) : undefined;
  const ltv = household?.recommendedLtv ?? 0.8;
  const savingsValue = savings ?? (assumed ? Math.round(assumed / 1000) * 1000 : 30000);
  const byLoan = loan != null ? loan + savingsValue : undefined;
  const bySavings = savingsValue / (1 - ltv);
  const maxPrice = byLoan != null ? Math.min(byLoan, bySavings) : undefined;
  const usedLoan = maxPrice != null ? Math.max(0, maxPrice - savingsValue) : undefined;
  const payment = usedLoan != null && rates?.fixedOver10Years ? instalment(usedLoan, rates.fixedOver10Years.value, term) : undefined;
  const others = columns.map((column) => ({ name: column.scope.name, price: publishedPrice(column.data.sale) })).filter((item) => item.price != null);

  return <section className="card wide calculator" aria-labelledby="calc-title">
    <h2 id="calc-title">{tx("Koliko si lahko privoščite v območju {area}", { area: areaName(scope) })}</h2>
    <form className="calc-inputs" onSubmit={(event) => event.preventDefault()}>
      <label>{t("Vaša neto plača na mesec (€)")}
        <input type="number" inputMode="numeric" min={1} max={100000} step={10} value={income ?? (own ?? "")} aria-invalid={invalid || undefined}
          onChange={(event) => setIncome(event.target.value)}/></label>
      <label className="check"><input type="checkbox" checked={second != null} onChange={(event) => setSecond(event.target.checked ? (own ?? 0) : null)}/> {t("Druga plača")}</label>
      {second != null && <label>{t("Druga neto plača (€)")}
        <input type="number" inputMode="numeric" min={0} max={100000} step={10} value={second || ""} onChange={(event) => setSecond(Math.max(0, Number(event.target.value) || 0))}/></label>}
      <label>{t("Prihranki za lastni delež (€)")}
        <input type="number" inputMode="numeric" min={0} step={1000} value={savingsValue} onChange={(event) => setSavings(Math.max(0, Number(event.target.value) || 0))}/></label>
      <div className="segmented small" role="group" aria-label={t("Doba kredita")}>
        {([20, 30] as const).map((value) => <button key={value} type="button" aria-pressed={term === value} onClick={() => setTerm(value)}>{count(value, NOUN_FORMS.leto)}</button>)}
      </div>
    </form>
    {invalid ? <p className="error" role="alert">{t("Vpišite neto mesečno plačo med 1 in 100.000 €.")}</p> // i18n-ignore (code, not text)
      : result.error ? <LoadFailed retry={result.retry}/> // i18n-ignore (code, not text)
      : !household || maxPrice == null ? <p className="muted">{own ? t("Računam …") : t("Vpišite neto plačo.")}</p> // i18n-ignore (code, not text)
      : savingsValue <= 0 ? <p className="calc-answer">{t("Brez prihrankov banka praviloma ne odobri stanovanjskega kredita: potrebujete vsaj {share} % cene.", { share: Math.round((1 - ltv) * 100) })}
        {" "}{t("S plačo {salary} bi lahko dobili kredit do {loan}, kar zadostuje za nakup do {price}, če imate {savings} prihrankov.", {
          salary: euro(own!), loan: euro(loan!), price: euro(Math.round(loan! / ltv / 1000) * 1000), savings: euro(Math.round(loan! * (1 - ltv) / ltv / 1000) * 1000) })}</p>
      : <>
      <p className="calc-answer">{(() => {
        const vars = { savings: euro(savingsValue), noun: noun.buy, price: <strong>{euro(Math.round(maxPrice / 1000) * 1000)}</strong>,
          loan: payment ? t("kredit {loan}, obrok okoli {payment} na mesec", { loan: euro(usedLoan!), payment: euro(Math.round(payment / 10) * 10) }) : t("kredit {loan}", { loan: euro(usedLoan!) }) };
        return second ? tx("Z dvema plačama ({first} in {second}) in {savings} prihrankov lahko kupite {noun} do {price} ({loan}).", { ...vars, first: euro(own!), second: euro(second) })
          : tx("S plačo {salary} in {savings} prihrankov lahko kupite {noun} do {price} ({loan}).", { ...vars, salary: euro(own!) });
      })()}
        {price != null && <> {tx("To je okoli {area} po mediani območja {name}", { area: <strong>{integer(maxPrice / price)} m²</strong>, name: areaName(scope) })}</>}
        {others.length > 0 && (() => {
          const list = others.map((item, index) => <span key={item.name}>{index ? ", " : ""}{tx("{area} m² v območju {name}", { area: integer(maxPrice / item.price!), name: <Name>{item.name}</Name> })}</span>);
          return price != null ? <>, {list}</> : <> {tx("To je {list}", { list })}</>;
        })()}
        {(price != null || others.length > 0) && "."}</p>
      <p className="muted">{bySavings < (byLoan ?? Infinity) ? `${t("Omejujejo prihranki: banka praviloma financira največ {max} % cene, zato potrebujete vsaj {min} % lastnih sredstev.", { max: Math.round(ltv * 100), min: Math.round((1 - ltv) * 100) })} ` : ""}
        {t("Največji obrok po omejitvah Banke Slovenije: {instalment}{note}.", { instalment: euro(household.maxInstalment), note: household.floorBinding ? ` ${t("(omejuje znesek, ki mora ostati za življenje)")}` : "" })}
        {" "}{t("Če obrestna mera zraste za {points} o. t., je največji 30-letni kredit {loan}.", { points: decimal1(data.affordability?.stressMarginPoints ?? 1), loan: euro(household.loan30YearsStress) })}
        {" "}{t("Fiksna obrestna mera {rate} %, brez drugih kreditov in vzdrževanih družinskih članov.", { rate: rates?.fixedOver10Years ? decimal1(rates.fixedOver10Years.value) : "—" })} {t("Ponazoritev, ne ponudba kredita.")}</p>
    </>}
  </section>;
}

interface Row {
  key: string; label: ReactNode; source: string; best?: "min" | "max";
  cell: (data: AreaData) => { value: string; delta?: number | null; note?: string; number?: number | null };
}

export function CompareTable({ columns, noun, band, removable, onRemove }: {
  columns: Array<{ scope: Scope; data: AreaData }>; noun: NounForms; band: Band; removable: boolean; onRemove: (id: number) => void;
}) {
  const typical = (sale?: StatisticsOverview) => band.typical ?? (sale?.medianArea != null ? Math.round(sale.medianArea) : 60);
  const rows: Row[] = [
    { key: "price", label: t("Mediana cene, {noun}", { noun: noun.plural }), source: t("GURS ETN, 12 mesecev do konca četrtletja"), best: "min",
      cell: ({ sale, salePrevious }) => {
        const price = publishedPrice(sale);
        return price != null ? { value: `${integer(price)} €/m²`, number: price, note: `n = ${integer(sale!.pricePerSqmSampleSize)}`,
          delta: change(price, publishedPrice(salePrevious)) }
          : { value: !sale ? "…" : sale.transactionCount === 0 ? t("ni prodaj") : t("premalo prodaj ({count})", { count: integer(sale.transactionCount) }) };
      } },
    { key: "typical", label: t("Tipičen posel"), source: t("mediana cene in površine"), best: "min",
      cell: ({ sale }) => sale?.isPublishable && sale.medianPrice != null
        ? { value: euro(sale.medianPrice), number: sale.medianPrice, note: sale.medianArea != null ? `${decimal1(sale.medianArea)} m²` : undefined }
        : { value: sale ? "—" : "…" } },
    { key: "count", label: t("Število prodaj"), source: t("vsi evidentirani posli, 12 mesecev"),
      cell: ({ sale, salePrevious }) => sale
        ? { value: integer(sale.transactionCount),
          delta: (salePrevious?.transactionCount ?? 0) >= MIN_SAMPLE ? change(sale.transactionCount, salePrevious?.transactionCount) : null }
        : { value: "…" } },
    { key: "rent", label: t("Mediana najemnine"), source: t("GURS ETN, zadnje celo leto, na mesec"), best: "min",
      cell: ({ rent, rentPrevious }) => {
        const value = publishedRent(rent);
        return value != null ? { value: `${decimal1(value)} €/m²`, number: value, note: `n = ${integer(rent!.rentPerSqmSampleSize)}`,
          delta: change(value, publishedRent(rentPrevious)) } : { value: rent === undefined ? "…" : rent ? t("premalo najemov") : "—" };
      } },
    { key: "rentbuy", label: t("Najem ali nakup"), source: t("tipična površina, kredit 30 let"), cell: ({ sale, rent, affordability }) => {
      const price = publishedPrice(sale);
      const monthly = publishedRent(rent);
      const fixed = affordability?.rates?.fixedOver10Years;
      const ltv = affordability?.rule?.recommendedLtv ?? 0.8;
      if (price == null || monthly == null || !fixed) return { value: sale && rent !== undefined ? "—" : "…" };
      const size = typical(sale);
      // Same basis as the cost cards: the median deal price when no size band is chosen.
      const total = band.typical ? price * size : sale?.medianPrice ?? price * size;
      return { value: t("najem {rent} · obrok {instalment}", { rent: euro(Math.round(monthly * size / 10) * 10), instalment: euro(Math.round(instalment(total * ltv, fixed.value, 30) / 10) * 10) }),
        note: t("{size} m², lastni delež {amount}", { size, amount: euro(Math.round(total * (1 - ltv) / 1000) * 1000) }) };
    } },
    { key: "afford", label: t("Površina za mediano plačo"), source: t("SURS plače, Banka Slovenije, 30 let"), best: "max", cell: ({ sale, affordability }) => {
      const row = affordability?.rows?.find((item) => item.band.id === "p50");
      const price = publishedPrice(sale);
      if (!row || price == null) return { value: affordability ? "—" : "…" };
      const sqm = Math.round(row.priceAtRecommendedLtv / price);
      return { value: `${integer(sqm)} m²`, number: sqm, note: `${t("kredit {loan}", { loan: euro(row.loan30Years) })}${affordability!.wageGeography?.nationalFallback ? `, ${t("plače Slovenije")}` : ""}` };
    } },
    { key: "population", label: t("Prebivalci"), source: t("SURS, 1. januar"), cell: ({ demographics }) => demographics?.profile?.population
      ? { value: integer(demographics.profile.population.total), delta: demographics.profile.population.change10Years, note: t("sprememba v 10 letih") }
      : { value: "…" } },
    { key: "older", label: t("Delež starih 65 let ali več"), source: t("SURS, 1. januar"), cell: ({ demographics }) => demographics?.profile?.population
      ? { value: percent(demographics.profile.population.share65Plus) } : { value: "…" } },
    { key: "migration", label: t("Neto selitve na 1.000 prebivalcev"), source: t("SURS, povprečje 5 let"), cell: ({ demographics }) => {
      const recent = (demographics?.profile?.migration ?? []).slice(-5).flatMap((year) => year.perThousand == null || Math.abs(year.perThousand) > 100 ? [] : [year.perThousand]);
      return recent.length ? { value: `${decimal1(recent.reduce((a, b) => a + b, 0) / recent.length)} ‰` } : { value: demographics ? "—" : "…" };
    } },
    { key: "releases", label: t("Stanovanja, ki jih sprostijo starejši"), source: t("modelna ocena na leto"), cell: ({ demographics }) => {
      const releases = demographics?.profile?.releases;
      return releases ? { value: integer(releases.perYear), note: releases.perThousandDwellings != null
        ? t("{count} na 1.000 stanovanj", { count: decimal1(releases.perThousandDwellings) }) : undefined } : { value: demographics ? "—" : "…" };
    } },
    { key: "yield", label: <Term text={GLOSSARY.donos}>{t("Bruto donos najema")}</Term>, source: t("groba ocena pred stroški, davki in praznimi meseci"), best: "max",
      cell: ({ sale, rent }) => {
        const price = publishedPrice(sale);
        const monthly = publishedRent(rent);
        return price && monthly ? { value: percent((monthly * 12) / price), number: (monthly * 12) / price } : { value: sale && rent !== undefined ? "—" : "…" };
      } },
  ];
  // Rent-or-buy and wage-based rows only make sense for homes.
  const dwelling = noun === NOUNS.apartment || noun === NOUNS.house;
  const shownRows = rows.filter((row) => dwelling || (row.key !== "rentbuy" && row.key !== "afford"));
  const cheapest = (() => {
    if (!removable) return undefined;
    const priced = columns.map((column) => ({ name: column.scope.name, price: publishedPrice(column.data.sale) })).filter((item) => item.price != null);
    if (priced.length < 2) return undefined;
    const best = priced.reduce((a, b) => (b.price! < a.price! ? b : a)); // i18n-ignore (code, not text)
    const first = publishedPrice(columns[0].data.sale);
    return { ...best, versus: first && best.name !== columns[0].scope.name ? best.price! / first - 1 : null };
  })();
  return <>
    <div className="table-scroll"><table className="compare">
      <caption className="sr-only">{t("Primerjava kazalnikov po območjih")}</caption>
      <thead><tr><th scope="col">{t("Kazalnik")}</th>{columns.map((column, index) => <th scope="col" key={`${column.scope.level}-${column.scope.id ?? 0}-${index}`}>
        {areaName(column.scope)}{removable && index > 0 && column.scope.id && <button type="button" className="remove" aria-label={t("Odstrani {name}", { name: column.scope.name })}
          onClick={() => onRemove(column.scope.id!)}>×</button>}</th>)}</tr></thead>
      <tbody>{shownRows.map((row) => {
        // A column whose data failed shows "—" instead of waiting ("…") forever; the panel offers the retry.
        const cells = columns.map((column) => { const cell = row.cell(column.data); return cell.value === "…" && column.data.failed ? { ...cell, value: "—" } : cell; });
        const numbers = cells.map((cell) => cell.number).filter((value): value is number => value != null);
        const target = removable && row.best && numbers.length > 1 ? (row.best === "min" ? Math.min(...numbers) : Math.max(...numbers)) : undefined;
        return <tr key={row.key}>
          <th scope="row">{row.label}<span className="cell-note">{row.source}</span></th>
          {cells.map((cell, index) => <td key={index} data-label={columns[index].scope.name} className={target != null && cell.number === target ? "best" : undefined}>
            <span className="value">{cell.value}</span>
            {cell.delta != null && <span className={cell.delta >= 0 ? "delta up" : "delta down"}>{percent(cell.delta, { signed: true })}</span>}
            {cell.note && <span className="cell-note">{cell.note}</span>}</td>)}
        </tr>;
      })}</tbody>
    </table></div>
    {cheapest && <p className="table-summary">{tx("Najcenejše med izbranimi: {name}, {price} €/m²{versus}.", {
      name: <Name>{cheapest.name}</Name>, price: integer(cheapest.price!), // i18n-ignore (code, not text)
      versus: cheapest.versus != null ? <> {tx("({change} glede na {name})", { change: percent(cheapest.versus, { signed: true }), name: areaName(columns[0].scope) })}</> : "" })}
      {" "}{t("Krepko je najugodnejša vrednost v vrstici.")}</p>}
  </>;
}

export function Cite({ scope, noun, windows, columns }: {
  scope: Scope; noun: NounForms; windows?: { sales: { current: Window } }; columns: Array<{ scope: Scope; data: AreaData }>;
}) {
  const [status, setStatus] = useState<string>();
  if (!windows) return null;
  const text = t("SREO, obdelava podatkov GURS ETN (CC BY 4.0), posli {from}–{to}, mediana reprezentativnih prodaj ({noun}), {area}. {url}", {
    from: date(windows.sales.current.from), to: date(windows.sales.current.to), noun: noun.genitive, area: scope.name, url: window.location.href });
  const csv = () => {
    const header = [t("Območje"), t("Mediana €/m²"), "n", t("Prodaje"), t("Mediana najemnine €/m²"), t("n najemov")];
    const lines = columns.map(({ scope: item, data }) => [item.name, publishedPrice(data.sale) ?? "", data.sale?.pricePerSqmSampleSize ?? "",
      data.sale?.transactionCount ?? "", publishedRent(data.rent) ?? "", data.rent?.rentPerSqmSampleSize ?? ""].join(";"));
    const blob = new Blob([[header.join(";"), ...lines].join("\n")], { type: "text/csv;charset=utf-8" });
    const link = document.createElement("a");
    link.href = URL.createObjectURL(blob);
    link.download = `sreo-${scope.name.toLocaleLowerCase("sl-SI").replace(/\s+/g, "-")}.csv`; // i18n-ignore (file name from the register name)
    link.click();
    URL.revokeObjectURL(link.href);
  };
  return <span className="cite">
    <button type="button" className="ghost" onClick={() => {
      const done = () => setStatus(t("Navedba vira je kopirana."));
      if (navigator.clipboard) navigator.clipboard.writeText(text).then(done, () => setStatus(text)); else setStatus(text);
    }}>{t("Citiraj")}</button>
    <button type="button" className="ghost" onClick={csv}>{t("Prenesi CSV")}</button>
    {status && <span role="status" className="muted">{status}</span>}
  </span>;
}

/** Where a municipality stands among all municipalities on the demographic indicators. */
function useRanking(municipalityId?: number) {
  const items = useLoad(municipalityId ? "municipal-demographics" : null, async (signal) => (await loadMunicipalDemographics(signal)).items).data;
  if (!municipalityId || !Array.isArray(items)) return undefined;
  const rank = (value: (item: MunicipalDemographics) => number | null | undefined) => {
    const own = items.find((item) => item.geographyId === municipalityId);
    const mine = own ? value(own) : null;
    if (mine == null) return undefined;
    return 1 + items.filter((item) => (value(item) ?? -Infinity) > mine).length;
  };
  return { total: items.length, older: rank((item) => item.share65Plus), migration: rank((item) => item.netMigrationPerThousand) };
}

export function Population({ data, name, municipalityId, failed }: { data?: DemographicsResponse; name: string; municipalityId?: number; failed?: () => void }) {
  const ranking = useRanking(municipalityId);
  if (!data?.profile?.population) return <section className="card wide"><h2>{t("Kdo bo kupoval in kdo prodajal")}</h2>
    {!data && failed ? <LoadFailed retry={failed}/> : <p className="muted">{data ? t("Podatki SURS za to območje niso na voljo.") : t("Nalagam podatke SURS …")}</p>}</section>;
  const { profile } = data;
  // Years above ±100 per 1,000 residents are registry artefacts, not migration.
  const net = profile.migration.slice(-5).filter((year) => year.perThousand == null || Math.abs(year.perThousand) <= 100); // i18n-ignore (code, not text)
  const average = net.length ? net.reduce((sum, year) => sum + year.net, 0) / net.length : null;
  const releases = profile.releases;
  // Death rates come from the region (a register name) or from the whole country (translated).
  const deathArea = releases?.deathRatesFrom === "Slovenija" ? t("Slovenija") : releases?.deathRatesFrom ?? "—"; // i18n-ignore (matches the API value)
  return <section className="card wide" aria-labelledby="population-title">
    <h2 id="population-title">{t("Kdo bo kupoval in kdo prodajal")}</h2>
    <div className="population">
      <Pyramid groups={profile.pyramid} period={profile.period} earlierPeriod={profile.earlierPeriod}
        label={t("Prebivalstvo območja {name} po starostnih skupinah", { name })}/>
      <div className="flows">
        <div className="table-scroll"><table className="compact-table flows-table">
          <caption>{tx("Na leto, {name}", { name: name === SLOVENIA.name ? name : <Name>{name}</Name> })}</caption>
          <tbody>
            <tr><th scope="row">{t("V starost okoli 30 let vstopi")}<span className="cell-note">{t("ko se večina ljudi prvič osamosvoji")}</span></th>
              <td>{count(profile.population.enteringThirtiesPerYear, NOUN_FORMS.človek)}</td></tr>
            {average != null && <tr><th scope="row">{t("Neto selitve")}<span className="cell-note">{t("povprečje {count} let", { count: net.length })}</span></th>
              <td>{average > 0 ? "+" : ""}{count(average, NOUN_FORMS.človek)}</td></tr>}
            {releases && <tr><th scope="row">{t("Starejši lastniki sprostijo")}<span className="cell-note">{tx("{estimate}, okvirni razpon ±25 %", { estimate: <Term text={GLOSSARY.modelna}>{t("modelna ocena")}</Term> })}</span></th>
              <td>{count(releases.perYear, NOUN_FORMS.stanovanje)}<span className="cell-note">{integer(releases.perYear * 0.75)}–{integer(releases.perYear * 1.25)}</span></td></tr>}
          </tbody>
        </table></div>
        <p className="muted">{t("Ljudje in stanovanja niso ista enota: vsak, ki dopolni 30 let, ne ustanovi svojega gospodinjstva, in vsako sproščeno stanovanje ne pride na trg.")}</p>
        {ranking?.older != null && <p>{tx("Po deležu starejših je {name} na {rank}. mestu od {total} občin (1. mesto = najstarejša), po neto priseljevanju {migration}.", {
          name: <Name>{name}</Name>, rank: ranking.older, total: ranking.total,
          migration: ranking.migration != null ? t("na {rank}. mestu", { rank: ranking.migration }) : t("ni objavljena") })}</p>}
        <p className="muted">{data.releasesCaveat ? t(data.releasesCaveat) : ""} {t("Umrljivost: {area}, {years};", {
          area: deathArea, years: releases?.deathYears ?? "—" })}
          {" "}{t("delež samskih po starosti: Slovenija; delež lastniških stanovanj: območje (popis 2021).")} {t("Domovi za starejše lahko oceno zvišajo.")}</p>
        <p className="evidence-note">{t("To so kazalniki ponudbe in povpraševanja, ne napoved cen. Preverili smo obdobje 2010–2025: demografija (staranje, sproščena stanovanja, mladi, selitve) ni imela merljivega vpliva na razlike v rasti cen med občinami in regijami; ravni cen po regijah so ostale stabilne. Morebiten učinek je manjši od približno 0,5 odstotne točke na leto.")}</p>
      </div>
    </div>
  </section>;
}

export function Construction({ summary, name, cutoff }: { summary?: ConstructionSummary; name: string; cutoff?: string }) {
  const rows = summary?.summary?.buildingsByYear ?? [];
  const built = rows.reduce((sum, row) => sum + row.buildings, 0);
  const dwellings = rows.reduce((sum, row) => sum + row.dwellings, 0);
  const permit = summary?.summary?.permits?.at(-1);
  const current = cutoff ? Number(cutoff.slice(0, 4)) : undefined;
  const years = summary?.filter ? `${summary.filter.fromYear}–${summary.filter.toYear}${summary.filter.toYear === current ? "*" : ""}` : "";
  return <section className="card" aria-labelledby="supply-title">
    <h2 id="supply-title">{t("Nova ponudba")}</h2>
    {!summary?.summary ? <p className="muted">{summary ? t("Podatki katastra niso na voljo.") : t("Nalagam kataster stavb …")}</p> : <dl className="facts">
      <div><dt>{t("Nove stavbe v katastru, {years}", { years })}</dt><dd>{integer(built)}</dd></div>
      <div><dt>{t("Stanovanj v njih")}</dt><dd>{integer(dwellings)}</dd></div>
      <div><dt>{t("Gradbena dovoljenja {year}", { year: permit?.year ?? "" })}</dt><dd>{permit?.buildings == null ? "—" : integer(permit.buildings)}</dd></div>
      <div><dt>{t("Stanovanja v dovoljenjih")}</dt><dd>{permit?.dwellings == null ? "—" : integer(permit.dwellings)}</dd></div>
    </dl>}
    {rows.length > 1 && <YearBars rows={rows} current={current}/>}
    <p className="muted">{years.endsWith("*") ? `${t("* Tekoče leto ni zaključeno.")} ` : ""}{t("Kataster pokaže zgrajene stavbe, ne gradenj v teku.")}
      {" "}{t("Dovoljenja SURS {scope}.", { scope: summary?.summary?.permitsScope === "slovenia" ? t("za Slovenijo") : name })}</p>
  </section>;
}

/** New buildings and their dwellings per year (cadastre year of construction). */
function YearBars({ rows, current }: { rows: Array<{ year: number; buildings: number; dwellings: number }>; current?: number }) {
  const max = Math.max(1, ...rows.map((row) => row.dwellings));
  return <figure className="supply-bars">
    <figcaption>{t("Stanovanja v novih stavbah po letih")}</figcaption>
    <ul>{rows.map((row) => <li key={row.year}>
      <span className="supply-bars-year">{row.year}{row.year === current ? "*" : ""}</span>
      <span className="supply-bars-track" aria-hidden="true"><i style={{ width: `${(row.dwellings / max) * 100}%` }}/></span>
      <span className="supply-bars-value">{t("{dwellings} stan., {buildings} stavb", { dwellings: integer(row.dwellings), buildings: integer(row.buildings) })}</span>
    </li>)}</ul>
  </figure>;
}

export function Housing({ data, failed }: { data?: DemographicsResponse; failed?: () => void }) {
  const housing = data?.profile?.housing;
  return <section className="card wide" aria-labelledby="stock-title">
    <h2 id="stock-title">{t("Stanovanjski fond")}</h2>
    {!housing ? (!data && failed ? <LoadFailed retry={failed}/> : <p className="muted">{data ? t("Popisni podatki niso objavljeni.") : t("Nalagam …")}</p>) : <dl className="facts wide-facts">
      <div><dt>{t("Stanovanja, {year}", { year: housing.year })}</dt><dd>{integer(housing.dwellings)}</dd></div>
      <div><dt>{t("Nenaseljena")}</dt><dd>{housing.unoccupied == null ? "—" : `${integer(housing.unoccupied)} (${percent(housing.unoccupied / housing.dwellings)})`}</dd></div>
      <div><dt>{t("Od nenaseljenih prazna (delež iz {year})", { year: housing.splitYear ?? "—" })}</dt><dd>{housing.vacant == null || housing.seasonal == null
        ? "—" : percent(housing.vacant / (housing.vacant + housing.seasonal))}</dd></div>
      <div><dt>{t("Lastniška med naseljenimi")}</dt><dd>{housing.ownerOccupiedShare == null ? "—" : percent(housing.ownerOccupiedShare)}</dd></div>
      <div><dt>{t("Enočlanska gospodinjstva")}</dt><dd>{housing.onePersonShare == null ? "—" : percent(housing.onePersonShare)}</dd></div>
      <div><dt>{t("Gospodinjstva, {year}", { year: housing.year })}</dt><dd>{housing.households == null ? "—" : integer(housing.households)}</dd></div>
    </dl>}
    <p className="muted">{t("Registrski popis SURS.")} {t("Za {year} SURS ne loči počitniških in praznih stanovanj, zato je delitev iz {splitYear}.", { year: housing?.year ?? "2021", splitYear: housing?.splitYear ?? "2018" })}
      {" "}{t("Nenaseljeno ne pomeni naprodaj ali za najem.")}</p>
  </section>;
}
