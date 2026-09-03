"""Focused coverage for the atomic administrator user-edit operation."""

import asyncio
import copy

import pytest
from fastapi import HTTPException, Response
from starlette.requests import Request

import server


ADMIN = {"id": "admin-1", "name": "Admin", "role": "admin"}


class AtomicEditDb:
    def __init__(self, user=None):
        self.user = copy.deepcopy(user or {
            "id": "user-1",
            "name": "Tester",
            "email": "tester@example.com",
            "role": "tester",
            "active": True,
            "revision": 1,
            "updated_at": "before",
            "password_hash": server.hash_password("original-password"),
        })
        self.activities = []
        self.sessions = {
            "session-1": {"user_id": self.user["id"]},
            "session-2": {"user_id": self.user["id"]},
            "other-session": {"user_id": "other"},
        }
        self.calls = 0
        self.fail_after_user_write = False

    async def update_user_profile(
        self, user_id, changes, *, expected_revision=None, expected_updated_at=None,
        timestamp, activity=None,
    ):
        self.calls += 1
        if user_id != self.user["id"]:
            return {"error": "not_found"}
        if expected_revision is not None and expected_revision != self.user["revision"]:
            return {
                "error": "stale_update",
                "current_revision": self.user["revision"],
                "current_updated_at": self.user["updated_at"],
            }
        if expected_updated_at is not None and expected_updated_at != self.user["updated_at"]:
            return {
                "error": "stale_update",
                "current_revision": self.user["revision"],
                "current_updated_at": self.user["updated_at"],
            }
        if changes.get("email") == "other@example.com":
            return {"error": "duplicate_email"}
        snapshot = (copy.deepcopy(self.user), copy.deepcopy(self.activities), copy.deepcopy(self.sessions))
        try:
            self.user.update(copy.deepcopy(changes))
            self.user["updated_at"] = timestamp
            self.user["revision"] += 1
            if self.fail_after_user_write:
                raise RuntimeError("simulated transaction failure")
            if activity:
                self.activities.append(copy.deepcopy(activity))
            public = {key: value for key, value in self.user.items() if key not in {"password_hash", "password_history"}}
            return {
                "user": public,
            }
        except Exception:
            self.user, self.activities, self.sessions = snapshot
            raise


def edit(**kwargs):
    values = {"expected_revision": 1, "expected_updated_at": "before"}
    values.update(kwargs)
    return server.UserEditIn(**values)


def test_email_only_update_is_atomic_and_audited(monkeypatch):
    fake = AtomicEditDb()
    monkeypatch.setattr(server, "db", fake)

    result = asyncio.run(server.update_user("user-1", edit(email="updated@example.com"), ADMIN))

    assert result["user"]["email"] == "updated@example.com"
    assert result["user"]["revision"] == 2
    assert fake.calls == 1
    assert fake.activities[-1]["action"] == "profile updated"
    assert "password_hash" not in result["user"]


def test_administrator_cannot_set_a_password_in_profile_edit(monkeypatch):
    fake = AtomicEditDb()
    monkeypatch.setattr(server, "db", fake)

    with pytest.raises(HTTPException, match="cannot set passwords directly"):
        asyncio.run(server.update_user(
            "user-1",
            edit(new_password="replacement-password", new_password_confirmation="replacement-password"),
            ADMIN,
        ))
    assert fake.calls == 0


def test_duplicate_email_returns_clear_conflict(monkeypatch):
    fake = AtomicEditDb()
    monkeypatch.setattr(server, "db", fake)

    with pytest.raises(HTTPException, match="Another active user already uses this email") as exc:
        asyncio.run(server.update_user("user-1", edit(email="other@example.com"), ADMIN))
    assert exc.value.status_code == 409
    assert fake.user["email"] == "tester@example.com"


def test_legacy_password_endpoint_is_disabled(monkeypatch):
    monkeypatch.setattr(server, "db", AtomicEditDb())
    with pytest.raises(HTTPException, match="cannot set passwords directly"):
        asyncio.run(server.set_user_password("user-1", {"password": "replacement-password"}, ADMIN))


def test_non_admin_is_rejected_before_user_edit():
    checker = server.require_roles("admin")
    with pytest.raises(HTTPException, match="Insufficient permissions"):
        asyncio.run(checker(user={"id": "qa-1", "role": "qa_manager"}))


def test_csrf_middleware_rejects_user_edit_without_valid_token(monkeypatch):
    async def lookup(_raw):
        return ({"id": "admin-1", "role": "admin"}, {"csrf_hash": server._digest("expected")})

    monkeypatch.setattr(server, "_lookup_session", lookup)
    scope = {
        "type": "http",
        "method": "PUT",
        "path": "/api/users/user-1",
        "headers": [(b"cookie", b"zq_session=session; zq_csrf=wrong")],
        "query_string": b"",
        "scheme": "http",
        "server": ("testserver", 80),
        "client": ("testclient", 123),
        "http_version": "1.1",
    }

    async def call_next(_request):
        return Response("should not run")

    response = asyncio.run(server.csrf_protection(Request(scope), call_next))

    assert response.status_code == 403


def test_stale_edit_returns_reload_guidance(monkeypatch):
    fake = AtomicEditDb()
    monkeypatch.setattr(server, "db", fake)

    with pytest.raises(HTTPException) as exc:
        asyncio.run(server.update_user(
            "user-1",
            server.UserEditIn(name="Stale", expected_revision=0, expected_updated_at="before"),
            ADMIN,
        ))
    assert exc.value.status_code == 409
