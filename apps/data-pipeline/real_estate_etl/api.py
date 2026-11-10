"""Thread-safe client for downloading public GURS JGP transaction archives."""

from __future__ import annotations

import logging
import threading
import time
import urllib.parse
from collections.abc import Callable
from pathlib import Path
from types import TracebackType
from typing import Any

import httpx

from . import http_client
from .settings import API_BASE, MAX_DOWNLOAD_ATTEMPTS, NATIONAL_DATASETS

logger = logging.getLogger(__name__)

MUNICIPALITY_PRODUCT = f"{API_BASE}/display-views/groups/131/composite-products/323"


class DatasetUnavailable(Exception):
    """The API has no prepared dataset for the requested filters."""


class JGPClient:
    """Downloads JGP archives; one HTTP connection pool per worker thread.

    Use it as a context manager (or call :meth:`close`) so every pool opened by a
    download thread is closed when the refresh ends.
    """

    def __init__(
        self,
        output_dir: Path,
        max_attempts: int = MAX_DOWNLOAD_ATTEMPTS,
        sleep: Callable[[float], None] = time.sleep,
    ):
        self.output_dir = output_dir
        self.max_attempts = max_attempts
        self._sleep = sleep
        self._local = threading.local()
        self._clients: list[httpx.Client] = []
        self._clients_lock = threading.Lock()

    def __enter__(self) -> JGPClient:
        return self

    def __exit__(
        self,
        exc_type: type[BaseException] | None,
        exc: BaseException | None,
        traceback: TracebackType | None,
    ) -> None:
        self.close()

    def close(self) -> None:
        with self._clients_lock:
            clients, self._clients = self._clients, []
        for client in clients:
            client.close()

    def _http(self) -> httpx.Client:
        client = getattr(self._local, "client", None)
        if client is None:
            client = http_client.create_client()
            self._local.client = client
            with self._clients_lock:
                self._clients.append(client)
        return client

    def _get_json(self, url: str) -> Any:
        response = self._http().get(url)
        response.raise_for_status()
        return response.json()

    def _with_retries(self, operation: Callable[[], Path], label: str) -> Path:
        return http_client.with_retries(operation, label, max_attempts=self.max_attempts, sleep=self._sleep)

    def fetch_municipality(self, municipality: int, year: int) -> Path:
        return self._with_retries(
            lambda: self._fetch_municipality_once(municipality, year),
            f"municipality={municipality} year={year} download",
        )

    def _fetch_municipality_once(self, municipality: int, year: int) -> Path:
        query = urllib.parse.urlencode({"filterParam": "OBCINE", "filterValue": municipality, "filterYear": year})
        return self._fetch_prepared(
            MUNICIPALITY_PRODUCT, query, f"municipality={municipality} year={year}"
        )

    def fetch_national(self, dataset_type: str, year: int) -> Path:
        return self._with_retries(
            lambda: self._fetch_national_once(dataset_type, year),
            f"national {dataset_type} year={year} download",
        )

    def _fetch_national_once(self, dataset_type: str, year: int) -> Path:
        product = NATIONAL_DATASETS[dataset_type]
        query = urllib.parse.urlencode({"filterParam": "DRZAVA", "filterValue": 1, "filterYear": year})
        base = f"{API_BASE}/display-views/groups/127/composite-products/{product.product_id}"
        return self._fetch_prepared(base, query, f"national {dataset_type} year={year}")

    def _fetch_prepared(self, base: str, query: str, label: str) -> Path:
        result = self._get_json(f"{base}/result?{query}")
        if result.get("statusText") != "OK" or not result.get("file"):
            raise DatasetUnavailable(f"{label} dataset is not ready: {result}")
        download = self._get_json(f"{base}/file?{query}")
        target = self.output_dir / result["file"]["name"]
        started = time.monotonic()
        path = http_client.download_file(self._http(), download["url"], target)
        logger.info("Downloaded %s: %s in %.0fs", label, path, time.monotonic() - started)
        return path
