import type { ReactNode } from "react";
import { lastCompleteYear, loadQuality } from "../api";
import { LoadState } from "../components/LoadState";
import { useLoad } from "../hooks/useLoad";
import { integer, upTo1, upTo2, withUnit } from "../format";
import { t, tx } from "../i18n";
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

/** One section of the reading column: a serif heading and its paragraphs. */
function Section({ id, title, children }: { id: string; title: string; children: ReactNode }) {
  return <section className="about-section" aria-labelledby={id}><h2 id={id}>{title}</h2>{children}</section>;
}

/**
 * Every source the site draws on, with what it is used for and its terms (docs/data-licensing-privacy.md keeps the same
 * list). The footer of every page names the sources in one line and links here.
 */
function Sources() {
  const source = (name: string) => <strong>{name}</strong>;
  return <ul className="sources">
    <li>{tx("{source}: dejansko sklenjene prodaje in najemi, cene, najemnine ter vse tržne statistike in modeli. CC BY 4.0, podatki so obdelani.", { source: source(t("GURS, Evidenca trga nepremičnin (ETN)")) })}</li>
    <li>{tx("{source}: meje statističnih regij, občin, četrtnih skupnosti in naselij. CC BY 4.0.", { source: source(t("GURS, Register prostorskih enot (RPE)")) })}</li>
    <li>{tx("{source}: leto gradnje, etaže, stanovanja, vrsta stavbe, prenove in dvigala; nove stavbe. Lastniški podatki se ne uvažajo. CC BY 4.0.", { source: source(t("GURS, Kataster nepremičnin (stavbe in deli stavb)")) })}</li>
    <li>{tx("{source}: posplošena vrednost prodane enote, prikazana ob oceni kot upravna vrednost, ne kot cena. Javni podatki po ZMVN-1, CC BY 4.0.", { source: source(t("GURS, Evidenca vrednotenja")) })}</li>
    <li>{tx("{source}: energijski razred in kazalniki prodane enote ali njene stavbe. Javne informacije, ponovna uporaba po ZDIJZ z navedbo vira.", { source: source(t("Register energetskih izkaznic (MOPE, Portal Energetika)")) })}</li>
    <li>{tx("{source}: razred poplavne nevarnosti stavbe in njegov prikaz na zemljevidu; zunaj preučenih območij razred ni določen. CC BY 4.0 (OPSI), z navedbo vira in datuma.", { source: source(t("DRSV, Integralna karta razredov poplavne nevarnosti")) })}</li>
    <li>{tx("{source}: neto plače, gradbena dovoljenja, prebivalstvo, umrli, selitve, stanovanja in gospodinjstva, inflacija. Prosta uporaba z navedbo vira.", { source: source(t("SURS, Statistični urad RS")) })}</li>
    <li>{tx("{source}: obrestne mere stanovanjskih posojil in makrobonitetne omejitve kreditiranja. Prosta uporaba z navedbo vira.", { source: source(t("Banka Slovenije")) })}</li>
    <li>{tx("{source}: šestmesečni EURIBOR. Prosta uporaba z navedbo vira.", { source: source(t("Evropska centralna banka (ECB)")) })}</li>
    <li>{tx("{source}: podlaga zemljevida in slog »liberty«. Podatki ODbL 1.0, shema in slog pod odprtimi licencami; navedba je ob zemljevidu.", { source: source(t("Sodelavci OpenStreetMap, OpenMapTiles in OpenFreeMap")) })}</li>
  </ul>;
}

/** What the numbers are, what they exclude and why, every source with its terms; the review queue sits behind an analyst fold. */
export function QualityView({ cutoff }: { cutoff: string }) {
  // The last complete year of the data, not of the clock.
  const year = lastCompleteYear(cutoff);
  const quality = useLoad(`quality|${year}`, (signal) => loadQuality(year, signal));
  const data = quality.data;
  const [, , outliers, rentalOutliers] = data ?? [];
  const excluded = (outliers?.total ?? 0) + (rentalOutliers?.total ?? 0);
  return <div className="view about">
    <h1 className="stage-title">{t("O podatkih")}</h1>
    <Section id="about-count" title={t("Kaj štejemo")}>
      <p>{t("Dejansko sklenjene prodaje in najeme iz Evidence trga nepremičnin (GURS ETN), ne oglasov.")}
        {" "}{t("Vsak posel je pripisan uradnim mejam občin, regij in naselij (Register prostorskih enot).")}
        {" "}{t("Mediana in povprečje upoštevata le reprezentativne posle: prodaje na prostem trgu z znano površino in ceno.")}</p>
    </Section>
    <Section id="about-excluded" title={t("Kaj izločimo in zakaj")}>
      <p>{data ? t("Posle med sorodniki, prodaje deležev, posle brez površine ali cene in skrajna odstopanja glede na primerljive posle (v zadnjem letu {count} poslov).", { count: integer(excluded) })
        : t("Posle med sorodniki, prodaje deležev, posle brez površine ali cene in skrajna odstopanja glede na primerljive posle.")}
        {" "}{t("Mediano objavimo šele od 30 poslov naprej, da posamezen posel ne odloča o vrednosti.")}</p>
    </Section>
    <Section id="about-lag" title={t("Zamik evidence")}>
      <p>{t("GURS posle evidentira z zamikom: prodaje nekaj mesecev, najemne pogodbe do enega leta.")}
        {" "}{t("Zato prodaje štejemo do konca zadnjega zaključenega četrtletja, najemnine pa za zadnje celo leto.")}
        {" "}{t("Zadnja četrtletja so začasna.")}</p>
    </Section>
    <Section id="about-demography" title={t("Demografija in cene")}>
      <p>{t("Prikazujemo demografske tokove (stanovanja, ki jih sprostijo starejši lastniki, nastajanje mladih gospodinjstev, selitve) kot kazalnike ponudbe in povpraševanja.")}
        {" "}{t("Napovedi cen iz demografije ne objavljamo: preizkus na podatkih 2010–2025 (206.520 prodaj, vse občine in regije) ni pokazal ponovljivega vpliva – učinki so majhni, med obdobji menjajo predznak in napovedujejo slabše kot predpostavka, da vse občine rastejo kot Slovenija.")}
        {" "}{t("Preizkus bomo ponovili, ko bodo na voljo podatki za 2027–2030.")}</p>
    </Section>
    <Section id="about-sources" title={t("Viri in pogoji uporabe")}>
      <p>{t("Vrednosti so obdelane in informativne; niso uradna cenitev ali ponudba kredita.")}
        {" "}{t("GURS in drugi viri aplikacije ne podpirajo, ne potrjujejo in zanjo ne odgovarjajo.")}</p>
      <Sources/>
    </Section>
    <details className="about-fold about-section">
      <summary><h2 id="about-analysts">{t("Za analitike: opozorila in izločena odstopanja")}</h2></summary>
      <p className="stage-sub">{t("Opozorila so signali za človeški pregled, ne dokaz napake ali goljufije.")} {t("Posel z opozorilom ostane v statistiki, razen če je izločen kot odstopanje.")}</p>
    <LoadState load={quality}>{([summary, anomalyResponse]) => {
      const anomalies = anomalyResponse as unknown as AnomalyList;
      const share = summary.total ? summary.flagged / summary.total : 0;
      return <>
      <dl className="tiles">
        <div><dt>{t("Ocenjeni prodajni posli")}</dt><dd>{integer(summary.total)}</dd><dd className="tile-note"><small>{t("vsi z izračunanimi signali")}</small></dd></div>
        <div><dt>{t("Z vsaj enim opozorilom")}</dt><dd>{integer(summary.flagged)}</dd><dd className="tile-note"><small>{t("{share} % vseh", { share: upTo1(share * 100) })}</small></dd></div>
        <div><dt>{t("Visoka prioriteta")}</dt><dd>{integer(summary.highPriority)}</dd><dd className="tile-note"><small>{t("najmočnejši združeni signal")}</small></dd></div>
      </dl>
      <h3>{t("Najmočnejša opozorila")}</h3>
      <p className="note muted">{anomalies.total != null ? t("Razvrščeno po skupni oceni pregleda, od {total} ocenjenih poslov.", { total: integer(anomalies.total) }) : t("Razvrščeno po skupni oceni pregleda.")}</p>
      <ol className="rows">{(anomalies.items ?? []).map((item) => <li key={`${item.transactionKind}-${item.transactionId}`}>
        <a href={saleLink(item.transactionId)}>{t("Posel #{id}", { id: item.transactionId })}</a>
        <span>{t("{flags}; ocena {score}", { flags: item.flags.map((flag) => FLAGS[flag] ?? flag.replace(/_/g, " ")).join(", "), score: upTo2(item.reviewScore) })}</span>
      </li>)}</ol>
      <h3>{t("Izločena statistična odstopanja, {year}", { year })}</h3>
      <p className="note muted">{t("Posli zunaj robustnih meja svoje kohorte; ne vstopajo v mediane.")}</p>
      <h4 className="mini">{outliers?.total != null ? t("Prodaje ({count})", { count: integer(outliers.total) }) : t("Prodaje")}</h4>
      <ol className="rows">{[...new Map((outliers?.items ?? []).map((item) => [item.transactionId, item])).values()].slice(0, 5).map((item) => <li key={item.transactionId}>
        <a href={saleLink(item.transactionId)}>{item.pricePerSqm == null ? t("Posel #{id}", { id: item.transactionId }) : withUnit(formatted(item.pricePerSqm), "€/m²")}</a>
        <span>{t("{bounds}; mediana primerljivih {median} (n = {size})", { bounds: bounds(item.lowerBound, item.upperBound), median: formatted(item.cohortMedian), size: item.cohortSize })}</span>
      </li>)}</ol>
      <h4 className="mini">{rentalOutliers?.total != null ? t("Najemi ({count})", { count: integer(rentalOutliers.total) }) : t("Najemi")}</h4>
      <ol className="rows">{[...new Map((rentalOutliers?.items ?? []).map((item) => [item.transactionId, item])).values()].slice(0, 5).map((item) => <li key={item.transactionId}>
        <a href={rentalLink(item.transactionId)}>{item.monthlyRentPerSqm == null ? t("Posel #{id}", { id: item.transactionId }) : withUnit(formatted(item.monthlyRentPerSqm, 1), "€/m²")}</a>
        <span>{bounds(item.lowerBound, item.upperBound, 1)}; n = {item.cohortSize}</span>
      </li>)}</ol>
    </>;
    }}</LoadState>
    </details>
  </div>;
}
