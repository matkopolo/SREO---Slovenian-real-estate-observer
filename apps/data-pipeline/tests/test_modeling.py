from datetime import date, timedelta
from threading import Lock
from time import sleep
from unittest.mock import MagicMock

import numpy as np
import pytest

from real_estate_etl.model_validation import (
    final_holdout_split,
    interval_half_width,
    percentile_scores,
    temporal_folds,
)


def holdout_split(dates, as_of=None):
    """Latest-complete-year split with the small minima the tests use."""
    _folds, _skipped, holdout = temporal_folds(
        dates, as_of=as_of, min_training_rows=10, min_calibration_rows=10, min_validation_rows=10,
    )
    if holdout is None:
        raise ValueError("temporal validation requires complete calendar years")
    return final_holdout_split(
        dates, holdout, min_training_rows=10, min_calibration_rows=10, min_holdout_rows=10,
    )


def test_model_refresh_marks_first_install_bootstrap_only_after_both_kinds(monkeypatch, caplog):
    from unittest.mock import MagicMock

    from real_estate_etl import modeling

    caplog.set_level("INFO")
    connection = MagicMock()
    results = [
        modeling.ModelResult("sale", 10, "sale-v", 1.0, {}),
        modeling.ModelResult("rent", 20, "rent-v", 1.0, {}),
    ]
    monkeypatch.setattr(modeling, "_refresh_kind", lambda _connection, kind, _workers: results[kind == "rent"])

    assert modeling.refresh_models(connection, workers=2) == results
    cursor = connection.cursor.return_value.__enter__.return_value
    assert "UPDATE analytics.pipeline_state" in cursor.execute.call_args.args[0]
    assert cursor.execute.call_args.args[1] == ("sale-v,rent-v",)
    output = caplog.text
    assert "learn sale price per m² separately for each property group" in output
    assert "learn monthly rent per m² separately" in output
    assert "analytics.model_runs: inserts immutable model configuration" in output
    assert "analytics.model_publications" in output
    assert "sale completes before rent starts" in output
    assert "sale and rent are sequential" in output
    assert output.index("[models] 2/2 rent model") < output.index(
        "transaction kind 1/2 starting: sale"
    )
    assert "transaction kind 1/2 starting: sale" in output
    assert "transaction kind completion 2/2 (100.0%)" in output


def test_property_groups_use_bounded_parallel_workers(monkeypatch, caplog):
    from unittest.mock import MagicMock

    from real_estate_etl import modeling

    caplog.set_level("INFO")
    lock = Lock()
    active = 0
    maximum_active = 0

    def train(_kind, group, number, _count, *_args):
        nonlocal active, maximum_active
        with lock:
            active += 1
            maximum_active = max(maximum_active, active)
        sleep(0.03)
        with lock:
            active -= 1
        indices = np.asarray([number - 1])
        return modeling.PropertyGroupResult(
            group, indices, np.asarray([1.0]), np.asarray([0.1]),
            np.asarray([0.0]), MagicMock(), {"status": "selected"},
        )

    monkeypatch.setattr(modeling, "_train_property_group", train)
    results = modeling._train_property_groups(
        "sale", ["apartment", "house", "land"], 2,
        np.empty((3, 8), dtype=object), np.zeros(3),
        [date(2025, 1, 1)] * 3, np.asarray([None] * 3, dtype=object),
        np.asarray(["apartment", "house", "land"], dtype=object),
        modeling.SelectionSettings(),
    )

    assert {result.group for result in results} == {"apartment", "house", "land"}
    assert maximum_active == 2
    output = caplog.text
    assert "parallel workers=2" in output
    assert "group completion 3/3 (100.0%)" in output


def test_hedonic_indices_are_generated_in_deterministic_group_order():
    from real_estate_etl import modeling

    class ConstantModel:
        def predict(self, values):
            return np.zeros(len(values))

    rows = modeling._hedonic_indices(
        np.asarray(["house", "apartment"], dtype=object),
        np.zeros((2, 8), dtype=object),
        [date(2025, 1, 1), date(2025, 1, 1)],
        {"house": ConstantModel(), "apartment": ConstantModel()},
        np.random.default_rng(42),
    )

    assert [row[0] for row in rows] == ["apartment", "house"]


def test_percentile_scores_are_bounded_and_ranked():
    scores = percentile_scores(np.asarray([10.0, 1.0, 5.0]))
    assert scores.tolist() == [1.0, 1 / 3, 2 / 3]


def test_percentile_scores_handle_empty_input():
    assert percentile_scores(np.asarray([])).size == 0


def test_temporal_split_is_deterministic_disjoint_and_has_no_future_leakage():
    dates = [date(year, 1, 1) + timedelta(days=index) for year in range(2019, 2026) for index in range(12)]
    first = holdout_split(dates, as_of=date(2026, 8, 1))
    second = holdout_split(dates, as_of=date(2026, 8, 1))
    assert all(np.array_equal(left, right) for left, right in zip(first, second, strict=True))
    training, calibration, test = first
    assert set(training).isdisjoint(calibration)
    assert set(training).isdisjoint(test)
    assert set(calibration).isdisjoint(test)
    assert max(dates[index] for index in training) < min(
        dates[index] for index in calibration
    )
    assert max(dates[index] for index in calibration) < min(
        dates[index] for index in test
    )


def test_temporal_split_rejects_small_population():
    with pytest.raises(ValueError, match="no earlier calibration year"):
        holdout_split([date(2025, 1, 1)] * 29, as_of=date(2026, 7, 1))


def test_temporal_split_uses_latest_complete_year_and_prior_calibration_year():
    dates = [
        *[date(2023, 6, 1)] * 20,
        *[date(2024, 6, 1)] * 10,
        *[date(2025, 6, 1)] * 10,
        *[date(2026, 1, 1)] * 10,
    ]
    training, calibration, test = holdout_split(
        dates, as_of=date(2026, 7, 1)
    )
    assert {dates[index].year for index in training} == {2023}
    assert {dates[index].year for index in calibration} == {2024}
    assert {dates[index].year for index in test} == {2025}


def test_rolling_folds_exclude_current_year_and_reserve_latest_complete_year():
    dates = [date(year, 6, 1) for year in range(2018, 2027) for _ in range(10)]
    folds, skipped, holdout = temporal_folds(
        dates, as_of=date(2026, 8, 1), min_training_rows=10,
        min_calibration_rows=10, min_validation_rows=10,
    )
    assert not skipped
    assert holdout == 2025
    assert folds
    for fold in folds:
        assert max(fold.train_years) < fold.calibration_year < fold.validation_year < holdout
        assert set(fold.training).isdisjoint(fold.calibration)
        assert set(fold.training).isdisjoint(fold.validation)
        assert set(fold.calibration).isdisjoint(fold.validation)
        assert all(dates[index].year != 2026 for index in np.concatenate(
            [fold.training, fold.calibration, fold.validation]
        ))


def test_interval_half_width_uses_finite_sample_conformal_rank():
    actual = np.asarray([0.0, 1.0, 2.0, 3.0])
    predicted = np.zeros(4)
    assert interval_half_width(actual, predicted, coverage=0.5) == 2.0


def test_interval_coverage_is_evaluated_on_separate_test_values():
    calibration_actual = np.asarray([0.0, 0.1, -0.1, 0.2, -0.2] * 10)
    width = interval_half_width(calibration_actual, np.zeros(50), coverage=0.9)
    test_actual = np.asarray([0.0, 0.1, 1.0, -1.0])
    covered = np.abs(test_actual) <= width
    assert covered.tolist() == [True, True, False, False]


class RecordingConnection:
    """Records transaction boundaries the way psycopg nests them."""

    def __init__(self):
        self.events: list[str] = []
        self.cursor_mock = MagicMock()

    def transaction(self):
        connection = self

        class Transaction:
            def __enter__(self):
                connection.events.append("begin")

            def __exit__(self, exc_type, exc, traceback):
                connection.events.append("rollback" if exc_type else "commit")
                return False

        return Transaction()

    def cursor(self):
        cursor = self.cursor_mock

        class Cursor:
            def __enter__(self):
                return cursor

            def __exit__(self, *_args):
                return False

        return Cursor()


def test_model_refresh_is_atomic_when_rent_fails(monkeypatch):
    from real_estate_etl import modeling

    connection = RecordingConnection()

    def refresh_kind(conn, kind, _workers):
        conn.events.append(kind)
        if kind == "rent":
            raise RuntimeError("rent model failed")
        return modeling.ModelResult("sale", 10, "sale-v", 1.0, {})

    monkeypatch.setattr(modeling, "_refresh_kind", refresh_kind)
    with pytest.raises(RuntimeError, match="rent model failed"):
        modeling.refresh_models(connection, workers=1)

    # Sale work is inside the same outer transaction, which is rolled back.
    assert connection.events == ["begin", "sale", "rent", "rollback"]
    connection.cursor_mock.execute.assert_not_called()


def test_model_refresh_publishes_inside_the_outer_transaction(monkeypatch):
    from real_estate_etl import modeling

    connection = RecordingConnection()
    monkeypatch.setattr(
        modeling, "_refresh_kind",
        lambda conn, kind, _workers: conn.events.append(kind) or modeling.ModelResult(kind, 1, f"{kind}-v", 1.0, {}),
    )
    modeling.refresh_models(connection, workers=1)
    assert connection.events == ["begin", "sale", "rent", "commit"]
    assert connection.cursor_mock.executemany.call_args.args[1] == [
        ("sale", "sale", "sale-v"), ("rent", "rent", "rent-v"),
    ]


def test_feature_columns_are_addressed_by_name():
    from real_estate_etl.model_features import CATEGORICAL_COLUMNS, FEATURE_INDEX, NUMERIC_COLUMNS
    from real_estate_etl.modeling import FEATURE_SQL, MODEL_FEATURES, TRAINING_COLUMNS

    assert list(FEATURE_SQL) == MODEL_FEATURES
    assert sorted(NUMERIC_COLUMNS + CATEGORICAL_COLUMNS) == list(range(len(MODEL_FEATURES)))
    assert [FEATURE_INDEX["property_group"], FEATURE_INDEX["municipality_id"]] == CATEGORICAL_COLUMNS
    assert TRAINING_COLUMNS[2:2 + len(MODEL_FEATURES)] == tuple(MODEL_FEATURES)
