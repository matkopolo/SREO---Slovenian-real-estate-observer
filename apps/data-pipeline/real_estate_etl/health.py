"""Health reporting for the long-running scheduler.

Semantics (what "healthy" means for the ``pipeline-worker`` container):

* The scheduler process is running: a background heartbeat rewrites the health file
  every :data:`HEARTBEAT_SECONDS`. A file older than the check's ``max_age`` means the
  process is gone or stuck, so the check fails.
* **and** the data it serves is usable, which is true when either
  - a refresh is in progress (this covers the first import on a fresh install, when
    nothing is published yet, and any later refresh), or
  - an analytical release is published and is younger than ``interval_days`` plus
    :data:`STALE_SLACK`. Failed refreshes keep the worker healthy while the last good
    release is still current; repeated failures beyond that window make it unhealthy.

The worker writes the file only while healthy and removes it otherwise, so a plain
"file exists" probe and the stricter ``real-estate-etl healthcheck`` command agree.
The API must not depend on this: it reads readiness from the publication tables.
"""

from __future__ import annotations

import json
import logging
import os
import threading
from collections.abc import Callable
from dataclasses import dataclass, field
from datetime import UTC, datetime, timedelta
from pathlib import Path
from types import TracebackType

logger = logging.getLogger(__name__)

HEARTBEAT_SECONDS = 60.0
DEFAULT_MAX_AGE = timedelta(minutes=5)
STALE_SLACK = timedelta(days=2)


def utc_now() -> datetime:
    return datetime.now(UTC)


@dataclass
class WorkerHealth:
    """Scheduler state that decides whether the health file is present."""

    path: Path | None
    stale_after: timedelta
    now: Callable[[], datetime] = utc_now
    refreshing: bool = False
    published_at: datetime | None = None
    last_error: str | None = None
    _lock: threading.Lock = field(default_factory=threading.Lock, repr=False)

    def healthy(self) -> bool:
        if self.refreshing:
            return True
        if self.published_at is None:
            return False
        return self.now() - self.published_at <= self.stale_after

    def update(self, **changes: object) -> None:
        with self._lock:
            for name, value in changes.items():
                setattr(self, name, value)
        self.write()

    def write(self) -> None:
        """Write the health file while healthy; remove it while unhealthy."""
        if self.path is None:
            return
        with self._lock:
            healthy = self.healthy()
            payload = {
                "healthy": healthy,
                "state": "refreshing" if self.refreshing else "waiting",
                "updated_at": self.now().isoformat(timespec="seconds"),
                "active_release_published_at": (
                    self.published_at.isoformat(timespec="seconds") if self.published_at else None
                ),
                "last_error": self.last_error,
            }
        try:
            if healthy:
                self.path.parent.mkdir(parents=True, exist_ok=True)
                temporary = self.path.with_name(self.path.name + ".tmp")
                temporary.write_text(json.dumps(payload), encoding="utf-8")
                os.replace(temporary, self.path)
            else:
                self.path.unlink(missing_ok=True)
        except OSError:
            logger.exception("Could not update health file %s", self.path)


class HealthHeartbeat:
    """Rewrite the health file immediately and then every ``interval`` seconds."""

    def __init__(self, health: WorkerHealth, interval: float = HEARTBEAT_SECONDS):
        self._health = health
        self._interval = interval
        self._stop = threading.Event()
        self._thread = threading.Thread(target=self._run, name="health-heartbeat", daemon=True)

    def __enter__(self) -> HealthHeartbeat:
        self._health.write()
        self._thread.start()
        return self

    def __exit__(
        self,
        exc_type: type[BaseException] | None,
        exc: BaseException | None,
        traceback: TracebackType | None,
    ) -> None:
        self._stop.set()
        self._thread.join()

    def _run(self) -> None:
        while not self._stop.wait(self._interval):
            self._health.write()


def check_health_file(
    path: Path, *, max_age: timedelta = DEFAULT_MAX_AGE, now: Callable[[], datetime] = utc_now,
) -> tuple[bool, str]:
    """Return ``(healthy, reason)`` for the container health probe."""
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except FileNotFoundError:
        return False, f"{path} does not exist (no published release and no refresh in progress)"
    except (OSError, ValueError) as error:
        return False, f"{path} is unreadable: {error}"
    try:
        updated_at = datetime.fromisoformat(payload["updated_at"])
    except (KeyError, TypeError, ValueError):
        return False, f"{path} has no valid updated_at"
    age = now() - updated_at
    if age > max_age:
        return False, f"heartbeat is {int(age.total_seconds())}s old (limit {int(max_age.total_seconds())}s)"
    if not payload.get("healthy"):
        return False, "worker reports unhealthy"
    published = payload.get("active_release_published_at")
    return True, f"{payload.get('state', 'unknown')}; active release published {published}"
