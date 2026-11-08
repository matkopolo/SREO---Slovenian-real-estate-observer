"use client";

import { useEffect, useState } from "react";
import { loadAffordability } from "@/lib/api";
import { decimal, euro } from "@/lib/display-values";
import type { Affordability, AffordabilityRow } from "@/lib/types";
import styles from "./affordability-panel.module.css";

const BAND_LABELS: Record<AffordabilityRow["band"]["id"], string> = {
  p10: "10. percentil", q1: "Spodnji kvartil", p50: "Mediana",
  mean: "Povprečje", q3: "Zgornji kvartil", p90: "90. percentil",
};

const percent = (value: number) => `${decimal.format(value)} %`;
const period = (value: string) => value.replace(/^(\d{4})M(\d{2})$/, "$2/$1").replace(/^(\d{4})-(\d{2})$/, "$2/$1");

type Term = 20 | 30;

export function AffordabilityPanel({ geographyId, areaName, propertyGroup }: {
  geographyId?: number; areaName: string; propertyGroup: "apartment" | "house";
}) {
  const [data, setData] = useState<Affordability>();
  const [error, setError] = useState(false);
  const [term, setTerm] = useState<Term>(30);
  useEffect(() => {
    const controller = new AbortController();
    queueMicrotask(() => { if (!controller.signal.aborted) { setError(false); setData(undefined); } });
    loadAffordability(geographyId, propertyGroup, controller.signal)
      .then((value) => { if (!controller.signal.aborted) setData(value); })
      .catch(() => { if (!controller.signal.aborted) setError(true); });
    return () => controller.abort();
  }, [geographyId, propertyGroup]);

  const ltv = data?.rule.recommendedLtv ?? 0.8;
  const median = data?.market.medianPricePerSqm ?? null;
  const loan = (row: AffordabilityRow) => term === 20 ? row.loan20Years : row.loan30Years;
  const maxLoan = Math.max(1, ...(data?.rows ?? []).map(loan));
  const propertyLabel = propertyGroup === "apartment" ? "stanovanj" : "hiš";

  return <section className={styles.panel} aria-labelledby="affordability-title" aria-busy={!data && !error}>
    <header className={styles.header}>
      <div>
        <span className="section-eyebrow">Dostopnost nakupa · {data?.wageGeography.name ?? areaName}</span>
        <h2 id="affordability-title">Koliko kredita omogočajo plače v tem območju?</h2>
        <p>En kreditojemalec brez drugih obveznosti, po omejitvah Banke Slovenije in povprečnih obrestnih merah
          novih stanovanjskih kreditov. Cena pri {percent(ltv * 100)} LTV in površina po mediani dejanskih poslov.</p>
      </div>
      <div className={styles.term} role="group" aria-label="Doba odplačevanja">
        {([20, 30] as Term[]).map((value) => <button type="button" key={value} aria-pressed={term === value}
          onClick={() => setTerm(value)}>{value} let</button>)}
      </div>
    </header>

    {error && <p role="alert" className={styles.notice}>Uradni podatki o plačah, obrestnih merah ali omejitvah še niso naloženi.
      Tržni podatki ostajajo na voljo zgoraj.</p>}
    {!data && !error && <p role="status" className={styles.notice}>Nalagam uradne podatke …</p>}

    {data && <>
      {data.wageGeography.nationalFallback && <p className={styles.notice}>Za izbrano območje SURS ne objavlja plač po občini
        prebivališča; uporabljene so plače za Slovenijo.</p>}
      <dl className={styles.inputs}>
        <div><dt>Neto plače</dt><dd>SURS · {period(data.wagePeriod)}</dd></div>
        <div><dt>Obrestna mera, fiksna nad 10 let</dt><dd>{percent(data.rates.fixedOver10Years.value)} · {period(data.rates.fixedOver10Years.period)}</dd></div>
        <div><dt>Spremenljiva / fiksna do 1 leta</dt><dd>{percent(data.rates.variable.value)}</dd></div>
        {data.rates.aprc && <div><dt>EOM stanovanjskih kreditov</dt><dd>{percent(data.rates.aprc.value)}</dd></div>}
        {data.rates.euribor6m && <div><dt>EURIBOR 6M (mesečno povprečje)</dt><dd>{percent(data.rates.euribor6m.value)} · {period(data.rates.euribor6m.period)}</dd></div>}
        <div><dt>Omejitve Banke Slovenije</dt><dd>obrok ≤ {percent(data.rule.dstiMax * 100)} dohodka · ostati mora {euro.format(data.rule.minRemainingIncome)}</dd></div>
        <div><dt>Mediana {propertyLabel} {data.market.year}</dt>
          <dd>{median == null ? "ni objavljena (premajhen vzorec)" : `${decimal.format(median)} €/m² · n=${data.market.sampleSize.toLocaleString("sl-SI")}`}</dd></div>
      </dl>

      <div className={styles.tableScroll}>
        <table className={styles.table}>
          <caption className="sr-only">Ponazoritev kredita po dohodkovnih razredih za {term} let</caption>
          <thead><tr>
            <th scope="col">Neto plača</th><th scope="col">Najvišji obrok</th><th scope="col">Kredit · {term} let</th>
            <th scope="col">Cena pri LTV {percent(ltv * 100)}</th><th scope="col">Lastna sredstva</th>
            <th scope="col">m² po mediani</th>{term === 30 && <th scope="col">Obrestna mera +{decimal.format(data.stressMarginPoints)} o. t.</th>}
          </tr></thead>
          <tbody>{data.rows.map((row) => {
            const amount = loan(row);
            const price = amount / ltv;
            const sqm = median ? Math.round(price / median) : null;
            return <tr key={row.band.id}>
              <th scope="row"><span>{BAND_LABELS[row.band.id]}</span><small>{euro.format(row.band.netMonthlyIncome)} / mesec</small></th>
              <td>{euro.format(row.maxInstalment)}<small className={row.floorBinding ? styles.floor : styles.ratio}>
                {row.floorBinding ? `omejuje ostanek ${euro.format(data.rule.minRemainingIncome)}` : `omejuje ${percent(data.rule.dstiMax * 100)} dohodka`}</small></td>
              <td className={styles.loanCell}><strong>{euro.format(amount)}</strong>
                <span className={styles.track} aria-hidden="true"><i style={{ width: `${amount / maxLoan * 100}%` }}/></span></td>
              <td>{euro.format(price)}</td>
              <td>{euro.format(price - amount)}</td>
              <td>{sqm == null ? "—" : `${sqm} m²`}</td>
              {term === 30 && <td>{euro.format(row.loan30YearsStress)}</td>}
            </tr>;
          })}</tbody>
        </table>
      </div>

      <p className={styles.footnote}>Dva enaka dohodka: Banka Slovenije omejitev uporabi za vsakega kreditojemalca posebej,
        zato je skupni znesek približno dvakratnik vrstice. Brez vzdrževanih družinskih članov, drugih kreditov in stroškov nakupa.
        Banke lahko dobo in LTV omejijo strožje.</p>
      <p className={styles.disclaimer}><strong>{data.disclaimer}</strong> Viri: {data.wageSource}; {data.rates.fixedOver10Years.sourceTable};
        {data.rates.euribor6m ? ` ${data.rates.euribor6m.sourceTable};` : ""} omejitve Banke Slovenije od {data.rule.validFrom};
        GURS ETN (CC BY 4.0). Preračun: DOMOGLASNIK.</p>
    </>}
  </section>;
}
