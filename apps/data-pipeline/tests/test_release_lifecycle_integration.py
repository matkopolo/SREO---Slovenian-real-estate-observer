"""The release bookkeeping against PostgreSQL: stage, failure, superseding and the atomic switch.

Rows are created with fresh UUIDs and removed again; the active release is never changed
(``publish_release`` runs inside a ``force_rollback`` transaction), so the tests can run
against a database other work is using.
"""

import os
import uuid
from datetime import timedelta

import psycopg
import pytest

from real_estate_etl.publication import (
    active_release_published_at,
    fail_release,
    publish_release,
    record_source_status,
    set_release_stage,
    supersede_stale_releases,
)

pytestmark = pytest.mark.integration
DATABASE_URL = os.getenv("TEST_DATABASE_URL")


@pytest.fixture
def database_url() -> str:
    if not DATABASE_URL:
        pytest.skip("TEST_DATABASE_URL is not set")
    return DATABASE_URL


@pytest.fixture
def processing_release(database_url: str):
    """A ``processing`` release started long ago; skipped while a real refresh is processing."""
    release_id = uuid.uuid4()
    with psycopg.connect(database_url) as setup:
        if setup.execute("SELECT count(*) FROM analytics.analytical_releases WHERE status='processing'").fetchone()[0]:
            pytest.skip("a refresh is processing right now; the single-processing-release index would reject the fixture")
        setup.execute(
            """INSERT INTO analytics.analytical_releases(id,status,stage,started_at)
               VALUES(%s,'processing','source',clock_timestamp()-interval '3 days')""",
            (release_id,),
        )
        setup.commit()
    try:
        yield release_id
    finally:
        with psycopg.connect(database_url) as cleanup:
            cleanup.execute(
                "DELETE FROM analytics.refresh_runs WHERE details->>'release_id'=%s", (str(release_id),)
            )
            cleanup.execute(
                "UPDATE analytics.analytical_publication SET pending_release_id=NULL WHERE pending_release_id=%s",
                (release_id,),
            )
            cleanup.execute("DELETE FROM analytics.analytical_releases WHERE id=%s", (release_id,))


def test_stage_sources_and_failure_are_recorded_through_the_status_connection(database_url, processing_release):
    set_release_stage(database_url, processing_release, "analytics")
    record_source_status(database_url, processing_release, {"rpe_boundaries": "ok", "surs_deaths": "HTTP 500"})
    fail_release(database_url, processing_release, RuntimeError("sale refresh failed"))

    with psycopg.connect(database_url) as reader:
        status, stage, message, details = reader.execute(
            "SELECT status,stage,failure_message,details FROM analytics.analytical_releases WHERE id=%s",
            (processing_release,),
        ).fetchone()
        runs = reader.execute(
            """SELECT process,status,details->>'stage',details->>'error'
               FROM analytics.refresh_runs WHERE details->>'release_id'=%s""",
            (str(processing_release),),
        ).fetchall()
    assert (status, stage, message) == ("failed", "failed", "RuntimeError: sale refresh failed")
    assert details["sources"] == {"rpe_boundaries": "ok", "surs_deaths": "HTTP 500"}
    assert runs == [("release:analytics", "failed", "analytics", "RuntimeError: sale refresh failed")]


def test_abandoned_processing_release_is_superseded_at_startup(database_url, processing_release):
    assert supersede_stale_releases(database_url, older_than=timedelta(days=30)) == []
    assert supersede_stale_releases(database_url, older_than=timedelta(days=1)) == [processing_release]
    with psycopg.connect(database_url) as reader:
        status, stage = reader.execute(
            "SELECT status,stage FROM analytics.analytical_releases WHERE id=%s", (processing_release,),
        ).fetchone()
    assert (status, stage) == ("failed", "superseded")


def test_publish_release_switches_the_active_release_atomically(database_url, processing_release):
    with psycopg.connect(database_url) as connection, psycopg.connect(database_url) as reader:
        before = active_release_published_at(reader)
        with connection.transaction(force_rollback=True):
            publish_release(connection, processing_release, "sale-v,rent-v")
            status, published_at, active = connection.execute(
                """SELECT release.status,release.published_at,publication.active_release_id
                   FROM analytics.analytical_releases release, analytics.analytical_publication publication
                   WHERE release.id=%s""",
                (processing_release,),
            ).fetchone()
            assert (status, active) == ("published", processing_release)
            assert published_at is not None
            assert active_release_published_at(reader) == before  # invisible until commit
    with psycopg.connect(database_url) as after:
        assert active_release_published_at(after) == before
