"""Revisioned Test Bank catalog and rubric helpers.

The JSON reference is an immutable source snapshot.  Runtime records copy its
definitions so later catalog revisions cannot reinterpret historical scores.
"""
from __future__ import annotations

import json
from pathlib import Path
from typing import Any


CATALOG_REVISION = "2026-09-16"
REFERENCE_PATH = Path(__file__).with_name("test_bank_reference_2026_09_16.json")
REFERENCE = json.loads(REFERENCE_PATH.read_text(encoding="utf-8"))
RUBRIC_ITEMS = tuple(REFERENCE["rubric_items"])
CATEGORIES = tuple(REFERENCE["categories"])
RUBRIC_BY_ID = {item["rubric_id"]: item for item in RUBRIC_ITEMS}
CATEGORY_BY_KEY = {item["key"]: item for item in CATEGORIES}


def category_name(key: str) -> str:
    return CATEGORY_BY_KEY.get(key, {}).get("name") or key


def suggested_category(rubric_ids: list[str]) -> str:
    """Use the first listed rubric category as the editable suggestion."""
    for rubric_id in rubric_ids:
        item = RUBRIC_BY_ID.get(rubric_id)
        if item:
            return category_name(item["category"])
    return category_name(CATEGORIES[0]["key"])


def normalize_rubric_ids(value: Any, *, allowed: set[str] | None = None) -> list[str]:
    allowed = allowed or set(RUBRIC_BY_ID)
    seen = set()
    normalized = []
    for raw in value if isinstance(value, list) else []:
        rubric_id = str(raw or "").strip().upper()
        if rubric_id in allowed and rubric_id not in seen:
            seen.add(rubric_id)
            normalized.append(rubric_id)
    return normalized


def scenario_definition(source: dict[str, Any]) -> dict[str, Any]:
    rubric_ids = normalize_rubric_ids(source.get("rubric_ids"))
    return {
        "stable_id": source["test_id"],
        "workflow_stage": "Research" if source["test_type"] == "General Research" else "Analysis",
        "report_type": source["test_type"],
        "test_type": source["test_type"],
        "test_scenario": source["test_scenario"],
        "complexity": source["complexity"],
        "why_it_matters": source["why_it_matters"],
        "what_bassett_should_do": source["what_bassett_should_do"],
        "success_criteria": source["success_criteria"],
        "priority": source["priority"],
        "scoring_category": suggested_category(rubric_ids),
        "catalog_revision": CATALOG_REVISION,
        "guidance_revision": REFERENCE.get("guidance_revision", CATALOG_REVISION),
        "rubric_ids": rubric_ids,
    }


def rubric_snapshot(selected_ids: Any) -> dict[str, dict[str, Any]]:
    ids = normalize_rubric_ids(selected_ids)
    return {rubric_id: dict(RUBRIC_BY_ID[rubric_id]) for rubric_id in ids}


def score_rubrics(scores: Any, selected_ids: Any) -> dict[str, Any]:
    """Neutral-weight category and overall averages; zero is a valid score."""
    scores = scores if isinstance(scores, dict) else {}
    ids = normalize_rubric_ids(selected_ids)
    values = []
    by_category = aggregate_rubric_categories(scores, ids)
    for rubric_id in ids:
        raw = scores.get(rubric_id)
        if raw in (None, "", "N/A", "NA", "Missing"):
            continue
        try:
            value = float(raw)
        except (TypeError, ValueError):
            continue
        if not 0 <= value <= 10:
            continue
        values.append(value)
    category_scores = {
        category_name(category): {
            **details,
            "category": category,
        }
        for category, details in by_category.items()
        if details["count"]
    }
    return {
        "category_scores": category_scores,
        "overall_score": round(sum(values) / len(values), 1) if values else None,
        "score_count": len(values),
    }


def aggregate_rubric_categories(scores: Any, selected_ids: Any) -> dict[str, dict[str, Any]]:
    """Aggregate selected current-revision rubric values across every catalog category.

    The returned rows deliberately include numerator and denominator rather than
    only a rounded average.  Missing, N/A, unchecked, invalid, and out-of-range
    values never enter either total; numeric zero remains a valid observation.
    All five catalog categories are returned so analytical consumers can render a
    stable chart and distinguish an empty category from an absent category.
    """
    scores = scores if isinstance(scores, dict) else {}
    ids = normalize_rubric_ids(selected_ids)
    category_totals = {
        category["key"]: {"numerator": 0.0, "denominator": 0, "count": 0}
        for category in CATEGORIES
    }
    for rubric_id in ids:
        raw = scores.get(rubric_id)
        if raw in (None, "", "N/A", "NA", "Missing"):
            continue
        try:
            value = float(raw)
        except (TypeError, ValueError):
            continue
        if not 0 <= value <= 10:
            continue
        category = RUBRIC_BY_ID[rubric_id]["category"]
        totals = category_totals[category]
        totals["numerator"] += value
        totals["denominator"] += 1
        totals["count"] += 1
    return {
        category: {
            "category": category,
            "average": round(details["numerator"] / details["denominator"], 1)
            if details["denominator"] else None,
            **details,
        }
        for category, details in category_totals.items()
    }


def aggregate_rubric_evaluations(evaluations: Any) -> list[dict[str, Any]]:
    """Aggregate current-revision rubric values across evaluation records."""
    totals = {
        category["key"]: {"numerator": 0.0, "denominator": 0, "count": 0}
        for category in CATEGORIES
    }
    evaluation_count = 0
    for evaluation in evaluations if isinstance(evaluations, list) else []:
        result = aggregate_rubric_categories(
            evaluation.get("rubric_scores") or {},
            evaluation.get("selected_rubric_ids") or [],
        )
        if result:
            evaluation_count += 1
        for category, details in result.items():
            totals[category]["numerator"] += details["numerator"]
            totals[category]["denominator"] += details["denominator"]
            totals[category]["count"] += details["count"]
    return [
        {
            "category": category,
            "label": category_name(category),
            "average": round(details["numerator"] / details["denominator"], 1)
            if details["denominator"] else None,
            **details,
            "evaluation_count": evaluation_count,
        }
        for category, details in totals.items()
    ]
