import { Fragment, useEffect, useRef, useState, type ReactNode } from "react";
import {
  loadBuilding, loadInflationBetween, loadPriceIndex, loadRentOverview, loadSaleAreas, loadSaleEvidence, loadSaleOverview, loadSpread, marketWindows, shiftWindow,
  type BuildingStatistics, type Distribution, type Geography, type MarketIndex, type PropertyGroup, type RentalOverview, type RentGroup, type StatisticsOverview,
} from "../api";
import { addressLabel, AreaSearch } from "./AreaSearch";
import { benchmarkPlace, chooseBenchmark } from "./TransactionDetails";
import { RangeBar } from "./charts";
import { dateCompact as date, decimal1, euro, integer, median, percent, sqm, upTo1 } from "../format";
import { useLoad } from "../hooks/useLoad";
import { LANG, proper, t, tx } from "../i18n";
import { ALL_SOLD, OF_TYPE, SIMILAR, TYPE_LABEL, TYPE_NAME } from "../nouns";
import { saleScenario, TAX_RULES } from "../resale";
import { count, forms, NOUN_FORMS } from "../plural";
import { whileLayoutSettles } from "../scroll";
import { chooseReference, DISTRICT_MIN_SAMPLE, type Typical, type ValueBand as Band } from "../valuation";
import "./value-check.css";

const signed = (fraction: number) => percent(fraction, { signed: true });
const round = (value: number) => Math.round(value / 1000) * 1000;
/** "266.000–314.000 €" / "€266,000–€314,000" */
const range = (low: number, high: number) => LANG === "en" ? `${euro(low)}–${euro(high)}` : `${integer(low)}–${euro(high)}`;
const span = (low: number, high: number) => range(round(low), round(high));
/** A deduction: "−1.234 €", but never "−0 €". */
const minus = (value: number) => Math.round(Math.abs(value)) === 0 ? euro(0) : `−${euro(Math.abs(value))}`;
const km = (meters: number) => upTo1(meters / 1000);
/** The condition question (land has none; a garage is valued by one typical price, without a band). Ticked, the value moves to the lower quarter of the evidence. */
const CONDITION: Partial<Record<PropertyGroup, string>> = {
  apartment: t("Stanovanje je v slabšem stanju od povprečnega (ni obnovljeno)"),
  house: t("Hiša je v slabšem stanju od povprečne (ni obnovljena)"),
  commercial: t("Poslovni prostor je v slabšem stanju od povprečnega (ni obnovljen)"),
};
/** The similar-sales row: "Podobna stanovanja danes" (nominative plural, so each type is its own key). */
const SIMILAR_TODAY: Record<PropertyGroup, string> = {
  apartment: t("Podobna stanovanja danes"), house: t("Podobne hiše danes"), commercial: t("Podobni poslovni prostori danes"),
  garage: t("Podobne garaže danes"), land: t("Podobna zemljišča danes"),
};
/** Accusative: "Stavba ima 11 enot". */
const UNITS = forms(["enoto", "enoti", "enote", "enot"], ["unit", "units"]); // i18n-ignore
const RECORDS = forms(["enak vpis", "enaka vpisa", "enaki vpisi", "enakih vpisov"], ["identical record", "identical records"]); // i18n-ignore
/** "v občini Ljubljana" / "in Ljubljana": where the municipality figures come from. */
const inMunicipality = (name?: string): ReactNode => name ? tx("v občini {municipality}", { municipality: proper(name) }) : t("v občini");
/** "v četrtni skupnosti Jarše" / "in the Jarše city district" (names arrive without the register prefix). */
const inDistrict = (name: string): ReactNode => tx("v četrtni skupnosti {name}", { name });
/** An example address for the search field. */
const EXAMPLE_ADDRESS = "Dunajska cesta 221, Ljubljana"; // i18n-ignore
const SUPPORTED: PropertyGroup[] = ["apartment", "house", "commercial", "garage", "land"];

export interface Purchase { price: number; date: string; area: number; group: PropertyGroup; transactionId?: number }
/** A city district (četrtna skupnost) the property lies in. */
interface District { id: number; name: string }
type Evidence = Awaited<ReturnType<typeof loadSaleEvidence>>;
const settled = <T,>(result: PromiseSettledResult<T> | undefined) => result?.status === "fulfilled" ? result.value : undefined; // i18n-ignore (generics, not text)
const quiet = <T,>(promise: Promise<T>) => promise.catch(() => undefined); // i18n-ignore (generics, not text)

/**
 * "Koliko je vredna moja nepremičnina?": find the address, pick (or type) your purchase, then today's value from the
 * evidence (similar sales, else the district or municipality), your own price updated with the local market as context, and a sale-now tax scenario.
 * The page has one close control: "← Nazaj na pregled trga" in the explorer bar.
 */
export function ValueCheck({ building: buildingRef, transactionId, municipalityId, cutoff, municipalities, onBuilding, onTransaction }: {
  building?: { ko: number; st: string }; transactionId?: number; municipalityId?: number; cutoff?: string; municipalities: Geography[];
  onBuilding: (ko: number, st: string) => void; onTransaction: (id: number | undefined) => void;
}) {
  const buildingKey = buildingRef ? `${buildingRef.ko}-${buildingRef.st}` : null;
  const building = useLoad(buildingKey && `building-${buildingKey}`, (signal) => loadBuilding(buildingRef!.ko, buildingRef!.st, signal)).data;
  // Opened without an area (or with a typed purchase): the building's municipality and district from one of its sales.
  const first = building?.saleTransactions[0]?.transactionId;
  const areas = useLoad(first ? `sale-areas-${first}` : null, (signal) => loadSaleAreas(first!, signal)).data;
  const [manual, setManual] = useState<Purchase | null>(null);
  const evidence = useLoad(transactionId ? `sale-evidence-${transactionId}` : null, (signal) => loadSaleEvidence(transactionId!, signal)).data;
  const stepOne = useRef<HTMLLIElement>(null);
  const stepTwo = useRef<HTMLHeadingElement>(null);
  // Raised when the owner picks or types a purchase: the answer heading takes focus as soon as it renders.
  const [focusRequest, setFocusRequest] = useState(0);

  // Step 1: the address field takes focus (and scrolls up, clear of the phone keyboard) when the check opens or the address is changed.
  useEffect(() => {
    if (buildingKey) return;
    const step = stepOne.current;
    return bringUp(step, step?.querySelector("input"));
  }, [buildingKey]);
  // Step 2: once the address is found (or the purchase is changed), focus moves to picking the purchase.
  const choosing = !!building && !transactionId && !manual;
  useEffect(() => {
    if (!choosing) return;
    return bringUp(stepTwo.current, stepTwo.current);
  }, [choosing, building]);

  const detail = manual ? undefined : settled(evidence?.detail);
  // A sale of a type the check cannot value is never valued as a flat.
  const unsupported = !!detail && !(SUPPORTED as string[]).includes(detail.propertyGroup);
  const purchase: Purchase | null = manual ?? (detail && !unsupported && detail.price != null && detail.area != null && detail.contractDate
    ? { price: detail.price, date: detail.contractDate, area: detail.area, group: detail.propertyGroup as PropertyGroup, transactionId }
    : null);
  const resolvedDistrict = areas?.find((item) => item.level === "city_district");
  const purchaseMunicipality = detail?.geographies?.find((item) => item.level === "municipality")?.id ?? areas?.find((item) => item.level === "municipality")?.id ?? municipalityId;
  const saleDistrict = detail?.geographies?.find((item) => item.level === "city_district") ?? resolvedDistrict;
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
        {purchase ? <><p>{tx("{type}, {area}\u00a0m², kupljeno {date} za {price} ({perSqm}\u00a0€/m²)", { type: TYPE_NAME[purchase.group], area: decimal1(purchase.area),
          date: whenNode(purchase.date), price: moneyNode(purchase.price), perSqm: integer(purchase.price / purchase.area) })}{" "}
          <button type="button" className="link" onClick={() => { setManual(null); onTransaction(undefined); }}>{t("spremeni")}</button></p>
          {beforeBuilt && <p className="error" role="alert">{t("Datum nakupa je pred letom izgradnje stavbe ({year}).", { year: building.constructionYear })} {t("Preverite datum.")}</p>}</>
          : <>
            {unsupported && <p className="error" role="alert">{t("Te vrste nepremičnine ne znamo oceniti.")} {t("Izberite vrsto spodaj in vnesite svoj nakup.")}</p>}
            <PickPurchase building={building} onPick={(id) => { setFocusRequest((value) => value + 1); onTransaction(id); }}
              onManual={(value) => { setFocusRequest((value) => value + 1); setManual(value); }}/>
          </>}
      </li>}
    </ol>

    {purchase && <Estimates purchase={purchase} evidence={manual ? undefined : evidence} municipalityId={purchaseMunicipality} district={district} cutoff={cutoff}
      focusRequest={focusRequest} municipalityName={municipalities.find((item) => item.id === purchaseMunicipality)?.name}/>}
  </article>;
}

/** A price and a date as they are marked up in sentences. */
function moneyNode(amount: number) { return <span className="money">{euro(amount)}</span>; }
function whenNode(value: string) { return <span className="when">{date(value)}</span>; }
/** The parts of one row's note, separated; empty parts are left out. Plain text and fragments only, so the note stays one text run. */
function join(parts: ReactNode[], separator: string): ReactNode {
  const kept = parts.filter((part) => part != null && part !== false && part !== "");
  return kept.length ? kept.map((part, index) => <Fragment key={index}>{index ? separator : ""}{part}</Fragment>) : null;
}

/** The building's address (a register name), else its cadastral number. */
const buildingName = (building: BuildingStatistics) => proper(addressLabel(building))
  || t("Stavba {ko}-{st}", { ko: building.cadastralMunicipalityCode, st: building.buildingNumber });

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
    if (y < 0 || y > 160) step.scrollIntoView?.({ block: "start" });
    return false;
  };
  return whileLayoutSettles(document.body, scroll);
}

/**
 * A euro amount: plain digits while typing, "289.000" once the field is left. The value passed around is digits only.
 */
function MoneyInput({ value, onChange, required }: { value: string; onChange: (value: string) => void; required?: boolean }) {
  const [editing, setEditing] = useState(false);
  const shown = editing || value === "" || !Number.isFinite(Number(value)) ? value : integer(Number(value));
  return <input type="text" inputMode="numeric" autoComplete="off" value={shown} required={required}
    onFocus={() => setEditing(true)} onBlur={() => setEditing(false)} onChange={(event) => onChange(event.target.value.replace(/\D/g, ""))}/>;
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
    else list.push({ ...item, copies: 1, lowPrice: typical != null && item.amountPerSqm != null && item.amountPerSqm < typical * 0.4 });
    return list;
  }, []);
  // An implausible type for this building: a house among many units, or a flat in a building of one unit.
  const units = building.knownBuildingPartCount;
  const likely: PropertyGroup | null = sales.length ? null : group === "house" && units >= 3 ? "apartment" : group === "apartment" && units === 1 ? "house" : null;
  const valid = Number(form.price) > 0 && Number(form.area) > 0 && /^\d{4}-\d{2}-\d{2}$/.test(form.date);
  return <div className="pick">
    <div className="value-types" role="group" aria-label={t("Vrsta nepremičnine")}>
      {SUPPORTED.map((item) => <button key={item} type="button" aria-pressed={group === item} onClick={() => setGroup(item)}>{TYPE_LABEL[item]}</button>)}
    </div>
    {likely && <p className="value-caveat value-type-warning" role="status">
      {likely === "apartment" ? t("Stavba ima {units} – je vaša nepremičnina res hiša?", { units: count(units, UNITS) })
        : t("Stavba ima samo eno enoto – je vaša nepremičnina morda hiša?")}{" "}
      <button type="button" className="link" onClick={() => setGroup(likely)}>{likely === "apartment" ? t("Izberi stanovanje") : t("Izberi hišo")}</button></p>}
    {rows.length ? <>
      <p className="muted">{t("Izberite svoj nakup med evidentiranimi prodajami {type} v stavbi.", { type: OF_TYPE[group] })}</p>
      <div className="table-scroll value-pick-scroll"><table className="compact-table value-pick">
        <caption className="sr-only">{t("Prodaje v stavbi")}</caption>
        <thead><tr><th scope="col">{t("Datum")}</th><th scope="col">{t("Površina")}</th><th scope="col">{t("Cena")}</th><th scope="col"><span className="sr-only">{t("Izbira")}</span></th></tr></thead>
        <tbody>{rows.slice(0, 40).map((item) => <tr key={item.transactionId} className={item.representative === false || item.lowPrice ? "atypical" : undefined}>
          <th scope="row" className="pick-date"><span className="when">{item.contractDate ? date(item.contractDate) : "—"}</span></th>
          <td className="pick-area"><span className="when">{item.area == null ? "—" : sqm(item.area)}</span></td>
          <td className="pick-price"><span className="money">{item.amount == null ? "—" : euro(item.amount)}</span>
            {(item.representative === false || item.lowPrice) && <small> {item.representative === false ? t("ni upoštevana v statistiki")
              : t("neobičajno nizka cena – verjetno ni tržni posel")}</small>}
            {item.copies > 1 && <small> {t("{records} – verjetno isti posel", { records: count(item.copies, RECORDS) })}</small>}</td>
          <td className="pick-action"><button type="button" className="ghost" onClick={() => onPick(item.transactionId)}>{t("To je moj nakup")} <span aria-hidden="true">›</span></button></td>
        </tr>)}</tbody>
      </table></div>
    </> : <p className="muted">{t("V tej stavbi ni evidentirane prodaje te vrste ({type}).", { type: TYPE_NAME[group] })} {t("Vnesite svoj nakup spodaj.")}</p>}
    <details key={group} className="module" open={!rows.length}>
      <summary>{rows.length ? t("Mojega nakupa ni na seznamu") : t("Vnesite svoj nakup")}</summary>
      <form className="calc-inputs" onSubmit={(event) => { event.preventDefault(); if (valid) onManual({ price: Number(form.price), date: form.date, area: Number(form.area), group }); }}>
        <label>{t("Nakupna cena (€)")}<MoneyInput value={form.price} onChange={(price) => setForm({ ...form, price })} required/></label>
        <label>{t("Datum nakupa")}<input type="date" min="2007-01-01" value={form.date} onChange={(event) => setForm({ ...form, date: event.target.value })} required/></label>
        <label>{t("Površina (m²)")}<input type="number" inputMode="decimal" min={1} step={0.1} value={form.area} onChange={(event) => setForm({ ...form, area: event.target.value })} required/></label>
        <button type="submit" className="value-primary" disabled={!valid}>{t("Izračunaj vrednost")}</button>
      </form>
    </details>
  </div>;
}

function indexAt(items: MarketIndex[], month: string) {
  const published = items.filter((item) => item.isPublishable).sort((a, b) => a.period.localeCompare(b.period));
  return published.filter((item) => month >= item.period.slice(0, 7)).at(-1) ?? published[0];
}

interface AreaData { sale?: StatisticsOverview; pooled?: boolean; spread?: Distribution; districtSpread?: Distribution; districtTypical?: Typical }
interface RentData { rent?: RentalOverview; rentSpread?: Distribution; districtRent?: RentalOverview; districtRentSpread?: Distribution }

function Estimates({ purchase, evidence, municipalityId, municipalityName, district, cutoff, focusRequest }: {
  purchase: Purchase; evidence?: Evidence; municipalityId?: number; municipalityName?: string; district?: District; cutoff?: string;
  /** Raised each time the owner picks a purchase: the answer heading then takes focus. */
  focusRequest: number;
}) {
  const [poorCondition, setPoorCondition] = useState(false);
  const garage = purchase.group === "garage";
  const index = useLoad(`price-index-${purchase.group}`, async (signal) => (await loadPriceIndex(purchase.group, signal)).items);
  const areaKey = cutoff && municipalityId ? `${cutoff}|${municipalityId}|${purchase.group}|${district?.id ?? ""}` : null;
  // The headline waits for the district and the municipality together, so it never jumps from one to the other.
  const sales = useLoad(areaKey && `value-sales|${areaKey}`, async (signal): Promise<AreaData> => {
    const window = marketWindows(cutoff!).sales.current;
    const segment = { propertyGroup: purchase.group };
    const typical = async (id: number): Promise<Typical> => {
      const sale = await loadSaleOverview(id, segment, window, signal);
      if (!garage || sale.isPublishable) return { sale, pooled: false };
      // Garages sell rarely: like the area page, pool three years before giving up on a typical price.
      const pooled = await loadSaleOverview(id, segment, { from: shiftWindow(window, 24).from, to: window.to }, signal);
      return pooled.isPublishable ? { sale: pooled, pooled: true } : { sale, pooled: false };
    };
    const [municipal, districtTypical, spread, districtSpread] = await Promise.all([
      quiet(typical(municipalityId!)),
      garage && district ? quiet(typical(district.id)) : undefined,
      garage ? undefined : quiet(loadSpread(municipalityId!, window, segment, "sale", signal)),
      !garage && district ? quiet(loadSpread(district.id, window, segment, "sale", signal)) : undefined,
    ]);
    return { sale: municipal?.sale, pooled: municipal?.pooled, districtTypical, spread, districtSpread };
  });
  // Rents: the last mostly reported full year (rental contracts are recorded up to a year late).
  const rents = useLoad(areaKey && purchase.group !== "land" ? `value-rents|${areaKey}` : null, async (signal): Promise<RentData> => {
    const window = marketWindows(cutoff!).rents.current;
    const segment = { propertyGroup: purchase.group };
    const rentSegment = { propertyGroup: purchase.group as RentGroup };
    const [rent, rentSpread, districtRent, districtRentSpread] = await Promise.all([
      quiet(loadRentOverview(municipalityId!, rentSegment, window, signal)),
      quiet(loadSpread(municipalityId!, window, segment, "rent", signal)),
      district ? quiet(loadRentOverview(district.id, rentSegment, window, signal)) : undefined,
      district ? quiet(loadSpread(district.id, window, segment, "rent", signal)) : undefined,
    ]);
    return { rent, rentSpread, districtRent, districtRentSpread };
  });
  // The municipality's median in the 12 months around the purchase: the local market change since then.
  const then = useLoad(municipalityId ? `value-then|${municipalityId}|${purchase.group}|${purchase.date}` : null, (signal) => {
    const day = { from: purchase.date, to: purchase.date };
    return loadSaleOverview(municipalityId!, { propertyGroup: purchase.group }, { from: shiftWindow(day, 6).from, to: shiftWindow(day, -6).to }, signal);
  }).data;
  const inflation = useLoad(cutoff ? `inflation|${purchase.date.slice(0, 7)}|${cutoff.slice(0, 7)}` : null,
    async (signal) => (await loadInflationBetween(`${purchase.date.slice(0, 7)}-01`, `${cutoff!.slice(0, 7)}-01`, signal)).factor).data;
  const area = sales.data ?? {};

  const context = settled(evidence?.context);
  const history = settled(evidence?.history);
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
  const condition = CONDITION[purchase.group];
  const where = useDistrict && district ? inDistrict(district.name) : municipalWhere;
  const year = purchase.date.slice(0, 4);
  // The row today's estimate rests on: it carries the "osnova ocene" chip and, for a worse condition, where the value moved to.
  const basisKey = reference?.kind === "market" ? "market" : reference ? "local" : anchored != null ? "updated" : null;
  const worseNote = worse ? t("slabše stanje: ocena na spodnji četrtini ({low}) namesto na mediani ({mid})", { low: euro(round(reference!.low)), mid: euro(round(reference!.mid)) }) : null;

  // How the purchase compared with the market at the time: the same benchmark and words as the sale page (narrowest publishable area, never a sample of one).
  const benchmark = context ? chooseBenchmark(context.benchmarks ?? []) : undefined;
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
  // Each row is a value with one muted note; a row without a value ("—") says why. Notes are fragments, parts separated by " · ".
  type Row = { key: string; title: ReactNode; value: string | null; note: ReactNode };
  const sold = (sales: number) => count(sales, NOUN_FORMS.prodaja);
  const unit = garage ? t("€ na enoto") : "€/m²";
  const rows: Row[] = [{ key: "purchase", title: t("Vaš nakup ({year})", { year }), value: euro(purchase.price),
    note: join([!garage && `${integer(purchase.price / purchase.area)}\u00a0€/m²`, paidThen], ", ") }];
  const updatedTitle = tx("Posodobljen s cenami {where}", { where: municipalWhere });
  if (anchored != null) rows.push({ key: "updated", title: updatedTitle, value: euro(round(anchored)),
    note: join([t("mediana {then} → {now} {unit} ({change})", { then: integer(localThen!), now: integer(localNow!), unit, change: signed(localFactor! - 1) }),
      national != null && t("v vsej Sloveniji {national}", { national: signed(national - 1) })], ", ") });
  else if (garageMismatch) rows.push({ key: "updated", title: updatedTitle, value: null, note: t("Vaše nakupne cene ne posodabljamo z gibanjem cen garaž: mediana na enoto meša nova parkirna mesta in starejše garaže.") });
  else if (reference) rows.push({ key: "updated", title: updatedTitle, value: null, note: t("premalo prodaj te vrste v občini ob nakupu ali danes") });
  if (market) {
    const confidence = market.confidence === "moderate" ? t("zanesljivost srednja") : market.confidence === "low" ? t("zanesljivost nizka") : t("zanesljivost zelo nizka");
    // Comparables from a wide area are said to be so; untrusted ones (very low reliability, under 10 sales) are shown but never lead.
    const caveat = !trustedMarket ? t("premalo ali preveč različne, zato ocena ne temelji na njih")
      : wideRadius == null ? null
      : reference?.kind === "local" && districtBand ? tx("iz širše okolice, zato ocena temelji na cenah {where}", { where })
      : t("iz širše okolice, zato lahko odstopajo od cen v vaši soseski");
    rows.push({ key: "market", title: SIMILAR_TODAY[purchase.group], value: span(market.lowerTotal, market.upperTotal),
      note: join([`${t("{sales} do {distance} km", { sales: sold(market.comparableCount), distance: km(market.maximumRadiusMeters) })}, ${confidence}`, caveat, basisKey === "market" && worseNote], " · ") });
  } else if (!purchase.transactionId) rows.push({ key: "market", title: SIMILAR_TODAY[purchase.group], value: null, note: t("za ročno vnesen nakup podobnih prodaj ne iščemo") });
  else if (context) rows.push({ key: "market", title: SIMILAR_TODAY[purchase.group], value: null, note: t("v okolici ni dovolj podobnih prodaj {type} za primerjavo", { type: OF_TYPE[purchase.group] }) });
  if (local) rows.push(garage
    ? { key: "local", title: tx("Tipična garaža {where}", { where }), value: euro(Math.round(local.mid / 500) * 500),
      note: garageSource?.pooled ? t("mediana, {sales} v zadnjih 3 letih", { sales: sold(localSales) }) : t("mediana, {sales} v zadnjih 12 mesecih", { sales: sold(localSales) }) }
    : { key: "local", title: tx("Cene {where} za {area} m²", { where, area: upTo1(purchase.area) }), value: span(local.low, local.high),
      note: join([t("srednja polovica, {sales} v zadnjih 12 mesecih", { sales: sold(localSales) }), basisKey === "local" && worseNote], " · ") });
  // The national index never makes the headline: with nothing local it is only a rough note (never for garages, whose index mixes kinds of parking).
  const hasEvidence = !!(market || local || anchored != null);
  if (!hasEvidence && indexed != null && !garage) rows.push({ key: "index", title: t("Vaš nakup × indeks cen za vso Slovenijo (samo za orientacijo)"), value: euro(round(indexed)),
    note: t("Za oceno vaše nepremičnine ni dovolj lokalnih podatkov; indeks za vso Slovenijo je le groba orientacija.") });
  const shownAnswer = rows.length > 1;

  // One scale for everything: today's band (the headline) with the purchase and the updated purchase as markers (rounded like the rows).
  // The other evidence's median is already a row above; a third identical dot only cluttered the bar.
  const markers = [{ value: purchase.price, name: t("vaš nakup") }, ...(anchored != null ? [{ value: round(anchored), name: t("posodobljen nakup") }] : [])];
  const scaleMax = Math.max(...markers.map((marker) => marker.value), answer?.high ?? 0) * 1.08;
  const events = (history?.assets ?? []).flatMap((asset) => asset.events).filter((event) => event.transactionId !== purchase.transactionId)
    .sort((a, b) => (a.contractDate ?? "").localeCompare(b.contractDate ?? ""));

  // The answer heading takes focus when it first renders after the owner picked a purchase (or when nothing has focus).
  const answerHeading = useRef<HTMLHeadingElement>(null);
  const handled = useRef(0);
  useEffect(() => {
    const heading = answerHeading.current;
    if (!heading || (focusRequest === handled.current && document.activeElement !== document.body)) return;
    handled.current = focusRequest;
    heading.focus();
  }, [focusRequest, shownAnswer]);
  if (!shownAnswer) return <p className="muted" role="status">{items && (sales.data || sales.error || !areaKey) ? t("Za to nepremičnino ni dovolj podatkov za oceno.") : t("Računam ocene …")}</p>;
  // The one value of the page: rent yield and the sale scenario use it too.
  const value = answer?.mid ?? null;
  const change = value != null ? value / purchase.price - 1 : null;
  const real = change != null && inflation ? (1 + change) / inflation - 1 : null;
  return <>
    <section className="module open value-answer" aria-labelledby="value-answer">
      <h2 id="value-answer" tabIndex={-1} ref={answerHeading}>
        {value == null ? t("Za zanesljivo oceno ni dovolj lokalnih podatkov") : <>{tx("Ocena danes: okoli {value}", { value: <span className="money">{euro(round(value))}</span> })}
          {round(answer!.high) > round(answer!.low) && <span className="value-likely"> {tx("(verjetno {range})", { range: <span className="money">{span(answer!.low, answer!.high)}</span> })}</span>}</>}</h2>
      {change != null && <p className="area-lede">{real != null
        ? tx("{change} od nakupa ({price}, {date}), po upoštevanju inflacije {real}.", { change: signed(change), price: moneyNode(purchase.price), date: whenNode(purchase.date), real: signed(real) })
        : tx("{change} od nakupa ({price}, {date}).", { change: signed(change), price: moneyNode(purchase.price), date: whenNode(purchase.date) })}</p>}
      <dl className="value-rows">{rows.map((row) => <div key={row.key} className={row.key === basisKey ? "value-row is-basis" : "value-row"}>
        <dt>{row.title}{row.key === basisKey && <span className="chip">{t("osnova ocene")}</span>}</dt>
        <dd className="value-amount money">{row.value ?? "—"}</dd>
        {row.note && <dd className="value-note">{row.note}</dd>}
      </div>)}</dl>
      {consequence && <p className="value-own">{consequence}</p>}
      {answer && answer.high > answer.low && <RangeBar p25={answer.low} p50={answer.mid} p75={answer.high} min={0} max={scaleMax} unit="€" markers={markers}
        label={t("Vaš nakup in današnja ocena na isti lestvici")} caption={t("Ocena danes {range}", { range: span(answer.low, answer.high) })}/>}
      {asksCondition && <label className="value-condition">
        <input type="checkbox" checked={poorCondition} onChange={(event) => setPoorCondition(event.target.checked)}/>
        <span>{condition}</span></label>}
      <p className="muted">{garage ? t("Ocena ne pozna lege garaže (podzemna, zunanja, z vrati).")
        : asksCondition ? t("Ocene ne poznajo nadstropja, razgleda in opreme vaše nepremičnine; slabše stanje označite zgoraj.")
        : t("Ocene ne poznajo nadstropja, razgleda in opreme vaše nepremičnine.")}</p>
    </section>

    {events.length > 0 && <section className="module open">
      <h2>{t("Druge evidentirane prodaje te enote")}</h2>
      <ol className="rows">{events.map((event) => <li key={`${event.transactionId}-${event.componentId}`}>
        <strong><span className="when">{event.contractDate ? date(event.contractDate) : "—"}</span>: <span className="money">{event.agreementPrice == null ? "—" : euro(event.agreementPrice)}</span></strong>
        <span>{event.area ? sqm(event.area) : ""}{event.share && event.share !== "1/1" ? `, ${t("delež {share}", { share: event.share })}` : ""}</span></li>)}</ol>
    </section>}

    <RentEstimate purchase={purchase} area={rents.data} done={!!(rents.data || rents.error)} district={district} municipalWhere={municipalWhere} value={value} year={cutoff ? marketWindows(cutoff).rents.year : undefined}/>

    <SaleNow key={`${purchase.transactionId ?? "manual"}-${purchase.group}-${purchase.date}-${purchase.price}`} purchase={purchase} suggested={value ?? purchase.price} band={answer}/>
  </>;
}

function SaleNow({ purchase, suggested, band }: { purchase: Purchase; suggested: number; band: Band | null }) {
  const home = purchase.group === "apartment" || purchase.group === "house";
  const [ownHome, setOwnHome] = useState<boolean | null>(home ? null : false);
  const [sale, setSale] = useState<string>();
  const [disposed, setDisposed] = useState(new Date().toISOString().slice(0, 10));
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
  // Agents in Slovenia may charge at most 4 % + DDV (22 %).
  const agentFee = agent ? Math.round(price * 0.04 * 1.22) : 0;
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
    {ownHome === null && <p className="muted">{t("Odgovorite na vprašanje zgoraj: od tega je odvisen davek na dobiček.")}</p>}
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
    <p className="muted">{t("Izobraževalni scenarij za zasebno prodajo brez DDV, ni davčna napoved.")} {t("Davčna osnova za davek na dobiček je razlika med prodajno in nakupno ceno, zmanjšane za dokazana vlaganja in za stroške, ki jih zakon prizna brez računov (1 % nakupne in 1 % prodajne vrednosti).")} {t("Stopnje: manj kot 5 let 25 %, 5–9 let 20 %, 10–14 let 15 %, od 15 let 0 %; lastni dom z bivanjem vsaj 3 leta je oproščen.")}
      {" "}<a href={TAX_RULES.source} target="_blank" rel="noopener noreferrer">{t("FURS: nakup in prodaja nepremičnine")}</a></p>
  </section>;
}

/** What renting it out would bring: the district's rents when it has at least 30 contracts, else the municipality's, scaled to the floor area. */
function RentEstimate({ purchase, area = {}, done, district, municipalWhere, value, year }: {
  purchase: Purchase; area?: RentData; done: boolean; district?: District; municipalWhere: ReactNode; value: number | null; year?: number;
}) {
  if (purchase.group === "land") return null;
  const fromDistrict = !!district && !!area.districtRent?.isPublishable && (area.districtRent.rentPerSqmSampleSize ?? 0) >= DISTRICT_MIN_SAMPLE;
  const rent = fromDistrict ? area.districtRent : area.rent;
  const spread = fromDistrict ? area.districtRentSpread : area.rentSpread;
  const where = fromDistrict && district ? inDistrict(district.name) : municipalWhere;
  const percentiles = spread?.isPublishable ? spread.percentiles : undefined;
  const median = rent?.isPublishable ? rent.medianMonthlyRentPerSqm ?? percentiles?.p50 ?? null : percentiles?.p50 ?? null;
  if (median == null) return <section className="module open"><h2>{t("Najemnina")}</h2>
    <p className="muted">{done ? t("V občini je bilo v letu {year} premalo najemov te vrste za oceno.", { year: year ?? "" }) : t("Nalagam najemnine …")}</p></section>;
  const round10 = (amount: number) => Math.round(amount / 10) * 10;
  const low = (percentiles?.p25 ?? median) * purchase.area;
  const high = (percentiles?.p75 ?? median) * purchase.area;
  const mid = median * purchase.area;
  const gross = value ? (mid * 12) / value : null;
  return <section className="module open" aria-labelledby="rent-title">
    <h2 id="rent-title">{tx("Če bi jo oddali: okoli {rent} na mesec", { rent: <span className="money">{euro(round10(mid))}</span> })}</h2>
    <p className="area-lede">{tx("Srednja polovica najemnin {where} za {area} m²: {range} na mesec (mediana {median} €/m², leto {year}, iz {rentals}).", {
      where, area: decimal1(purchase.area), range: <span className="money">{range(round10(low), round10(high))}</span>, median: decimal1(median), year: year ?? "—",
      rentals: count(rent?.rentPerSqmSampleSize ?? spread?.sampleSize ?? 0, NOUN_FORMS.najem) })}</p>
    <p className="value-caveat">{t("To so evidentirane najemne pogodbe (brez obratovalnih stroškov), ne oglasi: oglasne najemnine so običajno višje.")}</p>
    <p className="muted">{gross != null && <>{t("Bruto donos glede na oceno vrednosti ({value}): {yield} % na leto, pred stroški, vzdrževanjem, praznimi meseci in davkom na najemnino (25 % od najemnine po odbitku 10 % stroškov, ki jih zakon prizna brez računov).", {
      value: euro(round(value!)), yield: decimal1(gross * 100) })} </>}{t("Najemne pogodbe GURS evidentira z zamikom, zato uporabljamo zadnje celo leto.")}</p>
  </section>;
}
