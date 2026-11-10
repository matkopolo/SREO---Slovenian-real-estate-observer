"""One HTTP policy for every public source: timeouts, bounded retries and atomic downloads.

Retries cover transient failures only: transport errors (connection resets, timeouts)
and the HTTP statuses that mean "try again later" (408, 425, 429 and 5xx). Client
errors such as 400 or 404 come from a wrong query and fail immediately.
"""

from __future__ import annotations

import logging
import time
import zipfile
from collections.abc import Callable
from pathlib import Path
from typing import Any, TypeVar

import httpx
from tenacity import RetryCallState, Retrying, retry_if_exception, stop_after_attempt, wait_exponential

from .settings import MAX_DOWNLOAD_ATTEMPTS, USER_AGENT

logger = logging.getLogger(__name__)

T = TypeVar("T")

#: ``read`` is the longest silence between two received bytes, not a total duration,
#: so it also bounds a stalled multi-hundred-megabyte download. GURS prepares some
#: archives on request and can take minutes before the first byte.
DEFAULT_TIMEOUT = httpx.Timeout(180, connect=30)
DOWNLOAD_CHUNK_BYTES = 1 << 20
RETRYABLE_STATUSES = frozenset({408, 425, 429})


class InvalidDownload(ValueError):
    """A completed download failed validation (for example, it is not a ZIP archive)."""


def create_client(timeout: httpx.Timeout = DEFAULT_TIMEOUT) -> httpx.Client:
    """Return a client with the shared timeout, redirect and User-Agent policy."""
    return httpx.Client(timeout=timeout, follow_redirects=True, headers={"User-Agent": USER_AGENT})


def is_transient(error: BaseException) -> bool:
    """True for errors that a later attempt can plausibly fix."""
    if isinstance(error, httpx.TransportError):
        return True
    if isinstance(error, httpx.HTTPStatusError):
        status = error.response.status_code
        return status in RETRYABLE_STATUSES or status >= 500
    return False


def with_retries(
    operation: Callable[[], T],
    label: str,
    *,
    max_attempts: int = MAX_DOWNLOAD_ATTEMPTS,
    sleep: Callable[[float], None] = time.sleep,
) -> T:
    """Run ``operation`` with exponential backoff (1 s … 16 s) on transient errors only."""

    def before_sleep(state: RetryCallState) -> None:
        error = state.outcome.exception() if state.outcome else None
        logger.warning(
            "Transient %s error (%s: %s); retry %s/%s in %.0fs",
            label,
            type(error).__name__,
            error,
            state.attempt_number,
            max_attempts - 1,
            state.next_action.sleep if state.next_action else 0,
        )

    retryer = Retrying(
        stop=stop_after_attempt(max_attempts),
        wait=wait_exponential(multiplier=1, min=1, max=16),
        retry=retry_if_exception(is_transient),
        before_sleep=before_sleep,
        reraise=True,
        sleep=sleep,
    )
    return retryer(operation)


def fetch_json(
    client: httpx.Client,
    url: str,
    label: str,
    *,
    body: dict[str, Any] | None = None,
    max_attempts: int = MAX_DOWNLOAD_ATTEMPTS,
    sleep: Callable[[float], None] = time.sleep,
) -> Any:
    """GET (or POST ``body`` as JSON) and decode a JSON response, with status checks and retries."""

    def request() -> Any:
        response = client.get(url) if body is None else client.post(url, json=body)
        response.raise_for_status()
        return response.json()

    return with_retries(request, label, max_attempts=max_attempts, sleep=sleep)


def fetch_text(
    client: httpx.Client,
    url: str,
    label: str,
    *,
    max_attempts: int = MAX_DOWNLOAD_ATTEMPTS,
    sleep: Callable[[float], None] = time.sleep,
) -> str:
    """GET a text response, with status checks and retries."""

    def request() -> str:
        response = client.get(url)
        response.raise_for_status()
        return response.text

    return with_retries(request, label, max_attempts=max_attempts, sleep=sleep)


def download_file(
    client: httpx.Client,
    url: str,
    target: Path,
    *,
    validate: Callable[[Path], bool] | None = zipfile.is_zipfile,
    chunk_bytes: int = DOWNLOAD_CHUNK_BYTES,
) -> Path:
    """Stream ``url`` to ``target`` atomically.

    Bytes go to ``<target>.part``, which is validated and then renamed over the target.
    The partial file is removed on every failure, so an interrupted download never
    leaves a large truncated file behind.
    """
    target.parent.mkdir(parents=True, exist_ok=True)
    temporary = target.with_name(target.name + ".part")
    try:
        with client.stream("GET", url) as response:
            response.raise_for_status()
            with temporary.open("wb") as output:
                for chunk in response.iter_bytes(chunk_bytes):
                    output.write(chunk)
        if validate is not None and not validate(temporary):
            raise InvalidDownload(f"downloaded file failed validation: {target.name}")
        temporary.replace(target)
    finally:
        temporary.unlink(missing_ok=True)
    return target
