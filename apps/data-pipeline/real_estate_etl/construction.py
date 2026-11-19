"""Official construction sources for "Gradbeni projekti" v1.

- GURS Kataster nepremičnin buildings (JGP product 14): every registered building with its
  point, year built, floors, dwellings, floor area and the façade and roof renovation years,
  and every part of building (del stavbe) with its use, elevator, area and the window and
  installation renovation years. Ownership files in the archive are never read.
- SURS 1970717S: building permits per municipality and year (counts only).

Registered buildings are completed or measurable buildings, not construction in progress.
"""

from __future__ import annotations

import csv
import io
import logging
import re
import time
import zipfile
from collections.abc import Iterator
from datetime import date
from pathlib import Path
from typing import Any

import httpx
import psycopg
from psycopg import sql

from . import http_client
from .context import Observation, jsonstat_rows, municipality_key, store_observations
from .database import scalar
from .parsing import four_digit_year, gurs_integer, gurs_number, iso_day, safe_file_name, snapshot_date
from .settings import API_BASE, raw_data_dir
from .shapefile import iter_dbf, iter_points, member_named, open_nested_zip, read_member
from .source_sync import SourceSyncReport, run_isolated_sources

logger = logging.getLogger(__name__)

JGP_BUILDINGS = f"{API_BASE}/display-views/groups/121/composite-products/14"
JGP_FILTER = "filterParam=DRZAVA&filterValue=1"
SURS_PERMITS = "https://pxweb.stat.si/SiStatData/api/v1/sl/Data/1970717S.px"
CODEBOOKS = {"TIPI_STAVB": "building_type", "NOSILNE_KONSTRUKCIJE": "load_bearing_structure",
             "STATUSI_VPISA_STAVBE": "registration_status", "VRSTE_DEJANSKIH_RAB_DEL_ST": "actual_use"}
PERMIT_MEASURES = {"1": ("permit_buildings", "buildings"), "2": ("permit_floor_area", "m2"),
                   "4": ("permit_dwellings", "dwellings")}
#: Permit years requested from SURS: the newest ten.
PERMIT_YEARS = 10
BUILDING_COLUMNS = ("eid", "cadastral_code", "building_number", "year_built", "floors", "dwellings",
                    "business_units", "building_type", "load_bearing_structure", "registration_status",
                    "gross_floor_area", "municipality_eid", "record_changed_on", "location", "source_date",
                    "facade_renovated", "roof_renovated")
PART_COLUMNS = ("eid", "building_eid", "part_number", "actual_use", "elevator", "windows_renovated",
                "installations_renovated", "area", "usable_area", "record_changed_on", "source_date")
#: Members of the archive that are read. Everything else, in particular the owner files
#: (imetniki_lastnistva, pravice_lastnistva, osebe), stays unopened.
PARTS_MEMBER = re.compile(r"_STAVBE_SLO_deli_stavb_\d{8}\.csv$")
BUILDINGS_MEMBER = re.compile(r"_STAVBE_SLO_stavbe_\d{8}\.zip$")
#: The name GURS gives the national building snapshot (``KN_SLO_STAVBE_SLO_20261101.zip``).
SNAPSHOT_NAME = re.compile(r"KN_SLO_STAVBE_SLO_\d{8}\.zip")
#: DVIGALO / DA_NE codebook: 1 = yes, 2 = no, 0 = unknown.
YES_NO = {"1": True, "2": False}
#: Download chunk for the multi-hundred-megabyte snapshot.
SNAPSHOT_CHUNK_BYTES = 4 << 20


# --------------------------------------------------------------------------- buildings

def source_date(name: str) -> date:
    """The ``_YYYYMMDD`` snapshot date in a GURS building archive name (see :func:`parsing.snapshot_date`)."""
    return snapshot_date(name)


def building_rows(archive: zipfile.ZipFile, snapshot: date) -> Iterator[tuple[Any, ...]]:
    """Pair DBF attributes with Shapefile points record by record.

    Raises:
        ValueError: When the archive lacks the building tables or the two files hold
            different numbers of records, because any pairing after that point would
            attach buildings to the wrong coordinates.
    """
    inner_name = next((n for n in archive.namelist() if BUILDINGS_MEMBER.search(n)), None)
    if inner_name is None:
        raise ValueError(f"{archive.filename}: no building archive (_STAVBE_SLO_stavbe_YYYYMMDD.zip) member")
    inner = open_nested_zip(archive, inner_name)
    base = member_named(inner, "_tocka.dbf", label="building point table")[:-4]
    label = f"{inner_name}/{base}"
    with inner.open(base + ".dbf") as dbf, inner.open(base + ".shp") as shp:
        try:
            for attributes, point in zip(
                iter_dbf(dbf, label=label), iter_points(shp, label=label), strict=True,
            ):
                if attributes is None:
                    continue
                eid = attributes["EID_STAVBA"].strip()
                cadastral, number = gurs_integer(attributes["KO_ID"]), gurs_integer(attributes["ST_STAVBE"])
                if not eid or cadastral is None or number is None:
                    continue
                yield (
                    eid, cadastral, number, gurs_integer(attributes["LETO_IZGRA"]),
                    gurs_integer(attributes["STEVILO_ET"]), gurs_integer(attributes["STEVILO_ST"]),
                    gurs_integer(attributes["STEVILO_PO"]), gurs_integer(attributes["TIP_STAVBE"]),
                    gurs_integer(attributes["NOSILNA_KO"]), gurs_integer(attributes["STATUS_VPI"]),
                    gurs_number(attributes["BRUTO_TLOR"]), attributes["EID_OBCINA"].strip() or None,
                    _changed_on(attributes.get("DATUM_SYS", "")),
                    f"SRID=3794;POINT({point[0]} {point[1]})" if point else None,
                    snapshot,
                    # dBASE truncates LETO_OBNOVE_FASADE and LETO_OBNOVE_STREHE to these two names, in this order.
                    gurs_integer(attributes.get("LETO_OBNOV", "")), gurs_integer(attributes.get("LETO_OBNO0", "")),
                )
        except ValueError as error:
            raise ValueError(f"{label}: {error}") from error


def _changed_on(raw: str) -> str | None:
    return f"{raw[:4]}-{raw[4:6]}-{raw[6:8]}" if len(raw) == 8 else None


def part_rows(archive: zipfile.ZipFile, snapshot: date) -> Iterator[tuple[Any, ...]]:
    """Stream the parts of buildings (deli stavb) CSV: about 1.9 million rows, comma-separated.

    Raises:
        ValueError: When the archive holds no parts table.
    """
    member = next((n for n in archive.namelist() if PARTS_MEMBER.search(n)), None)
    if member is None:
        raise ValueError(f"{archive.filename}: no parts table (_STAVBE_SLO_deli_stavb_YYYYMMDD.csv) member")
    with archive.open(member) as raw:
        reader = csv.DictReader(io.TextIOWrapper(raw, encoding="utf-8-sig", newline=""))
        for row in reader:
            eid, building = row["EID_DEL_STAVBE"].strip(), row["EID_STAVBA"].strip()
            number = gurs_integer(row["ST_DELA_STAVBE"])
            if not eid or not building or number is None:
                continue
            yield (
                eid, building, number, gurs_integer(row["VRSTA_DEJANSKE_RABE_DEL_ST_ID"]),
                YES_NO.get(row["DVIGALO"].strip()), four_digit_year(row["LETO_OBNOVE_OKEN"]),
                four_digit_year(row["LETO_OBNOVE_INSTALACIJ"]), gurs_number(row["POVRSINA"]),
                gurs_number(row["UPORABNA_POVRSINA"]), iso_day(row["DATUM_SYS"]), snapshot,
            )


def codebook_rows(archive: zipfile.ZipFile) -> list[tuple[str, int, str]]:
    """``(codebook, code, label)`` rows from the ``sifranti/*.CSV`` members that exist."""
    rows: list[tuple[str, int, str]] = []
    for source, codebook in CODEBOOKS.items():
        member = f"sifranti/{source}.CSV"
        if member not in archive.namelist():
            continue
        text = read_member(archive, member).decode("utf-8-sig")
        rows.extend(
            (codebook, int(row["sifra"]), row["nazivSl"].strip())
            for row in csv.DictReader(io.StringIO(text))
            if row.get("sifra") not in (None, "") and row.get("nazivSl")
        )
    return rows


def download_buildings(client: httpx.Client, output_dir: Path) -> Path:
    """Download the newest national building snapshot (about 700 MB) unless it is already on disk.

    Raises:
        RuntimeError: When GURS reports the snapshot as not ready.
        ValueError: When GURS publishes a file name outside the expected shape.
    """
    result = http_client.fetch_json(client, f"{JGP_BUILDINGS}/result?{JGP_FILTER}", "GURS building snapshot status")
    if result.get("statusText") != "OK" or not result.get("file"):
        raise RuntimeError(f"GURS building snapshot not ready: {result}")
    target = output_dir / safe_file_name(str(result["file"]["name"]), SNAPSHOT_NAME)
    if target.exists() and zipfile.is_zipfile(target):
        logger.info("Using existing GURS building snapshot %s", target)
        return target
    started = time.monotonic()

    def download() -> Path:
        # Each attempt asks for a fresh signed link: the previous one may have expired.
        link = http_client.fetch_json(client, f"{JGP_BUILDINGS}/file?{JGP_FILTER}", "GURS building snapshot link")
        return http_client.download_file(client, link["url"], target, chunk_bytes=SNAPSHOT_CHUNK_BYTES)

    http_client.with_retries(download, f"GURS building snapshot {target.name} download")
    logger.info("Downloaded %s in %.0fs", target.name, time.monotonic() - started)
    for stale in output_dir.glob("KN_SLO_STAVBE_SLO_*.zip"):
        if stale != target:
            logger.info("Removing superseded GURS building snapshot %s", stale.name)
            stale.unlink()  # keep only the newest national snapshot
    return target


def load_buildings(connection: psycopg.Connection[Any], path: Path) -> int:
    """Replace the building snapshot atomically; readers keep the previous rows until commit.

    Returns:
        The number of buildings loaded, or 0 when this snapshot date is already stored.
    """
    snapshot = source_date(path.name)
    current = scalar(connection, "SELECT max(source_date) FROM analytics.cadastre_buildings")
    if current == snapshot:
        logger.info("GURS building snapshot %s already loaded", snapshot)
        return 0
    connection.commit()  # the swap below must be its own top-level transaction, not a savepoint
    started = time.monotonic()
    with zipfile.ZipFile(path) as archive, connection.transaction(), connection.cursor() as cursor:
        cursor.execute("CREATE TEMP TABLE staging_buildings (LIKE analytics.cadastre_buildings) ON COMMIT DROP")
        count = 0
        statement = sql.SQL("COPY staging_buildings ({}) FROM STDIN").format(
            sql.SQL(",").join(map(sql.Identifier, BUILDING_COLUMNS)))
        with cursor.copy(statement) as copy:
            for row in building_rows(archive, snapshot):
                copy.write_row(row)
                count += 1
        cursor.execute("DELETE FROM analytics.cadastre_buildings")
        # GURS can list one EID more than once; keep its most recently changed record.
        cursor.execute(
            """INSERT INTO analytics.cadastre_buildings
               SELECT DISTINCT ON (eid) * FROM staging_buildings
               ORDER BY eid, record_changed_on DESC NULLS LAST, building_number, cadastral_code"""
        )
        loaded = cursor.rowcount
        cursor.executemany(
            """INSERT INTO analytics.cadastre_codebooks (codebook, code, label) VALUES (%s, %s, %s)
               ON CONFLICT (codebook, code) DO UPDATE SET label = excluded.label""",
            codebook_rows(archive))
    if count > loaded >= 0:
        logger.warning("GURS building snapshot %s: dropped %s duplicate EID record(s)", snapshot, f"{count - loaded:,}")
    logger.info("Loaded %s GURS buildings (snapshot %s) in %.0fs", f"{loaded:,}", snapshot,
                time.monotonic() - started)
    return loaded


def load_building_parts(connection: psycopg.Connection[Any], path: Path) -> int:
    """Replace the parts of buildings from the same snapshot as the buildings, atomically.

    Returns:
        The number of parts loaded, or 0 when this snapshot date is already stored.
    """
    snapshot = source_date(path.name)
    current = scalar(connection, "SELECT max(source_date) FROM analytics.cadastre_building_parts")
    if current == snapshot:
        logger.info("GURS building parts snapshot %s already loaded", snapshot)
        return 0
    connection.commit()
    started = time.monotonic()
    with zipfile.ZipFile(path) as archive, connection.transaction(), connection.cursor() as cursor:
        cursor.execute("CREATE TEMP TABLE staging_parts (LIKE analytics.cadastre_building_parts) ON COMMIT DROP")
        count = 0
        statement = sql.SQL("COPY staging_parts ({}) FROM STDIN").format(
            sql.SQL(",").join(map(sql.Identifier, PART_COLUMNS)))
        with cursor.copy(statement) as copy:
            for row in part_rows(archive, snapshot):
                copy.write_row(row)
                count += 1
        cursor.execute("DELETE FROM analytics.cadastre_building_parts")
        cursor.execute(
            """INSERT INTO analytics.cadastre_building_parts
               SELECT DISTINCT ON (eid) * FROM staging_parts
               ORDER BY eid, record_changed_on DESC NULLS LAST, building_eid, part_number"""
        )
        loaded = cursor.rowcount
    if count > loaded >= 0:
        logger.warning("GURS building parts %s: dropped %s duplicate EID record(s)", snapshot, f"{count - loaded:,}")
    logger.info("Loaded %s GURS parts of buildings (snapshot %s) in %.0fs", f"{loaded:,}", snapshot,
                time.monotonic() - started)
    return loaded


# --------------------------------------------------------------------------- SURS permits

def permit_observations(payload: dict[str, Any]) -> list[Observation]:
    """Building-permit counts, floor area and dwellings per municipality and year."""
    rows = []
    for dims, value in jsonstat_rows(payload):
        series = PERMIT_MEASURES.get(dims["MERITVE"])
        if series:
            rows.append(Observation("surs", series[0], municipality_key(dims["OBČINE"]), dims["LETO"],
                                    value, series[1], "SURS 1970717S"))
    return rows


def sync_permits(connection: psycopg.Connection[Any], client: httpx.Client) -> int:
    """Fetch the newest :data:`PERMIT_YEARS` years of SURS 1970717S and upsert them.

    Raises:
        ValueError: When SURS returns no permit observations (nothing is overwritten).
    """
    metadata = http_client.fetch_json(client, SURS_PERMITS, "SURS 1970717S metadata")
    years = next(v["values"] for v in metadata["variables"] if v["code"] == "LETO")[-PERMIT_YEARS:]
    payload = http_client.fetch_json(client, SURS_PERMITS, "SURS 1970717S query", body={"query": [
        {"code": "OBČINE", "selection": {"filter": "all", "values": ["*"]}},
        {"code": "TIP STAVBE", "selection": {"filter": "item", "values": ["1"]}},
        {"code": "LETO", "selection": {"filter": "item", "values": years}},
        {"code": "MERITVE", "selection": {"filter": "item", "values": list(PERMIT_MEASURES)}},
    ], "response": {"format": "json-stat2"}})
    rows = permit_observations(payload)
    if not rows:
        raise ValueError("SURS 1970717S returned no permit observations")
    count = store_observations(connection, rows)
    logger.info("Synchronized %s SURS building-permit observations (%s–%s)", f"{count:,}", years[0], years[-1])
    return count


# --------------------------------------------------------------------------- orchestration

def sync_construction(
    connection: psycopg.Connection[Any],
    output_dir: Path | None = None,
    client: httpx.Client | None = None,
) -> SourceSyncReport:
    """Refresh every construction source; one failing source keeps its stored data."""
    directory: Path = output_dir or raw_data_dir()
    if client is None:
        with http_client.create_client() as owned:
            return sync_construction(connection, directory, owned)
    http = client
    return run_isolated_sources(
        connection,
        {
            "surs_permits": lambda: sync_permits(connection, http),
            "gurs_buildings": lambda: load_buildings(connection, download_buildings(http, directory)),
            "gurs_building_parts": lambda: load_building_parts(connection, download_buildings(http, directory)),
        },
        group="construction sources",
    )
