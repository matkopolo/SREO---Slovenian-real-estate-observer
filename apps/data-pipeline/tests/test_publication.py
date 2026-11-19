import uuid
from datetime import UTC, datetime, timedelta
from unittest.mock import MagicMock, patch

from real_estate_etl.publication import fail_release, supersede_stale_releases


def status_connection(stage_row):
    connection = MagicMock()
    connection.execute.return_value.fetchone.return_value = stage_row
    context = MagicMock()
    context.__enter__.return_value = connection
    return connection, context


def test_fail_release_records_the_running_stage_as_a_failed_refresh_run(caplog):
    release_id = uuid.uuid4()
    started = datetime(2026, 11, 9, 12, tzinfo=UTC)
    connection, context = status_connection(("analytics", started))
    with patch("real_estate_etl.publication.psycopg.connect", return_value=context):
        fail_release("postgresql://x", release_id, RuntimeError("sale refresh failed"))

    statements = [call.args[0] for call in connection.execute.call_args_list]
    assert any("SET status='failed',stage='failed'" in statement for statement in statements)
    assert any("pending_release_id=NULL" in statement for statement in statements)
    closing = next(call for call in connection.execute.call_args_list
                   if "UPDATE analytics.refresh_runs" in call.args[0])
    assert "status='running'" in closing.args[0]
    inserted = next(call for call in connection.execute.call_args_list
                    if "INSERT INTO analytics.refresh_runs" in call.args[0])
    assert inserted.args[1][:2] == ("release:analytics", started)
    assert inserted.args[1][3] == "analytics"
    assert "RuntimeError: sale refresh failed" in inserted.args[1][4]
    assert f"release={release_id} failed in stage analytics" in caplog.text


def test_fail_release_copes_with_a_release_row_that_no_longer_exists():
    connection, context = status_connection(None)
    with patch("real_estate_etl.publication.psycopg.connect", return_value=context):
        fail_release("postgresql://x", uuid.uuid4(), RuntimeError("boom"))
    inserted = next(call for call in connection.execute.call_args_list
                    if "INSERT INTO analytics.refresh_runs" in call.args[0])
    assert inserted.args[1][0] == "release:unknown"


def test_supersede_stale_releases_only_touches_old_processing_rows(caplog):
    abandoned = uuid.uuid4()
    connection, context = status_connection(None)
    connection.execute.return_value.fetchall.return_value = [(abandoned,)]
    with patch("real_estate_etl.publication.psycopg.connect", return_value=context):
        assert supersede_stale_releases("postgresql://x", older_than=timedelta(hours=2)) == [abandoned]
    update = connection.execute.call_args_list[0]
    assert "WHERE status='processing' AND started_at<=clock_timestamp()-%s::interval" in update.args[0]
    assert update.args[1] == (timedelta(hours=2),)
    assert any("pending_release_id=NULL" in call.args[0] for call in connection.execute.call_args_list)
    assert f"release={abandoned} was abandoned" in caplog.text
