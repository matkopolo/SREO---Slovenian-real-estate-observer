"""Hostile and malformed dBASE / Shapefile / ZIP inputs must raise ``ValueError`` naming the file."""

import io
import struct
import zipfile

import pytest

from real_estate_etl.shapefile import (
    dbf_date,
    iter_dbf,
    iter_points,
    iter_polygons,
    member_named,
    open_nested_zip,
    read_member,
)

FIELDS = [("PV_ID", 10), ("DATP_ZAC", 8)]


def dbf(rows, header_length=None, record_length=None):
    record_length = record_length or 1 + sum(length for _, length in FIELDS)
    header_length = header_length or 32 + 32 * len(FIELDS) + 1
    out = bytearray(struct.pack("<BBBBIHH20x", 3, 126, 1, 1, len(rows), header_length, record_length))
    for name, length in FIELDS:
        out += name.encode().ljust(11, b"\0") + b"C" + b"\0" * 4 + bytes([length, 0]) + b"\0" * 14
    out += b"\r"
    for row in rows:
        out += b" " + b"".join(str(row.get(name, "")).encode().ljust(length)[:length] for name, length in FIELDS)
    return bytes(out)


def record(content: bytes, number: int = 1, length_words: int | None = None) -> bytes:
    length = len(content) // 2 if length_words is None else length_words
    return bytes(100) + struct.pack(">ii", number, length) + content


def polygon(parts: int, points: int, coordinates: int | None = None) -> bytes:
    coordinates = points if coordinates is None else coordinates
    content = struct.pack("<i4d", 5, 0, 0, 0, 0) + struct.pack("<ii", parts, points)
    content += struct.pack(f"<{parts}i", *range(0, parts)) if parts > 0 else b""
    content += b"".join(struct.pack("<2d", float(i), float(i)) for i in range(coordinates))
    return content


def test_dbf_header_lengths_are_validated():
    with pytest.raises(ValueError, match=r"hostile\.dbf: dBASE header lengths are invalid"):
        list(iter_dbf(io.BytesIO(dbf([], header_length=20)), label="hostile.dbf"))
    with pytest.raises(ValueError, match="DBF field lengths do not match"):
        list(iter_dbf(io.BytesIO(dbf([], record_length=5)), label="hostile.dbf"))
    with pytest.raises(ValueError, match="truncated"):
        list(iter_dbf(io.BytesIO(dbf([])[:10]), label="hostile.dbf"))


def test_dbf_date_requires_a_calendar_day():
    with pytest.raises(ValueError, match=r"layer\.dbf: dBASE header date is invalid"):
        dbf_date(io.BytesIO(bytes([3, 126, 13, 1])), label="layer.dbf")
    with pytest.raises(ValueError, match="truncated"):
        dbf_date(io.BytesIO(b"\x03"), label="layer.dbf")


def test_negative_record_length_does_not_slurp_the_stream():
    data = record(polygon(1, 4), length_words=-1) + b"\0" * 1000
    with pytest.raises(ValueError, match=r"layer\.shp: Shapefile record 1 declares an invalid length -1"):
        list(iter_polygons(io.BytesIO(data), label="layer.shp"))


def test_polygon_counts_beyond_the_content_are_rejected():
    with pytest.raises(ValueError, match="declares 1 parts and 1000000 points"):
        list(iter_polygons(io.BytesIO(record(polygon(1, 1_000_000, coordinates=4))), label="layer.shp"))
    with pytest.raises(ValueError, match="declares 5 parts and 4 points"):
        list(iter_polygons(io.BytesIO(record(polygon(5, 4, coordinates=40))), label="layer.shp"))
    with pytest.raises(ValueError, match="declares -1 parts"):
        list(iter_polygons(io.BytesIO(record(polygon(0, 4) [:36] + struct.pack("<ii", -1, 4) + bytes(64))),
                           label="layer.shp"))


def test_part_offsets_must_stay_inside_the_points():
    content = struct.pack("<i4d", 5, 0, 0, 0, 0) + struct.pack("<ii", 1, 4) + struct.pack("<i", 9)
    content += b"".join(struct.pack("<2d", 0.0, 0.0) for _ in range(4))
    with pytest.raises(ValueError, match="part offsets outside its points"):
        list(iter_polygons(io.BytesIO(record(content)), label="layer.shp"))


def test_truncated_headers_and_point_records_fail():
    with pytest.raises(ValueError, match="Shapefile header is truncated"):
        list(iter_points(io.BytesIO(bytes(50)), label="points.shp"))
    with pytest.raises(ValueError, match="point record 1 is truncated"):
        list(iter_points(io.BytesIO(record(struct.pack("<i", 1) + bytes(8))), label="points.shp"))
    with pytest.raises(ValueError, match="polygon record 1 is truncated"):
        list(iter_polygons(io.BytesIO(record(struct.pack("<i", 5) + bytes(8))), label="layer.shp"))


def test_valid_streams_still_parse():
    rings = list(iter_polygons(io.BytesIO(record(polygon(1, 4))), label="layer.shp"))
    assert rings[0] is not None
    assert rings[0].startswith("MULTILINESTRING")
    assert list(iter_points(io.BytesIO(record(struct.pack("<i2d", 1, 1.5, 2.5))))) == [(1.5, 2.5)]
    assert [row["PV_ID"] for row in iter_dbf(io.BytesIO(dbf([{"PV_ID": "a"}])))] == ["a"]


def zipped(**members: bytes) -> zipfile.ZipFile:
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w") as archive:
        for name, data in members.items():
            archive.writestr(name, data)
    archive = zipfile.ZipFile(buffer)
    archive.filename = "outer.zip"
    return archive


def test_zip_members_beyond_the_size_cap_are_not_read():
    archive = zipped(**{"big.csv": b"x" * 1000})
    with pytest.raises(ValueError, match=r"outer.zip/big.csv: 1000 bytes exceeds the 100 byte limit"):
        read_member(archive, "big.csv", limit=100)
    assert read_member(archive, "big.csv", limit=1000) == b"x" * 1000


def test_zip_member_lying_about_its_size_is_rejected(monkeypatch):
    """A header that understates the member's size is caught either by the limit or by zipfile's own checks."""
    archive = zipped(**{"big.csv": b"x" * 1000})
    info = archive.getinfo("big.csv")
    monkeypatch.setattr(info, "file_size", 10)
    with pytest.raises(ValueError, match=r"outer\.zip/big\.csv"):
        read_member(archive, "big.csv", limit=100)


def test_missing_members_are_named():
    archive = zipped(**{"a.txt": b""})
    with pytest.raises(ValueError, match=r"outer.zip: no attribute table \(.dbf\) member"):
        member_named(archive, ".dbf", label="attribute table")


def test_nested_zip_is_opened_within_the_cap():
    inner = io.BytesIO()
    with zipfile.ZipFile(inner, "w") as z:
        z.writestr("x.dbf", b"data")
    archive = zipped(**{"inner.zip": inner.getvalue()})
    assert open_nested_zip(archive, "inner.zip").namelist() == ["x.dbf"]
