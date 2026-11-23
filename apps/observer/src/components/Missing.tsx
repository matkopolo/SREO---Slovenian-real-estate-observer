import { integer } from "../format";
import { t } from "../i18n";

/**
 * One way of saying that a value is absent (GLOSSARY.md, "missing data"): a register field that is not filled in reads
 * "—" on screen and "ni podatka" / "no data" to a screen reader, never "0" or an empty cell.
 */
export function Missing() {
  return <span className="missing"><span aria-hidden="true">—</span><span className="sr-only">{t("ni podatka")}</span></span>;
}

/** Below the publication threshold: "premalo prodaj (12)" / "too few sales (12)"; the count is added when known. */
export function tooFew(kind: "sale" | "rent", count?: number | null): string {
  const known = count != null && count > 0;
  if (kind === "rent") return known ? t("premalo najemov ({count})", { count: integer(count) }) : t("premalo najemov");
  return known ? t("premalo prodaj ({count})", { count: integer(count) }) : t("premalo prodaj");
}

/** No event at all in the period: "ni prodaj" / "no sales". */
export const none = (kind: "sale" | "rent"): string => kind === "rent" ? t("ni najemov") : t("ni prodaj");

/** Below the threshold or none at all, by the count. */
export const withheld = (kind: "sale" | "rent", count?: number | null): string => count === 0 ? none(kind) : tooFew(kind, count);

/** A chart with nothing to draw. */
export const emptyChart = (): string => t("Premalo prodaj za graf.");

/** An estimate that cannot be computed. */
export const noEstimate = (): string => t("Premalo podatkov za oceno.");

/** A loading value: "Nalagam …" with a non-breaking space ("Loading…" in English), never "…" alone. */
export const loadingText = (): string => t("Nalagam …");
