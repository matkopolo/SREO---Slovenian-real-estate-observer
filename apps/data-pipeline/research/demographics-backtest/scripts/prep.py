"""Parse SURS dumps + ETN sales into tidy panels (municipality x year)."""
import numpy as np, pandas as pd

D = "data/"

def sections(path):
    out, name, cols, rows = {}, None, None, []
    for line in open(path, encoding="utf-8"):
        line = line.rstrip("\n")
        if line.startswith("### "):
            if name: out.setdefault(name, []).append(pd.DataFrame(rows, columns=cols))
            _, name, hdr = line.split(" ", 2); cols = hdr.split("|"); rows = []
        elif line:
            rows.append(line.split("|"))
    out.setdefault(name, []).append(pd.DataFrame(rows, columns=cols))
    return {k: pd.concat(v, ignore_index=True) for k, v in out.items()}

S = {**sections(D + "pop.txt"), **sections(D + "rest.txt")}
for k, v in S.items():
    v["value"] = pd.to_numeric(v["value"].replace("", np.nan))

def mun(s): return s.astype(int)

# ---------- population by 5-year group ----------
p = S["pop"]; p = p[p["POLLETJE"].str.endswith("H1")]
p["mun"] = mun(p["OBČINE"]); p["yr"] = p["POLLETJE"].str[:4].astype(int); p["age"] = p["STAROST"].astype(int)
pw = p.pivot_table(index=["mun", "yr"], columns="age", values="value", aggfunc="sum")
g = lambda a, b: pw[[c for c in range(a, b + 1)]].sum(axis=1, min_count=1)   # codes 1=0-4 ... 21=100+
pop = pd.DataFrame({
    "pop": pw[0], "p0_14": g(1, 3), "p15_64": g(4, 13), "p65": g(14, 21), "p80": g(17, 21),
    "p20_24": g(5, 5), "p25_29": g(6, 6), "p30_34": g(7, 7), "p35_39": g(8, 8), "p20_29": g(5, 6),
    "p25_39": g(6, 8), "p30_39": g(7, 8), "p55_64": g(12, 13), "p75": g(16, 21),
}).reset_index()
pop.to_csv(D + "pop_panel.csv", index=False)

# ---------- municipal deaths (total, <65) ----------
d = S["deaths_mun"]; d["mun"] = mun(d["OBČINE"]); d["yr"] = d["LETO"].astype(int)
dm = d.pivot_table(index=["mun", "yr"], columns="MERITVE", values="value").rename(columns={"1": "deaths", "2": "deaths_u65"})
dm["deaths65"] = dm["deaths"] - dm["deaths_u65"]
dm.reset_index().to_csv(D + "deaths_mun.csv", index=False)

# ---------- regional deaths by age (for 80+ share of 65+ deaths) ----------
r = S["deaths_reg"]; r["reg"] = r["STATISTIČNA REGIJA"].astype(int); r["yr"] = r["LETO"].astype(int)
r.to_csv(D + "deaths_reg.csv", index=False)

# ---------- migration ----------
m = S["migr_mun"]; m["mun"] = mun(m["OBČINE"]); m["yr"] = m["LETO"].astype(int)
mm = m.pivot_table(index=["mun", "yr"], columns="MERITVE", values="value").rename(
    columns={"19": "netmig", "07": "netmig_int", "16": "netmig_dom", "28": "netmig_pk"})
mm.reset_index().to_csv(D + "migr_mun.csv", index=False)

# ---------- census stocks ----------
t = S["tenure"]; t["mun"] = mun(t["OBČINE"])
tw = t.pivot_table(index=["mun", "LETO"], columns="TIP LASTNIŠTVA", values="value").rename(
    columns={"0": "occ_dw", "1": "owner_dw", "3": "rent_dw", "4": "other_dw"}).reset_index()
w = S["dwell"]; w["mun"] = mun(w["OBČINE"])
ww = w[w["NASELJENOST"] == "0"].pivot_table(index=["mun", "LETO"], columns="VRSTA STAVBE", values="value").rename(
    columns={"0": "dw_total", "11": "dw_single", "13": "dw_multi"}).reset_index()
vac = w[(w["VRSTA STAVBE"] == "0")].pivot_table(index=["mun", "LETO"], columns="NASELJENOST", values="value").rename(
    columns={"2": "dw_unocc"})[["dw_unocc"]].reset_index()
stock = tw.merge(ww, on=["mun", "LETO"]).merge(vac, on=["mun", "LETO"]).rename(columns={"LETO": "census"})
stock.to_csv(D + "stock.csv", index=False)

# ---------- wages (net mean, residence) ----------
wg = S["wage"]; wg = wg[wg["MERITVE"] == "1"].copy(); wg["mun"] = mun(wg["OBČINE"]); wg["yr"] = wg["LETO"].astype(int)
wg[["mun", "yr", "value"]].rename(columns={"value": "wage"}).to_csv(D + "wage.csv", index=False)

# ---------- selected indicators (employed by residence) ----------
sl = S["sel"]; sl["mun"] = mun(sl["OBČINE"]); sl["yr"] = sl["LETO"].astype(int)
sl.pivot_table(index=["mun", "yr"], columns="MERITVE", values="value").rename(
    columns={"45": "pop_jan", "50": "sh65", "54": "mean_age", "12": "employed_res"}).reset_index().to_csv(D + "sel.csv", index=False)

S["proj_nat"].to_csv(D + "proj_nat.csv", index=False)
print({k: len(v) for k, v in S.items()})
print(pop[pop.mun == 0].tail(3).T)
