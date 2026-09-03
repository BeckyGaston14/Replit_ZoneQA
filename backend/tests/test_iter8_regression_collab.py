"""Iteration 8: Operational regression suites + assignments + threaded comments."""
import pytest

pytestmark = []


@pytest.fixture(scope="module")
def suite_id(auth_client, base_url):
    r = auth_client.get(f"{base_url}/api/regression_suites")
    assert r.status_code == 200
    suites = r.json()
    assert suites, "Expected seeded regression suite"
    return suites[0]["id"]


@pytest.fixture(scope="module")
def tc_id(auth_client, base_url):
    r = auth_client.get(f"{base_url}/api/testcases")
    return r.json()[0]["id"]


@pytest.fixture(scope="module")
def tester_user(auth_client, base_url):
    users = auth_client.get(f"{base_url}/api/users").json()
    return next(u for u in users if u["role"] == "tester")


# ---------- Regression suite execution ----------

class TestRegressionExecution:
    def test_execute_requires_version(self, auth_client, base_url, suite_id):
        r = auth_client.post(f"{base_url}/api/regression/suites/{suite_id}/execute", json={})
        assert r.status_code == 400

    def test_execute_creates_locked_snapshot_run(self, auth_client, base_url, suite_id):
        r = auth_client.post(f"{base_url}/api/regression/suites/{suite_id}/execute",
                             json={"bassett_version": "Bassett v2.0", "environment": "Staging", "notes": "pytest run"})
        assert r.status_code == 200, r.text
        run = r.json()
        assert run["locked"] is True
        assert run["total"] == len(run["results"]) > 0
        assert run["passed"] + run["failed"] + run["not_evaluated"] <= run["total"]
        for res in run["results"]:
            assert set(res) >= {"testcase_id", "testcase_name", "result", "score", "baseline_result", "delta"}
            assert res["delta"] in ("improved", "regressed", "still_pass", "still_fail", "new", "not_evaluated", "unchanged")
        pytest.iter8_run_id = run["id"]

    def test_second_run_compares_against_baseline(self, auth_client, base_url, suite_id):
        r = auth_client.post(f"{base_url}/api/regression/suites/{suite_id}/execute",
                             json={"bassett_version": "Bassett v2.0", "environment": "Staging"})
        assert r.status_code == 200
        run = r.json()
        assert run["baseline_run_id"], "Second run must auto-pick a baseline"
        # With no eval changes between runs, every evaluated test is still_pass / still_fail
        deltas = {x["delta"] for x in run["results"] if x["result"]}
        assert deltas <= {"still_pass", "still_fail", "improved", "regressed", "unchanged"}
        assert not any(x["delta"] == "new" for x in run["results"] if x["result"])
        pytest.iter8_run2_id = run["id"]

    def test_explicit_baseline_run_id(self, auth_client, base_url, suite_id):
        r = auth_client.post(f"{base_url}/api/regression/suites/{suite_id}/execute",
                             json={"bassett_version": "Bassett v2.0", "baseline_run_id": pytest.iter8_run_id})
        assert r.status_code == 200
        assert r.json()["baseline_run_id"] == pytest.iter8_run_id
        pytest.iter8_run3_id = r.json()["id"]

    def test_bad_baseline_rejected(self, auth_client, base_url, suite_id):
        r = auth_client.post(f"{base_url}/api/regression/suites/{suite_id}/execute",
                             json={"bassett_version": "Bassett v2.0", "baseline_run_id": "nonexistent"})
        assert r.status_code == 404

    def test_locked_run_cannot_be_edited(self, auth_client, base_url):
        r = auth_client.put(f"{base_url}/api/regression_runs/{pytest.iter8_run_id}", json={"passed": 999})
        assert r.status_code == 403

    def test_admin_can_delete_locked_run_cleanup(self, auth_client, base_url):
        # cleanup the extra pytest runs (admin-only delete), keep DB tidy
        for rid in (pytest.iter8_run_id, pytest.iter8_run2_id, pytest.iter8_run3_id):
            r = auth_client.delete(f"{base_url}/api/regression_runs/{rid}")
            assert r.status_code == 200

    def test_legacy_runs_still_listed(self, auth_client, base_url):
        runs = auth_client.get(f"{base_url}/api/regression_runs").json()
        versions = {r["bassett_version"] for r in runs}
        assert "Bassett v1.8" in versions and "Bassett v1.9" in versions


# ---------- Assignments ----------

class TestAssignments:
    def test_assign_testcase(self, auth_client, base_url, tc_id, tester_user):
        r = auth_client.post(f"{base_url}/api/assign",
                             json={"entity_type": "testcases", "entity_id": tc_id, "assignee_id": tester_user["id"]})
        assert r.status_code == 200
        doc = r.json()
        assert doc["assignee_id"] == tester_user["id"]
        assert doc["assignee_name"] == tester_user["name"]

    def test_assign_finding(self, auth_client, base_url, tester_user):
        f = auth_client.get(f"{base_url}/api/findings").json()[0]
        r = auth_client.post(f"{base_url}/api/assign",
                             json={"entity_type": "findings", "entity_id": f["id"], "assignee_id": tester_user["id"]})
        assert r.status_code == 200
        assert r.json()["assignee_name"] == tester_user["name"]
        # unassign
        r2 = auth_client.post(f"{base_url}/api/assign",
                              json={"entity_type": "findings", "entity_id": f["id"], "assignee_id": None})
        assert r2.status_code == 200 and r2.json()["assignee_id"] is None

    def test_invalid_entity_type(self, auth_client, base_url, tc_id):
        r = auth_client.post(f"{base_url}/api/assign",
                             json={"entity_type": "projects", "entity_id": tc_id, "assignee_id": "x"})
        assert r.status_code == 400

    def test_invalid_assignee(self, auth_client, base_url, tc_id):
        r = auth_client.post(f"{base_url}/api/assign",
                             json={"entity_type": "testcases", "entity_id": tc_id, "assignee_id": "ghost-user"})
        assert r.status_code == 404

    def test_unassign_testcase_cleanup(self, auth_client, base_url, tc_id):
        r = auth_client.post(f"{base_url}/api/assign",
                             json={"entity_type": "testcases", "entity_id": tc_id, "assignee_id": None})
        assert r.status_code == 200 and r.json()["assignee_id"] is None


# ---------- Threaded comments with mentions ----------

class TestComments:
    def test_create_comment_with_mention(self, auth_client, base_url, tc_id, tester_user):
        r = auth_client.post(f"{base_url}/api/comments", json={
            "entity_id": tc_id, "entity_type": "testcases",
            "text": f"pytest: @{tester_user['name']} please double-check", "mentions": [{"id": tester_user["id"]}]})
        assert r.status_code == 200
        c = r.json()
        assert c["mentions"] == [{"id": tester_user["id"], "name": tester_user["name"]}]
        assert c["parent_id"] is None
        pytest.iter8_comment_id = c["id"]

    def test_reply_threads_to_parent(self, auth_client, base_url, tc_id):
        r = auth_client.post(f"{base_url}/api/comments", json={
            "entity_id": tc_id, "entity_type": "testcases", "text": "pytest reply", "parent_id": pytest.iter8_comment_id})
        assert r.status_code == 200
        assert r.json()["parent_id"] == pytest.iter8_comment_id
        pytest.iter8_reply_id = r.json()["id"]

    def test_reply_to_reply_attaches_to_root(self, auth_client, base_url, tc_id):
        r = auth_client.post(f"{base_url}/api/comments", json={
            "entity_id": tc_id, "entity_type": "testcases", "text": "pytest nested", "parent_id": pytest.iter8_reply_id})
        assert r.status_code == 200
        assert r.json()["parent_id"] == pytest.iter8_comment_id
        pytest.iter8_nested_id = r.json()["id"]

    def test_empty_comment_rejected(self, auth_client, base_url, tc_id):
        r = auth_client.post(f"{base_url}/api/comments", json={"entity_id": tc_id, "text": "   "})
        assert r.status_code == 400

    def test_invalid_parent_rejected(self, auth_client, base_url, tc_id):
        r = auth_client.post(f"{base_url}/api/comments", json={"entity_id": tc_id, "text": "x", "parent_id": "ghost"})
        assert r.status_code == 404

    def test_list_comments_for_entity(self, auth_client, base_url, tc_id):
        r = auth_client.get(f"{base_url}/api/comments/{tc_id}", params={"include_test_data": "true"})
        assert r.status_code == 200
        ids = {c["id"] for c in r.json()}
        assert {pytest.iter8_comment_id, pytest.iter8_reply_id, pytest.iter8_nested_id} <= ids

    def test_soft_delete_preserves_thread(self, auth_client, base_url, tc_id):
        r = auth_client.delete(f"{base_url}/api/comments/{pytest.iter8_comment_id}")
        assert r.status_code == 200
        comments = auth_client.get(f"{base_url}/api/comments/{tc_id}", params={"include_test_data": "true"}).json()
        parent = next(c for c in comments if c["id"] == pytest.iter8_comment_id)
        assert parent["deleted"] is True and parent["text"] == ""
        # replies survive
        assert any(c["parent_id"] == pytest.iter8_comment_id for c in comments)

    def test_comment_logged_in_activity(self, auth_client, base_url, tc_id):
        # Comment text contains 'pytest' → its activity is auto-tagged automated_test,
        # so it only appears with the admin include_test_data flag (by design).
        acts = auth_client.get(f"{base_url}/api/activities", params={"include_test_data": "true"}).json()
        assert any(a["action"] == "commented" and a["entity_id"] == tc_id for a in acts)
