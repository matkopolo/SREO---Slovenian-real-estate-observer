import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { EN, EN_PARTS } from "./en";
import { keysIn, leftovers, slovenianVocabulary, sourceFiles } from "./scan";

const files = sourceFiles();
const used = new Map<string, string[]>();
for (const file of files) for (const key of keysIn(readFileSync(file, "utf8"))) used.set(key, [...(used.get(key) ?? []), file]);

describe("English translation", () => {
  it("has an English entry for every t()/tx() text", () => {
    const missing = [...used.keys()].filter((key) => !(key in EN));
    expect(missing).toEqual([]);
  });
  it("keeps the placeholders of every entry", () => {
    const broken = Object.entries(EN).filter(([sl, en]) => {
      const names = (text: string) => [...text.matchAll(/\{(\w+)\}/g)].map((match) => match[1]).sort().join(",");
      return names(sl) !== names(en);
    }).map(([sl]) => sl);
    expect(broken).toEqual([]);
  });
  it("defines each key in one dictionary file only", () => {
    const seen = new Map<string, string>();
    const duplicates: string[] = [];
    for (const [part, entries] of Object.entries(EN_PARTS)) for (const key of Object.keys(entries)) {
      if (seen.has(key) && entries[key] !== EN[key]) duplicates.push(`${key} (${seen.get(key)} / ${part})`);
      seen.set(key, part);
    }
    expect(duplicates).toEqual([]);
  });
  it("uses every English entry", () => {
    expect(Object.keys(EN).filter((key) => !used.has(key))).toEqual([]);
  });
  it("has no English entry that is still Slovenian", () => {
    const untranslated = Object.entries(EN).filter(([, en]) => /[čšžČŠŽ]/.test(en.replace(/\{\w+\}/g, ""))).map(([sl]) => sl);
    expect(untranslated).toEqual([]);
  });
  it("leaves no visible Slovenian outside t()/tx()", () => {
    const vocabulary = slovenianVocabulary(Object.keys(EN));
    const found = files.flatMap((file) => leftovers(file, vocabulary)).map((item) => `${item.file}:${item.line} [${item.kind}] ${item.text}`);
    expect(found).toEqual([]);
  });
});
