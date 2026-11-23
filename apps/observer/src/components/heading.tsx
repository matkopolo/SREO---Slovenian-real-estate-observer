import { createContext, createElement, useContext, type ReactNode } from "react";

/**
 * The heading level of a transaction's sections: h2 on a sale page (its title is the page's h1), h3 where the
 * transaction sits under another heading. Sub-headings take the next level, so the outline never skips one.
 */
export const SectionLevel = createContext<2 | 3>(3);

/** A section heading at the level of its context (`sub`: one below it). */
export function SectionHeading({ id, className, sub = false, children }: { id?: string; className?: string; sub?: boolean; children: ReactNode }) {
  const level = useContext(SectionLevel) + (sub ? 1 : 0);
  return createElement(`h${level}`, { id, className }, children);
}
