"""Official context series for the affordability illustration (SURS, Banka Slovenije, ECB).

Every series is stored as published (period label, value, unit, source table). Nothing here
alters GURS ETN facts, market statistics or valuation models.
"""

from __future__ import annotations

import csv
import io
import json
import logging
from collections.abc import Callable, Iterable
from dataclasses import dataclass
from itertools import product
from types import TracebackType
from typing import Any

import httpx
import psycopg

from . import http_client
from .source_sync import SourceSyncReport, run_isolated_sources

logger = logging.getLogger(__name__)

SURS_WAGE_DISTRIBUTION = "https://pxweb.stat.si/SiStatData/api/v1/sl/Data/0711357S.px"
SURS_AVERAGE_WAGE = "https://pxweb.stat.si/SiStatData/api/v1/sl/Data/0701015S.px"
BSI_HOUSEHOLD_RATES = "https://px.bsi.si/api/v1/sl/serije_slo/20_obrestne_mere/20_OBR_MERE_MFI/I2_4_3AS.px"
ECB_EURIBOR_6M = ("https://data-api.ecb.europa.eu/service/data/FM/"
                  "M.U2.EUR.RT.MM.EURIBOR6MD_.HSTA?lastNObservations=6&format=csvdata")

#: SURS 0711357S MERITVE codes -> stored series (net wages, all employees, by residence).
WAGE_MEASURES = {"1": "net_wage_mean", "2": "net_wage_p50", "3": "net_wage_q1",
                 "4": "net_wage_q3", "5": "net_wage_p10", "6": "net_wage_p90"}
#: Banka Slovenije I2_4_3AS "Postavke" -> new housing loans to households (monthly, %).
BSI_ITEMS = {"9": "housing_rate_variable", "12": "housing_rate_fixed_10y", "17": "housing_rate_aprc"}


@dataclass(frozen=True)
class Observation:
    source: str
    series: str
    geography_key: str
    period: str
    value: float
    unit: str
    source_table: str


def jsonstat_rows(payload: dict) -> Iterable[tuple[dict[str, str], float]]:
    """Flatten a JSON-stat 2.0 dataset into ({dimension: category code}, value) pairs."""
    ids = payload["id"]
    sizes = payload["size"]
    codes = []
    for dimension in ids:
        index = payload["dimension"][dimension]["category"]["index"]
        ordered = sorted(index, key=index.get) if isinstance(index, dict) else list(index)
        codes.append(ordered)
    values = payload["value"]
    keyed = values.items() if isinstance(values, dict) else enumerate(values)
    for dimension, ordered, size in zip(ids, codes, sizes, strict=True):
        if len(ordered) != size:
            raise ValueError(f"JSON-stat dimension {dimension} lists {len(ordered)} categories, size says {size}")
    lookup = {int(position): value for position, value in keyed}
    for position, combination in enumerate(product(*codes)):
        value = lookup.get(position)
        if value is None:
            continue
        yield dict(zip(ids, combination, strict=True)), float(value)


def latest_value(metadata: dict, variable: str) -> str:
    """Newest code of a PX-Web variable whose values are sortable period labels."""
    values = next(item["values"] for item in metadata["variables"] if item["code"] == variable)
    return max(values)


def municipality_key(code: str) -> str:
    number = int(code)
    return "SI" if number == 0 else f"municipality:{number}"


def surs_wage_observations(payload: dict) -> list[Observation]:
    rows = []
    for dims, value in jsonstat_rows(payload):
        series = WAGE_MEASURES.get(dims["MERITVE"])
        if series:
            rows.append(Observation("surs", series, municipality_key(dims["OBČINE"]), dims["MESEC"],
                                    value, "EUR/month", "SURS 0711357S"))
    return rows


def surs_average_observations(payload: dict) -> list[Observation]:
    return [Observation("surs", "net_wage_mean_monthly", "SI", dims["MESEC"], value, "EUR/month",
                        "SURS 0701015S") for dims, value in jsonstat_rows(payload)]


def bsi_rate_observations(payload: dict) -> list[Observation]:
    return [Observation("bsi", BSI_ITEMS[dims["Postavke"]], "SI", dims["Datum"], value, "percent",
                        "Banka Slovenije I2_4_3AS") for dims, value in jsonstat_rows(payload)
            if dims["Postavke"] in BSI_ITEMS]


def ecb_observations(text: str) -> list[Observation]:
    reader = csv.DictReader(io.StringIO(text))
    return [Observation("ecb", "euribor_6m", "SI", row["TIME_PERIOD"], float(row["OBS_VALUE"]),
                        "percent", "ECB FM EURIBOR6MD_ (monthly average)")
            for row in reader if row.get("OBS_VALUE")]


def px_query(selections: dict[str, tuple[str, list[str]]]) -> dict:
    return {"query": [{"code": code, "selection": {"filter": kind, "values": values}}
                      for code, (kind, values) in selections.items()],
            "response": {"format": "json-stat2"}}


class ContextClient:
    """PX-Web and ECB client; owns its HTTP connection pool unless one is injected."""

    def __init__(self, client: httpx.Client | None = None):
        self._owns_client = client is None
        self._client = client or http_client.create_client()

    def __enter__(self) -> ContextClient:
        return self

    def __exit__(
        self,
        exc_type: type[BaseException] | None,
        exc: BaseException | None,
        traceback: TracebackType | None,
    ) -> None:
        self.close()

    def close(self) -> None:
        if self._owns_client:
            self._client.close()

    def _post(self, url: str, body: dict[str, Any]) -> Any:
        return http_client.fetch_json(self._client, url, f"POST {url}", body=body)

    def _get(self, url: str) -> str:
        return http_client.fetch_text(self._client, url, f"GET {url}")

    def wages(self) -> list[Observation]:
        # 0711357S does not mark MESEC as a time variable, so "top" would return the first
        # (oldest) October; request the newest published month explicitly.
        metadata = json.loads(self._get(SURS_WAGE_DISTRIBUTION))
        latest = latest_value(metadata, "MESEC")
        return surs_wage_observations(self._post(SURS_WAGE_DISTRIBUTION, px_query({
            "MESEC": ("item", [latest]), "OBČINE": ("all", ["*"]), "SPOL": ("item", ["TOT"]),
            "PLAČA": ("item", ["2"]), "MERITVE": ("item", list(WAGE_MEASURES)),
        })))

    def average_wage(self) -> list[Observation]:
        return surs_average_observations(self._post(SURS_AVERAGE_WAGE, px_query({
            "SEKTOR": ("item", ["TOT"]), "MESEC": ("top", ["3"]),
            "PLAČE": ("item", ["2"]), "MERITVE": ("item", ["1"]),
        })))

    def housing_rates(self) -> list[Observation]:
        return bsi_rate_observations(self._post(BSI_HOUSEHOLD_RATES, px_query({
            "Datum": ("top", ["6"]), "Frekvenca": ("item", ["0"]), "Postavke": ("item", list(BSI_ITEMS)),
        })))

    def euribor(self) -> list[Observation]:
        return ecb_observations(self._get(ECB_EURIBOR_6M))


def store_observations(connection: psycopg.Connection, observations: list[Observation]) -> int:
    with connection.cursor() as cursor:
        cursor.executemany(
            """INSERT INTO analytics.context_series
                   (source, series, geography_key, period, value, unit, source_table, retrieved_at)
               VALUES (%s, %s, %s, %s, %s, %s, %s, now())
               ON CONFLICT (source, series, geography_key, period)
               DO UPDATE SET value = excluded.value, unit = excluded.unit,
                             source_table = excluded.source_table, retrieved_at = now()""",
            [(o.source, o.series, o.geography_key, o.period, o.value, o.unit, o.source_table)
             for o in observations],
        )
    return len(observations)


def store_fetched(connection: psycopg.Connection, fetch: Callable[[], list[Observation]]) -> int:
    """Fetch one source and upsert it; an empty response is a failure, never a wipe."""
    observations = fetch()
    if not observations:
        raise ValueError("source returned no observations")
    return store_observations(connection, observations)


def sync_context(connection: psycopg.Connection, client: ContextClient | None = None) -> SourceSyncReport:
    """Fetch and upsert every context series; one failing source does not block the others."""
    if client is None:
        with ContextClient() as owned:
            return sync_context(connection, owned)
    fetchers: dict[str, Callable[[], list[Observation]]] = {
        "surs_wage_distribution": client.wages,
        "surs_average_wage": client.average_wage,
        "bsi_housing_rates": client.housing_rates,
        "ecb_euribor_6m": client.euribor,
    }
    return run_isolated_sources(
        connection,
        {name: (lambda fetch=fetch: store_fetched(connection, fetch)) for name, fetch in fetchers.items()},
        group="affordability context",
    )
