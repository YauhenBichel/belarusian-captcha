"""The contract every Python demo backend keeps (Flask, FastAPI), the same as the Node backends'
(demo/backends/contract.ts), run over real HTTP against a recorded siteverify.

A backend's test subclasses :class:`DemoBackendContract` and :class:`unittest.TestCase` and
implements ``start_backend``. The real API is exercised by scripts/compose-smoke.ts against every
backend in compose.yaml.

  GET  /             the built demo page, with x-content-type-options and no x-powered-by
  GET  /healthz      {"ok": true}
  POST /demo/submit  application/x-www-form-urlencoded ``bc-response`` (+ ``comment``):
    200 {accepted: true,  verify}   the token is valid, unspent and for this site and action
    400 {accepted: false, verify}   the API refused it (replay, expired, wrong site, ...)
    400 {accepted: false, error: "missing-token"}   no usable token; the API is not called
    503 {accepted: false, verify}   the API could not be reached (fail closed, D11)
"""

from __future__ import annotations

import http.client
import json
import socket
import tempfile
import threading
import unittest
import urllib.parse
from collections.abc import Callable
from dataclasses import dataclass, field
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any

SUBMIT_PATH = "/demo/submit"
SECRET = "demo-test-secret-not-real"  # noqa: S105 - a test value
SITEKEY = "demo-sitekey-0001"
FORM = "application/x-www-form-urlencoded"

OK: dict[str, Any] = {
    "success": True,
    "challenge_ts": "2026-11-21T10:00:00Z",
    "hostname": "localhost",
    "score": 0.9,
    "action": "demo",
    "fallback": False,
    "error-codes": [],
}
SPENT: dict[str, Any] = {"success": False, "error-codes": ["timeout-or-duplicate"]}


@dataclass(frozen=True)
class ContractConfig:
    """The configuration the Python demo backends share."""

    secret: str
    api_url: str
    sitekey: str
    static_dir: str


@dataclass
class FakeApi:
    """A siteverify on 127.0.0.1 that records each call and answers with ``reply``."""

    reply: dict[str, Any]
    calls: list[tuple[str, dict[str, Any]]] = field(default_factory=list)
    url: str = ""
    _server: ThreadingHTTPServer | None = None

    def start(self) -> FakeApi:
        api = self

        class Handler(BaseHTTPRequestHandler):
            def do_POST(self) -> None:
                n = int(self.headers.get("content-length") or 0)
                api.calls.append((self.path, json.loads(self.rfile.read(n))))
                body = json.dumps(api.reply).encode()
                self.send_response(200)
                self.send_header("content-type", "application/json")
                self.send_header("content-length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)

            def log_message(self, *args: Any) -> None:
                pass

        self._server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        threading.Thread(target=self._server.serve_forever, daemon=True).start()
        self.url = f"http://127.0.0.1:{self._server.server_address[1]}"
        return self

    def stop(self) -> None:
        if self._server is not None:
            self._server.shutdown()
            self._server.server_close()


def closed_port_url() -> str:
    """A URL nothing listens on: the API is down."""
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        port = s.getsockname()[1]
    return f"http://127.0.0.1:{port}"


@dataclass(frozen=True)
class Response:
    status: int
    headers: http.client.HTTPMessage
    body: bytes

    def json(self) -> Any:
        return json.loads(self.body)


def request(
    base: str, method: str, path: str, body: bytes | None = None, ctype: str | None = None
) -> Response:
    u = urllib.parse.urlsplit(base)
    conn = http.client.HTTPConnection(u.hostname or "127.0.0.1", u.port, timeout=10)
    try:
        conn.request(method, path, body=body, headers={"content-type": ctype} if ctype else {})
        r = conn.getresponse()
        return Response(r.status, r.headers, r.read())
    finally:
        conn.close()


class DemoBackendContract:
    """The contract tests. Mix into a TestCase and implement ``start_backend``."""

    def start_backend(self, cfg: ContractConfig) -> tuple[str, Callable[[], None]]:
        """Starts the backend on 127.0.0.1 with an ephemeral port; returns (base, close)."""
        raise NotImplementedError

    def _tc(self) -> unittest.TestCase:
        if not isinstance(self, unittest.TestCase):
            raise TypeError("mix DemoBackendContract into a unittest.TestCase")
        return self

    def _start(self, api_url: str) -> str:
        tc = self._tc()
        tmp = tempfile.TemporaryDirectory()
        tc.addCleanup(tmp.cleanup)
        Path(tmp.name, "index.html").write_text("<!doctype html><title>demo</title>")
        base, close = self.start_backend(ContractConfig(SECRET, api_url, SITEKEY, tmp.name))
        tc.addCleanup(close)
        return base

    def _api(self, reply: dict[str, Any]) -> FakeApi:
        api = FakeApi(reply).start()
        self._tc().addCleanup(api.stop)
        return api

    def _submit(self, base: str, body: bytes | str, ctype: str = FORM) -> Response:
        raw = body.encode() if isinstance(body, str) else body
        return request(base, "POST", SUBMIT_PATH, raw, ctype)

    def test_serves_the_demo_page_and_a_health_check(self) -> None:
        tc = self._tc()
        base = self._start(closed_port_url())
        page = request(base, "GET", "/")
        tc.assertEqual(page.status, 200)
        tc.assertIn(b"<title>demo</title>", page.body)
        tc.assertIsNone(page.headers.get("x-powered-by"))
        tc.assertEqual(page.headers.get("x-content-type-options"), "nosniff")
        tc.assertEqual(page.headers.get("referrer-policy"), "no-referrer")
        health = request(base, "GET", "/healthz")
        tc.assertEqual(health.headers.get("cache-control"), "no-store")
        tc.assertEqual(health.json(), {"ok": True})
        tc.assertEqual(request(base, "GET", "/no-such-file").status, 404)

    def test_accepts_a_valid_token(self) -> None:
        tc = self._tc()
        api = self._api(OK)
        base = self._start(api.url)
        res = self._submit(base, urllib.parse.urlencode({"bc-response": "tok-1", "comment": "hi"}))
        tc.assertEqual(res.status, 200)
        tc.assertEqual(res.headers.get("cache-control"), "no-store")
        body = res.json()
        tc.assertIs(body["accepted"], True)
        tc.assertEqual(body["verify"]["success"], True)
        tc.assertEqual(body["verify"]["score"], 0.9)
        tc.assertEqual(body["verify"]["hostname"], "localhost")
        tc.assertEqual(len(api.calls), 1)
        path, sent = api.calls[0]
        tc.assertEqual(path, "/api/v1/siteverify")
        tc.assertEqual(sent["secret"], SECRET)
        tc.assertEqual(sent["response"], "tok-1")
        tc.assertEqual(sent["sitekey"], SITEKEY)
        tc.assertEqual(sent["action"], "demo")
        tc.assertNotIn(SECRET.encode(), res.body)

    def test_passes_a_refusal_through_as_400(self) -> None:
        tc = self._tc()
        base = self._start(self._api(SPENT).url)
        res = self._submit(base, "bc-response=tok-1")
        tc.assertEqual(res.status, 400)
        body = res.json()
        tc.assertIs(body["accepted"], False)
        tc.assertEqual(body["verify"]["error_codes"], ["timeout-or-duplicate"])
        tc.assertNotIn(SECRET.encode(), res.body)

    def test_fails_closed_with_503_when_the_api_is_down(self) -> None:
        tc = self._tc()
        base = self._start(closed_port_url())
        res = self._submit(base, "bc-response=tok-1")
        tc.assertEqual(res.status, 503)
        body = res.json()
        tc.assertIs(body["accepted"], False)
        tc.assertIs(body["verify"]["unavailable"], True)
        tc.assertEqual(body["verify"]["error_codes"], ["captcha-unavailable"])

    def test_refuses_a_form_without_a_usable_token(self) -> None:
        tc = self._tc()
        api = self._api(OK)
        base = self._start(api.url)
        forms: list[tuple[str, str, str]] = [
            ("empty form", "", FORM),
            ("no token", "comment=x", FORM),
            ("empty token", "bc-response=", FORM),
            ("oversized token", "bc-response=" + "x" * 4097, FORM),
            ("token twice", "bc-response=a&bc-response=b", FORM),
            ("JSON body", json.dumps({"bc-response": "tok-1"}), "application/json"),
            ("text body", "bc-response=tok-1", "text/plain"),
        ]
        for what, body, ctype in forms:
            with tc.subTest(what):
                res = self._submit(base, body, ctype)
                tc.assertEqual(res.status, 400)
                tc.assertEqual(res.json(), {"accepted": False, "error": "missing-token"})
        tc.assertEqual(api.calls, [])

    def test_refuses_a_body_over_16_kb_with_413(self) -> None:
        tc = self._tc()
        api = self._api(OK)
        base = self._start(api.url)
        big = urllib.parse.urlencode({"bc-response": "tok-1", "comment": "x" * 20_000})
        res = self._submit(base, big)
        tc.assertEqual(res.status, 413)
        tc.assertEqual(api.calls, [])
