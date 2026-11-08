import { ArrowDownRight, ArrowUpRight, RefreshCw } from "lucide-react";
import { periodLabel, propertyGroupLabel } from "@/lib/display-values";
import type { MarketMode, Overview, PropertyGroup, TimePoint, YearRange } from "@/lib/types";
import { ProvenanceBadge } from "@/components/ui/provenance-badge";
import { SuppressedStatistic } from "@/components/ui/suppressed-statistic";

const euro = new Intl.NumberFormat("sl-SI", { style: "currency", currency: "EUR", maximumFractionDigits: 0 });
const number = new Intl.NumberFormat("sl-SI", { maximumFractionDigits: 1 });
const titleCase = (value: string) => value.charAt(0).toLocaleUpperCase("sl-SI") + value.slice(1);

function formattedDate(value: string) {
  return new Intl.DateTimeFormat("sl-SI", { day: "numeric", month: "numeric", year: "numeric" })
    .format(new Date(`${value.slice(0, 10)}T00:00:00`));
}

export function MarketSnapshot({ title, mode, propertyGroup, overview, series, years, dataThrough, loading }: {
  title: string;
  mode: MarketMode;
  propertyGroup?: PropertyGroup;
  overview: Overview;
  series: TimePoint[];
  years: YearRange;
  /** Last contract date covered by the published analytical release. */
  dataThrough?: string;
  loading?: boolean;
}) {
  const metric = mode === "sale" ? overview.medianPricePerSqm : overview.medianMonthlyRent;
  const published = series.filter((point) => point.isPublishable !== false).flatMap((point) => {
    const value = mode === "sale" ? point.medianPricePerSqm : point.medianMonthlyRent;
    return value == null ? [] : [{ ...point, value }];
  });
  const [previous, latest] = published.slice(-2);
  const change = previous && latest ? ((latest.value / previous.value) - 1) * 100 : undefined;
  // Pooled over the whole selected range: a historical median, not a current market price.
  const period = years.from === years.to ? `${years.from}` : `${years.from}–${years.to}`;
  const rate = overview.transactionCount > 0 ? overview.includedSampleSize / overview.transactionCount * 100 : undefined;
  const ChangeIcon = change != null && change < 0 ? ArrowDownRight : ArrowUpRight;
  return <section className="market-snapshot" aria-labelledby="snapshot-title" aria-busy={loading}>
    <header className="snapshot-heading">
      <div><span className="section-eyebrow">Sklenjeni posli · {period}</span><h2 id="snapshot-title">{title}</h2>
        <p>{propertyGroup ? titleCase(propertyGroupLabel(propertyGroup)) : "Nepremičnine"} · {mode === "sale" ? "prodaja" : "najem"}</p>
        <small>Analizirano obdobje: {years.from}–{years.to}</small>
        <small className="snapshot-cutoff">{dataThrough
          ? `Zadnji objavljeni posli GURS: do ${formattedDate(dataThrough)}. `
          : ""}Prikazane so cene preteklih poslov, ne trenutna tržna cena.</small></div>
      <div className="snapshot-provenance"><ProvenanceBadge kind="calculated" />
        {loading && <span className="localized-loading" role="status"><RefreshCw aria-hidden="true" /> Osvežujem …</span>}
      </div>
    </header>
    {overview.isPublishable === false && metric == null
      ? <SuppressedStatistic reason={overview.suppressionReason} sampleSize={overview.includedSampleSize} />
      : <div className="snapshot-metrics">
        <div className="snapshot-primary"><span>{mode === "sale" ? "Mediana cene / m²" : "Mediana mesečne najemnine"} · {period}</span>
          <strong>{metric == null ? "—" : mode === "sale" ? `${number.format(metric)} €/m²` : `${euro.format(metric)} / mesec`}</strong></div>
        <div><span>{previous && latest
          ? `Sprememba ${periodLabel(previous.period, "year")} → ${periodLabel(latest.period, "year")}${latest.incomplete ? " *" : ""}`
          : "Letna sprememba"}</span><strong className="direction-neutral">{change == null ? "—" : <><ChangeIcon aria-hidden="true" />{change > 0 ? "+" : ""}{number.format(change)} %</>}</strong></div>
        <div><span>Posli</span><strong>{number.format(overview.transactionCount)}</strong></div>
        <div><span>Reprezentativni vzorec</span><strong>{number.format(overview.includedSampleSize)}{rate != null ? ` / ${number.format(rate)} %` : ""}</strong></div>
      </div>}
    {change != null && latest?.incomplete && <p className="snapshot-secondary">
      * {periodLabel(latest.period, "year")} še ni zaključeno; sprememba primerja delno leto s celim letom.</p>}
    <p className="snapshot-secondary">
      {mode === "sale" ? "Mediana posla" : "Mediana mesečnega najema"} {metric == null && overview.medianPrice == null ? "—" : euro.format(mode === "sale" ? overview.medianPrice ?? 0 : overview.medianMonthlyRent ?? 0)}
      {overview.medianArea != null && <> · mediana površine {number.format(overview.medianArea)} m²</>}
      {<> · {number.format(overview.eligibleCount)} kakovostno ustreznih</>}
      {<> · {number.format(overview.excludedOutlierCount)} izločenih statističnih odstopanj</>}
    </p>
  </section>;
}
