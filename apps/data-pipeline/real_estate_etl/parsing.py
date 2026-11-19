"""Text parsers for the source files and names the pipeline receives.

Every source is untrusted input: the helpers here never raise on a malformed value
unless the docstring says so, and they never guess. A value that does not match the
documented shape of its source becomes ``None`` so the loader can decide whether the
row is usable.
"""

from __future__ import annotations

import math
import re
from datetime import UTC, date, datetime
from pathlib import PurePosixPath

#: Slovenian number text: dots group thousands, the comma is the decimal mark.
SLOVENE_DECIMAL = re.compile(r"-?(?:\d{1,3}(?:\.\d{3})+|\d+)(?:,\d+)?")
#: GURS exports and snapshots carry their date as ``_YYYYMMDD`` before the extension.
SNAPSHOT_DATE = re.compile(r"_(\d{8})\.(?:zip|csv)$")
#: A file name the pipeline will create under its data directory: one path component.
SAFE_FILE_NAME = re.compile(r"[A-Za-z0-9][A-Za-z0-9._-]*")


def gurs_number(raw: str) -> float | None:
    """A GURS CSV or dBASE number (dot decimal); ``*`` overflow markers and blanks give None."""
    raw = raw.strip()
    if not raw or raw.startswith("*"):
        return None
    try:
        value = float(raw)
    except ValueError:
        return None
    return value if math.isfinite(value) else None


def gurs_integer(raw: str) -> int | None:
    """A GURS integer that dBASE may have written as ``2551.0``; anything else gives None."""
    value = gurs_number(raw)
    return None if value is None else int(value)


def digits_integer(raw: str) -> int | None:
    """A non-negative integer written only with digits; anything else gives None."""
    raw = raw.strip()
    return int(raw) if raw.isdigit() else None


def four_digit_year(raw: str) -> int | None:
    """A ``YYYY`` year; anything else gives None."""
    raw = raw.strip()
    return int(raw) if raw.isdigit() and len(raw) == 4 else None


def slovene_decimal(raw: str) -> float | None:
    """Slovenian number text (``472.179,28``); a value in another notation gives None.

    A dot-decimal value such as ``1.5`` does not match, so it can never be read as
    1500 by mistake.
    """
    raw = raw.strip()
    if not raw:
        return None
    if not SLOVENE_DECIMAL.fullmatch(raw):
        return None
    return float(raw.replace(".", "").replace(",", "."))


def register_day(raw: str) -> date | None:
    """``DD.MM.YYYY`` as written in the energy-certificate register; anything else gives None."""
    try:
        return datetime.strptime(raw.strip(), "%d.%m.%Y").replace(tzinfo=UTC).date()
    except ValueError:
        return None


def dbf_day(raw: str) -> str | None:
    """A dBASE ``YYYYMMDD`` field as ISO text; empty and placeholder dates (``00000000``) give None."""
    raw = raw.strip()
    if len(raw) != 8 or not raw.isdigit():
        return None
    try:
        return date(int(raw[:4]), int(raw[4:6]), int(raw[6:])).isoformat()
    except ValueError:
        return None


def iso_day(raw: str) -> str | None:
    """The date part of an ISO ``YYYY-MM-DD[Thh:mm:ss]`` text; anything else gives None."""
    raw = raw.strip()[:10]
    try:
        return date.fromisoformat(raw).isoformat()
    except ValueError:
        return None


def snapshot_date(name: str) -> date:
    """The ``_YYYYMMDD`` export date in a GURS file name.

    Raises:
        ValueError: When the name carries no date or the date is not a calendar day.
    """
    match = SNAPSHOT_DATE.search(name)
    if not match:
        raise ValueError(f"No snapshot date in {name}")
    value = match.group(1)
    return date(int(value[:4]), int(value[4:6]), int(value[6:]))


def safe_file_name(raw: str, pattern: re.Pattern[str] = SAFE_FILE_NAME) -> str:
    """A server-supplied file name reduced to one safe path component.

    Args:
        raw: The name as the source published it.
        pattern: The full shape the name must match after its directories are dropped.

    Returns:
        The last path component of ``raw``.

    Raises:
        ValueError: When the name has directory parts, is hidden or does not match ``pattern``.
    """
    name = PurePosixPath(raw.replace("\\", "/")).name
    if name != raw or name.startswith(".") or not pattern.fullmatch(name):
        raise ValueError(f"Refusing unsafe file name from the source: {raw!r}")
    return name
