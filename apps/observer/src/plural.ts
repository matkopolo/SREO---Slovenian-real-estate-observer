import { integer } from "./format";
import { LANG, LOCALE } from "./i18n";

/**
 * Count forms. Slovenian: 1 (one), 2 (two), 3–4 (few), 0 and 5+ (other); decimals take "few" ("5,1 leta").
 * English: 1 (one), everything else (other) — stored in the same four slots so callers never branch.
 */
const rules = new Intl.PluralRules(LOCALE);

export type Forms = [one: string, two: string, few: string, other: string];

const SLOVENIAN = {
  prodaja: ["prodaja", "prodaji", "prodaje", "prodaj"], // i18n-ignore
  najem: ["najem", "najema", "najemi", "najemov"], // i18n-ignore
  posel: ["posel", "posla", "posli", "poslov"], // i18n-ignore
  stavba: ["stavba", "stavbi", "stavbe", "stavb"], // i18n-ignore
  stanovanje: ["stanovanje", "stanovanji", "stanovanja", "stanovanj"], // i18n-ignore
  prebivalec: ["prebivalec", "prebivalca", "prebivalci", "prebivalcev"], // i18n-ignore
  človek: ["človek", "človeka", "ljudje", "ljudi"], // i18n-ignore
  leto: ["leto", "leti", "leta", "let"], // i18n-ignore
  naselje: ["naselje", "naselji", "naselja", "naselij"], // i18n-ignore
  občina: ["občina", "občini", "občine", "občin"], // i18n-ignore
  zapis: ["zapis", "zapisa", "zapisi", "zapisov"], // i18n-ignore
  sestavina: ["sestavina", "sestavini", "sestavine", "sestavin"], // i18n-ignore
  par: ["par", "para", "pari", "parov"], // i18n-ignore
} satisfies Record<string, Forms>;

const english = (one: string, other: string): Forms => [one, other, other, other];
const ENGLISH: Record<keyof typeof SLOVENIAN, Forms> = {
  prodaja: english("sale", "sales"),
  najem: english("rental", "rentals"),
  posel: english("transaction", "transactions"),
  stavba: english("building", "buildings"),
  stanovanje: english("dwelling", "dwellings"),
  prebivalec: english("resident", "residents"),
  človek: english("person", "people"),
  leto: english("year", "years"),
  naselje: english("settlement", "settlements"),
  občina: english("municipality", "municipalities"),
  zapis: english("record", "records"),
  sestavina: english("component", "components"),
  par: english("pair", "pairs"),
};

export const NOUN_FORMS: Record<keyof typeof SLOVENIAN, Forms> = LANG === "en" ? ENGLISH : SLOVENIAN;
/** Build forms for both languages in one place: plural(["hiša","hiši","hiše","hiš"], ["house","houses"]). */
export const forms = (slovenian: Forms, englishForms: [one: string, other: string]): Forms => LANG === "en" ? english(...englishForms) : slovenian;

export function form(count: number, list: Forms) {
  const category = rules.select(count);
  return category === "one" ? list[0] : category === "two" ? list[1] : category === "few" ? list[2] : list[3];
}

/** "2 prebivalca" / "2 residents", "1 prodaja" / "1 sale" (rounded counts). */
export function count(value: number, list: Forms) {
  const rounded = Math.round(value);
  return `${integer(rounded)} ${form(rounded, list)}`;
}
