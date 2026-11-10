import zipfile
from pathlib import Path
from unittest.mock import Mock

import httpx
import pytest

from real_estate_etl import http_client


def client_for(handler) -> httpx.Client:
    return httpx.Client(transport=httpx.MockTransport(handler))


def test_transient_statuses_are_retried_then_succeed(caplog):
    responses = iter([httpx.Response(503), httpx.Response(429), httpx.Response(200, json={"ok": True})])
    sleep = Mock()
    with client_for(lambda _request: next(responses)) as client:
        assert http_client.fetch_json(client, "https://x.test/a", "test request", sleep=sleep) == {"ok": True}
    assert sleep.call_count == 2
    assert "Transient test request error" in caplog.text


@pytest.mark.parametrize("status", [400, 404])
def test_client_errors_fail_immediately(status):
    calls = []

    def handler(request):
        calls.append(request)
        return httpx.Response(status)

    sleep = Mock()
    with client_for(handler) as client, pytest.raises(httpx.HTTPStatusError):
        http_client.fetch_json(client, "https://x.test/a", "test request", sleep=sleep)
    assert len(calls) == 1
    sleep.assert_not_called()


def test_retries_are_bounded():
    sleep = Mock()
    with client_for(lambda _request: httpx.Response(500)) as client, pytest.raises(httpx.HTTPStatusError):
        http_client.fetch_text(client, "https://x.test/a", "test", max_attempts=3, sleep=sleep)
    assert sleep.call_count == 2


def test_post_sends_json_body():
    def handler(request):
        assert request.method == "POST"
        return httpx.Response(200, json={"echo": request.read().decode()})

    with client_for(handler) as client:
        result = http_client.fetch_json(client, "https://x.test/a", "test", body={"query": []})
    assert result == {"echo": '{"query":[]}'}


def test_download_replaces_target_atomically(tmp_path: Path):
    payload = tmp_path / "payload.zip"
    with zipfile.ZipFile(payload, "w") as output:
        output.writestr("a.csv", "x\n")
    target = tmp_path / "out" / "archive.zip"
    with client_for(lambda _request: httpx.Response(200, content=payload.read_bytes())) as client:
        http_client.download_file(client, "https://x.test/a.zip", target)
    assert zipfile.is_zipfile(target)
    assert not (target.parent / "archive.zip.part").exists()


def test_invalid_download_leaves_no_partial_file(tmp_path: Path):
    target = tmp_path / "archive.zip"
    with (
        client_for(lambda _request: httpx.Response(200, content=b"<html>error</html>")) as client,
        pytest.raises(http_client.InvalidDownload),
    ):
        http_client.download_file(client, "https://x.test/a.zip", target)
    assert list(tmp_path.iterdir()) == []


def test_interrupted_download_leaves_no_partial_file(tmp_path: Path):
    class Broken(httpx.SyncByteStream):
        def __iter__(self):
            yield b"PK partial"
            raise httpx.ReadError("connection reset")

    target = tmp_path / "archive.zip"
    with (
        client_for(lambda _request: httpx.Response(200, stream=Broken())) as client,
        pytest.raises(httpx.ReadError),
    ):
        http_client.download_file(client, "https://x.test/a.zip", target)
    assert list(tmp_path.iterdir()) == []


def test_transient_classification():
    request = httpx.Request("GET", "https://x.test")
    assert http_client.is_transient(httpx.ConnectTimeout("slow", request=request))
    assert http_client.is_transient(
        httpx.HTTPStatusError("x", request=request, response=httpx.Response(502, request=request))
    )
    assert not http_client.is_transient(
        httpx.HTTPStatusError("x", request=request, response=httpx.Response(404, request=request))
    )
    assert not http_client.is_transient(ValueError("bad json"))
