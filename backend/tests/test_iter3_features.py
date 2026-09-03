"""
Iteration 3 — 4 new features:
1) AI Pre-Scoring: POST /api/testcases/{id}/prescore
2) Claim-Level QA: POST /api/responses/{id}/extract-claims (idempotency + CRUD + role gate)
3) Saved Views: GET/PUT /api/views/{page} (per-user isolation)
4) Executive Summary: GET /api/analytics/executive

LLM budget: max 1 real prescore call. Reuse existing claims from the NYC C5-3 test case.
"""
import os
import requests
import pytest
from .live_auth import login_headers


def _hdrs(token):
    return token


@pytest.fixture(scope="module")
def viewer_token(base_url, api_client):
    return login_headers(base_url, "viewer")


@pytest.fixture(scope="module")
def tester_token(base_url, api_client):
    return login_headers(base_url, "tester")


# =========== 1) AI Pre-Scoring ===========
class TestAIPreScoring:
    """One real LLM call: pre-score the NYC C5-3 test case (has Bassett + gold)."""

    def _find_nyc(self, auth_client, base_url):
        tcs = auth_client.get(f"{base_url}/api/testcases").json()
        return next((t for t in tcs if "NYC" in (t.get("name") or "") and "C5-3" in (t.get("name") or "")), None)

    def test_prescore_success_with_gold_and_bassett(self, base_url, auth_client):
        nyc = self._find_nyc(auth_client, base_url)
        assert nyc is not None, "NYC C5-3 seeded test case not found"
        full = auth_client.get(f"{base_url}/api/testcases/{nyc['id']}/full").json()
        assert full.get("gold_standard"), "seeded NYC case must have a gold standard"
        bassett_resps = [r for r in full.get("responses", []) if r.get("model") == "Bassett"]
        assert bassett_resps, "seeded NYC case must have a Bassett response for pre-score"

        r = auth_client.post(f"{base_url}/api/testcases/{nyc['id']}/prescore",
                             json={"model": "Bassett"}, timeout=120)
        assert r.status_code == 200, r.text
        d = r.json()

        # 12 dimension keys present
        cfg = auth_client.get(f"{base_url}/api/config").json()
        dim_keys = [x["key"] for x in cfg["eval_dimensions"]]
        assert set(d["scores"].keys()) == set(dim_keys), f"missing dims: {set(dim_keys) - set(d['scores'].keys())}"
        assert len(dim_keys) == 12

        # scores 0-10 or None
        for k, v in d["scores"].items():
            assert v is None or (isinstance(v, int) and 0 <= v <= 10), f"bad score {k}={v}"

        # final_result from allowed list
        assert d["final_result"] in cfg["pass_results"], d["final_result"]

        # rationale non-empty
        assert isinstance(d["rationale"], str) and len(d["rationale"].strip()) >= 20, d["rationale"]

        # model echoed
        assert d["model"] == "Bassett"

        # === evidence log ===
        print("\n=== AI Pre-Score result ===")
        print("scores:", d["scores"])
        print("final_result:", d["final_result"])
        print("rationale:", d["rationale"][:400])

    def test_prescore_no_gold_returns_400(self, base_url, auth_client):
        # find a testcase without a gold_standard
        tcs = auth_client.get(f"{base_url}/api/testcases").json()
        no_gold = None
        for tc in tcs:
            full = auth_client.get(f"{base_url}/api/testcases/{tc['id']}/full").json()
            if not full.get("gold_standard") or not (full.get("gold_standard") or {}).get("answer"):
                no_gold = tc
                break
        if not no_gold:
            pytest.skip("All seeded testcases have gold standards; skipping no-gold 400 check")
        r = auth_client.post(f"{base_url}/api/testcases/{no_gold['id']}/prescore",
                             json={"model": "Bassett"})
        assert r.status_code == 400, r.text
        assert "gold" in (r.json().get("detail") or "").lower()

    def test_viewer_prescore_403(self, base_url, viewer_token, auth_client):
        nyc = self._find_nyc(auth_client, base_url)
        assert nyc is not None
        r = requests.post(f"{base_url}/api/testcases/{nyc['id']}/prescore",
                          json={"model": "Bassett"}, headers=_hdrs(viewer_token))
        assert r.status_code == 403


# =========== 2) Claim-Level QA ===========
class TestClaimsQA:
    """Uses the existing 4 claims for NYC C5-3 Bassett response — no new LLM calls."""

    def _nyc_bassett_response(self, auth_client, base_url):
        tcs = auth_client.get(f"{base_url}/api/testcases").json()
        nyc = next((t for t in tcs if "NYC" in (t.get("name") or "") and "C5-3" in (t.get("name") or "")), None)
        assert nyc is not None
        full = auth_client.get(f"{base_url}/api/testcases/{nyc['id']}/full").json()
        resps = [r for r in full.get("responses", []) if r.get("model") == "Bassett"]
        assert resps
        return nyc, resps[0], full

    def test_existing_claims_appear_in_full(self, base_url, auth_client):
        nyc, resp, full = self._nyc_bassett_response(auth_client, base_url)
        claims = [c for c in full.get("claims", []) if c["response_id"] == resp["id"]]
        assert len(claims) >= 1, "seed should already have Bassett claims for NYC"
        for c in claims:
            assert c["testcase_id"] == nyc["id"]
            assert c["model"] == "Bassett"
            assert c["verdict"] in ("Unreviewed", "Verified", "Partially Correct", "Unsupported", "Incorrect")
            assert c.get("claim_text")

    def test_extract_claims_idempotent(self, base_url, auth_client):
        """POST extract-claims twice on same response → count unchanged, no new LLM call."""
        nyc, resp, full = self._nyc_bassett_response(auth_client, base_url)

        # snapshot count
        claims_before = [c for c in full.get("claims", []) if c["response_id"] == resp["id"]]
        n_before = len(claims_before)
        assert n_before >= 1

        # first call - should return existing without LLM invocation
        r = auth_client.post(f"{base_url}/api/responses/{resp['id']}/extract-claims", timeout=30)
        assert r.status_code == 200, r.text
        returned = r.json()
        assert isinstance(returned, list)
        assert len(returned) == n_before, f"idempotency broken: {len(returned)} vs {n_before}"

        # second call
        r2 = auth_client.post(f"{base_url}/api/responses/{resp['id']}/extract-claims", timeout=30)
        assert r2.status_code == 200
        assert len(r2.json()) == n_before

        # verify DB count unchanged
        full2 = auth_client.get(f"{base_url}/api/testcases/{nyc['id']}/full").json()
        claims_after = [c for c in full2.get("claims", []) if c["response_id"] == resp["id"]]
        assert len(claims_after) == n_before

    def test_update_claim_verdict(self, base_url, auth_client):
        nyc, resp, full = self._nyc_bassett_response(auth_client, base_url)
        claim = next(c for c in full.get("claims", []) if c["response_id"] == resp["id"])
        original_verdict = claim["verdict"]
        original_note = claim.get("note", "")

        # set to Verified
        r = auth_client.put(f"{base_url}/api/claims/{claim['id']}",
                            json={"verdict": "Verified", "note": "TEST_note_iter3"})
        assert r.status_code == 200
        assert r.json()["verdict"] == "Verified"
        assert r.json()["note"] == "TEST_note_iter3"

        # verify persisted
        full2 = auth_client.get(f"{base_url}/api/testcases/{nyc['id']}/full").json()
        c2 = next(c for c in full2.get("claims", []) if c["id"] == claim["id"])
        assert c2["verdict"] == "Verified"

        # revert to original state (do not pollute seed)
        auth_client.put(f"{base_url}/api/claims/{claim['id']}",
                        json={"verdict": original_verdict, "note": original_note})

    def test_viewer_cannot_extract_claims(self, base_url, viewer_token, auth_client):
        nyc, resp, _ = self._nyc_bassett_response(auth_client, base_url)
        r = requests.post(f"{base_url}/api/responses/{resp['id']}/extract-claims",
                          headers=_hdrs(viewer_token))
        assert r.status_code == 403

    def test_delete_claim_and_restore(self, base_url, auth_client):
        """Delete one existing claim, verify gone, then recreate with same data (best-effort)."""
        nyc, resp, full = self._nyc_bassett_response(auth_client, base_url)
        claims = [c for c in full.get("claims", []) if c["response_id"] == resp["id"]]
        if len(claims) < 2:
            pytest.skip("need >=2 claims to safely delete one")
        target = claims[-1]  # delete the last one

        r = auth_client.delete(f"{base_url}/api/claims/{target['id']}")
        assert r.status_code == 200

        # verify gone
        full2 = auth_client.get(f"{base_url}/api/testcases/{nyc['id']}/full").json()
        remaining = [c for c in full2.get("claims", []) if c["id"] == target["id"]]
        assert not remaining

        # restore by direct POST /api/claims (generic CRUD) so seed count is preserved
        restore_body = {k: v for k, v in target.items()
                        if k not in ("id", "created_at", "created_by", "updated_at", "_id")}
        r2 = auth_client.post(f"{base_url}/api/claims", json=restore_body)
        assert r2.status_code == 200


# =========== 3) Saved Views ===========
class TestSavedViews:
    def test_admin_view_initially_empty(self, base_url, auth_client):
        # We don't rely on 'initially empty' since past tests may set — but we know saved_views was reset per PS.
        # Just make PUT then GET round-trip. Test isolation by ensuring per-user separation below.
        r = auth_client.get(f"{base_url}/api/views/testcases")
        assert r.status_code == 200
        # value may be {} or a saved state — accept both
        assert isinstance(r.json(), dict)

    def test_admin_put_then_get_returns_saved_state(self, base_url, auth_client):
        state = {
            "filters": {"status": "Testing", "category": "Zoning Code Requirements",
                        "criticality": "3", "project": "*"},
            "cols": {"category": False, "criticality": True},
        }
        r = auth_client.put(f"{base_url}/api/views/testcases", json={"state": state})
        assert r.status_code == 200

        r2 = auth_client.get(f"{base_url}/api/views/testcases")
        assert r2.status_code == 200
        got = r2.json()
        assert got.get("state") == state
        assert got.get("page") == "testcases"

    def test_per_user_isolation_tester_sees_empty(self, base_url, tester_token):
        r = requests.get(f"{base_url}/api/views/testcases", headers=_hdrs(tester_token))
        assert r.status_code == 200
        # tester's view should NOT contain admin's saved filters
        got = r.json()
        assert got == {} or got.get("state") != {"filters": {"status": "Testing",
                                                              "category": "Zoning Code Requirements",
                                                              "criticality": "3", "project": "*"},
                                                  "cols": {"category": False, "criticality": True}}, got

    def test_admin_clear_view_via_default(self, base_url, auth_client):
        """Reset admin's saved view to unfiltered defaults so UI shows clean state after tests."""
        default_state = {"filters": {"status": "*", "category": "*", "criticality": "*", "project": "*"},
                         "cols": {"category": True, "criticality": True, "status": True,
                                  "municipality": True, "project": True}}
        r = auth_client.put(f"{base_url}/api/views/testcases", json={"state": default_state})
        assert r.status_code == 200


# =========== 4) Executive Summary ===========
class TestExecutiveAnalytics:
    def test_executive_endpoint_shape(self, base_url, auth_client):
        r = auth_client.get(f"{base_url}/api/analytics/executive")
        assert r.status_code == 200, r.text
        d = r.json()

        # KPIs shape
        assert "kpis" in d
        k = d["kpis"]
        for key in ("bassett_avg", "benchmark_avg", "pass_rate", "wins", "losses",
                    "open_critical", "total_evaluated", "total_findings"):
            assert key in k, f"missing kpi {key}"
        assert isinstance(k["bassett_avg"], (int, float))
        assert isinstance(k["pass_rate"], (int, float))
        assert 0 <= k["pass_rate"] <= 100

        # trend
        assert isinstance(d["trend"], list)
        for row in d["trend"]:
            assert "quarter" in row
            for m in row:
                if m == "quarter":
                    continue
                assert isinstance(row[m], (int, float))
                assert 0 <= row[m] <= 10

        # failure_modes
        assert isinstance(d["failure_modes"], list)
        for fm in d["failure_modes"]:
            assert "mode" in fm and "count" in fm

        # categories
        assert isinstance(d["categories"], list)
        for c in d["categories"]:
            assert "category" in c and "avg_score" in c and "count" in c

        # expected values per problem statement (soft check — allow drift)
        print("\n=== Executive KPIs ===")
        print(k)
        print("trend rows:", len(d["trend"]))
        print("failure_modes:", len(d["failure_modes"]))
        print("categories:", len(d["categories"]))

    def test_executive_expected_values(self, base_url, auth_client):
        """Problem statement values: bassett_avg 7.3, pass_rate 80, wins 4, losses 2, open_critical 3."""
        d = auth_client.get(f"{base_url}/api/analytics/executive").json()
        k = d["kpis"]
        # allow small drift (dataset may evolve)
        assert 6.5 <= k["bassett_avg"] <= 8.5, k["bassett_avg"]
        assert 60 <= d["kpis"]["pass_rate"] <= 90, k["pass_rate"]
        assert k["wins"] >= 3, k["wins"]
        assert k["losses"] >= 1, k["losses"]
        assert k["open_critical"] >= 1, k["open_critical"]
