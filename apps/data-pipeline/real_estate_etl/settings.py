"""Stable configuration and dataset metadata shared by every pipeline module.

Values that an environment variable can override are exposed as functions that read
the variable when called (``raw_data_dir()``, ``rpe_boundaries_seed_url()``, ...), so a
test can ``monkeypatch.setenv`` them and no module caches the environment at import.
"""

from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path

API_BASE = "https://ipi.eprostor.gov.si/jgp-service-api"
RPE_OGC_BASE = "https://ipi.eprostor.gov.si/wfs-si-gurs-rpe/ogc/features"
#: Fallback for a first install while the GURS boundary service is unavailable: the same RPE
#: boundaries (GURS, CC BY 4.0) as the project last synchronised them, published as a release
#: asset. Only used when the database has no boundaries yet; the next refresh takes GURS again.
DEFAULT_RPE_BOUNDARIES_SEED_URL = (
    "https://github.com/matkopolo/SREO---Slovenian-real-estate-observer/releases/download/"
    "rpe-boundaries/rpe-boundaries.zip"
)
DEFAULT_DATABASE_URL = "postgresql://real_estate:real_estate@localhost:5432/real_estate"

#: Directory for downloaded source archives. The container image creates and owns
#: ``/data/raw`` (the ``pipeline_data`` volume); override it with ``RAW_DATA_DIR`` for local runs.
DEFAULT_RAW_DATA_DIR = Path("/data/raw")
#: DRSV publishes the flood layers from this folder. The host serves no TLS (checked in
#: November 2026), so the download is plain HTTP; the archives are validated as ZIPs and
#: their Shapefile and dBASE contents are bounds-checked before anything reaches PostgreSQL.
DEFAULT_DRSV_FLOOD_BASE_URL = "http://www.statika.evode.gov.si/fileadmin/vodkat/"

USER_AGENT = "real-estate-etl/1.0"
AVAILABLE_THREADS = os.cpu_count() or 1
DEFAULT_WORKERS = min(6, AVAILABLE_THREADS)
MAX_DOWNLOAD_ATTEMPTS = 5
#: Largest single download accepted (the national building snapshot is about 700 MB).
MAX_DOWNLOAD_BYTES = 4 << 30
#: Largest ZIP member read into memory at once (the inner building archive is about 60 MB
#: compressed; streamed members have no such limit).
MAX_ZIP_MEMBER_BYTES = 512 << 20

#: Seed shared by model selection, production fits, Isolation Forest and index bootstraps.
MODEL_RANDOM_SEED = 20260723

#: psycopg/libpq keepalive parameters for the long-lived maintenance connection: a worker
#: whose host vanishes would otherwise keep the session-level advisory lock until the OS
#: keepalive timeout (two hours on Linux) and every manual command would fail with
#: "already running" meanwhile.
CONNECTION_KEEPALIVES = {
    "keepalives": 1,
    "keepalives_idle": 60,
    "keepalives_interval": 10,
    "keepalives_count": 5,
}


def raw_data_dir() -> Path:
    """The download directory: ``$RAW_DATA_DIR`` or :data:`DEFAULT_RAW_DATA_DIR`."""
    return Path(os.getenv("RAW_DATA_DIR") or DEFAULT_RAW_DATA_DIR)


def rpe_boundaries_seed_url() -> str:
    """The boundary seed archive URL: ``$RPE_BOUNDARIES_SEED_URL`` or the published release asset."""
    return os.getenv("RPE_BOUNDARIES_SEED_URL") or DEFAULT_RPE_BOUNDARIES_SEED_URL


def energy_certificates_url() -> str | None:
    """``$ENERGY_CERTIFICATES_URL`` pins one register export instead of the link on the register page."""
    return os.getenv("ENERGY_CERTIFICATES_URL") or None


def drsv_flood_base_url() -> str:
    """The DRSV download folder: ``$DRSV_FLOOD_BASE_URL`` or :data:`DEFAULT_DRSV_FLOOD_BASE_URL`."""
    return os.getenv("DRSV_FLOOD_BASE_URL") or DEFAULT_DRSV_FLOOD_BASE_URL


@dataclass(frozen=True)
class NationalDataset:
    product_id: int
    archive_code: str
    start_year: int


NATIONAL_DATASETS = {
    "sales": NationalDataset(product_id=321, archive_code="KPP", start_year=2007),
    "rent": NationalDataset(product_id=322, archive_code="NP", start_year=2013),
}

SALES_START_YEAR = NATIONAL_DATASETS["sales"].start_year
RENT_START_YEAR = NATIONAL_DATASETS["rent"].start_year
