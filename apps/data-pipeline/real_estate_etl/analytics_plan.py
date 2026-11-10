"""The analytical refresh stages, in dependency order, and their documented effects.

Each entry names a PostgreSQL function in the ``analytics`` schema. The stages run
sequentially inside one transaction (see :func:`operations.refresh_analytics`).
"""

from __future__ import annotations

import textwrap

ANALYTICS_REFRESH_FUNCTIONS = (
    "analytics.refresh_sale_facts",
    "analytics.refresh_land_transaction_facts",
    "analytics.refresh_sale_outliers",
    "analytics.refresh_rental_facts",
    "analytics.refresh_rental_outliers",
    "analytics.refresh_anomaly_signals",
    "analytics.refresh_near_duplicate_candidates",
    "analytics.refresh_repeat_sales_indices",
)

ANALYTICS_STAGE_DESCRIPTIONS = {
    "analytics.refresh_sale_facts": (
        "build one quality-audited analytical fact per sale agreement from its "
        "building parts and parcels; source transactions remain unchanged"
    ),
    "analytics.refresh_land_transaction_facts": (
        "classify land-only sales into strict, broad, and audit populations "
        "using the preserved ETN land codes"
    ),
    "analytics.refresh_sale_outliers": (
        "recalculate robust sale cohorts and representative-sample flags; "
        "statistical outliers are marked, not deleted"
    ),
    "analytics.refresh_rental_facts": (
        "build one quality-audited analytical fact per rental agreement from "
        "the preserved rental transactions and components"
    ),
    "analytics.refresh_rental_outliers": (
        "recalculate robust rental cohorts and representative-sample flags; "
        "statistical outliers are marked, not deleted"
    ),
    "analytics.refresh_anomaly_signals": (
        "combine quality, robust-cohort, duplicate, spatial, and available "
        "model evidence into non-destructive review signals"
    ),
    "analytics.refresh_near_duplicate_candidates": (
        "identify explainable possible duplicate transaction pairs within the "
        "configured seven-day and similarity rules"
    ),
    "analytics.refresh_repeat_sales_indices": (
        "rebuild eligible repeat-sale pairs and their published market-index "
        "vintages from representative transactions"
    ),
}

ANALYTICS_STAGE_DATABASE_EFFECTS = {
    "analytics.refresh_sale_facts": (
        (
            "analytics.sale_facts",
            "rebuilds derived sale facts, prices, areas, quality reasons, "
                "and geography; raw transactions are unchanged",
        ),
    ),
    "analytics.refresh_land_transaction_facts": (
        (
            "analytics.land_transaction_facts",
            "rebuilds land-only analytical rows and their strict, broad, and audit eligibility flags",
        ),
    ),
    "analytics.refresh_sale_outliers": (
        (
            "analytics.sale_outlier_evaluations",
            "rebuilds cohort status, bounds, modified z-score, and the outlier decision for every sale fact",
        ),
        (
            "analytics.sale_facts",
            "updates quality eligibility/reasons for implausible values and sets "
                "representative_eligible from the outlier decision; no sale is deleted",
        ),
    ),
    "analytics.refresh_rental_facts": (
        (
            "analytics.rental_facts",
            "rebuilds derived rental facts, rents, areas, quality reasons, and "
                "geography; raw rental agreements are unchanged",
        ),
    ),
    "analytics.refresh_rental_outliers": (
        (
            "analytics.rental_outlier_evaluations",
            "rebuilds cohort status, bounds, modified z-score, and the outlier decision for every rental fact",
        ),
        (
            "analytics.rental_facts",
            "sets representative_eligible from quality eligibility and the "
                "outlier decision; no rental agreement is deleted",
        ),
    ),
    "analytics.refresh_anomaly_signals": (
        (
            "analytics.anomaly_signals",
            "upserts non-destructive anomaly flags, component scores, reasons, "
                "and combined review scores; stale signals are removed",
        ),
    ),
    "analytics.refresh_near_duplicate_candidates": (
        (
            "analytics.near_duplicate_candidates",
            "rebuilds auditable candidate pairs and identifies only the later record as the possible duplicate",
        ),
        (
            "analytics.anomaly_signals",
            "updates possible_duplicate, duplicate_score, reasons, and the combined review score",
        ),
    ),
    "analytics.refresh_repeat_sales_indices": (
        (
            "analytics.repeat_sale_pairs",
            "rebuilds eligible consecutive repeat-sale pairs",
        ),
        (
            "analytics.index_calculation_runs",
            "records the repeat-sale index calculation run and data vintage",
        ),
        (
            "analytics.market_indices",
            "stores the resulting repeat-sale index series, sample sizes, and intervals",
        ),
    ),
}


def format_analytics_plan(functions: tuple[str, ...]) -> str:
    """Describe every stage and its database effects before the refresh starts."""
    width = 88
    lines = [
        " ANALYTICS REFRESH PLAN ".center(width, "="),
        (
            f"[analytics] execution plan: {len(functions)} sequential stages; "
            "database refresh stages do not run in parallel"
        ),
        "-" * width,
    ]
    for position, function in enumerate(functions, start=1):
        label = function.rsplit(".", 1)[-1]
        if position > 1:
            lines.append("")
        lines.append(f"[analytics] {position}/{len(functions)} {label}")
        description = ANALYTICS_STAGE_DESCRIPTIONS.get(function)
        if description:
            lines.extend(
                textwrap.wrap(
                    f"Action: {description}",
                    width=width,
                    initial_indent="  ",
                    subsequent_indent="          ",
                )
            )
        effects = ANALYTICS_STAGE_DATABASE_EFFECTS.get(function)
        if effects:
            lines.append("  Database effects:")
            for table, effect in effects:
                lines.extend(
                    textwrap.wrap(
                        f"- {table}: {effect}",
                        width=width,
                        initial_indent="    ",
                        subsequent_indent="      ",
                    )
                )
    lines.extend(["-" * width, " END ANALYTICS REFRESH PLAN ".center(width, "=")])
    return "\n".join(lines)
