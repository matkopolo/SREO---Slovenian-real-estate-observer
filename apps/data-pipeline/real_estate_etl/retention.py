"""Retention of model and index history after a successful publication.

Every model refresh inserts a new run with its predictions and a new index vintage,
and nothing removed the old ones. After a release is published this step keeps, per
transaction kind (and per method for indices), the runs that are published or
referenced by what is published plus the newest ``keep`` others, and deletes the
rest together with their rows.
"""

from __future__ import annotations

import logging
from typing import Any

import psycopg

logger = logging.getLogger(__name__)

#: Runs kept per transaction kind besides the published one.
DEFAULT_KEEP_RUNS = 3


def prune_model_history(connection: psycopg.Connection[Any], *, keep: int = DEFAULT_KEEP_RUNS) -> dict[str, int]:
    """Delete model runs and index vintages beyond the published one and the newest ``keep``.

    Runs in the caller's connection as one committed transaction. The published model
    run per kind (``analytics.model_publications``), the newest ``keep`` runs per kind,
    and every run a surviving index vintage still references are kept. Index vintages
    are kept per transaction kind and method: the newest (which the current view
    serves), the ones built from a kept model run, and the newest ``keep`` others.

    Args:
        connection: The maintenance connection; the step commits on exit.
        keep: How many non-published runs and vintages to keep per kind (and method).

    Returns:
        Deleted row counts per table.
    """
    counts: dict[str, int] = {}
    with connection.transaction(), connection.cursor() as cursor:
        cursor.execute(
            """
            CREATE TEMP TABLE pg_temp.pruned_model_runs ON COMMIT DROP AS
            SELECT run.id
            FROM analytics.model_runs run
            WHERE NOT EXISTS (
                    SELECT 1 FROM analytics.model_publications publication
                    WHERE publication.model_run_id=run.id)
              AND run.id NOT IN (
                    SELECT id FROM (
                        SELECT id,row_number() OVER (
                            PARTITION BY transaction_kind ORDER BY created_at DESC,id DESC) AS recency
                        FROM analytics.model_runs
                        WHERE NOT EXISTS (
                            SELECT 1 FROM analytics.model_publications publication
                            WHERE publication.model_run_id=model_runs.id)
                    ) ranked WHERE recency<=%s)
            """,
            (keep,),
        )
        cursor.execute(
            """
            CREATE TEMP TABLE pg_temp.pruned_index_runs ON COMMIT DROP AS
            SELECT run.id
            FROM analytics.index_calculation_runs run
            WHERE run.id NOT IN (
                    SELECT id FROM (
                        SELECT id,row_number() OVER (
                            PARTITION BY transaction_kind,method ORDER BY created_at DESC,id DESC) AS recency
                        FROM analytics.index_calculation_runs
                    ) ranked WHERE recency<=%s)
              AND NOT EXISTS (
                    SELECT 1 FROM analytics.market_indices index_data
                    JOIN analytics.model_publications publication
                      ON publication.model_run_id=index_data.model_run_id
                    WHERE index_data.calculation_run_id=run.id)
            """,
            (keep + 1,),
        )
        cursor.execute(
            """
            DELETE FROM analytics.market_indices
            WHERE calculation_run_id IN (SELECT id FROM pg_temp.pruned_index_runs)
               OR model_run_id IN (SELECT id FROM pg_temp.pruned_model_runs)
            """
        )
        counts["analytics.market_indices"] = cursor.rowcount
        cursor.execute(
            """
            DELETE FROM analytics.index_calculation_runs
            WHERE id IN (SELECT id FROM pg_temp.pruned_index_runs)
               OR NOT EXISTS (
                    SELECT 1 FROM analytics.market_indices index_data
                    WHERE index_data.calculation_run_id=index_calculation_runs.id)
            """
        )
        counts["analytics.index_calculation_runs"] = cursor.rowcount
        cursor.execute(
            """
            DELETE FROM analytics.valuation_predictions
            WHERE model_run_id IN (SELECT id FROM pg_temp.pruned_model_runs)
            """
        )
        counts["analytics.valuation_predictions"] = cursor.rowcount
        cursor.execute(
            """
            DELETE FROM analytics.model_runs run
            WHERE run.id IN (SELECT id FROM pg_temp.pruned_model_runs)
              AND NOT EXISTS (
                    SELECT 1 FROM analytics.market_indices index_data WHERE index_data.model_run_id=run.id)
            """
        )
        counts["analytics.model_runs"] = cursor.rowcount
    logger.info(
        "Pruned model and index history (kept the published runs and the newest %s): %s",
        keep, ", ".join(f"{table}={count}" for table, count in counts.items()),
    )
    return counts
