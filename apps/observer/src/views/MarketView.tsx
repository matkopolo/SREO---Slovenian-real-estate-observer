import { useState, type ReactNode } from "react";
import { lastCompleteYear, loadAreaLists, loadDensity, loadMarket } from "../api";
import { AreaSearch } from "../components/AreaSearch";
import { DotMap, Histogram } from "../components/charts";
import { LoadFailed } from "../components/LoadState";
import { useLoad } from "../hooks/useLoad";
import { date, euro, integer, upTo1, withUnit } from "../format";
import { Missing } from "../components/Missing";
import { NOUNS } from "../nouns";
import { count, NOUN_FORMS } from "../plural";
import { Name, t, tx } from "../i18n";
import { parseHash, transactionHref } from "../url-state";

const SPANS = [1, 3, 5] as const;
const dateText = (value?: string | null) => value ? date(value) : "—";
const decimal = { format: upTo1 };

const initialArea = () => parseHash().g;

/** Distributions and extremes of one area (any region or municipality), flats or houses. */
export function MarketView({ cutoff, tabs }: { cutoff: string; tabs?: ReactNode }) {
  const lists = useLoad("area-lists", (signal) => loadAreaLists(signal));
  const regions = lists.data?.regions ?? [], municipalities = lists.data?.municipalities ?? [];
  const [regionId, setRegionId] = useState<number | undefined>(initialArea);
  const [group, setGroup] = useState<"apartment" | "house">("apartment");
  const [span, setSpan] = useState<(typeof SPANS)[number]>(3);
  // The newest complete calendar year of the data (not of the clock: in January the GURS data still ends in autumn).
  const lastYear = lastCompleteYear(cutoff);
  const fromYear = lastYear - span + 1;
  const period = span === 1 ? String(lastYear) : `${fromYear}–${lastYear}`;
  const marketLoad = useLoad(`market|${regionId ?? 0}|${group}|${fromYear}|${lastYear}`, (signal) => loadMarket(regionId, fromYear, lastYear, signal, { propertyGroup: group }));
  const densityLoad = useLoad(`density|${fromYear}|${lastYear}`, (signal) => loadDensity(fromYear, lastYear, signal));
  const market = marketLoad.data, density = densityLoad.data;

  const [sale, rent, saleDistribution, rentDistribution, extremes, resales] = market ?? [];
  const area = regionId ? [...regions, ...municipalities].find((item) => item.id === regionId)?.name ?? "…" : t("Slovenija");
  const areaName = regionId ? <Name>{area}</Name> : area;
  const noun = NOUNS[group].genitive;
  const buckets = (distribution: typeof saleDistribution) => (distribution?.isPublishable ? distribution.buckets : [])
    .map((bucket) => ({ lower: bucket.from, upper: bucket.to, count: bucket.count }));
  const open = (distribution: typeof saleDistribution) => ({ below: !!distribution?.isPublishable && distribution.belowBoundCount > 0, above: !!distribution?.isPublishable && distribution.aboveBoundCount > 0 });
  const maxCount = Math.max(1, ...(density?.sales ?? []).map((cell) => cell.count), ...(density?.rentals ?? []).map((cell) => cell.count));
  const size = (count: number) => 1.5 + Math.sqrt(count / maxCount) * 9;

  return <div className="view">
    <section className="controls page-controls" aria-label={t("Območje in obdobje")}>
      {tabs}
      <AreaSearch compact regions={regions} municipalities={municipalities} label={t("Območje: {area}", { area })} placeholder={t("vpišite občino ali regijo")}
        includeAddresses={false} onArea={(option) => setRegionId(option.id)}/>
      <div className="segmented" role="group" aria-label={t("Vrsta nepremičnine")}>
        <button type="button" aria-pressed={group === "apartment"} onClick={() => setGroup("apartment")}>{t("Stanovanja")}</button>
        <button type="button" aria-pressed={group === "house"} onClick={() => setGroup("house")}>{t("Hiše")}</button>
      </div>
      <div className="segmented" role="group" aria-label={t("Obdobje")}>
        {SPANS.map((value) => <button key={value} type="button" aria-pressed={span === value} onClick={() => setSpan(value)}>
          {count(value, NOUN_FORMS.leto)}</button>)}
      </div>
    </section>
    <h2 className="section-title">{tx("Porazdelitev cen {noun}: {area}, {period}", { noun, area: areaName, period })}</h2>
    {marketLoad.error ? <LoadFailed retry={marketLoad.retry}>{t("Tržnih podatkov ni bilo mogoče naložiti.")}</LoadFailed>
      : !market && <div className="chart-placeholder" style={{ height: 760 }} aria-busy="true"><p className="sr-only" role="status">{t("Nalagam\u00a0…")}</p></div>}
    {market && <>
      <dl className="tiles">
        <div><dt>{t("Mediana cene")}</dt><dd>{sale?.medianPricePerSqm == null ? <Missing/> : withUnit(integer(sale.medianPricePerSqm), "€/m²")}</dd>
          <dd className="tile-note"><small>{sale?.transactionCount != null && sale.includedSampleSize != null && sale.excludedOutlierCount != null
            ? t("Iz {total} prodaj je {included} reprezentativnih; {excluded} skrajnih je izločenih.", { total: integer(sale.transactionCount), included: integer(sale.includedSampleSize), excluded: integer(sale.excludedOutlierCount) }) : ""}</small></dd></div>
        <div><dt>{t("Mediana posla")}</dt><dd>{sale?.medianPrice == null ? <Missing/> : euro(sale.medianPrice)}</dd>
          <dd className="tile-note"><small>{sale?.medianArea != null ? t("mediana površine {area}", { area: withUnit(decimal.format(sale.medianArea), "m²") }) : ""}</small></dd></div>
        <div><dt>{t("Mediana najemnine")}</dt><dd>{rent?.medianMonthlyRentPerSqm == null ? <Missing/> : withUnit(decimal.format(rent.medianMonthlyRentPerSqm), "€/m²")}</dd>
          <dd className="tile-note"><small>{rent?.medianMonthlyRent != null && rent.rentPerSqmSampleSize != null
            ? t("na mesec; mediana najemnine {rent}, n = {n}", { rent: euro(rent.medianMonthlyRent), n: integer(rent.rentPerSqmSampleSize) }) : t("na mesec")}</small></dd></div>
        <div><dt>{t("Čas med ponovnimi prodajami")}{regionId ? <span className="chip">{t("samo za Slovenijo")}</span> : null}</dt><dd>{resales?.isPublishable && resales.medianDays != null ? t("{years} leta", { years: decimal.format(resales.medianDays / 365.25) }) : <Missing/>}</dd>
          <dd className="tile-note"><small>{resales?.pairCount != null ? t("Samo za Slovenijo ({pairs}); srednja polovica {range}.", { pairs: count(resales.pairCount, NOUN_FORMS.par),
            range: resales.p25Days != null && resales.p75Days != null ? t("{from}–{to} leta", { from: decimal.format(resales.p25Days / 365.25), to: decimal.format(resales.p75Days / 365.25) }) : "—" }) : ""}</small></dd></div>
      </dl>
      <div className="chart-grid two">
        <section className="card"><h2>{t("Porazdelitev cen")}</h2>
          <p className="note muted">{t("€/m², reprezentativni posli.")}{saleDistribution?.percentiles?.p25 != null && saleDistribution.percentiles.p50 != null && saleDistribution.percentiles.p75 != null
            ? ` ${t("Srednja polovica od {p25} do {p75}, mediana {p50}.", { p25: integer(saleDistribution.percentiles.p25), p75: integer(saleDistribution.percentiles.p75), p50: integer(saleDistribution.percentiles.p50) })}` : ""}</p>
          <Histogram unit="€/m²" label={t("Porazdelitev cen {noun}, {area}", { noun, area })} buckets={buckets(saleDistribution)} open={open(saleDistribution)}/></section>
        <section className="card"><h2>{t("Porazdelitev najemnin")}</h2>
          <p className="note muted">{rentDistribution?.percentiles?.p50 != null ? t("€/m² na mesec, mediana {p50}.", { p50: decimal.format(rentDistribution.percentiles.p50) }) : t("€/m² na mesec.")}</p>
          <Histogram unit="€/m²" kind="rent" label={t("Porazdelitev najemnin {noun}, {area}", { noun, area })} buckets={buckets(rentDistribution)} open={open(rentDistribution)}/></section>
      </div>
      <section className="card"><h2>{t("Najvišje in najnižje prodaje")}</h2>
        <p className="note muted">{t("Skupna cena posla med reprezentativnimi posli.")} {t("Posli pod četrtino mediane so izpuščeni, ker gre skoraj vedno za napako v evidenci.")}</p>
        <div className="extremes">{(["highest", "lowest"] as const).map((direction) => <ol key={direction} aria-label={direction === "highest" ? t("Najvišje") : t("Najnižje")}>
          <li className="extremes-head">{direction === "highest" ? t("Najvišje") : t("Najnižje")}</li>
          {(extremes?.items ?? []).filter((item) => item.direction === direction
            && !(direction === "lowest" && sale?.medianPricePerSqm && (item.amountPerSqm ?? 0) < sale.medianPricePerSqm / 4)).map((item) => <li key={item.transactionId}>
            <a href={transactionHref({ kind: "sale", id: item.transactionId })}>{item.amount == null ? t("Posel #{id}", { id: item.transactionId }) : euro(item.amount)}</a>
            <span>{dateText(item.contractDate)}, {item.area == null ? <Missing/> : withUnit(decimal.format(item.area), "m²")}, {item.amountPerSqm == null ? <Missing/> : withUnit(integer(item.amountPerSqm), "€/m²")}</span></li>)}
        </ol>)}</div>
      </section>
    </>}
    <section className="card"><h2>{t("Kje se trguje v Sloveniji, {period}", { period })}</h2>
      <p className="note muted">{t("Slovenija je razdeljena v mrežo celic; velikost kroga ustreza številu poslov v celici (stanovanja).")}</p>
      {densityLoad.error ? <LoadFailed retry={densityLoad.retry}/> : !density ? <div className="chart-placeholder" style={{ height: 300 }} aria-busy="true"><p className="sr-only" role="status">{t("Nalagam\u00a0…")}</p></div> : <DotMap bbox={[13.3, 45.4, 16.7, 46.9]} label={t("Gostota prodaj in najemov stanovanj v Sloveniji")} // i18n-ignore (code, not text)
        layers={[
          { name: t("Najemi"), className: "layer-rent", total: density.rentals.reduce((sum, cell) => sum + cell.count, 0), points: density.rentals.map((cell) => ({ at: cell.at, size: size(cell.count) })) },
          { name: t("Prodaje"), className: "layer-sale", total: density.sales.reduce((sum, cell) => sum + cell.count, 0), points: density.sales.map((cell) => ({ at: cell.at, size: size(cell.count) })) },
        ]}/>}
    </section>
  </div>;
}
