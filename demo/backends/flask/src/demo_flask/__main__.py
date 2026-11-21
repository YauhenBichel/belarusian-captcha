"""Starts the Flask demo backend with waitress. Configuration comes from the environment only, the
same as the Node backends':

  BC_API_URL     base URL of the verify API as this backend reaches it  (required)
  BC_SITEKEY     the demo site's key                                     (required)
  BC_SECRET      the demo site's secret                       (this or BC_SECRET_FILE)
  BC_SECRET_FILE a file holding the secret (a Docker or Kubernetes secret)
  BC_DEMO_DIR    the built demo page (default: demo/dist of this checkout)
  HOST, PORT     where to listen (default 127.0.0.1:3002; compose sets HOST=0.0.0.0)

  python -m demo_flask
"""

from __future__ import annotations

import os
from pathlib import Path

from waitress import serve

from .app import BODY_LIMIT, DemoConfig, create_app


def _required(name: str) -> str:
    value = os.environ.get(name)
    if not value:
        raise SystemExit(f"{name} is required")
    return value


def _secret() -> str:
    if os.environ.get("BC_SECRET"):
        return os.environ["BC_SECRET"]
    if os.environ.get("BC_SECRET_FILE"):
        return Path(os.environ["BC_SECRET_FILE"]).read_text().strip()
    raise SystemExit("BC_SECRET or BC_SECRET_FILE is required")


def _checkout_demo_dir() -> str:
    """demo/dist of this checkout (demo/backends/flask/src/demo_flask/__main__.py); the image
    sets BC_DEMO_DIR instead."""
    return str(Path(__file__).resolve().parents[4] / "dist")


def main() -> None:
    app = create_app(
        DemoConfig(
            secret=_secret(),
            api_url=_required("BC_API_URL"),
            sitekey=_required("BC_SITEKEY"),
            static_dir=os.environ.get("BC_DEMO_DIR") or _checkout_demo_dir(),
        )
    )
    host = os.environ.get("HOST") or "127.0.0.1"
    port = int(os.environ.get("PORT") or 3002)
    print(f"demo backend (flask) on http://{host}:{port}/", flush=True)
    # ident=None: no Server header. max_request_body_size: waitress buffers a body (even a
    # chunked one) before Flask sees it, so it gets the app's limit too, not its 1 GB default.
    # waitress stops on SIGTERM (exec-form PID 1 in the container).
    serve(
        app,
        host=host,
        port=port,
        ident=None,
        threads=4,
        max_request_body_size=BODY_LIMIT,
    )


if __name__ == "__main__":
    main()
