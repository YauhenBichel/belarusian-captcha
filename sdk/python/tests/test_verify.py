"""verify() against a real HTTP server on 127.0.0.1 (standard library only: unittest)."""

from __future__ import annotations

import json
import threading
import time
import unittest
from collections.abc import Callable
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any

from belarusian_captcha import DEFAULT_TIMEOUT, VerifyResult, verify

SECRET = "sdk-test-secret-not-real"
FIXTURES = Path(__file__).resolve().parents[3] / "tests" / "fixtures" / "siteverify.json"
SHARED: list[dict[str, Any]] = json.loads(FIXTURES.read_text(encoding="utf-8"))["cases"]

OK = {
    "success": True,
    "challenge_ts": "2026-11-20T12:00:00.000Z",
    "hostname": "site-a.test",
    "score": 0.9,
    "action": "login",
    "error-codes": [],
}


class Reply:
    """What the fake API answers: a status, a body and optional headers, after a delay."""

    def __init__(
        self,
        status: int = 200,
        body: Any = None,
        raw: bytes | None = None,
        headers: dict[str, str] | None = None,
        delay: float = 0.0,
    ) -> None:
        self.status = status
        self.raw = raw if raw is not None else json.dumps(body).encode()
        self.headers = headers or {}
        self.delay = delay


class FakeApi:
    """A siteverify endpoint that records requests and answers with `reply(request)`."""

    def __init__(self, reply: Callable[[dict[str, Any]], Reply]) -> None:
        self.requests: list[dict[str, Any]] = []
        api = self

        class Handler(BaseHTTPRequestHandler):
            def do_POST(self) -> None:
                length = int(self.headers.get("content-length", "0"))
                req = {
                    "path": self.path,
                    "headers": {k.lower(): v for k, v in self.headers.items()},
                    "body": json.loads(self.rfile.read(length) or b"null"),
                }
                api.requests.append(req)
                r = reply(req)
                time.sleep(r.delay)
                try:
                    self.send_response(r.status)
                    self.send_header("content-type", "application/json")
                    self.send_header("content-length", str(len(r.raw)))
                    for k, v in r.headers.items():
                        self.send_header(k, v)
                    self.end_headers()
                    self.wfile.write(r.raw)
                except (BrokenPipeError, ConnectionResetError):
                    pass  # the client gave up (timeout tests)

            def log_message(self, format: str, *args: Any) -> None:
                pass

        self.server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.server.daemon_threads = True
        self.url = f"http://127.0.0.1:{self.server.server_address[1]}"
        threading.Thread(
            target=self.server.serve_forever, kwargs={"poll_interval": 0.01}, daemon=True
        ).start()

    def close(self) -> None:
        self.server.shutdown()
        self.server.server_close()


class ApiTestCase(unittest.TestCase):
    def api(self, reply: Callable[[dict[str, Any]], Reply]) -> FakeApi:
        a = FakeApi(reply)
        self.addCleanup(a.close)
        return a


class SharedCases(ApiTestCase):
    """The cases the Node SDK runs too (tests/fixtures/siteverify.json)."""

    def test_shared_cases(self) -> None:
        self.assertGreater(len(SHARED), 10)
        for case in SHARED:
            with self.subTest(case["name"]):
                reply = Reply(
                    case["status"],
                    case.get("body"),
                    case["raw"].encode() if "raw" in case else None,
                )
                api = self.api(lambda _r, rep=reply: rep)  # type: ignore[misc]
                r = verify("tok", secret=SECRET, url=api.url, **case["options"])
                self.assertEqual(r.to_dict(), case["expected"])


class Request(ApiTestCase):
    def test_posts_token_secret_and_optional_fields_as_json(self) -> None:
        api = self.api(lambda _r: Reply(200, OK))
        r = verify(
            "tok",
            secret=SECRET,
            url=api.url + "/",
            remoteip="203.0.113.7",
            sitekey="sitekey-aaaa",
            action="login",
        )
        self.assertEqual(
            r,
            VerifyResult(
                success=True,
                score=0.9,
                hostname="site-a.test",
                action="login",
                challenge_ts="2026-11-20T12:00:00.000Z",
                fallback=False,
            ),
        )
        [req] = api.requests
        self.assertEqual(req["path"], "/api/v1/siteverify")
        self.assertEqual(req["headers"]["content-type"], "application/json")
        self.assertEqual(
            req["body"],
            {
                "secret": SECRET,
                "response": "tok",
                "remoteip": "203.0.113.7",
                "sitekey": "sitekey-aaaa",
                "action": "login",
            },
        )

    def test_sends_only_secret_and_response_by_default(self) -> None:
        api = self.api(lambda _r: Reply(200, OK))
        verify("tok", secret=SECRET, url=api.url)
        self.assertEqual(api.requests[0]["body"], {"secret": SECRET, "response": "tok"})

    def test_keeps_a_path_prefix_in_the_base_url(self) -> None:
        api = self.api(lambda _r: Reply(200, OK))
        verify("tok", secret=SECRET, url=api.url + "/captcha//")
        self.assertEqual(api.requests[0]["path"], "/captcha/api/v1/siteverify")

    def test_refuses_empty_missing_or_oversized_token_without_calling_the_api(self) -> None:
        api = self.api(lambda _r: Reply(200, OK))
        for token in ["", None, "x" * 4097, 42]:
            r = verify(token, secret=SECRET, url=api.url)  # type: ignore[arg-type]
            self.assertEqual(r, VerifyResult(success=False, error_codes=["invalid-input-response"]))
        self.assertEqual(api.requests, [])


class Unavailable(ApiTestCase):
    def test_does_not_follow_a_redirect_so_the_secret_stays_put(self) -> None:
        elsewhere = self.api(lambda _r: Reply(200, OK))
        api = self.api(
            lambda _r: Reply(
                307, raw=b"", headers={"location": elsewhere.url + "/api/v1/siteverify"}
            )
        )
        for fail_open in (False, True):
            r = verify("tok", secret=SECRET, url=api.url, fail_open=fail_open)
            self.assertEqual(
                r,
                VerifyResult(
                    success=fail_open, error_codes=["captcha-unavailable"], unavailable=True
                ),
            )
        self.assertEqual(elsewhere.requests, [])

    def test_times_out(self) -> None:
        api = self.api(lambda _r: Reply(200, OK, delay=2.0))
        t0 = time.monotonic()
        r = verify("tok", secret=SECRET, url=api.url, timeout=0.2)
        self.assertLess(time.monotonic() - t0, 1.5)
        self.assertEqual(r.error_codes, ["captcha-unavailable"])
        self.assertTrue(r.unavailable)
        self.assertFalse(r.success)

    def test_nothing_listening(self) -> None:
        api = self.api(lambda _r: Reply(200, OK))
        api.close()
        r = verify("tok", secret=SECRET, url=api.url, fail_open=True)
        self.assertEqual(
            r, VerifyResult(success=True, error_codes=["captcha-unavailable"], unavailable=True)
        )

    def test_an_oversized_answer(self) -> None:
        api = self.api(lambda _r: Reply(200, raw=b" " * (65 * 1024) + json.dumps(OK).encode()))
        self.assertTrue(verify("tok", secret=SECRET, url=api.url).unavailable)

    def test_the_default_timeout_is_three_seconds(self) -> None:
        self.assertEqual(DEFAULT_TIMEOUT, 3.0)


class Secret(ApiTestCase):
    def test_not_in_the_result_when_the_api_fails(self) -> None:
        api = self.api(lambda _r: Reply(500, raw=f"error near {SECRET}".encode()))
        r = verify("tok", secret=SECRET, url=api.url)
        self.assertTrue(r.unavailable)
        self.assertNotIn(SECRET, repr(r))

    def test_wrong_options_raise_value_error_without_the_secret(self) -> None:
        bad: list[tuple[str, dict[str, Any]]] = [
            ("no secret", {"secret": ""}),
            ("secret not a string", {"secret": None}),
            ("relative url", {"url": "/captcha"}),
            ("ftp url", {"url": "ftp://captcha.example.test"}),
            ("no host", {"url": "https://"}),
            ("bad port", {"url": "https://captcha.example.test:99999"}),
            ("credentials in url", {"url": f"https://u:{SECRET}@captcha.example.test"}),
            ("query in url", {"url": "https://captcha.example.test?x=1"}),
            ("fragment in url", {"url": "https://captcha.example.test#x"}),
            ("min_score > 1", {"min_score": 1.5}),
            ("min_score NaN", {"min_score": float("nan")}),
            ("min_score bool", {"min_score": True}),
            ("timeout 0", {"timeout": 0}),
            ("timeout inf", {"timeout": float("inf")}),
        ]
        for name, override in bad:
            with self.subTest(name):
                opts: dict[str, Any] = {"secret": SECRET, "url": "https://captcha.example.test"}
                opts.update(override)
                with self.assertRaises(ValueError) as cm:
                    verify("tok", **opts)
                self.assertNotIn(SECRET, str(cm.exception))
                self.assertIsNone(cm.exception.__cause__)


if __name__ == "__main__":
    unittest.main()
