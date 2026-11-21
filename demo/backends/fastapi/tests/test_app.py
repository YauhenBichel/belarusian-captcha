"""The FastAPI demo backend against the shared demo-backend contract
(demo/backends/python_contract.py), served by uvicorn (as in the image) on an ephemeral port."""

from __future__ import annotations

import sys
import threading
import time
import unittest
from collections.abc import Callable
from pathlib import Path

import uvicorn

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))
import python_contract as contract
from demo_fastapi import DemoConfig, create_app


class FastApiDemoBackend(contract.DemoBackendContract, unittest.TestCase):
    def start_backend(self, cfg: contract.ContractConfig) -> tuple[str, Callable[[], None]]:
        app = create_app(DemoConfig(cfg.secret, cfg.api_url, cfg.sitekey, cfg.static_dir))
        config = uvicorn.Config(app, host="127.0.0.1", port=0, log_level="warning")
        server = uvicorn.Server(config)
        thread = threading.Thread(target=server.run, daemon=True)
        thread.start()
        deadline = time.monotonic() + 10
        while not server.started:
            if time.monotonic() > deadline or not thread.is_alive():
                raise RuntimeError("uvicorn did not start")
            time.sleep(0.01)
        port = server.servers[0].sockets[0].getsockname()[1]

        def close() -> None:
            server.should_exit = True
            thread.join(10)

        return f"http://127.0.0.1:{port}", close


if __name__ == "__main__":
    unittest.main()
