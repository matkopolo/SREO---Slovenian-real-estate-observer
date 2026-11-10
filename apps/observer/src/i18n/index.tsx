import { Fragment, createElement, type ReactNode } from "react";

/**
 * Interface language. Slovenian is the source language: every visible text is written in Slovenian in the code
 * and wrapped in t()/tx(); the English dictionary (src/i18n/en/*.ts) maps each Slovenian template to English.
 * The language is chosen once per page load (?lang=en in the URL, else the saved choice, else Slovenian),
 * so module-level formatters can use LOCALE directly; switching reloads the page.
 */
export type Language = "sl" | "en";
const STORE = "sreo-language";

function initialLanguage(): Language {
  if (typeof window === "undefined") return "sl";
  try {
    const fromUrl = new URLSearchParams(window.location.search).get("lang");
    if (fromUrl === "en" || fromUrl === "sl") { window.localStorage.setItem(STORE, fromUrl); return fromUrl; }
    const saved = window.localStorage.getItem(STORE);
    if (saved === "en" || saved === "sl") return saved;
  } catch { /* storage blocked: Slovenian */ }
  return "sl";
}

export const LANG: Language = initialLanguage();
/** BCP 47 locale for Intl number/date formatting. */
export const LOCALE = LANG === "en" ? "en-GB" : "sl-SI";
if (typeof document !== "undefined") document.documentElement.lang = LANG;

export function setLanguage(language: Language) {
  try { window.localStorage.setItem(STORE, language); } catch { /* ignore */ }
  const url = new URL(window.location.href);
  url.searchParams.delete("lang");
  // Same address (only the saved choice changed): replace() would just jump within the page, so reload.
  if (url.toString() === window.location.href) window.location.reload();
  else window.location.replace(url.toString());
}

/**
 * The English dictionary is a separate chunk: Slovenian readers never download it. main.tsx loads it before any module
 * that calls t() at load time is imported.
 */
let EN: Record<string, string> = {};
export async function loadEnglish() { EN = (await import("./en")).EN; }

/** Missing translations are collected (tests read them) and reported once in the console. */
export const missing = new Set<string>();

function lookup(text: string): string {
  if (LANG === "sl") return text;
  const english = EN[text];
  if (english == null) {
    if (!missing.has(text)) { missing.add(text); console.error(`[i18n] missing English for: ${JSON.stringify(text)}`); }
    return text;
  }
  return english;
}

type Vars = Record<string, string | number | null | undefined>;

/**
 * Translate a Slovenian template; `{name}` placeholders are filled from vars after translation,
 * so the English template may put them in a different order.
 *   t("Mediana cene {noun} v {period}", { noun: noun.genitive, period })
 */
export function t(text: string, vars?: Vars): string {
  const template = lookup(text);
  return vars ? template.replace(/\{(\w+)\}/g, (match, key: string) => (key in vars ? String(vars[key] ?? "") : match)) : template;
}

/** Like t(), but placeholders may be React nodes (links, <strong>, <Term>): returns a fragment. */
export function tx(text: string, vars: Record<string, ReactNode>): ReactNode {
  const template = lookup(text);
  const parts = template.split(/(\{\w+\})/g);
  return createElement(Fragment, null, ...parts.map((part, index) => {
    const match = /^\{(\w+)\}$/.exec(part);
    return match && match[1] in vars ? createElement(Fragment, { key: index }, vars[match[1]]) : part;
  }));
}

/**
 * A proper name from the registers (place, street, address, municipality): shown as is in both languages and
 * marked lang="sl" so screen readers pronounce it in Slovenian and the English crawl knows it is meant to stay.
 */
export function Name({ children }: { children: ReactNode }) {
  return createElement("span", { lang: "sl", translate: "no" }, children);
}

/** A register name inside running text: marked as Slovenian in the English interface; the Slovenian page already is. */
export const proper = (text: ReactNode): ReactNode => LANG === "en" && text !== "" && text != null ? createElement(Name, null, text) : text;
