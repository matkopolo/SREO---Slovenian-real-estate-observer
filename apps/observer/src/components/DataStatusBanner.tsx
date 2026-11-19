import type { loadDataStatus } from "../api";
import { date as dateText } from "../format";
import { t } from "../i18n";
import "./banner.css";

export type DataStatus = Awaited<ReturnType<typeof loadDataStatus>>;

/** A published cutoff older than this means the monthly GURS update has not come through. */
const STALE_DAYS = 120;
const STAGES: Record<string, string> = {
  source: t("preverjanje in uvoz vira GURS"),
  geography: t("usklajevanje geografskih meja"),
  analytics: t("preračun analitike"),
  models: t("učenje in preverjanje modelov"),
  published: t("objava"),
};
const date = (value?: string) => value ? dateText(value) : "—";

/**
 * What the reader should know about the data update; undefined when everything is current.
 * `missing` (no release at all) is the only prominent state: while a release is published the page works, so the
 * note is a single muted line ("Podatki do … · …") that opens to its explanation in `detail`.
 */
export interface Notice { key: string; tone: "note" | "missing"; text: string; detail?: string }

export function dataNotice(status: DataStatus | undefined, now = new Date()): Notice | undefined {
  if (!status) return undefined;
  const active = status.activeRelease;
  const through = active?.analyticsSaleThrough;
  if (!active || !through) return { key: "missing", tone: "missing", text: t("Podatki še niso objavljeni. Analitika GURS ETN se pripravlja.") };
  const shown = t("Podatki do {date}", { date: date(through) });
  const pending = status.pendingRelease;
  if (pending || status.status === "processing") {
    const checking = !pending || pending.stage === "source";
    return { key: `processing:${pending?.id ?? ""}`, tone: "note",
      text: checking ? `${shown} · ${t("nova posodobitev čaka na GURS")}` : `${shown} · ${t("podatki se osvežujejo")}`,
      detail: checking ? t("Preverjamo, ali je GURS objavil novejši vir.")
        : t("Novi vir sega do {date}; trenutno poteka {stage}.", { date: date(pending?.sourceSaleThrough), stage: STAGES[pending?.stage ?? ""] ?? pending?.stage }) };
  }
  if (status.status === "failed") {
    return { key: `failed:${status.lastFailedRelease?.id ?? ""}`, tone: "note", text: `${shown} · ${t("posodobitev bomo ponovili")}`,
      detail: t("Zadnja posodobitev podatkov ni uspela; prikazujemo zadnjo zaključeno analitiko.") };
  }
  if ((now.getTime() - new Date(through).getTime()) / 86_400_000 > STALE_DAYS) {
    return { key: `stale:${active.id}`, tone: "note", text: `${shown} · ${t("nova posodobitev čaka na GURS")}`,
      detail: t("Novejšega vira GURS še nismo obdelali.") };
  }
  return undefined;
}

/**
 * A quiet line about the data update (never an outage look while a release is published); nothing when all is current.
 * The explanation opens under the line (a disclosure, so it is reachable by touch and keyboard, not only on hover).
 */
export function DataStatusBanner({ status }: { status?: DataStatus }) {
  const notice = dataNotice(status);
  // The live region stays mounted so screen readers announce the notice when it appears.
  return <div className="data-banner-region" role="status">
    {notice && (notice.detail
      ? <details className={`data-banner ${notice.tone}`}><summary>{notice.text}</summary><p>{notice.detail}</p></details>
      : <p className={`data-banner ${notice.tone}`}>{notice.text}</p>)}
  </div>;
}
