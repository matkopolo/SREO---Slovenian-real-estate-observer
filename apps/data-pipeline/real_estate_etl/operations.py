"""End-to-end refresh, reset, and scheduling operations for the worker.

A system refresh runs these stages in order, each recorded on the analytical release:

1. ``source``     import new or revised GURS national archives;
2. ``geography``  refresh RPE boundaries (an outage keeps the stored boundaries);
   then the optional context sources (SURS, Banka Slovenije, ECB, GURS buildings),
   whose per-source outcome is stored in ``details.sources`` on the release;
3. ``analytics``  rebuild the analytical facts in one transaction;
4. ``models``     retrain valuation models when the policy and new data call for it;
5. ``published``  switch the active release, in the same transaction as 3 and 4.

Stages 3 to 5 deliberately share one long transaction: readers keep seeing the
previous release until the new one is complete. That holds back vacuum for the
duration of the refresh, which is acceptable for a refresh every 14 days.
"""

from __future__ import annotations

import logging
import os
import signal
import time
from collections.abc import Callable, MutableMapping
from dataclasses import dataclass
from datetime import datetime, timedelta
from pathlib import Path
from threading import Event, Thread, current_thread, main_thread
from typing import Any

import psycopg
from psycopg import sql

from . import http_client
from .analytics_plan import ANALYTICS_REFRESH_FUNCTIONS, format_analytics_plan
from .construction import sync_construction
from .context import sync_context
from .demography import sync_demography
from .geography import seed_fetcher, sync_geographies
from .health import HEARTBEAT_SECONDS, STALE_SLACK, HealthHeartbeat, WorkerHealth, utc_now
from .models import RefreshSummary
from .pipeline import refresh_all_national
from .publication import (
    active_release_published_at,
    fail_release,
    maintenance_lock,
    publish_release,
    record_source_status,
    set_release_stage,
    start_release,
    update_release_source,
)
from .settings import RPE_BOUNDARIES_SEED_URL
from .source_sync import SOURCE_OK, SOURCE_SEED, SUCCESSFUL_STATUSES, SourceSyncReport

logger = logging.getLogger(__name__)

DEFAULT_INTERVAL_DAYS = 14
DEFAULT_RETRY_HOURS = 1
DEFAULT_ANALYTICS_PROGRESS_INTERVAL_SECONDS = 15.0
#: The current and previous GURS years are re-downloaded on every refresh: late
#: registrations keep arriving for the year that just ended.
REVISION_YEARS = 2

#: Tables emptied by ``reset-and-repopulate``. TRUNCATE runs without CASCADE, so a new
#: table that references one of these fails the reset loudly until it is listed here.
RESET_TABLES = (
    "analytics.valuation_predictions",
    "analytics.market_indices",
    "analytics.repeat_sale_pairs",
    "analytics.index_calculation_runs",
    "analytics.model_publications",
    "analytics.model_runs",
    "analytics.anomaly_signals",
    "analytics.near_duplicate_candidates",
    "analytics.land_transaction_facts",
    "analytics.sale_outlier_evaluations",
    "analytics.rental_outlier_evaluations",
    "analytics.sale_facts",
    "analytics.rental_facts",
    "analytics.refresh_runs",
    "public.building_parts",
    "public.land_parcels",
    "public.transactions",
    "public.rental_building_parts",
    "public.rental_transactions",
    "public.codebook_values",
    "public.codebook_imports",
    "public.source_files",
)


class RefreshInterrupted(RuntimeError):
    """The worker was asked to stop between two refresh stages."""


@dataclass(frozen=True)
class SystemRefreshResult:
    archives: RefreshSummary
    geography_counts: dict[str, int]
    model_rows: dict[str, int]
    sources: dict[str, str]


class ReleaseLogger(logging.LoggerAdapter):
    """Prefix every message with the release id so logs match the release row."""

    def process(self, msg: Any, kwargs: MutableMapping[str, Any]) -> tuple[Any, MutableMapping[str, Any]]:
        return f"release={self.extra['release_id']} {msg}", kwargs


def model_training_enabled() -> bool:
    """Compose keeps automatic training; production can require a deliberate Job."""
    policy = os.getenv("MODEL_REFRESH_POLICY", "auto")
    if policy not in {"auto", "manual"}:
        raise ValueError("MODEL_REFRESH_POLICY must be auto or manual")
    return policy == "auto"


def _analytics_progress_interval() -> float:
    raw = os.getenv("ANALYTICS_PROGRESS_INTERVAL_SECONDS", str(DEFAULT_ANALYTICS_PROGRESS_INTERVAL_SECONDS))
    try:
        return max(1.0, float(raw))
    except ValueError:
        logger.warning(
            "ANALYTICS_PROGRESS_INTERVAL_SECONDS=%r is not a number; using %ss",
            raw, DEFAULT_ANALYTICS_PROGRESS_INTERVAL_SECONDS,
        )
        return DEFAULT_ANALYTICS_PROGRESS_INTERVAL_SECONDS


def _log_running_stage(label: str, started: float, done: Event, interval: float) -> None:
    while not done.wait(interval):
        logger.info("  %s: PostgreSQL is still processing (elapsed=%.1fs)", label, time.monotonic() - started)


def _function_call(function: str) -> sql.Composed:
    schema, name = function.split(".")
    return sql.SQL("SELECT {}()").format(sql.Identifier(schema, name))


def _refresh_functions(
    connection: psycopg.Connection,
    functions: tuple[str, ...],
    *,
    progress_interval_seconds: float | None = None,
) -> dict[str, int]:
    counts: dict[str, int] = {}
    interval = progress_interval_seconds or _analytics_progress_interval()
    logger.info("%s", format_analytics_plan(functions), extra={"plain_block": True})
    with connection.transaction(), connection.cursor() as cursor:
        for function in functions:
            label = function.rsplit(".", 1)[-1]
            started = time.monotonic()
            logger.info("  %s: started", label)
            done = Event()
            heartbeat = Thread(
                target=_log_running_stage,
                args=(label, started, done, interval),
                name=f"{label}-progress",
                daemon=True,
            )
            heartbeat.start()
            try:
                cursor.execute(_function_call(function))
            finally:
                done.set()
                heartbeat.join()
            value = int(cursor.fetchone()[0] or 0)
            counts[function] = value
            logger.info("  %s: %s rows in %.1fs", label, f"{value:,}", time.monotonic() - started)
    return counts


def refresh_analytics(connection: psycopg.Connection) -> dict[str, int]:
    """Build one coherent analytical generation in the caller's transaction."""
    return _refresh_functions(connection, ANALYTICS_REFRESH_FUNCTIONS)


def format_analytics_counts(counts: dict[str, int]) -> str:
    return ", ".join(f"{name.rsplit('.', 1)[-1]}={count}" for name, count in counts.items())


def reset_market_data(connection: psycopg.Connection) -> None:
    """Delete market data while preserving users and installation state."""
    tables = sql.SQL(", ").join(sql.Identifier(*table.split(".")) for table in RESET_TABLES)
    with connection.transaction(), connection.cursor() as cursor:
        cursor.execute(sql.SQL("TRUNCATE TABLE {} RESTART IDENTITY").format(tables))


def refresh_system(
    connection: psycopg.Connection,
    *,
    output_dir: Path,
    end_year: int,
    force: bool,
    workers: int,
    verbose: bool,
    database_url: str,
    stop_requested: Callable[[], bool] | None = None,
) -> SystemRefreshResult:
    """Run source → geography → analytics; models follow MODEL_REFRESH_POLICY."""
    with maintenance_lock(connection):
        return _refresh_system_unlocked(
            connection,
            output_dir=output_dir,
            end_year=end_year,
            force=force,
            workers=workers,
            verbose=verbose,
            database_url=database_url,
            stop_requested=stop_requested,
        )


def reset_and_repopulate(
    connection: psycopg.Connection,
    *,
    output_dir: Path,
    end_year: int,
    workers: int,
    verbose: bool,
    database_url: str,
) -> SystemRefreshResult:
    """Empty imported and derived market data, then run a full system refresh."""
    with maintenance_lock(connection):
        reset_market_data(connection)
        logger.info("Removed imported and derived market data; users and preferences were preserved.")
        return _refresh_system_unlocked(
            connection,
            output_dir=output_dir,
            end_year=end_year,
            force=False,
            workers=workers,
            verbose=verbose,
            database_url=database_url,
        )


def _sync_geographies_or_keep_existing(
    connection: psycopg.Connection, output_dir: Path | None = None
) -> tuple[dict[str, int], str]:
    """Refresh RPE boundaries, but never let a boundary-service outage block new GURS data.

    sync_geographies is atomic (rolls back and records a failed run), so on error the
    previously synchronised boundaries are intact. A first install has none: it then
    loads the published boundary seed (the same GURS data, CC BY 4.0) so the site can
    start, and the next refresh takes GURS again. Returns the per-level counts and the
    source status (``"ok"``, ``"seed"`` or the error).
    """
    try:
        return sync_geographies(connection), SOURCE_OK
    except Exception as error:
        connection.rollback()
        existing = connection.execute("SELECT count(*) FROM analytics.geographic_units").fetchone()[0]
        connection.commit()
        if existing:
            logger.warning(
                "Geographic boundary sync failed; keeping %s previously synchronised boundaries for this release.",
                existing, exc_info=error,
            )
            return {}, f"{type(error).__name__}: {error}"[:500]
        logger.warning(
            "Geographic boundary sync failed on a first install (%s: %s); loading the published boundary seed from %s",
            type(error).__name__, error, RPE_BOUNDARIES_SEED_URL,
        )
        archive = (output_dir or Path(".")) / "rpe-boundaries.zip"
        if not archive.exists():
            with http_client.create_client() as client:
                http_client.download_file(client, RPE_BOUNDARIES_SEED_URL, archive)
        counts = sync_geographies(connection, seed_fetcher(archive))
        logger.warning("Boundaries loaded from the seed archive; the next refresh will take them from GURS again.")
        return counts, SOURCE_SEED


def _sync_optional_sources(connection: psycopg.Connection, output_dir: Path) -> SourceSyncReport:
    """Affordability, demographic and construction context; failures keep stored values."""
    return (
        sync_context(connection)
        .merge(sync_demography(connection))
        .merge(sync_construction(connection, output_dir))
    )


def _bootstrap_required(connection: psycopg.Connection) -> bool:
    required = connection.execute(
        "SELECT model_bootstrap_completed_at IS NULL FROM analytics.pipeline_state WHERE singleton"
    ).fetchone()[0]
    connection.commit()
    return bool(required)


def _published_model_versions(connection: psycopg.Connection) -> str | None:
    return connection.execute(
        "SELECT model_bootstrap_version FROM analytics.pipeline_state WHERE singleton"
    ).fetchone()[0]


def _train_models(
    connection: psycopg.Connection, workers: int, log: logging.LoggerAdapter,
) -> tuple[dict[str, int], str]:
    from .model_reporting import format_model_report
    from .modeling import refresh_models

    log.info("Starting valuation-model training for the pending analytical release.")
    results = refresh_models(connection, workers)
    for result in results:
        log.info("%s", format_model_report(result))
    return (
        {result.transaction_kind: result.rows for result in results},
        ",".join(result.model_version for result in results),
    )


def _refresh_system_unlocked(
    connection: psycopg.Connection,
    *,
    output_dir: Path,
    end_year: int,
    force: bool,
    workers: int,
    verbose: bool,
    database_url: str,
    stop_requested: Callable[[], bool] | None = None,
) -> SystemRefreshResult:
    automatic_training = model_training_enabled()
    release_id = start_release(connection, database_url)
    log = ReleaseLogger(logger, {"release_id": release_id})

    def checkpoint(next_stage: str) -> None:
        if stop_requested is not None and stop_requested():
            raise RefreshInterrupted(f"stop requested before the {next_stage} stage")

    try:
        archives = refresh_all_national(
            connection, output_dir, end_year, force, workers, verbose, revision_years=REVISION_YEARS,
        )
        checkpoint("geography")
        update_release_source(connection, database_url, release_id)
        geography_counts, geography_status = _sync_geographies_or_keep_existing(connection, output_dir)
        checkpoint("context")
        sources = {"rpe_boundaries": geography_status, **_sync_optional_sources(connection, output_dir).status()}
        record_source_status(database_url, release_id, sources)
        checkpoint("analytics")
        set_release_stage(database_url, release_id, "analytics")
        bootstrap_required = _bootstrap_required(connection)
        model_rows: dict[str, int] = {}
        with connection.transaction():
            log.info("Refreshed analytics: %s", format_analytics_counts(refresh_analytics(connection)))
            model_versions = _published_model_versions(connection)
            if automatic_training and (bootstrap_required or archives.imported > 0):
                checkpoint("models")
                set_release_stage(database_url, release_id, "models")
                model_rows, model_versions = _train_models(connection, workers, log)
            else:
                log.info(
                    "Retaining published models (policy=%s, new archives=%s, bootstrap required=%s); "
                    "refresh-models remains available for deliberate training.",
                    "auto" if automatic_training else "manual", archives.imported, bootstrap_required,
                )
            checkpoint("publication")
            publish_release(connection, release_id, model_versions)
        failed = sorted(name for name, status in sources.items() if status not in SUCCESSFUL_STATUSES)
        log.info(
            "published (archives imported=%s, models=%s, failed optional sources=%s)",
            archives.imported, model_versions, ", ".join(failed) or "none",
        )
        return SystemRefreshResult(archives, geography_counts, model_rows, sources)
    except BaseException as error:
        connection.rollback()
        fail_release(database_url, release_id, error)
        raise


#: Longest single sleep. The deadline is wall-clock time: Docker Desktop pauses
#: its VM while the host sleeps and a monotonic wait does not advance then, so a
#: single 14-day Event.wait() silently stretched into months.
SCHEDULER_POLL_SECONDS = 300


def wait_until(
    deadline: datetime,
    stop_event: Event,
    *,
    now: Callable[[], datetime] = utc_now,
    poll_seconds: float = SCHEDULER_POLL_SECONDS,
) -> None:
    """Sleep in short slices until a wall-clock deadline or a stop request."""
    while not stop_event.is_set():
        remaining = (deadline - now()).total_seconds()
        if remaining <= 0:
            return
        stop_event.wait(min(remaining, poll_seconds))


def _reader_for_active_release(database_url: str) -> Callable[[], datetime | None]:
    def read() -> datetime | None:
        with psycopg.connect(database_url) as connection:
            return active_release_published_at(connection)

    return read


def scheduled_refresh_loop(
    database_url: str,
    *,
    output_dir: Path,
    interval_days: int = DEFAULT_INTERVAL_DAYS,
    retry_hours: int = DEFAULT_RETRY_HOURS,
    workers: int,
    verbose: bool,
    health_file: Path | None = None,
    stop_event: Event | None = None,
    refresh: Callable[..., SystemRefreshResult] = refresh_system,
    active_release: Callable[[], datetime | None] | None = None,
    now: Callable[[], datetime] = utc_now,
    poll_seconds: float = SCHEDULER_POLL_SECONDS,
    heartbeat_seconds: float = HEARTBEAT_SECONDS,
) -> None:
    """Run immediately, then every interval; retry failures after ``retry_hours``.

    Health semantics are documented in :mod:`real_estate_etl.health`.
    """
    if interval_days < 1:
        raise ValueError("interval_days must be at least 1")
    if retry_hours < 1:
        raise ValueError("retry_hours must be at least 1")
    stop_event = stop_event or Event()
    active_release = active_release or _reader_for_active_release(database_url)
    health = WorkerHealth(health_file, stale_after=timedelta(days=interval_days) + STALE_SLACK, now=now)

    def request_stop(signal_number: int, _frame: object) -> None:
        logger.info("Received signal %s; stopping after the current refresh stage.", signal_number)
        stop_event.set()

    # Compose runs the worker under tini (init: true), so it is not PID 1; install
    # graceful-stop handlers whenever the loop owns the main thread.
    if current_thread() is main_thread():
        signal.signal(signal.SIGTERM, request_stop)
        signal.signal(signal.SIGINT, request_stop)

    with HealthHeartbeat(health, heartbeat_seconds):
        while not stop_event.is_set():
            # After a host or Docker restart the database can still be recovering: wait for it
            # instead of counting that as a failed refresh and sleeping for an hour unhealthy.
            if not _wait_for_database(database_url, stop_event, poll_seconds=poll_seconds):
                break
            health.update(refreshing=True, published_at=_safe_active_release(active_release, health))
            try:
                with psycopg.connect(database_url) as connection:
                    refresh(
                        connection,
                        output_dir=output_dir,
                        end_year=now().year,
                        force=False,
                        workers=workers,
                        verbose=verbose,
                        database_url=database_url,
                        stop_requested=stop_event.is_set,
                    )
                wait = timedelta(days=interval_days)
                health.update(last_error=None)
                logger.info(
                    "Scheduled refresh succeeded; next run in %s days (at %s).",
                    interval_days, (now() + wait).isoformat(timespec="minutes"),
                )
            except RefreshInterrupted as interrupted:
                logger.info("Scheduled refresh stopped: %s", interrupted)
                break
            except Exception as exc:
                logger.exception("Scheduled refresh failed")
                health.update(last_error=f"{type(exc).__name__}: {exc}"[:500])
                wait = timedelta(hours=retry_hours)
                logger.warning(
                    "Retrying scheduled refresh in %s hour(s) (at %s).",
                    retry_hours, (now() + wait).isoformat(timespec="minutes"),
                )
            finally:
                health.update(refreshing=False, published_at=_safe_active_release(active_release, health))
            wait_until(now() + wait, stop_event, now=now, poll_seconds=poll_seconds)


def _wait_for_database(
    database_url: str, stop_event: Event, *, poll_seconds: float, connect: Callable[..., Any] | None = None
) -> bool:
    """Block until the database accepts connections (or a stop is requested; then False)."""
    announced = False
    while not stop_event.is_set():
        try:
            (connect or psycopg.connect)(database_url).close()
            if announced:
                logger.info("Database is accepting connections again.")
            return True
        except psycopg.OperationalError as error:
            if not announced:
                logger.warning("Database not ready (%s); waiting.", str(error).splitlines()[0][:160])
                announced = True
            stop_event.wait(min(5.0, max(poll_seconds, 0.05)))
    return False


def _safe_active_release(read: Callable[[], datetime | None], health: WorkerHealth) -> datetime | None:
    """Read the active release time; keep the last known value if the database is unreachable."""
    try:
        return read()
    except Exception:
        logger.exception("Could not read the active analytical release; keeping the last known health state")
        return health.published_at
