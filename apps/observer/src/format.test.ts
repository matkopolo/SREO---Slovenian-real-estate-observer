import { expect, it } from "vitest";
import { change, date, dateCompact, day, distance, instalment, landArea, median, month, percent, percentPoints, percentSigned, perSqm, titleCase, todayIso, withUnit } from "./format";

it("formats percent with one sign rule: gains signed on request, losses always, zero never", () => {
  expect(percent(0.098, { signed: true })).toBe("+9,8 %");
  expect(percent(-0.05)).toBe("−5,0 %");
  expect(percent(-0.0001, { signed: true })).toBe("0,0 %");
  expect(percent(0.5, { digits: "upTo1" })).toBe("50 %");
});

it("formats amounts, areas and dates", () => {
  expect(perSqm(4538.4)).toBe("4.538");
  expect(perSqm(7.74)).toBe("7,7");
  expect(landArea(24400)).toBe("2,44 ha");
  expect(landArea(900)).toBe("900 m²");
  expect(date("2026-06-30")).toBe("30. 6. 2026");
  expect(dateCompact("2026-10-01T00:00:00Z")).toBe("1.\u00a010.\u00a02026");
});

it("has one median, one change and one instalment", () => {
  expect(median([410, 1250, 1250, 2195])).toBe(1250);
  expect(median([1, 2, 3, 10])).toBe(2.5);
  expect(median([])).toBeNull();
  expect(change(110, 100)).toBeCloseTo(0.1);
  expect(change(110, 0)).toBeNull();
  expect(instalment(120000, 0, 10)).toBe(1000);
  expect(instalment(200000, 3.6, 30)).toBeCloseTo(909.29, 1);
});

it("title-cases register names, keeping street words lower case", () => {
  expect(titleCase("DUNAJSKA CESTA")).toBe("Dunajska cesta");
  expect(titleCase("CESTA V MESTNI LOG")).toBe("Cesta v Mestni Log");
  expect(titleCase("GORENJA VAS")).toBe("Gorenja vas");
  expect(titleCase("NAŠA ULICA")).toBe("Naša ulica");
  expect(titleCase("SPODNJE GAMELJNE-TACEN")).toBe("Spodnje Gameljne-Tacen");
});

it("never reads a division by zero as a percent, and shares one signed helper", () => {
  expect(percentSigned(0.1)).toBe("+10,0\u00a0%");
  expect(percentPoints(45.56)).toBe("+45,6\u00a0%");
  expect(percent(Number.NaN)).toBe("—");
  expect(percent(Number.POSITIVE_INFINITY, { signed: true })).toBe("—");
});

it("shows a missing or malformed date as a dash instead of throwing", () => {
  expect(day("2026-06-30")?.getDate()).toBe(30);
  expect(day("")).toBeNull();
  expect(day("n/a")).toBeNull();
  expect(day("2026-13-01")).toBeNull();
  expect(date(null)).toBe("—");
  expect(date("ni podatka")).toBe("—");
  expect(dateCompact(undefined)).toBe("—");
  expect(month("2026-13-40")).toBe("—");
  expect(month("2026-08-01")).toBe("avgust 2026");
});

it("names today in the reader's own calendar, not in UTC", () => {
  // 00:30 on 2 July in Slovenia (UTC+2) is still 1 July in UTC.
  expect(todayIso(new Date(2026, 6, 2, 0, 30))).toBe("2026-07-02");
  expect(todayIso(new Date(2026, 0, 5))).toBe("2026-01-05");
});

it("joins a number and its unit with a non-breaking space, and never prints a missing value as 0", () => {
  expect(withUnit("2.965", "€/m²")).toBe("2.965\u00a0€/m²");
  expect(withUnit(61.7, "m²")).toBe("61,7\u00a0m²");
  expect(withUnit(0, "m²")).toBe("0\u00a0m²");
  expect(withUnit(null, "€/m²")).toBe("—");
  expect(withUnit(undefined, "m²")).toBe("—");
  expect(withUnit(Number.NaN, "m²")).toBe("—");
  expect(distance(800)).toBe("800\u00a0m");
  expect(distance(1250)).toBe("1,3\u00a0km");
});
