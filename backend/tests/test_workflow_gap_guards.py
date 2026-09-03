"""Focused unit tests for comparison and lifecycle gap guards (no services)."""
import asyncio

import pytest
from fastapi import HTTPException

import server
from postgres_store import _matches


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
    def _match(self, row, query):
        return _matches(row, query or {})
    async def find_one(self, query, *_args, **_kwargs):
        row = next((r for r in self.db.rows.get(self.name, []) if self._match(r, query)), None)
        return dict(row) if row else None
    def find(self, query=None, *_args, **_kwargs):
        return Cursor([r for r in self.db.rows.get(self.name, []) if self._match(r, query)])
    async def insert_one(self, doc):
        self.db.rows.setdefault(self.name, []).append(dict(doc))
    async def update_one(self, query, update, **_kwargs):
        row = next((r for r in self.db.rows.get(self.name, []) if self._match(r, query)), None)
        if row:
            row.update(update.get("$set", {}))
        return type("Result", (), {"modified_count": int(bool(row)), "deleted_count": 0})()
    async def update_many(self, query, update):
        for row in self.db.rows.get(self.name, []):
            if self._match(row, query):
                row.update(update.get("$set", {}))
        return type("Result", (), {})()
    async def find_one_and_update(self, query, update, **_kwargs):
        row = next((r for r in self.db.rows.get(self.name, []) if self._match(r, query)), None)
        if not row:
            return None
        row.update(update.get("$set", {}))
        return dict(row)
    async def delete_one(self, query):
        rows = self.db.rows.get(self.name, [])
        for row in list(rows):
            if self._match(row, query):
                rows.remove(row)
                return type("Result", (), {"deleted_count": 1})()
        return type("Result", (), {"deleted_count": 0})()
    async def count_documents(self, query):
        return len([r for r in self.db.rows.get(self.name, []) if self._match(r, query)])


class Db:
    def __init__(self, rows=None):
        self.rows = rows or {}
    def __getattr__(self, name):
        return Collection(self, name)
    def __getitem__(self, name):
        return Collection(self, name)


class AsyncBarrier:
    def __init__(self, parties):
        self.parties = parties
        self.arrived = 0
        self.open = asyncio.Event()

    async def wait(self):
        self.arrived += 1
        if self.arrived == self.parties:
            self.open.set()
        await self.open.wait()


class ConcurrentCollection(Collection):
    def __init__(self, db, name, barrier):
        super().__init__(db, name)
        self.barrier = barrier

    async def find_one_and_update(self, query, update, **kwargs):
        await self.barrier.wait()
        row = next((r for r in self.db.rows.get(self.name, []) if self._match(r, query)), None)
        if not row:
            return None
        row.update(update.get("$set", {}))
        return dict(row)


class ConcurrentDb(Db):
    def __init__(self, rows, target):
        super().__init__(rows)
        self.target = target
        self.barrier = AsyncBarrier(2)
        self.target_collection = ConcurrentCollection(self, target, self.barrier)

    def __getattr__(self, name):
        if name == self.target:
            return self.target_collection
        return super().__getattr__(name)

    def __getitem__(self, name):
        if name == self.target:
            return self.target_collection
        return super().__getitem__(name)


class AtomicVersionCollection(Collection):
    def __init__(self, db):
        super().__init__(db, "versions")
        self.lock = asyncio.Lock()

    async def activate_version(self, query, update, projection=None):
        async with self.lock:
            target = next((row for row in self.db.rows["versions"] if self._match(row, query)), None)
            if not target:
                return None
            for row in self.db.rows["versions"]:
                if row["id"] != target["id"]:
                    row["active"] = False
            target.update(update["$set"])
            return dict(target)


class AtomicVersionDb(Db):
    def __init__(self, rows):
        super().__init__(rows)
        self.versions_collection = AtomicVersionCollection(self)

    def __getattr__(self, name):
        return self.versions_collection if name == "versions" else super().__getattr__(name)

    def __getitem__(self, name):
        return self.versions_collection if name == "versions" else super().__getitem__(name)


@pytest.mark.parametrize(
    "collection,row,body",
    [
        ("projects", {"id": "p1", "name": "Project", "revision": 1, "updated_at": "stamp"}, {"name": "Project A"}),
        ("municipalities", {"id": "m1", "name": "Municipality", "state": "MI", "revision": 1, "updated_at": "stamp"}, {"name": "Municipality A"}),
        ("testcases", {"id": "tc1", "name": "Test case", "prompts": [{"turn": 1, "text": "Prompt"}], "revision": 1, "updated_at": "stamp"}, {"name": "Test case A", "prompts": [{"text": "Prompt A"}]}),
        ("findings", {"id": "f1", "title": "Finding", "revision": 1, "updated_at": "stamp"}, {"title": "Finding A"}),
        ("test_runs", {"id": "run1", "name": "Run", "revision": 1, "updated_at": "stamp"}, {"name": "Run A"}),
    ],
)
def test_concurrent_stale_saves_only_one_wins_for_editable_resources(monkeypatch, collection, row, body):
    db = ConcurrentDb({collection: [row]}, collection)
    monkeypatch.setattr(server, "db", db)
    actor = {"id": "editor", "name": "Editor", "role": "admin"}

    async def save(suffix):
        try:
            result = await server.crud_update(
                collection, row["id"], {**body, "name": body.get("name", body.get("title")) + suffix, "expected_revision": 1}, actor
            )
            return ("saved", result)
        except HTTPException as exc:
            return ("error", exc)

    async def run_saves():
        return await asyncio.gather(save(" 1"), save(" 2"))

    outcomes = asyncio.run(run_saves())
    assert [outcome[0] for outcome in outcomes].count("saved") == 1
    assert [outcome[0] for outcome in outcomes].count("error") == 1
    conflict = next(outcome[1] for outcome in outcomes if outcome[0] == "error")
    assert conflict.status_code == 409
    assert conflict.detail["code"] == "stale_update"
    assert db.rows[collection][0]["revision"] == 2


@pytest.mark.parametrize(
    "collection,row,body",
    [
        ("projects", {"id": "legacy-project", "name": "Legacy project", "updated_at": "stamp"}, {"name": "Updated project"}),
        ("claims", {"id": "legacy-claim", "claim_text": "Legacy claim", "note": "", "updated_at": "stamp"}, {"note": "Reviewed"}),
    ],
)
def test_concurrent_first_edits_support_revisionless_legacy_records(monkeypatch, collection, row, body):
    db = ConcurrentDb({collection: [row]}, collection)
    monkeypatch.setattr(server, "db", db)
    actor = {"id": "editor", "name": "Editor", "role": "admin"}

    async def save(suffix):
        try:
            result = await server.crud_update(
                collection, row["id"], {**body, "note": body.get("note", "") + suffix, "expected_revision": 1}, actor
            )
            return ("saved", result)
        except HTTPException as exc:
            return ("error", exc)

    async def run_saves():
        return await asyncio.gather(save(" 1"), save(" 2"))

    outcomes = asyncio.run(run_saves())
    assert [outcome[0] for outcome in outcomes].count("saved") == 1
    conflict = next(outcome[1] for outcome in outcomes if outcome[0] == "error")
    assert conflict.status_code == 409
    assert conflict.detail["code"] == "stale_update"
    assert db.rows[collection][0]["revision"] == 2


def test_extracted_claims_start_with_editable_version_metadata(monkeypatch):
    db = Db()
    monkeypatch.setattr(server, "db", db)

    async def response(*_args, **_kwargs):
        return {"id": "response-1", "testcase_id": "tc-1", "model": "Bassett", "response": "Answer"}

    async def no_existing(*_args, **_kwargs):
        return []

    async def no_op(*_args, **_kwargs):
        return None

    async def ai_result(*_args, **_kwargs):
        return '[{"claim_text":"A claim","citation":""}]'

    monkeypatch.setattr(server, "crud_get", response)
    monkeypatch.setattr(server, "crud_list", no_existing)
    monkeypatch.setattr(server, "_guard_testcase_linked_document", no_op)
    monkeypatch.setattr(server, "_ai_assist_call", ai_result)
    monkeypatch.setattr(server, "log_activity", no_op)

    claims = asyncio.run(server.extract_claims("response-1", {"name": "Editor"}))
    assert claims[0]["revision"] == 1
    assert claims[0]["updated_at"] == claims[0]["created_at"]
    assert db.rows["claims"][0]["revision"] == 1


@pytest.mark.parametrize("kind", ["issue", "scenario"])
def test_sequential_stale_bassett_edits_are_rejected(monkeypatch, kind):
    collection = f"bassett_{'issues' if kind == 'issue' else 'scenarios'}"
    if kind == "issue":
        row = {
            "id": "record-1", "scenario_id": "scenario-1", "question_asked": "Question",
            "exact_bassett_answer": "Answer", "verified_correct_answer": "Verified",
            "status": "New", "result": "Pass", "revision": 1, "updated_at": "stamp",
        }
        update = server.bassett_update_issue
        body = {"note": "First", "expected_revision": 1}
    else:
        row = {
            "id": "record-1", "stable_id": "R-1", "workflow_stage": "Research",
            "report_type": "Property", "test_scenario": "Scenario", "complexity": "Medium",
            "why_it_matters": "Why", "what_bassett_should_do": "Do", "success_criteria": "Pass",
            "revision": 1, "updated_at": "stamp",
        }
        update = server.bassett_update_scenario
        body = {"why_it_matters": "First", "expected_revision": 1}
    db = Db({collection: [row], "bassett_history": [], "activities": [],
             "bassett_scenarios": [row] if kind == "scenario" else [{"id": "scenario-1", "archived": False}],
             "bassett_workflow_stages": [{"id": "stage", "name": "Research", "active": True}]})
    monkeypatch.setattr(server, "db", db)
    actor = {"id": "editor", "name": "Editor", "role": "admin"}

    asyncio.run(update("record-1", body, actor))
    with pytest.raises(HTTPException) as exc:
        asyncio.run(update("record-1", {**body, next(iter(body)): "Second"}, actor))
    assert exc.value.status_code == 409
    assert exc.value.detail["code"] == "stale_update"


def test_competing_version_activations_leave_exactly_one_active(monkeypatch):
    rows = {
        "versions": [
            {"id": "v1", "name": "One", "release_number": "1", "revision": 1, "active": False},
            {"id": "v2", "name": "Two", "release_number": "2", "revision": 1, "active": False},
        ],
        "config": [{"id": "global", **server.DEFAULT_CONFIG}],
        "activities": [],
    }
    db = AtomicVersionDb(rows)
    monkeypatch.setattr(server, "db", db)
    actor = {"id": "admin", "name": "Admin", "role": "admin"}

    async def activate(identifier):
        return await server.crud_update("versions", identifier, {"active": True, "expected_revision": 1}, actor)

    async def run_activations():
        return await asyncio.gather(activate("v1"), activate("v2"))

    asyncio.run(run_activations())
    assert sum(row.get("active") is True for row in rows["versions"]) == 1


@pytest.mark.parametrize("kind", ["workflow_stage", "user"])
def test_specialized_employee_editors_reject_one_concurrent_stale_save(monkeypatch, kind):
    actor = {"id": "admin", "name": "Admin", "role": "admin"}
    if kind == "workflow_stage":
        collection = "bassett_workflow_stages"
        row = {"id": "stage-1", "name": "Research", "code": "R", "position": 1,
               "active": True, "revision": 1, "updated_at": "stamp"}
        update = server.bassett_update_workflow_stage
        bodies = [
            {"name": "Research One", "expected_revision": 1},
            {"name": "Research Two", "expected_revision": 1},
        ]
    else:
        collection = "users"
        row = {"id": "user-1", "name": "User", "email": "user@example.com",
               "role": "tester", "active": True, "revision": 1, "updated_at": "stamp"}
        update = server.update_user
        bodies = [
            {"name": "User One", "expected_revision": 1},
            {"name": "User Two", "expected_revision": 1},
        ]
    db = ConcurrentDb({collection: [row], "activities": [], "users": [row] if kind == "user" else []}, collection)
    monkeypatch.setattr(server, "db", db)

    async def save(body):
        try:
            return ("saved", await update(row["id"], body, actor))
        except HTTPException as exc:
            return ("error", exc)

    async def run_saves():
        return await asyncio.gather(*(save(body) for body in bodies))

    outcomes = asyncio.run(run_saves())
    assert [outcome[0] for outcome in outcomes].count("saved") == 1
    conflict = next(outcome[1] for outcome in outcomes if outcome[0] == "error")
    assert conflict.status_code == 409
    assert conflict.detail["code"] == "stale_update"


def test_incomplete_comparison_evals_are_excluded_but_legacy_is_kept(monkeypatch):
    monkeypatch.setattr(server, "db", Db({"test_runs": [
        {"id": "partial", "status": "Completed with Errors", "outcome": "Partial", "comparison_complete": False},
        {"id": "done", "status": "Completed", "outcome": "Success", "comparison_complete": True},
    ]}))
    records = [{"id": "legacy"}, {"id": "bad", "run_id": "partial"}, {"id": "ok", "run_id": "done"}]
    kept = asyncio.run(server._exclude_incomplete_comparison_evaluations(records))
    assert [row["id"] for row in kept] == ["legacy", "ok"]


def _evaluation(id, testcase_id, model, score, *, run_id=None, created_at="2026-01-01T00:00:00Z"):
    return {
        "id": id, "testcase_id": testcase_id, "model": model, "run_id": run_id,
        "overall_score": score, "final_result": "Pass" if score >= 7 else "Fail",
        "scores": {"accuracy": score}, "created_at": created_at,
    }


def test_complete_population_never_combines_slots_from_different_runs(monkeypatch):
    monkeypatch.setattr(server, "db", Db({"test_runs": [
        {"id": "old", "status": "Completed", "outcome": "Success", "comparison_complete": True},
        {"id": "new", "status": "Completed", "outcome": "Success", "comparison_complete": True},
    ]}))
    records = [
        _evaluation("old-b", "tc", "Bassett", 8, run_id="old"),
        _evaluation("old-g", "tc", "ChatGPT", 7, run_id="old"),
        _evaluation("old-c", "tc", "Claude", 6, run_id="old"),
        _evaluation("new-b", "tc", "Bassett", 9, run_id="new", created_at="2026-02-01T00:00:00Z"),
    ]
    kept = asyncio.run(server._complete_comparison_evaluations(records))
    assert {row["id"] for row in kept} == {"old-b", "old-g", "old-c"}


def test_complete_population_selects_one_latest_complete_run(monkeypatch):
    monkeypatch.setattr(server, "db", Db({"test_runs": [
        {"id": "old", "status": "Completed", "outcome": "Success", "comparison_complete": True,
         "run_date": "2026-01-01T00:00:00Z"},
        {"id": "new", "status": "Completed", "outcome": "Success", "comparison_complete": True,
         "run_date": "2026-02-01T00:00:00Z"},
    ]}))
    records = [
        _evaluation("old-b", "tc", "Bassett", 9, run_id="old", created_at="2026-01-03T00:00:00Z"),
        _evaluation("old-g", "tc", "ChatGPT", 4, run_id="old", created_at="2026-01-02T00:00:00Z"),
        _evaluation("old-c", "tc", "Claude", 4, run_id="old", created_at="2026-01-01T00:00:00Z"),
        _evaluation("new-b", "tc", "Bassett", 4, run_id="new", created_at="2026-02-01T00:00:00Z"),
        _evaluation("new-g", "tc", "ChatGPT", 9, run_id="new", created_at="2026-02-03T00:00:00Z"),
        _evaluation("new-c", "tc", "Claude", 9, run_id="new", created_at="2026-02-02T00:00:00Z"),
    ]
    kept = asyncio.run(server._complete_comparison_evaluations(records))
    assert {row["id"] for row in kept} == {"new-b", "new-g", "new-c"}


def test_complete_population_uses_run_date_and_selects_within_version(monkeypatch):
    runs = [
        {"id": "v1", "status": "Completed", "outcome": "Success", "comparison_complete": True,
         "run_date": "2026-01-01T00:00:00Z"},
        {"id": "v2", "status": "Completed", "outcome": "Success", "comparison_complete": True,
         "run_date": "2026-02-01T00:00:00Z"},
    ]
    monkeypatch.setattr(server, "db", Db({"test_runs": runs}))
    records = []
    for run_id, version, score, scored_at in (
        ("v1", "v1", 9, "2026-03-01T00:00:00Z"),
        ("v2", "v2", 4, "2026-02-02T00:00:00Z"),
    ):
        for model in ("Bassett", "ChatGPT", "Claude"):
            row = _evaluation(f"{run_id}-{model}", "tc", model, score, run_id=run_id, created_at=scored_at)
            row["bassett_version"] = version
            records.append(row)

    latest = asyncio.run(server._complete_comparison_evaluations(records))
    scoped_v1 = asyncio.run(server._complete_comparison_evaluations(records, version="v1"))
    assert {row["run_id"] for row in latest} == {"v2"}
    assert {row["run_id"] for row in scoped_v1} == {"v1"}


def test_legacy_population_requires_all_three_valid_evaluations(monkeypatch):
    monkeypatch.setattr(server, "db", Db())
    incomplete = [
        _evaluation("b", "tc", "Bassett", 8),
        _evaluation("g", "tc", "ChatGPT", 7),
    ]
    assert asyncio.run(server._complete_comparison_evaluations(incomplete)) == []
    complete = incomplete + [_evaluation("c", "tc", "Claude", 6)]
    assert {row["model"] for row in asyncio.run(server._complete_comparison_evaluations(complete))} == {
        "Bassett", "ChatGPT", "Claude",
    }


def test_all_metric_endpoints_reconcile_to_complete_comparisons(monkeypatch):
    complete = [
        _evaluation("good-b", "good", "Bassett", 8, run_id="complete"),
        _evaluation("good-g", "good", "ChatGPT", 7, run_id="complete"),
        _evaluation("good-c", "good", "Claude", 6, run_id="complete"),
    ]
    partial = [
        _evaluation("bad-b", "partial", "Bassett", 2, run_id="partial"),
    ]
    for row in complete + partial:
        row["bassett_version"] = "v1"
    rows = {
        "testcases": [
            {"id": "good", "name": "Complete", "category": "Rules", "criticality": 3},
            {"id": "partial", "name": "Partial", "category": "Rules", "criticality": 3},
        ],
        "evaluations": complete + partial,
        "test_runs": [
            {"id": "complete", "status": "Completed", "outcome": "Success", "comparison_complete": True},
            {"id": "partial", "status": "Completed with Errors", "outcome": "Partial", "comparison_complete": False},
        ],
        "versions": [{"id": "v1", "name": "v1", "active": True}],
        "config": [{"id": "global", "categories": ["Rules"], "criticality": {}}],
        "projects": [], "findings": [], "demos": [], "regression_runs": [],
        "retests": [], "municipalities": [],
    }
    monkeypatch.setattr(server, "db", Db(rows))

    async def fake_crud_list(collection, query=None):
        return [dict(row) for row in rows.get(collection, [])]

    async def no_project_dates(_projects=None):
        return {}

    async def no_stale_gold():
        return {}

    monkeypatch.setattr(server, "crud_list", fake_crud_list)
    monkeypatch.setattr(server, "_current_project_last_tested_dates", no_project_dates)
    monkeypatch.setattr(server, "compute_stale_gold_map", no_stale_gold)

    user = {"id": "viewer", "role": "viewer"}
    dashboard = asyncio.run(server.dashboard_stats(user))
    performance = asyncio.run(server.analytics_performance(user))
    executive = asyncio.run(server.analytics_executive(user))
    coverage = asyncio.run(server.analytics_coverage(user))
    summary = asyncio.run(server.metrics_summary(user))
    records = asyncio.run(server.dashboard_metric_records("bassett-pass-rate", user))

    bassett_performance = next(item for item in performance["model_summary"] if item["model"] == "Bassett")
    assert dashboard["bassett_passed"] == bassett_performance["passed"] == 1
    assert dashboard["bassett_failed"] == bassett_performance["failed"] == 0
    assert (
        executive["kpis"]["total_evaluated"]
        == coverage["summary"]["evaluated_tests"]
        == summary["bassett_current"]["evaluated"]
        == records["count"]
        == 1
    )


def test_dashboard_legacy_quality_fields_use_active_version_and_latest_regression(monkeypatch):
    evaluations = []
    for run_id, testcase_id, version, score, created_at in [
        ("old", "historical", "v0", 2, "2025-01-01T00:00:00Z"),
        ("current", "current", "v1", 9, "2026-01-01T00:00:00Z"),
    ]:
        for model in ("Bassett", "ChatGPT", "Claude"):
            row = _evaluation(f"{run_id}-{model}", testcase_id, model, score, run_id=run_id, created_at=created_at)
            row["bassett_version"] = version
            evaluations.append(row)
    rows = {
        "testcases": [{"id": "historical"}, {"id": "current"}],
        "evaluations": evaluations,
        "test_runs": [
            {"id": "old", "status": "Completed", "outcome": "Success", "comparison_complete": True},
            {"id": "current", "status": "Completed", "outcome": "Success", "comparison_complete": True},
        ],
        "versions": [{"id": "v1", "name": "v1", "active": True}],
        "regression_runs": [
            {"id": "r-old", "bassett_version": "v1", "failed": 9, "created_at": "2026-01-01T00:00:00Z"},
            {"id": "r-new", "bassett_version": "v1", "failed": 1, "created_at": "2026-02-01T00:00:00Z"},
            {"id": "r-other", "bassett_version": "v0", "failed": 7, "created_at": "2026-03-01T00:00:00Z"},
        ],
    }
    monkeypatch.setattr(server, "db", Db(rows))

    async def fake_crud_list(collection, query=None):
        return [dict(row) for row in rows.get(collection, [])]

    monkeypatch.setattr(server, "crud_list", fake_crud_list)
    monkeypatch.setattr(server, "_current_project_last_tested_dates", lambda _projects=None: asyncio.sleep(0, result={}))
    result = asyncio.run(server.dashboard_stats({"id": "viewer", "role": "viewer"}))
    assert result["bassett_passed"] == 1
    assert result["bassett_failed"] == 0
    assert result["regression_failures"] == 1


def test_release_readiness_critical_findings_are_version_scoped(monkeypatch):
    rows = {
        "testcases": [],
        "evaluations": [],
        "test_runs": [],
        "findings": [
            {"id": "old-c5", "title": "Old blocker", "version_found": "v0", "criticality": 5, "developer_status": "Open"},
            {"id": "new-c4", "title": "Current warning", "version_found": "v1", "criticality": 4, "developer_status": "Open"},
        ],
        "regression_runs": [],
        "release_decisions": [],
    }
    monkeypatch.setattr(server, "db", Db(rows))

    async def fake_crud_list(collection, query=None):
        return [dict(row) for row in rows.get(collection, [])]

    monkeypatch.setattr(server, "crud_list", fake_crud_list)
    monkeypatch.setattr(server, "compute_stale_gold_map", lambda: asyncio.sleep(0, result={}))
    current = asyncio.run(server.release_readiness("v1", {"id": "viewer", "role": "viewer"}))
    old = asyncio.run(server.release_readiness("v0", {"id": "viewer", "role": "viewer"}))
    assert current["recommendation"] == "CONDITIONAL"
    assert not any(blocker["label"] == "Old blocker" for blocker in current["blockers"])
    assert old["recommendation"] == "NO-GO"
    assert [blocker["label"] for blocker in old["blockers"]] == ["Old blocker"]


def test_coverage_counts_valid_bassett_only_evaluations(monkeypatch):
    bassett_only = _evaluation("bassett-only", "solo", "Bassett", 8)
    rows = {
        "testcases": [{"id": "solo", "municipality_id": "m1", "category": "Rules", "criticality": 3}],
        "municipalities": [{"id": "m1", "name": "QA City", "state": "MI"}],
        "evaluations": [bassett_only],
        "test_runs": [],
        "config": [{"id": "global", "categories": ["Rules"], "criticality": {}}],
    }
    monkeypatch.setattr(server, "db", Db(rows))

    async def fake_crud_list(collection, query=None):
        return [dict(row) for row in rows.get(collection, [])]

    monkeypatch.setattr(server, "crud_list", fake_crud_list)
    result = asyncio.run(server.analytics_coverage({"id": "viewer", "role": "viewer"}))
    assert result["summary"]["evaluated_tests"] == 1
    assert result["municipalities"][0]["evaluated"] == 1
    assert result["categories"][0]["evaluated"] == 1
    assert result["criticality"][2]["evaluated"] == 1


def test_active_project_metric_uses_enriched_automatic_completion(monkeypatch):
    rows = {
        "projects": [
            {"id": "p1", "name": "Automatic Project", "status": "Active",
             "completion_mode": "automatic", "owner": "QA"},
        ],
        "testcases": [
            {"id": f"t{i}", "project_id": "p1", "status": "Evaluated"}
            for i in range(5)
        ],
        "evaluations": [], "findings": [], "retests": [], "demos": [],
        "regression_runs": [], "test_runs": [], "versions": [],
    }
    monkeypatch.setattr(server, "db", Db(rows))

    async def fake_crud_list(collection, query=None):
        return [dict(row) for row in rows.get(collection, [])]

    monkeypatch.setattr(server, "crud_list", fake_crud_list)

    result = asyncio.run(
        server.dashboard_metric_records(
            "active-projects",
            {"id": "viewer", "role": "viewer"},
        )
    )

    assert result["count"] == 1
    assert result["records"][0]["value"] == 100
    assert result["records"][0]["secondary"] == "Linked active test cases · QA"


def test_retest_card_and_drilldown_share_active_testcase_canonical_population(monkeypatch):
    """Historical links may remain, but dashboard retests need a live Test Case."""
    rows = {
        "testcases": [
            {"id": "active", "name": "Current Test"},
            {"id": "archived", "name": "Archived Test", "archived": True},
        ],
        "retests": [
            {"id": "included-completed", "testcase_id": "active", "finding_id": "closed-finding",
             "finding_title": "Previously fixed finding", "status": "Completed"},
            {"id": "included-progress", "testcase_id": "active", "finding_id": "active-finding",
             "finding_title": "Current finding", "status": "In Progress"},
            {"id": "archived-retest", "testcase_id": "active", "status": "Completed", "archived": True},
            {"id": "archived-testcase", "testcase_id": "archived", "status": "Completed"},
            {"id": "orphaned-testcase", "testcase_id": "missing", "status": "Completed"},
        ],
        # A terminal finding deliberately does not remove its valid retest
        # execution from the historical workflow population.
        "findings": [
            {"id": "closed-finding", "testcase_id": "active", "developer_status": "Fixed"},
            {"id": "active-finding", "testcase_id": "active", "developer_status": "Ready for Retest"},
        ],
        "evaluations": [], "regression_runs": [], "projects": [], "demos": [],
        "versions": [],
    }
    monkeypatch.setattr(server, "db", Db(rows))

    async def fake_crud_list(collection, query=None):
        return [dict(row) for row in rows.get(collection, [])]

    monkeypatch.setattr(server, "crud_list", fake_crud_list)
    user = {"id": "viewer", "role": "viewer"}
    card = asyncio.run(server.metrics_summary(user))["retests"]
    drilldown = asyncio.run(server.dashboard_metric_records("retests", user))

    assert card["total"] == drilldown["count"] == 2
    assert card["completed"] == 1
    assert {record["id"] for record in drilldown["records"]} == {
        "included-completed", "included-progress",
    }


def test_retry_endpoint_only_dispatches_incomplete_slots(monkeypatch):
    called = {}
    async def fake_run(testcase_id, body, user):
        called.update(testcase_id=testcase_id, body=body, user=user)
        return {"ok": True}
    monkeypatch.setattr(server, "run_models", fake_run)
    result = asyncio.run(server.retry_model_comparison(
        "tc", "run", {"test_date": "2026-01-01"}, {"id": "u", "role": "tester"}))
    assert result == {"ok": True}
    assert called["body"]["resume_run_id"] == "run"


def test_retry_runs_only_failed_slots_without_superseding_success(monkeypatch):
    db = Db({"testcases": [{"id": "tc", "name": "Case", "prompts": [{"turn": 1, "text": "Q"}],
                            "status": "Draft"}],
             "config": [{"id": "global", "integrations": {"bassett_api_url": "https://api.zoneomics.com"}}],
             "versions": [], "test_runs": [], "responses": [], "activities": []})
    monkeypatch.setattr(server, "db", db)
    calls, phase = [], {"retry": False}
    async def benchmark(provider, _model, prompts):
        calls.append(provider)
        if provider == "anthropic" and not phase["retry"]:
            raise RuntimeError("temporarily unavailable")
        return [{"turn": prompt["turn"], "text": provider} for prompt in prompts]
    async def bassett(_url, _key, prompts):
        calls.append("bassett")
        if not phase["retry"]:
            raise RuntimeError("temporarily unavailable")
        return [{"turn": prompt["turn"], "text": "bassett"} for prompt in prompts]
    monkeypatch.setattr(server, "_run_benchmark", benchmark)
    monkeypatch.setattr(server, "_run_bassett", bassett)
    actor = {"id": "u", "name": "User", "role": "tester"}
    initial = asyncio.run(server.run_models("tc", {"test_date": "2026-01-01"}, actor))
    assert initial["model_slots"]["ChatGPT"]["status"] == "complete"
    saved_chatgpt = next(row for row in db.rows["responses"] if row["model"] == "ChatGPT")
    phase["retry"] = True
    calls.clear()
    resumed = asyncio.run(server.run_models("tc", {"resume_run_id": initial["run_id"], "test_date": "2026-01-01"}, actor))
    assert calls == ["bassett", "anthropic"]
    assert resumed["complete"] is True
    assert saved_chatgpt["superseded"] is False


def test_manual_benchmark_completion_preserves_successful_slots(monkeypatch):
    db = Db({"test_runs": [{"id": "r", "testcase_id": "tc", "environment": "Staging",
                             "model_slots": {"Bassett": {"status": "complete"},
                                             "ChatGPT": {"status": "incomplete"},
                                             "Claude": {"status": "complete"}}}],
              "responses": [], "activities": []})
    monkeypatch.setattr(server, "db", db)
    result = asyncio.run(server.complete_benchmark_slot(
        "tc", "r", "ChatGPT", {"response": "manual answer"}, {"id": "u", "name": "User"}))
    assert result["complete"] is True
    assert db.rows["test_runs"][0]["model_slots"]["Bassett"]["status"] == "complete"
    assert len(db.rows["responses"]) == 1
    with pytest.raises(HTTPException) as exc:
        asyncio.run(server.complete_benchmark_slot("tc", "r", "Bassett", {"response": "x"}, {"name": "User"}))
    assert exc.value.status_code == 400


def test_parent_lifecycle_preflight_token_rejects_dependency_change():
    token = server._deletion_preflight_token("projects:p1", "stamp", {"test_cases": 0})
    server._verify_deletion_preflight_token(token, "projects:p1", "stamp", {"test_cases": 0})
    with pytest.raises(HTTPException) as exc:
        server._verify_deletion_preflight_token(token, "projects:p1", "stamp", {"test_cases": 1})
    assert exc.value.status_code == 409


def test_parent_archive_restore_and_permanent_dependency_guard(monkeypatch):
    db = Db({"projects": [{"id": "p1", "name": "Project", "status": "Active", "updated_at": "old"}],
             "activities": []})
    monkeypatch.setattr(server, "db", db)
    actor = {"id": "admin", "name": "Admin", "role": "admin"}
    archived = asyncio.run(server.archive_resource("projects", "p1", actor))
    assert archived["archived"] is True and db.rows["projects"][0]["archived_by"] == "admin"
    restored = asyncio.run(server.restore_resource("projects", "p1", actor))
    assert restored["archived"] is False
    # Re-archive and present a valid snapshot whose dependencies become nonzero.
    asyncio.run(server.archive_resource("projects", "p1", actor))
    monkeypatch.setattr(server, "_resource_dependency_counts", lambda *_: _async_value({"test_cases": 1}))
    deps = {"test_cases": 1}
    token = server._deletion_preflight_token("projects:p1", db.rows["projects"][0]["updated_at"], deps)
    with pytest.raises(HTTPException) as exc:
        asyncio.run(server.permanently_delete_resource("projects", "p1", {
            "confirmation_id": "p1", "confirmation_title": "Project", "preflight_token": token,
            "reason": "obsolete project",
        }, actor))
    assert exc.value.status_code == 409


async def _async_value(value):
    return value


def test_changed_user_reference_rejects_inactive_but_unchanged_history_is_allowed(monkeypatch):
    monkeypatch.setattr(server, "db", Db({"users": [{"id": "inactive", "active": False}],
                                           "testcases": [{"id": "tc", "assignee_id": "inactive"}]}))
    with pytest.raises(HTTPException):
        asyncio.run(server._validate_user_references("testcases", {"assignee_id": "inactive"}, {}))
    # Editing unrelated fields must not invalidate an historical assignment.
    asyncio.run(server._validate_user_references(
        "testcases", {"assignee_id": "inactive"}, {"assignee_id": "inactive"}))


def test_integrity_repair_mutation_is_admin_only():
    with pytest.raises(HTTPException) as exc:
        asyncio.run(server.integrity_repair({"key": "clear_user_reference", "entity_id": "x"},
                                            {"role": "qa_manager"}))
    assert exc.value.status_code == 403


def test_release_and_regression_helpers_use_comparison_eligibility(monkeypatch):
    db = Db({"test_runs": [{"id": "bad", "status": "Failed", "comparison_complete": False},
                            {"id": "good", "status": "Completed", "comparison_complete": True}]})
    monkeypatch.setattr(server, "db", db)
    evaluations = [{"run_id": "bad", "final_result": "Fail"},
                   {"run_id": "good", "final_result": "Pass"}]
    eligible = asyncio.run(server._exclude_incomplete_comparison_evaluations(evaluations))
    # Both release-readiness and regression execution call this shared gate.
    assert [item["final_result"] for item in eligible] == ["Pass"]


def test_canonical_report_data_excludes_archived_orphan_and_superseded_records(monkeypatch):
    rows = {
        "testcases": [{"id": "active"}, {"id": "archived", "archived": True}],
        "evaluations": [
            {"id": "current", "testcase_id": "active", "model": "Bassett", "scores": {"accuracy": 8}},
            {"id": "superseded", "testcase_id": "active", "model": "Bassett", "superseded": True, "scores": {"accuracy": 3}},
            {"id": "orphan", "testcase_id": "gone", "model": "Bassett", "scores": {"accuracy": 1}},
        ],
        "findings": [
            {"id": "current-finding", "testcase_id": "active"},
            {"id": "archived-finding", "testcase_id": "active", "archived": True},
        ],
        "regression_runs": [{"id": "run", "testcase_ids": ["active", "archived", "gone"]}],
        "projects": [], "municipalities": [], "test_runs": [], "versions": [],
        "config": [{"id": "global", "eval_dimensions": [{"key": "accuracy"}]}],
    }
    monkeypatch.setattr(server, "db", Db(rows))

    async def fake_crud_list(collection, query=None, include_archived=False):
        return [dict(row) for row in rows.get(collection, [])]

    async def no_stale_gold():
        return {}

    monkeypatch.setattr(server, "crud_list", fake_crud_list)
    monkeypatch.setattr(server, "compute_stale_gold_map", no_stale_gold)
    data = asyncio.run(server._canonical_report_data("regression"))

    assert [row["id"] for row in data["testcases"]] == ["active"]
    assert [row["id"] for row in data["evaluations"]] == ["current"]
    assert [row["id"] for row in data["findings"]] == ["current-finding"]
    assert data["regression_runs"][0]["testcase_ids"] == ["active"]