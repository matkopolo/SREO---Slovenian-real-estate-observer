from contextlib import ExitStack
from datetime import UTC, datetime, timedelta
from pathlib import Path
from threading import Event
from time import sleep
from unittest.mock import MagicMock, patch

import pytest
from psycopg import sql

from real_estate_etl.analytics_plan import (
    ANALYTICS_REFRESH_FUNCTIONS,
    ANALYTICS_STAGE_DATABASE_EFFECTS,
    ANALYTICS_STAGE_DESCRIPTIONS,
)
from real_estate_etl.cli import build_parser, validate_arguments
from real_estate_etl.models import RefreshSummary
from real_estate_etl.operations import (
    SystemRefreshResult,
    _refresh_functions,
    _refresh_system_unlocked,
    refresh_analytics,
    refresh_system,
    reset_market_data,
    scheduled_refresh_loop,
    wait_until,
)
from real_estate_etl.source_sync import SourceSyncReport

RESULT = SystemRefreshResult(RefreshSummary(0, 34, 0), {}, {}, {})


def test_long_analytics_refresh_emits_periodic_heartbeat(caplog):
    caplog.set_level("INFO")
    connection = MagicMock()
    cursor = connection.cursor.return_value.__enter__.return_value
    cursor.fetchone.return_value = (456_585,)
    cursor.execute.side_effect = lambda _statement: sleep(0.035)

    counts = _refresh_functions(
        connection,
        ("analytics.refresh_rental_facts",),
        progress_interval_seconds=0.01,
    )

    assert counts == {"analytics.refresh_rental_facts": 456_585}
    output = caplog.text
    assert "refresh_rental_facts: started" in output
    assert "one quality-audited analytical fact per rental agreement" in output
    assert "Database effects:" in output
    assert "analytics.rental_facts: rebuilds derived rental facts" in output
    assert "execution plan: 1 sequential stages" in output
    assert output.index("[analytics] 1/1 refresh_rental_facts") < output.index(
        "refresh_rental_facts: started"
    )
    assert output.count("PostgreSQL is still processing") >= 2
    assert "refresh_rental_facts: 456,585 rows in" in output


def test_every_analytics_stage_has_a_non_destructive_description():
    assert set(ANALYTICS_STAGE_DESCRIPTIONS) == set(ANALYTICS_REFRESH_FUNCTIONS)
    assert set(ANALYTICS_STAGE_DATABASE_EFFECTS) == set(ANALYTICS_REFRESH_FUNCTIONS)
    assert "marked, not deleted" in ANALYTICS_STAGE_DESCRIPTIONS[
        "analytics.refresh_sale_outliers"
    ]


def test_scheduler_defaults_to_every_fourteen_days():
    parser = build_parser()
    args = parser.parse_args(["schedule"])
    validate_arguments(parser, args)

    assert args.interval_days == 14
    assert args.retry_hours == 1


def test_reset_requires_explicit_confirmation():
    parser = build_parser()
    args = parser.parse_args(["reset-and-repopulate"])

    with pytest.raises(SystemExit):
        validate_arguments(parser, args)


def test_refresh_analytics_uses_documented_dependency_order(caplog):
    caplog.set_level("INFO")
    connection = MagicMock()
    cursor = connection.cursor.return_value.__enter__.return_value
    cursor.fetchone.return_value = (3,)
    counts = refresh_analytics(connection)

    assert [call.args[0] for call in cursor.execute.call_args_list] == [
        sql.SQL("SELECT {}()").format(sql.Identifier(*function.split(".")))
        for function in ANALYTICS_REFRESH_FUNCTIONS
    ]
    assert counts == dict.fromkeys(ANALYTICS_REFRESH_FUNCTIONS, 3)
    output = caplog.text
    assert "execution plan: 8 sequential stages" in output
    assert "database refresh stages do not run in parallel" in output
    planned = [
        output.index(f"[analytics] {position}/8 {function.rsplit('.', 1)[-1]}")
        for position, function in enumerate(ANALYTICS_REFRESH_FUNCTIONS, start=1)
    ]
    assert planned == sorted(planned)
    assert planned[-1] < output.index("refresh_sale_facts: started")
    for function in ANALYTICS_REFRESH_FUNCTIONS:
        assert f"{function.rsplit('.', 1)[-1]}: 3 rows in " in output


def test_refresh_analytics_stops_generation_when_a_stage_fails():
    connection = MagicMock()
    cursor = connection.cursor.return_value.__enter__.return_value

    def execute(statement):
        if "refresh_sale_facts" in repr(statement):
            raise RuntimeError("sale refresh failed")
        raise AssertionError("later analytical stage ran after failure")

    cursor.execute.side_effect = execute
    with pytest.raises(RuntimeError, match="sale refresh failed"):
        refresh_analytics(connection)

    assert cursor.execute.call_count == 1


def test_reset_market_data_preserves_identity_tables():
    connection = MagicMock()
    cursor = connection.cursor.return_value.__enter__.return_value

    reset_market_data(connection)

    statement = repr(cursor.execute.call_args.args[0])
    assert "Identifier('public', 'source_files')" in statement
    assert "Identifier('analytics', 'model_publications')" in statement
    assert "app_users" not in statement
    assert "user_preferences" not in statement
    assert "RESTART IDENTITY" in statement
    assert "CASCADE" not in statement


def test_refresh_system_holds_and_releases_advisory_lock(tmp_path: Path):
    connection = MagicMock()
    connection.execute.return_value.fetchone.return_value = (True,)
    expected = SystemRefreshResult(RefreshSummary(1, 2, 0), {"country": 1}, {"sale": 10}, {})

    with patch(
        "real_estate_etl.operations._refresh_system_unlocked", return_value=expected
    ) as run:
        result = refresh_system(
            connection,
            output_dir=tmp_path,
            end_year=2026,
            force=False,
            workers=2,
            verbose=False,
            database_url="postgresql://test",
        )

    assert result == expected
    run.assert_called_once()
    assert "pg_try_advisory_lock" in connection.execute.call_args_list[0].args[0]
    assert "pg_advisory_unlock" in connection.execute.call_args_list[-1].args[0]


@pytest.mark.parametrize(("policy", "bootstrap", "new_archives"), [
    ("auto", False, 0), ("manual", False, 1), ("manual", True, 1),
])
def test_system_refresh_skips_models_after_first_install(
    tmp_path: Path, caplog, monkeypatch, policy, bootstrap, new_archives
):
    caplog.set_level("INFO")
    monkeypatch.setenv("MODEL_REFRESH_POLICY", policy)
    connection = MagicMock()
    connection.execute.return_value.fetchone.return_value = (bootstrap,)
    archives = RefreshSummary(new_archives, 3, 0)
    with (
        patch("real_estate_etl.operations.refresh_all_national", return_value=archives),
        patch("real_estate_etl.operations.sync_geographies", return_value={"country": 1}),
        patch("real_estate_etl.operations.sync_context", return_value=SourceSyncReport()),
        patch("real_estate_etl.operations.sync_demography", return_value=SourceSyncReport()),
        patch("real_estate_etl.operations.sync_construction", return_value=SourceSyncReport()),
        patch("real_estate_etl.operations.sync_registers", return_value=SourceSyncReport()),
        patch("real_estate_etl.operations.refresh_analytics", return_value={"facts": 3}),
        patch("real_estate_etl.operations.start_release", return_value=MagicMock()),
        patch("real_estate_etl.operations.update_release_source"),
        patch("real_estate_etl.operations.set_release_stage"),
        patch("real_estate_etl.operations.record_source_status"),
        patch("real_estate_etl.operations.publish_release"),
        patch("real_estate_etl.modeling.refresh_models") as train,
    ):
        result = _refresh_system_unlocked(
            connection,
            output_dir=tmp_path,
            end_year=2026,
            force=False,
            workers=4,
            verbose=False,
            database_url="postgresql://test",
        )

    train.assert_not_called()
    assert result.model_rows == {}
    assert "Retaining published models" in caplog.text


@pytest.mark.parametrize("bootstrap_required", [True, False])
def test_system_refresh_trains_models_for_bootstrap_or_new_archive(
    tmp_path: Path, caplog, bootstrap_required: bool
):
    caplog.set_level("INFO")
    connection = MagicMock()
    connection.execute.return_value.fetchone.return_value = (bootstrap_required,)
    archives = RefreshSummary(1, 2, 0)
    model_result = MagicMock(
        transaction_kind="sale", rows=12, model_version="sale-test"
    )
    with (
        patch("real_estate_etl.operations.refresh_all_national", return_value=archives),
        patch("real_estate_etl.operations.sync_geographies", return_value={"country": 1}),
        patch("real_estate_etl.operations.sync_context", return_value=SourceSyncReport()),
        patch("real_estate_etl.operations.sync_demography", return_value=SourceSyncReport()),
        patch("real_estate_etl.operations.sync_construction", return_value=SourceSyncReport()),
        patch("real_estate_etl.operations.sync_registers", return_value=SourceSyncReport()),
        patch("real_estate_etl.operations.refresh_analytics", return_value={"facts": 3}),
        patch("real_estate_etl.operations.start_release", return_value=MagicMock()),
        patch("real_estate_etl.operations.update_release_source"),
        patch("real_estate_etl.operations.set_release_stage"),
        patch("real_estate_etl.operations.record_source_status"),
        patch("real_estate_etl.operations.publish_release"),
        patch("real_estate_etl.modeling.refresh_models", return_value=[model_result]) as train,
        patch("real_estate_etl.model_reporting.format_model_report", return_value="report"),
    ):
        result = _refresh_system_unlocked(
            connection,
            output_dir=tmp_path,
            end_year=2026,
            force=False,
            workers=4,
            verbose=False,
            database_url="postgresql://test",
        )

    train.assert_called_once_with(connection, 4)
    assert result.model_rows == {"sale": 12}
    assert "pending analytical release" in caplog.text


def test_scheduled_refresh_runs_immediately_and_marks_health(tmp_path: Path):
    stop = Event()
    connection = MagicMock()
    context = MagicMock()
    context.__enter__.return_value = connection
    health = tmp_path / "healthy"

    def refresh(*_args, **_kwargs):
        stop.set()
        return RESULT

    with patch("real_estate_etl.operations.psycopg.connect", return_value=context):
        scheduled_refresh_loop(
            "postgresql://example",
            output_dir=tmp_path,
            workers=2,
            verbose=False,
            health_file=health,
            stop_event=stop,
            refresh=refresh,
            active_release=lambda: datetime.now(UTC),
        )

    assert health.is_file()


def test_wait_until_uses_the_wall_clock_deadline():
    """A paused VM does not advance monotonic waits; the wall-clock check must end the wait."""
    start = datetime(2026, 9, 7, tzinfo=UTC)
    clock = {"now": start}
    waits = []

    class FakeEvent:
        def is_set(self):
            return False

        def wait(self, seconds):
            waits.append(seconds)
            # Simulate the host sleeping: far more wall time passes than was waited.
            clock["now"] += timedelta(days=20)

    wait_until(start + timedelta(days=14), FakeEvent(), now=lambda: clock["now"], poll_seconds=300)

    assert waits == [300]


def test_scheduler_reruns_after_the_interval_and_stops_cleanly(tmp_path: Path):
    clock = {"now": datetime(2026, 9, 7, tzinfo=UTC)}
    calls = []
    stop = Event()
    context = MagicMock()
    context.__enter__.return_value = MagicMock()

    def refresh(*_args, **_kwargs):
        calls.append(clock["now"])
        if len(calls) == 2:
            stop.set()
        clock["now"] += timedelta(days=15)  # the refresh plus a long host sleep
        return RESULT

    def tick():
        clock["now"] += timedelta(days=1)  # wall time keeps moving between checks
        return clock["now"]

    with patch("real_estate_etl.operations.psycopg.connect", return_value=context):
        scheduled_refresh_loop(
            "postgresql://example", output_dir=tmp_path, workers=1, verbose=False,
            stop_event=stop, refresh=refresh, now=tick, poll_seconds=0.01, active_release=lambda: None,
        )

    assert len(calls) == 2


def test_boundary_outage_keeps_existing_boundaries(caplog):
    from real_estate_etl.operations import _sync_geographies_or_keep_existing

    connection = MagicMock()
    connection.execute.return_value.fetchone.return_value = (6250,)
    with patch("real_estate_etl.operations.sync_geographies", side_effect=RuntimeError("HTTP 403")):
        assert _sync_geographies_or_keep_existing(connection) == ({}, "RuntimeError: HTTP 403")
    assert "keeping 6250 previously synchronised boundaries" in caplog.text


def test_boundary_outage_on_first_install_loads_the_seed(tmp_path: Path, caplog):
    from real_estate_etl.operations import _sync_geographies_or_keep_existing

    connection = MagicMock()
    connection.execute.return_value.fetchone.return_value = (0,)
    calls = []

    def fake_sync(_connection, fetch_json=None):
        calls.append(fetch_json)
        if fetch_json is None:
            raise RuntimeError("HTTP 403")
        return {"municipality": 212}

    def fake_download(_client, url, target):
        import zipfile

        with zipfile.ZipFile(target, "w") as bundle:
            bundle.writestr("SI.GURS.RPE_OBCINE.geojson", '{"type":"FeatureCollection","features":[]}')
        return target

    with (
        patch("real_estate_etl.operations.sync_geographies", side_effect=fake_sync),
        patch("real_estate_etl.operations.http_client.download_file", side_effect=fake_download),
    ):
        counts, status = _sync_geographies_or_keep_existing(connection, tmp_path)
    assert (counts, status) == ({"municipality": 212}, "seed")  # recorded as SOURCE_SEED, not a failure
    assert calls[0] is None
    assert callable(calls[1])
    assert "loading the published boundary seed" in caplog.text


def test_boundary_outage_on_first_install_fails_when_the_seed_is_unavailable(tmp_path: Path):
    from real_estate_etl.operations import _sync_geographies_or_keep_existing

    connection = MagicMock()
    connection.execute.return_value.fetchone.return_value = (0,)
    with (
        patch("real_estate_etl.operations.sync_geographies", side_effect=RuntimeError("HTTP 403")),
        patch("real_estate_etl.operations.http_client.download_file", side_effect=RuntimeError("seed 404")),
        pytest.raises(RuntimeError, match="seed 404"),
    ):
        _sync_geographies_or_keep_existing(connection, tmp_path)


def test_scheduler_waits_for_the_database_instead_of_failing():
    import psycopg

    from real_estate_etl.operations import _wait_for_database

    attempts = []

    def connect(_url):
        attempts.append(1)
        if len(attempts) < 3:
            raise psycopg.OperationalError("the database system is not yet accepting connections")
        return MagicMock()

    assert _wait_for_database("postgresql://x", Event(), poll_seconds=0.01, connect=connect) is True
    assert len(attempts) == 3


def test_scheduler_stops_waiting_for_the_database_when_asked():
    import psycopg

    from real_estate_etl.operations import _wait_for_database

    stop = Event()

    def connect(_url):
        stop.set()
        raise psycopg.OperationalError("down")

    assert _wait_for_database("postgresql://x", stop, poll_seconds=0.01, connect=connect) is False


def system_refresh_patches(stack: ExitStack, **overrides) -> dict[str, MagicMock]:
    mocks = {
        "refresh_all_national": MagicMock(return_value=RefreshSummary(0, 3, 0)),
        "sync_geographies": MagicMock(return_value={"country": 1}),
        "sync_context": MagicMock(return_value=SourceSyncReport({"ecb_euribor_6m": 6})),
        "sync_demography": MagicMock(return_value=SourceSyncReport(failures={"surs_deaths": "HTTPStatusError: 500"})),
        "sync_construction": MagicMock(return_value=SourceSyncReport({"gurs_buildings": 0})),
        "sync_registers": MagicMock(return_value=SourceSyncReport()),
        "refresh_analytics": MagicMock(return_value={"facts": 3}),
        "start_release": MagicMock(return_value="release-1"),
        "update_release_source": MagicMock(),
        "set_release_stage": MagicMock(),
        "record_source_status": MagicMock(),
        "publish_release": MagicMock(),
        "fail_release": MagicMock(),
        **overrides,
    }
    for name, mock in mocks.items():
        stack.enter_context(patch(f"real_estate_etl.operations.{name}", mock))
    return mocks


def run_unlocked(tmp_path: Path, **kwargs) -> SystemRefreshResult:
    connection = MagicMock()
    connection.execute.return_value.fetchone.return_value = (False,)
    return _refresh_system_unlocked(
        connection, output_dir=tmp_path, end_year=2026, force=False, workers=1, verbose=False,
        database_url="postgresql://test", **kwargs,
    )


def test_source_failures_are_recorded_on_the_release(tmp_path: Path, monkeypatch, caplog):
    caplog.set_level("INFO")
    monkeypatch.setenv("MODEL_REFRESH_POLICY", "manual")
    with ExitStack() as stack:
        mocks = system_refresh_patches(stack)
        result = run_unlocked(tmp_path)

    expected = {
        "rpe_boundaries": "ok", "ecb_euribor_6m": "ok", "gurs_buildings": "ok",
        "surs_deaths": "HTTPStatusError: 500",
    }
    assert result.sources == expected
    mocks["record_source_status"].assert_called_once_with("postgresql://test", "release-1", expected)
    mocks["publish_release"].assert_called_once()
    assert "release=release-1 published" in caplog.text
    assert "failed optional sources=surs_deaths" in caplog.text


def test_failed_stage_marks_release_failed_and_reraises_original_error(tmp_path: Path, monkeypatch):
    monkeypatch.setenv("MODEL_REFRESH_POLICY", "manual")
    error = RuntimeError("analytics broke")
    with ExitStack() as stack:
        mocks = system_refresh_patches(stack, refresh_analytics=MagicMock(side_effect=error))
        with pytest.raises(RuntimeError) as raised:
            run_unlocked(tmp_path)

    assert raised.value is error
    mocks["fail_release"].assert_called_once_with("postgresql://test", "release-1", error)
    mocks["publish_release"].assert_not_called()


def test_stop_request_interrupts_between_stages(tmp_path: Path, monkeypatch):
    from real_estate_etl.operations import RefreshInterrupted

    monkeypatch.setenv("MODEL_REFRESH_POLICY", "manual")
    with ExitStack() as stack:
        mocks = system_refresh_patches(stack)
        with pytest.raises(RefreshInterrupted):
            run_unlocked(tmp_path, stop_requested=lambda: True)

    mocks["update_release_source"].assert_not_called()
    mocks["fail_release"].assert_called_once()


def test_scheduler_reports_unhealthy_after_first_import_fails(tmp_path: Path):
    stop = Event()
    health = tmp_path / "healthy"
    states = []

    def refresh(*_args, **_kwargs):
        states.append(health.is_file())  # healthy while the first import runs
        stop.set()
        raise RuntimeError("GURS unavailable")

    with patch("real_estate_etl.operations.psycopg.connect", return_value=MagicMock()):
        scheduled_refresh_loop(
            "postgresql://example", output_dir=tmp_path, workers=1, verbose=False, health_file=health,
            stop_event=stop, refresh=refresh, active_release=lambda: None, poll_seconds=0.01,
        )

    assert states == [True]
    assert not health.exists()  # nothing published and no refresh running


def test_record_source_status_distinguishes_seeded_from_failed_sources(caplog):
    from real_estate_etl.publication import record_source_status

    with patch("real_estate_etl.publication.psycopg.connect"):
        record_source_status("postgresql://x", "release-1", {"rpe_boundaries": "seed", "surs_deaths": "HTTP 500", "ecb": "ok"})
    assert "loaded from the published seed: rpe_boundaries" in caplog.text
    assert "failed and kept stored values: surs_deaths" in caplog.text
    assert "rpe_boundaries, surs_deaths" not in caplog.text
