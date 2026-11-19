import { Fragment, type ReactNode } from "react";
import type { MarketComparable, PropertyGroup, TransactionContext } from "../api";
import { dateCompact as date, euro, integer, upTo1, percentSigned } from "../format";
import { t, tx } from "../i18n";
import { OF_TYPE } from "../nouns";
import { count, NOUN_FORMS } from "../plural";
import type { Typical, ValueBand } from "../valuation";

/** The rows "what the estimate rests on" is built from: pure, so every wording has a unit test. */

export interface Purchase { price: number; date: string; area: number; group: PropertyGroup; transactionId?: number }
export interface ValueRow { key: string; title: ReactNode; value: string | null; note: ReactNode }
type MarketEstimate = NonNullable<TransactionContext["currentMarketEstimate"]> & { comparables?: MarketComparable[]; comparablesAfter?: string | null };

/** The similar-sales row: "Podobna stanovanja danes" (nominative plural, so each type is its own key). */
const SIMILAR_TODAY: Record<PropertyGroup, string> = {
  apartment: t("Podobna stanovanja danes"), house: t("Podobne hiše danes"), commercial: t("Podobni poslovni prostori danes"),
  garage: t("Podobne garaže danes"), land: t("Podobna zemljišča danes"),
};
/** Prices are rounded to the thousand: an estimate is never "289.052 €". */
export const roundThousand = (value: number): number => Math.round(value / 1000) * 1000;
/** Garages are priced to the nearest 500 €. */
const GARAGE_STEP = 500;
export const km = (meters: number): string => upTo1(meters / 1000);

/** The parts of one row's note, separated; empty parts are left out. Plain text and fragments only, so the note stays one text run. */
export function join(parts: ReactNode[], separator: string): ReactNode {
  const kept = parts.filter((part) => part != null && part !== false && part !== "");
  return kept.length ? kept.map((part, index) => <Fragment key={index}>{index ? separator : ""}{part}</Fragment>) : null;
}

export interface ValueRowsInput {
  purchase: Purchase;
  /** How the purchase compared with the market then (the sale page's benchmark), already worded. */
  paidThen: ReactNode;
  /** The owner's price updated with the municipality: the medians then and now, their ratio, and the national change for context. */
  anchored: number | null; localThen: number | null; localNow: number | null; localFactor: number | null; national: number | null;
  /** The headline's basis (market, local or garage band), and whether a garage's updated price disagrees with it. */
  reference: (ValueBand & { kind: "market" | "local" | "garage" }) | null; garageMismatch: boolean;
  /** The municipality's medians are still loading, or could not be loaded (then the row says so instead of "too few sales"). */
  waiting: boolean; failed: boolean;
  market: MarketEstimate | null; trustedMarket: boolean; wideRadius: number | null; districtBand: boolean;
  /** "v občini Ljubljana" / "v četrtni skupnosti Jarše", and the municipality's words for the updated-purchase row. */
  where: ReactNode; municipalWhere: ReactNode;
  /** A sale page's context was loaded (so "no similar sales" is a finding, not a missing load). */
  hasContext: boolean;
  local: ValueBand | null; localSales: number; garageSource: Typical | null;
  /** The row that carries the "osnova ocene" chip, and the condition note it gets. */
  basisKey: string | null; worseNote: string | null;
  /** The purchase × the national index, shown only when nothing local exists. */
  indexed: number | null;
}

/** "266.000–314.000 €" / "€266,000–€314,000" */
export function span(low: number, high: number, english: boolean): string {
  return english ? `${euro(roundThousand(low))}–${euro(roundThousand(high))}` : `${integer(roundThousand(low))}–${euro(roundThousand(high))}`;
}

export function buildValueRows(input: ValueRowsInput, english: boolean): ValueRow[] {
  const { purchase, market, reference, local } = input;
  const garage = purchase.group === "garage";
  const year = purchase.date.slice(0, 4);
  const sold = (sales: number) => count(sales, NOUN_FORMS.prodaja);
  const unit = garage ? t("€ na enoto") : "€/m²";
  const rows: ValueRow[] = [{ key: "purchase", title: t("Vaš nakup ({year})", { year }), value: euro(purchase.price),
    note: join([!garage && `${integer(purchase.price / purchase.area)}\u00a0€/m²`, input.paidThen], ", ") }];
  const updatedTitle = tx("Posodobljen s cenami {where}", { where: input.municipalWhere });
  if (input.anchored != null && input.localThen != null && input.localNow != null && input.localFactor != null) {
    rows.push({ key: "updated", title: updatedTitle, value: euro(roundThousand(input.anchored)),
      note: join([t("mediana {then} → {now} {unit} ({change})", { then: integer(input.localThen), now: integer(input.localNow), unit, change: percentSigned(input.localFactor - 1) }),
        input.national != null && t("v vsej Sloveniji {national}", { national: percentSigned(input.national - 1) })], ", ") });
  } else if (input.garageMismatch) {
    rows.push({ key: "updated", title: updatedTitle, value: null, note: t("Vaše nakupne cene ne posodabljamo z gibanjem cen garaž: mediana na enoto meša nova parkirna mesta in starejše garaže.") });
  } else if (reference) {
    // While the municipality's medians are still loading (or failed) the row must not claim there were too few sales.
    rows.push({ key: "updated", title: updatedTitle, value: null,
      note: input.waiting ? t("Nalagam …") : input.failed ? t("cen v občini trenutno ni bilo mogoče naložiti") : t("premalo prodaj te vrste v občini ob nakupu ali danes") });
  }
  if (market) {
    const confidence = market.confidence === "moderate" ? t("zanesljivost srednja") : market.confidence === "low" ? t("zanesljivost nizka") : t("zanesljivost zelo nizka");
    // Comparables from a wide area are said to be so; untrusted ones (very low reliability, under 10 sales) are shown but never lead.
    const caveat = !input.trustedMarket ? t("premalo ali preveč različne, zato ocena ne temelji na njih")
      : input.wideRadius == null ? null
      : reference?.kind === "local" && input.districtBand ? tx("iz širše okolice, zato ocena temelji na cenah {where}", { where: input.where })
      : t("iz širše okolice, zato lahko odstopajo od cen v vaši soseski");
    // Only sales concluded after the owner's purchase, when there were enough of them: the row says since when.
    const since = market.comparablesAfter ? t("prodaje po {date}", { date: date(market.comparablesAfter) }) : null;
    rows.push({ key: "market", title: SIMILAR_TODAY[purchase.group], value: span(market.lowerTotal, market.upperTotal, english),
      note: join([`${t("{sales} do {distance} km", { sales: sold(market.comparableCount), distance: km(market.maximumRadiusMeters) })}, ${confidence}`, since, caveat, input.basisKey === "market" && input.worseNote], " · ") });
  } else if (!purchase.transactionId) rows.push({ key: "market", title: SIMILAR_TODAY[purchase.group], value: null, note: t("za ročno vnesen nakup podobnih prodaj ne iščemo") });
  else if (input.hasContext) rows.push({ key: "market", title: SIMILAR_TODAY[purchase.group], value: null, note: t("v okolici ni dovolj podobnih prodaj {type} za primerjavo", { type: OF_TYPE[purchase.group] }) });
  if (local) rows.push(garage
    ? { key: "local", title: tx("Tipična garaža {where}", { where: input.where }), value: euro(Math.round(local.mid / GARAGE_STEP) * GARAGE_STEP),
      note: input.garageSource?.pooled ? t("mediana, {sales} v zadnjih 3 letih", { sales: sold(input.localSales) }) : t("mediana, {sales} v zadnjih 12 mesecih", { sales: sold(input.localSales) }) }
    : { key: "local", title: tx("Cene {where} za {area} m²", { where: input.where, area: upTo1(purchase.area) }), value: span(local.low, local.high, english),
      note: join([t("srednja polovica, {sales} v zadnjih 12 mesecih", { sales: sold(input.localSales) }), input.basisKey === "local" && input.worseNote], " · ") });
  // The national index never makes the headline: with nothing local it is only a rough note (never for garages, whose index mixes kinds of parking).
  const hasEvidence = !!(market || local || input.anchored != null);
  if (!hasEvidence && input.indexed != null && !garage) rows.push({ key: "index", title: t("Vaš nakup × indeks cen za vso Slovenijo (samo za orientacijo)"), value: euro(roundThousand(input.indexed)),
    note: t("Za oceno vaše nepremičnine ni dovolj lokalnih podatkov; indeks za vso Slovenijo je le groba orientacija.") });
  return rows;
}
