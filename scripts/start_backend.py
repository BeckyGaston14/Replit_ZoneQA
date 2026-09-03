#!/usr/bin/env python3
"""Start the production API with import-stage diagnostics."""

from __future__ import annotations

import faulthandler
import os
from pathlib import Path
import signal
import sys

import uvicorn


def main() -> None:
    faulthandler.enable(all_threads=True)
    if hasattr(signal, "SIGUSR1"):
        faulthandler.register(signal.SIGUSR1, all_threads=True, chain=False)

    backend_dir = Path(__file__).resolve().parents[1] / "backend"
    sys.path.insert(0, str(backend_dir))
    print(f"Loading backend application from {backend_dir}", flush=True)
    faulthandler.dump_traceback_later(30, repeat=False)
    try:
        from server import app
    finally:
        faulthandler.cancel_dump_traceback_later()
    print("Backend application module loaded", flush=True)

    host = "127.0.0.1"
    port = int(os.environ.get("BACKEND_PORT", "8000"))
    print(f"Starting Uvicorn on http://{host}:{port}", flush=True)
    uvicorn.run(app, host=host, port=port)


if __name__ == "__main__":
    main()