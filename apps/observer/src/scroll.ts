/**
 * Content loads in steps, so a scroll position or a focused step is applied again whenever the element grows, until
 * `apply` reports success or `timeout` passes (instead of a ladder of timers). Returns the cleanup.
 */
export function whileLayoutSettles(target: Element | null | undefined, apply: () => boolean, timeout = 2000) {
  if (!target || apply()) return () => undefined;
  if (typeof ResizeObserver === "undefined") return () => undefined;
  const observer = new ResizeObserver(() => { if (apply()) stop(); });
  // A scrolling box keeps its size while its content grows: watch the children too, including children that replace
  // the first ones (a loading line swapped for the loaded panel).
  const watch = () => { for (const element of [target, ...Array.from(target.children)]) observer.observe(element); };
  const mutations = typeof MutationObserver === "undefined" ? undefined : new MutationObserver(() => { watch(); if (apply()) stop(); });
  const timer = setTimeout(() => stop(), timeout);
  function stop() { observer.disconnect(); mutations?.disconnect(); clearTimeout(timer); }
  watch();
  mutations?.observe(target, { childList: true, subtree: true });
  return stop;
}
