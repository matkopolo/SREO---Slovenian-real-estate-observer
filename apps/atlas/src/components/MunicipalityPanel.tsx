import { useEffect, useState } from "react";
import { loadAffordability, loadConstruction, loadTimeSeries, type Affordability, type ConstructionSummary, type TimePoint } from "../api";
import type { MetricDefinition, MunicipalityValue } from "../metrics";
import { Sparkline } from "./Sparkline";

const euro = new Intl.NumberFormat("sl-SI", { style: "currency", currency: "EUR", maximumFractionDigits: 0 });
const integer = new Intl.NumberFormat("sl-SI", { maximumFractionDigits: 0 });

interface Details { series?: TimePoint[]; affordability?: Affordability; construction?: ConstructionSummary; failed: string[] }

export function MunicipalityPanel({ geographyId, name, value, metric, year, onClose }: {
  geographyId: number | null; name?: string; value?: MunicipalityValue; metric: MetricDefinition; year: number; onClose: () => void;
}) {
  const [details, setDetails] = useState<Details>({ failed: [] });
  useEffect(() => {
    if (!geographyId) return;
    const controller = new AbortController();
    const { signal } = controller;
    queueMicrotask(() => { if (!signal.aborted) setDetails({ failed: [] }); });
    const settle = <T,>(promise: Promise<T>, key: keyof Omit<Details, "failed">, label: string, pick: (value: T) => unknown) =>
      promise.then((result) => { if (!signal.aborted) setDetails((current) => ({ ...current, [key]: pick(result) })); })
        .catch(() => { if (!signal.aborted) setDetails((current) => ({ ...current, failed: [...current.failed, label] })); });
    void settle(loadTimeSeries(geographyId, signal), "series", "časovna vrsta", (response) => response.items);
    void settle(loadAffordability(geographyId, signal), "affordability", "dostopnost", (response) => response);
    void settle(loadConstruction(geographyId, year, signal), "construction", "gradnja", (response) => response);
    return () => controller.abort();
  }, [geographyId, year]);

  if (!geographyId) {
    return <aside className="panel empty" aria-label="Podrobnosti občine">
      <p className="eyebrow">Občina</p>
      <h2>Izberite občino</h2>
      <p>Kliknite stolpec na zemljevidu ali vrstico v tabeli. Prikazali bomo gibanje cen, dostopnost za mediano plačo in gradnjo.</p>
    </aside>;
  }

  // Tolerate partial or unexpected responses: a missing field shows "—", never a crash.
  const median = details.affordability?.rows?.find((row) => row.band.id === "p50");
  const builds = details.construction?.summary?.buildingsByYear ?? [];
  const built = builds.reduce((sum, row) => sum + row.buildings, 0);
  const permit = details.construction?.summary?.permits?.at(-1);
  const points = (Array.isArray(details.series) ? details.series : []).filter((point) => point.isPublishable && point.medianPricePerSqm != null)
    .map((point) => ({ label: point.period.slice(0, 4), value: point.medianPricePerSqm as number, incomplete: point.incomplete }));

  return <aside className="panel" aria-label={`Podrobnosti: ${name ?? "občina"}`} aria-live="polite">
    <header>
      <div><p className="eyebrow">Občina</p><h2>{name ?? "Občina"}</h2></div>
      <button type="button" className="ghost icon" aria-label="Zapri podrobnosti" onClick={onClose}>×</button>
    </header>
    <dl className="headline">
      <dt>{metric.label}, {year}</dt>
      <dd>{value?.value == null ? "ni objavljive vrednosti" : metric.format(value.value)}</dd>
      <dt className="sr-only">Vzorec</dt><dd className="sample">vzorec {integer.format(value?.sample ?? 0)}</dd>
    </dl>

    <section>
      <h3>Mediana cene stanovanj po letih</h3>
      {!details.series ? <p className="muted">Nalagam …</p> : points.length < 2
        ? <p className="muted">Premalo objavljivih let za prikaz gibanja.</p>
        : <Sparkline points={points} unit="€/m²"/>}
    </section>

    <section>
      <h3>Dostopnost za mediano plačo</h3>
      {!details.affordability?.rule ? <p className="muted">{details.failed.includes("dostopnost") ? "Uradni podatki niso na voljo." : "Nalagam …"}</p>
        : !median ? <p className="muted">Ni podatka za mediano.</p> : <dl className="facts">
          <div><dt>Neto mediana ({details.affordability.wageGeography.name})</dt><dd>{euro.format(median.band.netMonthlyIncome)}</dd></div>
          <div><dt>Kredit, 30 let</dt><dd>{euro.format(median.loan30Years)}</dd></div>
          <div><dt>Cena pri LTV {Math.round(details.affordability.rule.recommendedLtv * 100)} %</dt><dd>{euro.format(median.priceAtRecommendedLtv)}</dd></div>
          <div><dt>Površina po mediani {details.affordability.market.year}</dt><dd>{median.affordableSqm == null ? "—" : `${median.affordableSqm} m²`}</dd></div>
        </dl>}
      {details.affordability?.rule && <p className="note">{median?.floorBinding ? `Obrok omejuje ostanek ${euro.format(details.affordability.rule.minRemainingIncome)}.` : "Obrok omejuje 50 % dohodka."} Ponazoritev, ne ponudba kredita.</p>}
    </section>

    <section>
      <h3>Gradnja</h3>
      {!details.construction ? <p className="muted">{details.failed.includes("gradnja") ? "Podatki niso na voljo." : "Nalagam …"}</p> : <dl className="facts">
        <div><dt>Nove vpisane stavbe {year - 5}–{year}</dt><dd>{integer.format(built)}</dd></div>
        <div><dt>Gradbena dovoljenja {permit?.year ?? ""}</dt><dd>{permit?.buildings == null ? "—" : integer.format(permit.buildings)}</dd></div>
        <div><dt>Javna gradbena naročila, 12 mes.</dt><dd>{details.construction.summary?.publicWorksLast12Months == null ? "—" : integer.format(details.construction.summary.publicWorksLast12Months)}</dd></div>
      </dl>}
    </section>
    {details.failed.length > 0 && <p className="error" role="alert">Ni bilo mogoče naložiti: {details.failed.join(", ")}.</p>}
  </aside>;
}
