"""Follow-ups: fair LORO, rank-correlation OOS, multiple-testing tally, sign stability, regional (n=12) test."""
import numpy as np, pandas as pd, statsmodels.api as sm, statsmodels.formula.api as smf, warnings
from scipy import stats
warnings.filterwarnings("ignore"); pd.set_option("display.width", 220)
exec(open("scripts/analyze.py").read().split("res = []")[0])   # reuse sample()/fit()/table()

CT = ["lp0", "ldist", "lpop", "multi_sh", "lwage0"]          # no single-region dummies -> LORO is well posed
FEATS = {"pressure": ["pressure"], "oadr+release": ["oadr", "release"], "d_oadr": ["d_oadr"],
         "all_demo": ["oadr", "d_oadr", "release", "hh_form", "mig_pk", "cohort"]}

def wfit(d, y, f):
    return sm.WLS(d[y], sm.add_constant(d[f], has_constant="add"), weights=d.w).fit()

def pred(m, d, f): return m.predict(sm.add_constant(d[f], has_constant="add"))

# 1) LORO with well-posed controls; metric: OOS R2 vs training mean, and Spearman of predictions
rows = []
for g in ["apartment", "house", "all"]:
    d = sample("L_2015_25", g, "y_mix")
    for fn, f in {"none": [], **FEATS}.items():
        for base in ["ctrl", "nothing"]:
            feats = (CT if base == "ctrl" else []) + f
            if not feats: continue
            p = pd.Series(index=d.index, dtype=float); naive = pd.Series(index=d.index, dtype=float)
            for reg in d.region.unique():
                tr, te = d[d.region != reg], d[d.region == reg]
                p[te.index] = pred(wfit(tr, "y_mix", feats), te, feats)
                naive[te.index] = np.average(tr.y_mix, weights=tr.w)
            mse = np.average((d.y_mix - p) ** 2, weights=d.w); mse0 = np.average((d.y_mix - naive) ** 2, weights=d.w)
            rows.append(dict(group=g, base=base, demo=fn, n=len(d), oos_r2=1 - mse / mse0,
                             spearman=stats.spearmanr(p, d.y_mix).correlation))
loro = pd.DataFrame(rows); loro.round(3).to_csv("out/oos_loro.csv", index=False)
print("=== LORO (L window, y_mix)"); print(loro.round(3).to_string())

# 2) Temporal OOS: rank correlation of predicted vs actual relative growth in the later window
rows = []
for train, test in [(["A_2010_15"], "B_2015_20"), (["B_2015_20"], "C_2020_25"), (["A_2010_15", "B_2015_20"], "C_2020_25")]:
    for g in ["apartment", "house", "all"]:
        tr = pd.concat([sample(w, g, "y_mix") for w in train]); te = sample(test, g, "y_mix")
        for fn, f in {"none": [], **FEATS}.items():
            for base in ["ctrl", "nothing"]:
                feats = (CT if base == "ctrl" else []) + f
                if not feats: continue
                m = wfit(tr, "y_mix", feats); p = pred(m, te, feats)
                yt = te.y_mix - np.average(te.y_mix, weights=te.w); pt = p - np.average(p, weights=te.w)
                r2 = 1 - np.average((yt - pt) ** 2, weights=te.w) / np.average(yt ** 2, weights=te.w)
                rows.append(dict(train="+".join(train), test=test, group=g, base=base, demo=fn,
                                 oos_r2_demeaned=r2, spearman=stats.spearmanr(p, te.y_mix).correlation))
tos = pd.DataFrame(rows); tos.round(3).to_csv("out/oos_temporal.csv", index=False)
print("\n=== Temporal OOS (demeaned R2 = cross-sectional ranking skill)")
print(tos.pivot_table(index=["train", "test", "group"], columns=["base", "demo"], values="oos_r2_demeaned").round(2).to_string())
print(tos.pivot_table(index=["train", "test", "group"], columns=["base", "demo"], values="spearman").round(2).to_string())

# 3) Multiple testing tally + sign stability across the three non-overlapping windows
u = pd.read_csv("out/univariate_with_controls.csv")
print("\n=== share of p<0.05 among", len(u), "demographic tests:", round((u.p < 0.05).mean(), 3),
      "(expected by chance 0.05);  p<0.01:", round((u.p < 0.01).mean(), 3))
nb = u[u.window.isin(["A_2010_15", "B_2015_20", "C_2020_25"]) & (u.y == "y_mix")]
sg = nb.pivot_table(index=["group", "var"], columns="window", values="coef").round(2)
sg["same_sign_all3"] = (np.sign(sg).nunique(axis=1) == 1)
print("\n=== sign stability across windows A,B,C (y_mix, with controls)"); print(sg.to_string())
sg.to_csv("out/sign_stability.csv")

# 4) Regional test (n = 12): pooled region outcomes and demography
sales = pd.read_csv("data/sales.csv"); data_all = pd.read_csv("out/dataset.csv")
# region-level outcome: weighted mean of municipal mix-adjusted growth (weights = w), demographics weighted by dwellings
reg = []
for w in ["A_2010_15", "B_2015_20", "C_2020_25", "L_2015_25"]:
    for g in ["apartment", "house", "all"]:
        d = data_all[(data_all.window == w) & (data_all.group == g)].dropna(subset=["y_mix", "pressure", "oadr", "region"])
        a = d.groupby("region").apply(lambda x: pd.Series({
            "y": np.average(x.y_mix, weights=x.w), "n": x.n0.sum() + x.n1.sum(),
            **{v: np.average(x[v], weights=x.w) for v in ["pressure", "oadr", "d_oadr", "release", "hh_form", "mig_pk", "fx_d_young", "fx_d_oadr"]}}))
        for v in ["pressure", "oadr", "d_oadr", "release", "hh_form", "mig_pk", "fx_d_young", "fx_d_oadr"]:
            r, p = stats.pearsonr(a[v], a.y); rs = stats.spearmanr(a[v], a.y).correlation
            z = np.arctanh(r); se = 1 / np.sqrt(len(a) - 3)
            reg.append(dict(window=w, group=g, var=v, n=len(a), pearson=r, lo=np.tanh(z - 1.96 * se), hi=np.tanh(z + 1.96 * se),
                            p=p, spearman=rs))
reg = pd.DataFrame(reg); reg.round(3).to_csv("out/regional_correlations.csv", index=False)
print("\n=== Regional correlations (n=12)")
print(reg.pivot_table(index=["window", "group"], columns="var", values="pearson").round(2).to_string())
print(reg.pivot_table(index=["window", "group"], columns="var", values="p").round(3).to_string())
