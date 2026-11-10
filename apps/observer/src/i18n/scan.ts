import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

/**
 * Static i18n audit used by i18n.test.ts:
 *  - keys: every t("…")/tx("…") literal must have an English entry;
 *  - leftovers: visible Slovenian outside t()/tx() — JSX text, user-facing attributes, and string literals
 *    with Slovenian letters or Slovenian words. A line can opt out with `// i18n-ignore` (data processing only,
 *    e.g. matching register spellings), never for something the user reads.
 */
export const SRC = join(__dirname, "..");
const SKIP_DIRS = new Set(["generated", "i18n"]);

export function sourceFiles(directory = SRC): string[] {
  return readdirSync(directory).flatMap((name) => {
    const path = join(directory, name);
    if (statSync(path).isDirectory()) return SKIP_DIRS.has(name) ? [] : sourceFiles(path);
    return /\.(ts|tsx)$/.test(name) && !/\.test\.tsx?$/.test(name) ? [path] : [];
  });
}

const CALL = /\b(?:t|tx)\(\s*"((?:[^"\\]|\\.)*)"/g;
export function keysIn(code: string) {
  return [...code.matchAll(CALL)].map((match) => JSON.parse(`"${match[1]}"`) as string);
}

/** Tokens that are the same in English (codes, units, brands, symbols). */
const NEUTRAL = /^(?:[\d\s.,:;!?%€²³/·–—−+×=()[\]{}"'«»„“”‘’…→←↓↑›‹|*#&@~^_<>-]|n|m²|m|km|ha|SREO|GURS|ETN|SURS|ECB|CC|BY|4\.0|OpenFreeMap|OpenStreetMap|OpenMapTiles|MapLibre|EUR|CSV|ID|P\d+|Q\d)+$/u;

function stripComments(code: string) {
  return code.replace(/\/\*[\s\S]*?\*\//g, (block) => block.replace(/[^\n]/g, " ")).replace(/(^|[^:"'`\\])\/\/[^\n]*/g, (_, lead: string) => lead);
}

export interface Leftover { file: string; line: number; text: string; kind: string }

export function leftovers(path: string, slovenianWords: Set<string>): Leftover[] {
  const original = readFileSync(path, "utf8");
  const lines = original.split("\n");
  const ignored = new Set(lines.flatMap((line, index) => /i18n-ignore/.test(line) ? [index + 1] : []));
  // Blank out t()/tx() keys and comments, keeping offsets so line numbers stay right.
  const code = stripComments(original).replace(CALL, (match) => match.replace(/"((?:[^"\\]|\\.)*)"/, (quoted) => `"${" ".repeat(quoted.length - 2)}"`));
  const out: Leftover[] = [];
  const lineOf = (offset: number) => code.slice(0, offset).split("\n").length;
  const push = (offset: number, text: string, kind: string) => {
    const line = lineOf(offset);
    if (!ignored.has(line)) out.push({ file: relative(SRC, path), line, text: text.trim().slice(0, 80), kind });
  };
  const looksSlovenian = (text: string) => /[čšžČŠŽćđ]/.test(text)
    || (text.match(/\p{L}{3,}/gu) ?? []).some((word) => slovenianWords.has(word.toLocaleLowerCase("sl-SI")));
  // Visible text (JSX, attributes) is always Slovenian in the source: short function words count too ("do", "na", "ni").
  const SHORT = new Set(["do", "na", "za", "ni", "od", "po", "ob", "še", "iz", "ki", "je", "so", "pa", "ali", "ter", "pri", "kot", "le", "sta", "bo", "se", "v", "z", "s", "k", "in", "ne", "da", "tu", "kje", "vse", "let", "leto", "dni"]);
  const visibleSlovenian = (text: string) => looksSlovenian(text) || text.split(/[\s,.;:!?()[\]{}"'«»„“”/–—-]+/u).some((word) => /^\p{L}+$/u.test(word) && SHORT.has(word.toLocaleLowerCase("sl-SI")));
  if (path.endsWith(".tsx")) {
    // JSX text between tags (not inside {…}).
    for (const match of code.matchAll(/>([^<>{}]*\p{L}[^<>{}]*)</gu)) {
      const text = match[1];
      if (!/\S/.test(text) || NEUTRAL.test(text.trim())) continue;
      if (/=>|\b(?:const|return|if|let)\b|&&|\?\?/.test(text)) continue; // generics / code, not JSX text
      if (!/\p{L}{2,}/u.test(text) && !visibleSlovenian(text)) continue;
      push(match.index! + 1, text, "jsx-text");
    }
    // User-facing attributes with literal text.
    for (const match of code.matchAll(/\b(aria-label|aria-description|title|placeholder|label|alt|summary)=("([^"]*\p{L}[^"]*)"|\{`([^`]*\p{L}[^`]*)`\})/gu)) {
      const text = match[3] ?? match[4];
      if (NEUTRAL.test(text.trim())) continue;
      push(match.index!, text, `attribute ${match[1]}`);
    }
  }
  // String and template literals that read as Slovenian.
  for (const match of code.matchAll(/"((?:[^"\\\n]|\\.)*)"|`((?:[^`\\]|\\.)*)`/g)) {
    const text = (match[1] ?? match[2] ?? "").replace(/\$\{[^}]*\}/g, " ");
    if (!/\p{L}/u.test(text) || NEUTRAL.test(text.trim())) continue;
    if (/^(?:#|\/api\/|[a-z][\w-]*(?:\s+[a-z][\w-]*)*$)/.test(text.trim()) && !looksSlovenian(text)) continue; // ids, classes, paths
    // Sentence-like literals (spaces or inserted values) also count with short Slovenian words: `do ${value}`.
    const sentence = /\s/.test(text.trim()) || /\$\{/.test(match[2] ?? "");
    if (looksSlovenian(text) || (sentence && visibleSlovenian(text))) push(match.index!, text, "string");
  }
  return out;
}

/** Slovenian words of the interface (from the dictionary keys) that are not also English words. */
export function slovenianVocabulary(keys: string[]) {
  // Words that are Slovenian in a key but also English (or code: class and file names): never evidence of Slovenian.
  const alsoEnglish = new Set(["median", "evidence", "register", "center", "index", "model", "minimum", "trend", "status", "start", "garage", "parcel", "table", "total", "data", "info", "list", "plan"]);
  const words = new Set<string>();
  for (const key of keys) for (const word of key.replace(/\{\w+\}/g, " ").match(/\p{L}{4,}/gu) ?? []) {
    const lower = word.toLocaleLowerCase("sl-SI");
    if (!alsoEnglish.has(lower)) words.add(lower);
  }
  return words;
}
