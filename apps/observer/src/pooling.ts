import { MIN_SAMPLE, type MunicipalityValue } from "./metrics";

/** A published area value; `pooled` is the number of years it was pooled over when the chosen period was too thin. */
export type AreaValue = MunicipalityValue & { pooled?: number };

/**
 * Published value per area: the period's own value from `minimum` sales, else the first wider period (3, then 5 years)
 * that has enough (flagged as pooled), else withheld (value null, the period's own count kept).
 */
export function pool(values: MunicipalityValue[], wider: Array<{ years: number; values: MunicipalityValue[] }>, minimum = MIN_SAMPLE): AreaValue[] {
  const lookups = wider.map((entry) => ({ years: entry.years, byId: new Map(entry.values.map((item) => [item.geographyId, item])) }));
  return values.map((item) => {
    if (item.sample >= minimum) return item;
    for (const { years, byId } of lookups) {
      const long = byId.get(item.geographyId);
      if (long && long.sample >= minimum) return { ...long, pooled: years };
    }
    return { ...item, value: null };
  });
}
