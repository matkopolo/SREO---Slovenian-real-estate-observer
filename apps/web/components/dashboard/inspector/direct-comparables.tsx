import { ArrowUpRight } from "lucide-react";
import { QualityBadge } from "@/components/ui/quality-badge";
import { anomalyStatusLabel, decimal, euro } from "@/lib/display-values";
import type { DirectComparable, MarketContext, MarketMode } from "@/lib/types";
import styles from "./property-report.module.css";

function tierLabel(tier: DirectComparable["matchTier"]) {
  if (tier === "same_building_same_year_area_15") return "Ista stavba · isto leto · površina ±15 %";
  if (tier === "same_building_adjacent_year_area_15") return "Ista stavba · sosednje leto · površina ±15 %";
  if (tier === "same_building_same_year") return "Ista stavba · isto leto · širša površina";
  return "Ista stavba · drug primerljiv posel";
}

export function DirectComparables({ items, selectedAmountPerSqm, mode, onChange }: {
  items: DirectComparable[];
  selectedAmountPerSqm?: number | null;
  mode: MarketMode;
  onChange: (context: MarketContext) => void;
}) {
  const valid = (value: number | null | undefined): value is number =>
    value != null && Number.isFinite(value) && value > 0;
  // All cards share a zero-based scale. No inferred valuation or time adjustment.
  const maximum = Math.max(0, ...items.map((item) => item.amountPerSqm).filter(valid),
    ...(valid(selectedAmountPerSqm) ? [selectedAmountPerSqm] : []));
  return <>
    <p>Prednost imajo isto leto in najbolj podobna površina. Primerjava prikazuje zabeležene
      {mode === "sale" ? " cene" : " mesečne najemnine"} na m² ob sklenitvi, brez časovne prilagoditve.</p>
    {!items.length ? <p className="empty-state">V isti stavbi v izbranem ali sosednjih letih ni primerljivega posla.</p>
      : <div className="comparable-list">{items.map((item) => <button
        className={`direct-comparable-card ${styles.comparable}`} type="button" key={item.transactionId}
        aria-label={`Odpri primerljivi posel #${item.transactionId}`}
        onClick={() => onChange({ kind: "transaction", mode, id: item.transactionId })}>
        <span className="comparable-tier">{tierLabel(item.matchTier)}</span>
        <div><span>{item.contractDate}<small>Posel #{item.transactionId}</small></span>
          <strong>{euro.format(item.amount)}<small>{decimal.format(item.amountPerSqm)} €/m²{mode === "rent" ? " / mesec" : ""}</small></strong></div>
        {valid(selectedAmountPerSqm) && valid(item.amountPerSqm) && <figure className={styles.priceComparison}>
          <figcaption>Skupna lestvica · {mode === "sale" ? "€/m²" : "€/m² / mesec"}</figcaption>
          {[{ label: "Izbrani posel", value: selectedAmountPerSqm }, { label: "Primerljivi posel", value: item.amountPerSqm }].map((row, index) =>
            <div className={styles.priceRow} key={row.label}>
              <span>{row.label}</span><strong>{decimal.format(row.value)}</strong>
              <span className={styles.priceTrack} aria-hidden="true"><i className={index === 0 ? styles.selectedBar : styles.comparableBar}
                style={{ width: `${row.value / maximum * 100}%` }}/></span>
            </div>)}
        </figure>}
        <dl><div><dt>Površina</dt><dd>{decimal.format(item.area)} m²</dd></div>
          <div><dt>Razlika površine</dt><dd>{item.areaDifferencePercent > 0 ? "+" : ""}{decimal.format(item.areaDifferencePercent)} %</dd></div>
          <div><dt>Razlika €/m²</dt><dd>{item.amountPerSqmDifferencePercent > 0 ? "+" : ""}{decimal.format(item.amountPerSqmDifferencePercent)} %</dd></div></dl>
        <QualityBadge representative={item.isRepresentative} label={item.isRepresentative ? "Reprezentativen posel" : anomalyStatusLabel(item.outlierStatus)}/>
        <span className={styles.openEvidence}>Odpri posel in njegove dokaze <ArrowUpRight aria-hidden="true" size={15}/></span>
      </button>)}</div>}
  </>;
}
