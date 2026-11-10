import numpy as np, pandas as pd
from scipy import stats
d = pd.read_csv("out/dataset.csv")
for g in ["apartment","house","all"]:
    x = d[(d.group==g)&(d.n0>=20)&(d.n1>=20)].pivot_table(index="mun", columns="window", values="y_mix")
    print(g, "corr A,B", round(x[["A_2010_15","B_2015_20"]].dropna().corr().iloc[0,1],2),
          "corr B,C", round(x[["B_2015_20","C_2020_25"]].dropna().corr().iloc[0,1],2),
          "corr A,C", round(x[["A_2010_15","C_2020_25"]].dropna().corr().iloc[0,1],2))
# annual mix-adjusted relative level by region (re-run mix model cheaply: median of resid stored? recompute)
import statsmodels.formula.api as smf
s = pd.read_csv("data/sales.csv"); s = s[(s.ppsqm>150)&(s.ppsqm<20000)&(s.area>=15)&(s.area<=600)&(s.yr>=2008)&(s.yr<=2026)].copy()
s["lp"]=np.log(s.ppsqm); s["la"]=np.log(s.area)
s["cyb"]=pd.cut(s.cy,[0,1945,1960,1970,1980,1990,2000,2010,2030],labels=False).fillna(-1).astype(int).astype(str)
m = smf.ols("lp ~ C(yr):C(pg) + C(pg):la + C(pg):I(la**2) + C(pg):C(cyb)", data=s).fit(); s["r"]=m.resid
names = {1:"Pomurska",2:"Podravska",3:"Koroška",4:"Savinjska",5:"Zasavska",6:"Posavska",7:"Jugovzhodna",8:"Osrednjeslovenska",9:"Gorenjska",10:"Primorsko-notranjska",11:"Goriška",12:"Obalno-kraška"}
lvl = s.groupby(["yr","reg"]).r.median().unstack()
lvl = (np.exp(lvl)*100).rename(columns=names).round(1); lvl.to_csv("out/region_relative_level.csv"); print(lvl.to_string())
# OADR by region-year for context
p = pd.read_csv("data/pop_panel.csv"); mu = pd.read_csv("data/muni.csv").set_index("code").reg
p["reg"]=p.mun.map(mu); a=p[p.mun>0].groupby(["yr","reg"])[["p65","p15_64"]].sum(); o=(a.p65/a.p15_64*100).unstack().rename(columns=names).round(1)
o.to_csv("out/region_oadr.csv"); print(o.loc[[2008,2015,2020,2026]].T)
