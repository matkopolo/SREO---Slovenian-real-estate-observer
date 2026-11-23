import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import { axisFormat, Columns, Histogram, LineChart, niceTicks, rangeTicks, roundLabel, stepDecimals } from "./charts";
import { Missing, tooFew, withheld } from "./Missing";

afterEach(cleanup);

it("labels axis ticks with the decimals their step needs, so 2,5 never reads as 3", () => {
  expect(niceTicks(10)).toEqual([2.5, 5, 7.5, 10]);
  expect(stepDecimals(2.5)).toBe(1);
  expect(stepDecimals(0.25)).toBe(2);
  expect(stepDecimals(500)).toBe(0);
  expect(niceTicks(10).map(axisFormat(niceTicks(10)))).toEqual(["2,5", "5,0", "7,5", "10,0"]);
  expect(niceTicks(4000).map(axisFormat(niceTicks(4000)))).toEqual(["1.000", "2.000", "3.000", "4.000"]);
  // Floating-point steps (0,1 × 3) still read cleanly.
  expect(niceTicks(0.3, 3).map(axisFormat(niceTicks(0.3, 3)))).toEqual(["0,1", "0,2", "0,3"]);
});

it("rounds a histogram's end labels and adds round ticks inside the range", () => {
  expect(roundLabel(33005)).toBe(33000);
  expect(roundLabel(1234567)).toBe(1200000);
  const ticks = rangeTicks(33005, 612000);
  expect(ticks.length).toBeGreaterThanOrEqual(2);
  expect(ticks.length).toBeLessThanOrEqual(3);
  for (const tick of ticks) expect(tick % 50000).toBe(0);
});

it("marks open end bins with ≤ and ≥ and lists every bucket in a table", () => {
  render(<Histogram unit="€/m²" label="Porazdelitev" open={{ below: true, above: true }}
    buckets={[{ lower: 1000, upper: 2000, count: 4 }, { lower: 2000, upper: 3000, count: 9 }, { lower: 3000, upper: 4000, count: 2 }]}/>);
  const rows = within(screen.getByRole("table")).getAllByRole("row");
  expect(rows).toHaveLength(4);
  expect(rows[1]).toHaveTextContent(/≤ 2\.000\s€\/m²/);
  expect(rows[3]).toHaveTextContent(/≥ 3\.000\s€\/m²/);
});

it("reads a line chart out by year from the keyboard, in a status region rendered empty first", () => {
  render(<LineChart unit="€/m²" label="Mediana" series={[{ name: "Ljubljana", className: "c-price", points: [{ x: 2023, y: 4000 }, { x: 2024, y: 4400 }] },
    { name: "Slovenija", className: "ref-country", points: [{ x: 2023, y: 2600 }, { x: 2024, y: null }] }]}/>);
  const status = screen.getByRole("status");
  expect(status).toHaveTextContent("");
  fireEvent.keyDown(screen.getByRole("img", { name: "Mediana" }), { key: "End" });
  expect(status).toHaveTextContent(/2024; Ljubljana: 4\.400\s€\/m²; Slovenija: premalo prodaj/);
});

it("says which months are still being reported, in the readout and the table", () => {
  render(<Columns unit="prodaj" label="Prodaje" items={[{ period: "2026-07-01", value: 400 }, { period: "2026-08-01", value: 120, incomplete: true }]}/>);
  expect(within(screen.getByRole("table")).getAllByRole("row")[2]).toHaveTextContent("120 (še se dopolnjuje)");
  fireEvent.keyDown(screen.getByRole("img", { name: "Prodaje" }), { key: "ArrowLeft" });
  expect(screen.getByRole("status")).toHaveTextContent(/avgust 2026; 120\sprodaj \(še se dopolnjuje\)/);
});

it("shows a missing value as a dash that screen readers hear as 'ni podatka', and names thin samples one way", () => {
  render(<p>{"Cena: "}<Missing/></p>);
  expect(screen.getByText("—")).toHaveAttribute("aria-hidden", "true");
  expect(screen.getByText("ni podatka")).toHaveClass("sr-only");
  expect(tooFew("sale")).toBe("premalo prodaj");
  expect(tooFew("sale", 12)).toBe("premalo prodaj (12)");
  expect(tooFew("rent", 3)).toBe("premalo najemov (3)");
  expect(withheld("sale", 0)).toBe("ni prodaj");
  expect(withheld("rent", 0)).toBe("ni najemov");
});
