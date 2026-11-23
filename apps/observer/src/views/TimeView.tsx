import { useEffect, useMemo, useState, type ReactNode } from "react";
import {
  api, loadGeography, loadIndices, loadInflation, loadInflationFactor, loadRegions, loadRentalTimeSeries, loadTimeSeries,
  type Geography, type MarketIndex, type RentalTimePoint, type TimePoint,
} from "../api";
import { LineChart } from "../components/charts";
import { LoadFailed } from "../components/LoadState";
import { useLoad } from "../hooks/useLoad";
import { decimal1, integer, month } from "../format";
import { Name, t, tx } from "../i18n";
import { NOUNS, ROOMS_GENITIVE } from "../nouns";
import { trendsArea } from "../url-state";

type IndexGroup = MarketIndex["propertyGroup"];
/** Property groups for which /api/v1/indices publishes a national series (land: sales only; rooms: rentals only). */
const INDEX_GROUPS: Array<{ id: IndexGroup; label: string; noun: string }> = [
  { id: "apartment", label: t("Stanovanja"), noun: NOUNS.apartment.genitive },
  { id: "house", label: t("Hiše"), noun: NOUNS.house.genitive },
  { id: "commercial", label: t("Poslovni prostori"), noun: NOUNS.commercial.genitive },
  { id: "garage", label: t("Garaže"), noun: NOUNS.garage.genitive },
  { id: "land", label: t("Zemljišča"), noun: NOUNS.land.genitive },
  { id: "room", label: t("Sobe"), noun: ROOMS_GENITIVE },
];
interface GroupIndices { sale: MarketIndex[]; rent: MarketIndex[] }
const loadGroupIndices = async (propertyGroup: IndexGroup, signal: AbortSignal): Promise<GroupIndices> => {
  if (propertyGroup === "apartment") {
    const [sale, rent] = await Promise.all([loadIndices(signal), loadIndices(signal, "rent")]);
    return { sale: sale.items, rent: rent.items };
  }
  const [sale, rent] = await Promise.all((["sale", "rent"] as const).map((transactionKind) =>
    api("/api/v1/indices", { query: { transactionKind, propertyGroup } }, signal)));
  return { sale: sale.items, rent: rent.items };
};

type Measure = "sale" | "rent" | "volume";
const MEASURES: Array<{ id: Measure; label: string; unit: string; digits: number }> = [
  { id: "sale", label: t("Mediana cene stanovanj"), unit: "€/m²", digits: 0 },
  { id: "rent", label: t("Mediana najemnine stanovanj"), unit: t("€/m² mesečno"), digits: 1 },
  { id: "volume", label: t("Število prodaj stanovanj"), unit: t("prodaj"), digits: 0 },
];
const year = (period: string) => Number(period.slice(0, 4));

interface RegionSeries { region: Geography; sales: TimePoint[]; rentals: RentalTimePoint[] }
interface AreaSeries { area: Geography; sales: TimePoint[]; rentals: RentalTimePoint[] }

const value = (measure: Measure, sale?: TimePoint, rent?: RentalTimePoint) => measure === "volume" ? sale?.transactionCount ?? null
  : measure === "sale" ? (sale?.isPublishable ? sale.medianPricePerSqm ?? null : null)
    : (rent?.isPublishable ? rent.medianMonthlyRentPerSqm ?? null : null);

/** Prices over time: twelve regional small multiples on one scale with Slovenia as the reference line. */
export function TimeView({ cutoff, tabs }: { cutoff: string; tabs?: ReactNode }) {
  // The year the data reaches: it is not complete yet.
  const THIS_YEAR = Number(cutoff.slice(0, 4));
  const [indexGroup, setIndexGroup] = useState<IndexGroup>("apartment");
  const [measure, setMeasure] = useState<Measure>("sale");
  // The area the user came from (#trendi?g=…): its own line against Slovenia above the regions; an edited address is followed.
  const [areaId, setAreaId] = useState(() => trendsArea());
  useEffect(() => {
    const follow = () => setAreaId(trendsArea());
    window.addEventListener("hashchange", follow);
    return () => window.removeEventListener("hashchange", follow);
  }, []);
  const own = useLoad(areaId ?? null, (id) => `trend-area-${id}`, async (id, signal): Promise<AreaSeries> => {
    const [area, sales, rentals] = await Promise.all([loadGeography(id, signal), loadTimeSeries(id, signal), loadRentalTimeSeries(id, signal)]);
    return { area, sales: sales.items, rentals: rentals.items };
  }).data;
  const regional = useLoad("trend-regions", async (signal): Promise<RegionSeries[]> => {
    const regions = [...(await loadRegions(signal)).items].sort((a, b) => a.name.localeCompare(b.name, "sl"));
    return Promise.all(regions.map(async (region) => {
      const [sales, rentals] = await Promise.all([loadTimeSeries(region.id, signal), loadRentalTimeSeries(region.id, signal)]);
      return { region, sales: sales.items, rentals: rentals.items };
    }));
  });
  const series = useMemo(() => regional.data ?? [], [regional.data]);
  const national = useLoad("trend-national", async (signal) => (await loadTimeSeries(undefined, signal)).items).data ?? [];
  const nationalRent = useLoad("trend-national-rent", async (signal) => (await loadRentalTimeSeries(undefined, signal)).items).data ?? [];
  const inflation = useLoad("trend-inflation", async (signal) => (await loadInflation(signal)).items).data ?? [];
  // Index series per property group, loaded when first chosen (switching back is answered from the API cache).
  const indexLoad = useLoad(indexGroup, (group) => `indices-${group}`, (group, signal) => loadGroupIndices(group, signal));
  // Real prices: SURS CPI factor from January of each year to January of the current year.
  const nationalYears = [...new Set(national.map((point) => year(point.period)))].filter((item) => item < THIS_YEAR).join(","); // i18n-ignore (comparison, not JSX text)
  const factors = useLoad(nationalYears ? { years: nationalYears, to: THIS_YEAR } : null, (input) => `factors|${input.years}|${input.to}`, async (input, signal) => {
    const results = await Promise.allSettled(input.years.split(",").map(Number).map((item) => loadInflationFactor(item, `${input.to}-01-01`, signal).then((result) => [item, result.factor] as const)));
    return new Map(results.flatMap((result) => result.status === "fulfilled" ? [result.value] : []));
  }).data ?? new Map<number, number>();

  const years = useMemo(() => [...new Set(series.flatMap((item) => item.sales.map((point) => year(point.period))))].sort((a, b) => a - b), [series]);
  const definition = MEASURES.find((item) => item.id === measure) ?? MEASURES[0];
  // Complete years only in the charts; the table marks the current year.
  const complete = years.filter((item) => item < THIS_YEAR); // i18n-ignore (comparison, not JSX text)
  const reference = complete.map((item) => ({ x: item, y: value(measure, national.find((point) => year(point.period) === item),
    nationalRent.find((point) => year(point.period) === item)) }));
  const panels = series.map((item) => ({ region: item.region, points: complete.map((entry) => ({ x: entry,
    y: value(measure, item.sales.find((point) => year(point.period) === entry), item.rentals.find((point) => year(point.period) === entry)) })) }));
  const shared = Math.max(0, ...panels.flatMap((panel) => panel.points.map((point) => point.y ?? 0)),
    ...(measure === "volume" ? [] : reference.map((point) => point.y ?? 0)));

  const nominal = national.flatMap((point) => point.isPublishable && point.medianPricePerSqm != null && !point.incomplete
    ? [{ x: year(point.period), y: point.medianPricePerSqm }] : []);
  const real = nominal.map((point) => { const factor = factors.get(point.x); return { x: point.x, y: factor != null ? point.y * factor : null }; });
  const toX = (item: MarketIndex) => Number(item.period.slice(0, 4)) + (Number(item.period.slice(5, 7)) - 1) / 12;
  const indices = indexLoad.data?.sale ?? [];
  const rentIndices = indexLoad.data?.rent ?? [];
  const groupDefinition = INDEX_GROUPS.find((item) => item.id === indexGroup) ?? INDEX_GROUPS[0];
  const pick = (items: MarketIndex[], method: MarketIndex["method"]) => items.filter((item) => item.method === method && item.isPublishable)
    .map((item) => ({ x: toX(item), y: item.indexValue }));
  const indexSeries = [
    { name: t("Cene, hedonski indeks"), className: "c-price", points: pick(indices, "hedonic") },
    { name: t("Cene, ponovne prodaje"), className: "c-price-alt", points: pick(indices, "matched_pair_median") }, // i18n-ignore (API method id)
    { name: t("Najemnine, hedonski indeks"), className: "c-rent", points: pick(rentIndices, "hedonic") },
  ].filter((item) => item.points.length);
  const base = (items: MarketIndex[], method: MarketIndex["method"]) => items.find((item) => item.method === method)?.basePeriod?.slice(0, 4);
  const salesBase = base(indices, "hedonic"), resalesBase = base(indices, "matched_pair_median"), rentBase = base(rentIndices, "hedonic"); // i18n-ignore (API method id)
  const bases = [
    salesBase && t("cene {year}", { year: salesBase }), resalesBase && t("ponovne prodaje {year}", { year: resalesBase }),
    rentBase && t("najemnine {year}", { year: rentBase }),
  ].filter(Boolean).join(", ");
  const noun = groupDefinition.noun;
  const indexTitle = indexSeries.some((item) => item.className === "c-rent")
    ? indexSeries.some((item) => item.className !== "c-rent") ? t("Indeksi cen in najemnin {noun}", { noun }) : t("Indeks najemnin {noun}", { noun })
    : t("Indeksi cen {noun}", { noun });
  const format = (amount: number | null) => amount == null ? "—" : (definition.digits ? decimal1 : integer)(amount);
  // The measure's family: rents in the water hue, prices and sale counts in the price hue.
  const own_ = measure === "rent" ? "c-rent" : "c-price";
  const kind = measure === "rent" ? "rent" as const : "sale" as const;
  // A monthly index point (x = year + month/12) is named by its month in the readout and the table.
  const monthOf = (x: number) => { const whole = Math.floor(x); return month(`${whole}-${String(Math.round((x - whole) * 12) + 1).padStart(2, "0")}-01`); };
  const hasRentIndex = indexSeries.some((item) => item.className === "c-rent");

  return <div className="view">
    <section className="controls page-controls" aria-label={t("Merilo")}>
      {tabs}
      <div className="segmented" role="group" aria-label={t("Merilo")}>
        {MEASURES.map((item) => <button key={item.id} type="button" aria-pressed={measure === item.id} onClick={() => setMeasure(item.id)}>{item.label}</button>)}
      </div>
    </section>
    {areaId != null && !own && <section className="card own-area" aria-hidden="true"><div className="chart-placeholder" style={{ height: 290 }}/></section>}
    {own && <section className="card own-area" aria-labelledby="own-title">
      <h2 id="own-title">{tx("{measure}: {area} in Slovenija", { measure: definition.label, area: <Name>{own.area.name}</Name> })}</h2>
      <LineChart unit={definition.unit} height={220} kind={kind} label={[definition.label, own.area.name].join(", ")}
        series={[...(measure === "volume" ? [] : [{ name: t("Slovenija"), className: "ref-country", points: reference }]),
          { name: own.area.name, className: own_, points: complete.map((entry) => ({ x: entry, y: value(measure, own.sales.find((point) => year(point.period) === entry), own.rentals.find((point) => year(point.period) === entry)) })) }]}/>
    </section>}
    <section aria-labelledby="time-title" className="multiples-section">
      <h2 id="time-title" className="section-title">{complete.length ? t("{measure} po regijah, {from}–{to}", { measure: definition.label, from: complete[0], to: complete.at(-1) }) : t("{measure} po regijah", { measure: definition.label })}</h2>
      <p className="stage-sub">{t("Vsak graf je ena statistična regija, vsi imajo isto lestvico ({unit}).", { unit: definition.unit })}
        {measure !== "volume" ? ` ${t("Siva pikčasta črta je Slovenija.")}` : ""} {t("Leta z manj kot 30 posli so izpuščena; tekoče leto ni zaključeno in ni prikazano.")}</p>
      {regional.error ? <LoadFailed retry={regional.retry}>{t("Časovnih vrst po regijah ni bilo mogoče naložiti.")}</LoadFailed>
        : !regional.data && <p className="note muted" role="status">{t("Nalagam regije\u00a0…")}</p>}
      <div className="multiples">{!regional.data && !regional.error && Array.from({ length: 12 }, (_, index) => <figure key={`placeholder-${index}`} className="multiple is-placeholder" aria-hidden="true">
        <figcaption>{"\u00a0"}</figcaption><div className="placeholder-plot"/></figure>)}
        {panels.map((panel) => <figure key={panel.region.id} className="multiple">
        <figcaption><Name>{panel.region.name}</Name><span>{format(panel.points.at(-1)?.y ?? null)}</span></figcaption>
        <LineChart compact legend={false} height={150} unit={definition.unit} yMax={shared} kind={kind}
          label={[definition.label, panel.region.name].join(", ")}
          series={[...(measure === "volume" ? [] : [{ name: t("Slovenija"), className: "ref-country", points: reference }]),
            { name: panel.region.name, className: own_, points: panel.points }]}/>
      </figure>)}</div>
    </section>

    <div className="chart-grid">
      <section className="card"><h2>{t("Slovenija: nominalno in v današnjih cenah")}</h2>
        <p className="note muted">{t("Mediana cene stanovanj; realna vrednost s faktorjem inflacije SURS do januarja {year}.", { year: THIS_YEAR })}</p>
        {!national.length ? <div className="chart-placeholder" style={{ height: 250 }} aria-hidden="true"/> : <LineChart unit="€/m²" label={t("Mediana cene stanovanj v Sloveniji, nominalno in realno")} series={[
          { name: t("Nominalno"), className: "c-price", points: nominal },
          { name: t("V cenah {year}", { year: THIS_YEAR }), className: "c-price-alt", points: real },
        ]}/>}</section>
      <section className="card index-card" aria-labelledby="index-title">
        {/* The title never changes; the type is a compact choice beside it (six options would wrap as pills in a card this narrow). */}
        <div className="card-head"><h2 id="index-title">{t("Indeksi cen in najemnin")}</h2>
          <label className="card-select"><span className="sr-only">{t("Vrsta nepremičnine za indekse")}</span>
            <select value={indexGroup} onChange={(event) => setIndexGroup(event.target.value as IndexGroup)}>
              {INDEX_GROUPS.map((item) => <option key={item.id} value={item.id}>{item.label}</option>)}
            </select></label></div>
        <p className="note muted"><strong>{groupDefinition.label}</strong> · {bases ? t("Prvo leto serije = 100 ({bases}).", { bases }) : t("Prvo leto serije = 100.")} {t("Indeksi upoštevajo kakovost (modelska ocena), zato se lahko razlikujejo od median.")}
          {indexGroup === "land" ? ` ${t("Za zemljišča indeksa najemnin ni.")}` : indexGroup === "room" ? ` ${t("Za sobe se objavljajo samo najemnine.")}` : ""}
          {hasRentIndex ? ` ${t("Indeks najemnin je mesečen; januarske vrednosti so vsako leto okoli 10 % nižje od drugih mesecev (lastnost izračuna, ki jo preverjamo), zato je krivulja zobčasta.")}` : ""}</p>
        {indexLoad.error ? <LoadFailed retry={indexLoad.retry}>{t("Indeksov za {noun} ni bilo mogoče naložiti.", { noun })}</LoadFailed> // i18n-ignore (code, not text)
          : !indexLoad.data ? <div className="chart-placeholder" style={{ height: 250 }} aria-busy="true"><p className="sr-only" role="status">{t("Nalagam indekse\u00a0…")}</p></div> // i18n-ignore (code, not text)
          : <LineChart unit={t("indeks")} xTitle={monthOf} label={t("{title} v Sloveniji", { title: indexTitle })} series={indexSeries}/>}</section>
      <section className="card"><h2>{t("Letna inflacija")}</h2>
        <p className="note muted">{t("SURS, sprememba cen življenjskih potrebščin.")}</p>
        {!inflation.length ? <div className="chart-placeholder" style={{ height: 250 }} aria-hidden="true"/> : <LineChart unit="%" label={t("Letna inflacija v Sloveniji")} series={[{ name: t("Inflacija"), className: "c-money",
          points: inflation.map((item) => ({ x: year(item.period), y: item.annualRatePercent })) }]}/>}</section>
    </div>

    <section className="table-section" aria-labelledby="time-table">
      <h2 id="time-table">{t("Tabela: {measure}", { measure: definition.label })}</h2>
      <div className="table-scroll" tabIndex={0} role="region" aria-labelledby="time-table"><table>
        <caption className="sr-only">{t("{measure} po regijah in letih ({unit})", { measure: definition.label, unit: definition.unit })}</caption>
        <thead><tr><th scope="col">{t("Regija")}</th>{years.map((item) => <th key={item} scope="col">{item}{item === THIS_YEAR ? "*" : ""}</th>)}</tr></thead>
        <tbody>{series.map((item) => <tr key={item.region.id}><th scope="row"><Name>{item.region.name}</Name></th>
          {years.map((entry) => <td key={entry}>{format(value(measure, item.sales.find((point) => year(point.period) === entry),
            item.rentals.find((point) => year(point.period) === entry)))}</td>)}</tr>)}</tbody>
      </table></div>
      <p className="note muted">{t("* Tekoče leto ni zaključeno.")}</p>
    </section>
  </div>;
}
