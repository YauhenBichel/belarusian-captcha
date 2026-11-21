"""Starts the FastAPI demo backend with uvicorn. Configuration comes from the environment only,
the same as the other backends':

  BC_API_URL     base URL of the verify API as this backend reaches it  (required)
  BC_SITEKEY     the demo site's key                                     (required)
  BC_SECRET      the demo site's secret                       (this or BC_SECRET_FILE)
  BC_SECRET_FILE a file holding the secret (a Docker or Kubernetes secret)
  BC_DEMO_DIR    the built demo page (default: demo/dist of this checkout)
  HOST, PORT     where to listen (default 127.0.0.1:3003; compose sets HOST=0.0.0.0)

  python -m demo_fastapi
"""

from __future__ import annotations

import os
from pathlib import Path

import uvicorn

from .app import DemoConfig, create_app


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
    """demo/dist of this checkout (demo/backends/fastapi/src/demo_fastapi/__main__.py); the image
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
    port = int(os.environ.get("PORT") or 3003)
    print(f"demo backend (fastapi) on http://{host}:{port}/", flush=True)
    # server_header=False: no Server header. The body limit is the app's own (uvicorn has none).
    # uvicorn stops on SIGTERM after the open requests (exec-form PID 1 in the container).
    uvicorn.run(
        app,
        host=host,
        port=port,
        server_header=False,
        proxy_headers=False,
        access_log=False,
        log_level="info",
    )


if __name__ == "__main__":
    main()
