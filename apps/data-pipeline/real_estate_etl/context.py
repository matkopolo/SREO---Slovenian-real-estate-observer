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

import httpx
from tenacity import retry, retry_if_exception_type, stop_after_attempt, wait_exponential

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
    lookup = dict((int(position), value) for position, value in keyed)
    for position, combination in enumerate(product(*codes)):
        value = lookup.get(position)
        if value is None:
            continue
        assert len(combination) == len(sizes)
        yield dict(zip(ids, combination)), float(value)


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
                        "percent", "ECB FM EURIBOR6MD_ (mesečno povprečje)")
            for row in reader if row.get("OBS_VALUE")]


def _query(selections: dict[str, tuple[str, list[str]]]) -> dict:
    return {"query": [{"code": code, "selection": {"filter": kind, "values": values}}
                      for code, (kind, values) in selections.items()],
            "response": {"format": "json-stat2"}}


class ContextClient:
    def __init__(self, client: httpx.Client | None = None):
        self._client = client or httpx.Client(
            timeout=60, follow_redirects=True, headers={"User-Agent": "real-estate-etl/1.0"})

    @retry(stop=stop_after_attempt(4), wait=wait_exponential(multiplier=2, max=30), reraise=True,
           retry=retry_if_exception_type((httpx.TransportError, httpx.HTTPStatusError)))
    def _post(self, url: str, body: dict) -> dict:
        response = self._client.post(url, json=body)
        response.raise_for_status()
        return response.json()

    @retry(stop=stop_after_attempt(4), wait=wait_exponential(multiplier=2, max=30), reraise=True,
           retry=retry_if_exception_type((httpx.TransportError, httpx.HTTPStatusError)))
    def _get(self, url: str) -> str:
        response = self._client.get(url)
        response.raise_for_status()
        return response.text

    def wages(self) -> list[Observation]:
        # 0711357S does not mark MESEC as a time variable, so "top" would return the first
        # (oldest) October; request the newest published month explicitly.
        metadata = json.loads(self._get(SURS_WAGE_DISTRIBUTION))
        latest = latest_value(metadata, "MESEC")
        return surs_wage_observations(self._post(SURS_WAGE_DISTRIBUTION, _query({
            "MESEC": ("item", [latest]), "OBČINE": ("all", ["*"]), "SPOL": ("item", ["TOT"]),
            "PLAČA": ("item", ["2"]), "MERITVE": ("item", list(WAGE_MEASURES)),
        })))

    def average_wage(self) -> list[Observation]:
        return surs_average_observations(self._post(SURS_AVERAGE_WAGE, _query({
            "SEKTOR": ("item", ["TOT"]), "MESEC": ("top", ["3"]),
            "PLAČE": ("item", ["2"]), "MERITVE": ("item", ["1"]),
        })))

    def housing_rates(self) -> list[Observation]:
        return bsi_rate_observations(self._post(BSI_HOUSEHOLD_RATES, _query({
            "Datum": ("top", ["6"]), "Frekvenca": ("item", ["0"]), "Postavke": ("item", list(BSI_ITEMS)),
        })))

    def euribor(self) -> list[Observation]:
        return ecb_observations(self._get(ECB_EURIBOR_6M))


def store_observations(connection, observations: list[Observation]) -> int:
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


def sync_context(connection, client: ContextClient | None = None) -> dict[str, int]:
    """Fetch and upsert every context series; one failing source does not block the others."""
    client = client or ContextClient()
    counts: dict[str, int] = {}
    fetchers: dict[str, Callable[[], list[Observation]]] = {
        "surs_wage_distribution": client.wages,
        "surs_average_wage": client.average_wage,
        "bsi_housing_rates": client.housing_rates,
        "ecb_euribor_6m": client.euribor,
    }
    for name, fetch in fetchers.items():
        try:
            observations = fetch()
            if not observations:
                raise ValueError("source returned no observations")
            counts[name] = store_observations(connection, observations)
            connection.commit()
        except Exception as error:  # keep previously stored values for this source
            connection.rollback()
            logger.warning("Context source %s failed (%s); keeping stored values.", name, error)
    logger.info("Synchronized affordability context: %s",
                ", ".join(f"{name}={count}" for name, count in counts.items()) or "nothing")
    return counts
