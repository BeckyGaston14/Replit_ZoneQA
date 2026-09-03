import asyncio
import pytest
from fastapi import HTTPException

import server


class CountCollection:
    def __init__(self, count=0, document=None):
        self.count = count
        self.document = document

    async def count_documents(self, query):
        return self.count

    async def find_one(self, query, projection=None):
        return self.document


class LifecycleDb:
    def __init__(self, testcase, counts=None, documents=None):
        counts = counts or {}
        documents = documents or {}
        names = {
            "responses", "evaluations", "goldstandards", "findings", "retests",
            "test_runs", "demos", "annotations", "claims", "comments",
            "activities", "attachments", "calendar_events", "bassett_issues",
            "bassett_scenarios", "bassett_executions", "regression_runs",
        }
        for name in names:
            setattr(self, name, CountCollection(counts.get(name, 0), documents.get(name)))
        self.testcases = CountCollection(counts.get("variants", 0), testcase)

    def __getitem__(self, name):
        return getattr(self, name)


def test_preflight_counts_expanded_testcase_itself(monkeypatch):
    testcase = {
        "id": "tc-expanded", "name": "Expanded comparison",
        "bassett_issue_id": "issue-123", "evidence_ids": [],
    }
    monkeypatch.setattr(server, "db", LifecycleDb(testcase))

    counts = asyncio.run(server._testcase_dependency_counts(testcase["id"]))

    assert counts["expanded_comparisons"] == 1
    assert counts["evidence"] == 0
    assert counts["objects"] == 0


def test_generic_create_rejects_lifecycle_fields_before_write():
    with pytest.raises(HTTPException) as exc:
        asyncio.run(server.crud_create(
            "testcases",
            {"name": "Unsafe", "prompts": [{"text": "Prompt"}], "archived": True},
            {"name": "Writer"},
        ))
    assert exc.value.status_code == 409


def test_generic_delete_never_cascades_testcases():
    with pytest.raises(HTTPException) as exc:
        asyncio.run(server.crud_delete("testcases", "tc-1", {"role": "admin", "name": "Admin"}))
    assert exc.value.status_code == 409


def test_preflight_token_rejects_changed_dependency_snapshot():
    token = server._deletion_preflight_token("tc-1", "2026-09-01T00:00:00+00:00", {"responses": 0})
    server._verify_deletion_preflight_token(
        token, "tc-1", "2026-09-01T00:00:00+00:00", {"responses": 0}
    )
    with pytest.raises(HTTPException) as exc:
        server._verify_deletion_preflight_token(
            token, "tc-1", "2026-09-01T00:00:00+00:00", {"responses": 1}
        )
    assert exc.value.status_code == 409


def test_generic_update_cannot_retarget_history_to_archived_testcase(monkeypatch):
    archived = {"id": "tc-archived", "archived": True}
    fake = LifecycleDb(archived, documents={"responses": {"id": "response-1"}})
    monkeypatch.setattr(server, "db", fake)

    with pytest.raises(HTTPException) as exc:
        asyncio.run(server.crud_update(
            "responses", "response-1", {"testcase_id": archived["id"]}, {"name": "Writer"}
        ))

    assert exc.value.status_code == 409