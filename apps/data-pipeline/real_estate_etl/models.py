"""Typed values shared across importer and pipeline modules."""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path


@dataclass
class ImportStats:
    #: Time spent reading CSV members and streaming them into PostgreSQL with COPY.
    member_import_seconds: float = 0.0
    #: Remaining database time: source registration, snapshot deletion, codebook upserts.
    database_seconds: float = 0.0
    rows: int = 0
    codebook_rows: int = 0
    unchanged: bool = False
    superseded_transactions: int = 0


@dataclass(frozen=True)
class ArchiveIdentity:
    """What a GURS ETN archive contains, derived from its file name."""

    dataset_scope: str  # "national" or "municipality"
    dataset_type: str  # "sales" or "rent"
    year: int
    municipality: int | None = None


@dataclass
class ArchiveResult:
    path: Path
    reused: bool
    download_seconds: float


@dataclass(frozen=True)
class RefreshSummary:
    imported: int
    already_imported: int
    unavailable: int
