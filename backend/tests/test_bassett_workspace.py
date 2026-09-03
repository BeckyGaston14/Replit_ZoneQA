"""Focused Bassett workspace rules that do not require a live database."""

import asyncio
import csv
import io

import pytest
from fastapi import HTTPException

import server


def test_bassett_permissions_keep_viewers_read_only():
    with pytest.raises(HTTPException) as exc:
        server._require_bassett_writer({"role": "viewer"})
    assert exc.value.status_code == 403
    assert server._require_bassett_writer({"role": "tester"})["role"] == "tester"


def test_only_managers_can_change_definitions():
    with pytest.raises(HTTPException) as exc:
        server._require_bassett_manager({"role": "developer"})
    assert exc.value.status_code == 403
    assert server._require_bassett_manager({"role": "qa_manager"})["role"] == "qa_manager"


@pytest.mark.parametrize("role", ["tester", "developer", "qa_manager", "admin"])
def test_archived_issues_reject_relationship_mutations_for_every_role(role):
    server._require_bassett_writer({"role": role})
    archived = {
        "id": "issue-1", "archived": True, "status": "Archived",
        "finding_id": "finding-before-archive",
    }
    with pytest.raises(HTTPException) as exc:
        server._require_mutable_bassett_issue(archived)
    assert exc.value.status_code == 409
    assert archived["finding_id"] == "finding-before-archive"


def test_status_only_archived_legacy_issue_is_immutable():
    with pytest.raises(HTTPException) as exc:
        server._require_mutable_bassett_issue({"status": "Archived"})
    assert exc.value.status_code == 409


@pytest.mark.parametrize("role", ["qa_manager", "admin"])
def test_archived_definitions_reject_manager_edits(role):
    server._require_bassett_manager({"role": role})
    archived = {"id": "scenario-1", "archived": True, "test_scenario": "Preserved definition"}
    with pytest.raises(HTTPException) as exc:
        server._require_mutable_bassett_scenario(archived)
    assert exc.value.status_code == 409
    assert archived["test_scenario"] == "Preserved definition"


def test_issue_csv_preserves_exact_answer_text():
    content = server._bassett_csv_rows("issues", [{
        "id": "issue-1",
        "question_asked": "What is allowed?",
        "exact_bassett_answer": 'It said "yes", with a caveat.',
        "verified_correct_answer": "No",
    }])
    row = next(csv.DictReader(io.StringIO(content)))
    assert row["exact_bassett_answer"] == 'It said "yes", with a caveat.'
    assert row["verified_correct_answer"] == "No"


def test_scenario_preview_requires_complete_definition(monkeypatch):
    class FakeCursor:
        async def to_list(self, _limit):
            return []

    class FakeCollection:
        def find(self, *_args, **_kwargs):
            return FakeCursor()

    class FakeDb:
        def __getitem__(self, _name):
            return FakeCollection()

    monkeypatch.setattr(server, "db", FakeDb())
    preview = asyncio.run(server._bassett_import_preview("scenarios", [{
        "stable_id": "R-01",
        "workflow_stage": "Research",
    }]))
    assert preview["invalid"] == 1
    assert "report_type is required" in preview["rows"][0]["errors"]


class _ImportCursor:
    def __init__(self, rows):
        self.rows = rows

    def sort(self, *_args, **_kwargs):
        return self

    async def to_list(self, _limit):
        return [dict(row) for row in self.rows]


class _ImportCollection:
    def __init__(self, database, name):
        self.database = database
        self.name = name

    def find(self, *_args, **_kwargs):
        return _ImportCursor(self.database.records.get(self.name, []))

    async def find_one(self, query, *_args, **_kwargs):
        for row in self.database.records.get(self.name, []):
            if all(row.get(key) == value for key, value in query.items()):
                return dict(row)
        return None

    async def insert_one(self, document):
        self.database.records.setdefault(self.name, []).append(dict(document))


class _ImportDb:
    def __init__(self, scenarios):
        self.records = {
            "bassett_scenarios": scenarios,
            "bassett_issues": [],
            "bassett_history": [],
            "bassett_workflow_stages": [
                {"id": "stage-research", "name": "Research", "code": "R", "active": True},
                {"id": "stage-analysis", "name": "Analysis", "code": "A", "active": True},
            ],
        }

    def __getitem__(self, name):
        return _ImportCollection(self, name)

    def __getattr__(self, name):
        return _ImportCollection(self, name)

    async def atomic_upsert_documents(self, collection, documents):
        for exists, document in documents:
            if exists:
                rows = self.records[collection]
                rows[:] = [dict(document) if row["id"] == document["id"] else row for row in rows]
            else:
                self.records.setdefault(collection, []).append(dict(document))

    async def create_bassett_issue(self, document, creation_key, snapshot_fields):
        for existing in self.records["bassett_issues"]:
            if existing.get("creation_key") == creation_key:
                return dict(existing), False
        scenario = next(row for row in self.records["bassett_scenarios"] if row["id"] == document["scenario_id"])
        stored = {
            **document,
            "definition_snapshot": {field: scenario.get(field) for field in snapshot_fields},
        }
        self.records["bassett_issues"].append(stored)
        return dict(stored), True


def _scenario_row(**overrides):
    row = {
        "workflow_stage": "Research",
        "report_type": "Assessment",
        "test_scenario": "Check a report",
        "complexity": "Low",
        "why_it_matters": "Accuracy matters",
        "what_bassett_should_do": "Produce the report",
        "success_criteria": "The report is correct",
        "priority": "Medium",
    }
    row.update(overrides)
    return row


def _issue_import_row(**overrides):
    row = {
        "scenario_id": "scenario-1", "question_asked": "What is allowed?",
        "exact_bassett_answer": "Ten feet", "verified_correct_answer": "Twenty feet",
        "test_date": "2026-09-01", "result": "Fail", "score": "25",
    }
    row.update(overrides)
    return row


def test_workflow_stage_contract_uses_research_and_analysis():
    legacy_analysis_name = " ".join(("Report", "Writing"))
    assert server.BASSETT_WORKFLOW_STAGE_NAMES == ("Research", "Analysis")
    assert server.DEFAULT_CONFIG["bassett_workflow_stages"] == [
        {"name": "Research", "code": "R", "position": 1},
        {"name": "Analysis", "code": "A", "position": 2},
    ]
    assert server._canonical_bassett_workflow_stage("Research") == "Research"
    assert server._canonical_bassett_workflow_stage("analysis") == "Analysis"
    assert server._canonical_bassett_workflow_stage(legacy_analysis_name) == "Analysis"
    normalized = server._normalize_bassett_config_stages([
        {"id": "legacy-a", "name": legacy_analysis_name, "code": "A"},
        {"id": "canonical-a", "name": "Analysis", "code": "A"},
    ])
    assert len(normalized) == 1
    assert normalized[0]["name"] == "Analysis"


def test_scenario_csv_export_and_preview_emit_analysis_for_transient_alias(monkeypatch):
    legacy_analysis_name = " ".join(("Report", "Writing"))
    existing = _scenario_row(
        id="scenario-a", stable_id="A-01", workflow_stage=legacy_analysis_name,
    )
    fake_db = _ImportDb([existing])
    monkeypatch.setattr(server, "db", fake_db)

    exported = server._bassett_csv_rows("scenarios", [existing])
    exported_row = next(csv.DictReader(io.StringIO(exported)))
    assert exported_row["workflow_stage"] == "Analysis"

    upload_row = {**exported_row, "workflow_stage": legacy_analysis_name}
    preview = asyncio.run(server._bassett_import_preview("scenarios", [upload_row]))
    assert preview["invalid"] == 0
    assert preview["updates"] == 1
    assert preview["rows"][0]["data"]["workflow_stage"] == "Analysis"


def test_scenario_csv_alias_import_updates_in_place_without_changing_test_ids(monkeypatch):
    legacy_analysis_name = " ".join(("Report", "Writing"))
    existing = _scenario_row(
        id="scenario-a", stable_id="A-01", workflow_stage=legacy_analysis_name,
    )
    fake_db = _ImportDb([existing])
    monkeypatch.setattr(server, "db", fake_db)
    row = _scenario_row(
        id="scenario-a", stable_id="A-01", workflow_stage=legacy_analysis_name,
        test_scenario="Updated analysis scenario",
    )

    result = asyncio.run(server.bassett_csv_import(
        "scenarios", {"rows": [row]},
        {"id": "manager-1", "name": "Manager", "role": "qa_manager"},
    ))

    assert result["imported"] == 0
    assert result["updated"] == 1
    assert len(fake_db.records["bassett_scenarios"]) == 1
    assert fake_db.records["bassett_scenarios"][0]["id"] == "scenario-a"
    assert fake_db.records["bassett_scenarios"][0]["stable_id"] == "A-01"
    assert fake_db.records["bassett_scenarios"][0]["workflow_stage"] == "Analysis"


def test_scenario_csv_preview_rejects_unconfigured_stage(monkeypatch):
    monkeypatch.setattr(server, "db", _ImportDb([]))
    preview = asyncio.run(server._bassett_import_preview(
        "scenarios", [_scenario_row(workflow_stage="Draft")],
    ))
    assert preview["invalid"] == 1
    assert "Invalid workflow stage" in preview["rows"][0]["errors"]


def test_scenario_export_preview_import_uses_stable_id_not_exported_id(monkeypatch):
    original = _scenario_row(id="database-id", stable_id="R-1", test_scenario="Before import")
    fake_db = _ImportDb([original])
    monkeypatch.setattr(server, "db", fake_db)

    exported = server._bassett_csv_rows("scenarios", [original])
    row = next(csv.DictReader(io.StringIO(exported)))
    row["test_scenario"] = "Updated through import"

    preview = asyncio.run(server._bassett_import_preview("scenarios", [row]))
    assert preview["invalid"] == 0
    assert preview["updates"] == 1

    result = asyncio.run(server.bassett_csv_import(
        "scenarios", {"rows": [row]}, {"id": "manager-1", "name": "Manager", "role": "qa_manager"},
    ))
    assert result["updated"] == 1
    assert fake_db.records["bassett_scenarios"][0]["id"] == "database-id"
    assert fake_db.records["bassett_scenarios"][0]["test_scenario"] == "Updated through import"


def test_scenario_preview_rejects_unknown_caller_stable_id(monkeypatch):
    monkeypatch.setattr(server, "db", _ImportDb([]))
    preview = asyncio.run(server._bassett_import_preview(
        "scenarios", [_scenario_row(id="caller-id", stable_id="unknown-stable-id")],
    ))
    assert preview["invalid"] == 1
    assert "stable_id is only allowed for an exact existing scenario" in preview["rows"][0]["errors"]


def test_scenario_preview_rejects_requested_id_for_new_record(monkeypatch):
    monkeypatch.setattr(server, "db", _ImportDb([]))
    preview = asyncio.run(server._bassett_import_preview(
        "scenarios", [_scenario_row(id="caller-id")],
    ))
    assert preview["invalid"] == 1
    assert "Scenario row IDs are server assigned" in preview["rows"][0]["errors"]


@pytest.mark.parametrize(
    "overrides, expected",
    [
        ({"scenario_id": ""}, "scenario_id is required"),
        ({"result": "Incomplete"}, "Bassett result must be"),
        ({"score": "101"}, "Score must be between 0 and 100"),
    ],
)
def test_issue_import_preview_enforces_canonical_run_fields(monkeypatch, overrides, expected):
    scenario = _scenario_row(id="scenario-1", stable_id="R-01", archived=False)
    monkeypatch.setattr(server, "db", _ImportDb([scenario]))
    preview = asyncio.run(server._bassett_import_preview("issues", [_issue_import_row(**overrides)]))
    assert preview["invalid"] == 1
    assert any(expected in error for error in preview["rows"][0]["errors"])


@pytest.mark.parametrize(
    "scenario",
    [
        _scenario_row(id="scenario-1", stable_id="R-01", archived=True),
        _scenario_row(id="scenario-1", stable_id="R-01", success_criteria=""),
    ],
)
def test_issue_import_preview_rejects_archived_or_incomplete_scenario(monkeypatch, scenario):
    monkeypatch.setattr(server, "db", _ImportDb([scenario]))
    preview = asyncio.run(server._bassett_import_preview("issues", [_issue_import_row()]))
    assert preview["invalid"] == 1


def test_issue_csv_import_creates_canonical_snapshot(monkeypatch):
    scenario = _scenario_row(id="scenario-1", stable_id="R-01", archived=False)
    fake_db = _ImportDb([scenario])
    monkeypatch.setattr(server, "db", fake_db)
    result = asyncio.run(server.bassett_csv_import(
        "issues", {"rows": [_issue_import_row()]},
        {"id": "manager-1", "name": "Manager", "role": "qa_manager"},
    ))
    assert result["imported"] == 1
    assert len(fake_db.records["bassett_issues"]) == 1
    saved = fake_db.records["bassett_issues"][0]
    assert saved["scenario_id"] == "scenario-1"
    assert saved["definition_snapshot"]["stable_id"] == "R-01"


def test_existing_legacy_issue_csv_round_trip_preserves_result_and_missing_test_date(monkeypatch):
    fake_db = _ImportDb([])
    legacy = {
        "id": "legacy-run", "question_asked": "Historic question",
        "exact_bassett_answer": "Historic answer", "verified_correct_answer": "Historic verification",
        "result": "Incomplete", "score": None, "reported_date": "2024-04-05",
        "status": "New", "archived": False,
    }
    fake_db.records["bassett_issues"] = [dict(legacy)]
    monkeypatch.setattr(server, "db", fake_db)
    exported = server._bassett_csv_rows("issues", [legacy])
    row = next(csv.DictReader(io.StringIO(exported)))
    result = asyncio.run(server.bassett_csv_import(
        "issues", {"rows": [row]},
        {"id": "manager-1", "name": "Manager", "role": "qa_manager"},
    ))
    assert result["updated"] == 1
    saved = fake_db.records["bassett_issues"][0]
    assert saved["result"] == "Incomplete"
    assert "test_date" not in saved
    assert saved["reported_date"] == "2024-04-05"


def test_canonical_metrics_count_current_result_vocabulary(monkeypatch):
    scenarios = [
        _scenario_row(id=f"scenario-{index}", stable_id=f"R-{index:02d}", archived=False)
        for index in range(1, 5)
    ]
    fake_db = _ImportDb(scenarios)
    fake_db.records["bassett_issues"] = [
        {"id": "one", "scenario_id": "scenario-1", "result": "Pass with Notes", "archived": False},
        {"id": "two", "scenario_id": "scenario-2", "result": "Partial", "archived": False},
        {"id": "three", "scenario_id": "scenario-3", "result": "Blocked", "archived": False},
        {"id": "four", "scenario_id": "scenario-4", "result": "Not Evaluated", "archived": False},
    ]
    fake_db.records["bassett_executions"] = []
    fake_db.records["findings"] = []
    monkeypatch.setattr(server, "db", fake_db)
    metrics = asyncio.run(server.bassett_metrics(user={"id": "viewer"}))
    assert metrics["test_runs"]["completed"] == 3
    assert metrics["test_runs"]["attention"] == 2
    assert metrics["test_runs"]["pass_rate"] == 50.0
    assert metrics["test_runs"]["passed"] == 1
    assert metrics["test_runs"]["eligible"] == 2
    assert metrics["test_runs"]["failed"] == 1
    assert metrics["test_runs"]["blocked"] == 1
    assert metrics["test_runs"]["incomplete"] == 1
    assert metrics["test_runs"]["test_bank_coverage"] == {
        "total": 4, "covered": 3, "percent": 75.0,
    }


def test_canonical_metrics_count_linked_issue_and_execution_once(monkeypatch):
    fake_db = _ImportDb([_scenario_row(id="scenario-1", stable_id="R-01", archived=False)])
    fake_db.records["bassett_issues"] = [{
        "id": "issue-1", "scenario_id": "scenario-1", "result": "Pass", "archived": False,
    }]
    fake_db.records["bassett_executions"] = [{
        "id": "execution-1", "issue_id": "issue-1", "scenario_id": "scenario-1",
        "result": "Pass", "archived": False,
    }]
    fake_db.records["findings"] = []
    monkeypatch.setattr(server, "db", fake_db)
    metrics = asyncio.run(server.bassett_metrics(user={"id": "viewer"}))
    assert metrics["test_runs"]["total"] == 1
    assert metrics["test_runs"]["completed"] == 1
    assert metrics["test_runs"]["passed"] == 1


def test_bassett_routes_do_not_replace_general_workflows():
    paths = {route.path for route in server.api.routes}
    assert "/api/findings" in paths
    assert "/api/testcases" in paths
    assert "/api/bassett/issues" in paths
    assert "/api/bassett/test-bank" in paths
    assert "/api/bassett/export/{resource}.csv" in paths
    assert "/api/bassett/findings" in paths
    assert "/api/bassett/executions/{id}/create-finding" in paths
    assert "/api/bassett/issues/{id}/send-for-retest" in paths


def test_bassett_canonical_results_keep_legacy_values_visible():
    assert set(("Pass", "Pass with Notes", "Partial", "Fail", "Blocked", "Not Evaluated")).issubset(
        server.BASSETT_RESULTS
    )
    assert set(("Pass", "Fail", "Blocked", "Incomplete")).issubset(server.BASSETT_RESULTS)
    legacy = server._decorate_bassett_execution({"id": "old-run", "result": "Incomplete"})
    assert legacy["result"] == "Incomplete"
    assert legacy["canonical_result"] == "Not Evaluated"
    assert legacy["legacy_result"] is True
    assert "legacy" in legacy["result_label"]


def test_latest_regression_run_uses_execution_time_not_test_date():
    historical_test_date_but_new_execution = {
        "id": "new", "created_at": "2026-09-01T12:00:00Z", "test_date": "2025-01-01",
        "bassett_version": "v2",
    }
    recent_test_date_but_old_execution = {
        "id": "old", "created_at": "2026-08-01T12:00:00Z", "test_date": "2026-08-31",
        "bassett_version": "v2",
    }
    assert server._latest_regression_run(
        [recent_test_date_but_old_execution, historical_test_date_but_new_execution], "v2"
    )["id"] == "new"


def test_test_bank_sorting_uses_natural_ids_and_keeps_invalid_ids_last():
    scenarios = [
        {"id": "one", "stable_id": "R-10"},
        {"id": "two", "stable_id": "A-12"},
        {"id": "three", "stable_id": "R-2"},
        {"id": "four", "stable_id": "A-01"},
        {"id": "five", "stable_id": "bad"},
        {"id": "six", "stable_id": ""},
    ]
    assert [row["stable_id"] for row in server._sort_bassett_scenarios(scenarios)] == [
        "A-01", "A-12", "R-2", "R-10", "bad", "",
    ]
    assert [row["stable_id"] for row in server._sort_bassett_scenarios(
        scenarios, direction="desc"
    )] == ["R-10", "R-2", "A-12", "A-01", "bad", ""]


def test_test_bank_sorting_uses_domain_order_and_stable_ties():
    scenarios = [
        {"id": "first", "stable_id": "R-01", "complexity": "Very High", "priority": "P2"},
        {"id": "second", "stable_id": "R-02", "complexity": "Low", "priority": "P0"},
        {"id": "third", "stable_id": "R-03", "complexity": "Moderate", "priority": "P1"},
        {"id": "fourth", "stable_id": "R-04", "complexity": "Unknown", "priority": "P9"},
    ]
    assert [row["complexity"] for row in server._sort_bassett_scenarios(
        scenarios, key="complexity"
    )] == ["Low", "Moderate", "Very High", "Unknown"]
    assert [row["complexity"] for row in server._sort_bassett_scenarios(
        scenarios, key="complexity", direction="desc"
    )] == ["Very High", "Moderate", "Low", "Unknown"]
    assert [row["priority"] for row in server._sort_bassett_scenarios(
        scenarios, key="priority"
    )] == ["P0", "P1", "P2", "P9"]

    ties = [
        {"id": "a", "stable_id": "R-01", "priority": "P1"},
        {"id": "b", "stable_id": "R-01", "priority": "P1"},
    ]
    assert [row["id"] for row in server._sort_bassett_scenarios(ties, key="priority")] == ["a", "b"]


def test_test_bank_endpoint_rejects_unsupported_sort_parameters():
    with pytest.raises(server.HTTPException) as field_error:
        asyncio.run(server.bassett_list_scenarios(sort_by="created_at;drop", user={"id": "user"}))
    assert field_error.value.status_code == 400
    with pytest.raises(server.HTTPException) as direction_error:
        asyncio.run(server.bassett_list_scenarios(sort_direction="sideways", user={"id": "user"}))
    assert direction_error.value.status_code == 400

class _RunCollection:
    def __init__(self, database, name):
        self.database = database
        self.name = name

    async def find_one(self, query, *_args, **_kwargs):
        for row in self.database.records.get(self.name, []):
            if all(row.get(key) == value for key, value in query.items()):
                return dict(row)
        return None

    async def insert_one(self, document):
        self.database.records.setdefault(self.name, []).append(dict(document))

class _RunDb:
    def __init__(self, scenario):
        self.records = {
            "bassett_scenarios": [scenario],
            "bassett_issues": [],
            "bassett_history": [],
            "activities": [],
            "bassett_executions": [],
        }

    def __getitem__(self, name):
        return _RunCollection(self, name)

    def __getattr__(self, name):
        return _RunCollection(self, name)

    async def create_bassett_issue(self, document, creation_key, snapshot_fields):
        for existing in self.records["bassett_issues"]:
            if creation_key and existing.get("creation_key") == creation_key:
                return dict(existing), False
        scenario = self.records["bassett_scenarios"][0]
        stored = {
            **document,
            "definition_snapshot": {
                field: scenario.get(field) for field in snapshot_fields
            },
        }
        self.records["bassett_issues"].append(stored)
        return dict(stored), True

def _complete_scenario(**overrides):
    scenario = {
        "id": "scenario-1", "stable_id": "R-01", "workflow_stage": "Research",
        "report_type": "Property", "test_scenario": "Setback research",
        "complexity": "High", "why_it_matters": "Accuracy",
        "what_bassett_should_do": "Read the ordinance",
        "success_criteria": "Quote the controlling section", "priority": "P1 - High",
        "archived": False,
    }
    scenario.update(overrides)
    return scenario

def test_canonical_run_creation_snapshots_definition_and_replays_without_duplicates(monkeypatch):
    fake_db = _RunDb(_complete_scenario())
    monkeypatch.setattr(server, "db", fake_db)
    actor = {"id": "tester-1", "name": "Tester", "role": "tester"}

    first = asyncio.run(server.bassett_create_issue(_run_body(), user=actor))
    replay = asyncio.run(server.bassett_create_issue(_run_body(), user=actor))

    assert first["id"] == replay["id"]
    assert first["idempotent_replay"] is False
    assert replay["idempotent_replay"] is True
    assert first["score"] == 25.0
    assert first["definition_snapshot"] == {
        field: _complete_scenario().get(field)
        for field in server.BASSETT_DEFINITION_SNAPSHOT_FIELDS
    }
    assert len(fake_db.records["bassett_issues"]) == 1
    assert fake_db.records["bassett_executions"] == []
    assert len(fake_db.records["bassett_history"]) == 2
    assert fake_db.records["activities"][0]["entity_id"] == first["id"]
    assert fake_db.records.get("findings", []) == []

def test_legacy_execution_endpoint_is_read_only():
    with pytest.raises(HTTPException) as exc:
        asyncio.run(server.bassett_create_execution(
            "scenario-1", {"result": "Pass"},
            user={"id": "tester-1", "role": "tester"},
        ))
    assert exc.value.status_code == 410
    assert "canonical Bassett Test Run" in exc.value.detail

@pytest.mark.parametrize(
    "scenario, detail",
    [
        (_complete_scenario(archived=True), "archived"),
        (_complete_scenario(success_criteria=""), "Required scenario fields are missing"),
    ],
)
def test_canonical_run_creation_rejects_archived_or_invalid_scenarios(monkeypatch, scenario, detail):
    fake_db = _RunDb(scenario)
    monkeypatch.setattr(server, "db", fake_db)
    with pytest.raises(HTTPException) as exc:
        asyncio.run(server.bassett_create_issue(
            _run_body(), user={"id": "tester-1", "name": "Tester", "role": "tester"},
        ))
    assert exc.value.status_code in (400, 409)
    assert detail.lower() in str(exc.value.detail).lower()
    assert fake_db.records["bassett_issues"] == []

def _run_body(**overrides):
    body = {
        "scenario_id": "scenario-1", "submission_id": "submission-1",
        "question_asked": "What is the setback?", "exact_bassett_answer": "Ten feet",
        "verified_correct_answer": "Twenty feet", "result": "Fail", "score": "25",
        "environment": "Staging", "test_date": "2026-09-01", "notes": "Reproduced twice",
    }
    body.update(overrides)
    return body

def test_new_runs_reject_legacy_results_and_invalid_scores():
    with pytest.raises(HTTPException) as legacy:
        server._validate_bassett_run_result({"result": "Incomplete"})
    assert legacy.value.status_code == 400
    with pytest.raises(HTTPException) as score:
        server._validate_bassett_run_result({"result": "Pass", "score": 101})
    assert score.value.status_code == 400

def test_canonical_run_scenario_link_cannot_be_changed(monkeypatch):
    class ExistingRunDb(_RunDb):
        def __init__(self):
            super().__init__(_complete_scenario())
            self.records["bassett_issues"] = [{
                **_run_body(), "id": "run-1", "scenario_id": "scenario-1",
                "definition_snapshot": _complete_scenario(), "status": "New",
            }]

    fake_db = ExistingRunDb()
    monkeypatch.setattr(server, "db", fake_db)
    with pytest.raises(HTTPException) as exc:
        asyncio.run(server.bassett_update_issue(
            "run-1", {"scenario_id": "scenario-2"},
            user={"id": "tester-1", "name": "Tester", "role": "tester"},
        ))
    assert exc.value.status_code == 409
    assert "immutable" in exc.value.detail
