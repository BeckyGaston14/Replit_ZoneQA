import asyncio

import server


class Cursor:
    def __init__(self, rows):
        self.rows = rows

    async def to_list(self, limit):
        return [dict(row) for row in self.rows[:limit]]


class Collection:
    def __init__(self, rows):
        self.rows = rows

    def find(self, query=None, *_args, **_kwargs):
        query = query or {}
        return Cursor([
            row for row in self.rows
            if all(
                row.get(key) != value.get("$ne")
                if isinstance(value, dict) and "$ne" in value
                else row.get(key) == value
                for key, value in query.items()
            )
        ])

    async def find_one(self, query=None, *_args, **_kwargs):
        query = query or {}
        return next(
            (
                dict(row) for row in self.rows
                if all(row.get(key) == value for key, value in query.items())
            ),
            None,
        )


class Db:
    def __init__(self, rows):
        self.rows = rows

    def __getattr__(self, name):
        return Collection(self.rows.get(name, []))


def _current_scores():
    return {
        "G-01": 0,
        "G-09": 10,
        "G-11": 4,
        "G-21": "N/A",
        "G-22": 7,
        "G-26": 8,
        "G-02": 6,
    }


def test_current_authoritative_read_recomputes_cached_rubric_values(monkeypatch):
    monkeypatch.setattr(server, "db", Db({"config": [{"id": "global", "eval_dimensions": []}]}))
    evaluation = {
        "id": "current",
        "rubric_revision": server.CATALOG_REVISION,
        "selected_rubric_ids": ["G-01", "G-09", "G-11", "G-21", "G-26", "G-02", "G-22"],
        "rubric_scores": _current_scores(),
        "category_scores": {"property_zoning_rules": {"average": 99}},
        "score_count": 99,
        "overall_score": 99,
        "final_result": "Pass",
    }
    row = asyncio.run(server._authoritative_evaluation_read_model([evaluation]))[0]
    assert row["overall_score"] == 5.8
    assert row["score_count"] == 6
    assert row["category_scores"]["Property & Zoning Rules"]["numerator"] == 6
    assert row["category_scores"]["Property & Zoning Rules"]["denominator"] == 2
    assert row["category_scores"]["Property & Zoning Rules"]["average"] == 3
    assert row["category_scores"]["Sources & Citations"]["numerator"] == 10
    assert row["category_scores"]["Analysis & Next Steps"]["denominator"] == 1
    assert row["scoring_system"] == "current_rubric"


def test_performance_current_categories_are_five_and_legacy_is_separate(monkeypatch):
    scenarios = [
        {"id": "current-scenario", "stable_id": "G-1", "test_type": "Single Prompt"},
        {"id": "legacy-scenario", "stable_id": "R-1", "test_type": "Single Prompt"},
    ]
    issues = [
        {
            "id": "current-run", "scenario_id": "current-scenario",
            "test_type": "Single Prompt", "status": "Triaged", "result": "Pass",
            "bassett_version": "v1", "version_id": "v1", "test_date": "2026-09-01",
            "rubric_revision": server.CATALOG_REVISION,
            "selected_rubric_ids": list(_current_scores()),
            "rubric_scores": _current_scores(),
        },
        {
            "id": "legacy-run", "scenario_id": "legacy-scenario",
            "test_type": "Single Prompt", "status": "Triaged", "result": "Pass",
            "bassett_version": "v1", "version_id": "v1", "test_date": "2026-09-02",
            "evaluation_scores": {"accuracy": 10},
        },
    ]
    rows = {
        "config": [{"id": "global", "eval_dimensions": [{"key": "accuracy", "weight": 1}]}],
        "versions": [{"id": "v1", "name": "v1", "active": True}],
        "bassett_scenarios": scenarios,
        "bassett_issues": issues,
        "bassett_executions": [],
        "testcases": [],
        "evaluations": [],
        "municipalities": [],
    }
    monkeypatch.setattr(server, "db", Db(rows))

    async def crud_list(collection, query=None, **_kwargs):
        return [dict(row) for row in rows.get(collection, [])]

    monkeypatch.setattr(server, "crud_list", crud_list)
    result = asyncio.run(server.analytics_performance({"id": "viewer"}, scope="bassett"))

    assert result["rubric_categories"] and len(result["rubric_categories"]) == 5
    assert all(row["denominator"] > 0 for row in result["rubric_categories"])
    assert {row["numerator"] for row in result["rubric_categories"]} == {6, 7, 8, 10, 4}
    assert result["scoring_populations"]["current_rubric"]["evaluation_count"] == 1
    assert result["scoring_populations"]["legacy_dimensions"]["evaluation_count"] == 1
    assert result["legacy_reporting_groups"]
    assert result["model_summary"][0]["avg_score"] == 5.8


def test_comparison_read_model_rejects_mixed_scoring_system_triplet(monkeypatch):
    rows = {
        "config": [{
            "id": "global",
            "eval_dimensions": [{"key": "accuracy", "weight": 1}],
        }],
        "test_runs": [{
            "id": "run-1", "status": "Completed",
            "outcome": "Complete", "comparison_complete": True,
        }],
    }
    monkeypatch.setattr(server, "db", Db(rows))
    evaluations = [
        {
            "id": "bassett", "run_id": "run-1", "testcase_id": "tc-1",
            "model": "Bassett", "rubric_revision": server.CATALOG_REVISION,
            "selected_rubric_ids": ["G-01"], "rubric_scores": {"G-01": 8},
            "scores": {}, "final_result": "Pass",
        },
        {
            "id": "chatgpt", "run_id": "run-1", "testcase_id": "tc-1",
            "model": "ChatGPT", "scores": {"accuracy": 8}, "final_result": "Pass",
        },
        {
            "id": "claude", "run_id": "run-1", "testcase_id": "tc-1",
            "model": "Claude", "scores": {"accuracy": 8}, "final_result": "Pass",
        },
    ]

    result = asyncio.run(server._complete_comparison_evaluations(evaluations))

    assert result == []


def test_standalone_bassett_release_scoring_uses_current_rubric():
    scored = server._authoritative_bassett_run_scoring({
        "rubric_revision": server.CATALOG_REVISION,
        "selected_rubric_ids": list(_current_scores()),
        "rubric_scores": _current_scores(),
        "evaluation_scores": {"accuracy": 99},
    }, [{"key": "accuracy", "weight": 1}])

    assert scored["overall_score"] == 5.8
    assert scored["score_count"] == 6
    assert scored["scoring_system"] == "current_rubric"
    assert len(scored["category_scores"]) == 5


def test_scenario_test_type_preserves_document_handling():
    assert server._bassett_scenario_test_type({"test_type": "General Research"}) == "Research"
    assert server._bassett_scenario_test_type({"test_type": "Analysis"}) == "Analysis"
    assert server._bassett_scenario_test_type({"test_type": "Document Handling"}) == "Document Handling"


def test_bassett_metrics_scope_cards_and_coverage_to_selected_project(monkeypatch):
    rows = {
        "bassett_scenarios": [
            {"id": "scenario-a", "test_type": "Research", "archived": False},
            {"id": "scenario-b", "test_type": "Document Handling", "archived": False},
        ],
        "bassett_issues": [
            {
                "id": "run-a", "project_id": "project-a", "scenario_id": "scenario-a",
                "status": "Not Started", "result": "Critical Fail", "severity": "Critical",
                "version_id": "v1", "bassett_version": "v1",
            },
            {
                "id": "run-b", "project_id": "project-b", "scenario_id": "scenario-b",
                "status": "In Review", "result": "Pass", "severity": "Medium",
                "version_id": "v1", "bassett_version": "v1",
            },
        ],
        "bassett_executions": [],
        "versions": [{"id": "v1", "name": "v1", "active": True}],
        "findings": [],
    }
    monkeypatch.setattr(server, "db", Db(rows))

    result = asyncio.run(server.bassett_metrics(project_id="project-b", user={"id": "viewer"}))

    assert result["issues"]["total"] == 1
    assert result["issues"]["new"] == 0
    assert result["issues"]["critical"] == 0
    assert result["test_runs"]["attention"] == 0
    assert result["test_runs"]["pass_rate"] == 100
    assert result["test_runs"]["test_bank_coverage"] == {"total": 1, "covered": 1, "percent": 100.0}
    assert result["scope"]["project_id"] == "project-b"
