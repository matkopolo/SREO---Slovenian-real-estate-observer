import io
import struct
import zipfile
from datetime import date
from pathlib import Path
from unittest.mock import MagicMock, patch

import httpx
import pytest

from real_estate_etl.construction import (
    building_rows,
    codebook_rows,
    download_buildings,
    iter_dbf,
    iter_points,
    load_building_parts,
    load_buildings,
    part_rows,
    permit_observations,
    source_date,
    sync_construction,
)

FIELDS = [("EID_STAVBA", 40), ("KO_ID", 8), ("ST_STAVBE", 8), ("STEVILO_ET", 4), ("STEVILO_ST", 4),
          ("STEVILO_PO", 4), ("TIP_STAVBE", 4), ("NOSILNA_KO", 4), ("STATUS_VPI", 3), ("LETO_IZGRA", 6),
          ("BRUTO_TLOR", 12), ("EID_OBCINA", 40), ("DATUM_SYS", 8), ("LETO_OBNOV", 4), ("LETO_OBNO0", 4)]

PARTS_CSV = (
    "FEATUREID,EID_DEL_STAVBE,EID_STAVBA,EID_HISNA_STEVILKA,UPRAVNIK_ID,VRSTA_DEJANSKE_RABE_DEL_ST_ID,DVIGALO,"
    "LETO_OBNOVE_INSTALACIJ,LETO_OBNOVE_OKEN,POVRSINA,STATUS,ST_DELA_STAVBE,EID_STANOVANJE,ST_STANOVANJA,"
    "VRSTA_STANOVANJA_ID,UPORABNA_POVRSINA,DATUM_SYS,PROSTORNINA_CISTERN_SILOSOV,"
    "NACIN_DOLOCITVE_POVRSINE_DELA_STAVBE_ID,UPRAVNIK_STATUS,ETAZNA_LASTNINA,SKUPNI_DEL_ETAZNA_LASTNINA\r\n"
    "DELI_STAVB.1003,1003,100200000250893316,,,2,1,1993,,93.5,4,2,,,,88.1,2022-05-30T04:36:33,,-1,,2,2\r\n"
    "DELI_STAVB.1004,1004,100200000250893316,,,28,0,,,37.8,4,1,,,,37.8,2022-05-30T04:36:33,,-1,,2,2\r\n"
    "DELI_STAVB.1005,,100200000250893316,,,28,2,,2001,12,4,3,,,,12,2023-03-01T08:52:32,,-1,,2,2\r\n"
)


def dbf(rows: list[dict[str, str] | None]) -> bytes:
    """Build a DBF; ``None`` writes a deleted record (flag ``*``)."""
    record_length = 1 + sum(length for _, length in FIELDS)
    header_length = 32 + 32 * len(FIELDS) + 1
    out = bytearray(struct.pack("<BBBBIHH20x", 3, 126, 1, 1, len(rows), header_length, record_length))
    for name, length in FIELDS:
        out += name.encode().ljust(11, b"\0") + b"C" + b"\0" * 4 + bytes([length, 0]) + b"\0" * 14
    out += b"\r"
    for row in rows:
        flag, values = (b"*", {}) if row is None else (b" ", row)
        out += flag + b"".join(str(values.get(name, "")).encode().ljust(length)[:length] for name, length in FIELDS)
    return bytes(out)


def shp(points: list[tuple[float, float] | None]) -> bytes:
    out = bytearray(100)
    for number, point in enumerate(points, start=1):
        content = struct.pack("<i2d", 1, *point) if point else struct.pack("<i", 0)
        out += struct.pack(">ii", number, len(content) // 2) + content
    return bytes(out)


def archive_bytes(rows, points) -> bytes:
    inner = io.BytesIO()
    with zipfile.ZipFile(inner, "w") as z:
        z.writestr("KN_SLO_STAVBE_SLO_STAVBE_tocka.dbf", dbf(rows))
        z.writestr("KN_SLO_STAVBE_SLO_STAVBE_tocka.shp", shp(points))
    outer = io.BytesIO()
    with zipfile.ZipFile(outer, "w") as z:
        z.writestr("KN_SLO_STAVBE_SLO_stavbe_20261101.zip", inner.getvalue())
        z.writestr("sifranti/TIPI_STAVB.CSV", "id,sifra,nazivSl\n1,1,samostoječa stavba\n")
        z.writestr("KN_SLO_STAVBE_SLO_deli_stavb_20261101.csv", PARTS_CSV)
        z.writestr("KN_SLO_STAVBE_SLO_imetniki_lastnistva_20261101.csv", "owner data that must never be read\n")
    return outer.getvalue()


def archive(rows, points) -> zipfile.ZipFile:
    return zipfile.ZipFile(io.BytesIO(archive_bytes(rows, points)))


BUILDING = {"EID_STAVBA": "100200000250893316", "KO_ID": "2551.0", "ST_STAVBE": "1.0", "STEVILO_ET": "2",
            "STEVILO_ST": "4", "STEVILO_PO": "0", "TIP_STAVBE": "1", "NOSILNA_KO": "5", "STATUS_VPI": "4",
            "LETO_IZGRA": "2024.0", "BRUTO_TLOR": "************", "EID_OBCINA": "110200000110277170",
            "DATUM_SYS": "20250717", "LETO_OBNOV": "****", "LETO_OBNO0": "2017"}


def test_dbf_and_points_stream_in_file_order():
    rows = list(iter_dbf(io.BytesIO(dbf([BUILDING, {**BUILDING, "EID_STAVBA": "2"}]))))
    assert [row["EID_STAVBA"] for row in rows] == ["100200000250893316", "2"]
    assert list(iter_points(io.BytesIO(shp([(437356.56, 41931.08), None])))) == [(437356.56, 41931.08), None]


def test_building_rows_parse_numbers_overflow_and_geometry():
    rows = list(building_rows(archive([BUILDING], [(437356.56, 41931.08)]), date(2026, 11, 1)))
    assert rows == [("100200000250893316", 2551, 1, 2024, 2, 4, 0, 1, 5, 4, None, "110200000110277170",
                     "2025-07-17", "SRID=3794;POINT(437356.56 41931.08)", date(2026, 11, 1), None, 2017)]


def test_part_rows_read_only_the_parts_table():
    rows = list(part_rows(archive([BUILDING], [None]), date(2026, 11, 1)))
    assert rows == [
        ("1003", "100200000250893316", 2, 2, True, None, 1993, 93.5, 88.1, "2022-05-30", date(2026, 11, 1)),
        ("1004", "100200000250893316", 1, 28, None, None, None, 37.8, 37.8, "2022-05-30", date(2026, 11, 1)),
    ]  # the third row has no EID and is skipped; DVIGALO 0 is "unknown"


def test_load_building_parts_skips_an_already_loaded_snapshot(tmp_path: Path):
    connection = MagicMock()
    connection.execute.return_value.fetchone.return_value = (date(2026, 11, 1),)
    assert load_building_parts(connection, tmp_path / "KN_SLO_STAVBE_SLO_20261101.zip") == 0
    connection.transaction.assert_not_called()


def test_building_rows_skip_records_without_identity_and_keep_null_shapes():
    rows = list(building_rows(archive([{**BUILDING, "KO_ID": ""}, BUILDING], [(1.0, 2.0), None]), date(2026, 11, 1)))
    assert len(rows) == 1
    assert rows[0][13] is None


def test_codebooks_and_snapshot_date():
    assert codebook_rows(archive([BUILDING], [None])) == [("building_type", 1, "samostoječa stavba")]
    assert source_date("KN_SLO_STAVBE_SLO_20261101.zip") == date(2026, 11, 1)


def test_permit_observations():
    payload = {"id": ["OBČINE", "TIP STAVBE", "LETO", "MERITVE"], "size": [1, 1, 1, 2],
               "dimension": {"OBČINE": {"category": {"index": {"070": 0}}},
                             "TIP STAVBE": {"category": {"index": {"1": 0}}},
                             "LETO": {"category": {"index": {"2025": 0}}},
                             "MERITVE": {"category": {"index": {"1": 0, "3": 1}}}},
               "value": [212, 99999]}
    rows = permit_observations(payload)
    assert [(r.series, r.geography_key, r.period, r.value) for r in rows] == [
        ("permit_buildings", "municipality:70", "2025", 212.0)]


def test_deleted_dbf_records_keep_attributes_aligned_with_their_points():
    second = {**BUILDING, "EID_STAVBA": "2"}
    third = {**BUILDING, "EID_STAVBA": "3"}
    rows = list(building_rows(
        archive([BUILDING, None, second, third], [(1.0, 1.0), (2.0, 2.0), (3.0, 3.0), (4.0, 4.0)]),
        date(2026, 11, 1),
    ))
    assert [(row[0], row[13]) for row in rows] == [
        ("100200000250893316", "SRID=3794;POINT(1.0 1.0)"),
        ("2", "SRID=3794;POINT(3.0 3.0)"),
        ("3", "SRID=3794;POINT(4.0 4.0)"),
    ]


def test_iter_dbf_yields_placeholder_for_deleted_records():
    assert next(iter_dbf(io.BytesIO(dbf([None, BUILDING])))) is None


@pytest.mark.parametrize("points", [[(1.0, 1.0)], [(1.0, 1.0), (2.0, 2.0), (3.0, 3.0)]])
def test_record_count_mismatch_fails_instead_of_misaligning(points):
    with pytest.raises(ValueError, match=r"shorter|longer"):
        list(building_rows(archive([BUILDING, BUILDING], points), date(2026, 11, 1)))


def test_truncated_dbf_fails():
    data = dbf([BUILDING, BUILDING])
    with pytest.raises(ValueError, match="DBF ends at record 2 of 2"):
        list(iter_dbf(io.BytesIO(data[:-10])))


def test_truncated_shapefile_fails():
    data = shp([(1.0, 1.0)])
    with pytest.raises(ValueError, match="truncated"):
        list(iter_points(io.BytesIO(data[:-4])))


def json_and_file_transport(tmp_path: Path, payload: bytes, status: int = 200) -> httpx.Client:
    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path.endswith("/result"):
            return httpx.Response(200, json={"statusText": "OK", "file": {"name": "KN_SLO_STAVBE_SLO_20261101.zip"}})
        if request.url.path.endswith("/file"):
            return httpx.Response(200, json={"url": "https://files.test/buildings.zip"})
        return httpx.Response(status, content=payload)

    return httpx.Client(transport=httpx.MockTransport(handler))


def zip_bytes() -> bytes:
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w") as output:
        output.writestr("a.txt", "x")
    return buffer.getvalue()


def test_download_buildings_replaces_older_snapshots(tmp_path: Path):
    old = tmp_path / "KN_SLO_STAVBE_SLO_20261001.zip"
    old.write_bytes(zip_bytes())
    with json_and_file_transport(tmp_path, zip_bytes()) as client:
        path = download_buildings(client, tmp_path)
    assert path == tmp_path / "KN_SLO_STAVBE_SLO_20261101.zip"
    assert zipfile.is_zipfile(path)
    assert not old.exists()


def test_failed_building_download_leaves_no_partial_file(tmp_path: Path):
    with (
        json_and_file_transport(tmp_path, b"not found", status=404) as client,
        pytest.raises(httpx.HTTPStatusError),
    ):
        download_buildings(client, tmp_path)
    assert list(tmp_path.iterdir()) == []


def test_load_buildings_skips_an_already_loaded_snapshot(tmp_path: Path):
    connection = MagicMock()
    connection.execute.return_value.fetchone.return_value = (date(2026, 11, 1),)
    assert load_buildings(connection, tmp_path / "KN_SLO_STAVBE_SLO_20261101.zip") == 0
    connection.transaction.assert_not_called()


def test_load_buildings_keeps_the_newest_duplicate_and_reports_the_loaded_count(tmp_path: Path, caplog):
    path = tmp_path / "KN_SLO_STAVBE_SLO_20261101.zip"
    path.write_bytes(archive_bytes([BUILDING, BUILDING], [(1.0, 1.0), (2.0, 2.0)]))
    connection = MagicMock()
    connection.execute.return_value.fetchone.return_value = (date(2026, 10, 1),)
    cursor = connection.cursor.return_value.__enter__.return_value
    cursor.rowcount = 1

    assert load_buildings(connection, path) == 1
    statements = [call.args[0] for call in cursor.execute.call_args_list]
    assert any("ORDER BY eid, record_changed_on DESC" in str(statement) for statement in statements)
    assert "dropped 1 duplicate EID record" in caplog.text


def test_one_failing_construction_source_keeps_the_other(tmp_path: Path):
    connection = MagicMock()
    with (
        patch("real_estate_etl.construction.sync_permits", side_effect=httpx.ConnectError("down")),
        patch("real_estate_etl.construction.download_buildings", return_value=tmp_path / "b.zip"),
        patch("real_estate_etl.construction.load_buildings", return_value=12),
        patch("real_estate_etl.construction.load_building_parts", return_value=30),
    ):
        report = sync_construction(connection, tmp_path, client=MagicMock())
    assert report.counts == {"gurs_buildings": 12, "gurs_building_parts": 30}
    assert report.status() == {"gurs_buildings": "ok", "gurs_building_parts": "ok", "surs_permits": "ConnectError: down"}
    connection.rollback.assert_called_once()
