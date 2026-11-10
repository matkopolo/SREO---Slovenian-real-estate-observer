/**
 * Content loads in steps, so a scroll position or a focused step is applied again whenever the element grows, until
 * `apply` reports success or `timeout` passes (instead of a ladder of timers). Returns the cleanup.
 */
export function whileLayoutSettles(target: Element | null | undefined, apply: () => boolean, timeout = 2000) {
  if (!target || apply()) return () => undefined;
  if (typeof ResizeObserver === "undefined") return () => undefined;
  const observer = new ResizeObserver(() => { if (apply()) stop(); });
  const timer = setTimeout(() => stop(), timeout);
  function stop() { observer.disconnect(); clearTimeout(timer); }
  // A scrolling box keeps its size while its content grows: watch the children too.
  for (const element of [target, ...Array.from(target.children)]) observer.observe(element);
  return stop;
}
