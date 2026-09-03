"""Authoritative evaluation scoring and analytical read-model helpers."""

COMPARISON_MODELS = ("Bassett", "ChatGPT", "Claude")
PASS_RESULTS = frozenset(("Pass", "Pass with Minor Issues"))
FAIL_RESULTS = frozenset(("Fail", "Critical Fail"))
EVALUATED_RESULTS = PASS_RESULTS | FAIL_RESULTS

RECOMMENDATION_THRESHOLDS = (
    (8.5, "Pass"),
    (7.0, "Pass with Minor Issues"),
    (5.0, "Needs Improvement"),
    (3.0, "Fail"),
)
DERIVED_SCORE_FIELDS = frozenset((
    "overall_score", "weighted_score", "system_recommended", "system_explanation",
    "score_mode", "score_label", "weight_explanation",
))


def evaluation_order(evaluation):
    return (evaluation.get("created_at", ""), evaluation.get("id", ""))


def latest_evaluations(evaluations, key):
    latest = {}
    for evaluation in sorted(evaluations, key=evaluation_order):
        latest[key(evaluation)] = evaluation
    return list(latest.values())


def result_summary(evaluations):
    passed = [evaluation for evaluation in evaluations if evaluation.get("final_result") in PASS_RESULTS]
    failed = [evaluation for evaluation in evaluations if evaluation.get("final_result") in FAIL_RESULTS]
    evaluated = len(passed) + len(failed)
    return {
        "passed_records": passed,
        "failed_records": failed,
        "passed": len(passed),
        "failed": len(failed),
        "evaluated": evaluated,
        "pass_rate": round(len(passed) / evaluated * 100, 1) if evaluated else None,
    }


def average_score(evaluations, *, empty=None):
    scores = [
        float(evaluation["overall_score"])
        for evaluation in evaluations
        if evaluation.get("overall_score") is not None
    ]
    return round(sum(scores) / len(scores), 1) if scores else empty


def score_evaluation(scores, dimensions):
    """Calculate the single authoritative score from configured dimensions.

    Missing dimensions are excluded. A configured weight is used only when at
    least one configured weight differs from the neutral value of 1; otherwise
    the result is the arithmetic mean of the scored dimensions.
    """
    scores = scores if isinstance(scores, dict) else {}
    weights = {
        dimension.get("key"): dimension.get("weight") or 1
        for dimension in dimensions or []
        if dimension.get("key")
    }
    weights_active = any(
        _safe_weight(dimension.get("weight")) != 1
        for dimension in dimensions or []
        if dimension.get("key")
    )
    entries = []
    for key, raw_value in scores.items():
        if raw_value in (None, ""):
            continue
        try:
            value = float(raw_value)
            weight = _safe_weight(weights.get(key, 1))
        except (TypeError, ValueError):
            continue
        if not 0 <= value <= 10:
            continue
        entries.append((value, weight))

    denominator = sum(weight for _, weight in entries) if weights_active else len(entries)
    numerator = sum(value * (weight if weights_active else 1) for value, weight in entries)
    score = round(numerator / denominator, 1) if denominator else None
    score_label = "Weighted score" if weights_active else "Average score"
    weight_explanation = (
        "Configured weights apply to scored dimensions; missing dimensions are excluded."
        if weights_active
        else "Arithmetic mean of scored dimensions; missing dimensions are excluded."
    )
    if score is None:
        recommendation = "Not Enough Evidence"
        explanation = "No scored dimensions."
    else:
        recommendation = next(
            (label for threshold, label in RECOMMENDATION_THRESHOLDS if score >= threshold),
            "Critical Fail",
        )
        explanation = (
            f"{'Weighted dimension average' if weights_active else 'Arithmetic mean'} {score}/10 maps to '{recommendation}' "
            "(≥8.5 Pass, ≥7 Minor, ≥5 Needs Improvement, ≥3 Fail)."
        )
    return {
        "overall_score": score,
        "weighted_score": score,
        "system_recommended": recommendation,
        "system_explanation": explanation,
        "score_mode": "weighted" if weights_active else "average",
        "score_label": score_label,
        "weight_explanation": weight_explanation,
    }


def _safe_weight(value):
    try:
        value = float(value)
    except (TypeError, ValueError):
        return 1
    return value if value > 0 else 1


def authoritative_score_update(incoming, dimensions, *, creating=False):
    """Remove client-derived fields and return the server-owned write payload."""
    sanitized = {
        key: value for key, value in incoming.items()
        if key not in DERIVED_SCORE_FIELDS
    }
    if creating or "scores" in sanitized:
        sanitized.update(score_evaluation(sanitized.get("scores"), dimensions))
    return sanitized