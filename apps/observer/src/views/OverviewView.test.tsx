import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { OverviewView } from "./OverviewView";
import { stubApi } from "../test/api-stub";

const municipalities = [
  { id: 133, level: "municipality", name: "Ljubljana", parentId: 8 }, { id: 137, level: "municipality", name: "Maribor", parentId: 2 },
  { id: 52, level: "municipality", name: "Kranj", parentId: 9 }, { id: 61, level: "municipality", name: "Ruše", parentId: 2 },
];
const regions = [{ id: 8, level: "statistical_region", name: "Osrednjeslovenska", parentId: 1 }, { id: 2, level: "statistical_region", name: "Podravska", parentId: 1 }];
const overview = { transactionCount: 5685, pricePerSqmSampleSize: 5245, medianPricePerSqm: 2965.78, medianPrice: 179990, isPublishable: true };
const before = { ...overview, transactionCount: 5000, medianPricePerSqm: 2700 };
const rent = { transactionCount: 3509, rentPerSqmSampleSize: 2362, medianMonthlyRentPerSqm: 8.17, isPublishable: true };
const rentBefore = { ...rent, medianMonthlyRentPerSqm: 7.8 };
const monthPoint = (period: string, count: number, median: number, incomplete = false) => ({ period, transactionCount: count, medianPricePerSqm: median, isPublishable: true, incomplete });
const months = Array.from({ length: 36 }, (_, index) => {
  const date = new Date(Date.UTC(2023, 6 + index, 1));
  return monthPoint(date.toISOString().slice(0, 10), 400 + index, 2500 + index * 10, index >= 34);
});
const years = Array.from({ length: 10 }, (_, index) => ({ period: `${2016 + index}-01-01`, transactionCount: 5000, medianPricePerSqm: 2000 + index * 100, isPublishable: true, incomplete: false }));
const feature = (geographyId: number, median: number, representativeCount: number) => ({ type: "Feature", geometry: null, properties: { geographyId, medianPricePerSqm: median, representativeCount, transactionCount: representativeCount } });
const rentFeature = (geographyId: number, median: number) => ({ type: "Feature", geometry: null, properties: { geographyId, medianMonthlyRentPerSqm: median, representativeCount: 80, transactionCount: 80 } });
const distribution = { metric: "price", sampleSize: 5245, isPublishable: true, belowBoundCount: 0, aboveBoundCount: 0,
  percentiles: { p25: 120000, p50: 180000, p75: 260000 }, buckets: [{ index: 0, from: 50000, to: 150000, count: 2000 }, { index: 1, from: 150000, to: 250000, count: 2500 }, { index: 2, from: 250000, to: 350000, count: 745 }] };
const affordability = { market: { propertyGroup: "apartment", year: 2025, medianPricePerSqm: 3000, sampleSize: 5000, isPublishable: true },
  rows: [{ band: { id: "p50", netMonthlyIncome: 1500 }, affordableSqm: 40 }] };

let api: ReturnType<typeof stubApi>;
beforeEach(() => {
  window.location.hash = "#pregled-trga";
  api = stubApi([
    { path: "/api/v1/geographies", query: { level: "municipality" }, body: { items: municipalities } },
    { path: "/api/v1/geographies", query: { level: "statistical_region" }, body: { items: regions } },
    { path: "/api/v1/statistics/overview", query: { from: "2024-07-01" }, body: before },
    { path: "/api/v1/statistics/overview", body: overview },
    { path: "/api/v1/rentals/statistics/overview", query: { from: "2024-01-01" }, body: rentBefore },
    { path: "/api/v1/rentals/statistics/overview", body: rent },
    { path: "/api/v1/statistics/timeseries", query: { interval: "month" }, body: { items: months } },
    { path: "/api/v1/statistics/timeseries", query: { interval: "year" }, body: { items: years } },
    // Twelve months: Kranj is thin and pooled over five years; Ruše is thin both ways and left out.
    { path: "/api/v1/map/geographies", query: { level: "municipality", from: "2025-07-01" }, body: { type: "FeatureCollection", features: [feature(133, 4200, 3000), feature(137, 2300, 900), feature(52, 2900, 12), feature(61, 2000, 9)] } },
    { path: "/api/v1/map/geographies", query: { level: "municipality" }, body: { type: "FeatureCollection", features: [feature(133, 4000, 15000), feature(137, 2200, 4500), feature(52, 2800, 60), feature(61, 1900, 20)] } },
    { path: "/api/v1/map/geographies", query: { level: "statistical_region" }, body: { type: "FeatureCollection", features: [feature(8, 4000, 5000), feature(2, 2200, 2000)] } },
    { path: "/api/v1/rentals/map/geographies", body: { type: "FeatureCollection", features: [rentFeature(8, 12), rentFeature(2, 9)] } },
    { path: "/api/v1/statistics/distribution", body: distribution },
    { path: "/api/v1/affordability", body: affordability },
  ]);
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); expect(api.unmatched).toEqual([]); });

it("shows the market of Slovenia in four tiles and five charts from the lag-aware periods", async () => {
  render(<OverviewView cutoff="2026-10-01"/>);
  expect(await screen.findByRole("heading", { level: 1, name: "Pregled trga: Slovenija" })).toBeInTheDocument();
  const price = (await screen.findByText("Mediana cene")).closest("div")!;
  expect(price).toHaveTextContent(/2\.?966\s€\/m²/);
  expect(price).toHaveTextContent(/\+9,8\s% proti letu prej/);            // 2965,78 / 2700 − 1
  const rents = screen.getByText("Mediana najemnine").closest("div")!;
  expect(rents).toHaveTextContent(/8,2\s€\/m²/);
  expect(rents).toHaveTextContent(/najemi leta 2025/);
  expect(rents).toHaveTextContent(/\+4,7\s%/);                              // 8,17 / 7,8 − 1
  const sold = screen.getByText("Prodaje v 12 mesecih").closest("div")!;
  expect(sold).toHaveTextContent(/5\.?685/);
  expect(sold).toHaveTextContent(/\+13,7\s%/);
  const wage = screen.getByText("Leta neto plače za 60 m²").closest("div")!;
  expect(wage).toHaveTextContent(/9,9\slet/);                                // 60 × 2.965,78 / 1.500 / 12
  expect(api.fetched("from=2025-07-01&to=2026-06-30")).toBe(true);
  expect(api.fetched("from=2024-07-01&to=2025-06-30")).toBe(true);

  // The ranking: cheapest first, Kranj pooled and marked, Ruše withheld; the bars link to the explorer.
  const cheapest = screen.getByRole("list", { name: "Najcenejše občine" });
  const cheapRows = within(cheapest).getAllByRole("listitem");
  expect(cheapRows[0]).toHaveTextContent(/Maribor.*2\.?300\s€\/m²/);
  expect(cheapRows[1]).toHaveTextContent(/Kranj.*2\.?800\s€\/m².*\(5 let\)/);
  expect(within(cheapest).queryByText("Ruše")).not.toBeInTheDocument();
  expect(within(cheapest).getByRole("link", { name: "Maribor" })).toHaveAttribute("href", "#?g=137");
  const dearest = screen.getByRole("list", { name: "Najdražje občine" });
  expect(within(dearest).getAllByRole("listitem")[0]).toHaveTextContent(/Ljubljana.*4\.?200\s€\/m²/);

  // Rent against purchase: 9 × 12 / 2200 = 4,9 % beats 12 × 12 / 4000 = 3,6 %.
  const yields = within(screen.getByRole("list", { name: "Bruto donos po regijah" })).getAllByRole("listitem");
  expect(yields[0]).toHaveTextContent(/Podravska.*4,9\s%.*najem 9,0\s€\/m²/);
  expect(yields[1]).toHaveTextContent(/Osrednjeslovenska.*3,6\s%/);

  // The histogram names the median; the activity chart lists 36 months with the last two still incomplete.
  expect(screen.getByText(/polovica prodaj med 120\.000\s€ in 260\.000\s€, mediana 180\.000\s€/)).toBeInTheDocument();
  expect(screen.getByRole("img", { name: "Porazdelitev cen poslov, Stanovanja" })).toHaveTextContent("mediana 180.000 €");
  const activity = screen.getByRole("img", { name: "Prodaje stanovanj po mesecih" }).closest("figure")!;
  expect(within(activity).getAllByRole("row")).toHaveLength(37);
  expect(within(activity).getByRole("img")).toBeInTheDocument();
});

it("switches to houses and an area, keeps the address, and prices 120 m² for a house", async () => {
  render(<OverviewView cutoff="2026-10-01"/>);
  await screen.findByRole("heading", { level: 1, name: "Pregled trga: Slovenija" });
  fireEvent.click(screen.getByRole("button", { name: "Hiše" }));
  expect(window.location.hash).toBe("#pregled-trga?vrsta=hise");
  expect(await screen.findByText("Leta neto plače za 120 m²")).toBeInTheDocument();
  expect(api.fetched("propertyGroup=house")).toBe(true);
});
