import type { LandScope, PropertyGroup } from "./api";
import { LANG, t } from "./i18n";

/**
 * Every word table for property types, in one place.
 *
 * Words for each property type, per language (declined forms cannot come from one dictionary key, so each
 * language has its own table; the Slovenian one is the source). How templates use each key:
 *  plural   – nominative plural, after a comma or as a subject: "Mediana cene, {noun}" → "Median price, apartments";
 *             "Za {noun} v tem obdobju …" → "For apartments in this period …".
 *  sold     – the verb after the plural: "{noun} {sold}" → "apartments sold".
 *  genitive – plural after "of": "Mediana cene {noun}" → "Median price of apartments", "{count} prodaj {noun}" → "{count} sales of apartments".
 *  one      – singular, bare: "apartment".
 *  ofOne    – one item after "of": "ni bilo evidentirane prodaje {noun}" → "no sale of an apartment was recorded".
 *  buy      – object of "buy": "lahko kupite {noun}" → "you can buy an apartment".
 *  typical  – sentence-initial "typical …": "Typical apartment".
 *  label    – button / heading label (sentence case): "Apartments".
 */
export interface NounForms { plural: string; sold: string; genitive: string; one: string; ofOne: string; buy: string; typical: string; label: string }
const NOUNS_SL: Record<PropertyGroup, NounForms> = {
  apartment: { plural: "stanovanja", sold: "so se prodajala", genitive: "stanovanj", one: "stanovanje", ofOne: "stanovanja", buy: "stanovanje", typical: "Tipično stanovanje", label: "Stanovanja" }, // i18n-ignore
  house: { plural: "hiše", sold: "so se prodajale", genitive: "hiš", one: "hiša", ofOne: "hiše", buy: "hišo", typical: "Tipična hiša", label: "Hiše" }, // i18n-ignore
  land: { plural: "zemljišča", sold: "so se prodajala", genitive: "zemljišč", one: "zemljišče", ofOne: "zemljišča", buy: "zemljišče", typical: "Tipično zemljišče", label: "Zemljišča" }, // i18n-ignore
  commercial: { plural: "poslovni prostori", sold: "so se prodajali", genitive: "poslovnih prostorov", one: "poslovni prostor", ofOne: "poslovnega prostora", buy: "poslovni prostor", typical: "Tipičen poslovni prostor", label: "Poslovni prostori" }, // i18n-ignore
  garage: { plural: "garaže", sold: "so se prodajale", genitive: "garaž", one: "garaža", ofOne: "garaže", buy: "garažo", typical: "Tipična garaža", label: "Garaže in parkirišča" }, // i18n-ignore
};
const NOUNS_EN: Record<PropertyGroup, NounForms> = {
  apartment: { plural: "apartments", sold: "sold", genitive: "apartments", one: "apartment", ofOne: "an apartment", buy: "an apartment", typical: "Typical apartment", label: "Apartments" },
  house: { plural: "houses", sold: "sold", genitive: "houses", one: "house", ofOne: "a house", buy: "a house", typical: "Typical house", label: "Houses" },
  land: { plural: "land", sold: "sold", genitive: "land", one: "plot of land", ofOne: "land", buy: "land", typical: "Typical plot", label: "Land" },
  commercial: { plural: "commercial premises", sold: "sold", genitive: "commercial premises", one: "commercial premises", ofOne: "commercial premises", buy: "commercial premises", typical: "Typical commercial premises", label: "Commercial premises" },
  garage: { plural: "garages", sold: "sold", genitive: "garages", one: "garage", ofOne: "a garage", buy: "a garage", typical: "Typical garage", label: "Garages and parking spaces" },
};
export const NOUNS: Record<PropertyGroup, NounForms> = LANG === "en" ? NOUNS_EN : NOUNS_SL;
/** Rooms are only rented (never sold on their own): the genitive plural for "Mediana najemnine {noun}". */
export const ROOMS_GENITIVE = LANG === "en" ? "rooms" : "sob"; // i18n-ignore (Slovenian genitive)

/** Land uses; the label is an adjective that is also used lower-cased before "zemljišča" / "land". */
export const LAND_SCOPES: Array<{ id: LandScope; label: string }> = [
  { id: "strict", label: t("Zazidljiva") }, { id: "agricultural", label: t("Kmetijska") }, { id: "forest", label: t("Gozdna") }, { id: "all", label: t("Vsa") },
];
/** `NounForms.genitive` of land by use ("Mediana cene {noun}" → "Median price of building land"). */
export const LAND_GENITIVE: Record<LandScope, string> = { strict: t("zazidljivih zemljišč"), agricultural: t("kmetijskih zemljišč"), forest: t("gozdnih zemljišč"), all: t("zemljišč (vseh vrst)") };

/** Register types in the singular, lower case ("stanovanje", "garaža / parkirišče"); also mixed packages and rooms. */
export const TYPE_NAME: Record<string, string> = { apartment: t("stanovanje"), house: t("hiša"), garage: t("garaža / parkirišče"), commercial: t("poslovni prostor"),
  land: t("zemljišče"), mixed: t("več vrst"), unknown: t("neznano"), room: t("soba") };
/** The same, capitalised for buttons ("Garaža / parkirišče"). */
export const TYPE_LABEL: Record<PropertyGroup, string> = { apartment: t("Stanovanje"), house: t("Hiša"), commercial: t("Poslovni prostor"), garage: t("Garaža / parkirišče"), land: t("Zemljišče") };
/** The noun that opens a sale title ("Stanovanje 61,7 m² · …"). */
export const TITLE_NOUN: Record<string, string> = { apartment: t("Stanovanje"), house: t("Hiša"), garage: t("Garaža"), commercial: t("Poslovni prostor"), land: t("Zemljišče"),
  mixed: t("Več nepremičnin"), room: t("Soba") };
/** "prodaje …": the type in the genitive plural ("sales of …" in English). */
export const OF_TYPE: Record<PropertyGroup, string> = { apartment: t("stanovanj"), house: t("hiš"), commercial: t("poslovnih prostorov"), garage: t("garaž in parkirišč"), land: t("zemljišč") };
/** "mediana podobnih …" and "mediana vseh prodanih/oddanih …". */
export const SIMILAR: Record<string, string> = { apartment: t("podobnih stanovanj"), house: t("podobnih hiš"), garage: t("podobnih garaž"),
  commercial: t("podobnih poslovnih prostorov"), land: t("podobnih zemljišč"), room: t("podobnih sob") };
export const ALL_SOLD: Record<string, string> = { apartment: t("vseh prodanih stanovanj"), house: t("vseh prodanih hiš"), garage: t("vseh prodanih garaž"),
  commercial: t("vseh prodanih poslovnih prostorov"), land: t("vseh prodanih zemljišč"), room: t("vseh prodanih sob") };
export const ALL_RENTED: Record<string, string> = { apartment: t("vseh oddanih stanovanj"), house: t("vseh oddanih hiš"), garage: t("vseh oddanih garaž"),
  commercial: t("vseh oddanih poslovnih prostorov"), land: t("vseh oddanih zemljišč"), room: t("vseh oddanih sob") };

// ------------------------------------------------------------------ size bands

export interface Band { id: string; label: string; min?: number; max?: number; typical?: number }
export const ALL_SIZES: Band = { id: "vse", label: t("vse") };
const upTo = (area: number) => t("do {area} m²", { area });
const over = (area: number) => t("nad {area} m²", { area });

/** Floor-area bands per type (the old dashboard's "Površina od–do"); `m2=45-70` in the link. Land and garages have none. */
export const SIZE_BANDS: Partial<Record<PropertyGroup, Band[]>> = {
  apartment: [{ id: "-45", label: upTo(45), max: 44.99, typical: 38 }, { id: "45-70", label: "45–70 m²", min: 45, max: 69.99, typical: 58 },
    { id: "70-100", label: "70–100 m²", min: 70, max: 99.99, typical: 83 }, { id: "100-", label: over(100), min: 100, typical: 125 }],
  house: [{ id: "-100", label: upTo(100), max: 99.99, typical: 80 }, { id: "100-150", label: "100–150 m²", min: 100, max: 149.99, typical: 125 },
    { id: "150-200", label: "150–200 m²", min: 150, max: 199.99, typical: 175 }, { id: "200-", label: over(200), min: 200, typical: 240 }],
  commercial: [{ id: "-50", label: upTo(50), max: 49.99, typical: 35 }, { id: "50-150", label: "50–150 m²", min: 50, max: 149.99, typical: 90 },
    { id: "150-", label: over(150), min: 150, typical: 250 }],
};
export const sizeBand = (group: PropertyGroup, id?: string) => SIZE_BANDS[group]?.find((band) => band.id === id);
