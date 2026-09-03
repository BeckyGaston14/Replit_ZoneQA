# ZoneQA Bassett Testing — PRD

## Original Problem Statement
Production-ready internal web app for Zoneomics: an AI QA, benchmarking, regression-testing and evaluation platform for **Bassett** (Zoneomics' zoning & land-use AI). Bassett is the product under test; ChatGPT and Claude are benchmark models; authoritative zoning evidence + expert Gold Standards define correctness. NOT a zoning-report QA tool, NOT a bug tracker.

## User Choices
- Auth: password login + opaque HttpOnly sessions with CSRF protection and role-based access.
- Response capture: MANUAL paste/upload (architecture ready for future live LLM APIs).
- Strategy: full end-to-end core workflow + seed data (10 sample tests).
- Branding: Bassett.ai — deep navy/indigo + warm orange, rounded (Poppins) headings, warm-white.

## Architecture
- Backend: FastAPI + PostgreSQL JSONB repository. Opaque server-side sessions, HttpOnly same-origin cookies, CSRF protection, bcrypt, UUID string ids, and role-based access control.
- Frontend: React + React Router + React Query + Tailwind + shadcn/ui + Recharts. Sidebar layout, 13 sections.
- Collections: users, config, projects, municipalities, properties, testcases, responses, goldstandards, evidence, evaluations, findings, retests, regression_suites, regression_runs, demos, models, versions, comments, activities.

## Personas / Roles
Administrator, QA Manager, Tester, Developer/Product, Viewer (read-only).

## Implemented (2026-06)
- Auth + seeded users (admin + 4 role users). RBAC on writes.
- Dashboard (12 live stat cards, model comparison chart, activity feed).
- Bassett Performance/Reward (wins/losses/shared failures, dimension radar, category bars).
- Testing Projects, Municipalities, Properties, Ordinance Evidence (CRUD + Select-or-Add).
- Test Cases (list + guided create with prompt sequence & expected behaviors).
- Test Case detail workspace: Overview, Responses (3 models), Gold Standard, Evidence, Evaluation (12 configurable dimensions), Findings, Retests, Activity.
- AI Comparison: side-by-side 3-model panels, Gold Standard banner, win/comparable/underperform verdict, dimension score bars.
- Findings: list/detail, developer status workflow with status history, bidirectional link to AI Comparison.
- Regression Testing: suite + historical runs (v1.8 vs v1.9).
- Demo Library, Reports (CSV + JSON export), Administration (configurable lookups, scoring weights, models, versions, users).
- Seed data: 10 sample tests (pass, citation fail, benchmark win, Bassett win, missing info, hallucination, calculation, multi-turn, retest, regression).
- Tested: backend 25/25 pytest; frontend core flows verified end-to-end.

## Implemented (2026-02 session 2) — all tested 45/45 backend + 12/12 UI flows
- **Response Annotation**: select text in any captured response → floating Annotate button → typed issue (config `annotation_types`) + note anchored to exact excerpt (start/end offsets). Highlights render inline with tooltips; annotation list per response with delete + promote-to-Finding (links `finding_id`). Collection: `annotations`; included in `/api/testcases/{id}/full`.
- **Bulk CSV Import**: Test Cases → Import CSV → client-side parse → auto-guessed column mapping UI → optional project assignment → POST `/api/import/testcases` with duplicate detection (name + municipality), auto-creates unknown municipalities, created/skipped summary. Imported docs tagged `source: csv_import`.
- **Authentication hardening**: password verification is followed by an opaque, revocable server-side session. Browser storage contains no auth token; inactive users are denied on every request.
- **Release Readiness** (`/release`): per-version GO / CONDITIONAL / NO-GO banner with reason, pass rate, avg score, failed tests, open findings (crit-4/5), regression run, blockers list. Logic: NO-GO if open crit-5 findings / Critical Fail evals / pass<70; CONDITIONAL if crit-4 / new regressions / pass<85. `GET /api/release-readiness?version=`.
- **Live Model Runs**: Bassett live runs use the configured endpoint and a single approved credential header. Benchmark and AI-assist actions remain unavailable until a supported provider is configured.
- Admin → Integrations tab: Bassett API URL/key (key masked on GET; blank preserves, null clears), ChatGPT/Claude model names.
- Backend test suite at /app/backend/tests (45 tests: 25 regression + 20 new-feature).

## Implemented (2026-02 session 2, batch 2) — tested 14/14 backend + 5/5 UI flows (iteration_3)
- **AI Pre-Scoring**: Evaluate modal "AI Pre-Score" button → `POST /api/testcases/{id}/prescore {model}` sends prompts + Gold Standard + configured eval dimensions to gpt-5.4 (configurable `integrations.ai_assist_model`), returns draft scores/final_result/rationale. Draft-only: reviewer confirms/adjusts then saves (`ai_prescored` flag stored). Requires a Gold Standard (400 otherwise).
- **Claim-Level QA**: "Claim QA" tab on test case detail. `POST /api/responses/{id}/extract-claims` (AI decomposes response into ≤12 atomic claims with citations, idempotent — returns existing claims without re-calling LLM). Reviewer verdicts per claim (Verified / Partially Correct / Unsupported / Incorrect) + note; verdict summary chips per model. Collection: `claims` (in `/full` payload).
- **Saved Views**: Test Cases filter bar (status/category/criticality/project) + column show/hide popover, auto-persisted per user via `GET/PUT /api/views/{page}` (saved_views collection); restored across sessions/devices; unknown sentinel values normalized on load.
- **Executive Summary** (`/executive`): KPI cards (Bassett accuracy vs benchmark avg, pass rate, wins/losses, open critical, competitive edge), auto-generated takeaway bullets, quarterly accuracy trend line chart (Bassett vs ChatGPT vs Claude), top failure modes, category performance. `GET /api/analytics/executive`.
- **Sidebar regroup** (user-provided reference image): sections OVERVIEW / DATA / EVALUATION / OUTPUT / SYSTEM with orange live count badges (projects, tests, open findings, approved demos) — Bassett navy branding preserved.
- Test suites: /app/backend/tests/test_iter3_features.py (14), test_new_features.py (20), backend_test.py (25).

## Implemented (2026-02 session 2, batch 3) — tested 17/17 backend + all UI flows (iteration_4)
- **Test Coverage** (`/coverage`): gap analysis — municipalities/categories/criticality levels with test + evaluated counts, red "NO TESTS" flags, gap summary KPIs. `GET /api/analytics/coverage`.
- **Competitive Insights** (`/insights`): head-to-head W-L-T records vs ChatGPT & Claude, loss/win battle cards (score deltas, side-by-side eval notes, top-3 dimension gaps, linked "competitor advantage" findings), dimension averages chart. `GET /api/analytics/competitive`. Weakness banner renders only when Bassett trails on a dimension average.
- **Testing Calendar** (`/calendar`): month grid aggregating project kickoffs/deadlines, version releases, regression runs (readonly) + user-schedulable events (calendar_events CRUD, viewer read-only); legend, Upcoming panel, click-day-to-schedule. `GET /api/calendar/all-events`. 2 seeded future events (Aug 21 regression, Sep 4 readiness review).
- **PDF Reports**: Executive Summary "Download PDF" (client-side html2canvas scale 1.5 + jsPDF JPEG q0.85, multi-page A4, Bassett-Executive-Summary-YYYY-MM-DD.pdf).
- Sidebar: Competitive Insights + Test Coverage under EVALUATION, Calendar under OUTPUT (matches user's reference image).
- Cumulative backend regression: 76 pytest cases green (+ test_iter4_features.py 17).

## Implemented (2026-02 session 2, batch 4) — tested 15/15 backend + all UI flows (iteration_5)
- **File Attachments** (Replit App Storage): testers attach ordinance PDFs/screenshots to Findings, Evidence, and Test Cases. Uploads and downloads use the same HttpOnly session as the rest of the application.
- Cumulative backend regression: 91 pytest cases green (+ test_iter5_attachments.py 15). Stale test municipality removed.

## Implemented (2026-02 session 2, batch 5) — self-tested (curl round-trip + UI E2E screenshot)
- **Test Variants**: `POST /api/testcases/{id}/clone` copies project/muni/property/category/criticality/expected behaviors (+ Gold Standard as Draft), accepts overrides (name, prompts, scenario, purpose), sets `variant_of` lineage, status Draft, fresh responses/evals. UI: "Clone Variant" button on test case detail → modal to tweak name/scenario/prompt sequence → navigates to new variant. Lineage chips: "Variant of: <parent>" (links back) + variant count on parent; Variants card in Overview tab. One demo variant kept: "NYC C5-3 retail permitted use (Variant)".
- **Variant Comparison** (`/testcases/{id}/variants`): side-by-side family view (Original + variants) showing phrasing, Bassett response, score & result per column; auto "Best phrasing" (green ring) vs "Trips Bassett" (red ring) verdict when ≥2 scored. `GET /api/testcases/{id}/variant-comparison` (resolves family from any member). Entry points: "Compare N variants →" chip on parent, "Compare family →" link on variants, link in Variants card. Demo variant seeded with Bassett Fail response/eval (4.2) vs original Pass (8.7).






## Implemented (2026-02 session 2, batch 6 — Data Integrity Iteration) — tested 15/15 new + 102 regression green (iteration_6)
User provided a 13-priority spec (trustworthy metrics, test runs, workflow, retest loop, reviewer control, evidence provenance, etc.). Implemented:
- **P1 Metrics**: `GET /api/metrics/summary` = single source of truth; every metric carries unit/denominator/definition; cleaned 7 orphaned evals/responses/golds (+1 annotation) that inflated counts; Dashboard cards relabeled ("7 of 11 passed · latest eval per test", all-model bucket explicitly labeled mixed); hover definitions via title attr.
- **P2 Test Runs (partial)**: `test_runs` collection; live runs create run records; old responses marked `superseded:true` (never deleted); Run History block on Responses tab; Responses tab shows only current responses.
- **P3 Workspace**: workflow stepper (Setup→…→Complete) + context-sensitive primary action, tab count badges, sticky context bar (title/crit/status/version/env), Prev/Next test nav, activity + empty states everywhere.
- **P4 Retest loop**: `POST /api/findings/{id}/start-retest` (captures original version-matched response/eval/failure modes) + `POST /api/retests/{id}/complete` (5 verdicts) auto-updates finding status/retest_status/status_history + activity on finding & test case. UI: Start Retest on Findings, Complete Retest modal on Retests tab. Seeded 'Ready for Retest' finding was consumed by acceptance test (now Fixed w/ Bassett v2.0 retest — intentional demo data).
- **P5 Reviewer control**: EvalModal computes weighted score (config weights) + system recommendation (≥8.5 Pass / ≥7 Minor / ≥5 NI / ≥3 Fail bands), reviewer final result separate, override reason REQUIRED when differing, reviewer/reviewed_at stored; Evaluation tab shows Weighted/System Rec./Reviewer Final columns. Release Readiness: banner labeled "System Recommendation", admin/qa_manager Record Final Decision (GO/CONDITIONAL/NO-GO + notes, decision_history preserved) via `POST /api/release-readiness/decision`.
- **P6 Gold/Evidence (partial)**: Gold Standard limitations/version fields, "Insufficient Verified Evidence" status (explanation required), confirm-warning before approving without Verified evidence, persistent warning banner, verified-evidence count display.
- **P7 (partial)**: conversation view (user prompt interleaved above each response turn per model), environment/version shown per response, raw responses immutable.
- **P8**: New Test form separates Test Purpose from Expected Behaviors; behaviors add/remove/reorder (▲▼); evaluation marks each behavior Met/Partially Met/Not Met/N/A (reflected on test case for Bassett).
- **P9 (partial)**: Findings filters (status/criticality/type/retest status) + result count.
- **P11**: verified clone inherits setup only (0 responses/evals/findings/retests), Draft shows "Not Evaluated".
- **P12**: sidebar consolidated Work/Releases/Analytics/Reference Data/System; Calendar removed from nav (route /calendar still live).


## Implemented (2026-02 session 2, batch 7 — Evidence Provenance) — self-tested (UI E2E screenshots)
- Evidence records extended: jurisdiction, issuing_authority, document_version, exact section, page_number, superseded_date, verified_by + verified_date, source_url, conflicts_with (relation link to another evidence record).
- Verification statuses migrated to canonical set: Unverified / Verification in Progress / Verified / Superseded / Conflicting / Rejected (legacy "Tester/Expert Verified", "Municipality Confirmed" → Verified). VerificationBadge component (text + color, not color-alone).
- Evidence list shows Issuing Authority, verification badge with verifier/date, superseded flag, conflict indicator; test case Evidence tab shows full provenance line + amber conflict-warning banner when conflicts_with set.
- Seed evidence enriched with real provenance values; Sterling Heights record set to "Verification in Progress".

## Implemented (2026-02 session 2, batch 8 — Evidence Freshness) — self-tested (curl + UI E2E screenshot)
- Municipalities gained `latest_amendment_date` field (form + list column) — drives freshness flags.
- Freshness rules: evidence is STALE if `superseded_date` set OR `effective_date < municipality.latest_amendment_date`.
- Backend enriches `/api/testcases/{id}/full` evidence entries with `freshness_warning`; Evidence list computes flags client-side via munis map.
- UI: red "⚠ STALE — Predates …" pill on Evidence list (data-testid evidence-stale-flag) + red banner on test case evidence cards (evidence-freshness-warning).
- Demo: NYC latest amendment set to 2026-01-15 → NYC ZR §32-00 evidence (effective 2025-11-01) flagged in both places.


## Implemented (2026-02 session 2, batch 9 — 17-issue QA review fixes) — tested 17/17 + 118/119 regression (iteration_7)
- (1) Variant with real eval → status Evaluated (Draft+Fail contradiction gone); fresh clones show Draft + Not Evaluated.
- (2) Executive & Performance analytics now dedupe to latest eval per (testcase, model), filter orphans — ALL dashboards reconcile at 11 evaluated / 63.6% / avg 6.8; scope statements shown under Executive/Performance/Readiness titles.
- (3) AI Comparison filters superseded responses; each response captioned Turn · Latest run · version · capture method · date.
- (4) Release decision override hardened: server computes override itself (client flag not trusted), requires ≥20-char rationale + explicit risk acceptance + confirm dialog; banner shows "GO + OVERRIDE — system said NO-GO" with blockers-at-decision; weak demo GO deleted; stores system_recommendation_at_decision.
- (5) Project version UUIDs resolved to names; (6) blank property deleted.
- (7) Sticky context shows "Retested — Fixed in Bassett v2.0 (Staging)" chip (original result untouched).
- (8/10) Workflow "Complete" = all prior stages record-complete (deterministic); step tooltips added.
- (9) 79 activity events backfilled for historical responses/evals/findings/retests/golds (script: /app/scripts/backfill_activities.py).
- (14) Grammar: "N tests · M evaluations" pluralized; list pages plural (Testing Projects/Municipalities/Properties) with singular modal titles.
- (Freshness propagation) Gold Standard tab shows "REVERIFICATION REQUIRED" banner when supporting evidence is stale.
- WARNING for agents: activities use entity_id NOT testcase_id — never orphan-clean activities with testcase_id filters.

### Deferred from the 17-issue review (documented):
- (11) v2.0 regression-run distinction on Readiness; (12) persistent version/environment/date scope filters on Performance/Executive/Comparison/Findings/Coverage; (13) chart label wrapping; (15) Comparison collapse/sticky redesign; (16) richer workflow counters ("3 model slots" wording); (17) 4-way empty-state distinctions; freshness propagation to comparison/evaluation/release blockers; attachment thumbnail metadata (type/size/verification); shadcn AlertDialog for override confirm; cascade delete of child records on testcase delete; activities index (entity_id, created_at).


### NOT implemented from the 13-priority spec (declared partial/deferred):
- P2: dashboards still read from latest-eval-per-testcase rather than first-class TestRun entities (manual paste doesn't create a run record yet).
- P6: extended evidence schema fields (jurisdiction, issuing authority, superseded date, verified by/date, page number, conflicting evidence links, source URL) — evidence form unchanged.
- P7: per-turn evaluation references; pre-run confirmation dialog for Run All Models.
- P9: filters for failure mode/root cause/municipality/project/assignee/version/environment; due dates.

## Implemented (2026-02 session 3 — Operational Regression Suites + Assignments & Threaded Comments) — tested 21/21 new pytest + 140 cumulative green + UI E2E (iteration_8 GREEN)
- **P10 Operational Regression Suites**: `POST /api/regression/suites/{id}/execute {bassett_version, environment, notes, baseline_run_id?}` snapshots the latest Bassett evaluation per suite test case, compares against baseline (explicit run or auto = latest prior snapshot run), computes per-test delta (improved / regressed / still_pass / still_fail / new / not_evaluated) + aggregates (passed/failed/improved/worsened/newly_failing/not_evaluated). Runs stored with embedded `results[]`, `locked:true` — PUT always 403, DELETE admin-only. Regression page rebuilt: suite CRUD (New/Edit modal with searchable test case checkboxes), Run Suite modal (version/environment/baseline shadcn selects, notes), expandable Run History rows with per-test baseline-vs-current table + delta chips, lock icons, legacy-run explanation for pre-operationalization v1.8/v1.9 rows. Seeded `Bassett v2.0` version (status Upcoming-style, NOT active — v1.9 remains active version) + one v2.0 demo snapshot run.
- **P13 Assignments**: `POST /api/assign {entity_type: testcases|findings|evaluations, entity_id, assignee_id|null}` sets assignee_id/name + assigned_by/at, logs activity, validates user. UI: AssigneePicker component in TestCaseDetail sticky bar + Findings detail panel; orange @Name chip on finding list rows; viewers see read-only text.
- **P13 Threaded Comments with @mentions**: comments excluded from generic CRUD (explicit routes now authoritative). `POST /api/comments` accepts parent_id (replies flatten to one level — reply-to-reply attaches to root) + mentions[] (validated against users); logs "commented" activity on testcases/findings. `DELETE /api/comments/{id}` = soft delete (author or admin/qa_manager) preserving thread. UI: CommentsThread component (composer with @ autocomplete dropdown, orange mention highlighting, inline replies, delete) on TestCaseDetail "Discussion" tab (with count badge) + Findings detail panel.
- Fixed stale test: test_iter6 release-decision now supplies override rationale + risk_accepted (matches iter7 hardened contract).
- Test suite: /app/backend/tests/test_iter8_regression_collab.py (21).

## Implemented (2026-02 session 3, batch 2 — Final Consistency & Data-Integrity Pass) — tested 19 new pytest + 159 cumulative green + iteration_9 GREEN (all 13 UI flows)
- **(1) Canonical Bassett score**: dashboard_stats now dedupes to latest Bassett eval per valid test case — Dashboard, Performance Overall card (reads model_summary), Metrics Summary and Executive all reconcile at 6.8 (was 6.9 on Performance card).
- **(2) Canonical retests**: status (Pending/In Progress/Completed/Cancelled) + separate outcome (Fixed/Partially Fixed/Not Fixed/New Regression Introduced/Unable to Verify); complete-retest sets outcome/completed_at/reviewer; both demo retests migrated to Completed → Dashboard shows "2 · 2 completed"; integrity check flags completed retests missing required fields.
- **(3) Release-decision snapshot**: POST decision captures immutable server-side snapshot (version, environment, date, system rec + reason, pass rate, evaluated/passed/failed, avg, findings, crit fails, regressions, blocker count + full blocker objects). GET readiness computes `state_changed` (+detail) when blockers/pass-rate/recommendation drift from snapshot → red "Decision based on an earlier snapshot" strip + Re-evaluate Final Decision button. Pass-rate<70% now appears as an explicit "Threshold Failure" blocker (v1.9 has 4 blockers). Legacy test decision replaced with realistic pilot-only rationale.
- **(4) Override presentation**: structured dl (Final Decision / Decision Type / System Rec at Decision / Risk Accepted / Rationale / Maker / Date), amber "GO WITH RISK ACCEPTANCE" badge, expandable blocker-snapshot details, confirm dialog lists blocker snapshot. NO-GO/COND buttons have testids.
- **(5) Regression baseline required for comparison**: no-baseline runs store None for improved/worsened/newly_failing/fixed/unchanged → UI renders N/A ("no baseline selected"), never 0; modal warns when suite has no snapshot baseline; existing v2.0 run migrated to N/A; runs with baseline compute fixed(=fail→pass) too.
- **(6) Variant independence verified**: NYC variant has own response + eval; migration created its own test_run record + eval environment/run_id. Integrity check flags variants with eval but no own response.
- **(7) Performance scope & filters**: exact scope line ("Latest non-retest evaluation for each test case · regardless of Bassett version · …") + 9 visible filters (version/environment/project/municipality/category/criticality/variants/date-from/date-to + clear) driving /api/analytics/performance query params; scope string included in payload.
- **(8) Stale-gold propagation**: compute_stale_gold_map helper; /full + /comparison return gold_stale + evidence names; AI Comparison label "Gold Standard — Approved Historically, Reverification Required" + amber warning; Evaluation tab warning; Gold tab derived state "Approved — Reverification Required"; Release Readiness stale-gold panel; Executive takeaway bullet + stale_gold_tests; Demo Library "GOLD REVERIFICATION REQUIRED" chip; enriched list gold_stale flag.
- **(9) Chart labels**: WrapTick (2-line wrapped category labels) + SrTable (sr-only accessible table) on Performance category, Executive failure-modes/categories, Insights dimensions; tooltips show full text; row heights scale.
- **(10) Formatting helpers**: /app/frontend/src/lib/format.js (plural, fmtScore, fmtPts, fmtPct) — Executive says "by 1.0 point" etc.; consistent 1-decimal scores.
- **(11) Test-activity hygiene**: activities & comments auto-tag source=automated_test at write time (pytest/TEST_iter/curl-smoke patterns); GET /activities & GET /comments exclude them by default (admin ?include_test_data=true); migration marked 120+ historical records, deleted pytest comments + orphaned test records; iter6/iter7 decision tests re-pointed to synthetic "Bassett vTEST-decision" so they never overwrite the real v1.9 decision; Dashboard feed omits trailing middot for empty details.
- **(12) Data Integrity view**: GET /api/admin/integrity (admin/qa_manager) + /integrity page (System nav, role-gated): 12 check families (status/eval contradictions, variant inheritance, retest completeness, Fixed-without-retest, decisions without snapshot, no-baseline runs, stale-gold approvals, orphaned FKs, unnamed records, dashboard reconciliation) with severity/repair/link per issue. Current baseline: 2 high (stale NYC golds — intentional demo), 1 medium (missing municipality ref), 1 low (no-baseline run).
- Migrations: /app/scripts/migration_final_pass.py, /app/scripts/cleanup_orphans.py (deleted 4 orphan evals, 4 responses, 11 orphan gold drafts from deleted clone tests).
- Test suite: /app/backend/tests/test_iter9_consistency.py (19).

## Implemented (2026-02 session 3, batch 3 — One-Click Integrity Repairs) — tested 13 new pytest + 172 cumulative green + UI dialog flow verified
- **Repair actions on integrity issues**: each safely-automatable issue now carries a machine-executable `repair_action` (key/label/effect/destructive/params): reset_status_draft, set_status_evaluated, reset_variant_draft (destructive), backfill_retest, complete_retest_status, recompute_snapshot (flagged as backfill), clear_reference (broken project/municipality/property FKs), delete_orphan (destructive). Substantive QA judgments (stale gold reverification, Fixed-without-retest, unnamed records, no-baseline runs, metric reconciliation) remain "Manual review" only.
- **`POST /api/admin/integrity/repair`** (admin/qa_manager): every handler re-validates preconditions live and returns 409 if the issue no longer applies (e.g., an evaluation now exists, reference now resolves, record not orphaned); repairs logged to activity as "integrity repair · {key}" with record name (test-created repairs auto-tagged).
- **Guided confirmation dialog** (DataIntegrity.jsx): Repair button per row → AlertDialog showing Record, Problem, exact "What this repair will do" effect; destructive repairs additionally require an explicit "cannot be undone" acknowledgement checkbox before Apply is enabled; success toast + auto-refresh.
- **Cascade delete (root-cause fix)**: deleting a test case now cascades evaluations/responses/annotations/claims/goldstandards/retests/test_runs/findings (logged) — orphaned records can no longer accumulate.
- **Fixed long-standing flaky test**: test_viewer_cannot_import failed in xdist because test_admin_change_and_revert briefly flips the viewer role in a parallel worker; now race-tolerant with cleanup+retry. Repaired live data: cleared broken municipality ref (via the UI dialog), deleted leftover orphan records/leaked TEST_viewer_denied testcase.
- Integrity baseline after full test suite: 2 high (intentional stale NYC golds) + 1 low (no-baseline run) + 0 medium.
- Test suite: /app/backend/tests/test_iter10_repairs.py (13).

## Backlog / Remaining (P1/P2)
- P1: User pastes Bassett API key in Admin → Integrations to activate Bassett live runs (only remaining step for feature 5).
- P1: Saved views for other list pages (findings, municipalities).
- P2: Double Review & Disagreement Tracking for Criticality-5 tests; In-app notifications (+ future Slack/email) incl. @mention inbox; Calendar tied to real assignment due dates; My Assignments page; Audit History admin page; promote-fixed-finding-to-regression-suite shortcut.
- P2: Backend refactor — split server.py (~2040 lines) into /app/backend/routes modules.
- P2: bulk import from existing Lovable app, weekly leadership digest email.

## Next Tasks
See Next Action Items in finish summary.
