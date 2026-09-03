"""Isolated Add User workflow checks; no live services or product data writes."""

import asyncio
from datetime import datetime, timezone, timedelta

import pytest
from fastapi import HTTPException, Response
from pydantic import ValidationError

import server


def matches(document, query):
    for key, expected in query.items():
        actual = document.get(key)
        if isinstance(expected, dict):
            if "$exists" in expected and (key in document) != expected["$exists"]:
                return False
            if "$ne" in expected and actual == expected["$ne"]:
                return False
        elif actual != expected:
            return False
    return True


class FakeCursor:
    def __init__(self, documents):
        self.documents = documents

    async def to_list(self, limit):
        return [dict(item) for item in self.documents[:limit]]


class FakeCollection:
    def __init__(self, documents=None):
        self.documents = list(documents or [])

    async def find_one(self, query, *_args, **_kwargs):
        return next((dict(item) for item in self.documents if matches(item, query)), None)

    def find(self, query=None, *_args, **_kwargs):
        return FakeCursor([item for item in self.documents if matches(item, query or {})])

    async def insert_one(self, document):
        self.documents.append(dict(document))

    async def update_one(self, query, update, **_kwargs):
        item = next((item for item in self.documents if matches(item, query)), None)
        if item:
            item.update(update.get("$set", {}))
            for key in update.get("$unset", {}):
                item.pop(key, None)

    async def count_documents(self, query):
        return sum(1 for item in self.documents if matches(item, query))


class FakeDb:
    def __init__(self, users=None):
        self.users = FakeCollection(users)
        self.activities = FakeCollection()
        self.testcases = FakeCollection([{"id": "tc1"}])
        self.setups = {}
        self.sessions = {}

    def __getitem__(self, name):
        return getattr(self, name)

    async def create_user_with_setup(self, user, setup):
        if any(item["email"].lower() == user["email"].lower() for item in self.users.documents):
            raise AssertionError("Duplicate should be rejected before insert")
        self.users.documents.append(dict(user))
        self.setups[setup["id"]] = dict(setup)

    async def rotate_user_setup(self, user_id, setup, now, cooldown_seconds=60):
        user = next((item for item in self.users.documents if item["id"] == user_id), None)
        if not user or user.get("deleted_at"):
            return {"error": "not_found"}
        if user.get("active") is False:
            return {"error": "inactive"}
        if user.get("password_hash") or user.get("activated_at"):
            return {"error": "activated"}
        last_attempted = user.get("welcome_email_last_attempted_at")
        if last_attempted:
            elapsed = (datetime.fromisoformat(now) - datetime.fromisoformat(last_attempted)).total_seconds()
            remaining = cooldown_seconds - int(elapsed)
            if remaining > 0:
                return {"error": "cooldown", "remaining": remaining}
        for prior in self.setups.values():
            if prior.get("user_id") == user_id and not prior.get("used_at") and not prior.get("revoked_at"):
                prior["revoked_at"] = now
        self.setups[setup["id"]] = dict(setup)
        user.update({
            "welcome_email_status": "pending",
            "welcome_email_last_attempted_at": now,
            "welcome_email_last_error": None,
            "activation_expires_at": setup["expires_at"],
        })
        return {"user": dict(user)}

    async def activate_user_with_password(self, setup_id, now, password_hash):
        setup = self.setups.get(setup_id)
        if (
            not setup
            or setup.get("used_at")
            or setup.get("revoked_at")
            or datetime.fromisoformat(setup["expires_at"]) <= datetime.fromisoformat(now)
        ):
            return None
        user = next((item for item in self.users.documents if item["id"] == setup["user_id"]), None)
        if not user or user.get("deleted_at"):
            return None
        user.update({
            "password_hash": password_hash,
            "auth_provider": "password",
            "activated_at": now,
            "welcome_email_status": "activated",
            "updated_at": now,
        })
        setup["used_at"] = now
        return dict(user)

    async def create_auth_session(self, document):
        self.sessions[document["id"]] = dict(document)

    async def revoke_auth_sessions_for_user(self, user_id):
        identifiers = [key for key, session in self.sessions.items() if session.get("user_id") == user_id]
        for identifier in identifiers:
            self.sessions.pop(identifier)
        return len(identifiers)

    async def get_auth_session(self, session_id):
        session = self.sessions.get(session_id)
        return dict(session) if session else None

    async def revoke_auth_session(self, session_id):
        self.sessions.pop(session_id, None)


ADMIN = {"id": "admin-1", "name": "Admin User", "email": "admin@example.com", "role": "admin"}


def create_body(**overrides):
    return server.UserCreateIn(**{
        "name": "  New Tester  ",
        "email": " New.Tester@Example.COM ",
        "role": "tester",
        "active": True,
        **overrides,
    })


def test_deactivation_revokes_sessions_and_is_audited(monkeypatch):
    target = {"id": "user-1", "name": "Target User", "email": "target@example.com",
              "role": "tester", "active": True}
    fake = FakeDb([ADMIN, target])
    fake.sessions = {
        "auth_session:one": {"user_id": target["id"]},
        "auth_session:two": {"user_id": target["id"]},
        "auth_session:admin": {"user_id": ADMIN["id"]},
    }
    monkeypatch.setattr(server, "db", fake)

    result = asyncio.run(server.deactivate_user(target["id"], ADMIN))

    stored = next(user for user in fake.users.documents if user["id"] == target["id"])
    assert stored["active"] is False
    assert result["sessions_revoked"] == 2
    assert list(fake.sessions) == ["auth_session:admin"]
    assert fake.activities.documents[-1]["action"] == "deactivated"
    assert '"history_preserved": true' in fake.activities.documents[-1]["detail"]


def test_user_lifecycle_blocks_self_and_last_active_admin(monkeypatch):
    fake = FakeDb([ADMIN])
    monkeypatch.setattr(server, "db", fake)

    with pytest.raises(HTTPException, match="own current account") as self_error:
        asyncio.run(server.deactivate_user(ADMIN["id"], ADMIN))
    assert self_error.value.status_code == 409

    other_actor = {"id": "admin-2", "name": "Other Admin", "role": "admin"}
    with pytest.raises(HTTPException, match="last active administrator") as last_admin_error:
        asyncio.run(server.deactivate_user(ADMIN["id"], other_actor))
    assert last_admin_error.value.status_code == 409


def test_reactivation_restores_active_state_and_is_audited(monkeypatch):
    target = {"id": "user-1", "name": "Target User", "email": "target@example.com",
              "role": "tester", "active": False, "deactivated_at": "2026-01-01",
              "deactivated_by": ADMIN["id"]}
    fake = FakeDb([ADMIN, target])
    monkeypatch.setattr(server, "db", fake)

    result = asyncio.run(server.reactivate_user(target["id"], ADMIN))

    stored = next(user for user in fake.users.documents if user["id"] == target["id"])
    assert stored["active"] is True
    assert "deactivated_at" not in stored
    assert result["active"] is True
    assert fake.activities.documents[-1]["action"] == "reactivated"


def test_admin_creates_normalized_user_with_one_time_setup_and_audit(monkeypatch):
    fake = FakeDb()
    monkeypatch.setattr(server, "db", fake)
    result = asyncio.run(server.create_user(create_body(), ADMIN))

    user = result["user"]
    assert user["name"] == "New Tester"
    assert user["email"] == "new.tester@example.com"
    assert user["created_by_id"] == ADMIN["id"]
    assert user["created_by"] == ADMIN["name"]
    assert user["created_at"]
    assert user["active"] is True
    assert "password_hash" not in user
    assert result["activation_path"].startswith("/activate?token=")
    raw_token = result["activation_path"].split("token=", 1)[1]
    assert all(raw_token not in str(value) for value in fake.setups.values())

    activity = fake.activities.documents[0]
    assert activity["entity_id"] == user["id"]
    assert activity["action"] == "created"
    assert ADMIN["id"] in activity["detail"]
    assert raw_token not in str(activity)


def test_creation_can_skip_welcome_email_without_attempting_delivery(monkeypatch):
    fake = FakeDb()
    sender = server.MockEmailSender()
    monkeypatch.setattr(server, "db", fake)
    monkeypatch.setattr(server, "email_sender", sender)

    result = asyncio.run(server.create_user(
        create_body(send_welcome_email=False),
        ADMIN,
    ))

    assert result["welcome_email"] == {
        "requested": False,
        "sent": False,
        "status": "not_requested",
    }
    assert sender.sent == []
    assert fake.activities.documents[-1]["action"] == "welcome email skipped"


def test_creation_failure_keeps_user_and_reports_safe_delivery_failure(monkeypatch):
    fake = FakeDb()
    sender = server.MockEmailSender()
    monkeypatch.setattr(server, "db", fake)
    monkeypatch.setattr(server, "email_sender", sender)
    monkeypatch.delenv("ZONEQA_APP_URL", raising=False)

    result = asyncio.run(server.create_user(create_body(), ADMIN))

    assert result["welcome_email"]["status"] == "failed"
    assert result["welcome_email"]["sent"] is False
    assert "published app URL" in result["welcome_email"]["message"]
    assert len(fake.users.documents) == 1
    assert fake.users.documents[0]["welcome_email_status"] == "failed"
    assert "token=" not in result["welcome_email"]["message"]


def test_resend_rotates_setup_and_sends_only_for_pending_active_users(monkeypatch):
    fake = FakeDb([ADMIN, {
        "id": "pending-1", "name": "Pending User", "email": "pending@example.com",
        "role": "tester", "active": True,
    }])
    sender = server.MockEmailSender()
    monkeypatch.setattr(server, "db", fake)
    monkeypatch.setattr(server, "email_sender", sender)
    monkeypatch.setenv("ZONEQA_APP_URL", "https://zone-qa.example")
    monkeypatch.setenv("WELCOME_EMAIL_COOLDOWN_SECONDS", "60")

    result = asyncio.run(server.resend_welcome_email("pending-1", ADMIN))

    assert result["welcome_email"]["sent"] is True
    assert sender.sent[0]["recipient"] == "pending@example.com"
    assert sender.sent[0]["role_label"] == "Tester"
    assert sender.sent[0]["activation_link"].startswith("https://zone-qa.example/activate?token=")
    assert all(sender.sent[0]["activation_link"].split("token=", 1)[1] not in str(setup)
               for setup in fake.setups.values())
    assert fake.activities.documents[-1]["action"] == "welcome email resent"


@pytest.mark.parametrize("target", [
    {"id": "inactive", "name": "Inactive", "email": "inactive@example.com", "role": "tester", "active": False},
    {"id": "active", "name": "Active", "email": "active@example.com", "role": "tester", "active": True,
     "password_hash": "already-set"},
])
def test_resend_blocks_inactive_or_activated_users(monkeypatch, target):
    fake = FakeDb([ADMIN, target])
    monkeypatch.setattr(server, "db", fake)
    monkeypatch.setenv("ZONEQA_APP_URL", "https://zone-qa.example")

    with pytest.raises(HTTPException) as exc:
        asyncio.run(server.resend_welcome_email(target["id"], ADMIN))
    assert exc.value.status_code == 409


def test_resend_cooldown_is_enforced(monkeypatch):
    target = {
        "id": "pending-2", "name": "Pending", "email": "pending2@example.com",
        "role": "tester", "active": True,
        "welcome_email_last_attempted_at": datetime.now(timezone.utc).isoformat(),
    }
    fake = FakeDb([ADMIN, target])
    monkeypatch.setattr(server, "db", fake)
    monkeypatch.setenv("ZONEQA_APP_URL", "https://zone-qa.example")
    monkeypatch.setenv("WELCOME_EMAIL_COOLDOWN_SECONDS", "60")

    with pytest.raises(HTTPException, match="cooldown") as exc:
        asyncio.run(server.resend_welcome_email(target["id"], ADMIN))
    assert exc.value.status_code == 429


def test_revoked_setup_cannot_be_used(monkeypatch):
    fake = FakeDb()
    monkeypatch.setattr(server, "db", fake)
    token = "revoked-token-" + ("x" * 24)
    fake.setups[f"user_setup:{server._digest(token)}"] = {
        "user_id": "u1",
        "expires_at": (datetime.now(timezone.utc) + timedelta(hours=1)).isoformat(),
        "used_at": None,
        "revoked_at": datetime.now(timezone.utc).isoformat(),
    }

    with pytest.raises(HTTPException) as exc:
        asyncio.run(server.activate_user(
            server.ActivateUserIn(token=token, password="a-strong-password-123"),
            Response(),
        ))
    assert exc.value.status_code == 400


def test_duplicate_email_is_case_insensitive(monkeypatch):
    fake = FakeDb([{"id": "u1", "email": "new.tester@example.com"}])
    monkeypatch.setattr(server, "db", fake)
    with pytest.raises(HTTPException) as exc:
        asyncio.run(server.create_user(create_body(email="NEW.TESTER@EXAMPLE.COM"), ADMIN))
    assert exc.value.status_code == 409


def test_invalid_role_and_missing_fields_are_rejected(monkeypatch):
    monkeypatch.setattr(server, "db", FakeDb())
    with pytest.raises(HTTPException) as exc:
        asyncio.run(server.create_user(create_body(role="owner"), ADMIN))
    assert exc.value.status_code == 400
    with pytest.raises(ValidationError):
        server.UserCreateIn(email="valid@example.com", role="tester")


def test_non_admin_dependency_rejects_creation():
    checker = server.require_roles("admin")
    with pytest.raises(HTTPException) as exc:
        asyncio.run(checker(user={"role": "qa_manager"}))
    assert exc.value.status_code == 403


def test_activation_is_single_use_and_sets_strong_hash(monkeypatch):
    fake = FakeDb()
    monkeypatch.setattr(server, "db", fake)
    created = asyncio.run(server.create_user(create_body(), ADMIN))
    token = created["activation_path"].split("token=", 1)[1]
    response = Response()
    result = asyncio.run(server.activate_user(
        server.ActivateUserIn(token=token, password="a-strong-password-123"),
        response,
    ))
    assert result["ok"] is True
    stored = fake.users.documents[0]
    assert server.verify_password("a-strong-password-123", stored["password_hash"])
    assert "password_hash" not in str(result)
    assert all("a-strong-password-123" not in str(value) for value in fake.setups.values())
    activation_activity = fake.activities.documents[-1]
    assert activation_activity["action"] == "password setup completed"
    assert token not in str(activation_activity)
    assert "activated_at" in activation_activity["detail"]

    with pytest.raises(HTTPException) as exc:
        asyncio.run(server.activate_user(
            server.ActivateUserIn(token=token, password="another-strong-password"),
            Response(),
        ))
    assert exc.value.status_code == 400


def test_expired_activation_is_rejected(monkeypatch):
    fake = FakeDb()
    monkeypatch.setattr(server, "db", fake)
    token = "x" * 32
    fake.setups[f"user_setup:{server._digest(token)}"] = {
        "user_id": "u1",
        "expires_at": (datetime.now(timezone.utc) - timedelta(minutes=1)).isoformat(),
        "used_at": None,
    }
    with pytest.raises(HTTPException) as exc:
        asyncio.run(server.activate_user(
            server.ActivateUserIn(token=token, password="a-strong-password-123"),
            Response(),
        ))
    assert exc.value.status_code == 400


def test_invalid_and_inactive_login_are_rejected(monkeypatch):
    password_hash = server.hash_password("a-strong-password-123")
    inactive = {
        "id": "inactive-login",
        "email": "inactive@example.com",
        "name": "Inactive Login",
        "role": "tester",
        "active": False,
        "password_hash": password_hash,
    }
    fake = FakeDb([inactive])
    monkeypatch.setattr(server, "db", fake)

    with pytest.raises(HTTPException) as invalid:
        asyncio.run(server.login(server.LoginIn(email="inactive@example.com", password="wrong-password"), Response()))
    assert invalid.value.status_code == 401

    with pytest.raises(HTTPException) as inactive_error:
        asyncio.run(server.login(server.LoginIn(email="inactive@example.com", password="a-strong-password-123"), Response()))
    assert inactive_error.value.status_code == 403
    assert "inactive" in str(inactive_error.value.detail).lower()


def test_expired_and_revoked_sessions_are_rejected(monkeypatch):
    now = datetime.now(timezone.utc)
    fake = FakeDb([ADMIN])
    monkeypatch.setattr(server, "db", fake)

    expired_raw = "expired-session"
    expired_id = f"auth_session:{server._digest(expired_raw)}"
    fake.sessions[expired_id] = {
        "user_id": ADMIN["id"],
        "expires_at": (now - timedelta(minutes=1)).isoformat(),
    }
    with pytest.raises(HTTPException, match="Session expired") as expired:
        asyncio.run(server.get_user_from_session(expired_raw))
    assert expired.value.status_code == 401
    assert expired_id not in fake.sessions

    revoked_raw = "revoked-session"
    revoked_id = f"auth_session:{server._digest(revoked_raw)}"
    fake.sessions[revoked_id] = {
        "user_id": ADMIN["id"],
        "expires_at": (now + timedelta(minutes=10)).isoformat(),
    }
    fake.sessions.pop(revoked_id)
    with pytest.raises(HTTPException, match="Not authenticated") as revoked:
        asyncio.run(server.get_user_from_session(revoked_raw))
    assert revoked.value.status_code == 401


def test_inactive_user_cannot_be_assigned(monkeypatch):
    fake = FakeDb([{
        "id": "inactive",
        "email": "inactive@example.com",
        "name": "Inactive User",
        "role": "tester",
        "active": False,
    }])
    monkeypatch.setattr(server, "db", fake)
    with pytest.raises(HTTPException) as exc:
        asyncio.run(server.assign_entity(
            {"entity_type": "testcases", "entity_id": "tc1", "assignee_id": "inactive"},
            ADMIN,
        ))
    assert exc.value.status_code == 404