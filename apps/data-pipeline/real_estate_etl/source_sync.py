"""Per-source isolation for optional context sources (SURS, Banka Slovenije, ECB, GURS buildings).

One failing source must not block the others or the GURS transaction release: it keeps
its previously stored rows. The failure is still logged with its traceback and returned
in a :class:`SourceSyncReport`, which the system refresh stores on the analytical release.
"""

from __future__ import annotations

import logging
from collections.abc import Callable, Mapping
from dataclasses import dataclass, field

import psycopg

logger = logging.getLogger(__name__)

SOURCE_OK = "ok"
#: The source was unavailable and its data came from the published seed instead (first install).
SOURCE_SEED = "seed"
SUCCESSFUL_STATUSES = frozenset({SOURCE_OK, SOURCE_SEED})


@dataclass
class SourceSyncReport:
    """Row counts for sources that succeeded and error messages for sources that failed."""

    counts: dict[str, int] = field(default_factory=dict)
    failures: dict[str, str] = field(default_factory=dict)

    def status(self) -> dict[str, str]:
        """``{source: "ok" | "<ErrorType>: message"}`` in a JSON-friendly shape."""
        return {**dict.fromkeys(self.counts, SOURCE_OK), **self.failures}

    def merge(self, other: SourceSyncReport) -> SourceSyncReport:
        return SourceSyncReport({**self.counts, **other.counts}, {**self.failures, **other.failures})


def run_isolated_sources(
    connection: psycopg.Connection,
    steps: Mapping[str, Callable[[], int]],
    *,
    group: str,
) -> SourceSyncReport:
    """Run each step and commit it on success; roll back and record it on failure.

    Each step stores its own rows and returns how many it stored (0 means "already
    current"). A step that must not be empty raises instead.
    """
    report = SourceSyncReport()
    for name, step in steps.items():
        try:
            count = step()
            connection.commit()
            report.counts[name] = count
        except Exception as error:
            connection.rollback()
            report.failures[name] = f"{type(error).__name__}: {error}"[:500]
            logger.warning(
                "%s source %s failed; keeping its stored values: %s",
                group, name, report.failures[name], exc_info=error,
            )
    logger.info(
        "Synchronized %s: %s%s",
        group,
        ", ".join(f"{name}={count}" for name, count in report.counts.items()) or "nothing",
        f"; failed: {', '.join(report.failures)}" if report.failures else "",
    )
    return report
