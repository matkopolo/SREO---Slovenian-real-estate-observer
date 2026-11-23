import { useEffect, useEffectEvent, useMemo, useRef, useState } from "react";
import {
  FIRST_SALE_YEAR, isDwelling, loadAreaConstruction, loadInflationBetween, loadRecent, loadSaleOverview, loadSpread, periodWindows, shiftWindow,
  type DateWindow, type Distribution, type Geography, type LandScope, type Period, type PropertyGroup, type Segment, type TimePoint,
} from "../api";
import { areaName, Calculator, Cite, CompareTable, Construction, Housing, loadPooledSale, Population, publishedPrice, publishedRent, useArea, type PooledSale, type Scope } from "./AreaModules";
import { AreaSearch } from "./AreaSearch";
import { RentSection } from "./RentSection";
import { SalesList } from "./SalesList";
import { Histogram, LineChart, RangeBar, ScaleStrip, type SeriesStyle } from "./charts";
import { LoadFailed, LoadState } from "./LoadState";
import { Missing } from "./Missing";
import { GLOSSARY, Term } from "./Term";
import { retryFailed, useLoad, type Load } from "../hooks/useLoad";
import { capitalise, change, decimal1, euro, instalment, integer, NBSP, percentSigned, perSqm, titleCase, withUnit } from "../format";
import { jumpTo } from "../focus";
import { loadingText, withheld } from "./Missing";
import { MIN_SAMPLE } from "../metrics";
import { ALL_SIZES, LAND_GENITIVE, LAND_SCOPES, NOUNS, SIZE_BANDS, sizeBand, type Band } from "../nouns";
import { count, NOUN_FORMS, type Forms } from "../plural";
import { Name, t, tx } from "../i18n";
import { hasCoarsePointer, prefersReducedMotion } from "../layout";
import { ABOUT, areaHref } from "../url-state";
import "./area-panel.css";

/** Below this many sales a median is not shown at all; the individual sales are listed instead. */
const LIST_INSTEAD = 10;
/** The pooled window thin areas borrow, and the span the individual sales are counted over. */
const POOLED_YEARS = 5;
/** How long "Povezava kopirana" stays. */
const TOAST_MS = 2000;

/** Too few sales for a median (rural areas): still say how many and for how much, from the last five years. */
function FewSales({ scopeId, segment, cutoff }: { scopeId?: number; segment: Segment; cutoff?: string }) {
  const summary = useLoad(cutoff ? { cutoff, scopeId, segment } : null, (input) => `few-sales|${input.scopeId ?? 0}|${JSON.stringify(input.segment)}|${input.cutoff}`, async (input, signal) => {
    const response = await loadRecent(input.scopeId, input.segment, "sale", periodWindows(input.cutoff, POOLED_YEARS).sales.current, signal, { limit: 100 });
    const representative = response.items.filter((item) => item.representative);
    const prices = representative.flatMap((item) => item.amount == null ? [] : [item.amount]);
    const perSqmValues = representative.flatMap((item) => item.amountPerSqm == null ? [] : [item.amountPerSqm]);
    if (response.total < 3 || prices.length < 2) return null;
    return { total: response.total, low: Math.min(...prices), high: Math.max(...prices),
      lowSqm: perSqmValues.length ? Math.min(...perSqmValues) : undefined, highSqm: perSqmValues.length ? Math.max(...perSqmValues) : undefined };
  }).data;
  if (!summary) return null;
  return <><br/><strong>{t("{sales} v zadnjih 5 letih · {low}–{high}", { sales: count(summary.total, NOUN_FORMS.prodaja), low: euro(summary.low), high: euro(summary.high) })}</strong>
    {summary.lowSqm != null && summary.highSqm != null ? ` (${perSqm(summary.lowSqm)}–${withUnit(perSqm(summary.highSqm), "€/m²")})` : ""}</>;
}

interface RankItem { id: number; name: string; value: number | null; sample: number; format: (value: number) => string; label: string; pooled?: number; populationSample?: boolean; unit?: Forms }

interface TypeFigures { sale?: PooledSale["sale"]; previous?: PooledSale["sale"]; spread?: Distribution; pooled?: { years: number; sale: PooledSale["sale"] } | null; wide?: PooledSale["sale"]; failed: boolean }

/** Sales median, change and spread for one property type, pooling 3 or 5 years when the period is too thin. */
function useTypeFigures(scope: Scope, group: PropertyGroup, cutoff: string | undefined, years: Period, landScope: LandScope = "strict", band?: Band): { figures: TypeFigures; loads: Array<Load<unknown>> } {
  const segment: Segment = { propertyGroup: group, landScope, minArea: band?.min, maxArea: band?.max };
  const windows = cutoff ? periodWindows(cutoff, years) : undefined;
  const base = cutoff ? { id: scope.id, segment, cutoff, years, key: `${scope.id ?? 0}|${JSON.stringify(segment)}|${cutoff}|${years}` } : null;
  const sale = useLoad(base, (input) => `area-sale|${input.key}`, (input, signal) => loadPooledSale(input.id, input.segment, input.cutoff, input.years, signal));
  const previousWindow = windows?.sales.previous;
  const previous = useLoad(base && previousWindow ? { ...base, window: previousWindow } : null, (input) => `area-sale-previous|${input.key}`,
    (input, signal) => loadSaleOverview(input.id, input.segment, input.window, signal));
  // The spread of the window the median comes from (the period's own, or the pooled one).
  const spreadWindow = sale.data?.sale.isPublishable ? windows?.sales.current : sale.data?.fallback?.window;
  const spread = useLoad(base && spreadWindow ? { ...base, window: spreadWindow } : null, (input) => `spread|${input.key}|${input.window.from}`,
    (input, signal) => loadSpread(input.id, input.window, input.segment, "sale", signal));
  const fallback = sale.data?.fallback;
  return {
    figures: { sale: sale.data?.sale, previous: previous.data, spread: spread.data, pooled: fallback ? { years: fallback.years, sale: fallback.sale } : sale.data ? null : undefined,
      wide: sale.data?.wide, failed: sale.error != null },
    loads: [sale, previous, spread],
  };
}

export function AreaPanel({ scope, parents: path, group, years, cutoff, onGroup, onSubArea, ranking, subRanking, regions = [], municipalities = [], districts = [], street, onClearStreet, landScope = "strict", landChosen = false, onLandScope, size, onSize }: {
  scope: Scope; parents: Scope[]; group: PropertyGroup; years: Period; cutoff?: string;
  onGroup: (group: PropertyGroup) => void; onSubArea?: (id: number) => void;
  landScope?: LandScope; landChosen?: boolean; onLandScope?: (scope: LandScope, auto?: boolean) => void;
  /** Floor-area band id of the selected type (`SIZE_BANDS`). */
  size?: string; onSize?: (size: string | undefined) => void;
  regions?: Geography[]; municipalities?: Geography[]; districts?: Geography[];
  street?: string; onClearStreet?: () => void; // i18n-ignore (code, not text)
  /** Child areas with their current map values (country: municipalities; region: its municipalities). */
  ranking?: Array<RankItem>; // i18n-ignore (code, not text)
  subRanking?: Array<RankItem>;
}) {
  const windows = useMemo(() => cutoff ? periodWindows(cutoff, years) : undefined, [cutoff, years]);
  const band = sizeBand(group, size);
  const segment = useMemo<Segment>(() => ({ propertyGroup: group, landScope, minArea: band?.min, maxArea: band?.max }), [band?.max, band?.min, group, landScope]);
  const flats = useTypeFigures(scope, "apartment", cutoff, years, "strict", group === "apartment" ? band : undefined);
  const houses = useTypeFigures(scope, "house", cutoff, years, "strict", group === "house" ? band : undefined);
  const land = useTypeFigures(scope, "land", cutoff, years, landScope);
  const commercial = useTypeFigures(scope, "commercial", cutoff, years, "strict", group === "commercial" ? band : undefined);
  const garages = useTypeFigures(scope, "garage", cutoff, years);
  const figuresOf: Record<PropertyGroup, TypeFigures> = { apartment: flats.figures, house: houses.figures, land: land.figures, commercial: commercial.figures, garage: garages.figures };
  const area = useArea(scope, segment, cutoff, years);
  // Comparators: the nearest parent and Slovenija (a district has three parents; the breadcrumb keeps them all).
  const parents = useMemo(() => path.length <= 2 ? path : [path[0], path[path.length - 1]], [path]); // i18n-ignore (code, not text)
  const parentA = useArea(parents[0], segment, cutoff, years);
  const parentB = useArea(parents[1], segment, cutoff, years);
  const parentData = [parentA, parentB].slice(0, parents.length);
  const [extra, setExtra] = useState<Scope[]>([]);
  const [adding, setAdding] = useState(false);
  const extraA = useArea(extra[0], segment, cutoff, years);
  const extraB = useArea(extra[1], segment, cutoff, years);

  // Land: unless the user picked a use, show the one with most sales here (rural areas sell farmland, not building plots).
  // Counted over five years: in rural areas a single year often has no sales of any use.
  const landAuto = useLoad(group === "land" && !landChosen && cutoff ? { cutoff, id: scope.id } : null, (input) => `land-auto|${input.id ?? 0}|${input.cutoff}`, async (input, signal) => {
    const uses = ["strict", "agricultural", "forest"] as const;
    const span = periodWindows(input.cutoff, POOLED_YEARS).sales.current;
    const counts = await Promise.all(uses.map(async (use) => (await loadSaleOverview(input.id, { propertyGroup: "land", landScope: use }, span, signal)).transactionCount ?? 0));
    return { best: uses[counts.indexOf(Math.max(...counts))], any: Math.max(...counts) > 0 };
  });
  const pickLand = useEffectEvent((found: { best: LandScope; any: boolean }) => { if (found.best !== landScope && found.any) onLandScope?.(found.best, true); });
  useEffect(() => { if (landAuto.data) pickLand(landAuto.data); }, [landAuto.data]);

  const current = figuresOf[group];
  const noun = group === "land" ? { ...NOUNS.land, genitive: LAND_GENITIVE[landScope] } : NOUNS[group];
  const shown = current.sale?.isPublishable ? current.sale : current.pooled?.sale;
  const price = publishedPrice(shown);
  const yoy = current.sale?.isPublishable ? change(price, publishedPrice(current.previous)) : null;
  const versus = windows?.custom ? t("glede na enako dolgo obdobje prej") : years === 1 ? t("v letu dni")
    : (windows?.years ?? 1) < 5 ? t("glede na prejšnja {years}", { years: count(windows?.years ?? 1, NOUN_FORMS.leto) }) : t("glede na prejšnjih {years}", { years: count(windows?.years ?? 1, NOUN_FORMS.leto) });
  // CPI between the middles of the two 12-month windows, so the real change matches the nominal comparison.
  const inflation = useLoad(cutoff ?? null, (value) => `inflation-year|${value}`, async (value, signal) => {
    const { sales } = periodWindows(value, 1);
    const middle = (span: DateWindow) => `${shiftWindow(span, 6).to.slice(0, 7)}-01`;
    return sales.previous ? (await loadInflationBetween(middle(sales.previous), middle(sales.current), signal)).factor : null;
  }).data;
  // One notice for the whole panel when some figures could not be loaded; each part then shows "—".
  const panelLoads = [...flats.loads, ...houses.loads, ...land.loads, ...commercial.loads, ...garages.loads];
  const failed = panelLoads.some((load) => load.error != null) || [area, ...parentData].some((data) => data.failed);
  const retryAll = () => { retryFailed(panelLoads)(); for (const data of [area, ...parentData]) if (data.failed) data.retry(); };
  const real = yoy != null && inflation ? (1 + yoy) / inflation - 1 : null;
  const periodText = windows?.label ?? "";
  const town = path.find((item) => item.level === "municipality");
  const bands = SIZE_BANDS[group];

  return <article className="area-panel" aria-labelledby="area-title">
    <nav className="breadcrumb" aria-label={t("Pot do območja")}>
      <ol>{[...path].reverse().map((item) => <li key={`${item.level}-${item.id ?? 0}`}><a href={areaHref(item.id)}>{areaName(item)}</a></li>)}
        <li aria-current="page">{areaName(scope)}</li></ol>
    </nav>
    <div className="title-row">
      {street ? <h1 id="area-title" className="area-title"><Name>{titleCase(street)}</Name><span className="title-town">, {areaName(scope)}</span></h1> : <h1 id="area-title" className="area-title">{scope.level === "city_district" ? <><Name>{scope.name}</Name>{town && <span className="title-town">, <Name>{town.name}</Name></span>}</> : areaName(scope)}</h1>}
      <ShareLink/>
    </div>
    {failed && <LoadFailed retry={retryAll}>{t("Nekaterih podatkov za to območje ni bilo mogoče naložiti.")}</LoadFailed>}
    <p className="area-lede">
      {!current.sale ? (current.failed ? null : t("Nalagam posle\u00a0…"))
        : price != null ? <>{tx("Mediana cene {noun}{band} {period}: {price}", { noun: noun.genitive, band: band ? ` (${band.label})` : "", period: periodText,
            price: <strong>{perSqm(price)}{NBSP}€/m²</strong> })}
          {yoy != null ? <>, {percentSigned(yoy)} {versus}{Math.abs(yoy) > 0.2 && shown?.pricePerSqmSampleSize != null && shown.pricePerSqmSampleSize < 200 && <span className="muted"> {t("(majhen vzorec, n = {n}: velika sprememba je lahko naključna)", { n: integer(shown.pricePerSqmSampleSize) })}</span>}{real != null && years === 1 && <> {t("(realno {change})", { change: percentSigned(real) })}</>}</> // i18n-ignore (code, not text)
            : current.pooled ? <> {t("(združeno {years}, ker je v izbranem obdobju premalo prodaj)", { years: count(current.pooled.years, NOUN_FORMS.leto) })}</> : null}.</>
          : current.sale.transactionCount === 0 ? t("{period} ni bilo evidentirane prodaje {noun}.", { period: capitalise(periodText), noun: noun.ofOne })
            : <>{tx("{period}: {sales} {noun} – premalo prodaj za mediano{wide}.", { period: capitalise(periodText), sales: count(current.sale.transactionCount, NOUN_FORMS.prodaja), noun: noun.genitive,
              wide: current.wide && current.wide.transactionCount > current.sale.transactionCount ? <> {t("(v zadnjih 5 letih {sales})", { sales: count(current.wide.transactionCount, NOUN_FORMS.prodaja) })}</> : null })}{/* i18n-ignore (code, not text) */}
              {" "}{t("Posamezne prodaje so spodaj.")}</>}
      {current.sale && price == null && <FewSales scopeId={scope.id} segment={segment} cutoff={cutoff}/>}
    </p>
    {street && <SalesList scopeId={scope.id} scopeName={scope.name} segment={segment} window={windows?.sales.current} noun={noun.genitive} linkArea={scope.id}
      street={street} onClearStreet={onClearStreet} fallback={windows ? { from: `${FIRST_SALE_YEAR}-01-01`, to: windows.sales.current.to } : undefined}/>}

    <nav className="jump" aria-label={t("Na tej strani")}>
      {[["sales-sale", t("Prodaje")], ...(group === "land" ? [] : [["rent-title", t("Najemi")]]), ["trend-title", t("Gibanje cen")], ...(isDwelling(group) ? [["afford-title", t("Dostopnost")]] : [])].map(([id, label]) =>
        <button key={id} type="button" onClick={() => jumpTo(document.getElementById(id), !prefersReducedMotion())}>{label}</button>)}
    </nav>
    <div className="type-pair" role="group" aria-label={t("Vrsta nepremičnine (izbira velja tudi za zemljevid)")}>
      {(["apartment", "house"] as const).map((item) => <TypeCard key={item} group={item} figures={figuresOf[item]}
        active={group === item} onClick={() => onGroup(item)} years={years}/>)}
      {(["land", "commercial", "garage"] as const).map((item) => <TypeCard key={item} group={item} figures={figuresOf[item]} compact
        // The land card names its use only once one is shown (chosen, or picked for this area); before that it is just "Land".
        label={item === "land" ? (group === "land" || landChosen ? t("Zemljišča ({use})", { use: LAND_SCOPES.find((entry) => entry.id === landScope)?.label.toLowerCase() ?? "" }) : NOUNS.land.label) : undefined}
        active={group === item} onClick={() => onGroup(item)} years={years}/>)}
    </div>
    {group === "land" && <div className="segmented small" role="group" aria-label={t("Raba zemljišča")}>
      <span className="segmented-label">{t("Raba zemljišča:")}</span>
      {LAND_SCOPES.map((item) => <button key={item.id} type="button" aria-pressed={landScope === item.id} onClick={() => onLandScope?.(item.id)}>{item.label}</button>)}
    </div>}
    {group === "land" && !landChosen && landAuto.data?.best === landScope && <p className="note muted">{t("Prikazana {use} zemljišča, ker je v tem območju največ teh prodaj.", { use: LAND_SCOPES.find((item) => item.id === landScope)?.label.toLowerCase() })}</p>}

    {bands && <div className="segmented small wrap" role="group" aria-label={t("Velikost (velja tudi za zemljevid)")}>
      <span className="segmented-label">{t("Velikost:")}</span>
      <button type="button" aria-pressed={!band} onClick={() => onSize?.(undefined)}>{ALL_SIZES.label}</button>
      {bands.map((item) => <button key={item.id} type="button" aria-pressed={band?.id === item.id} onClick={() => onSize?.(item.id)}>{item.label}</button>)}
    </div>}
    {!street && <SalesList scopeId={scope.id} scopeName={scope.name} segment={segment} window={windows?.sales.current} noun={noun.genitive} linkArea={scope.id}
      fallback={cutoff && !windows?.custom ? periodWindows(cutoff, POOLED_YEARS).sales.current : undefined}/>}

    {isDwelling(group) && <Affordability scope={scope} parents={parents} area={area} parentData={parentData} group={group}/>}

    <Trend scope={scope} parents={[...parents, ...extra]} parentData={[...parentData, ...[extraA, extraB].slice(0, extra.length)]} compared={extra.length} area={area.prices} group={group}/>

    {group !== "land" && <RentSection key={group} scope={scope} parent={parents[0]} group={group} band={band} cutoff={cutoff} years={years} salePerSqm={price}/>}


    {subRanking && subRanking.length > 0 && <details className="module" open>
      <summary>{t("Podrejena območja: {label}", { label: subRanking[0].label })}</summary>
      <Ranking items={subRanking} onSelect={onSubArea} current={scope.id}/>
    </details>}

    {ranking && ranking.length > 0 && <details className="module" open={scope.level === "municipality" && !subRanking?.length}>
      <summary>{t("Lestvica: {label}", { label: ranking[0].label })}</summary>
      <Ranking items={ranking} onSelect={onSubArea} current={scope.id}/>
    </details>}

    <details className="module" open={extra.length > 0}>
      <summary>{tx("Primerjava: {areas}", { areas: [scope, ...parents, ...extra].map((item, index) => <span key={`${item.name}${index}`}>{index ? ", " : ""}{areaName(item)}</span>) })}</summary>
      <div className="card-actions">
        {extra.length < 2 && (adding
          ? <AreaSearch compact regions={regions} municipalities={municipalities} districts={districts} label={t("Primerjaj z")} placeholder={t("vpišite občino, četrtno skupnost ali regijo")}
            includeAddresses={false} includeCountry={false}
            onArea={(option) => { setAdding(false); if (option.id && option.id !== scope.id && !extra.some((item) => item.id === option.id)) setExtra([...extra, { id: option.id, name: option.name, level: option.level }]); }}/>
          : <button type="button" className="ghost" onClick={() => setAdding(true)}>{t("+ Primerjaj z …")}</button>)}
        {windows && <Cite scope={scope} noun={noun} windows={windows} columns={[{ scope, data: area }, ...parents.map((item, index) => ({ scope: item, data: parentData[index] }))]}/>}
      </div>
      <CompareTable columns={[{ scope, data: area }, ...parents.map((item, index) => ({ scope: item, data: parentData[index] })),
        ...extra.map((item, index) => ({ scope: item, data: [extraA, extraB][index] }))]} noun={noun}
        band={band ?? ALL_SIZES} removable={extra.length > 0}
        onRemove={(id) => setExtra(extra.filter((item) => item.id !== id))}/>
    </details>

    <SpreadModule scope={scope} segment={segment} cutoff={cutoff} years={years} noun={noun.genitive}/>

    {group !== "land" && <details className="module">
      <summary>{t("Prebivalci in stanovanjski fond")}</summary>
      <Population data={area.demographics} name={scope.name} municipalityId={scope.level === "municipality" ? scope.id : undefined} failed={area.failed ? area.retry : undefined}/>
      <Housing data={area.demographics} failed={area.failed ? area.retry : undefined}/>
    </details>}

    {group !== "land" && <NewSupply scope={scope} cutoff={cutoff}/>}

    <p className="panel-source">{tx("Mediana šteje le {term} in je objavljena od {min} poslov.", { term: <Term text={GLOSSARY.reprezentativni}>{t("reprezentativne posle")}</Term>, min: MIN_SAMPLE })} <a href={`#${ABOUT}`}>{t("O podatkih")}</a></p>{/* i18n-ignore (code, not text) */}
  </article>;
}

/** One rule on every card without a median: sales in the chosen period, then in five years. */
function thinCounts(period: number, fiveYears?: number) {
  const inPeriod = t("{count} v izbranem obdobju", { count: count(period, NOUN_FORMS.prodaja) });
  return fiveYears != null && fiveYears > period ? `${inPeriod} · ${t("{count} v 5 letih", { count: integer(fiveYears) })}` : inPeriod;
}

function TypeCard({ group, figures, active, onClick, years, compact = false, label }: { group: PropertyGroup; figures: TypeFigures; active: boolean; onClick: () => void; years: Period; compact?: boolean; label?: string }) {
  const noun = NOUNS[group];
  const sale = figures.sale;
  const shown = sale?.isPublishable ? sale : figures.pooled?.sale;
  const price = publishedPrice(shown);
  const yoy = sale?.isPublishable ? change(price, publishedPrice(figures.previous)) : null;
  const percentiles = figures.spread?.isPublishable ? figures.spread.percentiles : undefined;
  if (compact) return <button type="button" className={active ? "type-card compact active" : "type-card compact"} aria-pressed={active} onClick={onClick}>
    <span className="type-name">{label ?? noun.label}</span>
    <span className="type-value small">{!sale ? (figures.failed ? "—" : loadingText()) : price == null ? withheld("sale", sale.transactionCount) : `${perSqm(price)}${NBSP}€/m²`}</span>
    {sale && price == null ? <span className="type-meta">{thinCounts(sale.transactionCount, figures.wide?.transactionCount)}</span>
    : sale && <span className="type-meta">{figures.pooled ? t("{sales} v {years} letih", { sales: count(figures.pooled.sale.transactionCount, NOUN_FORMS.prodaja), years: figures.pooled.years })
      : count(sale.transactionCount, NOUN_FORMS.prodaja)}{yoy != null ? `, ${percentSigned(yoy)}` : ""}</span>}
    {group === "garage" && shown?.medianPrice != null && <span className="type-meta">{noun.typical} {euro(Math.round(shown.medianPrice / 500) * 500)}</span>}
  </button>;
  return <button type="button" className={active ? "type-card active" : "type-card"} aria-pressed={active} onClick={onClick}>
    <span className="type-name">{noun.label}</span>
    {!sale ? <span className="muted">{figures.failed ? "—" : t("Nalagam\u00a0…")}</span> : price == null ? <>{/* i18n-ignore (code, not text) */}
      <span className="type-value muted">{withheld("sale", sale.transactionCount)}</span>
      <span className="type-meta">{thinCounts(sale.transactionCount, figures.wide?.transactionCount)}{sale.transactionCount > 0 && sale.transactionCount < LIST_INSTEAD ? `; ${t("posamezne spodaj")}` : ""}</span>
    </> : <>
      <span className="type-value">{integer(price)}{NBSP}€/m²</span>
      <span className="type-meta">{shown?.pricePerSqmSampleSize != null ? t("iz {n} primerljivih prodaj", { n: integer(shown.pricePerSqmSampleSize) }) : ""}
        {figures.pooled ? `, ${t("združeno {years}", { years: count(figures.pooled.years, NOUN_FORMS.leto) })}` : typeof years === "string" ? `, ${years.replace("-", "–")}` : years > 1 ? `, ${count(years, NOUN_FORMS.leto)}` : ""}{yoy != null && <>, {percentSigned(yoy)}</>}</span>
      {percentiles?.p25 != null && percentiles.p50 != null && percentiles.p75 != null && <RangeBar p25={percentiles.p25} p50={percentiles.p50} p75={percentiles.p75}
        min={percentiles.p05 ?? percentiles.p25 * 0.7} max={percentiles.p95 ?? percentiles.p75 * 1.3} unit="€/m²" label={t("Razpon cen {noun}", { noun: noun.genitive })}/>}
      {shown?.medianPrice != null && <span className="type-meta">{t("Tipičen posel {price}", { price: euro(shown.medianPrice) })}{shown.medianArea != null ? `, ${withUnit(decimal1(shown.medianArea), "m²")}` : ""}</span>}
    </>}
  </button>;
}

const SPANS = [{ id: 5, label: count(5, NOUN_FORMS.leto) }, { id: 10, label: count(10, NOUN_FORMS.leto) }, { id: 99, label: ALL_SIZES.label }] as const;

function Trend({ scope, parents, parentData, area, group, compared = 0 }: {
  scope: Scope; parents: Scope[]; parentData: Array<{ prices?: TimePoint[] }>; area?: TimePoint[]; group: PropertyGroup;
  /** The last `compared` entries of parents are areas the user added for comparison (drawn in colour, not grey). */
  compared?: number;
}) {
  const [span, setSpan] = useState<number>(10);
  const [table, setTable] = useState(false);
  // The area in the price hue; its region and Slovenia as grey references told apart by their dash; added areas in s2/s3.
  const reference = (item: Scope): SeriesStyle => item.level === "country" ? "ref-country" : "ref-region";
  const series = [{ scope, prices: area, className: "c-price" as SeriesStyle }, ...parents.map((item, index) => ({ scope: item, prices: parentData[index]?.prices,
    className: index >= parents.length - compared ? (index === parents.length - compared ? "s2" : "s3") as SeriesStyle : reference(item) }))];
  const points = (prices?: TimePoint[]) => (Array.isArray(prices) ? prices : []).filter((point) => !point.incomplete)
    .map((point) => ({ x: Number(point.period.slice(0, 4)), y: point.isPublishable ? point.medianPricePerSqm ?? null : null }));
  const last = Math.max(0, ...series.flatMap((item) => points(item.prices).map((point) => point.x)));
  const visible = series.map((item) => ({ name: item.scope.name, className: item.className, points: points(item.prices).filter((point) => point.x > last - span) }));
  const own = visible[0].points.flatMap((point) => point.y == null ? [] : [{ x: point.x, y: point.y }]);
  const firstOwn = own[0], lastOwn = own.at(-1);
  const finding = firstOwn && lastOwn && own.length > 1 ? tx("{area}: {change} od leta {year}", { area: areaName(scope), change: percentSigned(lastOwn.y / firstOwn.y - 1), year: firstOwn.x })
    : t("Mediana cene {noun} po letih", { noun: NOUNS[group].genitive });
  return <section className="module open" aria-labelledby="trend-title">
    <div className="module-head">
      <h2 id="trend-title">{finding}</h2>
      <div className="segmented small" role="group" aria-label={t("Razpon grafa")}>
        {SPANS.map((item) => <button key={item.id} type="button" aria-pressed={span === item.id} onClick={() => setSpan(item.id)}>{item.label}</button>)}
        <button type="button" aria-pressed={table} onClick={() => setTable(!table)}>{t("Tabela")}</button>
      </div>
    </div>
    {table ? <div className="table-scroll" tabIndex={0} role="region" aria-label={t("Mediana €/m² po letih")}><table className="compact-table">
      <caption className="sr-only">{t("Mediana €/m² po letih")}</caption>
      <thead><tr><th scope="col">{t("Leto")}</th>{visible.map((item, index) => <th key={index} scope="col">{item.name}</th>)}</tr></thead>
      <tbody>{[...new Set(visible.flatMap((item) => item.points.map((point) => point.x)))].sort((a, b) => b - a).map((year) => <tr key={year}>
        <th scope="row">{year}</th>{visible.map((item, index) => { const value = item.points.find((point) => point.x === year)?.y; return <td key={index}>{value == null ? "—" : integer(value)}</td>; })}
      </tr>)}</tbody></table></div> // i18n-ignore (code, not text)
      : area === undefined ? <div className="chart-placeholder" style={{ height: 230 }} aria-hidden="true"/>
      : <LineChart unit="€/m²" label={t("Mediana €/m² po letih: {areas}", { areas: visible.map((item) => item.name).join(", ") })} series={visible} height={200}/>}
    <p className="note muted">{t("{type}, €/m², nominalno; sivo nadrejena območja.", { type: NOUNS[group].label })} {t("Tekoče leto ni prikazano, ker ni zaključeno.")}</p>
  </section>;
}

function Affordability({ scope, parents, area, parentData, group }: {
  scope: Scope; parents: Scope[]; area: ReturnType<typeof useArea>; parentData: Array<ReturnType<typeof useArea>>; group: "apartment" | "house"; // i18n-ignore (code, not text)
}) {
  const [own, setOwn] = useState(false);
  const yearsOfSalary = (data: ReturnType<typeof useArea>) => {
    const wage = data.affordability?.rows?.find((row) => row.band.id === "p50")?.band.netMonthlyIncome;
    const sale = data.sale?.isPublishable ? data.sale : data.fallback?.sale;
    const price = sale?.medianPrice ?? null;
    return wage && price ? price / (wage * 12) : null;
  };
  const items = [{ name: scope.name, value: yearsOfSalary(area), current: true }, ...parents.map((item, index) => ({ name: item.name, value: yearsOfSalary(parentData[index]) }))]
    .filter((item): item is { name: string; value: number; current?: boolean } => item.value != null);
  const mine = items.find((item) => item.current);
  const sale = area.sale?.isPublishable ? area.sale : area.fallback?.sale;
  const fixed = area.affordability?.rates?.fixedOver10Years;
  const ltv = area.affordability?.rule?.recommendedLtv ?? 0.8;
  const rent = publishedRent(area.rent);
  const noun = NOUNS[group];
  return <section className="module open" aria-labelledby="afford-title">
    <h2 id="afford-title">{mine && sale?.medianPrice != null ? t("{typical} ({price}) stane {years} let neto mediane plače", { typical: noun.typical, price: euro(Math.round(sale.medianPrice / 1000) * 1000), years: decimal1(mine.value) }) : t("Dostopnost")}</h2>
    {items.length > 0 && <ScaleStrip items={items} unit={t("let neto plače")} label={t("Leta neto mediane plače za tipičen posel")}/>}
    {sale?.medianPrice != null && fixed && <dl className="cost-cards">
      <div><dt>{t("Lastna sredstva ({share} %)", { share: Math.round((1 - ltv) * 100) })}</dt><dd>{euro(Math.round(sale.medianPrice * (1 - ltv) / 1000) * 1000)}</dd></div>
      <div><dt>{t("Obrok na mesec, 30 let")}</dt><dd>{euro(Math.round(instalment(sale.medianPrice * ltv, fixed.value, 30) / 10) * 10)}</dd>
        <dd className="tile-note"><small>{t("fiksno {rate} %", { rate: decimal1(fixed.value) })}</small></dd></div>
      <div><dt>{t("Najem na mesec")}</dt><dd>{rent != null && sale.medianArea != null ? euro(Math.round(rent * sale.medianArea / 10) * 10) : <Missing/>}</dd>
        {sale.medianArea != null && <dd className="tile-note"><small>{withUnit(decimal1(sale.medianArea), "m²")}</small></dd>}</div>
    </dl>}
    <p className="note muted">{sale?.medianPrice != null ? `${t("Tipičen posel je mediana cene {price}{pooled}.", { price: euro(sale.medianPrice),
      pooled: area.fallback && !area.sale?.isPublishable ? ` (${t("združeno {years}", { years: count(area.fallback.years, NOUN_FORMS.leto) })})` : "" })} ` : area.sale === undefined || area.fallback === undefined ? (area.failed ? "" : `${t("Nalagam\u00a0…")} `) : `${t("Za to območje ni objavljive mediane cene.")} `}
      {t("Plača: SURS, neto mediana{scope}.", { scope: area.affordability?.wageGeography?.nationalFallback ? ` ${t("za Slovenijo")}` : "" })}</p>
    <button type="button" className="ghost" aria-expanded={own} onClick={() => setOwn(!own)}>{own ? t("Skrij izračun") : t("Izračunajte za svojo plačo")}</button>
    {own && <Calculator scope={scope} group={group} data={area} noun={noun} columns={parents.map((item, index) => ({ scope: item, data: parentData[index] }))}/>}
  </section>;
}

function Ranking({ items, onSelect, current }: { items: RankItem[]; onSelect?: (id: number) => void; current?: number }) {
  const [descending, setDescending] = useState(true);
  // Values of the selected period first; pooled (3/5-year) values are a separate, labelled group.
  type Published = RankItem & { value: number };
  const order = (a: Published, b: Published) => (a.pooled ? 1 : 0) - (b.pooled ? 1 : 0) || (descending ? b.value - a.value : a.value - b.value);
  const published = items.filter((item): item is Published => item.value != null).sort(order);
  const withheld = items.length - published.length;
  return <>
    <div className="segmented small" role="group" aria-label={t("Razvrsti")}>
      <button type="button" aria-pressed={descending} onClick={() => setDescending(true)}>{t("Najvišje")}</button>
      <button type="button" aria-pressed={!descending} onClick={() => setDescending(false)}>{t("Najnižje")}</button>
    </div>
    <ol className="ranking-list">{published.slice(0, current ? published.length : 15).map((item, index) => <li key={item.id} aria-current={item.id === current ? "true" : undefined}>
      <span className="rank">{index + 1}.</span>
      <button type="button" className="link" onClick={() => onSelect?.(item.id)}><Name>{item.name}</Name></button>
      <span className="rank-value">{item.format(item.value)}</span><span className="cell-note">{item.populationSample ? "" : `n = ${integer(item.sample)}`}{item.pooled ? `, ${t("združeno {years}", { years: count(item.pooled, NOUN_FORMS.leto) })}` : ""}</span></li>)}</ol>
    {withheld > 0 && <details className="withheld">
      <summary>{t("{areas} z manj kot {min} posli (brez mediane)", { areas: count(withheld, items[0]?.unit ?? NOUN_FORMS.občina), min: MIN_SAMPLE })}</summary>
      <ul className="withheld-list">{items.filter((item) => item.value == null).sort((a, b) => b.sample - a.sample || a.name.localeCompare(b.name, "sl")).map((item) => // i18n-ignore (Slovenian collation of register names)
        <li key={item.id} aria-current={item.id === current ? "true" : undefined}>
          <button type="button" className="link" onClick={() => onSelect?.(item.id)}><Name>{item.name}</Name></button>
          <span className="cell-note">{item.sample ? `n = ${integer(item.sample)}` : t("ni poslov")}</span></li>)}</ul>
    </details>}
  </>;
}

function SpreadModule({ scope, segment, cutoff, years, noun }: { scope: Scope; segment: Segment; cutoff?: string; years: Period; noun: string }) {
  const [open, setOpen] = useState(false);
  const spread = useLoad(open && cutoff ? { cutoff, id: scope.id, segment, years } : null, (input) => `spread|${input.id ?? 0}|${JSON.stringify(input.segment)}|${input.cutoff}|${input.years}|module`,
    (input, signal) => loadSpread(input.id, periodWindows(input.cutoff, input.years).sales.current, input.segment, "sale", signal));
  return <details className="module" onToggle={(event) => setOpen((event.target as HTMLDetailsElement).open)}>
    <summary>{t("Porazdelitev cen {noun}", { noun })}</summary>
    {open && <LoadState load={spread}>{(data) => !data.isPublishable ? <p className="note muted">{t("Premalo prodaj za graf.")}</p> // i18n-ignore (code, not text)
      : <Histogram unit="€/m²" label={t("Porazdelitev cen {noun}, {area}", { noun, area: scope.name })} open={{ below: data.belowBoundCount > 0, above: data.aboveBoundCount > 0 }}
        buckets={data.buckets.map((bucket) => ({ lower: bucket.from, upper: bucket.to, count: bucket.count }))}/>}</LoadState>}
  </details>;
}

function NewSupply({ scope, cutoff }: { scope: Scope; cutoff?: string }) {
  const [open, setOpen] = useState(false);
  const summary = useLoad(open && cutoff ? { cutoff, id: scope.id } : null, (input) => `construction|${input.id ?? 0}|${input.cutoff}`,
    (input, signal) => loadAreaConstruction(input.id, Number(input.cutoff.slice(0, 4)) - 1, signal));
  return <details className="module" onToggle={(event) => setOpen((event.target as HTMLDetailsElement).open)}>
    <summary>{t("Nova gradnja")}</summary>
    {summary.error ? <LoadFailed retry={summary.retry}/> : <Construction summary={summary.data} name={scope.level === "municipality" ? t("za občino {name}", { name: scope.name }) : scope.level === "country" ? t("za Slovenijo") : scope.level === "statistical_region" ? t("za občine regije {name}", { name: scope.name }) : t("za občino, v kateri leži {name}", { name: scope.name })} cutoff={cutoff}/>}
  </details>;
}

/** Copy the link of exactly this view (area, type, size, period, layer) to share or bookmark: an icon button by the title. */
function ShareLink() {
  const [done, setDone] = useState(false);
  // The toast's timer: cleared on the next click and on unmount, so it never sets state on a gone component.
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);
  const label = t("Kopiraj povezavo");
  return <span className="share">
    <button type="button" className="share-link" aria-label={label} title={label} onClick={() => {
      const url = window.location.href;
      const finish = () => { setDone(true); clearTimeout(timer.current); timer.current = setTimeout(() => setDone(false), TOAST_MS); };
      if (typeof navigator.share === "function" && hasCoarsePointer()) navigator.share({ url, title: document.title }).catch(() => undefined);
      else void navigator.clipboard.writeText(url).then(finish).catch(() => undefined);
    }}>
      <svg aria-hidden="true" viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <path d="M10 13a5 5 0 0 0 7.07 0l3-3a5 5 0 0 0-7.07-7.07l-1.5 1.5"/>
        <path d="M14 11a5 5 0 0 0-7.07 0l-3 3a5 5 0 0 0 7.07 7.07l1.5-1.5"/>
      </svg>
    </button>
    <span className="share-toast" role="status">{done ? <>{t("Povezava kopirana")} <span aria-hidden="true">✓</span></> : ""}</span>
  </span>;
}
