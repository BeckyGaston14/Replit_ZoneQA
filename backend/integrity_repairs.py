"""Narrow, idempotent production data repairs for the imported sample dataset."""

from datetime import date
from typing import Any


LEGACY_SAMPLE_PROJECT_NAMES = frozenset({
    "NYC Zoning Resolution Testing",
    "Parking Requirement Testing",
    "Planned Development Testing",
    "Bassett Release Regression",
})

SAMPLE_EVIDENCE_AUTHORITIES = {
    "NYC ZR §32-00 Use Regulations": "New York City Department of City Planning",
    "Cool Springs PD Ordinance 2019-14": "City of Franklin Planning and Sustainability Department",
    "OKC Municipal Code §59-9150 Parking": "City of Oklahoma City Planning Department",
    "Sterling Heights Setback Table": "City of Sterling Heights Office of Planning",
}

SAMPLE_VERSION_NAMES = frozenset({
    "Bassett 8.26 (Sample)",
    "Bassett 9.26 (Sample)",
})

COMPARISON_MODELS = frozenset({"Bassett", "ChatGPT", "Claude"})


def _blank(value: Any) -> bool:
    return value is None or (isinstance(value, str) and not value.strip())


def _is_sample_record(record: dict) -> bool:
    """Require an explicit sample marker so identical user records are untouched."""
    return record.get("sample_data") is True or record.get("created_by") == "seed"


def _is_active(record: dict) -> bool:
    return not record.get("archived") and record.get("status") != "Archived"


def _is_iso_date(value: Any) -> bool:
    if not isinstance(value, str) or not value.strip():
        return False
    try:
        date.fromisoformat(value.strip())
    except ValueError:
        return False
    return True


async def _all(collection, limit=5000):
    return await collection.find({}, {"_id": 0}).to_list(limit)


async def repair_integrity_batch(database) -> dict:
    """Apply the five exact-match repairs and return an auditable change report.

    Every write is guarded by the same blank/legacy predicate used to select it.
    Running this function repeatedly therefore produces no additional changes.
    """
    report = {
        "ok": True,
        "changed": {
            "project_owners": 0,
            "testcase_dates": 0,
            "evidence_authorities": 0,
            "version_metadata": 0,
            "lookup_options": 0,
        },
        "matched": {
            "legacy_sample_projects": 0,
            "sample_testcases_without_dates": 0,
            "sample_evidence": 0,
            "sample_versions_with_missing_metadata": 0,
        },
        "skipped": [],
    }

    users = await _all(database.users)
    active_admins = [
        user for user in users
        if user.get("role") == "admin"
        and user.get("active") is not False
        and not user.get("deleted_at")
    ]

    projects = await _all(database.projects)
    legacy_projects = [
        project for project in projects
        if project.get("name") in LEGACY_SAMPLE_PROJECT_NAMES
        and project.get("owner") == "QA Manager"
        and _is_sample_record(project)
    ]
    report["matched"]["legacy_sample_projects"] = len(legacy_projects)
    if len(active_admins) != 1:
        report["skipped"].append({
            "repair": "project_owners",
            "reason": "expected exactly one active Administrator",
            "active_administrator_count": len(active_admins),
        })
    elif len(legacy_projects) != 4:
        report["skipped"].append({
            "repair": "project_owners",
            "reason": "expected exactly four matching legacy sample projects",
            "matching_project_count": len(legacy_projects),
        })
    else:
        admin_id = active_admins[0]["id"]
        for project in legacy_projects:
            if project.get("owner_user_id") == admin_id and project.get("owner_id") == admin_id:
                continue
            # Do not touch the legacy owner text. owner_id remains as a
            # compatibility mirror for older clients; owner_user_id is canonical.
            result = await database.projects.update_one(
                {
                    "id": project["id"],
                    "name": project["name"],
                    "owner": "QA Manager",
                    "owner_user_id": project.get("owner_user_id"),
                },
                {"$set": {"owner_user_id": admin_id, "owner_id": admin_id}},
            )
            if getattr(result, "modified_count", 1):
                report["changed"]["project_owners"] += 1

    evaluations = await _all(database.evaluations)
    evaluation_dates = {}
    for evaluation in evaluations:
        testcase_id = evaluation.get("testcase_id")
        value = evaluation.get("test_date")
        if testcase_id and _is_iso_date(value):
            evaluation_dates.setdefault(testcase_id, []).append(value.strip())

    testcases = await _all(database.testcases)
    sample_comparison_testcases = []
    for testcase in testcases:
        if not _is_active(testcase) or not str(testcase.get("name") or "").startswith("[SAMPLE]"):
            continue
        testcase_evaluations = [
            evaluation for evaluation in evaluations
            if evaluation.get("testcase_id") == testcase.get("id")
        ]
        is_comparison = (
            testcase.get("comparison_mode") is True
            or testcase.get("test_type") == "Competitive Benchmark"
            or any(evaluation.get("model") in COMPARISON_MODELS for evaluation in testcase_evaluations)
        )
        if is_comparison and _blank(testcase.get("test_date")):
            sample_comparison_testcases.append(testcase)
    report["matched"]["sample_testcases_without_dates"] = len(sample_comparison_testcases)
    for testcase in sample_comparison_testcases:
        dates = sorted(evaluation_dates.get(testcase.get("id"), []))
        if not dates:
            continue
        earliest = dates[0]
        result = await database.testcases.update_one(
            {"id": testcase["id"], "name": testcase["name"], "test_date": testcase.get("test_date")},
            {"$set": {"test_date": earliest}},
        )
        if getattr(result, "modified_count", 1):
            report["changed"]["testcase_dates"] += 1

    evidence = await _all(database.evidence)
    matching_evidence = [
        record for record in evidence
        if record.get("document_name") in SAMPLE_EVIDENCE_AUTHORITIES
        and _is_sample_record(record)
        and _blank(record.get("issuing_authority"))
    ]
    report["matched"]["sample_evidence"] = len(matching_evidence)
    for record in matching_evidence:
        result = await database.evidence.update_one(
            {
                "id": record["id"],
                "document_name": record["document_name"],
                "issuing_authority": record.get("issuing_authority"),
            },
            {"$set": {"issuing_authority": SAMPLE_EVIDENCE_AUTHORITIES[record["document_name"]]}},
        )
        if getattr(result, "modified_count", 1):
            report["changed"]["evidence_authorities"] += 1

    versions = await _all(database.versions)
    matching_versions = [
        record for record in versions
        if record.get("name") in SAMPLE_VERSION_NAMES and _is_sample_record(record)
        and (_blank(record.get("version_type")) or _blank(record.get("release_channel")))
    ]
    report["matched"]["sample_versions_with_missing_metadata"] = len(matching_versions)
    missing_sample_lookup = bool(matching_versions)
    if missing_sample_lookup:
        config = await database.config.find_one({"id": "global"}, {"_id": 0}) or {}
        version_types = list(config.get("version_types") or [])
        release_channels = list(config.get("release_channels") or [])
        lookup_patch = {}
        if "Sample" not in version_types:
            lookup_patch["version_types"] = [*version_types, "Sample"]
        if "Sample" not in release_channels:
            lookup_patch["release_channels"] = [*release_channels, "Sample"]
        if lookup_patch:
            await database.config.update_one({"id": "global"}, {"$set": lookup_patch}, upsert=True)
            report["changed"]["lookup_options"] = len(lookup_patch)

    for version in matching_versions:
        patch = {}
        if _blank(version.get("version_type")):
            patch["version_type"] = "Sample"
        if _blank(version.get("release_channel")):
            patch["release_channel"] = "Sample"
        if not patch:
            continue
        result = await database.versions.update_one(
            {
                "id": version["id"],
                "name": version["name"],
                "version_type": version.get("version_type"),
                "release_channel": version.get("release_channel"),
            },
            {"$set": patch},
        )
        if getattr(result, "modified_count", 1):
            report["changed"]["version_metadata"] += 1

    report["changed_total"] = sum(report["changed"].values())
    return report


# A descriptive alias for callers that use the command language.
run_integrity_repairs = repair_integrity_batch