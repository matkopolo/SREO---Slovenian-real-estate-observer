import { lastCompleteYear, loadQuality } from "../api";
import { LoadState } from "../components/LoadState";
import { useLoad } from "../hooks/useLoad";
import { integer, upTo1, upTo2 } from "../format";
import { t } from "../i18n";
import { transactionHref } from "../url-state";

const FLAGS: Record<string, string> = {
  extreme_price_per_m2: t("skrajna cena na m²"), possible_duplicate: t("možen dvojnik"), possible_near_duplicate: t("možen skoraj-dvojnik"),
  model_residual: t("odstopa od modela"), isolation_forest: t("nenavaden po modelu"), hard_rule: t("kršeno pravilo"),
};
const saleLink = (id: number) => transactionHref({ kind: "sale", id });
const rentalLink = (id: number) => transactionHref({ kind: "rent", id });
/** The contract leaves /anomalies items untyped; these are the fields the API returns. */
interface AnomalyItem { transactionKind: string; transactionId: number; flags: string[]; reviewScore: number }
interface AnomalyList { items: AnomalyItem[]; total: number }
const formatted = (value: number | null | undefined, digits = 0) => value == null ? "—" : (digits ? upTo1 : integer)(value);
/** IQR/MAD bounds can fall below zero for skewed cohorts; a negative price bound reads as "no lower bound". */
const bounds = (lower: number | null | undefined, upper: number | null | undefined, digits = 0) =>
  lower != null && lower <= 0 ? t("meja do {upper}", { upper: formatted(upper, digits) }) : t("meja {lower}–{upper}", { lower: formatted(lower, digits), upper: formatted(upper, digits) });

/** What the numbers are, what they exclude and why; the review queue sits behind an analyst disclosure. */
export function QualityView({ cutoff }: { cutoff?: string }) {
  // The last complete year of the data, not of the clock.
  const year = cutoff ? lastCompleteYear(cutoff) : new Date().getFullYear() - 1;
  const quality = useLoad(`quality|${year}`, (signal) => loadQuality(year, signal));
  const data = quality.data;
  const [, , outliers, rentalOutliers] = data ?? [];
  const excluded = (outliers?.total ?? 0) + (rentalOutliers?.total ?? 0);
  return <div className="view about">
    <h1 className="stage-title">{t("O podatkih")}</h1>
    <div className="chart-grid two">
      <section className="card"><h2>{t("Kaj štejemo")}</h2>
        <p>{t("Dejansko sklenjene prodaje in najeme iz Evidence trga nepremičnin (GURS ETN), ne oglasov.")}
          {" "}{t("Vsak posel je pripisan uradnim mejam občin, regij in naselij (Register prostorskih enot).")}
          {" "}{t("Mediana in povprečje upoštevata le reprezentativne posle: prodaje na prostem trgu z znano površino in ceno.")}</p></section>
      <section className="card"><h2>{t("Kaj izločimo in zakaj")}</h2>
        <p>{data ? t("Posle med sorodniki, prodaje deležev, posle brez površine ali cene in skrajna odstopanja glede na primerljive posle (v zadnjem letu {count} poslov).", { count: integer(excluded) })
          : t("Posle med sorodniki, prodaje deležev, posle brez površine ali cene in skrajna odstopanja glede na primerljive posle.")}
          {" "}{t("Mediano objavimo šele od 30 poslov naprej, da posamezen posel ne odloča o vrednosti.")}</p></section>
      <section className="card"><h2>{t("Zamik evidence")}</h2>
        <p>{t("GURS posle evidentira z zamikom: prodaje nekaj mesecev, najemne pogodbe do enega leta.")}
          {" "}{t("Zato prodaje štejemo do konca zadnjega zaključenega četrtletja, najemnine pa za zadnje celo leto.")}
          {" "}{t("Zadnja četrtletja so začasna.")}</p></section>
      <section className="card"><h2>{t("Demografija in cene")}</h2>
        <p>{t("Prikazujemo demografske tokove (stanovanja, ki jih sprostijo starejši lastniki, nastajanje mladih gospodinjstev, selitve) kot kazalnike ponudbe in povpraševanja.")}
          {" "}{t("Napovedi cen iz demografije ne objavljamo: preizkus na podatkih 2010–2025 (206.520 prodaj, vse občine in regije) ni pokazal ponovljivega vpliva — učinki so majhni, med obdobji menjajo predznak in napovedujejo slabše kot predpostavka, da vse občine rastejo kot Slovenija.")}
          {" "}{t("Preizkus bomo ponovili, ko bodo na voljo podatki za 2027–2030.")}</p></section>
      <section className="card"><h2>{t("Drugi viri")}</h2>
        <p>{t("SURS: plače, prebivalstvo, selitve, umrli, popis stanovanj in gospodinjstev, inflacija.")}
          {" "}{t("Banka Slovenije: obrestne mere in omejitve kreditiranja.")} {t("ECB: EURIBOR.")} {t("GURS kataster stavb: nove stavbe.")}
          {" "}{t("Vrednosti so obdelane in informativne; niso uradna cenitev ali ponudba kredita.")}</p></section>
    </div>
    <details className="disclosure analysts">
      <summary>{t("Za analitike: opozorila in izločena odstopanja")}</summary>
      <p className="stage-sub">{t("Opozorila so signali za človeški pregled, ne dokaz napake ali goljufije.")} {t("Posel z opozorilom ostane v statistiki, razen če je izločen kot odstopanje.")}</p>
    <LoadState load={quality}>{([summary, anomalyResponse]) => {
      const anomalies = anomalyResponse as unknown as AnomalyList;
      const share = summary.total ? summary.flagged / summary.total : 0;
      return <>
      <dl className="tiles">
        <div><dt>{t("Ocenjeni prodajni posli")}</dt><dd>{integer(summary.total)}</dd><small>{t("vsi z izračunanimi signali")}</small></div>
        <div><dt>{t("Z vsaj enim opozorilom")}</dt><dd>{integer(summary.flagged)}</dd><small>{t("{share} % vseh", { share: upTo1(share * 100) })}</small></div>
        <div><dt>{t("Visoka prioriteta")}</dt><dd>{integer(summary.highPriority)}</dd><small>{t("najmočnejši združeni signal")}</small></div>
      </dl>
      <div className="chart-grid two">
        <section className="card"><h2>{t("Najmočnejša opozorila")}</h2>
          <p className="muted">{t("Razvrščeno po skupni oceni pregleda, od {total} ocenjenih poslov.", { total: integer(anomalies.total ?? 0) })}</p>
          <ol className="rows">{(anomalies.items ?? []).map((item) => <li key={`${item.transactionKind}-${item.transactionId}`}>
            <a href={saleLink(item.transactionId)}>{t("Posel #{id}", { id: item.transactionId })}</a>
            <span>{t("{flags}; ocena {score}", { flags: item.flags.map((flag) => FLAGS[flag] ?? flag.replace(/_/g, " ")).join(", "), score: upTo2(item.reviewScore) })}</span>
          </li>)}</ol></section>
        <section className="card"><h2>{t("Izločena statistična odstopanja, {year}", { year })}</h2>
          <p className="muted">{t("Posli zunaj robustnih meja svoje kohorte ; ne vstopajo v mediane.")}</p>
          <h3 className="mini">{t("Prodaje ({count})", { count: integer(outliers?.total ?? 0) })}</h3>
          <ol className="rows">{[...new Map((outliers?.items ?? []).map((item) => [item.transactionId, item])).values()].slice(0, 5).map((item) => <li key={item.transactionId}>
            <a href={saleLink(item.transactionId)}>{formatted(item.pricePerSqm)} €/m²</a>
            <span>{t("{bounds}; mediana primerljivih {median} (n = {size})", { bounds: bounds(item.lowerBound, item.upperBound), median: formatted(item.cohortMedian), size: item.cohortSize })}</span>
          </li>)}</ol>
          <h3 className="mini">{t("Najemi ({count})", { count: integer(rentalOutliers?.total ?? 0) })}</h3>
          <ol className="rows">{[...new Map((rentalOutliers?.items ?? []).map((item) => [item.transactionId, item])).values()].slice(0, 5).map((item) => <li key={item.transactionId}>
            <a href={rentalLink(item.transactionId)}>{formatted(item.monthlyRentPerSqm, 1)} €/m²</a>
            <span>{bounds(item.lowerBound, item.upperBound, 1)}; n = {item.cohortSize}</span>
          </li>)}</ol></section>
      </div>
    </>;
    }}</LoadState>
    </details>
  </div>;
}
