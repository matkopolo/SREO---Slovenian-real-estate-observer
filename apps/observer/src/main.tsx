import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { LANG, loadEnglish, t } from "./i18n";
import { isChunkLoadError, reloadOnce } from "./reload";
import "./styles.css";

/**
 * Start-up: the English dictionary (English readers only) must be in place before the app's modules load, because
 * they translate labels at import time. A stale chunk after a deploy reloads the page once.
 */
async function start() {
  // Vite reports a failed preload of a lazy chunk here (the tab still runs the previous deploy).
  window.addEventListener("vite:preloadError", (event) => { if (reloadOnce()) event.preventDefault(); });
  try {
    if (LANG === "en") await loadEnglish();
    const { App, BRAND } = await import("./components/App");
    // index.html carries the Slovenian title and description; the chosen language replaces them at startup.
    document.title = `${BRAND} (SREO)`;
    document.querySelector('meta[name="description"]')?.setAttribute("content",
      t("{brand}: dejansko sklenjeni nepremičninski posli, cene, najemnine in dostopnost v Sloveniji (GURS ETN).", { brand: BRAND }));
    createRoot(document.getElementById("root")!).render(<StrictMode><App /></StrictMode>);
  } catch (error) {
    console.error("[SREO] start-up failed", error); // i18n-ignore (console log, not shown)
    if (isChunkLoadError(error) && reloadOnce()) return;
    const root = document.getElementById("root");
    if (root) root.textContent = t("Strani ni bilo mogoče naložiti. Osvežite jo.");
  }
}

void start();
