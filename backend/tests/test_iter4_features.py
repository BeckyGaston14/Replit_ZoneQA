"""Iteration 4 backend tests:
- GET /api/analytics/coverage  (test coverage gaps)
- GET /api/analytics/competitive (head-to-head insights)
- GET /api/calendar/all-events (aggregated calendar)
- POST/DELETE /api/calendar_events (CRUD + role gate)
"""
import pytest
import requests
from .live_auth import base_url, login_headers, requires_live

pytestmark = requires_live

BASE_URL = base_url()


# ---------- Coverage ----------
class TestCoverage:
    def test_coverage_shape_and_gaps(self, auth_client):
        r = auth_client.get(f"{BASE_URL}/api/analytics/coverage")
        assert r.status_code == 200, r.text
        d = r.json()
        # top-level keys
        for k in ("municipalities", "categories", "criticality", "summary"):
            assert k in d
        s = d["summary"]

        # Municipalities: 4 total, all covered
        assert s["munis_total"] == 4, f"expected 4 munis, got {s['munis_total']}"
        assert s["munis_covered"] == 4, f"all 4 munis should have tests, got {s['munis_covered']}"

        # Categories: 11 total, 4 with 0 tests
        assert s["categories_total"] == 11, f"expected 11 categories, got {s['categories_total']}"
        assert s["categories_covered"] == 7, f"expected 7 categories covered (11-4), got {s['categories_covered']}"

        # Criticality: 5 levels, level 1 & 2 have 0 tests -> 3 covered
        assert s["crit_covered"] == 3, f"expected 3 crit levels covered, got {s['crit_covered']}"

        # Total gaps: 0 muni + 4 category + 2 criticality = 6
        assert s["gap_count"] == 6, f"expected gap_count=6, got {s['gap_count']}"

    def test_coverage_specific_gap_categories(self, auth_client):
        d = auth_client.get(f"{BASE_URL}/api/analytics/coverage").json()
        zero_cats = {c["category"] for c in d["categories"] if c["tests"] == 0}
        expected = {"Municipal Research", "Compliance", "Agency / Due Diligence", "Workflow / UX"}
        assert expected.issubset(zero_cats), f"missing expected gap categories: expected={expected}, actual={zero_cats}"

    def test_coverage_criticality_gaps(self, auth_client):
        d = auth_client.get(f"{BASE_URL}/api/analytics/coverage").json()
        zero_lvls = {c["level"] for c in d["criticality"] if c["tests"] == 0}
        assert 1 in zero_lvls and 2 in zero_lvls, f"expected levels 1 & 2 to be gaps, actual gaps={zero_lvls}"

    def test_coverage_requires_auth(self):
        r = requests.get(f"{BASE_URL}/api/analytics/coverage")
        assert r.status_code in (401, 403)


# ---------- Competitive ----------
class TestCompetitive:
    def test_competitive_shape(self, auth_client):
        r = auth_client.get(f"{BASE_URL}/api/analytics/competitive")
        assert r.status_code == 200, r.text
        d = r.json()
        for k in ("records", "losses", "wins", "dimension_comparison", "summary"):
            assert k in d
        assert set(d["records"].keys()) == {"ChatGPT", "Claude"}
        for m in ("ChatGPT", "Claude"):
            for kk in ("wins", "losses", "ties"):
                assert kk in d["records"][m]

    def test_competitive_losses_and_wins_counts(self, auth_client):
        d = auth_client.get(f"{BASE_URL}/api/analytics/competitive").json()
        # PS says 2 losses (Sterling Heights delta 3.5 to Claude, NYC Midtown delta 3.2 to ChatGPT), 4 wins
        assert d["summary"]["losses"] == 2, f"expected 2 losses, got {d['summary']['losses']}"
        assert d["summary"]["wins"] == 4, f"expected 4 wins, got {d['summary']['wins']}"
        assert len(d["losses"]) == 2
        assert len(d["wins"]) == 4

    def test_competitive_specific_loss_deltas(self, auth_client):
        d = auth_client.get(f"{BASE_URL}/api/analytics/competitive").json()
        losses = d["losses"]
        by_delta = {round(l["delta"], 1): l for l in losses}
        # Verify the 2 documented losses roughly (allow small drift)
        deltas = sorted(by_delta.keys(), reverse=True)
        assert deltas[0] >= 3.0, f"worst delta should be >=3.0, got {deltas}"
        # Ensure each loss has dimension_gaps + bassett/benchmark notes
        for l in losses:
            assert "dimension_gaps" in l and isinstance(l["dimension_gaps"], list)
            assert "benchmark_notes" in l
            assert "bassett_notes" in l
            assert "benchmark_model" in l
            assert l["benchmark_model"] in ("ChatGPT", "Claude")
            assert l["delta"] > 0

    def test_competitive_dimension_comparison(self, auth_client):
        d = auth_client.get(f"{BASE_URL}/api/analytics/competitive").json()
        dc = d["dimension_comparison"]
        assert len(dc) > 0
        for row in dc:
            assert {"dim", "bassett", "benchmark", "gap"}.issubset(row.keys())

    def test_competitive_win_records_math(self, auth_client):
        d = auth_client.get(f"{BASE_URL}/api/analytics/competitive").json()
        # summary wins should equal number of test cases where bassett beat max benchmark
        assert len(d["wins"]) == d["summary"]["wins"]
        assert len(d["losses"]) == d["summary"]["losses"]

    def test_competitive_requires_auth(self):
        r = requests.get(f"{BASE_URL}/api/analytics/competitive")
        assert r.status_code in (401, 403)


# ---------- Calendar ----------
class TestCalendar:
    def test_all_events_aggregates(self, auth_client):
        r = auth_client.get(f"{BASE_URL}/api/calendar/all-events")
        assert r.status_code == 200, r.text
        events = r.json()
        assert isinstance(events, list) and len(events) > 0
        # types present
        types = {e["type"] for e in events}
        # expect at least project_start, release, regression among aggregated
        assert "project_start" in types or "deadline" in types
        assert "release" in types
        assert "regression" in types

    def test_all_events_readonly_flags(self, auth_client):
        events = auth_client.get(f"{BASE_URL}/api/calendar/all-events").json()
        # readonly True for aggregated docs, False for calendar_events
        for e in events:
            assert "readonly" in e
        # There should be at least 2 seeded calendar_events (readonly False)
        editable = [e for e in events if e["readonly"] is False]
        assert len(editable) >= 2, f"expected >=2 seeded custom events, got {len(editable)}"

    def test_all_events_seeded_specifics(self, auth_client):
        events = auth_client.get(f"{BASE_URL}/api/calendar/all-events").json()
        editable = [e for e in events if e["readonly"] is False]
        dates = {e["date"] for e in editable}
        assert "2026-08-21" in dates, f"expected v2.0 regression run 2026-08-21 in editable events: {dates}"
        assert "2026-09-04" in dates, f"expected Q3 release readiness review 2026-09-04 in editable events: {dates}"

    def test_all_events_sorted_by_date(self, auth_client):
        events = auth_client.get(f"{BASE_URL}/api/calendar/all-events").json()
        dates = [e["date"] for e in events]
        assert dates == sorted(dates)

    def test_calendar_event_crud_admin(self, auth_client):
        # CREATE
        payload = {"title": "TEST_iter4 event", "date": "2026-12-15", "event_type": "milestone",
                   "notes": "auto-cleanup"}
        create = auth_client.post(f"{BASE_URL}/api/calendar_events", json=payload)
        assert create.status_code in (200, 201), create.text
        obj = create.json()
        assert obj["title"] == payload["title"]
        eid = obj["id"]

        # Verify shows up in aggregated feed
        events = auth_client.get(f"{BASE_URL}/api/calendar/all-events").json()
        found = [e for e in events if e["id"] == eid]
        assert found, f"created event {eid} not in /calendar/all-events"
        assert found[0]["readonly"] is False
        assert found[0]["date"] == "2026-12-15"
        assert found[0]["label"] == "TEST_iter4 event"

        # DELETE
        d = auth_client.delete(f"{BASE_URL}/api/calendar_events/{eid}")
        assert d.status_code in (200, 204), d.text

        # Verify gone
        events2 = auth_client.get(f"{BASE_URL}/api/calendar/all-events").json()
        assert not [e for e in events2 if e["id"] == eid], "event still present after delete"

    def test_calendar_event_viewer_forbidden(self, api_client):
        s = requests.Session()
        s.headers.update(login_headers(BASE_URL, "viewer"))
        # viewer can GET aggregate
        assert s.get(f"{BASE_URL}/api/calendar/all-events").status_code == 200
        # viewer cannot POST
        r2 = s.post(f"{BASE_URL}/api/calendar_events",
                    json={"title": "viewer attempt", "date": "2026-12-20", "event_type": "milestone"})
        assert r2.status_code == 403, f"viewer POST should be 403, got {r2.status_code}"

    def test_calendar_all_events_requires_auth(self):
        r = requests.get(f"{BASE_URL}/api/calendar/all-events")
        assert r.status_code in (401, 403)
