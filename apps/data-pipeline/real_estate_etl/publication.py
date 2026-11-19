"""The maintenance lock and the analytical-release lifecycle.

Every command that writes to the database runs inside :func:`maintenance_lock`, a
session-level PostgreSQL advisory lock, so a manual command never interleaves with the
Compose scheduler (or with another manual command).

A system refresh records its progress in ``analytics.analytical_releases``:
``processing`` (with a stage) until it is ``published`` or ``failed``. Stage, source and
failure updates use short separate connections, so they stay visible while the main
refresh transaction is still open and survive its rollback.
"""

from __future__ import annotations

import json
import logging
import uuid
from collections.abc import Iterator
from contextlib import contextmanager
from datetime import UTC, date, datetime, timedelta
from typing import Any

import psycopg

from .database import connect, scalar
from .source_sync import SOURCE_SEED, SUCCESSFUL_STATUSES

logger = logging.getLogger(__name__)

#: Keep the value stable: database maintenance tools may take the same lock.
REFRESH_LOCK_ID = 724_202_607
FAILURE_MESSAGE_LIMIT = 2000
#: A ``processing`` release older than this at scheduler start belongs to a worker that
#: was killed mid-refresh; nothing can still be writing it (the lock holder is gone).
STALE_PROCESSING_AGE = timedelta(hours=1)


class RefreshAlreadyRunning(RuntimeError):
    """Another pipeline process holds the maintenance lock."""


@contextmanager
def maintenance_lock(connection: psycopg.Connection[Any]) -> Iterator[None]:
    """Hold the pipeline advisory lock for the duration of the block.

    Raises :class:`RefreshAlreadyRunning` immediately instead of waiting. The block's
    work is committed on success; on failure it is rolled back. The lock is always
    released: explicitly on a live connection, and by the server itself when the
    session is gone (a broken connection is left alone so the original error is kept).
    """
    acquired = scalar(connection, "SELECT pg_try_advisory_lock(%s)", (REFRESH_LOCK_ID,))
    connection.commit()
    if not acquired:
        raise RefreshAlreadyRunning("another data-pipeline refresh or maintenance command is already running")
    try:
        yield
        connection.commit()
    finally:
        if not connection.closed and not connection.broken:
            connection.rollback()
            connection.execute("SELECT pg_advisory_unlock(%s)", (REFRESH_LOCK_ID,))
            connection.commit()


def _source_through(connection: psycopg.Connection[Any]) -> tuple[date | None, date | None]:
    row = connection.execute(
        """SELECT (SELECT max(contract_date) FROM transactions),
                  (SELECT max(contract_date) FROM rental_transactions)"""
    ).fetchone()
    connection.commit()
    if row is None:
        return None, None
    sale_through, rent_through = row
    return sale_through, rent_through


def _supersede_processing(status_connection: psycopg.Connection[Any], *, older_than: timedelta | None) -> list[Any]:
    """Mark ``processing`` releases failed; ``older_than`` limits it to abandoned ones."""
    cutoff = timedelta(0) if older_than is None else older_than
    return status_connection.execute(
        """
        UPDATE analytics.analytical_releases
        SET status='failed',stage='superseded',failed_at=clock_timestamp(),
            failure_message='superseded by a newer refresh'
        WHERE status='processing' AND started_at<=clock_timestamp()-%s::interval
        RETURNING id
        """,
        (cutoff,),
    ).fetchall()


def supersede_stale_releases(database_url: str, *, older_than: timedelta = STALE_PROCESSING_AGE) -> list[Any]:
    """Fail ``processing`` releases a killed worker left behind and clear them as pending.

    Called when the scheduler starts, before any refresh, so a release abandoned by a
    SIGKILL does not stay "in progress" until the next successful start.

    Returns:
        The ids of the releases that were marked failed.
    """
    with connect(database_url) as status_connection:
        superseded = _supersede_processing(status_connection, older_than=older_than)
        status_connection.execute(
            """
            UPDATE analytics.analytical_publication publication
            SET pending_release_id=NULL,updated_at=clock_timestamp()
            FROM analytics.analytical_releases release
            WHERE publication.singleton AND release.id=publication.pending_release_id
              AND release.status='failed'
            """
        )
    for (abandoned,) in superseded:
        logger.warning("release=%s was abandoned by an earlier worker; marked failed", abandoned)
    return [abandoned for (abandoned,) in superseded]


def start_release(connection: psycopg.Connection[Any], database_url: str) -> uuid.UUID:
    """Create a ``processing`` release, superseding any abandoned one, and mark it pending."""
    release_id = uuid.uuid4()
    sale_through, rent_through = _source_through(connection)
    with connect(database_url) as status_connection:
        superseded = _supersede_processing(status_connection, older_than=None)
        status_connection.execute(
            """
            INSERT INTO analytics.analytical_releases(
                id,status,stage,source_sale_through,source_rent_through
            ) VALUES(%s,'processing','source',%s,%s)
            """,
            (release_id, sale_through, rent_through),
        )
        status_connection.execute(
            """
            UPDATE analytics.analytical_publication
            SET pending_release_id=%s,updated_at=clock_timestamp()
            WHERE singleton
            """,
            (release_id,),
        )
    for (abandoned,) in superseded:
        logger.warning("release=%s was still processing; marked failed (superseded by %s)", abandoned, release_id)
    logger.info(
        "release=%s started (sale data through %s, rent data through %s)", release_id, sale_through, rent_through,
    )
    return release_id


def update_release_source(connection: psycopg.Connection[Any], database_url: str, release_id: uuid.UUID) -> None:
    """Record the newest imported contract dates and move the release to the geography stage."""
    sale_through, rent_through = _source_through(connection)
    with connect(database_url) as status_connection:
        status_connection.execute(
            """UPDATE analytics.analytical_releases
               SET source_sale_through=%s,source_rent_through=%s,stage='geography'
               WHERE id=%s""",
            (sale_through, rent_through, release_id),
        )
    logger.info("release=%s stage=geography (sale data through %s, rent data through %s)",
                release_id, sale_through, rent_through)


def set_release_stage(database_url: str, release_id: uuid.UUID, stage: str) -> None:
    """Record ``stage`` on the release through a short separate connection."""
    with connect(database_url) as status_connection:
        status_connection.execute(
            "UPDATE analytics.analytical_releases SET stage=%s WHERE id=%s",
            (stage, release_id),
        )
    logger.info("release=%s stage=%s", release_id, stage)


def record_source_status(database_url: str, release_id: uuid.UUID, sources: dict[str, str]) -> None:
    """Store ``{source: "ok" | error}`` under ``details.sources`` on the release."""
    with connect(database_url) as status_connection:
        status_connection.execute(
            """UPDATE analytics.analytical_releases
               SET details=details||jsonb_build_object('sources',%s::jsonb)
               WHERE id=%s""",
            (json.dumps(sources, sort_keys=True), release_id),
        )
    seeded = sorted(name for name, status in sources.items() if status == SOURCE_SEED)
    if seeded:
        logger.warning("release=%s sources loaded from the published seed: %s", release_id, ", ".join(seeded))
    failed = sorted(name for name, status in sources.items() if status not in SUCCESSFUL_STATUSES)
    if failed:
        logger.warning("release=%s optional sources failed and kept stored values: %s", release_id, ", ".join(failed))


def fail_release(database_url: str, release_id: uuid.UUID, error: BaseException) -> None:
    """Mark the release failed, clear it as the pending release and log the failed stage.

    The ``analytics.refresh_runs`` rows a stage writes inside the release transaction
    roll back with it, so the stage that was running is recorded here as a failed run
    through the status connection; any run still marked ``running`` is closed as failed
    as well.
    """
    message = f"{type(error).__name__}: {error}"
    with connect(database_url) as status_connection:
        row = status_connection.execute(
            "SELECT stage,started_at FROM analytics.analytical_releases WHERE id=%s", (release_id,),
        ).fetchone()
        stage, started_at = row if row is not None else ("unknown", datetime.now(UTC))
        status_connection.execute(
            """
            UPDATE analytics.analytical_releases
            SET status='failed',stage='failed',failed_at=clock_timestamp(),
                failure_message=left(%s,%s)
            WHERE id=%s
            """,
            (message, FAILURE_MESSAGE_LIMIT, release_id),
        )
        status_connection.execute(
            """
            UPDATE analytics.analytical_publication
            SET pending_release_id=NULL,updated_at=clock_timestamp()
            WHERE singleton AND pending_release_id=%s
            """,
            (release_id,),
        )
        status_connection.execute(
            """
            UPDATE analytics.refresh_runs
            SET status='failed',finished_at=clock_timestamp(),
                details=details||jsonb_build_object('release_id',%s::text,'error',left(%s::text,%s::int))
            WHERE status='running'
            """,
            (str(release_id), message, FAILURE_MESSAGE_LIMIT),
        )
        status_connection.execute(
            """
            INSERT INTO analytics.refresh_runs(process,status,started_at,finished_at,details)
            VALUES(%s,'failed',%s,clock_timestamp(),
                   jsonb_build_object('release_id',%s::text,'stage',%s::text,'error',left(%s::text,%s::int)))
            """,
            (f"release:{stage}", started_at, str(release_id), stage, message, FAILURE_MESSAGE_LIMIT),
        )
    logger.error("release=%s failed in stage %s: %s", release_id, stage, message)


def publish_release(connection: psycopg.Connection[Any], release_id: uuid.UUID, model_versions: str | None) -> None:
    """Activate the release inside the caller's transaction; readers switch on commit."""
    connection.execute(
        """
        UPDATE analytics.analytical_releases
        SET status='published',stage='published',published_at=clock_timestamp(),
            analytics_sale_through=(SELECT max(contract_date) FROM analytics.sale_facts),
            analytics_rent_through=(SELECT max(contract_date) FROM analytics.rental_facts),
            model_versions=%s
        WHERE id=%s
        """,
        (model_versions, release_id),
    )
    connection.execute(
        """
        UPDATE analytics.analytical_publication
        SET active_release_id=%s,pending_release_id=NULL,updated_at=clock_timestamp()
        WHERE singleton
        """,
        (release_id,),
    )


def active_release_published_at(connection: psycopg.Connection[Any]) -> datetime | None:
    """Publication time of the active release, or ``None`` before the first publication."""
    row = connection.execute(
        """SELECT release.published_at
           FROM analytics.analytical_publication publication
           JOIN analytics.analytical_releases release ON release.id=publication.active_release_id
           WHERE publication.singleton"""
    ).fetchone()
    connection.commit()
    return row[0] if row else None
