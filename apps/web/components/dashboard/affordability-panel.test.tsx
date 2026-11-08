import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { loadAffordability } from "@/lib/api";
import type { Affordability } from "@/lib/types";
import { AffordabilityPanel } from "./affordability-panel";

vi.mock("@/lib/api", () => ({ loadAffordability: vi.fn() }));
afterEach(() => { cleanup(); vi.resetAllMocks(); });

const observation = (series: string, value: number, period = "2026M09") =>
  ({ series, value, period, sourceTable: "Banka Slovenije I2_4_3AS" });
const data: Affordability = {
  wageGeography: { key: "municipality:70", name: "Maribor", nationalFallback: false },
  wagePeriod: "2025M10", wageSource: "SURS 0711357S",
  rule: { validFrom: "2026-01-01", dstiMax: 0.5, minRemainingIncome: 745, recommendedLtv: 0.8, sourceUrl: "https://www.bsi.si", note: "" },
  rates: { fixedOver10Years: observation("housing_rate_fixed_10y", 3.27), variable: observation("housing_rate_variable", 3.47),
    aprc: observation("housing_rate_aprc", 3.79), euribor6m: { ...observation("euribor_6m", 2.97, "2026-10"), sourceTable: "ECB" } },
  stressMarginPoints: 1,
  market: { propertyGroup: "apartment", year: 2025, medianPricePerSqm: 2000, sampleSize: 812, isPublishable: true },
  rows: [
    { band: { id: "p50", netMonthlyIncome: 1326 }, maxInstalment: 581, floorBinding: true, loan20Years: 102000, loan30Years: 133000,
      loan30YearsVariable: 130000, loan30YearsStress: 118000, priceAtRecommendedLtv: 166250, downPayment: 33250, affordableSqm: 83, twoEarnersLoan30Years: 266000 },
    { band: { id: "p90", netMonthlyIncome: 2522 }, maxInstalment: 1261, floorBinding: false, loan20Years: 222000, loan30Years: 289000,
      loan30YearsVariable: 282000, loan30YearsStress: 256000, priceAtRecommendedLtv: 361250, downPayment: 72250, affordableSqm: 181, twoEarnersLoan30Years: 578000 },
  ],
  disclaimer: "Statistična ponazoritev, ne ponudba kredita ali osebna ocena kreditne sposobnosti.",
};

it("shows sources, binding limits and the m² each band can afford", async () => {
  vi.mocked(loadAffordability).mockResolvedValue(data);
  render(<AffordabilityPanel geographyId={70} areaName="Maribor" propertyGroup="apartment"/>);
  const table = await screen.findByRole("table");
  const median = within(table).getByRole("rowheader", { name: /Mediana/ }).closest("tr")!;
  expect(median).toHaveTextContent("omejuje ostanek 745");
  expect(median).toHaveTextContent("133.000");
  expect(median).toHaveTextContent("166.250");   // 133 000 / 0.8
  expect(median).toHaveTextContent("83 m²");     // 166 250 / 2 000
  expect(within(table).getByRole("rowheader", { name: /90\. percentil/ }).closest("tr")).toHaveTextContent("omejuje 50 % dohodka");
  expect(screen.getByText(/ne ponudba kredita/)).toBeInTheDocument();
  expect(screen.getByText(/SURS · 10\/2025/)).toBeInTheDocument();
  expect(screen.getByText(/812/)).toBeInTheDocument();
  expect(loadAffordability).toHaveBeenCalledWith(70, "apartment", expect.any(AbortSignal));
});

it("switches the term and recomputes price, down payment and area", async () => {
  vi.mocked(loadAffordability).mockResolvedValue(data);
  render(<AffordabilityPanel geographyId={70} areaName="Maribor" propertyGroup="apartment"/>);
  await screen.findByRole("table");
  fireEvent.click(screen.getByRole("button", { name: "20 let" }));
  const median = screen.getByRole("rowheader", { name: /Mediana/ }).closest("tr")!;
  expect(median).toHaveTextContent("102.000");
  expect(median).toHaveTextContent("127.500");   // 102 000 / 0.8
  expect(median).toHaveTextContent("64 m²");
  expect(screen.queryByText(/o\. t\./)).not.toBeInTheDocument(); // stress column only for 30 years
});

it("keeps a suppressed median and a national fallback visible", async () => {
  vi.mocked(loadAffordability).mockResolvedValue({
    ...data, wageGeography: { key: "SI", name: "Slovenija", nationalFallback: true },
    market: { ...data.market, medianPricePerSqm: null, isPublishable: false },
  });
  render(<AffordabilityPanel geographyId={5} areaName="Kamnik" propertyGroup="apartment"/>);
  expect(await screen.findByText(/uporabljene so plače za Slovenijo/)).toBeInTheDocument();
  expect(screen.getByText(/ni objavljena \(premajhen vzorec\)/)).toBeInTheDocument();
  expect(screen.getByRole("rowheader", { name: /Mediana/ }).closest("tr")).toHaveTextContent("—");
});

it("reports missing official data without hiding the market", async () => {
  vi.mocked(loadAffordability).mockRejectedValue(new Error("503"));
  render(<AffordabilityPanel areaName="Slovenija" propertyGroup="house"/>);
  expect(await screen.findByRole("alert")).toHaveTextContent("še niso naloženi");
});
