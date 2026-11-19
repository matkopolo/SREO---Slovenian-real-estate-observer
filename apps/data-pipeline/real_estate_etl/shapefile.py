"""Bounded readers for the dBASE tables and Shapefiles inside GURS and DRSV archives.

The files are untrusted downloads, so every length read from a header is checked
against what the stream can hold before it is used; a malformed file raises
``ValueError`` naming the archive instead of allocating what the header asks for.
"""

from __future__ import annotations

import io
import struct
import zipfile
from collections.abc import Iterator
from datetime import date
from typing import IO

from .settings import MAX_ZIP_MEMBER_BYTES

#: Shapefile shape types read here.
SHAPE_NULL, SHAPE_POINT, SHAPE_POLYGON, SHAPE_POLYGON_Z, SHAPE_POLYGON_M = 0, 1, 5, 15, 25
POLYGON_TYPES = frozenset({SHAPE_POLYGON, SHAPE_POLYGON_Z, SHAPE_POLYGON_M})
SHAPEFILE_HEADER_BYTES = 100
RECORD_HEADER_BYTES = 8
#: Shape type, bounding box, part count and point count precede a polygon's part offsets.
POLYGON_PREAMBLE_BYTES = 44
POINT_BYTES = 16
DBF_HEADER_BYTES = 32
DBF_FIELD_DESCRIPTOR_BYTES = 32
DBF_HEADER_TERMINATOR = 0x0D
DBF_DELETED_FLAG = b"*"


def read_member(archive: zipfile.ZipFile, member: str, *, limit: int = MAX_ZIP_MEMBER_BYTES) -> bytes:
    """Read one ZIP member into memory after checking its declared size against ``limit``.

    Raises:
        ValueError: When the member declares more than ``limit`` bytes, inflates beyond it,
            or fails zipfile's own size and CRC checks.
    """
    info = archive.getinfo(member)
    if info.file_size > limit:
        raise ValueError(f"{archive.filename}/{member}: {info.file_size} bytes exceeds the {limit} byte limit")
    try:
        with archive.open(member) as handle:
            data = handle.read(limit + 1)
    except zipfile.BadZipFile as error:
        raise ValueError(f"{archive.filename}/{member}: {error}") from error
    if len(data) > limit:
        raise ValueError(f"{archive.filename}/{member}: inflates beyond the {limit} byte limit")
    return data


def member_named(archive: zipfile.ZipFile, suffix: str, *, label: str) -> str:
    """The first member whose lower-cased name ends with ``suffix``.

    Raises:
        ValueError: When the archive holds no such member.
    """
    member = next((name for name in archive.namelist() if name.lower().endswith(suffix)), None)
    if member is None:
        raise ValueError(f"{archive.filename}: no {label} ({suffix}) member")
    return member


def dbf_date(stream: IO[bytes], *, label: str = "dBASE table") -> date:
    """The last-update date in a dBASE header (year since 1900, month, day).

    Raises:
        ValueError: When the header is shorter than four bytes or the date is not a calendar day.
    """
    header = stream.read(4)
    if len(header) < 4:
        raise ValueError(f"{label}: dBASE header is truncated")
    try:
        return date(1900 + header[1], header[2], header[3])
    except ValueError as error:
        raise ValueError(f"{label}: dBASE header date is invalid ({error})") from error


def iter_dbf(stream: IO[bytes], *, label: str = "dBASE table") -> Iterator[dict[str, str] | None]:
    """Stream dBASE III records as ``{field: text}``, yielding ``None`` for deleted records.

    Deleted records still occupy a slot, and the matching Shapefile still holds a shape
    for them, so the caller needs the placeholder to keep both streams aligned.

    Raises:
        ValueError: When the header, field descriptors or record count are inconsistent
            with the stream (``label`` names the file in the message).
    """
    first = stream.read(DBF_HEADER_BYTES)
    if len(first) < DBF_HEADER_BYTES:
        raise ValueError(f"{label}: dBASE header is truncated")
    records, header_length, record_length = struct.unpack("<IHH", first[4:12])
    if header_length < DBF_HEADER_BYTES + 1 or record_length < 1:
        raise ValueError(f"{label}: dBASE header lengths are invalid ({header_length}, {record_length})")
    rest = stream.read(header_length - DBF_HEADER_BYTES)
    if len(rest) < header_length - DBF_HEADER_BYTES:
        raise ValueError(f"{label}: dBASE field descriptors are truncated")
    fields: list[tuple[str, int]] = []
    for offset in range(0, len(rest), DBF_FIELD_DESCRIPTOR_BYTES):
        descriptor = rest[offset:offset + DBF_FIELD_DESCRIPTOR_BYTES]
        if not descriptor or descriptor[0] == DBF_HEADER_TERMINATOR:
            break
        if len(descriptor) < DBF_FIELD_DESCRIPTOR_BYTES:
            raise ValueError(f"{label}: dBASE field descriptor is truncated")
        try:
            name = descriptor[:11].split(b"\0")[0].decode("ascii")
        except UnicodeDecodeError as error:
            raise ValueError(f"{label}: dBASE field name is not ASCII") from error
        fields.append((name, descriptor[16]))
    if sum(length for _, length in fields) + 1 != record_length:
        raise ValueError(f"{label}: DBF field lengths do not match the record length")
    for number in range(1, records + 1):
        record = stream.read(record_length)
        if len(record) < record_length:
            raise ValueError(f"{label}: DBF ends at record {number} of {records} declared in its header")
        if record[:1] == DBF_DELETED_FLAG:
            yield None
            continue
        position, row = 1, {}
        for name, length in fields:
            row[name] = record[position:position + length].decode("utf-8", "replace").strip()
            position += length
        yield row


def _records(stream: IO[bytes], label: str) -> Iterator[tuple[int, bytes]]:
    """Yield ``(record number, content)`` for every Shapefile record after the file header."""
    header = stream.read(SHAPEFILE_HEADER_BYTES)
    if len(header) < SHAPEFILE_HEADER_BYTES:
        raise ValueError(f"{label}: Shapefile header is truncated")
    while True:
        record_header = stream.read(RECORD_HEADER_BYTES)
        if not record_header:
            return
        if len(record_header) < RECORD_HEADER_BYTES:
            raise ValueError(f"{label}: Shapefile ends inside a record header")
        number, length = struct.unpack(">ii", record_header)
        if length < 2:  # at least the four-byte shape type (lengths count 16-bit words)
            raise ValueError(f"{label}: Shapefile record {number} declares an invalid length {length}")
        content = stream.read(length * 2)
        if len(content) < length * 2:
            raise ValueError(f"{label}: Shapefile record {number} is truncated")
        yield number, content


def iter_points(stream: IO[bytes], *, label: str = "Shapefile") -> Iterator[tuple[float, float] | None]:
    """Stream Shapefile point records in file order; null and non-point shapes yield None.

    Raises:
        ValueError: When a record is truncated or declares an invalid length.
    """
    for number, content in _records(stream, label):
        kind = struct.unpack("<i", content[:4])[0]
        if kind != SHAPE_POINT:
            yield None
            continue
        if len(content) < 4 + POINT_BYTES:
            raise ValueError(f"{label}: Shapefile point record {number} is truncated")
        x, y = struct.unpack("<2d", content[4:4 + POINT_BYTES])
        yield (x, y)


def iter_polygons(stream: IO[bytes], *, label: str = "Shapefile") -> Iterator[str | None]:
    """Stream Shapefile polygon records as WKT MULTILINESTRING of their rings; null shapes yield None.

    Ring orientation decides outer rings and holes in a Shapefile; PostGIS rebuilds the areas
    from the closed rings (ST_BuildArea), so no orientation logic lives here.

    Raises:
        ValueError: When a record is not a polygon, is truncated, or declares part and point
            counts its content cannot hold.
    """
    for number, content in _records(stream, label):
        kind = struct.unpack("<i", content[:4])[0]
        if kind == SHAPE_NULL:
            yield None
            continue
        if kind not in POLYGON_TYPES:
            raise ValueError(f"{label}: Shapefile record {number} is not a polygon (type {kind})")
        if len(content) < POLYGON_PREAMBLE_BYTES:
            raise ValueError(f"{label}: Shapefile polygon record {number} is truncated")
        parts, points = struct.unpack("<ii", content[36:POLYGON_PREAMBLE_BYTES])
        needed = POLYGON_PREAMBLE_BYTES + 4 * parts + POINT_BYTES * points
        if parts < 0 or points < 0 or parts > points or needed > len(content):
            raise ValueError(
                f"{label}: Shapefile record {number} declares {parts} parts and {points} points "
                f"but holds {len(content)} bytes"
            )
        offsets = struct.unpack(f"<{parts}i", content[POLYGON_PREAMBLE_BYTES:POLYGON_PREAMBLE_BYTES + 4 * parts])
        start = POLYGON_PREAMBLE_BYTES + 4 * parts
        coordinates = struct.unpack(f"<{2 * points}d", content[start:start + POINT_BYTES * points])
        rings = []
        for index, first in enumerate(offsets):
            last = offsets[index + 1] if index + 1 < parts else points
            if not 0 <= first <= last <= points:
                raise ValueError(f"{label}: Shapefile record {number} has part offsets outside its points")
            ring = ", ".join(f"{coordinates[2 * i]} {coordinates[2 * i + 1]}" for i in range(first, last))
            if last - first >= 4:
                rings.append(f"({ring})")
        yield f"MULTILINESTRING({', '.join(rings)})" if rings else None


def open_nested_zip(archive: zipfile.ZipFile, member: str) -> zipfile.ZipFile:
    """Open a ZIP stored inside ``archive`` (bounded by :func:`read_member`)."""
    return zipfile.ZipFile(io.BytesIO(read_member(archive, member)))
