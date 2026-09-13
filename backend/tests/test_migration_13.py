import copy
import re

import pytest

from postgres_store import (
    COLLECTIONS,
    PostgresDatabase,
    _migration_replace_known_property_paths,
)


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


def test_property_migration_replaces_only_documented_reference_paths():
    document = {
        "property_id": "loser",
        "nested": {"value": "loser", "property_id": "loser"},
        "entity_type": "property",
        "entity_id": "loser",
        "linked_entity_type": "properties",
        "linked_entity_id": "loser",
    }
    updated = _migration_replace_known_property_paths("activities", document, "loser", "canonical")
    assert updated["property_id"] == "canonical"
    assert updated["entity_id"] == "canonical"
    assert updated["linked_entity_id"] == "canonical"
    assert updated["nested"] == {"value": "loser", "property_id": "loser"}


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


@pytest.mark.asyncio
async def test_migration_14_ignores_technical_identity_bookkeeping_and_preserves_history():
    canonical = "c90c0ba2-122f-4969-99ea-db71a2ead130"
    loser = "7225e02b-0bd6-4e0b-ad28-11b63b3c7380"
    connection = MigrationConnection({
        "properties": [
            {"id": canonical, "data": {
                "id": canonical, "name": "6442 N 76th St", "address": "6442 N 76th St",
                "municipality_id": "49abba9d-4647-4aad-b970-ec851417c779", "city": "Milwaukee", "state": "Wisconsin",
                "zip": "53223", "created_at": "2026-09-11T21:03:04Z",
                 "property_identity_enforced": True,
                 "property_duplicate_key": "production-backfill-key",
            }},
            {"id": loser, "data": {
                "id": loser, "name": "6442 N 76th St", "address": "6442 North 76th Street",
                "municipality_id": "49abba9d-4647-4aad-b970-ec851417c779", "city": "Milwaukee", "state": "Wisconsin",
                "zip": "53223", "created_at": "2026-09-11T21:46:06Z",
                 "property_identity_enforced": False,
                 "property_duplicate_key": "pre-migration-key",
            }},
        ],
        "bassett_issues": [{"id": "issue", "data": {"id": "issue", "property_id": loser}}],
        "attachments": [{"id": "attachment", "data": {
            "id": "attachment", "entity_type": "property", "entity_id": loser,
        }}],
        "bassett_history": [{"id": "history", "data": {"id": "history", "entity_id": loser}}],
        "activities": [{"id": "activity", "data": {"id": "activity", "entity_id": loser}}],
    })
    database = PostgresDatabase.__new__(PostgresDatabase)

    result = await database._consolidate_known_duplicate_properties(connection)

    assert result["canonical_id"] == canonical
    assert _records(connection, "properties")[loser]["archived"] is True
    assert _records(connection, "bassett_issues")["issue"]["property_id"] == canonical
    assert _records(connection, "attachments")["attachment"]["entity_id"] == canonical
    assert _records(connection, "bassett_history")["history"]["entity_id"] == canonical
    assert _records(connection, "activities")["activity"]["entity_id"] == canonical
    assert len(connection.tables["activities"]) == 2
    assert _records(connection, "properties")[canonical]["property_identity_enforced"] is True
    assert _records(connection, "properties")[canonical]["property_duplicate_key"] != "pre-migration-key"

    second = await database._consolidate_known_duplicate_properties(connection)
    assert second == {"merged": False, "reassigned": 0}


@pytest.mark.asyncio
async def test_migration_14_stops_before_changes_for_extra_live_identity_candidate():
    canonical = "c90c0ba2-122f-4969-99ea-db71a2ead130"
    loser = "7225e02b-0bd6-4e0b-ad28-11b63b3c7380"
    third = "third-live-property"
    properties = [
        {"id": canonical, "data": {
            "id": canonical, "address": "6442 N 76th St", "municipality_id": "49abba9d-4647-4aad-b970-ec851417c779",
            "city": "Milwaukee", "state": "Wisconsin", "zip": "53223",
            "created_at": "2026-09-11T21:03:04Z",
        }},
        {"id": loser, "data": {
            "id": loser, "address": "6442 North 76th Street", "municipality_id": "49abba9d-4647-4aad-b970-ec851417c779",
            "city": "Milwaukee", "state": "Wisconsin", "zip": "53223",
            "created_at": "2026-09-11T21:46:06Z",
        }},
        {"id": third, "data": {
            "id": third, "address": "6442 North 76th St.", "municipality_id": "49abba9d-4647-4aad-b970-ec851417c779",
            "city": "Milwaukee", "state": "Wisconsin", "zip": "53223",
            "created_at": "2026-09-11T22:00:00Z",
        }},
    ]
    connection = MigrationConnection({"properties": properties})
    database = PostgresDatabase.__new__(PostgresDatabase)

    with pytest.raises(RuntimeError, match="unexpected third duplicate"):
        await database._consolidate_known_duplicate_properties(connection)

    assert all(record["data"].get("archived") is not True for record in properties)


@pytest.mark.asyncio
async def test_migration_14_stops_on_material_pair_conflict():
    pair = [
        {"id": "c90c0ba2-122f-4969-99ea-db71a2ead130", "data": {
            "id": "c90c0ba2-122f-4969-99ea-db71a2ead130", "address": "6442 N 76th St",
            "municipality_id": "49abba9d-4647-4aad-b970-ec851417c779",
            "city": "Milwaukee", "state": "WI", "zip": "53223",
            "notes": "canonical material value", "created_at": "2026-01-01",
        }},
        {"id": "7225e02b-0bd6-4e0b-ad28-11b63b3c7380", "data": {
            "id": "7225e02b-0bd6-4e0b-ad28-11b63b3c7380", "address": "6442 North 76th Street",
            "municipality_id": "49abba9d-4647-4aad-b970-ec851417c779",
            "city": "Milwaukee", "state": "Wisconsin", "zip": "53223",
            "notes": "conflicting material value", "created_at": "2026-01-02",
        }},
    ]
    connection = MigrationConnection({"properties": pair})
    database = PostgresDatabase.__new__(PostgresDatabase)

    with pytest.raises(RuntimeError, match="conflicting material field notes"):
        await database._consolidate_known_duplicate_properties(connection)
    assert all(record["data"].get("archived") is not True for record in pair)