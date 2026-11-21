"""The Flask demo backend against the shared demo-backend contract
(demo/backends/python_contract.py), served by Werkzeug's threaded server on an ephemeral port."""

from __future__ import annotations

import logging
import sys
import threading
import unittest
from collections.abc import Callable
from pathlib import Path

from werkzeug.serving import make_server

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))
import python_contract as contract
from demo_flask import DemoConfig, create_app

# Werkzeug logs every request; the contract makes many.
logging.getLogger("werkzeug").setLevel(logging.ERROR)


class FlaskDemoBackend(contract.DemoBackendContract, unittest.TestCase):
    def start_backend(self, cfg: contract.ContractConfig) -> tuple[str, Callable[[], None]]:
        app = create_app(DemoConfig(cfg.secret, cfg.api_url, cfg.sitekey, cfg.static_dir))
        server = make_server("127.0.0.1", 0, app, threaded=True)
        threading.Thread(target=server.serve_forever, daemon=True).start()

        def close() -> None:
            server.shutdown()
            server.server_close()

        return f"http://127.0.0.1:{server.server_port}", close


if __name__ == "__main__":
    unittest.main()
