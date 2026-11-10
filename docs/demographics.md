# Demographics: context, not a price driver

## Decision

SREO shows SURS demography (population by age, deaths, migration, dwellings and
households) as **context indicators only**. Demography is not used in any price
statistic, index, valuation model or forecast, and SREO publishes no
"demographic price scenario" per municipality or region.

The reason is empirical: in Slovenian data from 2007 to 2026, base-period
demography does not predict which municipalities or regions see faster or
slower real price growth. A scenario built on it would present noise as a
forecast.

## What was tested (November 2026)

The question was whether ageing, dwellings released by older owners' deaths,
young-household formation and migration, measured at the start of a window,
predict mix-adjusted real €/m² growth **relative to Slovenia** over that window.

- **Prices.** 206,520 representative apartment and house sales from GURS ETN
  (`analytics.sale_facts`). One national hedonic model (year × type, area,
  construction decade) removes mix effects. Each municipality's growth is the
  change in its median residual between a three-year start pool and end pool.
- **Demography.** SURS population by five-year age group, deaths, net migration,
  2011 census dwellings and tenure, wages; ten features (old-age dependency, its
  recent change, the 80+ share, expected dwelling releases, household formation,
  cohort ratios, migration, a combined "pressure" measure), all measured before
  the window starts.
- **Windows.** 2010→15, 2015→20, 2020→25, and 2015→25 as the primary window.
  About 73-142 municipalities per test (at least 20 sales in both pools),
  weighted by sample size, plus the 12 statistical regions separately.
- **Tests.** Weighted cross-section regressions with robust errors and controls
  (initial price level, Ljubljana, coast, tourist areas, distance to Ljubljana,
  size, urbanity, wages); a joint test; robustness variants; out-of-sample tests
  forward in time and leave-one-region-out; sign stability across windows; a
  multiple-testing tally.

## Result

- At most about **3 percentage points of extra adjusted R²** beyond the controls.
  The six main features are jointly insignificant in every group (Wald p 0.18-0.27).
- Effects are at most about **±0.4 pp of relative growth a year per standard
  deviation**, and the confidence intervals almost always include zero.
- The few "significant" effects **change sign** between windows. For houses,
  dwelling releases go from +1.1 (2010→15) to −0.7 (2020→25).
- Out of sample, demography **never beats the naive forecast** that every
  municipality grows at the national average, forward in time or across regions.
- Of 240 tests, 9.6 % had p < 0.05 against 5 % expected by chance: a little
  structure plus noise, not a usable predictor.
- Municipal relative growth is negatively autocorrelated between windows (mean
  reversion and local new-build waves dominate).
- Regionally, relative price levels barely moved: Osrednjeslovenska stayed at
  142-163 % of the national level and Pomurska at 55-66 % from 2010 to 2026, while
  their old-age dependency ratios rose by 7.8 and 18.2 points.
- Nationally, the old-age dependency ratio rose from 23.8 to 35.6 and the 25-39
  population fell by 20 % between 2010 and 2026, while real median apartment €/m²
  rose about 31 %.

**Limits.** Usable ETN starts in 2007, so there are only three independent
five-year windows, all within one credit cycle. A slow drag smaller than about
0.5-0.7 pp a year cannot be ruled out. The honest statement is "not detectable,
and if present, small", not "zero".

## What the product shows

- Demographic **flows as indicators**, labelled as flows: potential dwelling
  releases from deaths of older owners, young-household formation and net
  migration, per region and municipality (`/api/v1/demographics`,
  `/api/v1/demographics/municipalities`, stored in `analytics.context_series`).
- An explicit note beside them that, in 2010-2025, municipalities and regions that
  aged faster did not show measurably slower real price growth, and that the
  figures describe supply and demand flows, not a price forecast.
- If a quantitative statement is ever needed, use only the bound, at national or
  regional level: "historical effect not distinguishable from zero".

## Revisit when

- 2027-2030 data arrive, or the price cycle turns (a downturn is where an ageing
  drag would most plausibly show). Re-run the backtest; only a sign-stable
  effect that also wins out of sample would justify a scenario.
- A better next question is quantity, not price: measure how released dwellings
  pass through into ETN sales (older, larger resale dwellings sold within a few
  years of an estimated release), turning the release flow from an assumption
  into a measured series.

## Reproducing

The scripts are in
[`apps/data-pipeline/research/demographics-backtest/`](../apps/data-pipeline/research/demographics-backtest/README.md),
with inputs, run order and outputs. The full working report and literature notes
are kept outside the repository.
