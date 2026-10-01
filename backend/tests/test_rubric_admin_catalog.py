import asyncio

import server


class Cursor:
    def __init__(self, rows):
        self.rows = rows

    async def to_list(self, limit):
        return [dict(row) for row in self.rows[:limit]]


class Collection:
    def __init__(self, rows):
        self.rows = rows

    async def find_one(self, query, *_args, **_kwargs):
        return next((dict(row) for row in self.rows if all(row.get(key) == value for key, value in query.items())), None)

    def find(self, query=None, *_args, **_kwargs):
        query = query or {}
        return Cursor([row for row in self.rows if all(row.get(key) == value for key, value in query.items())])

    async def update_one(self, query, update, upsert=False):
        row = next((row for row in self.rows if all(row.get(key) == value for key, value in query.items())), None)
        if row is None and upsert:
            row = dict(query)
            self.rows.append(row)
        if row is not None:
            row.update(update.get("$set", {}))

    async def insert_one(self, row):
        self.rows.append(dict(row))

    async def delete_one(self, query):
        row = next((row for row in self.rows if all(row.get(key) == value for key, value in query.items())), None)
        if row is not None:
            self.rows.remove(row)
        return type("DeleteResult", (), {"deleted_count": int(row is not None)})()


class Db:
    def __init__(self, config, scenarios):
        self.config = Collection(config)
        self.bassett_scenarios = Collection(scenarios)
        self.bassett_history = Collection([])
        for name in (
            "bassett_issues", "bassett_executions", "testcases", "findings",
            "retests", "regression_runs",
        ):
            setattr(self, name, Collection([]))

    def __getitem__(self, name):
        return getattr(self, name)


def test_reorder_updates_current_scenario_links_and_preserves_contiguous_numbers(monkeypatch):
    config = [{"id": "global"}]
    scenarios = [{
        "id": "scenario-1",
        "catalog_revision": server.CATALOG_REVISION,
        "rubric_ids": ["R-21", "R-22", "R-24"],
    }]
    monkeypatch.setattr(server, "db", Db(config, scenarios))

    result = asyncio.run(server.reorder_bassett_rubric_item(
        {"rubric_id": "R-22", "position": 21},
        {"role": "admin", "name": "QA Admin"},
    ))

    stored = config[0]["rubric_catalog_items"]
    assert len(stored) == 32
    assert [item["rubric_id"] for item in stored] == [f"R-{index:02}" for index in range(1, 33)]
    assert stored[20]["evaluation_criterion"] == "Keep property facts separate when comparing two properties"
    assert stored[21]["evaluation_criterion"] == "Do not lose context"
    assert scenarios[0]["rubric_ids"] == ["R-22", "R-21", "R-24"]
    assert result["historical_snapshots_preserved"] is True


def test_add_rubric_item_at_position_renumbers_later_items(monkeypatch):
    config = [{"id": "global"}]
    scenarios = [{
        "id": "scenario-1",
        "catalog_revision": server.CATALOG_REVISION,
        "rubric_ids": ["R-31", "R-32"],
    }]
    monkeypatch.setattr(server, "db", Db(config, scenarios))
    body = {
        "position": 32,
        "category": "documents_municipal_records",
        "evaluation_complexity": "Moderate",
        "evaluation_criterion": "Confirm municipal response status",
        "why_it_matters": "Open requests need a clear status.",
        "expected_behavior": "State the response status and next follow-up.",
        "passing_standard": "The status and next action are clear.",
    }

    created = asyncio.run(server.create_bassett_rubric_item(
        body, {"role": "admin", "name": "QA Admin"}
    ))

    assert created["rubric_id"] == "R-32"
    assert created["evaluation_criterion"] == body["evaluation_criterion"]
    assert len(config[0]["rubric_catalog_items"]) == 33
    assert scenarios[0]["rubric_ids"] == ["R-31", "R-33"]


def test_r21_backfill_updates_every_current_scenario_once_and_preserves_legacy(monkeypatch):
    config = [{"id": "global"}]
    scenarios = [
        {
            "id": "current-missing",
            "catalog_revision": server.CATALOG_REVISION,
            "rubric_ids": ["R-03", "R-09"],
        },
        {
            "id": "current-complete",
            "catalog_revision": server.CATALOG_REVISION,
            "rubric_ids": ["R-03", "R-21"],
        },
        {
            "id": "historical",
            "catalog_revision": "2026-09-30",
            "rubric_ids": ["R-03"],
        },
    ]
    monkeypatch.setattr(server, "db", Db(config, scenarios))

    first = asyncio.run(server._ensure_r21_on_current_scenarios())
    second = asyncio.run(server._ensure_r21_on_current_scenarios())

    assert first == {"updated": 1, "already_applied": False}
    assert second == {"updated": 0, "already_applied": True}
    assert scenarios[0]["rubric_ids"] == ["R-03", "R-09", "R-21"]
    assert scenarios[1]["rubric_ids"] == ["R-03", "R-21"]
    assert scenarios[2]["rubric_ids"] == ["R-03"]
    assert config[0]["scenario_r21_backfill_count"] == 1


def test_bulk_hidden_scenario_cleanup_deletes_only_unreferenced_rows(monkeypatch):
    scenarios = [
        {"id": "hidden-free", "stable_id": "OLD-01", "archived": True},
        {"id": "hidden-used", "stable_id": "OLD-02", "archived": True},
        {"id": "active", "stable_id": "R-01", "archived": False},
    ]
    database = Db([{"id": "global"}], scenarios)
    database.bassett_issues.rows.append({"id": "run-1", "scenario_id": "hidden-used"})
    monkeypatch.setattr(server, "db", database)

    result = asyncio.run(server.bassett_delete_archived_scenarios(
        True, {"id": "admin-1", "role": "admin", "name": "QA Admin"}
    ))

    assert result["found"] == 2
    assert result["deleted_count"] == 1
    assert result["retained_count"] == 1
    assert result["deleted"][0]["stable_id"] == "OLD-01"
    assert result["retained"][0]["stable_id"] == "OLD-02"
    assert {row["id"] for row in scenarios} == {"hidden-used", "active"}
    assert database.bassett_history.rows[0]["action"] == "deleted"
