import { LANG, LOCALE } from "./i18n";

/**
 * Every number, amount, date and name the interface shows is formatted here, once per language
 * (the language is fixed per page load, so the Intl formatters are built once).
 */

/** Non-breaking space: "5 %", "30. 6. 2026" never wrap. */
export const NBSP = " ";
/** Typographic minus (U+2212), also in English, so signed values line up. */
const MINUS = "−";

// Thousands are always grouped ("2.864"): Slovenian's CLDR minimum of two grouping digits would leave four-digit numbers
// ungrouped in engines that honour it (Firefox), so the same page showed "2864" and "2.864" to different readers.
// (The ES2023 string value is not in the TypeScript lib this project compiles against.)
const GROUPED = { useGrouping: "always" as unknown as boolean };
const integerFormat = new Intl.NumberFormat(LOCALE, { maximumFractionDigits: 0, ...GROUPED });
const decimal1Format = new Intl.NumberFormat(LOCALE, { minimumFractionDigits: 1, maximumFractionDigits: 1, ...GROUPED });
const upTo1Format = new Intl.NumberFormat(LOCALE, { maximumFractionDigits: 1, ...GROUPED });
const upTo2Format = new Intl.NumberFormat(LOCALE, { maximumFractionDigits: 2, ...GROUPED });
const euroFormat = new Intl.NumberFormat(LOCALE, { style: "currency", currency: "EUR", maximumFractionDigits: 0, ...GROUPED });

/** "1.234" */
export const integer = (value: number) => integerFormat.format(value);
/** "1,0", "12,3" (always one decimal) */
export const decimal1 = (value: number) => decimal1Format.format(value);
/** "1", "12,3" (at most one decimal) */
export const upTo1 = (value: number) => upTo1Format.format(value);
/** "2,44" (at most two decimals) */
export const upTo2 = (value: number) => upTo2Format.format(value);
/** "289.000 €" / "€289,000" */
export const euro = (value: number) => euroFormat.format(value);
/** €/m² without the unit: whole euros, one decimal below 10 €/m² (farmland, rents). */
export const perSqm = (value: number) => (value !== 0 && Math.abs(value) < 10 ? decimal1 : integer)(value);
/** A floor area: "61,7 m²". */
export const sqm = (value: number) => `${upTo1(value)}${NBSP}m²`;
/** A land area: hectares from 1 ha up ("7,47 ha"), else whole m². */
export const landArea = (value: number) => value >= 10000 ? `${upTo2(value / 10000)}${NBSP}ha` : `${integer(value)}${NBSP}m²`;
/** "1,2 km" / "800 m" */
export const distance = (meters: number) => meters >= 1000 ? `${upTo1(meters / 1000)} km` : `${integer(meters)} m`;

/**
 * A share or change given as a fraction (0.098 → "9,8 %" / "9.8%"). `signed` adds "+" to gains; losses always carry "−",
 * and a value that rounds to zero carries no sign. `digits: "upTo1"` drops a trailing ",0".
 */
export function percent(fraction: number, { signed = false, digits = "fixed" }: { signed?: boolean; digits?: "fixed" | "upTo1" } = {}) {
  const body = (digits === "fixed" ? decimal1 : upTo1)(Math.abs(fraction) * 100);
  const zero = !/[1-9]/.test(body);
  const sign = zero ? "" : fraction < 0 ? MINUS : signed && fraction > 0 ? "+" : "";
  return `${sign}${body}${LANG === "en" ? "" : NBSP}%`;
}

/** Relative change, or null when either side is missing (or the base is not positive). */
export const change = (current?: number | null, previous?: number | null) =>
  current != null && previous != null && previous > 0 ? current / previous - 1 : null;

/** The median (the mean of the middle pair for an even count); null for no values. */
export function median(values: number[]) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

/** Monthly instalment of an annuity loan (display arithmetic; lending limits come from the API). */
export function instalment(loan: number, annualPercent: number, years: number) {
  const rate = annualPercent / 100 / 12;
  const months = years * 12;
  return rate === 0 ? loan / months : (loan * rate) / (1 - (1 + rate) ** -months);
}

// ------------------------------------------------------------------ dates

const day = (value: string) => new Date(`${value.slice(0, 10)}T00:00:00`);
const numericDate = new Intl.DateTimeFormat(LOCALE, { day: "numeric", month: "numeric", year: "numeric" });
const compactDate = new Intl.DateTimeFormat(LOCALE, { day: "numeric", month: LANG === "en" ? "short" : "numeric", year: "numeric" });
const monthYear = new Intl.DateTimeFormat(LOCALE, { month: "long", year: "numeric" });

/** "30. 6. 2026" / "30/06/2026" (an ISO date or timestamp). */
export const date = (value: string) => numericDate.format(day(value));
/** "30. 6. 2026" / "30 Jun 2026" with non-breaking spaces, so a date never wraps. */
export const dateCompact = (value: string) => compactDate.format(day(value)).replace(/ /g, NBSP);
/** "avgust 2026" / "August 2026" */
export const month = (value: string) => monthYear.format(day(value));

// ------------------------------------------------------------------ names

/** "v 12 mesecih …" → "V 12 mesecih …" at the start of a sentence. */
export const capitalise = (text: string) => text.charAt(0).toLocaleUpperCase(LOCALE) + text.slice(1);

/** Street words that stay lower case after the first word ("Celovška cesta", "Ulica bratov Učakar", "Gorenja vas"). */
const GENERIC = new Set(["cesta", "cesti", "ulica", "ul.", "pot", "trg", "steza", "breg", "klanec", "drevored", "sprehajališče", "nabrežje", "nasip", // i18n-ignore (register spelling)
  "naselje", "vas", "ob", "na", "pod", "nad", "pri", "za", "v", "in", "do"]); // i18n-ignore (register spelling)

/** "DUNAJSKA CESTA" → "Dunajska cesta", "GORENJA VAS" → "Gorenja vas" (register names are upper case). */
export function titleCase(value: string | null | undefined) {
  return (value ?? "").toLocaleLowerCase("sl-SI").split(/([\s(-]+)/).map((word, index) =>
    index > 0 && GENERIC.has(word) ? word : word.replace(/^\p{L}/u, (letter) => letter.toLocaleUpperCase("sl-SI"))).join("");
}
