"""Iteration 10: one-click integrity repairs with guided confirmation."""
import pytest

R = "/api/admin/integrity/repair"


def find_issue(auth_client, base_url, key, entity_id):
    d = auth_client.get(f"{base_url}/api/admin/integrity").json()
    return next((i for i in d["issues"] if i.get("repair_action") and i["repair_action"]["key"] == key and i["entity_id"] == entity_id), None)


class TestRepairStatus:
    def test_reset_status_draft(self, auth_client, base_url):
        tc = auth_client.post(f"{base_url}/api/testcases", json={"name": "TEST_iter9_repair status-no-eval", "status": "Evaluated"}).json()
        issue = find_issue(auth_client, base_url, "reset_status_draft", tc["id"])
        assert issue and issue["repair_action"]["destructive"] is False
        r = auth_client.post(f"{base_url}{R}", json={"key": "reset_status_draft", "entity_id": tc["id"], "record_name": tc["name"]})
        assert r.status_code == 200
        assert auth_client.get(f"{base_url}/api/testcases/{tc['id']}").json()["status"] == "Draft"
        auth_client.delete(f"{base_url}/api/testcases/{tc['id']}")

    def test_set_status_evaluated(self, auth_client, base_url):
        tc = auth_client.post(f"{base_url}/api/testcases", json={"name": "TEST_iter9_repair draft-with-eval", "status": "Draft"}).json()
        ev = auth_client.post(f"{base_url}/api/evaluations", json={"testcase_id": tc["id"], "model": "Bassett", "overall_score": 8.0, "final_result": "Pass"}).json()
        assert find_issue(auth_client, base_url, "set_status_evaluated", tc["id"])
        r = auth_client.post(f"{base_url}{R}", json={"key": "set_status_evaluated", "entity_id": tc["id"], "record_name": tc["name"]})
        assert r.status_code == 200
        assert auth_client.get(f"{base_url}/api/testcases/{tc['id']}").json()["status"] == "Evaluated"
        auth_client.delete(f"{base_url}/api/evaluations/{ev['id']}")
        auth_client.delete(f"{base_url}/api/testcases/{tc['id']}")

    def test_precondition_guard_409(self, auth_client, base_url):
        tc = auth_client.post(f"{base_url}/api/testcases", json={"name": "TEST_iter9_repair guard", "status": "Evaluated"}).json()
        ev = auth_client.post(f"{base_url}/api/evaluations", json={"testcase_id": tc["id"], "model": "Bassett", "overall_score": 7.0, "final_result": "Pass"}).json()
        r = auth_client.post(f"{base_url}{R}", json={"key": "reset_status_draft", "entity_id": tc["id"], "record_name": tc["name"]})
        assert r.status_code == 409, "must refuse when an evaluation now exists"
        auth_client.delete(f"{base_url}/api/evaluations/{ev['id']}")
        auth_client.delete(f"{base_url}/api/testcases/{tc['id']}")


class TestRepairReferencesAndOrphans:
    def test_clear_reference(self, auth_client, base_url):
        tc = auth_client.post(f"{base_url}/api/testcases", json={"name": "TEST_iter9_repair broken-muni", "status": "Draft", "municipality_id": "ghost-muni-id"}).json()
        issue = find_issue(auth_client, base_url, "clear_reference", tc["id"])
        assert issue and issue["repair_action"]["params"]["field"] == "municipality_id"
        r = auth_client.post(f"{base_url}{R}", json={"key": "clear_reference", "entity_id": tc["id"], "params": {"field": "municipality_id"}, "record_name": tc["name"]})
        assert r.status_code == 200
        assert auth_client.get(f"{base_url}/api/testcases/{tc['id']}").json()["municipality_id"] is None
        auth_client.delete(f"{base_url}/api/testcases/{tc['id']}")

    def test_delete_orphan_evaluation(self, auth_client, base_url):
        ev = auth_client.post(f"{base_url}/api/evaluations", json={"testcase_id": "ghost-tc-id", "model": "Bassett", "overall_score": 5.0, "final_result": "Fail"}).json()
        issue = find_issue(auth_client, base_url, "delete_orphan", ev["id"])
        assert issue and issue["repair_action"]["destructive"] is True
        r = auth_client.post(f"{base_url}{R}", json={"key": "delete_orphan", "entity_id": ev["id"], "params": {"collection": "evaluations"}, "record_name": "TEST_iter9_repair orphan"})
        assert r.status_code == 200
        assert auth_client.get(f"{base_url}/api/evaluations/{ev['id']}").status_code == 404

    def test_delete_orphan_refuses_non_orphan(self, auth_client, base_url):
        tcs = auth_client.get(f"{base_url}/api/testcases").json()
        evs = auth_client.get(f"{base_url}/api/evaluations").json()
        live = next(e for e in evs if e["testcase_id"] in {t["id"] for t in tcs})
        r = auth_client.post(f"{base_url}{R}", json={"key": "delete_orphan", "entity_id": live["id"], "params": {"collection": "evaluations"}})
        assert r.status_code == 409


class TestRepairRetests:
    def test_backfill_retest(self, auth_client, base_url):
        rt = auth_client.post(f"{base_url}/api/retests", json={"testcase_name": "TEST_iter9_repair retest", "status": "Completed",
                                                              "new_result": "Pass", "new_bassett_version": "Bassett v2.0",
                                                              "new_response": "corrected answer", "started_by": "Tester"}).json()
        assert find_issue(auth_client, base_url, "backfill_retest", rt["id"])
        r = auth_client.post(f"{base_url}{R}", json={"key": "backfill_retest", "entity_id": rt["id"], "record_name": rt["testcase_name"]})
        assert r.status_code == 200
        fixed = auth_client.get(f"{base_url}/api/retests/{rt['id']}").json()
        assert fixed["outcome"] == "Fixed" and fixed["completed_at"] and fixed["reviewer"]
        auth_client.delete(f"{base_url}/api/retests/{rt['id']}")

    def test_complete_retest_status(self, auth_client, base_url):
        rt = auth_client.post(f"{base_url}/api/retests", json={"testcase_name": "TEST_iter9_repair retest2", "status": "In Progress",
                                                              "verdict": "Fixed", "retest_date": "2026-02-01"}).json()
        assert find_issue(auth_client, base_url, "complete_retest_status", rt["id"])
        r = auth_client.post(f"{base_url}{R}", json={"key": "complete_retest_status", "entity_id": rt["id"], "record_name": rt["testcase_name"]})
        assert r.status_code == 200
        fixed = auth_client.get(f"{base_url}/api/retests/{rt['id']}").json()
        assert fixed["status"] == "Completed" and fixed["outcome"] == "Fixed"
        auth_client.delete(f"{base_url}/api/retests/{rt['id']}")


class TestRepairGuards:
    def test_snapshot_repair_refuses_when_present(self, auth_client, base_url):
        r = auth_client.post(f"{base_url}{R}", json={"key": "recompute_snapshot", "entity_id": "Bassett v1.9"})
        assert r.status_code == 409

    def test_unknown_key_400(self, auth_client, base_url):
        r = auth_client.post(f"{base_url}{R}", json={"key": "nuke_everything", "entity_id": "x"})
        assert r.status_code == 400

    def test_viewer_forbidden(self, base_url):
        import requests
        from .live_auth import login_headers
        r = requests.post(f"{base_url}{R}", json={"key": "reset_status_draft", "entity_id": "x"},
                          headers=login_headers(base_url, "viewer"))
        assert r.status_code == 403

    def test_manual_only_issues_have_no_action(self, auth_client, base_url):
        d = auth_client.get(f"{base_url}/api/admin/integrity").json()
        for i in d["issues"]:
            if i["entity_type"] == "goldstandard" or i["entity_type"] == "regression_run":
                assert i.get("repair_action") is None, "substantive QA judgments must stay manual"

    def test_repairs_logged_to_activity(self, auth_client, base_url):
        acts = auth_client.get(f"{base_url}/api/activities", params={"include_test_data": "true"}).json()
        assert any(a["action"].startswith("integrity repair") for a in acts)
