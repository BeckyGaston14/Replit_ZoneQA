"""Focused coverage for authenticated, scope-aware global search results."""

import asyncio
import re

import server


class Cursor:
    def __init__(self, rows):
        self.rows = rows

    def sort(self, *_args, **_kwargs):
        return self

    async def to_list(self, limit):
        return [dict(row) for row in self.rows[:limit]]


def _matches(row, condition):
    if not isinstance(condition, dict):
        return row == condition
    if "$regex" in condition:
        value = row
        if isinstance(value, list):
            return any(re.search(condition["$regex"], str(item), re.I) for item in value)
        return re.search(condition["$regex"], str(value or ""), re.I) is not None
    if "$in" in condition:
        return row in condition["$in"]
    if "$ne" in condition:
        return row != condition["$ne"]
    return all(_matches(row.get(key), value) for key, value in condition.items())


class Collection:
    def __init__(self, db, name):
        self.db, self.name = db, name

    def find(self, query=None, *_args, **_kwargs):
        query = query or {}

        def matches(row):
            if "$or" in query and not any(
                _matches(row.get(key), value) for clause in query["$or"] for key, value in clause.items()
            ):
                return False
            return all(
                key == "$or" or _matches(row.get(key), value)
                for key, value in query.items()
            )

        return Cursor([row for row in self.db.rows.get(self.name, []) if matches(row)])


class Db:
    def __init__(self, rows):
        self.rows = rows

    def __getattr__(self, name):
        return Collection(self, name)

    def __getitem__(self, name):
        return Collection(self, name)


def test_global_search_returns_property_and_linked_bassett_run_without_sample_crowding(monkeypatch):
    hidden_properties = [
        {
            "id": f"sample-property-{index}",
            "address": f"404 Southwestern Sample {index}",
            "sample_data": True,
        }
        for index in range(6)
    ]
    rows = {
        "properties": [
            *hidden_properties,
            {"id": "property-visible", "address": "404 Southwestern Avenue", "name": "Southwestern parcel"},
        ],
        "bassett_issues": [
            {"id": f"sample-run-{index}", "property_id": f"sample-property-{index}", "title": "Sample run", "sample_data": True}
            for index in range(6)
        ] + [
            {
                "id": "run-visible",
                "property_id": "property-visible",
                "title": "Setback review",
                "question_asked": "Check the current setback",
                "status": "In Review",
            },
        ],
    }
    for collection in (
        "municipalities", "projects", "versions", "testcases", "findings",
        "evidence", "regression_suites", "demos",
    ):
        rows.setdefault(collection, [])
    monkeypatch.setattr(server, "db", Db(rows))
    visibility_token = server._sample_visibility_context.set(False)
    scope_token = server._sample_scope_context.set({
        "projects": set(), "testcases": set(), "municipalities": set(),
        "properties": set(), "evidence": set(), "versions": set(),
        "version_names": set(),
    })
    try:
        result = asyncio.run(server.global_search("404 Southwestern", {"id": "viewer", "role": "viewer"}))
    finally:
        server._sample_visibility_context.reset(visibility_token)
        server._sample_scope_context.reset(scope_token)

    property_group = next(group for group in result["groups"] if group["label"] == "Properties")
    run_group = next(group for group in result["groups"] if group["label"] == "Bassett Test Runs")
    assert [item["id"] for item in property_group["items"]] == ["property-visible"]
    assert [item["id"] for item in run_group["items"]] == ["run-visible"]
    assert run_group["items"][0]["type"] == "Bassett Test Run"
    assert run_group["items"][0]["link"] == "/bassett/issues?open=run-visible"
    assert "404 Southwestern Avenue" in run_group["items"][0]["context"]