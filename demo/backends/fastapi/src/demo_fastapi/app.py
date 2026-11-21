"""The demo backend's app (FastAPI): it serves the built demo page and answers its form. The same
contract as the other backends (demo/backends/contract.ts, demo/backends/python_contract.py), so
the demo page works with any of them.

POST /demo/submit takes the form as application/x-www-form-urlencoded (``bc-response``, the pass
token the widget put in the form, and ``comment``) and checks the token with the Python SDK
(``belarusian_captcha.verify``), the way a site's own backend would. The answer is JSON:

  200 {accepted: true,  verify}   the token is valid, unspent and for this site and action
  400 {accepted: false, verify}   the API refused it (replay, expired, wrong site, ...)
  400 {accepted: false, error}    no usable token in the form
  503 {accepted: false, verify}   the API could not be reached (fail closed, D11)

``verify`` is the SDK's result, shown on the page so a visitor sees what the site's backend sees.
The secret is never logged or sent back; the token and the comment are not logged or stored.

The form is read here, not with FastAPI's ``Form()`` (which needs python-multipart): the body is
read up to the limit and parsed with the standard library.
"""

from __future__ import annotations

import urllib.parse
from collections.abc import Awaitable, Callable
from dataclasses import dataclass

from belarusian_captcha import verify
from fastapi import FastAPI, Request, Response
from fastapi.responses import JSONResponse
from fastapi.staticfiles import StaticFiles
from starlette.concurrency import run_in_threadpool

SUBMIT_PATH = "/demo/submit"
DEMO_ACTION = "demo"
"""The action the demo page binds into its tokens (demo/src/demo.js)."""
MAX_TOKEN = 4096
BODY_LIMIT = 16 * 1024
"""Body limit, as the other backends': a demo form is a token and a short comment."""
_FORM = "application/x-www-form-urlencoded"


@dataclass(frozen=True)
class DemoConfig:
    secret: str
    """The demo site's secret key."""
    api_url: str
    """Base URL of the verify API as this backend reaches it (in compose: http://api:8080)."""
    sitekey: str
    """The demo site's key: a token from another site is refused."""
    static_dir: str
    """The built demo page (demo/dist)."""


class BodyTooLarge(Exception):
    pass


async def _read_body(request: Request) -> bytes:
    """The body, at most BODY_LIMIT bytes, whether or not it has a Content-Length."""
    declared = request.headers.get("content-length")
    if declared is not None and declared.isdigit() and int(declared) > BODY_LIMIT:
        raise BodyTooLarge
    chunks: list[bytes] = []
    size = 0
    async for chunk in request.stream():
        size += len(chunk)
        if size > BODY_LIMIT:
            raise BodyTooLarge
        chunks.append(chunk)
    return b"".join(chunks)


def _token(body: bytes) -> str | None:
    """The one ``bc-response`` of a urlencoded body, or None."""
    try:
        fields = urllib.parse.parse_qsl(
            body.decode("utf-8"), keep_blank_values=True, strict_parsing=False, max_num_fields=64
        )
    except (UnicodeDecodeError, ValueError):
        return None
    tokens = [v for k, v in fields if k == "bc-response"]
    if len(tokens) != 1 or tokens[0] == "" or len(tokens[0]) > MAX_TOKEN:
        return None
    return tokens[0]


def _no_store(body: object, status: int) -> JSONResponse:
    return JSONResponse(body, status_code=status, headers={"cache-control": "no-store"})


def create_app(cfg: DemoConfig) -> FastAPI:
    # No OpenAPI schema or docs pages: this is a demo site's backend, not an API.
    app = FastAPI(openapi_url=None, docs_url=None, redoc_url=None)

    @app.middleware("http")
    async def security_headers(
        request: Request, call_next: Callable[[Request], Awaitable[Response]]
    ) -> Response:
        resp = await call_next(request)
        resp.headers["x-content-type-options"] = "nosniff"
        resp.headers["referrer-policy"] = "no-referrer"
        return resp

    @app.get("/healthz")
    async def healthz() -> JSONResponse:
        return _no_store({"ok": True}, 200)

    @app.post(SUBMIT_PATH)
    async def submit(request: Request) -> JSONResponse:
        # Only a urlencoded form is read; any other body type has no token.
        mimetype = request.headers.get("content-type", "").split(";")[0].strip().lower()
        token = None
        if mimetype == _FORM:
            try:
                token = _token(await _read_body(request))
            except BodyTooLarge:
                return _no_store({"accepted": False, "error": "body-too-large"}, 413)
        if token is None:
            return _no_store({"accepted": False, "error": "missing-token"}, 400)
        # The SDK blocks (urllib): run it off the event loop.
        result = await run_in_threadpool(
            verify,
            token,
            secret=cfg.secret,
            url=cfg.api_url,
            sitekey=cfg.sitekey,
            action=DEMO_ACTION,
        )
        status = 200 if result.success else 503 if result.unavailable else 400
        return _no_store({"accepted": result.success, "verify": result.to_dict()}, status)

    # Last, so the routes above win. StaticFiles refuses paths outside the directory.
    app.mount("/", StaticFiles(directory=cfg.static_dir, html=True), name="page")
    return app
