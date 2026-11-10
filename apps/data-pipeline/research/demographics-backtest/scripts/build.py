"""Build the municipality x window dataset: outcomes (relative real price growth) + demographic and control features."""
import numpy as np, pandas as pd, statsmodels.formula.api as smf

D = "data/"
sales = pd.read_csv(D + "sales.csv")
sales = sales[(sales.ppsqm > 150) & (sales.ppsqm < 20000) & (sales.area >= 15) & (sales.area <= 600)].copy()
cpi = pd.read_csv(D + "cpi.csv").set_index("yr")["cpi"]
sales["lp"] = np.log(sales.ppsqm)
sales["lp_real"] = sales.lp - np.log(sales.yr.map(cpi) / 100)
sales["la"] = np.log(sales.area)
dec = pd.cut(sales.cy, [0, 1945, 1960, 1970, 1980, 1990, 2000, 2010, 2030], labels=False)
sales["cyb"] = dec.fillna(-1).astype(int).astype(str)
sales = sales[sales.yr <= 2026]

# National mix model: year x group FE, group x (log area, area^2, construction decade).
mix = smf.ols("lp ~ C(yr):C(pg) + C(pg):la + C(pg):I(la**2) + C(pg):C(cyb)", data=sales).fit()
sales["resid"] = mix.resid
print("mix model R2", round(mix.rsquared, 3), "n", int(mix.nobs))

# National real median growth (for context)
nat = sales.groupby(["pg", "yr"]).ppsqm.median().unstack(0)
nat["cpi"] = cpi
nat["apt_real"] = nat.apartment / nat.cpi * 100; nat["house_real"] = nat.house / nat.cpi * 100
nat.round(1).to_csv("out/national_medians.csv")

pop = pd.read_csv(D + "pop_panel.csv").set_index(["mun", "yr"])
deaths = pd.read_csv(D + "deaths_mun.csv").set_index(["mun", "yr"])
migr = pd.read_csv(D + "migr_mun.csv").set_index(["mun", "yr"])
stock = pd.read_csv(D + "stock.csv")
st11 = stock[stock.census == 2011].set_index("mun"); st21 = stock[stock.census == 2021].set_index("mun")
wage = pd.read_csv(D + "wage.csv").set_index(["mun", "yr"])["wage"]
geo = pd.read_csv(D + "geo.csv").set_index("code")
muni = pd.read_csv(D + "muni.csv").set_index("code")

LA_FACTOR = 0.35      # share of 65+ deaths that empty an owner household (last survivor) - scale only
HEADSHIP_STEP = 0.03  # households formed per person aged 25-34 per year (~0.3 headship gain over the decade) - scale only
PERSONS_PER_HH = 2.4

COAST = {50, 40, 90, 213}
TOURIST = {3, 4, 6, 53, 46, 78, 92, 106, 100, 144}

WINDOWS = {  # name: (base year for demographics, start pool, end pool, pre pool for initial level)
    "A_2010_15": (2010, [2009, 2010, 2011], [2014, 2015, 2016], [2007, 2008]),
    "B_2015_20": (2015, [2014, 2015, 2016], [2019, 2020, 2021], [2012, 2013]),
    "C_2020_25": (2020, [2019, 2020, 2021], [2024, 2025, 2026], [2017, 2018]),
    "L_2015_25": (2015, [2014, 2015, 2016], [2023, 2024, 2025], [2012, 2013]),
}


def avg(df, col, muns, years):
    s = df[col].unstack("yr")
    return s.reindex(index=muns, columns=[y for y in years if y in s.columns]).mean(axis=1)


def demo_features(b, end_year, muns):
    P = lambda yr: pop.xs(min(max(yr, 2008), 2026), level="yr").reindex(muns)
    pb = P(b); back = max(2008, b - 5); pk = P(back)
    f = pd.DataFrame(index=muns)
    f["oadr"] = pb.p65 / pb.p15_64 * 100
    f["d_oadr"] = (f.oadr - pk.p65 / pk.p15_64 * 100) / (b - back)            # pp per year, pre-window
    f["sh80"] = pb.p80 / pb["pop"] * 100
    dw = st11.dw_total.reindex(muns); own = (st11.owner_dw / st11.occ_dw).reindex(muns)
    d65 = avg(deaths, "deaths65", muns, range(b - 3, b))
    f["release"] = d65 * own * LA_FACTOR / dw * 1000                          # dwellings / 1000 dw / yr
    f["hh_form"] = (pb.p25_29 + pb.p30_34) * HEADSHIP_STEP / dw * 1000        # households / 1000 dw / yr
    nm = avg(migr, "netmig", muns, range(b - 3, b))
    f["mig_pk"] = avg(migr, "netmig_pk", muns, range(b - 3, b))
    f["mig_hh"] = nm / PERSONS_PER_HH / dw * 1000
    f["cohort"] = pb.p20_29 / pb.p30_39                                        # incoming vs established young adults
    f["young_sh"] = pb.p25_39 / pb["pop"] * 100
    f["pressure_core"] = f.hh_form - f.release
    f["pressure"] = f.hh_form - f.release + f.mig_hh
    # "Perfect foresight" (realised during the window; what a perfect projection would have given)
    pe = P(end_year)
    yrs = end_year - b
    f["fx_d_young"] = np.log(pe.p25_39 / pb.p25_39) / yrs * 100               # % per year
    f["fx_d_pop"] = np.log(pe["pop"] / pb["pop"]) / yrs * 100
    f["fx_d_oadr"] = (pe.p65 / pe.p15_64 * 100 - f.oadr) / yrs
    f["fx_mig_pk"] = avg(migr, "netmig_pk", muns, range(b, end_year))
    d65f = avg(deaths, "deaths65", muns, range(b, min(end_year, 2025) + 1))
    f["fx_pressure"] = ((pb.p25_29 + pb.p30_34 + pe.p25_29 + pe.p30_34) / 2 * HEADSHIP_STEP / dw * 1000
                        - d65f * own * LA_FACTOR / dw * 1000
                        + avg(migr, "netmig", muns, range(b, min(end_year, 2025) + 1)) / PERSONS_PER_HH / dw * 1000)
    return f


def controls(b, end_year, muns, lp0):
    c = pd.DataFrame(index=muns)
    c["lp0"] = lp0
    c["lj"] = (c.index == 61).astype(int)
    c["coast"] = c.index.isin(COAST).astype(int)
    c["tourist"] = c.index.isin(TOURIST).astype(int)
    c["ldist"] = np.log1p(geo.dist_lj_km.reindex(muns))
    c["lpop"] = np.log(pop.xs(b, level="yr")["pop"].reindex(muns))
    c["multi_sh"] = (st11.dw_multi / st11.dw_total).reindex(muns) * 100
    c["unocc_sh"] = (st11.dw_unocc / st11.dw_total).reindex(muns) * 100
    w0 = wage.xs(min(b, 2022), level="yr").reindex(muns); w1 = wage.xs(min(end_year, 2022), level="yr").reindex(muns)
    wn0 = wage.loc[(0, min(b, 2022))]; wn1 = wage.loc[(0, min(end_year, 2022))]
    yrs = max(min(end_year, 2022) - min(b, 2022), 1)
    c["lwage0"] = np.log(w0 / wn0)
    c["wage_g"] = (np.log(w1 / w0) - np.log(wn1 / wn0)) / yrs * 100           # relative % per year (to 2022)
    c["region"] = muni.reg.reindex(muns)
    return c


rows = []
for name, (b, s_pool, e_pool, pre_pool) in WINDOWS.items():
    yrs = np.mean(e_pool) - np.mean(s_pool)
    for grp in ["apartment", "house", "all"]:
        sx = sales if grp == "all" else sales[sales.pg == grp]
        def stat(pool):
            t = sx[sx.yr.isin(pool)]
            return t.groupby("mun").agg(n=("resid", "size"), r=("resid", "median"), lp=("lp_real", "median"))
        s0, s1, sp = stat(s_pool), stat(e_pool), stat(pre_pool)
        # national (same filter) real median log growth
        ns0, ns1 = sx[sx.yr.isin(s_pool)].lp_real.median(), sx[sx.yr.isin(e_pool)].lp_real.median()
        npre = sx[sx.yr.isin(pre_pool)].lp_real.median()
        df = s0.join(s1, lsuffix="0", rsuffix="1", how="inner").join(sp.add_suffix("p"), how="left")
        df = df[df.index > 0]
        df["y_mix"] = (df.r1 - df.r0) / yrs * 100                               # mix-adjusted relative growth, %/yr
        df["y_med"] = ((df.lp1 - df.lp0) - (ns1 - ns0)) / yrs * 100           # relative real median growth, %/yr
        df["y_real_abs"] = (df.lp1 - df.lp0) / yrs * 100                       # absolute real median growth
        df["nat_real"] = (ns1 - ns0) / yrs * 100
        df["w"] = 1 / (1 / df.n0 + 1 / df.n1)
        lp0 = (df.lpp - npre).where(df["np"] >= 10)
        muns = df.index
        f = demo_features(b, int(max(e_pool)) if max(e_pool) <= 2026 else 2026, muns)
        c = controls(b, int(max(e_pool)), muns, lp0)
        out = df[["n0", "n1", "w", "y_mix", "y_med", "y_real_abs", "nat_real"]].join(f).join(c)
        out["window"], out["group"], out["mun"] = name, grp, out.index
        rows.append(out.reset_index(drop=True))

data = pd.concat(rows, ignore_index=True)
data["name"] = data.mun.map(muni.name)
data.to_csv("out/dataset.csv", index=False)
print(data.groupby(["window", "group"]).agg(n=("mun", "size"), nmin20=("n0", lambda s: (s >= 20).sum()),
                                           nat_real=("nat_real", "first")).round(2))
