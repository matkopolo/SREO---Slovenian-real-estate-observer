"""Stable configuration and dataset metadata shared by every pipeline module."""

from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path

API_BASE = "https://ipi.eprostor.gov.si/jgp-service-api"
RPE_OGC_BASE = "https://ipi.eprostor.gov.si/wfs-si-gurs-rpe/ogc/features"
#: Fallback for a first install while the GURS boundary service is unavailable: the same RPE
#: boundaries (GURS, CC BY 4.0) as the project last synchronised them, published as a release
#: asset. Only used when the database has no boundaries yet; the next refresh takes GURS again.
RPE_BOUNDARIES_SEED_URL = os.getenv(
    "RPE_BOUNDARIES_SEED_URL",
    "https://github.com/matkopolo/SREO---Slovenian-real-estate-observer/releases/download/rpe-boundaries/rpe-boundaries.zip",
)
DEFAULT_DATABASE_URL = "postgresql://real_estate:real_estate@localhost:5432/real_estate"

#: Directory for downloaded source archives. The container image creates and owns
#: ``/data/raw`` (the ``pipeline_data`` volume); override it for local runs.
RAW_DATA_DIR = Path(os.getenv("RAW_DATA_DIR", "/data/raw"))

USER_AGENT = "real-estate-etl/1.0"
AVAILABLE_THREADS = os.cpu_count() or 1
DEFAULT_WORKERS = min(6, AVAILABLE_THREADS)
MAX_DOWNLOAD_ATTEMPTS = 5

#: Seed shared by model selection, production fits, Isolation Forest and index bootstraps.
MODEL_RANDOM_SEED = 20260723


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
