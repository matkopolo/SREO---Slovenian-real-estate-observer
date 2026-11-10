import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ValueCheck } from "./ValueCheck";
import { stubApi } from "../test/api-stub";
import { clearApiCache } from "../api";

const municipalities = [{ id: 133, level: "municipality", name: "Ljubljana", parentId: 8, gursEid: "x" }] as const;
const building = { cadastralMunicipalityCode: 1734, buildingNumber: "1710", constructionYear: 1980, knownBuildingPartCount: 40,
  settlement: "LJUBLJANA", street: "DUNAJSKA CESTA", houseNumber: "221", houseNumberSuffix: null, longitude: 14.51, latitude: 46.09,
  sales: { transactionCount: 1, representativeCount: 1 }, rentals: { transactionCount: 0, representativeCount: 0 }, saleHistory: [], rentalHistory: [],
  saleTransactions: [{ transactionId: 14, contractDate: "2021-06-30", propertyGroup: "apartment", area: 61, amount: 130000, amountPerSqm: 2131, representative: true }],
  rentalTransactions: [] };
const overview = { transactionCount: 5685, pricePerSqmSampleSize: 5245, medianPricePerSqm: 2965.78, isPublishable: true };
const market = { lowerTotal: 266375, centralTotal: 289052, upperTotal: 313826, comparableCount: 85, maximumRadiusMeters: 10000,
  areaTolerancePercent: 15, constructionYearTolerance: 8, confidence: "moderate" };
let context: Record<string, unknown>;
let propertyGroup: string;

let api: ReturnType<typeof stubApi>;
const saleOf = (price: number, area: number, geographies: unknown[] = [{ id: 133, level: "municipality", name: "Ljubljana" }]) =>
  () => ({ transactionId: 14, contractDate: "2021-06-30", price, area, propertyGroup, geographies });
const INDEX = { items: [{ period: "2021-06-01", indexValue: 100, isPublishable: true }, { period: "2026-08-01", indexValue: 150, isPublishable: true }] };

beforeEach(() => {
  context = { benchmarks: [], directComparables: [], currentMarketEstimate: market };
  propertyGroup = "apartment";
  api = stubApi([
    { path: "/api/v1/buildings/1734/1710/statistics", body: building },
    { path: "/api/v1/sales/transactions/14", body: saleOf(130000, 61) },
    { path: "/api/v1/sales/transactions/14/context", body: () => context },
    { path: "/api/v1/sales/transactions/14/history", body: { assets: [] } },
    { path: "/api/v1/valuations/sale/14", body: { predictedTotal: 153000 } },
    { path: "/api/v1/indices", body: INDEX },
    { path: "/api/v1/rentals/statistics/overview", body: {} },
    { path: "/api/v1/statistics/overview", body: overview },
    { path: "/api/v1/statistics/distribution", body: { isPublishable: false } },
    { path: "/api/v1/rentals/statistics/distribution", body: { isPublishable: false } },
    { path: "/api/v1/economy/inflation-factor", body: { factor: 1.03 } },
    { path: "/api/v1/buildings/search", body: { items: [], count: 0, matchType: "none", requestedHouseNumber: null, streets: [], settlements: [] } },
  ]);
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); expect(api.unmatched).toEqual([]); });

const open = () => render(<ValueCheck building={{ ko: 1734, st: "1710" }} transactionId={14} municipalityId={133} cutoff="2026-06-30"
  municipalities={[...municipalities]} onBuilding={() => undefined} onTransaction={() => undefined}/>);

it("leads with the similar-sales value, explains my purchase with the sale page's benchmark and moves to the lower quarter on poor condition", async () => {
  context = { ...context, contractYear: 2021, incompletePeriod: false, benchmarks: [
    { scope: "nearby", label: "Primerljivi posli v krogu 500 m", radiusMeters: 500, medianAmountPerSqm: 2933, sampleSize: 14, differencePercent: -27.4, period: 2021, isPublishable: false, comparisonProfile: "area_15_age_8" },
    { scope: "settlement", label: "Ljubljana", medianAmountPerSqm: 2926, sampleSize: 200, differencePercent: -27.2, period: 2021, isPublishable: true, comparisonProfile: "area_15_age_8" },
  ] };
  open();
  expect(await screen.findByRole("heading", { level: 2, name: /^Ocena danes: okoli 289\.000\s€\s*\(verjetno\s*266\.000–314\.000\s€\s*\)$/ })).toBeInTheDocument();
  expect(screen.getByText(/^Osnova ocene: mediana 85 podobnih prodaj v okolici\.$/)).toBeInTheDocument();
  const own = await screen.findByText(/Vaš nakup 2021 \(130\.000\s€\), posodobljen z gibanjem cen v občini Ljubljana: 130\.000\s€\./);
  // The same basis as the sale page ("27 % pod mediano podobnih stanovanj v naselju Ljubljana"), never the statistical model.
  expect(own).toHaveTextContent(/Ob nakupu \(2021\) je bila cena na m² 27 % pod mediano podobnih stanovanj v naselju Ljubljana \(2\.?926\s€\/m²\)\. Zato je vaša posodobljena nakupna cena nižja od današnje ocene\./);
  expect(own).not.toHaveTextContent(/statističnega modela/);
  expect(screen.queryByRole("button", { name: "Zapri" })).not.toBeInTheDocument();          // the explorer bar's "Nazaj na pregled trga" closes it
  fireEvent.click(screen.getByRole("checkbox", { name: "Stanovanje je v slabšem stanju od povprečnega (ni obnovljeno)" }));
  expect(await screen.findByRole("heading", { level: 2, name: /^Ocena danes: okoli 266\.000\s€\s*\(verjetno\s*266\.000–289\.000\s€\s*\)$/ })).toBeInTheDocument();
  expect(screen.getByText(/Slabše stanje: ocena je na spodnjem robu podobnih prodaj \(spodnja četrtina, 266\.000\s€\) namesto na mediani \(289\.000\s€\)/)).toBeInTheDocument();
  expect(screen.getByLabelText("Prodajna cena (€)")).toHaveValue("266.000");      // the sale scenario uses the headline, formatted
  expect(screen.getByText(/Podobne prodaje so iz širše okolice, do 10 km/)).toBeInTheDocument();
});

it("falls back to the municipal band when similar sales are not trusted, and never to the national index", async () => {
  context = { ...context, currentMarketEstimate: { ...market, confidence: "very_low" } };
  api.prepend([{ path: "/api/v1/statistics/distribution", body: { isPublishable: true, sampleSize: 900, percentiles: { p25: 4000, p50: 4500, p75: 5000 } } }]);
  open();
  const heading = await screen.findByRole("heading", { level: 2, name: /Ocena danes/ });
  expect(heading).not.toHaveTextContent("195.000");                         // 130.000 € × index 1,5
  expect(screen.getByText(/Podobnih prodaj je premalo ali so si preveč različne/)).toBeInTheDocument();
});

it("asks about condition for a house and skips the question for land", async () => {
  propertyGroup = "house";
  open();
  expect(await screen.findByRole("checkbox", { name: "Hiša je v slabšem stanju od povprečne (ni obnovljena)" })).toBeInTheDocument();
  cleanup();
  clearApiCache();                                      // the same sale, now of land
  propertyGroup = "land";
  open();
  await screen.findByRole("heading", { level: 2, name: /Ocena danes/ });
  expect(screen.queryByRole("checkbox", { name: /slabšem stanju/ })).not.toBeInTheDocument();
});

it("offers every property type and says plainly when the building has no sale of that type", async () => {
  render(<ValueCheck building={{ ko: 1734, st: "1710" }} municipalityId={133} cutoff="2026-06-30" municipalities={[...municipalities]}
    onBuilding={() => undefined} onTransaction={() => undefined}/>);
  const types = await screen.findByRole("group", { name: "Vrsta nepremičnine" });
  for (const name of ["Stanovanje", "Hiša", "Poslovni prostor", "Garaža / parkirišče", "Zemljišče"]) expect(within(types).getByRole("button", { name })).toBeInTheDocument();
  expect(within(types).getByRole("button", { name: "Stanovanje", pressed: true })).toBeInTheDocument();
  expect(screen.getByRole("heading", { level: 2, name: "2. Vaš nakup" })).toHaveFocus();
  expect(screen.getByRole("row", { name: /30\.\s6\.\s2021/ })).toBeInTheDocument();
  fireEvent.click(within(types).getByRole("button", { name: "Garaža / parkirišče" }));
  expect(screen.getByText(/V tej stavbi ni evidentirane prodaje te vrste \(garaža \/ parkirišče\)/)).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Izračunaj vrednost" })).toBeDisabled();
});

it("values a garage per unit from the typical garage in the municipality", async () => {
  propertyGroup = "garage";
  api.prepend([
    { path: "/api/v1/sales/transactions/14", body: saleOf(15000, 14) },
    { path: "/api/v1/sales/transactions/14/context", body: { benchmarks: [], directComparables: [], currentMarketEstimate: null } },
    { path: "/api/v1/statistics/overview", body: { ...overview, medianPrice: 18000, priceSampleSize: 320 } },
  ]);
  open();
  expect(await screen.findByRole("heading", { level: 2, name: /^Ocena danes: okoli 18\.000\s€$/ })).toBeInTheDocument();
  expect(screen.getByText("Tipična garaža v občini Ljubljana").closest("li")).toHaveTextContent("18.000");
  expect(screen.getByText(/V okolici ni dovolj podobnih prodaj garaž in parkirišč za primerjavo/)).toBeInTheDocument();
});

it("focuses the address field when the check opens", async () => {
  render(<ValueCheck municipalityId={133} cutoff="2026-06-30" municipalities={[...municipalities]}
    onBuilding={() => undefined} onTransaction={() => undefined}/>);
  expect(await screen.findByLabelText("Naslov nepremičnine")).toHaveFocus();
});

it("writes a zero tax as 0 €, never −0 €", async () => {
  open();
  await screen.findByRole("heading", { level: 2, name: /Ocena danes/ });
  fireEvent.click(screen.getByRole("button", { name: "Da" }));
  const tax = screen.getByText(/Davek na dobiček/).closest("li")!;
  expect(tax).toHaveTextContent(/0\s€$/);
  expect(tax).not.toHaveTextContent("−0");
});

const jarse = { id: 256, level: "city_district", name: "Četrtna skupnost Jarše" };
it("values a garage from the district's typical garage and leaves out an updated purchase that disagrees with it", async () => {
  propertyGroup = "garage";
  api.prepend([
    { path: "/api/v1/sales/transactions/14", body: saleOf(18000, 14, [{ id: 133, level: "municipality", name: "Ljubljana" }, jarse]) },
    { path: "/api/v1/sales/transactions/14/context", body: { benchmarks: [], directComparables: [], currentMarketEstimate: null } },
    { path: "/api/v1/statistics/overview", query: { geographyId: "256" }, body: { isPublishable: true, medianPrice: 18000, priceSampleSize: 40 } },
    { path: "/api/v1/statistics/overview", query: (query) => query.get("to")?.startsWith("2021") ?? false, body: { isPublishable: true, medianPrice: 9000, priceSampleSize: 300 } },   // around the purchase
    { path: "/api/v1/statistics/overview", body: { ...overview, medianPrice: 24000, priceSampleSize: 397 } },
  ]);
  open();
  expect(await screen.findByRole("heading", { level: 2, name: /^Ocena danes: okoli 18\.000\s€$/ })).toBeInTheDocument();
  expect(screen.getByText(/^Osnova ocene: tipična cena garaže v četrtni skupnosti Jarše\.$/)).toBeInTheDocument();
  expect(screen.getByText("Tipična garaža v četrtni skupnosti Jarše").closest("li")).toHaveTextContent("iz 40 prodaj");
  // 18.000 € × (24.000 / 9.000) = 48.000 €, far from the typical garage: not shown, and said why.
  expect(screen.queryByText(/Vaš nakup, posodobljen z gibanjem cen/)).not.toBeInTheDocument();
  expect(screen.getByText(/ne posodabljamo z gibanjem cen garaž/)).toBeInTheDocument();
  expect(screen.queryByRole("checkbox", { name: /slabšem stanju/ })).not.toBeInTheDocument();
  expect(screen.getByText(/Ocena ne pozna lege garaže/)).toBeInTheDocument();
});

it("prefers the district band over comparables from a wide area, and uses the district rent with the contracts-not-listings note", async () => {
  api.prepend([
    { path: "/api/v1/sales/transactions/14", body: saleOf(130000, 61, [{ id: 133, level: "municipality", name: "Ljubljana" }, jarse]) },
    { path: "/api/v1/rentals/statistics/overview", query: { geographyId: "256" }, body: { isPublishable: true, medianMonthlyRentPerSqm: 10, rentPerSqmSampleSize: 362 } },
    { path: "/api/v1/rentals/statistics/overview", body: { isPublishable: true, medianMonthlyRentPerSqm: 8, rentPerSqmSampleSize: 6000 } },
    { path: "/api/v1/statistics/distribution", query: { geographyId: "256" }, body: { isPublishable: true, sampleSize: 78, percentiles: { p25: 4000, p50: 4500, p75: 5000 } } },
    { path: "/api/v1/statistics/distribution", body: { isPublishable: true, sampleSize: 1687, percentiles: { p25: 3900, p50: 4600, p75: 5400 } } },
  ]);
  open();
  // 4.000 / 4.500 / 5.000 €/m² × 61 m²
  expect(await screen.findByRole("heading", { level: 2, name: /^Ocena danes: okoli 275\.000\s€\s*\(verjetno\s*244\.000–305\.000\s€\s*\)$/ })).toBeInTheDocument();
  expect(screen.getByText(/Podobne prodaje so iz širše okolice, do 10 km, zato ocena temelji na prodajah v četrtni skupnosti Jarše\./)).toBeInTheDocument();
  expect(screen.getByText(/Cene v četrtni skupnosti Jarše za 61,0 m²/).closest("li")).toHaveTextContent("iz 78 prodaj");
  expect(await screen.findByRole("heading", { level: 2, name: /Če bi jo oddali: okoli 610\s€ na mesec/ })).toBeInTheDocument();
  expect(screen.getByText(/Srednja polovica najemnin v četrtni skupnosti Jarše za 61,0\sm²/)).toBeInTheDocument();
  expect(screen.getByText(/ne oglasi: oglasne najemnine so običajno višje/)).toBeInTheDocument();
});

it("warns about a house in a building of many units, merges duplicate rows and marks non-market prices", async () => {
  const sales = [
    { transactionId: 21, contractDate: "2012-11-08", propertyGroup: "apartment", area: 50.4, amount: 63000, amountPerSqm: 1250, representative: true },
    { transactionId: 22, contractDate: "2012-11-08", propertyGroup: "apartment", area: 50.4, amount: 63000, amountPerSqm: 1250, representative: true },
    { transactionId: 23, contractDate: "2017-08-14", propertyGroup: "apartment", area: 122, amount: 50000, amountPerSqm: 410, representative: true },
    { transactionId: 24, contractDate: "2019-06-12", propertyGroup: "apartment", area: 82, amount: 180000, amountPerSqm: 2195, representative: true },
  ];
  api.prepend([{ path: "/api/v1/buildings/1734/1710/statistics", body: { ...building, knownBuildingPartCount: 11, saleTransactions: sales } },
    { path: "/api/v1/sales/transactions/21", body: saleOf(63000, 50.4) }]);
  render(<ValueCheck building={{ ko: 1734, st: "1710" }} municipalityId={133} cutoff="2026-06-30" municipalities={[...municipalities]}
    onBuilding={() => undefined} onTransaction={() => undefined}/>);
  const types = await screen.findByRole("group", { name: "Vrsta nepremičnine" });
  expect(screen.getAllByRole("row", { name: /8\.\s11\.\s2012/ })).toHaveLength(1);
  expect(screen.getByRole("row", { name: /8\.\s11\.\s2012/ })).toHaveTextContent("2 enaka vpisa – verjetno isti posel");
  expect(screen.getByRole("row", { name: /14\.\s8\.\s2017/ })).toHaveTextContent("neobičajno nizka cena – verjetno ni tržni posel");
  expect(screen.getByRole("row", { name: /12\.\s6\.\s2019/ })).not.toHaveTextContent(/nizka cena|statistiki/);
  fireEvent.click(within(types).getByRole("button", { name: "Hiša" }));
  expect(screen.getByText(/Stavba ima 11 enot – je vaša nepremičnina res hiša\?/)).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Izberi stanovanje" }));
  expect(within(types).getByRole("button", { name: "Stanovanje", pressed: true })).toBeInTheDocument();
  expect(screen.queryByText(/res hiša/)).not.toBeInTheDocument();
});

it("offers sale price presets, formats the price and labels the own-home exemption plainly", async () => {
  open();
  await screen.findByRole("heading", { level: 2, name: /Ocena danes/ });
  const presets = screen.getByRole("group", { name: "Prodajna cena iz ocene" });
  expect(within(presets).getByRole("button", { name: /Ocena 289\.000/, pressed: true })).toBeInTheDocument();
  fireEvent.click(within(presets).getByRole("button", { name: /Zgornja meja 314\.000/ }));
  const price = screen.getByLabelText("Prodajna cena (€)");
  expect(price).toHaveValue("314.000");
  fireEvent.focus(price);
  expect(price).toHaveValue("314000");
  fireEvent.change(price, { target: { value: "300.500" } });
  fireEvent.blur(price);
  expect(price).toHaveValue("300.500");
  fireEvent.click(screen.getByRole("button", { name: "Da" }));
  expect(screen.getByText("Davek na dobiček – oproščen (vaš dom)").closest("li")).toHaveTextContent(/0\s€$/);
  expect(screen.getByText("Ostane vam po davku in stroških")).toBeInTheDocument();
  expect(screen.getByText(/^To je .* več, kot ste plačali za nakup in vlaganja\./)).toBeInTheDocument();
});
