"""The demo backend's app (Flask): it serves the built demo page and answers its form. The same
contract as the Node backends (demo/backends/contract.ts, demo/backends/python_contract.py), so
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
"""

from __future__ import annotations

from dataclasses import dataclass

from belarusian_captcha import verify
from flask import Flask, Response, jsonify, request, send_from_directory

SUBMIT_PATH = "/demo/submit"
DEMO_ACTION = "demo"
"""The action the demo page binds into its tokens (demo/src/demo.js)."""
MAX_TOKEN = 4096
BODY_LIMIT = 16 * 1024
"""Body limit, as the Node backends': a demo form is a token and a short comment."""


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


def _token() -> str | None:
    """The one ``bc-response`` of a urlencoded form, or None. Any other body type has no token."""
    if request.mimetype != "application/x-www-form-urlencoded":
        return None
    tokens = request.form.getlist("bc-response")  # reading the form enforces the body limit
    if len(tokens) != 1 or tokens[0] == "" or len(tokens[0]) > MAX_TOKEN:
        return None
    return tokens[0]


def create_app(cfg: DemoConfig) -> Flask:
    # No static route of Flask's own: the page is served by the routes below.
    app = Flask(__name__, static_folder=None)
    app.config["MAX_CONTENT_LENGTH"] = BODY_LIMIT

    @app.after_request
    def security_headers(resp: Response) -> Response:
        resp.headers["x-content-type-options"] = "nosniff"
        resp.headers["referrer-policy"] = "no-referrer"
        return resp

    @app.get("/healthz")
    def healthz() -> Response:
        resp = jsonify(ok=True)
        resp.headers["cache-control"] = "no-store"
        return resp

    @app.post(SUBMIT_PATH)
    def submit() -> tuple[Response, int]:
        token = _token()
        if token is None:
            resp, status = jsonify(accepted=False, error="missing-token"), 400
        else:
            result = verify(
                token,
                secret=cfg.secret,
                url=cfg.api_url,
                sitekey=cfg.sitekey,
                action=DEMO_ACTION,
            )
            status = 200 if result.success else 503 if result.unavailable else 400
            resp = jsonify(accepted=result.success, verify=result.to_dict())
        resp.headers["cache-control"] = "no-store"
        return resp, status

    @app.get("/")
    @app.get("/<path:path>")
    def page(path: str = "index.html") -> Response:
        # send_from_directory refuses paths outside static_dir and answers 404 for a missing file.
        return send_from_directory(cfg.static_dir, path)

    return app
