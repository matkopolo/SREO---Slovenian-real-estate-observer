"""Cross-sectional tests: does base-period demography predict later relative real price growth?"""
import numpy as np, pandas as pd, statsmodels.formula.api as smf, statsmodels.api as sm, warnings
warnings.filterwarnings("ignore")
pd.set_option("display.width", 220); pd.set_option("display.max_columns", 40)

data = pd.read_csv("out/dataset.csv").replace([np.inf, -np.inf], np.nan)
MIN_N = 20
DEMO = ["oadr", "d_oadr", "sh80", "release", "hh_form", "cohort", "young_sh", "mig_pk", "pressure_core", "pressure"]
FX = ["fx_d_young", "fx_d_pop", "fx_d_oadr", "fx_mig_pk", "fx_pressure"]
CTRL = "lp0 + lj + coast + tourist + ldist + lpop + multi_sh + lwage0 + wage_g"
CTRL_NOWAGE = "lp0 + lj + coast + tourist + ldist + lpop + multi_sh"

def sample(window, group, y):
    d = data[(data.window == window) & (data.group == group) & (data.n0 >= MIN_N) & (data.n1 >= MIN_N)].copy()
    need = [y, "lp0", "ldist", "lpop", "multi_sh", "lwage0", "wage_g"] + DEMO
    d = d.dropna(subset=need)
    for v in DEMO + FX:   # standardise within sample -> coefficient = pp/yr per 1 SD
        d[v + "_z"] = (d[v] - d[v].mean()) / d[v].std()
    return d

def fit(formula, d, weighted=True):
    if weighted:
        return smf.wls(formula, d, weights=d.w).fit(cov_type="HC3")
    return smf.ols(formula, d).fit(cov_type="HC3")

def table(window, group, y, ctrl=CTRL, weighted=True, extra=None):
    d = sample(window, group, y)
    base = fit(f"{y} ~ {ctrl}", d, weighted)
    out = []
    for v in (extra or DEMO):
        m = fit(f"{y} ~ {ctrl} + {v}_z", d, weighted)
        raw = fit(f"{y} ~ {v}_z", d, weighted)
        b, (lo, hi) = m.params[v + "_z"], m.conf_int().loc[v + "_z"]
        out.append(dict(window=window, group=group, y=y, var=v, n=len(d), coef=b, lo=lo, hi=hi, p=m.pvalues[v + "_z"],
                        raw_coef=raw.params[v + "_z"], raw_p=raw.pvalues[v + "_z"], raw_r2=raw.rsquared,
                        r2_ctrl=base.rsquared, r2_full=m.rsquared, d_adjr2=m.rsquared_adj - base.rsquared_adj))
    return pd.DataFrame(out), base, d

res = []
for w in ["L_2015_25", "A_2010_15", "B_2015_20", "C_2020_25"]:
    for g in ["apartment", "house", "all"]:
        for y in ["y_mix", "y_med"]:
            t, base, d = table(w, g, y)
            res.append(t)
            if w == "L_2015_25" and y == "y_mix":
                print(f"\n=== {w} {g} {y}: controls-only model (WLS, HC3) n={len(d)} R2={base.rsquared:.3f}")
                print(base.summary2().tables[1][["Coef.", "Std.Err.", "P>|z|"]].round(3))
res = pd.concat(res); res.round(3).to_csv("out/univariate_with_controls.csv", index=False)
show = res[res["var"].isin(["oadr", "d_oadr", "release", "hh_form", "mig_pk", "pressure"])]
print("\n=== Demographic coefficient (pp/yr relative growth per 1 SD), with controls, WLS HC3")
print(show.pivot_table(index=["window", "group", "y"], columns="var", values="coef").round(2))
print("\n=== p-values")
print(show.pivot_table(index=["window", "group", "y"], columns="var", values="p").round(3))
print("\n=== raw (no controls) coefficients / R2")
print(show.pivot_table(index=["window", "group", "y"], columns="var", values="raw_coef").round(2))
print(show.pivot_table(index=["window", "group", "y"], columns="var", values="raw_r2").round(3))

# Joint test: all base demography together beyond controls
joint = []
for w in ["L_2015_25", "A_2010_15", "B_2015_20", "C_2020_25"]:
    for g in ["apartment", "house", "all"]:
        for y in ["y_mix", "y_med"]:
            d = sample(w, g, y)
            set_ = ["oadr_z", "d_oadr_z", "release_z", "hh_form_z", "mig_pk_z", "cohort_z"]
            r = fit(f"{y} ~ {CTRL}", d); u = fit(f"{y} ~ {CTRL} + " + " + ".join(set_), d)
            ft = u.wald_test(" , ".join(f"{s} = 0" for s in set_), scalar=True)
            joint.append(dict(window=w, group=g, y=y, n=len(d), r2_ctrl=r.rsquared, r2_full=u.rsquared,
                              adj_ctrl=r.rsquared_adj, adj_full=u.rsquared_adj, wald_p=float(ft.pvalue)))
joint = pd.DataFrame(joint); joint.round(3).to_csv("out/joint_test.csv", index=False)
print("\n=== Joint test of 6 base-period demographic measures beyond controls"); print(joint.round(3))

# Perfect-foresight (realised, contemporaneous) demography - an upper bound for what projections could add
fxr = []
for w in ["L_2015_25", "A_2010_15", "B_2015_20", "C_2020_25"]:
    for g in ["apartment", "house", "all"]:
        t, _, _ = table(w, g, "y_mix", extra=FX); fxr.append(t)
fxr = pd.concat(fxr); fxr.round(3).to_csv("out/foresight.csv", index=False)
print("\n=== Realised (perfect-foresight) demography, with controls: coef / p")
print(fxr.pivot_table(index=["window", "group"], columns="var", values="coef").round(2))
print(fxr.pivot_table(index=["window", "group"], columns="var", values="p").round(3))
print(fxr.pivot_table(index=["window", "group"], columns="var", values="raw_r2").round(3))

# Robustness: unweighted, no wage controls, region FE
rob = []
for spec, ctrl, wt in [("WLS_ctrl", CTRL, True), ("OLS_ctrl", CTRL, False), ("WLS_nowage", CTRL_NOWAGE, True),
                       ("WLS_regionFE", CTRL + " + C(region)", True), ("WLS_minimal", "lp0", True)]:
    for g in ["apartment", "house", "all"]:
        t, _, _ = table("L_2015_25", g, "y_mix", ctrl=ctrl, weighted=wt, extra=["pressure", "oadr", "release", "mig_pk", "hh_form"])
        t["spec"] = spec; rob.append(t)
rob = pd.concat(rob); rob.round(3).to_csv("out/robustness.csv", index=False)
print("\n=== Robustness (L window, y_mix): coef [p]")
rob["cell"] = rob.coef.round(2).astype(str) + " [" + rob.p.round(2).astype(str) + "]"
print(rob.pivot_table(index=["group", "spec"], columns="var", values="cell", aggfunc="first"))

# ---------------- Out-of-sample ----------------
def oos(train_ws, test_w, g, y, feats):
    tr = pd.concat([sample(w, g, y) for w in train_ws]); te = sample(test_w, g, y)
    # standardise with training moments (use raw vars to avoid leakage)
    X = lambda d, f: sm.add_constant(d[f].astype(float), has_constant="add")
    ctrl = ["lp0", "lj", "coast", "tourist", "ldist", "lpop", "multi_sh", "lwage0"]   # wage_g is not known ex ante
    out = {}
    for name, f in [("naive", []), ("ctrl", ctrl), ("ctrl+demo", ctrl + feats), ("demo", feats)]:
        if f:
            m = sm.WLS(tr[y], X(tr, f), weights=tr.w).fit(); pred = m.predict(X(te, f))
        else:
            pred = pd.Series(np.average(tr[y], weights=tr.w), index=te.index)
        out[name] = np.average((te[y] - pred) ** 2, weights=te.w)
    ref = np.average((te[y] - np.average(te[y], weights=te.w)) ** 2, weights=te.w)
    return {k: 1 - v / ref for k, v in out.items()}, len(tr), len(te)

FEATS = {"pressure": ["pressure"], "oadr+release": ["oadr", "release"], "all_demo": ["oadr", "d_oadr", "release", "hh_form", "mig_pk", "cohort"]}
o = []
for train, test in [(["A_2010_15"], "B_2015_20"), (["B_2015_20"], "C_2020_25"), (["A_2010_15", "B_2015_20"], "C_2020_25"),
                    (["A_2010_15"], "C_2020_25")]:
    for g in ["apartment", "house", "all"]:
        for fn, f in FEATS.items():
            r, ntr, nte = oos(train, test, g, "y_mix", f)
            o.append(dict(train="+".join(train), test=test, group=g, feats=fn, ntr=ntr, nte=nte, **r))
o = pd.DataFrame(o); o.round(3).to_csv("out/oos_temporal.csv", index=False)
print("\n=== Out-of-sample R2 vs test-window mean (temporal: fit earlier window, predict later)"); print(o.round(3))

# Leave-one-region-out on the long window
lr = []
for g in ["apartment", "house", "all"]:
    d = sample("L_2015_25", g, "y_mix")
    ctrl = ["lp0", "lj", "coast", "tourist", "ldist", "lpop", "multi_sh", "lwage0"]
    for fn, f in FEATS.items():
        err = {"ctrl": [], "ctrl+demo": [], "naive": []}; wts = []
        for reg in sorted(d.region.dropna().unique()):
            tr, te = d[d.region != reg], d[d.region == reg]
            for name, ff in [("ctrl", ctrl), ("ctrl+demo", ctrl + f)]:
                m = sm.WLS(tr["y_mix"], sm.add_constant(tr[ff]), weights=tr.w).fit()
                err[name].extend(list((te.y_mix - m.predict(sm.add_constant(te[ff], has_constant="add"))) ** 2))
            err["naive"].extend(list((te.y_mix - np.average(tr.y_mix, weights=tr.w)) ** 2)); wts.extend(list(te.w))
        mse = {k: np.average(v, weights=wts) for k, v in err.items()}
        lr.append(dict(group=g, feats=fn, n=len(d), r2_ctrl=1 - mse["ctrl"] / mse["naive"],
                       r2_ctrl_demo=1 - mse["ctrl+demo"] / mse["naive"]))
lr = pd.DataFrame(lr); lr.round(3).to_csv("out/oos_loro.csv", index=False)
print("\n=== Leave-one-region-out R2 (vs training mean), L window"); print(lr.round(3))
