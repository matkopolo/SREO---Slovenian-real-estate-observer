import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { App } from "./App";
import { emptyLists, stubApi } from "../test/api-stub";

// jsdom has no WebGL: the map is replaced by buttons that fire the same callbacks.
vi.mock("./ExplorerMap", () => ({
  default: ({ onArea, onBuilding }: { onArea: (id: number) => void; onBuilding: (key: string) => void }) => <div>
    <button type="button" onClick={() => onArea(137)}>zemljevid: Maribor</button>
    <button type="button" onClick={() => onBuilding("1734-1710")}>zemljevid: stavba</button>
  </div>,
}));

const boundaries = { type: "FeatureCollection", features: [
  { type: "Feature", properties: { id: 133, name: "Ljubljana" }, geometry: { type: "Polygon", coordinates: [[[14.4, 46], [14.6, 46], [14.6, 46.1], [14.4, 46]]] } },
  { type: "Feature", properties: { id: 137, name: "Maribor" }, geometry: { type: "Polygon", coordinates: [[[15.6, 46.5], [15.7, 46.5], [15.7, 46.6], [15.6, 46.5]]] } },
] };
const municipalities = [{ id: 133, level: "municipality", name: "Ljubljana", parentId: 8 }, { id: 137, level: "municipality", name: "Maribor", parentId: 2 },
  { id: 129, level: "municipality", name: "Kranjska Gora", parentId: 9 }, { id: 52, level: "municipality", name: "Kranj", parentId: 9 }];
const regions = [{ id: 8, level: "statistical_region", name: "Osrednjeslovenska", parentId: 1 }, { id: 2, level: "statistical_region", name: "Podravska", parentId: 1 },
  { id: 9, level: "statistical_region", name: "Gorenjska", parentId: 1 }];
const overview = { transactionCount: 5685, pricePerSqmSampleSize: 5245, medianPricePerSqm: 2965.78, medianPrice: 179990, medianArea: 60.8, isPublishable: true };
const previous = { ...overview, transactionCount: 5000, medianPricePerSqm: 2700 };
const rent = { transactionCount: 3509, rentPerSqmSampleSize: 2362, medianMonthlyRentPerSqm: 8.17, isPublishable: true };
const building = { cadastralMunicipalityCode: 1734, buildingNumber: "1710", constructionYear: 2023, knownBuildingPartCount: 430,
  settlement: "LJUBLJANA", street: "DUNAJSKA CESTA", houseNumber: "221", houseNumberSuffix: null, longitude: 14.51, latitude: 46.09,
  sales: { transactionCount: 3, representativeCount: 2 }, rentals: { transactionCount: 0, representativeCount: 0 }, saleHistory: [], rentalHistory: [],
  saleTransactions: [
    { transactionId: 11, contractDate: "2026-03-11", propertyGroup: "apartment", area: 68.2, amount: 410000, amountPerSqm: 6012, representative: true },
    { transactionId: 12, contractDate: "2026-03-03", propertyGroup: "apartment", area: 43.3, amount: 249000, amountPerSqm: 5751, representative: true },
    { transactionId: 13, contractDate: "2025-12-01", propertyGroup: "garage", area: 12.5, amount: 26840, amountPerSqm: 2147, representative: true },
  ], rentalTransactions: [] };
const district = { id: 266, level: "city_district", name: "Četrtna skupnost Bežigrad", parentId: 133 };
const byId: Record<string, unknown> = { 266: district, 133: municipalities[0], 137: municipalities[1], 129: municipalities[2], 8: regions[0], 2: regions[1], 9: regions[2] };

const collection = { type: "FeatureCollection", features: [] };
const saleDetail = { transactionId: 14, contractDate: "2021-06-30", price: 130000, area: 61, propertyGroup: "apartment",
  geographies: [{ id: 133, level: "municipality", name: "Ljubljana" }], buildingParts: [{ id: 1, cadastralMunicipalityCode: 1734, buildingNumber: "1710" }] };
const market = { lowerTotal: 266375, centralTotal: 289052, upperTotal: 313826, comparableCount: 85, maximumRadiusMeters: 10000, areaTolerancePercent: 15,
  constructionYearTolerance: 8, confidence: "moderate" };
let api: ReturnType<typeof stubApi>;

beforeEach(() => {
  window.location.hash = "";
  api = stubApi([
    { path: "/api/v1/data-status", body: { activeRelease: { analyticsSaleThrough: "2026-10-01T00:00:00Z" } } },
    { path: "/api/v1/geographies", query: { level: "municipality" }, body: { items: municipalities } },
    { path: "/api/v1/geographies", query: { level: "statistical_region" }, body: { items: regions } },
    { path: "/api/v1/geographies", query: { level: "city_district" }, body: { items: [district] } },
    { path: "/api/v1/geographies/boundaries", body: boundaries },
    { path: /^\/api\/v1\/geographies\/\d+\/children$/, body: { items: [] } },
    { path: /^\/api\/v1\/geographies\/\d+$/, body: (url: URL) => byId[url.pathname.split("/").at(-1)!] },
    { path: "/api/v1/map/geographies", body: collection },
    { path: "/api/v1/rentals/map/geographies", body: collection },
    { path: "/api/v1/statistics/overview", query: { from: "2024-07-01" }, body: previous },
    { path: "/api/v1/statistics/overview", body: overview },
    { path: "/api/v1/rentals/statistics/overview", body: rent },
    { path: "/api/v1/statistics/distribution", body: { isPublishable: false, buckets: [] } },
    { path: "/api/v1/rentals/statistics/distribution", body: { isPublishable: false, buckets: [] } },
    { path: "/api/v1/affordability", body: {} },
    { path: "/api/v1/demographics", body: {} },
    { path: "/api/v1/economy/inflation-factor", body: { factor: 1.03 } },
    { path: "/api/v1/indices", body: { items: [{ period: "2021-06-01", indexValue: 100, isPublishable: true }, { period: "2026-08-01", indexValue: 150, isPublishable: true }] } },
    { path: "/api/v1/buildings/1734/1710/statistics", body: building },
    { path: "/api/v1/sales/transactions/14", body: saleDetail },
    { path: "/api/v1/sales/transactions/11", body: { ...saleDetail, transactionId: 11 } },
    { path: "/api/v1/anomalies/summary", body: { total: 100, flagged: 4, highPriority: 1 } },
    ...emptyLists("/api/v1/anomalies", "/api/v1/statistics/outliers", "/api/v1/rentals/statistics/outliers"),
    { path: "/api/v1/sales/transactions/14/context", body: { benchmarks: [], directComparables: [], currentMarketEstimate: market } },
    { path: "/api/v1/sales/transactions/14/history", body: { assets: [] } },
    { path: "/api/v1/valuations/sale/14", body: {} },
    { path: "/api/v1/buildings/search", body: { items: [], count: 0, matchType: "none", requestedHouseNumber: null, streets: [], settlements: [] } },
    { path: "/api/v1/transactions/recent", body: { items: [], total: 0 } },
    ...emptyLists("/api/v1/statistics/timeseries", "/api/v1/rentals/statistics/timeseries", "/api/v1/demographics/municipalities", "/api/v1/construction/map",
      "/api/v1/affordability/municipalities"),
  ]);
});
afterEach(() => {
  cleanup(); vi.unstubAllGlobals();
  expect(api.unmatched).toEqual([]);   // every request the page made is one the test knows
});

const fetched = (part: string) => api.fetched(part);

it("opens on Slovenija: median, change, real change and a flats/houses pair on lag-aware periods", async () => {
  render(<App/>);
  expect(await screen.findByRole("heading", { level: 1, name: "Slovenija" })).toBeInTheDocument();
  // One copy check; the rest asserts the numbers.
  const lede = await screen.findByText(/Mediana cene stanovanj v 12 mesecih do 30\. 6\. 2026/);
  expect(lede).toHaveTextContent("2966");
  expect(lede).toHaveTextContent(/\+9,8\s%/);                                   // 2965,78 / 2700 − 1
  expect(lede).toHaveTextContent(/\+6,6\s%/);                                   // real: 1,0984 / 1,03 − 1
  const pair = screen.getByRole("group", { name: /Vrsta nepremičnine/ });
  expect(within(pair).getAllByRole("button", { pressed: true })).toHaveLength(1);
  expect(fetched("from=2025-07-01&to=2026-06-30")).toBe(true);
  expect(fetched("from=2024-07-01&to=2025-06-30")).toBe(true);
  expect(fetched("/rentals/statistics/overview?from=2025-01-01&to=2025-12-31")).toBe(true);
});

it("drills into an area from the map with a real history entry and a breadcrumb", async () => {
  render(<App/>);
  await screen.findByRole("heading", { level: 1, name: "Slovenija" });
  fireEvent.click(await screen.findByRole("button", { name: "zemljevid: Maribor" }));
  expect(await screen.findByRole("heading", { level: 1, name: "Maribor" })).toBeInTheDocument();
  expect(window.location.hash).toBe("#?g=137");
  const crumbs = screen.getByRole("navigation", { name: "Pot do območja" });
  expect(within(crumbs).getByRole("link", { name: "Slovenija" })).toBeInTheDocument();
});

it("opens a building with its flat sales only (garages are a separate type)", async () => {
  window.location.hash = "#?b=1734-1710";
  render(<App/>);
  expect(await screen.findByRole("heading", { level: 1, name: "Dunajska cesta 221, Ljubljana" })).toBeInTheDocument();
  expect(screen.getByText(/2 prodaji stanovanj v letih \d{4}–\d{4}/)).toBeInTheDocument();
  expect(screen.getByRole("combobox", { name: "Vrsta nepremičnine" })).toHaveTextContent("garaža / parkirišče (1)");
});

it("translates earlier links (#pregled, #kakovost)", async () => {
  window.location.hash = "#pregled?g=133";
  render(<App/>);
  expect(await screen.findByRole("heading", { level: 1, name: "Ljubljana" })).toBeInTheDocument();
  expect(window.location.hash).toBe("#?g=133");
  cleanup();
  window.location.hash = "#kakovost";
  render(<App/>);
  expect(await screen.findByRole("heading", { level: 1, name: "O podatkih" })).toBeInTheDocument();
});

it("the area search does not jump while typing a longer name, and Enter takes the best match", async () => {
  render(<App/>);
  await screen.findByRole("heading", { level: 1, name: "Slovenija" });
  const search = screen.getByRole("combobox", { name: /Poiščite občino, (četrtno skupnost, )?regijo ali naslov/ });
  fireEvent.input(search, { target: { value: "Kranj" }, inputType: "insertText" });
  expect(window.location.hash).toBe("");
  fireEvent.input(search, { target: { value: "kranjska gora" }, inputType: "insertText" });
  fireEvent.submit(search.closest("form")!);
  expect(await screen.findByRole("heading", { level: 1, name: "Kranjska Gora" })).toBeInTheDocument();
});

it("a city district (three parent areas) renders instead of crashing", async () => {
  window.location.hash = "#?g=266";
  render(<App/>);
  expect(await screen.findByRole("heading", { level: 1, name: /Bežigrad/ })).toBeInTheDocument();
  const crumbs = screen.getByRole("navigation", { name: "Pot do območja" });
  expect(within(crumbs).getByRole("link", { name: "Ljubljana" })).toBeInTheDocument();
  expect(within(crumbs).getByRole("link", { name: "Osrednjeslovenska" })).toBeInTheDocument();
  expect(await screen.findByRole("heading", { level: 2, name: /stane .* let neto mediane plače|Dostopnost/ })).toBeInTheDocument();
  expect(screen.queryByText("Tega območja ni bilo mogoče prikazati.")).not.toBeInTheDocument();
});

it("leads today's value with similar sales and moves it to the lower quarter of similar sales for a worse condition", async () => {
  window.location.hash = "#?vrednost=1&b=1734-1710&posel=14";
  render(<App/>);
  expect(await screen.findByRole("heading", { level: 1, name: "Koliko je vredna vaša nepremičnina?" })).toBeInTheDocument();
  expect(await screen.findByRole("heading", { level: 2, name: /Ocena danes: okoli 289\.000\s€\s*\(verjetno\s*266\.000–314\.000\s€\s*\)/ })).toBeInTheDocument();
  // The stubbed municipal median is the same then and now, so the purchase updated with the local market stays 130.000 €.
  expect(await screen.findByText(/Vaš nakup 2021 \(130\.000\s€\), posodobljen z gibanjem cen v občini/)).toBeInTheDocument();
  fireEvent.click(screen.getByRole("checkbox", { name: /je v slabšem stanju od povprečnega/ }));
  expect(await screen.findByRole("heading", { level: 2, name: /Ocena danes: okoli 266\.000\s€\s*\(verjetno\s*266\.000–289\.000\s€\s*\)/ })).toBeInTheDocument();
  expect(screen.getByText("Podobne nepremičnine danes").closest("li")).toHaveTextContent("85 podobnih prodaj");
});

it("Back from a sale opened in the recent list returns to the area (no trapped history)", async () => {
  window.location.hash = "#?g=133";
  render(<App/>);
  await screen.findByRole("heading", { level: 1, name: "Ljubljana" });
  window.history.pushState(null, "", "#?g=133&posel=14");
  window.dispatchEvent(new PopStateEvent("popstate"));
  await screen.findByRole("heading", { level: 2, name: "Stavba: Dunajska cesta 221, Ljubljana" });   // the sale brings its building
  await new Promise((resolve) => setTimeout(resolve, 50));
  window.history.back();
  await new Promise((resolve) => setTimeout(resolve, 50));
  expect(window.location.hash).toBe("#?g=133");
});

it("covers land (by use), commercial premises and garages, and keeps them in the link", async () => {
  window.location.hash = "#?vrsta=zemljisca&raba=kmetijska";
  render(<App/>);
  await screen.findByRole("heading", { level: 1, name: "Slovenija" });
  const types = screen.getByRole("group", { name: /Vrsta nepremičnine/ });
  expect(within(types).getByRole("button", { name: /Zemljišča \(kmetijska\)/i, pressed: true })).toBeInTheDocument();
  expect(within(types).getByRole("button", { name: /Poslovni prostori/ })).toBeInTheDocument();
  expect(within(types).getByRole("button", { name: /Garaže in parkirišča/ })).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Kmetijska", pressed: true })).toBeInTheDocument();
  expect(fetched("propertyGroup=land&landScope=agricultural")).toBe(true);
  expect(screen.queryByText(/let neto mediane plače/)).not.toBeInTheDocument();     // affordability is for homes only
  fireEvent.click(within(types).getByRole("button", { name: /Poslovni prostori/ }));
  expect(window.location.hash).toContain("vrsta=poslovni");
});

it("the value check adds what renting it out would bring", async () => {
  window.location.hash = "#?vrednost=1&b=1734-1710&posel=14";
  render(<App/>);
  expect(await screen.findByRole("heading", { level: 2, name: /Če bi jo oddali: okoli 500\s€ na mesec/ })).toBeInTheDocument();   // 8,17 × 61 m²
});

it("a deep link shows a loading state, never Slovenija, and needs no geography request for a listed area", async () => {
  window.location.hash = "#?g=266";
  render(<App/>);
  expect(screen.queryByRole("heading", { level: 1, name: "Slovenija" })).not.toBeInTheDocument();
  expect(await screen.findByRole("heading", { level: 1, name: /Bežigrad/ })).toBeInTheDocument();
  expect(fetched("/geographies/266")).toBe(false);                  // district, municipality and region come from the lists
  // Identical requests are shared: the national overview is asked once, however many panels show it.
  const national = api.calls.filter((url) => url === "/api/v1/statistics/overview?from=2025-07-01&to=2026-06-30&propertyGroup=apartment");
  expect(national.length).toBeLessThanOrEqual(1);
});
