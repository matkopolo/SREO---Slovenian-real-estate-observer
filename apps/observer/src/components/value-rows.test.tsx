import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { buildValueRows, type ValueRowsInput } from "./value-rows";

const market = { lowerTotal: 266375, centralTotal: 289052, upperTotal: 313826, comparableCount: 85, maximumRadiusMeters: 2000,
  lowerAmountPerSqm: 4300, centralAmountPerSqm: 4700, upperAmountPerSqm: 5100, referenceYear: 2026, areaTolerancePercent: 15, constructionYearTolerance: 8,
  confidence: "moderate", comparables: [], subjectLongitude: 14.5, subjectLatitude: 46 } as unknown as NonNullable<ValueRowsInput["market"]>;
const base: ValueRowsInput = {
  purchase: { price: 130000, date: "2021-06-30", area: 61, group: "apartment", transactionId: 14 }, paidThen: null,
  anchored: 195000, localThen: 2000, localNow: 3000, localFactor: 1.5, national: 1.4,
  reference: { kind: "market", low: 266375, mid: 289052, high: 313826 }, garageMismatch: false, waiting: false, failed: false,
  market, trustedMarket: true, wideRadius: null, districtBand: false, where: "v občini Ljubljana", municipalWhere: "v občini Ljubljana", hasContext: true,
  local: { low: 244000, mid: 274500, high: 305000 }, localSales: 900, garageSource: null, basisKey: "market", worseNote: null, indexed: 180000,
};
const text = (node: React.ReactNode) => render(<div>{node}</div>).container.textContent ?? "";

describe("value rows", () => {
  it("lists the purchase, the updated purchase, the similar sales and the local band, in that order", () => {
    const rows = buildValueRows(base, false);
    expect(rows.map((row) => row.key)).toEqual(["purchase", "updated", "market", "local"]);
    expect(rows[0].value).toBe("130.000\u00a0€");
    expect(rows[1].value).toBe("195.000\u00a0€");
    expect(text(rows[1].note)).toBe("mediana 2.000 → 3.000 €/m² (+50,0\u00a0%), v vsej Sloveniji +40,0\u00a0%");
    expect(rows[2].value).toBe("266.000–314.000\u00a0€");
    expect(text(rows[2].note)).toBe("85 prodaj do 2 km, zanesljivost srednja");
    expect(rows[3].value).toBe("244.000–305.000\u00a0€");
    // The national index never appears beside local evidence.
    expect(rows.some((row) => row.key === "index")).toBe(false);
  });
  it("says the municipality is still loading or could not be loaded instead of claiming too few sales", () => {
    const pending = buildValueRows({ ...base, anchored: null, waiting: true }, false);
    expect(text(pending.find((row) => row.key === "updated")?.note)).toBe("Nalagam\u00a0…");
    const broken = buildValueRows({ ...base, anchored: null, failed: true }, false);
    expect(text(broken.find((row) => row.key === "updated")?.note)).toBe("cen v občini trenutno ni bilo mogoče naložiti");
    const thin = buildValueRows({ ...base, anchored: null }, false);
    expect(text(thin.find((row) => row.key === "updated")?.note)).toBe("premalo prodaj te vrste v občini ob nakupu ali danes");
  });
  it("explains why similar sales are missing: a typed purchase, or none found in a loaded context", () => {
    const manual = buildValueRows({ ...base, market: null, purchase: { ...base.purchase, transactionId: undefined } }, false);
    expect(text(manual.find((row) => row.key === "market")?.note)).toBe("za ročno vnesen nakup podobnih prodaj ne iščemo");
    const none = buildValueRows({ ...base, market: null }, false);
    expect(text(none.find((row) => row.key === "market")?.note)).toBe("v okolici ni dovolj podobnih prodaj stanovanj za primerjavo");
    const unloaded = buildValueRows({ ...base, market: null, hasContext: false }, false);
    expect(unloaded.some((row) => row.key === "market")).toBe(false);
  });
  it("falls back to the national index only when nothing local exists, never for a garage", () => {
    const nothing = { ...base, anchored: null, market: null, local: null, reference: null, hasContext: false };
    expect(buildValueRows(nothing, false).map((row) => row.key)).toEqual(["purchase", "index"]);
    const garage = buildValueRows({ ...nothing, purchase: { ...base.purchase, group: "garage" } }, false);
    expect(garage.map((row) => row.key)).toEqual(["purchase"]);
  });
  it("prices a garage by its typical unit; the English layout puts the currency on both ends of a range", () => {
    const garage = buildValueRows({ ...base, purchase: { ...base.purchase, group: "garage", area: 12 }, market: null, hasContext: false,
      local: { low: 18250, mid: 18250, high: 18250 }, garageSource: { pooled: true }, localSales: 7, reference: { kind: "garage", low: 18250, mid: 18250, high: 18250 } }, true);
    const local = garage.find((row) => row.key === "local");
    expect(local?.value).toBe("18.500\u00a0€");
    expect(text(local?.note)).toContain("3 letih");
    // Amounts follow the page locale (Slovenian in tests); the English layout repeats the currency on both ends.
    expect(buildValueRows(base, true).find((row) => row.key === "market")?.value).toBe("266.000\u00a0€–314.000\u00a0€");
  });
});
