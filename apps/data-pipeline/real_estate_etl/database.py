"""Connection helpers shared by the CLI, the scheduler and the release bookkeeping."""

from __future__ import annotations

from typing import Any

import psycopg

from .settings import CONNECTION_KEEPALIVES


def connect(database_url: str, **options: Any) -> psycopg.Connection[tuple[Any, ...]]:
    """Open a connection with TCP keepalives so an orphaned session (and its advisory lock) ends.

    Args:
        database_url: A libpq connection URL.
        **options: Further ``psycopg.connect`` keyword arguments; they override the keepalives.

    Returns:
        A new, non-autocommit connection.
    """
    return psycopg.connect(database_url, **{**CONNECTION_KEEPALIVES, **options})


def scalar(connection: psycopg.Connection[Any], query: str, params: tuple[Any, ...] = ()) -> Any:
    """Run ``query`` and return the first column of its first row.

    Raises:
        RuntimeError: When the query returns no row (every caller expects exactly one).
    """
    row = connection.execute(query, params).fetchone()
    if row is None:
        raise RuntimeError(f"query returned no row: {query.strip().splitlines()[0]}")
    return row[0]
