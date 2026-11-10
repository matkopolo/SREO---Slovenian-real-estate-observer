import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { AreaSearch } from "./AreaSearch";

const municipalities = [{ id: 133, level: "municipality", name: "Ljubljana", parentId: 8 }, { id: 52, level: "municipality", name: "Kranj", parentId: 9 },
  { id: 129, level: "municipality", name: "Kranjska Gora", parentId: 9 }, { id: 21, level: "municipality", name: "Dobrepolje", parentId: 8 },
  { id: 123, level: "municipality", name: "Kamnik", parentId: 8 }] as never[];
const regions = [{ id: 8, level: "statistical_region", name: "Osrednjeslovenska", parentId: 1 }, { id: 9, level: "statistical_region", name: "Gorenjska", parentId: 1 }] as never[];
const districts = [{ id: 269, level: "city_district", name: "Šiška", parentId: 133 }] as never[];

const item = (street: string | null, number: string, suffix: string | null, settlement: string, sales: number, rentals: number, building = number) => ({
  cadastralMunicipalityCode: 1730, buildingNumber: building, settlement, street, houseNumber: number, houseNumberSuffix: suffix,
  longitude: 14.5, latitude: 46.05, saleCount: sales, rentalCount: rentals, saleCounts: {}, rentalCounts: {} });
const empty = { items: [], count: 0, matchType: "none", requestedHouseNumber: null, streets: [], settlements: [] };
const celovska = { street: "CELOVŠKA CESTA", settlement: "LJUBLJANA", municipalityId: 133, buildingCount: 141, saleCount: 2039, rentalCount: 5100 };
const responses: Record<string, unknown> = {
  "Celovška cesta": { ...empty, matchType: "street", items: [item("CELOVŠKA CESTA", "143", null, "LJUBLJANA", 28, 4), item("CELOVŠKA CESTA", "15", "A", "LJUBLJANA", 0, 0)],
    streets: [celovska, { ...celovska, settlement: "MEŽICA", municipalityId: 74, buildingCount: 8, saleCount: 3, rentalCount: 0 }] },
  "Dunajska cesta 100": { ...empty, matchType: "nearest", requestedHouseNumber: "100",
    items: [item("DUNAJSKA CESTA", "98", null, "LJUBLJANA", 5, 1), item("DUNAJSKA CESTA", "102", null, "LJUBLJANA", 12, 0)],
    streets: [{ ...celovska, street: "DUNAJSKA CESTA", buildingCount: 194, saleCount: 1701 }] },
  "celovska cesta 143": { ...empty, matchType: "address", requestedHouseNumber: "143", items: [item("CELOVŠKA CESTA", "143", null, "LJUBLJANA", 28, 4)], streets: [celovska] },
  "Cankarjeva ulica 5": { ...empty, matchType: "address", requestedHouseNumber: "5",
    items: [item("CANKARJEVA ULICA", "5", null, "MARIBOR", 141, 2, "11"), item("CANKARJEVA ULICA", "5", null, "CELJE", 16, 0, "12")] },
  "Clevelandska ulica 15A": { ...empty, matchType: "address", requestedHouseNumber: "15a",
    items: [item("CLEVELANDSKA ULICA", "15", null, "LJUBLJANA", 12, 1, "17")] },
  "Clevelandska 15a": { ...empty, matchType: "address", requestedHouseNumber: "15a",
    items: [item("CLEVELANDSKA ULICA", "15", "A", "LJUBLJANA", 12, 1, "17")] },
  "Perovo 17": { ...empty, matchType: "address", requestedHouseNumber: "17",
    items: [item("PEROVO", "17", "A", "KAMNIK", 1, 0, "923"), item("PEROVO", "17", "b", "KAMNIK", 1, 0, "2877")] },
  "Clevelandska ulica 11": { ...empty, matchType: "address", requestedHouseNumber: "11", items: [
    { ...item("CLEVELANDSKA ULICA", "11", null, "LJUBLJANA", 16, 10, "472"), saleCounts: { garage: 16 }, rentalCounts: { garage: 10 } },
    { ...item("Clevelandska ulica", "11", null, "Ljubljana", 0, 1, "46"), rentalCounts: { apartment: 1 } }] },
  "Šiš": { ...empty, matchType: "street", items: [item("CELOVŠKA CESTA", "85", null, "ŠIŠKA", 65, 172)],
    streets: [{ ...celovska, street: "ŠIŠKA", settlement: "PREDDVOR", municipalityId: 77, buildingCount: 5, saleCount: 5 }] },
  "Krivčevo": { ...empty, matchType: "street", items: [item(null, "4", null, "KRIVČEVO", 2, 0)],
    settlements: [{ id: 2584, name: "Krivčevo", municipalityId: 123, municipality: "Kamnik" }] },
};

beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn(async (url: string) => {
    const q = new URL(url, "http://localhost").searchParams.get("q") ?? "";
    return { ok: true, status: 200, json: async () => responses[q] ?? empty } as Response;
  }));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

function setup(extra: { onStreet?: (street: string, settlement?: string, municipalityId?: number) => void; districts?: never[] } = {}) {
  const onArea = vi.fn(), onAddress = vi.fn();
  render(<AreaSearch regions={regions} municipalities={municipalities} districts={districts} label="Poiščite občino ali naslov" placeholder=""
    onArea={onArea} onAddress={onAddress} {...extra}/>);
  const input = screen.getByRole("combobox", { name: "Poiščite občino ali naslov" });
  const type = (value: string) => fireEvent.change(input, { target: { value } });
  return { onArea, onAddress, input, type };
}

it("is an ARIA combobox: arrows move the active option, Enter picks it, Escape closes", async () => {
  const { onArea, input, type } = setup();
  type("kranj");
  expect(input).toHaveAttribute("aria-expanded", "true");
  const list = screen.getByRole("listbox");
  expect(within(list).getByRole("group", { name: "Območja" })).toBeInTheDocument();
  const options = within(list).getAllByRole("option");
  expect(options.map((option) => option.querySelector(".area-search-label")?.textContent)).toEqual(["Kranj", "Kranjska Gora"]);
  fireEvent.keyDown(input, { key: "ArrowDown" });
  fireEvent.keyDown(input, { key: "ArrowDown" });
  expect(input).toHaveAttribute("aria-activedescendant", options[1].id);
  expect(options[1]).toHaveAttribute("aria-selected", "true");
  fireEvent.keyDown(input, { key: "Escape" });
  expect(input).toHaveAttribute("aria-expanded", "false");
  fireEvent.keyDown(input, { key: "ArrowDown" });
  fireEvent.keyDown(input, { key: "Enter" });
  expect(onArea).toHaveBeenCalledWith(expect.objectContaining({ id: 52, name: "Kranj", level: "municipality" }));
});

it("lists addresses with their deal counts and a whole-street row, and Enter on a street opens its sales", async () => {
  const onStreet = vi.fn();
  const { input, type } = setup({ onStreet });
  type("Celovška cesta");
  const group = await screen.findByRole("group", { name: "Naslovi" });
  const options = within(group).getAllByRole("option");
  expect(options[0]).toHaveTextContent("Vse prodaje na ulici Celovška cesta (2.039)");
  expect(options[0]).toHaveTextContent("ulica, Ljubljana · 141 stavb");
  expect(options.find((option) => option.textContent?.includes("Celovška cesta 143, Ljubljana"))).toHaveTextContent("naslov · 28 prodaj · 4 najemi");
  expect(options.find((option) => option.textContent?.includes("Celovška cesta 15A"))).toHaveTextContent("ni evidentiranih poslov");
  fireEvent.submit(input.closest("form")!);
  expect(onStreet).toHaveBeenCalledWith("CELOVŠKA CESTA", "Ljubljana", 133);
});

it("Enter on a street without onStreet asks for a number instead of doing nothing", async () => {
  const { onAddress, input, type } = setup();
  type("Celovška cesta");
  await screen.findByRole("group", { name: "Naslovi" });
  expect(screen.queryByText(/Vse prodaje na ulici/)).not.toBeInTheDocument();
  fireEvent.submit(input.closest("form")!);
  expect(onAddress).not.toHaveBeenCalled();
  expect(screen.getByRole("status")).toHaveTextContent("Dodajte hišno številko ali izberite stavbo s seznama.");
});

it("a missing house number shows the nearest numbers on the street", async () => {
  const { onAddress, input, type } = setup();
  type("Dunajska cesta 100");
  expect(await screen.findByText("Hišne številke 100 ni v evidenci poslov; najbližje: 98, 102.")).toBeInTheDocument();
  fireEvent.submit(input.closest("form")!);
  expect(onAddress).not.toHaveBeenCalled();
  expect(screen.getByRole("status")).toHaveTextContent("najbližje: 98, 102");
});

it("Enter opens a unique exact address, also when pressed before the results arrive", async () => {
  const { onAddress, input, type } = setup();
  type("celovska cesta 143");
  fireEvent.submit(input.closest("form")!);
  // Resolved from an effect when the results arrive: the callback and the cleared field land in the same update,
  // which React renders just after the callback runs, so both are awaited together.
  await vi.waitFor(() => {
    expect(onAddress).toHaveBeenCalledWith({ cadastralMunicipalityCode: 1730, buildingNumber: "143", label: "Celovška cesta 143, Ljubljana" });
    expect(input).toHaveValue("");
  });
});

it("Enter on an address in several towns asks for a pick", async () => {
  const { onAddress, input, type } = setup();
  type("Cankarjeva ulica 5");
  await screen.findByRole("group", { name: "Naslovi" });
  fireEvent.submit(input.closest("form")!);
  expect(onAddress).not.toHaveBeenCalled();
  expect(screen.getByRole("status")).toHaveTextContent("Več stavb s tem naslovom (2)");
});

it("offers settlements as areas and Enter opens an exact settlement", async () => {
  const { onArea, input, type } = setup();
  type("Krivčevo");
  const areas = await screen.findByRole("group", { name: "Območja" });
  expect(within(areas).getByRole("option")).toHaveTextContent("Krivčevo naselje, Kamnik");
  fireEvent.submit(input.closest("form")!);
  expect(onArea).toHaveBeenCalledWith({ id: 2584, name: "Krivčevo", level: "settlement", region: "Kamnik" });
});

it("'Polje' does not open Dobrepolje, and districts carry their town", async () => {
  const { onArea, input, type } = setup();
  type("Polje");
  await screen.findByRole("option", { name: /Dobrepolje/ });
  fireEvent.submit(input.closest("form")!);
  expect(await screen.findByRole("status")).toHaveTextContent("Ni natančnega zadetka – izberite s seznama, npr. Dobrepolje.");
  expect(onArea).not.toHaveBeenCalled();
  type("siska");
  expect(screen.getByRole("option", { name: /Šiška \(Ljubljana\)/ })).toHaveTextContent("četrtna skupnost, Ljubljana");
  fireEvent.submit(input.closest("form")!);
  await vi.waitFor(() => expect(onArea).toHaveBeenCalledWith(expect.objectContaining({ id: 269, level: "city_district" })));
});

it("says when nothing matches, with useful advice", async () => {
  const { input, type } = setup();
  type("Neobstojeca 12");
  fireEvent.submit(input.closest("form")!);
  expect(await screen.findByRole("status")).toHaveTextContent("Ni zadetkov. Preverite hišno številko ali vpišite samo ulico in kraj");
});

it("an area-only search clicks through to the area and says 'Ni takega območja'", () => {
  const onArea = vi.fn();
  render(<AreaSearch regions={regions} municipalities={municipalities} label="Primerjaj z" placeholder="" includeAddresses={false} onArea={onArea}/>);
  const input = screen.getByRole("combobox", { name: "Primerjaj z" });
  fireEvent.change(input, { target: { value: "xyz" } });
  expect(screen.getByRole("status")).toHaveTextContent("Ni takega območja");
  fireEvent.change(input, { target: { value: "gorenj" } });
  fireEvent.click(screen.getByRole("option", { name: /Gorenjska/ }));
  expect(onArea).toHaveBeenCalledWith(expect.objectContaining({ id: 9, level: "statistical_region" }));
  expect(fetch).not.toHaveBeenCalled();
});

const ljubljanaDistricts = [{ id: 269, level: "city_district", name: "Šiška", parentId: 133 },
  { id: 266, level: "city_district", name: "Bežigrad", parentId: 133 }, { id: 271, level: "city_district", name: "Vič", parentId: 133 },
  { id: 263, level: "city_district", name: "Center", parentId: 133 }, { id: 300, level: "city_district", name: "Center", parentId: 52 }] as never[];

it("Enter on a district name opens the district, before any street or settlement of that name", async () => {
  const onStreet = vi.fn();
  const { onArea, input, type } = setup({ onStreet, districts: ljubljanaDistricts });
  for (const [text, id] of [["Bežigrad", 266], ["Bezigrad", 266], ["Vič", 271], ["siska", 269]] as const) {
    type(text);
    expect(within(screen.getByRole("listbox")).getAllByRole("option")[0]).toHaveTextContent(/četrtna skupnost, Ljubljana/);
    fireEvent.submit(input.closest("form")!);
    expect(onArea).toHaveBeenLastCalledWith(expect.objectContaining({ id, level: "city_district" }));
    expect(input).toHaveAttribute("aria-expanded", "false");
  }
  // The start of one district name: the street "Šiška" in Preddvor is listed below, but the district is taken.
  type("Šiš");
  await screen.findByRole("group", { name: "Naslovi" });
  const groups = within(screen.getByRole("listbox")).getAllByRole("group").map((group) => group.getAttribute("aria-labelledby") && group.textContent?.slice(0, 8));
  expect(groups[0]).toMatch(/^Območja/);
  fireEvent.submit(input.closest("form")!);
  expect(onArea).toHaveBeenLastCalledWith(expect.objectContaining({ id: 269 }));
  expect(onStreet).not.toHaveBeenCalled();
  // Two districts are called Center: the list stays open and says so.
  type("Center");
  fireEvent.submit(input.closest("form")!);
  expect(screen.getByRole("status")).toHaveTextContent("Več zadetkov (2)");
  expect(input).toHaveAttribute("aria-expanded", "true");
  expect(fetch).not.toHaveBeenCalledWith(expect.stringContaining("q=Bez"), expect.anything());
});

it("a house-number letter the register leaves out still opens the building, with a note", async () => {
  const { onAddress, input, type } = setup();
  type("Clevelandska ulica 15A");
  await screen.findByRole("group", { name: "Naslovi" });
  fireEvent.submit(input.closest("form")!);
  expect(onAddress).toHaveBeenCalledWith(expect.objectContaining({ buildingNumber: "17", label: "Clevelandska ulica 15, Ljubljana" }));
  expect(screen.getByRole("status")).toHaveTextContent("Hišna številka 15A je v evidenci zapisana kot 15.");
  type("Clevelandska 15a");
  fireEvent.submit(input.closest("form")!);
  await vi.waitFor(() => expect(onAddress).toHaveBeenLastCalledWith(expect.objectContaining({ buildingNumber: "17", label: "Clevelandska ulica 15A, Ljubljana" })));
  // Only lettered numbers are registered: say so instead of "not in the records", and keep the list open.
  type("Perovo 17");
  await screen.findByRole("option", { name: /Perovo 17b/ });
  fireEvent.submit(input.closest("form")!);
  expect(screen.getByRole("status")).toHaveTextContent("Hišna številka 17 je v evidenci zapisana z dodatkom (17A, 17b) – izberite s seznama.");
  expect(screen.getByRole("status")).not.toHaveTextContent("ni v evidenci");
  expect(input).toHaveAttribute("aria-expanded", "true");
});

it("merges buildings that share an address into one row and names a single property type", async () => {
  const { onAddress, input, type } = setup();
  type("Clevelandska ulica 11");
  const group = await screen.findByRole("group", { name: "Naslovi" });
  const options = within(group).getAllByRole("option");
  expect(options).toHaveLength(1);
  expect(options[0]).toHaveTextContent("Clevelandska ulica 11, Ljubljana");
  expect(options[0]).toHaveTextContent("naslov · 16 prodaj garaž · 11 najemov · 2 stavbi");
  fireEvent.submit(input.closest("form")!);
  expect(onAddress).toHaveBeenCalledWith(expect.objectContaining({ buildingNumber: "472" }));
});

it("a miss closes the list so the message is visible", async () => {
  const { input, type } = setup();
  type("Dunajska cesta 100");
  await screen.findByText("Hišne številke 100 ni v evidenci poslov; najbližje: 98, 102.");
  expect(input).toHaveAttribute("aria-expanded", "true");
  fireEvent.submit(input.closest("form")!);
  expect(input).toHaveAttribute("aria-expanded", "false");
  expect(screen.getByRole("status")).not.toHaveClass("sr-only");
});
