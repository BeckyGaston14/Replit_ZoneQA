import pytest
from fastapi import HTTPException

import server


@pytest.mark.parametrize(
    ("resource", "payload", "missing"),
    [
        ("projects", {}, "name"),
        ("municipalities", {"name": "QA City"}, "state"),
        ("properties", {"name": "QA Parcel", "address": "1 Test Way"}, "municipality_id"),
        ("evidence", {"document_name": "QA Ordinance"}, "municipality_id"),
        ("demos", {"testcase_id": "tc-1"}, "why_good"),
        ("models", {}, "name"),
    ],
)
def test_api_rejects_missing_required_resource_fields(resource, payload, missing):
    with pytest.raises(HTTPException) as exc:
        server._validate_resource_required_fields(resource, payload)
    assert exc.value.status_code == 400
    assert exc.value.detail[missing].endswith("is required")


@pytest.mark.parametrize(
    ("resource", "payload"),
    [
        ("projects", {"name": "QA Project"}),
        ("municipalities", {"name": "QA City", "state": "MI"}),
        ("properties", {"name": "QA Parcel", "address": "1 Test Way", "municipality_id": "m-1"}),
        ("evidence", {"document_name": "QA Ordinance", "municipality_id": "m-1"}),
        ("demos", {"testcase_id": "tc-1", "why_good": "Clear and accurate"}),
        ("models", {"name": "QA Model"}),
    ],
)
def test_api_accepts_complete_required_resource_fields(resource, payload):
    server._validate_resource_required_fields(resource, payload)


def test_partial_updates_validate_the_merged_record_shape():
    existing = {"name": "QA City", "state": "MI"}
    server._validate_resource_required_fields("municipalities", {**existing, "state": "NY"})
    with pytest.raises(HTTPException) as exc:
        server._validate_resource_required_fields("municipalities", {**existing, "name": "   "})
    assert exc.value.detail == {"name": "Municipality name is required"}


def test_score_preview_has_one_writer_only_route():
    routes = [
        route
        for route in server.api.routes
        if getattr(route, "path", None) == "/api/evaluations/score-preview"
        and "POST" in getattr(route, "methods", ())
    ]
    assert len(routes) == 1
    assert [dependency.call for dependency in routes[0].dependant.dependencies] == [server.require_writer]