import json
from datetime import UTC, datetime, timedelta
from pathlib import Path

from real_estate_etl.health import WorkerHealth, check_health_file

NOW = datetime(2026, 11, 9, 12, tzinfo=UTC)


def health(path: Path, **state) -> WorkerHealth:
    return WorkerHealth(path, stale_after=timedelta(days=16), now=lambda: NOW, **state)


def test_first_import_in_progress_is_healthy(tmp_path: Path):
    worker = health(tmp_path / "healthy", refreshing=True)
    worker.write()
    assert json.loads((tmp_path / "healthy").read_text())["state"] == "refreshing"
    assert check_health_file(tmp_path / "healthy", now=lambda: NOW)[0]


def test_no_release_and_no_refresh_is_unhealthy(tmp_path: Path):
    path = tmp_path / "healthy"
    path.write_text("{}")
    health(path).write()
    assert not path.exists()
    assert not check_health_file(path, now=lambda: NOW)[0]


def test_recent_release_stays_healthy_after_a_failed_refresh(tmp_path: Path):
    worker = health(tmp_path / "healthy", published_at=NOW - timedelta(days=3), last_error="boom")
    worker.write()
    assert check_health_file(tmp_path / "healthy", now=lambda: NOW)[0]


def test_stale_release_is_unhealthy(tmp_path: Path):
    worker = health(tmp_path / "healthy", published_at=NOW - timedelta(days=17))
    assert not worker.healthy()


def test_old_heartbeat_fails_the_check(tmp_path: Path):
    worker = health(tmp_path / "healthy", refreshing=True)
    worker.write()
    healthy, reason = check_health_file(tmp_path / "healthy", now=lambda: NOW + timedelta(minutes=10))
    assert not healthy
    assert "heartbeat" in reason


def test_concurrent_writes_from_the_heartbeat_and_the_scheduler_never_fail(tmp_path: Path, caplog):
    """Two threads rewriting the same health file race on the temporary name unless the IO is locked."""
    import threading

    from real_estate_etl.health import HealthHeartbeat

    path = tmp_path / "healthy"
    worker = WorkerHealth(path, stale_after=timedelta(days=16), refreshing=True)
    stop = threading.Event()

    def flip_state() -> None:
        while not stop.is_set():
            worker.update(refreshing=True)
            worker.update(published_at=None, refreshing=False)  # unhealthy: the file is removed

    with HealthHeartbeat(worker, interval=0.0005):
        flipper = threading.Thread(target=flip_state)
        flipper.start()
        for _ in range(300):
            worker.update(refreshing=True)
        stop.set()
        flipper.join()

    assert "Could not update health file" not in caplog.text
    worker.update(refreshing=True)
    assert json.loads(path.read_text())["healthy"] is True
    worker.update(refreshing=False)
    assert not path.exists()
