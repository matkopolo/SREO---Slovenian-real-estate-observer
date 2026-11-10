"""Download orchestration for incremental GURS archive refreshes."""

from __future__ import annotations

import logging
import time
import zipfile
from collections.abc import Callable, Sequence
from concurrent.futures import FIRST_COMPLETED, Future, ThreadPoolExecutor, wait
from pathlib import Path
from typing import TypeVar

import httpx
import psycopg

from . import http_client
from .api import DatasetUnavailable, JGPClient
from .formatting import format_duration
from .importer import import_zip
from .models import ArchiveResult, RefreshSummary
from .settings import API_BASE, AVAILABLE_THREADS, NATIONAL_DATASETS

logger = logging.getLogger(__name__)

WorkItem = TypeVar("WorkItem")


def sync_reference_data(connection: psycopg.Connection, client: httpx.Client | None = None) -> None:
    """Upsert municipality and cadastral-municipality reference data."""
    if client is None:
        with http_client.create_client() as owned:
            sync_reference_data(connection, owned)
        return
    municipalities = http_client.fetch_json(client, f"{API_BASE}/municipalities", "GURS municipalities")
    cadastral = http_client.fetch_json(client, f"{API_BASE}/register-municipalities", "GURS cadastral municipalities")
    with connection.cursor() as cursor:
        cursor.executemany(
            """INSERT INTO municipalities(code,name) VALUES (%s,%s)
               ON CONFLICT(code) DO UPDATE SET name=excluded.name""",
            [(int(item["sifra"]), item["name"]) for item in municipalities],
        )
        cursor.executemany(
            """INSERT INTO cadastral_municipalities(code,name) VALUES (%s,%s)
               ON CONFLICT(code) DO UPDATE SET name=excluded.name""",
            [(int(item["sifko"]), item["name"]) for item in cadastral],
        )
    connection.commit()
    logger.info(
        "Synced %s municipalities and %s cadastral municipalities",
        len(municipalities),
        len(cadastral),
    )


def fetch_zip(municipality: int, year: int, output_dir: Path, client: JGPClient | None = None) -> Path:
    if client is not None:
        return client.fetch_municipality(municipality, year)
    with JGPClient(output_dir) as owned:
        return owned.fetch_municipality(municipality, year)


def fetch_national_zip(dataset_type: str, year: int, output_dir: Path, client: JGPClient | None = None) -> Path:
    if client is not None:
        return client.fetch_national(dataset_type, year)
    with JGPClient(output_dir) as owned:
        return owned.fetch_national(dataset_type, year)


def _newest_local_archive(output_dir: Path, pattern: str) -> Path | None:
    local = sorted(output_dir.glob(pattern), reverse=True)
    return next((path for path in local if zipfile.is_zipfile(path)), None)


def prepare_archive(
    municipality: int, year: int, output_dir: Path, force: bool, client: JGPClient | None = None,
) -> ArchiveResult:
    started_at = time.monotonic()
    archive = _newest_local_archive(output_dir, f"ETN_{municipality:03d}_{year}_KPP_*.zip")
    if archive is not None and not force:
        return ArchiveResult(archive, True, time.monotonic() - started_at)
    return ArchiveResult(fetch_zip(municipality, year, output_dir, client), False, time.monotonic() - started_at)


def prepare_national_archive(
    dataset_type: str, year: int, output_dir: Path, force: bool, client: JGPClient | None = None,
) -> ArchiveResult:
    started_at = time.monotonic()
    pattern = f"ETN_SLO_{year}_{NATIONAL_DATASETS[dataset_type].archive_code}*.zip"
    archive = _newest_local_archive(output_dir, pattern)
    if archive is not None and not force:
        return ArchiveResult(archive, True, time.monotonic() - started_at)
    downloaded = fetch_national_zip(dataset_type, year, output_dir, client)
    _remove_superseded_archives(output_dir, pattern, keep=downloaded)
    return ArchiveResult(downloaded, False, time.monotonic() - started_at)


def _remove_superseded_archives(output_dir: Path, pattern: str, *, keep: Path) -> None:
    """Forced revision downloads would otherwise pile up one archive per refresh."""
    for stale in output_dir.glob(pattern):
        if stale != keep:
            logger.info("Removing superseded archive %s", stale.name)
            stale.unlink(missing_ok=True)


def validate_worker_count(workers: int, available_threads: int = AVAILABLE_THREADS) -> None:
    if workers < 1:
        raise ValueError("--workers must be at least 1")
    if workers > available_threads:
        raise ValueError(
            f"--workers cannot exceed the {available_threads} logical CPU threads available on this machine"
        )


def _run_refresh(
    connection: psycopg.Connection,
    combinations: Sequence[WorkItem],
    *,
    skipped: int,
    workers: int,
    verbose: bool,
    thread_name: str,
    prepare: Callable[[WorkItem], ArchiveResult],
    label: Callable[[int, int, WorkItem], str],
    summary_prefix: str,
) -> RefreshSummary:
    """Download concurrently while importing sequentially on one DB connection."""
    started_at = time.monotonic()
    work = iter(combinations)
    total = len(combinations)
    imported = unavailable = 0
    already_imported = skipped
    download_seconds = member_import_seconds = database_seconds = 0.0
    logger.info(
        "Queued %s archives; skipped %s already imported; download workers=%s; available logical CPU threads=%s",
        total, skipped, workers, AVAILABLE_THREADS,
    )

    executor = ThreadPoolExecutor(max_workers=workers, thread_name_prefix=thread_name)
    pending: dict[Future[ArchiveResult], WorkItem] = {}

    def submit_next() -> bool:
        try:
            item = next(work)
        except StopIteration:
            return False
        pending[executor.submit(prepare, item)] = item
        return True

    for _ in range(min(total, workers * 2)):
        submit_next()

    position = 0
    try:
        while pending:
            completed, _ = wait(pending, return_when=FIRST_COMPLETED)
            for future in completed:
                item = pending.pop(future)
                position += 1
                item_label = label(position, total, item)
                submit_next()
                try:
                    archive = future.result()
                    download_seconds += archive.download_seconds
                    if archive.reused:
                        logger.info("%s: using existing %s", item_label, archive.path)
                    elif verbose:
                        logger.info("%s: importing %s", item_label, archive.path)
                    stats = import_zip(connection, archive.path, verbose=verbose)
                    if stats.unchanged:
                        already_imported += 1
                        logger.info("%s: source checksum unchanged (%s)", item_label, archive.path.name)
                        continue
                    member_import_seconds += stats.member_import_seconds
                    database_seconds += stats.database_seconds
                    imported += 1
                    if not verbose:
                        logger.info(
                            "%s: imported %s data rows from %s", item_label, f"{stats.rows:,}", archive.path.name,
                        )
                except DatasetUnavailable as exc:
                    unavailable += 1
                    logger.warning("%s: unavailable (%s)", item_label, exc)
                except Exception:
                    logger.exception("%s: stopped by unexpected error", item_label)
                    raise
    finally:
        for future in pending:
            future.cancel()
        executor.shutdown(wait=True, cancel_futures=True)

    logger.info(
        "%s: imported=%s, already_imported=%s, unavailable=%s, elapsed=%s, download_worker_time=%s, "
        "member_import=%s, other_database=%s",
        summary_prefix, imported, already_imported, unavailable,
        format_duration(time.monotonic() - started_at), format_duration(download_seconds),
        format_duration(member_import_seconds), format_duration(database_seconds),
    )
    return RefreshSummary(imported, already_imported, unavailable)


def refresh_all_sales(
    connection: psycopg.Connection,
    output_dir: Path,
    start_year: int,
    end_year: int,
    force: bool,
    workers: int,
    verbose: bool = False,
) -> RefreshSummary:
    """Diagnostic per-municipality sales import; the national archives are the normal path."""
    sync_reference_data(connection)
    with connection.cursor() as cursor:
        cursor.execute("SELECT code FROM municipalities ORDER BY code")
        municipalities = [row[0] for row in cursor]
        cursor.execute("SELECT municipality_code,dataset_year FROM source_files WHERE municipality_code IS NOT NULL")
        imported = set(cursor.fetchall())
    connection.commit()
    all_items = [(code, year) for year in range(start_year, end_year + 1) for code in municipalities]
    items = [item for item in all_items if force or item not in imported]
    with JGPClient(output_dir) as client:
        return _run_refresh(
            connection,
            items,
            skipped=len(all_items) - len(items),
            workers=workers,
            verbose=verbose,
            thread_name="jgp-download",
            prepare=lambda item: prepare_archive(*item, output_dir, force, client),
            label=lambda position, total, item: f"[{position}/{total}] municipality={item[0]} year={item[1]}",
            summary_prefix="Finished municipality import",
        )


def refresh_all_national(
    connection: psycopg.Connection,
    output_dir: Path,
    end_year: int,
    force: bool,
    workers: int,
    verbose: bool = False,
    revision_years: int = 0,
) -> RefreshSummary:
    """Import every national BUY and RENT year that is missing.

    ``revision_years`` also re-downloads the newest N years (through ``end_year``):
    GURS keeps adding late-registered contracts to recent years. An unchanged archive
    is detected by its checksum and skipped cheaply.
    """
    sync_reference_data(connection)
    with connection.cursor() as cursor:
        cursor.execute(
            """SELECT dataset_type,dataset_year FROM source_files
               WHERE dataset_scope='national' AND dataset_type IN ('sales','rent')"""
        )
        imported = set(cursor.fetchall())
    connection.commit()
    first_revision_year = end_year - revision_years + 1

    def revision_due(item: tuple[str, int]) -> bool:
        return force or item[1] >= first_revision_year

    all_items = [
        (dataset_type, year)
        for dataset_type, product in NATIONAL_DATASETS.items()
        for year in range(product.start_year, end_year + 1)
    ]
    items = [item for item in all_items if item not in imported or revision_due(item)]
    with JGPClient(output_dir) as client:
        return _run_refresh(
            connection,
            items,
            skipped=len(all_items) - len(items),
            workers=workers,
            verbose=verbose,
            thread_name="jgp-national-download",
            prepare=lambda item: prepare_national_archive(*item, output_dir, revision_due(item), client),
            label=lambda position, total, item: f"[{position}/{total}] national {item[0]} year={item[1]}",
            summary_prefix="Finished national import",
        )
