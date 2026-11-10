import { useState } from "react";
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

interface Notice { key: string; tone: "processing" | "failed" | "stale"; title: string; text: string }

/** What (if anything) the reader should know about the data update; undefined when everything is current. */
export function dataNotice(status: DataStatus | undefined, now = new Date()): Notice | undefined {
  if (!status) return undefined;
  const active = status.activeRelease;
  const through = active?.analyticsSaleThrough;
  const shown = through ? t("Prikazujemo zadnjo zaključeno analitiko s podatki do {date}.", { date: date(through) }) : t("Objavljene analitike še ni.");
  const pending = status.pendingRelease;
  if (pending || status.status === "processing") {
    const checking = !pending || pending.stage === "source";
    return { key: `processing:${pending?.id ?? ""}`, tone: "processing",
      title: checking ? t("Preverjamo nove podatke GURS") : t("Novi podatki GURS so v obdelavi"),
      text: checking ? `${shown} ${t("Preverjamo, ali je GURS objavil novejši vir.")}`
        : `${shown} ${t("Novi vir sega do {date}; trenutno poteka {stage}.", { date: date(pending?.sourceSaleThrough), stage: STAGES[pending?.stage ?? ""] ?? pending?.stage })}` };
  }
  if (status.status === "failed") {
    return { key: `failed:${status.lastFailedRelease?.id ?? ""}`, tone: "failed", title: t("Zadnja posodobitev podatkov ni uspela"),
      text: shown };
  }
  if (!active) return { key: "missing", tone: "stale", title: t("Podatki še niso objavljeni"), text: t("Analitika GURS ETN se pripravlja.") };
  if (through && (now.getTime() - new Date(through).getTime()) / 86_400_000 > STALE_DAYS) {
    return { key: `stale:${active.id}`, tone: "stale", title: t("Podatki morda niso najnovejši"),
      text: t("Zadnja objavljena analitika sega do {date}; novejšega vira GURS še nismo obdelali.", { date: date(through) }) };
  }
  return undefined;
}

const DISMISSED = "sreo-data-notice-dismissed"; // i18n-ignore (storage key)
const readDismissed = () => { try { return window.sessionStorage.getItem(DISMISSED) ?? undefined; } catch { return undefined; } };

/** Small, polite notice about a GURS update in progress, a failed update or stale data; nothing when all is current. */
export function DataStatusBanner({ status }: { status?: DataStatus }) {
  const [dismissed, setDismissed] = useState(readDismissed);
  const notice = dataNotice(status);
  // The live region stays mounted so screen readers announce the notice when it appears.
  return <div className="data-banner-region" role="status">
    {notice && dismissed !== notice.key && <div className={`data-banner ${notice.tone}`}>
      <span className="data-banner-mark" aria-hidden="true"/>
      <p><strong>{notice.title}.</strong> {notice.text}</p>
      <button type="button" className="data-banner-close" aria-label={t("Zapri obvestilo")} onClick={() => {
        setDismissed(notice.key);
        try { window.sessionStorage.setItem(DISMISSED, notice.key); } catch { /* storage unavailable: dismiss for this view only */ }
      }}>×</button>
    </div>}
  </div>;
}
