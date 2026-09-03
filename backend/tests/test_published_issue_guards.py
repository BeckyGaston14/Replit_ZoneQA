import asyncio

import pytest

import server


def test_dashboard_activity_summary_hides_json_uuids_and_emails():
    activity = {
        "id": "a1",
        "entity_type": "users",
        "entity_id": "d3b3500b-d91c-42c0-88d9-989d2e0f6a02",
        "action": "welcome email sent to person@example.com for d3b3500b-d91c-42c0-88d9-989d2e0f6a02",
        "detail": '{"previous_email":"deleted@example.com"}',
        "user": "admin@example.com",
        "created_at": "2026-09-02T12:00:00Z",
    }
    public = server._public_activity(activity, "viewer")
    assert "{" not in public["summary"]
    assert "d3b3500b" not in public["summary"]
    assert "person@example.com" not in public["summary"]
    assert public["user"] == "a***@example.com"
    assert public["audit_detail_available"] is False
    assert "detail" not in public and "entity_id" not in public


def test_admin_audit_detail_masks_sensitive_email_fields():
    detail = server._safe_audit_value({
        "previous_email": "deleted@example.com",
        "recipient_email": "person@example.com",
        "note": "Contact owner@example.com",
    })
    assert detail["previous_email"] == "[masked]"
    assert detail["recipient_email"] == "[masked]"
    assert detail["note"] == "Contact o***@example.com"


def test_regression_execution_date_prefers_recorded_run_date():
    run = {"run_date": "2026-08-30", "created_at": "2026-08-31T23:30:00Z"}
    assert server._regression_execution_date(run) == "2026-08-30"
    assert server._regression_execution_date({"created_at": "2026-08-31T23:30:00Z"}) == "2026-08-31"


def test_audit_detail_route_is_admin_only():
    routes = [
        route for route in server.api.routes
        if getattr(route, "path", None) == "/api/activities/{id}"
        and "GET" in getattr(route, "methods", ())
    ]
    assert len(routes) == 1
    dependency = routes[0].dependant.dependencies[0].call
    with pytest.raises(Exception) as exc:
        asyncio.run(dependency({"role": "qa_manager"}))
    assert getattr(exc.value, "status_code", None) == 403