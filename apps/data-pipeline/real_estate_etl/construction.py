"""Official construction sources for "Gradbeni projekti" v1.

- GURS Kataster nepremičnin buildings (JGP product 14): every registered building with its
  point, year built, floors, dwellings and floor area. Ownership files are never read.
- SURS 1970717S: building permits per municipality and year (counts only).

Registered buildings are completed or measurable buildings, not construction in progress.
"""

from __future__ import annotations

import csv
import io
import logging
import re
import struct
import time
import zipfile
from collections.abc import Iterator
from datetime import date
from pathlib import Path
from typing import BinaryIO

import httpx
import psycopg
from psycopg import sql

from . import http_client
from .context import Observation, jsonstat_rows, municipality_key, store_observations
from .settings import API_BASE, RAW_DATA_DIR
from .source_sync import SourceSyncReport, run_isolated_sources

logger = logging.getLogger(__name__)

JGP_BUILDINGS = f"{API_BASE}/display-views/groups/121/composite-products/14"
JGP_FILTER = "filterParam=DRZAVA&filterValue=1"
SURS_PERMITS = "https://pxweb.stat.si/SiStatData/api/v1/sl/Data/1970717S.px"
CODEBOOKS = {"TIPI_STAVB": "building_type", "NOSILNE_KONSTRUKCIJE": "load_bearing_structure",
             "STATUSI_VPISA_STAVBE": "registration_status"}
PERMIT_MEASURES = {"1": ("permit_buildings", "buildings"), "2": ("permit_floor_area", "m2"),
                   "4": ("permit_dwellings", "dwellings")}
BUILDING_COLUMNS = ("eid", "cadastral_code", "building_number", "year_built", "floors", "dwellings",
                    "business_units", "building_type", "load_bearing_structure", "registration_status",
                    "gross_floor_area", "municipality_eid", "record_changed_on", "location", "source_date")
#: Shapefile point records are the only geometry this product publishes.
SHAPE_POINT = 1


# --------------------------------------------------------------------------- buildings

def source_date(name: str) -> date:
    match = re.search(r"_(\d{8})\.zip$", name)
    if not match:
        raise ValueError(f"No snapshot date in {name}")
    value = match.group(1)
    return date(int(value[:4]), int(value[4:6]), int(value[6:]))


def _number(raw: str) -> float | None:
    raw = raw.strip()
    if not raw or raw.startswith("*"):  # DBF overflow / missing
        return None
    try:
        return float(raw)
    except ValueError:
        return None


def _integer(raw: str) -> int | None:
    value = _number(raw)
    return None if value is None else int(value)


def iter_dbf(stream: BinaryIO) -> Iterator[dict[str, str] | None]:
    """Stream dBASE III records as {field: text}, yielding ``None`` for deleted records.

    Deleted records still occupy a slot, and the matching Shapefile still holds a shape
    for them, so the caller needs the placeholder to keep both streams aligned.
    """
    first = stream.read(32)
    records, header_length, record_length = struct.unpack("<IHH", first[4:12])
    rest = stream.read(header_length - 32)
    fields: list[tuple[str, int]] = []
    for offset in range(0, len(rest), 32):
        descriptor = rest[offset:offset + 32]
        if not descriptor or descriptor[0] == 0x0D:
            break
        fields.append((descriptor[:11].split(b"\0")[0].decode("ascii"), descriptor[16]))
    if sum(length for _, length in fields) + 1 != record_length:
        raise ValueError("DBF field lengths do not match the record length")
    for number in range(1, records + 1):
        record = stream.read(record_length)
        if len(record) < record_length:
            raise ValueError(f"DBF ends at record {number} of {records} declared in its header")
        if record[:1] == b"*":  # deleted record
            yield None
            continue
        position, row = 1, {}
        for name, length in fields:
            row[name] = record[position:position + length].decode("utf-8", "replace").strip()
            position += length
        yield row


def iter_points(stream: BinaryIO) -> Iterator[tuple[float, float] | None]:
    """Stream Shapefile point records in file order; null and non-point shapes yield None."""
    stream.read(100)
    while True:
        header = stream.read(8)
        if not header:
            return
        if len(header) < 8:
            raise ValueError("Shapefile ends inside a record header")
        number, length = struct.unpack(">ii", header)
        content = stream.read(length * 2)
        if len(content) < length * 2 or len(content) < 4:
            raise ValueError(f"Shapefile record {number} is truncated")
        kind = struct.unpack("<i", content[:4])[0]
        yield struct.unpack("<2d", content[4:20]) if kind == SHAPE_POINT else None


def _changed_on(raw: str) -> str | None:
    return f"{raw[:4]}-{raw[4:6]}-{raw[6:8]}" if len(raw) == 8 else None


def building_rows(archive: zipfile.ZipFile, snapshot: date) -> Iterator[tuple]:
    """Pair DBF attributes with Shapefile points record by record.

    Raises ``ValueError`` when the two files hold different numbers of records, because
    any pairing after that point would attach buildings to the wrong coordinates.
    """
    inner_name = next(n for n in archive.namelist() if re.search(r"_STAVBE_SLO_stavbe_\d{8}\.zip$", n))
    with archive.open(inner_name) as raw:
        inner = zipfile.ZipFile(io.BytesIO(raw.read()))  # 57 MB compressed; members stream below
    base = next(n[:-4] for n in inner.namelist() if n.endswith("_tocka.dbf"))
    with inner.open(base + ".dbf") as dbf, inner.open(base + ".shp") as shp:
        try:
            for attributes, point in zip(iter_dbf(dbf), iter_points(shp), strict=True):
                if attributes is None:
                    continue
                eid = attributes["EID_STAVBA"].strip()
                cadastral, number = _integer(attributes["KO_ID"]), _integer(attributes["ST_STAVBE"])
                if not eid or cadastral is None or number is None:
                    continue
                yield (
                    eid, cadastral, number, _integer(attributes["LETO_IZGRA"]),
                    _integer(attributes["STEVILO_ET"]), _integer(attributes["STEVILO_ST"]),
                    _integer(attributes["STEVILO_PO"]), _integer(attributes["TIP_STAVBE"]),
                    _integer(attributes["NOSILNA_KO"]), _integer(attributes["STATUS_VPI"]),
                    _number(attributes["BRUTO_TLOR"]), attributes["EID_OBCINA"].strip() or None,
                    _changed_on(attributes.get("DATUM_SYS", "")),
                    f"SRID=3794;POINT({point[0]} {point[1]})" if point else None,
                    snapshot,
                )
        except ValueError as error:
            raise ValueError(f"{inner_name}/{base}: {error}") from error


def codebook_rows(archive: zipfile.ZipFile) -> list[tuple[str, int, str]]:
    rows = []
    for source, codebook in CODEBOOKS.items():
        member = f"sifranti/{source}.CSV"
        if member not in archive.namelist():
            continue
        text = archive.read(member).decode("utf-8-sig")
        rows.extend(
            (codebook, int(row["sifra"]), row["nazivSl"].strip())
            for row in csv.DictReader(io.StringIO(text))
            if row.get("sifra") not in (None, "") and row.get("nazivSl")
        )
    return rows


def download_buildings(client: httpx.Client, output_dir: Path) -> Path:
    """Download the newest national building snapshot (about 700 MB) unless it is already on disk."""
    result = http_client.fetch_json(client, f"{JGP_BUILDINGS}/result?{JGP_FILTER}", "GURS building snapshot status")
    if result.get("statusText") != "OK" or not result.get("file"):
        raise RuntimeError(f"GURS building snapshot not ready: {result}")
    target = output_dir / result["file"]["name"]
    if target.exists() and zipfile.is_zipfile(target):
        logger.info("Using existing GURS building snapshot %s", target)
        return target
    link = http_client.fetch_json(client, f"{JGP_BUILDINGS}/file?{JGP_FILTER}", "GURS building snapshot link")
    started = time.monotonic()
    http_client.with_retries(
        lambda: http_client.download_file(client, link["url"], target, chunk_bytes=4 << 20),
        f"GURS building snapshot {target.name} download",
    )
    logger.info("Downloaded %s in %.0fs", target.name, time.monotonic() - started)
    for stale in output_dir.glob("KN_SLO_STAVBE_SLO_*.zip"):
        if stale != target:
            logger.info("Removing superseded GURS building snapshot %s", stale.name)
            stale.unlink()  # keep only the newest national snapshot
    return target


def load_buildings(connection: psycopg.Connection, path: Path) -> int:
    """Replace the building snapshot atomically; readers keep the previous rows until commit."""
    snapshot = source_date(path.name)
    current = connection.execute("SELECT max(source_date) FROM analytics.cadastre_buildings").fetchone()[0]
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
               ORDER BY eid, record_changed_on DESC NULLS LAST"""
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


# --------------------------------------------------------------------------- SURS permits

def permit_observations(payload: dict) -> list[Observation]:
    rows = []
    for dims, value in jsonstat_rows(payload):
        series = PERMIT_MEASURES.get(dims["MERITVE"])
        if series:
            rows.append(Observation("surs", series[0], municipality_key(dims["OBČINE"]), dims["LETO"],
                                    value, series[1], "SURS 1970717S"))
    return rows


def sync_permits(connection: psycopg.Connection, client: httpx.Client) -> int:
    metadata = http_client.fetch_json(client, SURS_PERMITS, "SURS 1970717S metadata")
    years = next(v["values"] for v in metadata["variables"] if v["code"] == "LETO")[-10:]
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
    connection: psycopg.Connection,
    output_dir: Path = RAW_DATA_DIR,
    client: httpx.Client | None = None,
) -> SourceSyncReport:
    """Refresh every construction source; one failing source keeps its stored data."""
    if client is None:
        with http_client.create_client() as owned:
            return sync_construction(connection, output_dir, owned)
    return run_isolated_sources(
        connection,
        {
            "surs_permits": lambda: sync_permits(connection, client),
            "gurs_buildings": lambda: load_buildings(connection, download_buildings(client, output_dir)),
        },
        group="construction sources",
    )
