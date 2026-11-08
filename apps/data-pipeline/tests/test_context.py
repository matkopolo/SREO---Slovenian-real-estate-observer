from unittest.mock import MagicMock

from real_estate_etl.context import (
    ContextClient,
    bsi_rate_observations,
    ecb_observations,
    jsonstat_rows,
    latest_value,
    surs_wage_observations,
    sync_context,
)

WAGES = {
    "id": ["MESEC", "OBČINE", "SPOL", "PLAČA", "MERITVE"],
    "size": [1, 2, 1, 1, 2],
    "dimension": {
        "MESEC": {"category": {"index": {"2025M10": 0}}},
        "OBČINE": {"category": {"index": {"0": 0, "061": 1}}},
        "SPOL": {"category": {"index": {"TOT": 0}}},
        "PLAČA": {"category": {"index": {"2": 0}}},
        "MERITVE": {"category": {"index": {"1": 0, "2": 1}}},
    },
    "value": [1580.3, 1379.49, 1723.24, None],
}


def test_jsonstat_rows_follow_dimension_order_and_skip_missing_cells():
    rows = list(jsonstat_rows(WAGES))
    assert rows[0] == ({"MESEC": "2025M10", "OBČINE": "0", "SPOL": "TOT", "PLAČA": "2", "MERITVE": "1"}, 1580.3)
    assert len(rows) == 3  # the suppressed cell is not invented


def test_wage_rows_map_measures_and_municipality_codes():
    rows = surs_wage_observations(WAGES)
    assert [(r.series, r.geography_key, r.value) for r in rows] == [
        ("net_wage_mean", "SI", 1580.3),
        ("net_wage_p50", "SI", 1379.49),
        ("net_wage_mean", "municipality:61", 1723.24),
    ]
    assert rows[0].period == "2025M10" and rows[0].source_table == "SURS 0711357S"


def test_latest_value_picks_newest_period_not_first_listed():
    metadata = {"variables": [{"code": "MESEC", "values": ["2023M10", "2024M10", "2025M10"]}]}
    assert latest_value(metadata, "MESEC") == "2025M10"


def test_bsi_rows_keep_only_housing_loan_items():
    payload = {
        "id": ["Datum", "Frekvenca", "Postavke"], "size": [1, 1, 2],
        "dimension": {"Datum": {"category": {"index": {"2026M09": 0}}},
                      "Frekvenca": {"category": {"index": {"0": 0}}},
                      "Postavke": {"category": {"index": {"12": 0, "3": 1}}}},
        "value": [3.27, 6.1],
    }
    rows = bsi_rate_observations(payload)
    assert [(r.series, r.period, r.value) for r in rows] == [("housing_rate_fixed_10y", "2026M09", 3.27)]


def test_ecb_csv_rows():
    text = "KEY,FREQ,TIME_PERIOD,OBS_VALUE\nFM.M,M,2026-09,2.9215909\nFM.M,M,2026-10,2.9746818\n"
    assert [(r.period, r.value) for r in ecb_observations(text)] == [("2026-09", 2.9215909), ("2026-10", 2.9746818)]


def test_one_failing_source_does_not_block_the_others(caplog):
    client = MagicMock(spec=ContextClient)
    client.wages.side_effect = RuntimeError("SURS down")
    client.average_wage.return_value = []
    client.housing_rates.return_value = bsi_rate_observations({
        "id": ["Datum", "Frekvenca", "Postavke"], "size": [1, 1, 1],
        "dimension": {"Datum": {"category": {"index": {"2026M09": 0}}},
                      "Frekvenca": {"category": {"index": {"0": 0}}},
                      "Postavke": {"category": {"index": {"9": 0}}}},
        "value": [3.47]})
    client.euribor.return_value = ecb_observations("TIME_PERIOD,OBS_VALUE\n2026-10,2.97\n")
    connection = MagicMock()
    counts = sync_context(connection, client)
    assert counts == {"bsi_housing_rates": 1, "ecb_euribor_6m": 1}
    assert "surs_wage_distribution failed" in caplog.text
    assert "surs_average_wage failed" in caplog.text  # empty response is a failure, not a wipe
