import { useEffect, useMemo, useState } from "react";
import { api, lastCompleteYear, loadAreaAffordability, loadAreaLists, loadGeography, loadMetric, loadRentOverview, loadSaleOverview, marketWindows, periodWindows, shiftWindow } from "../api";
import { AreaSearch } from "../components/AreaSearch";
import { Bars, Columns, Histogram, LineChart, Sparkline } from "../components/charts";
import { LoadFailed } from "../components/LoadState";
import { change, decimal1, euro, integer, percent, upTo1 } from "../format";
import { useLoad } from "../hooks/useLoad";
import { Name, t, tx } from "../i18n";
import { NOUNS } from "../nouns";
import { pool, type AreaValue } from "../pooling";
import { areaHref, overviewHref, overviewState, replaceHash, trendsHref } from "../url-state";

type Group = "apartment" | "house";
/** The home a typical household looks for: the floor area the affordability tile prices. */
const TYPICAL_AREA: Record<Group, number> = { apartment: 60, house: 120 };
/** Municipalities shown at each end of the price ranking. */
const SHOWN = 8;

const yearOf = (period: string) => Number(period.slice(0, 4));

/**
 * "Pregled trga": the market in four numbers and five charts, for Slovenia or one area, flats or houses.
 * Every figure is from concluded sales (GURS ETN) over the lag-aware periods the explorer uses, so the two pages agree.
 */
export function OverviewView({ cutoff }: { cutoff?: string }) {
  const [initial] = useState(() => overviewState());
  const [areaId, setAreaId] = useState<number | undefined>(initial.g);
  const [group, setGroup] = useState<Group>(initial.group);
  // The address follows the choices (no history entries: Back leaves the page), and the view follows an edited address.
  const remember = (nextArea: number | undefined, nextGroup: Group) => replaceHash(overviewHref(nextArea, nextGroup === "house"));
  useEffect(() => {
    const follow = () => { const state = overviewState(); setAreaId(state.g); setGroup(state.group); };
    window.addEventListener("hashchange", follow);
    return () => window.removeEventListener("hashchange", follow);
  }, []);
  const lists = useLoad("area-lists", (signal) => loadAreaLists(signal));
  const regions = lists.data?.regions ?? [], municipalities = lists.data?.municipalities ?? [];
  const byId = useMemo(() => new Map([...(lists.data?.regions ?? []), ...(lists.data?.municipalities ?? [])].map((item) => [item.id, item])), [lists.data]);
  // A district or settlement (the explorer's area carried over) is not in the picker's lists: its name is looked up.
  const other = useLoad(areaId && lists.data && !byId.has(areaId) ? `geography-${areaId}` : null, (signal) => loadGeography(areaId!, signal));
  const area = areaId ? byId.get(areaId) ?? (other.data?.id === areaId ? other.data : undefined) : undefined;
  const areaName = area ? <Name>{area.name}</Name> : areaId ? "…" : t("Slovenija");
  const nouns = NOUNS[group];
  const segment = { propertyGroup: group };
  // The lag-aware periods the explorer uses, once per cutoff; without a data status the clock stands in.
  const base = cutoff ?? new Date().toISOString().slice(0, 10);
  const periods = useMemo(() => ({ ...marketWindows(base), wide: periodWindows(base, 5).sales.current, lastYear: lastCompleteYear(base), label: periodWindows(base, 1).label }), [base]);
  const sales = periods.sales.current, previousSales = periods.sales.previous;
  const rents = periods.rents.current, previousRents = periods.rents.previous, rentYear = periods.rents.year;
  const lastYear = periods.lastYear;
  const period = periods.label;
  const key = `${areaId ?? 0}|${group}|${base}`;

  // Headline numbers: this period against the one before.
  const headline = useLoad(`overview-head|${key}`, async (signal) => {
    const [sale, before, rent, rentBefore] = await Promise.all([
      loadSaleOverview(areaId, segment, sales, signal), loadSaleOverview(areaId, segment, previousSales, signal),
      loadRentOverview(areaId, segment, rents, signal), loadRentOverview(areaId, segment, previousRents, signal),
    ]);
    return { sale, before, rent, rentBefore };
  }, { keepPrevious: true });
  // Monthly sales over three years up to the data's end: the activity columns (the months past the lag-aware period are
  // still being reported and drawn lighter), and the tiles' sparklines from the last twelve complete months.
  const monthly = useLoad(`overview-monthly|${key}`, async (signal) =>
    (await api("/api/v1/statistics/timeseries", { query: { from: shiftWindow(sales, 24).from, to: base, propertyGroup: group, interval: "month", geographyId: areaId } }, signal)).items
      .map((point) => ({ ...point, incomplete: point.incomplete || point.period > sales.to })),
  { keepPrevious: true });
  // Ten complete years, the area against Slovenia (the result remembers whose it is: a previous area's lines never pose as the new one's).
  const trend = useLoad(`overview-trend|${key}`, async (signal) => {
    const query = { from: `${lastYear - 9}-01-01`, to: `${lastYear}-12-31`, propertyGroup: group, interval: "year" as const };
    const [own, country] = await Promise.all([
      areaId ? api("/api/v1/statistics/timeseries", { query: { ...query, geographyId: areaId } }, signal) : null,
      api("/api/v1/statistics/timeseries", { query }, signal),
    ]);
    return { areaId, own: own?.items ?? null, country: country.items };
  }, { keepPrevious: true });
  // Every municipality's median: the period's own with enough sales, else pooled over five years, else withheld.
  const ranking = useLoad(`overview-ranking|${group}|${base}`, async (signal) => {
    const [own, wide] = await Promise.all([
      loadMetric("salePrice", periods.sales.current, "municipality", signal, segment),
      loadMetric("salePrice", periods.wide, "municipality", signal, segment),
    ]);
    return pool(own, [{ years: 5, values: wide }]).filter((item) => item.value != null);
  }, { keepPrevious: true });
  // Rent against price per region: the explorer's gross-yield measure (both medians from at least 30 agreements).
  const regional = useLoad(`overview-regions|${group}|${base}`, async (signal) =>
    (await loadMetric("grossYield", sales, "statistical_region", signal, segment, rents)).filter((item) => item.value != null), { keepPrevious: true });
  const spread = useLoad(`overview-spread|${key}`, (signal) =>
    api("/api/v1/statistics/distribution", { query: { ...sales, propertyGroup: group, geographyId: areaId, metric: "price", bins: 24 } }, signal), { keepPrevious: true });
  const affordability = useLoad(`overview-afford|${areaId ?? 0}|${group}`, (signal) => loadAreaAffordability(areaId, group, signal), { keepPrevious: true });

  // ------------------------------------------------------------ the numbers
  const head = headline.data;
  const price = head?.sale.isPublishable ? head.sale.medianPricePerSqm ?? null : null;
  const priceChange = head?.before.isPublishable ? change(price, head.before.medianPricePerSqm) : null;
  const rentValue = head?.rent.isPublishable ? head.rent.medianMonthlyRentPerSqm ?? null : null;
  const rentChange = head?.rentBefore.isPublishable ? change(rentValue, head.rentBefore.medianMonthlyRentPerSqm) : null;
  const sold = head?.sale.transactionCount ?? null;
  const soldChange = change(sold, head?.before.transactionCount);
  const months = monthly.data ?? [];
  // The sparklines show the last twelve complete months (the columns below fade the ones still being reported).
  const recent = months.filter((point) => !point.incomplete).slice(-12);
  const wage = affordability.data?.rows?.find((row) => row.band.id === "p50")?.band.netMonthlyIncome;
  // The same median as the headline tile, so the two tiles never disagree on the period.
  const yearsOfWage = wage && price ? (TYPICAL_AREA[group] * price) / wage / 12 : null;
  const delta = (value: number | null) => value == null ? t("brez primerjave z letom prej") : t("{change} proti letu prej", { change: percent(value, { signed: true }) });

  const ranked = [...(ranking.data ?? [])].sort((a, b) => a.value! - b.value!); // cheapest first
  // The two ends never share a municipality: with few published ones the list is simply split in half.
  const half = Math.min(SHOWN, Math.ceil(ranked.length / 2));
  const cheapest = ranked.slice(0, half), dearest = ranked.slice(Math.max(half, ranked.length - SHOWN)).reverse();
  const rankMax = Math.max(1, ...ranked.map((item) => item.value!));
  const ownRank = areaId ? ranked.findIndex((item) => item.geographyId === areaId) : -1;
  // The rank is said from the nearer end: "3. najcenejša" in the cheaper half, "2. najdražja" in the dearer half.
  const rankText = ownRank < 0 ? null : ownRank < ranked.length / 2
    ? tx("{area} je {rank}. najcenejša od {total} občin z objavljeno mediano.", { area: areaName, rank: ownRank + 1, total: ranked.length })
    : tx("{area} je {rank}. najdražja od {total} občin z objavljeno mediano.", { area: areaName, rank: ranked.length - ownRank, total: ranked.length });
  const bar = (item: AreaValue) => ({
    key: item.geographyId, name: <Name>{byId.get(item.geographyId)?.name ?? ""}</Name>, value: item.value!, href: areaHref(item.geographyId),
    current: item.geographyId === areaId, pooled: !!item.pooled, note: item.pooled ? t("({years} let)", { years: item.pooled }) : undefined,
    title: `${byId.get(item.geographyId)?.name ?? ""}: ${integer(item.value!)} €/m², ${t("{count} prodaj", { count: integer(item.sample) })}`,
  });
  const yields = [...(regional.data ?? [])].sort((a, b) => b.value! - a.value!).map((item) => ({
    key: item.geographyId, name: <Name>{byId.get(item.geographyId)?.name ?? ""}</Name>, value: item.value!, current: item.geographyId === area?.parentId || item.geographyId === areaId,
    note: item.rent != null ? t("najem {rent} €/m²", { rent: decimal1(item.rent) }) : undefined,
    title: item.rent != null && item.price != null ? `${byId.get(item.geographyId)?.name ?? ""}: ${t("najemnina {rent} €/m² na mesec, cena {price} €/m²", { rent: decimal1(item.rent), price: integer(item.price) })}` : undefined,
  }));

  const complete = (items: Array<{ period: string; incomplete: boolean; isPublishable: boolean; medianPricePerSqm?: number | null }>) =>
    items.filter((point) => !point.incomplete).map((point) => ({ x: yearOf(point.period), y: point.isPublishable ? point.medianPricePerSqm ?? null : null }));
  const trendSeries = !trend.data ? [] : trend.data.own && trend.data.areaId === areaId && area
    ? [{ name: t("Slovenija"), className: "ref", points: complete(trend.data.country) }, { name: area.name, className: "accent", points: complete(trend.data.own) }]
    : [{ name: t("Slovenija"), className: "accent", points: complete(trend.data.country) }];

  const distribution = spread.data;
  const buckets = (distribution?.isPublishable ? distribution.buckets : []).map((bucket) => ({ lower: bucket.from, upper: bucket.to, count: bucket.count }));
  const quartiles = distribution?.isPublishable ? distribution.percentiles : null;
  // The caption names the quartiles only when all three are published.
  const percentiles = quartiles?.p25 != null && quartiles.p50 != null && quartiles.p75 != null ? { p25: quartiles.p25, p50: quartiles.p50, p75: quartiles.p75 } : null;
  const activity = months.map((point) => ({ period: point.period, value: point.transactionCount, incomplete: point.incomplete }));

  return <div className="view overview">
    <section className="controls" aria-label={t("Območje in vrsta nepremičnine")}>
      <AreaSearch compact regions={regions} municipalities={municipalities} label={t("Območje: {area}", { area: area?.name ?? (areaId ? "…" : t("Slovenija")) })} placeholder={t("vpišite občino ali regijo")}
        includeAddresses={false} onArea={(option) => { setAreaId(option.id); remember(option.id, group); }}/>
      <div className="segmented" role="group" aria-label={t("Vrsta nepremičnine")}>
        <button type="button" aria-pressed={group === "apartment"} onClick={() => { setGroup("apartment"); remember(areaId, "apartment"); }}>{t("Stanovanja")}</button>
        <button type="button" aria-pressed={group === "house"} onClick={() => { setGroup("house"); remember(areaId, "house"); }}>{t("Hiše")}</button>
      </div>
    </section>
    <h1 className="stage-title">{tx("Pregled trga: {area}", { area: areaName })}</h1>
    <p className="stage-sub">{t("{nouns} {period}. Vsaka številka je iz dejansko sklenjenih poslov (GURS ETN); primerjave so z enako dolgim obdobjem pred tem.", { nouns: nouns.label, period })}
      {" "}{t("Črtici v ploščicah cene in prodaj kažeta zadnjih 12 zaključenih mesecev.")}</p>

    {!!headline.error && <LoadFailed retry={headline.retry}>{t("Pregleda trenutno ni bilo mogoče naložiti (povezava ali strežnik).")}</LoadFailed>}
    <dl className={headline.loading ? "tiles overview-tiles dimmed" : "tiles overview-tiles"} aria-busy={headline.loading || undefined}>
      <div><dt>{t("Mediana cene")}</dt><dd>{price == null ? "—" : `${integer(price)} €/m²`}</dd>
        <small>{head ? delta(priceChange) : t("Nalagam …")}</small>
        <Sparkline points={recent.map((point) => point.isPublishable ? point.medianPricePerSqm ?? null : null)} label={t("Mediana cene po mesecih, zadnjih 12 mesecev")}/></div>
      <div><dt>{t("Mediana najemnine")}</dt><dd>{rentValue == null ? "—" : `${decimal1(rentValue)} €/m²`}</dd>
        <small>{rentYear ? `${t("na mesec, najemi leta {year}", { year: rentYear })} · ${head ? delta(rentChange) : t("Nalagam …")}` : ""}</small></div>
      <div><dt>{t("Prodaje v 12 mesecih")}</dt><dd>{sold == null ? "—" : integer(sold)}</dd>
        <small>{head ? delta(soldChange) : t("Nalagam …")}</small>
        <Sparkline points={recent.map((point) => point.transactionCount ?? null)} label={t("Prodaje po mesecih, zadnjih 12 mesecev")}/></div>
      <div><dt>{t("Leta neto plače za {area} m²", { area: TYPICAL_AREA[group] })}</dt><dd>{yearsOfWage == null ? "—" : t("{years} let", { years: upTo1(yearsOfWage) })}</dd>
        <small>{wage ? t("cela cena ob mediani neto plače {wage} € (SURS, {period})", { wage: integer(wage), period: affordability.data?.wagePeriod ?? "" }) : affordability.error ? t("ni bilo mogoče naložiti") : t("ni dovolj podatkov")}</small></div>
    </dl>
    {!!affordability.error && <LoadFailed retry={affordability.retry}>{t("Dostopnosti ni bilo mogoče naložiti.")}</LoadFailed>}

    <div className="overview-grid">
      <section className="card" aria-labelledby="ov-trend">
        <h2 id="ov-trend">{t("Gibanje cen, zadnjih 10 let")}</h2>
        <p className="muted">{t("Mediana €/m² po koledarskih letih; tekoče leto ni zaključeno in ni prikazano.")}{area ? ` ${t("Siva črta je Slovenija.")}` : ""}</p>
        {trend.error ? <LoadFailed retry={trend.retry}/> : <LineChart unit="€/m²" label={t("Mediana cene {nouns} po letih", { nouns: nouns.genitive })} series={trendSeries}/>}
        <p><a href={trendsHref(areaId)}>{t("Več v Trendih →")}</a></p>
      </section>
      <section className="card" aria-labelledby="ov-rank">
        <h2 id="ov-rank">{t("Najcenejše in najdražje občine")}</h2>
        <p className="muted">{t("Mediana €/m² {period}; občine z manj kot 30 prodajami so združene čez 5 let (svetlejše) ali izpuščene.", { period })} {t("Oba seznama sta na isti lestvici.")}
          {rankText ? <> {rankText}</> : null}</p>
        {ranking.error ? <LoadFailed retry={ranking.retry}/> : <div className="bars-pair">
          <div><h3>{t("Najcenejše")}</h3><Bars items={cheapest.map(bar)} label={t("Najcenejše občine")} format={(value) => `${integer(value)} €/m²`} max={rankMax}/></div>
          <div><h3>{t("Najdražje")}</h3><Bars items={dearest.map(bar)} label={t("Najdražje občine")} format={(value) => `${integer(value)} €/m²`} max={rankMax}/></div>
        </div>}
      </section>
      <section className="card" aria-labelledby="ov-yield">
        <h2 id="ov-yield">{t("Najem proti nakupu po regijah")}</h2>
        <p className="muted">{t("Bruto donos: letna mediana najemnine deljena z mediano cene, brez stroškov in praznih mesecev. {nouns}, najemi leta {year}.", { nouns: nouns.label, year: rentYear ?? "" })} {t("Regije s premalo najemi ali prodajami so izpuščene.")}</p>
        {regional.error ? <LoadFailed retry={regional.retry}/> : <Bars items={yields} label={t("Bruto donos po regijah")} format={(value) => percent(value / 100)}/>}
      </section>
      <section className="card" aria-labelledby="ov-spread">
        <h2 id="ov-spread">{t("Za koliko so se prodajali")}</h2>
        <p className="muted">{percentiles ? t("Skupna cena posla; polovica prodaj med {p25} in {p75}, mediana {p50}.", { p25: euro(percentiles.p25), p75: euro(percentiles.p75), p50: euro(percentiles.p50) })
          : t("Skupna cena posla, reprezentativne prodaje {period}.", { period })}
          {distribution?.isPublishable && (distribution.belowBoundCount > 0 || distribution.aboveBoundCount > 0)
            ? ` ${t("Prvi in zadnji stolpec zajemata tudi {below} cenejših in {above} dražjih prodaj zunaj prikazanega razpona.", { below: integer(distribution.belowBoundCount), above: integer(distribution.aboveBoundCount) })}` : ""}</p>
        {spread.error ? <LoadFailed retry={spread.retry}/> : <Histogram unit="€" format={euro} label={t("Porazdelitev cen poslov, {nouns}", { nouns: nouns.label })} buckets={buckets}
          marker={percentiles ? { value: percentiles.p50, name: t("mediana {value}", { value: euro(percentiles.p50) }) } : undefined}/>}
      </section>
      <section className="card wide" aria-labelledby="ov-activity">
        <h2 id="ov-activity">{t("Prodaje po mesecih, zadnja 3 leta")}</h2>
        <p className="muted">{t("Število evidentiranih prodaj na mesec; zadnji meseci se še dopolnjujejo (svetlejši stolpci).")}</p>
        {monthly.error ? <LoadFailed retry={monthly.retry}/> : <Columns items={activity} unit={t("prodaj")} label={t("Prodaje {nouns} po mesecih", { nouns: nouns.genitive })}/>}
      </section>
    </div>
  </div>;
}
