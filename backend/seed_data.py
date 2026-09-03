"""Seed realistic fictional ZoneQA data (Tests 1-10)."""

DIMS = ["accuracy", "current_code", "interpretation", "calculation", "context", "missing_info",
        "followup", "citation_accuracy", "source_quality", "guidance", "completeness", "usefulness"]


async def run_seed_impl(db, new_id, now_iso):
    # Development/demo reset only. Delete dependents before their parents so
    # PostgreSQL's referential safeguards remain active during normal API use.
    for c in [
        "attachments", "saved_views", "release_decisions", "activities", "comments",
        "annotations", "claims", "retests", "findings", "responses", "evaluations",
        "goldstandards", "test_runs", "regression_runs", "demos", "regression_suites",
        "calendar_events",
    ]:
        await db[c].delete_many({})
    # A testcase can be a variant of another testcase, so clear child variants
    # before parent cases instead of relying on deletion order by UUID.
    await db.testcases.delete_many({"variant_of": {"$ne": None}})
    await db.testcases.delete_many({})
    for c in ["evidence", "properties", "projects", "municipalities", "versions", "models"]:
        await db[c].delete_many({})

    ts = now_iso()

    # Models
    models = [
        {"id": new_id(), "name": "Bassett", "provider": "Zoneomics", "role_type": "Primary", "active": True, "created_at": ts, "created_by": "seed"},
        {"id": new_id(), "name": "ChatGPT", "provider": "OpenAI", "role_type": "Benchmark", "model_name": "gpt-4o", "active": True, "created_at": ts, "created_by": "seed"},
        {"id": new_id(), "name": "Claude", "provider": "Anthropic", "role_type": "Benchmark", "model_name": "claude-sonnet-4", "active": True, "created_at": ts, "created_by": "seed"},
    ]
    await db.models.insert_many([dict(m) for m in models])

    # Bassett versions
    versions = [
        {"id": new_id(), "name": "Bassett v1.8", "release_number": "1.8.0", "release_date": "2026-03-01", "environment": "Production", "active": False, "description": "Prior production release", "created_at": ts, "created_by": "seed"},
        {"id": new_id(), "name": "Bassett v1.9", "release_number": "1.9.0", "release_date": "2026-05-15", "environment": "Production", "active": True, "description": "Current production release", "created_at": ts, "created_by": "seed"},
    ]
    await db.versions.insert_many([dict(v) for v in versions])
    V18, V19 = "Bassett v1.8", "Bassett v1.9"

    # Municipalities
    munis = [
        {"id": new_id(), "name": "New York City", "state": "NY", "county": "New York", "muni_type": "City",
         "primary_code": "NYC Zoning Resolution", "code_url": "https://zr.planning.nyc.gov", "map_url": "https://zola.planning.nyc.gov",
         "code_effective_date": "2025-11-01", "last_verified": "2026-05-20", "notes": "Complex ZR with many overlays.", "created_at": ts, "created_by": "seed"},
        {"id": new_id(), "name": "Franklin", "state": "TN", "county": "Williamson", "muni_type": "City",
         "primary_code": "Franklin Zoning Ordinance", "code_url": "https://franklintn.gov/zoning", "map_url": "",
         "code_effective_date": "2024-07-01", "last_verified": "2026-04-10", "notes": "", "created_at": ts, "created_by": "seed"},
        {"id": new_id(), "name": "Oklahoma City", "state": "OK", "county": "Oklahoma", "muni_type": "City",
         "primary_code": "OKC Municipal Code Ch.59", "code_url": "https://okc.gov/zoning", "map_url": "",
         "code_effective_date": "2023-01-15", "last_verified": "2026-02-01", "notes": "", "created_at": ts, "created_by": "seed"},
        {"id": new_id(), "name": "Sterling Heights", "state": "MI", "county": "Macomb", "muni_type": "City",
         "primary_code": "Sterling Heights Zoning", "code_url": "", "map_url": "", "code_effective_date": "2022-05-01",
         "last_verified": "2025-12-01", "notes": "Evidence may be stale — verify.", "created_at": ts, "created_by": "seed"},
    ]
    await db.municipalities.insert_many([dict(m) for m in munis])
    M = {m["name"]: m["id"] for m in munis}

    # Properties
    props = [
        {"id": new_id(), "name": "432 Park Retail Parcel", "address": "432 Park Ave, New York, NY", "municipality_id": M["New York City"],
         "state": "NY", "county": "New York", "apn": "NY-13-0022", "zoning_district": "C5-3", "overlay": "Special Midtown District",
         "special_district": "MiD", "property_type": "Commercial", "notes": "", "created_at": ts, "created_by": "seed"},
        {"id": new_id(), "name": "Cool Springs Mixed-Use Site", "address": "1000 Meridian Blvd, Franklin, TN", "municipality_id": M["Franklin"],
         "state": "TN", "county": "Williamson", "apn": "TN-88-1201", "zoning_district": "PD (Cool Springs)", "overlay": "",
         "special_district": "Planned Development", "property_type": "Mixed-Use", "notes": "Governed by PD ordinance, not base district.", "created_at": ts, "created_by": "seed"},
        {"id": new_id(), "name": "2219 Bainbridge Warehouse", "address": "2219 Bainbridge St, Oklahoma City, OK", "municipality_id": M["Oklahoma City"],
         "state": "OK", "county": "Oklahoma", "apn": "OK-44-9931", "zoning_district": "I-2", "overlay": "", "special_district": "",
         "property_type": "Industrial", "notes": "", "created_at": ts, "created_by": "seed"},
    ]
    await db.properties.insert_many([dict(p) for p in props])
    P = {p["name"]: p["id"] for p in props}

    # Projects
    projects = [
        {"id": new_id(), "name": "NYC Zoning Resolution Testing", "description": "Validate Bassett on NYC ZR permitted uses, overlays and dimensional rules.",
         "owner": "QA Manager", "testers": ["Test Engineer"], "start_date": "2026-04-01", "target_date": "2026-07-01",
         "status": "Active", "priority": "High", "bassett_version": V19, "completion": 45, "notes": "", "created_at": ts, "created_by": "seed"},
        {"id": new_id(), "name": "Parking Requirement Testing", "description": "Parking/FAR calculation accuracy across jurisdictions.",
         "owner": "QA Manager", "testers": ["Test Engineer"], "start_date": "2026-04-15", "target_date": "2026-06-30",
         "status": "Active", "priority": "Medium", "bassett_version": V19, "completion": 30, "notes": "", "created_at": ts, "created_by": "seed"},
        {"id": new_id(), "name": "Planned Development Testing", "description": "Ensure Bassett recognizes PD/PUD ordinances over base districts.",
         "owner": "QA Manager", "testers": ["Test Engineer"], "start_date": "2026-03-01", "target_date": "2026-06-01",
         "status": "Active", "priority": "High", "bassett_version": V19, "completion": 60, "notes": "", "created_at": ts, "created_by": "seed"},
        {"id": new_id(), "name": "Bassett Release Regression", "description": "Regression suite run on each Bassett release.",
         "owner": "QA Manager", "testers": ["Test Engineer"], "start_date": "2026-05-15", "target_date": "2026-05-30",
         "status": "Active", "priority": "Critical", "bassett_version": V19, "completion": 80, "notes": "", "created_at": ts, "created_by": "seed"},
    ]
    await db.projects.insert_many([dict(p) for p in projects])
    PR = {p["name"]: p["id"] for p in projects}

    # Evidence
    evidence = [
        {"id": new_id(), "municipality_id": M["New York City"], "document_name": "NYC ZR §32-00 Use Regulations", "doc_type": "Ordinance Section",
         "section": "§32-00", "citation": "NYC ZR §32-00", "effective_date": "2025-11-01", "source_url": "https://zr.planning.nyc.gov/article-iii",
         "relevant_text": "Use Group 6 retail uses are permitted as-of-right in C5 districts subject to Special Midtown District provisions.",
         "verification_status": "Expert Verified", "verified_by": "QA Manager", "verified_date": "2026-05-01", "notes": "", "created_at": ts, "created_by": "seed"},
        {"id": new_id(), "municipality_id": M["Franklin"], "document_name": "Cool Springs PD Ordinance 2019-14", "doc_type": "Planned Development Ordinance",
         "section": "PD 2019-14 §4", "citation": "Franklin PD 2019-14", "effective_date": "2019-09-01", "source_url": "https://franklintn.gov/pd/2019-14",
         "relevant_text": "Permitted uses, setbacks and density for the Cool Springs PD are governed exclusively by this ordinance and supersede base district standards.",
         "verification_status": "Municipality Confirmed", "verified_by": "QA Manager", "verified_date": "2026-04-20", "notes": "", "created_at": ts, "created_by": "seed"},
        {"id": new_id(), "municipality_id": M["Oklahoma City"], "document_name": "OKC Municipal Code §59-9150 Parking", "doc_type": "Ordinance Section",
         "section": "§59-9150", "citation": "OKC §59-9150", "effective_date": "2023-01-15", "source_url": "https://okc.gov/parking",
         "relevant_text": "Warehouse/industrial (I-2): 1 space per 1,000 sq ft of gross floor area.",
         "verification_status": "Expert Verified", "verified_by": "QA Manager", "verified_date": "2026-02-01", "notes": "", "created_at": ts, "created_by": "seed"},
        {"id": new_id(), "municipality_id": M["Sterling Heights"], "document_name": "Sterling Heights Setback Table", "doc_type": "Ordinance Section",
         "section": "§7.02", "citation": "SH §7.02", "effective_date": "2022-05-01", "source_url": "",
         "relevant_text": "R-60 front setback: 30 ft.", "verification_status": "Unverified", "verified_by": "", "verified_date": "",
         "notes": "Effective date is old — verification recommended.", "created_at": ts, "created_by": "seed"},
    ]
    await db.evidence.insert_many([dict(e) for e in evidence])
    E = {e["document_name"]: e["id"] for e in evidence}

    # helper builders
    def scores(vals):
        return {DIMS[i]: vals[i] for i in range(len(DIMS))}

    tc_docs, resp_docs, gold_docs, eval_docs, finding_docs, retest_docs, demo_docs = [], [], [], [], [], [], []

    def make_tc(**kw):
        tid = new_id()
        base = {"id": tid, "created_at": ts, "created_by": "seed", "tester": "Test Engineer",
                "difficulty": 2, "criticality": 3, "bassett_version": V19, "test_type": "Single Prompt",
                "in_regression": False, "demo_status": "Not Reviewed", "evidence_ids": [], "expected_behaviors": []}
        base.update(kw)
        tc_docs.append(base)
        return tid

    def make_resp(tid, model, text, citations="", turn=1, version=V19):
        resp_docs.append({"id": new_id(), "testcase_id": tid, "model": model, "model_version": version if model == "Bassett" else "",
                          "turn": turn, "prompt_ref": turn, "response": text, "citations": citations, "sources": "",
                          "notes": "", "capture_method": "paste", "created_at": ts, "created_by": "seed"})

    def make_gold(tid, answer, explanation, ev_ids):
        gold_docs.append({"id": new_id(), "testcase_id": tid, "answer": answer, "explanation": explanation,
                          "prepared_by": "QA Manager", "reviewed_by": "Zoneomics Admin", "review_status": "Approved",
                          "ordinance_sections": "", "evidence_ids": ev_ids, "created_at": ts, "created_by": "seed"})

    def make_eval(tid, model, sc, result, note="", version=V19):
        ov = round(sum(sc.values()) / len(sc), 1)
        eval_docs.append({"id": new_id(), "testcase_id": tid, "model": model, "scores": sc, "overall_score": ov,
                          "system_recommended": result, "final_result": result, "reviewer": "Test Engineer",
                          "notes": note, "bassett_version": version if model == "Bassett" else "",
                          "created_at": ts, "created_by": "seed"})

    # TEST 1 — Straightforward Pass
    t1 = make_tc(name="NYC C5-3 retail permitted use", project_id=PR["NYC Zoning Resolution Testing"],
                 municipality_id=M["New York City"], property_id=P["432 Park Retail Parcel"],
                 category="Zoning Code Requirements", subcategory="permitted uses", status="Evaluated",
                 criticality=3, difficulty=2, scenario="Confirm ground-floor retail is permitted in C5-3.",
                 purpose="Baseline permitted-use identification.", evidence_ids=[E["NYC ZR §32-00 Use Regulations"]],
                 expected_behaviors=[{"text": "Identify C5-3 district", "status": "Met"},
                                     {"text": "Cite NYC ZR §32-00 / Use Group 6", "status": "Met"}],
                 prompts=[{"turn": 1, "text": "Is ground-floor retail permitted at 432 Park Ave (C5-3), NYC?"}])
    make_resp(t1, "Bassett", "Yes. 432 Park Ave is in a C5-3 district. Use Group 6 retail uses are permitted as-of-right (NYC ZR §32-00), subject to Special Midtown District provisions.", "NYC ZR §32-00")
    make_resp(t1, "ChatGPT", "Retail is generally allowed in commercial NYC zones like C5, but confirm with the zoning resolution.", "")
    make_resp(t1, "Claude", "C5 districts are commercial; retail is typically permitted. Verify Special Midtown overlay.", "")
    make_gold(t1, "Permitted as-of-right (Use Group 6, NYC ZR §32-00).", "Confirmed against verified ZR section.", [E["NYC ZR §32-00 Use Regulations"]])
    make_eval(t1, "Bassett", scores([9,9,9,8,9,8,8,9,9,8,9,9]), "Pass", "Correct + well cited.")
    make_eval(t1, "ChatGPT", scores([6,4,5,6,7,6,6,3,4,5,5,5]), "Needs Improvement", "Vague, no citation.")
    make_eval(t1, "Claude", scores([6,5,6,6,7,6,6,4,5,6,6,6]), "Pass with Minor Issues")

    # TEST 2 — Citation Failure
    t2 = make_tc(name="OKC I-2 parking — correct answer, wrong cite", project_id=PR["Parking Requirement Testing"],
                 municipality_id=M["Oklahoma City"], property_id=P["2219 Bainbridge Warehouse"],
                 category="Source / Citation Performance", subcategory="correct ordinance section", status="Evaluated",
                 criticality=3, difficulty=2, test_type="Calculation", in_regression=True,
                 scenario="Parking for a 40,000 sqft warehouse.", purpose="Detect citation errors even when answer is right.",
                 evidence_ids=[E["OKC Municipal Code §59-9150 Parking"]],
                 expected_behaviors=[{"text": "Compute 40 spaces (1/1000 sqft)", "status": "Met"},
                                     {"text": "Cite OKC §59-9150", "status": "Not Met"}],
                 prompts=[{"turn": 1, "text": "How many parking spaces for a 40,000 sqft I-2 warehouse in OKC?"}])
    make_resp(t2, "Bassett", "40 spaces are required (1 per 1,000 sqft). See OKC §59-9200.", "OKC §59-9200")
    make_resp(t2, "ChatGPT", "About 40 spaces, assuming 1 per 1,000 sqft — confirm with the city.", "")
    make_resp(t2, "Claude", "Roughly 40 spaces at 1/1000 sqft.", "")
    make_gold(t2, "40 spaces; OKC §59-9150.", "Rate correct; correct section is §59-9150 not §59-9200.", [E["OKC Municipal Code §59-9150 Parking"]])
    make_eval(t2, "Bassett", scores([9,7,8,9,8,7,7,3,6,7,8,8]), "Pass with Minor Issues", "Right number, wrong citation section.")
    make_eval(t2, "ChatGPT", scores([8,6,7,8,7,7,7,4,5,7,7,7]), "Pass with Minor Issues")
    make_eval(t2, "Claude", scores([8,6,7,8,7,6,6,4,5,6,7,7]), "Pass with Minor Issues")
    finding_docs.append({"id": new_id(), "title": "Correct parking count but wrong ordinance section cited",
                         "project_id": PR["Parking Requirement Testing"], "testcase_id": t2, "finding_type": "citation problem",
                         "category": "Source / Citation Performance", "criticality": 3,
                         "description": "Bassett cited §59-9200; correct section is §59-9150.",
                         "expected_behavior": "Cite OKC §59-9150.", "actual_behavior": "Cited §59-9200.",
                         "developer_status": "Confirmed", "root_cause": "Citation Generation", "failure_modes": ["Incorrect Citation"],
                         "retest_required": True, "retest_status": "Pending", "version_found": V19, "version_fixed": "",
                         "tester": "Test Engineer", "owner": "Product Dev", "status_history": [], "created_at": ts, "created_by": "seed"})

    # TEST 3 — Benchmark Win (ChatGPT catches issue Bassett misses)
    t3 = make_tc(name="NYC Special Midtown overlay missed", project_id=PR["NYC Zoning Resolution Testing"],
                 municipality_id=M["New York City"], property_id=P["432 Park Retail Parcel"],
                 category="Property & Regulatory Identification", subcategory="overlay identification", status="Evaluated",
                 criticality=4, difficulty=3, scenario="Signage rules for 432 Park.", purpose="Overlay recognition.",
                 evidence_ids=[E["NYC ZR §32-00 Use Regulations"]],
                 expected_behaviors=[{"text": "Recognize Special Midtown District controls signage", "status": "Not Met"}],
                 prompts=[{"turn": 1, "text": "What signage is allowed at 432 Park Ave?"}])
    make_resp(t3, "Bassett", "Standard C5 signage regulations apply.", "")
    make_resp(t3, "ChatGPT", "Note this is within the Special Midtown District, which imposes additional signage controls beyond base C5 rules.", "")
    make_resp(t3, "Claude", "C5 signage rules apply generally.", "")
    make_gold(t3, "Special Midtown District signage controls apply in addition to C5.", "Overlay governs; base rules insufficient.", [E["NYC ZR §32-00 Use Regulations"]])
    make_eval(t3, "Bassett", scores([4,3,4,6,5,4,4,4,5,4,4,4]), "Fail", "Missed overlay.")
    make_eval(t3, "ChatGPT", scores([8,7,8,7,8,7,7,6,7,8,8,8]), "Pass", "Caught the overlay.")
    make_eval(t3, "Claude", scores([5,4,5,6,5,5,5,4,5,5,5,5]), "Needs Improvement")
    finding_docs.append({"id": new_id(), "title": "Bassett missed Special Midtown overlay (ChatGPT caught it)",
                         "project_id": PR["NYC Zoning Resolution Testing"], "testcase_id": t3, "finding_type": "competitor advantage",
                         "category": "Property & Regulatory Identification", "criticality": 4,
                         "description": "Bassett applied base C5 rules; benchmark identified the overlay.",
                         "expected_behavior": "Recognize Special Midtown District.", "actual_behavior": "Only base district applied.",
                         "developer_status": "In Development", "root_cause": "Data Coverage", "failure_modes": ["Missed Overlay"],
                         "retest_required": True, "retest_status": "Pending", "version_found": V19, "version_fixed": "",
                         "tester": "Test Engineer", "owner": "Product Dev", "status_history": [], "created_at": ts, "created_by": "seed"})

    # TEST 4 — Bassett Win (PD ordinance)
    t4 = make_tc(name="Franklin Cool Springs PD recognized", project_id=PR["Planned Development Testing"],
                 municipality_id=M["Franklin"], property_id=P["Cool Springs Mixed-Use Site"],
                 category="Special Districts / Entitlements", subcategory="PD", status="Evaluated",
                 criticality=4, difficulty=4, test_type="Ordinance Interpretation", in_regression=True, demo_status="Approved",
                 scenario="Permitted uses for the Cool Springs PD site.", purpose="PD supremacy over base district.",
                 evidence_ids=[E["Cool Springs PD Ordinance 2019-14"]],
                 expected_behaviors=[{"text": "Recognize PD ordinance governs, not base district", "status": "Met"},
                                     {"text": "Cite PD 2019-14", "status": "Met"}],
                 prompts=[{"turn": 1, "text": "What uses are permitted at 1000 Meridian Blvd, Franklin TN?"}])
    make_resp(t4, "Bassett", "This site is within the Cool Springs Planned Development. Permitted uses are governed by PD Ordinance 2019-14 §4, which supersedes the base district. Mixed-use retail/office is permitted.", "Franklin PD 2019-14 §4")
    make_resp(t4, "ChatGPT", "Based on the underlying commercial zoning, mixed-use is likely permitted.", "")
    make_resp(t4, "Claude", "Commercial base district uses probably apply; check for any PD.", "")
    make_gold(t4, "Governed by PD 2019-14; base district does not control.", "PD ordinance supersedes.", [E["Cool Springs PD Ordinance 2019-14"]])
    make_eval(t4, "Bassett", scores([9,9,9,8,9,8,8,9,9,9,9,9]), "Pass", "Correctly applied PD.")
    make_eval(t4, "ChatGPT", scores([5,4,5,6,5,4,5,3,4,5,5,5]), "Needs Improvement", "Used base district.")
    make_eval(t4, "Claude", scores([5,5,5,6,5,5,5,4,5,5,5,5]), "Needs Improvement")
    demo_docs.append({"id": new_id(), "testcase_id": t4, "status": "Approved", "why_good": "Bassett found a difficult PD ordinance both benchmark models missed.",
                      "bassett_version": V19, "approved_by": "QA Manager", "approval_date": ts, "use_case": "PD identification", "created_at": ts, "created_by": "seed"})

    # TEST 5 — Missing Information
    t5 = make_tc(name="Setback question without address", project_id=PR["NYC Zoning Resolution Testing"],
                 municipality_id=M["New York City"], property_id=None, category="Risk Assessment",
                 subcategory="missing information", status="Evaluated", criticality=3, difficulty=2,
                 test_type="Missing Information", scenario="User asks setbacks without giving a property.",
                 purpose="Reward asking for needed info rather than guessing.", evidence_ids=[],
                 expected_behaviors=[{"text": "Ask for the address / district before answering", "status": "Met"}],
                 prompts=[{"turn": 1, "text": "What are my required setbacks?"}])
    make_resp(t5, "Bassett", "I need more information to answer accurately — could you provide the property address or the zoning district? Setbacks vary by district and overlay.", "")
    make_resp(t5, "ChatGPT", "Typical residential front setbacks are 20-30 ft.", "")
    make_resp(t5, "Claude", "Please share the property address or district so I can give accurate setbacks.", "")
    make_gold(t5, "Correct behavior is to request the address/district.", "Insufficient info to answer.", [])
    make_eval(t5, "Bassett", scores([8,7,7,7,9,9,9,7,7,9,8,9]), "Pass", "Appropriately requested info.")
    make_eval(t5, "ChatGPT", scores([3,3,4,5,4,2,3,3,4,4,4,4]), "Fail", "Guessed without context.")
    make_eval(t5, "Claude", scores([8,7,7,7,8,9,9,7,7,8,8,8]), "Pass")

    # TEST 6 — Hallucination
    t6 = make_tc(name="Sterling Heights hallucinated citation", project_id=PR["NYC Zoning Resolution Testing"],
                 municipality_id=M["Sterling Heights"], property_id=None, category="Source / Citation Performance",
                 subcategory="source authority", status="Evaluated", criticality=5, difficulty=3,
                 test_type="Adversarial / Edge Case", in_regression=True, scenario="Ask an obscure setback; watch for made-up citation.",
                 purpose="Detect hallucinated ordinance citations.", evidence_ids=[E["Sterling Heights Setback Table"]],
                 expected_behaviors=[{"text": "Do not fabricate a citation", "status": "Not Met"}],
                 prompts=[{"turn": 1, "text": "What is the R-60 rear setback in Sterling Heights, MI?"}])
    make_resp(t6, "Bassett", "The R-60 rear setback is 35 ft per Sterling Heights Zoning §7.08(c).", "SH §7.08(c)")
    make_resp(t6, "ChatGPT", "I'm not certain of the exact figure; please verify with the city.", "")
    make_resp(t6, "Claude", "I don't have a verified value for that setback — recommend municipal verification.", "")
    make_gold(t6, "Insufficient verified evidence; §7.08(c) as cited does not exist in our verified record.", "Citation appears fabricated.", [E["Sterling Heights Setback Table"]])
    make_eval(t6, "Bassett", scores([2,2,3,5,4,2,3,1,2,3,4,3]), "Critical Fail", "Hallucinated a citation for a high-risk question.")
    make_eval(t6, "ChatGPT", scores([6,5,6,6,6,8,7,6,6,7,5,6]), "Pass with Minor Issues")
    make_eval(t6, "Claude", scores([6,5,6,6,6,8,7,6,7,8,5,6]), "Pass with Minor Issues")
    finding_docs.append({"id": new_id(), "title": "Hallucinated ordinance citation (SH §7.08(c))",
                         "project_id": PR["NYC Zoning Resolution Testing"], "testcase_id": t6, "finding_type": "hallucination",
                         "category": "Source / Citation Performance", "criticality": 5,
                         "description": "Bassett fabricated a citation and setback value for an unverified jurisdiction.",
                         "expected_behavior": "Express uncertainty; recommend verification.", "actual_behavior": "Confident fabricated citation.",
                         "developer_status": "New", "root_cause": "Citation Generation", "failure_modes": ["Hallucinated Citation", "Overly Confident Answer"],
                         "retest_required": True, "retest_status": "Pending", "version_found": V19, "version_fixed": "",
                         "tester": "Test Engineer", "owner": "Product Dev", "status_history": [], "created_at": ts, "created_by": "seed"})

    # TEST 7 — Calculation
    t7 = make_tc(name="Cool Springs FAR calculation", project_id=PR["Parking Requirement Testing"],
                 municipality_id=M["Franklin"], property_id=P["Cool Springs Mixed-Use Site"],
                 category="Calculation Performance", subcategory="FAR", status="Evaluated", criticality=3, difficulty=3,
                 test_type="Calculation", in_regression=True, scenario="FAR for 2.0 on a 50,000 sqft lot.",
                 purpose="Calculation accuracy.", evidence_ids=[E["Cool Springs PD Ordinance 2019-14"]],
                 expected_behaviors=[{"text": "Compute 100,000 sqft max floor area", "status": "Met"}],
                 prompts=[{"turn": 1, "text": "With FAR 2.0 on a 50,000 sqft lot, max building floor area?"}])
    make_resp(t7, "Bassett", "Maximum floor area = 2.0 × 50,000 = 100,000 sq ft.", "")
    make_resp(t7, "ChatGPT", "100,000 sq ft (2.0 × 50,000).", "")
    make_resp(t7, "Claude", "100,000 sq ft.", "")
    make_gold(t7, "100,000 sq ft.", "FAR × lot area.", [E["Cool Springs PD Ordinance 2019-14"]])
    make_eval(t7, "Bassett", scores([9,8,8,10,9,8,8,8,8,8,9,9]), "Pass")
    make_eval(t7, "ChatGPT", scores([9,7,7,10,8,7,7,6,6,7,8,8]), "Pass")
    make_eval(t7, "Claude", scores([9,7,7,10,8,7,7,6,6,7,8,8]), "Pass")

    # TEST 8 — Multi-Turn Context
    t8 = make_tc(name="Multi-turn property context retention", project_id=PR["NYC Zoning Resolution Testing"],
                 municipality_id=M["Franklin"], property_id=P["Cool Springs Mixed-Use Site"],
                 category="Conversational Performance", subcategory="context retention", status="Evaluated",
                 criticality=4, difficulty=4, test_type="Multi-Turn Conversation", in_regression=True,
                 scenario="Ask a follow-up that requires remembering the PD from turn 1.", purpose="Context retention across turns.",
                 evidence_ids=[E["Cool Springs PD Ordinance 2019-14"]],
                 expected_behaviors=[{"text": "Carry forward PD context to turn 2", "status": "Met"}],
                 prompts=[{"turn": 1, "text": "Tell me about 1000 Meridian Blvd, Franklin TN."},
                          {"turn": 2, "text": "And what's the max height there?"}])
    make_resp(t8, "Bassett", "1000 Meridian Blvd is in the Cool Springs PD (Ordinance 2019-14).", "Franklin PD 2019-14", turn=1)
    make_resp(t8, "Bassett", "Within the Cool Springs PD, maximum height is set by PD 2019-14 §4.3 at 65 ft — not the base district limit.", "Franklin PD 2019-14 §4.3", turn=2)
    make_resp(t8, "ChatGPT", "Which property are you asking about?", "", turn=2)
    make_resp(t8, "Claude", "Could you remind me of the address?", "", turn=2)
    make_gold(t8, "Bassett should retain PD context and answer height from PD ordinance.", "Multi-turn memory required.", [E["Cool Springs PD Ordinance 2019-14"]])
    make_eval(t8, "Bassett", scores([9,8,9,8,10,8,9,8,8,9,9,9]), "Pass", "Retained context.")
    make_eval(t8, "ChatGPT", scores([4,4,4,5,3,4,4,4,5,4,4,4]), "Fail", "Lost context.")
    make_eval(t8, "Claude", scores([4,4,4,5,3,4,4,4,5,4,4,4]), "Fail", "Lost context.")

    # TEST 9 — Retest (fail on v1.8, fixed in v1.9)
    t9 = make_tc(name="Franklin permitted use — fixed in v1.9", project_id=PR["Bassett Release Regression"],
                 municipality_id=M["Franklin"], property_id=P["Cool Springs Mixed-Use Site"],
                 category="Zoning Code Requirements", subcategory="permitted uses", status="Retested",
                 criticality=4, difficulty=3, in_regression=True, bassett_version=V19,
                 scenario="Previously failed PD use identification; developer fixed it.", purpose="Verify fix via retest.",
                 evidence_ids=[E["Cool Springs PD Ordinance 2019-14"]],
                 expected_behaviors=[{"text": "Apply PD ordinance for permitted uses", "status": "Met"}],
                 prompts=[{"turn": 1, "text": "Is multifamily permitted at the Cool Springs PD site?"}])
    make_resp(t9, "Bassett", "Yes — multifamily is a permitted use under Cool Springs PD 2019-14 §4.1.", "Franklin PD 2019-14 §4.1", version=V19)
    make_eval(t9, "Bassett", scores([9,9,9,8,9,8,8,9,9,9,9,9]), "Pass", "v1.9 passes.")
    retest_docs.append({"id": new_id(), "testcase_id": t9, "original_version": V18, "new_version": V19,
                        "original_result": "Fail", "original_score": 4.1, "new_result": "Pass", "new_score": 8.8,
                        "original_response": "Multifamily is not permitted (applied base district).",
                        "new_response": "Yes — multifamily permitted under PD 2019-14 §4.1.",
                        "tester": "Test Engineer", "retest_date": ts, "pass_fail": "Pass", "improved": True,
                        "notes": "Fix confirmed; PD ordinance now applied.", "created_at": ts, "created_by": "seed"})

    # TEST 10 — Regression (passed before, fails now)
    t10 = make_tc(name="OKC parking regression — worsened in v1.9", project_id=PR["Bassett Release Regression"],
                  municipality_id=M["Oklahoma City"], property_id=P["2219 Bainbridge Warehouse"],
                  category="Calculation Performance", subcategory="parking calculations", status="Evaluated",
                  criticality=4, difficulty=2, in_regression=True, test_type="Regression",
                  scenario="Parking calc that regressed after v1.9 release.", purpose="Catch regressions across versions.",
                  evidence_ids=[E["OKC Municipal Code §59-9150 Parking"]],
                  expected_behaviors=[{"text": "Compute 40 spaces", "status": "Not Met"}],
                  prompts=[{"turn": 1, "text": "Parking for 40,000 sqft I-2 warehouse in OKC?"}])
    make_resp(t10, "Bassett", "Approximately 80 spaces required (1 per 500 sqft).", "OKC §59-9150", version=V19)
    make_gold(t10, "40 spaces (1 per 1,000 sqft), OKC §59-9150.", "Rate misread in v1.9.", [E["OKC Municipal Code §59-9150 Parking"]])
    make_eval(t10, "Bassett", scores([3,6,4,2,6,6,6,6,7,5,5,4]), "Fail", "Regressed: doubled the count.")
    finding_docs.append({"id": new_id(), "title": "Regression: OKC parking rate misapplied in v1.9",
                         "project_id": PR["Bassett Release Regression"], "testcase_id": t10, "finding_type": "regression",
                         "category": "Calculation Performance", "criticality": 4,
                         "description": "v1.8 computed 40 spaces correctly; v1.9 returns 80 (wrong rate).",
                         "expected_behavior": "40 spaces at 1/1000 sqft.", "actual_behavior": "80 spaces at 1/500 sqft.",
                         "developer_status": "Ready for Retest", "root_cause": "Reasoning", "failure_modes": ["Incorrect Calculation"],
                         "retest_required": True, "retest_status": "Pending", "version_found": V19, "version_fixed": "",
                         "tester": "Test Engineer", "owner": "Product Dev", "status_history": [], "created_at": ts, "created_by": "seed"})

    await db.testcases.insert_many([dict(x) for x in tc_docs])
    await db.responses.insert_many([dict(x) for x in resp_docs])
    await db.goldstandards.insert_many([dict(x) for x in gold_docs])
    await db.evaluations.insert_many([dict(x) for x in eval_docs])
    await db.findings.insert_many([dict(x) for x in finding_docs])
    await db.retests.insert_many([dict(x) for x in retest_docs])
    await db.demos.insert_many([dict(x) for x in demo_docs])

    # Regression suite + runs
    reg_ids = [t for t in [t2, t4, t6, t7, t8, t9, t10]]
    suite_id = new_id()
    await db.regression_suites.insert_one({"id": suite_id, "name": "Core Regression Suite",
                                           "description": "High-value + previously failed tests.", "testcase_ids": reg_ids,
                                           "created_at": ts, "created_by": "seed"})
    await db.regression_runs.insert_many([
        {"id": new_id(), "suite_id": suite_id, "suite_name": "Core Regression Suite", "bassett_version": V18,
         "run_date": "2026-03-05", "total": 7, "passed": 5, "failed": 2, "improved": 0, "worsened": 0,
         "unchanged": 5, "newly_failing": 2, "unresolved": 2, "created_at": ts, "created_by": "seed"},
        {"id": new_id(), "suite_id": suite_id, "suite_name": "Core Regression Suite", "bassett_version": V19,
         "run_date": "2026-05-18", "total": 7, "passed": 5, "failed": 2, "improved": 1, "worsened": 1,
         "unchanged": 4, "newly_failing": 1, "unresolved": 1, "created_at": ts, "created_by": "seed"},
    ])

    await db.activities.insert_one({"id": new_id(), "entity_type": "system", "entity_id": "system",
                                    "action": "Seed data loaded", "user": "seed", "detail": "10 sample tests",
                                    "created_at": ts, "_log": True})
