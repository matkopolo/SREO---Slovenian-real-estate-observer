import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { BuildingStack, TransactionEvidence } from "./BuildingEvidence";
import { googleMapsUrl } from "./TransactionDetails";
import { stubApi } from "../test/api-stub";

const sale = {
  transactionId: 640685, contractDate: "2022-03-01", datasetYear: 2022, propertyGroup: "apartment", area: 109, price: 150000, pricePerSqm: 1376,
  priceDerivation: "package", longitude: 14.06, latitude: 46.43,
  quality: { isQualityEligible: true, isRepresentative: false, reasons: ["non_comparable_package"], anomalyFlags: ["possible_duplicate"] },
  outlier: { status: "outlier", cohortLevel: "municipality_year", cohortSize: 120, cohortMedian: 1800, lowerBound: -10, upperBound: 2900 },
  geographies: [{ id: 1, level: "municipality", name: "Jesenice" }],
  buildingParts: [
    { id: 1, cadastralMunicipalityCode: 2175, buildingNumber: "662", buildingPartNumber: "39", buildingPartTypeDescription: "Stanovanje", constructionYear: 1966,
      floor: "3", positionInBuilding: "nadstropje", roomCount: 3, soldArea: 109, soldUsableArea: null, buildingPartArea: 108.7, usableArea: 99.2,
      outdoorParkingSpaces: null, contractualPrice: null, settlement: "JESENICE", street: "CESTA MARŠALA TITA", houseNumber: "16" },
    { id: 2, cadastralMunicipalityCode: 2175, buildingNumber: "662", buildingPartNumber: "40", buildingPartTypeDescription: "Garaža", soldArea: 7,
      positionInBuilding: "klet", floor: null, roomCount: null, contractualPrice: 9000 },
  ],
  landParcels: [{ id: 3, cadastralMunicipalityCode: 2175, parcelNumber: "369/3", landTypeDescription: "Zemljišče pod stavbo (dvorišče, vrt)", parcelArea: 18, contractualPrice: null }],
};
const context = { transactionKind: "sale", benchmarks: [], directComparables: [
  { transactionId: 555, contractDate: "2022-05-01", contractYear: 2022, area: 87, amount: 270000, amountPerSqm: 3103, areaDifferencePercent: 42.6,
    amountPerSqmDifferencePercent: 45.6, yearDifference: 0, matchTier: "same_building_same_year", isRepresentative: true, outlierStatus: "inlier" }] };
const pair = { transactionId: 640685, previousId: 100, from: "2015-01-29", to: "2022-03-01", days: 2588, comparable: true, previousPrice: 100000, price: 150000,
  nominalChange: 50000, changePercent: 50, landTransition: false };
const event = (transactionId: number, contractDate: string, agreementPrice: number) => ({ transactionId, componentId: 1, contractDate, evidence: "exact_identity",
  propertyGroup: "apartment", sourceType: 2, share: "1/1", area: 100, agreementPrice, componentPrice: null, constructionYear: 1966, componentCount: 1,
  representative: true, possibleDuplicate: false });
const history = { transactionId: 640685, truncated: false, assets: [
  { kind: "building_part", cadastralCode: 2175, number: "662", partNumber: "39", truncated: false, events: [event(100, "2015-01-29", 100000), event(640685, "2022-03-01", 150000)], pairs: [pair] },
  { kind: "building_part", cadastralCode: 2175, number: "662", partNumber: "40", truncated: false, events: [event(640685, "2022-03-01", 150000)], pairs: [pair] }] };
const rental = {
  transactionId: 678918, contractDate: "2023-01-05", rentalStartDate: "2023-02-01", rentalEndDate: "2024-02-28", datasetYear: 2023, propertyGroup: "apartment",
  area: 51.7, monthlyRentReported: 400, monthlyRentExVat: 400, monthlyRentPerSqm: 7.74, rentDerivation: "x", rentalTerm: "fixed", durationMonths: 13,
  operatingCostsIncluded: false, isMarketRent: true, longitude: null, latitude: null,
  quality: { isQualityEligible: true, isRepresentative: true, reasons: [], anomalyFlags: [] }, outlier: { status: "inlier" }, geographies: [],
  spaces: [
    { id: 1, cadastralMunicipalityCode: 1720, buildingNumber: "193", buildingPartNumber: "6", rentedSpaceTypeDescription: "Stanovanje", area: 41.7, usableArea: 41.7,
      contractualRent: null, constructionYear: 1826, settlement: "LJUBLJANA", street: "KRAKOVSKI NASIP", houseNumber: "10" },
    { id: 2, rentedSpaceTypeDescription: "Tehnični ali pomožni prostori", area: 10, usableArea: 10, contractualRent: null }],
};

const flat = {
  transactionId: 1004708, contractDate: "2026-08-17", datasetYear: 2026, propertyGroup: "apartment", area: 61.7, price: 280000, pricePerSqm: 4538.0875,
  priceDerivation: "single_primary_transaction_price", longitude: 14.48, latitude: 46.07,
  quality: { isQualityEligible: true, isRepresentative: true, reasons: [], anomalyFlags: [] }, outlier: { status: "inlier" },
  geographies: [{ id: 133, level: "municipality", name: "Ljubljana" }, { id: 269, level: "city_district", name: "Četrtna skupnost Šiška" }],
  buildingParts: [{ id: 1, cadastralMunicipalityCode: 1739, buildingNumber: "1354", buildingPartNumber: "58", buildingPartTypeDescription: "Stanovanje",
    constructionYear: 1968, floor: null, positionInBuilding: "nadstropje", roomCount: null, soldArea: 61.7, soldUsableArea: null, buildingPartArea: 61.7,
    usableArea: 51.1, outdoorParkingSpaces: null, contractualPrice: null, settlement: "LJUBLJANA", street: "CELOVŠKA CESTA", houseNumber: "143" }],
  landParcels: [],
};
const benchmark = (scope: string, label: string, medianAmountPerSqm: number, sampleSize: number, differencePercent: number, isPublishable: boolean,
  extra: Record<string, unknown> = {}) => ({ scope, label, medianAmountPerSqm, sampleSize, differencePercent, isPublishable, percentile: 42, period: 2026,
  reliability: "moderate", comparisonProfile: "area_15_age_8", ...extra });
const flatContext = { transactionKind: "sale", transactionId: 1004708, contractYear: 2026, incompletePeriod: true, propertyGroup: "apartment", directComparables: [],
  benchmarks: [
    benchmark("country", "Slovenija", 2990, 4089, 51.8, true, { comparisonProfile: "unadjusted" }),
    benchmark("nearby", "Primerljivi posli v krogu 500 m", 4731, 15, -4, false, { radiusMeters: 500 }),
    benchmark("city_district", "Četrtna skupnost Šiška", 4538, 1, 0, true),
    benchmark("settlement", "Ljubljana", 4731, 295, -4.1, true),
  ],
  currentMarketEstimate: { lowerTotal: 264159, centralTotal: 286385, upperTotal: 315573, lowerAmountPerSqm: 4281, centralAmountPerSqm: 4642, upperAmountPerSqm: 5115,
    comparableCount: 52, maximumRadiusMeters: 2500, referenceYear: 2026, confidence: "moderate" },
  valuation: { predictedAmountPerSqm: 4642, lowerAmountPerSqm: 2734, upperAmountPerSqm: 7881, predictedTotal: 286427, lowerTotal: 168718, upperTotal: 486257,
    modelVersion: "x", reliability: "very_low", warnings: [] } };

let api: ReturnType<typeof stubApi>;
beforeEach(() => {
  // Anything else answers 404 (no valuation, no building statistics): the page must cope.
  api = stubApi([
    { path: "/api/v1/sales/transactions/640685", body: sale },
    { path: "/api/v1/sales/transactions/640685/context", body: context },
    { path: "/api/v1/sales/transactions/640685/history", body: history },
    { path: "/api/v1/rentals/transactions/678918", body: rental },
    { path: "/api/v1/rentals/transactions/678918/context", body: { transactionKind: "rent", benchmarks: [], directComparables: [] } },
    { path: "/api/v1/sales/transactions/1004708", body: flat },
    { path: "/api/v1/sales/transactions/1004708/context", body: flatContext },
    { path: "/api/v1/sales/transactions/1004708/history", body: { transactionId: 1004708, truncated: false, assets: [] } },
    { path: "/api/v1/buildings/1739/1354/statistics", body: { constructionYear: 1964 } },
    { path: "/api/v1/economy/inflation-factor", body: { from: "2015-01-01", to: "2022-03-01", factor: 1.2, months: 86, source: "SURS" } },
  ]);
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

it("shows unit details, the package note, quality, history with inflation and building comparables for a sale", async () => {
  render(<TransactionEvidence selected={{ kind: "sale", id: 640685 }} onChoose={() => {}}/>);
  const details = within((await screen.findByRole("heading", { name: "Podrobnosti" })).closest("section")!);
  // The header reads like a listing; the id and cadastral labels wait in the register section.
  expect(screen.getByRole("heading", { level: 2, name: /^Stanovanje 109\sm²\s· 150\.000\s€ · marec 2022$/ })).toBeInTheDocument();
  expect(screen.getByText("Cesta Maršala Tita 16, Jesenice in še 2 dela")).toBeInTheDocument();
  expect(screen.queryByText(/Posel #/)).not.toBeInTheDocument();
  expect(details.getByText("Vrsta").nextSibling).toHaveTextContent("Stanovanje");
  expect(details.getByText(/zajema 3 sestavine \(2 dela stavbe, 1 parcelo\)/)).toBeInTheDocument();
  expect(details.getByText("Nadstropje").nextSibling).toHaveTextContent("3");
  expect(details.getByText("Število sob").nextSibling).toHaveTextContent("3");
  expect(details.getByText("Površina").nextSibling).toHaveTextContent("109 m²");
  expect(details.getByText("Uporabna površina").nextSibling).toHaveTextContent("99,2 m²");
  expect(details.queryByText("Neto površina dela stavbe")).not.toBeInTheDocument();
  expect(details.getByText("Zemljišče skupaj").nextSibling).toHaveTextContent("18 m²");
  expect(details.getByText("Parcela").nextSibling).toHaveTextContent("369/3 (katastrska občina 2175)");
  expect(details.queryByText(/k\. o\./)).not.toBeInTheDocument();
  expect(details.getByText(/velja za vse dele skupaj/)).toBeInTheDocument();
  expect(details.getByText("Garaža")).toBeInTheDocument();
  expect(details.getByText(/cena tega dela/)).toHaveTextContent("9000");
  expect(details.getByText("Zemljišče pod stavbo ali ob njej (dvorišče, vrt)")).toBeInTheDocument();   // plain words, no GURS paragraph

  const register = within(screen.getByText("Podatki iz registra").closest("details")!);
  expect(register.getByText("Številka posla").nextSibling).toHaveTextContent("640685");
  expect(register.getByText("Katastrska oznaka").nextSibling).toHaveTextContent("k. o. 2175, stavba 662, del 39");
  expect(register.getByText("Neto površina dela stavbe").nextSibling).toHaveTextContent("108,7 m²");
  expect(register.queryByText("Prodana uporabna površina")).not.toBeInTheDocument();
  expect(register.getByText("Upoštevan v statistiki").nextSibling).toHaveTextContent("ne");

  const quality = within(screen.getByRole("heading", { name: "Kakovost podatka" }).closest("section")!);
  expect(quality.getByText("Možen podvojen zapis.")).toBeInTheDocument();
  expect(quality.getByText(/združuje različne vrste nepremičnin/)).toBeInTheDocument();
  expect(quality.getByText(/Cena izrazito odstopa od podobnih prodaj/)).toBeInTheDocument();
  const how = within(screen.getByText("Kako smo to izračunali").closest("details")!);
  expect(how.getByText(/običajni razpon 0–2900 €\/m²/)).toBeInTheDocument();

  const historySection = within(screen.getByRole("heading", { name: "Prejšnje prodaje te nepremičnine" }).closest("section")!);
  expect(historySection.getAllByRole("listitem").filter((item) => item.closest(".td-events"))).toHaveLength(2);
  expect(historySection.getByText("ta prodaja")).toBeInTheDocument();
  expect(historySection.getByText(/1000 €\/m²/)).toBeInTheDocument();
  expect(historySection.getByText(/Nominalno: .*50\.000.*\(\+50\s%\)/)).toBeInTheDocument();
  expect(await historySection.findByText(/Po upoštevanju inflacije: .*30\.000.*\(\+25\s%\)/)).toBeInTheDocument();
  expect(historySection.getAllByText(/→/)).toHaveLength(2); // one deduplicated pair: dates and prices

  // The building could not be loaded: the API's matched subset, named as such.
  const comparables = within(screen.getByRole("heading", { name: "Podobne prodaje v isti stavbi" }).closest("section")!);
  expect(comparables.getByText(/^\+45,6\s%$/)).toBeInTheDocument();

  const maps = screen.getByRole("link", { name: /Google Zemljevidih/ });
  expect(maps).toHaveAttribute("target", "_blank");
  expect(maps).toHaveAttribute("rel", expect.stringContaining("noopener"));
  expect(maps.getAttribute("href")).toContain("46.430000%2C14.060000");
  expect(document.body.textContent).not.toMatch(/undefined|null|NaN/);
});

it("shows rental term, operating costs and the shared-rent note for a rental, and links the address without coordinates", async () => {
  render(<TransactionEvidence selected={{ kind: "rent", id: 678918 }} onChoose={() => {}}/>);
  const details = within((await screen.findByRole("heading", { name: "Podrobnosti" })).closest("section")!);
  expect(screen.getByRole("heading", { level: 2, name: /^Stanovanje 51,7\sm²\s· 400\s€ na mesec · januar 2023$/ })).toBeInTheDocument();
  expect(details.getByText("Vrsta oddanega prostora").nextSibling).toHaveTextContent("Stanovanje");
  expect(details.getByText("Trajanje najema").nextSibling).toHaveTextContent("za določen čas, 13 mes.");
  expect(details.getByText("Obratovalni stroški").nextSibling).toHaveTextContent("niso vključeni v najemnino");
  expect(details.queryByText("Najemnina z DDV")).not.toBeInTheDocument();
  expect(details.getByText(/velja za vse prostore skupaj/)).toBeInTheDocument();
  const quality = within(screen.getByRole("heading", { name: "Kakovost podatka" }).closest("section")!);
  expect(quality.getByText(/Najemnina je v običajnem razponu podobnih najemov/)).toBeInTheDocument();
  expect(screen.queryByRole("heading", { name: "Prejšnje prodaje te nepremičnine" })).not.toBeInTheDocument();
  expect(screen.queryByRole("link", { name: /Ocena današnje vrednosti/ })).not.toBeInTheDocument();
  expect(screen.getByRole("link", { name: /Google Zemljevidih/ }).getAttribute("href")).toContain(encodeURIComponent("Krakovski nasip 10, Ljubljana"));
  expect(document.body.textContent).not.toMatch(/undefined|null|NaN/);
});

it("builds no maps link without a usable location", () => {
  expect(googleMapsUrl(0, 0)).toBeUndefined();
  expect(googleMapsUrl(null, 14.5)).toBeUndefined();
  expect(googleMapsUrl(46.05, 14.5)).toContain("46.050000%2C14.500000");
});

it("gives one verdict from the narrowest area with enough sales, never against itself, and folds the rest away", async () => {
  window.location.hash = "#?g=269&posel=1004708";
  render(<TransactionEvidence selected={{ kind: "sale", id: 1004708 }} onChoose={() => {}}/>);
  expect(await screen.findByRole("heading", { level: 2, name: /^Stanovanje 61,7\sm²\s· 280\.000\s€ · avgust 2026$/ })).toBeInTheDocument();
  expect(screen.getByText("Celovška cesta 143, Ljubljana · Šiška")).toBeInTheDocument();
  const verdict = screen.getByRole("region", { name: "Primerjava cene" });
  // The 500 m circle is too small and Šiška holds only this sale; the settlement is the narrowest honest comparison, and the page says why.
  expect(verdict).toHaveTextContent(/Cena na m² je 4 % pod mediano podobnih stanovanj v naselju Ljubljana/);
  expect(verdict).toHaveTextContent(/Mediana 4731\s€\/m² iz 295 drugih prodaj v letu 2026 \(do zdaj\)/);
  expect(verdict).toHaveTextContent(/V četrtni skupnosti Šiška je bilo v letu 2026 premalo podobnih prodaj \(1\)/);
  // No standalone value for this flat: the owner goes to the value check instead.
  expect(screen.queryByText(/286\.385/)).not.toBeInTheDocument();
  const value = screen.getByRole("link", { name: /Je to vaša nepremičnina\? Ocena današnje vrednosti/ });
  expect(value.getAttribute("href")).toBe("#?g=269&b=1739-1354&posel=1004708&vrednost=1");
  const how = within(screen.getByText("Kako smo to izračunali").closest("details")!);
  expect(how.getByText(/primerjava le s to prodajo/)).toBeInTheDocument();
  expect(how.getByText(/premalo za zanesljivo primerjavo/)).toBeInTheDocument();
  expect(how.getByText(/okoli/).textContent).toMatch(/4642\s€\/m²/);
  expect(how.getByText(/Za oceno ni dovolj podobnih prodaj/)).toBeInTheDocument();   // the very-low-reliability model is hidden
  expect(document.body.textContent).not.toMatch(/P25|P75|hedonsk|\(izračun\)|reprezentativ|undefined|NaN/);
  // A bare "nadstropje" is no floor; the second construction year waits in the register with a note.
  const details = within(screen.getByRole("heading", { name: "Podrobnosti" }).closest("section")!);
  expect(details.queryByText("Nadstropje")).not.toBeInTheDocument();
  expect(details.getByText("Leto gradnje").nextSibling).toHaveTextContent("1968");
  const register = within(screen.getByText("Podatki iz registra").closest("details")!);
  expect(await register.findByText("Leto gradnje stavbe")).toBeInTheDocument();
  expect(register.getByText(/dve leti gradnje: 1968 za ta del stavbe in 1964 za stavbo/)).toBeInTheDocument();
  window.location.hash = "";
});

it("counts a building's sales once: header, heading, per-year bars, list and area bar share the type, size band and whole years", () => {
  const year = new Date().getFullYear();
  const sale = (transactionId: number, contractDate: string, area: number, propertyGroup = "apartment", amountPerSqm = 4000) =>
    ({ transactionId, contractDate, propertyGroup, area, amount: area * amountPerSqm, amountPerSqm, representative: true });
  const building = { cadastralMunicipalityCode: 1734, buildingNumber: "1710", constructionYear: 2023, knownBuildingPartCount: 430, settlement: "LJUBLJANA",
    street: "DUNAJSKA CESTA", houseNumber: "221", houseNumberSuffix: null, sales: { transactionCount: 6, representativeCount: 6 },
    rentals: { transactionCount: 0, representativeCount: 0 }, saleHistory: [], rentalHistory: [], rentalTransactions: [],
    saleTransactions: [sale(1, `${year}-04-10`, 50), sale(2, `${year - 1}-05-01`, 60, "apartment", 4200), sale(3, `${year - 1}-06-01`, 90),
      sale(6, `${year - 5}-02-01`, 55, "apartment", 3800), sale(4, `${year - 9}-01-01`, 55), sale(5, `${year}-02-01`, 12, "garage")] };
  render(<BuildingStack building={building as never} onChoose={() => {}} band={{ min: 45, max: 69.99, label: "45–70 m²" }}
    area={{ name: "Bežigrad", p25: 3500, p50: 4100, p75: 4700 }}/>);
  expect(document.querySelector(".be-meta")).toHaveTextContent(`Zgrajena 2023 · 430 enot · zadnja prodaja 4/${year}`);
  const heading = () => document.querySelector(".be-count")!;
  // Whole calendar years: a sale in February five years ago is inside "2021–2026", and its bar is not 0.
  expect(heading()).toHaveTextContent(new RegExp(`^3 prodaje stanovanj v letih ${year - 5}–${year} \\(velikost 45–70 m²\\), mediana 4000 €/m²\\.$`));
  expect(screen.getAllByRole("row")).toHaveLength(4);   // header + 3 sales
  const years = document.querySelector(".be-years")!;
  expect(within(years as HTMLElement).getByText(`${year - 5}: 1`)).toBeInTheDocument();
  expect(within(years as HTMLElement).getByText(`${year}: 1`)).toBeInTheDocument();
  expect(within(years as HTMLElement).getByText(`${year - 1}: 1`)).toBeInTheDocument();
  // One median: the bar uses the same three sales as the heading.
  expect(document.querySelector(".be-area")).toHaveTextContent(/Srednja polovica poslov: 3500–4700 €\/m²; Ta stavba 4000.*Mediana stavbe je iz istih 3 prodaj kot zgoraj, srednja polovica iz prodaj v območju Bežigrad\./);
  fireEvent.click(screen.getByRole("button", { name: "Pokaži vse velikosti" }));
  expect(heading()).toHaveTextContent(new RegExp(`^4 prodaje stanovanj v letih ${year - 5}–${year}, mediana`));
  fireEvent.click(screen.getByRole("button", { name: /Pokaži vse, tudi starejše/ }));
  expect(heading()).toHaveTextContent(new RegExp(`^5 prodaj stanovanj od leta ${year - 9}, mediana`));
  expect(screen.getAllByRole("row")).toHaveLength(6);
});

it("prefers a city district over the whole-city settlement, and a village over its local community", async () => {
  const { chooseBenchmark } = await import("./TransactionDetails");
  const city = [benchmark("settlement", "Ljubljana", 4700, 295, -4, true), benchmark("city_district", "Četrtna skupnost Šiška", 4400, 40, 2, true),
    benchmark("municipality", "Ljubljana", 4600, 900, -3, true, { comparisonProfile: "unadjusted" })];
  expect(chooseBenchmark(city as never)?.scope).toBe("city_district");
  const village = [benchmark("local_community", "Krajevna skupnost Črna", 1500, 60, -5, true), benchmark("settlement", "Krivčevo", 1400, 31, 3, true)];
  expect(chooseBenchmark(village as never)?.scope).toBe("settlement");
  // A median of one other sale is never a comparison.
  expect(chooseBenchmark([benchmark("city_district", "Četrtna skupnost Šiška", 4400, 1, 12, true)] as never)).toBeUndefined();
});

it("uses one address and one list for a sale in a building: the register's 15A, and the building's other sales with the same filter", async () => {
  const year = new Date().getFullYear();
  const own = { ...flat, transactionId: 77, contractDate: `${year - 1}-06-30`, buildingParts: [{ ...flat.buildingParts[0], cadastralMunicipalityCode: 2680, buildingNumber: "17",
    street: "CLEVELANDSKA ULICA", houseNumber: "15" }] };
  const other = (transactionId: number, contractDate: string, area: number, propertyGroup = "apartment") =>
    ({ transactionId, contractDate, propertyGroup, area, amount: area * 3000, amountPerSqm: 3000, representative: true });
  const building = { cadastralMunicipalityCode: 2680, buildingNumber: "17", constructionYear: 1980, knownBuildingPartCount: 11, settlement: "LJUBLJANA",
    street: "CLEVELANDSKA ULICA", houseNumber: "15", houseNumberSuffix: "A", sales: { transactionCount: 4, representativeCount: 4 },
    rentals: { transactionCount: 0, representativeCount: 0 }, saleHistory: [], rentalHistory: [], rentalTransactions: [],
    saleTransactions: [other(77, `${year - 1}-06-30`, 61.7), other(78, `${year - 1}-08-19`, 87), other(79, `${year - 9}-01-01`, 70), other(80, `${year}-01-01`, 12, "garage")] };
  api.prepend([
    { path: "/api/v1/sales/transactions/77", body: own },
    { path: "/api/v1/sales/transactions/77/context", body: { ...flatContext, transactionId: 77 } },
    { path: "/api/v1/sales/transactions/77/history", body: { transactionId: 77, truncated: false, assets: [] } },
  ]);
  render(<TransactionEvidence selected={{ kind: "sale", id: 77 }} building={building as never} onChoose={() => {}}/>);
  expect(await screen.findByText("Clevelandska ulica 15A, Ljubljana · Šiška")).toBeInTheDocument();
  const others = within(screen.getByRole("heading", { name: "Druge prodaje v isti stavbi" }).closest("section")!);
  expect(others.getByText(new RegExp(`^1 prodaja stanovanja v letih ${year - 5}–${year}\\.`))).toBeInTheDocument();
  expect(others.getAllByRole("listitem")).toHaveLength(1);
  // A suffix the agreement leaves out is the same address: nothing extra in the register section.
  expect(screen.queryByText("Naslov v pogodbi")).not.toBeInTheDocument();
});

it("warns that a share or a package price is not comparable", async () => {
  const share = { ...flat, transactionId: 674223, propertyGroup: "house", area: 109, price: 2249, pricePerSqm: 20.6 };
  const shareContext = { ...flatContext, transactionId: 674223, propertyGroup: "house",
    benchmarks: [benchmark("statistical_region", "Jugovzhodna Slovenija", 485, 301, -95.7, true, { comparisonProfile: "unadjusted" })] };
  const shareHistory = { transactionId: 674223, truncated: false, assets: [{ kind: "building_part", cadastralCode: 1587, number: "1", partNumber: "1", truncated: false,
    events: [{ ...event(674223, "2022-09-22", 2249), share: "1/14" }], pairs: [] }] };
  api.prepend([
    { path: "/api/v1/sales/transactions/674223", body: share },
    { path: "/api/v1/sales/transactions/674223/context", body: shareContext },
    { path: "/api/v1/sales/transactions/674223/history", body: shareHistory },
  ]);
  render(<TransactionEvidence selected={{ kind: "sale", id: 674223 }} onChoose={() => {}}/>);
  const verdict = await screen.findByRole("region", { name: "Primerjava cene" });
  expect(await within(verdict).findByText(/Verjetno delež ali del paketa — cena ni primerljiva/)).toBeInTheDocument();
  expect(verdict).toHaveTextContent(/Prodan je le delež 1\/14; cena na m² je le 4 % mediane primerjave/);
});
