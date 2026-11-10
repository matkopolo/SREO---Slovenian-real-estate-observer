"""SURS demographic and housing-stock context for the SREO overview.

Every value is stored as published in analytics.context_series (source 'surs'):

- 05C4004S population on 1 January (H1) by municipality and five-year age group;
- 05L2016S deaths by statistical region and five-year age group;
- 05I2002S net migration by municipality;
- 0861110S dwellings by occupancy, 0861102S occupied dwellings by tenure and
  05F3015S households by size, per municipality (register census years only);
- 05E3002S people living alone by age group (Slovenia, register census years).

Nothing here alters GURS ETN facts or market statistics.
"""

from __future__ import annotations

import json
import logging
from collections.abc import Callable

import psycopg

from .context import ContextClient, Observation, jsonstat_rows, municipality_key, px_query, store_fetched
from .source_sync import SourceSyncReport, run_isolated_sources

logger = logging.getLogger(__name__)

PX = "https://pxweb.stat.si/SiStatData/api/v1/sl/Data/{}.px"
POPULATION, DEATHS, MIGRATION = "05C4004S", "05L2016S", "05I2002S"
DWELLINGS, TENURE, HOUSEHOLDS, LIVING_ALONE = "0861110S", "0861102S", "05F3015S", "05E3002S"

#: 05C4004S STAROST codes -> age-group label (1 = 0-4 … 21 = 100+).
POPULATION_AGES = {"0": "total", **{str(code): f"{(code - 1) * 5}_{(code - 1) * 5 + 4}" for code in range(1, 21)},
                   "21": "100_plus"}
#: 05L2016S STAROST codes ('000' = 0-4 … '100' = 100+).
DEATH_AGES = {"1000": "total", **{f"{start:03d}": f"{start}_{start + 4}" for start in range(0, 100, 5)},
              "100": "100_plus"}
#: 05E3002S STAROST codes for 65+ (14 = 65-69 … 18 = 85+) and the total.
ALONE_AGES = {"0": "total", "14": "65_69", "15": "70_74", "16": "75_79", "17": "80_84", "18": "85_plus"}
MIGRATION_MEASURES = {"19": ("net_migration_total", "persons"), "07": ("net_migration_international", "persons"),
                      "16": ("net_migration_internal", "persons"), "28": ("net_migration_per_1000", "per 1000")}
OCCUPANCY = {"0": "dwellings_total", "1": "dwellings_occupied", "2": "dwellings_unoccupied",
             "21": "dwellings_seasonal", "22": "dwellings_vacant"}
TENURES = {"0": "occupied_dwellings_tenure_total", "1": "dwellings_owner_occupied", "3": "dwellings_rented"}
HOUSEHOLD_SIZES = {"99": "households_total", "1": "households_one_person"}
CENSUS_YEARS = ["2018", "2021"]


def region_key(code: str) -> str:
    number = int(code)
    return "SI" if number == 0 else f"region:{number}"


def population_observations(payload: dict) -> list[Observation]:
    return [Observation("surs", f"population_{POPULATION_AGES[dims['STAROST']]}", municipality_key(dims["OBČINE"]),
                        dims["POLLETJE"], value, "persons", f"SURS {POPULATION}")
            for dims, value in jsonstat_rows(payload) if dims["STAROST"] in POPULATION_AGES]


def death_observations(payload: dict) -> list[Observation]:
    return [Observation("surs", f"deaths_{DEATH_AGES[dims['STAROST']]}", region_key(dims["STATISTIČNA REGIJA"]),
                        dims["LETO"], value, "persons", f"SURS {DEATHS}")
            for dims, value in jsonstat_rows(payload) if dims["STAROST"] in DEATH_AGES]


def migration_observations(payload: dict) -> list[Observation]:
    rows = []
    for dims, value in jsonstat_rows(payload):
        series = MIGRATION_MEASURES.get(dims["MERITVE"])
        if series:
            rows.append(Observation("surs", series[0], municipality_key(dims["OBČINE"]), dims["LETO"], value,
                                    series[1], f"SURS {MIGRATION}"))
    return rows


def stock_observations(
    payload: dict, dimension: str, series: dict[str, str], unit: str, table: str,
) -> list[Observation]:
    rows = []
    for dims, value in jsonstat_rows(payload):
        name = series.get(dims[dimension])
        if name:
            rows.append(Observation("surs", name, municipality_key(dims["OBČINE"]), dims["LETO"], value, unit,
                                    f"SURS {table}"))
    return rows


def living_alone_observations(payload: dict) -> list[Observation]:
    rows = []
    for dims, value in jsonstat_rows(payload):
        age = ALONE_AGES.get(dims["STAROST"])
        status = {"0": "persons", "11": "living_alone"}.get(dims["GOSPODINJSKI STATUS"])
        if age and status:
            rows.append(Observation("surs", f"{status}_{age}", "SI", dims["LETO"], value, "persons",
                                    f"SURS {LIVING_ALONE}"))
    return rows


class DemographyClient(ContextClient):
    def _metadata(self, table: str) -> dict:
        return json.loads(self._get(PX.format(table)))

    def _values(self, table: str, variable: str) -> list[str]:
        return next(item["values"] for item in self._metadata(table)["variables"] if item["code"] == variable)

    def population(self) -> list[Observation]:
        # The newest eleven 1 January stocks give a ten-year change.
        periods = sorted(value for value in self._values(POPULATION, "POLLETJE") if value.endswith("H1"))[-11:]
        return population_observations(self._post(PX.format(POPULATION), px_query({
            "SPOL": ("item", ["0"]), "OBČINE": ("all", ["*"]), "POLLETJE": ("item", periods),
            "STAROST": ("item", list(POPULATION_AGES)),
        })))

    def deaths(self) -> list[Observation]:
        years = sorted(self._values(DEATHS, "LETO"))[-5:]
        return death_observations(self._post(PX.format(DEATHS), px_query({
            "SPOL": ("item", ["0"]), "STAROST": ("item", list(DEATH_AGES)), "LETO": ("item", years),
            "STATISTIČNA REGIJA": ("all", ["*"]),
        })))

    def migration(self) -> list[Observation]:
        years = sorted(self._values(MIGRATION, "LETO"))[-10:]
        return migration_observations(self._post(PX.format(MIGRATION), px_query({
            "OBČINE": ("all", ["*"]), "LETO": ("item", years), "MERITVE": ("item", list(MIGRATION_MEASURES)),
        })))

    def dwellings(self) -> list[Observation]:
        return stock_observations(self._post(PX.format(DWELLINGS), px_query({
            "OBČINE": ("all", ["*"]), "NASELJENOST": ("item", list(OCCUPANCY)), "VRSTA STAVBE": ("item", ["0"]),
            "LETO": ("item", CENSUS_YEARS), "MERITVE": ("item", ["1"]),
        })), "NASELJENOST", OCCUPANCY, "dwellings", DWELLINGS)

    def tenure(self) -> list[Observation]:
        return stock_observations(self._post(PX.format(TENURE), px_query({
            "OBČINE": ("all", ["*"]), "TIP LASTNIŠTVA": ("item", list(TENURES)), "LETO": ("item", CENSUS_YEARS),
            "MERITVE": ("item", ["1"]),
        })), "TIP LASTNIŠTVA", TENURES, "dwellings", TENURE)

    def households(self) -> list[Observation]:
        return stock_observations(self._post(PX.format(HOUSEHOLDS), px_query({
            "OBČINE": ("all", ["*"]), "LETO": ("item", CENSUS_YEARS),
            "ŠTEVILO ČLANOV GOSPODINJSTVA": ("item", list(HOUSEHOLD_SIZES)),
        })), "ŠTEVILO ČLANOV GOSPODINJSTVA", HOUSEHOLD_SIZES, "households", HOUSEHOLDS)

    def living_alone(self) -> list[Observation]:
        return living_alone_observations(self._post(PX.format(LIVING_ALONE), px_query({
            "KOHEZIJSKA REGIJA": ("item", ["0"]), "STAROST": ("item", list(ALONE_AGES)), "SPOL": ("item", ["0"]),
            "LETO": ("item", CENSUS_YEARS), "GOSPODINJSKI STATUS": ("item", ["0", "11"]),
        })))


def sync_demography(connection: psycopg.Connection, client: DemographyClient | None = None) -> SourceSyncReport:
    """Fetch and upsert every demographic table; one failing table keeps its stored values."""
    if client is None:
        with DemographyClient() as owned:
            return sync_demography(connection, owned)
    fetchers: dict[str, Callable[[], list[Observation]]] = {
        "surs_population": client.population, "surs_deaths": client.deaths, "surs_migration": client.migration,
        "surs_dwellings": client.dwellings, "surs_tenure": client.tenure, "surs_households": client.households,
        "surs_living_alone": client.living_alone,
    }
    return run_isolated_sources(
        connection,
        {name: (lambda fetch=fetch: store_fetched(connection, fetch)) for name, fetch in fetchers.items()},
        group="demography",
    )
