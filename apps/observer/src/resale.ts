/**
 * Educational sale-now scenario for a private seller in Slovenia (same reviewed rules as the
 * original dashboard). Not a tax return or advice; the taxable base is approximated and editable.
 */
export const TAX_RULES = {
  id: "SI-private-sale-2026-reviewed-2026-09-10",
  source: "https://www.fu.gov.si/zivljenjski_dogodki_prebivalci/nakup_in_prodaja_nepremicnine", // i18n-ignore (URL)
} as const;

/** Completed years of ownership between two ISO dates. */
export function completedYears(acquired: string, disposed: string) {
  let years = Number(disposed.slice(0, 4)) - Number(acquired.slice(0, 4));
  if (disposed.slice(5) < acquired.slice(5)) years -= 1;
  return Math.max(0, years);
}

/** Capital gains rate: under 5 years 25 %, 5–9 years 20 %, 10–14 years 15 %, from 15 years (or own home ≥ 3 years) 0 %. */
export function capitalGainsRate(years: number, ownHome: boolean) {
  if ((ownHome && years >= 3) || years >= 15) return 0;
  return years >= 10 ? 0.15 : years >= 5 ? 0.20 : 0.25;
}

interface SaleScenario {
  years: number; rate: number; base: number; capitalGainsTax: number; transferTax: number; sellingCosts: number;
  net: number; afterLoan: number; gain: number; nextRate?: { date: string; rate: number };
}

/**
 * Base ≈ sale − purchase − normirani stroški (1 % of purchase + 1 % of sale) − documented investments (they lower the base).
 * Selling costs (agent, notary) lower the proceeds; the remaining loan is repaid from them.
 */
export function saleScenario(input: { acquired: string; disposed: string; purchase: number; sale: number; investments: number; sellingCosts: number;
  loan: number; ownHome: boolean; sellerPaysTransferTax: boolean }): SaleScenario {
  const years = completedYears(input.acquired, input.disposed);
  const rate = capitalGainsRate(years, input.ownHome);
  const base = Math.max(0, input.sale - input.purchase - 0.01 * input.purchase - 0.01 * input.sale - input.investments);
  const capitalGainsTax = Math.round(base * rate);
  const transferTax = input.sellerPaysTransferTax ? Math.round(input.sale * 0.02) : 0;
  const net = input.sale - capitalGainsTax - transferTax - input.sellingCosts;
  // When the next lower rate starts (5, 10, 15 completed years).
  const threshold = [5, 10, 15].find((value) => value > years);
  const nextRate = rate > 0 && threshold ? { date: `${Number(input.acquired.slice(0, 4)) + threshold}${input.acquired.slice(4)}`, rate: capitalGainsRate(threshold, false) } : undefined;
  return { years, rate, base, capitalGainsTax, transferTax, sellingCosts: input.sellingCosts, net, afterLoan: net - input.loan,
    gain: net - input.purchase - input.investments, nextRate };
}
