import { useEffect, useRef } from "react";
import { t } from "./i18n";

/**
 * The document title follows the view (WCAG 2.4.2), so a tab, a bookmark, the history list and a shared link name what
 * the reader sees. Nested views offer titles with a priority (page < area < building < sale or value check); the most
 * specific one that is mounted wins, whatever order the effects run in.
 */
const offered = new Map<symbol, { title: string; priority: number; order: number }>();
let order = 0;

function apply() {
  let best: { title: string; priority: number; order: number } | undefined;
  for (const entry of offered.values()) if (!best || entry.priority > best.priority || (entry.priority === best.priority && entry.order > best.order)) best = entry;
  if (best && document.title !== best.title) document.title = best.title;
}

/** Offer `title` while the component is mounted (null: offer nothing). */
export function useDocumentTitle(title: string | null | undefined, priority = 0) {
  const id = useRef<symbol>(undefined);
  if (!id.current) id.current = Symbol("title");
  useEffect(() => {
    const key = id.current!;
    if (title) offered.set(key, { title, priority, order: (order += 1) }); else offered.delete(key);
    apply();
    return () => { offered.delete(key); apply(); };
  }, [title, priority]);
}

/** Title priorities: the page, an area, a building, a single sale or rental and the value check. */
export const TITLE = { page: 0, area: 1, building: 2, detail: 3 } as const;

/** "Ljubljana · Trg po območjih · SREO" */
export const areaTitle = (area: string): string => t("{area} · Trg po območjih · SREO", { area });
/** "Dunajska cesta 221 · SREO" */
export const viewTitle = (title: string): string => t("{title} · SREO", { title });
