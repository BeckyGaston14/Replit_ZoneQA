"""Small async PostgreSQL document repository used by the existing API.

The API historically returned JSON documents from MongoDB.  This repository
keeps that public shape while storing each logical collection in its own
PostgreSQL table.  Stable relationships are represented by typed reference
columns and flexible values remain in JSONB.
"""

import copy
import json
import re
import uuid
from dataclasses import dataclass
from datetime import datetime
from typing import Any, Dict, Iterable, List, Optional, Tuple

import asyncpg


class BassettScenarioUnavailableError(Exception):
    """The selected scenario is missing or archived at canonical run creation."""


class BassettScenarioInvalidError(Exception):
    """The selected scenario cannot produce a complete immutable snapshot."""


COLLECTIONS = (
    "users", "projects", "municipalities", "properties", "testcases",
    "responses", "goldstandards", "evidence", "evaluations", "findings",
    "retests", "regression_suites", "regression_runs", "demos", "models",
    "versions", "comments", "annotations", "claims", "calendar_events",
    "test_runs", "activities", "config", "attachments", "release_decisions",
    "saved_views", "bassett_issues", "bassett_scenarios", "bassett_executions",
    "bassett_history", "bassett_workflow_stages",
)

# These are intentionally fixed identifiers, never derived from request data.
REFERENCE_COLUMNS = {
    "properties": {"municipality_id": "municipalities"},
    "testcases": {
        "project_id": "projects", "municipality_id": "municipalities",
        "property_id": "properties", "variant_of": "testcases",
    },
    "responses": {"testcase_id": "testcases"},
    "goldstandards": {"testcase_id": "testcases"},
    "evidence": {"municipality_id": "municipalities"},
    "evaluations": {"testcase_id": "testcases"},
    "findings": {"project_id": "projects", "testcase_id": "testcases"},
    "retests": {"testcase_id": "testcases"},
    "regression_runs": {"suite_id": "regression_suites"},
    "demos": {"testcase_id": "testcases"},
    "annotations": {"testcase_id": "testcases"},
    "claims": {"testcase_id": "testcases"},
    "calendar_events": {
        "owner_id": "users", "created_by_id": "users",
    },
    "test_runs": {"testcase_id": "testcases"},
    "attachments": {"uploaded_by_id": "users"},
    # Bassett relationships are intentionally application-validated.  These
    # records are archiveable and must not make the existing parent records
    # undeletable or require a destructive migration.
}

REFERENCE_COLUMN_NAMES = {
    collection: tuple(refs.keys()) for collection, refs in REFERENCE_COLUMNS.items()
}


def _table(collection: str) -> str:
    if collection not in COLLECTIONS:
        raise ValueError(f"Unknown collection: {collection}")
    return collection


def _json_default(value: Any) -> str:
    return str(value)


def _missing() -> object:
    return _MISSING


_MISSING = object()


def _get_field(document: Dict[str, Any], field: str) -> Any:
    value: Any = document
    for part in field.split("."):
        if not isinstance(value, dict) or part not in value:
            return _missing()
        value = value[part]
    return value


def _equal(actual: Any, expected: Any) -> bool:
    if actual is _MISSING:
        return expected is None
    if isinstance(actual, list) and not isinstance(expected, list):
        return expected in actual
    return actual == expected


def _compare(actual: Any, expected: Any, operator: str) -> bool:
    if actual is _MISSING:
        return False
    try:
        if operator == "$lt":
            return actual < expected
        if operator == "$lte":
            return actual <= expected
        if operator == "$gt":
            return actual > expected
        if operator == "$gte":
            return actual >= expected
    except TypeError:
        return False
    return False


def _condition_matches(actual: Any, condition: Any, regex_options: str = "") -> bool:
    if not isinstance(condition, dict) or not any(
        str(k).startswith("$") for k in condition
    ):
        return _equal(actual, condition)

    for operator, expected in condition.items():
        if operator == "$options":
            continue
        if operator == "$exists":
            if (actual is not _MISSING) != bool(expected):
                return False
        elif operator == "$ne":
            if _equal(actual, expected):
                return False
        elif operator == "$in":
            if not any(_equal(actual, item) for item in expected):
                return False
        elif operator == "$nin":
            if any(_equal(actual, item) for item in expected):
                return False
        elif operator in {"$lt", "$lte", "$gt", "$gte"}:
            if not _compare(actual, expected, operator):
                return False
        elif operator == "$regex":
            if actual is _MISSING:
                return False
            flags = re.I if "i" in regex_options else 0
            if re.search(str(expected), str(actual), flags) is None:
                return False
        elif operator == "$elemMatch":
            if not isinstance(actual, list) or not any(
                _matches(item, expected) if isinstance(item, dict)
                else _condition_matches(item, expected)
                for item in actual
            ):
                return False
        else:
            raise ValueError(f"Unsupported PostgreSQL repository operator: {operator}")
    return True


def _matches(document: Any, query: Dict[str, Any]) -> bool:
    if not isinstance(document, dict):
        return False
    for field, condition in query.items():
        if field == "$or":
            if not any(_matches(document, child) for child in condition):
                return False
            continue
        if field == "$and":
            if not all(_matches(document, child) for child in condition):
                return False
            continue
        if field == "$nor":
            if any(_matches(document, child) for child in condition):
                return False
            continue
        actual = _get_field(document, field)
        options = ""
        if isinstance(condition, dict):
            options = str(condition.get("$options", ""))
        if not _condition_matches(actual, condition, options):
            return False
    return True


def _project(document: Dict[str, Any], projection: Optional[Dict[str, int]]) -> Dict[str, Any]:
    if not projection:
        return copy.deepcopy(document)
    include = {
        key for key, enabled in projection.items()
        if enabled and key != "_id"
    }
    exclude = {
        key for key, enabled in projection.items()
        if not enabled and key != "_id"
    }
    if include:
        result = {key: copy.deepcopy(document[key]) for key in include if key in document}
        if "id" in document and ("id" in include or "_id" not in projection):
            result.setdefault("id", copy.deepcopy(document["id"]))
    else:
        result = copy.deepcopy(document)
        for key in exclude:
            result.pop(key, None)
    return result


def _set_field(document: Dict[str, Any], field: str, value: Any) -> None:
    parts = field.split(".")
    target = document
    for part in parts[:-1]:
        target = target.setdefault(part, {})
    target[parts[-1]] = copy.deepcopy(value)


def _unset_field(document: Dict[str, Any], field: str) -> None:
    parts = field.split(".")
    target: Any = document
    for part in parts[:-1]:
        if not isinstance(target, dict):
            return
        target = target.get(part)
    if isinstance(target, dict):
        target.pop(parts[-1], None)


def _apply_update(document: Dict[str, Any], update: Dict[str, Any]) -> Dict[str, Any]:
    result = copy.deepcopy(document)
    if not any(str(key).startswith("$") for key in update):
        return copy.deepcopy(update)
    for field, value in update.get("$set", {}).items():
        _set_field(result, field, value)
    for field in update.get("$unset", {}):
        _unset_field(result, field)
    for field, value in update.get("$push", {}).items():
        values = value.get("$each", []) if isinstance(value, dict) and "$each" in value else [value]
        result.setdefault(field, [])
        result[field].extend(copy.deepcopy(values))
    for field, value in update.get("$addToSet", {}).items():
        values = value.get("$each", []) if isinstance(value, dict) and "$each" in value else [value]
        result.setdefault(field, [])
        for item in values:
            if item not in result[field]:
                result[field].append(copy.deepcopy(item))
    for field, condition in update.get("$pull", {}).items():
        values = result.get(field, [])
        if isinstance(values, list):
            result[field] = [
                item for item in values
                if not _condition_matches(item, condition)
            ]
    return result


@dataclass
class _WriteResult:
    inserted_id: Optional[str] = None
    modified_count: int = 0
    matched_count: int = 0
    deleted_count: int = 0


class PostgresCursor:
    def __init__(
        self,
        collection: "PostgresCollection",
        query: Dict[str, Any],
        projection: Optional[Dict[str, int]],
    ):
        self._collection = collection
        self._query = query
        self._projection = projection
        self._documents: Optional[List[Dict[str, Any]]] = None
        self._sort_fields: List[Tuple[str, int]] = []

    async def _load(self):
        if self._documents is None:
            self._documents = self._collection._filter(
                await self._collection._all(), self._query, self._projection
            )
            for field, order in reversed(self._sort_fields):
                self._documents.sort(
                    key=lambda doc: (
                        _get_field(doc, field) is _MISSING,
                        _get_field(doc, field),
                    ),
                    reverse=order < 0,
                )

    def sort(self, key: Any, direction: int = 1):
        fields = key if isinstance(key, list) else [(key, direction)]
        self._sort_fields.extend(fields)
        return self

    async def to_list(self, length: int) -> List[Dict[str, Any]]:
        await self._load()
        return self._documents[:length]

    def __aiter__(self):
        self._iterator = None
        return self

    async def __anext__(self):
        await self._load()
        if self._iterator is None:
            self._iterator = iter(self._documents)
        try:
            return next(self._iterator)
        except StopIteration:
            raise StopAsyncIteration


class PostgresCollection:
    def __init__(self, database: "PostgresDatabase", collection: str):
        self.database = database
        self.collection = collection

    async def _all(self) -> List[Dict[str, Any]]:
        pool = self.database.pool
        if pool is None:
            raise RuntimeError("PostgreSQL database has not been connected")
        rows = await pool.fetch(
            f'SELECT id, data FROM "{_table(self.collection)}"'
        )
        documents = []
        for row in rows:
            document = dict(row["data"])
            document.setdefault("id", row["id"])
            documents.append(document)
        return documents

    def _filter(self, documents, query, projection=None):
        return [_project(document, projection) for document in documents if _matches(document, query)]

    async def find_one(self, query=None, projection=None, **kwargs):
        matches = self._filter(await self._all(), query or {}, projection)
        return matches[0] if matches else None

    def find(self, query=None, projection=None, **kwargs):
        # The existing API applies filtering, projection, sort, and limits on
        # this cursor.  Values are always bound separately in SQL; filtering
        # keeps legacy document-query semantics without SQL interpolation.
        return PostgresCursor(self, query or {}, projection)

    async def insert_one(self, document: Dict[str, Any]):
        await self.database._insert(self.collection, document)
        return _WriteResult(inserted_id=document.get("id"))

    async def insert_many(self, documents: Iterable[Dict[str, Any]]):
        inserted = list(documents)
        async with self.database.pool.acquire() as connection:
            async with connection.transaction():
                for document in inserted:
                    await self.database._insert(self.collection, document, connection)
        return _WriteResult(inserted_id=inserted[0].get("id") if inserted else None)

    async def update_one(self, query, update, upsert=False):
        documents = await self._all()
        matched = next((doc for doc in documents if _matches(doc, query)), None)
        if matched is None:
            if upsert:
                base = {key: value for key, value in query.items() if not key.startswith("$") and not isinstance(value, dict)}
                replacement = _apply_update(base, update)
                replacement.setdefault("id", str(uuid.uuid4()))
                await self.database._insert(self.collection, replacement)
                return _WriteResult(matched_count=0, modified_count=0)
            return _WriteResult()
        await self.database._replace(self.collection, _apply_update(matched, update))
        return _WriteResult(matched_count=1, modified_count=1)

    async def update_many(self, query, update):
        documents = await self._all()
        matches = [doc for doc in documents if _matches(doc, query)]
        async with self.database.pool.acquire() as connection:
            async with connection.transaction():
                for document in matches:
                    await self.database._replace(self.collection, _apply_update(document, update), connection)
        return _WriteResult(matched_count=len(matches), modified_count=len(matches))

    async def find_one_and_update(self, query, update, projection=None, **kwargs):
        identifier = query.get("id")
        if isinstance(identifier, str):
            if self.database.pool is None:
                raise RuntimeError("PostgreSQL database has not been connected")
            async with self.database.pool.acquire() as connection:
                async with connection.transaction():
                    row = await connection.fetchrow(
                        f'SELECT id, data FROM "{_table(self.collection)}" '
                        "WHERE id = $1 FOR UPDATE",
                        identifier,
                    )
                    if row is None:
                        return None
                    document = dict(row["data"])
                    document.setdefault("id", row["id"])
                    if not _matches(document, query):
                        return None
                    updated = _apply_update(document, update)
                    await self.database._replace(self.collection, updated, connection)
                    return _project(updated, projection)
        document = await self.find_one(query)
        if document is None:
            return None
        updated = _apply_update(document, update)
        await self.database._replace(self.collection, updated)
        return _project(updated, projection)

    async def activate_version(self, query, update, projection=None):
        if self.collection != "versions":
            raise ValueError("Atomic activation is only available for versions")
        if self.database.pool is None:
            raise RuntimeError("PostgreSQL database has not been connected")
        async with self.database.pool.acquire() as connection:
            async with connection.transaction():
                rows = await connection.fetch(
                    'SELECT id, data FROM "versions" ORDER BY id FOR UPDATE'
                )
                documents = []
                for row in rows:
                    document = copy.deepcopy(dict(row["data"]))
                    document.setdefault("id", row["id"])
                    documents.append(document)
                target = next((document for document in documents if _matches(document, query)), None)
                if target is None:
                    return None
                updated = _apply_update(target, update)
                for document in documents:
                    if document["id"] != target["id"] and document.get("active"):
                        document["active"] = False
                        await self.database._replace("versions", document, connection)
                await self.database._replace("versions", updated, connection)
                return _project(updated, projection)

    async def insert_active_version(self, document):
        if self.collection != "versions":
            raise ValueError("Atomic activation is only available for versions")
        if self.database.pool is None:
            raise RuntimeError("PostgreSQL database has not been connected")
        async with self.database.pool.acquire() as connection:
            async with connection.transaction():
                rows = await connection.fetch(
                    'SELECT id, data FROM "versions" ORDER BY id FOR UPDATE'
                )
                for row in rows:
                    existing = copy.deepcopy(dict(row["data"]))
                    existing.setdefault("id", row["id"])
                    if existing.get("active"):
                        existing["active"] = False
                        await self.database._replace("versions", existing, connection)
                await self.database._insert("versions", document, connection)
        return _WriteResult(inserted_id=document.get("id"))

    async def delete_one(self, query):
        documents = await self._all()
        document = next((doc for doc in documents if _matches(doc, query)), None)
        if document is None:
            return _WriteResult()
        await self.database._delete(self.collection, document["id"])
        return _WriteResult(deleted_count=1)

    async def delete_many(self, query):
        documents = [doc for doc in await self._all() if _matches(doc, query)]
        async with self.database.pool.acquire() as connection:
            async with connection.transaction():
                for document in documents:
                    await self.database._delete(self.collection, document["id"], connection)
        return _WriteResult(deleted_count=len(documents))

    async def count_documents(self, query):
        return sum(1 for document in await self._all() if _matches(document, query or {}))

    async def create_index(self, field, unique=False, **kwargs):
        if self.collection == "users" and field == "email" and unique:
            await self.database.pool.execute(
                'CREATE UNIQUE INDEX IF NOT EXISTS users_email_unique '
                'ON "users" ((lower(data->>\'email\'))) '
                'WHERE data->>\'deleted_at\' IS NULL'
            )
        elif self.collection == "versions" and field == "active" and unique:
            await self.database.pool.execute(
                'CREATE UNIQUE INDEX IF NOT EXISTS versions_active_unique '
                'ON "versions" ((data->>\'active\')) WHERE data->>\'active\' = \'true\''
            )
        return field


class PostgresDatabase:
    def __init__(self, database_url: str):
        self.database_url = database_url
        self.pool: Optional[asyncpg.Pool] = None

    def __getattr__(self, collection: str) -> PostgresCollection:
        if collection in COLLECTIONS:
            return PostgresCollection(self, collection)
        raise AttributeError(collection)

    def __getitem__(self, collection: str) -> PostgresCollection:
        return PostgresCollection(self, collection)

    async def connect(self, connect_timeout: Optional[float] = None):
        if self.pool is not None:
            return
        async def configure_connection(connection):
            await connection.set_type_codec(
                "jsonb", encoder=json.dumps, decoder=json.loads, schema="pg_catalog"
            )

        connect_options = {"timeout": connect_timeout} if connect_timeout is not None else {}
        self.pool = await asyncpg.create_pool(
            self.database_url,
            min_size=1,
            max_size=5,
            init=configure_connection,
            **connect_options,
        )
        await self.apply_migrations()

    async def close(self):
        if self.pool is not None:
            await self.pool.close()
            self.pool = None

    async def apply_migrations(self):
        if self.pool is None:
            raise RuntimeError("PostgreSQL database has not been connected")
        async with self.pool.acquire() as connection:
            await connection.execute(
                "CREATE TABLE IF NOT EXISTS schema_migrations "
                "(version integer PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())"
            )
            # Only one application instance may inspect/apply migrations at a time.
            # The session lock is automatically released if this connection fails.
            await connection.execute(
                "SELECT pg_advisory_lock(hashtext($1))", "zoneqa:schema-migrations"
            )
            try:
                current = await connection.fetchval("SELECT COALESCE(MAX(version), 0) FROM schema_migrations")
                if current < 1:
                    async with connection.transaction():
                        for collection in COLLECTIONS:
                            columns = ["id text PRIMARY KEY", "data jsonb NOT NULL"]
                            if collection == "users":
                                columns.append("email text")
                            for field in REFERENCE_COLUMN_NAMES.get(collection, ()):
                                columns.append(f'"{field}" text')
                            await connection.execute(
                                f'CREATE TABLE IF NOT EXISTS "{collection}" ({", ".join(columns)})'
                            )
                        for collection, refs in REFERENCE_COLUMNS.items():
                            for field, target in refs.items():
                                constraint = f"{collection}_{field}_fk"
                                await connection.execute(
                                    f'ALTER TABLE "{collection}" '
                                    f'ADD CONSTRAINT "{constraint}" FOREIGN KEY ("{field}") '
                                    f'REFERENCES "{target}" (id) ON DELETE RESTRICT'
                                )
                        await connection.execute(
                            "CREATE UNIQUE INDEX IF NOT EXISTS users_email_unique "
                            'ON "users" ((lower(data->>\'email\'))) '
                            'WHERE data->>\'deleted_at\' IS NULL'
                        )
                        await connection.execute(
                            "CREATE UNIQUE INDEX IF NOT EXISTS versions_active_unique "
                            'ON "versions" ((data->>\'active\')) WHERE data->>\'active\' = \'true\''
                        )
                        await connection.execute(
                            "INSERT INTO schema_migrations (version) VALUES (1)"
                        )
                        current = 1
                if current < 2:
                    async with connection.transaction():
                        # Integrity-repair routes deliberately support legacy
                        # orphan records so operators can discover and repair them.
                        # Keep FK enforcement for normal stable references while
                        # allowing these two documented repair workflows.
                        await connection.execute(
                            'ALTER TABLE "testcases" DROP CONSTRAINT IF EXISTS "testcases_municipality_id_fk"'
                        )
                        await connection.execute(
                            'ALTER TABLE "evaluations" DROP CONSTRAINT IF EXISTS "evaluations_testcase_id_fk"'
                        )
                        await connection.execute(
                            'CREATE TABLE IF NOT EXISTS "saved_views" (id text PRIMARY KEY, data jsonb NOT NULL)'
                        )
                        await connection.execute(
                            "INSERT INTO schema_migrations (version) VALUES (2)"
                        )
                        current = 2
                if current < 3:
                    async with connection.transaction():
                        await connection.execute(
                            'ALTER TABLE "testcases" ADD CONSTRAINT "testcases_municipality_id_fk" '
                            'FOREIGN KEY ("municipality_id") REFERENCES "municipalities" (id) ON DELETE RESTRICT'
                        )
                        await connection.execute(
                            'ALTER TABLE "evaluations" ADD CONSTRAINT "evaluations_testcase_id_fk" '
                            'FOREIGN KEY ("testcase_id") REFERENCES "testcases" (id) ON DELETE RESTRICT'
                        )
                        await connection.execute(
                            "INSERT INTO schema_migrations (version) VALUES (3)"
                        )
                        current = 3
                if current < 4:
                    async with connection.transaction():
                        # These indexes support stable Test Bank IDs and
                        # idempotent administrator imports without changing any
                        # existing collection or relationship semantics.
                        for collection in (
                            "bassett_issues", "bassett_scenarios",
                            "bassett_executions", "bassett_history",
                        ):
                            await connection.execute(
                                f'CREATE TABLE IF NOT EXISTS "{collection}" '
                                "(id text PRIMARY KEY, data jsonb NOT NULL)"
                            )
                        await connection.execute(
                            'CREATE UNIQUE INDEX IF NOT EXISTS bassett_scenarios_stable_id_unique '
                            'ON "bassett_scenarios" ((data->>\'stable_id\')) '
                            'WHERE COALESCE(data->>\'archived\', \'false\') <> \'true\''
                        )
                        await connection.execute(
                            'CREATE INDEX IF NOT EXISTS bassett_issues_scenario_idx '
                            'ON "bassett_issues" ((data->>\'scenario_id\'))'
                        )
                        await connection.execute(
                            'CREATE INDEX IF NOT EXISTS bassett_executions_scenario_idx '
                            'ON "bassett_executions" ((data->>\'scenario_id\'))'
                        )
                        await connection.execute(
                            'CREATE INDEX IF NOT EXISTS bassett_history_entity_idx '
                            'ON "bassett_history" ((data->>\'entity_id\'), (data->>\'created_at\'))'
                        )
                        await connection.execute(
                            "INSERT INTO schema_migrations (version) VALUES (4)"
                        )
                        current = 4
                if current < 5:
                    async with connection.transaction():
                        duplicate_stable_ids = await connection.fetchval(
                            'SELECT EXISTS (SELECT 1 FROM "bassett_scenarios" '
                            "WHERE data->>'stable_id' IS NOT NULL GROUP BY data->>'stable_id' HAVING COUNT(*) > 1)"
                        )
                        duplicate_expansions = await connection.fetchval(
                            'SELECT EXISTS (SELECT 1 FROM "testcases" '
                            "WHERE data->>'bassett_issue_id' IS NOT NULL "
                            "GROUP BY data->>'bassett_issue_id' HAVING COUNT(*) > 1)"
                        )
                        if duplicate_stable_ids or duplicate_expansions:
                            raise RuntimeError(
                                "Migration 5 blocked: duplicate Bassett stable IDs or issue expansions "
                                "must be reviewed without deleting historical records"
                            )
                        # Stable IDs are public identifiers: an archived record still
                        # reserves its identifier forever.
                        await connection.execute(
                            'DROP INDEX IF EXISTS bassett_scenarios_stable_id_unique'
                        )
                        await connection.execute(
                            'CREATE UNIQUE INDEX IF NOT EXISTS bassett_scenarios_stable_id_unique '
                            'ON "bassett_scenarios" ((data->>\'stable_id\')) '
                            'WHERE data->>\'stable_id\' IS NOT NULL'
                        )
                        await connection.execute(
                            'CREATE TABLE IF NOT EXISTS "bassett_workflow_stages" '
                            '(id text PRIMARY KEY, data jsonb NOT NULL)'
                        )
                        await connection.execute(
                            'CREATE UNIQUE INDEX IF NOT EXISTS bassett_workflow_stages_code_unique '
                            'ON "bassett_workflow_stages" ((data->>\'code\'))'
                        )
                        await connection.execute(
                            'CREATE TABLE IF NOT EXISTS "bassett_stage_sequences" '
                            '(stage_code text PRIMARY KEY, last_value bigint NOT NULL)'
                        )
                        # Exactly one expanded test case may be created per issue.
                        await connection.execute(
                            'CREATE UNIQUE INDEX IF NOT EXISTS testcases_bassett_issue_unique '
                            'ON "testcases" ((data->>\'bassett_issue_id\')) '
                            'WHERE data->>\'bassett_issue_id\' IS NOT NULL'
                        )
                        await connection.execute(
                            "INSERT INTO schema_migrations (version) VALUES (5)"
                        )
                        current = 5
                if current < 6:
                    async with connection.transaction():
                        duplicate_stage_names = await connection.fetchval(
                            'SELECT EXISTS (SELECT 1 FROM "bassett_workflow_stages" '
                            "GROUP BY lower(data->>'name') HAVING COUNT(*) > 1)"
                        )
                        if duplicate_stage_names:
                            raise RuntimeError(
                                "Migration 6 blocked: duplicate Bassett workflow-stage names "
                                "must be reviewed before enforcing unique stage identity"
                            )
                        await connection.execute(
                            'CREATE UNIQUE INDEX IF NOT EXISTS bassett_workflow_stages_name_unique '
                            'ON "bassett_workflow_stages" ((lower(data->>\'name\')))'
                        )
                        await connection.execute(
                            "INSERT INTO schema_migrations (version) VALUES (6)"
                        )
                        current = 6
                if current < 7:
                    async with connection.transaction():
                        # JSON-only references need the same parent-lock invariant as
                        # typed foreign keys so permanent deletion cannot race an insert.
                        await connection.execute("""
                            CREATE OR REPLACE FUNCTION guard_testcase_json_reference()
                            RETURNS trigger LANGUAGE plpgsql AS $$
                            DECLARE ref text;
                            BEGIN
                              ref := NEW.data->>'testcase_id';
                              IF TG_TABLE_NAME IN ('comments', 'attachments', 'activities')
                                 AND NEW.data->>'entity_type' IN ('testcase', 'testcases') THEN
                                ref := NEW.data->>'entity_id';
                              END IF;
                              IF ref IS NOT NULL AND NOT EXISTS (
                                SELECT 1 FROM testcases WHERE id = ref FOR KEY SHARE
                              ) THEN
                                RAISE foreign_key_violation USING MESSAGE =
                                  'referenced test case does not exist';
                              END IF;
                              IF TG_TABLE_NAME = 'regression_runs' AND EXISTS (
                                SELECT 1 FROM jsonb_array_elements_text(
                                  COALESCE(NEW.data->'testcase_ids', '[]'::jsonb)
                                ) AS item(value) WHERE NOT EXISTS (
                                  SELECT 1 FROM testcases WHERE id = item.value FOR KEY SHARE
                                )
                              ) THEN
                                RAISE foreign_key_violation USING MESSAGE =
                                  'regression run references a missing test case';
                              END IF;
                              RETURN NEW;
                            END $$;
                        """)
                        for collection in (
                            "annotations", "claims", "goldstandards", "retests",
                            "test_runs", "findings", "demos", "calendar_events",
                            "bassett_issues", "bassett_scenarios", "bassett_executions",
                            "comments", "attachments", "regression_runs",
                        ):
                            await connection.execute(
                                f'DROP TRIGGER IF EXISTS guard_testcase_json_reference ON "{collection}"'
                            )
                            await connection.execute(
                                f'CREATE TRIGGER guard_testcase_json_reference '
                                f'BEFORE INSERT OR UPDATE ON "{collection}" FOR EACH ROW '
                                f'EXECUTE FUNCTION guard_testcase_json_reference()'
                            )
                        await connection.execute(
                            "INSERT INTO schema_migrations (version) VALUES (7)"
                        )
                        current = 7
                if current < 8:
                    async with connection.transaction():
                        # Repair the regression-array scalar alias in the migration-7
                        # trigger for databases where version 7 already ran.
                        await connection.execute("""
                            CREATE OR REPLACE FUNCTION guard_testcase_json_reference()
                            RETURNS trigger LANGUAGE plpgsql AS $$
                            DECLARE ref text;
                            BEGIN
                              ref := NEW.data->>'testcase_id';
                              IF TG_TABLE_NAME IN ('comments', 'attachments', 'activities')
                                 AND NEW.data->>'entity_type' IN ('testcase', 'testcases') THEN
                                ref := NEW.data->>'entity_id';
                              END IF;
                              IF ref IS NOT NULL AND NOT EXISTS (
                                SELECT 1 FROM testcases WHERE id = ref FOR KEY SHARE
                              ) THEN
                                RAISE foreign_key_violation USING MESSAGE =
                                  'referenced test case does not exist';
                              END IF;
                              IF TG_TABLE_NAME = 'regression_runs' AND EXISTS (
                                SELECT 1 FROM jsonb_array_elements_text(
                                  COALESCE(NEW.data->'testcase_ids', '[]'::jsonb)
                                ) AS item(value) WHERE NOT EXISTS (
                                  SELECT 1 FROM testcases WHERE id = item.value FOR KEY SHARE
                                )
                              ) THEN
                                RAISE foreign_key_violation USING MESSAGE =
                                  'regression run references a missing test case';
                              END IF;
                              RETURN NEW;
                            END $$;
                        """)
                        await connection.execute(
                            "INSERT INTO schema_migrations (version) VALUES (8)"
                        )
                        current = 8
                if current < 9:
                    async with connection.transaction():
                        # Activities include aggregate/system events such as the
                        # testcase CSV-import entity "bulk", so they are not a
                        # strict foreign-reference table.
                        await connection.execute(
                            'DROP TRIGGER IF EXISTS guard_testcase_json_reference ON "activities"'
                        )
                        await connection.execute(
                            "INSERT INTO schema_migrations (version) VALUES (9)"
                        )
                        current = 9
                if current < 10:
                    async with connection.transaction():
                        await connection.execute(
                            'CREATE UNIQUE INDEX IF NOT EXISTS bassett_issues_creation_key_unique '
                            'ON "bassett_issues" ((data->>\'creation_key\')) '
                            'WHERE data->>\'creation_key\' IS NOT NULL'
                        )
                        await connection.execute(
                            "INSERT INTO schema_migrations (version) VALUES (10)"
                        )
                        current = 10
            finally:
                # This is a session lock (rather than an xact lock), so it must
                # be released even when a migration deliberately aborts.
                await connection.execute(
                    "SELECT pg_advisory_unlock(hashtext($1))", "zoneqa:schema-migrations"
                )

    async def _insert(self, collection, document, connection=None):
        if self.pool is None:
            raise RuntimeError("PostgreSQL database has not been connected")
        connection = connection or self.pool
        document = copy.deepcopy(document)
        identifier = str(document["id"])
        refs = REFERENCE_COLUMNS.get(collection, {})
        fields = ["id", "data"]
        values = [identifier, document]
        for field in refs:
            fields.append(field)
            value = document.get(field)
            values.append(None if value == "" else value)
        if collection == "users":
            fields.append("email")
            values.append(str(document.get("email", "")).lower())
        placeholders = ", ".join(f"${index}" for index in range(1, len(values) + 1))
        quoted_fields = ", ".join(f'"{field}"' for field in fields)
        await connection.execute(
            f'INSERT INTO "{collection}" ({quoted_fields}) VALUES ({placeholders})',
            *values,
        )

    async def _replace(self, collection, document, connection=None):
        if self.pool is None:
            raise RuntimeError("PostgreSQL database has not been connected")
        connection = connection or self.pool
        document = copy.deepcopy(document)
        identifier = str(document["id"])
        refs = REFERENCE_COLUMNS.get(collection, {})
        assignments = ['data = $1']
        values = [document, identifier]
        parameter_index = 2
        for field in refs:
            parameter_index += 1
            assignments.append(f'"{field}" = ${parameter_index}')
            value = document.get(field)
            values.append(None if value == "" else value)
        if collection == "users":
            parameter_index += 1
            assignments.append(f'email = ${parameter_index}')
            values.append(str(document.get("email", "")).lower())
        await connection.execute(
            f'UPDATE "{collection}" SET {", ".join(assignments)} WHERE id = $2',
            *values,
        )

    async def _delete(self, collection, identifier, connection=None):
        if self.pool is None:
            raise RuntimeError("PostgreSQL database has not been connected")
        connection = connection or self.pool
        await connection.execute(
            f'DELETE FROM "{collection}" WHERE id = $1', str(identifier)
        )

    async def atomic_upsert_documents(
        self, collection: str, documents: Iterable[Tuple[bool, Dict[str, Any]]]
    ) -> None:
        """Insert/replace a validated batch in one transaction."""
        if collection not in {
            "bassett_issues", "bassett_scenarios", "bassett_executions",
        }:
            raise ValueError("Atomic imports are limited to Bassett workspace records")
        if self.pool is None:
            raise RuntimeError("PostgreSQL database has not been connected")
        async with self.pool.acquire() as connection:
            async with connection.transaction():
                for exists, document in documents:
                    if exists:
                        await self._replace(collection, document, connection)
                    else:
                        await self._insert(collection, document, connection)

    async def create_bassett_scenario(self, document: Dict[str, Any], stage_code: str) -> Dict[str, Any]:
        """Atomically allocate a permanently increasing public stage sequence."""
        if self.pool is None:
            raise RuntimeError("PostgreSQL database has not been connected")
        async with self.pool.acquire() as connection:
            async with connection.transaction():
                existing_max = await connection.fetchval(
                    'SELECT COALESCE(MAX(NULLIF(regexp_replace(data->>\'stable_id\', '
                    '$1 || \'-\', \'\'), \'\')::bigint), 0) FROM "bassett_scenarios" '
                    "WHERE data->>'stable_id' ~ ($1 || '-[0-9]+$')",
                    stage_code,
                )
                number = await connection.fetchval(
                    'INSERT INTO "bassett_stage_sequences" (stage_code, last_value) '
                    'VALUES ($1, $2 + 1) '
                    'ON CONFLICT (stage_code) DO UPDATE SET last_value = '
                    'GREATEST("bassett_stage_sequences".last_value, $2) + 1 '
                    'RETURNING last_value',
                    stage_code, int(existing_max),
                )
                result = copy.deepcopy(document)
                result["stable_id"] = f"{stage_code}-{int(number):02d}"
                await self._insert("bassett_scenarios", result, connection)
                return result

    async def _next_bassett_test_id(self, connection) -> str:
        """Allocate the human-readable sequence shown on Bassett test runs."""
        existing_max = await connection.fetchval(
            'SELECT COALESCE(MAX(NULLIF(regexp_replace(data->>\'test_id\', '
            '$1 || \'-\', \'\')::bigint, 0)), 0) FROM "bassett_issues" '
            "WHERE data->>'test_id' ~ ($1 || '-[0-9]+$')",
            "T",
        )
        number = await connection.fetchval(
            'INSERT INTO "bassett_stage_sequences" (stage_code, last_value) '
            'VALUES ($1, $2 + 1) '
            'ON CONFLICT (stage_code) DO UPDATE SET last_value = '
            'GREATEST("bassett_stage_sequences".last_value, $2) + 1 '
            'RETURNING last_value',
            "T", int(existing_max),
        )
        return f"T-{int(number):02d}"

    async def _next_testcase_id(self, connection) -> str:
        existing_max = await connection.fetchval(
            'SELECT COALESCE(MAX(NULLIF(regexp_replace(data->>\'test_id\', '
            '$1 || \'-\', \'\')::bigint, 0)), 0) FROM "testcases" '
            "WHERE data->>'test_id' ~ ($1 || '-[0-9]+$')",
            "TC",
        )
        number = await connection.fetchval(
            'INSERT INTO "bassett_stage_sequences" (stage_code, last_value) '
            'VALUES ($1, $2 + 1) '
            'ON CONFLICT (stage_code) DO UPDATE SET last_value = '
            'GREATEST("bassett_stage_sequences".last_value, $2) + 1 '
            'RETURNING last_value',
            "TC", int(existing_max),
        )
        return f"TC-{int(number):02d}"

    async def create_bassett_issue(
        self, document: Dict[str, Any], creation_key: Optional[str],
        snapshot_fields: Iterable[str],
    ) -> Tuple[Dict[str, Any], bool]:
        """Atomically validate, snapshot, and create one canonical Bassett run."""
        if self.pool is None:
            raise RuntimeError("PostgreSQL database has not been connected")
        async with self.pool.acquire() as connection:
            async with connection.transaction():
                if creation_key:
                    await connection.execute(
                        "SELECT pg_advisory_xact_lock(hashtext($1))",
                        f"zoneqa:bassett-run:{creation_key}",
                    )
                    existing = await connection.fetchrow(
                        'SELECT data FROM "bassett_issues" WHERE data->>\'creation_key\'=$1',
                        creation_key,
                    )
                    if existing:
                        return dict(existing["data"]), False
                scenario_row = await connection.fetchrow(
                    'SELECT data FROM "bassett_scenarios" WHERE id=$1 FOR SHARE',
                    str(document.get("scenario_id") or ""),
                )
                if not scenario_row:
                    raise BassettScenarioUnavailableError("Bassett scenario does not exist")
                scenario = dict(scenario_row["data"])
                if scenario.get("archived") or scenario.get("archived_at"):
                    raise BassettScenarioUnavailableError("Bassett scenario is archived")
                snapshot_fields = tuple(snapshot_fields)
                if any(not str(scenario.get(field) or "").strip() for field in snapshot_fields):
                    raise BassettScenarioInvalidError(
                        "Bassett scenario does not have a complete definition"
                    )
                stored = copy.deepcopy(document)
                if not stored.get("test_id"):
                    stored["test_id"] = await self._next_bassett_test_id(connection)
                stored["definition_snapshot"] = {
                    field: scenario.get(field) for field in snapshot_fields
                }
                await self._insert("bassett_issues", stored, connection)
                return stored, True

    async def create_bassett_workflow(
        self,
        document: Dict[str, Any],
        creation_key: Optional[str],
        snapshot_fields: Iterable[str],
        finding: Optional[Dict[str, Any]] = None,
        attachment_documents: Iterable[Dict[str, Any]] = (),
        history_documents: Iterable[Dict[str, Any]] = (),
        activity_document: Optional[Dict[str, Any]] = None,
    ) -> Tuple[Dict[str, Any], bool]:
        """Persist a complete Bassett-only workflow atomically.

        Object-storage bytes are deliberately handled by the API before this
        method is called. This method owns the metadata transaction, including
        the issue, optional finding, attachments, history, and activity record.
        """
        if self.pool is None:
            raise RuntimeError("PostgreSQL database has not been connected")
        async with self.pool.acquire() as connection:
            async with connection.transaction():
                if creation_key:
                    await connection.execute(
                        "SELECT pg_advisory_xact_lock(hashtext($1))",
                        f"zoneqa:bassett-workflow:{creation_key}",
                    )
                    existing = await connection.fetchrow(
                        'SELECT data FROM "bassett_issues" WHERE data->>\'creation_key\'=$1',
                        creation_key,
                    )
                    if existing:
                        return dict(existing["data"]), False

                scenario_row = await connection.fetchrow(
                    'SELECT data FROM "bassett_scenarios" WHERE id=$1 FOR SHARE',
                    str(document.get("scenario_id") or ""),
                )
                if not scenario_row:
                    raise BassettScenarioUnavailableError("Bassett scenario does not exist")
                scenario = dict(scenario_row["data"])
                if scenario.get("archived") or scenario.get("archived_at"):
                    raise BassettScenarioUnavailableError("Bassett scenario is archived")
                snapshot_fields = tuple(snapshot_fields)
                if any(not str(scenario.get(field) or "").strip() for field in snapshot_fields):
                    raise BassettScenarioInvalidError(
                        "Bassett scenario does not have a complete definition"
                    )

                stored = copy.deepcopy(document)
                if not stored.get("test_id"):
                    stored["test_id"] = await self._next_bassett_test_id(connection)
                stored["definition_snapshot"] = {
                    field: scenario.get(field) for field in snapshot_fields
                }
                if finding:
                    stored["finding_id"] = finding["id"]
                await self._insert("bassett_issues", stored, connection)
                if finding:
                    await self._insert("findings", finding, connection)
                for attachment in attachment_documents:
                    await self._insert("attachments", attachment, connection)
                for history in history_documents:
                    await self._insert("bassett_history", history, connection)
                if activity_document:
                    await self._insert("activities", activity_document, connection)
                return stored, True

    async def create_testcase_workflow(
        self,
        testcase: Dict[str, Any],
        goldstandard: Dict[str, Any],
        responses: Iterable[Dict[str, Any]],
        evaluations: Iterable[Dict[str, Any]],
        findings: Iterable[Dict[str, Any]] = (),
        attachment_documents: Iterable[Dict[str, Any]] = (),
        activity_document: Optional[Dict[str, Any]] = None,
        creation_key: Optional[str] = None,
    ) -> Tuple[Dict[str, Any], bool]:
        """Create a comparison test and every entered workflow record atomically."""
        if self.pool is None:
            raise RuntimeError("PostgreSQL database has not been connected")
        async with self.pool.acquire() as connection:
            async with connection.transaction():
                stored = copy.deepcopy(testcase)
                if creation_key:
                    await connection.execute(
                        "SELECT pg_advisory_xact_lock(hashtext($1))", creation_key
                    )
                    replay = await connection.fetchrow(
                        'SELECT data FROM "testcases" WHERE data->>\'creation_key\'=$1 FOR UPDATE',
                        creation_key,
                    )
                    if replay:
                        return dict(replay["data"]), False
                    stored["creation_key"] = creation_key
                stored.setdefault("test_id", await self._next_testcase_id(connection))
                await self._insert("testcases", stored, connection)
                await self._insert("goldstandards", goldstandard, connection)
                for response in responses:
                    await self._insert("responses", response, connection)
                for evaluation in evaluations:
                    await self._insert("evaluations", evaluation, connection)
                for finding in findings:
                    await self._insert("findings", finding, connection)
                for attachment in attachment_documents:
                    await self._insert("attachments", attachment, connection)
                if activity_document:
                    await self._insert("activities", activity_document, connection)
                return stored, True

    async def update_testcase_workflow(
        self,
        testcase_id: str,
        testcase_updates: Dict[str, Any],
        responses: Iterable[Dict[str, Any]],
        evaluations: Iterable[Dict[str, Any]],
        findings: Iterable[Dict[str, Any]] = (),
        attachment_documents: Iterable[Dict[str, Any]] = (),
        goldstandard: Optional[Dict[str, Any]] = None,
        expected_revision: Optional[int] = None,
    ) -> Optional[Dict[str, Any]]:
        """Update comparison-only fields and upsert model records in one transaction."""
        if self.pool is None:
            raise RuntimeError("PostgreSQL database has not been connected")
        async with self.pool.acquire() as connection:
            async with connection.transaction():
                row = await connection.fetchrow(
                    'SELECT data FROM "testcases" WHERE id=$1 FOR UPDATE', testcase_id
                )
                if not row:
                    return None
                current = dict(row["data"])
                if expected_revision is None:
                    return {"error": "revision_required", "current": current}
                if int(current.get("revision", 1)) != int(expected_revision):
                    return {"error": "stale", "current": current}
                if current.get("archived"):
                    return {"error": "archived"}
                updated = {**current, **testcase_updates}
                updated["revision"] = int(current.get("revision", 1)) + 1
                await self._replace("testcases", updated, connection)
                if goldstandard:
                    existing_gold = await connection.fetchrow(
                        'SELECT data FROM "goldstandards" WHERE data->>\'testcase_id\'=$1 '
                        "ORDER BY data->>'created_at' DESC LIMIT 1 FOR UPDATE",
                        testcase_id,
                    )
                    if existing_gold:
                        await self._replace(
                            "goldstandards",
                            {**dict(existing_gold["data"]), **goldstandard, "id": dict(existing_gold["data"])["id"], "testcase_id": testcase_id},
                            connection,
                        )
                    else:
                        await self._insert("goldstandards", goldstandard, connection)

                for document, collection in (
                    *[(response, "responses") for response in responses],
                    *[(evaluation, "evaluations") for evaluation in evaluations],
                ):
                    existing = await connection.fetchrow(
                        f'SELECT data FROM "{collection}" '
                        "WHERE data->>'testcase_id'=$1 AND data->>'model'=$2 "
                        "ORDER BY data->>'created_at' DESC LIMIT 1 FOR UPDATE",
                        testcase_id, str(document.get("model") or ""),
                    )
                    if existing:
                        existing_document = dict(existing["data"])
                        merged = {**existing_document, **document, "id": existing_document["id"], "testcase_id": testcase_id}
                        await self._replace(collection, merged, connection)
                    else:
                        await self._insert(collection, document, connection)
                for finding in findings:
                    existing_finding = await connection.fetchrow(
                        'SELECT data FROM "findings" WHERE '
                        "(id=$1 OR (data->>'testcase_id'=$2 AND data->>'source'=$3 AND data->>'title'=$4)) "
                        "ORDER BY data->>'created_at' DESC LIMIT 1 FOR UPDATE",
                        finding.get("id"), testcase_id, finding.get("source"), finding.get("title"),
                    )
                    if existing_finding:
                        existing_document = dict(existing_finding["data"])
                        await self._replace("findings", {**existing_document, **finding, "id": existing_document["id"]}, connection)
                    else:
                        await self._insert("findings", finding, connection)
                for attachment in attachment_documents:
                    await self._insert("attachments", attachment, connection)
                return updated

    async def expand_bassett_issue(self, issue_id: str, testcase: Dict[str, Any],
                                   goldstandard: Dict[str, Any],
                                   responses: Iterable[Dict[str, Any]],
                                   evaluations: Iterable[Dict[str, Any]],
                                   attachment_copies: Iterable[Dict[str, Any]]) -> Dict[str, Any]:
        """Idempotently materialize an issue as one test case and its slots."""
        if self.pool is None:
            raise RuntimeError("PostgreSQL database has not been connected")
        async with self.pool.acquire() as connection:
            async with connection.transaction():
                await connection.execute(
                    "SELECT pg_advisory_xact_lock(hashtext($1))", f"zoneqa:bassett-expand:{issue_id}"
                )
                issue_row = await connection.fetchrow(
                    'SELECT data FROM "bassett_issues" WHERE id=$1 FOR UPDATE', issue_id
                )
                if not issue_row:
                    return {}
                issue = dict(issue_row["data"])
                if issue.get("testcase_id"):
                    linked = await connection.fetchrow(
                        'SELECT data FROM "testcases" WHERE id=$1', str(issue["testcase_id"])
                    )
                    if linked:
                        linked_testcase = dict(linked["data"])
                        # A prior expansion may have committed its test case but
                        # predate linking the associated Finding. Repair only the
                        # missing link; never overwrite a different relationship.
                        if issue.get("finding_id"):
                            finding_row = await connection.fetchrow(
                                'SELECT data FROM "findings" WHERE id=$1 FOR UPDATE',
                                str(issue["finding_id"]),
                            )
                            if not finding_row:
                                return {"error": "finding_conflict"}
                            finding = dict(finding_row["data"])
                            if finding.get("testcase_id") not in (None, "", linked_testcase["id"]):
                                return {"error": "finding_conflict"}
                            if (finding.get("project_id") and linked_testcase.get("project_id")
                                    and finding["project_id"] != linked_testcase["project_id"]):
                                return {"error": "finding_conflict"}
                            if not finding.get("testcase_id"):
                                finding["testcase_id"] = linked_testcase["id"]
                                if not finding.get("project_id") and linked_testcase.get("project_id"):
                                    finding["project_id"] = linked_testcase["project_id"]
                                finding["updated_at"] = testcase["updated_at"]
                                await self._replace("findings", finding, connection)
                        return {"issue": issue, "testcase": linked_testcase, "created": False}
                existing = await connection.fetchrow(
                    'SELECT data FROM "testcases" WHERE data->>\'bassett_issue_id\'=$1', issue_id
                )
                if existing:
                    return {"issue": issue, "testcase": dict(existing["data"]), "created": False}
                linked_finding = None
                if issue.get("finding_id"):
                    finding_row = await connection.fetchrow(
                        'SELECT data FROM "findings" WHERE id=$1 FOR UPDATE', str(issue["finding_id"])
                    )
                    if not finding_row:
                        return {"error": "finding_conflict"}
                    linked_finding = dict(finding_row["data"])
                    if linked_finding.get("testcase_id") not in (None, "", testcase["id"]):
                        return {"error": "finding_conflict"}
                    if linked_finding.get("project_id") and testcase.get("project_id") and linked_finding["project_id"] != testcase["project_id"]:
                        return {"error": "finding_conflict"}
                testcase.setdefault("test_id", await self._next_testcase_id(connection))
                await self._insert("testcases", testcase, connection)
                await self._insert("goldstandards", goldstandard, connection)
                for response in responses:
                    await self._insert("responses", response, connection)
                for evaluation in evaluations:
                    await self._insert("evaluations", evaluation, connection)
                for attachment in attachment_copies:
                    source_attachment_id = attachment.get("source_attachment_id")
                    if source_attachment_id:
                        existing_attachment = await connection.fetchrow(
                            'SELECT data FROM "attachments" WHERE id=$1 FOR UPDATE',
                            str(source_attachment_id),
                        )
                        if existing_attachment:
                            linked_attachment = dict(existing_attachment["data"])
                            linked_attachment["linked_entity_type"] = "testcase"
                            linked_attachment["linked_entity_id"] = testcase["id"]
                            linked_attachment["linked_testcase_id"] = testcase["id"]
                            linked_attachment["updated_at"] = testcase["updated_at"]
                            await self._replace("attachments", linked_attachment, connection)
                            continue
                    await self._insert("attachments", attachment, connection)
                issue["testcase_id"] = testcase["id"]
                issue["updated_at"] = testcase["updated_at"]
                await self._replace("bassett_issues", issue, connection)
                if linked_finding is not None:
                    linked_finding["testcase_id"] = testcase["id"]
                    if not linked_finding.get("project_id") and testcase.get("project_id"):
                        linked_finding["project_id"] = testcase["project_id"]
                    linked_finding["updated_at"] = testcase["updated_at"]
                    await self._replace("findings", linked_finding, connection)
                return {"issue": issue, "testcase": testcase, "created": True}

    async def create_auth_session(self, document: Dict[str, Any]) -> None:
        """Persist an opaque auth session in the existing indexed config table."""
        await self._insert("config", document)

    async def get_auth_session(self, identifier: str) -> Optional[Dict[str, Any]]:
        if self.pool is None:
            raise RuntimeError("PostgreSQL database has not been connected")
        row = await self.pool.fetchrow(
            'SELECT data FROM "config" WHERE id = $1', identifier
        )
        return dict(row["data"]) if row else None

    async def revoke_auth_session(self, identifier: str) -> None:
        await self._delete("config", identifier)

    async def revoke_auth_sessions_for_user(self, user_id: str) -> int:
        """Revoke every active opaque session owned by one user."""
        if self.pool is None:
            raise RuntimeError("PostgreSQL database has not been connected")
        result = await self.pool.execute(
            'DELETE FROM "config" '
            "WHERE id LIKE 'auth_session:%' AND data->>'user_id' = $1",
            user_id,
        )
        return int(result.rsplit(" ", 1)[-1])

    async def consume_auth_rate_limit(
        self, identifier: str, now: str, limit: int, window_seconds: int
    ) -> Dict[str, Any]:
        """Atomically consume a bounded authentication rate-limit bucket."""
        if self.pool is None:
            raise RuntimeError("PostgreSQL database has not been connected")
        async with self.pool.acquire() as connection:
            async with connection.transaction():
                await connection.execute(
                    "SELECT pg_advisory_xact_lock(hashtext($1))", identifier
                )
                row = await connection.fetchrow(
                    'SELECT data FROM "config" WHERE id = $1 FOR UPDATE', identifier
                )
                current = dict(row["data"]) if row else {}
                try:
                    elapsed = (
                        datetime.fromisoformat(now)
                        - datetime.fromisoformat(current["window_started_at"])
                    ).total_seconds()
                except (KeyError, TypeError, ValueError):
                    elapsed = window_seconds
                if elapsed >= window_seconds:
                    current = {"window_started_at": now, "attempts": 0}
                attempts = int(current.get("attempts", 0))
                if attempts >= limit:
                    return {
                        "allowed": False,
                        "retry_after": max(1, window_seconds - int(elapsed)),
                    }
                current.update({"id": identifier, "attempts": attempts + 1})
                if row:
                    await connection.execute(
                        'UPDATE "config" SET data = $1 WHERE id = $2',
                        current,
                        identifier,
                    )
                else:
                    await self._insert("config", current, connection)
                return {"allowed": True, "remaining": max(0, limit - attempts - 1)}

    async def deactivate_user_and_revoke_sessions(
        self, user_id: str, actor_id: str, timestamp: str
    ) -> Dict[str, Any]:
        """Atomically deactivate a user, guard the last admin, and revoke sessions."""
        if self.pool is None:
            raise RuntimeError("PostgreSQL database has not been connected")
        async with self.pool.acquire() as connection:
            async with connection.transaction():
                await connection.execute(
                    "SELECT pg_advisory_xact_lock(hashtext($1))",
                    "zoneqa:user-lifecycle",
                )
                row = await connection.fetchrow(
                    'SELECT data FROM "users" WHERE id = $1 FOR UPDATE', user_id
                )
                if not row:
                    return {"error": "not_found"}
                target = dict(row["data"])
                if target.get("deleted_at"):
                    return {"error": "not_found"}
                if target.get("role") == "admin":
                    active_admins = await connection.fetchval(
                        'SELECT count(*) FROM "users" '
                        "WHERE id <> $1 AND data->>'role' = 'admin' "
                        "AND COALESCE(data->>'active', 'true') <> 'false' "
                        "AND data->>'deleted_at' IS NULL",
                        user_id,
                    )
                    if not active_admins:
                        return {"error": "last_active_admin"}
                if target.get("active") is False:
                    return {"active": False, "sessions_revoked": 0}
                target.update({
                    "active": False,
                    "deactivated_at": timestamp,
                    "deactivated_by": actor_id,
                    "updated_at": timestamp,
                })
                await connection.execute(
                    'UPDATE "users" SET data = $2 WHERE id = $1', user_id, target
                )
                deleted = await connection.execute(
                    'DELETE FROM "config" '
                    "WHERE id LIKE 'auth_session:%' AND data->>'user_id' = $1",
                    user_id,
                )
                return {
                    "active": False,
                    "sessions_revoked": int(deleted.rsplit(" ", 1)[-1]),
                }

    async def bootstrap_admin(self, document: Dict[str, Any]) -> bool:
        """Create the first admin under a transaction-wide advisory lock."""
        if self.pool is None:
            raise RuntimeError("PostgreSQL database has not been connected")
        async with self.pool.acquire() as connection:
            async with connection.transaction():
                await connection.execute(
                    "SELECT pg_advisory_xact_lock(hashtext($1))",
                    "zoneqa:first-admin-bootstrap",
                )
                exists = await connection.fetchval(
                    'SELECT 1 FROM "users" '
                    "WHERE data->>'role' = 'admin' "
                    "AND COALESCE(data->>'active', 'true') <> 'false' "
                    "AND data->>'deleted_at' IS NULL LIMIT 1"
                )
                if exists:
                    return False
                email_exists = await connection.fetchval(
                    'SELECT 1 FROM "users" WHERE email = $1 LIMIT 1',
                    str(document.get("email", "")).lower(),
                )
                if email_exists:
                    return False
                await self._insert("users", document, connection)
                return True

    async def create_user_with_setup(
        self, document: Dict[str, Any], setup_document: Dict[str, Any]
    ) -> None:
        """Create a user and its setup record together without a schema change."""
        if self.pool is None:
            raise RuntimeError("PostgreSQL database has not been connected")
        async with self.pool.acquire() as connection:
            async with connection.transaction():
                await self._insert("users", document, connection)
                await self._insert("config", setup_document, connection)

    async def rotate_user_setup(
        self,
        user_id: str,
        setup_document: Dict[str, Any],
        now: str,
        cooldown_seconds: int = 60,
    ) -> Dict[str, Any]:
        """Invalidate prior activation links and create one replacement atomically."""
        if self.pool is None:
            raise RuntimeError("PostgreSQL database has not been connected")
        async with self.pool.acquire() as connection:
            async with connection.transaction():
                row = await connection.fetchrow(
                    'SELECT data FROM "users" WHERE id = $1 FOR UPDATE', str(user_id)
                )
                if not row:
                    return {"error": "not_found"}
                user = copy.deepcopy(dict(row["data"]))
                if user.get("deleted_at"):
                    return {"error": "not_found"}
                if user.get("active") is False:
                    return {"error": "inactive"}
                if user.get("password_hash") or user.get("activated_at"):
                    return {"error": "activated"}
                last_attempted = user.get("welcome_email_last_attempted_at")
                if last_attempted:
                    try:
                        elapsed = (
                            datetime.fromisoformat(now)
                            - datetime.fromisoformat(last_attempted)
                        ).total_seconds()
                    except (TypeError, ValueError):
                        elapsed = cooldown_seconds
                    remaining = cooldown_seconds - int(elapsed)
                    if remaining > 0:
                        return {"error": "cooldown", "remaining": remaining}
                setups = await connection.fetch(
                    'SELECT id, data FROM "config" '
                    "WHERE data->>'user_id' = $1 "
                    "AND data->>'purpose' = 'user_activation' "
                    "AND data->>'used_at' IS NULL "
                    "AND data->>'revoked_at' IS NULL FOR UPDATE",
                    str(user_id),
                )
                for existing in setups:
                    prior = dict(existing["data"])
                    prior["revoked_at"] = now
                    await connection.execute(
                        'UPDATE "config" SET data = $1 WHERE id = $2',
                        prior,
                        str(existing["id"]),
                    )
                await self._insert("config", setup_document, connection)
                user.update({
                    "welcome_email_status": "pending",
                    "welcome_email_last_attempted_at": now,
                    "welcome_email_last_error": None,
                    "activation_expires_at": setup_document["expires_at"],
                    "updated_at": now,
                })
                await connection.execute(
                    'UPDATE "users" SET data = $1 WHERE id = $2',
                    user,
                    str(user_id),
                )
                return {"user": user}

    async def update_user_profile(
        self,
        user_id: str,
        changes: Dict[str, Any],
        *,
        expected_revision: Optional[int] = None,
        expected_updated_at: Optional[str] = None,
        timestamp: str,
        activity: Optional[Dict[str, Any]] = None,
    ) -> Dict[str, Any]:
        """Atomically update a user's profile and audit record."""
        if self.pool is None:
            raise RuntimeError("PostgreSQL database has not been connected")
        async with self.pool.acquire() as connection:
            async with connection.transaction():
                if "role" in changes:
                    await connection.execute(
                        "SELECT pg_advisory_xact_lock(hashtext($1))",
                        "zoneqa:user-lifecycle",
                    )
                row = await connection.fetchrow(
                    'SELECT id, data FROM "users" WHERE id = $1 FOR UPDATE',
                    str(user_id),
                )
                if row is None:
                    return {"error": "not_found"}
                target = copy.deepcopy(dict(row["data"]))
                target.setdefault("id", row["id"])
                if target.get("deleted_at"):
                    return {"error": "not_found"}

                current_revision = int(target.get("revision", 1))
                if (
                    expected_updated_at is not None
                    and expected_updated_at != target.get("updated_at")
                ):
                    return {
                        "error": "stale_update",
                        "current_revision": current_revision,
                        "current_updated_at": target.get("updated_at"),
                    }
                if (
                    expected_revision is not None
                    and int(expected_revision) != current_revision
                ):
                    return {
                        "error": "stale_update",
                        "current_revision": current_revision,
                        "current_updated_at": target.get("updated_at"),
                    }

                if "email" in changes:
                    duplicate = await connection.fetchval(
                        'SELECT 1 FROM "users" '
                        "WHERE id <> $1 AND email = $2 "
                        "AND COALESCE(data->>'active', 'true') <> 'false' "
                        "AND data->>'deleted_at' IS NULL LIMIT 1",
                        str(user_id),
                        str(changes["email"]).lower(),
                    )
                    if duplicate:
                        return {"error": "duplicate_email"}

                if (
                    changes.get("role") is not None
                    and target.get("role") == "admin"
                    and changes["role"] != "admin"
                ):
                    active_admins = await connection.fetchval(
                        'SELECT count(*) FROM "users" '
                        "WHERE id <> $1 AND data->>'role' = 'admin' "
                        "AND COALESCE(data->>'active', 'true') <> 'false' "
                        "AND data->>'deleted_at' IS NULL",
                        str(user_id),
                    )
                    if not active_admins:
                        return {"error": "last_active_admin"}

                target.update(copy.deepcopy(changes))
                target["updated_at"] = timestamp
                target["revision"] = current_revision + 1
                await self._replace("users", target, connection)

                if activity is not None:
                    await self._insert("activities", activity, connection)

                public_user = copy.deepcopy(target)
                public_user.pop("password_hash", None)
                public_user.pop("password_history", None)
                public_user.pop("session_tokens", None)
                return {
                    "user": public_user,
                }

    async def change_password_with_current(
        self,
        user_id: str,
        expected_password_hash: str,
        password_hash: str,
        password_history: List[str],
        timestamp: str,
        activity: Optional[Dict[str, Any]] = None,
    ) -> Dict[str, Any]:
        """Atomically change a password, audit it, and establish no old sessions."""
        if self.pool is None:
            raise RuntimeError("PostgreSQL database has not been connected")
        async with self.pool.acquire() as connection:
            async with connection.transaction():
                row = await connection.fetchrow(
                    'SELECT id, data FROM "users" WHERE id = $1 FOR UPDATE',
                    str(user_id),
                )
                if row is None:
                    return {"error": "not_found"}
                target = copy.deepcopy(dict(row["data"]))
                if target.get("deleted_at") or target.get("active") is False:
                    return {"error": "inactive"}
                if target.get("password_hash") != expected_password_hash:
                    return {"error": "stale_password"}
                target.update({
                    "password_hash": password_hash,
                    "password_history": list(password_history)[:5],
                    "auth_provider": "password",
                    "password_changed_at": timestamp,
                    "updated_at": timestamp,
                    "revision": int(target.get("revision", 1)) + 1,
                })
                await self._replace("users", target, connection)
                deleted = await connection.execute(
                    'DELETE FROM "config" '
                    "WHERE id LIKE 'auth_session:%' AND data->>'user_id' = $1",
                    str(user_id),
                )
                if activity is not None:
                    await self._insert("activities", activity, connection)
                public_user = copy.deepcopy(target)
                public_user.pop("password_hash", None)
                public_user.pop("password_history", None)
                public_user.pop("session_tokens", None)
                return {
                    "user": public_user,
                    "sessions_revoked": int(deleted.rsplit(" ", 1)[-1]),
                }

    async def rotate_password_reset(
        self,
        user_id: str,
        reset_document: Dict[str, Any],
        now: str,
        cooldown_seconds: int = 60,
    ) -> Dict[str, Any]:
        """Rotate an administrator/public password reset token atomically."""
        if self.pool is None:
            raise RuntimeError("PostgreSQL database has not been connected")
        async with self.pool.acquire() as connection:
            async with connection.transaction():
                row = await connection.fetchrow(
                    'SELECT data FROM "users" WHERE id = $1 FOR UPDATE', str(user_id)
                )
                if not row:
                    return {"error": "not_found"}
                user = copy.deepcopy(dict(row["data"]))
                if user.get("deleted_at"):
                    return {"error": "not_found"}
                if user.get("active") is False:
                    return {"error": "inactive"}
                last_attempted = user.get("password_reset_last_attempted_at")
                if last_attempted:
                    try:
                        elapsed = (
                            datetime.fromisoformat(now)
                            - datetime.fromisoformat(last_attempted)
                        ).total_seconds()
                    except (TypeError, ValueError):
                        elapsed = cooldown_seconds
                    remaining = cooldown_seconds - int(elapsed)
                    if remaining > 0:
                        return {"error": "cooldown", "remaining": remaining}
                existing = await connection.fetch(
                    'SELECT id, data FROM "config" '
                    "WHERE data->>'user_id' = $1 "
                    "AND data->>'purpose' = 'password_reset' "
                    "AND data->>'used_at' IS NULL "
                    "AND data->>'revoked_at' IS NULL FOR UPDATE",
                    str(user_id),
                )
                for prior_row in existing:
                    prior = dict(prior_row["data"])
                    prior["revoked_at"] = now
                    await connection.execute(
                        'UPDATE "config" SET data = $1 WHERE id = $2',
                        prior,
                        str(prior_row["id"]),
                    )
                await self._insert("config", reset_document, connection)
                user.update({
                    "password_reset_last_attempted_at": now,
                    "password_reset_status": "pending",
                    "password_reset_last_error": None,
                    "updated_at": now,
                })
                await connection.execute(
                    'UPDATE "users" SET data = $1 WHERE id = $2', user, str(user_id)
                )
                return {"user": user}

    async def get_password_reset(self, identifier: str) -> Optional[Dict[str, Any]]:
        if self.pool is None:
            raise RuntimeError("PostgreSQL database has not been connected")
        row = await self.pool.fetchrow(
            'SELECT data FROM "config" WHERE id = $1', identifier
        )
        return dict(row["data"]) if row else None

    async def consume_password_reset_with_password(
        self,
        reset_id: str,
        now: str,
        password_hash: str,
        password_history: List[str],
        expected_password_hash: Optional[str] = None,
        activity: Optional[Dict[str, Any]] = None,
    ) -> Dict[str, Any]:
        """Consume one reset token and change the user in one transaction."""
        if self.pool is None:
            raise RuntimeError("PostgreSQL database has not been connected")
        async with self.pool.acquire() as connection:
            async with connection.transaction():
                token_row = await connection.fetchrow(
                    'SELECT data FROM "config" WHERE id = $1 FOR UPDATE', reset_id
                )
                if not token_row:
                    return {"error": "invalid"}
                token = dict(token_row["data"])
                if token.get("purpose") != "password_reset":
                    return {"error": "invalid"}
                if token.get("used_at") or token.get("revoked_at"):
                    return {"error": "invalid"}
                try:
                    expired = datetime.fromisoformat(token["expires_at"]) <= datetime.fromisoformat(now)
                except (KeyError, TypeError, ValueError):
                    expired = True
                if expired or not token.get("user_id"):
                    return {"error": "invalid"}
                user_row = await connection.fetchrow(
                    'SELECT data FROM "users" WHERE id = $1 FOR UPDATE',
                    str(token["user_id"]),
                )
                if not user_row:
                    return {"error": "invalid"}
                user = copy.deepcopy(dict(user_row["data"]))
                if user.get("deleted_at") or user.get("active") is False:
                    return {"error": "invalid"}
                if expected_password_hash is not None and user.get("password_hash") != expected_password_hash:
                    return {"error": "invalid"}
                user.update({
                    "password_hash": password_hash,
                    "password_history": list(password_history)[:5],
                    "auth_provider": "password",
                    "password_changed_at": now,
                    "password_reset_status": "completed",
                    "password_reset_completed_at": now,
                    "updated_at": now,
                    "revision": int(user.get("revision", 1)) + 1,
                })
                token["used_at"] = now
                await connection.execute(
                    'UPDATE "users" SET data = $1 WHERE id = $2',
                    user,
                    str(token["user_id"]),
                )
                await connection.execute(
                    'UPDATE "config" SET data = $1 WHERE id = $2', token, reset_id
                )
                deleted = await connection.execute(
                    'DELETE FROM "config" '
                    "WHERE id LIKE 'auth_session:%' AND data->>'user_id' = $1",
                    str(token["user_id"]),
                )
                if activity is not None:
                    await self._insert("activities", activity, connection)
                public_user = copy.deepcopy(user)
                public_user.pop("password_hash", None)
                public_user.pop("password_history", None)
                public_user.pop("session_tokens", None)
                return {
                    "user": public_user,
                    "sessions_revoked": int(deleted.rsplit(" ", 1)[-1]),
                }

    async def activate_user_with_password(
        self, setup_id: str, now: str, password_hash: str
    ) -> Optional[Dict[str, Any]]:
        """Atomically consume setup and install the user's password hash."""
        if self.pool is None:
            raise RuntimeError("PostgreSQL database has not been connected")
        async with self.pool.acquire() as connection:
            async with connection.transaction():
                row = await connection.fetchrow(
                    'SELECT data FROM "config" WHERE id = $1 FOR UPDATE', setup_id
                )
                if not row:
                    return None
                setup = dict(row["data"])
                if (
                    setup.get("used_at")
                    or setup.get("revoked_at")
                    or not setup.get("user_id")
                ):
                    return None
                try:
                    from datetime import datetime, timezone
                    expired = datetime.fromisoformat(setup["expires_at"]) <= datetime.fromisoformat(now)
                except (KeyError, TypeError, ValueError):
                    expired = True
                if expired:
                    return None
                user_row = await connection.fetchrow(
                    'SELECT data FROM "users" WHERE id = $1 FOR UPDATE',
                    str(setup["user_id"]),
                )
                if not user_row:
                    return None
                user = dict(user_row["data"])
                if user.get("deleted_at"):
                    return None
                user.update({
                    "password_hash": password_hash,
                    "auth_provider": "password",
                    "activated_at": now,
                    "welcome_email_status": "activated",
                    "activation_completed_at": now,
                    "updated_at": now,
                })
                setup["used_at"] = now
                await connection.execute(
                    'UPDATE "users" SET data = $1 WHERE id = $2',
                    user,
                    str(setup["user_id"]),
                )
                await connection.execute(
                    'UPDATE "config" SET data = $1 WHERE id = $2', setup, setup_id
                )
                return user

    async def insert_active_retest(self, document: Dict[str, Any]) -> bool:
        """Atomically enforce one In Progress retest per finding."""
        finding_id = str(document.get("finding_id") or "")
        if not finding_id:
            raise ValueError("Active retests require a finding_id")
        async with self.pool.acquire() as connection:
            async with connection.transaction():
                # Serialize starts for the same finding without imposing a
                # permanent schema constraint on historical retest records.
                await connection.execute(
                    "SELECT pg_advisory_xact_lock(hashtext($1))", finding_id
                )
                existing = await connection.fetchval(
                    'SELECT id FROM "retests" '
                    "WHERE data->>'finding_id' = $1 "
                    "AND data->>'status' = 'In Progress' LIMIT 1",
                    finding_id,
                )
                if existing:
                    return False
                await self._insert("retests", document, connection)
                return True

    async def complete_retest_transition(
        self,
        retest_id: str,
        retest_updates: Dict[str, Any],
        finding_status: str,
        history_entry: Dict[str, Any],
    ) -> Dict[str, Any]:
        """Atomically complete one retest and update its linked finding."""
        async with self.pool.acquire() as connection:
            async with connection.transaction():
                row = await connection.fetchrow(
                    'SELECT data FROM "retests" WHERE id = $1 FOR UPDATE',
                    retest_id,
                )
                if not row:
                    return {"error": "not_found"}
                retest = dict(row["data"])
                if retest.get("status") != "In Progress":
                    return {"error": "invalid_state"}
                finding_id = retest.get("finding_id")
                if not finding_id:
                    return {"error": "orphaned"}
                finding_row = await connection.fetchrow(
                    'SELECT data FROM "findings" WHERE id = $1 FOR UPDATE',
                    finding_id,
                )
                if not finding_row:
                    return {"error": "finding_not_found"}
                finding = dict(finding_row["data"])

                updated_retest = {**retest, **retest_updates}
                entry = {**history_entry, "from": finding.get("developer_status")}
                updated_finding = {
                    **finding,
                    "developer_status": finding_status,
                    "retest_status": retest_updates["verdict"],
                    "status_history": (finding.get("status_history") or []) + [entry],
                    "updated_at": retest_updates["updated_at"],
                }
                await self._replace("retests", updated_retest, connection)
                await self._replace("findings", updated_finding, connection)
                return {
                    "retest": updated_retest,
                    "finding_id": finding_id,
                    "testcase_id": retest.get("testcase_id"),
                    "finding_title": retest.get("finding_title", ""),
                }

    async def delete_testcase_cascade(self, identifier: str):
        """Delete a test case and its dependent QA documents as one transaction."""
        if self.pool is None:
            raise RuntimeError("PostgreSQL database has not been connected")
        children = (
            "evaluations", "responses", "annotations", "claims", "goldstandards",
            "retests", "test_runs", "findings", "demos",
        )
        async with self.pool.acquire() as connection:
            async with connection.transaction():
                exists = await connection.fetchval(
                    'SELECT 1 FROM "testcases" WHERE id = $1', identifier
                )
                if not exists:
                    return None
                variants = await connection.fetch(
                    'SELECT id FROM "testcases" WHERE "variant_of" = $1', identifier
                )
                if variants:
                    return {"blocked_variants": [row["id"] for row in variants]}
                cascaded = {}
                for collection in children:
                    tag = await connection.execute(
                        f'DELETE FROM "{collection}" WHERE data->>\'testcase_id\' = $1',
                        identifier,
                    )
                    count = int(tag.rsplit(" ", 1)[-1])
                    if count:
                        cascaded[collection] = count
                await connection.execute('DELETE FROM "testcases" WHERE id = $1', identifier)
                return {"cascaded": cascaded}

    async def permanent_delete_testcase(
        self, identifier: str, audit_document: Dict[str, Any], expected_updated_at: str
    ):
        """Delete only an unused testcase, rechecking all references in one transaction.

        This intentionally does not cascade.  The caller supplies the immutable audit
        event, which is inserted on the same transaction as the guarded delete.
        """
        if self.pool is None:
            raise RuntimeError("PostgreSQL database has not been connected")
        queries = {
            "responses": 'SELECT COUNT(*) FROM "responses" WHERE data->>\'testcase_id\' = $1',
            "evaluations": 'SELECT COUNT(*) FROM "evaluations" WHERE data->>\'testcase_id\' = $1',
            "gold_standards": 'SELECT COUNT(*) FROM "goldstandards" WHERE data->>\'testcase_id\' = $1',
            "findings": 'SELECT COUNT(*) FROM "findings" WHERE data->>\'testcase_id\' = $1',
            "retests": 'SELECT COUNT(*) FROM "retests" WHERE data->>\'testcase_id\' = $1',
            "test_runs": 'SELECT COUNT(*) FROM "test_runs" WHERE data->>\'testcase_id\' = $1',
            "demos": 'SELECT COUNT(*) FROM "demos" WHERE data->>\'testcase_id\' = $1',
            "annotations": 'SELECT COUNT(*) FROM "annotations" WHERE data->>\'testcase_id\' = $1',
            "claims": 'SELECT COUNT(*) FROM "claims" WHERE data->>\'testcase_id\' = $1',
            "comments": 'SELECT COUNT(*) FROM "comments" WHERE data->>\'entity_id\' = $1',
            "activities": 'SELECT COUNT(*) FROM "activities" WHERE data->>\'entity_id\' = $1 AND COALESCE(data->>\'source\', \'\') <> \'testcase_lifecycle_audit\' AND COALESCE(data->>\'action\', \'\') <> \'created\'',
            "attachments": 'SELECT COUNT(*) FROM "attachments" WHERE '
                          "((data->>'entity_id' = $1 AND data->>'entity_type' IN "
                          "('testcase', 'testcases')) OR data->>'linked_testcase_id' = $1)",
            "calendar_records": 'SELECT COUNT(*) FROM "calendar_events" WHERE data->>\'testcase_id\' = $1',
            "bassett_issues": 'SELECT COUNT(*) FROM "bassett_issues" WHERE data->>\'testcase_id\' = $1',
            "test_bank_links": 'SELECT COUNT(*) FROM "bassett_scenarios" WHERE data->>\'testcase_id\' = $1',
            "test_bank_executions": 'SELECT COUNT(*) FROM "bassett_executions" WHERE data->>\'testcase_id\' = $1',
            "regression_runs": 'SELECT COUNT(*) FROM "regression_runs" WHERE data->\'testcase_ids\' ? $1',
            "variants": 'SELECT COUNT(*) FROM "testcases" WHERE data->>\'variant_of\' = $1',
            "expanded_comparisons": 'SELECT COUNT(*) FROM "testcases" WHERE id = $1 AND data->>\'bassett_issue_id\' IS NOT NULL',
        }
        async with self.pool.acquire() as connection:
            async with connection.transaction():
                locked = await connection.fetchrow(
                    'SELECT data FROM "testcases" WHERE id = $1 FOR UPDATE', identifier
                )
                if not locked:
                    return {"error": "not_found"}
                testcase = dict(locked["data"])
                if not testcase.get("archived") or testcase.get("updated_at") != expected_updated_at:
                    return {"error": "stale"}
                counts = {}
                for name, query in queries.items():
                    count = await connection.fetchval(query, identifier)
                    if count:
                        counts[name] = int(count)
                evidence_count = await connection.fetchval(
                    'SELECT COALESCE(jsonb_array_length(COALESCE(data->\'evidence_ids\', \'[]\'::jsonb)), 0) '
                    'FROM "testcases" WHERE id = $1', identifier,
                )
                if evidence_count:
                    counts["evidence"] = int(evidence_count)
                if counts:
                    return {"error": "blocked", "dependencies": counts}
                await self._insert("activities", audit_document, connection)
                await connection.execute('DELETE FROM "testcases" WHERE id = $1', identifier)
                return {"deleted": True, "dependencies": {}}