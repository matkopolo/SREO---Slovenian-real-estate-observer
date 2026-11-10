"""Human-readable validation reporting for offline valuation-model refreshes."""

from __future__ import annotations

from collections.abc import Mapping
from typing import Any

from .formatting import format_duration


def format_model_report(result: Any) -> str:
    """Format persisted model metrics without implying a single accuracy score."""
    metrics: Mapping[str, Any] = result.metrics
    kind = "sale price/m²" if result.transaction_kind == "sale" else "rent/m²"
    lines = [
        f"Model validation — {kind}",
        f"  version={result.model_version} rows={result.rows:,} "
        f"elapsed={format_duration(result.elapsed_seconds)}",
        "  estimators: hedonic valuation=temporally selected Ridge regression, Elastic Net, "
        "or histogram gradient boosting; anomaly signal=separate Isolation Forest",
        "  untouched latest-complete-year holdout: "
        f"n={int(metrics.get('rows', 0)):,}, "
        f"MAE={_number(metrics.get('mae_amount_per_sqm'))}, "
        f"median APE={_percent(metrics.get('median_absolute_percentage_error'))}, "
        f"log RMSE={_number(metrics.get('rmse_log'), 3)}, "
        f"log R²={_number(metrics.get('r2_log'), 3)}",
        "  split-conformal interval: "
        f"nominal={_percent(metrics.get('nominal_interval_coverage'))}, "
        f"observed={_percent(metrics.get('empirical_interval_coverage'))}",
    ]

    groups = metrics.get("property_groups", {})
    if isinstance(groups, Mapping) and groups:
        lines.append("  property-group diagnostics:")
        for group, raw in sorted(groups.items()):
            if not isinstance(raw, Mapping):
                continue
            temporal = raw.get("final_holdout", {})
            spatial = raw.get("grouped_robustness", {})
            if not isinstance(temporal, Mapping) or not isinstance(spatial, Mapping):
                continue
            model_mae = _as_float(temporal.get("mae_amount_per_sqm"))
            baseline = temporal.get("baseline", {})
            baseline_mae = _as_float(baseline.get("mae_amount_per_sqm")) if isinstance(baseline, Mapping) else None
            improvement = (
                1 - model_mae / baseline_mae
                if model_mae is not None and baseline_mae and baseline_mae > 0
                else None
            )
            spatial_summary = (
                f"grouped R²={_number(spatial.get('r2_log'), 3)} "
                f"across {int(spatial.get('held_out_group_count', 0))} held-out groups"
                if "r2_log" in spatial
                else f"spatial={spatial.get('status', 'unavailable')}"
            )
            lines.append(
                f"    {group}: test n={int(temporal.get('rows', 0)):,}, "
                f"MAE={_number(model_mae)}, median APE="
                f"{_percent(temporal.get('median_absolute_percentage_error'))}, "
                f"log R²={_number(temporal.get('r2_log'), 3)}, "
                f"vs local-median baseline={_signed_percent(improvement)}; "
                f"{spatial_summary}"
            )

    warnings = _warnings(metrics)
    lines.extend(f"  WARNING: {warning}" for warning in warnings)
    lines.append(
        "  Interpretation: validation error and coverage are diagnostics, not a "
        "certified appraisal or a classification accuracy."
    )
    return "\n".join(lines)


def _warnings(metrics: Mapping[str, Any]) -> list[str]:
    warnings: list[str] = []
    coverage = _as_float(metrics.get("empirical_interval_coverage"))
    nominal = _as_float(metrics.get("nominal_interval_coverage"))
    if coverage is not None and nominal is not None and coverage < nominal - 0.03:
        warnings.append("prediction-interval coverage is more than 3 percentage points below nominal")
    groups = metrics.get("property_groups", {})
    if isinstance(groups, Mapping):
        weak = []
        for group, raw in groups.items():
            if not isinstance(raw, Mapping):
                continue
            temporal = raw.get("final_holdout", {})
            spatial = raw.get("grouped_robustness", {})
            if isinstance(temporal, Mapping) and (_as_float(temporal.get("r2_log")) or 0) < 0:
                weak.append(f"{group} temporal")
            if isinstance(spatial, Mapping) and "r2_log" in spatial and (
                _as_float(spatial.get("r2_log")) or 0
            ) < 0:
                weak.append(f"{group} spatial")
        if weak:
            warnings.append("negative log R² (worse than a mean baseline): " + ", ".join(weak))
    return warnings


def _as_float(value: Any) -> float | None:
    return float(value) if isinstance(value, (int, float)) else None


def _number(value: Any, decimals: int = 2) -> str:
    parsed = _as_float(value)
    return "n/a" if parsed is None else f"{parsed:,.{decimals}f}"


def _percent(value: Any) -> str:
    parsed = _as_float(value)
    return "n/a" if parsed is None else f"{100 * parsed:.1f}%"


def _signed_percent(value: float | None) -> str:
    return "n/a" if value is None else f"{100 * value:+.1f}% MAE improvement"
