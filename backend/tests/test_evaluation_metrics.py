from evaluation_metrics import (
    authoritative_score_update,
    average_score,
    latest_evaluations,
    result_summary,
    score_evaluation,
)


DIMENSIONS = [
    {"key": "accuracy", "weight": 3},
    {"key": "citation", "weight": 1},
]


def test_score_evaluation_uses_configured_weights_without_mutating_raw_scores():
    scores = {"accuracy": 9, "citation": 5, "not_configured": 7, "not_applicable": None}
    before = dict(scores)

    result = score_evaluation(scores, DIMENSIONS)

    assert scores == before
    assert result["overall_score"] == 7.8
    assert result["weighted_score"] == 7.8
    assert result["system_recommended"] == "Pass with Minor Issues"


def test_score_evaluation_thresholds_and_empty_scores_are_authoritative():
    assert score_evaluation({"accuracy": 8.5}, DIMENSIONS)["system_recommended"] == "Pass"
    assert score_evaluation({"accuracy": 7}, DIMENSIONS)["system_recommended"] == "Pass with Minor Issues"
    assert score_evaluation({"accuracy": 5}, DIMENSIONS)["system_recommended"] == "Needs Improvement"
    assert score_evaluation({"accuracy": 3}, DIMENSIONS)["system_recommended"] == "Fail"
    assert score_evaluation({"accuracy": 2.9}, DIMENSIONS)["system_recommended"] == "Critical Fail"
    assert score_evaluation({}, DIMENSIONS)["system_recommended"] == "Not Enough Evidence"


def test_latest_and_denominator_helpers_preserve_reviewer_results():
    evaluations = [
        {"id": "old", "testcase_id": "tc", "created_at": "2026-01-01", "final_result": "Pass"},
        {"id": "new", "testcase_id": "tc", "created_at": "2026-02-01", "final_result": "Needs Improvement"},
        {"id": "pass", "testcase_id": "other", "created_at": "2026-01-01", "final_result": "Pass with Minor Issues", "overall_score": 8},
    ]

    latest = latest_evaluations(evaluations, lambda evaluation: evaluation["testcase_id"])
    summary = result_summary(latest)

    assert {evaluation["id"] for evaluation in latest} == {"new", "pass"}
    assert summary["passed"] == 1
    assert summary["failed"] == 0
    assert summary["evaluated"] == 1
    assert summary["pass_rate"] == 100.0
    assert average_score(latest) == 8.0


def test_authoritative_write_strips_injected_derived_fields():
    injected = {
        "scores": {"accuracy": 4},
        "overall_score": 10,
        "weighted_score": 10,
        "system_recommended": "Pass",
        "system_explanation": "client supplied",
        "final_result": "Pass",
    }

    created = authoritative_score_update(injected, DIMENSIONS, creating=True)
    metadata_only_update = authoritative_score_update({
        "notes": "reviewed",
        "overall_score": 10,
        "system_recommended": "Pass",
    }, DIMENSIONS)

    assert created["scores"] == {"accuracy": 4}
    assert created["overall_score"] == 4.0
    assert created["system_recommended"] == "Fail"
    assert created["final_result"] == "Pass"
    assert metadata_only_update == {"notes": "reviewed"}