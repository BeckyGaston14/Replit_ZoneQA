"""Isolated regression checks for audited QA workflow rules.

These tests exercise pure helpers only; they do not connect to PostgreSQL or
call the running preview API.
"""

import pytest
from fastapi import HTTPException

from server import (
    _finding_is_open,
    _model_run_state,
    _require_retest_target_status,
    _validate_finding_status,
    _validate_and_normalize_testcase,
)


@pytest.mark.parametrize(
    ("status", "expected"),
    [
        ("New", True),
        ("In Development", True),
        ("Ready for Retest", True),
        ("Fixed", False),
        ("Closed", False),
        ("Won't Fix", False),
        ("Duplicate", False),
    ],
)
def test_finding_open_definition(status, expected):
    assert _finding_is_open({"developer_status": status}) is expected


@pytest.mark.parametrize(
    ("results", "expected"),
    [
        ({"Bassett": {"ok": True}}, ("Completed", "Success")),
        (
            {"Bassett": {"ok": True}, "Claude": {"ok": False}},
            ("Completed with Errors", "Partial"),
        ),
        (
            {"Bassett": {"ok": False}, "Claude": {"ok": False}},
            ("Failed", "Failure"),
        ),
    ],
)
def test_model_run_state_is_truthful(results, expected):
    assert _model_run_state(results) == expected


def test_finding_status_validation_rejects_unknown_values():
    with pytest.raises(HTTPException) as exc:
        _validate_finding_status("Invented", ["New", "Fixed"])
    assert exc.value.status_code == 400


def test_finding_status_validation_normalizes_whitespace():
    assert _validate_finding_status("  New ", ["New", "Fixed"]) == "New"


def test_retest_target_must_exist_in_configured_statuses():
    with pytest.raises(HTTPException) as exc:
        _require_retest_target_status("In Development", ["New", "Fixed"])
    assert exc.value.status_code == 409
    assert "not configured" in exc.value.detail


def test_retest_target_accepts_configured_status():
    assert _require_retest_target_status("Confirmed", ["New", "Confirmed"]) == "Confirmed"


def test_testcase_input_is_normalized():
    document = {
        "name": "  Height limit  ",
        "prompts": [
            {"turn": 9, "text": "  What is the height limit?  "},
            {"turn": 9, "text": "   "},
            "List the source.",
        ],
    }

    _validate_and_normalize_testcase(document)

    assert document["name"] == "Height limit"
    assert document["prompts"] == [
        {"turn": 1, "text": "What is the height limit?"},
        {"turn": 2, "text": "List the source."},
    ]


@pytest.mark.parametrize(
    "document",
    [
        {"name": "", "prompts": [{"text": "A prompt"}]},
        {"name": "Named", "prompts": []},
        {"name": "Named", "prompts": [{"text": "   "}]},
    ],
)
def test_testcase_input_rejects_missing_essentials(document):
    with pytest.raises(HTTPException) as exc:
        _validate_and_normalize_testcase(document)
    assert exc.value.status_code == 400