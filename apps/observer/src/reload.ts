/** A lazy chunk that no longer exists: the tab still runs the previous deploy's index.html. */
export function isChunkLoadError(error: unknown) {
  const { name = "", message = "" } = (error ?? {}) as { name?: string; message?: string };
  return name === "ChunkLoadError" || /dynamically imported module|Importing a module script failed|error loading dynamically imported module|Unable to preload CSS/i.test(message);
}

const RELOADED = "sreo-chunk-reload"; // i18n-ignore (storage key)
/**
 * After a deploy, reload once to fetch the new index.html; a second failure within a minute shows the reload button
 * instead (so a broken deploy never loops). Returns whether a reload was started.
 */
export function reloadOnce() {
  try {
    const last = Number(window.sessionStorage.getItem(RELOADED) ?? 0);
    if (Date.now() - last < 60_000) return false;
    window.sessionStorage.setItem(RELOADED, String(Date.now()));
  } catch { return false; /* storage blocked: let the reader reload */ }
  window.location.reload();
  return true;
}
