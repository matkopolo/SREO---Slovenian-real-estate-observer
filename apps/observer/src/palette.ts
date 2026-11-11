import type { MetricId } from "./metrics";

/**
 * The colours of the data, chosen with the "Teren" direction (November 2026): a map reads like a relief map, so each
 * family of measure has its own hue and a value's height is its darkness. Prices climb from sand to pine, rents are
 * water blues, money (yield, affordability) is coral, people are plum, building is amber. The chrome is ink on paper
 * (styles.css); the opened property is marked in coral so it stands apart from every ramp.
 */
export type Family = "price" | "rent" | "money" | "people" | "build";

const RAMPS: Record<Family, string[]> = {
  price: ["#f1e6c6", "#c9c488", "#7f9e57", "#3f7144", "#1f4d3a"],
  rent: ["#e4ebf1", "#b7c9da", "#7f9fbd", "#4c7398", "#2a4a6b"],
  money: ["#f7dfd5", "#eeaf98", "#df7a5c", "#c2452d", "#7e2a19"],
  people: ["#ece0ea", "#cdaac9", "#a677a3", "#7d4a7b", "#50294f"],
  build: ["#f8ecd0", "#edcf86", "#d9a83c", "#b7801a", "#7a540d"],
};
/** Marks the map draws in code (MapLibre takes literals): the opened property's ring, a comparable sale, a new building. */
const MARKS = { subject: "#c2452d", comparable: "#1f4d3a", newBuilding: "#b7801a" };

/** Five classes, light → dark, of the family's hue. */
export const ramp = (family: Family) => RAMPS[family];
export const marks = () => MARKS;
/** The family of measure a map layer belongs to, so prices, rents, money, people and building take their own hue. */
export function familyOf(metric: MetricId): Family {
  switch (metric) {
    case "rentPrice": return "rent";
    case "grossYield": case "affordableSqm": return "money";
    case "share65": case "netMigration": case "releases": return "people";
    case "newBuildings": return "build";
    default: return "price";
  }
}
/** The DRSV flood hazard classes in the rent (water) ramp: Pv velika, Ps srednja, Pm majhna, Pp preostala. */
export const FLOOD_COLORS = { Pv: RAMPS.rent[4], Ps: RAMPS.rent[3], Pm: RAMPS.rent[2], Pp: RAMPS.rent[1] };
