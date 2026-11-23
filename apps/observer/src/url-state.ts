import { parsePeriod, type LandScope, type Period, type PropertyGroup } from "./api";
import { METRICS, type MetricId } from "./metrics";
import { sizeBand } from "./nouns";

/**
 * The address is the state: every page, area, type, period and opened sale lives in the hash, so links can be shared
 * and Back/Forward work. This module is the only place that reads or writes it.
 * URL words (page ids, parameter names, slugs) are Slovenian in both languages so links keep working.
 */

/** Page ids in the address (#trendi, #o-podatkih); the explorer has none. */
export const TRENDS = "trendi", ABOUT = "o-podatkih", OVERVIEW = "pregled-trga"; // i18n-ignore (URL ids, never shown as text)
export type Page = "explorer" | typeof TRENDS | typeof ABOUT | typeof OVERVIEW;

/** The page of a URL or hash ("#trendi?g=1" → trendi). */
export function pageOf(url: string = window.location.href): Page {
  const hash = url.includes("#") ? url.slice(url.indexOf("#")) : "";
  const name = hash.replace(/^#/, "").split("?")[0];
  return name === TRENDS ? TRENDS : name === ABOUT ? ABOUT : name === OVERVIEW ? OVERVIEW : "explorer";
}

/** The query part of a hash: "#trendi?g=133" → g=133. */
export const hashQuery = (hash: string = window.location.hash): URLSearchParams => new URLSearchParams(hash.replace(/^#[^?]*\??/, ""));

/** An opened sale or rental. */
export type Selected = { kind: "sale" | "rent"; id: number };
/** A building by cadastral municipality and number, as the registers name it. */
export type BuildingRef = { ko: number; st: string };

/** Everything the explorer shows. */
export interface ExplorerState {
  g?: number; building?: BuildingRef; selected?: Selected; group: PropertyGroup; landScope: LandScope; landChosen: boolean;
  size?: string; street?: string; years: Period; layer: MetricId; value: boolean;
}
export const DEFAULT_STATE: ExplorerState = { group: "apartment", landScope: "strict", landChosen: false, years: 1, layer: "salePrice", value: false };

const GROUP_SLUGS: Record<PropertyGroup, string> = { apartment: "", house: "hise", land: "zemljisca", commercial: "poslovni", garage: "garaze" }; // i18n-ignore: URL slugs (links keep working)
const LAND_SLUGS: Record<LandScope, string> = { strict: "zazidljiva", agricultural: "kmetijska", forest: "gozdna", all: "vsa" }; // i18n-ignore: URL slugs (links keep working)
const bySlug = <K extends string>(slugs: Record<K, string>, slug: string | null) => (Object.entries(slugs) as Array<[K, string]>).find(([, value]) => value && value === slug)?.[0];

/** A positive integer id from the address, else undefined (`posel=-5`, `g=abc` and `g=0` are not ids). */
const positiveId = (raw: string | null): number | undefined => { const id = Number(raw); return Number.isInteger(id) && id > 0 ? id : undefined; };

/** The building of a map point or address part, "1734-1710": the cadastral municipality, then the building number (which may itself contain "-"). */
export function parseBuildingKey(key: string | null | undefined): BuildingRef | undefined {
  const separator = key?.indexOf("-") ?? -1;
  if (!key || separator < 1) return undefined;
  const ko = Number(key.slice(0, separator));
  const st = key.slice(separator + 1);
  return Number.isInteger(ko) && ko > 0 && st ? { ko, st } : undefined;
}
export const buildingKey = (building: BuildingRef): string => `${building.ko}-${building.st}`;

/**
 * `#?g=133&b=1734-1710&posel=985416&vrsta=hise&obdobje=3&sloj=rentPrice`; a chosen year range is `od=2019&do=2021`.
 * Unknown parts are ignored and dropped on the next write (`3d=1` of links to the former 3D view among them).
 */
export function parseHash(hash: string = window.location.hash): ExplorerState {
  const query = hashQuery(hash);
  const sale = positiveId(query.get("posel")); // i18n-ignore: URL parameter names (links keep working)
  const rent = positiveId(query.get("najem")); // i18n-ignore: URL parameter names (links keep working)
  const years = Number(query.get("obdobje")); // i18n-ignore: URL parameter names (links keep working)
  const layer = query.get("sloj"); // i18n-ignore: URL parameter names (links keep working)
  return {
    g: positiveId(query.get("g")),
    building: parseBuildingKey(query.get("b")),
    selected: sale ? { kind: "sale", id: sale } : rent ? { kind: "rent", id: rent } : undefined,
    group: bySlug(GROUP_SLUGS, query.get("vrsta")) ?? "apartment", // i18n-ignore: URL parameter names (links keep working)
    landChosen: query.has("raba"), // i18n-ignore: URL parameter names (links keep working)
    landScope: bySlug(LAND_SLUGS, query.get("raba")) ?? "strict", // i18n-ignore: URL parameter names (links keep working)
    size: query.get("m2") ?? undefined,
    street: query.get("ulica") ?? undefined, // i18n-ignore: URL parameter names (links keep working)
    years: parsePeriod(query.get("od"), query.get("do")) ?? (years === 3 || years === 5 ? years : 1), // i18n-ignore: URL parameter names (links keep working)
    layer: layer != null && Object.hasOwn(METRICS, layer) ? layer as MetricId : "salePrice",
    value: query.get("vrednost") === "1", // i18n-ignore: URL slugs (links keep working)
  };
}

/** The canonical hash of a state: defaults and invalid parts are left out ("#" for Slovenija). */
export function toHash(state: ExplorerState): string {
  const query = new URLSearchParams();
  if (state.g) query.set("g", String(state.g));
  if (state.building) query.set("b", buildingKey(state.building));
  if (state.selected) query.set(state.selected.kind === "sale" ? "posel" : "najem", String(state.selected.id)); // i18n-ignore: URL parameter names (links keep working)
  if (GROUP_SLUGS[state.group]) query.set("vrsta", GROUP_SLUGS[state.group]); // i18n-ignore: URL parameter names (links keep working)
  if (state.group === "land" && state.landChosen) query.set("raba", LAND_SLUGS[state.landScope]); // i18n-ignore: URL parameter names (links keep working)
  if (state.size && sizeBand(state.group, state.size)) query.set("m2", state.size);
  if (state.street) query.set("ulica", state.street); // i18n-ignore: URL parameter names (links keep working)
  if (typeof state.years === "string") { const [from, to] = state.years.split("-"); query.set("od", from); query.set("do", to); } // i18n-ignore: URL parameter names (links keep working)
  else if (state.years !== 1) query.set("obdobje", String(state.years)); // i18n-ignore: URL parameter names (links keep working)
  if (state.layer !== "salePrice") query.set("sloj", state.layer); // i18n-ignore: URL parameter names (links keep working)
  if (state.value) query.set("vrednost", "1"); // i18n-ignore: URL slugs (links keep working)
  const text = query.toString();
  return text ? `#?${text}` : "#";
}

/** A link to the explorer with this page's state changed by `patch` (the type, period and layer are kept). */
export const hrefWith = (patch: Partial<ExplorerState>, hash: string = window.location.hash): string => toHash({ ...parseHash(hash), ...patch });
/** A link to one area (Slovenija without an id). */
export const areaHref = (id?: number): string => toHash({ ...DEFAULT_STATE, g: id });
/** A link to one sale or rental from a page outside the explorer. */
export const transactionHref = (selected: Selected): string => toHash({ ...DEFAULT_STATE, selected });
/** The trends page, for the area of the explorer when there is one. */
export const trendsHref = (g?: number): string => g ? `#${TRENDS}?g=${g}` : `#${TRENDS}`;
/** What the market overview reads from its address: the area and flats or houses (other types fall back to flats). */
export function overviewState(hash: string = window.location.hash): { g?: number; group: "apartment" | "house" } {
  const state = parseHash(hash);
  return { g: state.g, group: state.group === "house" ? "house" : "apartment" };
}
/** The area of the trends page ("#trendi?g=133"). */
export const trendsArea = (hash: string = window.location.hash): number | undefined => positiveId(hashQuery(hash).get("g"));
/** Rewrites the address without a history entry (choices on a page that Back should leave as a whole). */
export const replaceHash = (hash: string): void => window.history.replaceState(window.history.state, "", hash);
/** The market overview of an area (Slovenija without `g`), flats unless `houses`. */
export function overviewHref(g?: number, houses = false): string {
  const query = new URLSearchParams();
  if (g) query.set("g", String(g));
  if (houses) query.set("vrsta", "hise"); // i18n-ignore (URL slug)
  const text = query.toString();
  return `#${OVERVIEW}${text ? `?${text}` : ""}`;
}

/** A non-numeric area id in the link (`g=abc`) is reported instead of silently showing Slovenija. */
export function hasBadArea(hash: string = window.location.hash): boolean {
  const raw = hashQuery(hash).get("g");
  return raw != null && positiveId(raw) === undefined;
}

/**
 * Earlier shared links keep working: old view names map onto the explorer state
 * (`#pregled?g=133` → `#?g=133`, `#posli?ko=1734&st=1710` → `#?b=1734-1710`, `#dokazi?posel=1` → `#?posel=1`).
 * The app itself no longer emits these; remove after 2027-06-30, when shared links of the old views have aged out.
 */
export function translateLegacyHash(hash: string): string | undefined {
  const [name, rest = ""] = hash.replace(/^#/, "").split("?");
  if (!["pregled", "primerjava", "zemljevid", "posli", "dokazi"].includes(name)) return name === "kakovost" ? `#${ABOUT}` : name === "cas" || name === "trg" ? `#${TRENDS}${rest ? `?${rest}` : ""}` : undefined; // i18n-ignore (old URL ids)
  const old = new URLSearchParams(rest);
  const next = new URLSearchParams();
  const g = old.get("g"), ko = old.get("ko"), st = old.get("st"), m = old.get("m");
  if (g) next.set("g", g);
  if (ko && st) next.set("b", `${ko}-${st}`);
  for (const key of ["posel", "najem"]) { const id = old.get(key); if (id) next.set(key, id); } // i18n-ignore (URL keys)
  if (old.get("vrsta") === "hise") next.set("vrsta", "hise"); // i18n-ignore (URL keys)
  if (m && m !== "salePrice") next.set("sloj", m);
  const text = next.toString();
  return text ? `#?${text}` : "#";
}

/** Old links (`#pregled?g=133`) are rewritten in place to the explorer's address, before the app reads it. */
export function followLegacyHash(): void {
  const legacy = translateLegacyHash(window.location.hash);
  if (legacy) replaceHash(legacy);
}
