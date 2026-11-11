import { useId, type ReactNode } from "react";
import type { SaleTransaction } from "../api";
import { date, euro, integer, sqm } from "../format";
import { t, tx } from "../i18n";
import { count, forms, NOUN_FORMS } from "../plural";

const FLOORS = forms(["etaža", "etaži", "etaže", "etaž"], ["storey", "storeys"]); // i18n-ignore
const CERTIFICATES = forms(["izkaznica", "izkaznici", "izkaznice", "izkaznic"], ["certificate", "certificates"]); // i18n-ignore
const PARTS = forms(["prodani del", "prodana dela", "prodani deli", "prodanih delov"], ["sold part", "sold parts"]); // i18n-ignore

/**
 * What the official registers say about the sold unit and its building: the energy certificate, the DRSV flood
 * hazard class, the cadastre's renovation years and elevator, and GURS's generalised value last (an administrative
 * value, the one most easily mistaken for a price). The same block serves the sale page (an h3 section, compact,
 * because the unit's size and year are already in Podrobnosti) and the value page (an h2 module).
 */
export type Facts = NonNullable<SaleTransaction["building"]>;

const HAZARD: Record<string, string> = {
  Pv: t("velika poplavna nevarnost"), Ps: t("srednja poplavna nevarnost"), Pm: t("majhna poplavna nevarnost"), Pp: t("preostala poplavna nevarnost (zelo redke poplave)"),
};
/** GURS valuation models by code; an unlisted code shows the register's own label. */
const MODELS: Record<string, string> = {
  STA: t("stanovanja"), HIS: t("hiše"), GAR: t("garaže"), PPP: t("pisarne"), PPL: t("lokali"), IND: t("industrija"),
  KDS: t("kmetijske in druge stavbe"), SDP: t("stavbe splošnega družbenega pomena"), TUR: t("stavbe za turizem"),
};
const yesNo = (value: boolean | null | undefined) => value == null ? t("ni podatka") : value ? t("da") : t("ne");

/** The class as a coloured chip on the EU label scale (A1 best … G worst). */
export function EnergyClass({ value }: { value: string }) {
  return <span className="energy-class" data-class={value}>{value}</span>;
}

type Row = { label: string; value: ReactNode; note?: ReactNode };

function energyRow(facts: Facts): Row {
  const label = t("Energijska izkaznica");
  const certificate = facts.energyCertificate;
  // The other units' classes, when there is more than the shown certificate.
  const others = facts.buildingCertificates > 1 && facts.buildingEnergyClasses.length
    ? t("v stavbi {certificates}, razredi {classes}", { certificates: count(facts.buildingCertificates, CERTIFICATES), classes: facts.buildingEnergyClasses.join(", ") }) : null;
  if (!certificate) return { label, value: <span className="muted">{t("ni v javnem registru")}</span>, note: others };
  const kind = certificate.type === "measured" ? t("merjena izkaznica") : t("računska izkaznica");
  const scope = certificate.scope === "building" ? t("za celo stavbo") : t("za to enoto");
  const issued = t("izdana {date}, velja do {until}", { date: date(certificate.issuedOn), until: certificate.validUntil ? date(certificate.validUntil) : "—" });
  const demand = certificate.type === "computed" && certificate.heatingDemand != null
    ? t("potrebna toplota za ogrevanje {value} kWh/m²a", { value: integer(certificate.heatingDemand) }) : null;
  return {
    label,
    value: certificate.class ? <>{<EnergyClass value={certificate.class}/>} <span className="energy-kind">{kind}, {scope}</span></> : <>{kind}, {scope}</>,
    note: [issued, demand, others].filter(Boolean).join(" · "),
  };
}

function floodRow(facts: Facts): Row | null {
  const flood = facts.flood;
  if (!flood) return null;
  const label = t("Poplavna nevarnost (DRSV)");
  if (flood.hazardClass) return { label, value: HAZARD[flood.hazardClass] ?? flood.hazardClass, note: t("razred {code} za središče stavbe; na poplavno preučenem območju", { code: flood.hazardClass }) };
  if (flood.studied) return { label, value: t("zunaj razredov poplavne nevarnosti"), note: t("območje je poplavno preučeno") };
  return { label, value: <span className="muted">{t("območje še ni poplavno preučeno")}</span>, note: t("brez študije to ne pomeni, da poplav ni") };
}

function cadastreRows(facts: Facts, compact: boolean): Row[] {
  const cadastre = facts.cadastre;
  if (!cadastre) return [];
  const years = [
    cadastre.facadeRenovated && t("fasada {year}", { year: cadastre.facadeRenovated }),
    cadastre.roofRenovated && t("streha {year}", { year: cadastre.roofRenovated }),
    cadastre.windowsRenovated && t("okna {year}", { year: cadastre.windowsRenovated }),
    cadastre.installationsRenovated && t("instalacije {year}", { year: cadastre.installationsRenovated }),
  ].filter(Boolean);
  const unitNote = cadastre.unitKnown ? null : t("samo podatki o stavbi; ta del stavbe v katastru ni vpisan");
  const renovations: Row = years.length
    ? { label: t("Prenove po katastru"), value: years.join(", "), note: [t("leto, v katerem je bila zamenjana več kot polovica elementa"), unitNote].filter(Boolean).join(" · ") }
    : { label: t("Prenove po katastru"), value: t("v katastru ni vpisanih prenov"), note: [t("lastniki prenov pogosto ne sporočijo, zato to ne pomeni, da jih ni bilo"), unitNote].filter(Boolean).join(" · ") };
  const building = [
    cadastre.yearBuilt && t("zgrajena {year}", { year: cadastre.yearBuilt }),
    cadastre.floors && count(cadastre.floors, FLOORS),
    cadastre.dwellings && count(cadastre.dwellings, NOUN_FORMS.stanovanje),
  ].filter(Boolean).join(", ");
  const unitSize = !compact && cadastre.unitKnown && cadastre.area != null
    ? t("ta enota {area}{usable}", { area: sqm(cadastre.area), usable: cadastre.usableArea != null && Math.abs(cadastre.usableArea - cadastre.area) >= 0.1 ? `, ${t("uporabna {area}", { area: sqm(cadastre.usableArea) })}` : "" })
    : undefined;
  return [renovations, { label: t("Dvigalo"), value: yesNo(cadastre.elevator) },
    ...(building ? [{ label: t("Stavba"), value: building, note: unitSize }] : [])];
}

function valueRow(facts: Facts): Row | null {
  const value = facts.generalisedValue;
  if (!value) return null;
  const model = MODELS[value.model] ?? value.modelLabel?.toLowerCase() ?? value.model;
  return { label: t("Posplošena vrednost GURS"),
    value: value.value != null ? <strong>{euro(value.value)}</strong> : <span className="muted">{t("ni določena")}</span>,
    note: [
      t("uradna vrednost GURS za davčne in druge javne namene po stanju trga {date}, ne tržna cena", { date: date(value.valuationDate) }),
      t("model: {model}", { model }),
      value.packageValue != null ? t("{parts} skupaj {value}", { parts: count(value.packageParts, PARTS), value: euro(value.packageValue) }) : null,
    ].filter(Boolean).join(" · ") };
}

export function BuildingFacts({ facts, heading = "h3", title, compact = false }: { facts: Facts; heading?: "h2" | "h3"; title?: string;
  /** On the sale card the unit's size is already in Podrobnosti, so the block does not repeat it. */
  compact?: boolean }) {
  const Heading = heading;
  const titleId = useId();
  const rows = [energyRow(facts), floodRow(facts), ...cadastreRows(facts, compact), valueRow(facts)].filter((row): row is Row => row != null);
  const stated = (label: string, when: string | undefined) => when ? t("{source} (stanje {date})", { source: label, date: date(when) }) : null;
  const registerDate = [facts.cadastre?.sourceDate, facts.generalisedValue?.sourceDate].filter(Boolean).sort().at(-1);
  const sources = [
    stated(t("Register energetskih izkaznic (MOPE)"), facts.energyCertificate?.sourceDate),
    stated(t("GURS, Kataster nepremičnin in Evidenca vrednotenja (CC BY 4.0)"), registerDate),
    stated(t("DRSV, karta razredov poplavne nevarnosti (CC BY 4.0)"), facts.flood?.sourceDate),
  ].filter(Boolean).join("; ");
  return <section className="building-facts" aria-labelledby={titleId}>
    <Heading id={titleId}>{title ?? t("Stavba in enota po registrih")}</Heading>
    <dl className="facts td-facts building-facts-rows">{rows.map((row) => <div key={row.label}>
      <dt>{row.label}</dt><dd>{row.value}{row.note && <small className="muted">{row.note}</small>}</dd>
    </div>)}</dl>
    {sources && <p className="muted td-note">{tx("Viri: {sources}.", { sources })}</p>}
  </section>;
}
