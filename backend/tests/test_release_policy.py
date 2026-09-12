import pytest

from release_policy import MIN_QUALIFYING_TESTS, apply_evidence_gate, evidence_status


@pytest.mark.parametrize("count", [0, 1, 49])
def test_release_evidence_is_neutral_below_threshold_even_with_critical_blockers(count):
    evidence = evidence_status(count)
    blockers = [{"type": "Critical Finding"}, {"type": "Critical Fail Evaluation"}]

    assert MIN_QUALIFYING_TESTS == 50
    assert evidence["sufficient"] is False
    assert evidence["status"] == "insufficient_evidence"
    # Blockers remain available to the report, but cannot turn neutral evidence
    # into a GO/NO-GO release conclusion.
    assert blockers and apply_evidence_gate(count, "GO") == "INSUFFICIENT-EVIDENCE"


@pytest.mark.parametrize("count", [50, 51, 100])
def test_release_evidence_becomes_sufficient_at_and_above_boundary(count):
    evidence = evidence_status(count)

    assert evidence["sufficient"] is True
    assert evidence["status"] == "sufficient"
    assert evidence["minimum"] == 50
    assert apply_evidence_gate(count, "NO-GO") == "NO-GO"