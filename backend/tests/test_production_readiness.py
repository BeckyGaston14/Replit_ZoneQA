"""Focused production-readiness regressions with no live services or data writes."""

import asyncio
from pathlib import Path

import pytest
from fastapi import HTTPException, Response

import server


class FakeCursor:
    def __init__(self, documents):
        self.documents = documents

    async def to_list(self, _limit):
        return [dict(document) for document in self.documents]


class FakeUsers:
    def __init__(self, users):
        self.users = users

    async def find_one(self, query, *_args, **_kwargs):
        for user in self.users:
            if all(user.get(key) == value for key, value in query.items()):
                return dict(user)
        return None

    def find(self, *_args, **_kwargs):
        return FakeCursor(self.users)

    async def update_one(self, query, update, **_kwargs):
        user = next(item for item in self.users if item["id"] == query["id"])
        user.update(update.get("$set", {}))

    async def count_documents(self, query):
        return sum(
            1 for user in self.users
            if user.get("role") == query.get("role")
            and user.get("active") is not False
            and not user.get("deleted_at")
        )


class FakeDb:
    def __init__(self, users):
        self.users = FakeUsers(users)
        self.sessions = {}

    async def create_auth_session(self, document):
        self.sessions[document["id"]] = dict(document)

    async def get_auth_session(self, identifier):
        return self.sessions.get(identifier)

    async def revoke_auth_session(self, identifier):
        self.sessions.pop(identifier, None)


def test_login_uses_http_only_cookie_and_returns_no_token(monkeypatch):
    user = {
        "id": "u1",
        "email": "admin@example.com",
        "name": "Admin",
        "role": "admin",
        "password_hash": server.hash_password("a-long-test-password"),
        "active": True,
    }
    monkeypatch.setattr(server, "db", FakeDb([user]))
    response = Response()
    result = asyncio.run(
        server.login(
            server.LoginIn(email=user["email"], password="a-long-test-password"),
            response,
        )
    )
    assert "token" not in result
    cookies = response.headers.getlist("set-cookie")
    session_cookie = next(value for value in cookies if value.startswith("zq_session="))
    assert "HttpOnly" in session_cookie
    assert "SameSite=lax" in session_cookie
    assert any(value.startswith("zq_csrf=") for value in cookies)


def test_csrf_is_bound_to_session():
    token = "csrf-value"
    session = {"csrf_hash": server._digest(token)}
    assert server._csrf_is_valid(session, token, token)
    assert not server._csrf_is_valid(session, "", token)
    assert not server._csrf_is_valid(session, token, "other")


def test_shared_configured_secret_validates_sessions_across_processes(monkeypatch):
    raw_session = "shared-opaque-session"
    shared_secret = "shared-deployment-secret"
    user = {"id": "u1", "email": "user@example.com", "role": "tester", "active": True}
    database = FakeDb([user])

    # Simulate process A issuing the database key and process B deriving it.
    monkeypatch.setattr(server, "SESSION_SECRET", shared_secret)
    session_id = f"auth_session:{server._digest(raw_session)}"
    database.sessions[session_id] = {
        "user_id": "u1",
        "csrf_hash": server._digest("csrf"),
        "expires_at": "2999-01-01T00:00:00+00:00",
    }
    monkeypatch.setattr(server, "db", database)
    assert asyncio.run(server.get_user_from_session(raw_session))["id"] == "u1"


def test_missing_secret_is_rejected_for_production_and_multiple_workers():
    with pytest.raises(RuntimeError, match="SESSION_SECRET"):
        server._validate_session_secret_configuration("production", "", 1)
    with pytest.raises(RuntimeError, match="SESSION_SECRET"):
        server._validate_session_secret_configuration("development", "", 2)
    server._validate_session_secret_configuration("test", "", 1)


def test_expired_and_inactive_sessions_are_rejected(monkeypatch):
    raw = "expired-session"
    expired = {
        "id": "u1",
        "email": "user@example.com",
        "role": "viewer",
        "active": True,
    }
    expired_db = FakeDb([expired])
    expired_db.sessions[f"auth_session:{server._digest(raw)}"] = {
        "user_id": "u1", "csrf_hash": server._digest("csrf"),
        "expires_at": "2000-01-01T00:00:00+00:00",
    }
    monkeypatch.setattr(server, "db", expired_db)
    with pytest.raises(HTTPException, match="Session expired"):
        asyncio.run(server.get_user_from_session(raw))

    inactive_raw = "inactive-session"
    inactive = {
        **expired,
        "active": False,
    }
    inactive_db = FakeDb([inactive])
    inactive_db.sessions[f"auth_session:{server._digest(inactive_raw)}"] = {
        "user_id": "u1", "csrf_hash": server._digest("csrf"),
        "expires_at": "2999-01-01T00:00:00+00:00",
    }
    monkeypatch.setattr(server, "db", inactive_db)
    with pytest.raises(HTTPException) as exc:
        asyncio.run(server.get_user_from_session(inactive_raw))
    assert exc.value.status_code == 403


def test_cors_rejects_wildcards(monkeypatch):
    monkeypatch.setenv("CORS_ORIGINS", "*")
    with pytest.raises(RuntimeError, match="may not contain"):
        server._cors_origins()


@pytest.mark.parametrize(
    "url",
    [
        "http://api.zoneomics.com/v2/ask",
        "https://127.0.0.1/v2/ask",
        "https://metadata.google.internal/v1",
        "https://api.zoneomics.com.evil.example/v2/ask",
        "https://api.zoneomics.com/v2/ask?key=leak",
    ],
)
def test_bassett_url_rejects_unapproved_destinations(url):
    with pytest.raises(HTTPException):
        server._validate_bassett_url(url)


def test_bassett_key_is_only_sent_in_approved_header(monkeypatch):
    captured = []

    class FakeResponse:
        status_code = 200

        def json(self):
            return {"answer": "ok"}

    class FakeClient:
        async def __aenter__(self):
            return self

        async def __aexit__(self, *_args):
            return None

        async def post(self, url, **kwargs):
            captured.append((url, kwargs))
            return FakeResponse()

    monkeypatch.setattr(server.httpx, "AsyncClient", lambda **_kwargs: FakeClient())
    asyncio.run(server._run_bassett("https://example.test/ask", "super-secret", [{"turn": 1, "text": "Q"}]))
    url, request = captured[0]
    assert "super-secret" not in url
    assert request["headers"] == {"Content-Type": "application/json", "X-API-Key": "super-secret"}
    assert "super-secret" not in str(request["json"])
    assert "params" not in request


def test_browser_auth_source_contains_no_token_storage_or_emergent_flow():
    root = Path(__file__).resolve().parents[2]
    sources = "\n".join(
        (root / path).read_text()
        for path in (
            "frontend/src/lib/auth.jsx",
            "frontend/src/lib/api.js",
            "frontend/src/pages/Login.jsx",
            "frontend/src/App.js",
        )
    )
    assert "localStorage" not in sources
    assert "zq_token" not in sources
    assert "emergentagent.com" not in sources
    assert "Bassett2026!" not in sources


def test_runtime_dependencies_have_one_authoritative_manifest():
    root = Path(__file__).resolve().parents[2]
    assert (root / "pyproject.toml").is_file()
    assert not (root / "backend/requirements.txt").exists()
    assert "emergentintegrations" not in (root / "pyproject.toml").read_text()


def test_production_supervisor_allows_bounded_cold_imports_and_proxy_reports_retryable_startup():
    root = Path(__file__).resolve().parents[2]
    supervisor = (root / "scripts/start_production.py").read_text()
    proxy = (root / "scripts/serve_frontend.py").read_text()
    assert 'BACKEND_STARTUP_TIMEOUT", "300"' in supervisor
    assert "HTTPStatus.SERVICE_UNAVAILABLE" in proxy
    assert '"Retry-After", "5"' in proxy
    assert "The server is still starting" in proxy