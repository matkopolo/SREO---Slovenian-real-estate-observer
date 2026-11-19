"""Retention against PostgreSQL, inside one ``force_rollback`` transaction.

``prune_model_history`` opens ``connection.transaction()``; nested in the test's own
transaction it becomes a savepoint, so the fixtures and the deletions never commit and
the stored history of the database the tests run against is untouched.
"""

import json
import os
import uuid
from datetime import UTC, date, datetime, timedelta

import psycopg
import pytest

from real_estate_etl.retention import prune_model_history

pytestmark = pytest.mark.integration


def model_run(connection, kind: str, created_at: datetime) -> uuid.UUID:
    run_id = uuid.uuid4()
    connection.execute(
        """INSERT INTO analytics.model_runs(
               id,transaction_kind,model_version,model_type,feature_schema,training_rows,metrics,random_seed,created_at
           ) VALUES(%s,%s,%s,'test','{}'::jsonb,1,%s::jsonb,42,%s)""",
        (run_id, kind, f"test-{run_id}", json.dumps({"test": True}), created_at),
    )
    connection.execute(
        """INSERT INTO analytics.valuation_predictions(
               transaction_kind,transaction_id,model_run_id,predicted_amount_per_sqm,lower_amount_per_sqm,
               upper_amount_per_sqm,actual_amount_per_sqm,log_residual
           ) VALUES(%s,-9_000_000_000,%s,1000,900,1100,1000,0)""",
        (kind, run_id),
    )
    return run_id


def index_run(connection, kind: str, method: str, created_at: datetime, model_run_id=None) -> uuid.UUID:
    run_id = uuid.uuid4()
    connection.execute(
        """INSERT INTO analytics.index_calculation_runs(id,transaction_kind,method,methodology_version,created_at)
           VALUES(%s,%s,%s,'test-v1',%s)""",
        (run_id, kind, method, created_at),
    )
    connection.execute(
        """INSERT INTO analytics.market_indices(
               transaction_kind,method,property_group,geography_id,period,index_value,sample_size,base_period,
               model_run_id,methodology_version,calculation_run_id,observed_sample_size
           ) VALUES(%s,%s,'test_group',NULL,%s,100,1,%s,%s,'test-v1',%s,1)""",
        (kind, method, date(2026, 1, 1), date(2026, 1, 1), model_run_id, run_id),
    )
    return run_id


def ids(connection, table: str, column: str = "id") -> set[uuid.UUID]:
    rows = connection.execute(f"SELECT {column} FROM {table} WHERE {column} = ANY(%s)", (list(ALL),)).fetchall()
    return {row[0] for row in rows}


ALL: set[uuid.UUID] = set()


def test_prune_keeps_the_published_run_and_the_newest_three_per_kind():
    database_url = os.getenv("TEST_DATABASE_URL")
    if not database_url:
        pytest.skip("TEST_DATABASE_URL is not set")
    base = datetime(2030, 1, 1, tzinfo=UTC)  # newer than any real run, so the fixtures rank first
    with psycopg.connect(database_url) as connection, connection.transaction(force_rollback=True):
        connection.execute("SET CONSTRAINTS ALL IMMEDIATE")
        published = model_run(connection, "sale", base - timedelta(days=40))  # old, but published: kept
        newest = [model_run(connection, "sale", base - timedelta(days=offset)) for offset in (1, 2, 3)]
        pruned_runs = [model_run(connection, "sale", base - timedelta(days=offset)) for offset in (4, 5)]
        kept_by_index = model_run(connection, "rent", base - timedelta(days=50))  # referenced by a kept vintage
        connection.execute(
            """INSERT INTO analytics.model_publications(transaction_kind,model_run_id)
               VALUES('sale',%s) ON CONFLICT(transaction_kind) DO UPDATE SET model_run_id=excluded.model_run_id""",
            (published,),
        )
        kept_vintages = [index_run(connection, "rent", "hedonic", base - timedelta(days=offset), kept_by_index)
                         for offset in (1, 2, 3, 4)]
        pruned_vintages = [index_run(connection, "rent", "hedonic", base - timedelta(days=offset))
                           for offset in (5, 6)]
        ALL.update([published, *newest, *pruned_runs, kept_by_index, *kept_vintages, *pruned_vintages])

        counts = prune_model_history(connection, keep=3)

        assert ids(connection, "analytics.model_runs") >= {published, *newest, kept_by_index}
        assert ids(connection, "analytics.model_runs").isdisjoint(pruned_runs)
        assert ids(connection, "analytics.valuation_predictions", "model_run_id").isdisjoint(pruned_runs)
        assert ids(connection, "analytics.index_calculation_runs") >= set(kept_vintages)
        assert ids(connection, "analytics.index_calculation_runs").isdisjoint(pruned_vintages)
        assert ids(connection, "analytics.market_indices", "calculation_run_id").isdisjoint(pruned_vintages)
        assert counts["analytics.model_runs"] >= 2
        assert counts["analytics.index_calculation_runs"] >= 2
