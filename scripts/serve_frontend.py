#!/usr/bin/env python3
"""Keep the stable preview port and proxy the frontend dev server when available."""

from __future__ import annotations

import argparse
import base64
import http.client
import json
import os
import select
import socket
import tempfile
import threading
import time
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import unquote, urlsplit


PROJECT_ROOT = Path(__file__).resolve().parent.parent
BUILD_DIR = PROJECT_ROOT / "frontend" / "build"
BACKEND_HOST = os.environ.get("BACKEND_HOST", "127.0.0.1")
BACKEND_PORT = int(os.environ.get("BACKEND_PORT", "8000"))
FRONTEND_DEV_HOST = os.environ.get("FRONTEND_DEV_HOST", "127.0.0.1")
FRONTEND_DEV_PORT = int(os.environ.get("FRONTEND_DEV_PORT", "5001"))
SERVE_MODE = os.environ.get("SERVE_MODE", "development").strip().lower()
FAVICON_ICO = base64.b64decode(
    "AAABAAEAICAAAAEAIACPAAAAFgAAAIlQTkcNChoKAAAADUlIRFIAAAAgAAAAIAgGAAAAc3p69AAAAFZJREFUeNrt17sVACAIQ1FGcU/Xtkc38HMIUrwUKcPtPJrtM3pzTcUEHz58RX2647nlK+GFD5/MdzDwwXc1kOZ7HBD7cgfw4cPH+4Gvko//Bz58+ES+CSApflju3XiXAAAAAElFTkSuQmCC"
)
HOP_BY_HOP_HEADERS = {
    "connection",
    "keep-alive",
    "proxy-authenticate",
    "proxy-authorization",
    "te",
    "trailers",
    "transfer-encoding",
    "upgrade",
}


class FrontendHandler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(BUILD_DIR), **kwargs)

    def do_GET(self):
        self._handle_request()

    def do_HEAD(self):
        self._handle_request()

    def do_POST(self):
        self._handle_request()

    def do_PUT(self):
        self._handle_request()

    def do_PATCH(self):
        self._handle_request()

    def do_DELETE(self):
        self._handle_request()

    def do_OPTIONS(self):
        self._handle_request()

    def _handle_request(self):
        request_path = urlsplit(self.path).path
        if request_path == "/favicon.ico":
            self._serve_legacy_favicon()
            return
        if request_path == "/api" or request_path.startswith("/api/"):
            self._proxy_api()
            return

        if SERVE_MODE != "production" and self.headers.get("Upgrade", "").lower() == "websocket":
            self._proxy_websocket()
            return

        if SERVE_MODE != "production" and self.command in {"GET", "HEAD"} and self._proxy_dev_server():
            return

        self._serve_frontend()

    def _serve_legacy_favicon(self):
        self.send_response(HTTPStatus.OK)
        self.send_header("Content-Type", "image/x-icon")
        self.send_header("Content-Length", str(len(FAVICON_ICO)))
        self.end_headers()
        if self.command == "GET":
            self.wfile.write(FAVICON_ICO)

    def _proxy_dev_server(self):
        """Proxy frontend requests to CRACO, falling back to the last good build."""
        headers = {
            name: value
            for name, value in self.headers.items()
            if name.lower() not in HOP_BY_HOP_HEADERS and name.lower() != "host"
        }
        connection = http.client.HTTPConnection(
            FRONTEND_DEV_HOST, FRONTEND_DEV_PORT, timeout=2
        )
        try:
            connection.request(self.command, self.path, headers=headers)
            response = connection.getresponse()
            response_body = response.read()

            self.send_response(response.status, response.reason)
            for name, value in response.getheaders():
                if name.lower() not in HOP_BY_HOP_HEADERS:
                    self.send_header(name, value)
            self.end_headers()
            if self.command != "HEAD":
                self.wfile.write(response_body)
            return True
        except OSError:
            return False
        finally:
            connection.close()

    def _proxy_websocket(self):
        """Tunnel CRACO's HMR WebSocket through the stable preview port."""
        upstream = None
        try:
            upstream = socket.create_connection(
                (FRONTEND_DEV_HOST, FRONTEND_DEV_PORT), timeout=2
            )
            upstream.settimeout(None)
            request = [f"{self.command} {self.path} HTTP/1.1\r\n"]
            for name, value in self.headers.items():
                if name.lower() == "host":
                    value = f"{FRONTEND_DEV_HOST}:{FRONTEND_DEV_PORT}"
                request.append(f"{name}: {value}\r\n")
            request.append("\r\n")
            upstream.sendall("".join(request).encode("latin-1"))

            self.connection.settimeout(None)
            sockets = [self.connection, upstream]
            while sockets:
                readable, _, exceptional = select.select(sockets, [], sockets)
                if exceptional:
                    break
                for source in readable:
                    data = source.recv(64 * 1024)
                    if not data:
                        return
                    destination = upstream if source is self.connection else self.connection
                    destination.sendall(data)
        except OSError:
            # If CRACO is still compiling, the browser will retry the HMR connection.
            self.close_connection = True
        finally:
            if upstream is not None:
                upstream.close()

    def _serve_frontend(self):
        path = urlsplit(self.path).path
        relative_path = unquote(path).lstrip("/")
        requested_file = (BUILD_DIR / relative_path).resolve()

        if (
            not requested_file.is_relative_to(BUILD_DIR)
            or (not requested_file.is_file() and "." not in Path(relative_path).name)
        ):
            self.path = "/index.html"

        super().do_GET() if self.command == "GET" else super().do_HEAD()

    def end_headers(self):
        # The HTML shell must always be revalidated after a rebuild. Hashed assets
        # can retain their normal cache behavior.
        if self.path == "/index.html":
            self.send_header("Cache-Control", "no-store")
        super().end_headers()

    def _proxy_api(self):
        content_length = int(self.headers.get("Content-Length", "0"))
        body = self.rfile.read(content_length) if content_length else None
        headers = {
            name: value
            for name, value in self.headers.items()
            if name.lower() not in HOP_BY_HOP_HEADERS and name.lower() != "host"
        }

        retry_deadline = time.monotonic() + float(
            os.environ.get("API_STARTUP_RETRY_SECONDS", "3")
        )
        while True:
            connection = http.client.HTTPConnection(BACKEND_HOST, BACKEND_PORT, timeout=60)
            try:
                connection.request(self.command, self.path, body=body, headers=headers)
                response = connection.getresponse()
                response_body = response.read()

                self.send_response(response.status, response.reason)
                for name, value in response.getheaders():
                    if name.lower() not in HOP_BY_HOP_HEADERS:
                        self.send_header(name, value)
                self.end_headers()
                if self.command != "HEAD":
                    self.wfile.write(response_body)
                return
            except OSError:
                if time.monotonic() < retry_deadline:
                    time.sleep(0.25)
                    continue
                response_body = json.dumps({
                    "detail": "The server is still starting. Please wait a moment and try signing in again."
                }).encode()
                self.send_response(HTTPStatus.SERVICE_UNAVAILABLE)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(response_body)))
                self.send_header("Retry-After", "5")
                self.end_headers()
                if self.command != "HEAD":
                    self.wfile.write(response_body)
                return
            finally:
                connection.close()


class _SmokeFrontendHandler(BaseHTTPRequestHandler):
    """Small frontend-dev-server fixture used by the preview proxy smoke test."""

    protocol_version = "HTTP/1.1"

    def do_GET(self):
        if self.headers.get("Upgrade", "").lower() != "websocket":
            body = f"dev frontend response for {self.path}".encode()
            self.send_response(HTTPStatus.OK)
            self.send_header("Content-Type", "text/plain")
            self.send_header("Content-Length", str(len(body)))
            self.send_header("X-Smoke-Frontend", "dev")
            self.end_headers()
            self.wfile.write(body)
            return

        self.send_response(HTTPStatus.SWITCHING_PROTOCOLS)
        self.send_header("Upgrade", "websocket")
        self.send_header("Connection", "Upgrade")
        self.end_headers()
        # These are the messages webpack-dev-server sends when a source update
        # has been compiled successfully. Keep them as real WebSocket frames so
        # this check covers the byte-for-byte tunnel, not just an HTTP upgrade.
        for message in (
            b'{"type":"hash","data":"smoke-source-update"}',
            b'{"type":"ok"}',
        ):
            self.wfile.write(bytes((0x81, len(message))) + message)
        self.wfile.flush()
        self.close_connection = True

    def log_message(self, *_args):
        return


class _SmokeBackendHandler(BaseHTTPRequestHandler):
    """Same-origin API fixture used by the preview proxy smoke test."""

    protocol_version = "HTTP/1.1"

    def do_GET(self):
        body = b'{"source":"same-origin-api","path":"%s"}' % self.path.encode()
        self.send_response(HTTPStatus.OK)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("X-Smoke-Backend", "api")
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *_args):
        return


def _start_smoke_server(server):
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    return thread


def _smoke_http_request(port, path):
    connection = http.client.HTTPConnection("127.0.0.1", port, timeout=3)
    try:
        connection.request("GET", path)
        response = connection.getresponse()
        return response.status, dict(response.getheaders()), response.read()
    finally:
        connection.close()


def _smoke_websocket_request(port):
    request = (
        "GET /ws HTTP/1.1\r\n"
        "Host: preview-smoke\r\n"
        "Connection: Upgrade\r\n"
        "Upgrade: websocket\r\n"
        "Sec-WebSocket-Version: 13\r\n"
        "Sec-WebSocket-Key: c21tb2tlLXNvdXJjZQ==\r\n"
        "\r\n"
    ).encode("ascii")
    received = bytearray()
    with socket.create_connection(("127.0.0.1", port), timeout=3) as connection:
        connection.sendall(request)
        while b'"type":"ok"' not in received:
            chunk = connection.recv(4096)
            if not chunk:
                break
            received.extend(chunk)
    return bytes(received)


def run_smoke_test():
    """Exercise every route that keeps the proxied preview live during edits."""
    global BACKEND_HOST, BACKEND_PORT, BUILD_DIR, FRONTEND_DEV_HOST, FRONTEND_DEV_PORT

    original_values = (
        BACKEND_HOST,
        BACKEND_PORT,
        BUILD_DIR,
        FRONTEND_DEV_HOST,
        FRONTEND_DEV_PORT,
    )
    dev_server = backend_server = proxy_server = None
    dev_thread = backend_thread = proxy_thread = None

    try:
        with tempfile.TemporaryDirectory(prefix="preview-proxy-smoke-") as build_dir:
            build_path = Path(build_dir)
            (build_path / "index.html").write_text(
                "<!doctype html><title>static fallback</title>", encoding="utf-8"
            )
            (build_path / "favicon.svg").write_bytes(
                (PROJECT_ROOT / "frontend" / "public" / "favicon.svg").read_bytes()
            )
            BUILD_DIR = build_path

            dev_server = ThreadingHTTPServer(("127.0.0.1", 0), _SmokeFrontendHandler)
            backend_server = ThreadingHTTPServer(("127.0.0.1", 0), _SmokeBackendHandler)
            FRONTEND_DEV_HOST = BACKEND_HOST = "127.0.0.1"
            FRONTEND_DEV_PORT = dev_server.server_address[1]
            BACKEND_PORT = backend_server.server_address[1]
            dev_thread = _start_smoke_server(dev_server)
            backend_thread = _start_smoke_server(backend_server)

            proxy_server = ThreadingHTTPServer(("127.0.0.1", 0), FrontendHandler)
            proxy_thread = _start_smoke_server(proxy_server)
            proxy_port = proxy_server.server_address[1]

            status, headers, body = _smoke_http_request(
                proxy_port, "/static/app.js?cache=smoke"
            )
            if status != HTTPStatus.OK or headers.get("X-Smoke-Frontend") != "dev":
                raise RuntimeError("frontend dev-server proxying failed")
            if b"dev frontend response" not in body:
                raise RuntimeError("frontend dev-server response was not preserved")

            websocket_response = _smoke_websocket_request(proxy_port)
            if b"101 Switching Protocols" not in websocket_response:
                raise RuntimeError("HMR WebSocket upgrade was not proxied")
            if b"smoke-source-update" not in websocket_response:
                raise RuntimeError("HMR source-update signal was not proxied")
            if b'"type":"ok"' not in websocket_response:
                raise RuntimeError("HMR compile-success signal was not proxied")

            status, headers, body = _smoke_http_request(
                proxy_port, "/api/preview-smoke?origin=same-origin"
            )
            if status != HTTPStatus.OK or headers.get("X-Smoke-Backend") != "api":
                raise RuntimeError("same-origin /api forwarding failed")
            if b'"source":"same-origin-api"' not in body:
                raise RuntimeError("same-origin /api response was not preserved")

            backend_server.shutdown()
            backend_server.server_close()
            backend_thread.join(timeout=3)
            backend_server = backend_thread = None
            previous_retry = os.environ.get("API_STARTUP_RETRY_SECONDS")
            os.environ["API_STARTUP_RETRY_SECONDS"] = "0"
            try:
                status, headers, body = _smoke_http_request(proxy_port, "/api/auth/login")
            finally:
                if previous_retry is None:
                    os.environ.pop("API_STARTUP_RETRY_SECONDS", None)
                else:
                    os.environ["API_STARTUP_RETRY_SECONDS"] = previous_retry
            if status != HTTPStatus.SERVICE_UNAVAILABLE:
                raise RuntimeError("unavailable backend did not return retryable 503")
            if headers.get("Retry-After") != "5" or b'"detail"' not in body:
                raise RuntimeError("unavailable backend response lacked retry guidance")

            dev_server.shutdown()
            dev_server.server_close()
            dev_thread.join(timeout=3)
            dev_server = dev_thread = None

            for favicon_path, content_type, expected_body in (
                ("/favicon.svg", "image/svg+xml", (build_path / "favicon.svg").read_bytes()),
                ("/favicon.ico", "image/x-icon", FAVICON_ICO),
            ):
                status, headers, body = _smoke_http_request(proxy_port, favicon_path)
                actual_content_type = next(
                    (value for name, value in headers.items() if name.lower() == "content-type"),
                    None,
                )
                if status != HTTPStatus.OK or actual_content_type != content_type:
                    raise RuntimeError(f"{favicon_path} did not return its expected image content type")
                if body != expected_body:
                    raise RuntimeError(f"{favicon_path} did not return its expected favicon content")

            status, headers, body = _smoke_http_request(proxy_port, "/editor/project")
            if status != HTTPStatus.OK or b"static fallback" not in body:
                raise RuntimeError("static-build fallback failed")
            if headers.get("Cache-Control") != "no-store":
                raise RuntimeError("static fallback HTML was not marked no-store")
    finally:
        for server in (proxy_server, backend_server, dev_server):
            if server is not None:
                server.shutdown()
                server.server_close()
        for thread in (proxy_thread, backend_thread, dev_thread):
            if thread is not None:
                thread.join(timeout=3)
        (
            BACKEND_HOST,
            BACKEND_PORT,
            BUILD_DIR,
            FRONTEND_DEV_HOST,
            FRONTEND_DEV_PORT,
        ) = original_values

    print(
        "Preview proxy smoke check passed: frontend proxy, HMR WebSocket/source update, "
        "static fallback, /api forwarding, and startup retry guidance.",
        flush=True,
    )


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--smoke-test",
        action="store_true",
        help="exercise frontend, HMR, static fallback, and API proxy routes",
    )
    args = parser.parse_args()
    if args.smoke_test:
        run_smoke_test()
        return

    if not BUILD_DIR.is_dir():
        raise SystemExit(
            f"Frontend build is missing at {BUILD_DIR}. Run `yarn --cwd frontend build` first."
        )

    host = os.environ.get("HOST", "0.0.0.0")
    port = int(os.environ.get("PORT", "5000"))
    server = ThreadingHTTPServer((host, port), FrontendHandler)
    print(
        f"Serving {SERVE_MODE} frontend at http://{host}:{port}"
        + (
            f" (frontend dev proxy {FRONTEND_DEV_HOST}:{FRONTEND_DEV_PORT})"
            if SERVE_MODE != "production"
            else " (static build; same-origin API proxy)"
        ),
        flush=True,
    )
    server.serve_forever()


if __name__ == "__main__":
    main()