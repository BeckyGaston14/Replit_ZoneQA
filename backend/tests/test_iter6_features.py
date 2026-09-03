"""
Iteration 6 backend tests — data integrity iteration for ZoneQA Bassett Testing.

Covers:
- P1  GET /api/metrics/summary (unified metrics service)
- P2  test_runs collection + response supersession preservation
- P3  /api/testcases/{id}/full includes test_runs, activities
- P4  Finding → retest workflow (start-retest + complete)
- P5  Release readiness decision (GO/CONDITIONAL/NO-GO) + role guard
- P6  Clone testcase integrity (draft variant is clean)
- P8  New testcase form fields (purpose + expected_behaviors persisted)
"""
import uuid, requests, pytest, time
from .live_auth import base_url, login_headers

BASE_URL = base_url()

PASS_SET = ("Pass", "Pass with Minor Issues")
FAIL_SET = ("Fail", "Critical Fail")


@pytest.fixture(scope="module")
def admin_headers():
    return login_headers(BASE_URL, "admin")


@pytest.fixture(scope="module")
def viewer_headers():
    return login_headers(BASE_URL, "viewer")


# ============ P1: metrics endpoint ============
class TestMetricsSummary:
    def test_metrics_summary_shape(self, admin_headers):
        r = requests.get(f"{BASE_URL}/api/metrics/summary", headers=admin_headers, timeout=30)
        assert r.status_code == 200, r.text
        m = r.json()
        # required top-level buckets
        for k in ("active_version", "test_cases", "bassett_current", "bassett_all_versions",
                  "all_model_evaluations", "bassett_avg_score", "findings", "retests"):
            assert k in m, f"missing metric key: {k}"

    def test_metrics_bassett_current_denominator(self, admin_headers):
        m = requests.get(f"{BASE_URL}/api/metrics/summary", headers=admin_headers, timeout=30).json()
        bc = m["bassett_current"]
        # As specified in the review request: 7 of 11 passed, rate 63.6, tc.total=12
        assert m["test_cases"]["total"] == 12, f"expected 12 test cases, got {m['test_cases']['total']}"
        assert bc["passed"] == 7, f"expected 7 passed, got {bc['passed']}"
        assert bc["evaluated"] == 11, f"expected 11 evaluated (denom), got {bc['evaluated']}"
        assert bc["pass_rate"] == 63.6, f"expected 63.6% pass rate, got {bc['pass_rate']}"
        assert bc["label"] == "7 of 11 passed", f"expected label '7 of 11 passed', got '{bc['label']}'"

    def test_every_metric_has_unit_and_definition(self, admin_headers):
        m = requests.get(f"{BASE_URL}/api/metrics/summary", headers=admin_headers, timeout=30).json()
        for k in ("test_cases", "bassett_current", "bassett_all_versions", "all_model_evaluations",
                  "bassett_avg_score", "findings"):
            assert "unit" in m[k], f"{k} missing 'unit'"
            assert "definition" in m[k], f"{k} missing 'definition'"

    def test_all_model_evaluations_labeled(self, admin_headers):
        m = requests.get(f"{BASE_URL}/api/metrics/summary", headers=admin_headers, timeout=30).json()
        ame = m["all_model_evaluations"]
        # unit must clearly indicate mixed models
        assert "Bassett" in ame["unit"] and "ChatGPT" in ame["unit"] and "Claude" in ame["unit"], \
            f"all_model_evaluations unit should list all models: {ame['unit']}"
        # definition warns about mixing
        assert "mix" in ame["definition"].lower() or "benchmark" in ame["definition"].lower()


# ============ P2: response supersession + test_runs ============
class TestSupersededResponses:
    def test_full_endpoint_returns_test_runs_and_all_responses(self, admin_headers):
        # pick any test case
        tcs = requests.get(f"{BASE_URL}/api/testcases", headers=admin_headers).json()
        assert tcs, "no test cases"
        tcid = tcs[0]["id"]
        r = requests.get(f"{BASE_URL}/api/testcases/{tcid}/full", headers=admin_headers, timeout=30)
        assert r.status_code == 200, r.text
        full = r.json()
        assert "test_runs" in full, "/full missing test_runs key"
        assert isinstance(full["test_runs"], list)
        assert "responses" in full, "/full missing responses"

    def test_manual_superseded_flag_is_returned(self, admin_headers):
        """
        Manually flag a response as superseded and confirm the /full endpoint still returns it
        (frontend must filter, DB must preserve). Restore original state after.
        """
        tcs = requests.get(f"{BASE_URL}/api/testcases", headers=admin_headers).json()
        tcid = None
        for t in tcs:
            full = requests.get(f"{BASE_URL}/api/testcases/{t['id']}/full", headers=admin_headers).json()
            if full.get("responses"):
                tcid = t["id"]
                target_resp = full["responses"][0]
                break
        if not tcid:
            pytest.skip("no test case has any responses")
        rid = target_resp["id"]
        original_superseded = target_resp.get("superseded", False)
        # flip
        r = requests.put(f"{BASE_URL}/api/responses/{rid}",
                         json={**target_resp, "superseded": True},
                         headers=admin_headers)
        assert r.status_code == 200, r.text
        # re-fetch
        full = requests.get(f"{BASE_URL}/api/testcases/{tcid}/full", headers=admin_headers).json()
        found = next((x for x in full["responses"] if x["id"] == rid), None)
        assert found is not None, "response missing from /full after marking superseded (backend must preserve)"
        assert found.get("superseded") is True, "superseded flag lost"
        # restore
        requests.put(f"{BASE_URL}/api/responses/{rid}",
                     json={**target_resp, "superseded": original_superseded},
                     headers=admin_headers)


# ============ P3+P4: finding → retest end-to-end ============
class TestFindingRetestLoop:
    """
    Runs the full retest scenario against the seeded 'Ready for Retest' finding.
    Per review-request: this permanently marks that finding as Fixed and is desired demo data.
    """
    @pytest.fixture(scope="class")
    def target_finding(self, admin_headers):
        r = requests.get(f"{BASE_URL}/api/findings", headers=admin_headers)
        assert r.status_code == 200
        for f in r.json():
            if f.get("developer_status") == "Ready for Retest":
                return f
        pytest.skip("no 'Ready for Retest' finding available (likely already consumed by an earlier test run)")

    def test_start_retest_captures_originals(self, admin_headers, target_finding):
        fid = target_finding["id"]
        r = requests.post(f"{BASE_URL}/api/findings/{fid}/start-retest",
                          json={"fix_description": "test fix"}, headers=admin_headers, timeout=30)
        assert r.status_code == 200, r.text
        rt = r.json()
        # captured originals
        assert "original_bassett_version" in rt
        assert "original_response" in rt
        assert "original_score" in rt
        assert "original_failure_modes" in rt
        # finding retest_status flipped
        f = requests.get(f"{BASE_URL}/api/findings/{fid}", headers=admin_headers).json()
        assert f.get("retest_status") == "In Progress", f
        # stash for next test
        target_finding["_retest_id"] = rt["id"]
        target_finding["_tc_id"] = rt["testcase_id"]

    def test_full_shows_retest_after_start(self, admin_headers, target_finding):
        assert "_tc_id" in target_finding, "start_retest test must run first"
        full = requests.get(f"{BASE_URL}/api/testcases/{target_finding['_tc_id']}/full",
                            headers=admin_headers, timeout=30).json()
        retest_ids = [r["id"] for r in full.get("retests", [])]
        assert target_finding["_retest_id"] in retest_ids, "retest should appear in testcase /full"

    def test_complete_retest_updates_finding_and_history(self, admin_headers, target_finding):
        rt_id = target_finding.get("_retest_id")
        assert rt_id, "start_retest must run first"
        fid = target_finding["id"]
        r = requests.post(f"{BASE_URL}/api/retests/{rt_id}/complete",
                          json={"verdict": "Fixed", "new_bassett_version": "Bassett v2.0",
                                "new_response": "corrected answer", "new_score": 8.5, "new_result": "Pass"},
                          headers=admin_headers, timeout=30)
        assert r.status_code == 200, r.text
        rt = r.json()
        assert rt["verdict"] == "Fixed"
        assert rt["status"] == "Completed"
        # finding must be updated
        f = requests.get(f"{BASE_URL}/api/findings/{fid}", headers=admin_headers).json()
        assert f["developer_status"] == "Fixed", f["developer_status"]
        assert f["retest_status"] == "Fixed", f["retest_status"]
        hist = f.get("status_history") or []
        assert any("retest" in (h.get("note", "").lower()) or h.get("to") == "Fixed" for h in hist), \
            f"status_history should include retest transition: {hist}"

    def test_activities_logged(self, admin_headers, target_finding):
        # activities on the testcase should mention retest
        tcid = target_finding.get("_tc_id")
        full = requests.get(f"{BASE_URL}/api/testcases/{tcid}/full", headers=admin_headers).json()
        acts = " ".join(a.get("action", "") for a in full.get("activities", []))
        assert "retest" in acts.lower(), f"expected retest activity, got: {acts[:400]}"


# ============ P5: release readiness decision ============
class TestReleaseDecision:
    def test_admin_can_record_decision(self, admin_headers):
        # Synthetic version — never overwrites the real v1.9 decision record
        version = "Bassett vTEST-decision"
        r = requests.post(f"{BASE_URL}/api/release-readiness/decision",
                          json={"version": version, "decision": "GO",
                                "notes": "TEST_iter6 decision — structured rationale exceeding twenty characters for override compliance",
                                "risk_accepted": True},
                          headers=admin_headers, timeout=30)
        assert r.status_code == 200, r.text
        d = r.json()
        assert d["decision"] == "GO"
        assert d["decided_by"]
        assert d["decided_at"]
        # verify displayed on GET /api/release-readiness
        rr = requests.get(f"{BASE_URL}/api/release-readiness", params={"version": version},
                          headers=admin_headers).json()
        assert rr.get("decision", {}).get("decision") == "GO", rr.get("decision")

    def test_viewer_forbidden(self, viewer_headers):
        m = requests.get(f"{BASE_URL}/api/metrics/summary", headers=viewer_headers).json()
        version = m.get("active_version") or "Bassett v1.9"
        r = requests.post(f"{BASE_URL}/api/release-readiness/decision",
                          json={"version": version, "decision": "GO", "notes": "should fail"},
                          headers=viewer_headers, timeout=30)
        assert r.status_code == 403, f"viewer should be forbidden, got {r.status_code}"

    def test_invalid_decision_rejected(self, admin_headers):
        m = requests.get(f"{BASE_URL}/api/metrics/summary", headers=admin_headers).json()
        version = m.get("active_version") or "Bassett v1.9"
        r = requests.post(f"{BASE_URL}/api/release-readiness/decision",
                          json={"version": version, "decision": "MAYBE"},
                          headers=admin_headers, timeout=30)
        assert r.status_code == 400


# ============ P6: clone integrity ============
class TestCloneIntegrity:
    def test_clone_has_no_eval_response_finding_retest(self, admin_headers):
        # pick an evaluated test
        tcs = requests.get(f"{BASE_URL}/api/testcases", headers=admin_headers).json()
        source_id = None
        for t in tcs:
            full = requests.get(f"{BASE_URL}/api/testcases/{t['id']}/full", headers=admin_headers).json()
            if full.get("evaluations") and full.get("responses"):
                source_id = t["id"]
                break
        assert source_id, "need at least one evaluated testcase with responses"
        # clone
        r = requests.post(f"{BASE_URL}/api/testcases/{source_id}/clone",
                          json={"name": f"TEST_iter6_clone_{uuid.uuid4().hex[:6]}"},
                          headers=admin_headers, timeout=30)
        assert r.status_code == 200, r.text
        clone = r.json()
        clone_id = clone["id"]
        try:
            assert clone.get("status") == "Draft", f"clone status should be Draft, got {clone.get('status')}"
            assert clone.get("variant_of") == source_id
            full = requests.get(f"{BASE_URL}/api/testcases/{clone_id}/full", headers=admin_headers).json()
            assert full.get("evaluations") == [], f"clone should have no evaluations: {full.get('evaluations')}"
            assert full.get("responses") == [], f"clone should have no responses: {full.get('responses')}"
            assert full.get("findings") == [], f"clone should have no findings"
            assert full.get("retests") == [], f"clone should have no retests"
            # gold copied as Draft
            gold = full.get("gold_standard")
            if gold:
                assert gold.get("review_status") == "Draft", f"cloned gold should be Draft, got {gold.get('review_status')}"
        finally:
            # cleanup: delete clone and its draft gold
            if full.get("gold_standard"):
                requests.delete(f"{BASE_URL}/api/goldstandards/{full['gold_standard']['id']}",
                                headers=admin_headers)
            requests.delete(f"{BASE_URL}/api/testcases/{clone_id}", headers=admin_headers)
            # verify deleted
            g = requests.get(f"{BASE_URL}/api/testcases/{clone_id}", headers=admin_headers)
            assert g.status_code == 404, "cleanup: clone should be deleted"


# ============ P8: new-testcase form fields persistence ============
class TestNewTestcaseForm:
    def test_purpose_and_expected_behaviors_persisted(self, admin_headers):
        payload = {
            "name": f"TEST_iter6_form_{uuid.uuid4().hex[:6]}",
            "purpose": "Verify P8 form separates Test Purpose from Scenario",
            "scenario": "Given the test scenario",
            "criticality": 3, "difficulty": 2, "status": "Draft",
            "prompts": [{"turn": 1, "text": "prompt one"}],
            "expected_behaviors": [
                {"text": "Behavior A", "status": "Not Met"},
                {"text": "Behavior B", "status": "Not Met"},
                {"text": "Behavior C", "status": "Not Met"},
            ],
        }
        r = requests.post(f"{BASE_URL}/api/testcases", json=payload, headers=admin_headers, timeout=30)
        assert r.status_code == 200, r.text
        tc = r.json()
        tcid = tc["id"]
        try:
            got = requests.get(f"{BASE_URL}/api/testcases/{tcid}", headers=admin_headers).json()
            assert got.get("purpose") == payload["purpose"], got.get("purpose")
            assert got.get("scenario") == payload["scenario"]
            assert len(got.get("expected_behaviors") or []) == 3
            assert got["expected_behaviors"][0]["text"] == "Behavior A"
        finally:
            requests.delete(f"{BASE_URL}/api/testcases/{tcid}", headers=admin_headers)
