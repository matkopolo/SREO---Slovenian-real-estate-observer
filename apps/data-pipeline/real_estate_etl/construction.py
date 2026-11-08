"""Official construction sources for "Gradbeni projekti" v1.

- GURS Kataster nepremičnin buildings (JGP product 14): every registered building with its
  point, year built, floors, dwellings and floor area. Ownership files are never read.
- EU TED Search API v3: Slovenian construction-works notices (CPV 45*), region-level location.
- SURS 1970717S: building permits per municipality and year (counts only).

Registered buildings are completed or measurable buildings, not construction in progress.
"""

from __future__ import annotations

import csv
import io
import json
import logging
import re
import struct
import time
import zipfile
from collections.abc import Iterator
from datetime import date
from pathlib import Path

import httpx
from psycopg import sql

from .context import Observation, jsonstat_rows, municipality_key, store_observations

logger = logging.getLogger(__name__)

JGP_BUILDINGS = "https://ipi.eprostor.gov.si/jgp-service-api/display-views/groups/121/composite-products/14"
JGP_FILTER = "filterParam=DRZAVA&filterValue=1"
TED_SEARCH = "https://api.ted.europa.eu/v3/notices/search"
SURS_PERMITS = "https://pxweb.stat.si/SiStatData/api/v1/sl/Data/1970717S.px"
CODEBOOKS = {"TIPI_STAVB": "building_type", "NOSILNE_KONSTRUKCIJE": "load_bearing_structure",
             "STATUSI_VPISA_STAVBE": "registration_status"}
PERMIT_MEASURES = {"1": ("permit_buildings", "buildings"), "2": ("permit_floor_area", "m2"),
                   "4": ("permit_dwellings", "dwellings")}
TED_FIELDS = ["publication-number", "notice-type", "publication-date", "notice-title", "buyer-name",
              "winner-name", "place-of-performance-subdiv-lot", "total-value", "total-value-cur"]


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


def iter_dbf(stream) -> Iterator[dict[str, str]]:
    """Stream dBASE III records as {field: text}; the whole header is read at once."""
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
    for _ in range(records):
        record = stream.read(record_length)
        if len(record) < record_length:
            break
        if record[:1] == b"*":  # deleted record
            continue
        position, row = 1, {}
        for name, length in fields:
            row[name] = record[position:position + length].decode("utf-8", "replace").strip()
            position += length
        yield row


def iter_points(stream) -> Iterator[tuple[float, float] | None]:
    """Stream Shapefile point records in file order; null shapes yield None."""
    stream.read(100)
    while True:
        header = stream.read(8)
        if len(header) < 8:
            return
        _, length = struct.unpack(">ii", header)
        content = stream.read(length * 2)
        kind = struct.unpack("<i", content[:4])[0]
        yield struct.unpack("<2d", content[4:20]) if kind == 1 else None


def building_rows(archive: zipfile.ZipFile, snapshot: date) -> Iterator[tuple]:
    inner_name = next(n for n in archive.namelist() if re.search(r"_STAVBE_SLO_stavbe_\d{8}\.zip$", n))
    with archive.open(inner_name) as raw:
        inner = zipfile.ZipFile(io.BytesIO(raw.read()))  # 57 MB compressed; members stream below
    base = next(n[:-4] for n in inner.namelist() if n.endswith("_tocka.dbf"))
    with inner.open(base + ".dbf") as dbf, inner.open(base + ".shp") as shp:
        for attributes, point in zip(iter_dbf(dbf), iter_points(shp)):
            eid = attributes["EID_STAVBA"].strip()
            cadastral, number = _integer(attributes["KO_ID"]), _integer(attributes["ST_STAVBE"])
            if not eid or cadastral is None or number is None:
                continue
            changed = attributes.get("DATUM_SYS", "")
            yield (
                eid, cadastral, number, _integer(attributes["LETO_IZGRA"]), _integer(attributes["STEVILO_ET"]),
                _integer(attributes["STEVILO_ST"]), _integer(attributes["STEVILO_PO"]),
                _integer(attributes["TIP_STAVBE"]), _integer(attributes["NOSILNA_KO"]),
                _integer(attributes["STATUS_VPI"]), _number(attributes["BRUTO_TLOR"]),
                attributes["EID_OBCINA"].strip() or None,
                f"{changed[:4]}-{changed[4:6]}-{changed[6:8]}" if len(changed) == 8 else None,
                f"SRID=3794;POINT({point[0]} {point[1]})" if point else None,
                snapshot,
            )


def codebook_rows(archive: zipfile.ZipFile) -> list[tuple[str, int, str]]:
    rows = []
    for source, codebook in CODEBOOKS.items():
        member = f"sifranti/{source}.CSV"
        if member not in archive.namelist():
            continue
        text = archive.read(member).decode("utf-8-sig")
        for row in csv.DictReader(io.StringIO(text)):
            if row.get("sifra") not in (None, "") and row.get("nazivSl"):
                rows.append((codebook, int(row["sifra"]), row["nazivSl"].strip()))
    return rows


def download_buildings(client: httpx.Client, output_dir: Path) -> Path:
    result = client.get(f"{JGP_BUILDINGS}/result?{JGP_FILTER}").json()
    if result.get("statusText") != "OK" or not result.get("file"):
        raise RuntimeError(f"GURS building snapshot not ready: {result}")
    target = output_dir / result["file"]["name"]
    if target.exists() and zipfile.is_zipfile(target):
        return target
    url = client.get(f"{JGP_BUILDINGS}/file?{JGP_FILTER}").json()["url"]
    partial = target.with_suffix(target.suffix + ".part")
    output_dir.mkdir(parents=True, exist_ok=True)
    started = time.monotonic()
    with client.stream("GET", url) as response, partial.open("wb") as output:
        response.raise_for_status()
        for chunk in response.iter_bytes(4 << 20):
            output.write(chunk)
    if not zipfile.is_zipfile(partial):
        partial.unlink(missing_ok=True)
        raise ValueError(f"Downloaded GURS building file is not a ZIP: {target.name}")
    partial.replace(target)
    logger.info("Downloaded %s in %.0fs", target.name, time.monotonic() - started)
    for stale in output_dir.glob("KN_SLO_STAVBE_SLO_*.zip"):
        if stale != target:
            stale.unlink()  # keep only the newest national snapshot (≈700 MB each)
    return target


def load_buildings(connection, path: Path) -> int:
    """Replace the building snapshot atomically; readers keep the previous rows until commit."""
    snapshot = source_date(path.name)
    current = connection.execute("SELECT max(source_date) FROM analytics.cadastre_buildings").fetchone()[0]
    if current == snapshot:
        logger.info("GURS building snapshot %s already loaded", snapshot)
        return 0
    connection.commit()  # the swap below must be its own top-level transaction, not a savepoint
    columns = ["eid", "cadastral_code", "building_number", "year_built", "floors", "dwellings",
               "business_units", "building_type", "load_bearing_structure", "registration_status",
               "gross_floor_area", "municipality_eid", "record_changed_on", "location", "source_date"]
    started = time.monotonic()
    with zipfile.ZipFile(path) as archive, connection.transaction(), connection.cursor() as cursor:
        cursor.execute("CREATE TEMP TABLE staging_buildings (LIKE analytics.cadastre_buildings) ON COMMIT DROP")
        count = 0
        statement = sql.SQL("COPY staging_buildings ({}) FROM STDIN").format(
            sql.SQL(",").join(map(sql.Identifier, columns)))
        with cursor.copy(statement) as copy:
            for row in building_rows(archive, snapshot):
                copy.write_row(row)
                count += 1
        cursor.execute("DELETE FROM analytics.cadastre_buildings")
        cursor.execute("INSERT INTO analytics.cadastre_buildings SELECT DISTINCT ON (eid) * FROM staging_buildings")
        cursor.executemany(
            """INSERT INTO analytics.cadastre_codebooks (codebook, code, label) VALUES (%s, %s, %s)
               ON CONFLICT (codebook, code) DO UPDATE SET label = excluded.label""",
            codebook_rows(archive))
    logger.info("Loaded %s GURS buildings (snapshot %s) in %.0fs", f"{count:,}", snapshot,
                time.monotonic() - started)
    return count


# --------------------------------------------------------------------------- TED

def _text(value) -> str | None:
    if isinstance(value, dict):
        value = value.get("slv") or value.get("eng") or next(iter(value.values()), None)
    if isinstance(value, list):
        value = value[0] if value else None
    return str(value).strip() if value not in (None, "") else None


def _list(value) -> list[str]:
    if isinstance(value, dict):
        value = value.get("slv") or value.get("eng") or next(iter(value.values()), [])
    if value is None:
        return []
    return [str(item).strip() for item in (value if isinstance(value, list) else [value]) if str(item).strip()]


def ted_row(notice: dict) -> tuple | None:
    number = notice.get("publication-number")
    published = _text(notice.get("publication-date"))
    title = _text(notice.get("notice-title"))
    if not number or not published or not title:
        return None
    value = notice.get("total-value")
    value = value[0] if isinstance(value, list) and value else value
    return (number, _text(notice.get("notice-type")) or "unknown", published[:10], title,
            _text(notice.get("buyer-name")), _list(notice.get("winner-name")),
            _list(notice.get("place-of-performance-subdiv-lot")),
            float(value) if isinstance(value, (int, float)) else None,
            _text(notice.get("total-value-cur")), f"https://ted.europa.eu/sl/notice/-/detail/{number}")


def sync_public_works(connection, client: httpx.Client, since: str = "20230101", max_pages: int = 60) -> int:
    rows = []
    for page in range(1, max_pages + 1):
        response = client.post(TED_SEARCH, json={
            "query": f"buyer-country=SVN AND classification-cpv=45000000 AND publication-date>={since}",
            "fields": TED_FIELDS, "limit": 250, "page": page, "paginationMode": "PAGE_NUMBER"})
        response.raise_for_status()
        notices = response.json().get("notices", [])
        rows.extend(row for row in map(ted_row, notices) if row)
        if len(notices) < 250:
            break
    connection.commit()
    with connection.transaction(), connection.cursor() as cursor:
        cursor.executemany(
            """INSERT INTO analytics.public_works_notices
                   (publication_number, notice_type, publication_date, title, buyer, winners, nuts3,
                    value, currency, url, retrieved_at)
               VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, now())
               ON CONFLICT (publication_number) DO UPDATE SET
                   notice_type = excluded.notice_type, title = excluded.title, buyer = excluded.buyer,
                   winners = excluded.winners, nuts3 = excluded.nuts3, value = excluded.value,
                   currency = excluded.currency, retrieved_at = now()""", rows)
    logger.info("Synchronized %s TED construction notices since %s", f"{len(rows):,}", since)
    return len(rows)


# --------------------------------------------------------------------------- SURS permits

def permit_observations(payload: dict) -> list[Observation]:
    rows = []
    for dims, value in jsonstat_rows(payload):
        series = PERMIT_MEASURES.get(dims["MERITVE"])
        if series:
            rows.append(Observation("surs", series[0], municipality_key(dims["OBČINE"]), dims["LETO"],
                                    value, series[1], "SURS 1970717S"))
    return rows


def sync_permits(connection, client: httpx.Client) -> int:
    metadata = client.get(SURS_PERMITS).json()
    years = next(v["values"] for v in metadata["variables"] if v["code"] == "LETO")[-10:]
    response = client.post(SURS_PERMITS, json={"query": [
        {"code": "OBČINE", "selection": {"filter": "all", "values": ["*"]}},
        {"code": "TIP STAVBE", "selection": {"filter": "item", "values": ["1"]}},
        {"code": "LETO", "selection": {"filter": "item", "values": years}},
        {"code": "MERITVE", "selection": {"filter": "item", "values": list(PERMIT_MEASURES)}},
    ], "response": {"format": "json-stat2"}})
    response.raise_for_status()
    rows = permit_observations(response.json())
    count = store_observations(connection, rows)
    connection.commit()
    logger.info("Synchronized %s SURS building-permit observations (%s–%s)", f"{count:,}", years[0], years[-1])
    return count


# --------------------------------------------------------------------------- orchestration

def sync_construction(connection, output_dir: Path, client: httpx.Client | None = None) -> dict[str, int]:
    """Refresh every construction source; one failing source keeps its stored data."""
    client = client or httpx.Client(timeout=600, follow_redirects=True,
                                    headers={"User-Agent": "real-estate-etl/1.0"})
    counts: dict[str, int] = {}
    steps = {
        "surs_permits": lambda: sync_permits(connection, client),
        "ted_public_works": lambda: sync_public_works(connection, client),
        "gurs_buildings": lambda: load_buildings(connection, download_buildings(client, output_dir)),
    }
    for name, step in steps.items():
        try:
            counts[name] = step()
        except Exception as error:
            connection.rollback()
            logger.warning("Construction source %s failed (%s); keeping stored data.", name, error)
    logger.info("Synchronized construction sources: %s", json.dumps(counts))
    return counts

