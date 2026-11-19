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


def test_concurrent_downloads_of_the_same_target_use_distinct_partial_files(tmp_path: Path):
    """Two processes downloading one archive must never share a .part file (the second would truncate the first)."""
    import threading

    payload = tmp_path / "payload.zip"
    with zipfile.ZipFile(payload, "w") as output:
        output.writestr("a.csv", "x\n")
    content = payload.read_bytes()
    target = tmp_path / "out" / "archive.zip"
    partials_seen = set()
    started = threading.Barrier(2, timeout=5)

    class Slow(httpx.SyncByteStream):
        def __iter__(self):
            started.wait()
            yield content[:10]
            partials_seen.update(p.name for p in target.parent.glob("*.part"))
            yield content[10:]

    def download() -> None:
        with client_for(lambda _request: httpx.Response(200, stream=Slow())) as client:
            http_client.download_file(client, "https://x.test/a.zip", target)

    threads = [threading.Thread(target=download) for _ in range(2)]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join()

    assert len(partials_seen) == 2
    assert zipfile.is_zipfile(target)
    assert list(target.parent.iterdir()) == [target]


def test_downloads_beyond_the_size_cap_are_rejected_and_cleaned_up(tmp_path: Path):
    target = tmp_path / "archive.zip"
    with (
        client_for(lambda _request: httpx.Response(200, content=b"x" * 2048)) as client,
        pytest.raises(http_client.DownloadTooLarge, match="exceeds 1024 bytes"),
    ):
        http_client.download_file(client, "https://x.test/a.zip", target, validate=None, max_bytes=1024)
    with (
        client_for(lambda _request: httpx.Response(200, headers={"content-length": "4096"}, content=b"")) as client,
        pytest.raises(http_client.DownloadTooLarge, match="Content-Length 4096"),
    ):
        http_client.download_file(client, "https://x.test/a.zip", target, validate=None, max_bytes=1024)
    assert list(tmp_path.iterdir()) == []


def test_request_errors_are_not_retried_as_transient():
    request = httpx.Request("GET", "file:///etc/passwd")
    assert not http_client.is_transient(httpx.UnsupportedProtocol("unsupported", request=request))
    assert not http_client.is_transient(httpx.ProxyError("proxy", request=request))
    assert http_client.is_transient(httpx.RemoteProtocolError("closed", request=request))
