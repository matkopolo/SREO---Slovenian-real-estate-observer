from unittest.mock import MagicMock

from real_estate_etl.retention import DEFAULT_KEEP_RUNS, prune_model_history


def test_prune_runs_in_one_transaction_and_reports_every_table(caplog):
    caplog.set_level("INFO")
    connection = MagicMock()
    cursor = connection.cursor.return_value.__enter__.return_value
    cursor.rowcount = 4

    counts = prune_model_history(connection, keep=2)

    assert counts == {
        "analytics.market_indices": 4, "analytics.index_calculation_runs": 4,
        "analytics.valuation_predictions": 4, "analytics.model_runs": 4,
    }
    connection.transaction.assert_called_once()
    statements = [str(call.args[0]) for call in cursor.execute.call_args_list]
    assert statements[0].lstrip().startswith("CREATE TEMP TABLE pg_temp.pruned_model_runs")
    assert statements[1].lstrip().startswith("CREATE TEMP TABLE pg_temp.pruned_index_runs")
    assert cursor.execute.call_args_list[0].args[1] == (2,)
    assert cursor.execute.call_args_list[1].args[1] == (3,)  # the newest vintage is the published one
    deletes = [statement for statement in statements if statement.lstrip().startswith("DELETE")]
    assert [statement.split()[2] for statement in deletes] == [
        "analytics.market_indices", "analytics.index_calculation_runs",
        "analytics.valuation_predictions", "analytics.model_runs",
    ]  # children before parents: indices and predictions reference the runs
    assert "model_publications" in statements[0]  # the published run is never pruned
    assert "kept the published runs and the newest 2" in caplog.text
    assert DEFAULT_KEEP_RUNS == 3
