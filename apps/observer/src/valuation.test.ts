import { describe, expect, it } from "vitest";
import { chooseReference, type ValuationInput } from "./valuation";

const market = { lowerTotal: 266375, centralTotal: 289052, upperTotal: 313826, comparableCount: 85, maximumRadiusMeters: 2000,
  areaTolerancePercent: 15, constructionYearTolerance: 8, confidence: "moderate" } as NonNullable<ValuationInput["market"]>;
const spread = (sampleSize: number, p25: number, p50: number, p75: number) => ({ isPublishable: true, sampleSize, percentiles: { p25, p50, p75 } }) as never;
const sale = (extra: Record<string, unknown>) => ({ isPublishable: true, ...extra }) as never;
const flat = (extra: Partial<ValuationInput> = {}): ValuationInput => ({ purchase: { price: 130000, area: 61, group: "apartment" }, market,
  municipal: { sale: sale({ medianPricePerSqm: 3000 }), spread: spread(900, 4000, 4500, 5000) }, then: sale({ medianPricePerSqm: 2000 }),
  poorCondition: false, hasCondition: true, ...extra });

describe("value check reference", () => {
  it("leads with trusted similar sales and updates the purchase with the local market", () => {
    const result = chooseReference(flat());
    expect(result.reference).toMatchObject({ kind: "market", mid: 289052 });
    expect(result.anchored).toBeCloseTo(195000);                       // 130.000 × 3.000 / 2.000
    expect(result.answer?.mid).toBe(289052);
  });
  it("falls back to the municipal band when similar sales are untrusted", () => {
    const result = chooseReference(flat({ market: { ...market, confidence: "very_low" } }));
    expect(result.reference).toMatchObject({ kind: "local", low: 244000, mid: 274500, high: 305000 });
    expect(result.trustedMarket).toBeNull();
  });
  it("prefers a district with enough sales over comparables from a wide area", () => {
    const wide = { ...market, maximumRadiusMeters: 10000 };
    const result = chooseReference(flat({ market: wide, district: { spread: spread(78, 4000, 4500, 5000) } }));
    expect(result.useDistrict).toBe(true);
    expect(result.reference?.kind).toBe("local");
    expect(result.wideRadius).toBe(10000);
    // A thin district (< 30 sales) leaves the comparables in charge.
    expect(chooseReference(flat({ market: wide, district: { spread: spread(12, 4000, 4500, 5000) } })).reference?.kind).toBe("market");
  });
  it("moves a worse condition to the lower quarter and asks only when the evidence has a spread", () => {
    const result = chooseReference(flat({ poorCondition: true }));
    expect(result.worse).toBe(true);
    expect(result.answer).toEqual({ low: 266375, mid: 266375, high: 289052 });
    expect(chooseReference(flat({ hasCondition: false, poorCondition: true })).asksCondition).toBe(false);
  });
  it("values a garage by the typical garage and drops an updated price that disagrees by more than 25 %", () => {
    const garage = chooseReference({ purchase: { price: 18000, area: 14, group: "garage" }, market: null, poorCondition: false, hasCondition: false,
      municipal: { sale: sale({ medianPrice: 24000, priceSampleSize: 397 }) }, then: sale({ medianPrice: 9000 }),
      district: { typical: { sale: sale({ medianPrice: 18000, priceSampleSize: 40 }), pooled: false } } });
    expect(garage.reference).toMatchObject({ kind: "garage", mid: 18000 });
    expect(garage.localSales).toBe(40);
    expect(garage.garageMismatch).toBe(true);                          // 18.000 × 24.000 / 9.000 = 48.000
    expect(garage.anchored).toBeNull();
  });
  it("answers with the updated purchase alone when there is no local evidence", () => {
    const result = chooseReference(flat({ market: null, municipal: { sale: sale({ medianPricePerSqm: 3000 }) } }));
    expect(result.reference).toBeNull();
    expect(result.answer).toEqual({ low: 195000, mid: 195000, high: 195000 });
  });
});
