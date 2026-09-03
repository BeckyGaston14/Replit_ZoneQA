"""Evaluation score calculations remain authoritative and configuration-backed."""

import asyncio
import math

import pytest
from fastapi import HTTPException

import server


class _Config:
    async def find_one(self, *_args, **_kwargs):
        return {
            "eval_dimensions": [
                {"key": "accuracy", "weight": 2},
                {"key": "usefulness", "weight": 1},
            ],
        }


class _Db:
    config = _Config()


def test_weighted_score_and_recommendation_use_configured_dimensions(monkeypatch):
    monkeypatch.setattr(server, "db", _Db())
    result = asyncio.run(server._evaluation_score_fields({"accuracy": 9, "usefulness": 6}))
    assert result["overall_score"] == 8.0
    assert result["weighted_score"] == 8.0
    assert result["system_recommended"] == "Pass with Minor Issues"
    assert "Weighted dimension average 8.0/10" in result["system_explanation"]


def test_unscored_evaluation_is_not_enough_evidence(monkeypatch):
    monkeypatch.setattr(server, "db", _Db())
    result = asyncio.run(server._evaluation_score_fields({"accuracy": None}))
    assert result["overall_score"] is None
    assert result["system_recommended"] == "Not Enough Evidence"


def test_score_values_outside_zero_to_ten_are_rejected(monkeypatch):
    monkeypatch.setattr(server, "db", _Db())
    with pytest.raises(HTTPException) as exc:
        asyncio.run(server._evaluation_score_fields({"accuracy": 11}))
    assert exc.value.status_code == 400


@pytest.mark.parametrize("scores", [
    {"invented_dimension": 10},
    {"accuracy": float("nan")},
    {"accuracy": float("inf")},
    ["not", "an", "object"],
])
def test_malformed_or_unconfigured_scores_are_rejected(monkeypatch, scores):
    monkeypatch.setattr(server, "db", _Db())
    with pytest.raises(HTTPException) as exc:
        asyncio.run(server._evaluation_score_fields(scores))
    assert exc.value.status_code == 400


def test_client_derived_fields_are_ignored_even_without_scores(monkeypatch):
    monkeypatch.setattr(server, "db", _Db())
    incoming = {
        "overall_score": 10,
        "weighted_score": 10,
        "system_recommended": "Pass",
        "system_explanation": "Client supplied",
    }
    result = asyncio.run(server._apply_authoritative_evaluation_fields(incoming))
    assert result["overall_score"] is None
    assert result["weighted_score"] is None
    assert result["system_recommended"] == "Not Enough Evidence"
    assert result["system_explanation"] == "No scored dimensions."


def test_update_recomputes_from_existing_scores_when_scores_are_omitted(monkeypatch):
    monkeypatch.setattr(server, "db", _Db())
    incoming = {"notes": "Reviewer clarification", "overall_score": 1}
    existing = {"scores": {"accuracy": 9, "usefulness": 6}}
    result = asyncio.run(server._apply_authoritative_evaluation_fields(incoming, existing))
    assert result["overall_score"] == 8.0
    assert result["system_recommended"] == "Pass with Minor Issues"