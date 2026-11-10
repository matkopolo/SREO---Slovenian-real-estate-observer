import { useMemo, useState } from "react";
import {
  api, loadGeography, loadIndices, loadInflation, loadInflationFactor, loadRegions, loadRentalTimeSeries, loadTimeSeries,
  type Geography, type MarketIndex, type RentalTimePoint, type TimePoint,
} from "../api";
import { LineChart } from "../components/charts";
import { LoadFailed } from "../components/LoadState";
import { useLoad } from "../hooks/useLoad";
import { decimal1, integer } from "../format";
import { Name, t, tx } from "../i18n";
import { NOUNS, ROOMS_GENITIVE } from "../nouns";
import { hashQuery } from "../url-state";

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

const value = (measure: Measure, sale?: TimePoint, rent?: RentalTimePoint) => measure === "volume" ? sale?.transactionCount ?? null
  : measure === "sale" ? (sale?.isPublishable ? sale.medianPricePerSqm ?? null : null)
    : (rent?.isPublishable ? rent.medianMonthlyRentPerSqm ?? null : null);

/** Prices over time: twelve regional small multiples on one scale with Slovenia as the reference line. */
export function TimeView({ cutoff }: { cutoff?: string }) {
  // The year the data reaches (the clock's year until the data status is known): it is not complete yet.
  const THIS_YEAR = cutoff ? Number(cutoff.slice(0, 4)) : new Date().getFullYear();
  const [indexGroup, setIndexGroup] = useState<IndexGroup>("apartment");
  const [measure, setMeasure] = useState<Measure>("sale");
  // The area the user came from (#trendi?g=…): its own line against Slovenia above the regions.
  const areaId = Number(hashQuery().get("g")) || undefined;
  const own = useLoad(areaId ? `trend-area-${areaId}` : null, async (signal) => {
    const [area, sales, rentals] = await Promise.all([loadGeography(areaId!, signal), loadTimeSeries(areaId, signal), loadRentalTimeSeries(areaId, signal)]);
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
  const indexLoad = useLoad(`indices-${indexGroup}`, (signal) => loadGroupIndices(indexGroup, signal));
  // Real prices: SURS CPI factor from January of each year to January of the current year.
  const nationalYears = [...new Set(national.map((point) => year(point.period)))].filter((item) => item < THIS_YEAR).join(","); // i18n-ignore (comparison, not JSX text)
  const factors = useLoad(nationalYears ? `factors|${nationalYears}|${THIS_YEAR}` : null, async (signal) => {
    const results = await Promise.allSettled(nationalYears.split(",").map(Number).map((item) => loadInflationFactor(item, `${THIS_YEAR}-01-01`, signal).then((result) => [item, result.factor] as const)));
    return new Map(results.flatMap((result) => result.status === "fulfilled" ? [result.value] : []));
  }).data ?? new Map<number, number>();

  const years = useMemo(() => [...new Set(series.flatMap((item) => item.sales.map((point) => year(point.period))))].sort(), [series]);
  const definition = MEASURES.find((item) => item.id === measure)!;
  // Complete years only in the charts; the table marks the current year.
  const complete = years.filter((item) => item < THIS_YEAR); // i18n-ignore (comparison, not JSX text)
  const reference = complete.map((item) => ({ x: item, y: value(measure, national.find((point) => year(point.period) === item),
    nationalRent.find((point) => year(point.period) === item)) }));
  const panels = series.map((item) => ({ region: item.region, points: complete.map((entry) => ({ x: entry,
    y: value(measure, item.sales.find((point) => year(point.period) === entry), item.rentals.find((point) => year(point.period) === entry)) })) }));
  const shared = Math.max(0, ...panels.flatMap((panel) => panel.points.map((point) => point.y ?? 0)),
    ...(measure === "volume" ? [] : reference.map((point) => point.y ?? 0)));

  const nominal = national.filter((point) => point.isPublishable && point.medianPricePerSqm != null && !point.incomplete)
    .map((point) => ({ x: year(point.period), y: point.medianPricePerSqm! }));
  const real = nominal.map((point) => ({ x: point.x, y: factors.has(point.x) ? point.y * factors.get(point.x)! : null }));
  const toX = (item: MarketIndex) => Number(item.period.slice(0, 4)) + (Number(item.period.slice(5, 7)) - 1) / 12;
  const indices = indexLoad.data?.sale ?? [];
  const rentIndices = indexLoad.data?.rent ?? [];
  const groupDefinition = INDEX_GROUPS.find((item) => item.id === indexGroup)!;
  const pick = (items: MarketIndex[], method: MarketIndex["method"]) => items.filter((item) => item.method === method && item.isPublishable)
    .map((item) => ({ x: toX(item), y: item.indexValue }));
  const indexSeries = [
    { name: t("Cene, hedonski indeks"), className: "s1", points: pick(indices, "hedonic") },
    { name: t("Cene, ponovne prodaje"), className: "s2", points: pick(indices, "matched_pair_median") }, // i18n-ignore (API method id)
    { name: t("Najemnine, hedonski indeks"), className: "s3", points: pick(rentIndices, "hedonic") },
  ].filter((item) => item.points.length);
  const base = (items: MarketIndex[], method: MarketIndex["method"]) => items.find((item) => item.method === method)?.basePeriod?.slice(0, 4);
  const salesBase = base(indices, "hedonic"), resalesBase = base(indices, "matched_pair_median"), rentBase = base(rentIndices, "hedonic"); // i18n-ignore (API method id)
  const bases = [
    salesBase && t("cene {year}", { year: salesBase }), resalesBase && t("ponovne prodaje {year}", { year: resalesBase }),
    rentBase && t("najemnine {year}", { year: rentBase }),
  ].filter(Boolean).join(", ");
  const noun = groupDefinition.noun;
  const indexTitle = indexSeries.some((item) => item.className === "s3")
    ? indexSeries.some((item) => item.className !== "s3") ? t("Indeksi cen in najemnin {noun}", { noun }) : t("Indeks najemnin {noun}", { noun })
    : t("Indeksi cen {noun}", { noun });
  const format = (amount: number | null) => amount == null ? "—" : (definition.digits ? decimal1 : integer)(amount);

  return <div className="view">
    <section className="controls" aria-label={t("Merilo")}>
      <div className="segmented" role="group" aria-label={t("Merilo")}>
        {MEASURES.map((item) => <button key={item.id} type="button" aria-pressed={measure === item.id} onClick={() => setMeasure(item.id)}>{item.label}</button>)}
      </div>
    </section>
    {own && <section className="card own-area" aria-labelledby="own-title">
      <h2 id="own-title">{tx("{measure}: {area} in Slovenija", { measure: definition.label, area: <Name>{own.area.name}</Name> })}</h2>
      <LineChart unit={definition.unit} height={220} label={[definition.label, own.area.name].join(", ")}
        series={[...(measure === "volume" ? [] : [{ name: t("Slovenija"), className: "ref", points: reference }]),
          { name: own.area.name, className: "s1", points: complete.map((entry) => ({ x: entry, y: value(measure, own.sales.find((point) => year(point.period) === entry), own.rentals.find((point) => year(point.period) === entry)) })) }]}/>
    </section>}
    <section aria-labelledby="time-title" className="multiples-section">
      <h1 id="time-title" className="stage-title">{t("{measure} po regijah, {from}–{to}", { measure: definition.label, from: complete[0] ?? "", to: complete.at(-1) ?? "" })}</h1>
      <p className="stage-sub">{t("Vsak graf je ena statistična regija, vsi imajo isto lestvico ({unit}).", { unit: definition.unit })}
        {measure !== "volume" ? ` ${t("Siva črta je Slovenija.")}` : ""} {t("Leta z manj kot 30 posli so izpuščena; tekoče leto ni zaključeno in ni prikazano.")}</p>
      {regional.error ? <LoadFailed retry={regional.retry}>{t("Časovnih vrst po regijah ni bilo mogoče naložiti.")}</LoadFailed>
        : !regional.data && <p className="muted" role="status">{t("Nalagam regije …")}</p>}
      <div className="multiples">{panels.map((panel) => <figure key={panel.region.id} className="multiple">
        <figcaption><Name>{panel.region.name}</Name><span>{format(panel.points.at(-1)?.y ?? null)}</span></figcaption>
        <LineChart compact legend={false} height={150} unit={definition.unit} yMax={shared}
          label={[definition.label, panel.region.name].join(", ")}
          series={[...(measure === "volume" ? [] : [{ name: t("Slovenija"), className: "ref", points: reference }]),
            { name: panel.region.name, className: "s1", points: panel.points }]}/>
      </figure>)}</div>
    </section>

    <div className="chart-grid">
      <section className="card"><h2>{t("Slovenija: nominalno in v današnjih cenah")}</h2>
        <p className="muted">{t("Mediana cene stanovanj; realna vrednost s faktorjem inflacije SURS do januarja {year}.", { year: THIS_YEAR })}</p>
        <LineChart unit="€/m²" label={t("Mediana cene stanovanj v Sloveniji, nominalno in realno")} series={[
          { name: t("Nominalno"), className: "s1", points: nominal },
          { name: t("V cenah {year}", { year: THIS_YEAR }), className: "s2", points: real },
        ]}/></section>
      <section className="card index-card" aria-labelledby="index-title"><h2 id="index-title">{indexTitle}</h2>
        <div className="segmented small" role="group" aria-label={t("Vrsta nepremičnine za indekse")}>
          {INDEX_GROUPS.map((item) => <button key={item.id} type="button" aria-pressed={indexGroup === item.id}
            onClick={() => setIndexGroup(item.id)}>{item.label}</button>)}
        </div>
        <p className="muted">{bases ? t("Prvo leto serije = 100 ({bases}).", { bases }) : t("Prvo leto serije = 100.")} {t("Indeksi upoštevajo kakovost (modelska ocena), zato se lahko razlikujejo od median.")}
          {indexGroup === "land" ? ` ${t("Za zemljišča indeksa najemnin ni.")}` : indexGroup === "room" ? ` ${t("Za sobe se objavljajo samo najemnine.")}` : ""}</p>
        {indexLoad.error ? <LoadFailed retry={indexLoad.retry}>{t("Indeksov za {noun} ni bilo mogoče naložiti.", { noun })}</LoadFailed> // i18n-ignore (code, not text)
          : !indexLoad.data ? <p className="muted" role="status">{t("Nalagam indekse …")}</p> // i18n-ignore (code, not text)
          : <LineChart unit={t("indeks")} label={t("{title} v Sloveniji", { title: indexTitle })} series={indexSeries}/>}</section>
      <section className="card"><h2>{t("Letna inflacija")}</h2>
        <p className="muted">{t("SURS, sprememba cen življenjskih potrebščin.")}</p>
        <LineChart unit="%" label={t("Letna inflacija v Sloveniji")} series={[{ name: t("Inflacija"), className: "s3",
          points: inflation.map((item) => ({ x: year(item.period), y: item.annualRatePercent })) }]}/></section>
    </div>

    <section className="table-section" aria-labelledby="time-table">
      <h2 id="time-table">{t("Tabela: {measure}", { measure: definition.label })}</h2>
      <div className="table-scroll"><table>
        <caption className="sr-only">{t("{measure} po regijah in letih ({unit})", { measure: definition.label, unit: definition.unit })}</caption>
        <thead><tr><th scope="col">{t("Regija")}</th>{years.map((item) => <th key={item} scope="col">{item}{item === THIS_YEAR ? "*" : ""}</th>)}</tr></thead>
        <tbody>{series.map((item) => <tr key={item.region.id}><th scope="row"><Name>{item.region.name}</Name></th>
          {years.map((entry) => <td key={entry}>{format(value(measure, item.sales.find((point) => year(point.period) === entry),
            item.rentals.find((point) => year(point.period) === entry)))}</td>)}</tr>)}</tbody>
      </table></div>
      <p className="muted">{t("* Tekoče leto ni zaključeno.")}</p>
    </section>
  </div>;
}
