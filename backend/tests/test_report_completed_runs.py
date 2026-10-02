import asyncio
import pytest
import server
from tests.test_current_rubric_reporting import Db


@pytest.mark.parametrize("count", [0, 3, 4, 5, 6, 20])
def test_all_completed_runs_count_within_project_and_scenario(monkeypatch, count):
    def run(identifier, **overrides):
        return {
            "id": identifier, "name": identifier, "scenario_id": "s1",
            "scenario_ids": ["s1", "s2"], "project_id": "p1",
            "test_type": "Single Prompt", "status": "In Review", "result": "Fail",
            "version_id": "v1", "bassett_version": "v1", "test_date": "2026-10-01",
            "rubric_revision": server.CATALOG_REVISION,
            "selected_rubric_ids": ["R-01"], "rubric_scores": {"R-01": 4},
            **overrides,
        }

    rows = {
        "projects": [{"id": "p1", "name": "Use Table Testing"}],
        "versions": [{"id": "v1", "name": "v1", "active": True}],
        "config": [{"id": "global", "eval_dimensions": []}],
        "bassett_scenarios": [{"id": "s1"}, {"id": "s2"}, {"id": "s3"}],
        "bassett_issues": [run(f"run-{i}") for i in range(count)] + [
            run("other-project", project_id="p2"),
            run("other-scenario", scenario_id="s3", scenario_ids=["s3"]),
            run("draft", status="Draft"),
            run("unrated", result="Not Evaluated"),
            run("archived", archived=True),
            run("deleted", deleted_at="2026-10-01"),
        ],
    }
    monkeypatch.setattr(server, "db", Db(rows))

    async def records(collection, **kwargs):
        return rows.get(collection, [])

    async def no_stale():
        return {}

    monkeypatch.setattr(server, "crud_list", records)
    monkeypatch.setattr(server, "compute_stale_gold_map", no_stale)
    executive = asyncio.run(server.analytics_executive(
        {"id": "viewer"}, report_scope="bassett", project_id="p1", scenario_id="s2"))
    performance = asyncio.run(server.analytics_performance(
        {"id": "viewer"}, scope="bassett", project_id="p1", scenario_id="s2"))
    for report in [executive, performance]:
        assert report["release_evidence"]["evaluated"] == count
        assert report["release_evidence"]["sufficient"] == (count >= 5)
        assert report["minimum_qualifying_tests"] == 5
    assert len(executive["included_tests"]) == count
    assert executive["kpis"]["bassett_avg"] == (4 if count else None)
    assert executive["kpis"]["total_evaluated"] == count

    if count:
        # A newer completed verdict without numeric ratings must not replace
        # older scored tests or blank their score/trend contribution.
        rows["bassett_issues"].append(run("new-unscored", rubric_scores={}, test_date="2026-10-02"))
        refreshed = asyncio.run(server.analytics_executive(
            {"id": "viewer"}, report_scope="bassett", project_id="p1", scenario_id="s2"))
        assert refreshed["kpis"]["total_evaluated"] == count + 1
        assert refreshed["kpis"]["bassett_avg"] == 4
        assert len(refreshed["included_tests"]) == count + 1
