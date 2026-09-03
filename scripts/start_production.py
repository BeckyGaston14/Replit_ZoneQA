#!/usr/bin/env python3
"""Supervise the production API and serve the built SPA on Replit's web port."""

from __future__ import annotations

import http.client
import os
import signal
import subprocess
import sys
import threading
import time
from pathlib import Path


def backend_exit_reason(returncode: int | None) -> str:
    if returncode is None:
        return "still running (no exit status)"
    if returncode >= 0:
        return f"exit status {returncode}"
    signal_number = -returncode
    try:
        signal_name = signal.Signals(signal_number).name
    except ValueError:
        signal_name = "unknown signal"
    return f"terminated by {signal_name} ({signal_number})"


def relay_backend_output(stream) -> None:
    if stream is None:
        return
    for line in stream:
        print(f"[backend] {line.rstrip()}", flush=True)


def wait_for_backend(process: subprocess.Popen, port: int, timeout: float = 120) -> None:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        returncode = process.poll()
        if returncode is not None:
            reason = backend_exit_reason(returncode)
            print(f"Backend child exited before becoming healthy: {reason}", file=sys.stderr, flush=True)
            raise SystemExit(f"Backend child exited before becoming healthy: {reason}")
        connection = http.client.HTTPConnection("127.0.0.1", port, timeout=1)
        try:
            connection.request("GET", "/api/health")
            if connection.getresponse().status == 200:
                return
        except OSError:
            pass
        finally:
            connection.close()
        time.sleep(0.25)
    returncode = process.poll()
    state = backend_exit_reason(returncode)
    if returncode is None and hasattr(signal, "SIGUSR1"):
        print(
            "Backend child is still running; requesting a Python stack dump",
            file=sys.stderr,
            flush=True,
        )
        process.send_signal(signal.SIGUSR1)
        time.sleep(1)
    raise SystemExit(
        f"Backend did not become healthy within {timeout:g} seconds; backend child is {state}"
    )


def main() -> None:
    os.environ.setdefault("APP_ENV", "production")
    os.environ["SERVE_MODE"] = "production"
    backend_port = int(os.environ.get("BACKEND_PORT", "8000"))
    backend_env = os.environ.copy()
    backend_env["PYTHONUNBUFFERED"] = "1"
    backend_env["PYTHONFAULTHANDLER"] = "1"
    backend_script = Path(__file__).resolve().with_name("start_backend.py")
    backend = subprocess.Popen(
        [
            sys.executable,
            "-u",
            str(backend_script),
        ],
        env=backend_env,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
        bufsize=1,
    )
    backend_output_thread = threading.Thread(
        target=relay_backend_output,
        args=(backend.stdout,),
        daemon=True,
    )
    backend_output_thread.start()
    print(
        f"Started backend child process {backend.pid} on http://127.0.0.1:{backend_port}",
        flush=True,
    )
    server = None
    server_thread = None
    try:
        from serve_frontend import BUILD_DIR, FrontendHandler, ThreadingHTTPServer

        if not BUILD_DIR.is_dir():
            raise SystemExit(f"Frontend build is missing at {BUILD_DIR}")
        host = os.environ.get("HOST", "0.0.0.0")
        port = int(os.environ.get("PORT", "5000"))
        server = ThreadingHTTPServer((host, port), FrontendHandler)
        server_thread = threading.Thread(target=server.serve_forever, daemon=True)
        server_thread.start()
        print(
            f"Serving production frontend at http://{host}:{port} "
            "(static build; backend initializing)",
            flush=True,
        )
        # Cold deployment containers can spend more than two minutes importing
        # Python dependencies before Uvicorn begins accepting requests. Keep the
        # immediately served SPA health probe, but do not restart a healthy
        # backend child while that bounded cold start is still progressing.
        startup_timeout = float(os.environ.get("BACKEND_STARTUP_TIMEOUT", "300"))
        wait_for_backend(backend, backend_port, timeout=startup_timeout)
        print("Production backend is healthy; same-origin API proxy is ready", flush=True)
        returncode = backend.wait()
        reason = backend_exit_reason(returncode)
        print(f"Backend child exited after becoming healthy: {reason}", file=sys.stderr, flush=True)
        raise SystemExit(f"Backend child exited unexpectedly: {reason}")
    finally:
        if server is not None:
            server.shutdown()
            server.server_close()
        if server_thread is not None:
            server_thread.join(timeout=5)
        if backend.poll() is None:
            backend.terminate()
        try:
            backend.wait(timeout=10)
        except subprocess.TimeoutExpired:
            backend.kill()
            backend.wait(timeout=5)
        backend_output_thread.join(timeout=5)


if __name__ == "__main__":
    main()