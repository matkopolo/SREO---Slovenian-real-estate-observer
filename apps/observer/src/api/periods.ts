import { date } from "../format";
import { t } from "../i18n";

/** An inclusive date range, ISO dates ("2025-07-01"–"2026-06-30"). */
export interface DateWindow { from: string; to: string }

/** Whole calendar years as a window. */
export const range = (fromYear: number, toYear: number): DateWindow => ({ from: `${fromYear}-01-01`, to: `${toYear}-12-31` });

/** Shift a window back by whole months (previous-period comparisons, reporting-lag windows). */
export function shiftWindow(window: DateWindow, months: number): DateWindow {
  const move = (value: string) => {
    const [year, month, day] = value.split("-").map(Number);
    const last = new Date(Date.UTC(year, month - 1 - months + 1, 0)).getUTCDate(); // days in the target month
    return new Date(Date.UTC(year, month - 1 - months, Math.min(day, last))).toISOString().slice(0, 10);
  };
  return { from: move(window.from), to: move(window.to) };
}

interface MarketWindows { sales: { current: DateWindow; previous: DateWindow }; rents: { current: DateWindow; previous: DateWindow; year: number } }

/**
 * Comparable periods despite GURS reporting lag. Sales: the twelve months ending at the last quarter
 * that closed at least three months before the cutoff (the newest quarter is still being filled in).
 * Rentals are reported up to a year late, so rents use the last mostly reported calendar year.
 */
export function marketWindows(cutoff: string): MarketWindows {
  const [year, month, day] = cutoff.split("-").map(Number);
  const lagged = new Date(Date.UTC(year, month - 1 - 3, day));
  const end = new Date(Date.UTC(lagged.getUTCFullYear(), Math.floor(lagged.getUTCMonth() / 3) * 3, 0)); // last day of the previous quarter
  const iso = (value: Date) => value.toISOString().slice(0, 10);
  const start = new Date(Date.UTC(end.getUTCFullYear() - 1, end.getUTCMonth(), end.getUTCDate() + 1));
  const current = { from: iso(start), to: iso(end) };
  const rentYear = new Date(Date.UTC(year, month - 1 - 9, 1)).getUTCFullYear() - 1;
  return { sales: { current, previous: shiftWindow(current, 12) },
    rents: { current: range(rentYear, rentYear), previous: range(rentYear - 1, rentYear - 1), year: rentYear } };
}

export type PeriodYears = 1 | 3 | 5;
/** A trailing window (1, 3 or 5 years to the cutoff) or chosen calendar years, e.g. "2019-2021". */
export type Period = PeriodYears | `${number}-${number}`;
export const FIRST_SALE_YEAR = 2007;
export const FIRST_RENT_YEAR = 2013;
export interface PeriodWindows {
  /** `previous` is null when it would start before the data does (sales 2007, rents 2013): no change is shown then. */
  sales: { current: DateWindow; previous: DateWindow | null }; rents: { current: DateWindow; previous: DateWindow | null };
  /** Length in years; custom periods are never widened for thin areas. */
  years: number; custom: boolean; rentYear: number;
  /** "v 12 mesecih do 30. 6. 2026", "v obdobju 1. 1. 2019–31. 12. 2021" */
  label: string;
  /** "2025" or "2023–2025" */
  rentYears: string;
}

/** Wider trailing windows a thin area may borrow (never for a chosen year range: the numbers must match the range). */
export const widerPeriods = (period: Period): PeriodYears[] => typeof period === "number" ? ([3, 5] as const).filter((value) => value > period) : [];

export function parsePeriod(from: string | null, to: string | null): Period | undefined {
  const start = Number(from), end = Number(to), now = new Date().getFullYear();
  if (!Number.isInteger(start) || !Number.isInteger(end) || start < FIRST_SALE_YEAR || end > now || start > end) return undefined;
  return `${start}-${end}`;
}

/** The lag-aware market windows widened to 3 or 5 years (small areas), each with an equally long previous period. */
export function periodWindows(cutoff: string, period: Period): PeriodWindows {
  const base = marketWindows(cutoff);
  if (typeof period === "string") {
    const [fromYear, toYear] = period.split("-").map(Number);
    const length = toYear - fromYear + 1;
    // The newest months are still being reported, so a range never reaches past the lag-aware end.
    const end = `${toYear}-12-31` < base.sales.current.to ? `${toYear}-12-31` : base.sales.current.to;
    const sales = { from: `${fromYear}-01-01`, to: end };
    const rentTo = Math.min(toYear, base.rents.year);
    const rentFrom = Math.max(fromYear, FIRST_RENT_YEAR);
    // A range that ends before rentals were recorded queries its own years and finds no rents: no rent, no yield
    // (never 2013 rents divided by 2008 prices).
    const available = rentFrom <= rentTo;
    const rents = available ? range(rentFrom, rentTo) : range(fromYear, toYear);
    const previousSales = shiftWindow(sales, length * 12);
    const previousRents = available ? shiftWindow(rents, (rentTo - rentFrom + 1) * 12) : null;
    return { sales: { current: sales, previous: previousSales.from >= `${FIRST_SALE_YEAR}-01-01` ? previousSales : null },
      rents: { current: rents, previous: previousRents && previousRents.from >= `${FIRST_RENT_YEAR}-01-01` ? previousRents : null },
      years: length, custom: true, rentYear: rentTo, rentYears: !available ? "—" : rentFrom === rentTo ? String(rentTo) : `${rentFrom}–${rentTo}`,
      // Whole calendar years say so; a range cut at the reporting lag shows its exact dates.
      label: end === `${toYear}-12-31` ? (length === 1 ? t("v koledarskem letu {year}", { year: fromYear }) : t("v koledarskih letih {from}–{to}", { from: fromYear, to: toYear }))
        : length === 1 ? t("v obdobju {from}–{to} (del leta)", { from: date(sales.from), to: date(sales.to) }) : t("v obdobju {from}–{to}", { from: date(sales.from), to: date(sales.to) }) };
  }
  const years = period;
  const months = years * 12;
  const sales = { from: shiftWindow(base.sales.current, months - 12).from, to: base.sales.current.to };
  const rents = range(base.rents.year - years + 1, base.rents.year);
  return { sales: { current: sales, previous: shiftWindow(sales, months) }, rents: { current: rents, previous: shiftWindow(rents, months) },
    years, custom: false, rentYear: base.rents.year, rentYears: years === 1 ? String(base.rents.year) : `${base.rents.year - years + 1}–${base.rents.year}`,
    label: years === 1 ? t("v 12 mesecih do {date}", { date: date(sales.to) }) : t("v {years} letih do {date}", { years, date: date(sales.to) }) };
}

/** The newest calendar year inside the lag-aware sales window (2025 for a cutoff in October 2026 or in January 2027). */
export function lastCompleteYear(cutoff: string): number {
  const end = marketWindows(cutoff).sales.current.to;
  return Number(end.slice(0, 4)) - (end.endsWith("-12-31") ? 0 : 1);
}
