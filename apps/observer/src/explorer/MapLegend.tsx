import { useState, type ReactNode } from "react";
import type { PeriodWindows, PropertyGroup } from "../api";
import { date } from "../format";
import { Name, t, tx } from "../i18n";
import { METRICS, type MetricId } from "../metrics";
import { NOUNS, type Band } from "../nouns";
import { typedLabel } from "./paint";

/** Legend classes and their colour. */
export interface Scale { breaks: number[]; ramp: (value: number | null) => string }
export type MapLevel = "statistical_region" | "municipality" | "fine";

function Classes({ scale, label, format, signed = false, children }: { scale: Scale; label: string; format: (value: number) => string; signed?: boolean; children?: ReactNode }) {
  return <ol className="legend" aria-label={label}>
    {scale.breaks.map((value) => <li key={value}><i style={{ background: scale.ramp(value) }}/>{signed ? format(value) : t("do {value}", { value: format(value) })}</li>)}
    {children}
  </ol>;
}
const middle = (scale: Scale) => scale.ramp(scale.breaks[Math.floor(scale.breaks.length / 2)] ?? null);

/** The map's layer picker and legend: what is drawn at this zoom, its scale and how to drill down. */
export function MapLegend({ layer, layers, group, band, windows, level, street, land, buildingSpan, scales, pooled, fineShown, sub, extrude, onLayer, onExtrude }: {
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
  extrude: boolean; onLayer: (layer: MetricId) => void; onExtrude: () => void;
}) {
  const definition = METRICS[layer];
  const rent = layer === "rentPrice";
  // The legend card would cover a third of a smaller map: open by default only on wide screens; it collapses to a "Legenda" pill.
  const [open, setOpen] = useState(() => window.matchMedia?.("(min-width: 1400px)").matches ?? true);
  // At street zoom the dots matter more than the legend: it folds once on the way in.
  const [wasStreet, setWasStreet] = useState(street);
  if (street !== wasStreet) { setWasStreet(street); if (street) setOpen(false); }
  const span = windows && (rent ? windows.rents : windows.sales).current;
  const shown = street ? (land ? t("Prikaz: prodana zemljišča ({period})", { period: buildingSpan }) : rent ? t("Prikaz: stavbe s najemi ({period})", { period: buildingSpan }) : t("Prikaz: stavbe s prodajami ({period})", { period: buildingSpan }))
    : level === "statistical_region" ? t("Prikaz: statistične regije") : level === "municipality" ? t("Prikaz: občine") : t("Prikaz: četrtne skupnosti in naselja");
  const fineFormat = METRICS[rent ? "rentPrice" : "salePrice"].format;
  return <div className="map-overlay">
    <label className="map-layer">{t("Barva zemljevida")}
      <select value={layer} onChange={(event) => onLayer(event.target.value as MetricId)}>
        {layers.map((id) => <option key={id} value={id}>{typedLabel(id, group)}</option>)}
      </select></label>
    <details className="legend-card" open={open} onToggle={(event) => setOpen((event.target as HTMLDetailsElement).open)}>
      <summary>{t("Legenda")}</summary>
      <p className="map-level">{shown}{band ? `, ${band.label}` : ""}. {definition.usesYears && span ? `${typedLabel(layer, group)}, ${date(span.from)}–${date(span.to)}.` : ""}</p>
      {street ? <>
        {scales.buildings.breaks.length > 0 && <Classes scale={scales.buildings} label={t("Lestvica stavb (mediana €/m² stavb v pogledu)")} format={METRICS.salePrice.format}>
          {!land && <li><i style={{ background: "#ffffff" }}/>{t("bel krog: 1–2 posla, brez mediane")}</li>}
        </Classes>}
        <p className="map-hint">{land ? t("Vsaka pika je ena prodaja zemljišča (€/m², lastna lestvica). Kliknite piko za podrobnosti.")
          : rent ? t("Stavbe imajo lastno lestvico (stavbe v pogledu); velikost kroga = število najemov. Kliknite stavbo za posle.")
          : t("Stavbe imajo lastno lestvico (stavbe v pogledu); velikost kroga = število prodaj. Kliknite stavbo za posle.")}</p>
      </> : <>
        {level === "statistical_region" && scales.region.breaks.length > 0 && <Classes scale={scales.region} label={t("Lestvica regij")} format={definition.format}/>}
        {level === "fine" && (scales.fine.breaks.length > 0 ? <Classes scale={scales.fine} label={t("Lestvica četrtnih skupnosti in naselij (lastna lestvica)")} format={fineFormat}>
          <li><i style={{ background: scales.fine.ramp(null) }}/>{t("premalo poslov")}</li>
          {pooled.fine && <li><i className="pooled-key" style={{ background: middle(scales.fine) }}/>{t("svetleje: združeno 5 let")}</li>}
        </Classes> : fineShown && <p className="map-hint">{t("V tem pogledu je premalo prodaj {noun} za mediano; posamezne prodaje so v plošči in ob približanju.", { noun: NOUNS[group].genitive })}</p>)}
        {level === "municipality" && (scales.municipal.breaks.length > 0 ? <Classes scale={scales.municipal} label={t("Lestvica: {unit}", { unit: definition.unit })} format={definition.format} signed={definition.signed}>
          <li><i style={{ background: scales.municipal.ramp(null) }}/>{t("ni objavljeno")}</li>
          {pooled.municipal && <li><i className="pooled-key" style={{ background: middle(scales.municipal) }}/>{t("svetleje: združeno 3 ali 5 let")}</li>}
        </Classes> : <p className="map-hint">{t("V tem obdobju ni objavljivih vrednosti po občinah ({noun}).", { noun: NOUNS[group].label.toLowerCase() })}</p>)}
        {level !== "fine" && sub && sub.scale.breaks.length > 0 && <>
          <p className="map-hint">{sub.level === "city_district" ? tx("Četrtne skupnosti občine {municipality} (mediana €/m², lastna modra lestvica):", { municipality: <Name>{sub.municipality}</Name> })
            : tx("Naselja občine {municipality} (mediana €/m², lastna modra lestvica):", { municipality: <Name>{sub.municipality}</Name> })}</p>
          <Classes scale={sub.scale} label={t("Lestvica četrtnih skupnosti ali naselij")} format={METRICS.salePrice.format}/>
        </>}
        <p className="map-hint">{level === "fine" ? t("Kliknite četrtno skupnost ali naselje za podrobnosti; približajte do ulic za stavbe.")
          : t("Kliknite območje ali približajte za podrobnejša območja.")}</p>
      </>}
      {!definition.signed && <button type="button" className="ghost" aria-pressed={extrude} onClick={onExtrude}>{t("3D pogled")}</button>}
    </details>
  </div>;
}
