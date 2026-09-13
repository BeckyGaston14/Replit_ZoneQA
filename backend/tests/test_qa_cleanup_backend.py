import pytest

from postgres_store import _migration_replace_known_municipality_paths
from server import (
    _canonical_severity_pair,
    _canonicalize_finding_severity,
    _finding_criticality,
    _finding_is_high_or_critical,
    _finding_severity_counts,
    _normalize_severity,
    _severity_criticality,
    _test_bank_category,
)


def test_severity_vocabulary_maps_legacy_labels_to_canonical_labels():
    assert [_normalize_severity(value) for value in (
        "Informational", "Minor", "Moderate", "High", "Critical Fail", "5"
    )] == ["Very Low", "Low", "Medium", "High", "Critical", "Critical"]
    assert _severity_criticality(None, "Very Low") == 1
    assert _severity_criticality(None, "Critical") == 5


def test_mismatched_finding_pair_uses_severity_for_all_read_population_checks():
    mismatched = {"severity": "Low", "criticality": 5}

    assert _canonical_severity_pair(**mismatched) == ("Low", 2)
    assert _canonicalize_finding_severity(mismatched)["criticality"] == 2
    assert _finding_criticality(mismatched) == 2
    assert not _finding_is_high_or_critical(mismatched)

    legacy_numeric = {"criticality": 5}
    assert _canonicalize_finding_severity(legacy_numeric)["severity"] == "Critical"
    assert _finding_criticality(legacy_numeric) == 5
    assert _finding_is_high_or_critical(legacy_numeric)


def test_severity_summary_keeps_high_and_critical_counts_separate():
    findings = [
        {"severity": "High", "criticality": 5},
        {"severity": "Critical", "criticality": 4},
        {"criticality": 3},
    ]
    assert _finding_severity_counts(findings) == {"high": 1, "critical": 1}


def test_active_test_bank_category_wins_over_obsolete_issue_category():
    scenarios = {"scenario-a": {"id": "scenario-a", "workflow_stage": "Analysis"}}
    linked = {"scenario_id": "scenario-a", "issue_category": "Research", "category": "Research"}
    unlinked = {"issue_category": "Research", "category": "Research"}

    assert _test_bank_category(linked, scenarios) == "Analysis"
    assert _test_bank_category(unlinked, scenarios) == "Research"


def test_404_a11_uses_active_test_bank_category_over_stale_issue_category():
    scenarios = {
        "404": {
            "id": "404",
            "workflow_stage": "A-11",
            "archived": False,
        },
    }
    issue = {"id": "issue-404", "scenario_id": "404", "issue_category": "Legacy"}

    assert _test_bank_category(issue, scenarios) == "A-11"


def test_migration_replaces_only_known_municipality_paths():
    document = {
        "municipality_id": "duplicate",
        "entity_id": "duplicate",
        "nested": [{"id": "duplicate"}, {"other": "duplicate"}],
    }
    assert _migration_replace_known_municipality_paths(
        "bassett_issues", document, "duplicate", "canonical"
    ) == {
        "municipality_id": "canonical",
        "entity_id": "duplicate",
        "nested": [{"id": "duplicate"}, {"other": "duplicate"}],
    }


class _MunicipalityCursor:
    def __init__(self, records):
        self.records = records

    async def to_list(self, _limit):
        return self.records


class _MunicipalityCollection:
    def __init__(self, records):
        self.records = records

    def find(self, *_args):
        return _MunicipalityCursor(self.records)


@pytest.mark.asyncio
async def test_municipality_api_uniqueness_is_normalized_and_excludes_archived_records(monkeypatch):
    import server

    monkeypatch.setattr(server.db, "municipalities", _MunicipalityCollection([
        {"id": "m-existing", "name": "City  of Milwaukee", "state": " Wisconsin "},
        {"id": "m-archived", "name": "Archived City", "state": "WI", "archived": True},
    ]))
    with pytest.raises(server.HTTPException) as duplicate:
        await server._validate_unique_municipality({
            "name": " city of milwaukee ", "state": "WISCONSIN",
        })
    assert duplicate.value.status_code == 409
    await server._validate_unique_municipality({
        "id": "m-archived-new", "name": "Archived City", "state": "WI",
    })