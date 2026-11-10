import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import type { PeriodWindows, PropertyGroup } from "../api";
import { date, decimal1, integer, upTo1 } from "../format";
import { Name, t, tx } from "../i18n";
import { METRICS, type MetricId } from "../metrics";
import { NOUNS, type Band } from "../nouns";
import { typedLabel } from "./paint";

/** Legend classes and their colour. */
export interface Scale { breaks: number[]; ramp: (value: number | null) => string }
export type MapLevel = "statistical_region" | "municipality" | "fine";

interface Key { color: string; text: string; title?: string; pooled?: boolean }
interface RampSpec { id: string; caption: ReactNode; label: string; scale: Scale; signed?: boolean; keys: Key[]; secondary?: boolean }

const middle = (scale: Scale) => scale.ramp(scale.breaks[Math.floor(scale.breaks.length / 2)] ?? null);
/** Class limits as bare numbers (the caption carries the unit), so five of them fit under a short ramp. */
const brief = (value: number, signed = false) => `${signed && value > 0 ? "+" : ""}${Math.abs(value) < 10 && !Number.isInteger(value) ? decimal1(value) : integer(value)}`;

/** A horizontal colour ramp with the class limits under it, then the no-data / pooled swatches. */
function Ramp({ ramp }: { ramp: RampSpec }) {
  return <div className={ramp.secondary ? "ramp secondary" : "ramp"}>
    <span className="ramp-caption">{ramp.caption}</span>
    <ol className="ramp-classes" aria-label={ramp.label}>
      {ramp.scale.breaks.map((value) => <li key={value}><i style={{ background: ramp.scale.ramp(value) }}/><span>{ramp.signed ? brief(value, true) : t("do {value}", { value: brief(value) })}</span></li>)}
    </ol>
    {ramp.keys.length > 0 && <ul className="ramp-keys">
      {ramp.keys.map((key) => <li key={key.text} title={key.title}><i className={key.pooled ? "pooled-key" : undefined} style={{ background: key.color }}/>{key.text}</li>)}
    </ul>}
  </div>;
}

/**
 * A slim strip docked to the bottom of the map: the layer picker, the colour ramp of what is drawn at this zoom
 * (regions, municipalities, districts and settlements, or the buildings at street zoom) and a "?" with the one-line
 * explanation. The map keeps its full height; the map's own controls move up by the strip's height (--strip).
 */
/** Reports the strip's height to the map column (--strip), so the map's own controls (zoom, credit) sit above it. */
function useStripHeight() {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const strip = ref.current;
    if (!strip || typeof ResizeObserver === "undefined") return;
    const column = strip.parentElement;
    const observer = new ResizeObserver(() => column?.style.setProperty("--strip", `${strip.offsetHeight}px`));
    observer.observe(strip);
    return () => { observer.disconnect(); column?.style.removeProperty("--strip"); };
  }, []);
  return ref;
}

/** The value check's map: the similar sales as dots, the property's ring and the dashed search circle. */
export function ComparablesLegend({ count, radiusMeters, trusted }: { count: number; radiusMeters: number; trusted: boolean }) {
  const ref = useStripHeight();
  return <div className="map-strip comparables-strip" ref={ref} role="note">
    <ul className="ramp-keys">
      <li><i className="key-dot"/>{trusted ? t("primerljive prodaje ({count})", { count }) : t("podobne prodaje v okolici ({count})", { count })}</li>
      <li><i className="key-ring"/>{t("vaša nepremičnina")}</li>
      <li><svg className="key-dash" width="18" height="6" aria-hidden="true"><line x1="0" y1="3" x2="18" y2="3" stroke="currentColor" strokeWidth="2" strokeDasharray="4 3"/></svg>{t("iskalni polmer {distance} km", { distance: upTo1(radiusMeters / 1000) })}</li>
    </ul>
    <p className="strip-note">{trusted ? t("Pike so prodaje, na katerih temelji ocena. Kliknite piko za podrobnosti prodaje.") : t("Pike so podobne prodaje v okolici; kliknite piko za podrobnosti prodaje.")}</p>
  </div>;
}

export function MapLegend({ layer, layers, group, band, windows, level, street, land, buildingSpan, scales, pooled, fineShown, sub, onLayer }: {
  layer: MetricId; layers: MetricId[]; group: PropertyGroup; band?: Band; windows?: PeriodWindows; level: MapLevel;
  /** Street zoom: buildings (or land sales) instead of areas. */
  street: boolean; land: boolean; buildingSpan: string;
  scales: { municipal: Scale; region: Scale; fine: Scale; buildings: Scale };
  /** Some municipalities / districts borrow 3 or 5 years. */
  pooled: { municipal: boolean; fine: boolean };
  /** Districts or settlements are drawn at this zoom (with or without enough sales). */
  fineShown: boolean;
  /** The selected municipality's districts or settlements on their own scale. */
  sub?: { level: "city_district" | "settlement"; municipality: string; scale: Scale };
  onLayer: (layer: MetricId) => void;
}) {
  const definition = METRICS[layer];
  const rent = layer === "rentPrice";
  const [help, setHelp] = useState(false);
  const helpId = useId();
  const ref = useStripHeight();

  const span = windows && (rent ? windows.rents : windows.sales).current;
  const shown = street ? (land ? t("Prikaz: prodana zemljišča ({period})", { period: buildingSpan }) : rent ? t("Prikaz: stavbe s najemi ({period})", { period: buildingSpan }) : t("Prikaz: stavbe s prodajami ({period})", { period: buildingSpan }))
    : level === "statistical_region" ? t("Prikaz: statistične regije") : level === "municipality" ? t("Prikaz: občine") : t("Prikaz: četrtne skupnosti in naselja");
  const hint = street ? (land ? t("Vsaka pika je ena prodaja zemljišča (€/m², lastna lestvica). Kliknite piko za podrobnosti.")
      : rent ? t("Stavbe imajo lastno lestvico (stavbe v pogledu); velikost kroga = število najemov. Kliknite stavbo za posle.")
      : t("Stavbe imajo lastno lestvico (stavbe v pogledu); velikost kroga = število prodaj. Kliknite stavbo za posle."))
    : level === "fine" ? t("Kliknite četrtno skupnost ali naselje za podrobnosti; približajte do ulic za stavbe.") : t("Kliknite območje ali približajte za podrobnejša območja.");
  const fineUnit = rent ? METRICS.rentPrice.unit : METRICS.salePrice.unit;

  // What the colours mean at this zoom; a second ramp (own scale) for the selected municipality's districts or settlements.
  const ramps: RampSpec[] = [];
  let note: string | undefined;
  if (street) {
    if (scales.buildings.breaks.length) ramps.push({ id: "buildings", scale: scales.buildings, label: t("Lestvica stavb (mediana €/m² stavb v pogledu)"),
      caption: land ? t("prodana zemljišča · €/m²") : rent ? t("stavbe z najemi · €/m²") : t("stavbe s prodajami · €/m²"),
      keys: land ? [] : [{ color: "#ffffff", text: t("1–2 posla"), title: t("bel krog: 1–2 posla, brez mediane") }] });
  } else if (level === "statistical_region") {
    if (scales.region.breaks.length) ramps.push({ id: "regions", scale: scales.region, label: t("Lestvica regij"), caption: t("regije · {unit}", { unit: definition.unit }), keys: [] });
  } else if (level === "fine") {
    if (scales.fine.breaks.length) ramps.push({ id: "fine", scale: scales.fine, label: t("Lestvica četrtnih skupnosti in naselij (lastna lestvica)"),
      caption: t("četrtne skupnosti in naselja · {unit}", { unit: fineUnit }),
      keys: [{ color: scales.fine.ramp(null), text: t("premalo poslov") }, ...(pooled.fine ? [{ color: middle(scales.fine), pooled: true, text: t("združeno"), title: t("svetleje: združeno 5 let") }] : [])] });
    else if (fineShown) note = t("V tem pogledu je premalo prodaj {noun} za mediano; posamezne prodaje so v plošči in ob približanju.", { noun: NOUNS[group].genitive });
  } else {
    if (scales.municipal.breaks.length) ramps.push({ id: "municipal", scale: scales.municipal, signed: definition.signed, label: t("Lestvica: {unit}", { unit: definition.unit }),
      caption: t("občine · {unit}", { unit: definition.unit }),
      keys: [{ color: scales.municipal.ramp(null), text: t("ni objavljeno") }, ...(pooled.municipal ? [{ color: middle(scales.municipal), pooled: true, text: t("združeno"), title: t("svetleje: združeno 3 ali 5 let") }] : [])] });
    else note = t("V tem obdobju ni objavljivih vrednosti po občinah ({noun}).", { noun: NOUNS[group].label.toLowerCase() });
  }
  // The selected municipality's districts or settlements: the same ramp on their own scale (the help says so).
  const own = !street && level !== "fine" && sub && sub.scale.breaks.length > 0 ? sub : undefined;
  if (own) ramps.push({ id: "sub", scale: own.scale, label: t("Lestvica četrtnih skupnosti ali naselij"), secondary: true,
    caption: own.level === "city_district" ? t("četrtne skupnosti · €/m²") : t("naselja · €/m²"), keys: [] });

  return <div className="map-strip" ref={ref}>
    <label className="strip-layer"><span className="sr-only">{t("Barva zemljevida")}</span>
      <select value={layer} onChange={(event) => onLayer(event.target.value as MetricId)} title={t("Barva zemljevida")}>
        {layers.map((id) => <option key={id} value={id}>{typedLabel(id, group)}</option>)}
      </select></label>
    {ramps.map((ramp) => <Ramp key={ramp.id} ramp={ramp}/>)}
    {note && <p className="strip-note">{note}</p>}
    <button type="button" className="strip-help-toggle" aria-expanded={help} aria-controls={helpId} aria-label={t("Pojasnilo zemljevida")} title={t("Pojasnilo zemljevida")}
      onClick={() => setHelp(!help)}>?</button>
    {help && <p id={helpId} className="strip-help">{shown}{band ? `, ${band.label}` : ""}. {definition.usesYears && span ? `${typedLabel(layer, group)}, ${date(span.from)}–${date(span.to)}. ` : ""}{hint}{own ? <> {tx("{areas} občine {municipality} imajo lastno lestvico.", { areas: own.level === "city_district" ? t("Četrtne skupnosti") : t("Naselja"), municipality: <Name>{own.municipality}</Name> })}</> : null}</p>}
  </div>;
}
