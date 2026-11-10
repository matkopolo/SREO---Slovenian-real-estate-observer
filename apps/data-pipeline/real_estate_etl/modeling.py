"""Versioned hedonic residual and Isolation Forest anomaly scoring.

``refresh_models`` trains the sale and then the rent population and persists both in
one transaction: a failure in either leaves every model table, prediction, anomaly
score and index exactly as it was. Called inside the system refresh, that transaction
is a savepoint of the release transaction.
"""

from __future__ import annotations

import json
import logging
import os
import textwrap
import time
import uuid
from collections import Counter
from collections.abc import Iterator
from concurrent.futures import ThreadPoolExecutor, as_completed
from dataclasses import dataclass
from datetime import UTC, date, datetime

import numpy as np
import psycopg
from psycopg import sql
from sklearn.ensemble import IsolationForest
from sklearn.pipeline import Pipeline

from .formatting import format_duration
from .model_features import FEATURE_INDEX, MODEL_FEATURES, feature_preprocessor
from .model_selection import SelectionSettings, build_pipeline, optimize_model
from .model_validation import NOMINAL_INTERVAL_COVERAGE, percentile_scores
from .settings import DEFAULT_WORKERS, MODEL_RANDOM_SEED, RENT_START_YEAR, SALES_START_YEAR

logger = logging.getLogger(__name__)

RANDOM_SEED = MODEL_RANDOM_SEED
ISOLATION_TRAINING_LIMIT = 50_000
ISOLATION_ESTIMATORS = 150
MIN_POPULATION_ROWS = 100
#: Percentile score at or above which a model signal raises its anomaly flag.
MODEL_FLAG_THRESHOLD = 0.99
INDEX_MIN_PERIOD_OBSERVATIONS = 30
INDEX_BOOTSTRAP_REPLICATES = 100
INDEX_REFERENCE_SIZE = 5_000
INDEX_METHODOLOGY = "constant-quality-ridge-v2"
MODEL_VERSION_PREFIX = "selected-hedonic-iforest-v3"

PROPERTY_GROUP = FEATURE_INDEX["property_group"]
CONTRACT_YEAR = FEATURE_INDEX["contract_year"]
CONTRACT_MONTH = FEATURE_INDEX["contract_month"]

#: SQL expression for each feature; the SELECT lists them in MODEL_FEATURES order.
FEATURE_SQL = {
    "log_area": "ln(area::float8)",
    "construction_year": "construction_year::float8",
    "contract_year": "extract(year FROM contract_date)::float8",
    "contract_month": "extract(month FROM contract_date)::float8",
    "centroid_e": "ST_X(location)::float8",
    "centroid_n": "ST_Y(location)::float8",
    "property_group": "property_group",
    "municipality_id": "coalesce(municipality_id,0)::text",
}
#: Column layout of a training-query row.
TRAINING_COLUMNS = ("transaction_id", "target", *MODEL_FEATURES, "contract_date", "building_identity")
_FEATURES_START = TRAINING_COLUMNS.index(MODEL_FEATURES[0])
_FEATURES_END = _FEATURES_START + len(MODEL_FEATURES)
_CONTRACT_DATE = TRAINING_COLUMNS.index("contract_date")
_BUILDING_IDENTITY = TRAINING_COLUMNS.index("building_identity")


@dataclass(frozen=True)
class ModelPopulation:
    kind: str
    table: tuple[str, str]
    target_column: str
    start_year: int
    land_population: str | None


POPULATIONS = {
    "sale": ModelPopulation(
        "sale", ("analytics", "sale_facts_strict_land"), "price_per_sqm", SALES_START_YEAR, "strict_etn_codes_1_2",
    ),
    "rent": ModelPopulation(
        "rent", ("analytics", "rental_facts"), "monthly_rent_per_sqm", RENT_START_YEAR, None,
    ),
}


def _environment_flag(name: str) -> bool:
    return os.getenv(name, "").strip().lower() in {"1", "true", "yes", "on"}


@dataclass(frozen=True)
class ModelResult:
    transaction_kind: str
    rows: int
    model_version: str
    elapsed_seconds: float
    metrics: dict[str, object]


@dataclass(frozen=True)
class PropertyGroupResult:
    group: str
    indices: np.ndarray
    predictions: np.ndarray
    interval_widths: np.ndarray
    residual_scores: np.ndarray
    model: Pipeline
    metrics: dict[str, object]


@dataclass(frozen=True)
class TrainingFrame:
    """One population's training rows as aligned arrays."""

    transaction_ids: np.ndarray
    target: np.ndarray  # natural log of the amount per m²
    features: np.ndarray  # MODEL_FEATURES columns, dtype=object
    contract_dates: list[date]
    building_identities: np.ndarray

    @property
    def rows(self) -> int:
        return len(self.transaction_ids)

    @property
    def property_groups(self) -> np.ndarray:
        return self.features[:, PROPERTY_GROUP]


@dataclass(frozen=True)
class ModelScores:
    """Per-row production outputs aligned with a :class:`TrainingFrame`."""

    fitted_log: np.ndarray
    interval_widths: np.ndarray
    residual_scores: np.ndarray
    isolation_scores: np.ndarray


def _train_property_group(
    kind: str,
    group: str,
    group_number: int,
    group_count: int,
    features: np.ndarray,
    target: np.ndarray,
    contract_dates: list[date],
    building_identities: np.ndarray,
    property_groups: np.ndarray,
    settings: SelectionSettings,
) -> PropertyGroupResult:
    group_indices = np.flatnonzero(property_groups == group)
    group_features = features[group_indices]
    group_target = target[group_indices]
    group_dates = [contract_dates[index] for index in group_indices]
    prefix = f"[{kind} model · {group} · group {group_number}/{group_count}]"
    logger.info("%s population=%s rows", prefix, f"{len(group_indices):,}")
    robustness_groups = building_identities[group_indices].copy()
    missing_identity = np.asarray([not value for value in robustness_groups])
    robustness_groups[missing_identity] = np.asarray(
        [f"municipality:{value}" for value in group_features[missing_identity, FEATURE_INDEX["municipality_id"]]],
        dtype=object,
    )
    selection = optimize_model(
        group_features,
        group_target,
        group_dates,
        robustness_groups,
        settings,
        progress=lambda message: logger.info("%s %s", prefix, message),
    )
    predictions = np.empty(len(group_indices), dtype=float)
    widths = np.empty(len(group_indices), dtype=float)
    residuals = np.zeros(len(group_indices), dtype=float)
    if selection["status"] != "selected":
        fallback = build_pipeline({"family": "ridge", "alpha": 2.0}, RANDOM_SEED)
        logger.info("%s fitting sparse-group production fallback", prefix)
        production_started = time.monotonic()
        fallback.fit(group_features, group_target)
        production_training_seconds = time.monotonic() - production_started
        production_started = time.monotonic()
        predictions[:] = fallback.predict(group_features)
        production_prediction_seconds = time.monotonic() - production_started
        widths[:] = float(np.quantile(
            np.abs(group_target - predictions), NOMINAL_INTERVAL_COVERAGE
        ))
        metrics = {
            **selection,
            "population_rows": len(group_indices),
            "production_fallback": {"family": "ridge", "alpha": 2.0},
            "production": {
                "training_rows": len(group_indices),
                "training_seconds": production_training_seconds,
                "prediction_seconds": production_prediction_seconds,
            },
            "interval_status": "uncalibrated_sparse_group_fallback",
        }
        return PropertyGroupResult(
            group, group_indices, predictions, widths, residuals, fallback, metrics
        )

    widths[:] = float(selection["interval_half_width_log"])
    final_model = build_pipeline(selection["selected_configuration"], RANDOM_SEED)
    logger.info("%s fitting selected production model", prefix)
    production_started = time.monotonic()
    final_model.fit(group_features, group_target)
    production_training_seconds = time.monotonic() - production_started
    production_started = time.monotonic()
    predictions[:] = final_model.predict(group_features)
    production_prediction_seconds = time.monotonic() - production_started
    holdout_year = selection["final_holdout_year"]
    holdout_indices = np.flatnonzero(
        np.asarray([value.year for value in group_dates]) == holdout_year
    )
    holdout_prediction = final_model.predict(group_features[holdout_indices])
    residuals[holdout_indices] = percentile_scores(
        np.abs(group_target[holdout_indices] - holdout_prediction)
    )
    metrics = {
        "population_rows": len(group_indices),
        **selection,
        "production": {
            "training_rows": len(group_indices),
            "training_seconds": production_training_seconds,
            "prediction_seconds": production_prediction_seconds,
        },
    }
    return PropertyGroupResult(
        group, group_indices, predictions, widths, residuals, final_model, metrics
    )


def _train_property_groups(
    kind: str,
    groups: list[str],
    workers: int,
    features: np.ndarray,
    target: np.ndarray,
    contract_dates: list[date],
    building_identities: np.ndarray,
    property_groups: np.ndarray,
    settings: SelectionSettings,
) -> list[PropertyGroupResult]:
    group_workers = min(workers, len(groups))
    logger.info(
        "[%s model] property groups=%s; parallel workers=%s; database persistence remains single-threaded",
        kind, len(groups), group_workers,
    )
    started = time.monotonic()
    results: list[PropertyGroupResult] = []
    with ThreadPoolExecutor(
        max_workers=group_workers, thread_name_prefix=f"{kind}-model"
    ) as executor:
        futures = [
            executor.submit(
                _train_property_group,
                kind,
                group,
                number,
                len(groups),
                features,
                target,
                contract_dates,
                building_identities,
                property_groups,
                settings,
            )
            for number, group in enumerate(groups, start=1)
        ]
        for completed, future in enumerate(as_completed(futures), start=1):
            results.append(future.result())
            elapsed = time.monotonic() - started
            remaining = elapsed / completed * (len(groups) - completed)
            logger.info(
                "[%s model] group completion %s/%s (%.1f%%); elapsed=%s; ETA=%s",
                kind, completed, len(groups), 100 * completed / len(groups),
                format_duration(elapsed), format_duration(remaining),
            )
    return results


MODEL_KIND_DESCRIPTIONS = {
    "sale": (
        "learn sale price per m² separately for each property group from "
        "quality-eligible, de-duplicated transactions (strict ETN land rules); "
        "select and calibrate with time-ordered validation before production fitting"
    ),
    "rent": (
        "learn monthly rent per m² separately for each supported property group "
        "from quality-eligible, de-duplicated agreements; select and calibrate "
        "with time-ordered validation before production fitting"
    ),
}

MODEL_DATABASE_EFFECTS = (
    ("analytics.model_runs", "inserts immutable model configuration, validation "
        "metrics, periods, and training metadata"),
    ("analytics.valuation_predictions", "inserts versioned production predictions and conformal "
        "ranges without overwriting earlier model runs"),
    ("analytics.anomaly_signals", "updates model-residual and Isolation Forest evidence "
        "while preserving reviewed anomaly metadata"),
    ("analytics.index_calculation_runs", "records the hedonic-index calculation run and data vintage"),
    ("analytics.market_indices", "stores versioned hedonic index values, intervals, and sample sizes"),
    ("analytics.model_publications", "activates the completed sale and rent model runs "
        "together only after both populations succeed"),
    ("analytics.pipeline_state", "records completion of the initial model bootstrap and the published model version"),
)


def _training_query(population: ModelPopulation) -> sql.Composed:
    """Quality-eligible, de-duplicated rows in TRAINING_COLUMNS order; binds ``kind`` and ``minimum_date``."""
    return sql.SQL(
        """
        SELECT transaction_id,{target}::float8,{features},contract_date,
          CASE WHEN cadastral_municipality_code IS NOT NULL
                     AND building_number IS NOT NULL
               THEN concat(cadastral_municipality_code,':',building_number)
               ELSE NULL END building_identity
        FROM {table} facts
        WHERE is_quality_eligible AND {target}>0 AND area>0
          AND contract_date IS NOT NULL
          AND contract_date>=%(minimum_date)s
          AND NOT EXISTS (
            SELECT 1 FROM analytics.near_duplicate_candidates duplicate
            WHERE duplicate.transaction_kind=%(kind)s
              AND duplicate.candidate_transaction_id=facts.transaction_id
          )
        ORDER BY contract_date,transaction_id
        """
    ).format(
        target=sql.Identifier(population.target_column),
        features=sql.SQL(",").join(sql.SQL(FEATURE_SQL[name]) for name in MODEL_FEATURES),
        table=sql.Identifier(*population.table),
    )


def _format_model_plan(workers: int) -> str:
    width = 88
    lines = [
        " VALUATION MODEL TRAINING PLAN ".center(width, "="),
        "[models] ordered execution plan: 2 transaction populations; sale completes before rent starts",
        "-" * width,
    ]
    for kind_number, kind in enumerate(POPULATIONS, start=1):
        if kind_number > 1:
            lines.append("")
        lines.append(f"[models] {kind_number}/2 {kind} model")
        lines.extend(textwrap.wrap(
            f"Action: {MODEL_KIND_DESCRIPTIONS[kind]}",
            width=width, initial_indent="  ", subsequent_indent="          ",
        ))
        lines.append("  Database effects:")
        for table, effect in MODEL_DATABASE_EFFECTS:
            lines.extend(textwrap.wrap(
                f"- {table}: {effect}", width=width, initial_indent="    ", subsequent_indent="      ",
            ))
    lines.extend([
        "-" * width,
        (
            "[models] concurrency: sale and rent are sequential; within the active "
            f"population, up to {workers} property groups may train in parallel"
        ),
        " END VALUATION MODEL TRAINING PLAN ".center(width, "="),
    ])
    return "\n".join(lines)


def refresh_models(connection: psycopg.Connection, workers: int | None = None) -> list[ModelResult]:
    """Train and publish the sale and rent models atomically (all or nothing)."""
    workers = workers or DEFAULT_WORKERS
    results: list[ModelResult] = []
    all_started = time.monotonic()
    logger.info("%s", _format_model_plan(workers), extra={"plain_block": True})
    with connection.transaction():
        for kind_number, kind in enumerate(POPULATIONS, start=1):
            logger.info("[models] transaction kind %s/2 starting: %s", kind_number, kind)
            results.append(_refresh_kind(connection, kind, workers))
            elapsed = time.monotonic() - all_started
            remaining = elapsed / kind_number * (2 - kind_number)
            logger.info(
                "[models] transaction kind completion %s/2 (%.1f%%); elapsed=%s; ETA=%s",
                kind_number, 50 * kind_number, format_duration(elapsed), format_duration(remaining),
            )
        with connection.cursor() as cursor:
            cursor.execute(
                """
                UPDATE analytics.pipeline_state
                SET model_bootstrap_completed_at=now(),
                    model_bootstrap_version=%s
                WHERE singleton
                """,
                (",".join(result.model_version for result in results),),
            )
            cursor.executemany(
                """
                INSERT INTO analytics.model_publications(
                    transaction_kind,model_run_id,activated_at
                )
                SELECT %s,id,clock_timestamp() FROM analytics.model_runs
                WHERE transaction_kind=%s AND model_version=%s
                ON CONFLICT(transaction_kind) DO UPDATE SET
                    model_run_id=excluded.model_run_id,
                    activated_at=excluded.activated_at
                """,
                [(result.transaction_kind, result.transaction_kind, result.model_version) for result in results],
            )
    logger.info("[models] published %s", ", ".join(result.model_version for result in results))
    return results


def _load_training_frame(connection: psycopg.Connection, population: ModelPopulation) -> TrainingFrame:
    with connection.cursor() as cursor:
        cursor.execute(
            _training_query(population),
            {"kind": population.kind, "minimum_date": date(population.start_year, 1, 1)},
        )
        rows = cursor.fetchall()
    if len(rows) < MIN_POPULATION_ROWS:
        raise RuntimeError(
            f"{population.kind} model requires at least {MIN_POPULATION_ROWS} eligible rows; found {len(rows)}"
        )
    return TrainingFrame(
        transaction_ids=np.asarray([row[0] for row in rows], dtype=np.int64),
        target=np.log(np.asarray([row[1] for row in rows], dtype=float)),
        features=np.asarray([row[_FEATURES_START:_FEATURES_END] for row in rows], dtype=object),
        contract_dates=[row[_CONTRACT_DATE] for row in rows],
        building_identities=np.asarray([row[_BUILDING_IDENTITY] for row in rows], dtype=object),
    )


def _selection_settings() -> SelectionSettings:
    return SelectionSettings(
        min_training_rows=int(os.getenv("MODEL_MIN_TRAINING_ROWS", "100")),
        min_calibration_rows=int(os.getenv("MODEL_MIN_CALIBRATION_ROWS", "30")),
        min_validation_rows=int(os.getenv("MODEL_MIN_VALIDATION_ROWS", "30")),
        random_seed=RANDOM_SEED,
        detailed_progress=_environment_flag("MODEL_DETAILED_PROGRESS"),
    )


def _fit_isolation_forest(
    kind: str, frame: TrainingFrame, workers: int, generator: np.random.Generator,
) -> np.ndarray:
    """Percentile Isolation Forest scores, ranked within each property group."""
    logger.info("[%s model] fitting separate Isolation Forest", kind)
    isolation_features = np.column_stack([frame.target, frame.features])
    transformed = feature_preprocessor(offset=1).fit_transform(isolation_features)
    training_size = min(ISOLATION_TRAINING_LIMIT, frame.rows)
    training_indices = generator.choice(frame.rows, size=training_size, replace=False)
    isolation = IsolationForest(
        n_estimators=ISOLATION_ESTIMATORS,
        max_samples="auto",
        contamination="auto",
        random_state=RANDOM_SEED,
        n_jobs=workers,
    )
    isolation.fit(transformed[training_indices])
    raw_scores = -isolation.score_samples(transformed)
    scores = np.empty(frame.rows, dtype=float)
    groups = frame.property_groups
    for group in sorted(set(groups)):
        group_indices = np.flatnonzero(groups == group)
        scores[group_indices] = percentile_scores(raw_scores[group_indices])
    return scores


def _aggregate_metrics(
    group_metrics: dict[str, dict[str, object]], workers: int, group_workers: int,
) -> dict[str, object]:
    """Row-weighted holdout metrics across the property groups that selected a model."""
    selected = [value for value in group_metrics.values() if value.get("status") == "selected"]
    holdout_rows = sum(value["final_holdout"]["holdout_rows"] for value in selected)

    def weighted_holdout(metric: str) -> float | None:
        if not holdout_rows:
            return None
        return float(sum(
            value["final_holdout"][metric] * value["final_holdout"]["holdout_rows"] for value in selected
        ) / holdout_rows)

    return {
        "rows": holdout_rows,
        "mae_amount_per_sqm": weighted_holdout("mae_amount_per_sqm"),
        "median_absolute_percentage_error": weighted_holdout("median_absolute_percentage_error"),
        "rmse_log": weighted_holdout("rmse_log"),
        "r2_log": weighted_holdout("r2_log"),
        "empirical_interval_coverage": weighted_holdout("empirical_interval_coverage"),
        "nominal_interval_coverage": NOMINAL_INTERVAL_COVERAGE,
        "interval_method": "split_conformal_absolute_log_residual",
        "validation_method": "rolling_expanding_temporal_cv_plus_untouched_latest_complete_year",
        "training_parallelism": {
            "requested_workers": workers,
            "property_group_workers": group_workers,
            "database_persistence_workers": 1,
            "native_threads_per_fit": 1,
        },
        "property_groups": group_metrics,
        "excluded_rows_and_reasons": {
            "quality_ineligible": "excluded_by_is_quality_eligible",
            "missing_or_nonpositive_target_or_area": "excluded_before_training",
            "current_calendar_year": "excluded_from_validation_but_included_in_production_fit",
            "near_duplicates": "higher_transaction_id_in_each_persisted_candidate_pair_excluded",
            "strict_land": "default sale view permits only verified-buildable ETN land codes 1 and 2",
        },
    }


def _refresh_kind(connection: psycopg.Connection, kind: str, workers: int) -> ModelResult:
    """Train one population and persist its run, predictions, anomaly scores and indices."""
    started = time.monotonic()
    population = POPULATIONS[kind]
    frame = _load_training_frame(connection, population)
    groups = sorted(str(value) for value in set(frame.property_groups))
    fitted_log = np.empty(frame.rows, dtype=float)
    interval_widths = np.empty(frame.rows, dtype=float)
    residual_scores = np.zeros(frame.rows, dtype=float)
    group_metrics: dict[str, dict[str, object]] = {}
    final_models: dict[str, Pipeline] = {}
    for result in _train_property_groups(
        kind, groups, workers, frame.features, frame.target, frame.contract_dates,
        frame.building_identities, frame.property_groups, _selection_settings(),
    ):
        fitted_log[result.indices] = result.predictions
        interval_widths[result.indices] = result.interval_widths
        residual_scores[result.indices] = result.residual_scores
        final_models[result.group] = result.model
        group_metrics[result.group] = result.metrics

    generator = np.random.default_rng(RANDOM_SEED)
    scores = ModelScores(
        fitted_log, interval_widths, residual_scores,
        _fit_isolation_forest(kind, frame, workers, generator),
    )
    metrics = _aggregate_metrics(group_metrics, workers, min(workers, len(groups)))
    version = f"{kind}-{MODEL_VERSION_PREFIX}-{datetime.now(UTC):%Y%m%dT%H%M%SZ}"
    model_run_id = uuid.uuid4()
    logger.info("[%s model] persisting model run %s (%s) and production predictions", kind, version, model_run_id)
    with connection.transaction(), connection.cursor() as cursor:
        _persist_model_run(cursor, population, model_run_id, version, frame, metrics, group_metrics)
        _persist_scores(cursor, kind, model_run_id, frame, scores)
        _update_anomaly_signals(cursor, kind, version)
        _persist_hedonic_indices(cursor, population, model_run_id, frame, final_models, generator)
    return ModelResult(
        transaction_kind=kind,
        rows=frame.rows,
        model_version=version,
        elapsed_seconds=time.monotonic() - started,
        metrics=metrics,
    )


def _persist_model_run(
    cursor: psycopg.Cursor,
    population: ModelPopulation,
    model_run_id: uuid.UUID,
    version: str,
    frame: TrainingFrame,
    metrics: dict[str, object],
    group_metrics: dict[str, dict[str, object]],
) -> None:
    feature_schema = {
        "hedonic": MODEL_FEATURES,
        "targetTransformation": "natural_log_amount_per_sqm",
        "isolationForest": ["log_amount_per_sqm", *MODEL_FEATURES],
        "separateModelPerPropertyGroup": True,
        "isolationTrainingLimit": ISOLATION_TRAINING_LIMIT,
        "validation": {
            "temporal": "expanding_window_cv_untouched_latest_complete_year",
            "grouped": "building_identity_then_municipality_group_holdout",
            "interval": "split_conformal_absolute_log_residual",
            "nominalCoverage": NOMINAL_INTERVAL_COVERAGE,
        },
        "landPopulation": population.land_population,
    }
    selection_metadata = {
        group: {key: value for key, value in result.items() if key != "final_holdout"}
        for group, result in group_metrics.items()
    }
    final_holdout = {
        group: result.get("final_holdout")
        for group, result in group_metrics.items()
        if result.get("status") == "selected"
    }
    cursor.execute(
        """
        INSERT INTO analytics.model_runs(
            id,transaction_kind,model_version,model_type,feature_schema,
            training_rows,training_from,training_to,metrics,random_seed,
            selection_metadata,final_holdout_metrics
        ) VALUES(%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)
        """,
        (
            model_run_id, population.kind, version, "selected_log_hedonic_plus_isolation_forest",
            json.dumps(feature_schema), frame.rows, min(frame.contract_dates), max(frame.contract_dates),
            json.dumps(metrics), RANDOM_SEED, json.dumps(selection_metadata), json.dumps(final_holdout),
        ),
    )


def _persist_scores(
    cursor: psycopg.Cursor, kind: str, model_run_id: uuid.UUID, frame: TrainingFrame, scores: ModelScores,
) -> None:
    """Stage per-row scores in ``model_scores`` and insert the versioned predictions."""
    predicted = np.exp(scores.fitted_log)
    lower = np.exp(scores.fitted_log - scores.interval_widths)
    upper = np.exp(scores.fitted_log + scores.interval_widths)
    actual = np.exp(frame.target)
    cursor.execute("DROP TABLE IF EXISTS model_scores")
    cursor.execute(
        """
        CREATE TEMP TABLE model_scores(
            transaction_id bigint,
            predicted numeric,
            lower_bound numeric,
            upper_bound numeric,
            actual numeric,
            log_residual numeric,
            residual_score numeric,
            isolation_score numeric
        ) ON COMMIT DROP
        """
    )
    with cursor.copy(
        """
        COPY model_scores(
            transaction_id,predicted,lower_bound,upper_bound,actual,
            log_residual,residual_score,isolation_score
        ) FROM STDIN
        """
    ) as copy:
        for index, transaction_id in enumerate(frame.transaction_ids):
            copy.write_row((
                int(transaction_id),
                float(predicted[index]),
                float(lower[index]),
                float(upper[index]),
                float(actual[index]),
                float(frame.target[index] - scores.fitted_log[index]),
                float(scores.residual_scores[index]),
                float(scores.isolation_scores[index]),
            ))
    cursor.execute(
        """
        INSERT INTO analytics.valuation_predictions(
            transaction_kind,transaction_id,model_run_id,
            predicted_amount_per_sqm,lower_amount_per_sqm,
            upper_amount_per_sqm,actual_amount_per_sqm,log_residual
        )
        SELECT %s,transaction_id,%s,predicted,lower_bound,upper_bound,
               actual,log_residual
        FROM model_scores
        ON CONFLICT(transaction_kind,transaction_id,model_run_id) DO UPDATE SET
            predicted_amount_per_sqm=excluded.predicted_amount_per_sqm,
            lower_amount_per_sqm=excluded.lower_amount_per_sqm,
            upper_amount_per_sqm=excluded.upper_amount_per_sqm,
            actual_amount_per_sqm=excluded.actual_amount_per_sqm,
            log_residual=excluded.log_residual,
            scored_at=now()
        """,
        (kind, model_run_id),
    )


def _update_anomaly_signals(cursor: psycopg.Cursor, kind: str, version: str) -> None:
    """Attach model evidence to scored rows and clear it from rows the model did not score.

    The combined review score comes from ``analytics.anomaly_review_score`` so the SQL
    refresh stages and this step always weigh the components the same way.
    """
    cursor.execute(
        """
        UPDATE analytics.anomaly_signals signal
        SET model_residual_score=score.residual_score,
            isolation_forest_score=score.isolation_score,
            model_version=%(version)s,
            flags=array_cat(
              array_remove(array_remove(signal.flags,
                'large_model_residual'),'isolation_forest_anomaly'),
              array_remove(ARRAY[
                CASE WHEN score.residual_score>=%(threshold)s
                     THEN 'large_model_residual' END,
                CASE WHEN score.isolation_score>=%(threshold)s
                     THEN 'isolation_forest_anomaly' END
              ],NULL)
            ),
            review_score=analytics.anomaly_review_score(
              signal.hard_rule_score,signal.robust_cohort_score,
              score.residual_score,score.isolation_score,
              signal.duplicate_score,signal.spatial_score
            )
        FROM model_scores score
        WHERE signal.transaction_kind=%(kind)s
          AND signal.transaction_id=score.transaction_id
        """,
        {"version": version, "threshold": MODEL_FLAG_THRESHOLD, "kind": kind},
    )
    cursor.execute(
        """
        UPDATE analytics.anomaly_signals signal
        SET model_residual_score=NULL,isolation_forest_score=NULL,
            model_version=NULL,
            flags=array_remove(array_remove(signal.flags,
              'large_model_residual'),'isolation_forest_anomaly'),
            review_score=analytics.anomaly_review_score(
              signal.hard_rule_score,signal.robust_cohort_score,NULL,NULL,
              signal.duplicate_score,signal.spatial_score
            )
        WHERE signal.transaction_kind=%s
          AND NOT EXISTS (
            SELECT 1 FROM model_scores score
            WHERE score.transaction_id=signal.transaction_id
          )
        """,
        (kind,),
    )


def _persist_hedonic_indices(
    cursor: psycopg.Cursor,
    population: ModelPopulation,
    model_run_id: uuid.UUID,
    frame: TrainingFrame,
    final_models: dict[str, Pipeline],
    generator: np.random.Generator,
) -> None:
    cursor.execute(
        """
        INSERT INTO analytics.index_calculation_runs(
            transaction_kind,method,methodology_version,data_from,data_to,
            parameters
        ) VALUES(%s,'hedonic',%s,%s,%s,%s)
        RETURNING id
        """,
        (
            population.kind, INDEX_METHODOLOGY, min(frame.contract_dates), max(frame.contract_dates),
            json.dumps({
                "minimumPeriodObservations": INDEX_MIN_PERIOD_OBSERVATIONS,
                "bootstrapReplicates": INDEX_BOOTSTRAP_REPLICATES,
                "nominalCoverage": 0.95,
                "landPopulation": population.land_population,
            }),
        ),
    )
    index_run_id = cursor.fetchone()[0]
    indices = _hedonic_indices(frame.property_groups, frame.features, frame.contract_dates, final_models, generator)
    cursor.executemany(
        """
        INSERT INTO analytics.market_indices(
            transaction_kind,method,property_group,geography_id,period,
            index_value,sample_size,base_period,model_run_id,
            methodology_version,calculation_run_id,observed_sample_size,
            reference_sample_size,lower_index_value,upper_index_value,
            nominal_coverage,uncertainty_method,is_publishable,
            suppression_reason
        ) VALUES(
            %s,'hedonic',%s,NULL,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,
            %s,.95,'deterministic_reference_bootstrap',%s,%s
        )
        """,
        [
            (
                population.kind, group, period, index_value, observed_size, base_period, model_run_id,
                INDEX_METHODOLOGY, index_run_id, observed_size, reference_size, lower_value, upper_value,
                observed_size >= INDEX_MIN_PERIOD_OBSERVATIONS,
                None
                if observed_size >= INDEX_MIN_PERIOD_OBSERVATIONS
                else f"below_minimum_period_observations_{INDEX_MIN_PERIOD_OBSERVATIONS}",
            )
            for (
                group, period, index_value, observed_size, reference_size, base_period, lower_value, upper_value,
            ) in indices
        ],
    )


def _hedonic_indices(
    property_groups: np.ndarray,
    features: np.ndarray,
    contract_dates: list[date],
    models: dict[str, Pipeline],
    generator: np.random.Generator,
) -> list[tuple[str, date, float, int, int, date, float, float]]:
    rows: list[tuple[str, date, float, int, int, date, float, float]] = []
    date_values = np.asarray(contract_dates, dtype=object)
    for group in sorted(models):
        model = models[group]
        indices = np.flatnonzero(property_groups == group)
        reference_size = min(INDEX_REFERENCE_SIZE, len(indices))
        reference_indices = generator.choice(indices, size=reference_size, replace=False)
        reference = features[reference_indices].copy()
        group_dates = date_values[indices]
        observed_by_month = Counter((value.year, value.month) for value in group_dates)
        first = min(group_dates)
        last = max(group_dates)
        periods = list(_month_range(first, last))
        predicted_medians: list[float] = []
        bootstrap_medians: list[np.ndarray] = []
        bootstrap_indices = generator.integers(
            0, reference_size, size=(INDEX_BOOTSTRAP_REPLICATES, reference_size)
        )
        for period in periods:
            counterfactual = reference.copy()
            counterfactual[:, CONTRACT_YEAR] = float(period.year)
            counterfactual[:, CONTRACT_MONTH] = float(period.month)
            values = np.exp(model.predict(counterfactual))
            predicted_medians.append(float(np.median(values)))
            bootstrap_medians.append(np.median(values[bootstrap_indices], axis=1))
        base = predicted_medians[0]
        bootstrap_base = bootstrap_medians[0]
        for period, predicted_median, bootstraps in zip(
            periods, predicted_medians, bootstrap_medians, strict=True
        ):
            bootstrap_index = 100.0 * bootstraps / bootstrap_base
            observed_size = observed_by_month[(period.year, period.month)]
            rows.append(
                (
                    str(group),
                    period,
                    100.0 * predicted_median / base,
                    observed_size,
                    reference_size,
                    periods[0],
                    float(np.quantile(bootstrap_index, 0.025)),
                    float(np.quantile(bootstrap_index, 0.975)),
                )
            )
    return rows


def _month_range(first: date, last: date) -> Iterator[date]:
    current = date(first.year, first.month, 1)
    end = date(last.year, last.month, 1)
    while current <= end:
        yield current
        current = (
            date(current.year + 1, 1, 1)
            if current.month == 12
            else date(current.year, current.month + 1, 1)
        )
