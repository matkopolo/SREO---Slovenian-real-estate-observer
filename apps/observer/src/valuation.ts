import type { Distribution, PropertyGroup, StatisticsOverview, TransactionContext } from "./api";

/**
 * The value check's decision, without the page: which evidence leads today's estimate, whether the owner's price can be
 * updated with the local market, and where a worse condition moves the value. Pure, so every branch is unit-tested.
 */

/** Comparables are "from the wider area" beyond this radius. */
const WIDE_RADIUS_METERS = 3000;
/** A district's own figures replace the municipality's (and wide-area comparables) from this many sales or rentals. */
export const DISTRICT_MIN_SAMPLE = 30;

export type ValueBand = { low: number; mid: number; high: number };
type Reference = ValueBand & { kind: "market" | "local" | "garage" };
type MarketEstimate = NonNullable<TransactionContext["currentMarketEstimate"]>;
export type Typical = { sale?: StatisticsOverview; pooled: boolean };

export interface ValuationInput {
  purchase: { price: number; area: number; group: PropertyGroup };
  market: MarketEstimate | null;
  /** The municipality's figures (garages: its typical garage, possibly pooled over 3 years). */
  municipal: { sale?: StatisticsOverview; pooled?: boolean; spread?: Distribution };
  /** The district's figures, when the property lies in one. */
  district?: { spread?: Distribution; typical?: Typical };
  /** The municipality's median around the purchase (to update the owner's price). */
  then?: StatisticsOverview;
  /** The owner ticked "worse than average". */
  poorCondition: boolean;
  /** The type has a condition question (land: none; garages: valued by one typical price). */
  hasCondition: boolean;
}

export interface Valuation {
  reference: Reference | null;
  /** The local band (district or municipality) and how many sales it comes from. */
  local: ValueBand | null; localSales: number;
  /** The district's evidence replaces the municipality's. */
  useDistrict: boolean; districtBand: ValueBand | null;
  /** For a garage: the typical garage used (district or municipality). */
  garageSource: Typical | null;
  trustedMarket: MarketEstimate | null; wideRadius: number | null;
  /** The municipal median per unit now and around the purchase, and their ratio. */
  localNow: number | null; localThen: number | null; localFactor: number | null;
  /** The owner's price updated with the local market (null when it disagrees with a garage's typical price). */
  anchored: number | null; garageMismatch: boolean;
  asksCondition: boolean; worse: boolean;
  /** The headline: the reference (moved to its lower quarter for a worse condition), else the updated purchase. */
  answer: ValueBand | null;
}

export function chooseReference({ purchase, market, municipal, district, then, poorCondition, hasCondition }: ValuationInput): Valuation {
  const garage = purchase.group === "garage";
  // Garages are priced per unit (the typical garage), everything else per m².
  const unitPrice = (overview?: StatisticsOverview) => overview?.isPublishable ? (garage ? overview.medianPrice : overview.medianPricePerSqm) ?? null : null;
  const localNow = unitPrice(municipal.sale);
  const localThen = unitPrice(then);
  const localFactor = localNow && localThen ? localNow / localThen : null;

  // The local evidence: the narrowest area with enough sales — the district (≥ 30 sales; for garages a published typical price), else the municipality.
  const bandOf = (spread?: Distribution): ValueBand | null => {
    const percentiles = spread?.isPublishable ? spread.percentiles : undefined;
    return percentiles?.p50 != null ? { low: (percentiles.p25 ?? percentiles.p50) * purchase.area, mid: percentiles.p50 * purchase.area, high: (percentiles.p75 ?? percentiles.p50) * purchase.area } : null;
  };
  const districtBand = !garage && district && (district.spread?.sampleSize ?? 0) >= DISTRICT_MIN_SAMPLE ? bandOf(district.spread) : null;
  const districtGarage = garage && district?.typical?.sale?.isPublishable && district.typical.sale.medianPrice != null ? district.typical : null;
  const garageSource = districtGarage ?? (garage && localNow != null ? { sale: municipal.sale, pooled: !!municipal.pooled } : null);
  const garagePrice = garageSource?.sale?.medianPrice ?? null;
  const local: ValueBand | null = garage ? (garagePrice != null ? { low: garagePrice, mid: garagePrice, high: garagePrice } : null) : districtBand ?? bandOf(municipal.spread);
  const localSales = garage ? garageSource?.sale?.priceSampleSize ?? garageSource?.sale?.transactionCount ?? 0 : (districtBand ? district?.spread : municipal.spread)?.sampleSize ?? 0;

  // The headline is the evidence: similar sales when they are trusted (not very low reliability, at least 10 sales) and close by, else the local band.
  // Comparables from a wide area (> 3 km) give way to the district's own band when it has enough sales. For a garage the typical garage leads.
  const trustedMarket = market && market.confidence !== "very_low" && market.comparableCount >= 10 ? market : null;
  const wideRadius = market && market.maximumRadiusMeters > WIDE_RADIUS_METERS ? market.maximumRadiusMeters : null;
  const fromMarket: Reference | null = trustedMarket && { low: trustedMarket.lowerTotal, mid: trustedMarket.centralTotal, high: trustedMarket.upperTotal, kind: "market" };
  const fromLocal: Reference | null = local && { ...local, kind: garage ? "garage" : "local" };
  const reference = garage ? fromLocal ?? fromMarket : fromMarket && !(wideRadius != null && districtBand) ? fromMarket : fromLocal ?? fromMarket;

  // Only the local change updates the owner's price: a national index applied to one unit can be far off (garages, small towns).
  // A garage's per-unit median mixes new parking spaces with old garages, so its updated price is shown only when it agrees with the typical garage (±25 %).
  const updated = localFactor != null ? purchase.price * localFactor : null;
  const garageMismatch = garage && updated != null && reference != null && Math.abs(updated / reference.mid - 1) > 0.25;
  const anchored = garageMismatch ? null : updated;

  // Condition: ticked, the value moves to the lower quarter of the evidence (never towards what the owner once paid).
  const asksCondition = hasCondition && reference != null && reference.low < reference.mid * 0.99;
  const worse = asksCondition && poorCondition;
  const answer: ValueBand | null = reference ? (worse ? { low: reference.low, mid: reference.low, high: reference.mid } : reference)
    : anchored != null ? { low: anchored, mid: anchored, high: anchored } : null;
  return { reference, local, localSales, useDistrict: !!(districtBand || districtGarage), districtBand, garageSource, trustedMarket, wideRadius,
    localNow, localThen, localFactor, anchored, garageMismatch, asksCondition, worse, answer };
}
