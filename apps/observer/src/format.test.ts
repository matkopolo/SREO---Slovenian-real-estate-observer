import { expect, it } from "vitest";
import { change, date, dateCompact, instalment, landArea, median, percent, perSqm, titleCase } from "./format";

it("formats percent with one sign rule: gains signed on request, losses always, zero never", () => {
  expect(percent(0.098, { signed: true })).toBe("+9,8 %");
  expect(percent(-0.05)).toBe("−5,0 %");
  expect(percent(-0.0001, { signed: true })).toBe("0,0 %");
  expect(percent(0.5, { digits: "upTo1" })).toBe("50 %");
});

it("formats amounts, areas and dates", () => {
  expect(perSqm(4538.4)).toBe("4538");
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
