"""Validate the exact spreadsheet snapshot used by the rubric migration."""
import json
from collections import Counter
from pathlib import Path

REFERENCE = json.loads((Path(__file__).parents[1] / "test_bank_reference_2026_09_16.json").read_text(encoding="utf-8"))


def test_reference_contains_all_unique_scenarios_and_rubric_items():
    scenarios = REFERENCE["scenarios"]
    rubric = REFERENCE["rubric_items"]
    assert len(scenarios) == len({row["test_id"] for row in scenarios}) == 100
    assert Counter(row["test_type"] for row in scenarios) == {"Analysis": 29, "Document Handling": 25, "General Research": 46}
    assert {row["rubric_id"] for row in rubric} == {f"G-{index:02}" for index in range(1, 32)}


def test_every_association_resolves_and_every_rubric_item_has_one_category():
    ids = {row["rubric_id"] for row in REFERENCE["rubric_items"]}
    categories = REFERENCE["categories"]
    all_category_ids = [item for category in categories for item in category["rubric_ids"]]
    assert len(categories) == 5
    assert len(all_category_ids) == len(set(all_category_ids)) == 31
    assert set(all_category_ids) == ids
    for item in REFERENCE["rubric_items"]:
        assert item["rubric_id"] in next(category["rubric_ids"] for category in categories if category["key"] == item["category"])
        assert all(item[key].strip() for key in ("evaluation_criterion", "expected_behavior", "passing_standard"))
    for row in REFERENCE["scenarios"]:
        assert row["rubric_ids"] and len(row["rubric_ids"]) == len(set(row["rubric_ids"]))
        assert set(row["rubric_ids"]) <= ids


def test_changed_ids_use_current_source_meaning_not_legacy_subtype_meaning():
    items = {row["rubric_id"]: row for row in REFERENCE["rubric_items"]}
    assert items["G-01"]["evaluation_criterion"] == "Verify the property and governing jurisdiction"
    assert items["G-30"]["evaluation_criterion"] == "Search municipal permit records carefully"
    assert items["G-31"]["category"] == "documents_municipal_records"
