"""CSV/ZIP conversion and PostgreSQL import for GURS transaction archives."""

from __future__ import annotations

import csv
import hashlib
import io
import logging
import re
import time
import zipfile
from collections.abc import Iterable
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path

import psycopg
from psycopg import sql

from .conversion import converted
from .models import ArchiveIdentity, ImportStats

logger = logging.getLogger(__name__)

IGNORED_SOURCE_COLUMNS = {
    "OPOMBE_O_PRAVNEM_POSLU",
    "OPOMBE_O_NEPREMICNINI",
    "OPOMBE_O_ODDANIH_PROSTORIH",
}



@dataclass(frozen=True)
class TableSpec:
    """Destination table and ``{source CSV column: destination column}`` mapping."""

    table: str
    columns: dict[str, str]


TABLES = {
    "POSLI": TableSpec("transactions", {
        "ID_POSLA": "transaction_id", "VRSTA_KUPOPRODAJNEGA_POSLA": "transaction_type",
        "DATUM_UVELJAVITVE": "effective_date", "DATUM_SKLENITVE_POGODBE": "contract_date",
        "POGODBENA_CENA_ODSKODNINA": "contract_price", "VKLJUCENOST_DDV": "vat_included",
        "STOPNJA_DDV": "vat_rate", "DATUM_IZTEKA_LIZINGA": "lease_expiry_date",
        "DATUM_PRENEHANJA_LIZINGA": "lease_termination_date",
        "POSREDOVANJE_NEPREMICNINSKE_AGENCIJE": "agency_brokered",
        "DATUM_ZADNJE_SPREMEMBE_POSLA": "last_changed_date",
        "DATUM_ZADNJE_UVELJAVITVE_POSLA": "last_effective_date", "VRSTA_AKTA": "deed_type",
        "TRZNOST_POSLA": "marketability", "LETO": "dataset_year", "RPE_OBCINE_SIFRA": "municipality_code",
    }),
    "DELISTAVB": TableSpec("building_parts", {
        "ID_POSLA": "transaction_id", "SIFRA_KO": "cadastral_municipality_code",
        "IME_KO": "cadastral_municipality_name", "OBCINA": "municipality_name",
        "STEVILKA_STAVBE": "building_number", "STEVILKA_DELA_STAVBE": "building_part_number",
        "PARCELNA_STEVILKA_ZA_GEOLOKACIJO": "parcel_number_for_geolocation",
        "INTERNA_OZNAKA_DELA_STAVBE": "internal_building_part_label",
        "EVIDENTIRANOST_DELA_STAVBE": "recorded_status", "NASELJE": "settlement", "ULICA": "street",
        "HISNA_STEVILKA": "house_number", "DODATEK_HS": "house_number_suffix",
        "STEVILKA_STANOVANJA_ALI_POSLOVNEGA_PROSTORA": "apartment_or_business_unit_number",
        "VRSTA_DELA_STAVBE": "building_part_type", "LETO_IZGRADNJE_DELA_STAVBE": "construction_year",
        "STAVBA_JE_DOKONCANA": "building_completed", "GRADBENA_FAZA": "construction_phase",
        "NOVOGRADNJA": "new_construction", "PRODANA_POVRSINA": "sold_area",
        "PRODANI_DELEZ_DELA_STAVBE": "sold_share", "PRODANA_POVRSINA_DELA_STAVBE": "sold_building_part_area",
        "PRODANA_UPORABNA_POVRSINA_DELA_STAVBE": "sold_usable_area", "NADSTROPJE_DELA_STAVBE": "floor",
        "STEVILO_ZUNANJIH_PARKIRNIH_MEST": "outdoor_parking_spaces", "ATRIJ": "atrium",
        "POVRSINA_ATRIJA": "atrium_area",
        "DEJANSKA_RABA_DELA_STAVBE": "actual_use", "LEGA_DELA_STAVBE_V_STAVBI": "position_in_building",
        "STEVILO_SOB": "room_count", "POVRSINA_DELA_STAVBE": "building_part_area",
        "UPORABNA_POVRSINA": "usable_area", "PROSTORI_DELA_STAVBE": "rooms",
        "POGODBENA_CENA_DELA_STAVBE": "contractual_price", "STOPNJA_DDV_DELA_STAVBE": "vat_rate",
        "E_CENTROID": "centroid_e", "N_CENTROID": "centroid_n", "LETO": "dataset_year",
        "RPE_OBCINE_SIFRA": "municipality_code",
    }),
    "ZEMLJISCA": TableSpec("land_parcels", {
        "ID_POSLA": "transaction_id", "SIFRA_KO": "cadastral_municipality_code",
        "IME_KO": "cadastral_municipality_name", "OBCINA": "municipality_name",
        "PARCELNA_STEVILKA": "parcel_number", "VRSTA_ZEMLJISCA": "land_type",
        "VRSTA_TRAJNEGA_NASADA": "permanent_crop_type", "STAROST_TRAJNEGA_NASADA": "permanent_crop_age",
        "PRODANI_DELEZ_PARCELE": "sold_share",
        "POVRSINA_PARCELE": "parcel_area", "POGODBENA_CENA_PARCELE": "contractual_price",
        "STOPNJA_DDV_PARCELE": "vat_rate", "E_CENTROID": "centroid_e", "N_CENTROID": "centroid_n",
        "LETO": "dataset_year", "RPE_OBCINE_SIFRA": "municipality_code",
    }),
}

RENT_TABLES = {
    "POSLI": TableSpec("rental_transactions", {
        "ID_POSLA": "transaction_id", "VRSTA_NAJEMNEGA_POSLA": "rental_transaction_type",
        "DATUM_UVELJAVITVE": "effective_date", "DATUM_SKLENITVE_POGODBE": "contract_date",
        "POGODBENA_NAJEMNINA": "contract_rent",
        "VKLJUCENOST_OBRATOVALNIH_STROSKOV_V_NAJEMNINO": "operating_costs_included",
        "VKLJUCENOST_DDV": "vat_included", "STOPNJA_DDV": "vat_rate",
        "DATUM_ZACETKA_NAJEMA": "rental_start_date", "DATUM_PRENEHANJA_NAJEMA": "rental_end_date",
        "CAS_NAJEMA": "rental_time", "TRAJANJE_NAJEMA": "rental_duration",
        "DATUM_ZAKLJUCKA_NAJEMA_DATUM_PREDCASNE_PREKINITVE_NAJEMA": "closure_or_early_termination_date",
        "POSREDOVANJE_NEPREMICNINSKE_AGENCIJE": "agency_brokered",
        "DATUM_ZADNJE_SPREMEMBE_POSLA": "last_changed_date",
        "DATUM_ZADNJE_UVELJAVITVE_POSLA": "last_effective_date", "VRSTA_AKTA": "deed_type",
        "TRZNOST_POSLA": "marketability", "LETO": "dataset_year",
    }),
    "DELISTAVB": TableSpec("rental_building_parts", {
        "ID_POSLA": "transaction_id", "SIFRA_KO": "cadastral_municipality_code",
        "IME_KO": "cadastral_municipality_name", "OBCINA": "municipality_name",
        "STEVILKA_STAVBE": "building_number", "STEVILKA_DELA_STAVBE": "building_part_number",
        "INTERNA_OZNAKA_ODDANIH_PROSTOROV": "internal_rented_spaces_label", "NASELJE": "settlement",
        "ULICA": "street", "HISNA_STEVILKA": "house_number", "DODATEK_HS": "house_number_suffix",
        "STEVILKA_STANOVANJA_ALI_POSLOVNEGA_PROSTORA": "apartment_or_business_unit_number",
        "VRSTA_ODDANIH_PROSTOROV": "rented_spaces_type", "OPREMLJENOST_ODDANIH_PROSTOROV": "furnishing",
        "MIKROLOKACIJA_ODDANIH_PROSTOROV": "microlocation", "IZLOZBA": "storefront",
        "NAKUPOVALNI_CENTER": "shopping_center", "POVRSINA_ODDANIH_PROSTOROV": "rented_spaces_area",
        "POVRSINA_ODDANIH_PROSTOROV_ENAKA_DELU_STAVBE": "rented_area_equals_building_part",
        "POGODBENA_NAJEMNINA_POSAMEZNIH_ODDANIH_PROSTOROV": "contractual_rent",
        "LETO_IZGRADNJE_STAVBE": "construction_year", "DEJANSKA_RABA_DELA_STAVBE": "actual_use",
        "LEGA_DELA_STAVBE_V_STAVBI": "position_in_building", "STEVILO_SOB": "room_count",
        "POVRSINA_DELA_STAVBE": "building_part_area",
        "UPORABNA_POVRSINA_DELA_STAVBE": "usable_building_part_area", "PROSTORI_DELA_STAVBE": "rooms",
        "UPORABNA_POVRSINA_ODDANIH_PROSTOROV": "rented_usable_area", "GOSTINSKI_VRT": "hospitality_garden",
        "VKLJUCENOST_GOSTINSKEGA_VRTA_V_NAJEMNINO": "garden_included_in_rent",
        "POVRSINA_GOSTINSKEGA_VRTA": "hospitality_garden_area", "E_CENTROID": "centroid_e",
        "N_CENTROID": "centroid_n", "LETO": "dataset_year",
    }),
}

ARCHIVE_NATIONAL = re.compile(r"ETN_SLO_(\d+)_(KPP|NP)")
ARCHIVE_MUNICIPALITY = re.compile(r"ETN_(\d+)_(\d+)_KPP_")
HASH_CHUNK_BYTES = 1 << 20
CODEBOOK_BATCH_ROWS = 500


def parse_archive_name(name: str) -> ArchiveIdentity:
    """Derive scope, type, year and municipality from a GURS ETN archive file name."""
    if match := ARCHIVE_NATIONAL.search(name):
        dataset_type = "sales" if match.group(2) == "KPP" else "rent"
        return ArchiveIdentity("national", dataset_type, int(match.group(1)))
    if match := ARCHIVE_MUNICIPALITY.search(name):
        return ArchiveIdentity("municipality", "sales", int(match.group(2)), int(match.group(1)))
    raise ValueError(f"Cannot determine dataset scope/type/year from archive name: {name}")


def supersede_other_years(cur, table: str, ids: set[int], year: int) -> list[int]:
    """Drop transactions that the archive for `year` now contains but that are stored
    under another dataset year.

    GURS occasionally republishes an agreement in a different yearly archive. The
    transaction id is the primary key, so the newest archive being imported wins;
    child rows (building parts, parcels, rented spaces, derived facts) cascade and are
    reloaded from this archive.
    """
    if not ids:
        return []
    cur.execute(
        sql.SQL("DELETE FROM {} WHERE transaction_id = ANY(%s) AND dataset_year <> %s "
                "RETURNING transaction_id").format(sql.Identifier(table)),
        (sorted(ids), year),
    )
    return sorted(int(row[0]) for row in cur.fetchall())


def copy_rows(
    cur: psycopg.Cursor, table: str, mapping: dict[str, str], rows: Iterable[dict[str, str]], source_file_id: int,
    *, archive_name: str = "<unknown archive>", member: str = "<unknown member>",
) -> int:
    preserve_source_rows = table in {"building_parts", "land_parcels", "rental_building_parts"}
    columns = [*mapping.values(), "source_file_id"]
    if preserve_source_rows:
        columns.append("source_row_number")
    statement = sql.SQL("COPY {} ({}) FROM STDIN").format(
        sql.Identifier(table), sql.SQL(",").join(map(sql.Identifier, columns)),
    )
    count = 0
    with cur.copy(statement) as copy:
        for row_number, row in enumerate(rows, start=2):
            value = (
                *(
                    converted(
                        mapping[source], row.get(source, ""),
                        archive=archive_name, member=member, row_number=row_number,
                        source_field=source,
                    )
                    for source in mapping
                ),
                source_file_id,
            )
            copy.write_row((*value, row_number) if preserve_source_rows else value)
            count += 1
    return count


def _reader(archive: zipfile.ZipFile, member: str):
    binary = archive.open(member)
    text = io.TextIOWrapper(binary, encoding="utf-8-sig", newline="")
    return text, csv.DictReader(text)


def _member_checksum(archive: zipfile.ZipFile, member: str) -> str:
    hasher = hashlib.sha256()
    with archive.open(member) as source:
        while chunk := source.read(HASH_CHUNK_BYTES):
            hasher.update(chunk)
    return hasher.hexdigest()


def _historical_cadastral_units(
    archive: zipfile.ZipFile, member: str,
) -> set[tuple[int, str]]:
    text, rows = _reader(archive, member)
    try:
        return {
            (int(row["SIFRA_KO"]), row.get("IME_KO", "").strip())
            for row in rows
            if row.get("SIFRA_KO", "").strip()
        }
    finally:
        text.close()


def _import_codebook(
    cur, archive: zipfile.ZipFile, member: str, source_file_id: int,
) -> int:
    count = 0
    batch = []
    text, rows = _reader(archive, member)
    try:
        for row in rows:
            batch.append((
                int(row["ID"]), row["SIFRANT"], int(row["NUMERICNA_VREDNOST"]),
                row["OPIS"], source_file_id,
            ))
            if len(batch) == CODEBOOK_BATCH_ROWS:
                _write_codebook_batch(cur, batch)
                count += len(batch)
                batch.clear()
        if batch:
            _write_codebook_batch(cur, batch)
            count += len(batch)
    finally:
        text.close()
    return count


def _write_codebook_batch(cur, values) -> None:
    cur.executemany(
        """INSERT INTO codebook_values(
               codebook_id,codebook_name,numeric_value,description,source_file_id
           ) VALUES (%s,%s,%s,%s,%s)
           ON CONFLICT(codebook_id,numeric_value) DO UPDATE SET
             codebook_name=excluded.codebook_name,
             description=excluded.description,
             source_file_id=excluded.source_file_id""",
        values,
    )


def _file_sha256(path: Path) -> str:
    hasher = hashlib.sha256()
    with path.open("rb") as source:
        while chunk := source.read(HASH_CHUNK_BYTES):
            hasher.update(chunk)
    return hasher.hexdigest()


def _already_imported(connection: psycopg.Connection, identity: ArchiveIdentity, digest: str) -> bool:
    existing = connection.execute(
        """
        SELECT 1 FROM source_files
        WHERE dataset_scope=%s AND dataset_type=%s AND dataset_year=%s
          AND municipality_code IS NOT DISTINCT FROM %s AND sha256=%s
        """,
        (identity.dataset_scope, identity.dataset_type, identity.year, identity.municipality, digest),
    ).fetchone()
    connection.commit()
    return existing is not None


def _register_source_file(cur: psycopg.Cursor, path: Path, identity: ArchiveIdentity, digest: str) -> int:
    cur.execute(
        """INSERT INTO source_files(
               file_name,municipality_code,dataset_year,dataset_type,dataset_scope,sha256,downloaded_at
           ) VALUES (%s,%s,%s,%s,%s,%s,%s)
           ON CONFLICT(sha256) DO UPDATE SET file_name=excluded.file_name,
               dataset_type=excluded.dataset_type,dataset_scope=excluded.dataset_scope
           RETURNING id""",
        (
            path.name, identity.municipality, identity.year, identity.dataset_type,
            identity.dataset_scope, digest, datetime.fromtimestamp(path.stat().st_mtime, UTC),
        ),
    )
    return cur.fetchone()[0]


def _replace_snapshot(cur: psycopg.Cursor, identity: ArchiveIdentity) -> None:
    """Delete the rows this archive replaces; child rows cascade."""
    if identity.dataset_type == "rent":
        cur.execute("DELETE FROM rental_transactions WHERE dataset_year=%s", (identity.year,))
    elif identity.dataset_scope == "national":
        cur.execute("DELETE FROM transactions WHERE dataset_year=%s", (identity.year,))
    else:
        cur.execute(
            "DELETE FROM transactions WHERE municipality_code=%s AND dataset_year=%s",
            (identity.municipality, identity.year),
        )


def _import_codebook_member(
    cur: psycopg.Cursor, archive: zipfile.ZipFile, member: str, source_file_id: int, verbose: bool,
) -> int:
    checksum = _member_checksum(archive, member)
    cur.execute(
        """INSERT INTO codebook_imports(checksum,source_file_id) VALUES (%s,%s)
           ON CONFLICT(checksum) DO NOTHING RETURNING checksum""",
        (checksum, source_file_id),
    )
    if cur.fetchone() is None:
        if verbose:
            logger.info("%s: skipped unchanged codebook", member)
        return 0
    imported = _import_codebook(cur, archive, member, source_file_id)
    if verbose:
        logger.info("%s: imported %s rows into codebook_values", member, imported)
    return imported


def _transaction_ids(archive: zipfile.ZipFile, member: str) -> set[int]:
    text, rows = _reader(archive, member)
    try:
        return {int(row["ID_POSLA"]) for row in rows if (row.get("ID_POSLA") or "").strip()}
    finally:
        text.close()


def _import_member(
    cur: psycopg.Cursor,
    archive: zipfile.ZipFile,
    archive_name: str,
    member: str,
    spec: TableSpec,
    identity: ArchiveIdentity,
    source_file_id: int,
    stats: ImportStats,
) -> int:
    """Copy one CSV member into its table and return the number of rows copied."""
    if "SIFRA_KO" in spec.columns:
        cur.executemany(
            """INSERT INTO cadastral_municipalities(code,name) VALUES (%s,%s)
               ON CONFLICT(code) DO UPDATE SET name=excluded.name""",
            _historical_cadastral_units(archive, member),
        )
    if "_POSLI_" in member and (identity.dataset_scope == "national" or identity.dataset_type == "rent"):
        superseded = supersede_other_years(cur, spec.table, _transaction_ids(archive, member), identity.year)
        if superseded:
            stats.superseded_transactions += len(superseded)
            logger.warning(
                "%s: %s transaction(s) moved here from another dataset year; "
                "replacing the older copy (ids %s%s).",
                archive_name, len(superseded), ", ".join(map(str, superseded[:10])),
                " …" if len(superseded) > 10 else "",
            )
    text, rows = _reader(archive, member)
    try:
        unknown = set(rows.fieldnames or ()) - set(spec.columns) - IGNORED_SOURCE_COLUMNS
        if unknown:
            raise ValueError(f"{archive_name}: unmapped columns in {member}: {sorted(unknown)}")
        return copy_rows(
            cur, spec.table, spec.columns, rows, source_file_id,
            archive_name=archive_name, member=member,
        )
    finally:
        text.close()


def _ordered_members(names: Iterable[str]) -> list[str]:
    """Transactions first: building parts and parcels reference them."""
    return sorted(names, key=lambda name: 0 if "_POSLI_" in name else 1)


def import_zip(connection: psycopg.Connection, path: Path, verbose: bool = False) -> ImportStats:
    """Import one ETN archive atomically, replacing the snapshot it supersedes.

    An archive whose checksum is already registered for the same dataset is skipped.
    """
    stats = ImportStats()
    identity = parse_archive_name(path.name)
    digest = _file_sha256(path)
    if _already_imported(connection, identity, digest):
        stats.unchanged = True
        return stats
    selected_tables = RENT_TABLES if identity.dataset_type == "rent" else TABLES
    started = time.monotonic()
    with connection.transaction(), connection.cursor() as cur:
        source_file_id = _register_source_file(cur, path, identity, digest)
        _replace_snapshot(cur, identity)
        with zipfile.ZipFile(path) as archive:
            for member in _ordered_members(archive.namelist()):
                if "_sifranti_" in member:
                    stats.codebook_rows += _import_codebook_member(cur, archive, member, source_file_id, verbose)
                    continue
                kind = next((key for key in selected_tables if f"_{key}_" in member), None)
                if not kind:
                    raise ValueError(f"{path.name}: unknown CSV member {member}")
                spec = selected_tables[kind]
                member_started = time.monotonic()
                copied = _import_member(cur, archive, path.name, member, spec, identity, source_file_id, stats)
                stats.member_import_seconds += time.monotonic() - member_started
                stats.rows += copied
                if verbose:
                    logger.info("%s: copied %s rows from %s into %s", path.name, copied, member, spec.table)
    stats.database_seconds = max(0.0, time.monotonic() - started - stats.member_import_seconds)
    return stats
