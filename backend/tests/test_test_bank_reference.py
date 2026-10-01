"""Validate the current approved Test Bank refreshed on 2026-10-01."""
import json
import asyncio
from collections import Counter
from pathlib import Path

import server

REFERENCE = json.loads((Path(__file__).parents[1] / "test_bank_reference_2026_10_01.json").read_text(encoding="utf-8"))


def test_reference_contains_all_unique_scenarios_and_rubric_items():
    scenarios = REFERENCE["scenarios"]
    rubric = REFERENCE["rubric_items"]
    assert len(scenarios) == len({row["test_id"] for row in scenarios}) == 94
    assert Counter(row["test_type"] for row in scenarios) == {
        "Analysis": 30, "Document Handling": 19,
        "General Research": 35, "Municipal Research": 10,
    }
    assert {row["rubric_id"] for row in rubric} == {f"R-{index:02}" for index in range(1, 33)}


def test_every_association_resolves_and_every_rubric_item_has_one_category():
    ids = {row["rubric_id"] for row in REFERENCE["rubric_items"]}
    categories = REFERENCE["categories"]
    all_category_ids = [item for category in categories for item in category["rubric_ids"]]
    assert len(categories) == 5
    assert len(all_category_ids) == len(set(all_category_ids)) == 32
    assert set(all_category_ids) == ids
    for item in REFERENCE["rubric_items"]:
        assert item["rubric_id"] in next(category["rubric_ids"] for category in categories if category["key"] == item["category"])
        assert all(item[key].strip() for key in ("evaluation_criterion", "expected_behavior", "passing_standard"))
    for row in REFERENCE["scenarios"]:
        assert row["rubric_ids"] and len(row["rubric_ids"]) == len(set(row["rubric_ids"]))
        assert set(row["rubric_ids"]) <= ids


def test_rubric_ids_use_current_source_meaning():
    items = {row["rubric_id"]: row for row in REFERENCE["rubric_items"]}
    assert items["R-01"]["evaluation_criterion"] == "Verify the property and governing jurisdiction"
    assert items["R-21"]["evaluation_criterion"] == "Do not lose context"
    assert items["R-31"]["evaluation_criterion"] == "Search municipal permit records carefully"
    assert items["R-32"]["category"] == "documents_municipal_records"
    assert all("R-21" in row["rubric_ids"] for row in REFERENCE["scenarios"])


def test_rubric_reorder_renumbers_contiguously_and_returns_association_mapping():
    items = [
        {"rubric_id": "R-01", "evaluation_criterion": "First"},
        {"rubric_id": "R-02", "evaluation_criterion": "Second"},
        {"rubric_id": "R-03", "evaluation_criterion": "Third"},
    ]
    reordered, mapping = server._renumber_rubric_items(items, "R-03", 2)
    assert [item["evaluation_criterion"] for item in reordered] == ["First", "Third", "Second"]
    assert [item["rubric_id"] for item in reordered] == ["R-01", "R-02", "R-03"]
    assert mapping == {"R-01": "R-01", "R-03": "R-02", "R-02": "R-03"}


def test_simplified_scenarios_are_the_user_facing_catalog_labels():
    from test_bank_catalog import scenario_definition

    for source in REFERENCE["scenarios"]:
        definition = scenario_definition(source)
        assert source["simplified_scenario"].strip()
        assert definition["test_scenario"] == source["simplified_scenario"]
        assert definition["detailed_scenario"] == source["test_scenario"]


def test_rubric_union_defaults_and_neutral_score_math():
    first = REFERENCE["scenarios"][0]
    selected = server.normalize_rubric_ids(first["rubric_ids"])
    assert selected == first["rubric_ids"]
    scored = server.score_rubrics(
        {"R-01": 0, "R-02": 10, "R-03": "N/A"},
        ["R-01", "R-02", "R-03"],
    )
    assert scored["overall_score"] == 5.0
    assert scored["score_count"] == 2


class _Cursor:
    def __init__(self, rows):
        self.rows = rows

    async def to_list(self, _limit):
        return [dict(row) for row in self.rows]


class _Collection:
    def __init__(self, db):
        self.db = db

    def find(self, query=None, *_args, **_kwargs):
        query = query or {}
        def matches(row):
            for key, value in query.items():
                if isinstance(value, dict) and "$ne" in value:
                    if row.get(key) == value["$ne"]:
                        return False
                elif row.get(key) != value:
                    return False
            return True
        return _Cursor([
            row for row in self.db.rows
            if matches(row)
        ])

    async def find_one(self, query, *_args, **_kwargs):
        for row in self.db.rows:
            if all(row.get(key) == value for key, value in query.items()):
                return dict(row)
        return None

    async def insert_one(self, row):
        self.db.rows.append(dict(row))

    async def update_one(self, query, update):
        for row in self.db.rows:
            if all(row.get(key) == value for key, value in query.items()):
                row.update(update.get("$set", {}))
                return


class _Db:
    def __init__(self, rows):
        self.rows = rows

    @property
    def bassett_scenarios(self):
        return _Collection(self)


def test_catalog_reconciliation_archives_legacy_and_is_idempotent(monkeypatch):
    previous = {
        "id": "prior-a-01", "stable_id": "A-01", "archived": False,
        "test_scenario": "Prior meaning", "catalog_revision": "prior",
    }
    db = _Db([previous])
    monkeypatch.setattr(server, "db", db)
    asyncio.run(server._seed_bassett_catalog())
    assert previous["archived"] is False
    assert previous["id"] == "prior-a-01"
    assert len(db.rows) == 94
    fresh = next(
        row for row in db.rows
        if row.get("catalog_revision") == server.CATALOG_REVISION
        and row.get("stable_id") == "A-01"
    )
    assert fresh["id"] == "prior-a-01"
    assert fresh["rubric_ids"] == REFERENCE["scenarios"][0]["rubric_ids"]
    snapshot = [dict(row) for row in db.rows]
    asyncio.run(server._seed_bassett_catalog())
    assert db.rows == snapshot


def test_guidance_refresh_keeps_canonical_ids_and_is_idempotent(monkeypatch):
    import server
    import asyncio
    from test_bank_catalog import scenario_definition
    definition = scenario_definition(REFERENCE["scenarios"][0])
    old = {**definition, "id": "existing-canonical-id", "guidance_revision": "2026-09-16", "why_it_matters": "Old generic guidance", "archived": False}
    db = _Db([old])
    monkeypatch.setattr(server, "db", db)
    asyncio.run(server._seed_bassett_catalog())
    assert old["id"] == "existing-canonical-id"
    assert old["why_it_matters"] == definition["why_it_matters"]
    assert len(db.rows) == 94
    snapshot = [dict(row) for row in db.rows]
    asyncio.run(server._seed_bassett_catalog())
    assert db.rows == snapshot


def test_existing_catalog_still_previews_changed_guidance(monkeypatch):
    from test_bank_catalog import scenario_definition
    rows = [{**scenario_definition(row), "id": row["test_id"], "archived": False,
             "guidance_revision": "2026-09-16"} for row in REFERENCE["scenarios"]]
    monkeypatch.setattr(server, "db", _Db(rows))
    preview = asyncio.run(server._catalog_revision_preview())
    assert preview["already_applied"] is False
    assert preview["would_update_guidance"] == 94
    assert preview["would_insert"] == 0
    assert preview["would_archive"] == 0


def test_current_revision_with_legacy_content_is_refreshed(monkeypatch):
    from test_bank_catalog import scenario_definition
    rows = [
        {
            **scenario_definition(row),
            "id": row["test_id"],
            "archived": False,
        }
        for row in REFERENCE["scenarios"]
    ]
    rows[0]["test_type"] = "Research"
    rows[0]["workflow_stage"] = "Research"
    db = _Db(rows)
    monkeypatch.setattr(server, "db", db)

    preview = asyncio.run(server._catalog_revision_preview())
    assert preview["would_update_guidance"] == 1

    asyncio.run(server._seed_bassett_catalog())
    refreshed = next(row for row in db.rows if row["stable_id"] == rows[0]["stable_id"])
    expected = scenario_definition(REFERENCE["scenarios"][0])
    assert refreshed["test_type"] == expected["test_type"]
    assert refreshed["workflow_stage"] == expected["workflow_stage"]
