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
