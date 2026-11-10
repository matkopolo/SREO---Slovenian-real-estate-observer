import { describe, expect, it } from "vitest";
import { EMPTY_RESPONSE, fold, rank, resolveEnter, type AreaOption, type EnterInput, type SearchResponse } from "./search-model";

const kranj: AreaOption = { id: 52, name: "Kranj", level: "municipality" };
const kranjskaGora: AreaOption = { id: 129, name: "Kranjska Gora", level: "municipality" };
const dobrepolje: AreaOption = { id: 21, name: "Dobrepolje", level: "municipality" };
const input = (text: string, extra: Partial<EnterInput> = {}): EnterInput => {
  const query = fold(text);
  const options = [kranj, kranjskaGora, dobrepolje];
  const localMatches = options.filter((option) => rank(option, query) >= 0).sort((a, b) => rank(a, query) - rank(b, query));
  return { query, hasDigit: /\d/.test(query), exactArea: options.find((option) => fold(option.name) === query), localMatches, settlements: [], rows: [],
    wantsSearch: false, streets: true, addresses: true, ...extra };
};
const item = (street: string, houseNumber: string, suffix: string | null, buildingNumber: string) => ({ cadastralMunicipalityCode: 1730, buildingNumber, settlement: "LJUBLJANA",
  street, houseNumber, houseNumberSuffix: suffix, longitude: 14.5, latitude: 46, saleCount: 3, rentalCount: 0, saleCounts: {}, rentalCounts: {} });
const response = (extra: Partial<SearchResponse>): SearchResponse => ({ ...EMPTY_RESPONSE, ...extra });

describe("Enter in the area search", () => {
  it("takes an exact name, and a unique starting name, but never a name that only contains the text", () => {
    expect(resolveEnter(input("kranj"), undefined)).toMatchObject({ type: "choose", row: { area: kranj } });
    expect(resolveEnter(input("kranjska"), undefined)).toMatchObject({ type: "choose", row: { area: kranjskaGora } });
    expect(resolveEnter(input("polje"), undefined)).toMatchObject({ type: "several" });        // Dobrepolje only contains it
    expect(resolveEnter(input("xyz"), undefined)).toMatchObject({ type: "miss" });
  });
  it("waits for the address answer, then takes the one street that has almost all its sales", () => {
    const street = { street: "CELOVŠKA CESTA", settlement: "LJUBLJANA", municipalityId: 133, buildingCount: 141, saleCount: 2039, rentalCount: 5100 };
    const typed = input("celovska cesta", { wantsSearch: true });
    expect(resolveEnter(typed, undefined)).toEqual({ type: "wait" });
    const body = response({ matchType: "street", streets: [street, { ...street, settlement: "MEŽICA", saleCount: 3 }] });
    expect(resolveEnter(typed, body)).toMatchObject({ type: "choose", row: { kind: "street" } });
    expect(resolveEnter({ ...typed, streets: false }, body)).toMatchObject({ type: "ask" });
  });
  it("matches a house number written differently in the register and says so", () => {
    const typed = input("clevelandska ulica 15a", { wantsSearch: true });
    const body = response({ matchType: "address", requestedHouseNumber: "15a", items: [item("CLEVELANDSKA ULICA", "15", null, "17")] });
    const action = resolveEnter(typed, body);
    expect(action).toMatchObject({ type: "choose", row: { kind: "address" } });
    expect(action.type === "choose" && action.note).toBe("Hišna številka 15A je v evidenci zapisana kot 15.");
    const several = response({ matchType: "address", requestedHouseNumber: "5", items: [item("CANKARJEVA ULICA", "5", null, "11"), { ...item("CANKARJEVA ULICA", "5", null, "12"), settlement: "CELJE" }] });
    expect(resolveEnter(input("cankarjeva ulica 5", { wantsSearch: true }), several)).toMatchObject({ type: "ask" });
  });
});
