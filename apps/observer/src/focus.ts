/**
 * Focus and history after in-app navigation (WCAG 2.4.3). A navigation that opens a new view moves focus to the view's
 * <h1> once it has rendered; Back and Forward return focus to the link or button that opened the view the reader comes
 * back to (else its <h1>). Which way the reader went is kept in history.state, so a link click (a new entry) and Back
 * (an earlier entry) can be told apart.
 */

/** Enough to find the element that opened a view again after the view was re-rendered. */
export interface Opener { tag: string; text: string; href?: string; id?: string }

/** The control that is about to navigate (the focused link or button), described so it can be found again. */
export function openerOf(element: Element | null): Opener | null {
  if (!(element instanceof HTMLElement) || element === document.body || element.id === "main") return null;
  const control = element.closest<HTMLElement>("a, button") ?? element;
  return { tag: control.tagName.toLowerCase(), text: (control.textContent ?? "").trim(), href: control.getAttribute("href") ?? undefined, id: control.id || undefined };
}

/** The opener inside `root`, if it is there again (same id, or same tag, address and text). */
export function findOpener(root: ParentNode, opener: Opener): HTMLElement | null {
  if (opener.id) {
    const byId = document.getElementById(opener.id);
    if (byId && (root === document || (root as Node).contains(byId))) return byId;
  }
  for (const element of root.querySelectorAll<HTMLElement>(opener.tag)) {
    if (opener.href != null && element.getAttribute("href") !== opener.href) continue;
    if ((element.textContent ?? "").trim() === opener.text) return element;
  }
  return null;
}

/** The view's heading once it is settled: the first <h1> that is not inside a region still loading (aria-busy). */
export function viewHeading(root: ParentNode): HTMLElement | null {
  for (const heading of root.querySelectorAll<HTMLElement>("h1")) if (!heading.closest('[aria-busy="true"]')) return heading;
  return null;
}

const NATIVELY_FOCUSABLE = /^(?:a|button|input|select|textarea|summary)$/i;

/**
 * Focus an element without scrolling to it and without a keyboard focus ring (a heading or a section reached by a
 * script is not a control). Elements that are not focusable get tabindex="-1" first.
 */
export function focusQuietly(element: HTMLElement) {
  if (!element.hasAttribute("tabindex") && !NATIVELY_FOCUSABLE.test(element.tagName)) element.setAttribute("tabindex", "-1");
  element.focus({ preventScroll: true, focusVisible: false } as FocusOptions);
}

/** An in-page jump ("Prodaje", "Podrobnosti ↓"): scroll the target into view and move focus to it. */
export function jumpTo(target: HTMLElement | null, smooth = false) {
  if (!target) return;
  target.scrollIntoView({ block: "start", behavior: smooth ? "smooth" : "auto" });
  focusQuietly(target);
}

/**
 * Focus what `find` returns as soon as it exists (content loads in steps), unless the reader has moved focus elsewhere
 * in the meantime. Returns the cleanup.
 */
export function focusWhenReady(root: Element | null | undefined, find: () => HTMLElement | null, timeout = 4000): () => void {
  if (!root) return () => undefined;
  const started = document.activeElement;
  let done = false;
  const moved = () => { const active = document.activeElement; return active != null && active !== started && active !== document.body && !(active instanceof HTMLElement && active.id === "main"); };
  const attempt = () => {
    if (done) return true;
    if (moved()) return (done = true);
    const target = find();
    if (!target) return false;
    focusQuietly(target);
    return (done = true);
  };
  if (attempt()) return () => undefined;
  if (typeof MutationObserver === "undefined") return () => undefined;
  const observer = new MutationObserver(() => { if (attempt()) stop(); });
  // Some waits end without a DOM change (a preferred target given up on after a while): look again now and then.
  const poll = setInterval(() => { if (attempt()) stop(); }, 250);
  const timer = setTimeout(() => stop(), timeout);
  function stop() { done = true; observer.disconnect(); clearInterval(poll); clearTimeout(timer); }
  observer.observe(root, { childList: true, subtree: true, attributes: true, attributeFilter: ["aria-busy"] });
  return stop;
}

// ------------------------------------------------------------------ history direction

/** Index of the current entry in this tab's history, kept in history.state (other state keys are preserved). */
const indexOf = (state: unknown): number | undefined => {
  const value = (state as { sreo?: unknown } | null)?.sreo;
  return typeof value === "number" ? value : undefined;
};
let current = typeof window === "undefined" ? 0 : indexOf(window.history.state) ?? 0;
let lastHref = typeof window === "undefined" ? "" : window.location.href;
let lastHash = typeof window === "undefined" ? "" : window.location.hash || "#";
let lastArrival: Arrival = "same";
/** The control that left each address, for Back. */
const openers = new Map<string, Opener>();

export type Arrival = "new" | "back" | "forward" | "same";

/** A navigation inside the app: a new history entry (or the same one replaced), with its index. */
export function pushAddress(hash: string, replace = false) {
  if (!replace) {
    remember(window.location.hash || "#");
    current += 1;
  }
  window.history[replace ? "replaceState" : "pushState"]({ ...(window.history.state ?? {}), sreo: current }, "", hash);
  lastHref = window.location.href;
  lastHash = window.location.hash || "#";
  lastArrival = "same";
}

/** Remember the control that is leaving `hash` (the focused element), so Back can return to it. */
export function remember(hash: string) {
  const opener = openerOf(document.activeElement);
  if (opener) openers.set(hash, opener); else openers.delete(hash);
}

/**
 * Called from popstate and hashchange: which way the reader went (a link click is a new entry, Back an earlier one).
 * Both events fire for one navigation; the second call returns the first answer.
 */
export function arrival(): Arrival {
  if (window.location.href === lastHref) return lastArrival;
  const index = indexOf(window.history.state);
  remember(lastHash);
  let result: Arrival;
  if (index == null) {
    // A link or a typed address: a new entry after the current one.
    current += 1;
    window.history.replaceState({ ...(window.history.state ?? {}), sreo: current }, "", window.location.href);
    result = "new";
  } else {
    result = index < current ? "back" : index > current ? "forward" : "same";
    current = index;
  }
  lastHref = window.location.href;
  lastHash = window.location.hash || "#";
  lastArrival = result;
  return result;
}

/** The control that opened the view at `hash` before the reader left it, if any. */
export const openerFor = (hash: string): Opener | undefined => openers.get(hash || "#");

/** How long Back waits for the opener to render again before it settles for the view's heading. */
const OPENER_WAIT_MS = 1500;

/**
 * After Back or Forward: the opener of the view at the current address when it is there again (it may render after the
 * heading, so it gets a head start), else the view's heading. After a new navigation: the heading.
 */
export function returnFocus(root: Element | null, how: Arrival, hash: string = window.location.hash || "#"): () => void {
  if (!root || how === "same") return () => undefined;
  const opener = how === "back" || how === "forward" ? openerFor(hash) : undefined;
  const deadline = Date.now() + OPENER_WAIT_MS;
  return focusWhenReady(root, () => (opener && findOpener(document, opener)) || (!opener || Date.now() > deadline ? viewHeading(root) : null));
}

/** Tests: forget the history bookkeeping. */
export function resetNavigation() {
  current = indexOf(window.history.state) ?? 0;
  lastHref = window.location.href;
  lastHash = window.location.hash || "#";
  lastArrival = "same";
  openers.clear();
}
