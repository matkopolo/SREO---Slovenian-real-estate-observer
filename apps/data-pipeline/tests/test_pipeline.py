import zipfile
from pathlib import Path
from unittest.mock import MagicMock, patch

import httpx
import pytest

from real_estate_etl.formatting import format_duration
from real_estate_etl.models import ArchiveResult
from real_estate_etl.pipeline import (
    prepare_archive,
    prepare_national_archive,
    refresh_all_national,
    validate_worker_count,
)


@pytest.mark.parametrize(
    ("seconds", "expected"),
    [(42.9, "42s"), (125, "2m 5s"), (7384, "2h 3m 4s")],
)
def test_format_duration(seconds, expected):
    assert format_duration(seconds) == expected


def test_worker_count_is_bounded_by_machine_threads():
    validate_worker_count(1, available_threads=4)
    validate_worker_count(4, available_threads=4)
    with pytest.raises(ValueError, match="at least 1"):
        validate_worker_count(0, available_threads=4)
    with pytest.raises(ValueError, match="cannot exceed"):
        validate_worker_count(5, available_threads=4)


def test_prepare_archive_reuses_valid_zip(tmp_path: Path):
    archive = tmp_path / "ETN_001_2026_KPP_test.zip"
    with zipfile.ZipFile(archive, "w") as output:
        output.writestr("test.csv", "a\n1\n")

    with patch("real_estate_etl.pipeline.fetch_zip") as fetch:
        result = prepare_archive(1, 2026, tmp_path, force=False)

    assert isinstance(result, ArchiveResult)
    assert result.path == archive
    assert result.reused is True
    fetch.assert_not_called()


def test_prepare_archive_force_downloads(tmp_path: Path):
    downloaded = tmp_path / "new.zip"
    with patch("real_estate_etl.pipeline.fetch_zip", return_value=downloaded) as fetch:
        result = prepare_archive(1, 2026, tmp_path, force=True)

    assert result.path == downloaded
    assert result.reused is False
    fetch.assert_called_once_with(1, 2026, tmp_path, None)


def test_prepare_national_archive_reuses_valid_zip(tmp_path: Path):
    archive = tmp_path / "ETN_SLO_2020_KPP_test.zip"
    with zipfile.ZipFile(archive, "w") as output:
        output.writestr("test.csv", "a\n1\n")
    with patch("real_estate_etl.pipeline.fetch_national_zip") as fetch:
        result = prepare_national_archive("sales", 2020, tmp_path, force=False)
    assert result.path == archive
    assert result.reused is True
    fetch.assert_not_called()


def test_forced_national_download_removes_superseded_archives(tmp_path: Path):
    old = tmp_path / "ETN_SLO_2026_KPP_20260101.zip"
    with zipfile.ZipFile(old, "w") as output:
        output.writestr("test.csv", "a\n1\n")
    new = tmp_path / "ETN_SLO_2026_KPP_20260201.zip"

    def download(*_args):
        with zipfile.ZipFile(new, "w") as output:
            output.writestr("test.csv", "a\n2\n")
        return new

    with patch("real_estate_etl.pipeline.fetch_national_zip", side_effect=download):
        result = prepare_national_archive("sales", 2026, tmp_path, force=True)

    assert result.path == new
    assert not old.exists()


def test_national_refresh_rechecks_the_revision_years_only(tmp_path: Path):
    connection = MagicMock()
    cursor = connection.cursor.return_value.__enter__.return_value
    imported = {("sales", year) for year in range(2007, 2027)} | {("rent", year) for year in range(2013, 2027)}
    cursor.fetchall.return_value = list(imported)
    captured = {}

    def run_refresh(_connection, items, **kwargs):
        captured["items"] = items
        captured["prepare"] = kwargs["prepare"]
        return MagicMock()

    with (
        patch("real_estate_etl.pipeline.sync_reference_data"),
        patch("real_estate_etl.pipeline._run_refresh", side_effect=run_refresh),
        patch("real_estate_etl.pipeline.prepare_national_archive") as prepare,
    ):
        refresh_all_national(connection, tmp_path, 2026, force=False, workers=1, revision_years=2)
        captured["prepare"](("sales", 2025))

    assert sorted(captured["items"]) == [("rent", 2025), ("rent", 2026), ("sales", 2025), ("sales", 2026)]
    assert prepare.call_args.args[3] is True  # revision years are always re-downloaded


def _refused(*_args, **_kwargs):
    request = httpx.Request("GET", "https://ipi.eprostor.gov.si/jgp-service-api/municipalities")
    raise httpx.HTTPStatusError("403", request=request, response=httpx.Response(403, request=request))


def test_reference_sync_keeps_stored_lists_when_gurs_refuses():
    from real_estate_etl.pipeline import sync_reference_data

    connection = MagicMock()
    connection.cursor.return_value.__enter__.return_value.fetchone.return_value = (212, 2698)
    with patch("real_estate_etl.pipeline.http_client.fetch_json", side_effect=_refused):
        assert sync_reference_data(connection, client=MagicMock()) is False
    connection.rollback.assert_called_once()
    connection.commit.assert_not_called()


def test_reference_sync_still_fails_on_an_empty_database():
    from real_estate_etl.pipeline import sync_reference_data

    connection = MagicMock()
    connection.cursor.return_value.__enter__.return_value.fetchone.return_value = (0, 0)
    with patch("real_estate_etl.pipeline.http_client.fetch_json", side_effect=_refused), pytest.raises(httpx.HTTPStatusError):
        sync_reference_data(connection, client=MagicMock())


def test_import_failure_cancels_queued_downloads_and_closes_pools(tmp_path: Path):
    """The first import error stops the refresh: pending downloads are cancelled, no later item is imported."""
    from real_estate_etl.pipeline import _run_refresh

    connection = MagicMock()
    imported = []
    prepared = []

    def prepare(item):
        prepared.append(item)
        return ArchiveResult(tmp_path / f"{item}.zip", True, 0.0)

    def import_zip(_connection, path, verbose):
        imported.append(path.name)
        if len(imported) == 2:
            raise RuntimeError("corrupt member")
        return MagicMock(unchanged=False, rows=1, member_import_seconds=0.0, database_seconds=0.0)

    items = list(range(50))
    with patch("real_estate_etl.pipeline.import_zip", side_effect=import_zip), pytest.raises(RuntimeError, match="corrupt"):
        _run_refresh(
            connection, items, skipped=0, workers=2, verbose=False, thread_name="t", prepare=prepare,
            label=lambda position, total, item: f"{position}/{total}", summary_prefix="test",
        )

    assert len(imported) == 2
    assert len(prepared) < len(items)  # the queue was bounded and the rest cancelled


def test_unavailable_dataset_is_counted_not_fatal(tmp_path: Path):
    from real_estate_etl.api import DatasetUnavailable
    from real_estate_etl.pipeline import _run_refresh

    def prepare(item):
        if item == 1:
            raise DatasetUnavailable("not prepared yet")
        return ArchiveResult(tmp_path / f"{item}.zip", True, 0.0)

    with patch(
        "real_estate_etl.pipeline.import_zip",
        return_value=MagicMock(unchanged=False, rows=3, member_import_seconds=0.0, database_seconds=0.0),
    ):
        summary = _run_refresh(
            MagicMock(), [0, 1, 2], skipped=4, workers=1, verbose=False, thread_name="t", prepare=prepare,
            label=lambda position, total, item: f"{position}/{total}", summary_prefix="test",
        )
    assert (summary.imported, summary.already_imported, summary.unavailable) == (2, 4, 1)
