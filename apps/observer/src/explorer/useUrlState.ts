import { useCallback, useEffect, useRef, useState, type RefObject } from "react";
import { parseHash, toHash, type ExplorerState } from "../url-state";
import { whileLayoutSettles } from "../scroll";

export type Navigate = (patch: Partial<ExplorerState>, replace?: boolean) => void;

/** On a phone the page scrolls; on a wide screen the panel does. */
const scroller = (panel: RefObject<HTMLElement | null>) => window.matchMedia?.("(max-width: 900px)").matches ? null : panel.current;

/**
 * The explorer state in the address bar. Every navigation is a history entry (or replaces the current one);
 * Back/Forward and edited URLs restore the state, and going back to an area returns to where the reader was in the panel.
 */
export function useUrlState(panel: RefObject<HTMLElement | null>) {
  const [state, setState] = useState<ExplorerState>(parseHash);
  const current = useRef(state);
  const scrollMemory = useRef(new Map<string, number>());

  // An invalid or unknown hash part (obdobje=7, od>do, raba for flats, 3d=1 of an old link) is dropped from the address bar.
  useEffect(() => {
    const clean = toHash(parseHash());
    if (clean !== window.location.hash && (window.location.hash || clean !== "#")) window.history.replaceState(null, "", clean);
  }, []);

  useEffect(() => {
    const follow = () => { current.current = parseHash(); setState(current.current); };
    window.addEventListener("popstate", follow);
    window.addEventListener("hashchange", follow);
    return () => { window.removeEventListener("popstate", follow); window.removeEventListener("hashchange", follow); };
  }, []);

  const navigate = useCallback<Navigate>((patch, replace = false) => {
    const box = scroller(panel);
    scrollMemory.current.set(window.location.hash || "#", box ? box.scrollTop : window.scrollY);
    const previous = current.current;
    const next = { ...previous, ...patch };
    // A street filter belongs to its area: another area drops it.
    if ("g" in patch && patch.g !== previous.g && !("street" in patch)) next.street = undefined;
    const hash = toHash(next);
    if (hash !== window.location.hash) window.history[replace ? "replaceState" : "pushState"](null, "", hash);
    current.current = next;
    setState(next);
  }, [panel]);

  // Back to an area: restore the panel's scroll once its content is tall enough (it loads in steps).
  const hash = toHash(state);
  const detail = !!(state.building || state.selected || state.value);
  useEffect(() => {
    const saved = scrollMemory.current.get(hash);
    if (saved == null || detail) return;
    const box = scroller(panel);
    const restore = () => {
      if (box) { if (box.scrollHeight - box.clientHeight < saved) return false; box.scrollTop = saved; return true; }
      if (document.documentElement.scrollHeight - window.innerHeight < saved) return false;
      window.scrollTo(0, saved);
      return true;
    };
    return whileLayoutSettles(box ?? document.body, restore);
  }, [detail, hash, panel]);

  return { state, navigate };
}
