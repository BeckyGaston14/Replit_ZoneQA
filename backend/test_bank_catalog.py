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
    by_category: dict[str, list[float]] = {}
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
        by_category.setdefault(category, []).append(value)
        values.append(value)
    category_scores = {
        category_name(category): {
            "category": category,
            "average": round(sum(items) / len(items), 1),
            "count": len(items),
        }
        for category, items in by_category.items()
    }
    return {
        "category_scores": category_scores,
        "overall_score": round(sum(values) / len(values), 1) if values else None,
        "score_count": len(values),
    }
