import copy
import re

import pytest

from postgres_store import COLLECTIONS, PostgresDatabase


class MigrationConnection:
    def __init__(self, rows):
        self.tables = {collection: [] for collection in COLLECTIONS}
        for collection, records in rows.items():
            self.tables[collection] = [
                {"id": record["id"], "data": copy.deepcopy(record["data"])}
                for record in records
            ]
        self.executed = []

    async def fetch(self, query):
        collection = re.search(r'FROM "([^"]+)"', query).group(1)
        return self.tables[collection]

    async def execute(self, query, *args):
        self.executed.append((query, args))
        update = re.search(r'UPDATE "([^"]+)" SET', query)
        if update:
            collection = update.group(1)
            if '"municipality_id" = $1' in query:
                replacement, loser = args
                for row in self.tables[collection]:
                    if row["data"].get("municipality_id") == loser:
                        row["data"]["municipality_id"] = replacement
            elif "data = $1" in query:
                document, row_id = args[:2]
                for row in self.tables[collection]:
                    if row["id"] == row_id:
                        row["data"] = copy.deepcopy(document)
                        for field, value in zip(
                            re.findall(r'"([^"]+)" = \$\d+', query), args[2:]
                        ):
                            row["data"][field] = value
        elif query.startswith('INSERT INTO "activities"'):
            activity_id, document = args
            self.tables["activities"].append({"id": activity_id, "data": document})


def _records(connection, collection):
    return {row["id"]: row["data"] for row in connection.tables[collection]}


@pytest.mark.asyncio
async def test_migration_13_is_scoped_ranked_relationship_safe_and_idempotent():
    connection = MigrationConnection({
        "municipalities": [
            {"id": "z-rich", "data": {
                "id": "z-rich", "name": " City  of Milwaukee ", "state": "WISCONSIN",
                "notes": "canonical note", "ordinance_source": "source",
            }},
            {"id": "a-los", "data": {
                "id": "a-los", "name": "City of Milwaukee", "state": "Wisconsin",
                "notes": "loser note",
            }},
            {"id": "other-1", "data": {
                "id": "other-1", "name": "Springfield", "state": "Illinois",
            }},
            {"id": "other-2", "data": {
                "id": "other-2", "name": " Springfield ", "state": "ILLINOIS",
                "notes": "must not merge",
            }},
        ],
        "properties": [
            {"id": "property-1", "data": {
                "id": "property-1", "municipality_id": "a-los",
            }},
        ],
        "testcases": [
            {"id": "testcase-1", "data": {
                "id": "testcase-1", "municipality_id": "a-los",
            }},
        ],
        "bassett_issues": [
            {"id": "issue-1", "data": {
                "id": "issue-1", "municipality_id": "a-los",
                "notes": "a-los must change only at the known path",
            }},
        ],
        "attachments": [
            {"id": "attachment-1", "data": {
                "id": "attachment-1", "entity_type": "municipality",
                "entity_id": "a-los",
            }},
        ],
        "bassett_history": [
            {"id": "history-1", "data": {
                "id": "history-1", "entity_id": "a-los",
                "detail": "immutable history",
            }},
        ],
        "activities": [
            {"id": "activity-1", "data": {
                "id": "activity-1", "detail": "immutable existing audit",
                "entity_id": "a-los",
            }},
        ],
    })
    database = PostgresDatabase.__new__(PostgresDatabase)

    first = await database._consolidate_duplicate_municipalities(connection)

    assert first["groups"][0]["canonical_id"] == "z-rich"
    assert first["groups"][0]["duplicate_ids"] == ["a-los"]
    assert first["groups"][0]["metadata_conflicts"]["notes"] == [{
        "canonical": "canonical note", "duplicate": "loser note", "duplicate_id": "a-los",
    }]
    municipalities = _records(connection, "municipalities")
    assert municipalities["a-los"]["archived"] is True
    assert municipalities["a-los"]["municipality_merge_canonical_id"] == "z-rich"
    assert municipalities["other-1"].get("archived") is not True
    assert municipalities["other-2"].get("archived") is not True
    assert _records(connection, "properties")["property-1"]["municipality_id"] == "z-rich"
    assert _records(connection, "testcases")["testcase-1"]["municipality_id"] == "z-rich"
    assert _records(connection, "bassett_issues")["issue-1"]["municipality_id"] == "z-rich"
    assert _records(connection, "attachments")["attachment-1"]["entity_id"] == "z-rich"
    assert _records(connection, "bassett_history")["history-1"]["entity_id"] == "a-los"
    assert _records(connection, "activities")["activity-1"]["entity_id"] == "a-los"

    before_audit_count = len(connection.tables["activities"])
    second = await database._consolidate_duplicate_municipalities(connection)
    assert second == {"groups": [], "reassigned": 0}
    assert len(connection.tables["activities"]) == before_audit_count


@pytest.mark.asyncio
async def test_migration_13_uses_oldest_id_only_after_completeness_and_links_tie():
    connection = MigrationConnection({
        "municipalities": [
            {"id": "z-newer", "data": {
                "id": "z-newer", "name": "City of Milwaukee", "state": "Wisconsin",
                "notes": "same",
            }},
            {"id": "a-older", "data": {
                "id": "a-older", "name": "City of Milwaukee", "state": "Wisconsin",
                "notes": "same",
            }},
        ],
    })

    database = PostgresDatabase.__new__(PostgresDatabase)
    result = await database._consolidate_duplicate_municipalities(connection)

    assert result["groups"][0]["canonical_id"] == "a-older"