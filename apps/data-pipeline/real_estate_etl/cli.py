"""Command-line interface for the Slovenian real-estate data pipeline.

Every command that writes to the database runs inside the shared maintenance lock
(:func:`publication.maintenance_lock`), so it never interleaves with the Compose
scheduler or another maintenance command. ``refresh-system`` and
``reset-and-repopulate`` take the same lock themselves.
"""

from __future__ import annotations

import argparse
import enum
import logging
import os
import sys
from collections.abc import Callable
from datetime import UTC, datetime, timedelta
from pathlib import Path

import psycopg

from .construction import sync_construction
from .context import sync_context
from .demography import sync_demography
from .geography import export_boundary_seed, sync_geographies
from .health import DEFAULT_MAX_AGE, check_health_file
from .importer import import_zip
from .logging_config import configure_logging
from .operations import (
    DEFAULT_INTERVAL_DAYS,
    DEFAULT_RETRY_HOURS,
    format_analytics_counts,
    refresh_analytics,
    refresh_system,
    reset_and_repopulate,
    scheduled_refresh_loop,
)
from .pipeline import (
    fetch_national_zip,
    fetch_zip,
    refresh_all_national,
    refresh_all_sales,
    sync_reference_data,
    validate_worker_count,
)
from .publication import maintenance_lock
from .registers import sync_registers
from .settings import (
    AVAILABLE_THREADS,
    DEFAULT_DATABASE_URL,
    DEFAULT_WORKERS,
    NATIONAL_DATASETS,
    RAW_DATA_DIR,
    SALES_START_YEAR,
)

logger = logging.getLogger(__name__)


class Database(enum.Enum):
    """How a command uses the database."""

    NONE = "none"  # no connection
    LOCKED = "locked"  # connection held inside the maintenance lock by run()
    SELF_LOCKING = "self_locking"  # the operation takes the maintenance lock itself
    READ_ONLY = "read_only"  # a plain connection without the lock: the command only reads


Handler = Callable[[argparse.Namespace, "psycopg.Connection | None"], None]


def _current_year() -> int:
    return datetime.now(UTC).year


def _command(
    commands: argparse._SubParsersAction, name: str, handler: Handler, database: Database, **kwargs: str,
) -> argparse.ArgumentParser:
    parser = commands.add_parser(name, **kwargs)
    parser.set_defaults(handler=handler, database=database)
    return parser


# --------------------------------------------------------------------------- handlers

def _sync_reference_data(_args: argparse.Namespace, connection: psycopg.Connection) -> None:
    sync_reference_data(connection)


def _sync_geographies(_args: argparse.Namespace, connection: psycopg.Connection) -> None:
    sync_geographies(connection)


def _export_boundaries(args: argparse.Namespace, connection: psycopg.Connection) -> None:
    export_boundary_seed(connection, Path(args.output))


def _sync_context(_args: argparse.Namespace, connection: psycopg.Connection) -> None:
    sync_context(connection)


def _sync_demography(_args: argparse.Namespace, connection: psycopg.Connection) -> None:
    sync_demography(connection)


def _sync_construction(args: argparse.Namespace, connection: psycopg.Connection) -> None:
    sync_construction(connection, args.output_dir)


def _sync_registers(args: argparse.Namespace, connection: psycopg.Connection) -> None:
    sync_registers(connection, args.output_dir)


def _refresh_models(args: argparse.Namespace, connection: psycopg.Connection) -> None:
    from .model_reporting import format_model_report
    from .modeling import refresh_models

    for result in refresh_models(connection, args.workers):
        logger.info("%s", format_model_report(result))


def _fetch(args: argparse.Namespace, _connection: None) -> None:
    fetch_zip(args.municipality, args.year, args.output_dir)


def _fetch_national(args: argparse.Namespace, _connection: None) -> None:
    fetch_national_zip(args.dataset_type, args.year, args.output_dir)


def _import(args: argparse.Namespace, connection: psycopg.Connection) -> None:
    import_zip(connection, args.zip_file, verbose=args.verbose)


def _refresh(args: argparse.Namespace, connection: psycopg.Connection) -> None:
    sync_reference_data(connection)
    archive = fetch_zip(args.municipality, args.year, args.output_dir)
    import_zip(connection, archive, verbose=args.verbose)


def _refresh_all_sales(args: argparse.Namespace, connection: psycopg.Connection) -> None:
    refresh_all_sales(
        connection, args.output_dir, args.start_year, args.end_year, args.force, args.workers, args.verbose,
    )


def _refresh_all_data(args: argparse.Namespace, connection: psycopg.Connection) -> None:
    refresh_all_national(connection, args.output_dir, args.end_year, args.force, args.workers, args.verbose)


def _refresh_system(args: argparse.Namespace, connection: psycopg.Connection) -> None:
    refresh_system(
        connection,
        output_dir=args.output_dir,
        end_year=args.end_year,
        force=args.force,
        workers=args.workers,
        verbose=args.verbose,
        database_url=args.database_url,
    )


def _refresh_analytics(_args: argparse.Namespace, connection: psycopg.Connection) -> None:
    logger.info("Refreshed analytics: %s", format_analytics_counts(refresh_analytics(connection)))


def _reset_and_repopulate(args: argparse.Namespace, connection: psycopg.Connection) -> None:
    reset_and_repopulate(
        connection,
        output_dir=args.output_dir,
        end_year=args.end_year,
        workers=args.workers,
        verbose=args.verbose,
        database_url=args.database_url,
    )


def _schedule(args: argparse.Namespace, _connection: None) -> None:
    scheduled_refresh_loop(
        args.database_url,
        output_dir=args.output_dir,
        interval_days=args.interval_days,
        retry_hours=args.retry_hours,
        workers=args.workers,
        verbose=args.verbose,
        health_file=args.health_file,
    )


def _healthcheck(args: argparse.Namespace, _connection: None) -> None:
    healthy, reason = check_health_file(args.health_file, max_age=timedelta(seconds=args.max_age_seconds))
    if not healthy:
        raise SystemExit(f"unhealthy: {reason}")
    logger.info("healthy: %s", reason)


# --------------------------------------------------------------------------- parser

def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Fetch and import Slovenian JGP real-estate data")
    parser.add_argument("--database-url", default=os.getenv("DATABASE_URL", DEFAULT_DATABASE_URL))
    commands = parser.add_subparsers(dest="command", required=True)
    current_year = _current_year()

    _command(commands, "sync-reference-data", _sync_reference_data, Database.LOCKED)
    _command(commands, "sync-geographies", _sync_geographies, Database.LOCKED,
             help="Import current GURS RPE boundaries into the analytics schema")
    export = _command(commands, "export-boundaries", _export_boundaries, Database.READ_ONLY,
                      help="Write the stored RPE boundaries to a seed archive for first installs")
    export.add_argument("--output", default="/data/raw/rpe-boundaries.zip")
    _command(commands, "sync-context", _sync_context, Database.LOCKED,
             help="Import SURS wages, Banka Slovenije housing-loan rates and ECB EURIBOR")
    _command(commands, "sync-demography", _sync_demography, Database.LOCKED,
             help="Import SURS population, deaths, migration, dwellings and households")
    construction = _command(commands, "sync-construction", _sync_construction, Database.LOCKED,
                            help="Import GURS buildings and SURS permits")
    _add_output_dir(construction)
    registers = _command(commands, "sync-registers", _sync_registers, Database.LOCKED,
                         help="Import energy certificates, GURS generalised values and DRSV flood classes")
    _add_output_dir(registers)

    models = _command(commands, "refresh-models", _refresh_models, Database.LOCKED,
                      help="Cross-fit hedonic and Isolation Forest models and refresh anomaly scores")
    _add_workers(models, "Parallel property-group and Isolation Forest workers")

    fetch = _command(commands, "fetch", _fetch, Database.NONE,
                     help="Diagnostics: download one municipality/year sales archive")
    fetch.add_argument("--municipality", type=int, required=True)
    fetch.add_argument("--year", type=int, required=True)
    _add_output_dir(fetch)

    fetch_national = _command(commands, "fetch-national", _fetch_national, Database.NONE,
                              help="Download one national BUY or RENT yearly archive")
    fetch_national.add_argument("--type", choices=tuple(NATIONAL_DATASETS), required=True, dest="dataset_type")
    fetch_national.add_argument("--year", type=int, required=True)
    _add_output_dir(fetch_national)

    load = _command(commands, "import", _import, Database.LOCKED, help="Import one downloaded ETN archive")
    load.add_argument("zip_file", type=Path)
    load.add_argument("--verbose", action="store_true")

    refresh = _command(commands, "refresh", _refresh, Database.LOCKED,
                       help="Diagnostics: download and import one municipality/year sales archive")
    refresh.add_argument("--municipality", type=int, required=True)
    refresh.add_argument("--year", type=int, required=True)
    _add_output_dir(refresh)
    refresh.add_argument("--verbose", action="store_true")

    all_sales = _command(commands, "refresh-all-sales", _refresh_all_sales, Database.LOCKED,
                         help="Diagnostics: download and import all municipality/year sales data")
    all_sales.add_argument("--start-year", type=int, default=SALES_START_YEAR)
    all_sales.add_argument("--end-year", type=int, default=current_year)
    _add_refresh_options(all_sales, "Refresh combinations already present in source_files")

    all_national = _command(commands, "refresh-all-data", _refresh_all_data, Database.LOCKED,
                            help="Download and import all national yearly BUY and RENT archives")
    all_national.add_argument("--end-year", type=int, default=current_year)
    _add_refresh_options(all_national, "Refresh national years already imported")

    system = _command(
        commands, "refresh-system", _refresh_system, Database.SELF_LOCKING,
        help=(
            "Incrementally import GURS data, synchronize geography, refresh analytics, "
            "with training controlled by MODEL_REFRESH_POLICY (auto or manual)"
        ),
    )
    system.add_argument("--end-year", type=int, default=current_year)
    _add_refresh_options(system, "Download current source versions even when already imported")

    _command(commands, "refresh-analytics", _refresh_analytics, Database.LOCKED,
             help="Refresh deterministic analytical facts, outliers, quality profiles, and indices")

    reset = _command(commands, "reset-and-repopulate", _reset_and_repopulate, Database.SELF_LOCKING,
                     help="Delete imported/derived market data and rebuild it; preserves users/preferences")
    reset.add_argument("--confirm-reset", action="store_true")
    reset.add_argument("--end-year", type=int, default=current_year)
    _add_output_dir(reset)
    _add_workers(reset, "Parallel download and model workers")
    reset.add_argument("--verbose", action="store_true")

    schedule = _command(commands, "schedule", _schedule, Database.NONE,
                        help="Run a complete refresh immediately and then every configured interval")
    schedule.add_argument(
        "--interval-days", type=int, default=int(os.getenv("REFRESH_INTERVAL_DAYS", DEFAULT_INTERVAL_DAYS)),
    )
    schedule.add_argument(
        "--retry-hours", type=int, default=int(os.getenv("REFRESH_RETRY_HOURS", DEFAULT_RETRY_HOURS)),
    )
    _add_output_dir(schedule)
    schedule.add_argument("--health-file", type=Path, help="Heartbeat file; see real_estate_etl.health")
    _add_workers(schedule, "Parallel download and model workers")
    schedule.add_argument("--verbose", action="store_true")

    health = _command(commands, "healthcheck", _healthcheck, Database.NONE,
                      help="Exit non-zero unless the scheduler's health file is fresh and healthy")
    health.add_argument("--health-file", type=Path, required=True)
    health.add_argument("--max-age-seconds", type=int, default=int(DEFAULT_MAX_AGE.total_seconds()))
    return parser


def _add_output_dir(parser: argparse.ArgumentParser) -> None:
    parser.add_argument(
        "--output-dir", type=Path, default=RAW_DATA_DIR,
        help=f"Download directory (default: $RAW_DATA_DIR or {RAW_DATA_DIR})",
    )


def _add_workers(parser: argparse.ArgumentParser, description: str) -> None:
    parser.add_argument(
        "--workers",
        type=int,
        default=DEFAULT_WORKERS,
        metavar="N",
        help=f"{description} (default: {DEFAULT_WORKERS}; machine limit: {AVAILABLE_THREADS})",
    )


def _add_refresh_options(parser: argparse.ArgumentParser, force_help: str) -> None:
    _add_output_dir(parser)
    parser.add_argument("--force", action="store_true", help=force_help)
    _add_workers(parser, "Parallel download workers")
    parser.add_argument("--verbose", action="store_true", help="Print per-table row counts and codebook details")


def validate_arguments(parser: argparse.ArgumentParser, args: argparse.Namespace) -> None:
    if args.command == "fetch-national":
        start_year = NATIONAL_DATASETS[args.dataset_type].start_year
        if args.year < start_year:
            parser.error(f"{args.dataset_type} national data starts in {start_year}")
    if args.command == "reset-and-repopulate" and not args.confirm_reset:
        parser.error("reset-and-repopulate requires --confirm-reset")
    if args.command == "schedule":
        if args.interval_days < 1:
            parser.error("--interval-days must be at least 1")
        if args.retry_hours < 1:
            parser.error("--retry-hours must be at least 1")
    if args.command == "refresh-all-sales" and args.start_year > args.end_year:
        parser.error("--start-year must not be later than --end-year")
    if hasattr(args, "end_year") and args.end_year < SALES_START_YEAR:
        parser.error(f"--end-year must be {SALES_START_YEAR} or later")
    if hasattr(args, "workers"):
        try:
            validate_worker_count(args.workers)
        except ValueError as exc:
            parser.error(str(exc))


def run(args: argparse.Namespace) -> None:
    if args.database is Database.NONE:
        args.handler(args, None)
        return
    with psycopg.connect(args.database_url) as connection:
        if args.database in (Database.SELF_LOCKING, Database.READ_ONLY):
            args.handler(args, connection)
            return
        with maintenance_lock(connection):
            args.handler(args, connection)


def main(argv: list[str] | None = None) -> None:
    configure_logging()
    parser = build_parser()
    args = parser.parse_args(argv)
    validate_arguments(parser, args)
    try:
        run(args)
    except SystemExit:
        raise
    except Exception:
        logger.exception("command %s failed", args.command)
        sys.exit(1)


if __name__ == "__main__":
    main()
