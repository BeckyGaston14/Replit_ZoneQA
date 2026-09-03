"""Iteration 9: final consistency & data-integrity pass."""
import pytest
from .live_auth import login_headers

VARIANT_NAME = "NYC C5-3 retail permitted use (Variant)"


@pytest.fixture(scope="module")
def viewer_client(api_client, base_url):
    import requests
    s = requests.Session()
    s.headers.update(login_headers(base_url, "viewer"))
    return s


class TestMetricReconciliation:
    def test_all_surfaces_report_same_bassett_average(self, auth_client, base_url):
        dash = auth_client.get(f"{base_url}/api/dashboard/stats").json()
        metrics = auth_client.get(f"{base_url}/api/metrics/summary").json()
        perf = auth_client.get(f"{base_url}/api/analytics/performance").json()
        execu = auth_client.get(f"{base_url}/api/analytics/executive").json()
        b = next(m for m in perf["model_summary"] if m["model"] == "Bassett")
        vals = {"dashboard": dash["bassett_accuracy"], "metrics": metrics["bassett_avg_score"]["value"],
                "performance": b["avg_score"], "executive": execu["kpis"]["bassett_avg"]}
        assert len(set(vals.values())) == 1, f"Metric mismatch: {vals}"

    def test_pass_fail_counts_reconcile(self, auth_client, base_url):
        dash = auth_client.get(f"{base_url}/api/dashboard/stats").json()
        perf = auth_client.get(f"{base_url}/api/analytics/performance").json()
        b = next(m for m in perf["model_summary"] if m["model"] == "Bassett")
        assert dash["bassett_passed"] == b["passed"] and dash["bassett_failed"] == b["failed"]

    def test_performance_scope_string(self, auth_client, base_url):
        perf = auth_client.get(f"{base_url}/api/analytics/performance").json()
        assert perf["scope"].startswith("Latest non-retest evaluation for each test case")

    def test_performance_filters(self, auth_client, base_url):
        allv = auth_client.get(f"{base_url}/api/analytics/performance").json()
        novar = auth_client.get(f"{base_url}/api/analytics/performance?include_variants=false").json()
        b_all = next(m for m in allv["model_summary"] if m["model"] == "Bassett")
        b_nv = next(m for m in novar["model_summary"] if m["model"] == "Bassett")
        assert (b_nv["passed"] + b_nv["failed"]) < (b_all["passed"] + b_all["failed"]), "variant exclusion should shrink denominator"
        assert "variants excluded" in novar["scope"]
        ver = auth_client.get(f"{base_url}/api/analytics/performance?version=Bassett%20v1.9").json()
        assert "Bassett version: Bassett v1.9" in ver["scope"]


class TestRetestCanonical:
    def test_two_completed_retests(self, auth_client, base_url):
        m = auth_client.get(f"{base_url}/api/metrics/summary").json()
        assert m["retests"]["total"] == 2
        assert m["retests"]["completed"] == 2

    def test_retests_have_canonical_fields(self, auth_client, base_url):
        for rt in auth_client.get(f"{base_url}/api/retests").json():
            if rt.get("status") == "Completed":
                for k in ("outcome", "completed_at", "reviewer", "new_bassett_version", "new_environment"):
                    assert rt.get(k), f"completed retest missing {k}: {rt['id']}"
                assert rt["outcome"] in ("Fixed", "Partially Fixed", "Not Fixed", "New Regression Introduced", "Unable to Verify")


class TestReleaseDecisionSnapshot:
    def test_decision_has_immutable_snapshot(self, auth_client, base_url):
        r = auth_client.get(f"{base_url}/api/release-readiness", params={"version": "Bassett v1.9"}).json()
        dec = r["decision"]
        assert dec and dec.get("snapshot"), "decision must carry a snapshot"
        snap = dec["snapshot"]
        for k in ("version", "environment", "decision_date", "system_recommendation", "pass_rate", "evaluated",
                  "failed", "avg_score", "open_findings", "critical_fail_evals", "blocker_count", "blockers"):
            assert k in snap, f"snapshot missing {k}"
        assert snap["blocker_count"] == len(snap["blockers"]) > 0
        for b in snap["blockers"]:
            assert b.get("type") and b.get("label")

    def test_threshold_failure_is_a_blocker(self, auth_client, base_url):
        r = auth_client.get(f"{base_url}/api/release-readiness", params={"version": "Bassett v1.9"}).json()
        if r["pass_rate"] < 70:
            assert any(b["type"] == "Threshold Failure" for b in r["blockers"]), "pass-rate threshold must appear as a blocker"

    def test_state_changed_flag_present(self, auth_client, base_url):
        r = auth_client.get(f"{base_url}/api/release-readiness", params={"version": "Bassett v1.9"}).json()
        assert "state_changed" in r["decision"]
        # Snapshot was recorded from the current state, so it should not be flagged stale right now
        assert r["decision"]["state_changed"] is False, r["decision"].get("state_changed_detail")


class TestRegressionBaseline:
    def test_no_baseline_run_reports_na_not_zero(self, auth_client, base_url):
        runs = auth_client.get(f"{base_url}/api/regression_runs").json()
        snap_runs = [r for r in runs if r.get("results")]
        no_base = [r for r in snap_runs if not r.get("baseline_run_id")]
        assert no_base, "expected at least one snapshot run without baseline"
        for r in no_base:
            assert r["improved"] is None and r["worsened"] is None and r["newly_failing"] is None, \
                "comparison aggregates must be None (N/A) without a baseline, never 0"

    def test_run_with_baseline_computes_comparison(self, auth_client, base_url):
        suites = auth_client.get(f"{base_url}/api/regression_suites").json()
        sid = suites[0]["id"]
        r = auth_client.post(f"{base_url}/api/regression/suites/{sid}/execute",
                             json={"bassett_version": "Bassett v2.0", "environment": "Staging", "notes": "iter9 pytest baseline check"})
        assert r.status_code == 200
        run = r.json()
        assert run["baseline_run_id"] and isinstance(run["improved"], int) and isinstance(run["worsened"], int)
        assert all(x["delta"] in ("improved", "regressed", "still_pass", "still_fail", "unchanged", "not_evaluated", "new") for x in run["results"])
        # cleanup (admin may delete locked runs)
        assert auth_client.delete(f"{base_url}/api/regression_runs/{run['id']}").status_code == 200


class TestVariantIndependence:
    def test_variant_has_own_run_and_evaluation(self, auth_client, base_url):
        tcs = auth_client.get(f"{base_url}/api/testcases").json()
        variant = next(t for t in tcs if t["name"] == VARIANT_NAME)
        full = auth_client.get(f"{base_url}/api/testcases/{variant['id']}/full").json()
        assert len(full["test_runs"]) >= 1, "variant must own a Test Run record"
        evs = [e for e in full["evaluations"] if e["model"] == "Bassett"]
        assert evs and evs[-1]["testcase_id"] == variant["id"]
        assert evs[-1].get("environment") and evs[-1].get("bassett_version")
        assert all(r["testcase_id"] == variant["id"] for r in full["responses"])


class TestStaleGoldPropagation:
    def test_full_and_comparison_flag_stale_gold(self, auth_client, base_url):
        tcs = auth_client.get(f"{base_url}/api/testcases").json()
        nyc = next(t for t in tcs if t["name"] == "NYC C5-3 retail permitted use")
        full = auth_client.get(f"{base_url}/api/testcases/{nyc['id']}/full").json()
        assert full["gold_stale"] is True and full["gold_stale_evidence"]
        cmp_ = auth_client.get(f"{base_url}/api/comparison/{nyc['id']}").json()
        assert cmp_["gold_stale"] is True

    def test_readiness_and_executive_list_stale_gold(self, auth_client, base_url):
        r = auth_client.get(f"{base_url}/api/release-readiness", params={"version": "Bassett v1.9"}).json()
        assert any("NYC" in t["name"] for t in r["stale_gold_tests"])
        e = auth_client.get(f"{base_url}/api/analytics/executive").json()
        assert any("NYC" in t["name"] for t in e["stale_gold_tests"])

    def test_enriched_list_flags_stale(self, auth_client, base_url):
        tcs = auth_client.get(f"{base_url}/api/list/testcases-enriched").json()
        assert any(t.get("gold_stale") for t in tcs)


class TestActivityHygiene:
    def test_default_feed_excludes_automated_records(self, auth_client, base_url):
        acts = auth_client.get(f"{base_url}/api/activities").json()
        joined = " | ".join(f"{a.get('action', '')} {a.get('detail', '')}" for a in acts)
        for pat in ("pytest", "TEST_iter", "curl smoke", "iter6 test decision"):
            assert pat not in joined, f"automated pattern '{pat}' leaked into default feed"

    def test_admin_can_view_automated_records(self, auth_client, base_url):
        default = auth_client.get(f"{base_url}/api/activities").json()
        with_test = auth_client.get(f"{base_url}/api/activities", params={"include_test_data": "true"}).json()
        assert len(with_test) >= len(default)


class TestIntegrityEndpoint:
    def test_admin_gets_structured_report(self, auth_client, base_url):
        r = auth_client.get(f"{base_url}/api/admin/integrity")
        assert r.status_code == 200
        d = r.json()
        assert set(d["counts"]) == {"high", "medium", "low"}
        for i in d["issues"]:
            assert set(i) >= {"entity_type", "entity_id", "name", "problem", "severity", "repair", "link"}
        # dashboard reconciliation must NOT be flagged anymore
        assert not any(i["entity_type"] == "metrics" for i in d["issues"]), \
            [i["problem"] for i in d["issues"] if i["entity_type"] == "metrics"]

    def test_viewer_forbidden(self, viewer_client, base_url):
        assert viewer_client.get(f"{base_url}/api/admin/integrity").status_code == 403
