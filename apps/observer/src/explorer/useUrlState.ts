import { useCallback, useEffect, useRef, useState, type RefObject } from "react";
import { isPhone } from "../layout";
import { parseHash, toHash, type ExplorerState } from "../url-state";
import { whileLayoutSettles } from "../scroll";
import { arrival, pushAddress, returnFocus, type Arrival } from "../focus";

export type Navigate = (patch: Partial<ExplorerState>, replace?: boolean) => void;

/** On a phone the page scrolls; on a wide screen the panel does. */
const scroller = (panel: RefObject<HTMLElement | null>) => isPhone() ? null : panel.current;

/** The parts of the state that make a different view (a new heading): area, street, building, transaction, value check. */
const viewOf = (state: ExplorerState) => [state.g ?? 0, state.street ?? "", state.building ? `${state.building.ko}-${state.building.st}` : "",
  state.selected ? `${state.selected.kind}${state.selected.id}` : "", state.value ? 1 : 0].join("|");

/**
 * The explorer state in the address bar. Every navigation is a history entry (or replaces the current one);
 * Back/Forward and edited URLs restore the state. Going back returns to where the reader was in the panel (its scroll
 * position, followed continuously, so links that change the address themselves are covered too) and to the control
 * that opened the view; a new view moves focus to its heading.
 */
export function useUrlState(panel: RefObject<HTMLElement | null>) {
  const [state, setState] = useState<ExplorerState>(() => parseHash());
  const current = useRef(state);
  const scrollMemory = useRef(new Map<string, number>());
  /** How the current state was reached; only a pushed navigation or Back/Forward move focus (never a replace or the first load). */
  const how = useRef<Arrival | "push" | "replace" | "load">("load");
  /** While a remembered position is being restored, the scroll events of the growing content are not remembered. */
  const restoring = useRef(false);

  // An invalid or unknown hash part (obdobje=7, od>do, raba for flats, 3d=1 of an old link) is dropped from the address bar.
  useEffect(() => {
    const clean = toHash(parseHash());
    if (clean !== window.location.hash && (window.location.hash || clean !== "#")) pushAddress(clean, true);
  }, []);

  useEffect(() => {
    const follow = () => {
      const way = arrival();
      const next = parseHash();
      if (toHash(next) === toHash(current.current)) return;
      how.current = way;
      restoring.current = how.current === "back" || how.current === "forward";
      current.current = next;
      setState(next);
    };
    window.addEventListener("popstate", follow);
    window.addEventListener("hashchange", follow);
    return () => { window.removeEventListener("popstate", follow); window.removeEventListener("hashchange", follow); };
  }, []);

  // Where the reader is, per address: remembered on every scroll (rAF-throttled), so Back finds it whichever way they left.
  useEffect(() => {
    let frame = 0;
    const box = () => scroller(panel);
    const record = () => {
      frame = 0;
      if (restoring.current) return;
      const element = box();
      scrollMemory.current.set(window.location.hash || "#", element ? element.scrollTop : window.scrollY);
    };
    const onScroll = () => { if (!frame) frame = requestAnimationFrame(record); };
    const element = panel.current;
    element?.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => { element?.removeEventListener("scroll", onScroll); window.removeEventListener("scroll", onScroll); if (frame) cancelAnimationFrame(frame); };
  }, [panel]);

  const navigate = useCallback<Navigate>((patch, replace = false) => {
    // Where the reader was in this entry, for Back; a replaced entry (a toggle on the same view) is not a place to return to.
    if (!replace) { const box = scroller(panel); scrollMemory.current.set(window.location.hash || "#", box ? box.scrollTop : window.scrollY); }
    const previous = current.current;
    const next = { ...previous, ...patch };
    // A street filter belongs to its area: another area drops it.
    if ("g" in patch && patch.g !== previous.g && !("street" in patch)) next.street = undefined;
    const hash = toHash(next);
    if (hash !== window.location.hash) pushAddress(hash, replace);
    how.current = replace ? "replace" : "push";
    restoring.current = false;
    current.current = next;
    setState(next);
  }, [panel]);

  const hash = toHash(state);
  const view = viewOf(state);
  const detail = !!(state.building || state.selected || state.value);

  // Back to an area: restore the panel's scroll once its content is tall enough (it loads in steps). The reader's own
  // scrolling, wheel, touch or keys end the restoring.
  useEffect(() => {
    if (!restoring.current) return;
    const saved = scrollMemory.current.get(hash);
    if (saved == null || detail) { restoring.current = false; return; }
    const box = scroller(panel);
    const restore = () => {
      if (box) { if (box.scrollHeight - box.clientHeight < saved) return false; box.scrollTop = saved; }
      else { if (document.documentElement.scrollHeight - window.innerHeight < saved) return false; window.scrollTo(0, saved); }
      restoring.current = false;
      return true;
    };
    const stopRestoring = () => { restoring.current = false; cancel(); };
    const events = ["wheel", "touchstart", "keydown", "pointerdown"] as const;
    for (const name of events) window.addEventListener(name, stopRestoring, { passive: true, once: true });
    const stop = whileLayoutSettles(box ?? document.body, restore, 5000);
    function cancel() { stop(); for (const name of events) window.removeEventListener(name, stopRestoring); }
    return () => { cancel(); restoring.current = false; };
  }, [detail, hash, panel]);

  // A new view (area, street, building, transaction, value check): focus its heading once it has rendered; after
  // Back/Forward, the control that opened the view the reader returns to. Never on the first load or a replace.
  const shownView = useRef(view);
  useEffect(() => {
    if (shownView.current === view) return;
    shownView.current = view;
    const way = how.current;
    if (way === "load" || way === "replace" || way === "same") return;
    return returnFocus(panel.current, way === "push" ? "new" : way);
  }, [panel, view]);

  return { state, navigate };
}
