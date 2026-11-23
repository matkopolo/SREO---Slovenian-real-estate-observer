import { useState, type ReactNode } from "react";
import { loadRecent, type DateWindow, type RecentTransaction, type RentSegment, type SalesSort, type Segment } from "../api";
import { addressLabel } from "../address";
import { LoadFailed } from "./LoadState";
import { useLoad } from "../hooks/useLoad";
import { dateCompact, decimal1, euro, integer, landArea, NBSP, titleCase } from "../format";
import { count, NOUN_FORMS } from "../plural";
import { Name, t, tx } from "../i18n";
import { hrefWith } from "../url-state";
import { GLOSSARY_EXTRA, Term } from "./Term";
import "./sales-list.css";

const COLUMNS: Array<{ id: SalesSort; label: string; className?: string }> = [
  { id: "date", label: t("Datum") }, { id: "area", label: t("Površina"), className: "num" }, { id: "price", label: t("Cena"), className: "num" }, { id: "perSqm", label: "€/m²", className: "num" },
];
const PAGE = 25;
/** Sort choices as people say them (the column headers are hidden in a narrow panel). */
const SORTS: Array<{ value: string; label: string }> = [
  { value: "date-desc", label: t("Najnovejše") }, { value: "date-asc", label: t("Najstarejše") },
  { value: "price-asc", label: t("Najcenejše") }, { value: "price-desc", label: t("Najdražje") },
  { value: "perSqm-asc", label: t("Najnižja cena na m²") }, { value: "perSqm-desc", label: t("Najvišja cena na m²") },
  { value: "area-desc", label: t("Največje") }, { value: "area-asc", label: t("Najmanjše") },
];

/** Street address, or for land (no address) the settlement and largest parcel ("Vetrnik, parc. 659/5 in še 2"). */
function place(row: RecentTransaction): ReactNode {
  const address = addressLabel(row);
  if (address) return <Name>{address}</Name>;
  const town = titleCase(row.settlementName);
  const parcel = !row.parcelNumber ? "" : (row.parcelCount ?? 0) > 1 ? t("parc. {number} in še {count}", { number: row.parcelNumber, count: (row.parcelCount ?? 1) - 1 })
    : t("parc. {number}", { number: row.parcelNumber });
  if (!town && !parcel) return t("lokacija ni navedena");
  return <>{town && <Name>{town}</Name>}{town && parcel ? ", " : ""}{parcel}</>;
}
const PREVIEW = 5;

/**
 * Every recorded sale (or rental) of the area for the chosen period, type and size, like DVF's list:
 * the newest five open by default, then all of them with sorting and paging. A thin period falls back to five years.
 */
export function SalesList({ scopeId, scopeName, segment, window, fallback, kind = "sale", noun, linkArea, street, onClearStreet }: {
  scopeId?: number; scopeName: string; segment: Segment | RentSegment; window?: DateWindow; fallback?: DateWindow; kind?: "sale" | "rent";
  /** Genitive plural of the type (`Noun.genitive`): "stanovanj" / "apartments". */
  noun: string;
  /** Area kept in sale links, so the breadcrumb and Back return here. */
  linkArea?: number;
  /** Only this street (registered spelling, from the address search). */
  street?: string; onClearStreet?: () => void;
}) {
  const [all, setAll] = useState(false);
  const [sort, setSort] = useState<SalesSort>("date");
  const [descending, setDescending] = useState(true);
  const [offset, setOffset] = useState(0);
  // Another area, type, period or street starts again from the newest five.
  const listKey = `${scopeId}|${JSON.stringify(segment)}|${window?.from}|${window?.to}|${fallback?.from}|${street}|${kind}`;
  const [shownKey, setShownKey] = useState(listKey);
  if (shownKey !== listKey) { setShownKey(listKey); setOffset(0); setAll(false); }
  const page = { limit: all ? PAGE : PREVIEW, offset: all ? offset : 0, sort, order: descending ? "desc" as const : "asc" as const, street };
  const load = useLoad(window ? { window, fallback, street, page, listKey, scopeId, segment, kind } : null, (input) => `sales-list|${input.listKey}|${JSON.stringify(input.page)}`, async (input, signal) => {
    // A street is short: its list covers five years (the period would leave a handful of sales).
    const span = input.street && input.fallback ? input.fallback : input.window;
    const response = await loadRecent(input.scopeId, input.segment, input.kind, span, signal, input.page);
    // Fewer than five in the period: show the last five years instead, and say so ("show all" keeps those five years).
    if (response.total < PREVIEW && input.fallback && !input.street) {
      const widened = await loadRecent(input.scopeId, input.segment, input.kind, input.fallback, signal, input.page);
      if (widened.total > response.total) return { items: widened.items, total: widened.total, wide: true };
    }
    return { items: response.items, total: response.total, wide: false };
  });
  const result = load.data;

  const forms = kind === "sale" ? NOUN_FORMS.prodaja : NOUN_FORMS.najem;
  const title = kind === "sale" ? t("Prodaje {noun}", { noun }) : t("Najemi {noun}", { noun });
  const where = street ? (fallback ? t("na ulici {street} od leta {year}", { street: titleCase(street), year: fallback.from.slice(0, 4) }) : t("na ulici {street}", { street: titleCase(street) }))
    : t("v območju {area}", { area: scopeName });
  const choose = (id: SalesSort) => {
    if (id === sort) setDescending(!descending); else { setSort(id); setDescending(id === "date" || id === "price"); }
    setOffset(0); setAll(true);
  };
  const rows = result?.items ?? [];
  const total = result?.total ?? 0;
  // The sale link keeps the page state (type, size, land use, period, layer), so the map and panel stay on houses or land.
  const href = (row: RecentTransaction) => hrefWith({ building: undefined, value: false, selected: { kind, id: row.transactionId }, ...(linkArea ? { g: linkArea } : {}) });

  return <section className="module open sales-list" aria-labelledby={`sales-${kind}`}>
    <h2 id={`sales-${kind}`}>{title} {where}{result ? `: ${integer(total)}` : ""}</h2>
    {street && onClearStreet && <button type="button" className="ghost" onClick={onClearStreet}>{tx("× Vse prodaje v območju {area}", { area: <Name>{scopeName}</Name> })}</button>}
    {result?.wide && <p className="note muted">{kind === "sale" ? t("V izbranem obdobju je premalo prodaj; prikazanih je {count} iz zadnjih 5 let.", { count: count(total, forms) })
      : t("V izbranem obdobju je premalo najemov; prikazanih je {count} iz zadnjih 5 let.", { count: count(total, forms) })}</p>}
    {load.error ? <LoadFailed retry={load.retry}>{t("Seznama ni bilo mogoče naložiti.")}</LoadFailed> // i18n-ignore (code, not text)
      : !result ? <p className="note muted" role="status">{kind === "sale" ? t("Nalagam prodaje\u00a0…") : t("Nalagam najeme\u00a0…")}</p> // i18n-ignore (code, not text)
      : !rows.length ? <p className="note muted">{kind === "sale" ? t("V tem obdobju ni evidentiranih prodaj.") : t("V tem obdobju ni evidentiranih najemov.")} {t("Poskusite daljše obdobje ali vse velikosti.")}</p>
      : <>
        {total > 1 && <label className="sales-sort">{t("Razvrsti")}
          <select value={`${sort}-${descending ? "desc" : "asc"}`} onChange={(event) => {
            const [id, order] = event.target.value.split("-") as [SalesSort, string];
            setSort(id); setDescending(order === "desc"); setOffset(0); setAll(true);
          }}>
            {SORTS.map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}
          </select></label>}
        <table className="sales-table">
          <caption className="sr-only">{t("{list}, razvrščeno po {column}", { list: title, column: COLUMNS.find((column) => column.id === sort)?.label })}</caption>
          <thead><tr>
            <th scope="col">{t("Naslov")}</th>
            {COLUMNS.map((column) => <th key={column.id} scope="col" className={column.className} aria-sort={sort === column.id ? (descending ? "descending" : "ascending") : "none"}>
              <button type="button" onClick={() => choose(column.id)}>{column.label}{sort === column.id && <span aria-hidden="true">{descending ? " ↓" : " ↑"}</span>}</button></th>)}
          </tr></thead>
          <tbody>{rows.map((row) => <tr key={row.transactionId}>
            <th scope="row"><a href={href(row)}>{place(row)}</a>
              {!row.representative && <span className="chip"><Term text={GLOSSARY_EXTRA.notInStatistics}>{t("ni v statistiki")}</Term></span>}</th>
            <td data-label={t("Datum")}>{row.contractDate ? dateCompact(row.contractDate) : "—"}</td>
            <td data-label={t("Površina")} className="num">{row.area == null ? "—" : row.area >= 10000 ? landArea(row.area) : `${decimal1(row.area)}${NBSP}m²`}</td>
            <td data-label={kind === "sale" ? t("Cena") : t("Na mesec")} className="num">{row.amount != null ? euro(row.amount) : "—"}</td>
            <td data-label="€/m²" className="num">{row.amountPerSqm != null ? (row.amountPerSqm < 100 ? decimal1 : integer)(row.amountPerSqm) : "—"}</td>
          </tr>)}</tbody>
        </table>
        {!all ? total > rows.length && <button type="button" className="primary-link" onClick={() => setAll(true)}>{kind === "sale" ? t("Prikaži vse prodaje ({count})", { count: integer(total) }) : t("Prikaži vse najeme ({count})", { count: integer(total) })} <span aria-hidden="true">→</span></button>
          : total > PAGE && <nav className="pager" aria-label={t("Strani seznama")}>
            {/* aria-disabled, not disabled: the focused button stays focused at the first or last page. */}
            <button type="button" className="ghost" aria-disabled={offset === 0 || undefined} onClick={() => { if (offset > 0) setOffset(Math.max(0, offset - PAGE)); }}><span aria-hidden="true">←</span> {t("Prejšnjih {count}", { count: PAGE })}</button>
            <span role="status">{t("{from}–{to} od {total}", { from: integer(offset + 1), to: integer(Math.min(total, offset + PAGE)), total: integer(total) })}</span>
            <button type="button" className="ghost" aria-disabled={offset + PAGE >= total || undefined} onClick={() => { if (offset + PAGE < total) setOffset(offset + PAGE); }}>{t("Naslednjih {count}", { count: PAGE })} <span aria-hidden="true">→</span></button>
          </nav>}
      </>}
  </section>;
}
