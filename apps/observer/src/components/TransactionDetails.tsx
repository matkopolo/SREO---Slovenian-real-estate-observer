import { Fragment, type ReactNode } from "react";
import { areaLabel, loadInflationBetween, type PropertyHistory, type RentalTransaction, type SaleTransaction, type TransactionContext, type Valuation } from "../api";
import { capitalise, date, distance as distanceText, euro, integer, landArea, month, percent, perSqm, sqm, titleCase, upTo1 } from "../format";
import { useLoad } from "../hooks/useLoad";
import { proper, t, tx } from "../i18n";
import { ALL_RENTED, ALL_SOLD, SIMILAR, TITLE_NOUN, TYPE_NAME } from "../nouns";
import { count, forms, NOUN_FORMS } from "../plural";
import type { Selected } from "../url-state";
import { addressLabel } from "./AreaSearch";
import "./transaction-details.css";

/**
 * One GURS ETN agreement in plain language: a title a buyer can read ("Stanovanje 61,7 m² · 280.000 € · avgust 2026"),
 * one verdict against similar sales, the unit facts, the same unit's earlier sales and the deals in the same building.
 * Cadastral identifiers and the source's extra area fields live in the collapsed "Podatki iz registra".
 * Every field the source leaves empty is left out instead of being shown as a placeholder.
 */

/** €/m²: whole euros, one decimal below 10 €/m² (farmland, rents). */
export const perSqmText = perSqm;
/** A percent value (45.6 → "+45,6 %"). */
const signed = (value: number) => percent(value / 100, { signed: true, digits: "upTo1" });
const finite = (value: number | null | undefined): value is number => typeof value === "number" && Number.isFinite(value);
/** Source text fields sometimes hold placeholders instead of being empty. */
const text = (value: string | null | undefined) => {
  const trimmed = value?.trim();
  return !trimmed || /^(-|n\/a|null|undefined|ni podatka)$/i.test(trimmed) ? undefined : trimmed;
};
const named = proper;

/** Accusative forms ("zajema 2 dela stavbe", "cena za 3 sestavine"). */
const COMPONENT = forms(["sestavino", "sestavini", "sestavine", "sestavin"], ["component", "components"]); // i18n-ignore
const PART = forms(["del stavbe", "dela stavbe", "dele stavbe", "delov stavbe"], ["unit", "units"]); // i18n-ignore
const PARCEL = forms(["parcelo", "parceli", "parcele", "parcel"], ["parcel", "parcels"]); // i18n-ignore
const MORE_PARTS = forms(["del", "dela", "deli", "delov"], ["other part", "other parts"]); // i18n-ignore
const SPACE = forms(["oddani prostor", "oddana prostora", "oddane prostore", "oddanih prostorov"], ["rented space", "rented spaces"]); // i18n-ignore

type Field = { label: string; value: ReactNode | null | undefined };
type SalePart = SaleTransaction["buildingParts"][number];
type RentalSpace = RentalTransaction["spaces"][number];
type Detail = SaleTransaction | RentalTransaction;
type Benchmark = TransactionContext["benchmarks"][number];

function Fields({ fields, className = "facts td-facts" }: { fields: Field[]; className?: string }) {
  const shown = fields.filter((field) => field.value != null && field.value !== "");
  if (!shown.length) return null;
  return <dl className={className}>{shown.map((field) => <div key={field.label}><dt>{field.label}</dt><dd>{field.value}</dd></div>)}</dl>;
}

const TERM: Record<string, string> = { fixed: t("za določen čas"), indefinite: t("za nedoločen čas") };
const RELIABILITY: Record<string, string> = { high: t("visoka"), moderate: t("srednja"), low: t("nizka"), very_low: t("zelo nizka") };

/**
 * Register codebooks (GURS ETN), by code: the API sends the Slovenian description next to the code.
 * "Vrsta dela stavbe" (sales) and "Vrsta oddanih prostorov" (rentals) share codes 1–15; 16 is rentals only.
 */
const PART_TYPE: Record<number, string> = {
  1: t("Stanovanjska hiša"), 2: t("Stanovanje"), 3: t("Parkirni prostor"), 4: t("Garaža"), 5: t("Pisarniški prostori"),
  6: t("Prostori za poslovanje s strankami"), 7: t("Prostori za zdravstveno dejavnost"), 8: t("Trgovski ali storitveni lokal"), 9: t("Gostinski lokal"),
  10: t("Prostori za šport, kulturo ali izobraževanje"), 11: t("Industrijski prostori"), 12: t("Turistični nastanitveni objekt"), 13: t("Kmetijski objekt"),
  14: t("Tehnični ali pomožni prostori"), 15: t("Drugo"), 16: t("Stanovanjska soba ali sobe"),
};
/** "Vrsta zemljišča" in plain words; the register's own descriptions run to a paragraph of planning terms. */
const LAND_TYPE: Record<number, string> = {
  1: t("Zazidljivo zemljišče z gradbenim dovoljenjem"),
  2: t("Zazidljivo zemljišče s komunalno opremo"),
  3: t("Zazidljivo zemljišče, delno ali brez komunalne opreme"),
  4: t("Zemljišče za ceste ali energetsko infrastrukturo"),
  5: t("Zemljišče pod stavbo ali ob njej (dvorišče, vrt)"),
  6: t("Cesta ali parkirišče"),
  7: t("Kmetijsko zemljišče (njiva, travnik, pašnik)"),
  8: t("Trajni nasad (sadovnjak, vinograd)"),
  9: t("Gozd"),
  10: t("Neplodno ali vodno zemljišče"),
};
/** The codebook entry for a description without a code (older records): matched on the GURS wording. */
const LAND_WORDING: [RegExp, number][] = [ // i18n-ignore (code)
  [/gradbeno dovoljenje/i, 1], [/delno komunalno|neopremljen/i, 3], [/komunalno opremljen/i, 2], [/prometno|energetsko/i, 4], // i18n-ignore (code)
  [/pod stavbo|pripadajo/i, 5], [/cesta ali parkiri/i, 6], [/trajni nasad/i, 8], [/kmetijsk/i, 7], [/gozd/i, 9], [/neplodn|vodno|neuporabn/i, 10], // i18n-ignore (code)
];
const landCode = (code: number | null | undefined, description: string | undefined) =>
  code != null && LAND_TYPE[code] ? code : description ? LAND_WORDING.find(([pattern]) => pattern.test(description))?.[1] : undefined;
/** Position of a unit in its building, as the register writes it. */
const POSITION: Record<string, string> = { pritličje: t("pritličje"), nadstropje: t("nadstropje"), klet: t("klet"), mansarda: t("mansarda"), drugo: t("drugo") };

/** A codebook text by code; an unknown code shows the register's own (Slovenian) description. */
function codebook(map: Record<number, string>, code: number | null | undefined, description: string | undefined): ReactNode | undefined {
  if (!description) return undefined;
  return (code != null ? map[code] : undefined) ?? named(description);
}
const partType = (part: { buildingPartType?: number | null; buildingPartTypeDescription?: string | null }) =>
  codebook(PART_TYPE, part.buildingPartType, text(part.buildingPartTypeDescription));
const spaceType = (space: { rentedSpaceType?: number | null; rentedSpaceTypeDescription?: string | null }) =>
  codebook(PART_TYPE, space.rentedSpaceType, text(space.rentedSpaceTypeDescription));
const position = (value?: string | null) => {
  const place = text(value);
  return place ? POSITION[place.toLocaleLowerCase("sl-SI")] ?? named(place) : undefined;
};

const isSale = (detail: Detail): detail is SaleTransaction => "buildingParts" in detail;

function address(street?: string | null, house?: string | null, settlement?: string | null) {
  const place = text(settlement) && titleCase(text(settlement)!);
  // Rural addresses have no street: the settlement carries the house number ("Krivčevo 4").
  if (!text(street)) return [place, text(house)].filter(Boolean).join(" ") || undefined;
  const line = [titleCase(text(street)!), text(house)].filter(Boolean).join(" ");
  return [line, place].filter(Boolean).join(", ") || undefined;
}
const partLabel = (code?: number | null, building?: string | null, part?: string | null) =>
  [code && t("k. o. {code}", { code }), text(building) && t("stavba {number}", { number: building }), text(part) && t("del {number}", { number: part })]
    .filter(Boolean).join(", ") || undefined;

/** The unit the agreement is about: the largest sold part (a flat rather than its storage room). */
function mainPart(parts: SalePart[]) {
  const size = (part: SalePart) => part.soldArea ?? part.buildingPartArea ?? part.usableArea ?? 0;
  return [...parts].sort((a, b) => size(b) - size(a))[0];
}
function mainSpace(spaces: RentalSpace[]) {
  return [...spaces].sort((a, b) => (b.area ?? b.usableArea ?? 0) - (a.area ?? a.usableArea ?? 0))[0];
}
export const mainUnit = (detail: Detail) => isSale(detail) ? mainPart(detail.buildingParts ?? []) : mainSpace(detail.spaces ?? []);

/** Floor number when the source has one; a useful position word ("pritličje", "klet") otherwise; nothing for a bare "nadstropje". */
function floorText(floor?: string | null, place?: string | null): ReactNode | undefined {
  const number = text(floor);
  if (number) return number;
  const value = text(place);
  return value && !/^nadstropje$/i.test(value) ? position(value) : undefined;
}

/** Joins visible pieces with " · " (pieces may hold register names). */
const dotted = (items: ReactNode[]) => items.filter(Boolean).map((item, index) => <Fragment key={index}>{index > 0 && " · "}{item}</Fragment>);

// ------------------------------------------------------------------ header

/** "Stanovanje 61,7 m² · 280.000 € · avgust 2026" (rent: "… · 400 € na mesec · januar 2023"). */
export function transactionTitle(detail: Detail) {
  const noun = TITLE_NOUN[detail.propertyGroup] ?? t("Nepremičnina");
  const amount = isSale(detail) ? detail.price : detail.monthlyRentExVat;
  const area = finite(detail.area) ? detail.propertyGroup === "land" ? landArea(detail.area) : sqm(detail.area) : undefined;
  return [area ? `${noun} ${area}` : noun,
    finite(amount) ? isSale(detail) ? euro(amount) : t("{amount} na mesec", { amount: euro(amount) }) : undefined,
    detail.contractDate ? month(detail.contractDate) : undefined].filter(Boolean).join(" · ");
}

/** The building register's entry for the primary part's building (current address with its suffix, "15A"). */
type BuildingAddress = { cadastralMunicipalityCode: number; buildingNumber: string } & Parameters<typeof addressLabel>[0];
const sameBuilding = (detail: Detail, building?: BuildingAddress) => {
  const unit = mainUnit(detail);
  return building && unit && building.cadastralMunicipalityCode === unit.cadastralMunicipalityCode && building.buildingNumber === unit.buildingNumber
    ? building : undefined;
};
/**
 * One address for the whole sale page: the primary part's building as the register names it today (with the house-number
 * suffix), else the address written in the agreement. The agreement's own address, when different, is in the register section.
 */
function saleAddress(detail: Detail, building?: BuildingAddress) {
  const unit = mainUnit(detail);
  const own = sameBuilding(detail, building);
  return (own && (own.street || own.houseNumber) ? addressLabel(own) || undefined : undefined) ?? (unit && address(unit.street, unit.houseNumber, unit.settlement));
}
/** The address the agreement itself gives, when it differs from the register's current one ("Krivčevo 4" vs "Velika Planina 21"). */
function contractAddress(detail: Detail, building?: BuildingAddress) {
  const unit = mainUnit(detail);
  const written = unit && address(unit.street, unit.houseNumber, unit.settlement);
  const own = sameBuilding(detail, building);
  if (!written || !own || !(own.street || own.houseNumber)) return undefined;
  const plain = (value: string) => value.toLocaleLowerCase("sl-SI").replace(/[^\p{L}\p{N}]/gu, "");
  // Only the suffix missing ("15" for "15A") is the same address.
  return [addressLabel(own), addressLabel({ ...own, houseNumberSuffix: null })].some((label) => plain(label) === plain(written)) ? undefined : written;
}

/** "Celovška cesta 143, Ljubljana · Šiška": the primary part's address and the narrowest named area. */
export function transactionSubtitle(detail: Detail, building?: BuildingAddress): ReactNode {
  const components = isSale(detail) ? (detail.buildingParts?.length ?? 0) + (detail.landParcels?.length ?? 0) : detail.spaces?.length ?? 0;
  const street = saleAddress(detail, building);
  // One source everywhere: the primary part's address, with the rest of a package counted.
  const place = street && components > 1 ? tx("{address} in še {rest}", { address: named(street), rest: count(components - 1, MORE_PARTS) })
    : street && named(street);
  const areas = detail.geographies ?? [];
  const area = (["city_district", "local_community"] as const).map((level) => areas.find((item) => item.level === level)).find(Boolean)
    ?? areas.find((item) => item.level === "municipality");
  const name = area && areaLabel(area.name);
  const shown = [place, name && !street?.endsWith(name) ? named(name) : undefined].filter(Boolean);
  return shown.length ? dotted(shown) : undefined;
}

// ------------------------------------------------------------------ location

export function googleMapsUrl(latitude?: number | null, longitude?: number | null, place?: string) {
  if (finite(latitude) && finite(longitude) && Math.abs(latitude) <= 90 && Math.abs(longitude) <= 180 && !(latitude === 0 && longitude === 0))
    return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(`${latitude.toFixed(6)},${longitude.toFixed(6)}`)}`; // i18n-ignore (code)
  return place ? `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(`${place}, Slovenija`)}` : undefined; // i18n-ignore (search query)
}

export function MapsLink({ detail, building }: { detail: Detail; building?: BuildingAddress }) {
  const url = googleMapsUrl(detail.latitude, detail.longitude, saleAddress(detail, building));
  if (!url) return null;
  return <p className="td-maps"><a href={url} target="_blank" rel="noopener noreferrer">{t("Odpri v Google Zemljevidih")}<span aria-hidden="true"> ↗</span>
    <span className="sr-only"> {t("(odpre se v novem zavihku)")}</span></a>
    <span className="muted"> {t("Približna lokacija; pri več delih posla lahko kaže le enega.")}</span></p>;
}

// ------------------------------------------------------------------ the one verdict

const SCOPE_RANK: Record<string, number> = { building: 0, nearby: 1, radius: 1, settlement: 2, local_community: 3, city_district: 3, municipality: 5,
  statistical_region: 6, country: 7 };
/**
 * Narrowest first. A village (Krivčevo) is narrower than its local community, but a town settlement (Ljubljana) covers all of
 * its districts: a settlement with more sales than a district or community of the same sale, or named like the municipality,
 * ranks after them, so Šiška wins over "naselje Ljubljana".
 */
function ranker(benchmarks: Benchmark[]) {
  const local = benchmarks.filter((item) => item.scope === "city_district" || item.scope === "local_community");
  const municipality = benchmarks.find((item) => item.scope === "municipality")?.label;
  const broad = (item: Benchmark) => local.some((area) => area.sampleSize < item.sampleSize) || (local.length > 0 && !!municipality && text(item.label) === text(municipality)); // i18n-ignore (code)
  return (item: Benchmark) => item.radiusMeters ? 1 : item.scope === "settlement" && broad(item) ? 4 : SCOPE_RANK[item.scope] ?? 8;
}
const byScope = (benchmarks: Benchmark[]) => {
  const rank = ranker(benchmarks);
  return [...benchmarks].sort((a, b) => rank(a) - rank(b));
};

/** A median of one other sale, or one that is (nearly) only this sale itself, says nothing about the price. */
const comparesWithItself = (item: Benchmark) => item.sampleSize <= 1 || (Math.abs(item.differencePercent) < 0.05 && item.sampleSize < 10); // i18n-ignore (code)
const usable = (item: Benchmark) => item.isPublishable && finite(item.medianAmountPerSqm) && finite(item.differencePercent) && !comparesWithItself(item);

/** The narrowest area with enough sales for a published median that is not just this sale itself. */
export function chooseBenchmark(benchmarks: Benchmark[]) {
  return byScope(benchmarks).find(usable);
}
/** The narrowest named area (district, community, settlement) passed over for too few sales, so the verdict can say so. */
function skippedArea(benchmarks: Benchmark[], chosen?: Benchmark) {
  const rank = ranker(benchmarks);
  return byScope(benchmarks).find((item) => !item.radiusMeters && ["city_district", "local_community", "settlement"].includes(item.scope) && !usable(item)
    && (!chosen || rank(item) < rank(chosen)));
}

/** "v četrtni skupnosti Šiška", "v občini Ljubljana", "v krogu 500 m"; capitalised to open a line. Also the value check's words. */
export function benchmarkPlace(item: Benchmark, capitalised = false): ReactNode {
  const label = text(item.label) ?? "";
  if (finite(item.radiusMeters) && item.radiusMeters > 0) {
    const distance = distanceText(item.radiusMeters);
    return capitalised ? t("V krogu {distance}", { distance }) : t("v krogu {distance}", { distance });
  }
  const vars = (name: string) => ({ name: named(name) });
  switch (item.scope) {
    case "city_district": {
      const name = vars(areaLabel(label));
      return capitalised ? tx("V četrtni skupnosti {name}", name) : tx("v četrtni skupnosti {name}", name);
    }
    case "local_community": {
      const name = vars(areaLabel(label));
      return capitalised ? tx("V krajevni skupnosti {name}", name) : tx("v krajevni skupnosti {name}", name);
    }
    case "settlement": return capitalised ? tx("V naselju {name}", vars(label)) : tx("v naselju {name}", vars(label));
    case "municipality": return capitalised ? tx("V občini {name}", vars(label)) : tx("v občini {name}", vars(label));
    case "statistical_region": return capitalised ? tx("V regiji {name}", vars(label)) : tx("v regiji {name}", vars(label));
    case "country": return capitalised ? t("V Sloveniji") : t("v Sloveniji");
    case "building": return capitalised ? t("V isti stavbi") : t("v isti stavbi");
    default: return label ? capitalised ? tx("V območju {name}", vars(label)) : tx("v območju {name}", vars(label))
      : capitalised ? t("V okolici") : t("v okolici");
  }
}
/** "295 drugih prodaj": the comparison never contains the sale itself, so two sales in one area show different medians. */
const OTHER_SALES = forms(["druge prodaje", "drugih prodaj", "drugih prodaj", "drugih prodaj"], ["other sale", "other sales"]); // i18n-ignore (genitive after "iz")
const OTHER_RENTALS = forms(["drugega najema", "drugih najemov", "drugih najemov", "drugih najemov"], ["other rental", "other rentals"]); // i18n-ignore (genitive after "iz")
/** "podobnih stanovanj" (size and age matched) or "vseh prodanih stanovanj" (no matching). */
function similar(item: Benchmark, group: string, isRent: boolean) {
  if (item.comparisonProfile === "unadjusted")
    return (isRent ? ALL_RENTED : ALL_SOLD)[group] ?? (isRent ? t("vseh oddanih nepremičnin") : t("vseh prodanih nepremičnin"));
  return SIMILAR[group] ?? t("podobnih nepremičnin");
}
const PROFILE: Record<string, string> = {
  area_15_age_8: t("podobna velikost (±15 %) in starost stavbe (±8 let)"),
  area_15: t("podobna velikost (±15 %)"),
  unadjusted: t("vse velikosti in starosti"),
};

export function PriceVerdict({ context, detail, kind, partial = [] }: {
  context?: TransactionContext; detail?: Detail; kind: "sale" | "rent";
  /** Reasons the price is likely for a share or a package (partialSaleReasons): the comparison is then only shown for reference. */
  partial?: string[];
}) {
  if (!context) return null;
  const isRent = kind === "rent";
  const benchmarks = context.benchmarks ?? [];
  const chosen = chooseBenchmark(benchmarks);
  const skipped = skippedArea(benchmarks, chosen);
  const perSqmValue = { format: perSqmText };
  const unit = isRent ? t("€/m² na mesec") : "€/m²";
  const group = detail?.propertyGroup ?? context.propertyGroup;
  const sale = detail && isSale(detail) ? detail : undefined;
  const pkg = sale ? (sale.buildingParts?.length ?? 0) + (sale.landParcels?.length ?? 0) > 1 || /package/i.test(sale.priceDerivation ?? "")
    : detail && !isSale(detail) ? (detail.spaces?.length ?? 0) > 1 : false;
  const notCounted = detail?.quality ? !detail.quality.isRepresentative : false;
  const caveat = [pkg && (isRent ? t("Najemnina velja za več delov skupaj (npr. stanovanje z garažo)") : t("Cena velja za več delov skupaj (npr. stanovanje z garažo)")),
    notCounted && (isRent ? t("ta najem ni upoštevan v statistiki") : t("ta prodaja ni upoštevana v statistiki"))].filter(Boolean) as string[];
  const warning = partial.length > 0 && <p className="td-warning td-partial" role="note"><strong>{t("Verjetno delež ali del paketa — cena ni primerljiva.")}</strong>{" "}
    {capitalise(partial.join("; "))}.</p>;
  const skippedNote = skipped && <p className="td-verdict-meta">{isRent
    ? tx("{where} je bilo v letu {year} premalo podobnih najemov ({count}) za zanesljivo primerjavo, zato primerjamo širše območje.",
      { where: benchmarkPlace(skipped, true), year: skipped.period, count: integer(skipped.sampleSize) })
    : tx("{where} je bilo v letu {year} premalo podobnih prodaj ({count}) za zanesljivo primerjavo, zato primerjamo širše območje.",
      { where: benchmarkPlace(skipped, true), year: skipped.period, count: integer(skipped.sampleSize) })}</p>;
  if (!chosen) return <section className="td-verdict-box" aria-label={t("Primerjava cene")}>
    {warning}
    <p className="td-verdict-line">{isRent ? t("Za zanesljivo primerjavo ni dovolj podobnih najemov v okolici.") : t("Za zanesljivo primerjavo ni dovolj podobnih prodaj v okolici.")}</p>
  </section>;
  const percent = Math.round(Math.abs(chosen.differencePercent));
  const percentile = finite(chosen.percentile) ? Math.min(100, Math.max(0, chosen.percentile)) : undefined;
  const shown = Math.round(percentile ?? 0);
  const compared = { similar: similar(chosen, group, isRent), where: benchmarkPlace(chosen) };
  const equal = { ...compared, equal: <strong>{t("enaka mediani")}</strong> };
  const difference = { ...compared, difference: <strong>{chosen.differencePercent < 0 ? t("{percent} % pod", { percent }) : t("{percent} % nad", { percent })}</strong> };
  const verdict = percent === 0
    ? isRent ? tx("Najemnina na m² je {equal} {similar} {where}", equal) : tx("Cena na m² je {equal} {similar} {where}", equal)
    : isRent ? tx("Najemnina na m² je {difference} mediano {similar} {where}", difference) : tx("Cena na m² je {difference} mediano {similar} {where}", difference);
  const meta = {
    value: perSqmValue.format(chosen.medianAmountPerSqm), unit, year: chosen.period,
    sofar: context.incompletePeriod && chosen.period === context.contractYear ? ` ${t("(do zdaj)")}` : "",
    count: count(chosen.sampleSize, isRent ? OTHER_RENTALS : OTHER_SALES),
  };
  return <section className="td-verdict-box" aria-label={t("Primerjava cene")}>
    {warning}
    <p className={partial.length ? "td-verdict-line muted" : "td-verdict-line"}>{verdict}</p>
    <p className="td-verdict-meta">{t("Mediana {value} {unit} iz {count} v letu {year}{sofar}", meta)}</p>
    {skippedNote}
    {percentile != null && !partial.length && <div className="td-range" role="img"
      aria-label={isRent ? t("Najemnina na m² je višja od {percent} % najemov v tej primerjavi.", { percent: shown })
        : t("Cena na m² je višja od {percent} % prodaj v tej primerjavi.", { percent: shown })}>
      <div className="td-range-track" aria-hidden="true">
        <span className="td-range-middle"/>
        <span className="td-range-median"/>{/* i18n-ignore (class names, code) */}
        <span className="td-range-dot" style={{ left: `${percentile}%` }}/>
      </div>
      <div className="td-range-labels" aria-hidden="true"><span>{t("cenejše")}</span><span>{t("mediana")}</span><span>{t("dražje")}</span></div>
      <p className="td-range-note">{isRent ? t("Višja od {percent} % najemov v tej primerjavi; senčeni del je srednja polovica.", { percent: shown })
        : t("Višja od {percent} % prodaj v tej primerjavi; senčeni del je srednja polovica.", { percent: shown })}</p>
    </div>}
    {caveat.length > 0 && !partial.length && <p className="td-verdict-caveat">{t("{caveats}, zato je primerjava le okvirna.", { caveats: capitalise(caveat.join("; ")) })}</p>}
  </section>;
}

/** Land and house sales whose price is probably for a share or one part of a larger deal. */
const PARCEL_PACKAGE = 5;
export function partialSaleReasons(detail: Detail | undefined, context: TransactionContext | undefined, history: PropertyHistory | undefined): string[] {
  if (!detail || !isSale(detail)) return [];
  const reasons: string[] = [];
  // The share is per component in the register (history events of this agreement).
  const shares = (history?.assets ?? []).flatMap((asset) => asset.events ?? []).filter((event) => event.transactionId === detail.transactionId)
    .map((event) => ({ text: text(event.share), value: fraction(event.share) })).filter((item): item is { text: string; value: number } => !!item.text && item.value != null && item.value < 1);
  const smallest = shares.sort((a, b) => a.value - b.value)[0];
  if (smallest) reasons.push(t("prodan je le delež {share}", { share: smallest.text }));
  const reference = chooseBenchmark(context?.benchmarks ?? [])?.medianAmountPerSqm ?? detail.outlier?.cohortMedian;
  const land = detail.propertyGroup === "land";
  if (finite(detail.pricePerSqm) && finite(reference) && reference > 0 && detail.pricePerSqm < reference * (land ? 0.1 : 0.2)) // i18n-ignore (code)
    reasons.push(t("cena na m² je le {percent} % mediane primerjave", { percent: Math.max(1, Math.round(100 * detail.pricePerSqm / reference)) }));
  const parcels = detail.landParcels?.length ?? 0;
  if (land && parcels >= PARCEL_PACKAGE) reasons.push(t("ena cena velja za {parcels}", { parcels: count(parcels, PARCEL) }));
  return reasons;
}
/** "1/14" → 0.0714; "1/1" → 1. */
function fraction(value?: string | null) {
  const match = /^\s*(\d+)\s*\/\s*(\d+)\s*$/.exec(value ?? "");
  return match && Number(match[2]) > 0 ? Number(match[1]) / Number(match[2]) : undefined;
}

// ------------------------------------------------------------------ how it was calculated

const OUTLIER: Record<string, string> = {
  inlier: t("cena je v običajnem razponu podobnih prodaj"),
  outlier: t("cena izrazito odstopa od podobnih prodaj"),
  insufficient_cohort: t("premalo podobnih prodaj za presojo odstopanja"),
  ineligible: t("ni preverjeno (podatek ne izpolnjuje pravil kakovosti)"),
};
const RENT_OUTLIER: Record<string, string> = {
  inlier: t("najemnina je v običajnem razponu podobnih najemov"),
  outlier: t("najemnina izrazito odstopa od podobnih najemov"),
  insufficient_cohort: t("premalo podobnih najemov za presojo odstopanja"),
  ineligible: t("ni preverjeno (podatek ne izpolnjuje pravil kakovosti)"),
};
const COHORT: Record<string, string> = { building: t("ista stavba"), municipality_year: t("ista občina in leto"), statistical_region_year: t("ista regija in leto") };

export function HowCalculated({ context, valuation, detail, kind }: {
  context?: TransactionContext; valuation?: Valuation; detail?: Detail; kind: "sale" | "rent";
}) {
  const isRent = kind === "rent";
  const perSqmValue = { format: perSqmText };
  const unit = isRent ? t("€/m² na mesec") : "€/m²";
  const group = detail?.propertyGroup ?? context?.propertyGroup ?? "apartment";
  const flats = group === "apartment";
  const benchmarks = byScope(context?.benchmarks ?? []);
  const chosen = chooseBenchmark(benchmarks);
  const estimate = context?.currentMarketEstimate;
  const model = valuation ?? context?.valuation ?? undefined;
  const outlier = detail?.outlier;
  const range = outlier && finite(outlier.lowerBound) && finite(outlier.upperBound)
    ? `${perSqmValue.format(Math.max(0, outlier.lowerBound))}–${perSqmValue.format(outlier.upperBound)} ${unit}` : undefined;
  if (!benchmarks.length && !estimate && !model && !outlier?.status) return null;
  const sales = isRent ? NOUN_FORMS.najem : NOUN_FORMS.prodaja;
  const profile = chosen && chosen.comparisonProfile !== "unadjusted" ? { profile: PROFILE[chosen.comparisonProfile] ?? "" } : undefined;
  const above = isRent
    ? profile ? flats ? t("Zgoraj je najmanjše območje z dovolj najemi istega leta; podobna stanovanja imajo {profile}.", profile)
      : t("Zgoraj je najmanjše območje z dovolj najemi istega leta; podobne nepremičnine imajo {profile}.", profile)
      : t("Zgoraj je najmanjše območje z dovolj najemi istega leta.")
    : profile ? flats ? t("Zgoraj je najmanjše območje z dovolj prodajami istega leta; podobna stanovanja imajo {profile}.", profile)
      : t("Zgoraj je najmanjše območje z dovolj prodajami istega leta; podobne nepremičnine imajo {profile}.", profile)
      : t("Zgoraj je najmanjše območje z dovolj prodajami istega leta.");
  const tooFew = isRent ? t("Za oceno ni dovolj podobnih najemov.") : t("Za oceno ni dovolj podobnih prodaj.");
  const cohort = outlier?.cohortLevel && finite(outlier.cohortMedian)
    ? ` (${COHORT[outlier.cohortLevel] ?? t("podobne prodaje")}${finite(outlier.cohortSize) ? `, ${count(outlier.cohortSize, sales)}` : ""}; ${
      t("mediana {value} {unit}", { value: perSqmValue.format(outlier.cohortMedian), unit })}${range ? `, ${t("običajni razpon {range}", { range })}` : ""})` : "";
  const estimateVars = (item: NonNullable<typeof estimate>) => ({
    price: <strong>{perSqmValue.format(item.centralAmountPerSqm)} {unit}</strong>, unit,
    lower: perSqmValue.format(item.lowerAmountPerSqm), upper: perSqmValue.format(item.upperAmountPerSqm),
    count: count(item.comparableCount, sales), distance: upTo1(item.maximumRadiusMeters / 1000), year: item.referenceYear,
    reliability: RELIABILITY[item.confidence] ?? item.confidence,
  });
  const modelVars = (item: NonNullable<typeof model>) => ({
    value: perSqmValue.format(item.predictedAmountPerSqm), unit, lower: perSqmValue.format(item.lowerAmountPerSqm), upper: perSqmValue.format(item.upperAmountPerSqm),
    reliability: RELIABILITY[item.reliability] ?? item.reliability,
  });
  return <details className="td-how">
    <summary>{t("Kako smo to izračunali")}</summary>
    <div className="td-how-body">
      {benchmarks.length > 0 && <>
        <p>{isRent ? t("Primerjamo najemnino na m² z mediano: polovica najemov je dražjih, polovica cenejših.")
          : t("Primerjamo ceno na m² z mediano: polovica prodaj je dražjih, polovica cenejših.")} {above}</p>
        <h4 className="td-subtitle">{t("Po območjih")}</h4>
        <ul className="rows td-benchmarks">{benchmarks.map((item) => {
          const self = comparesWithItself(item);
          const diff = Math.round(item.differencePercent);
          const median = { value: perSqmValue.format(item.medianAmountPerSqm), unit };
          return <li key={`${item.scope}${item.geographyId ?? item.radiusMeters ?? item.label}`}>
            <strong>{benchmarkPlace(item, true)}{item === chosen && <span className="chip">{t("uporabljeno zgoraj")}</span>}</strong>
            <span>{self ? t("primerjava le s to prodajo, zato je ne upoštevamo")
              : diff === 0 ? t("enako mediani {value} {unit}", median)
                : t("{difference} % glede na mediano {value} {unit}", { ...median, difference: `${diff > 0 ? "+" : "−"}${Math.abs(diff)}` })}
              {` · ${count(item.sampleSize, sales)} (${PROFILE[item.comparisonProfile] ?? t("vse")})`}
              {!item.isPublishable && !self ? ` · ${t("premalo za zanesljivo primerjavo")}` : ""}</span></li>;
        })}</ul></>}
      {estimate && <>
        <h4 className="td-subtitle">{flats ? t("Podobna stanovanja danes") : t("Podobna nepremičnine danes")}</h4>
        {estimate.confidence === "very_low" ? <p>{tooFew}</p> : <p>{isRent
          ? tx("Podobne nepremičnine se danes oddajajo po okoli {price}; srednja polovica podobnih najemov je med {lower} in {upper} {unit} ({count} do {distance} km, preračunano na leto {year}; zanesljivost {reliability}).", estimateVars(estimate))
          : tx("Podobne nepremičnine se danes prodajajo po okoli {price}; srednja polovica podobnih prodaj je med {lower} in {upper} {unit} ({count} do {distance} km, preračunano na leto {year}; zanesljivost {reliability}).", estimateVars(estimate))
        } {t("To so cene podobnih nepremičnin, ne ocena vrednosti te nepremičnine.")}</p>}</>}
      {model && <>
        <h4 className="td-subtitle">{t("Statistični model")}</h4>
        {model.reliability === "very_low" ? <p>{tooFew}</p> : <p>{isRent
          ? t("Model, ki upošteva lokacijo, velikost, starost stavbe in čas najema, bi pričakoval okoli {value} {unit} (v 9 od 10 primerov med {lower} in {upper} {unit}); zanesljivost {reliability}.", modelVars(model))
          : t("Model, ki upošteva lokacijo, velikost, starost stavbe in čas prodaje, bi pričakoval okoli {value} {unit} (v 9 od 10 primerov med {lower} in {upper} {unit}); zanesljivost {reliability}.", modelVars(model))
        } {t("To ni uradna cenitev.")}</p>}</>}
      {outlier?.status && <>
        <h4 className="td-subtitle">{t("Preverjanje odstopanja")}</h4>
        <p>{capitalise((isRent ? RENT_OUTLIER : OUTLIER)[outlier.status] ?? t("odstopanje ni določeno"))}{cohort}.
          {outlier.status === "outlier" ? ` ${t("Odstopanje ni nujno napaka: lahko gre za posebno nepremičnino ali okoliščine posla.")}` : ""}</p></>}
    </div>
  </details>;
}

// ------------------------------------------------------------------ details and packages

export function TransactionFacts({ sale, rent }: { sale?: SaleTransaction; rent?: RentalTransaction }) {
  if (sale) {
    const parts = sale.buildingParts ?? [];
    const parcels = sale.landParcels ?? [];
    const part = mainPart(parts);
    const components = parts.length + parcels.length;
    const area = part?.soldArea ?? part?.buildingPartArea ?? sale.area;
    const largest = [...parcels].sort((a, b) => (b.parcelArea ?? 0) - (a.parcelArea ?? 0))[0];
    const price = finite(sale.price) ? euro(sale.price) : undefined;
    return <section aria-labelledby="td-details"><h3 id="td-details">{t("Podrobnosti")}</h3>
      {part ? <Fields fields={[
        { label: t("Vrsta"), value: partType(part) },
        { label: t("Površina"), value: finite(area) ? sqm(area) : undefined },
        { label: t("Uporabna površina"), value: finite(part.usableArea) && (!finite(area) || Math.abs(part.usableArea - area) >= 0.1) ? sqm(part.usableArea) : undefined },
        { label: t("Nadstropje"), value: floorText(part.floor, part.positionInBuilding) },
        { label: t("Število sob"), value: finite(part.roomCount) ? integer(part.roomCount) : undefined },
        { label: t("Leto gradnje"), value: part.constructionYear },
        { label: t("Zunanja parkirna mesta"), value: finite(part.outdoorParkingSpaces) ? integer(part.outdoorParkingSpaces) : undefined },
      ]}/> : parcels.length === 0 && <p className="muted">{t("Vir ne navaja delov stavbe ali parcel.")}</p>}
      {parcels.length > 0 && <Fields fields={[
        { label: t("Vrsta zemljišča"), value: part || !largest ? undefined : landType(largest) },
        { label: t("Zemljišče skupaj"), value: parcels.some((item) => finite(item.parcelArea)) ? landArea(parcels.reduce((sum, item) => sum + (item.parcelArea ?? 0), 0)) : undefined },
        { label: parcels.length > 1 ? t("Parcele") : t("Parcela"), value: parcelText(parcels) },
      ]}/>}
      {components > 1 && <Package label={price ? t("Cena {price} velja za vse dele skupaj", { price }) : t("Cena velja za vse dele skupaj")}
        note={`${t("Prodaja zajema {components} ({list}).", { components: count(components, COMPONENT),
          list: [parts.length && count(parts.length, PART), parcels.length && count(parcels.length, PARCEL)].filter(Boolean).join(", ") })} ${
          t("Cena na m² je izračunana iz celotne cene, zato ni cena posameznega dela.")}`}
        items={[...parts.map((item) => ({ key: `p${item.id}`, title: partType(item) ?? t("Del stavbe"),
          meta: [finite(item.soldArea ?? item.buildingPartArea) ? sqm((item.soldArea ?? item.buildingPartArea)!) : undefined,
            floorText(item.floor, item.positionInBuilding) && (text(item.floor) ? t("nadstropje {floor}", { floor: item.floor }) : floorText(item.floor, item.positionInBuilding))],
          price: item.contractualPrice })),
        ...parcels.map((item) => ({ key: `l${item.id}`, title: landType(item),
          meta: [text(item.parcelNumber) && t("parcela {number}", { number: item.parcelNumber }), finite(item.parcelArea) ? landArea(item.parcelArea) : undefined],
          price: item.contractualPrice }))]}/>}
    </section>;
  }
  if (!rent) return null;
  const spaces = rent.spaces ?? [];
  const space = mainSpace(spaces);
  const term = TERM[rent.rentalTerm] ?? text(rent.rentalTerm);
  const period = rent.rentalStartDate ? `${date(rent.rentalStartDate)}${rent.rentalEndDate ? `–${date(rent.rentalEndDate)}` : ""}` : undefined;
  const area = space?.area ?? rent.area;
  const monthly = finite(rent.monthlyRentExVat) ? euro(rent.monthlyRentExVat) : undefined;
  return <section aria-labelledby="td-details"><h3 id="td-details">{t("Podrobnosti")}</h3>
    <Fields fields={[
      { label: t("Vrsta oddanega prostora"), value: space ? spaceType(space) : undefined },
      { label: t("Površina"), value: finite(area) ? sqm(area) : undefined },
      { label: t("Uporabna površina"), value: finite(space?.usableArea) && (!finite(area) || Math.abs(space.usableArea - area) >= 0.1) ? sqm(space.usableArea) : undefined },
      { label: t("Trajanje najema"), value: term && (finite(rent.durationMonths) && rent.rentalTerm !== "indefinite"
        ? t("{term}, {months} mes.", { term, months: integer(rent.durationMonths) }) : term) },
      { label: t("Obdobje najema"), value: period },
      { label: t("Obratovalni stroški"), value: rent.operatingCostsIncluded == null ? undefined : rent.operatingCostsIncluded ? t("vključeni v najemnino") : t("niso vključeni v najemnino") },
      { label: t("Najemnina z DDV"), value: finite(rent.monthlyRentReported) && finite(rent.monthlyRentExVat) && Math.abs(rent.monthlyRentReported - rent.monthlyRentExVat) >= 1
        ? t("{amount} na mesec", { amount: euro(rent.monthlyRentReported) }) : undefined },
      { label: t("Tržni najem"), value: rent.isMarketRent === false ? t("ne") : undefined },
      { label: t("Leto gradnje"), value: space?.constructionYear },
    ]}/>
    {spaces.length > 1 && <Package label={monthly ? t("Najemnina {amount} na mesec velja za vse prostore skupaj", { amount: monthly }) : t("Najemnina velja za vse prostore skupaj")}
      note={`${t("Pogodba zajema {spaces}.", { spaces: count(spaces.length, SPACE) })} ${t("Najemnina na m² je izračunana iz celotne najemnine.")}`}
      items={spaces.map((item) => ({ key: `s${item.id}`, title: spaceType(item) ?? t("Oddani prostor"),
        meta: [finite(item.area ?? item.usableArea) ? sqm((item.area ?? item.usableArea)!) : undefined],
        price: item.contractualRent }))}/>}
  </section>;
}

/** "369/3, 370/1 (katastrska občina 2175)": parcel numbers are only unique within a cadastral municipality. */
function parcelText(parcels: SaleTransaction["landParcels"]) {
  const groups = new Map<string, string[]>();
  for (const item of parcels) {
    const number = text(item.parcelNumber);
    if (!number) continue;
    const key = item.cadastralMunicipalityCode ? String(item.cadastralMunicipalityCode) : "";
    groups.set(key, [...(groups.get(key) ?? []), number]);
  }
  const shown = [...groups].map(([code, numbers]) => `${numbers.slice(0, 6).join(", ")}${numbers.length > 6 ? ` ${t("in še {count}", { count: numbers.length - 6 })}` : ""}${
    code ? ` ${t("(katastrska občina {code})", { code })}` : ""}`);
  return shown.length ? shown.join("; ") : undefined;
}

/** Plain words for the land use; an unknown wording shows the register's text up to its brackets. */
const landType = (parcel: { landType?: number | null; landTypeDescription?: string | null }) => {
  const description = text(parcel.landTypeDescription);
  const code = landCode(parcel.landType, description);
  return code != null ? LAND_TYPE[code] : description ? named(description.replace(/\s*\(.*$/, "")) : t("Parcela");
};

function Package({ label, note, items }: { label: string; note: string;
  items: { key: string; title: ReactNode; meta: ReactNode[]; price?: number | null }[] }) {
  return <div className="td-package">
    <p className="td-package-note"><strong>{label}.</strong> {note}</p>
    <ul className="rows td-components">{items.map((item) => <li key={item.key}>
      <strong>{item.title}{finite(item.price) && <span className="td-price"> · {t("cena tega dela {price}", { price: euro(item.price) })}</span>}</strong>
      {item.meta.some(Boolean) && <span>{dotted(item.meta)}</span>}</li>)}</ul>
  </div>;
}

// ------------------------------------------------------------------ register

/**
 * Identifiers and the source's extra fields, collapsed: the transaction id, cadastral labels, the other area fields,
 * the raw position text, both construction years when the unit and the building disagree, and whether the deal counts.
 */
export function RegisterDetails({ detail, buildingYear, building }: { detail: Detail; buildingYear?: number | null; building?: BuildingAddress }) {
  const sale = isSale(detail) ? detail : undefined;
  const unit = mainUnit(detail);
  const part = sale ? unit as SalePart | undefined : undefined;
  const unitYear = unit?.constructionYear;
  const differ = finite(unitYear) && finite(buildingYear) && unitYear !== buildingYear;
  const labels = sale ? [...new Set((sale.buildingParts ?? []).map((item) => partLabel(item.cadastralMunicipalityCode, item.buildingNumber, item.buildingPartNumber)).filter(Boolean))]
    : [...new Set((detail as RentalTransaction).spaces?.map((item) => partLabel(item.cadastralMunicipalityCode, item.buildingNumber, item.buildingPartNumber)).filter(Boolean) ?? [])];
  const parcels = sale ? (sale.landParcels ?? []).map((item) => [item.cadastralMunicipalityCode && t("k. o. {code}", { code: item.cadastralMunicipalityCode }),
    text(item.parcelNumber) && t("parcela {number}", { number: item.parcelNumber })].filter(Boolean).join(", ")).filter(Boolean) : [];
  return <details className="td-register">{/* i18n-ignore (class names, code) */}
    <summary>{t("Podatki iz registra")}</summary>
    <Fields className="facts td-facts td-register-facts" fields={[ // i18n-ignore (code)
      { label: t("Številka posla"), value: String(detail.transactionId) },
      { label: t("Naslov v pogodbi"), value: (() => { const written = contractAddress(detail, building); return written && named(written); })() },
      { label: t("Katastrska oznaka"), value: labels.length ? labels.join("; ") : undefined },
      { label: t("Parcele"), value: parcels.length ? parcels.join("; ") : undefined },
      { label: t("Prodana površina"), value: part && finite(part.soldArea) ? sqm(part.soldArea) : undefined },
      { label: t("Prodana uporabna površina"), value: part && finite(part.soldUsableArea) ? sqm(part.soldUsableArea) : undefined },
      { label: t("Neto površina dela stavbe"), value: part && finite(part.buildingPartArea) ? sqm(part.buildingPartArea) : undefined },
      { label: t("Položaj v stavbi"), value: part ? position(part.positionInBuilding) : undefined },
      { label: differ ? t("Leto gradnje dela stavbe") : t("Leto gradnje"), value: unitYear },
      { label: t("Leto gradnje stavbe"), value: differ ? buildingYear : undefined },
      { label: t("Upoštevan v statistiki"), value: detail.quality ? detail.quality.isRepresentative ? t("da") : t("ne") : undefined },
      { label: t("Vir"), value: t("GURS, evidenca trga nepremičnin") },
    ]}/>
    {differ && <p className="muted td-note">{t("Register navaja dve leti gradnje: {unit} za ta del stavbe in {building} za stavbo (npr. zaradi prizidave ali kasnejšega vpisa).",
      { unit: unitYear, building: buildingYear })} {t("V podrobnostih je leto za ta del stavbe.")}</p>}
  </details>;
}

// ------------------------------------------------------------------ quality

const REASONS: Record<string, string> = {
  missing_contract_date: t("datum pogodbe ni naveden"),
  invalid_contract_date: t("datum pogodbe ni veljaven"),
  missing_or_invalid_area: t("površina ni navedena ali ni veljavna"),
  missing_or_invalid_price: t("cena ni navedena ali ni veljavna"),
  missing_or_invalid_monthly_rent: t("mesečna najemnina ni navedena ali ni veljavna"),
  non_comparable_package: t("prodaja združuje različne vrste nepremičnin, zato cene ni mogoče primerjati"),
  non_market_rent: t("najem ni označen kot tržni (npr. neprofitni ali službeni najem)"),
  unknown_vat_rate: t("stopnje DDV ni mogoče zanesljivo določiti"),
  invalid_fixed_term_duration: t("trajanje najema za določen čas ni veljavno ali je zelo kratko"),
  implausible_area_for_property_group: t("površina je neobičajna za to vrsto nepremičnine"),
  implausible_price_per_sqm: t("cena na m² je zunaj verjetnega razpona"),
  implausible_rent_for_property_group: t("najemnina je neobičajna za to vrsto nepremičnine"),
  extreme_price_per_m2: t("cena na m² izrazito odstopa od podobnih prodaj"),
  missing_coordinates: t("lokacija ni znana"),
  coordinate_outside_slovenia: t("koordinate so zunaj Slovenije"),
  coordinate_outside_municipality: t("koordinate se ne ujemajo z navedeno občino"),
  large_model_residual: t("cena močno odstopa od pričakovane za podobne nepremičnine"),
  isolation_forest_anomaly: t("kombinacija lastnosti je neobičajna"),
};
const DUPLICATES = new Set(["possible_duplicate", "possible_near_duplicate"]);

export function TransactionQuality({ detail }: { detail: Detail }) {
  const isRent = !isSale(detail);
  const quality = detail.quality ?? { isQualityEligible: true, isRepresentative: false, reasons: [], anomalyFlags: [] };
  const flags = quality.anomalyFlags ?? [];
  const duplicate = flags.some((flag) => DUPLICATES.has(flag));
  const reasons = [...new Set([...(quality.reasons ?? []), ...flags.filter((flag) => !DUPLICATES.has(flag))])];
  const status = detail.outlier?.status ? (isRent ? RENT_OUTLIER : OUTLIER)[detail.outlier.status] : undefined;
  const verdict = quality.isRepresentative ? isRent ? t("Najem je upoštevan v statistiki.") : t("Prodaja je upoštevana v statistiki.")
    : quality.isQualityEligible ? isRent ? t("Najem je popolen, a ni upoštevan v statistiki.") : t("Prodaja je popolna, a ni upoštevana v statistiki.")
      : isRent ? t("Najem ni upoštevan v statistiki.") : t("Prodaja ni upoštevana v statistiki.");
  return <section aria-labelledby="td-quality"><h3 id="td-quality">{t("Kakovost podatka")}</h3>
    {duplicate && <p className="td-warning" role="note"><strong>{t("Možen podvojen zapis.")}</strong> {isRent
      ? t("V evidenci je zelo podoben najem; morda gre za isto pogodbo, vpisano dvakrat.")
      : t("V evidenci je zelo podoben posel; morda gre za isto prodajo, vpisano dvakrat.")}</p>}
    <p className="td-verdict">{verdict}{status ? ` ${capitalise(status)}.` : ""}</p>
    {reasons.length > 0 && <><p className="muted">{t("Razlogi:")}</p><ul className="td-reasons">{reasons.map((reason) =>
      <li key={reason}>{REASONS[reason] ?? t("podatek ne izpolnjuje enega od pravil kakovosti")}</li>)}</ul></>}
  </section>;
}

// ------------------------------------------------------------------ history of the same unit

type Pair = PropertyHistory["assets"][number]["pairs"][number];

/** Nominal and CPI-adjusted change between two recorded sales of the same unit. */
function InflationChange({ pair }: { pair: Pair }) {
  const load = useLoad(pair.from && pair.to ? `inflation|${pair.from}|${pair.to}` : null, (signal) => loadInflationBetween(pair.from!, pair.to!, signal));
  const factor = load.error ? null : load.data ? (finite(load.data.factor) ? load.data.factor : null) : undefined;
  if (!finite(pair.previousPrice) || !finite(pair.price)) return null;
  const adjusted = finite(factor) ? pair.previousPrice * factor : undefined;
  return <>
    <span>{t("Nominalno: {amount} ({percent})", { amount: euro(pair.price - pair.previousPrice),
      percent: signed(pair.changePercent ?? 100 * (pair.price / pair.previousPrice - 1)) })}</span>
    {factor === undefined && <span role="status">{t("Nalagam podatke o inflaciji …")}</span>}
    {factor === null && <span>{t("Sprememba po inflaciji ni na voljo.")}</span>}
    {adjusted != null && <span>{t("Po upoštevanju inflacije: {amount} ({percent}); prejšnja cena v današnjem denarju {previous}.", {
      amount: euro(pair.price - adjusted), percent: signed(100 * (pair.price / adjusted - 1)), previous: euro(adjusted) })}</span>}
  </>;
}

export function TransactionHistory({ history, transactionId, onChoose }: {
  history: PropertyHistory; transactionId: number; onChoose: (selected: Selected) => void;
}) {
  const assets = history.assets ?? [];
  // A package links several units to the same agreements; show each agreement and resale pair once.
  const events = [...new Map(assets.flatMap((asset) => asset.events ?? []).map((event) => [event.transactionId, event])).values()]
    .sort((a, b) => (a.contractDate ?? "").localeCompare(b.contractDate ?? ""));
  const pairs = [...new Map(assets.flatMap((asset) => asset.pairs ?? []).map((pair) => [`${pair.previousId}:${pair.transactionId}`, pair])).values()]
    .sort((a, b) => (a.to ?? "").localeCompare(b.to ?? ""));
  return <section aria-labelledby="td-history"><h3 id="td-history">{t("Prejšnje prodaje te nepremičnine")}</h3>
    {events.length <= 1 ? <p className="muted">{assets.length === 0 ? t("Te nepremičnine ne moremo povezati z drugimi zapisi v registru.")
      : t("V evidenci ni drugih prodaj te nepremičnine.")}</p> : <>
      <p className="muted">{t("Prodaje istega stanovanja oziroma parcele po registru.")} {t("Darila in dedovanja niso zajeta.")}</p>
      <ol className="rows td-events">{events.map((event) => {
        const current = event.transactionId === transactionId;
        const perSqm = event.componentCount <= 1 && finite(event.agreementPrice) && finite(event.area) && event.area > 0 ? event.agreementPrice / event.area : undefined;
        return <li key={event.transactionId} aria-current={current ? "true" : undefined} className={current ? "td-current" : undefined}>
          <strong>{current ? <>{event.contractDate ? date(event.contractDate) : t("Datum ni znan")} <span className="chip">{t("ta prodaja")}</span></>
            : <button type="button" className="link" onClick={() => onChoose({ kind: "sale", id: event.transactionId })}>
              {event.contractDate ? date(event.contractDate) : t("Datum ni znan")}</button>}
            {!event.representative && <span className="chip">{t("ni v statistiki")}</span>}
            {event.possibleDuplicate && <span className="chip">{t("možen dvojnik")}</span>}</strong>
          <span>{[t("Prodaja"), TYPE_NAME[event.propertyGroup] ?? undefined].filter(Boolean).join(", ")}
            {finite(event.agreementPrice) ? ` · ${euro(event.agreementPrice)}` : ""}
            {perSqm != null ? ` · ${perSqmText(perSqm)} €/m²` : ""}
            {event.componentCount <= 1 && finite(event.area) ? ` · ${sqm(event.area)}` : ""}
            {event.share && event.share !== "1/1" ? ` · ${t("delež {share}", { share: event.share })}` : ""}
            {event.componentCount > 1 ? ` · ${t("cena za {components} skupaj", { components: count(event.componentCount, COMPONENT) })}` : ""}
            {event.evidence === "building_geolocation_reference" ? ` · ${t("povezano le po lokaciji stavbe")}` : ""}</span>
        </li>;
      })}</ol></>}
    {pairs.length > 0 && <><h4 className="td-subtitle">{t("Ponovne prodaje")}</h4>
      <ol className="rows td-pairs">{pairs.map((pair) => <li key={`${pair.previousId}:${pair.transactionId}`}>
        <strong>{pair.from ? date(pair.from) : "?"} → {pair.to ? date(pair.to) : "?"}
          {finite(pair.days) && pair.days > 0 && <span className="muted"> {t("({years} let)", { years: upTo1(pair.days / 365.25) })}</span>}</strong>
        {finite(pair.previousPrice) && finite(pair.price) && <span>{euro(pair.previousPrice)} → {euro(pair.price)}</span>}
        {pair.comparable ? <InflationChange pair={pair}/>
          : <span>{t("Spremembe cene ne izračunamo: prodaji nista neposredno primerljivi (npr. skupaj z drugimi deli, delni delež, drugačna površina ali možen dvojnik).")}</span>}
        {pair.landTransition && <span>{t("Zemljišče se je medtem iz kmetijskega spremenilo v zazidljivo.")}</span>}
      </li>)}</ol>
      <p className="muted">{t("Razlika med cenama ni dobiček: ne vključuje vlaganj, stroškov in davkov.")} {t("Inflacija po indeksu cen življenjskih potrebščin SURS.")}</p></>}
    {history.truncated && <p className="muted">{t("Prodaja zajema veliko delov; prikazan je le del povezanih zapisov.")}</p>}
  </section>;
}

// ------------------------------------------------------------------ same building

export function BuildingComparables({ context, kind, onChoose }: {
  context: TransactionContext; kind: "sale" | "rent"; onChoose: (selected: Selected) => void;
}) {
  const items = context.directComparables ?? [];
  const perSqmValue = { format: perSqmText };
  const isRent = kind === "rent";
  // Without the building's own list (it could not be loaded): the API's matched subset, named as such.
  return <section aria-labelledby="td-comparables"><h3 id="td-comparables">{isRent ? t("Podobni najemi v isti stavbi") : t("Podobne prodaje v isti stavbi")}</h3>
    {items.length === 0 ? <p className="muted">{isRent ? t("V isti stavbi ni podobnih najemov.") : t("V isti stavbi ni podobnih prodaj.")}</p> : <>
      <p className="muted">{isRent ? t("Najemi istega leta in podobno veliki (±15 %) iz sosednjih let. Razlika v ceni na m² glede na ta najem, brez prilagoditve za čas.")
        : t("Prodaje istega leta in podobno velike (±15 %) iz sosednjih let. Razlika v ceni na m² glede na to prodajo, brez prilagoditve za čas.")}</p>
      <ol className="rows td-comparables">{items.slice(0, 6).map((item) => <li key={item.transactionId}>
        <div className="td-comparable-head">
          <button type="button" className="link" onClick={() => onChoose({ kind, id: item.transactionId })}>{item.contractDate ? date(item.contractDate) : "—"}</button>
          {finite(item.amountPerSqmDifferencePercent) && <strong className="td-diff"
            aria-label={isRent ? t("{difference} na m² glede na ta najem", { difference: signed(item.amountPerSqmDifferencePercent) })
              : t("{difference} na m² glede na to prodajo", { difference: signed(item.amountPerSqmDifferencePercent) })}>{signed(item.amountPerSqmDifferencePercent)}</strong>}
        </div>
        <span>{isRent ? t("{amount} na mesec", { amount: euro(item.amount) }) : euro(item.amount)} · {perSqmValue.format(item.amountPerSqm)} €/m² · {sqm(item.area)}
          {!item.isRepresentative ? ` · ${t("ni v statistiki")}` : ""}</span></li>)}</ol></>}
  </section>;
}
