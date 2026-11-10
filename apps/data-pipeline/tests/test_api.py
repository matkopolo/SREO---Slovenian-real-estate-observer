import zipfile
from pathlib import Path
from unittest.mock import Mock, patch

import httpx
import pytest

from real_estate_etl.api import DatasetUnavailable, JGPClient


def test_fetch_retries_transient_connection_errors(tmp_path: Path):
    downloaded = tmp_path / "result.zip"
    request = httpx.Request("GET", "https://example.test/data")
    transient = httpx.ReadError("connection reset", request=request)
    sleep = Mock()
    client = JGPClient(tmp_path, sleep=sleep)
    with (
        patch.object(client, "_fetch_municipality_once", side_effect=[transient, transient, downloaded]) as fetch_once,
    ):
        result = client.fetch_municipality(3, 2023)

    assert result == downloaded
    assert fetch_once.call_count == 3
    assert [call.args[0] for call in sleep.call_args_list] == [1, 2]


def test_fetch_does_not_retry_unavailable_dataset(tmp_path: Path):
    sleep = Mock()
    client = JGPClient(tmp_path, sleep=sleep)
    with (
        patch.object(client, "_fetch_municipality_once", side_effect=DatasetUnavailable("missing")) as fetch_once,
        pytest.raises(DatasetUnavailable),
    ):
        client.fetch_municipality(3, 2023)

    fetch_once.assert_called_once()
    sleep.assert_not_called()


def test_client_closes_every_thread_pool(tmp_path: Path):
    client = JGPClient(tmp_path)
    pool = client._http()
    assert client._http() is pool
    client.close()
    assert pool.is_closed


def test_national_fetch_downloads_prepared_archive(tmp_path: Path):
    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path.endswith("/result"):
            return httpx.Response(200, json={"statusText": "OK", "file": {"name": "ETN_SLO_2020_KPP_x.zip"}})
        if request.url.path.endswith("/file"):
            return httpx.Response(200, json={"url": "https://files.test/archive.zip"})
        payload = Path(tmp_path / "payload.zip")
        with zipfile.ZipFile(payload, "w") as output:
            output.writestr("a.csv", "x\n")
        return httpx.Response(200, content=payload.read_bytes())

    with JGPClient(tmp_path / "raw", sleep=Mock()) as client:
        client._local.client = httpx.Client(transport=httpx.MockTransport(handler))
        client._clients.append(client._local.client)
        path = client.fetch_national("sales", 2020)

    assert path == tmp_path / "raw" / "ETN_SLO_2020_KPP_x.zip"
    assert zipfile.is_zipfile(path)
