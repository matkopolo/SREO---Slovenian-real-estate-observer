import { useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode, type Ref } from "react";
import { focusQuietly, jumpTo } from "../focus";
import { noEstimate } from "./Missing";
import {
  loadBuilding, loadInflationBetween, loadPriceIndex, loadRentOverview, loadSaleAreas, loadSaleEvidence, loadSaleOverview, loadSpread, marketWindows, shiftWindow,
  type BuildingStatistics, type Distribution, type Geography, type MarketIndex, type PropertyGroup, type RentalOverview, type RentGroup, type StatisticsOverview,
} from "../api";
import { AreaSearch } from "./AreaSearch";
import { addressLabel } from "../address";
import { benchmarkPlace, chooseBenchmark } from "./TransactionDetails";
import { BuildingFacts } from "./BuildingFacts";
import { RangeBar } from "./charts";
import { LoadFailed } from "./LoadState";
import { dateCompact as date, decimal1, euro, integer, median, percentSigned as signed, sqm, todayIso } from "../format";
import { useLoad } from "../hooks/useLoad";
import { LANG, proper, t, tx } from "../i18n";
import type { MarketComparable } from "../api";
import { allRejected, failed as failedResult, settled } from "../promise";
import { buildingKey, transactionHref, type BuildingRef } from "../url-state";
import { ALL_SOLD, OF_TYPE, SIMILAR, TYPE_LABEL, TYPE_NAME } from "../nouns";
import { saleScenario, TAX_RULES } from "../resale";
import { count, forms, NOUN_FORMS } from "../plural";
import { whileLayoutSettles } from "../scroll";
import { chooseReference, DISTRICT_MIN_SAMPLE, type Typical, type ValueBand as Band } from "../valuation";
import { buildValueRows, join, km, roundThousand as round, span as spanIn, type Purchase } from "./value-rows";
import "./value-check.css";

export type { Purchase } from "./value-rows";

const ENGLISH = LANG === "en";
/** "266.000–314.000 €" / "€266,000–€314,000" */
const range = (low: number, high: number) => ENGLISH ? `${euro(low)}–${euro(high)}` : `${integer(low)}–${euro(high)}`;
const span = (low: number, high: number) => spanIn(low, high, ENGLISH);
/** A deduction: "−1.234 €", but never "−0 €". */
const minus = (value: number) => Math.round(Math.abs(value)) === 0 ? euro(0) : `−${euro(Math.abs(value))}`;
/** The condition question (land has none; a garage is valued by one typical price, without a band). Ticked, the value moves to the lower quarter of the evidence. */
const CONDITION: Partial<Record<PropertyGroup, string>> = {
  apartment: t("Stanovanje je v slabšem stanju od povprečnega (ni obnovljeno)"),
  house: t("Hiša je v slabšem stanju od povprečne (ni obnovljena)"),
  commercial: t("Poslovni prostor je v slabšem stanju od povprečnega (ni obnovljen)"),
};
/** Accusative: "Stavba ima 11 enot". */
const UNITS = forms(["enoto", "enoti", "enote", "enot"], ["unit", "units"]); // i18n-ignore
const RECORDS = forms(["enak vpis", "enaka vpisa", "enaki vpisi", "enakih vpisov"], ["identical record", "identical records"]); // i18n-ignore
/** "2 dela" / "2 parts": the parts of one package sale. */
const PARTS = forms(["del", "dela", "deli", "delov"], ["part", "parts"]); // i18n-ignore

/** One recorded sale of the unit; a package sale arrives once per part (same transaction). */
interface UnitEvent { transactionId: number; componentId?: number | null; contractDate?: string | null; agreementPrice?: number | null; area?: number | null; share?: string | null }
/** The unit's other sales with a package's parts grouped under their sale (one date and price each), oldest first. */
export function groupPackages<T extends UnitEvent>(events: T[]): Array<{ transactionId: number; contractDate?: string | null; agreementPrice?: number | null; parts: T[] }> { // i18n-ignore (code, not text)
  const sales = new Map<number, { transactionId: number; contractDate?: string | null; agreementPrice?: number | null; parts: T[] }>();
  for (const event of events) {
    const sale = sales.get(event.transactionId);
    if (sale) { if (!sale.parts.some((part) => part.componentId != null && part.componentId === event.componentId)) sale.parts.push(event); }
    else sales.set(event.transactionId, { transactionId: event.transactionId, contractDate: event.contractDate, agreementPrice: event.agreementPrice, parts: [event] });
  }
  return [...sales.values()];
}

/** "v občini Ljubljana" / "in Ljubljana": where the municipality figures come from. */
const inMunicipality = (name?: string): ReactNode => name ? tx("v občini {municipality}", { municipality: proper(name) }) : t("v občini");
/** "v četrtni skupnosti Jarše" / "in the Jarše city district" (names arrive without the register prefix). */
const inDistrict = (name: string): ReactNode => tx("v četrtni skupnosti {name}", { name });
/** An example address for the search field. */
const EXAMPLE_ADDRESS = "Dunajska cesta 221, Ljubljana"; // i18n-ignore
const SUPPORTED: PropertyGroup[] = ["apartment", "house", "commercial", "garage", "land"];
/** How many comparables the list shows before "Prikaži vse", and how many sales the purchase picker lists. */
const COMPARABLES_SHOWN = 8;
const PICK_ROWS = 40;
/** A sale far below the building's usual €/m² (a family sale, a share) is marked: below this share of the median. */
const LOW_PRICE_SHARE = 0.4;
/** A garage's typical price pools this many months when the year is thin. */
const GARAGE_POOL_MONTHS = 24;
/** The purchase-time median covers this many months around the purchase (either side). */
const THEN_HALF_MONTHS = 6;
/** The headline's scale leaves room above the highest marker. */
const SCALE_HEADROOM = 1.08;
/** Agents in Slovenia may charge at most 4 % + DDV (22 %). */
const AGENT_FEE_RATE = 0.04 * 1.22;

/** The similar sales found for the estimate, the circle they were searched in (centre and radius); `trusted` when the estimate rests on them. */
export interface ShownComparables { comparables: MarketComparable[]; center: [number, number]; radiusMeters: number; trusted: boolean }
/** A city district (četrtna skupnost) the property lies in. */
interface District { id: number; name: string }
type Evidence = Awaited<ReturnType<typeof loadSaleEvidence>>;

/**
 * "Koliko je vredna moja nepremičnina?": find the address, pick (or type) your purchase, then today's value from the
 * evidence (similar sales, else the district or municipality), your own price updated with the local market as context, and a sale-now tax scenario.
 * The page has one close control: "← Nazaj na pregled trga" in the explorer bar.
 */
export function ValueCheck({ building: buildingRef, transactionId, municipalityId, cutoff, municipalities, onBuilding, onTransaction, onComparables, onHighlight, onComparable }: {
  building?: BuildingRef; transactionId?: number; municipalityId?: number; cutoff?: string; municipalities: Geography[];
  /** The similar sales found for the estimate and their search radius, for the map; null when there are none. */
  onComparables?: (shown: ShownComparables | null) => void;
  /** The comparable the owner points at in the list, for the map to highlight. */
  onHighlight?: (id: number | null) => void;
  /** Opens a comparable's sale page (the same way as a click on its dot); the row link is the fallback. */
  onComparable?: (item: MarketComparable) => void;
  onBuilding: (ko: number, st: string) => void; onTransaction: (id: number | undefined) => void;
}) {
  const key = buildingRef ? buildingKey(buildingRef) : null;
  const building = useLoad(buildingRef ?? null, (ref) => `building-${buildingKey(ref)}`, (ref, signal) => loadBuilding(ref.ko, ref.st, signal)).data;
  // Opened without an area (or with a typed purchase): the building's municipality and district from one of its sales.
  const first = building?.saleTransactions[0]?.transactionId;
  const areas = useLoad(first ?? null, (id) => `sale-areas-${id}`, (id, signal) => loadSaleAreas(id, signal)).data;
  const [manual, setManual] = useState<Purchase | null>(null);
  const evidenceLoad = useLoad(transactionId ?? null, (id) => `sale-evidence-${id}`, (id, signal) => loadSaleEvidence(id, signal));
  const evidence = evidenceLoad.data;
  const stepOne = useRef<HTMLLIElement>(null);
  const stepTwo = useRef<HTMLHeadingElement>(null);
  // Raised when the owner picks or types a purchase: the answer heading takes focus as soon as it renders.
  const [focusRequest, setFocusRequest] = useState(0);

  // Step 1: the address field takes focus (and scrolls up, clear of the phone keyboard) when the check opens or the address is changed.
  useEffect(() => {
    if (key) return;
    const step = stepOne.current;
    return bringUp(step, step?.querySelector("input"));
  }, [key]);
  // Step 2: once the address is found (or the purchase is changed), focus moves to picking the purchase.
  const choosing = !!building && !transactionId && !manual;
  useEffect(() => {
    if (!choosing) return;
    return bringUp(stepTwo.current, stepTwo.current);
  }, [choosing, building]);

  const detail = manual ? undefined : settled(evidence?.detail);
  // A sale of a type the check cannot value is never valued as a flat.
  const group = detail ? SUPPORTED.find((item) => item === detail.propertyGroup) : undefined;
  const unsupported = !!detail && !group;
  const purchase: Purchase | null = manual ?? (detail && group && detail.price != null && detail.area != null && detail.contractDate
    ? { price: detail.price, date: detail.contractDate, area: detail.area, group, transactionId }
    : null);
  const resolvedDistrict = areas?.find((item) => item.level === "city_district");
  const purchaseMunicipality = detail?.geographies.find((item) => item.level === "municipality")?.id ?? areas?.find((item) => item.level === "municipality")?.id ?? municipalityId;
  const saleDistrict = detail?.geographies.find((item) => item.level === "city_district") ?? resolvedDistrict;
  const district = saleDistrict ? { id: saleDistrict.id, name: saleDistrict.name } : undefined;
  const beforeBuilt = purchase && building?.constructionYear && Number(purchase.date.slice(0, 4)) < building.constructionYear;

  return <article className="area-panel value-check" aria-labelledby="value-title">
    <h1 id="value-title" className="area-title">{t("Koliko je vredna vaša nepremičnina?")}</h1>
    <p className="area-lede">{t("Poiščite naslov, izberite svoj nakup in dobite oceno današnje vrednosti iz podobnih prodaj.")} {t("Ocena je statistična, ne uradna cenitev.")}</p>

    <ol className="steps">
      <li ref={stepOne} className={buildingRef ? "done" : "current"}>
        <h2 className="value-step">{t("1. Naslov")}</h2>
        {building ? <p>{building.constructionYear ? tx("{address}, zgrajena {year}", { address: buildingName(building), year: building.constructionYear }) : buildingName(building)}{" "}
          <button type="button" className="link" onClick={() => { setManual(null); onTransaction(undefined); onBuilding(0, ""); }}>{t("spremeni")}</button></p>
          : <AreaSearch regions={[]} municipalities={municipalities} includeCountry={false} label={t("Naslov nepremičnine")} placeholder={t("npr. {example}", { example: EXAMPLE_ADDRESS })}
            onArea={() => undefined} onAddress={(address) => onBuilding(address.cadastralMunicipalityCode, address.buildingNumber)}/>}
      </li>
      {building && <li className={purchase ? "done" : "current"}>
        <h2 className="value-step" ref={stepTwo} tabIndex={-1}>{t("2. Vaš nakup")}</h2>
        {purchase ? <><p>{tx("{type}, {area} m², kupljeno {date} za {price} ({perSqm} €/m²)", { type: TYPE_NAME[purchase.group], area: decimal1(purchase.area),
          date: whenNode(purchase.date), price: moneyNode(purchase.price), perSqm: integer(purchase.price / purchase.area) })}{" "}
          <button type="button" className="link" onClick={() => { setManual(null); onTransaction(undefined); }}>{t("spremeni")}</button></p>
          {beforeBuilt && <p className="error" role="alert">{t("Datum nakupa je pred letom izgradnje stavbe ({year}).", { year: building.constructionYear })} {t("Preverite datum.")}</p>}</>
          : <>
            {unsupported && <p className="error" role="alert">{t("Te vrste nepremičnine ne znamo oceniti.")} {t("Izberite vrsto spodaj in vnesite svoj nakup.")}</p>}
            {evidenceLoad.error != null && <LoadFailed retry={evidenceLoad.retry}>{t("Prodaje ni bilo mogoče naložiti.")}</LoadFailed>}
            <PickPurchase building={building} onPick={(id) => { setFocusRequest((value) => value + 1); onTransaction(id); }}
              onManual={(value) => { setFocusRequest((value) => value + 1); setManual(value); }}/>
          </>}
      </li>}
    </ol>

    {purchase && <Estimates purchase={purchase} evidence={manual ? undefined : evidence} municipalityId={purchaseMunicipality} district={district} cutoff={cutoff}
      focusRequest={focusRequest} municipalityName={municipalities.find((item) => item.id === purchaseMunicipality)?.name}
      onComparables={onComparables} onHighlight={onHighlight} onComparable={onComparable} evidenceLoading={!manual && evidenceLoad.loading}/>}
  </article>;
}

/** A price and a date as they are marked up in sentences. */
function moneyNode(amount: number) { return <span className="money">{euro(amount)}</span>; }
function whenNode(value: string) { return <span className="when">{date(value)}</span>; }

/** The building's address (a register name), else its cadastral number. */
const buildingName = (building: BuildingStatistics) => proper(addressLabel(building))
  || t("Stavba {ko}-{st}", { ko: building.cadastralMunicipalityCode, st: building.buildingNumber });

/** A step is scrolled back to the top while it sits lower than this (pixels) and still has focus. */
const STEP_TOP_PX = 160;
/**
 * Focus a step and scroll it to the top of the screen. The page grows while the map and the area load, so the scroll is
 * repeated briefly, but only while the step still has focus and is not near the top (the owner has not moved on).
 */
function bringUp(step: HTMLElement | null | undefined, target: HTMLElement | null | undefined) {
  if (!step || !target) return;
  target.focus({ preventScroll: true });
  // Done once the owner has moved on; otherwise keep it in place while the page above it grows.
  const scroll = () => {
    if (document.activeElement !== target) return true;
    const y = step.getBoundingClientRect().y;
    if (y < 0 || y > STEP_TOP_PX) step.scrollIntoView({ block: "start" });
    return false;
  };
  return whileLayoutSettles(document.body, scroll);
}

/**
 * A euro amount: plain digits while typing, "289.000" once the field is left. The value passed around is digits only.
 */
function MoneyInput({ value, onChange, required, invalid, describedBy, inputRef }: {
  value: string; onChange: (value: string) => void; required?: boolean; invalid?: boolean; describedBy?: string; inputRef?: Ref<HTMLInputElement>; // i18n-ignore (code, not text)
}) {
  const [editing, setEditing] = useState(false);
  const shown = editing || value === "" || !Number.isFinite(Number(value)) ? value : integer(Number(value));
  return <input ref={inputRef} type="text" inputMode="numeric" autoComplete="off" value={shown} required={required} aria-invalid={invalid || undefined} aria-describedby={describedBy}
    onFocus={() => setEditing(true)} onBlur={() => setEditing(false)} onChange={(event) => onChange(event.target.value.replace(/\D/g, ""))}/>;
}

type PurchaseField = "price" | "date" | "area";
/** Which fields of a typed purchase are not usable, in the form's order. */
export function invalidFields(form: { price: string; date: string; area: string }): PurchaseField[] {
  return [
    ...(Number(form.price) > 0 ? [] : ["price" as const]),
    ...(/^\d{4}-\d{2}-\d{2}$/.test(form.date) && form.date >= "2007-01-01" ? [] : ["date" as const]),
    ...(Number(form.area) > 0 ? [] : ["area" as const]),
  ];
}

type SaleRow = BuildingStatistics["saleTransactions"][number] & { copies: number; lowPrice: boolean };

function PickPurchase({ building, onPick, onManual }: { building: BuildingStatistics; onPick: (id: number) => void; onManual: (purchase: Purchase) => void }) {
  // Every type is offered; the most common one in the building is preselected.
  const sold = (group: PropertyGroup) => building.saleTransactions.filter((sale) => sale.propertyGroup === group).length;
  const [group, setGroup] = useState<PropertyGroup>(() => [...SUPPORTED].sort((a, b) => sold(b) - sold(a))[0]);
  const [form, setForm] = useState({ price: "", date: "", area: "" });
  const sales = building.saleTransactions.filter((item) => item.propertyGroup === group)
    .sort((a, b) => (b.contractDate ?? "").localeCompare(a.contractDate ?? ""));
  // A price far below the building's usual €/m² (a family sale, a share) is marked like the rows left out of the statistics.
  const typical = sales.length >= 3 ? median(sales.flatMap((item) => item.amountPerSqm != null ? [item.amountPerSqm] : [])) : null;
  // The register sometimes lists one deal twice (same date, price and area): one row, with the count.
  const rows = sales.reduce<SaleRow[]>((list, item) => {
    const same = item.amount != null && list.find((row) => row.contractDate === item.contractDate && row.amount === item.amount && row.area === item.area);
    if (same) same.copies += 1;
    else list.push({ ...item, copies: 1, lowPrice: typical != null && item.amountPerSqm != null && item.amountPerSqm < typical * LOW_PRICE_SHARE });
    return list;
  }, []);
  // An implausible type for this building: a house among many units, or a flat in a building of one unit.
  const units = building.knownBuildingPartCount;
  const likely: PropertyGroup | null = sales.length ? null : group === "house" && units >= 3 ? "apartment" : group === "apartment" && units === 1 ? "house" : null;
  // Validated on submit (the button is never disabled): each wrong field says why, and focus goes to the first one.
  const [errors, setErrors] = useState<PurchaseField[]>([]);
  const formId = useId();
  const priceField = useRef<HTMLInputElement>(null), dateField = useRef<HTMLInputElement>(null), areaField = useRef<HTMLInputElement>(null); // i18n-ignore (code, not text)
  const messages: Record<PurchaseField, string> = { price: t("Vpišite nakupno ceno v evrih."), date: t("Vpišite datum nakupa (od leta 2007 naprej)."), area: t("Vpišite površino v m².") };
  const errorOf = (field: PurchaseField) => errors.includes(field) ? `${formId}-${field}` : undefined;
  const edit = (patch: Partial<typeof form>) => { setForm({ ...form, ...patch }); setErrors(errors.filter((field) => !(field in patch))); };
  return <div className="pick">
    <div className="value-types" role="group" aria-label={t("Vrsta nepremičnine")}>
      {SUPPORTED.map((item) => <button key={item} type="button" aria-pressed={group === item} onClick={() => setGroup(item)}>{TYPE_LABEL[item]}</button>)}
    </div>
    {likely && <p className="value-caveat value-type-warning" role="status">
      {likely === "apartment" ? t("Stavba ima {units} – je vaša nepremičnina res hiša?", { units: count(units, UNITS) })
        : t("Stavba ima samo eno enoto – je vaša nepremičnina morda hiša?")}{" "}
      <button type="button" className="link" onClick={() => setGroup(likely)}>{likely === "apartment" ? t("Izberi stanovanje") : t("Izberi hišo")}</button></p>}
    {rows.length ? <>
      <p className="note muted">{t("Izberite svoj nakup med evidentiranimi prodajami {type} v stavbi.", { type: OF_TYPE_LABEL(group) })}</p>
      <div className="table-scroll value-pick-scroll"><table className="compact-table value-pick">
        <caption className="sr-only">{t("Prodaje v stavbi")}</caption>
        <thead><tr><th scope="col">{t("Datum")}</th><th scope="col">{t("Površina")}</th><th scope="col">{t("Cena")}</th><th scope="col"><span className="sr-only">{t("Izbira")}</span></th></tr></thead>
        <tbody>{rows.slice(0, PICK_ROWS).map((item) => <tr key={item.transactionId} className={item.representative === false || item.lowPrice ? "atypical" : undefined}>
          <th scope="row" className="pick-date"><span className="when">{item.contractDate ? date(item.contractDate) : "—"}</span></th>
          <td className="pick-area"><span className="when">{item.area == null ? "—" : sqm(item.area)}</span></td>
          <td className="pick-price"><span className="money">{item.amount == null ? "—" : euro(item.amount)}</span>
            {(item.representative === false || item.lowPrice) && <small> {item.representative === false ? t("ni upoštevana v statistiki")
              : t("neobičajno nizka cena – verjetno ni tržni posel")}</small>}
            {item.copies > 1 && <small> {t("{records} – verjetno isti posel", { records: count(item.copies, RECORDS) })}</small>}</td>
          <td className="pick-action"><button type="button" className="ghost" onClick={() => onPick(item.transactionId)}>{t("To je moj nakup")} <span aria-hidden="true">›</span></button></td>
        </tr>)}</tbody>
      </table></div>
    </> : <p className="note muted">{t("V tej stavbi ni evidentirane prodaje te vrste ({type}).", { type: TYPE_NAME[group] })} {t("Vnesite svoj nakup spodaj.")}</p>}
    <details key={group} className="module" open={!rows.length}>
      <summary>{rows.length ? t("Mojega nakupa ni na seznamu") : t("Vnesite svoj nakup")}</summary>
      <form className="calc-inputs" noValidate onSubmit={(event) => {
        event.preventDefault();
        const wrong = invalidFields(form);
        setErrors(wrong);
        if (wrong.length) { ({ price: priceField, date: dateField, area: areaField })[wrong[0]].current?.focus(); return; }
        onManual({ price: Number(form.price), date: form.date, area: Number(form.area), group });
      }}>
        <label>{t("Nakupna cena (€)")}<MoneyInput inputRef={priceField} value={form.price} onChange={(price) => edit({ price })} required invalid={errors.includes("price")} describedBy={errorOf("price")}/>
          {errors.includes("price") && <span id={errorOf("price")} className="field-error">{messages.price}</span>}</label>
        <label>{t("Datum nakupa")}<input ref={dateField} type="date" min="2007-01-01" value={form.date} onChange={(event) => edit({ date: event.target.value })} required
          aria-invalid={errors.includes("date") || undefined} aria-describedby={errorOf("date")}/>
          {errors.includes("date") && <span id={errorOf("date")} className="field-error">{messages.date}</span>}</label>
        <label>{t("Površina (m²)")}<input ref={areaField} type="number" inputMode="decimal" min={1} step={0.1} value={form.area} onChange={(event) => edit({ area: event.target.value })} required
          aria-invalid={errors.includes("area") || undefined} aria-describedby={errorOf("area")}/>
          {errors.includes("area") && <span id={errorOf("area")} className="field-error">{messages.area}</span>}</label>
        <button type="submit" className="value-primary">{t("Izračunaj vrednost")}</button>
      </form>
    </details>
  </div>;
}
/** "prodaje stanovanj": the type in the genitive plural, from nouns.ts. */
const OF_TYPE_LABEL = (group: PropertyGroup) => OF_TYPE[group];

function indexAt(items: MarketIndex[], month: string) {
  const published = items.filter((item) => item.isPublishable).sort((a, b) => a.period.localeCompare(b.period));
  return published.filter((item) => month >= item.period.slice(0, 7)).at(-1) ?? published[0];
}

/** The municipality's (and district's) figures; `failed` when a part could not be loaded (never silently "no data"). */
interface AreaData { sale?: StatisticsOverview; pooled?: boolean; spread?: Distribution; districtSpread?: Distribution; districtTypical?: Typical; failed: boolean }
interface RentData { rent?: RentalOverview; rentSpread?: Distribution; districtRent?: RentalOverview; districtRentSpread?: Distribution; failed: boolean }
const NO_AREA: AreaData = { failed: false };

function Estimates({ purchase, evidence, evidenceLoading = false, municipalityId, municipalityName, district, cutoff, focusRequest, onComparables, onHighlight, onComparable }: {
  purchase: Purchase; evidence?: Evidence; evidenceLoading?: boolean; municipalityId?: number; municipalityName?: string; district?: District; cutoff?: string;
  /** Raised each time the owner picks a purchase: the answer heading then takes focus. */
  focusRequest: number;
  onComparables?: (shown: ShownComparables | null) => void; onHighlight?: (id: number | null) => void; onComparable?: (item: MarketComparable) => void;
}) {
  const [poorCondition, setPoorCondition] = useState(false);
  const garage = purchase.group === "garage";
  const index = useLoad(purchase.group, (group) => `price-index-${group}`, async (group, signal) => (await loadPriceIndex(group, signal)).items);
  const areaInput = cutoff && municipalityId ? { cutoff, municipalityId, group: purchase.group, district, key: `${cutoff}|${municipalityId}|${purchase.group}|${district?.id ?? ""}` } : null;
  // The headline waits for the district and the municipality together, so it never jumps from one to the other.
  const sales = useLoad(areaInput, (input) => `value-sales|${input.key}`, async (input, signal): Promise<AreaData> => {
    const window = marketWindows(input.cutoff).sales.current;
    const segment = { propertyGroup: input.group };
    const typical = async (id: number): Promise<Typical> => {
      const sale = await loadSaleOverview(id, segment, window, signal);
      if (!garage || sale.isPublishable) return { sale, pooled: false };
      // Garages sell rarely: like the area page, pool three years before giving up on a typical price.
      const pooled = await loadSaleOverview(id, segment, { from: shiftWindow(window, GARAGE_POOL_MONTHS).from, to: window.to }, signal);
      return pooled.isPublishable ? { sale: pooled, pooled: true } : { sale, pooled: false };
    };
    const none = Promise.resolve(undefined);
    const [municipal, districtTypical, spread, districtSpread] = await Promise.allSettled([
      typical(input.municipalityId),
      garage && input.district ? typical(input.district.id) : none,
      garage ? none : loadSpread(input.municipalityId, window, segment, "sale", signal),
      !garage && input.district ? loadSpread(input.district.id, window, segment, "sale", signal) : none,
    ]);
    const parts = [municipal, districtTypical, spread, districtSpread];
    const outage = allRejected(parts);
    if (outage) throw outage.reason;
    const own = settled(municipal);
    return { sale: own?.sale, pooled: own?.pooled, districtTypical: settled(districtTypical), spread: settled(spread), districtSpread: settled(districtSpread), failed: parts.some(failedResult) };
  });
  // Rents: the last mostly reported full year (rental contracts are recorded up to a year late).
  const rents = useLoad(areaInput && purchase.group !== "land" ? areaInput : null, (input) => `value-rents|${input.key}`, async (input, signal): Promise<RentData> => {
    const window = marketWindows(input.cutoff).rents.current;
    const segment = { propertyGroup: input.group };
    const rentSegment = { propertyGroup: input.group as RentGroup };
    const none = Promise.resolve(undefined);
    const parts = await Promise.allSettled([
      loadRentOverview(input.municipalityId, rentSegment, window, signal),
      loadSpread(input.municipalityId, window, segment, "rent", signal),
      input.district ? loadRentOverview(input.district.id, rentSegment, window, signal) : none,
      input.district ? loadSpread(input.district.id, window, segment, "rent", signal) : none,
    ]);
    const outage = allRejected(parts);
    if (outage) throw outage.reason;
    const [rent, rentSpread, districtRent, districtRentSpread] = parts;
    return { rent: settled(rent), rentSpread: settled(rentSpread), districtRent: settled(districtRent), districtRentSpread: settled(districtRentSpread), failed: parts.some(failedResult) };
  });
  // The municipality's median in the 12 months around the purchase: the local market change since then.
  const thenLoad = useLoad(municipalityId ? { municipalityId, group: purchase.group, date: purchase.date } : null, (input) => `value-then|${input.municipalityId}|${input.group}|${input.date}`,
    (input, signal) => {
      const day = { from: input.date, to: input.date };
      return loadSaleOverview(input.municipalityId, { propertyGroup: input.group }, { from: shiftWindow(day, THEN_HALF_MONTHS).from, to: shiftWindow(day, -THEN_HALF_MONTHS).to }, signal);
    });
  const then = thenLoad.data;
  // SURS publishes a month's CPI in the following month, so the newest index the API can serve is the month before the data's cutoff month.
  const inflation = useLoad(cutoff ? { from: `${purchase.date.slice(0, 7)}-01`, to: shiftWindow({ from: cutoff, to: `${cutoff.slice(0, 7)}-01` }, 1).to } : null,
    (input) => `inflation|${input.from}|${input.to}`, async (input, signal) => (await loadInflationBetween(input.from, input.to, signal)).factor).data;
  const area = sales.data ?? NO_AREA;
  const areaFailed = area.failed || sales.error != null || thenLoad.error != null;

  const context = settled(evidence?.context);
  const history = settled(evidence?.history);
  const registers = settled(evidence?.detail)?.building ?? null;
  const market = context?.currentMarketEstimate ?? null;
  const items = index.data ?? (index.error ? [] : undefined);
  const latest = items ? items.filter((item) => item.isPublishable).sort((a, b) => a.period.localeCompare(b.period)).at(-1) : undefined;
  const atPurchase = items?.length ? indexAt(items, purchase.date.slice(0, 7)) : undefined;
  const national = latest && atPurchase ? latest.indexValue / atPurchase.indexValue : null;
  const indexed = national != null ? purchase.price * national : null;
  const municipalWhere = inMunicipality(municipalityName);

  const { reference, local, localSales, useDistrict, districtBand, garageSource, trustedMarket, wideRadius, localNow, localThen, localFactor, anchored, garageMismatch,
    asksCondition, worse, answer } = chooseReference({ purchase, market, municipal: area, district: district && { spread: area.districtSpread, typical: area.districtTypical },
    then, poorCondition, hasCondition: CONDITION[purchase.group] != null });
  // The similar sales go to the map and the list below, worded by whether the headline rests on them (a set the estimate
  // does not use still shows what sold nearby). One object per settled estimate, reported once per change; while a new
  // estimate loads the map keeps the previous one. An estimate from before this field simply shows no list.
  const shownComparables = market?.comparables.length ? market.comparables : null;
  const trusted = reference?.kind === "market";
  const subjectLon = market?.subjectLongitude, subjectLat = market?.subjectLatitude, radiusMeters = market?.maximumRadiusMeters;
  useEffect(() => {
    if (evidenceLoading) return;
    onComparables?.(shownComparables && subjectLon != null && subjectLat != null && radiusMeters != null
      ? { comparables: shownComparables, center: [subjectLon, subjectLat], radiusMeters, trusted } : null);
  }, [evidenceLoading, onComparables, radiusMeters, shownComparables, subjectLat, subjectLon, trusted]);
  const callbacks = useRef({ onComparables, onHighlight });
  useLayoutEffect(() => { callbacks.current = { onComparables, onHighlight }; });
  useEffect(() => () => { callbacks.current.onComparables?.(null); callbacks.current.onHighlight?.(null); }, []);
  // "Prikaži vse" holds for this estimate only.
  const [expandedFor, setExpandedFor] = useState<unknown>(null);
  const allComparables = expandedFor === market;
  const condition = CONDITION[purchase.group];
  const where = useDistrict && district ? inDistrict(district.name) : municipalWhere;
  // The row today's estimate rests on: it carries the "osnova ocene" chip and, for a worse condition, where the value moved to.
  const basisKey = reference?.kind === "market" ? "market" : reference ? "local" : anchored != null ? "updated" : null;
  const worseNote = worse && reference ? t("slabše stanje: ocena na spodnji četrtini ({low}) namesto na mediani ({mid})", { low: euro(round(reference.low)), mid: euro(round(reference.mid)) }) : null;

  // How the purchase compared with the market at the time: the same benchmark and words as the sale page (narrowest publishable area, never a sample of one).
  const benchmark = context ? chooseBenchmark(context.benchmarks) : undefined;
  const benchmarkPercent = benchmark ? Math.round(Math.abs(benchmark.differencePercent)) : 0;
  const paidThen: ReactNode = !benchmark ? null : (() => {
    const vars = { similar: (benchmark.comparisonProfile === "unadjusted" ? ALL_SOLD : SIMILAR)[purchase.group], where: benchmarkPlace(benchmark) };
    return benchmarkPercent === 0 ? tx("enako mediani {similar} {where} takrat", vars)
      : tx("{difference} mediano {similar} {where} takrat", { ...vars,
        difference: benchmark.differencePercent < 0 ? t("{percent} % pod", { percent: benchmarkPercent }) : t("{percent} % nad", { percent: benchmarkPercent }) });
  })();
  // When it explains why the owner's updated price differs from today's estimate, say so.
  const gapToday = anchored != null && reference != null ? anchored / reference.mid - 1 : null;
  const consequence = benchmark && benchmarkPercent > 0 && gapToday != null && Math.abs(gapToday) > 0.05 && (benchmark.differencePercent < 0) === (gapToday < 0)
    ? gapToday < 0 ? t("Zato je vaša posodobljena nakupna cena nižja od današnje ocene.") : t("Zato je vaša posodobljena nakupna cena višja od današnje ocene.")
    : null;

  // What the estimate rests on, as labelled rows: the purchase, the purchase updated with the municipality, similar sales today, the local band.
  const rows = buildValueRows({ purchase, paidThen, anchored, localThen, localNow, localFactor, national, reference, garageMismatch,
    waiting: thenLoad.loading || sales.loading, failed: areaFailed, market, trustedMarket: trustedMarket != null, wideRadius, districtBand: districtBand != null,
    where, municipalWhere, hasContext: !!context, local, localSales, garageSource, basisKey, worseNote, indexed }, ENGLISH);
  const shownAnswer = rows.length > 1;

  // One scale for everything: today's band (the headline) with the purchase and the updated purchase as markers (rounded like the rows).
  // The other evidence's median is already a row above; a third identical dot only cluttered the bar.
  const markers = [{ value: purchase.price, name: t("vaš nakup") }, ...(anchored != null ? [{ value: round(anchored), name: t("posodobljen nakup") }] : [])];
  const scaleMax = Math.max(...markers.map((marker) => marker.value), answer?.high ?? 0) * SCALE_HEADROOM;
  const events = (history?.assets ?? []).flatMap((asset) => asset.events).filter((event) => event.transactionId !== purchase.transactionId)
    .sort((a, b) => (a.contractDate ?? "").localeCompare(b.contractDate ?? ""));

  // The answer heading takes focus when it first renders after the owner picked a purchase (or when nothing has focus).
  const answerHeading = useRef<HTMLHeadingElement>(null);
  const handled = useRef(0);
  useEffect(() => {
    const heading = answerHeading.current;
    if (!heading || (focusRequest === handled.current && document.activeElement !== document.body)) return;
    handled.current = focusRequest;
    focusQuietly(heading);
  }, [focusRequest, shownAnswer]);
  if (!shownAnswer) return <p className="note muted" role="status">{items && (sales.data || sales.error || !areaInput) ? noEstimate() : t("Računam ocene\u00a0…")}</p>;
  // The one value of the page: rent yield and the sale scenario use it too.
  const value = answer?.mid ?? null;
  const change = value != null && purchase.price > 0 ? value / purchase.price - 1 : null;
  const real = change != null && inflation ? (1 + change) / inflation - 1 : null;
  return <>
    <section className="module open value-answer" aria-labelledby="value-answer">
      <h2 id="value-answer" tabIndex={-1} ref={answerHeading}>
        {value == null || !answer ? t("Za zanesljivo oceno ni dovolj lokalnih podatkov") : <>{tx("Ocena danes: okoli {value}", { value: <span className="money">{euro(round(value))}</span> })}
          {round(answer.high) > round(answer.low) && <span className="value-likely"> {tx("(verjetno {range})", { range: <span className="money">{span(answer.low, answer.high)}</span> })}</span>}</>}</h2>
      {change != null && <p className="area-lede">{real != null
        ? tx("{change} od nakupa ({price}, {date}), po upoštevanju inflacije {real}.", { change: signed(change), price: moneyNode(purchase.price), date: whenNode(purchase.date), real: signed(real) })
        : tx("{change} od nakupa ({price}, {date}).", { change: signed(change), price: moneyNode(purchase.price), date: whenNode(purchase.date) })}</p>}
      {areaFailed && <LoadFailed retry={() => { sales.retry(); thenLoad.retry(); }}>{t("Cen v občini trenutno ni bilo mogoče naložiti; ocena je brez njih.")}</LoadFailed>}
      <dl className="value-rows">{rows.map((row) => <div key={row.key} className={row.key === basisKey ? "value-row is-basis" : "value-row"}>
        <dt>{row.title}{row.key === basisKey && <span className="chip">{t("osnova ocene")}</span>}</dt>
        <dd className="value-amount money">{row.value ?? "—"}</dd>
        {row.note && <dd className="value-note">{row.note}</dd>}
      </div>)}</dl>
      {consequence && <p className="value-own">{consequence}</p>}
      {shownComparables && <details className="value-comparables">
        <summary>{trusted ? t("Primerljive prodaje na zemljevidu ({count})", { count: shownComparables.length }) : t("Podobne prodaje v okolici na zemljevidu ({count})", { count: shownComparables.length })}</summary>
        <p className="note muted">{trusted ? t("Pike na zemljevidu so prodaje, na katerih temelji ocena; obroč je vaša nepremičnina. Povezava odpre prodajo.")
          : t("Ocena ne temelji na njih (premalo ali preveč različne), a kažejo, kaj se je v okolici prodajalo; obroč je vaša nepremičnina. Povezava odpre prodajo.")}
          {" "}<a href="#explorer-map" className="value-map-jump" onClick={(event) => { event.preventDefault(); jumpTo(document.querySelector<HTMLElement>(".explorer-map-wrap")); }}>{t("Zemljevid je na dnu strani")} <span aria-hidden="true">↓</span></a></p>
        <ol className="rows value-comparable-rows">{(allComparables ? shownComparables : shownComparables.slice(0, COMPARABLES_SHOWN)).map((item) => <li key={item.transactionId}
          onMouseEnter={() => onHighlight?.(item.transactionId)} onMouseLeave={() => onHighlight?.(null)}>
          <a href={transactionHref({ kind: "sale", id: item.transactionId })} onFocus={() => onHighlight?.(item.transactionId)} onBlur={() => onHighlight?.(null)}
            onClick={(event) => { if (!onComparable || event.metaKey || event.ctrlKey || event.shiftKey || event.button !== 0) return; event.preventDefault(); onComparable(item); }}>
            {proper(addressLabel(item)) || t("naslov ni naveden")}</a>
          <span>{[date(item.contractDate), `${integer(item.amountPerSqm)}\u00a0€/m²`, sqm(item.area),
            item.distanceMeters < 1000 ? t("{distance} m", { distance: integer(item.distanceMeters) }) : t("{distance} km", { distance: km(item.distanceMeters) })].join(" · ")}</span>
        </li>)}</ol>
        {!allComparables && shownComparables.length > COMPARABLES_SHOWN && <button type="button" className="ghost" onClick={() => setExpandedFor(market)}>{t("Prikaži vse ({count})", { count: shownComparables.length })}</button>}
      </details>}
      {answer && answer.high > answer.low && <RangeBar p25={answer.low} p50={answer.mid} p75={answer.high} min={0} max={scaleMax} unit="€" markers={markers}
        label={t("Vaš nakup in današnja ocena na isti lestvici")} caption={t("Ocena danes {range}", { range: span(answer.low, answer.high) })}/>}
      {asksCondition && <label className="value-condition">
        <input type="checkbox" checked={poorCondition} onChange={(event) => setPoorCondition(event.target.checked)}/>
        <span>{condition}</span></label>}
      <p className="note muted">{garage ? t("Ocena ne pozna lege garaže (podzemna, zunanja, z vrati).")
        : asksCondition ? t("Ocene ne poznajo nadstropja, razgleda in opreme vaše nepremičnine; slabše stanje označite zgoraj.")
        : t("Ocene ne poznajo nadstropja, razgleda in opreme vaše nepremičnine.")}</p>
    </section>

    {registers && <div className="module open value-registers"><BuildingFacts facts={registers} heading="h2" title={t("Vaša nepremičnina v uradnih registrih")}/></div>}

    {events.length > 0 && <section className="module open">
      <h2>{t("Druge evidentirane prodaje te enote")}</h2>
      {/* A package (a flat with its garage) is one sale with several parts: one date and one price, the parts listed under it. */}
      <ol className="rows">{groupPackages(events).map((sale) => <li key={sale.transactionId}>
        <strong><span className="when">{sale.contractDate ? date(sale.contractDate) : "—"}</span>: <span className="money">{sale.agreementPrice == null ? "—" : euro(sale.agreementPrice)}</span>
          {sale.parts.length > 1 && <span className="muted"> {t("(cena za {parts} skupaj)", { parts: count(sale.parts.length, PARTS) })}</span>}</strong>
        <span>{sale.parts.map((part) => [part.area ? sqm(part.area) : "", part.share && part.share !== "1/1" ? t("delež {share}", { share: part.share }) : ""].filter(Boolean).join(", ")).filter(Boolean).join(" · ")}</span></li>)}</ol>
    </section>}

    <RentEstimate purchase={purchase} area={rents.data} done={!!(rents.data || rents.error)} failed={!!rents.data?.failed || rents.error != null} retry={rents.retry}
      district={district} municipalWhere={municipalWhere} value={value} year={cutoff ? marketWindows(cutoff).rents.year : undefined}/>

    <SaleNow key={`${purchase.transactionId ?? "manual"}-${purchase.group}-${purchase.date}-${purchase.price}`} purchase={purchase} suggested={value ?? purchase.price} band={answer}/>
  </>;
}

function SaleNow({ purchase, suggested, band }: { purchase: Purchase; suggested: number; band: Band | null }) {
  const home = purchase.group === "apartment" || purchase.group === "house";
  const [ownHome, setOwnHome] = useState<boolean | null>(home ? null : false);
  const [sale, setSale] = useState<string>();
  const [disposed, setDisposed] = useState(() => todayIso());
  const [investments, setInvestments] = useState("0");
  const [agent, setAgent] = useState(true);
  const [notary, setNotary] = useState("500");
  const [loan, setLoan] = useState("0");
  const [sellerTax, setSellerTax] = useState(true);
  const price = sale === undefined ? round(suggested) : Number(sale);
  // Quick choices from the estimate: the lower edge, the estimate itself and the upper edge (each once).
  const presets = !band ? [] : [
    { key: "low", label: t("Spodnja meja"), value: round(band.low) },
    { key: "mid", label: t("Ocena"), value: round(band.mid) },
    { key: "high", label: t("Zgornja meja"), value: round(band.high) },
  ].filter((item, _position, list) => item.key === "mid" || item.value !== list[1].value);
  const agentFee = agent ? Math.round(price * AGENT_FEE_RATE) : 0;
  const result = price > 0 ? saleScenario({ acquired: purchase.date, disposed, purchase: purchase.price, sale: price,
    investments: Math.max(0, Number(investments) || 0), sellingCosts: agentFee + Math.max(0, Number(notary) || 0), loan: Math.max(0, Number(loan) || 0),
    ownHome: !!ownHome, sellerPaysTransferTax: sellerTax }) : undefined;
  const exemptHome = !!result && result.rate === 0 && !!ownHome && result.years >= 3;
  const gain = result ? Math.round(result.gain) : 0;
  return <section className="module open" aria-labelledby="sale-title">
    <h2 id="sale-title">{t("Če prodate: koliko vam ostane")}</h2>
    {home && <fieldset className="question">
      <legend>{t("Je to vaš dom (stalno prebivališče in bivanje vsaj 3 leta)?")}</legend>
      <div className="segmented small" role="group" aria-label={t("Lastni dom")}>
        <button type="button" aria-pressed={ownHome === true} onClick={() => setOwnHome(true)}>{t("Da")}</button>
        <button type="button" aria-pressed={ownHome === false} onClick={() => setOwnHome(false)}>{t("Ne")}</button>
      </div>
    </fieldset>}
    {presets.length > 1 && <div className="value-presets" role="group" aria-label={t("Prodajna cena iz ocene")}>
      {presets.map((item) => <button key={item.key} type="button" aria-pressed={price === item.value} onClick={() => setSale(String(item.value))}>
        {item.label} <span className="money">{euro(item.value)}</span></button>)}
    </div>}
    <form className="calc-inputs" onSubmit={(event) => event.preventDefault()}>
      <label>{t("Prodajna cena (€)")}<MoneyInput value={sale ?? String(price)} onChange={setSale}/></label>
      <label>{t("Datum prodaje")}<input type="date" min={purchase.date} value={disposed} onChange={(event) => setDisposed(event.target.value)}/></label>
      <label>{t("Vlaganja od nakupa (€)")}<MoneyInput value={investments} onChange={setInvestments}/>
        <small>{t("prenova, ki jo dokažete z računi; zniža davčno osnovo")}</small></label>
      <label className="check"><input type="checkbox" checked={agent} onChange={(event) => setAgent(event.target.checked)}/> {t("Posrednik (do 4 % + DDV; privzeto vključen)")}</label>
      <label>{t("Notar, overitve, drugo (€)")}<MoneyInput value={notary} onChange={setNotary}/></label>
      <label>{t("Preostanek kredita (€)")}<MoneyInput value={loan} onChange={setLoan}/></label>
      <label className="check"><input type="checkbox" checked={sellerTax} onChange={(event) => setSellerTax(event.target.checked)}/> {t("Davek na promet (2 %) plačam jaz")}</label>
    </form>
    {ownHome === null && <p className="note muted">{t("Odgovorite na vprašanje zgoraj: od tega je odvisen davek na dobiček.")}</p>}
    {result && ownHome !== null && <>
      <ol className="waterfall">
        <li><span>{t("Prodajna cena")}</span><strong>{euro(price)}</strong></li>
        <li><span>{exemptHome ? t("Davek na dobiček – oproščen (vaš dom)")
          : result.rate === 0 ? t("Davek na dobiček – oproščen ({years} lastništva)", { years: count(result.years, NOUN_FORMS.leto) })
          : t("Davek na dobiček ({rate} %, {years} lastništva)", { rate: integer(result.rate * 100), years: count(result.years, NOUN_FORMS.leto) })}</span><strong>{minus(result.capitalGainsTax)}</strong></li>
        <li><span>{t("Davek na promet nepremičnin")}</span><strong>{minus(result.transferTax)}</strong></li>
        <li><span>{t("Posrednik in drugi stroški prodaje")}</span><strong>{minus(result.sellingCosts)}</strong></li>
        <li className="total"><span>{t("Ostane vam po davku in stroških")}</span><strong>{euro(result.net)}</strong></li>
        {Number(loan) > 0 && <li><span>{t("Poplačilo kredita")}</span><strong>{minus(Number(loan))}</strong></li>}
        {Number(loan) > 0 && <li className="total"><span>{t("Ostane vam po poplačilu kredita")}</span><strong>{euro(result.afterLoan)}</strong></li>}
      </ol>
      <p>{gain > 0 ? t("To je {gain} več, kot ste plačali za nakup in vlaganja.", { gain: euro(gain) })
        : gain < 0 ? t("To je {gain} manj, kot ste plačali za nakup in vlaganja.", { gain: euro(-gain) })
        : t("To je toliko, kot ste plačali za nakup in vlaganja.")}
        {result.nextRate && <> {t("Po {date} bo stopnja davka {rate} %.", { date: date(result.nextRate.date), rate: integer(result.nextRate.rate * 100) })}</>}</p>
    </>}
    <p className="note muted">{t("Izobraževalni scenarij za zasebno prodajo brez DDV, ni davčna napoved.")} {t("Davčna osnova za davek na dobiček je razlika med prodajno in nakupno ceno, zmanjšane za dokazana vlaganja in za stroške, ki jih zakon prizna brez računov (1 % nakupne in 1 % prodajne vrednosti).")} {t("Stopnje: manj kot 5 let 25 %, 5–9 let 20 %, 10–14 let 15 %, od 15 let 0 %; lastni dom z bivanjem vsaj 3 leta je oproščen.")}
      {" "}<a href={TAX_RULES.source} target="_blank" rel="noopener noreferrer">{t("FURS: nakup in prodaja nepremičnine")}</a></p>
  </section>;
}

/** What renting it out would bring: the district's rents when it has at least 30 contracts, else the municipality's, scaled to the floor area. */
function RentEstimate({ purchase, area, done, failed, retry, district, municipalWhere, value, year }: {
  purchase: Purchase; area?: RentData; done: boolean; failed: boolean; retry: () => void; district?: District; municipalWhere: ReactNode; value: number | null; year?: number;
}) {
  if (purchase.group === "land") return null;
  const data: RentData = area ?? { failed: false };
  const fromDistrict = !!district && !!data.districtRent?.isPublishable && (data.districtRent.rentPerSqmSampleSize ?? 0) >= DISTRICT_MIN_SAMPLE;
  const rent = fromDistrict ? data.districtRent : data.rent;
  const spread = fromDistrict ? data.districtRentSpread : data.rentSpread;
  const where = fromDistrict && district ? inDistrict(district.name) : municipalWhere;
  const percentiles = spread?.isPublishable ? spread.percentiles : undefined;
  const medianRent = rent?.isPublishable ? rent.medianMonthlyRentPerSqm ?? percentiles?.p50 ?? null : percentiles?.p50 ?? null;
  if (medianRent == null) return <section className="module open"><h2>{t("Najemnina")}</h2>
    {failed ? <LoadFailed retry={retry}>{t("Najemnin ni bilo mogoče naložiti.")}</LoadFailed>
      : <p className="note muted">{done ? t("V občini je bilo v letu {year} premalo najemov te vrste za oceno.", { year: year ?? "" }) : t("Nalagam najemnine\u00a0…")}</p>}</section>;
  const round10 = (amount: number) => Math.round(amount / 10) * 10;
  const low = (percentiles?.p25 ?? medianRent) * purchase.area;
  const high = (percentiles?.p75 ?? medianRent) * purchase.area;
  const mid = medianRent * purchase.area;
  const gross = value ? (mid * 12) / value : null;
  return <section className="module open" aria-labelledby="rent-title">
    <h2 id="rent-title">{tx("Če bi jo oddali: okoli {rent} na mesec", { rent: <span className="money">{euro(round10(mid))}</span> })}</h2>
    <p className="area-lede">{tx("Srednja polovica najemnin {where} za {area}\u00a0m²: {range} na mesec (mediana {median}\u00a0€/m², leto {year}, iz {rentals}).", {
      where, area: decimal1(purchase.area), range: <span className="money">{range(round10(low), round10(high))}</span>, median: decimal1(medianRent), year: year ?? "—",
      rentals: count(rent?.rentPerSqmSampleSize ?? spread?.sampleSize ?? 0, NOUN_FORMS.najem) })}</p>
    <p className="value-caveat">{t("To so evidentirane najemne pogodbe (brez obratovalnih stroškov), ne oglasi: oglasne najemnine so običajno višje.")}</p>
    <p className="note muted">{gross != null && value != null && <>{t("Bruto donos glede na oceno vrednosti ({value}): {yield} % na leto, pred stroški, vzdrževanjem, praznimi meseci in davkom na najemnino (25 % od najemnine po odbitku 10 % stroškov, ki jih zakon prizna brez računov).", {
      value: euro(round(value)), yield: decimal1(gross * 100) })} </>}{t("Najemne pogodbe GURS evidentira z zamikom, zato uporabljamo zadnje celo leto.")}</p>
  </section>;
}

export { join };
