"""Focused tests for per-user sample visibility and relationship scoping."""
import asyncio

import server


class Cursor:
    def __init__(self, rows):
        self.rows = rows

    def sort(self, *_args, **_kwargs):
        return self

    async def to_list(self, limit):
        return [dict(row) for row in self.rows[:limit]]


class Collection:
    def __init__(self, db, name):
        self.db, self.name = db, name

    async def find_one(self, query, *_args, **_kwargs):
        for row in self.db.rows.get(self.name, []):
            if all(row.get(key) == value for key, value in query.items()):
                return dict(row)
        return None

    def find(self, query=None, *_args, **_kwargs):
        query = query or {}
        return Cursor([
            row for row in self.db.rows.get(self.name, [])
            if all(row.get(key) == value for key, value in query.items())
        ])

    async def update_one(self, query, update, upsert=False, **_kwargs):
        row = next(
            (row for row in self.db.rows.get(self.name, [])
             if all(row.get(key) == value for key, value in query.items())),
            None,
        )
        if row is None and upsert:
            row = dict(query)
            self.db.rows.setdefault(self.name, []).append(row)
        if row is not None:
            row.update(update.get("$set", {}))
            for key in update.get("$unset", {}):
                row.pop(key, None)

    async def insert_one(self, document):
        self.db.rows.setdefault(self.name, []).append(dict(document))


class Db:
    def __init__(self, rows):
        self.rows = rows

    def __getattr__(self, name):
        return Collection(self, name)

    def __getitem__(self, name):
        return Collection(self, name)


def test_sample_scope_hides_direct_and_linked_records(monkeypatch):
    scope = {
        "projects": {"sample-project"},
        "testcases": {"sample-test"},
        "municipalities": {"sample-municipality"},
        "properties": {"sample-property"},
        "evidence": {"sample-evidence"},
        "versions": {"sample-version"},
        "version_names": {"Bassett Sample"},
    }
    monkeypatch.setattr(server, "_sample_visibility_context", server.ContextVar("test_visibility"))
    monkeypatch.setattr(server, "_sample_scope_context", server.ContextVar("test_scope"))
    server._sample_visibility_context.set(False)
    server._sample_scope_context.set(scope)

    records = [
        {"id": "production", "name": "Production"},
        {"id": "sample-by-flag", "sample_data": True},
        {"id": "sample-by-parent", "testcase_id": "sample-test"},
        {"id": "sample-by-version", "bassett_version": "Bassett Sample"},
    ]
    assert [record["id"] for record in server._filter_sample_scope("evaluations", records)] == ["production"]

    server._sample_visibility_context.set(True)
    assert [record["id"] for record in server._filter_sample_scope("evaluations", records)] == [
        "production", "sample-by-flag", "sample-by-parent", "sample-by-version",
    ]


def test_model_configuration_is_never_hidden_with_sample_records(monkeypatch):
    monkeypatch.setattr(server, "_sample_visibility_context", server.ContextVar("test_visibility"))
    monkeypatch.setattr(server, "_sample_scope_context", server.ContextVar("test_scope"))
    server._sample_visibility_context.set(False)
    server._sample_scope_context.set({
        "projects": set(), "testcases": set(), "municipalities": set(),
        "properties": set(), "evidence": set(), "versions": set(),
        "version_names": set(),
    })
    legacy_models = [
        {"id": "model-bassett", "name": "Bassett", "sample_data": True},
        {"id": "model-custom", "name": "Custom evaluator"},
    ]

    assert server._filter_sample_scope("models", legacy_models) == legacy_models


def test_startup_model_defaults_preserve_admin_models_and_repair_legacy_sample_flag(monkeypatch):
    rows = {"models": [
        {
            "id": "legacy-bassett", "name": "Bassett", "provider": "Administrator value",
            "role_type": "Primary", "active": False, "sample_data": True,
        },
        {"id": "custom", "name": "Custom evaluator", "provider": "Internal", "active": True},
    ]}
    monkeypatch.setattr(server, "db", Db(rows))

    asyncio.run(server._ensure_default_models())

    by_name = {record["name"]: record for record in rows["models"]}
    assert set(by_name) == {"Bassett", "ChatGPT", "Claude", "Custom evaluator"}
    assert by_name["Bassett"]["provider"] == "Administrator value"
    assert by_name["Bassett"]["active"] is False
    assert "sample_data" not in by_name["Bassett"]


def test_sample_visibility_preference_is_isolated_per_user(monkeypatch):
    db = Db({"saved_views": []})
    monkeypatch.setattr(server, "db", db)
    server._SAMPLE_SCOPE_CACHE = None
    server._SAMPLE_SCOPE_CACHE_AT = 0

    asyncio.run(server.put_sample_visibility(
        {"include_sample_records": True}, {"id": "user-a", "role": "viewer"}
    ))
    assert asyncio.run(server._sample_preference("user-a")) is True
    assert asyncio.run(server._sample_preference("user-b")) is False

    asyncio.run(server.put_sample_visibility(
        {"include_sample_records": False}, {"id": "user-a", "role": "viewer"}
    ))
    assert asyncio.run(server._sample_preference("user-a")) is False
    assert db.rows["saved_views"][0]["user_id"] == "user-a"
    assert db.rows["saved_views"][0]["page"] == server.SAMPLE_VISIBILITY_PAGE


def test_request_scope_reads_the_saved_visibility_preference(monkeypatch):
    db = Db({"saved_views": []})
    monkeypatch.setattr(server, "db", db)
    monkeypatch.setattr(server, "_sample_visibility_context", server.ContextVar("request_visibility"))
    monkeypatch.setattr(server, "_sample_scope_context", server.ContextVar("request_scope"))

    asyncio.run(server.put_sample_visibility(
        {"include_sample_records": True}, {"id": "user-a", "role": "viewer"}
    ))
    user = {"id": "user-a", "role": "viewer"}
    assert asyncio.run(server._set_sample_scope_for_user(user)) is True
    assert user["include_sample_records"] is True
    assert server._sample_visibility_context.get() is True


def test_loading_sample_data_invalidates_the_visibility_cache(monkeypatch):
    async def fake_seed(*_args, **_kwargs):
        return {"loaded": True, "testcases": 10}

    async def fake_activity(*_args, **_kwargs):
        return None

    monkeypatch.setattr(server, "run_seed_impl", fake_seed)
    monkeypatch.setattr(server, "log_activity", fake_activity)
    server._SAMPLE_SCOPE_CACHE = {"testcases": set()}
    server._SAMPLE_SCOPE_CACHE_AT = 123

    result = asyncio.run(server.sample_data(True, {"id": "admin", "role": "admin"}))
    assert result["loaded"] is True
    assert server._SAMPLE_SCOPE_CACHE is None
    assert server._SAMPLE_SCOPE_CACHE_AT == 0.0


def test_sample_preference_does_not_delete_or_mutate_sample_records(monkeypatch):
    rows = {
        "saved_views": [],
        "projects": [{"id": "sample-project", "name": "[SAMPLE] Project", "sample_data": True}],
        "testcases": [{"id": "sample-test", "name": "[SAMPLE] Test", "sample_data": True}],
        "municipalities": [], "properties": [], "evidence": [], "versions": [],
    }
    db = Db(rows)
    monkeypatch.setattr(server, "db", db)
    server._SAMPLE_SCOPE_CACHE = None
    server._SAMPLE_SCOPE_CACHE_AT = 0

    asyncio.run(server.put_sample_visibility(
        {"include_sample_records": False}, {"id": "user-a", "role": "viewer"}
    ))
    assert rows["projects"][0]["sample_data"] is True
    assert rows["testcases"][0]["name"] == "[SAMPLE] Test"
