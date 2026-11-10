import { useMemo, useState } from "react";
import { loadRentOverview, loadRentSpread, loadRentTrend, periodWindows, type Period, type PropertyGroup, type RentalOverview, type RentalTimePoint, type RentGroup } from "../api";
import { SalesList } from "./SalesList";
import { areaName, type Scope } from "./AreaModules";
import { Histogram, LineChart } from "./charts";
import { LoadFailed, LoadState } from "./LoadState";
import { GLOSSARY, Term } from "./Term";
import { useLoad } from "../hooks/useLoad";
import { decimal1, euro, integer, NBSP, percent } from "../format";
import { NOUNS, ROOMS_GENITIVE, type Band } from "../nouns";
import { count, NOUN_FORMS } from "../plural";
import { t, tx } from "../i18n";

/**
 * Rental types as in the earlier dashboard; rooms are rented on their own and quoted per month, not per m².
 * `genitive` is the plural used inside templates ("Mediana najemnine {noun}" / "Median rent of {noun}"), as `NounForms.genitive`.
 */
const RENT_TYPES: Array<{ id: RentGroup; label: string; genitive: string; perUnit: boolean }> = [
  { id: "apartment", label: t("Stanovanja"), genitive: NOUNS.apartment.genitive, perUnit: false },
  { id: "house", label: t("Hiše"), genitive: NOUNS.house.genitive, perUnit: false },
  { id: "room", label: t("Sobe"), genitive: ROOMS_GENITIVE, perUnit: true },
  { id: "commercial", label: t("Poslovni prostori"), genitive: NOUNS.commercial.genitive, perUnit: false },
  { id: "garage", label: t("Garaže"), genitive: NOUNS.garage.genitive, perUnit: true },
];

/** Rental flat sizes as renters search for them. */
const RENT_SIZES = [
  { id: "-40", label: t("do 40 m² (garsonjera)"), max: 39.99 }, { id: "40-60", label: t("40–60 m² (dvosobno)"), min: 40, max: 59.99 },
  { id: "60-80", label: t("60–80 m² (trisobno)"), min: 60, max: 79.99 }, { id: "80-", label: t("nad {area} m²", { area: 80 }), min: 80 },
];

const published = (overview?: RentalOverview | null) => overview?.isPublishable ? overview : undefined;

/**
 * The rental market of an area (the old dashboard's "Najem" mode, inside the panel): median rent, change,
 * gross yield, yearly trend against the parent area, the spread and the latest contracts.
 */
export function RentSection({ scope, parent, group, band, cutoff, years, salePerSqm }: {
  scope: Scope; parent?: Scope; group: PropertyGroup; band?: Band; cutoff?: string; years: Period;
  /** Sale median €/m² of the panel's type, for the gross yield (only when the rental type is the same). */
  salePerSqm?: number | null;
}) {
  // The panel remounts this section for another type (key), so the rental type starts from the panel's type.
  const [kind, setKind] = useState<RentGroup>(group === "house" || group === "commercial" || group === "garage" ? group : "apartment");
  const type = RENT_TYPES.find((item) => item.id === kind)!;
  // The size band only applies when the rental type is the type chosen above.
  // Flats: sizes renters think in ("dvosobno"); otherwise the panel's size band when the type matches.
  const [rentSize, setRentSize] = useState<string>();
  const ownBand = kind === "apartment" ? RENT_SIZES.find((item) => item.id === rentSize) : undefined;
  const segment = useMemo(() => ({ propertyGroup: kind, ...(ownBand ? { minArea: ownBand.min, maxArea: ownBand.max } : kind === group && band ? { minArea: band.min, maxArea: band.max } : {}) }),
    [band, group, kind, ownBand]);
  const windows = useMemo(() => cutoff ? periodWindows(cutoff, years) : undefined, [cutoff, years]);
  const base = windows ? `${scope.id ?? 0}|${JSON.stringify(segment)}|${windows.rents.current.from}|${windows.rents.current.to}` : null;
  const overview = useLoad(base && `rent-overview|${base}`, (signal) => loadRentOverview(scope.id, segment, windows!.rents.current, signal));
  const previousLoad = useLoad(base && `rent-previous|${base}`, (signal) => windows!.rents.previous ? loadRentOverview(scope.id, segment, windows!.rents.previous, signal) : Promise.resolve(null));
  const ownTrend = useLoad(base && `rent-trend|${scope.id ?? 0}|${JSON.stringify(segment)}`, async (signal) => (await loadRentTrend(scope.id, segment, signal)).items);
  const parentTrend = useLoad(base && parent ? `rent-trend|${parent.id ?? 0}|${JSON.stringify(segment)}` : null, async (signal) => (await loadRentTrend(parent!.id, segment, signal)).items);
  const spread = useLoad(base && `rent-spread|${base}|${type.perUnit}`, (signal) => loadRentSpread(scope.id, segment, windows!.rents.current, type.perUnit ? "monthlyRent" : "rentPerSqm", signal));
  const current = overview.data;
  const previous = previousLoad.data;
  const trend: { own?: RentalTimePoint[]; parent?: RentalTimePoint[] } = { own: ownTrend.data, parent: parentTrend.data };
  const rentFrom = windows?.rents.current.from, rentTo = windows?.rents.current.to;

  const now = published(current);
  const before = published(previous);
  const value = (overview?: RentalOverview) => type.perUnit ? overview?.medianMonthlyRent : overview?.medianMonthlyRentPerSqm;
  const change = value(now) != null && value(before) ? value(now)! / value(before)! - 1 : null;
  const yieldPercent = !type.perUnit && kind === group && now?.medianMonthlyRentPerSqm != null && salePerSqm ? now.medianMonthlyRentPerSqm * 12 / salePerSqm * 100 : null;
  const unit = type.perUnit ? t("€ na mesec") : t("€/m² na mesec");
  const points = (items?: RentalTimePoint[]) => (items ?? []).filter((point) => !point.incomplete)
    .map((point) => ({ x: Number(point.period.slice(0, 4)), y: point.isPublishable ? (type.perUnit ? point.medianMonthlyRent : point.medianMonthlyRentPerSqm) ?? null : null }));
  const series = [{ name: scope.name, className: "s1", points: points(trend.own) }, ...(parent ? [{ name: parent.name, className: "ref", points: points(trend.parent) }] : [])];
  const period = windows ? (windows.rentYears.includes("–") ? t("v letih {years}", { years: windows.rentYears }) : t("v letu {year}", { year: windows.rentYears })) : "";
  const typical = !type.perUnit && now?.medianMonthlyRent != null
    ? now.medianArea != null ? t("(tipično {rent} za {area} m²)", { rent: euro(now.medianMonthlyRent), area: decimal1(now.medianArea) }) : t("(tipično {rent})", { rent: euro(now.medianMonthlyRent) })
    : type.perUnit && now?.medianArea != null ? t("(tipično {area} m²)", { area: decimal1(now.medianArea) }) : null;

  return <section className="module open rent-section" aria-labelledby="rent-title">
    <h2 id="rent-title">{t("Najemi {period}", { period })}</h2>
    <div className="segmented small wrap" role="group" aria-label={t("Vrsta najema")}>
      {RENT_TYPES.map((item) => <button key={item.id} type="button" aria-pressed={kind === item.id} onClick={() => setKind(item.id)}>{item.label}</button>)}
    </div>
    {kind === "apartment" && <div className="segmented small wrap" role="group" aria-label={t("Velikost najetega stanovanja")}>
      <button type="button" aria-pressed={!ownBand} onClick={() => setRentSize(undefined)}>{t("vse velikosti")}</button>
      {RENT_SIZES.map((item) => <button key={item.id} type="button" aria-pressed={ownBand?.id === item.id} onClick={() => setRentSize(item.id)}>{item.label}</button>)}
    </div>}
    <p className="area-lede">
      {overview.error ? <LoadFailed retry={overview.retry}/> : current === undefined ? t("Nalagam najeme …")
        : now && value(now) != null ? <>{tx("Mediana najemnine {noun}{band}: {rent} na mesec{typical}, n = {n}{change}.", {
          noun: type.genitive, band: kind === group && band ? ` (${band.label})` : "",
          rent: <strong>{type.perUnit ? euro(value(now)!) : `${decimal1(value(now)!)}${NBSP}€/m²`}</strong>,
          typical: typical ? ` ${typical}` : "", n: integer(type.perUnit ? now.monthlyRentSampleSize : now.rentPerSqmSampleSize),
          change: change != null ? `, ${percent(change, { signed: true })} ${t("glede na enako dolgo obdobje prej")}` : "" })}
          {yieldPercent != null && <> {tx("{term} {value} %.", { term: <Term text={GLOSSARY.donos}>{t("Bruto donos")}</Term>, value: decimal1(yieldPercent) })}</>}</>
        : <>{t("{rentals} {noun}{note}.", { rentals: count(current?.transactionCount ?? 0, NOUN_FORMS.najem), noun: type.genitive,
          note: current?.transactionCount ? `, ${t("premalo za mediano; posamezni najemi so spodaj")}` : "" })}</>}
    </p>
    {series[0].points.some((point) => point.y != null) && <LineChart unit={type.perUnit ? "€" : "€/m²"} height={180}
      label={t("Mediana najemnine {noun} po letih ({unit}): {areas}", { noun: type.genitive, unit, areas: series.map((item) => item.name).join(", ") })} series={series}/>}
    <details className="module-inner">
      <summary>{t("Porazdelitev najemnin")}</summary>
      <LoadState load={spread}>{(data) => !data.isPublishable ? <p className="muted">{t("Premalo najemov za porazdelitev.")}</p> // i18n-ignore (code, not text)
        : <Histogram unit={type.perUnit ? "€" : "€/m²"} label={t("Porazdelitev najemnin {noun}, {area}", { noun: type.genitive, area: scope.name })}
          buckets={data.buckets.map((bucket) => ({ lower: bucket.from, upper: bucket.to, count: bucket.count }))}/>}</LoadState>
    </details>
    {rentFrom && rentTo && <SalesList kind="rent" scopeId={scope.id} scopeName={scope.name} segment={segment} window={{ from: rentFrom, to: rentTo }} noun={type.genitive} linkArea={scope.id}/>}
    <p className="muted">{tx("To so evidentirane najemne pogodbe za {area} (brez obratovalnih stroškov), ne oglasi: oglasne cene so pogosto višje, med pogodbami pa so tudi starejši najemi in najemi med znanci.", { area: areaName(scope) })}
      {" "}{t("GURS jih evidentira z zamikom do enega leta, zato najnovejši meseci manjkajo.")}</p>
  </section>;
}
