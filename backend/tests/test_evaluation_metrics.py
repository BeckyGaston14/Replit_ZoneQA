from evaluation_metrics import (
    CANONICAL_EVALUATION_RESULTS,
    authoritative_score_update,
    average_score,
    evaluation_result_details,
    latest_evaluations,
    normalize_evaluation_result,
    result_summary,
    reporting_group_averages,
    score_evaluation,
)


def test_evaluation_results_normalize_legacy_values_without_losing_provenance():
    assert CANONICAL_EVALUATION_RESULTS == (
        "Pass", "Pass with Minor Issues", "Needs Improvement",
        "Fail", "Critical Fail", "Not Evaluated",
    )
    assert normalize_evaluation_result("Pass with Notes") == "Pass with Minor Issues"
    assert normalize_evaluation_result("Partial") == "Needs Improvement"
    assert normalize_evaluation_result("Blocked") == "Not Evaluated"
    assert evaluation_result_details("Blocked")["is_workflow_state"] is True
    assert evaluation_result_details("Pass with Notes")["is_legacy"] is True


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
    assert score_evaluation({}, DIMENSIONS)["system_recommended"] == "Not Evaluated"


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


def test_result_summary_normalizes_legacy_results_and_excludes_blocked():
    summary = result_summary([
        {"id": "pass", "final_result": "Pass with Notes"},
        {"id": "improve", "final_result": "Partial"},
        {"id": "blocked", "final_result": "Blocked"},
        {"id": "empty", "final_result": "Not Evaluated"},
    ])

    assert summary["passed"] == 1
    assert summary["failed"] == 0
    assert summary["evaluated"] == 1
    assert summary["passed_records"][0]["id"] == "pass"


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


def test_reporting_groups_cover_all_dimensions_and_exclude_na_and_history_gaps():
    dimensions = [
        {"key": "accuracy", "label": "Accuracy", "weight": 3},
        {"key": "current_code", "label": "Current Code", "weight": 2},
        {"key": "calculation", "label": "Calculation", "weight": 2},
        {"key": "interpretation", "label": "Interpretation", "weight": 3},
        {"key": "context", "label": "Context", "weight": 2},
        {"key": "missing_info", "label": "Missing Info", "weight": 2},
        {"key": "followup", "label": "Follow-Up", "weight": 1},
        {"key": "citation_accuracy", "label": "Citation", "weight": 2},
        {"key": "source_quality", "label": "Source Quality", "weight": 1},
        {"key": "guidance", "label": "Guidance", "weight": 1},
        {"key": "completeness", "label": "Completeness", "weight": 2},
        {"key": "usefulness", "label": "Usefulness", "weight": 3},
    ]
    groups = reporting_group_averages([
        {"scores": {"accuracy": 10, "current_code": 0, "interpretation": "N/A"}},
        {"scores": {"accuracy": 0}},
    ], dimensions)
    assert len(groups) == 7
    assert groups[0]["score"] == 3.8
    assert groups[0]["scored_value_count"] == 3
    assert groups[1]["score"] is None