from unittest.mock import MagicMock

from real_estate_etl.demography import (
    DEATH_AGES,
    POPULATION_AGES,
    DemographyClient,
    death_observations,
    living_alone_observations,
    migration_observations,
    population_observations,
    stock_observations,
    sync_demography,
)


def payload(dimensions: dict[str, list[str]], values: list[float]) -> dict:
    return {"id": list(dimensions), "size": [len(codes) for codes in dimensions.values()],
            "dimension": {name: {"category": {"index": {code: i for i, code in enumerate(codes)}}}
                          for name, codes in dimensions.items()},
            "value": values}


def test_age_group_labels_cover_the_published_groups():
    assert POPULATION_AGES["1"] == "0_4"
    assert POPULATION_AGES["14"] == "65_69"
    assert POPULATION_AGES["21"] == "100_plus"
    assert DEATH_AGES["065"] == "65_69"
    assert DEATH_AGES["100"] == "100_plus"
    assert len(DEATH_AGES) == 22


def test_population_keys_municipalities_and_slovenia():
    rows = population_observations(payload(
        {"SPOL": ["0"], "OBČINE": ["0", "061"], "POLLETJE": ["2026H1"], "STAROST": ["0", "14"]}, [2135107, 4512, 295000, 100]))
    assert [(r.series, r.geography_key, r.period, r.value) for r in rows] == [
        ("population_total", "SI", "2026H1", 2135107), ("population_65_69", "SI", "2026H1", 4512),
        ("population_total", "municipality:61", "2026H1", 295000), ("population_65_69", "municipality:61", "2026H1", 100)]


def test_deaths_are_keyed_by_statistical_region():
    rows = death_observations(payload({"SPOL": ["0"], "STAROST": ["085"], "LETO": ["2025"],
                                       "STATISTIČNA REGIJA": ["0", "08"]}, [5000, 900]))
    assert [(r.series, r.geography_key) for r in rows] == [("deaths_85_89", "SI"), ("deaths_85_89", "region:8")]


def test_migration_keeps_only_selected_measures():
    rows = migration_observations(payload({"OBČINE": ["061"], "LETO": ["2025"], "MERITVE": ["19", "01"]}, [1200, 9000]))
    assert [(r.series, r.value) for r in rows] == [("net_migration_total", 1200)]


def test_stock_and_living_alone():
    rows = stock_observations(payload({"OBČINE": ["0"], "NASELJENOST": ["0", "22"], "VRSTA STAVBE": ["0"],
                                       "LETO": ["2021"], "MERITVE": ["1"]}, [864323, 152280]),
                              "NASELJENOST", {"0": "dwellings_total", "22": "dwellings_vacant"}, "dwellings", "0861110S")
    assert [(r.series, r.value, r.source_table) for r in rows] == [
        ("dwellings_total", 864323, "SURS 0861110S"), ("dwellings_vacant", 152280, "SURS 0861110S")]
    alone = living_alone_observations(payload({"KOHEZIJSKA REGIJA": ["0"], "STAROST": ["18"], "SPOL": ["0"], "LETO": ["2021"],
                                               "GOSPODINJSKI STATUS": ["0", "11"]}, [60000, 23000]))
    assert [(r.series, r.value) for r in alone] == [("persons_85_plus", 60000), ("living_alone_85_plus", 23000)]


def test_one_failing_demography_table_keeps_the_others(caplog):
    caplog.set_level("INFO")
    client = MagicMock(spec=DemographyClient)
    rows = migration_observations(payload({"OBČINE": ["061"], "LETO": ["2025"], "MERITVE": ["19"]}, [1200]))
    for name in ("population", "migration", "dwellings", "tenure", "households", "living_alone"):
        getattr(client, name).return_value = rows
    client.deaths.side_effect = RuntimeError("SURS 500")
    connection = MagicMock()

    report = sync_demography(connection, client)

    assert "surs_deaths" not in report.counts
    assert report.failures == {"surs_deaths": "RuntimeError: SURS 500"}
    assert len(report.counts) == 6
    assert connection.rollback.call_count == 1
    assert "failed: surs_deaths" in caplog.text
