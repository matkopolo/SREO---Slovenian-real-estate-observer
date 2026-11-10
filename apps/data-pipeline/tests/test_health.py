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
