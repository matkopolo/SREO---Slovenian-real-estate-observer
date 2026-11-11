import io
import re
import struct
import zipfile
from datetime import date
from pathlib import Path
from unittest.mock import MagicMock, patch

import httpx
import pytest

from real_estate_etl.registers import (
    VALUATION_MEMBERS,
    _dbf_day,
    _member,
    certificate_rows,
    dbf_date,
    discover_energy_register,
    download_energy_register,
    download_valuation,
    flood_rows,
    iter_polygons,
    load_energy_certificates,
    load_floods,
    load_valuation,
    sync_registers,
    sync_valuation,
    valuation_codebook_rows,
    valuation_rows,
    valuation_source_date,
)

# --------------------------------------------------------------------------- energy certificates

REGISTER = (
    "﻿ID energetske izkaznice|Datum izdelave|Velja do|Šifra KO|Številka stavbe|Številka dela stavbe|Tip izkaznice|"
    "Potrebna toplota za ogrevanje|Dovedena energija za delovanje stavbe|Celotna energija|Dovedena električna energija|"
    "Primarna energija|Emisije CO2|Kondicionirana površina stavbe|Energijski razred|EPBD \r\n"
    "2025-912-380-130303|13.11.2025|13.11.2035|665|2257|2|računska|59|109||1|128,5|25|53|C|STANOVANJE\r\n"
    "2025-808-65-119802|14.02.2025|14.02.2035|2631|2293|0|merjena|||472.179,28|162.452|584.378,01|87937|2.566||DRUGO\r\n"
    "2025-000-00-000000|14.02.2025|14.02.2035||12|0|računska|||||||||HISA\r\n"
)

PAGE = ('<p>stanje na dan 21. 10. 2026</p><a href="https://www.energetika-portal.si/fileadmin/dokumenti/podrocja/'
        'energetika/energetske_izkaznice/ei_javni_register_okt26.csv">Register</a>'
        '<a href="https://www.energetika-portal.si/fileadmin/x/ei_zacasni_register_okt26.csv">Začasni</a>')


def test_certificate_rows_parse_slovenian_numbers_and_skip_rows_without_a_key(tmp_path: Path):
    path = tmp_path / "ei_javni_register_okt26.csv"
    path.write_text(REGISTER, encoding="utf-8")
    rows = list(certificate_rows(path, date(2026, 10, 21)))
    assert rows == [
        ("2025-912-380-130303", date(2025, 11, 13), date(2035, 11, 13), 665, 2257, 2, "computed", "C",
         59.0, 109.0, None, 1.0, 128.5, 25.0, 53.0, "STANOVANJE", date(2026, 10, 21)),
        ("2025-808-65-119802", date(2025, 2, 14), date(2035, 2, 14), 2631, 2293, 0, "measured", None,
         None, None, 472179.28, 162452.0, 584378.01, 87937.0, 2566.0, "DRUGO", date(2026, 10, 21)),
    ]


def test_certificate_rows_reject_a_file_with_another_layout(tmp_path: Path):
    path = tmp_path / "ei.csv"
    path.write_text("a|b|c\n1|2|3\n", encoding="utf-8")
    with pytest.raises(ValueError, match="unexpected first column"):
        list(certificate_rows(path, date(2026, 10, 21)))


def page_and_file_transport(csv_text: str) -> httpx.Client:
    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path.endswith("/register-energetskih-izkaznic/"):
            return httpx.Response(200, text=PAGE)
        return httpx.Response(200, content=csv_text.encode("utf-8"))

    return httpx.Client(transport=httpx.MockTransport(handler))


def test_discover_energy_register_reads_the_public_link_and_the_state_date():
    with page_and_file_transport(REGISTER) as client:
        url, as_of = discover_energy_register(client)
    assert url.endswith("/ei_javni_register_okt26.csv")
    assert as_of == date(2026, 10, 21)


def test_download_energy_register_replaces_older_months(tmp_path: Path):
    old = tmp_path / "ei_javni_register_sep26.csv"
    old.write_text(REGISTER, encoding="utf-8")
    with page_and_file_transport(REGISTER) as client:
        path, as_of = download_energy_register(client, tmp_path)
    assert path == tmp_path / "ei_javni_register_okt26.csv"
    assert as_of == date(2026, 10, 21)
    assert not old.exists()


def test_download_energy_register_rejects_a_file_that_is_not_the_register(tmp_path: Path):
    with page_and_file_transport("<html>maintenance</html>") as client, pytest.raises(ValueError, match="validation"):
        download_energy_register(client, tmp_path)
    assert list(tmp_path.iterdir()) == []


def test_load_energy_certificates_skips_a_register_already_loaded(tmp_path: Path):
    connection = MagicMock()
    connection.execute.return_value.fetchone.return_value = (date(2026, 10, 21),)
    assert load_energy_certificates(connection, tmp_path / "ei.csv", date(2026, 10, 21)) == 0
    connection.transaction.assert_not_called()


def test_load_energy_certificates_refuses_an_empty_register(tmp_path: Path):
    path = tmp_path / "ei.csv"
    path.write_text(REGISTER.splitlines()[0] + "\n", encoding="utf-8")
    connection = MagicMock()
    connection.execute.return_value.fetchone.return_value = (date(2026, 9, 21),)
    with pytest.raises(ValueError, match="no certificates"):
        load_energy_certificates(connection, path, date(2026, 10, 21))


# --------------------------------------------------------------------------- generalised values

def valuation_archive() -> zipfile.ZipFile:
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w") as z:
        z.writestr("EV_108_EVIDENCA_VREDNOTENJA_stavba_20261107.csv",
                   "FEATUREID,EID_STAVBA,KO_SIFKO,STEV_ST,ST_ETAZ,LETO_IZG_STA,RPE_OBCINE_SIFRA\r\n"
                   "STAVBA_OB.1,100200000100460910,665,2257,5,2009,108\r\n"
                   "STAVBA_OB.2,100200000100477955,,336,1,1990,108\r\n")
        z.writestr("EV_108_EVIDENCA_VREDNOTENJA_del_stavbe_20261107.csv",
                   "FEATUREID,EID_DEL_STAVBE,EID_STAVBA,STEV_DST,STEV_STAN,POVRSINA,UPOR_POV,ST_NADSTROPJA,ID_LEGA,"
                   "IMA_DVIGALO_DN,RPE_OBCINE_SIFRA\r\n"
                   "DEL_STAVBE_OB.11,11,100200000100460910,2,1,96.2,53.4,0,1714,2,108\r\n"
                   "DEL_STAVBE_OB.12,12,100200000100460910,26,2,70,60,-1,,1,108\r\n"
                   "DEL_STAVBE_OB.13,13,100200000100477955,1,1,172.1,82.9,1,,2,108\r\n")
        z.writestr("EV_108_EVIDENCA_VREDNOTENJA_del_stavbe_enota_20261107.csv",
                   "FEATUREID,EID_DEL_STAVBE,ID_MODEL,RAVEN,VPLIV,POSPLOSENA_VREDNOST,RPE_OBCINE_SIFRA\r\n"
                   "DEL_STAVBE_ENOTA_OB.11,11,STA,8/21,,84700.00,108\r\n"
                   "DEL_STAVBE_ENOTA_OB.12,12,STA,8/21,,,108\r\n"
                   "DEL_STAVBE_ENOTA_OB.13,13,HIS,5/15,,213200,108\r\n")
        z.writestr("EV_108_EVIDENCA_VREDNOTENJA_SIF_MODEL_20261107.csv",
                   "FEATUREID,ID_MODEL,NAZIV,OPIS\r\nSIF_MODEL.STA,STA,STANOVANJA,STANOVANJA\r\n")
        z.writestr("EV_108_EVIDENCA_VREDNOTENJA_SIF_LEGA_20261107.csv",
                   "FEATUREID,ID_LEGA,SIFRA,NAZIV\r\nSIF_LEGA.1714,1714,2,pritličje\r\n")
        z.writestr("EV_108_EVIDENCA_VREDNOTENJA_imetnik_lastnistva_20261107.csv", "owner data that must never be read\r\n")
        z.writestr("EV_108_EVIDENCA_VREDNOTENJA_oseba_20261107.csv", "person data that must never be read\r\n")
    return zipfile.ZipFile(buffer)


def test_valuation_rows_join_units_to_parts_and_buildings():
    rows = list(valuation_rows(valuation_archive(), 108, date(2026, 11, 7)))
    assert rows == [
        ("11", "100200000100460910", 665, 2257, 2, "STA", "8/21", 84700, 0, 1714, 108, date(2026, 11, 7)),
        ("12", "100200000100460910", 665, 2257, 26, "STA", "8/21", None, -1, None, 108, date(2026, 11, 7)),
    ]  # the house belongs to a building without a cadastral key and is skipped; floor -1 is a cellar


def test_valuation_archive_members_never_include_owner_tables():
    archive = valuation_archive()
    opened = [_member(archive, key) for key in ("buildings", "parts", "units", "models", "positions")]
    assert not any("imetnik" in name or "oseba" in name for name in opened)
    VALUATION_MEMBERS["owners"] = re.compile(r"_imetnik_lastnistva_\d{8}\.csv$")
    try:
        with pytest.raises(ValueError, match="refusing"):
            _member(archive, "owners")
    finally:
        del VALUATION_MEMBERS["owners"]


def test_valuation_codebooks_and_source_date():
    assert valuation_codebook_rows(valuation_archive()) == [("valuation_model", "STA", "STANOVANJA"),
                                                            ("position", "1714", "pritličje")]
    assert valuation_source_date("EV_108_EVIDENCA_VREDNOTENJA_20261107.zip") == date(2026, 11, 7)


def valuation_transport(status: str = "OK") -> httpx.Client:
    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path.endswith("/result"):
            return httpx.Response(200, json={"statusText": status,
                                             "file": {"name": "EV_108_EVIDENCA_VREDNOTENJA_20261107.zip"} if status == "OK" else None})
        if request.url.path.endswith("/file"):
            return httpx.Response(200, json={"url": "https://files.test/ev.zip"})
        buffer = io.BytesIO()
        with zipfile.ZipFile(buffer, "w") as z:
            z.writestr("a.txt", "x")
        return httpx.Response(200, content=buffer.getvalue())

    return httpx.Client(transport=httpx.MockTransport(handler))


def test_download_valuation_keeps_only_the_newest_export(tmp_path: Path):
    old = tmp_path / "valuation" / "EV_108_EVIDENCA_VREDNOTENJA_20261031.zip"
    old.parent.mkdir()
    old.write_bytes(b"")
    with valuation_transport() as client:
        path = download_valuation(client, tmp_path, 108)
    assert path == tmp_path / "valuation" / "EV_108_EVIDENCA_VREDNOTENJA_20261107.zip"
    assert not old.exists()


def test_download_valuation_skips_an_export_already_loaded(tmp_path: Path):
    with valuation_transport() as client:
        assert download_valuation(client, tmp_path, 108, loaded=date(2026, 11, 7)) is None
    assert not (tmp_path / "valuation").exists()


def test_download_valuation_fails_when_gurs_has_no_export(tmp_path: Path):
    with valuation_transport("ERROR") as client, pytest.raises(RuntimeError, match="not ready"):
        download_valuation(client, tmp_path, 108)


def test_load_valuation_skips_a_municipality_already_at_this_export(tmp_path: Path):
    connection = MagicMock()
    connection.execute.return_value.fetchone.return_value = (date(2026, 11, 7),)
    assert load_valuation(connection, tmp_path / "EV_108_EVIDENCA_VREDNOTENJA_20261107.zip", 108) == 0
    connection.transaction.assert_not_called()


def test_sync_valuation_keeps_other_municipalities_when_one_fails(tmp_path: Path):
    connection = MagicMock()
    connection.execute.return_value.__iter__.return_value = iter([(1,), (2,), (3,)])

    def download(_client, _dir, municipality, _loaded=None):
        if municipality == 2:
            raise httpx.ConnectError("down")
        return tmp_path / f"EV_{municipality}_EVIDENCA_VREDNOTENJA_20261107.zip"

    with (
        patch("real_estate_etl.registers.download_valuation", side_effect=download),
        patch("real_estate_etl.registers.load_valuation", return_value=5),
        patch("real_estate_etl.registers.VALUATION_FAILURE_SHARE", 0.5),
    ):
        assert sync_valuation(connection, MagicMock(), tmp_path) == 10
    assert connection.rollback.call_count == 1


def test_sync_valuation_fails_when_too_many_municipalities_fail(tmp_path: Path):
    connection = MagicMock()
    connection.execute.return_value.__iter__.return_value = iter([(1,), (2,)])
    with (
        patch("real_estate_etl.registers.download_valuation", side_effect=httpx.ConnectError("down")),
        pytest.raises(RuntimeError, match="2 of 2"),
    ):
        sync_valuation(connection, MagicMock(), tmp_path)


# --------------------------------------------------------------------------- floods

FLOOD_FIELDS = [("ID_REG_PV", 10), ("PV_ID", 50), ("DATP_ZAC", 8)]


def dbf(rows: list[dict[str, str]], updated: date = date(2026, 10, 26)) -> bytes:
    record_length = 1 + sum(length for _, length in FLOOD_FIELDS)
    header_length = 32 + 32 * len(FLOOD_FIELDS) + 1
    out = bytearray(struct.pack("<BBBBIHH20x", 3, updated.year - 1900, updated.month, updated.day, len(rows),
                                header_length, record_length))
    for name, length in FLOOD_FIELDS:
        out += name.encode().ljust(11, b"\0") + b"C" + b"\0" * 4 + bytes([length, 0]) + b"\0" * 14
    out += b"\r"
    for row in rows:
        out += b" " + b"".join(str(row.get(name, "")).encode().ljust(length)[:length] for name, length in FLOOD_FIELDS)
    return bytes(out)


def polygon_record(rings: list[list[tuple[float, float]]], kind: int = 5) -> bytes:
    points = [point for ring in rings for point in ring]
    offsets, total = [], 0
    for ring in rings:
        offsets.append(total)
        total += len(ring)
    content = struct.pack("<i4d", kind, 0, 0, 0, 0) + struct.pack("<ii", len(rings), len(points))
    content += struct.pack(f"<{len(rings)}i", *offsets)
    content += b"".join(struct.pack("<2d", *point) for point in points)
    if kind == 15:
        content += struct.pack("<2d", 0, 0) + struct.pack(f"<{len(points)}d", *([0.0] * len(points)))
    return content


def shp(records: list[bytes | None]) -> bytes:
    out = bytearray(100)
    for number, record in enumerate(records, start=1):
        content = record if record is not None else struct.pack("<i", 0)
        out += struct.pack(">ii", number, len(content) // 2) + content
    return bytes(out)


SQUARE = [(0.0, 0.0), (0.0, 10.0), (10.0, 10.0), (10.0, 0.0), (0.0, 0.0)]
HOLE = [(2.0, 2.0), (4.0, 2.0), (4.0, 4.0), (2.0, 4.0), (2.0, 2.0)]


def test_iter_polygons_writes_every_ring_and_keeps_null_shapes_aligned():
    data = shp([polygon_record([SQUARE, HOLE]), None, polygon_record([SQUARE], kind=15)])
    rings = list(iter_polygons(io.BytesIO(data)))
    assert rings[0] == ("MULTILINESTRING((0.0 0.0, 0.0 10.0, 10.0 10.0, 10.0 0.0, 0.0 0.0), "
                        "(2.0 2.0, 4.0 2.0, 4.0 4.0, 2.0 4.0, 2.0 2.0))")
    assert rings[1] is None
    assert rings[2].startswith("MULTILINESTRING((0.0 0.0")


def test_iter_polygons_rejects_other_shape_types():
    point = struct.pack("<i2d", 1, 1.0, 1.0)
    with pytest.raises(ValueError, match="not a polygon"):
        list(iter_polygons(io.BytesIO(shp([point]))))


def flood_archive(path: Path, rows, records, updated=date(2026, 10, 26)) -> Path:
    with zipfile.ZipFile(path, "w") as z:
        z.writestr("IKRPN_PV.dbf", dbf(rows, updated))
        z.writestr("IKRPN_PV.shp", shp(records))
        z.writestr("IKRPN_PV.prj", "PROJCS[...]")
    return path


def test_dbf_day_rejects_placeholder_dates():
    assert _dbf_day("20180411") == "2018-04-11"
    assert _dbf_day("00000000") is None
    assert _dbf_day("") is None


def test_flood_rows_pair_attributes_with_polygons(tmp_path: Path):
    path = flood_archive(tmp_path / "DRSV_IKRPN_PV.zip",
                         [{"ID_REG_PV": "1", "PV_ID": "IKRPN_PV_1", "DATP_ZAC": "20180411"},
                          {"ID_REG_PV": "2", "PV_ID": "IKRPN_PV_2", "DATP_ZAC": ""}],
                         [polygon_record([SQUARE]), None])
    rows = list(flood_rows(path, "Pv"))
    assert len(rows) == 1
    assert rows[0][:3] == ("Pv", "IKRPN_PV_1", "2018-04-11")
    assert rows[0][3].startswith("MULTILINESTRING(")
    assert rows[0][4] == date(2026, 10, 26)
    with zipfile.ZipFile(path) as archive, archive.open("IKRPN_PV.dbf") as handle:
        assert dbf_date(handle) == date(2026, 10, 26)


def test_flood_rows_fail_on_a_record_count_mismatch(tmp_path: Path):
    path = flood_archive(tmp_path / "DRSV_IKRPN_PV.zip", [{"PV_ID": "a"}], [polygon_record([SQUARE])] * 2)
    with pytest.raises(ValueError, match=r"shorter|longer"):
        list(flood_rows(path, "Pv"))


def test_load_floods_skips_layers_already_loaded(tmp_path: Path):
    path = flood_archive(tmp_path / "DRSV_IKRPN_PV.zip", [{"PV_ID": "a"}], [polygon_record([SQUARE])])
    connection = MagicMock()
    connection.execute.return_value.fetchone.return_value = (date(2026, 10, 26),)
    assert load_floods(connection, {"Pv": path}, path) == 0
    connection.transaction.assert_not_called()


# --------------------------------------------------------------------------- orchestration

def test_one_failing_register_keeps_the_others(tmp_path: Path):
    connection = MagicMock()
    with (
        patch("real_estate_etl.registers.sync_energy_certificates", return_value=70000),
        patch("real_estate_etl.registers.sync_valuation", side_effect=httpx.ConnectError("down")),
        patch("real_estate_etl.registers.sync_floods", return_value=720000),
    ):
        report = sync_registers(connection, tmp_path, client=MagicMock())
    assert report.counts == {"energy_certificates": 70000, "drsv_floods": 720000}
    assert "gurs_valuation" in report.failures
