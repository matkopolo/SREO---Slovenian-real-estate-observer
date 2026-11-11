"""Building registers joined to ETN sales by the cadastral key; none of them names an owner.

- Register energetskih izkaznic (Ministry of the Environment, Climate and Energy): the public
  register of energy performance certificates, one bulk CSV per month (ZURE Art. 32).
- GURS Evidenca vrednotenja (JGP product 362, per municipality): the official generalised
  value (posplošena vrednost) of every part of building. Only the building, part and value
  tables of each archive are read; the owner, right and person tables stay unopened.
- DRSV Integralna karta razredov poplavne nevarnosti (IKRPN) and the areas with a hydraulic
  study: flood hazard classes as polygons (CC BY 4.0).
"""

from __future__ import annotations

import csv
import io
import logging
import os
import re
import struct
import time
import zipfile
from collections.abc import Iterator
from datetime import UTC, date, datetime
from email.utils import parsedate_to_datetime
from pathlib import Path
from typing import BinaryIO

import httpx
import psycopg
from psycopg import sql

from . import http_client
from .construction import _integer as _gurs_integer
from .construction import _number as _gurs_number
from .construction import iter_dbf
from .settings import API_BASE, RAW_DATA_DIR
from .source_sync import SourceSyncReport, run_isolated_sources

logger = logging.getLogger(__name__)

# --------------------------------------------------------------------------- energy certificates

ENERGY_REGISTER_PAGE = ("https://www.energetika-portal.si/podrocja/energetika/energetske-izkaznice-stavb/"
                        "register-energetskih-izkaznic/")
#: The export's file name changes every month (``ei_javni_register_okt26.csv``), so the link is
#: read from the register page; ``ENERGY_CERTIFICATES_URL`` pins one file instead.
ENERGY_REGISTER_URL = os.getenv("ENERGY_CERTIFICATES_URL")
ENERGY_LINK = re.compile(r'href="(https?://[^"]*/ei_javni_register_[A-Za-z0-9]+\.csv)"')
ENERGY_STATE = re.compile(r"stanje na dan\s*(\d{1,2})\.\s*(\d{1,2})\.\s*(\d{4})")
ENERGY_HEADER = "ID energetske izkaznice"
CERTIFICATE_TYPES = {"računska": "computed", "merjena": "measured"}
CERTIFICATE_COLUMNS = ("certificate_id", "issued_on", "valid_until", "cadastral_code", "building_number",
                       "part_number", "certificate_type", "energy_class", "heating_demand", "delivered_energy",
                       "total_energy", "electricity", "primary_energy", "co2", "conditioned_area", "building_use",
                       "source_date")


def _decimal(raw: str) -> float | None:
    """Slovenian number text: dots group thousands, the comma is the decimal mark."""
    raw = raw.strip().replace(".", "").replace(",", ".")
    if not raw:
        return None
    try:
        return float(raw)
    except ValueError:
        return None


def _integer(raw: str) -> int | None:
    raw = raw.strip()
    return int(raw) if raw.isdigit() else None


def _day(raw: str) -> date | None:
    """``DD.MM.YYYY`` as written in the register."""
    try:
        return datetime.strptime(raw.strip(), "%d.%m.%Y").replace(tzinfo=UTC).date()
    except ValueError:
        return None


def discover_energy_register(client: httpx.Client) -> tuple[str, date | None]:
    """The current export's URL and the "stanje na dan" date on the register page."""
    page = http_client.fetch_text(client, ENERGY_REGISTER_PAGE, "energy-certificate register page")
    state = ENERGY_STATE.search(page)
    as_of = date(int(state.group(3)), int(state.group(2)), int(state.group(1))) if state else None
    if ENERGY_REGISTER_URL:
        return ENERGY_REGISTER_URL, as_of
    link = ENERGY_LINK.search(page)
    if not link:
        raise RuntimeError("The energy-certificate register page lists no CSV export")
    return link.group(1), as_of


def _looks_like_register(path: Path) -> bool:
    with path.open("rb") as handle:
        return ENERGY_HEADER.encode() in handle.read(200)


def download_energy_register(client: httpx.Client, output_dir: Path) -> tuple[Path, date]:
    """Download the current export (about 8 MB) unless it is on disk; drop older months."""
    url, as_of = discover_energy_register(client)
    target = output_dir / url.rsplit("/", 1)[-1]
    if not (target.exists() and _looks_like_register(target)):
        http_client.with_retries(
            lambda: http_client.download_file(client, url, target, validate=_looks_like_register),
            f"energy-certificate register {target.name} download",
        )
        for stale in output_dir.glob("ei_javni_register_*.csv"):
            if stale != target:
                stale.unlink()
    if as_of is None:
        as_of = datetime.fromtimestamp(target.stat().st_mtime, tz=UTC).date()
    return target, as_of


def certificate_rows(path: Path, source_date: date) -> Iterator[tuple]:
    """Stream the pipe-separated register; rows without a cadastral key are skipped."""
    with path.open(encoding="utf-8-sig", newline="") as handle:
        reader = csv.reader(handle, delimiter="|")
        header = [name.strip() for name in next(reader)]
        if header[0] != ENERGY_HEADER:
            raise ValueError(f"{path.name}: unexpected first column {header[0]!r}")
        for raw in reader:
            if len(raw) < 16:
                continue
            row = dict(zip(header, (value.strip() for value in raw), strict=False))
            issued = _day(row["Datum izdelave"])
            cadastral, building = _integer(row["Šifra KO"]), _integer(row["Številka stavbe"])
            kind = CERTIFICATE_TYPES.get(row["Tip izkaznice"].lower())
            if not row[ENERGY_HEADER] or issued is None or cadastral is None or building is None or kind is None:
                continue
            yield (
                row[ENERGY_HEADER], issued, _day(row["Velja do"]), cadastral, building,
                _integer(row["Številka dela stavbe"]) or 0, kind,
                row["Energijski razred"] or None, _decimal(row["Potrebna toplota za ogrevanje"]),
                _decimal(row["Dovedena energija za delovanje stavbe"]), _decimal(row["Celotna energija"]),
                _decimal(row["Dovedena električna energija"]), _decimal(row["Primarna energija"]),
                _decimal(row["Emisije CO2"]), _decimal(row["Kondicionirana površina stavbe"]),
                row["EPBD"] or None, source_date,
            )


def load_energy_certificates(connection: psycopg.Connection, path: Path, source_date: date) -> int:
    """Replace the register atomically; readers keep the previous rows until commit."""
    current = connection.execute("SELECT max(source_date) FROM analytics.energy_certificates").fetchone()[0]
    if current == source_date:
        logger.info("Energy-certificate register of %s already loaded", source_date)
        return 0
    connection.commit()
    started = time.monotonic()
    with connection.transaction(), connection.cursor() as cursor:
        cursor.execute("CREATE TEMP TABLE staging_certificates (LIKE analytics.energy_certificates) ON COMMIT DROP")
        statement = sql.SQL("COPY staging_certificates ({}) FROM STDIN").format(
            sql.SQL(",").join(map(sql.Identifier, CERTIFICATE_COLUMNS)))
        count = 0
        with cursor.copy(statement) as copy:
            for row in certificate_rows(path, source_date):
                copy.write_row(row)
                count += 1
        if count == 0:
            raise ValueError(f"{path.name} holds no certificates")
        stored = cursor.execute("SELECT count(*) FROM analytics.energy_certificates").fetchone()[0]
        if count < 0.8 * stored:  # a truncated export must not replace a fuller register
            raise ValueError(f"{path.name} holds {count:,} certificates, far fewer than the {stored:,} stored")
        cursor.execute("DELETE FROM analytics.energy_certificates")
        cursor.execute(
            """INSERT INTO analytics.energy_certificates
               SELECT DISTINCT ON (certificate_id, cadastral_code, building_number, part_number) *
               FROM staging_certificates
               ORDER BY certificate_id, cadastral_code, building_number, part_number, issued_on DESC"""
        )
        loaded = cursor.rowcount
    logger.info("Loaded %s energy certificates (register of %s) in %.0fs", f"{loaded:,}", source_date,
                time.monotonic() - started)
    return loaded


def sync_energy_certificates(connection: psycopg.Connection, client: httpx.Client, output_dir: Path) -> int:
    path, as_of = download_energy_register(client, output_dir)
    return load_energy_certificates(connection, path, as_of)


# --------------------------------------------------------------------------- generalised values

JGP_VALUATION = f"{API_BASE}/display-views/groups/363/composite-products/362"
VALUE_COLUMNS = ("part_eid", "building_eid", "cadastral_code", "building_number", "part_number", "model",
                 "value_level", "value", "floor", "position", "municipality_code", "source_date")
#: The only members of a valuation archive that are opened.
VALUATION_MEMBERS = {
    "buildings": re.compile(r"EVIDENCA_VREDNOTENJA_stavba_\d{8}\.csv$"),
    "parts": re.compile(r"EVIDENCA_VREDNOTENJA_del_stavbe_\d{8}\.csv$"),
    "units": re.compile(r"EVIDENCA_VREDNOTENJA_del_stavbe_enota_\d{8}\.csv$"),
    "models": re.compile(r"EVIDENCA_VREDNOTENJA_SIF_MODEL_\d{8}\.csv$"),
    "positions": re.compile(r"EVIDENCA_VREDNOTENJA_SIF_LEGA_\d{8}\.csv$"),
}
#: Member names that hold personal data; a match is a bug in the patterns above, never opened.
OWNER_MEMBER = re.compile(r"imetnik|lastni|oseb|pravic", re.IGNORECASE)
VALUATION_CODEBOOKS = {"models": ("valuation_model", "ID_MODEL", "NAZIV"),
                       "positions": ("position", "ID_LEGA", "NAZIV")}
#: Share of municipalities that may fail before the whole source counts as failed.
VALUATION_FAILURE_SHARE = 0.1


def valuation_source_date(name: str) -> date:
    match = re.search(r"_(\d{8})\.zip$", name)
    if not match:
        raise ValueError(f"No export date in {name}")
    value = match.group(1)
    return date(int(value[:4]), int(value[4:6]), int(value[6:]))


def municipality_codes(connection: psycopg.Connection) -> list[int]:
    return [row[0] for row in connection.execute("SELECT code FROM municipalities ORDER BY code")]


def download_valuation(
    client: httpx.Client, output_dir: Path, municipality: int, loaded: date | None = None,
) -> Path | None:
    """Download one municipality's valuation export (1 to 60 MB) unless it is on disk; drop older ones.

    Returns None when GURS's current export carries the date already loaded for the municipality,
    so a refresh with nothing new downloads nothing.
    """
    query = f"filterParam=OBCINE&filterValue={municipality}"
    result = http_client.fetch_json(client, f"{JGP_VALUATION}/result?{query}", f"GURS valuation {municipality} status")
    if result.get("statusText") != "OK" or not result.get("file"):
        raise RuntimeError(f"GURS valuation export for municipality {municipality} not ready: "
                           f"{result.get('statusText')}")
    if loaded is not None and valuation_source_date(result["file"]["name"]) == loaded:
        return None
    target = output_dir / "valuation" / result["file"]["name"]
    if target.exists() and zipfile.is_zipfile(target):
        return target
    link = http_client.fetch_json(client, f"{JGP_VALUATION}/file?{query}", f"GURS valuation {municipality} link")
    http_client.with_retries(
        lambda: http_client.download_file(client, link["url"], target, chunk_bytes=4 << 20),
        f"GURS valuation {target.name} download",
    )
    for stale in target.parent.glob(f"EV_{municipality}_*.zip"):
        if stale != target:
            stale.unlink()
    return target


def _member(archive: zipfile.ZipFile, key: str) -> str:
    pattern = VALUATION_MEMBERS[key]
    try:
        member = next(n for n in archive.namelist() if pattern.search(n))
    except StopIteration:
        raise ValueError(f"{archive.filename}: no {key} table") from None
    if OWNER_MEMBER.search(member):
        raise ValueError(f"{archive.filename}: refusing to open {member}")
    return member


def _table(archive: zipfile.ZipFile, key: str) -> csv.DictReader:
    return csv.DictReader(io.StringIO(archive.read(_member(archive, key)).decode("utf-8-sig")))


def valuation_rows(archive: zipfile.ZipFile, municipality: int, source_date: date) -> Iterator[tuple]:
    """Join the value units to their parts and buildings (all three tables of one municipality)."""
    buildings = {}
    for row in _table(archive, "buildings"):
        cadastral, number = _gurs_integer(row["KO_SIFKO"]), _gurs_integer(row["STEV_ST"])
        if cadastral is not None and number is not None:
            buildings[row["EID_STAVBA"]] = (cadastral, number)
    parts = {}
    for row in _table(archive, "parts"):
        number = _gurs_integer(row["STEV_DST"])
        if number is not None and row["EID_STAVBA"] in buildings:
            # Floors can be negative (cellar storage, underground parking).
            parts[row["EID_DEL_STAVBE"]] = (row["EID_STAVBA"], number, _gurs_integer(row["ST_NADSTROPJA"]),
                                            _gurs_integer(row["ID_LEGA"]))
    for row in _table(archive, "units"):
        part = parts.get(row["EID_DEL_STAVBE"])
        if part is None or not row["ID_MODEL"]:
            continue
        building_eid, number, floor, position = part
        cadastral, building_number = buildings[building_eid]
        value = _gurs_number(row["POSPLOSENA_VREDNOST"])  # a plain number with a dot decimal, as in every GURS CSV
        yield (row["EID_DEL_STAVBE"], building_eid, cadastral, building_number, number, row["ID_MODEL"],
               row["RAVEN"] or None, None if value is None else round(value), floor, position, municipality,
               source_date)


def valuation_codebook_rows(archive: zipfile.ZipFile) -> list[tuple[str, str, str]]:
    rows = []
    for key, (codebook, code, label) in VALUATION_CODEBOOKS.items():
        rows.extend((codebook, row[code].strip(), row[label].strip()) for row in _table(archive, key)
                    if row.get(code) and row.get(label))
    return rows


def loaded_valuation_date(connection: psycopg.Connection, municipality: int) -> date | None:
    return connection.execute(
        "SELECT max(source_date) FROM analytics.generalised_values WHERE municipality_code = %s", (municipality,),
    ).fetchone()[0]


def load_valuation(connection: psycopg.Connection, path: Path, municipality: int) -> int:
    """Replace one municipality's values; 0 when its export date is already loaded."""
    snapshot = valuation_source_date(path.name)
    if loaded_valuation_date(connection, municipality) == snapshot:
        return 0
    connection.commit()  # the swap below must be its own top-level transaction, not a savepoint
    with zipfile.ZipFile(path) as archive, connection.transaction(), connection.cursor() as cursor:
        cursor.execute("CREATE TEMP TABLE staging_values (LIKE analytics.generalised_values) ON COMMIT DROP")
        statement = sql.SQL("COPY staging_values ({}) FROM STDIN").format(
            sql.SQL(",").join(map(sql.Identifier, VALUE_COLUMNS)))
        with cursor.copy(statement) as copy:
            for row in valuation_rows(archive, municipality, snapshot):
                copy.write_row(row)
        cursor.execute("DELETE FROM analytics.generalised_values WHERE municipality_code = %s", (municipality,))
        cursor.execute(
            """INSERT INTO analytics.generalised_values
               SELECT DISTINCT ON (part_eid) * FROM staging_values ORDER BY part_eid
               ON CONFLICT (part_eid) DO UPDATE SET building_eid = excluded.building_eid,
                 cadastral_code = excluded.cadastral_code, building_number = excluded.building_number,
                 part_number = excluded.part_number, model = excluded.model, value_level = excluded.value_level,
                 value = excluded.value, floor = excluded.floor, position = excluded.position,
                 municipality_code = excluded.municipality_code, source_date = excluded.source_date"""
        )
        loaded = cursor.rowcount
        for codebook, code, label in valuation_codebook_rows(archive):
            cursor.execute(
                """INSERT INTO analytics.register_codebooks (codebook, code, label) VALUES (%s, %s, %s)
                   ON CONFLICT (codebook, code) DO UPDATE SET label = excluded.label""",
                (codebook, code, label))
    return loaded


def sync_valuation(connection: psycopg.Connection, client: httpx.Client, output_dir: Path) -> int:
    """Refresh every municipality; each one commits on its own, so a failure keeps the rest."""
    started = time.monotonic()
    codes = municipality_codes(connection)
    connection.commit()
    loaded, failures = 0, {}
    for municipality in codes:
        try:
            current = loaded_valuation_date(connection, municipality)
            path = download_valuation(client, output_dir, municipality, current)
            if path is not None:
                loaded += load_valuation(connection, path, municipality)
            connection.commit()
        except Exception as error:  # noqa: BLE001 - one municipality must not stop the others
            connection.rollback()
            failures[municipality] = f"{type(error).__name__}: {error}"[:200]
            logger.warning("GURS valuation for municipality %s failed; keeping stored values: %s",
                           municipality, failures[municipality])
    logger.info("Loaded %s generalised values for %s municipalities in %.0fs", f"{loaded:,}",
                len(codes) - len(failures), time.monotonic() - started)
    if len(failures) > VALUATION_FAILURE_SHARE * len(codes):
        raise RuntimeError(f"{len(failures)} of {len(codes)} municipality exports failed, e.g. "
                           + "; ".join(f"{code}: {message}" for code, message in list(failures.items())[:3]))
    return loaded


# --------------------------------------------------------------------------- flood hazard

FLOOD_BASE = os.getenv("DRSV_FLOOD_BASE_URL", "http://www.statika.evode.gov.si/fileadmin/vodkat/")
#: IKRPN classes: Pp preostala (Q100–Q500), Pm majhna (< 0.5 m at Q100), Ps srednja, Pv velika.
FLOOD_LAYERS = {"Pp": "DRSV_IKRPN_PP.zip", "Pm": "DRSV_IKRPN_PM.zip", "Ps": "DRSV_IKRPN_PS.zip",
                "Pv": "DRSV_IKRPN_PV.zip"}
FLOOD_STUDY_AREAS = "DRSV_OPKP_OBM_HHM.zip"
SHAPE_NULL, SHAPE_POLYGON, SHAPE_POLYGON_Z, SHAPE_POLYGON_M = 0, 5, 15, 25
FLOOD_COLUMNS = ("hazard_class", "source_id", "valid_from", "rings", "source_date")
#: A dissolved class polygon made drawable: opened by 2 m and closed by 3 m (mitred, so corners stay),
#: simplified to 1.5 m, and kept to polygons.
DRAWABLE = ("ST_Multi(ST_CollectionExtract(ST_MakeValid(ST_SimplifyPreserveTopology(ST_Buffer(ST_Buffer("
            "ST_Buffer(ST_Buffer(GEOM, -2, 'join=mitre'), 2, 'join=mitre'), 3, 'join=mitre'), -3, 'join=mitre'),"
            " 1.5)), 3))")


def dbf_date(stream: BinaryIO) -> date:
    """The last-update date in a dBASE header (year since 1900, month, day)."""
    header = stream.read(4)
    return date(1900 + header[1], header[2], header[3])


def iter_polygons(stream: BinaryIO) -> Iterator[str | None]:
    """Stream Shapefile polygon records as WKT MULTILINESTRING of their rings; null shapes yield None.

    Ring orientation decides outer rings and holes in a Shapefile; PostGIS rebuilds the areas
    from the closed rings (ST_BuildArea), so no orientation logic lives here.
    """
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
        if kind == SHAPE_NULL:
            yield None
            continue
        if kind not in (SHAPE_POLYGON, SHAPE_POLYGON_Z, SHAPE_POLYGON_M):
            raise ValueError(f"Shapefile record {number} is not a polygon (type {kind})")
        parts, points = struct.unpack("<ii", content[36:44])
        offsets = struct.unpack(f"<{parts}i", content[44:44 + 4 * parts])
        start = 44 + 4 * parts
        coordinates = struct.unpack(f"<{2 * points}d", content[start:start + 16 * points])
        rings = []
        for index, first in enumerate(offsets):
            last = offsets[index + 1] if index + 1 < parts else points
            ring = ", ".join(f"{coordinates[2 * i]} {coordinates[2 * i + 1]}" for i in range(first, last))
            if last - first >= 4:
                rings.append(f"({ring})")
        yield f"MULTILINESTRING({', '.join(rings)})" if rings else None


def _dbf_day(raw: str) -> str | None:
    """A dBASE ``YYYYMMDD`` field as ISO text; empty and placeholder dates (``00000000``) give None."""
    raw = raw.strip()
    if len(raw) != 8 or not raw.isdigit():
        return None
    try:
        return date(int(raw[:4]), int(raw[4:6]), int(raw[6:])).isoformat()
    except ValueError:
        return None


def flood_rows(path: Path, hazard_class: str | None) -> Iterator[tuple]:
    """Pair the shapefile's attributes with its polygons record by record (the class is per file)."""
    with zipfile.ZipFile(path) as archive:
        table = next(n for n in archive.namelist() if n.lower().endswith(".dbf"))
        shp = next(n for n in archive.namelist() if n.lower().endswith(".shp"))
        with archive.open(table) as probe:
            source_date = dbf_date(probe)
        with archive.open(table) as dbf, archive.open(shp) as shapes:
            for attributes, rings in zip(iter_dbf(dbf), iter_polygons(shapes), strict=True):
                if attributes is None or rings is None:
                    continue
                identifier = next((value for name, value in attributes.items() if name.endswith("_ID")), None)
                yield (hazard_class, identifier or attributes.get("OBMHHM_IME") or None,
                       _dbf_day(attributes.get("DATP_ZAC", "")), rings, source_date)


def download_flood_layer(client: httpx.Client, output_dir: Path, name: str) -> Path:
    """Download a DRSV archive unless the copy on disk is as new as the server's (HTTP Last-Modified)."""
    target = output_dir / "floods" / name
    url = FLOOD_BASE + name
    if target.exists() and zipfile.is_zipfile(target):
        try:
            head = client.head(url)
            head.raise_for_status()
            modified = head.headers.get("last-modified")
            if modified and parsedate_to_datetime(modified).timestamp() <= target.stat().st_mtime:
                return target
        except httpx.HTTPError as error:
            logger.warning("Could not check %s for a newer version (%s); using the copy on disk", name, error)
            return target
    http_client.with_retries(lambda: http_client.download_file(client, url, target, chunk_bytes=4 << 20),
                             f"DRSV {name} download")
    return target


def flood_archive_date(path: Path) -> date:
    with zipfile.ZipFile(path) as archive:
        member = next(n for n in archive.namelist() if n.lower().endswith(".dbf"))
        with archive.open(member) as dbf:
            return dbf_date(dbf)


def load_floods(connection: psycopg.Connection, layers: dict[str, Path], study_areas: Path) -> int:
    """Replace the flood layers atomically when any of the archives is newer than the stored ones."""
    snapshot = max(flood_archive_date(path) for path in [*layers.values(), study_areas])
    current = connection.execute("SELECT max(source_date) FROM analytics.flood_hazard_zones").fetchone()[0]
    if current == snapshot:
        logger.info("DRSV flood layers of %s already loaded", snapshot)
        return 0
    connection.commit()
    started = time.monotonic()
    build = ("ST_Multi(ST_CollectionExtract(ST_MakeValid(ST_BuildArea(ST_GeomFromText(rings, 3794))), 3))")
    with connection.transaction(), connection.cursor() as cursor:
        cursor.execute("CREATE TEMP TABLE staging_floods (hazard_class text, source_id text, valid_from date, "
                       "rings text, source_date date) ON COMMIT DROP")
        statement = sql.SQL("COPY staging_floods ({}) FROM STDIN").format(
            sql.SQL(",").join(map(sql.Identifier, FLOOD_COLUMNS)))
        with cursor.copy(statement) as copy:
            for hazard_class, path in layers.items():
                for row in flood_rows(path, hazard_class):
                    copy.write_row(row)
            for row in flood_rows(study_areas, None):
                copy.write_row(row)
        cursor.execute("DELETE FROM analytics.flood_hazard_zones")
        cursor.execute("DELETE FROM analytics.flood_hazard_areas")
        cursor.execute("DELETE FROM analytics.flood_study_areas")
        cursor.execute(
            f"""INSERT INTO analytics.flood_hazard_zones (hazard_class, source_id, valid_from, geom, source_date)
                SELECT hazard_class, source_id, valid_from, geom, %s FROM (
                  SELECT hazard_class, source_id, valid_from, {build} AS geom
                  FROM staging_floods WHERE hazard_class IS NOT NULL) zones
                WHERE geom IS NOT NULL AND NOT ST_IsEmpty(geom)""", (snapshot,))  # noqa: S608 - SQL expression, no input
        zones = cursor.rowcount
        # The source polygons are raster-like fragments (median 4 m²): for drawing they are dissolved per class
        # within 2 km tiles, cleaned of slivers and pinholes narrower than about 4 m (an opening by 2 m, then a
        # closing by 3 m) and simplified to 1.5 m, which keeps the map's answers small.
        cursor.execute(
            f"""INSERT INTO analytics.flood_hazard_areas (hazard_class, geom, source_date)
                SELECT hazard_class, geom, %s FROM (
                  SELECT hazard_class, {DRAWABLE.replace("GEOM", "ST_Union(geom)")} AS geom
                  FROM analytics.flood_hazard_zones
                  GROUP BY hazard_class, ST_SnapToGrid(ST_PointOnSurface(geom), 2000)) tiles
                WHERE geom IS NOT NULL AND NOT ST_IsEmpty(geom)""", (snapshot,))  # noqa: S608 - SQL expression, no input
        areas_drawn = cursor.rowcount
        # The studied areas are drawn only as outlines: 5 m simplification loses nothing visible.
        cursor.execute(
            f"""INSERT INTO analytics.flood_study_areas (name, valid_from, geom, source_date)
                SELECT source_id, valid_from, geom, %s FROM (
                  SELECT source_id, valid_from, ST_Multi(ST_CollectionExtract(ST_MakeValid(
                           ST_SimplifyPreserveTopology({build}, 5)), 3)) AS geom
                  FROM staging_floods WHERE hazard_class IS NULL) areas
                WHERE geom IS NOT NULL AND NOT ST_IsEmpty(geom)""", (snapshot,))  # noqa: S608
        areas = cursor.rowcount
    logger.info("Loaded %s flood hazard polygons (%s dissolved for drawing) and %s studied areas (DRSV %s) in %.0fs",
                f"{zones:,}", f"{areas_drawn:,}", areas, snapshot, time.monotonic() - started)
    return zones


def sync_floods(connection: psycopg.Connection, client: httpx.Client, output_dir: Path) -> int:
    layers = {hazard_class: download_flood_layer(client, output_dir, name)
              for hazard_class, name in FLOOD_LAYERS.items()}
    return load_floods(connection, layers, download_flood_layer(client, output_dir, FLOOD_STUDY_AREAS))


# --------------------------------------------------------------------------- orchestration

def sync_registers(
    connection: psycopg.Connection,
    output_dir: Path = RAW_DATA_DIR,
    client: httpx.Client | None = None,
) -> SourceSyncReport:
    """Refresh every building register; one failing register keeps its stored data."""
    if client is None:
        with http_client.create_client() as owned:
            return sync_registers(connection, output_dir, owned)
    return run_isolated_sources(
        connection,
        {
            "energy_certificates": lambda: sync_energy_certificates(connection, client, output_dir),
            "gurs_valuation": lambda: sync_valuation(connection, client, output_dir),
            "drsv_floods": lambda: sync_floods(connection, client, output_dir),
        },
        group="building registers",
    )
