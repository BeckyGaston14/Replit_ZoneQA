"""Narrow, idempotent production data repairs for the imported sample dataset."""

from datetime import date
from collections import Counter
import hashlib
import json
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
INTEGRITY_REPAIR_SCOPES = frozenset({"metadata", "sample_testcase_dates"})


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


def _is_retest_evaluation(evaluation: dict) -> bool:
    """Recognize explicit retest markers without treating ordinary evaluations as retests."""
    if evaluation.get("is_retest") is True or evaluation.get("retest") is True:
        return True
    if any(evaluation.get(key) for key in ("retest_id", "retest_run_id")):
        return True
    for key in ("evaluation_type", "evaluation_kind", "run_type", "type"):
        if str(evaluation.get(key) or "").strip().lower().replace("-", "_") == "retest":
            return True
    return False


def _evaluation_record_date(evaluation: dict) -> tuple[str | None, str]:
    test_date = evaluation.get("test_date")
    if _is_iso_date(test_date):
        return test_date.strip(), "evaluation Test Date"
    created_at = str(evaluation.get("created_at") or "").strip()
    created_date = created_at[:10]
    if _is_iso_date(created_date):
        return created_date, "evaluation record created date"
    return None, ""


def _latest_non_retest_evaluation_date(evaluations: list[dict]) -> tuple[str | None, str, str | None]:
    eligible = [
        evaluation for evaluation in evaluations
        if not _is_retest_evaluation(evaluation) and _evaluation_record_date(evaluation)[0]
    ]
    if not eligible:
        return None, "", None
    latest = max(
        eligible,
        key=lambda evaluation: (str(evaluation.get("created_at") or ""), str(evaluation.get("id") or "")),
    )
    source_date, source_kind = _evaluation_record_date(latest)
    return source_date, source_kind, latest.get("created_at")


def validate_integrity_repair_scope(scope: Any) -> str:
    if not isinstance(scope, str) or scope not in INTEGRITY_REPAIR_SCOPES:
        raise ValueError("Unsupported integrity repair scope")
    return scope


def _preview_payload(scope: str, records: list[dict], skipped: list[dict]) -> dict:
    token_payload = {
        "scope": scope,
        "records": sorted(records, key=lambda item: (item.get("collection", ""), item.get("id", ""))),
        "skipped": sorted(skipped, key=lambda item: (item.get("collection", ""), item.get("id", ""), item.get("reason", ""))),
    }
    preview_token = hashlib.sha256(
        json.dumps(token_payload, sort_keys=True, separators=(",", ":"), default=str).encode()
    ).hexdigest()
    return {
        "ok": True,
        "scope": scope,
        "records": records,
        "preview_ids": [f"{record['collection']}:{record['id']}" for record in records],
        "counts": dict(Counter(record["repair"] for record in records)),
        "skipped": skipped,
        "preview_token": preview_token,
    }


async def _sample_testcase_date_candidates(database) -> tuple[list[dict], list[dict]]:
    evaluations = await _all(database.evaluations)
    testcases = await _all(database.testcases)
    records = []
    skipped = []
    for testcase in testcases:
        if (
            not _is_active(testcase)
            or not str(testcase.get("name") or "").startswith("[SAMPLE]")
            or not _is_sample_record(testcase)
        ):
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
        source_date, source_kind, source_created_at = _latest_non_retest_evaluation_date(testcase_evaluations)
        if is_comparison and _blank(testcase.get("test_date")) and source_date:
            records.append({
                "repair": "testcase_dates",
                "collection": "testcases",
                "id": testcase["id"],
                "name": testcase.get("name", ""),
                "source_date": source_date,
                "source_date_kind": source_kind,
                "source_evaluation_created_at": source_created_at,
                "target_test_date": source_date,
                "changes": {"test_date": source_date},
                "_current_test_date": testcase.get("test_date"),
            })
        elif is_comparison and _blank(testcase.get("test_date")):
            skipped.append({
                "repair": "testcase_dates",
                "collection": "testcases",
                "id": testcase.get("id"),
                "name": testcase.get("name", ""),
                "reason": "no valid non-retest evaluation Test Date or evaluation record created date is available",
            })
    return records, skipped


def _public_preview_records(records: list[dict]) -> list[dict]:
    return [{key: value for key, value in record.items() if not key.startswith("_")} for record in records]


async def _all(collection, limit=5000):
    return await collection.find({}, {"_id": 0}).to_list(limit)


async def preview_integrity_batch(database, scope: str = "metadata") -> dict:
    """Describe only the deterministic SAMPLE records the batch would change."""
    scope = validate_integrity_repair_scope(scope)
    if scope == "sample_testcase_dates":
        records, skipped = await _sample_testcase_date_candidates(database)
        return _preview_payload(scope, _public_preview_records(records), skipped)

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
    records = []
    skipped = []
    if len(active_admins) != 1:
        skipped.append({
            "repair": "project_owners",
            "reason": "expected exactly one active Administrator",
            "active_administrator_count": len(active_admins),
        })
    elif len(legacy_projects) != 4:
        skipped.append({
            "repair": "project_owners",
            "reason": "expected exactly four matching legacy sample projects",
            "matching_project_count": len(legacy_projects),
        })
    else:
        admin_id = active_admins[0]["id"]
        records.extend(
            {
                "repair": "project_owners",
                "collection": "projects",
                "id": project["id"],
                "name": project.get("name", ""),
                "changes": {"owner_user_id": admin_id, "owner_id": admin_id},
            }
            for project in legacy_projects
            if project.get("owner_user_id") != admin_id or project.get("owner_id") != admin_id
        )

    testcase_records, testcase_skipped = await _sample_testcase_date_candidates(database)
    records.extend(_public_preview_records(testcase_records))
    skipped.extend(testcase_skipped)

    evidence = await _all(database.evidence)
    for record in evidence:
        authority = SAMPLE_EVIDENCE_AUTHORITIES.get(record.get("document_name"))
        if authority and _is_sample_record(record) and _blank(record.get("issuing_authority")):
            records.append({
                "repair": "evidence_authorities",
                "collection": "evidence",
                "id": record["id"],
                "name": record.get("document_name", ""),
                "changes": {"issuing_authority": authority},
            })

    versions = await _all(database.versions)
    matching_versions = [
        record for record in versions
        if record.get("name") in SAMPLE_VERSION_NAMES and _is_sample_record(record)
        and (_blank(record.get("version_type")) or _blank(record.get("release_channel")))
    ]
    for version in matching_versions:
        changes = {}
        if _blank(version.get("version_type")):
            changes["version_type"] = "Sample"
        if _blank(version.get("release_channel")):
            changes["release_channel"] = "Sample"
        if changes:
            records.append({
                "repair": "version_metadata",
                "collection": "versions",
                "id": version["id"],
                "name": version.get("name", ""),
                "changes": changes,
            })

    if matching_versions:
        config = await database.config.find_one({"id": "global"}, {"_id": 0}) or {}
        if "Sample" not in list(config.get("version_types") or []) or "Sample" not in list(config.get("release_channels") or []):
            changes = {}
            if "Sample" not in list(config.get("version_types") or []):
                changes["version_types"] = "append Sample"
            if "Sample" not in list(config.get("release_channels") or []):
                changes["release_channels"] = "append Sample"
            records.append({
                "repair": "lookup_options",
                "collection": "config",
                "id": "global",
                "name": "Global lookup options",
                "changes": changes,
            })

    return _preview_payload(scope, records, skipped)


async def _repair_sample_testcase_dates(database) -> dict:
    candidates, skipped = await _sample_testcase_date_candidates(database)
    report = {
        "ok": True,
        "scope": "sample_testcase_dates",
        "changed": {"testcase_dates": 0},
        "matched": {"sample_testcases_without_dates": len(candidates) + len(skipped)},
        "skipped": skipped,
        "changed_testcase_dates": [],
    }
    for candidate in candidates:
        result = await database.testcases.update_one(
            {
                "id": candidate["id"],
                "name": candidate["name"],
                "test_date": candidate["_current_test_date"],
            },
            {"$set": {"test_date": candidate["target_test_date"]}},
        )
        if getattr(result, "modified_count", 1):
            report["changed"]["testcase_dates"] += 1
            report["changed_testcase_dates"].append(_public_preview_records([candidate])[0])
    report["changed_total"] = sum(report["changed"].values())
    return report


async def repair_integrity_batch(database, scope: str = "metadata") -> dict:
    """Apply the five exact-match repairs and return an auditable change report.

    Every write is guarded by the same blank/legacy predicate used to select it.
    Running this function repeatedly therefore produces no additional changes.
    """
    scope = validate_integrity_repair_scope(scope)
    if scope == "sample_testcase_dates":
        return await _repair_sample_testcase_dates(database)

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
        testcase_evaluations = [
            evaluation for evaluation in evaluations
            if evaluation.get("testcase_id") == testcase.get("id")
        ]
        latest_date, source_kind, source_created_at = _latest_non_retest_evaluation_date(testcase_evaluations)
        if not latest_date:
            report["skipped"].append({
                "repair": "testcase_dates",
                "collection": "testcases",
                "id": testcase.get("id"),
                "name": testcase.get("name", ""),
                "reason": "no valid non-retest evaluation Test Date is available",
            })
            continue
        result = await database.testcases.update_one(
            {"id": testcase["id"], "name": testcase["name"], "test_date": testcase.get("test_date")},
            {"$set": {"test_date": latest_date}},
        )
        if getattr(result, "modified_count", 1):
            report["changed"]["testcase_dates"] += 1
            report.setdefault("changed_testcase_dates", []).append({
                "id": testcase["id"],
                "name": testcase.get("name", ""),
                "source_date": latest_date,
                "source_date_kind": source_kind,
                "source_evaluation_created_at": source_created_at,
                "target_test_date": latest_date,
            })

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