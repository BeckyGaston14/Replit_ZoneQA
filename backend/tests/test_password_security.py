"""Focused coverage for self-service and one-time password recovery."""

import asyncio
import copy
from datetime import datetime, timedelta, timezone
from types import SimpleNamespace

import pytest
from fastapi import HTTPException, Response

import server


class Collection:
    def __init__(self, documents=None):
        self.documents = list(documents or [])

    async def find_one(self, query, *_args, **_kwargs):
        for document in self.documents:
            matches = True
            for key, expected in query.items():
                actual = document.get(key)
                if isinstance(expected, dict) and "$exists" in expected:
                    matches = matches and ((key in document) == expected["$exists"])
                elif actual != expected:
                    matches = False
            if matches:
                result = copy.deepcopy(document)
                projection = _args[0] if _args else _kwargs.get("projection")
                if projection:
                    for key, enabled in projection.items():
                        if not enabled:
                            result.pop(key, None)
                return result
        return None

    async def update_one(self, query, update, **_kwargs):
        document = next((item for item in self.documents if item.get("id") == query.get("id")), None)
        if document:
            document.update(copy.deepcopy(update.get("$set", {})))
            for key in update.get("$unset", {}):
                document.pop(key, None)

    async def insert_one(self, document):
        self.documents.append(copy.deepcopy(document))

    async def count_documents(self, query):
        return sum(1 for item in self.documents if item.get("role") == query.get("role"))


class PasswordDb:
    def __init__(self):
        self.user = {
            "id": "user-1",
            "email": "user@example.com",
            "name": "Test User",
            "role": "tester",
            "active": True,
            "revision": 1,
            "password_hash": server.hash_password("original-password"),
        }
        self.users = Collection([self.user])
        self.activities = Collection()
        self.tokens = {}
        self.sessions = {}

    async def create_auth_session(self, document):
        self.sessions[document["id"]] = copy.deepcopy(document)

    async def get_auth_session(self, identifier):
        return copy.deepcopy(self.sessions.get(identifier))

    async def revoke_auth_session(self, identifier):
        self.sessions.pop(identifier, None)

    async def consume_auth_rate_limit(self, *_args):
        return {"allowed": True}

    async def rotate_password_reset(self, user_id, reset_document, _now, _cooldown):
        if user_id != self.user["id"] or self.user.get("active") is False:
            return {"error": "not_found"}
        for token in self.tokens.values():
            if token.get("user_id") == user_id and not token.get("used_at") and not token.get("revoked_at"):
                token["revoked_at"] = reset_document["created_at"]
        self.tokens[reset_document["id"]] = copy.deepcopy(reset_document)
        self.user["password_reset_last_attempted_at"] = reset_document["created_at"]
        return {"user": copy.deepcopy(self.user)}

    async def get_password_reset(self, identifier):
        return copy.deepcopy(self.tokens.get(identifier))

    async def change_password_with_current(
        self, user_id, expected_hash, password_hash, history, timestamp, activity
    ):
        if user_id != self.user["id"] or self.user["password_hash"] != expected_hash:
            return {"error": "stale_password"}
        self.user.update({
            "password_hash": password_hash,
            "password_history": history[:5],
            "password_changed_at": timestamp,
            "revision": self.user["revision"] + 1,
        })
        revoked = len(self.sessions)
        self.sessions = {}
        await self.activities.insert_one(activity)
        return {"user": {key: value for key, value in self.user.items() if key not in {"password_hash", "password_history"}}, "sessions_revoked": revoked}

    async def consume_password_reset_with_password(
        self, reset_id, now, password_hash, history, expected_password_hash, activity
    ):
        token = self.tokens.get(reset_id)
        if not token or token.get("used_at") or token.get("revoked_at"):
            return {"error": "invalid"}
        if datetime.fromisoformat(token["expires_at"]) <= datetime.fromisoformat(now):
            return {"error": "invalid"}
        if self.user["password_hash"] != expected_password_hash:
            return {"error": "invalid"}
        self.user.update({
            "password_hash": password_hash,
            "password_history": history[:5],
            "password_changed_at": now,
            "revision": self.user["revision"] + 1,
        })
        token["used_at"] = now
        revoked = len(self.sessions)
        self.sessions = {}
        await self.activities.insert_one(activity)
        return {"user": copy.deepcopy(self.user), "sessions_revoked": revoked}


def request(host="127.0.0.1"):
    return SimpleNamespace(client=SimpleNamespace(host=host))


def strong(value="a-new-password-123"):
    return server.PasswordChangeIn(
        current_password="original-password",
        new_password=value,
        new_password_confirmation=value,
    )


def test_self_change_verifies_current_password_and_reissues_one_session(monkeypatch):
    fake = PasswordDb()
    monkeypatch.setattr(server, "db", fake)
    fake.sessions = {"old-1": {"user_id": "user-1"}, "old-2": {"user_id": "user-1"}}

    response = Response()
    result = asyncio.run(server.change_password(strong(), request(), response, fake.user))

    assert result["ok"] is True
    assert result["sessions_revoked"] == 2
    assert len(fake.sessions) == 1
    assert server.verify_password("a-new-password-123", fake.user["password_hash"])
    assert fake.activities.documents[-1]["action"] == "password changed"
    assert "original-password" not in str(fake.activities.documents[-1])
    assert "password_hash" not in str(result)


def test_self_change_rejects_wrong_current_and_reused_password(monkeypatch):
    fake = PasswordDb()
    monkeypatch.setattr(server, "db", fake)
    wrong = server.PasswordChangeIn(
        current_password="not-the-password",
        new_password="a-new-password-123",
        new_password_confirmation="a-new-password-123",
    )
    with pytest.raises(HTTPException, match="Unable to change password"):
        asyncio.run(server.change_password(wrong, request(), Response(), fake.user))
    reused = server.PasswordChangeIn(
        current_password="original-password",
        new_password="original-password",
        new_password_confirmation="original-password",
    )
    with pytest.raises(HTTPException, match="not used recently"):
        asyncio.run(server.change_password(reused, request(), Response(), fake.user))


def test_admin_reset_is_confirmed_and_token_is_hashed(monkeypatch):
    fake = PasswordDb()
    sender = server.MockEmailSender()
    monkeypatch.setattr(server, "db", fake)
    monkeypatch.setattr(server, "email_sender", sender)
    monkeypatch.setenv("ZONEQA_APP_URL", "https://zoneqa.example")
    admin = {"id": "admin-1", "name": "Admin", "role": "admin"}

    result = asyncio.run(server.request_password_reset(
        "user-1", server.AdminPasswordResetIn(confirm=True), request(), admin
    ))
    raw_token = result["reset_path"].split("token=", 1)[1]
    assert result["email"]["sent"] is True
    assert raw_token not in str(fake.tokens)
    assert sender.sent[0]["reset_link"].endswith(raw_token)
    assert fake.activities.documents[-1]["action"] == "password reset link sent"


def test_reset_is_single_use_and_revokes_target_sessions(monkeypatch):
    fake = PasswordDb()
    sender = server.MockEmailSender()
    monkeypatch.setattr(server, "db", fake)
    monkeypatch.setattr(server, "email_sender", sender)
    monkeypatch.setenv("ZONEQA_APP_URL", "https://zoneqa.example")
    admin = {"id": "admin-1", "name": "Admin", "role": "admin"}
    fake.sessions = {"target-session": {"user_id": "user-1"}}
    issued = asyncio.run(server.request_password_reset(
        "user-1", server.AdminPasswordResetIn(confirm=True), request(), admin
    ))
    token = issued["reset_path"].split("token=", 1)[1]
    reset = server.PasswordResetIn(
        token=token,
        new_password="reset-password-123",
        new_password_confirmation="reset-password-123",
    )
    result = asyncio.run(server.reset_password(reset, request()))
    assert result["ok"] is True
    assert fake.sessions == {}
    assert fake.tokens[f"password_reset:{server._digest(token)}"]["used_at"]
    with pytest.raises(HTTPException, match="invalid, expired, or already used"):
        asyncio.run(server.reset_password(reset, request()))


def test_forgot_password_does_not_enumerate_unknown_or_cooldown_accounts(monkeypatch):
    fake = PasswordDb()
    monkeypatch.setattr(server, "db", fake)
    monkeypatch.setattr(server, "email_sender", server.MockEmailSender())
    monkeypatch.setenv("ZONEQA_APP_URL", "https://zoneqa.example")
    unknown = asyncio.run(server.forgot_password(
        server.PasswordResetRequestIn(email="unknown@example.com"), request()
    ))
    known = asyncio.run(server.forgot_password(
        server.PasswordResetRequestIn(email="user@example.com"), request()
    ))
    again = asyncio.run(server.forgot_password(
        server.PasswordResetRequestIn(email="user@example.com"), request()
    ))
    assert unknown == known
    assert again == known
    assert "user@example.com" not in str(unknown)


def test_reset_expiry_is_rejected(monkeypatch):
    fake = PasswordDb()
    monkeypatch.setattr(server, "db", fake)
    token = "expired-token-" + "x" * 24
    fake.tokens[f"password_reset:{server._digest(token)}"] = {
        "purpose": "password_reset",
        "user_id": "user-1",
        "expires_at": (datetime.now(timezone.utc) - timedelta(minutes=1)).isoformat(),
        "used_at": None,
        "revoked_at": None,
    }
    with pytest.raises(HTTPException, match="invalid, expired, or already used"):
        asyncio.run(server.reset_password(server.PasswordResetIn(
            token=token,
            new_password="reset-password-123",
            new_password_confirmation="reset-password-123",
        ), request()))