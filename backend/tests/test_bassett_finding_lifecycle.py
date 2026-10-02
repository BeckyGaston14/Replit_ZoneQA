import asyncio
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest
from fastapi import HTTPException
import server

ADMIN = {"id": "admin", "name": "Admin", "role": "admin"}


def setup_finding(monkeypatch, **changes):
    finding = {"id": "finding", "title": "Use Table Errors", "finding_scope": "bassett", "bassett_issue_id": "run-1", "linked_test_run_ids": ["run-1", "run-2"], **changes}
    store = SimpleNamespace(update_one=AsyncMock())
    monkeypatch.setattr(server, "db", SimpleNamespace(findings=store))
    monkeypatch.setattr(server, "crud_get", AsyncMock(return_value=finding))
    monkeypatch.setattr(server, "log_activity", AsyncMock())
    return finding, store


@pytest.mark.parametrize("action,archived", [("archive", True), ("restore", False), ("delete", True)])
def test_lifecycle_preserves_run_links(monkeypatch, action, archived):
    finding, store = setup_finding(monkeypatch)
    result = asyncio.run(server.bassett_finding_lifecycle("finding", {"action": action, "confirmation_title": finding["title"]}, ADMIN))
    update = store.update_one.call_args.args[1]["$set"]
    assert result["ok"]
    assert update["archived"] is archived
    assert "bassett_issue_id" not in update
    assert "linked_test_run_ids" not in update
    assert bool(update.get("deleted_at")) == (action == "delete")


def test_delete_requires_exact_confirmation(monkeypatch):
    _, store = setup_finding(monkeypatch)
    with pytest.raises(HTTPException) as error:
        asyncio.run(server.bassett_finding_lifecycle("finding", {"action": "delete"}, ADMIN))
    assert error.value.status_code == 400
    store.update_one.assert_not_called()


def test_deleted_finding_cannot_be_restored(monkeypatch):
    _, store = setup_finding(monkeypatch, deleted_at="yesterday")
    with pytest.raises(HTTPException) as error:
        asyncio.run(server.bassett_finding_lifecycle("finding", {"action": "restore"}, ADMIN))
    assert error.value.status_code == 409
    store.update_one.assert_not_called()


def test_comparison_finding_cannot_use_bassett_lifecycle(monkeypatch):
    _, store = setup_finding(monkeypatch, finding_scope="comparison", bassett_issue_id=None)
    with pytest.raises(HTTPException):
        asyncio.run(server.bassett_finding_lifecycle("finding", {"action": "archive"}, ADMIN))
    store.update_one.assert_not_called()


def test_create_forces_bassett_scope_and_primary_link(monkeypatch):
    create = AsyncMock(return_value={"id": "new"})
    monkeypatch.setattr(server, "crud_create", create)
    asyncio.run(server.create_bassett_finding({"title": " New finding ", "finding_scope": "comparison", "deleted_at": "bad", "linked_test_run_ids": ["run-1", "run-2"]}, ADMIN))
    doc = create.call_args.args[1]
    assert doc["title"] == "New finding"
    assert doc["finding_scope"] == "bassett"
    assert doc["bassett_issue_id"] == "run-1"
    assert "deleted_at" not in doc


def test_new_finding_requires_title():
    with pytest.raises(HTTPException):
        asyncio.run(server.create_bassett_finding({"title": " "}, ADMIN))
