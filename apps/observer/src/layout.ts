/**
 * Layout breakpoints the code shares with the stylesheets (styles.css, components/*.css use the same numbers).
 * Below PHONE the explorer stacks: the page scrolls, not the panel, and the map comes first.
 */
export const PHONE_QUERY = "(max-width: 900px)";
export const COARSE_POINTER_QUERY = "(pointer: coarse)";
const REDUCED_MOTION_QUERY = "(prefers-reduced-motion: reduce)";

const matches = (query: string): boolean => window.matchMedia?.(query).matches ?? false;
export const isPhone = (): boolean => matches(PHONE_QUERY);
export const hasCoarsePointer = (): boolean => matches(COARSE_POINTER_QUERY);
export const prefersReducedMotion = (): boolean => matches(REDUCED_MOTION_QUERY);
