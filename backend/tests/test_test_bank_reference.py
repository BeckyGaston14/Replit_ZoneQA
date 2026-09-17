"""Validate the approved Test Bank.

The guidance was refreshed from the approved Google Sheet on 2026-09-17.
The pinned hash below verifies the checked-in JSON, not a Git commit.
"""
import json
import asyncio
import hashlib
from collections import Counter
from pathlib import Path

import server

REFERENCE = json.loads((Path(__file__).parents[1] / "test_bank_reference_2026_09_16.json").read_text(encoding="utf-8"))


def test_reference_contains_all_unique_scenarios_and_rubric_items():
    scenarios = REFERENCE["scenarios"]
    rubric = REFERENCE["rubric_items"]
    assert len(scenarios) == len({row["test_id"] for row in scenarios}) == 100
    assert Counter(row["test_type"] for row in scenarios) == {"Analysis": 29, "Document Handling": 25, "General Research": 46}
    assert {row["rubric_id"] for row in rubric} == {f"G-{index:02}" for index in range(1, 32)}
    assert hashlib.sha256(
        (Path(__file__).parents[1] / "test_bank_reference_2026_09_16.json").read_bytes()
    ).hexdigest() == "db11c6b979fe7ea8206c86e6bf65edc62a96e888769c611972bbf7b9c93edc31"


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


def test_rubric_union_defaults_and_neutral_score_math():
    first = REFERENCE["scenarios"][0]
    selected = server.normalize_rubric_ids(first["rubric_ids"])
    assert selected == first["rubric_ids"]
    scored = server.score_rubrics(
        {"G-01": 0, "G-02": 10, "G-03": "N/A"},
        ["G-01", "G-02", "G-03"],
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
    legacy = {
        "id": "legacy-r-01", "stable_id": "R-01", "archived": False,
        "test_scenario": "Historical meaning", "catalog_revision": "legacy12",
    }
    db = _Db([legacy])
    monkeypatch.setattr(server, "db", db)
    asyncio.run(server._seed_bassett_catalog())
    assert legacy["archived"] is True
    assert legacy["id"] == "legacy-r-01"
    assert len(db.rows) == 101
    fresh = next(
        row for row in db.rows
        if row.get("catalog_revision") == server.CATALOG_REVISION
        and row.get("stable_id") == "R-01"
    )
    assert fresh["id"] == "bassett-catalog-2026-09-16-R-01"
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
    assert len(db.rows) == 100
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
    assert preview["would_update_guidance"] == 100
    assert preview["would_insert"] == 0
    assert preview["would_archive"] == 0
