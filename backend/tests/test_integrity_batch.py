import copy
from types import SimpleNamespace

import pytest

from integrity_repairs import preview_integrity_batch, repair_integrity_batch


class Cursor:
    def __init__(self, records):
        self.records = records

    async def to_list(self, _limit):
        return copy.deepcopy(self.records)


class Collection:
    def __init__(self, records):
        self.records = records

    def find(self, _query=None, _projection=None):
        return Cursor(self.records)

    async def find_one(self, query, _projection=None):
        for record in self.records:
            if all(record.get(key) == value for key, value in query.items() if not isinstance(value, dict)):
                if all(
                    (record.get("active", True) is not False)
                    if key == "active" and value == {"$ne": False}
                    else True
                    for key, value in query.items()
                ):
                    return copy.deepcopy(record)
        return None

    async def update_one(self, query, update, upsert=False):
        for record in self.records:
            if all(
                (record.get(key) == value)
                if not isinstance(value, dict)
                else (
                    value.get("$exists") == (key in record)
                    if "$exists" in value
                    else record.get(key) == value.get("$ne") is False
                )
                for key, value in query.items()
            ):
                before = copy.deepcopy(record)
                record.update(update.get("$set", {}))
                return SimpleNamespace(modified_count=int(before != record))
        if upsert:
            record = {key: value for key, value in query.items() if not isinstance(value, dict)}
            record.update(update.get("$set", {}))
            self.records.append(record)
        return SimpleNamespace(modified_count=0)


class Database:
    def __init__(self, users, projects, testcases, evaluations, evidence, versions, config):
        self.users = Collection(users)
        self.projects = Collection(projects)
        self.testcases = Collection(testcases)
        self.evaluations = Collection(evaluations)
        self.evidence = Collection(evidence)
        self.versions = Collection(versions)
        self.config = Collection(config)


@pytest.mark.asyncio
async def test_batch_repairs_exact_sample_records_and_is_idempotent():
    projects = [
        {
            "id": f"project-{number}", "name": name, "owner": "QA Manager",
            "sample_data": True,
        }
        for number, name in enumerate((
            "NYC Zoning Resolution Testing", "Parking Requirement Testing",
            "Planned Development Testing", "Bassett Release Regression",
        ))
    ]
    projects.append({
        "id": "user-project", "name": "NYC Zoning Resolution Testing",
        "owner": "QA Manager", "sample_data": False,
    })
    testcases = [
        {"id": "tc-date", "name": "[SAMPLE] comparison", "comparison_mode": True},
        {"id": "tc-existing", "name": "[SAMPLE] already dated", "comparison_mode": True, "test_date": "2026-01-01"},
        {"id": "tc-created-date", "name": "[SAMPLE] created date fallback", "comparison_mode": True},
        {"id": "tc-no-source", "name": "[SAMPLE] no source date", "comparison_mode": True},
        {"id": "tc-other", "name": "comparison", "comparison_mode": True},
    ]
    database = Database(
        users=[{"id": "admin-1", "role": "admin", "active": True}],
        projects=projects,
        testcases=testcases,
        evaluations=[
            {"id": "eval-late", "testcase_id": "tc-date", "model": "Bassett", "test_date": "2026-05-02"},
            {"id": "eval-early", "testcase_id": "tc-date", "model": "ChatGPT", "test_date": "2026-04-01"},
            {"id": "eval-latest", "testcase_id": "tc-date", "model": "Claude", "test_date": "2026-06-01"},
            {"id": "eval-retest", "testcase_id": "tc-date", "model": "Bassett", "test_date": "2026-07-01", "is_retest": True},
            {"id": "eval-existing", "testcase_id": "tc-existing", "model": "Bassett", "test_date": "2025-01-01"},
            {"id": "eval-created-date", "testcase_id": "tc-created-date", "model": "Bassett", "test_date": "", "created_at": "2026-08-04T18:30:00+00:00"},
        ],
        evidence=[
            {"id": "ev-1", "document_name": "NYC ZR §32-00 Use Regulations", "issuing_authority": "", "created_by": "seed"},
            {"id": "ev-user", "document_name": "NYC ZR §32-00 Use Regulations", "issuing_authority": "", "sample_data": False},
        ],
        versions=[
            {"id": "v-8", "name": "Bassett 8.26 (Sample)", "version_type": "", "release_channel": None, "created_by": "seed"},
            {"id": "v-9", "name": "Bassett 9.26 (Sample)", "version_type": "Minor", "release_channel": "Development", "created_by": "seed"},
        ],
        config=[{"id": "global", "version_types": ["Minor"], "release_channels": ["Development"]}],
    )

    preview = await preview_integrity_batch(database)
    assert len(preview["records"]) == 8
    assert preview["preview_ids"] == [
        "projects:project-0", "projects:project-1", "projects:project-2", "projects:project-3",
        "testcases:tc-date", "testcases:tc-created-date", "evidence:ev-1", "versions:v-8", "config:global",
    ]
    assert preview["records"][4]["source_date"] == "2026-06-01"
    assert preview["records"][4]["source_date_kind"] == "evaluation Test Date"
    assert preview["records"][5]["source_date"] == "2026-08-04"
    assert preview["records"][5]["source_date_kind"] == "evaluation record created date"
    assert preview["records"][5]["target_test_date"] == "2026-08-04"
    assert any(item["id"] == "tc-no-source" for item in preview["skipped"])

    first = await repair_integrity_batch(database)
    assert first["changed"] == {
        "project_owners": 4,
        "testcase_dates": 2,
        "evidence_authorities": 1,
        "version_metadata": 1,
        "lookup_options": 2,
    }
    assert all(project.get("owner_user_id") == "admin-1" for project in projects[:4])
    assert projects[4].get("owner_user_id") is None
    assert next(tc for tc in testcases if tc["id"] == "tc-date")["test_date"] == "2026-06-01"
    assert next(tc for tc in testcases if tc["id"] == "tc-created-date")["test_date"] == "2026-08-04"
    assert next(tc for tc in testcases if tc["id"] == "tc-no-source").get("test_date") is None
    assert next(tc for tc in testcases if tc["id"] == "tc-existing")["test_date"] == "2026-01-01"
    assert database.evidence.records[0]["issuing_authority"] == "New York City Department of City Planning"
    assert database.evidence.records[1]["issuing_authority"] == ""
    assert database.versions.records[0]["version_type"] == "Sample"
    assert database.versions.records[0]["release_channel"] == "Sample"
    assert "Sample" in database.config.records[0]["version_types"]
    assert "Sample" in database.config.records[0]["release_channels"]

    second = await repair_integrity_batch(database)
    assert second["changed_total"] == 0
    assert (await preview_integrity_batch(database))["records"] == []


@pytest.mark.asyncio
async def test_project_owner_repair_makes_no_owner_changes_without_one_admin():
    projects = [
        {"id": str(index), "name": name, "owner": "QA Manager", "sample_data": True}
        for index, name in enumerate((
            "NYC Zoning Resolution Testing", "Parking Requirement Testing",
            "Planned Development Testing", "Bassett Release Regression",
        ))
    ]
    database = Database(
        users=[
            {"id": "admin-1", "role": "admin", "active": True},
            {"id": "admin-2", "role": "admin", "active": True},
        ],
        projects=projects, testcases=[], evaluations=[], evidence=[], versions=[],
        config=[{"id": "global", "version_types": [], "release_channels": []}],
    )

    result = await repair_integrity_batch(database)
    assert result["changed"]["project_owners"] == 0
    assert all("owner_user_id" not in project for project in projects)
    assert result["skipped"][0]["repair"] == "project_owners"
