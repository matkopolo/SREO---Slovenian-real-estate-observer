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
import re
import time
import zipfile
from collections.abc import Iterator
from datetime import UTC, date, datetime
from email.utils import parsedate_to_datetime
from pathlib import Path
from typing import Any

import httpx
import psycopg
from psycopg import sql

from . import http_client
from .database import scalar
from .parsing import (
    dbf_day,
    digits_integer,
    gurs_integer,
    gurs_number,
    register_day,
    safe_file_name,
    slovene_decimal,
    snapshot_date,
)
from .settings import API_BASE, drsv_flood_base_url, energy_certificates_url, raw_data_dir
from .shapefile import dbf_date, iter_dbf, iter_polygons, member_named, read_member
from .source_sync import SourceSyncReport, run_isolated_sources

logger = logging.getLogger(__name__)

#: Download chunk for the multi-megabyte register and valuation archives.
LARGE_CHUNK_BYTES = 4 << 20

# --------------------------------------------------------------------------- energy certificates

ENERGY_REGISTER_PAGE = ("https://www.energetika-portal.si/podrocja/energetika/energetske-izkaznice-stavb/"
                        "register-energetskih-izkaznic/")
#: The export's file name changes every month (``ei_javni_register_okt26.csv``), so the link is
#: read from the register page; ``ENERGY_CERTIFICATES_URL`` pins one file instead.
ENERGY_LINK = re.compile(r'href="(https?://[^"]*/ei_javni_register_[A-Za-z0-9]+\.csv)"')
ENERGY_FILE_NAME = re.compile(r"ei_javni_register_[A-Za-z0-9]+\.csv")
ENERGY_STATE = re.compile(r"stanje na dan\s*(\d{1,2})\.\s*(\d{1,2})\.\s*(\d{4})")
ENERGY_HEADER = "ID energetske izkaznice"
#: Bytes of the file that must contain the header for it to count as the register.
ENERGY_PROBE_BYTES = 200
#: Columns a register row needs before it is read (the identity, dates, key and energy values).
ENERGY_MIN_COLUMNS = 16
#: A register with fewer certificates than this share of the stored ones is a truncated export.
ENERGY_MIN_RETAINED_SHARE = 0.8
CERTIFICATE_TYPES = {"računska": "computed", "merjena": "measured"}
CERTIFICATE_COLUMNS = ("certificate_id", "issued_on", "valid_until", "cadastral_code", "building_number",
                       "part_number", "certificate_type", "energy_class", "heating_demand", "delivered_energy",
                       "total_energy", "electricity", "primary_energy", "co2", "conditioned_area", "building_use",
                       "source_date")


def discover_energy_register(client: httpx.Client) -> tuple[str, date | None]:
    """The current export's URL and the "stanje na dan" date on the register page.

    Raises:
        RuntimeError: When the page lists no CSV export and no URL is pinned.
    """
    page = http_client.fetch_text(client, ENERGY_REGISTER_PAGE, "energy-certificate register page")
    state = ENERGY_STATE.search(page)
    as_of = date(int(state.group(3)), int(state.group(2)), int(state.group(1))) if state else None
    pinned = energy_certificates_url()
    if pinned:
        return pinned, as_of
    link = ENERGY_LINK.search(page)
    if not link:
        raise RuntimeError("The energy-certificate register page lists no CSV export")
    return link.group(1), as_of


def _looks_like_register(path: Path) -> bool:
    with path.open("rb") as handle:
        return ENERGY_HEADER.encode() in handle.read(ENERGY_PROBE_BYTES)


def download_energy_register(client: httpx.Client, output_dir: Path) -> tuple[Path, date]:
    """Download the current export (about 8 MB) unless it is on disk; drop older months.

    Returns:
        The local file and the register's "as of" date (the file's modification time
        when the page does not state one).
    """
    url, as_of = discover_energy_register(client)
    target = output_dir / safe_file_name(url.rsplit("/", 1)[-1], ENERGY_FILE_NAME)
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


def certificate_rows(path: Path, source_date: date) -> Iterator[tuple[Any, ...]]:
    """Stream the pipe-separated register; rows without a cadastral key are skipped.

    Raises:
        ValueError: When the first column is not the certificate id (another layout).
    """
    with path.open(encoding="utf-8-sig", newline="") as handle:
        reader = csv.reader(handle, delimiter="|")
        header = [name.strip() for name in next(reader)]
        if header[0] != ENERGY_HEADER:
            raise ValueError(f"{path.name}: unexpected first column {header[0]!r}")
        for raw in reader:
            if len(raw) < ENERGY_MIN_COLUMNS:
                continue
            row = dict(zip(header, (value.strip() for value in raw), strict=False))
            issued = register_day(row["Datum izdelave"])
            cadastral, building = digits_integer(row["Šifra KO"]), digits_integer(row["Številka stavbe"])
            kind = CERTIFICATE_TYPES.get(row["Tip izkaznice"].lower())
            if not row[ENERGY_HEADER] or issued is None or cadastral is None or building is None or kind is None:
                continue
            yield (
                row[ENERGY_HEADER], issued, register_day(row["Velja do"]), cadastral, building,
                digits_integer(row["Številka dela stavbe"]) or 0, kind,
                row["Energijski razred"] or None, slovene_decimal(row["Potrebna toplota za ogrevanje"]),
                slovene_decimal(row["Dovedena energija za delovanje stavbe"]), slovene_decimal(row["Celotna energija"]),
                slovene_decimal(row["Dovedena električna energija"]), slovene_decimal(row["Primarna energija"]),
                slovene_decimal(row["Emisije CO2"]), slovene_decimal(row["Kondicionirana površina stavbe"]),
                row["EPBD"] or None, source_date,
            )


def load_energy_certificates(connection: psycopg.Connection[Any], path: Path, source_date: date) -> int:
    """Replace the register atomically; readers keep the previous rows until commit.

    Returns:
        The number of certificates loaded, or 0 when this register date is already stored.

    Raises:
        ValueError: When the export is empty or holds far fewer certificates than the stored register.
    """
    current = scalar(connection, "SELECT max(source_date) FROM analytics.energy_certificates")
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
        stored = scalar(connection, "SELECT count(*) FROM analytics.energy_certificates")
        if count < ENERGY_MIN_RETAINED_SHARE * stored:  # a truncated export must not replace a fuller register
            raise ValueError(f"{path.name} holds {count:,} certificates, far fewer than the {stored:,} stored")
        cursor.execute("DELETE FROM analytics.energy_certificates")
        cursor.execute(
            """INSERT INTO analytics.energy_certificates
               SELECT DISTINCT ON (certificate_id, cadastral_code, building_number, part_number) *
               FROM staging_certificates
               ORDER BY certificate_id, cadastral_code, building_number, part_number,
                        issued_on DESC, valid_until DESC NULLS LAST"""
        )
        loaded = cursor.rowcount
    logger.info("Loaded %s energy certificates (register of %s) in %.0fs", f"{loaded:,}", source_date,
                time.monotonic() - started)
    return loaded


def sync_energy_certificates(connection: psycopg.Connection[Any], client: httpx.Client, output_dir: Path) -> int:
    """Download the current register export and load it; returns the certificates loaded."""
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
#: The export name GURS publishes per municipality (``EV_108_EVIDENCA_VREDNOTENJA_20261107.zip``).
VALUATION_NAME = re.compile(r"EV_\d+_EVIDENCA_VREDNOTENJA_\d{8}\.zip")
VALUATION_CODEBOOKS = {"models": ("valuation_model", "ID_MODEL", "NAZIV"),
                       "positions": ("position", "ID_LEGA", "NAZIV")}
#: Share of municipalities that may fail before the whole source counts as failed.
VALUATION_FAILURE_SHARE = 0.1
#: Failed municipalities quoted in the error message.
VALUATION_FAILURES_QUOTED = 3


def valuation_source_date(name: str) -> date:
    """The ``_YYYYMMDD`` export date in a valuation archive name (see :func:`parsing.snapshot_date`)."""
    return snapshot_date(name)


def municipality_codes(connection: psycopg.Connection[Any]) -> list[int]:
    """Every municipality code in ascending order."""
    return [row[0] for row in connection.execute("SELECT code FROM municipalities ORDER BY code")]


def download_valuation(
    client: httpx.Client, output_dir: Path, municipality: int, loaded: date | None = None,
) -> Path | None:
    """Download one municipality's valuation export (1 to 60 MB) unless it is on disk; drop older ones.

    Returns:
        The local archive, or None when GURS's current export carries the date already loaded
        for the municipality, so a refresh with nothing new downloads nothing.

    Raises:
        RuntimeError: When GURS reports the export as not ready.
        ValueError: When GURS publishes a file name outside the expected shape.
    """
    query = f"filterParam=OBCINE&filterValue={municipality}"
    result = http_client.fetch_json(client, f"{JGP_VALUATION}/result?{query}", f"GURS valuation {municipality} status")
    if result.get("statusText") != "OK" or not result.get("file"):
        raise RuntimeError(f"GURS valuation export for municipality {municipality} not ready: "
                           f"{result.get('statusText')}")
    name = safe_file_name(str(result["file"]["name"]), VALUATION_NAME)
    if loaded is not None and valuation_source_date(name) == loaded:
        return None
    target = output_dir / "valuation" / name
    if target.exists() and zipfile.is_zipfile(target):
        return target

    def download() -> Path:
        # Each attempt asks for a fresh signed link: the previous one may have expired.
        link = http_client.fetch_json(client, f"{JGP_VALUATION}/file?{query}", f"GURS valuation {municipality} link")
        return http_client.download_file(client, link["url"], target, chunk_bytes=LARGE_CHUNK_BYTES)

    http_client.with_retries(download, f"GURS valuation {target.name} download")
    for stale in target.parent.glob(f"EV_{municipality}_*.zip"):
        if stale != target:
            stale.unlink()
    return target


def _member(archive: zipfile.ZipFile, key: str) -> str:
    pattern = VALUATION_MEMBERS[key]
    member = next((n for n in archive.namelist() if pattern.search(n)), None)
    if member is None:
        raise ValueError(f"{archive.filename}: no {key} table")
    if OWNER_MEMBER.search(member):
        raise ValueError(f"{archive.filename}: refusing to open {member}")
    return member


def _table(archive: zipfile.ZipFile, key: str) -> csv.DictReader[str]:
    return csv.DictReader(io.StringIO(read_member(archive, _member(archive, key)).decode("utf-8-sig")))


def valuation_rows(archive: zipfile.ZipFile, municipality: int, source_date: date) -> Iterator[tuple[Any, ...]]:
    """Join the value units to their parts and buildings (all three tables of one municipality)."""
    buildings: dict[str, tuple[int, int]] = {}
    for row in _table(archive, "buildings"):
        cadastral, number = gurs_integer(row["KO_SIFKO"]), gurs_integer(row["STEV_ST"])
        if cadastral is not None and number is not None:
            buildings[row["EID_STAVBA"]] = (cadastral, number)
    parts: dict[str, tuple[str, int, int | None, int | None]] = {}
    for row in _table(archive, "parts"):
        number = gurs_integer(row["STEV_DST"])
        if number is not None and row["EID_STAVBA"] in buildings:
            # Floors can be negative (cellar storage, underground parking).
            parts[row["EID_DEL_STAVBE"]] = (row["EID_STAVBA"], number, gurs_integer(row["ST_NADSTROPJA"]),
                                            gurs_integer(row["ID_LEGA"]))
    for row in _table(archive, "units"):
        part = parts.get(row["EID_DEL_STAVBE"])
        if part is None or not row["ID_MODEL"]:
            continue
        building_eid, number, floor, position = part
        cadastral, building_number = buildings[building_eid]
        value = gurs_number(row["POSPLOSENA_VREDNOST"])  # a plain number with a dot decimal, as in every GURS CSV
        yield (row["EID_DEL_STAVBE"], building_eid, cadastral, building_number, number, row["ID_MODEL"],
               row["RAVEN"] or None, None if value is None else round(value), floor, position, municipality,
               source_date)


def valuation_codebook_rows(archive: zipfile.ZipFile) -> list[tuple[str, str, str]]:
    """``(codebook, code, label)`` rows of the model and position codebooks in the archive."""
    rows: list[tuple[str, str, str]] = []
    for key, (codebook, code, label) in VALUATION_CODEBOOKS.items():
        rows.extend((codebook, row[code].strip(), row[label].strip()) for row in _table(archive, key)
                    if row.get(code) and row.get(label))
    return rows


def loaded_valuation_date(connection: psycopg.Connection[Any], municipality: int) -> date | None:
    """The export date stored for ``municipality``, or None before its first load."""
    return scalar(
        connection, "SELECT max(source_date) FROM analytics.generalised_values WHERE municipality_code = %s",
        (municipality,),
    )


def load_valuation(connection: psycopg.Connection[Any], path: Path, municipality: int) -> int:
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
        # One part can appear with several units; keep the highest valued one, then the lowest model code.
        cursor.execute(
            """INSERT INTO analytics.generalised_values
               SELECT DISTINCT ON (part_eid) * FROM staging_values
               ORDER BY part_eid, value DESC NULLS LAST, model, value_level
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


def sync_valuation(connection: psycopg.Connection[Any], client: httpx.Client, output_dir: Path) -> int:
    """Refresh every municipality; each one commits on its own, so a failure keeps the rest.

    Raises:
        RuntimeError: When more than :data:`VALUATION_FAILURE_SHARE` of the municipalities failed.
    """
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
        quoted = list(failures.items())[:VALUATION_FAILURES_QUOTED]
        raise RuntimeError(f"{len(failures)} of {len(codes)} municipality exports failed, e.g. "
                           + "; ".join(f"{code}: {message}" for code, message in quoted))
    return loaded


# --------------------------------------------------------------------------- flood hazard

#: IKRPN classes: Pp preostala (Q100–Q500), Pm majhna (< 0.5 m at Q100), Ps srednja, Pv velika.
FLOOD_LAYERS = {"Pp": "DRSV_IKRPN_PP.zip", "Pm": "DRSV_IKRPN_PM.zip", "Ps": "DRSV_IKRPN_PS.zip",
                "Pv": "DRSV_IKRPN_PV.zip"}
FLOOD_STUDY_AREAS = "DRSV_OPKP_OBM_HHM.zip"
FLOOD_COLUMNS = ("hazard_class", "source_id", "valid_from", "rings", "source_date")
#: Dissolved class polygons are built per tile of this size (metres, D96/TM) to keep each one small.
FLOOD_TILE_METRES = 2000
#: Studied areas are drawn only as outlines: this simplification (metres) loses nothing visible.
STUDY_AREA_SIMPLIFY_METRES = 5
#: A dissolved class polygon made drawable: opened by 2 m and closed by 3 m (mitred, so corners stay),
#: simplified to 1.5 m, and kept to polygons.
DRAWABLE = ("ST_Multi(ST_CollectionExtract(ST_MakeValid(ST_SimplifyPreserveTopology(ST_Buffer(ST_Buffer("
            "ST_Buffer(ST_Buffer(GEOM, -2, 'join=mitre'), 2, 'join=mitre'), 3, 'join=mitre'), -3, 'join=mitre'),"
            " 1.5)), 3))")
#: Closed rings become areas in PostGIS; invalid results are repaired and reduced to polygons.
BUILD_AREA = "ST_Multi(ST_CollectionExtract(ST_MakeValid(ST_BuildArea(ST_GeomFromText(rings, 3794))), 3))"


def flood_rows(path: Path, hazard_class: str | None) -> Iterator[tuple[Any, ...]]:
    """Pair the shapefile's attributes with its polygons record by record (the class is per file).

    Raises:
        ValueError: When the archive lacks its tables or they hold different numbers of records.
    """
    with zipfile.ZipFile(path) as archive:
        table = member_named(archive, ".dbf", label="attribute table")
        shp = member_named(archive, ".shp", label="shape file")
        with archive.open(table) as probe:
            source_date = dbf_date(probe, label=f"{path.name}/{table}")
        with archive.open(table) as dbf, archive.open(shp) as shapes:
            try:
                records = zip(
                    iter_dbf(dbf, label=f"{path.name}/{table}"),
                    iter_polygons(shapes, label=f"{path.name}/{shp}"),
                    strict=True,
                )
                for attributes, rings in records:
                    if attributes is None or rings is None:
                        continue
                    identifier = next((value for name, value in attributes.items() if name.endswith("_ID")), None)
                    yield (hazard_class, identifier or attributes.get("OBMHHM_IME") or None,
                           dbf_day(attributes.get("DATP_ZAC", "")), rings, source_date)
            except ValueError as error:
                raise ValueError(f"{path.name}: {error}") from error


def download_flood_layer(client: httpx.Client, output_dir: Path, name: str) -> Path:
    """Download a DRSV archive unless the copy on disk is as new as the server's (HTTP Last-Modified)."""
    target = output_dir / "floods" / safe_file_name(name)
    url = drsv_flood_base_url() + name
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
    http_client.with_retries(lambda: http_client.download_file(client, url, target, chunk_bytes=LARGE_CHUNK_BYTES),
                             f"DRSV {name} download")
    return target


def flood_archive_date(path: Path) -> date:
    """The last-update date of the archive's dBASE table."""
    with zipfile.ZipFile(path) as archive:
        member = member_named(archive, ".dbf", label="attribute table")
        with archive.open(member) as dbf:
            return dbf_date(dbf, label=f"{path.name}/{member}")


def load_floods(connection: psycopg.Connection[Any], layers: dict[str, Path], study_areas: Path) -> int:
    """Replace the flood layers atomically when any of the archives is newer than the stored ones.

    Returns:
        The number of hazard polygons loaded, or 0 when the newest archive date is already stored.
    """
    snapshot = max(flood_archive_date(path) for path in [*layers.values(), study_areas])
    current = scalar(connection, "SELECT max(source_date) FROM analytics.flood_hazard_zones")
    if current == snapshot:
        logger.info("DRSV flood layers of %s already loaded", snapshot)
        return 0
    connection.commit()
    started = time.monotonic()
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
                  SELECT hazard_class, source_id, valid_from, {BUILD_AREA} AS geom
                  FROM staging_floods WHERE hazard_class IS NOT NULL) zones
                WHERE geom IS NOT NULL AND NOT ST_IsEmpty(geom)""", (snapshot,))  # noqa: S608 - SQL expression, no input
        zones = cursor.rowcount
        # The source polygons are raster-like fragments (median 4 m²): for drawing they are dissolved per class
        # within tiles, cleaned of slivers and pinholes narrower than about 4 m (an opening by 2 m, then a
        # closing by 3 m) and simplified to 1.5 m, which keeps the map's answers small.
        cursor.execute(
            f"""INSERT INTO analytics.flood_hazard_areas (hazard_class, geom, source_date)
                SELECT hazard_class, geom, %s FROM (
                  SELECT hazard_class, {DRAWABLE.replace("GEOM", "ST_Union(geom)")} AS geom
                  FROM analytics.flood_hazard_zones
                  GROUP BY hazard_class, ST_SnapToGrid(ST_PointOnSurface(geom), %s)) tiles
                WHERE geom IS NOT NULL AND NOT ST_IsEmpty(geom)""",  # noqa: S608 - SQL expression, no input
            (snapshot, FLOOD_TILE_METRES))
        areas_drawn = cursor.rowcount
        cursor.execute(
            f"""INSERT INTO analytics.flood_study_areas (name, valid_from, geom, source_date)
                SELECT source_id, valid_from, geom, %s FROM (
                  SELECT source_id, valid_from, ST_Multi(ST_CollectionExtract(ST_MakeValid(
                           ST_SimplifyPreserveTopology({BUILD_AREA}, %s)), 3)) AS geom
                  FROM staging_floods WHERE hazard_class IS NULL) areas
                WHERE geom IS NOT NULL AND NOT ST_IsEmpty(geom)""",  # noqa: S608 - SQL expression, no input
            (snapshot, STUDY_AREA_SIMPLIFY_METRES))
        areas = cursor.rowcount
    logger.info("Loaded %s flood hazard polygons (%s dissolved for drawing) and %s studied areas (DRSV %s) in %.0fs",
                f"{zones:,}", f"{areas_drawn:,}", areas, snapshot, time.monotonic() - started)
    return zones


def sync_floods(connection: psycopg.Connection[Any], client: httpx.Client, output_dir: Path) -> int:
    """Download every DRSV layer and the study areas, then load them; returns the polygons loaded."""
    layers = {hazard_class: download_flood_layer(client, output_dir, name)
              for hazard_class, name in FLOOD_LAYERS.items()}
    return load_floods(connection, layers, download_flood_layer(client, output_dir, FLOOD_STUDY_AREAS))


# --------------------------------------------------------------------------- orchestration

def sync_registers(
    connection: psycopg.Connection[Any],
    output_dir: Path | None = None,
    client: httpx.Client | None = None,
) -> SourceSyncReport:
    """Refresh every building register; one failing register keeps its stored data."""
    directory: Path = output_dir or raw_data_dir()
    if client is None:
        with http_client.create_client() as owned:
            return sync_registers(connection, directory, owned)
    http = client
    return run_isolated_sources(
        connection,
        {
            "energy_certificates": lambda: sync_energy_certificates(connection, http, directory),
            "gurs_valuation": lambda: sync_valuation(connection, http, directory),
            "drsv_floods": lambda: sync_floods(connection, http, directory),
        },
        group="building registers",
    )
