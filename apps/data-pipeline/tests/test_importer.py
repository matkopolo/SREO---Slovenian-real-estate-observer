import zipfile
from pathlib import Path
from unittest.mock import MagicMock

import pytest

from real_estate_etl.importer import RENT_TABLES, TABLES, import_zip, parse_archive_name, supersede_other_years
from real_estate_etl.models import ArchiveIdentity


@pytest.mark.parametrize(
    ("name", "expected"),
    [
        ("ETN_SLO_2024_KPP_20250101.zip", ArchiveIdentity("national", "sales", 2024)),
        ("ETN_SLO_2019_NP_20250101.zip", ArchiveIdentity("national", "rent", 2019)),
        ("ETN_061_2012_KPP_20250101.zip", ArchiveIdentity("municipality", "sales", 2012, 61)),
    ],
)
def test_parse_archive_name(name, expected):
    assert parse_archive_name(name) == expected


@pytest.mark.parametrize("name", ["ETN_SLO_KPP.zip", "KN_SLO_STAVBE_SLO_20261101.zip", "random.zip"])
def test_parse_archive_name_rejects_unknown_names(name):
    with pytest.raises(ValueError, match="Cannot determine dataset"):
        parse_archive_name(name)


def test_table_specs_name_tables_and_columns():
    assert TABLES["POSLI"].table == "transactions"
    assert RENT_TABLES["DELISTAVB"].table == "rental_building_parts"
    assert TABLES["POSLI"].columns["ID_POSLA"] == "transaction_id"


def test_unchanged_archive_is_skipped_without_opening_a_transaction(tmp_path: Path):
    archive = tmp_path / "ETN_SLO_2020_KPP_x.zip"
    with zipfile.ZipFile(archive, "w") as output:
        output.writestr("x.csv", "a\n")
    connection = MagicMock()
    connection.execute.return_value.fetchone.return_value = (1,)

    stats = import_zip(connection, archive)

    assert stats.unchanged
    connection.transaction.assert_not_called()


def test_supersede_other_years_deletes_only_other_years():
    class Cursor:
        def execute(self, statement, params):
            self.params = params

        def fetchall(self):
            return [(967543,)]

    cursor = Cursor()
    assert supersede_other_years(cursor, "rental_transactions", {967543, 5}, 2026) == [967543]
    assert cursor.params == ([5, 967543], 2026)
    assert supersede_other_years(cursor, "rental_transactions", set(), 2026) == []


def national_archive(path: Path, fieldnames: list[str], extra_members: dict[str, str] | None = None) -> Path:
    import csv
    import io

    output = io.StringIO(newline="")
    writer = csv.DictWriter(output, fieldnames=fieldnames)
    writer.writeheader()
    writer.writerow(dict.fromkeys(fieldnames, ""))
    with zipfile.ZipFile(path, "w") as archive:
        archive.writestr("ETN_SLO_2010_KPP_KPP_POSLI_test.csv", output.getvalue())
        for name, text in (extra_members or {}).items():
            archive.writestr(name, text)
    return path


def importing_connection() -> MagicMock:
    connection = MagicMock()
    connection.execute.return_value.fetchone.return_value = None  # the checksum is new
    cursor = connection.cursor.return_value.__enter__.return_value
    cursor.fetchone.return_value = (1,)  # source_files.id
    return connection


def test_renamed_source_column_fails_instead_of_loading_nulls(tmp_path: Path):
    """A GURS layout change (here POGODBENA_CENA_ODSKODNINA renamed) must not commit a year of NULL prices."""
    fieldnames = [name if name != "POGODBENA_CENA_ODSKODNINA" else "CENA" for name in TABLES["POSLI"].columns]
    archive = national_archive(tmp_path / "ETN_SLO_2010_KPP_x.zip", fieldnames)
    with pytest.raises(ValueError, match=r"unmapped columns.*CENA"):
        import_zip(importing_connection(), archive)


def test_missing_mapped_column_fails_unless_documented_optional(tmp_path: Path):
    from real_estate_etl.importer import OPTIONAL_SOURCE_COLUMNS

    assert {"RPE_OBCINE_SIFRA"} == OPTIONAL_SOURCE_COLUMNS
    without_price = [name for name in TABLES["POSLI"].columns if name != "POGODBENA_CENA_ODSKODNINA"]
    archive = national_archive(tmp_path / "ETN_SLO_2010_KPP_x.zip", without_price)
    with pytest.raises(ValueError, match=r"expected columns missing.*POGODBENA_CENA_ODSKODNINA"):
        import_zip(importing_connection(), archive)

    without_municipality = [name for name in TABLES["POSLI"].columns if name != "RPE_OBCINE_SIFRA"]
    archive = national_archive(tmp_path / "ETN_SLO_2011_KPP_x.zip", without_municipality)
    assert import_zip(importing_connection(), archive).rows == 1
