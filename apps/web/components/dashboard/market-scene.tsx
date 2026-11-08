"use client";

import { useEffect, useRef, useState } from "react";
import type { MarketMode, TimePoint } from "@/lib/types";
import { decimal, periodLabel } from "@/lib/display-values";
import type { MarketSceneHandle } from "./market-scene-renderer";
import styles from "./market-scene.module.css";

export function MarketScene({ points, mode, name }: { points: TimePoint[]; mode: MarketMode; name: string }) {
  const [enabled, setEnabled] = useState(false);
  const [failed, setFailed] = useState(false);
  // Select by period, not array position, so a filter change keeps the same year;
  // without a selection (or when it leaves the range) show the latest period.
  const [selectedPeriod, setSelectedPeriod] = useState<string>();
  const host = useRef<HTMLDivElement>(null);
  const scene = useRef<MarketSceneHandle | null>(null);
  const found = points.findIndex((row) => row.period === selectedPeriod);
  const index = found >= 0 ? found : Math.max(0, points.length - 1);
  const indexRef = useRef(index);
  // Declared before the mount effect, so a newly mounted scene starts on the current period.
  useEffect(() => { indexRef.current = index; }, [index]);
  const point = points[index];
  const price = (row: TimePoint) => row.isPublishable === false ? null :
    mode === "sale" ? row.medianPricePerSqm : row.medianMonthlyRent;
  const unit = mode === "sale" ? "€/m²" : "€ / mesec";
  const label = (row: TimePoint) => `${periodLabel(row.period, "year")}${row.incomplete ? " *" : ""}`;
  useEffect(() => {
    if (!enabled || failed || !host.current || !points.length) return;
    let cancelled = false;
    const element = host.current;
    import("./market-scene-renderer").then(({ mountMarketScene }) => {
      if (cancelled) return;
      try {
        scene.current = mountMarketScene(element, points.map((row) => Math.max(0, row.transactionCount)),
          indexRef.current, (next) => setSelectedPeriod(points[next]?.period), () => setFailed(true));
      } catch { setFailed(true); }
    }).catch(() => { if (!cancelled) setFailed(true); });
    return () => { cancelled = true; scene.current?.dispose(); scene.current = null; };
  }, [enabled, failed, points]);
  // Changing the period only recolours bars; the WebGL context is created once per data set.
  useEffect(() => { scene.current?.select(index); }, [index]);

  return <section className={styles.section} aria-labelledby="perspective-title">
    <header><div><span className="section-eyebrow">Obseg trga · {name}</span><h2 id="perspective-title">Trg v perspektivi</h2>
      <p>Vsak stolpec predstavlja obdobje. Višina prikazuje število poslov, ne cene ali vrednosti stavb.</p></div>
      <button type="button" aria-pressed={enabled} disabled={failed || !points.length}
        onClick={() => setEnabled(!enabled)}>{enabled ? "Izklopi 3D" : "Vključi 3D pogled"}</button></header>
    {!points.length ? <p>Za izbrani trg še ni časovne serije.</p> : <>
      {failed && <p role="status">WebGL ni na voljo. Vsi podatki ostanejo dostopni spodaj.</p>}
      {enabled && !failed && <><div className={styles.scene} ref={host}/>
        <p className={styles.hint}>Povlecite za vrtenje, dvokliknite za začetni pogled. Klik na stolpec izbere obdobje.</p></>}
      <div className={styles.periods} role="group" aria-label="Izberi obdobje">{points.map((row, i) => <button type="button" key={row.period}
        aria-pressed={i === index} onClick={() => setSelectedPeriod(points[i].period)}>{label(row)}</button>)}</div>
      {point && <dl className={styles.metrics} aria-live="polite">
        <div><dt>Obdobje</dt><dd>{label(point)}</dd></div>
        <div><dt>Posli</dt><dd>{point.transactionCount.toLocaleString("sl-SI")}</dd></div>
        <div><dt>Reprezentativni vzorec</dt><dd>{point.includedSampleSize.toLocaleString("sl-SI")}</dd></div>
        <div><dt>{mode === "sale" ? "Mediana cene / m²" : "Mediana mesečne najemnine"}</dt>
          <dd>{price(point) == null ? "Ni objavljena" : `${decimal.format(price(point)!)} ${unit}`}</dd></div>
      </dl>}
      {points.some(row => row.incomplete) && <p>* Nepopolno obdobje; ni neposredno primerljivo s celotnim letom.</p>}
      <details><summary>Vsa obdobja v tabeli</summary><div className={styles.tableScroll}><table>
        <thead><tr><th>Obdobje</th><th>Posli</th><th>Vzorec</th><th>Mediana ({unit})</th></tr></thead>
        <tbody>{points.map(row => <tr key={row.period}><th>{label(row)}</th><td>{row.transactionCount}</td><td>{row.includedSampleSize}</td><td>{price(row) == null ? "Ni objavljena" : decimal.format(price(row)!)}</td></tr>)}</tbody>
      </table></div></details>
    </>}
  </section>;
}
