from pathlib import Path
from unittest.mock import MagicMock, patch

import pytest

from real_estate_etl import cli
from real_estate_etl.cli import Database, build_parser, main, run, validate_arguments
from real_estate_etl.settings import RAW_DATA_DIR


def parse(*argv: str):
    parser = build_parser()
    args = parser.parse_args(list(argv))
    validate_arguments(parser, args)
    return args


def test_output_dir_defaults_to_the_container_data_directory():
    for command in (["fetch", "--municipality", "1", "--year", "2020"], ["refresh-all-data"], ["schedule"],
                    ["sync-construction"], ["reset-and-repopulate", "--confirm-reset"]):
        assert parse(*command).output_dir == RAW_DATA_DIR


@pytest.mark.parametrize(
    "argv",
    [
        ["fetch-national", "--type", "rent", "--year", "2012"],
        ["reset-and-repopulate"],
        ["schedule", "--interval-days", "0"],
        ["schedule", "--retry-hours", "0"],
        ["refresh-all-sales", "--start-year", "2020", "--end-year", "2019"],
        ["refresh-all-data", "--end-year", "2006"],
        ["refresh-system", "--workers", "0"],
        ["refresh-models", "--workers", "100000"],
    ],
)
def test_invalid_arguments_are_rejected(argv):
    with pytest.raises(SystemExit):
        parse(*argv)


@pytest.mark.parametrize(
    ("command", "database"),
    [
        (["sync-reference-data"], Database.LOCKED),
        (["sync-geographies"], Database.LOCKED),
        (["sync-context"], Database.LOCKED),
        (["sync-demography"], Database.LOCKED),
        (["sync-construction"], Database.LOCKED),
        (["refresh-models"], Database.LOCKED),
        (["import", "x.zip"], Database.LOCKED),
        (["refresh", "--municipality", "1", "--year", "2020"], Database.LOCKED),
        (["refresh-all-sales"], Database.LOCKED),
        (["refresh-all-data"], Database.LOCKED),
        (["refresh-analytics"], Database.LOCKED),
        (["refresh-system"], Database.SELF_LOCKING),
        (["reset-and-repopulate", "--confirm-reset"], Database.SELF_LOCKING),
        (["fetch", "--municipality", "1", "--year", "2020"], Database.NONE),
        (["fetch-national", "--type", "sales", "--year", "2020"], Database.NONE),
        (["schedule"], Database.NONE),
        (["healthcheck", "--health-file", "/tmp/x"], Database.NONE),
    ],
)
def test_every_database_command_takes_the_maintenance_lock(command, database):
    assert parse(*command).database is database


def test_locked_command_runs_inside_the_lock():
    args = parse("import", "archive.zip")
    connection = MagicMock()
    events = []
    lock = MagicMock()
    lock.return_value.__enter__.side_effect = lambda *_: events.append("locked")
    lock.return_value.__exit__.side_effect = lambda *_: events.append("released")
    with (
        patch("real_estate_etl.cli.psycopg.connect") as connect,
        patch("real_estate_etl.cli.maintenance_lock", lock),
        patch("real_estate_etl.cli.import_zip", side_effect=lambda *_a, **_k: events.append("import")) as load,
    ):
        connect.return_value.__enter__.return_value = connection
        run(args)

    assert events == ["locked", "import", "released"]
    load.assert_called_once_with(connection, Path("archive.zip"), verbose=False)


def test_fetch_needs_no_database():
    args = parse("fetch-national", "--type", "sales", "--year", "2020", "--output-dir", "/tmp/raw")
    with (
        patch("real_estate_etl.cli.psycopg.connect") as connect,
        patch("real_estate_etl.cli.fetch_national_zip") as fetch,
    ):
        run(args)
    connect.assert_not_called()
    fetch.assert_called_once_with("sales", 2020, Path("/tmp/raw"))


def test_main_logs_failures_and_exits_non_zero(caplog):
    with (
        patch.object(cli, "configure_logging"),
        patch("real_estate_etl.cli.fetch_national_zip", side_effect=RuntimeError("GURS down")),
        pytest.raises(SystemExit) as exited,
    ):
        main(["fetch-national", "--type", "sales", "--year", "2020"])
    assert exited.value.code == 1
    assert "command fetch-national failed" in caplog.text
    assert "GURS down" in caplog.text


def test_healthcheck_command_fails_without_health_file(tmp_path: Path):
    with patch.object(cli, "configure_logging"), pytest.raises(SystemExit) as exited:
        main(["healthcheck", "--health-file", str(tmp_path / "missing")])
    assert "unhealthy" in str(exited.value.code)
