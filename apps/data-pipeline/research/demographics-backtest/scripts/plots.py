import numpy as np, pandas as pd, matplotlib; matplotlib.use("Agg"); import matplotlib.pyplot as plt
from scipy import stats
INK, INK2, GRID, BLUE, ORANGE, AQUA, SURF = "#0b0b0b", "#52514e", "#e4e3df", "#2a78d6", "#eb6834", "#1baf7a", "#fcfcfb"
plt.rcParams.update({"font.size": 10, "axes.edgecolor": GRID, "axes.labelcolor": INK2, "xtick.color": INK2, "ytick.color": INK2,
                     "axes.spines.top": False, "axes.spines.right": False, "figure.facecolor": SURF, "axes.facecolor": SURF})
lvl = pd.read_csv("out/region_relative_level.csv", index_col=0); o = pd.read_csv("out/region_oadr.csv", index_col=0)
lvl.index = lvl.index.astype(int); o.index = o.index.astype(int)
dp = (np.log(lvl.loc[2024:2026].mean()) - np.log(lvl.loc[2010:2012].mean())) * 100
do = o.loc[2026] - o.loc[2010]
r, p = stats.pearsonr(do, dp); print("region dOADR vs d rel level r=%.2f p=%.3f" % (r, p))
pd.DataFrame({"d_oadr_pp_2010_26": do, "d_rel_level_pct": dp, "rel_level_2010_12": lvl.loc[2010:2012].mean(),
              "rel_level_2024_26": lvl.loc[2024:2026].mean()}).round(2).to_csv("out/region_scatter.csv")
fig, ax = plt.subplots(figsize=(7.5, 5))
ax.axhline(0, color=GRID, lw=1, zorder=0); ax.grid(color=GRID, lw=0.6); ax.set_axisbelow(True)
ax.scatter(do, dp, s=64, color=BLUE, edgecolor=SURF, linewidth=2, zorder=3)
for k in dp.index: ax.annotate(k, (do[k], dp[k]), xytext=(6, 4), textcoords="offset points", fontsize=8.5, color=INK)
ax.set_xlabel("Change in old-age dependency ratio 2010–2026 (pp, 65+ per 100 aged 15–64)")
ax.set_ylabel("Change in mix-adjusted price level vs Slovenia\n2010–12 → 2024–26 (%)")
ax.set_title(f"Regions that aged fastest did not lose relative price (r = {r:.2f}, p = {p:.2f}, n = 12)", loc="left", color=INK, fontsize=11)
fig.tight_layout(); fig.savefig("out/fig1_region_ageing_vs_price.png", dpi=150)

u = pd.read_csv("out/univariate_with_controls.csv")
u = u[(u.y == "y_mix") & (u.group == "all") & u["var"].isin(["pressure", "release", "d_oadr", "oadr", "mig_pk"])]
labels = {"pressure": "Demographic pressure", "release": "Released dwellings /1000", "d_oadr": "Pre-window ageing speed",
          "oadr": "Old-age dependency", "mig_pk": "Net migration /1000"}
wins = [("A_2010_15", "2010→15", BLUE), ("B_2015_20", "2015→20", ORANGE), ("C_2020_25", "2020→25", AQUA)]
fig, ax = plt.subplots(figsize=(7.5, 4.6)); ax.axvline(0, color=INK2, lw=1); ax.grid(axis="x", color=GRID, lw=0.6)
vars_ = list(labels)
for j, (w, lab, c) in enumerate(wins):
    t = u[u.window == w].set_index("var").loc[vars_]
    yy = np.arange(len(vars_)) + (j - 1) * 0.22
    ax.errorbar(t.coef, yy, xerr=[t.coef - t.lo, t.hi - t.coef], fmt="o", ms=6, color=c, ecolor=c, elinewidth=2, capsize=0, label=lab,
                markeredgecolor=SURF, markeredgewidth=1.5)
ax.set_yticks(range(len(vars_))); ax.set_yticklabels([labels[v] for v in vars_]); ax.invert_yaxis()
ax.set_xlabel("Effect on relative real price growth (pp per year per 1 SD), 95% CI, with controls")
ax.set_title("Municipal effects are small and flip sign between windows", loc="left", color=INK, fontsize=11)
ax.legend(title="Window", frameon=False, loc="upper left", bbox_to_anchor=(1.0, 1.0)); fig.set_size_inches(8.6, 4.6); fig.tight_layout(); fig.savefig("out/fig2_coefficients_by_window.png", dpi=150)
