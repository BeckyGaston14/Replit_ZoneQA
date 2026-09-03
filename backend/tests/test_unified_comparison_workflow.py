"""Unit coverage for shared Bassett/comparison workflow normalization."""

import asyncio

import pytest
from fastapi import HTTPException

import server


class _Config:
    async def find_one(self, *_args, **_kwargs):
        return {
            "pass_results": server.DEFAULT_CONFIG["pass_results"],
            "eval_dimensions": [
                {"key": "accuracy", "weight": 2},
                {"key": "usefulness", "weight": 1},
            ],
        }


class _Db:
    config = _Config()


def _body(**overrides):
    body = {
        "testcase": {
            "name": "Unified case", "scenario_id": "scenario-1",
            "prompts": [{"turn": 1, "text": "What applies?"}],
            "test_date": "2026-09-01", "result": "Pass",
        },
        "gold_standard": {"answer": "Verified answer"},
        "responses": {"Bassett": {"response": "Bassett answer"}},
        "evaluations": {"Bassett": {"scores": {"accuracy": 9}}},
        "comparison": {"comparison_result": "Incomplete"},
    }
    body.update(overrides)
    return body


def _prepare(monkeypatch, body):
    monkeypatch.setattr(server, "db", _Db())

    async def reference(collection, identifier, _label):
        assert collection == "bassett_scenarios"
        assert identifier == "scenario-1"
        return {"id": identifier, "workflow_stage": "Research"}

    async def no_op(*_args, **_kwargs):
        return None

    monkeypatch.setattr(server, "_bassett_ref", reference)
    monkeypatch.setattr(server, "_validate_user_references", no_op)
    monkeypatch.setattr(server, "_validate_relationships", no_op)
    return asyncio.run(server._prepare_comparison_workflow(
        body, {"id": "tester-1", "name": "Tester"}
    ))


def test_workflow_keeps_missing_benchmarks_unavailable_and_out_of_score_denominators(monkeypatch):
    testcase, gold, responses, evaluations = _prepare(monkeypatch, _body())
    by_model = {record["model"]: record for record in responses}
    scores = {record["model"]: record for record in evaluations}
    assert testcase["comparison_mode"] is True
    assert gold["answer"] == "Verified answer"
    assert by_model["Bassett"]["availability"] == "available"
    assert by_model["ChatGPT"]["availability"] == "unavailable"
    assert by_model["Claude"]["availability"] == "unavailable"
    assert scores["Bassett"]["overall_score"] == 9
    assert scores["ChatGPT"]["overall_score"] is None
    assert scores["Claude"]["overall_score"] is None
    assert scores["ChatGPT"]["scores"] == {}
    assert scores["Claude"]["status"] == "Unavailable"


def test_workflow_preserves_relationships_and_embedded_evidence_context(monkeypatch):
    body = _body(testcase={
        **_body()["testcase"],
        "project_id": "project-1",
        "municipality_id": "municipality-1",
        "property_id": "property-1",
        "evidence_ids": ["evidence-1"],
        "source_links": "https://example.test/ordinance",
        "create_finding": True,
        "finding": {"title": "Linked Bassett finding", "description": "Incorrect setback"},
        "regression_run_id": "regression-1",
    })
    testcase, _gold, _responses, _evaluations = _prepare(monkeypatch, body)
    finding = server._bassett_finding_document(
        body, "testcase-1", {"name": "Tester"}, "2026-09-03T00:00:00Z"
    )

    assert testcase["project_id"] == "project-1"
    assert testcase["municipality_id"] == "municipality-1"
    assert testcase["property_id"] == "property-1"
    assert testcase["evidence_ids"] == ["evidence-1"]
    assert testcase["source_links"] == "https://example.test/ordinance"
    assert testcase["regression_run_id"] == "regression-1"
    assert finding["testcase_id"] == "testcase-1"
    assert finding["project_id"] == "project-1"


def test_workflow_recomputes_scores_and_rejects_invalid_client_verdict(monkeypatch):
    body = _body(evaluations={
        "Bassett": {"scores": {"accuracy": 9, "usefulness": 6}},
        "ChatGPT": {"scores": {"accuracy": 11}, "final_result": "Pass"},
    })
    with pytest.raises(HTTPException) as exc:
        _prepare(monkeypatch, body)
    assert exc.value.status_code == 400

    invalid = _body(evaluations={
        "Bassett": {"scores": {"accuracy": 9}},
        "ChatGPT": {"scores": {"accuracy": 8}, "final_result": "Invented verdict"},
    })
    with pytest.raises(HTTPException) as exc:
        _prepare(monkeypatch, invalid)
    assert exc.value.status_code == 400


def test_finding_scopes_are_separate_and_ownership_is_preserved():
    user = {"name": "Tester"}
    body = {
        "testcase": {
            "create_finding": True, "assignee_id": "owner-1",
            "finding": {"title": "Bassett defect", "description": "Wrong answer"},
        },
        "comparison": {
            "findings": [{
                "title": "Competitive gap", "description": "Claude was clearer",
                "assignee_id": "owner-2",
            }],
        },
    }
    bassett = server._bassett_finding_document(body, "tc-1", user, "stamp")
    comparison = server._comparison_finding_documents(body, "tc-1", user, "stamp")
    assert bassett["finding_scope"] == "bassett"
    assert bassett["source"] == "bassett_only"
    assert bassett["assignee_id"] == "owner-1"
    assert comparison[0]["finding_scope"] == "comparison"
    assert comparison[0]["source"] == "model_comparison"
    assert comparison[0]["assignee_id"] == "owner-2"