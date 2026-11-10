# Demographics and prices backtest

One-off research scripts behind the decision in [`docs/demographics.md`](../../../../docs/demographics.md):
base-period demography does not predict relative real price growth of Slovenian
municipalities or regions, so SREO shows SURS demography as context only.

They are kept as they were run, for reproducibility. They are not part of the
`real_estate_etl` package, are not installed into the pipeline image and are not
linted (see `../ruff.toml`). Re-run them when 2027-2030 data arrive or the cycle turns.

## Inputs

Run everything from this directory. The scripts read `data/` and write `out/`; both
are git-ignored and must be created first (`mkdir -p data out`).

| File in `data/` | Produced by | Columns used |
|---|---|---|
| `pop.txt`, `rest.txt` | `fetch.py` (SURS PX-Web: 05C4004S, 05L2016S, 05L2020S, 05I2002S, 0861102S, 0861110S, 0711344S) | sections `### name col\|col\|value` |
| `sales.csv` | export of `analytics.sale_facts` (`representative_eligible`, apartments and houses) | `yr`, `ppsqm`, `area`, `cy` (construction year), `pg` (property group), `mun`, `reg` |
| `muni.csv` | municipalities from `analytics.geographic_units` | `code`, `name`, `reg` |
| `geo.csv` | PostGIS point-on-surface distance to Ljubljana | `code`, `dist_lj_km` |
| `cpi.csv` | `/api/v1/economy/inflation` (SURS H281S), annual average | `yr`, `cpi` |

## Run order

1. `fetch.py`, inside the pipeline container (it has network access and only uses the
   standard library):

   ```sh
   docker compose exec -T pipeline-worker python - pop  < scripts/fetch.py > data/pop.txt
   docker compose exec -T pipeline-worker python - rest < scripts/fetch.py > data/rest.txt
   ```

2. Steps 2-7 in a throwaway Python container:

   ```sh
   docker run --rm -v "$PWD:/work" -w /work python:3.11-slim sh -c \
     "pip install -q pandas numpy statsmodels scipy matplotlib && \
      python scripts/prep.py && python scripts/build.py && python scripts/analyze.py && \
      python scripts/analyze2.py && python scripts/cycle.py && python scripts/plots.py"
   ```

`analyze2.py` reuses the helpers of `scripts/analyze.py` by path, so keep the layout.
Outputs: `out/dataset.csv`, the result tables (`univariate_with_controls.csv`,
`joint_test.csv`, `robustness.csv`, `sign_stability.csv`, `oos_temporal.csv`,
`oos_loro.csv`, `regional_correlations.csv`, `region_relative_level.csv`,
`region_oadr.csv`, `region_scatter.csv`, `foresight.csv`, `national_medians.csv`) and
two figures.
