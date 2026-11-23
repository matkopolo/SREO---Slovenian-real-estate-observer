import { lazy, Suspense, useEffect, useRef, useState } from "react";
import { loadDataStatus } from "../api";
import { dateCompact } from "../format";
import { useLoad } from "../hooks/useLoad";
import { LANG, setLanguage, t, tx, type Language } from "../i18n";
import { ABOUT, followLegacyHash, OVERVIEW, overviewHref, pageOf, parseHash, trendsHref, TRENDS, type Page } from "../url-state";
import { arrival, returnFocus, type Arrival } from "../focus";
import { TITLE, useDocumentTitle } from "../title";
import { DataStatusBanner } from "./DataStatusBanner";
import { ErrorBoundary } from "./ErrorBoundary";
import { LoadFailed } from "./LoadState";
import "./page-shell.css";

// The explorer is a chunk of its own too: its map, search and stylesheets never block the reading pages.
const ExplorerView = lazy(() => import("../views/ExplorerView").then((module) => ({ default: module.ExplorerView })));
const TimeView = lazy(() => import("../views/TimeView").then((module) => ({ default: module.TimeView })));
const MarketView = lazy(() => import("../views/MarketView").then((module) => ({ default: module.MarketView })));
const QualityView = lazy(() => import("../views/QualityView").then((module) => ({ default: module.QualityView })));
const OverviewView = lazy(() => import("../views/OverviewView").then((module) => ({ default: module.OverviewView })));

/** The product name is the same in both languages. */
export const BRAND = "Slovenian Real Estate Observer"; // i18n-ignore (brand)

/** Each language is offered under its own name (an endonym, the same in both interfaces, like a proper name). */
const LANGUAGES: Array<{ id: Language; code: string; name: string }> = [
  { id: "sl", code: "SL", name: "Slovenščina" }, // i18n-ignore (endonym)
  { id: "en", code: "EN", name: "English" },
];

/**
 * Compact SL | EN switch; switching reloads the page in place (same path and hash). setLanguage() replaces the URL
 * without ?lang; when there was no ?lang that is the same URL, which with a hash is only a fragment jump, so reload.
 */
function switchLanguage(language: Language) {
  const hadParameter = new URLSearchParams(window.location.search).has("lang");
  setLanguage(language);
  if (!hadParameter && window.location.hash) window.location.reload();
}

function LanguageSwitch() {
  return <div className="language-switch" role="group" aria-label={t("Jezik")}>
    {LANGUAGES.map((language) => <button key={language.id} type="button" lang={language.id} title={language.name}
      aria-pressed={LANG === language.id} onClick={() => { if (LANG !== language.id) switchLanguage(language.id); }}>{language.code}</button>)}
  </div>;
}

/** A reading page while its data or code loads: as tall as the screen, so the footer never jumps up under the masthead. */
const loading = <div className="page-loading" aria-busy="true"><p className="note muted" role="status">{t("Nalagam\u00a0…")}</p></div>;
/** The explorer while the data status loads: its final layout (bar, panel, map) from the first paint. */
const explorerLoading = <div className="explorer explorer-placeholder" aria-busy="true">
  <div className="explorer-bar"/>
  <div className="explorer-body"><div className="explorer-panel"><p className="note muted" role="status">{t("Nalagam\u00a0…")}</p></div><div className="explorer-map-wrap"/></div>
</div>;

/** The document title of each page; the explorer offers its own (area, building, sale, value check) on top. */
function pageTitle(page: Page): string {
  switch (page) {
    case TRENDS: return t("Trendi · SREO");
    case ABOUT: return t("O podatkih · SREO");
    case OVERVIEW: return t("Pregled trga · SREO");
    case "explorer": return t("Trg po območjih · SREO");
  }
}

export function App() {
  // main.tsx rewrites an old link before the first render; a link typed later is rewritten on the change.
  const [page, setPage] = useState<Page>(() => pageOf());
  const status = useLoad("data-status", (signal) => loadDataStatus(signal));
  const cutoff = status.data?.activeRelease?.analyticsSaleThrough?.slice(0, 10);
  // "Trg po območjih" returns to the area last looked at (not to Slovenija) after Trendi or O podatkih: the explorer's
  // address is remembered when the reader leaves it (oldURL includes the explorer's own pushState navigations).
  const [lastArea, setLastArea] = useState(() => pageOf() === "explorer" && window.location.hash ? window.location.hash : "#");
  const [trendPart, setTrendPart] = useState<"time" | "distribution">("time");
  useDocumentTitle(pageTitle(page), TITLE.page);
  /** How the reader reached the current page (a link, Back, Forward), for where focus goes. */
  const how = useRef<Arrival>("same");
  useEffect(() => {
    const change = (event: Event) => {
      if (event instanceof HashChangeEvent && pageOf(event.oldURL) === "explorer" && pageOf(event.newURL) !== "explorer") setLastArea(new URL(event.oldURL).hash || "#");
      followLegacyHash();
      how.current = arrival();
      setPage(pageOf());
    };
    window.addEventListener("hashchange", change);
    window.addEventListener("popstate", change);
    return () => { window.removeEventListener("hashchange", change); window.removeEventListener("popstate", change); };
  }, []);

  // Another page (the masthead tabs, a link, Back): focus moves to its heading, or back to the control that left it.
  const shown = useRef(page);
  useEffect(() => {
    if (shown.current === page) return;
    shown.current = page;
    return returnFocus(document.getElementById("main"), how.current === "same" ? "new" : how.current);
  }, [page]);

  const trendTabs = <div className="part-tabs" role="group" aria-label={t("Del strani")}>
    <button type="button" aria-pressed={trendPart === "time"} onClick={() => setTrendPart("time")}>{t("Cene skozi čas")}</button>
    <button type="button" aria-pressed={trendPart === "distribution"} onClick={() => setTrendPart("distribution")}>{t("Porazdelitev in skrajni posli")}</button>
  </div>;

  // Every page's figures hang on the data's cutoff: until it is known nothing is asked for (no second round of
  // requests once it arrives), and when it cannot be loaded the page says so once, with a retry, instead of waiting forever.
  const content = status.error ? <LoadFailed retry={status.retry}>{t("Stanja podatkov trenutno ni bilo mogoče naložiti (povezava ali strežnik).")}</LoadFailed> // i18n-ignore (code, not text)
    : !status.data ? (page === "explorer" ? explorerLoading : loading)
    : !cutoff ? <p className="note muted" role="status">{t("Podatki še niso objavljeni. Analitika GURS ETN se pripravlja.")}</p>
    : <ErrorBoundary name={`page ${page}`} resetKey={page}><Suspense fallback={page === "explorer" ? explorerLoading : loading}>
      {page === "explorer" && <ExplorerView cutoff={cutoff}/>}
      {page === TRENDS && <div className="view">
        {/* The page's one h1 comes first; the part tabs sit in the shown part's control row, the visible titles of the parts are h2. */}
        <h1 className="stage-title">{t("Trendi")}</h1>
        {/* The part's own boundary: the switch stays while a part's chunk loads. */}
        <Suspense fallback={loading}>{trendPart === "time" ? <TimeView cutoff={cutoff} tabs={trendTabs}/> : <MarketView cutoff={cutoff} tabs={trendTabs}/>}</Suspense>
      </div>}
      {page === OVERVIEW && <OverviewView cutoff={cutoff}/>}
      {page === ABOUT && <QualityView cutoff={cutoff}/>}
    </Suspense></ErrorBoundary>;

  return <div className={page === "explorer" ? "observer full" : "observer"}>
    <a className="skip" href="#main" onClick={(event) => { event.preventDefault(); document.getElementById("main")?.focus(); }}>{t("Na vsebino")}</a>
    {/* One row: wordmark (with the tagline under it on wide screens), the page tabs and the language switch. */}
    <header className="masthead">
      <div className="brand">
        <a className="wordmark" href="#"><span>SREO</span><strong>{BRAND}</strong></a>
        <p className="tagline">{t("Dejansko sklenjeni nepremičninski posli v Sloveniji")}</p>
      </div>
      <nav className="views" aria-label={t("Strani")}>
        <a href={lastArea} aria-current={page === "explorer" ? "page" : undefined}
          onClick={(event) => { if (pageOf() === "explorer") event.preventDefault(); }}>{t("Trg po območjih")}</a>
        <a href={`#${OVERVIEW}`} aria-current={page === OVERVIEW ? "page" : undefined}
          onClick={(event) => { if (page === OVERVIEW) { event.preventDefault(); return; } const { g, group } = parseHash(); if (g || group === "house") { event.preventDefault(); window.location.hash = overviewHref(g, group === "house"); } }}>{t("Pregled trga")}</a>
        <a href={`#${TRENDS}`} aria-current={page === TRENDS ? "page" : undefined}
          onClick={(event) => { const { g } = parseHash(); if (g) { event.preventDefault(); window.location.hash = trendsHref(g); } }}>{t("Trendi")}</a>
        <a href={`#${ABOUT}`} aria-current={page === ABOUT ? "page" : undefined}>{t("O podatkih")}</a>
      </nav>
      <LanguageSwitch/>
    </header>
    <DataStatusBanner status={status.data}/>

    <main id="main" className="page-main" tabIndex={-1}>{content}</main>

    {/* The sources are named once per page, in this one line; the full list with each licence is on O podatkih. */}
    <footer className={page === "explorer" ? "colophon compact" : "colophon"}>
      <p>{tx("Vir: GURS ETN, SURS, Banka Slovenije, DRSV, MOPE ({licence})", { licence: <abbr title={t("Creative Commons Priznanje avtorstva 4.0")}>CC BY 4.0</abbr> })}
        {cutoff && <> · {t("podatki do {date}", { date: dateCompact(cutoff) })}</>}
        {" "}· <a href={`#${ABOUT}`}>{t("Metodologija in viri")}</a></p>
    </footer>
  </div>;
}
