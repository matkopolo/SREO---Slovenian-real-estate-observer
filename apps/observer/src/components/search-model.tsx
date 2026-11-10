import { Fragment, type ReactNode } from "react";
import type { searchBuildings } from "../api";
import { integer, titleCase } from "../format";
import { count, forms, NOUN_FORMS, type Forms } from "../plural";
import { LOCALE, proper, t, tx } from "../i18n";

/** The search's model: area names and ranking, address rows, and what Enter does. Pure, so it is unit-tested. */

export interface AreaOption { id?: number; name: string; level: "country" | "statistical_region" | "municipality" | "city_district" | "settlement"; region?: string }
export interface AddressOption { cadastralMunicipalityCode: number; buildingNumber: string; label: string }

export type SearchResponse = Awaited<ReturnType<typeof searchBuildings>>;
type SearchItem = SearchResponse["items"][number];
type StreetSummary = SearchResponse["streets"][number];

export const EMPTY_RESPONSE: SearchResponse = { items: [], count: 0, matchType: "none", requestedHouseNumber: null, streets: [], settlements: [] };

export const SLOVENIA_OPTION: AreaOption = { name: t("Slovenija"), level: "country" };
/** Every spelling an area answers to: the country also by its Slovenian and English name in either language. */
const SLOVENIA_NAMES = ["Slovenija", "Slovenia"]; // i18n-ignore
/** "Vič (Ljubljana)" → "Vič": a district also answers to its name without the town. */
const districtBase = (option: AreaOption) => option.name.replace(/ \([^()]*\)$/, "");
const fullNames = (option: AreaOption) => option.level === "country" ? [...new Set([option.name, ...SLOVENIA_NAMES])] : [option.name];
export const names = (option: AreaOption) => option.level === "city_district" ? [...new Set([option.name, districtBase(option)])] : fullNames(option);

/** Visible name of an area: the country is translated, everything else is a register name. */
export const areaName = (option: AreaOption) => option.level === "country" ? option.name : proper(option.name);
/** Join visible parts with a separator ("a · b"); plain strings stay one text in Slovenian. */
export const joined = (parts: ReactNode[], separator: string): ReactNode => parts.every((part) => typeof part === "string" || typeof part === "number")
  ? parts.join(separator) : parts.map((part, index) => <Fragment key={index}>{index ? separator : ""}{part}</Fragment>);

export function addressLabel(item: { street?: string | null; houseNumber?: string | null; houseNumberSuffix?: string | null; settlement?: string | null }) {
  const number = `${item.houseNumber ?? ""}${item.houseNumberSuffix ?? ""}`.trim();
  const settlement = titleCase(item.settlement);
  // Rural addresses have no street: the settlement carries the house number ("Kozje 144").
  if (!item.street) return [settlement, number].filter(Boolean).join(" ");
  const street = `${titleCase(item.street)} ${number}`.trim();
  return [street, settlement && settlement !== street ? settlement : ""].filter(Boolean).join(", ");
}

/** Lower case without diacritics, so "domzale" finds Domžale. */
export const fold = (value: string) => value.normalize("NFD").replace(/\p{M}/gu, "").toLocaleLowerCase("sl-SI").trim();

export const levelLabel = (option: AreaOption): ReactNode => option.level === "country" ? t("država")
  : option.level === "city_district" ? tx("četrtna skupnost, {town}", { town: proper(option.region ?? "") })
  : option.level === "statistical_region" ? t("regija") : option.level === "settlement" ? tx("naselje, {municipality}", { municipality: proper(option.region ?? "") })
  : option.region ? tx("občina, {region}", { region: proper(option.region) }) : t("občina");

/** "Ni podatka" is the source's placeholder for a missing settlement. */
export const place = (value: string | null | undefined) => value && fold(value) !== "ni podatka" ? titleCase(value) : ""; // i18n-ignore

export type Row =
  | { kind: "area"; key: string; label: ReactNode; meta: ReactNode; area: AreaOption }
  | { kind: "street"; key: string; label: ReactNode; meta: ReactNode; street: StreetSummary }
  | { kind: "address"; key: string; label: ReactNode; meta: ReactNode; address: AddressOption; empty: boolean };

/** Name order for a typed text: exact, then starting, then a later word starting, then anywhere. */
function rankName(name: string, query: string) {
  const value = fold(name);
  if (value === query) return 0;
  if (value.startsWith(query)) return 1;
  if (value.split(/[\s(-]+/).some((word) => word.startsWith(query))) return 2;
  return value.includes(query) ? 3 : -1;
}
/** The best rank over every name of an area. */
export function rank(option: AreaOption, query: string) {
  const scores = names(option).map((name) => rankName(name, query)).filter((score) => score >= 0);
  return scores.length ? Math.min(...scores) : -1;
}
const isNamed = (option: AreaOption, query: string) => names(option).some((name) => fold(name) === query);
/** The one area a text names: "Tabor" is a municipality and a district of Maribor, so the full name wins over a district's short one. */
export function namedArea(options: AreaOption[], query: string) {
  const named = options.filter((option) => isNamed(option, query));
  if (named.length <= 1) return { named, area: named[0] };
  const full = named.filter((option) => fullNames(option).some((name) => fold(name) === query));
  return { named, area: full.length === 1 ? full[0] : undefined };
}

export const houseNumber = (item: SearchItem) => `${item.houseNumber ?? ""}${item.houseNumberSuffix ?? ""}`.trim();

export function streetRow(street: StreetSummary): Row {
  const name = titleCase(street.street);
  const settlement = place(street.settlement);
  // A rural address (or a street named after its village) is a settlement, not a street.
  const village = !settlement || fold(name) === fold(settlement);
  return { kind: "street", key: `street-${street.street}-${street.settlement}`, street,
    label: village ? tx("Vse prodaje v naselju {settlement} ({count})", { settlement: proper(name), count: integer(street.saleCount) })
      : tx("Vse prodaje na ulici {street} ({count})", { street: proper(name), count: integer(street.saleCount) }),
    meta: joined([village ? t("naselje") : tx("ulica, {settlement}", { settlement: proper(settlement) }), count(street.buildingCount, NOUN_FORMS.stavba)], " · ") };
}

/** Deal counts named by type when a building has one kind ("16 prodaj garaž", "12 prodaj stanovanj"). */
const typed = (singular: string, plural: string, sale: [string, string], rental: [string, string]) => ({
  sale: forms([`prodaja ${singular}`, `prodaji ${plural}`, `prodaje ${plural}`, `prodaj ${plural}`], sale), // i18n-ignore
  rental: forms([`najem ${singular}`, `najema ${plural}`, `najemi ${plural}`, `najemov ${plural}`], rental), // i18n-ignore
});
const TYPED: Record<string, { sale: Forms; rental: Forms }> = {
  apartment: typed("stanovanja", "stanovanj", ["apartment sale", "apartment sales"], ["apartment rental", "apartment rentals"]), // i18n-ignore
  house: typed("hiše", "hiš", ["house sale", "house sales"], ["house rental", "house rentals"]), // i18n-ignore
  garage: typed("garaže", "garaž", ["sale of a garage", "sales of garages"], ["garage rental", "garage rentals"]), // i18n-ignore
  commercial: typed("poslovnega prostora", "poslovnih prostorov", ["commercial sale", "commercial sales"], ["commercial rental", "commercial rentals"]), // i18n-ignore
  land: typed("zemljišča", "zemljišč", ["land sale", "land sales"], ["land rental", "land rentals"]), // i18n-ignore
  room: typed("sobe", "sob", ["room sale", "room sales"], ["room rental", "room rentals"]), // i18n-ignore
};
function dealCount(total: number, byGroup: Counts, kind: "sale" | "rental") {
  const groups = Object.entries(byGroup).filter(([, value]) => value > 0);
  const only = groups.length === 1 && groups[0][1] === total ? TYPED[groups[0][0]] : undefined;
  return count(total, only ? only[kind] : kind === "sale" ? NOUN_FORMS.prodaja : NOUN_FORMS.najem);
}

/** One suggestion per visible address: buildings that share a label are one row, opening the busiest. */
type Counts = { [group: string]: number };
interface AddressEntry { item: SearchItem; label: string; buildings: number; saleCount: number; rentalCount: number; saleCounts: Counts; rentalCounts: Counts }
const visibleAddress = (item: SearchItem) => addressLabel({ ...item, settlement: place(item.settlement) || null });
export function mergeAddresses(items: SearchItem[]): AddressEntry[] {
  const merged = new Map<string, AddressEntry>();
  const add = (into: Counts, from: Counts | undefined) => { for (const [key, value] of Object.entries(from ?? {})) into[key] = (into[key] ?? 0) + value; };
  for (const item of items) {
    const label = visibleAddress(item);
    const key = label ? fold(label) : `${item.cadastralMunicipalityCode}-${item.buildingNumber}`;
    const entry = merged.get(key);
    if (!entry) {
      merged.set(key, { item, label, buildings: 1, saleCount: item.saleCount, rentalCount: item.rentalCount, saleCounts: { ...item.saleCounts }, rentalCounts: { ...item.rentalCounts } });
      continue;
    }
    if (item.saleCount + item.rentalCount > entry.item.saleCount + entry.item.rentalCount) entry.item = item;
    entry.buildings += 1; entry.saleCount += item.saleCount; entry.rentalCount += item.rentalCount;
    add(entry.saleCounts, item.saleCounts); add(entry.rentalCounts, item.rentalCounts);
  }
  return [...merged.values()];
}

export function addressRow(entry: AddressEntry): Row {
  const { item } = entry;
  const deals = [entry.saleCount ? dealCount(entry.saleCount, entry.saleCounts, "sale") : "", entry.rentalCount ? dealCount(entry.rentalCount, entry.rentalCounts, "rental") : ""].filter(Boolean);
  return { kind: "address", key: `address-${item.cadastralMunicipalityCode}-${item.buildingNumber}`,
    label: proper(entry.label) || t("Stavba {ko}-{st}", { ko: item.cadastralMunicipalityCode, st: item.buildingNumber }),
    meta: [t("naslov"), deals.length ? deals.join(" · ") : t("ni evidentiranih poslov"), entry.buildings > 1 ? count(entry.buildings, NOUN_FORMS.stavba) : ""].filter(Boolean).join(" · "),
    empty: !deals.length,
    address: { cadastralMunicipalityCode: item.cadastralMunicipalityCode, buildingNumber: item.buildingNumber, label: addressLabel(item) } };
}

/** "Hišne številke 100 ni v evidenci poslov; najbližje: 98, 102." */
export function nearestNote(response: SearchResponse) {
  if (response.matchType !== "nearest" || !response.requestedHouseNumber) return "";
  const numbers = [...new Set(response.items.map(houseNumber).filter(Boolean))].slice(0, 4);
  return missingNumber(response.requestedHouseNumber, numbers.join(", "));
}
const missingNumber = (wanted: string, numbers: string) =>
  t("Hišne številke {number} ni v evidenci poslov; najbližje: {numbers}.", { number: wanted.toLocaleUpperCase(LOCALE), numbers });
/** "Ni zadetkov. Preverite …": the hint names a real street as the example. */
const EXAMPLE_STREET = "Celovška cesta, Ljubljana"; // i18n-ignore
const noArea = () => <>{t("Ni takega območja.")} {t("Vpišite ime občine, četrtne skupnosti ali regije.")}</>;
export const noResults = () => <>{t("Ni zadetkov.")} {tx("Preverite hišno številko ali vpišite samo ulico in kraj (npr. {example}).", { example: proper(EXAMPLE_STREET) })}</>;


// ------------------------------------------------------------------ Enter

/** What Enter does: take a row (with an optional note under the field), ask the reader to pick, report a miss, or wait for addresses. */
export type EnterAction =
  | { type: "choose"; row: Row; note?: ReactNode }
  | { type: "ask"; message: ReactNode }
  | { type: "several"; matches: Array<{ label: ReactNode }> }
  | { type: "miss"; message: ReactNode }
  | { type: "wait" };

export interface EnterInput {
  /** The folded text. */
  query: string; hasDigit: boolean;
  /** The one area the text names exactly, if any. */
  exactArea?: AreaOption;
  /** Local areas matching the text, best first, and settlements from the address search. */
  localMatches: AreaOption[]; settlements: AreaOption[];
  /** The rows the list shows. */
  rows: Row[];
  /** Addresses are searched for this text. */
  wantsSearch: boolean;
  /** The caller takes streets ("all sales on this street") and addresses. */
  streets: boolean; addresses: boolean;
}

const settlementArea = (item: SearchResponse["settlements"][number]): AreaOption => ({ id: item.id, name: item.name, level: "settlement", region: item.municipality });

/** Enter without a highlighted row: an exact or unique match is taken; otherwise the reader is told why not. */
export function resolveEnter(input: EnterInput, body: SearchResponse | undefined): EnterAction {
  const { query, hasDigit, exactArea, localMatches, settlements, rows, wantsSearch, streets } = input;
  const nothing = (): EnterAction => ({ type: "miss", message: input.addresses ? noResults() : noArea() });
  const areaRow = (area: AreaOption): Row => rows.find((row) => row.kind === "area" && row.area === area) ?? { kind: "area", key: "", label: areaName(area), meta: "", area };
  const choose = (row: Row, note?: ReactNode): EnterAction => ({ type: "choose", row, note });
  const several = (areas: AreaOption[]): EnterAction => ({ type: "several", matches: areas.map((option) => ({ label: areaName(option) })) });
  if (!hasDigit) {
    if (exactArea) return choose(areaRow(exactArea));
    // "Polje" must not open Dobrepolje: only a name that starts with the text (or has a word that does) counts.
    const starting = localMatches.filter((option) => { const score = rank(option, query); return score === 1 || score === 2; });
    if (!wantsSearch && starting.length === 1) return choose(areaRow(starting[0]));
    if (!wantsSearch) return localMatches.length ? several(localMatches) : nothing();
    if (!body) return { type: "wait" };
    const exactSettlements = body.settlements.filter((item) => [fold(item.name), fold(`${item.name} ${item.municipality}`), fold(`${item.name}, ${item.municipality}`)].includes(query));
    if (exactSettlements.length === 1) return choose(areaRow(settlementArea(exactSettlements[0])));
    // Areas before streets: an area whose name starts with the text is the place meant ("Šiška" is the district,
    // not the street). A settlement named like the municipality or district it belongs to ("Kranjska Gora") is the same place.
    const localStarting = localMatches.filter((option) => [0, 1].includes(rank(option, query)));
    const localNames = new Set(localStarting.flatMap((option) => names(option).map(fold)));
    const startingAreas = [...localStarting, ...body.settlements.filter((item) => fold(item.name).startsWith(query) && !localNames.has(fold(item.name))).map(settlementArea)];
    if (startingAreas.length === 1) return choose(areaRow(startingAreas[0]));
    if (startingAreas.length > 1) return several(startingAreas);
    if (body.matchType === "street" && body.streets.length) {
      const [first] = body.streets;
      const total = body.streets.reduce((sum, street) => sum + street.saleCount, 0);
      // "Celovška cesta" is Ljubljana's (2.039 of 2.045 sales); "Cankarjeva ulica" is in many towns.
      if (streets && first.saleCount > 0 && first.saleCount >= 0.9 * total) return choose(streetRow(first));
      if (body.items.length === 1) return choose(addressRow(mergeAddresses(body.items)[0]));
      return { type: "ask", message: streets ? t("Ulica s tem imenom je v več krajih – izberite s seznama ali dodajte kraj.") : t("Dodajte hišno številko ali izberite stavbo s seznama.") };
    }
    if (starting.length === 1) return choose(areaRow(starting[0]));
    if (starting.length > 1) return several(starting);
    if (body.items.length === 1) return choose(addressRow(mergeAddresses(body.items)[0]));
    if (settlements.length + body.items.length + localMatches.length) return { type: "several", matches: rows };
    return nothing();
  }
  if (!wantsSearch) return nothing();
  if (!body) return { type: "wait" };
  const entries = mergeAddresses(body.items);
  if (body.matchType === "cadastral" && entries.length === 1) return choose(addressRow(entries[0]));
  if (body.matchType === "nearest") return { type: "miss", message: nearestNote(body) };
  if (body.matchType === "address") {
    const wanted = (body.requestedHouseNumber ?? "").toLocaleLowerCase("sl-SI"); // i18n-ignore
    const lower = (entry: AddressEntry) => houseNumber(entry.item).toLocaleLowerCase("sl-SI"); // i18n-ignore
    const severalBuildings = (total: number): EnterAction => ({ type: "ask", message: t("Več stavb s tem naslovom ({count}) – izberite s seznama ali dodajte kraj.", { count: total }) });
    const exact = entries.filter((entry) => lower(entry) === wanted);
    if (exact.length === 1) return choose(addressRow(exact[0]));
    if (exact.length > 1) return severalBuildings(exact.length);
    // The register writes the number differently: "15A" as "15", or "17" only as "17A" and "17b".
    const bare = wanted.replace(/\D+$/, "");
    const written = entries.filter((entry) => (entry.item.houseNumber ?? "") === bare);
    const shown = wanted.toLocaleUpperCase(LOCALE);
    if (written.length === 1) return choose(addressRow(written[0]), t("Hišna številka {number} je v evidenci zapisana kot {registered}.", { number: shown, registered: houseNumber(written[0].item) }));
    if (written.length > 1 && bare !== wanted) return severalBuildings(written.length);
    if (written.length > 1) return { type: "ask", message: t("Hišna številka {number} je v evidenci zapisana z dodatkom ({numbers}) – izberite s seznama.", { number: shown, numbers: written.map((entry) => houseNumber(entry.item)).join(", ") }) };
    const numbers = [...new Set(body.items.map(houseNumber))].slice(0, 4).join(", ");
    return { type: "miss", message: missingNumber(wanted, numbers) };
  }
  if (entries.length === 1) return choose(addressRow(entries[0]));
  return entries.length ? { type: "several", matches: rows } : nothing();
}
