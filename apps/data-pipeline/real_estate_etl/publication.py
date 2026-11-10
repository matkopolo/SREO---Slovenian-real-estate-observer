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
from datetime import date, datetime

import psycopg

logger = logging.getLogger(__name__)

#: Keep the value stable: database maintenance tools may take the same lock.
REFRESH_LOCK_ID = 724_202_607
FAILURE_MESSAGE_LIMIT = 2000


class RefreshAlreadyRunning(RuntimeError):
    """Another pipeline process holds the maintenance lock."""


@contextmanager
def maintenance_lock(connection: psycopg.Connection) -> Iterator[None]:
    """Hold the pipeline advisory lock for the duration of the block.

    Raises :class:`RefreshAlreadyRunning` immediately instead of waiting. The block's
    work is committed on success; on failure it is rolled back. The lock is always
    released.
    """
    acquired = connection.execute("SELECT pg_try_advisory_lock(%s)", (REFRESH_LOCK_ID,)).fetchone()[0]
    connection.commit()
    if not acquired:
        raise RefreshAlreadyRunning("another data-pipeline refresh or maintenance command is already running")
    try:
        yield
        connection.commit()
    finally:
        connection.rollback()
        connection.execute("SELECT pg_advisory_unlock(%s)", (REFRESH_LOCK_ID,))
        connection.commit()


def _source_through(connection: psycopg.Connection) -> tuple[date | None, date | None]:
    sale_through, rent_through = connection.execute(
        """SELECT (SELECT max(contract_date) FROM transactions),
                  (SELECT max(contract_date) FROM rental_transactions)"""
    ).fetchone()
    connection.commit()
    return sale_through, rent_through


def start_release(connection: psycopg.Connection, database_url: str) -> uuid.UUID:
    """Create a ``processing`` release, superseding any abandoned one, and mark it pending."""
    release_id = uuid.uuid4()
    sale_through, rent_through = _source_through(connection)
    with psycopg.connect(database_url) as status_connection:
        superseded = status_connection.execute(
            """
            UPDATE analytics.analytical_releases
            SET status='failed',stage='superseded',failed_at=clock_timestamp(),
                failure_message='superseded by a newer refresh'
            WHERE status='processing'
            RETURNING id
            """
        ).fetchall()
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


def update_release_source(connection: psycopg.Connection, database_url: str, release_id: uuid.UUID) -> None:
    """Record the newest imported contract dates and move the release to the geography stage."""
    sale_through, rent_through = _source_through(connection)
    with psycopg.connect(database_url) as status_connection:
        status_connection.execute(
            """UPDATE analytics.analytical_releases
               SET source_sale_through=%s,source_rent_through=%s,stage='geography'
               WHERE id=%s""",
            (sale_through, rent_through, release_id),
        )
    logger.info("release=%s stage=geography (sale data through %s, rent data through %s)",
                release_id, sale_through, rent_through)


def set_release_stage(database_url: str, release_id: uuid.UUID, stage: str) -> None:
    with psycopg.connect(database_url) as status_connection:
        status_connection.execute(
            "UPDATE analytics.analytical_releases SET stage=%s WHERE id=%s",
            (stage, release_id),
        )
    logger.info("release=%s stage=%s", release_id, stage)


def record_source_status(database_url: str, release_id: uuid.UUID, sources: dict[str, str]) -> None:
    """Store ``{source: "ok" | error}`` under ``details.sources`` on the release."""
    with psycopg.connect(database_url) as status_connection:
        status_connection.execute(
            """UPDATE analytics.analytical_releases
               SET details=details||jsonb_build_object('sources',%s::jsonb)
               WHERE id=%s""",
            (json.dumps(sources, sort_keys=True), release_id),
        )
    failed = sorted(name for name, status in sources.items() if status != "ok")
    if failed:
        logger.warning("release=%s optional sources failed and kept stored values: %s", release_id, ", ".join(failed))


def fail_release(database_url: str, release_id: uuid.UUID, error: BaseException) -> None:
    """Mark the release failed and clear it as the pending release."""
    message = f"{type(error).__name__}: {error}"
    with psycopg.connect(database_url) as status_connection:
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
    logger.error("release=%s failed: %s", release_id, message)


def publish_release(connection: psycopg.Connection, release_id: uuid.UUID, model_versions: str | None) -> None:
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


def active_release_published_at(connection: psycopg.Connection) -> datetime | None:
    """Publication time of the active release, or ``None`` before the first publication."""
    row = connection.execute(
        """SELECT release.published_at
           FROM analytics.analytical_publication publication
           JOIN analytics.analytical_releases release ON release.id=publication.active_release_id
           WHERE publication.singleton"""
    ).fetchone()
    connection.commit()
    return row[0] if row else None
