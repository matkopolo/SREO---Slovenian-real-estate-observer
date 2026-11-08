import io
import struct
import zipfile
from datetime import date

from real_estate_etl.construction import (
    building_rows,
    codebook_rows,
    iter_dbf,
    iter_points,
    permit_observations,
    source_date,
    ted_row,
)

FIELDS = [("EID_STAVBA", 40), ("KO_ID", 8), ("ST_STAVBE", 8), ("STEVILO_ET", 4), ("STEVILO_ST", 4),
          ("STEVILO_PO", 4), ("TIP_STAVBE", 4), ("NOSILNA_KO", 4), ("STATUS_VPI", 3), ("LETO_IZGRA", 6),
          ("BRUTO_TLOR", 12), ("EID_OBCINA", 40), ("DATUM_SYS", 8)]


def dbf(rows: list[dict[str, str]]) -> bytes:
    record_length = 1 + sum(length for _, length in FIELDS)
    header_length = 32 + 32 * len(FIELDS) + 1
    out = bytearray(struct.pack("<BBBBIHH20x", 3, 126, 1, 1, len(rows), header_length, record_length))
    for name, length in FIELDS:
        out += name.encode().ljust(11, b"\0") + b"C" + b"\0" * 4 + bytes([length, 0]) + b"\0" * 14
    out += b"\r"
    for row in rows:
        out += b" " + b"".join(str(row.get(name, "")).encode().ljust(length)[:length] for name, length in FIELDS)
    return bytes(out)


def shp(points: list[tuple[float, float] | None]) -> bytes:
    out = bytearray(100)
    for number, point in enumerate(points, start=1):
        content = struct.pack("<i2d", 1, *point) if point else struct.pack("<i", 0)
        out += struct.pack(">ii", number, len(content) // 2) + content
    return bytes(out)


def archive(rows, points) -> zipfile.ZipFile:
    inner = io.BytesIO()
    with zipfile.ZipFile(inner, "w") as z:
        z.writestr("KN_SLO_STAVBE_SLO_STAVBE_tocka.dbf", dbf(rows))
        z.writestr("KN_SLO_STAVBE_SLO_STAVBE_tocka.shp", shp(points))
    outer = io.BytesIO()
    with zipfile.ZipFile(outer, "w") as z:
        z.writestr("KN_SLO_STAVBE_SLO_stavbe_20261101.zip", inner.getvalue())
        z.writestr("sifranti/TIPI_STAVB.CSV", "id,sifra,nazivSl\n1,1,samostoječa stavba\n")
        z.writestr("KN_SLO_STAVBE_SLO_imetniki_lastnistva_20261101.csv", "owner data that must never be read\n")
    return zipfile.ZipFile(io.BytesIO(outer.getvalue()))


BUILDING = {"EID_STAVBA": "100200000250893316", "KO_ID": "2551.0", "ST_STAVBE": "1.0", "STEVILO_ET": "2",
            "STEVILO_ST": "4", "STEVILO_PO": "0", "TIP_STAVBE": "1", "NOSILNA_KO": "5", "STATUS_VPI": "4",
            "LETO_IZGRA": "2024.0", "BRUTO_TLOR": "************", "EID_OBCINA": "110200000110277170",
            "DATUM_SYS": "20250717"}


def test_dbf_and_points_stream_in_file_order():
    rows = list(iter_dbf(io.BytesIO(dbf([BUILDING, {**BUILDING, "EID_STAVBA": "2"}]))))
    assert [row["EID_STAVBA"] for row in rows] == ["100200000250893316", "2"]
    assert list(iter_points(io.BytesIO(shp([(437356.56, 41931.08), None])))) == [(437356.56, 41931.08), None]


def test_building_rows_parse_numbers_overflow_and_geometry():
    rows = list(building_rows(archive([BUILDING], [(437356.56, 41931.08)]), date(2026, 11, 1)))
    assert rows == [("100200000250893316", 2551, 1, 2024, 2, 4, 0, 1, 5, 4, None, "110200000110277170",
                     "2025-07-17", "SRID=3794;POINT(437356.56 41931.08)", date(2026, 11, 1))]


def test_building_rows_skip_records_without_identity_and_keep_null_shapes():
    rows = list(building_rows(archive([{**BUILDING, "KO_ID": ""}, BUILDING], [(1.0, 2.0), None]), date(2026, 11, 1)))
    assert len(rows) == 1 and rows[0][13] is None


def test_codebooks_and_snapshot_date():
    assert codebook_rows(archive([BUILDING], [None])) == [("building_type", 1, "samostoječa stavba")]
    assert source_date("KN_SLO_STAVBE_SLO_20261101.zip") == date(2026, 11, 1)


def test_ted_notice_mapping():
    row = ted_row({
        "publication-number": "3680-2026", "notice-type": "can-standard", "publication-date": "2026-01-08+01:00",
        "notice-title": {"slv": "Slovenija – Gradbena dela – UKC Maribor"}, "buyer-name": {"slv": ["UKC MARIBOR"]},
        "winner-name": {"slv": ["KLEPARSTVO TISAJ d.o.o."]}, "place-of-performance-subdiv-lot": ["SI032"],
        "total-value": [125000.0], "total-value-cur": ["EUR"],
    })
    assert row[:9] == ("3680-2026", "can-standard", "2026-01-08", "Slovenija – Gradbena dela – UKC Maribor",
                       "UKC MARIBOR", ["KLEPARSTVO TISAJ d.o.o."], ["SI032"], 125000.0, "EUR")
    assert ted_row({"publication-number": "1-2026"}) is None


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
