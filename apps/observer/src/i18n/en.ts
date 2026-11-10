/**
 * English dictionary: Slovenian template → English template. Each area of the interface has its own file
 * (so translations live next to each other and can be reviewed per screen); keys must be unique overall.
 */
import { common } from "./en/common";
import { explorer } from "./en/explorer";
import { area } from "./en/area";
import { value } from "./en/value";
import { sale } from "./en/sale";
import { pages } from "./en/pages";

export const EN: Record<string, string> = { ...common, ...explorer, ...area, ...value, ...sale, ...pages };
export const EN_PARTS = { common, explorer, area, value, sale, pages };
