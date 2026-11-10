import { lazy, Suspense, useEffect, useState } from "react";
import { loadDataStatus } from "../api";
import { dateCompact } from "../format";
import { useLoad } from "../hooks/useLoad";
import { LANG, setLanguage, t, tx, type Language } from "../i18n";
import { ABOUT, OVERVIEW, overviewHref, pageOf, parseHash, translateLegacyHash, trendsHref, TRENDS, type Page } from "../url-state";
import { ExplorerView } from "../views/ExplorerView";
import { DataStatusBanner } from "./DataStatusBanner";
import { ErrorBoundary } from "./ErrorBoundary";

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

/** Old links (`#pregled?g=133`) are rewritten in place to the explorer's address. */
function followLegacyHash() {
  const legacy = translateLegacyHash(window.location.hash);
  if (legacy) window.history.replaceState(null, "", legacy);
}

export function App() {
  const [page, setPage] = useState<Page>(() => { followLegacyHash(); return pageOf(); });
  const dataStatus = useLoad("data-status", (signal) => loadDataStatus(signal)).data;
  const cutoff = dataStatus?.activeRelease?.analyticsSaleThrough?.slice(0, 10);
  // "Trg po območjih" returns to the area last looked at (not to Slovenija) after Trendi or O podatkih: the explorer's
  // address is remembered when the reader leaves it (oldURL includes the explorer's own pushState navigations).
  const [lastArea, setLastArea] = useState(() => pageOf() === "explorer" && window.location.hash ? window.location.hash : "#");
  const [trendPart, setTrendPart] = useState<"time" | "distribution">("time");
  useEffect(() => {
    const change = (event: Event) => {
      if (event instanceof HashChangeEvent && pageOf(event.oldURL) === "explorer" && pageOf(event.newURL) !== "explorer") setLastArea(new URL(event.oldURL).hash || "#");
      followLegacyHash();
      setPage(pageOf());
    };
    window.addEventListener("hashchange", change);
    window.addEventListener("popstate", change);
    return () => { window.removeEventListener("hashchange", change); window.removeEventListener("popstate", change); };
  }, []);

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
    <DataStatusBanner status={dataStatus}/>

    <main id="main" tabIndex={-1}>
      <ErrorBoundary name={`page ${page}`} resetKey={page}><Suspense fallback={<p className="muted" role="status">{t("Nalagam …")}</p>}>
        {page === "explorer" && <ExplorerView cutoff={cutoff}/>}
        {page === TRENDS && <div className="view">
          <div className="segmented" role="group" aria-label={t("Del strani")}>
            <button type="button" aria-pressed={trendPart === "time"} onClick={() => setTrendPart("time")}>{t("Cene skozi čas")}</button>
            <button type="button" aria-pressed={trendPart === "distribution"} onClick={() => setTrendPart("distribution")}>{t("Porazdelitev in skrajni posli")}</button>
          </div>
          {trendPart === "time" ? <TimeView cutoff={cutoff}/> : <MarketView cutoff={cutoff}/>}
        </div>}
        {page === OVERVIEW && <OverviewView cutoff={cutoff}/>}
        {page === ABOUT && <QualityView cutoff={cutoff}/>}
      </Suspense></ErrorBoundary>
    </main>

    {/* The attribution (GURS ETN, CC BY 4.0) and the data date stay visible on every page; the reading pages list every source. */}
    <footer className={page === "explorer" ? "colophon compact" : "colophon"}>
      {page !== "explorer" && <p>{t("Vir: Geodetska uprava RS (GURS), Evidenca trga nepremičnin, Register prostorskih enot in Kataster nepremičnin (CC BY 4.0); SURS; Banka Slovenije; ECB; zemljevid OpenFreeMap in sodelavci OpenStreetMap.")}
        {" "}{t("Podatki so obdelani.")} {t("Prikaz je informativen in ni uradna cenitev ali ponudba kredita.")}</p>}
      <p>{tx("Vir GURS ETN, {licence}, obdelano", { licence: <abbr title={t("Creative Commons Priznanje avtorstva 4.0")}>CC BY 4.0</abbr> })}
        {cutoff && <> · {t("podatki do {date}", { date: dateCompact(cutoff) })}</>}
        {" "}· <a href={`#${ABOUT}`}>{t("Metodologija in viri")}</a></p>
    </footer>
  </div>;
}
