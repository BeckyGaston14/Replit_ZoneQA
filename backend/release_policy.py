"""Authoritative release evidence policy shared by API/report calculations."""

MIN_QUALIFYING_TESTS = 50


def evidence_status(evaluated: int) -> dict:
    """Return neutral evidence status until the minimum qualifying population."""
    count = max(0, int(evaluated or 0))
    return {
        "evaluated": count,
        "minimum": MIN_QUALIFYING_TESTS,
        "label": f"{count} of {MIN_QUALIFYING_TESTS} qualifying tests completed",
        "sufficient": count >= MIN_QUALIFYING_TESTS,
        "status": "sufficient" if count >= MIN_QUALIFYING_TESTS else "insufficient_evidence",
    }


def apply_evidence_gate(evaluated: int, recommendation: str) -> str:
    """Prevent any release recommendation, especially GO, below the minimum."""
    return "INSUFFICIENT-EVIDENCE" if not evidence_status(evaluated)["sufficient"] else recommendation