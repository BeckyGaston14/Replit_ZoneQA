"""Regression coverage for sparse imported records on shared read-model routes."""

import asyncio

import server
from fastapi.testclient import TestClient


class _Cursor:
    def __init__(self, rows):
        self.rows = rows

    def sort(self, *_args, **_kwargs):
        return self

    async def to_list(self, _limit):
        return [dict(row) for row in self.rows]


class _Collection:
    def __init__(self, database, name):
        self.database = database
        self.name = name

    def find(self, *_args, **_kwargs):
        return _Cursor(self.database.records.get(self.name, []))

    async def find_one(self, query, *_args, **_kwargs):
        for row in self.database.records.get(self.name, []):
            if all(row.get(key) == value for key, value in query.items()):
                return dict(row)
        return None


class _Database:
    def __init__(self):
        self.records = {
            "config": [{
                "id": "global",
                "eval_dimensions": [{"key": "accuracy", "weight": 1}],
            }],
            "versions": [{"id": "version-1", "name": "Imported v1", "active": True}],
            "projects": [
                {
                    "id": "project-1",
                    "name": "Imported project",
                    "status": "Active",
                    "owner_id": "owner-1",
                    "owner": "Legacy Owner",
                },
                {
                    "id": "project-2",
                    "name": "Owner-only imported project",
                    "status": "Active",
                    "owner": "Owner-only Legacy Owner",
                },
            ],
            "users": [{"id": "owner-1", "name": "Imported Owner", "active": True}],
            "testcases": [{
                "id": "testcase-1",
                "project_id": "project-1",
                "status": "Draft",
            }],
            "evaluations": [
                {
                    "id": f"evaluation-{model.lower()}",
                    "testcase_id": "testcase-1",
                    "model": model,
                    "final_result": "Pass with Notes" if model == "Bassett" else "Pass",
                    "scores": {"accuracy": 8},
                    "bassett_version": "Imported v1",
                    "created_at": "2026-09-01T12:00:00Z",
                }
                for model in ("Bassett", "ChatGPT", "Claude")
            ],
        }

    def __getitem__(self, name):
        return _Collection(self, name)

    def __getattr__(self, name):
        return _Collection(self, name)


def _install_sparse_import_db(monkeypatch):
    database = _Database()
    monkeypatch.setattr(server, "db", database)
    return database


def test_summary_projects_and_integrity_accept_sparse_imported_records(monkeypatch):
    database = _install_sparse_import_db(monkeypatch)
    admin = {"id": "admin", "role": "admin", "name": "Admin"}
    server.app.dependency_overrides[server.get_current_user] = lambda: admin
    try:
        client = TestClient(server.app)
        summary_response = client.get("/api/metrics/summary")
        enriched_response = client.get("/api/list/projects-enriched?include_archived=true")
        integrity_response = client.get("/api/admin/integrity")
    finally:
        server.app.dependency_overrides.pop(server.get_current_user, None)

    assert summary_response.status_code == 200
    assert enriched_response.status_code == 200
    assert integrity_response.status_code == 200
    assert summary_response.json()["bassett_current"]["passed"] == 1
    enriched = enriched_response.json()
    owners = {project["id"]: project["owner"] for project in enriched}
    assert owners["project-1"] == "Imported Owner"
    assert owners["project-2"] == "Owner-only Legacy Owner"
    assert enriched[0]["owner_id"] == "owner-1"
    assert set(integrity_response.json()["counts"]) == {"high", "medium", "low"}
    assert database.records["projects"][0]["owner_id"] == "owner-1"