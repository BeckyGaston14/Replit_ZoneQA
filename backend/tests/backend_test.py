"""ZoneQA Bassett Testing — Backend API tests.

Covers: auth, dashboard/analytics, CRUD (testcases, projects, findings, gold),
testcases-enriched, comparison, finding status history, config, reports data.
"""
import time
import pytest
from .live_auth import credentials, requires_live

pytestmark = requires_live


# ---------- Auth ----------
class TestAuth:
    def test_login_success(self, api_client, base_url):
        admin = credentials("admin")
        r = api_client.post(f"{base_url}/api/auth/login",
                            json=admin)
        assert r.status_code == 200
        d = r.json()
        assert "token" not in d
        assert api_client.cookies.get("zq_session")
        assert d["user"]["email"] == admin["email"].lower()
        assert d["user"]["role"] == "admin"

    def test_login_bad_password(self, api_client, base_url):
        admin = credentials("admin")
        r = api_client.post(f"{base_url}/api/auth/login",
                            json={"email": admin["email"], "password": "deliberately-incorrect"})
        assert r.status_code == 401

    def test_login_other_users(self, api_client, base_url):
        for role in ("qa_manager", "tester", "developer", "viewer"):
            account = credentials(role)
            r = api_client.post(f"{base_url}/api/auth/login", json=account)
            assert r.status_code == 200, f"{role} login failed"

    def test_me_requires_auth(self, base_url):
        import requests
        r = requests.get(f"{base_url}/api/auth/me")
        assert r.status_code == 401

    def test_me_with_token(self, auth_client, base_url):
        r = auth_client.get(f"{base_url}/api/auth/me")
        assert r.status_code == 200
        assert r.json()["email"] == credentials("admin")["email"].lower()


# ---------- Seed / lists ----------
class TestSeedData:
    def test_testcases_count(self, auth_client, base_url):
        r = auth_client.get(f"{base_url}/api/testcases")
        assert r.status_code == 200
        tcs = r.json()
        assert len(tcs) >= 10, f"expected 10 seeded testcases, got {len(tcs)}"

    def test_testcases_enriched_has_project_muni(self, auth_client, base_url):
        r = auth_client.get(f"{base_url}/api/list/testcases-enriched")
        assert r.status_code == 200
        tcs = r.json()
        assert len(tcs) >= 10
        assert any(t.get("project_name") for t in tcs)
        assert any(t.get("municipality_name") for t in tcs)
        assert any(t.get("bassett_result") for t in tcs)

    def test_projects_seeded(self, auth_client, base_url):
        r = auth_client.get(f"{base_url}/api/projects")
        assert r.status_code == 200
        assert len(r.json()) >= 4

    def test_municipalities_seeded(self, auth_client, base_url):
        r = auth_client.get(f"{base_url}/api/municipalities")
        assert r.status_code == 200
        names = {m["name"] for m in r.json()}
        assert "New York City" in names and "Franklin" in names

    def test_evidence_seeded(self, auth_client, base_url):
        r = auth_client.get(f"{base_url}/api/evidence")
        assert r.status_code == 200 and len(r.json()) >= 4

    def test_findings_seeded(self, auth_client, base_url):
        r = auth_client.get(f"{base_url}/api/findings")
        assert r.status_code == 200 and len(r.json()) >= 3

    def test_regression_runs(self, auth_client, base_url):
        r = auth_client.get(f"{base_url}/api/regression_runs")
        assert r.status_code == 200 and len(r.json()) >= 2

    def test_versions_and_models(self, auth_client, base_url):
        assert auth_client.get(f"{base_url}/api/versions").status_code == 200
        m = auth_client.get(f"{base_url}/api/models").json()
        names = {x["name"] for x in m}
        assert {"Bassett", "ChatGPT", "Claude"}.issubset(names)


# ---------- Dashboard & analytics ----------
class TestDashboard:
    def test_dashboard_stats(self, auth_client, base_url):
        r = auth_client.get(f"{base_url}/api/dashboard/stats")
        assert r.status_code == 200
        s = r.json()
        for k in ("active_projects", "bassett_passed", "bassett_failed", "bassett_accuracy",
                  "open_findings", "critical_findings", "regression_failures", "total_tests",
                  "total_findings"):
            assert k in s, f"missing {k}"
        assert s["total_tests"] >= 10
        assert s["bassett_passed"] >= 1
        assert s["bassett_failed"] >= 1
        assert isinstance(s["bassett_accuracy"], (int, float))

    def test_analytics_performance(self, auth_client, base_url):
        r = auth_client.get(f"{base_url}/api/analytics/performance")
        assert r.status_code == 200
        p = r.json()
        assert "model_summary" in p and "dimension_averages" in p and "by_category" in p
        models = {m["model"] for m in p["model_summary"]}
        assert "Bassett" in models
        # winds/losses/shared_failures present
        for k in ("wins", "losses", "shared_failures"):
            assert k in p


# ---------- Config ----------
class TestConfig:
    def test_config_get(self, auth_client, base_url):
        r = auth_client.get(f"{base_url}/api/config")
        assert r.status_code == 200
        c = r.json()
        assert "categories" in c and len(c["categories"]) > 0
        assert "finding_statuses" in c and "pass_results" in c

    def test_config_admin_update(self, auth_client, base_url):
        current = auth_client.get(f"{base_url}/api/config").json()
        cats = list(current["categories"])
        marker = f"TEST_CAT_{int(time.time())}"
        new_cats = cats + [marker]
        r = auth_client.put(f"{base_url}/api/config", json={"categories": new_cats})
        assert r.status_code == 200
        got = auth_client.get(f"{base_url}/api/config").json()
        assert marker in got["categories"]
        # cleanup
        auth_client.put(f"{base_url}/api/config", json={"categories": cats})


# ---------- CRUD flows ----------
class TestTestcaseCRUD:
    created_ids = []

    def test_create_and_full(self, auth_client, base_url):
        # need a project & muni id
        proj = auth_client.get(f"{base_url}/api/projects").json()[0]
        muni = auth_client.get(f"{base_url}/api/municipalities").json()[0]
        payload = {
            "name": "TEST_backend_created_tc",
            "project_id": proj["id"],
            "municipality_id": muni["id"],
            "category": "Zoning Code Requirements",
            "criticality": 3, "difficulty": 2,
            "status": "Draft",
            "test_type": "Single Prompt",
            "scenario": "Backend test scenario",
            "prompts": [{"turn": 1, "text": "test prompt"}],
            "expected_behaviors": [{"text": "test behavior", "status": "Met"}],
        }
        r = auth_client.post(f"{base_url}/api/testcases", json=payload)
        assert r.status_code == 200
        tc = r.json()
        assert tc["name"] == payload["name"]
        assert "id" in tc
        TestTestcaseCRUD.created_ids.append(tc["id"])

        # GET verify persistence
        got = auth_client.get(f"{base_url}/api/testcases/{tc['id']}")
        assert got.status_code == 200
        assert got.json()["name"] == payload["name"]

        # /full endpoint
        full = auth_client.get(f"{base_url}/api/testcases/{tc['id']}/full")
        assert full.status_code == 200
        f = full.json()
        assert f["testcase"]["id"] == tc["id"]
        assert f["project"]["id"] == proj["id"]
        assert isinstance(f["responses"], list)

    def test_add_response(self, auth_client, base_url):
        tid = TestTestcaseCRUD.created_ids[0]
        r = auth_client.post(f"{base_url}/api/responses", json={
            "testcase_id": tid, "model": "Bassett", "turn": 1,
            "response": "TEST_backend_response text", "citations": "TEST cite",
        })
        assert r.status_code == 200
        # verify shows up on /full
        full = auth_client.get(f"{base_url}/api/testcases/{tid}/full").json()
        assert any("TEST_backend_response" in x["response"] for x in full["responses"])

    def test_add_gold(self, auth_client, base_url):
        tid = TestTestcaseCRUD.created_ids[0]
        r = auth_client.post(f"{base_url}/api/goldstandards", json={
            "testcase_id": tid, "answer": "TEST answer", "explanation": "TEST expl",
            "prepared_by": "tester", "review_status": "Draft",
        })
        assert r.status_code == 200
        full = auth_client.get(f"{base_url}/api/testcases/{tid}/full").json()
        assert full["gold_standard"] and full["gold_standard"]["answer"] == "TEST answer"

    def test_add_evaluation(self, auth_client, base_url):
        tid = TestTestcaseCRUD.created_ids[0]
        scores = {"accuracy": 8, "citation_accuracy": 7, "interpretation": 7, "calculation": 8,
                  "context": 8, "completeness": 8, "usefulness": 8}
        overall = round(sum(scores.values()) / len(scores), 1)
        r = auth_client.post(f"{base_url}/api/evaluations", json={
            "testcase_id": tid, "model": "Bassett", "scores": scores,
            "overall_score": overall, "final_result": "Pass",
        })
        assert r.status_code == 200 and r.json()["final_result"] == "Pass"

    def test_update_delete(self, auth_client, base_url):
        tid = TestTestcaseCRUD.created_ids[0]
        r = auth_client.put(f"{base_url}/api/testcases/{tid}", json={"status": "Evaluated"})
        assert r.status_code == 200
        assert auth_client.get(f"{base_url}/api/testcases/{tid}").json()["status"] == "Evaluated"
        d = auth_client.delete(f"{base_url}/api/testcases/{tid}")
        assert d.status_code == 200
        # should now 404
        assert auth_client.get(f"{base_url}/api/testcases/{tid}").status_code == 404


# ---------- Finding status history ----------
class TestFindingStatus:
    def test_status_update_history(self, auth_client, base_url):
        findings = auth_client.get(f"{base_url}/api/findings").json()
        assert findings, "no findings seeded"
        # Pick first finding
        fid = findings[0]["id"]
        prior_status = findings[0].get("developer_status")
        r = auth_client.post(f"{base_url}/api/findings/{fid}/status", json={
            "status": "Confirmed", "root_cause": "Reasoning",
            "resolution": "TEST_backend_resolution", "note": "TEST_backend note",
        })
        assert r.status_code == 200
        after = r.json()
        assert after["developer_status"] == "Confirmed"
        assert any(h.get("to") == "Confirmed" and h.get("note") == "TEST_backend note"
                   for h in after.get("status_history", []))
        # revert
        auth_client.post(f"{base_url}/api/findings/{fid}/status",
                         json={"status": prior_status or "New", "note": "revert"})


# ---------- Comparison ----------
class TestComparison:
    def test_comparison_returns_full(self, auth_client, base_url):
        tcs = auth_client.get(f"{base_url}/api/testcases").json()
        # pick one that has evaluations
        evals = auth_client.get(f"{base_url}/api/evaluations").json()
        eval_tc_ids = {e["testcase_id"] for e in evals if e.get("model") == "Bassett"}
        tid = next(iter(eval_tc_ids))
        r = auth_client.get(f"{base_url}/api/comparison/{tid}")
        assert r.status_code == 200
        d = r.json()
        assert d["testcase"]["id"] == tid
        assert isinstance(d["responses"], list)
        assert isinstance(d["evaluations"], list)


# ---------- Unauthorized ----------
class TestNoAuth:
    def test_all_endpoints_require_auth(self, base_url):
        import requests
        endpoints = ["/api/dashboard/stats", "/api/testcases", "/api/findings",
                     "/api/analytics/performance", "/api/config", "/api/users"]
        for e in endpoints:
            r = requests.get(f"{base_url}{e}")
            assert r.status_code == 401, f"{e} did not require auth: {r.status_code}"
