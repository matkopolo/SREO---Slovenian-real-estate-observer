import { describe, expect, it } from "vitest";
import { marketWindows, parsePeriod, periodWindows, widerPeriods } from "./api";
import { addressLabel, fold } from "./components/AreaSearch";
import { translateLegacyHash } from "./url-state";
import { classBreaks, colorScale, divergingBreaks, layersFor, quantileBreaks } from "./metrics";
import { count, NOUN_FORMS } from "./plural";

describe("scales", () => {
  it("merges legend classes less than 3 % apart and handles equal, negative and empty values", () => {
    expect(classBreaks([])).toEqual([]);
    expect(classBreaks([2000, 2000, 2000])).toEqual([2000]);
    expect(classBreaks([4588, 4600, 4650, 4700, 9000])).toEqual([4700, 9000]);   // 4.600 and 4.700 are < 3 % apart
    const negatives = classBreaks([-30, -10, 0, 5, 12]);
    expect(negatives).toEqual([...negatives].sort((a, b) => a - b));
  });
  it("offers wage layers only for homes and only prices and counts for land and garages", () => {
    expect(layersFor("apartment")).toContain("affordableSqm");
    expect(layersFor("commercial")).not.toContain("affordableSqm");
    expect(layersFor("garage")).toEqual(["salePrice", "saleVolume"]);
  });
  it("uses quantile colour bins, a neutral colour for withheld values, and de-duplicated monotone breaks", () => {
    const values = [100, 200, 300, 400, 500, 600, 4000, null];
    const color = colorScale(values);
    expect(color(null)).toBe("#c9cdd1");
    expect(color(100)).not.toBe(color(4000));
    const breaks = quantileBreaks(values);
    expect(breaks).toEqual([...new Set(breaks)].sort((a, b) => a - b));
    expect(quantileBreaks([435, null, null])).toEqual([435]);
  });
  it("keeps one registry artefact from flattening the diverging scale", () => {
    const values = [-58, 4, 5, 6, -3, 2, 1, -1, 3, 2, 4, 5, 6, 3, 2, 1, 2, 3, 4, 5];
    expect(divergingBreaks(values).at(-1)).toBeLessThan(58);
  });
});

describe("Slovenian counts", () => {
  it("agrees in number", () => {
    expect(count(1, NOUN_FORMS.prodaja)).toBe("1 prodaja");
    expect(count(2, NOUN_FORMS.prebivalec)).toBe("2 prebivalca");
    expect(count(3, NOUN_FORMS.stavba)).toBe("3 stavbe");
    expect(count(5, NOUN_FORMS.leto)).toBe("5 let");
    expect(count(101, NOUN_FORMS.posel)).toBe("101 posel");
  });
});

describe("periods and links", () => {
  it("ends sales at the last closed quarter ≥ 3 months before the cutoff, rents at the last full year", () => {
    const windows = marketWindows("2026-10-01");
    expect(windows.sales.current).toEqual({ from: "2025-07-01", to: "2026-06-30" });
    expect(windows.sales.previous).toEqual({ from: "2024-07-01", to: "2025-06-30" });
    expect(windows.rents.year).toBe(2025);
    expect(periodWindows("2026-10-01", 3).sales.current).toEqual({ from: "2023-07-01", to: "2026-06-30" });
    expect(periodWindows("2026-10-01", 3).rents.current).toEqual({ from: "2023-01-01", to: "2025-12-31" });
  });
  it("translates earlier view links into the explorer state", () => {
    expect(translateLegacyHash("#pregled?g=133&vrsta=hise")).toBe("#?g=133&vrsta=hise");
    expect(translateLegacyHash("#posli?ko=1734&st=1710&posel=9")).toBe("#?b=1734-1710&posel=9");
    expect(translateLegacyHash("#dokazi?najem=-5")).toBe("#?najem=-5");
    expect(translateLegacyHash("#kakovost")).toBe("#o-podatkih");
    expect(translateLegacyHash("#trendi")).toBeUndefined();
  });
  it("formats rural addresses and folds diacritics for search", () => {
    expect(addressLabel({ settlement: "KOZJE", houseNumber: "144" })).toBe("Kozje 144");
    expect(addressLabel({ street: "DUNAJSKA CESTA", houseNumber: "219", settlement: "LJUBLJANA" })).toBe("Dunajska cesta 219, Ljubljana");
    expect(fold("Domžale")).toBe(fold("domzale"));
  });
});

import { capitalGainsRate, completedYears, saleScenario } from "./resale";
describe("sale-now scenario", () => {
  it("applies the holding-period rates, own-home exemption, normirani stroški and transfer tax", () => {
    expect(completedYears("2021-06-30", "2026-06-29")).toBe(4);
    expect(completedYears("2021-06-30", "2026-07-01")).toBe(5);
    expect([capitalGainsRate(4, false), capitalGainsRate(5, false), capitalGainsRate(10, false), capitalGainsRate(15, false), capitalGainsRate(3, true)]).toEqual([0.25, 0.2, 0.15, 0, 0]);
    const result = saleScenario({ acquired: "2021-06-30", disposed: "2026-10-01", purchase: 130000, sale: 289000, investments: 0, sellingCosts: 0, loan: 0, ownHome: false, sellerPaysTransferTax: true });
    expect(result.base).toBeCloseTo(289000 - 130000 - 1300 - 2890);
    expect(result.capitalGainsTax).toBe(Math.round((289000 - 134190) * 0.2));
    expect(result.transferTax).toBe(5780);
    expect(result.nextRate).toEqual({ date: "2031-06-30", rate: 0.15 });
    const home = saleScenario({ acquired: "2021-06-30", disposed: "2026-10-01", purchase: 130000, sale: 289000, investments: 20000, sellingCosts: 14104, loan: 90000, ownHome: true, sellerPaysTransferTax: true });
    expect(home.capitalGainsTax).toBe(0);
    expect(home.afterLoan).toBe(289000 - 5780 - 14104 - 90000);
  });
});

describe("chosen year range", () => {
  it("covers whole calendar years, compares with the equally long period before and never pools", () => {
    const windows = periodWindows("2026-10-01", "2019-2021");
    expect(windows.sales.current).toEqual({ from: "2019-01-01", to: "2021-12-31" });
    expect(windows.sales.previous).toEqual({ from: "2016-01-01", to: "2018-12-31" });
    expect(windows.rents.current).toEqual({ from: "2019-01-01", to: "2021-12-31" });
    expect(windows.custom).toBe(true);
    expect(widerPeriods("2019-2021")).toEqual([]);
    expect(widerPeriods(1)).toEqual([3, 5]);
  });
  it("labels the period, leaves out a previous period before the data starts and drops a range that ends before rentals", () => {
    const year = periodWindows("2026-10-01", 1);
    expect(year.label).toBe("v 12 mesecih do 30. 6. 2026");
    expect(year.rentYears).toBe("2025");
    expect(periodWindows("2026-10-01", "2007-2008").sales.previous).toBeNull();
    expect(periodWindows("2026-10-01", "2026-2026").label).toMatch(/^v obdobju 1\. 1\. 2026–30\. 6\. 2026 \(del leta\)$/);
    const early = periodWindows("2026-10-01", "2008-2010");
    expect(early.rentYears).toBe("—");
    expect(early.rents.previous).toBeNull();
    expect(periodWindows("2026-10-01", 5).sales.current).toEqual({ from: "2021-07-01", to: "2026-06-30" });
  });
  it("stops at the lag-aware end and clamps rents to their first and last reported year", () => {
    const windows = periodWindows("2026-10-01", "2010-2026");
    expect(windows.sales.current.to).toBe("2026-06-30");
    expect(windows.rents.current).toEqual({ from: "2013-01-01", to: "2025-12-31" });
    expect(parsePeriod("2021", "2019")).toBeUndefined();
    expect(parsePeriod("2000", "2005")).toBeUndefined();
    expect(parsePeriod("2019", "2021")).toBe("2019-2021");
  });
});
