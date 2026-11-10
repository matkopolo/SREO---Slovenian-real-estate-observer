import { parsePeriod, type LandScope, type Period, type PropertyGroup } from "./api";
import { METRICS, type MetricId } from "./metrics";
import { sizeBand } from "./nouns";

/**
 * The address is the state: every page, area, type, period and opened sale lives in the hash, so links can be shared
 * and Back/Forward work. This module is the only place that reads or writes it.
 * URL words (page ids, parameter names, slugs) are Slovenian in both languages so links keep working.
 */

/** Page ids in the address (#trendi, #o-podatkih); the explorer has none. */
export const TRENDS = "trendi", ABOUT = "o-podatkih"; // i18n-ignore (URL ids, never shown as text)
export type Page = "explorer" | typeof TRENDS | typeof ABOUT;

/** The page of a URL or hash ("#trendi?g=1" → trendi). */
export function pageOf(url: string = window.location.href): Page {
  const hash = url.includes("#") ? url.slice(url.indexOf("#")) : "";
  const name = hash.replace(/^#/, "").split("?")[0];
  return name === TRENDS ? TRENDS : name === ABOUT ? ABOUT : "explorer";
}

/** The query part of a hash: "#trendi?g=133" → g=133. */
export const hashQuery = (hash: string = window.location.hash) => new URLSearchParams(hash.replace(/^#[^?]*\??/, ""));

/** An opened sale or rental. */
export type Selected = { kind: "sale" | "rent"; id: number };

/** Everything the explorer shows. */
export interface ExplorerState {
  g?: number; building?: { ko: number; st: string }; selected?: Selected; group: PropertyGroup; landScope: LandScope; landChosen: boolean;
  size?: string; street?: string; years: Period; layer: MetricId; value: boolean;
}
export const DEFAULT_STATE: ExplorerState = { group: "apartment", landScope: "strict", landChosen: false, years: 1, layer: "salePrice", value: false };

const GROUP_SLUGS: Record<PropertyGroup, string> = { apartment: "", house: "hise", land: "zemljisca", commercial: "poslovni", garage: "garaze" }; // i18n-ignore: URL slugs (links keep working)
const LAND_SLUGS: Record<LandScope, string> = { strict: "zazidljiva", agricultural: "kmetijska", forest: "gozdna", all: "vsa" }; // i18n-ignore: URL slugs (links keep working)
const bySlug = <K extends string>(slugs: Record<K, string>, slug: string | null) => (Object.entries(slugs) as Array<[K, string]>).find(([, value]) => value && value === slug)?.[0];

/**
 * `#?g=133&b=1734-1710&posel=985416&vrsta=hise&obdobje=3&sloj=rentPrice`; a chosen year range is `od=2019&do=2021`.
 * Unknown parts are ignored and dropped on the next write (`3d=1` of links to the former 3D view among them).
 */
export function parseHash(hash: string = window.location.hash): ExplorerState {
  const query = hashQuery(hash);
  const g = Number(query.get("g"));
  const [ko, st] = (query.get("b") ?? "").split("-");
  const sale = Number(query.get("posel")); // i18n-ignore: URL parameter names (links keep working)
  const rent = Number(query.get("najem")); // i18n-ignore: URL parameter names (links keep working)
  const years = Number(query.get("obdobje")); // i18n-ignore: URL parameter names (links keep working)
  const layer = query.get("sloj") as MetricId | null; // i18n-ignore: URL parameter names (links keep working)
  return {
    g: Number.isInteger(g) && g > 0 ? g : undefined,
    building: Number(ko) > 0 && st ? { ko: Number(ko), st } : undefined,
    selected: Number.isInteger(sale) && sale !== 0 ? { kind: "sale", id: sale } : Number.isInteger(rent) && rent !== 0 ? { kind: "rent", id: rent } : undefined,
    group: bySlug(GROUP_SLUGS, query.get("vrsta")) ?? "apartment", // i18n-ignore: URL parameter names (links keep working)
    landChosen: query.has("raba"), // i18n-ignore: URL parameter names (links keep working)
    landScope: bySlug(LAND_SLUGS, query.get("raba")) ?? "strict", // i18n-ignore: URL parameter names (links keep working)
    size: query.get("m2") ?? undefined,
    street: query.get("ulica") ?? undefined, // i18n-ignore: URL parameter names (links keep working)
    years: parsePeriod(query.get("od"), query.get("do")) ?? (years === 3 || years === 5 ? years : 1), // i18n-ignore: URL parameter names (links keep working)
    layer: layer && layer in METRICS ? layer : "salePrice",
    value: query.get("vrednost") === "1", // i18n-ignore: URL slugs (links keep working)
  };
}

/** The canonical hash of a state: defaults and invalid parts are left out ("#" for Slovenija). */
export function toHash(state: ExplorerState) {
  const query = new URLSearchParams();
  if (state.g) query.set("g", String(state.g));
  if (state.building) query.set("b", `${state.building.ko}-${state.building.st}`);
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
export const hrefWith = (patch: Partial<ExplorerState>, hash: string = window.location.hash) => toHash({ ...parseHash(hash), ...patch });
/** A link to one area (Slovenija without an id). */
export const areaHref = (id?: number) => toHash({ ...DEFAULT_STATE, g: id });
/** A link to one sale or rental from a page outside the explorer. */
export const transactionHref = (selected: Selected) => toHash({ ...DEFAULT_STATE, selected });
/** The trends page, for the area of the explorer when there is one. */
export const trendsHref = (g?: number) => g ? `#${TRENDS}?g=${g}` : `#${TRENDS}`;

/** A non-numeric area id in the link (`g=abc`) is reported instead of silently showing Slovenija. */
export function hasBadArea(hash: string = window.location.hash) {
  const raw = hashQuery(hash).get("g");
  return raw != null && !(Number(raw) > 0);
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
  if (old.get("g")) next.set("g", old.get("g")!);
  if (old.get("ko") && old.get("st")) next.set("b", `${old.get("ko")}-${old.get("st")}`);
  for (const key of ["posel", "najem"]) if (old.get(key)) next.set(key, old.get(key)!); // i18n-ignore (URL keys)
  if (old.get("vrsta") === "hise") next.set("vrsta", "hise"); // i18n-ignore (URL keys)
  if (old.get("m") && old.get("m") !== "salePrice") next.set("sloj", old.get("m")!);
  const text = next.toString();
  return text ? `#?${text}` : "#";
}
