import { useEffect, useState } from "react";
import { useParams, useNavigate, Link, useSearchParams } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api, formatApiErrorDetail, staleUpdateMessage, withExpectedVersion } from "../lib/api";
import { useConfig } from "../lib/hooks";
import { useAuth } from "../lib/auth";
import { CritBadge, ResultBadge, ScorePill } from "../components/shared";
import { AnnotatedResponse } from "../components/AnnotatedResponse";
import { CommentsThread } from "../components/CommentsThread";
import { AssigneePicker } from "../components/AssigneePicker";
import { ClaimsPanel } from "../components/ClaimsPanel";
import { Attachments } from "../components/Attachments";
import { VerificationBadge } from "./Resources";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "../components/ui/tabs";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import { Textarea } from "../components/ui/textarea";
import { FormModal, Field, ListSelect } from "../components/forms";
import { ArrowLeft, Plus, Flag, Columns3, Star, Zap, Play, Loader2, Sparkles, CopyPlus, GitBranch, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { RESULT_COLORS } from "../lib/api";
import { SortableTableHeader } from "../components/SortableTableHeader";
import { TableSortControls } from "../components/TableSortControls";
import { TestCaseActions } from "../components/TestCaseActions";
import { ConfirmActionDialog } from "../components/ConfirmActionDialog";
import {
  COMPARISON_RUN_STATUSES, COMPARISON_SLOT_STATUSES, DEMO_STATUSES,
  EXPECTED_BEHAVIOR_STATUSES, FINDING_STATUSES, GOLD_STANDARD_STATUSES,
  RETEST_LIFECYCLE_STATUSES, RETEST_STATUSES, StatusBadge, StatusLegend,
  TEST_CASE_STATUSES, TEST_WORKFLOW_STATUSES,
} from "../lib/statusMaps";
import { nextSort, sortTableRows, usePersistentTableSort } from "../lib/tableSorting";
import { formatTestDate, todayInTimeZone } from "../lib/testDates";
import { MODEL_COLORS, MODEL_ORDER } from "../lib/modelColors";
import { QueryState } from "../components/PageState";
import { SCORE_RUBRIC, hasScoredDimension, scoreRubricReason } from "../lib/scoreRubric";

const ANN_TO_FINDING = {
  "Citation Problem": "citation problem", "Hallucination": "hallucination",
  "Outdated Regulation": "outdated ordinance", "Misinterpretation": "incorrect interpretation",
  "Incorrect Calculation": "incorrect calculation", "Missing Context": "missing context",
};

const MODELS = MODEL_ORDER;
const TESTCASE_TABS = ["overview", "responses", "claims", "gold", "evidence", "evaluation", "findings", "retests", "discussion", "activity"];
const DIMS = [["accuracy", "Accuracy"], ["current_code", "Current Code"], ["interpretation", "Interpretation"], ["calculation", "Calculation"], ["context", "Context"], ["missing_info", "Missing Info"], ["followup", "Follow-Up"], ["citation_accuracy", "Citation"], ["source_quality", "Source Quality"], ["guidance", "Guidance"], ["completeness", "Completeness"], ["usefulness", "Usefulness"]];
const EVALUATION_COLUMNS = [
  { key: "model", label: "Model", type: "natural" },
  { key: "score", label: "Weighted", type: "score", getValue: (row) => row.evaluation?.overall_score },
  { key: "system", label: "System Rec.", type: "status", getValue: (row) => row.evaluation?.system_recommended },
  { key: "final", label: "Reviewer Final", type: "status", getValue: (row) => row.evaluation?.final_result },
];

export default function TestCaseDetail() {
  const { id } = useParams();
  const nav = useNavigate();
  const [sp, setSp] = useSearchParams();
  const qc = useQueryClient();
  const { user } = useAuth();
  const { data: config } = useConfig();
  const { data, isLoading, isError, error, refetch } = useQuery({ queryKey: ["tc-full", id], queryFn: async () => (await api.get(`/testcases/${id}/full`)).data });
  const [respModal, setRespModal] = useState(null);
  const [evalModal, setEvalModal] = useState(null);
  const [findModal, setFindModal] = useState(false);
  const [goldModal, setGoldModal] = useState(false);
  const [annotModal, setAnnotModal] = useState(null);
  const [variantModal, setVariantModal] = useState(false);
  const defaultEvaluationSort = { key: "model", direction: "asc" };
  const [evaluationSort, setEvaluationSort] = usePersistentTableSort(`testcase-evaluations-${id}`, EVALUATION_COLUMNS, defaultEvaluationSort);
  const [retestModal, setRetestModal] = useState(null);
  const requestedTab = sp.get("tab");
  const tab = TESTCASE_TABS.includes(requestedTab) ? requestedTab : "overview";
  const setTab = (nextTab) => {
    const params = new URLSearchParams(sp);
    if (nextTab === "overview") params.delete("tab");
    else params.set("tab", nextTab);
    setSp(params);
  };
  useEffect(() => {
    if (requestedTab && !TESTCASE_TABS.includes(requestedTab)) {
      const params = new URLSearchParams(sp);
      params.delete("tab");
      setSp(params, { replace: true });
    }
  }, [requestedTab, sp, setSp]);
  const [running, setRunning] = useState(false);
  const [runModal, setRunModal] = useState(null);

  const roleCanWrite = user && user.role !== "viewer";
  const { data: allTcs = [] } = useQuery({ queryKey: ["tc-nav"], queryFn: async () => (await api.get("/testcases")).data });
  const { data: comments = [] } = useQuery({ queryKey: ["comments", id], queryFn: async () => (await api.get(`/comments/${id}`)).data });

  if (isLoading) return <QueryState query={{ isLoading }} resource="test case" testId="testcase-detail" />;
  if (isError || !data) return <QueryState query={{ isError: true, error, refetch }} resource="Test case" onRetry={refetch} notFoundAction={() => nav("/testcases")} testId="testcase-detail" />;
  const { testcase: tc, responses, gold_standard, evaluations, findings, retests, activities, evidence, project, municipality, property, annotations = [], claims = [], variants = [], parent = null, test_runs = [] } = data;
  const canWrite = roleCanWrite && !tc.archived;
  // A comparison is a single three-model execution. Keep evaluations tied to
  // that execution so partial runs cannot be treated as complete analytics.
  const comparisonRun = test_runs.find((r) => (r.models || []).length === 3
    || r.slot_status || r.slot_results || r.comparison === true) || null;
  const slotValue = (run, model) => run?.slot_status?.[model] ?? run?.slot_results?.[model] ?? run?.results?.[model];
  const slotState = (run, model) => {
    let value = slotValue(run, model);
    if (value && typeof value === "object") {
      if (value.ok === true) return "completed";
      value = value.status || value.state || value.result || value.error;
    }
    const text = String(value || "").toLowerCase();
    if (/(captured|complete|success|^ok$)/.test(text)) return "completed";
    if (/(fail|error|unavailable|missing|incomplete|blocked)/.test(text)) return "incomplete";
    // Legacy runs did not expose slot state; use their retained response.
    if (!value && (!run || responses.some((r) => (
      r.model === model && r.availability !== "unavailable"
      && String(r.response || "").trim() && !r.superseded
      && (!run || !r.run_id || r.run_id === run.id)
    )))) return "completed";
    return "incomplete";
  };
  const incompleteModels = MODELS.filter((m) => slotState(comparisonRun, m) !== "completed");
  const comparisonStatus = comparisonRun
    ? (comparisonRun.run_status || comparisonRun.status || (incompleteModels.length ? "Completed with Errors" : "Completed"))
    : null;
  // The API returns evaluations newest-first with an id tie-breaker. Unscoped
  // evaluations remain available for legacy pasted-response workflows.
  const evalFor = (m) => evaluations.find((e) => e.model === m
    && (!comparisonRun || e.run_id === comparisonRun.id));
  const evaluationRows = sortTableRows(MODELS.map((model) => ({ model, evaluation: evalFor(model) })), EVALUATION_COLUMNS, evaluationSort, ["model"]);
  const respFor = (m) => responses.filter((r) => r.model === m && !r.superseded).sort((a, b) => a.turn - b.turn);
  const supersededCount = responses.filter((r) => r.superseded).length;

  // Prev / Next navigation
  const navIdx = allTcs.findIndex((t) => t.id === id);
  const prevTc = navIdx > 0 ? allTcs[navIdx - 1] : null;
  const nextTc = navIdx >= 0 && navIdx < allTcs.length - 1 ? allTcs[navIdx + 1] : null;

  // Workflow stage: Setup → Responses → Evidence → Evaluation → Findings → Complete
  const bassettEval = evalFor("Bassett");
  const goldApproved = gold_standard && ["Approved", "Insufficient Verified Evidence"].includes(gold_standard.review_status);
  const failedEval = bassettEval && ["Fail", "Critical Fail", "Needs Improvement"].includes(bassettEval.final_result);
  const STAGES = [
    { key: "setup", label: "Setup", done: (tc.prompts || []).some((p) => p.text) && !!gold_standard, req: "Define prompts and draft a Gold Standard" },
    { key: "responses", label: "Responses", done: responses.some((r) => !r.superseded), req: "Capture at least one model response" },
    { key: "evidence", label: "Evidence", done: evidence.length > 0 && goldApproved, req: "Link evidence and approve the Gold Standard" },
    { key: "evaluation", label: "Evaluation", done: !!bassettEval, req: "Complete the Bassett evaluation" },
    { key: "findings", label: "Findings", done: !failedEval || findings.length > 0, req: "File a finding for the failed evaluation" },
  ];
  // Complete only when every prior stage is genuinely complete (record-based, not status-based)
  STAGES.push({ key: "complete", label: "Complete", done: STAGES.every((s) => s.done), req: "" });
  const stageIdx = STAGES.findIndex((s) => !s.done);
  const currentStage = stageIdx === -1 ? STAGES.length - 1 : stageIdx;
  const latestRetest = [...retests].filter((r) => r.verdict).sort((a, b) => (a.retest_date || "").localeCompare(b.retest_date || "")).slice(-1)[0];
  const PRIMARY = {
    0: { label: "Continue to Responses", tab: "responses" },
    1: { label: "Capture Responses", tab: "responses" },
    2: { label: "Continue to Evidence", tab: "evidence" },
    3: { label: "Complete Evaluation", tab: "evaluation" },
    4: { label: "Create Finding", tab: "findings", action: () => setFindModal(true) },
    5: { label: "Workflow Complete", tab: "overview" },
  };

  const TAB_COUNTS = { responses: responses.filter((r) => !r.superseded).length, claims: claims.length, evidence: evidence.length, evaluation: evaluations.length, findings: findings.length, retests: retests.length, discussion: comments.filter((c) => !c.deleted).length, activity: activities.length };

  const refresh = () => qc.invalidateQueries({ queryKey: ["tc-full", id] });

  const runModels = async () => {
    const { models, test_date } = runModal;
    setRunning(true);
    toast.info(`Running ${models.join(", ")} — this may take up to a minute…`);
    try {
      const { data: res } = await api.post(`/testcases/${id}/run`, { models, test_date });
      Object.entries(res.results).forEach(([m, r]) =>
        r.ok ? toast.success(`${m}: response captured`) : toast.error(`${m}: ${r.error}`, { duration: 9000 }));
      refresh();
      setRunModal(null);
    } catch (e) {
      toast.error(mutationError(e, "Run failed"));
    } finally { setRunning(false); }
  };

  const resumeComparison = async () => {
    if (!comparisonRun || incompleteModels.length === 0) return;
    setRunning(true);
    try {
      const { data: res } = await api.post(`/testcases/${id}/runs/${comparisonRun.id}/retry`, { models: incompleteModels });
      toast.success(res.status === "Completed" ? "Comparison completed" : `Resumed ${incompleteModels.join(", ")}`);
      refresh();
    } catch (e) {
      toast.error(mutationError(e, "Unable to resume incomplete slots"));
    } finally { setRunning(false); }
  };

  const deleteAnnotation = async (a) => { await api.delete(`/annotations/${a.id}`); toast.success("Annotation removed"); refresh(); };

  const promoteAnnotation = async (a) => {
    const { data: f } = await api.post("/findings", {
      title: `${a.annotation_type}: “${(a.quoted_text || "").slice(0, 60)}${(a.quoted_text || "").length > 60 ? "…" : ""}”`,
      finding_type: ANN_TO_FINDING[a.annotation_type] || "Bassett error",
      criticality: tc.criticality || 3, developer_status: "New",
      description: `Annotated excerpt from ${a.model} response:\n“${a.quoted_text}”\n\nNote: ${a.note || "—"}`,
      testcase_id: tc.id, project_id: tc.project_id, category: tc.category,
      annotation_id: a.id, model: a.model, retest_required: true, retest_status: "Pending", status_history: [],
    });
    try {
      await api.put(`/annotations/${a.id}`, withExpectedVersion(a, { finding_id: f.id }));
      toast.success("Finding created from annotation");
      refresh();
    } catch (error) {
      toast.error(staleUpdateMessage(error) || formatApiErrorDetail(error?.response?.data?.detail) || "Unable to link the finding.");
      if (error?.response?.status === 409) refresh();
    }
  };


  return (
    <div>
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2 mb-3">
        <div className="flex flex-wrap items-center gap-3">
          <button type="button" onClick={() => nav("/testcases")} className="flex items-center gap-1 text-sm text-muted-foreground hover:text-[var(--navy)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--orange)] focus-visible:ring-offset-2 rounded"><ArrowLeft size={15} aria-hidden="true" /> Test Cases</button>
          {tc.bassett_issue_id && <Link to={`/bassett/issues?open=${encodeURIComponent(tc.bassett_issue_id)}`} className="flex items-center gap-1 text-sm font-semibold text-[var(--orange)] hover:underline" data-testid="back-to-bassett-run"><ArrowLeft size={15} /> Original Bassett Test Run</Link>}
        </div>
        <div className="flex flex-wrap items-center gap-2 text-xs">
          {prevTc && <button className="text-muted-foreground hover:text-[var(--navy)] font-semibold" onClick={() => nav(`/testcases/${prevTc.id}`)} data-testid="prev-test-btn">← Prev: {prevTc.name.slice(0, 28)}</button>}
          {prevTc && nextTc && <span className="text-muted-foreground">|</span>}
          {nextTc && <button className="text-muted-foreground hover:text-[var(--navy)] font-semibold" onClick={() => nav(`/testcases/${nextTc.id}`)} data-testid="next-test-btn">Next: {nextTc.name.slice(0, 28)} →</button>}
        </div>
      </div>
      {/* Sticky test context bar */}
      <div className="sticky top-0 z-20 bg-[var(--paper)]/95 backdrop-blur border-b -mx-2 px-2 py-2 mb-4" data-testid="sticky-context">
      <div className="flex items-start justify-between flex-wrap gap-3">
        <div>
          <div className="flex items-center gap-2 mb-1 flex-wrap">
            <CritBadge value={tc.criticality} /><span className="text-xs text-muted-foreground">{tc.test_type} · Difficulty {tc.difficulty}</span>
            {latestRetest && (
              <span data-testid="retest-outcome-chip"
                title={`Original ${latestRetest.original_bassett_version || ""} result unchanged — this shows the latest retest outcome`}>
                <StatusBadge value={latestRetest.verdict} definitions={RETEST_STATUSES} compact /> <span className="text-xs">Retested{latestRetest.new_bassett_version ? ` in ${latestRetest.new_bassett_version}` : ""}{latestRetest.new_environment ? ` (${latestRetest.new_environment})` : ""}</span>
              </span>
            )}
            {parent && (
              <>
                <Link to={`/testcases/${parent.id}`} className="text-xs font-semibold bg-indigo-50 border border-indigo-200 text-indigo-700 rounded-full px-2 py-0.5 flex items-center gap-1 hover:bg-indigo-100" data-testid="variant-parent-chip">
                  <GitBranch size={11} /> Variant of: {parent.name}
                </Link>
                <Link to={`/testcases/${id}/variants`} className="text-xs font-semibold text-[var(--orange)] hover:underline" data-testid="compare-family-link">Compare family →</Link>
              </>
            )}
          </div>
           <h1 className="text-2xl font-bold font-display text-[var(--navy)] break-words">{tc.name}</h1>
          <div className="flex items-center gap-2 text-sm text-muted-foreground mt-1 flex-wrap"><span>{project?.name} · {municipality ? `${municipality.name}, ${municipality.state}` : "No municipality"}{property ? ` · ${property.name}` : ""}</span><StatusBadge value={tc.archived ? "Archived" : (tc.status || "Unknown")} definitions={TEST_CASE_STATUSES} compact />{bassettEval?.bassett_version && <span>· {bassettEval.bassett_version}</span>}{tc.environment && <span>· {tc.environment}</span>}</div>
        </div>
         <div className="flex w-full flex-wrap gap-2 items-center lg:w-auto">
          <TestCaseActions testcase={tc} user={user} onDeleted={() => nav("/testcases")} />
          <AssigneePicker entityType="testcases" entityId={id} assigneeId={tc.assignee_id} assigneeName={tc.assignee_name} canWrite={canWrite} onChanged={refresh} />
          {canWrite && <Button variant="outline" onClick={() => setVariantModal(true)} data-testid="clone-variant-btn"><CopyPlus size={15} className="mr-1" /> Clone Variant</Button>}
           <Button variant="outline" className="flex-1 sm:flex-none" onClick={() => nav(`/comparison?tc=${id}`)}><Columns3 size={15} className="mr-1" /> AI Comparison</Button>
           {canWrite && <Button className="flex-1 sm:flex-none bg-[var(--orange)] hover:bg-[var(--orange-600)]" onClick={() => setFindModal(true)} data-testid="create-finding-btn"><Flag size={15} className="mr-1" /> Create Finding</Button>}
        </div>
      </div>
      </div>

      {tc.archived && <div className="rounded-xl border bg-card px-4 py-3 mb-5" role="status" data-testid="archived-testcase-banner">
        <StatusBadge value="Archived" definitions={TEST_CASE_STATUSES} />
        <div className="text-sm text-muted-foreground mt-1">This definition is read-only and excluded from active lists and calculations. All linked history remains available.</div>
      </div>}

      {/* Compact derived workflow status (record-based, replaces the old 6-step bar) */}
      {(() => {
        const complete = STAGES[5].done;
        const s = STAGES[currentStage];
        const label = complete
          ? (latestRetest ? `Workflow Complete — retest ${latestRetest.verdict}` : "Workflow Complete")
          : currentStage === 4 ? "Reviewer Findings Required — evaluation failed"
          : `${s.label} Incomplete — ${s.req}`;
        return (
          <div className="rounded-xl border bg-card px-4 py-2.5 mb-5 flex items-center gap-3 flex-wrap" data-testid="workflow-status-banner">
            <StatusBadge value={complete ? "Complete" : "Incomplete"} definitions={TEST_WORKFLOW_STATUSES} compact />
            <span className="text-sm font-semibold text-[var(--navy)]">{label}</span>
            <span className="text-xs text-muted-foreground hidden md:inline">Step {Math.min(currentStage + 1, 6)} of 6</span>
            {!complete && canWrite && (
              <Button size="sm" className="ml-auto bg-[var(--navy)] hover:bg-[#232f73]" data-testid="primary-action-btn"
                onClick={() => { setTab(PRIMARY[currentStage].tab); PRIMARY[currentStage].action?.(); }}>
                {PRIMARY[currentStage].label}
              </Button>
            )}
          </div>
        );
      })()}

      <Tabs value={tab} onValueChange={setTab}>
        <div className="overflow-x-auto pb-1" aria-label="Test case sections">
        <TabsList className="flex w-max min-w-full flex-nowrap h-auto">
          {TESTCASE_TABS.map((t) => (
            <TabsTrigger key={t} value={t} data-testid={`tab-${t}`} className="capitalize whitespace-nowrap" aria-label={`${t === "gold" ? "Gold Standard" : t === "claims" ? "Claim QA" : t}${TAB_COUNTS[t] != null ? `, ${TAB_COUNTS[t]} items` : ""}`}>
              {t === "gold" ? "Gold Standard" : t === "claims" ? "Claim QA" : t}
              {TAB_COUNTS[t] != null && TAB_COUNTS[t] > 0 && <span className="ml-1.5 text-[10px] font-bold bg-[var(--navy)]/10 text-[var(--navy)] rounded-full px-1.5 py-0.5">{TAB_COUNTS[t]}</span>}
            </TabsTrigger>
          ))}
        </TabsList>
        </div>

        <TabsContent value="overview" className="space-y-4">
          <div className="grid md:grid-cols-2 gap-4">
            <div className="bg-card border rounded-xl p-5"><h3 className="font-semibold font-display text-[var(--navy)] mb-2">Scenario</h3><p className="text-sm prose-response">{tc.scenario || "—"}</p></div>
            <div className="bg-card border rounded-xl p-5"><h3 className="font-semibold font-display text-[var(--navy)] mb-2">Test Purpose</h3><p className="text-sm prose-response">{tc.purpose || "—"}</p></div>
          </div>
          <div className="bg-card border rounded-xl p-5">
            <h3 className="font-semibold font-display text-[var(--navy)] mb-3">Prompt Sequence</h3>
            {(tc.prompts || []).map((p) => (
              <div key={p.turn} className="flex gap-3 mb-3"><div className="accent-gradient text-white text-xs font-bold rounded-md h-6 px-2 flex items-center shrink-0">Turn {p.turn}</div><p className="text-sm prose-response">{p.text}</p></div>
            ))}
          </div>
          <div className="bg-card border rounded-xl p-5">
            <h3 className="font-semibold font-display text-[var(--navy)] mb-3">Test Case Documents & Images</h3>
            <Attachments entityType="testcase" entityId={tc.id} canWrite={canWrite} />
          </div>
          <div className="bg-card border rounded-xl p-5">
            <div className="flex flex-wrap items-center justify-between gap-2 mb-3"><h3 className="font-semibold font-display text-[var(--navy)]">Expected Behaviors</h3><StatusLegend values={Object.keys(EXPECTED_BEHAVIOR_STATUSES)} definitions={EXPECTED_BEHAVIOR_STATUSES} label="Expected behavior status legend" /></div>
            {(tc.expected_behaviors || []).length === 0 && <p className="text-sm text-muted-foreground">None defined.</p>}
            {(tc.expected_behaviors || []).map((eb, i) => (
              <div key={i} className="flex items-center justify-between py-1.5 border-b last:border-0 text-sm">
                <span>{eb.text}</span>
                <StatusBadge value={eb.status} definitions={EXPECTED_BEHAVIOR_STATUSES} compact />
              </div>
            ))}
          </div>
          {variants.length > 0 && (
            <div className="bg-card border rounded-xl p-5" data-testid="variants-card">
              <h3 className="font-semibold font-display text-[var(--navy)] mb-3 flex items-center gap-2"><GitBranch size={15} /> Variants of this test ({variants.length})
                <Link to={`/testcases/${id}/variants`} className="text-xs font-semibold text-[var(--orange)] hover:underline ml-auto">Compare side by side →</Link>
              </h3>
              <div className="space-y-1.5">
                {variants.map((v) => (
                  <Link key={v.id} to={`/testcases/${v.id}`} className="flex items-center justify-between gap-2 py-1.5 px-2 rounded-lg hover:bg-[var(--paper)] text-sm">
                    <span className="font-medium text-[var(--navy)] truncate">{v.name}</span>
                    <span className="flex items-center gap-2 shrink-0">
                      {v.latest_result ? <ResultBadge value={v.latest_result} /> : <span className="text-[10px] text-muted-foreground border rounded-full px-1.5 py-0.5">Not Evaluated</span>}
                      <span className="text-xs text-muted-foreground">{v.status}</span>
                    </span>
                  </Link>
                ))}
              </div>
            </div>
          )}
        </TabsContent>

        <TabsContent value="responses">
                <div className="flex items-start justify-between mb-3 gap-3 flex-wrap">
            <p className="text-xs text-muted-foreground">Select text inside a response to annotate an error or citation issue at that exact spot.</p>
            <div className="flex w-full flex-wrap gap-2 sm:w-auto">
              {canWrite && !comparisonRun && (
                <Button size="sm" className="bg-[var(--navy)] hover:bg-[#232f73]" disabled={running} onClick={() => setRunModal({ models: MODELS, test_date: todayInTimeZone(config?.application_timezone) })} data-testid="run-all-models-btn">
                  {running ? <Loader2 size={14} className="mr-1 animate-spin" /> : <Zap size={14} className="mr-1" />}
                  {running ? "Running…" : "Run All Models"}
                </Button>
              )}
              {canWrite && comparisonRun && incompleteModels.length > 0 && (
                <Button size="sm" className="bg-[var(--navy)] hover:bg-[#232f73]" disabled={running} onClick={resumeComparison} data-testid="resume-incomplete-models-btn">
                  {running ? <Loader2 size={14} className="mr-1 animate-spin" /> : <Play size={14} className="mr-1" />}
                  Resume Incomplete ({incompleteModels.length})
                </Button>
              )}
              {canWrite && <Button size="sm" variant="outline" onClick={() => setRespModal({ model: "Bassett", turn: 1, response: "", citations: "" })}><Plus size={14} className="mr-1" /> Add Response</Button>}
            </div>
          </div>
             <div className="grid lg:grid-cols-3 gap-4">
             {MODELS.map((m) => (
               <div key={m} className="bg-card border rounded-xl overflow-hidden flex min-w-0 flex-col" data-testid={`resp-col-${m}`}>
                <div className="px-4 py-2.5 text-white font-semibold font-display flex items-center justify-between" style={{ background: MODEL_COLORS[m] }}>
                  <span className="flex items-center gap-2">{m}
                    {canWrite && comparisonRun && slotState(comparisonRun, m) !== "completed" && (
                       <button type="button" title={`Resume ${m}`} aria-label={`Resume incomplete ${m} response`} disabled={running} onClick={resumeComparison} data-testid={`resume-${m}-btn`}
                         className="icon-action rounded-full bg-white/20 hover:bg-white/35 p-1 transition-colors disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white">
                        {running ? <Loader2 size={12} className="animate-spin" /> : <Play size={12} />}
                      </button>
                    )}
                  </span>
                  {evalFor(m) && <ScorePill score={evalFor(m).overall_score} />}
                </div>
                <div className="p-4 space-y-3 flex-1">
                  {comparisonRun && (
                    <div className={`text-xs rounded-md px-2 py-1.5 font-semibold ${slotState(comparisonRun, m) === "completed" ? "bg-emerald-50 text-emerald-800" : "bg-amber-50 text-amber-800"}`} data-testid={`slot-status-${m}`}>
                      {slotState(comparisonRun, m) === "completed" ? "Completed" : "Incomplete — failed or unavailable"}
                      {slotState(comparisonRun, m) !== "completed" && canWrite && (
                        <button className="ml-2 underline" onClick={() => setRespModal({ model: m, turn: 1, response: "", citations: "", run_id: comparisonRun.id, manual_slot: true })}>Enter manually</button>
                      )}
                    </div>
                  )}
                  {respFor(m).length === 0 && (
                    <div className="text-sm text-muted-foreground">
                      <p>No response captured.</p>
                      {canWrite && <button className="text-xs text-[var(--orange)] font-semibold hover:underline mt-1" onClick={() => setRespModal({ model: m, turn: 1, response: "", citations: "" })}>Paste a response →</button>}
                    </div>
                  )}
                  {respFor(m).map((r) => (
                    <div key={r.id}>
                      {/* Conversation view: show the user prompt for this turn above the response */}
                      {(tc.prompts || []).find((p) => p.turn === r.turn) && (
                        <div className="mb-1.5 bg-slate-100 border-l-2 border-[var(--navy)] rounded-r px-2 py-1.5">
                          <span className="text-[9px] font-bold uppercase text-[var(--navy)]">User · Turn {r.turn}</span>
                           <p className="text-xs text-slate-700 break-words">{(tc.prompts || []).find((p) => p.turn === r.turn)?.text}</p>
                        </div>
                      )}
                      <div className="flex items-center gap-2 mb-1">
                        <span className="text-[10px] font-bold text-muted-foreground uppercase">{m} · Turn {r.turn}</span>
                        {r.capture_method === "live_api" && <span className="text-[9px] font-bold uppercase tracking-wide bg-emerald-100 text-emerald-700 rounded-full px-1.5 py-0.5">Live API{r.model_version ? ` · ${r.model_version}` : ""}</span>}
                        {r.environment && <span className="text-[9px] text-muted-foreground">{r.environment}</span>}
                      </div>
                      <AnnotatedResponse response={r} annotations={annotations} canAnnotate={canWrite}
                        onAnnotate={(a) => setAnnotModal(a)} onDeleteAnnotation={deleteAnnotation} onPromote={promoteAnnotation} />
                       {r.citations && <div className="mt-1.5 text-xs bg-[var(--paper)] rounded px-2 py-1 text-[var(--navy)] break-words"><b>Citations:</b> {r.citations}</div>}
                    </div>
                  ))}
                </div>
              </div>
            ))}
          </div>
          {(test_runs.length > 0 || supersededCount > 0) && (
            <div className="mt-4 bg-card border rounded-xl p-4" data-testid="run-history">
              <h4 className="text-xs font-bold uppercase text-muted-foreground mb-2">Test Run History ({test_runs.length} run{test_runs.length === 1 ? "" : "s"}{supersededCount ? ` · ${supersededCount} superseded response${supersededCount === 1 ? "" : "s"} preserved` : ""})</h4>
              <div className="space-y-1.5">
                {test_runs.map((r) => (
                  <div key={r.id} className="text-xs flex gap-3 flex-wrap">
                    <span className="font-semibold text-[var(--navy)]">{new Date(r.run_date).toLocaleString()}</span>
                    <span>{(r.models || []).join(", ")}</span>
                     <span className="text-muted-foreground">{r.bassett_version || "—"} · {r.environment || "—"} · {r.capture_method}</span>
                       {(r.run_status || r.status || r === comparisonRun) && <StatusBadge value={r === comparisonRun ? comparisonStatus : (r.run_status || r.status)} definitions={COMPARISON_RUN_STATUSES} compact />}
                       <span className="flex flex-wrap items-center gap-1 text-muted-foreground">{MODELS.filter((m) => (r.models || []).includes(m) || slotValue(r, m) != null).map((m) => <span key={m} className="inline-flex items-center gap-1">{m}: <StatusBadge value={slotState(r, m)} definitions={COMPARISON_SLOT_STATUSES} compact /></span>)}</span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </TabsContent>

        <TabsContent value="claims">
          <ClaimsPanel responses={responses} claims={claims} canWrite={canWrite} onRefresh={refresh} />
        </TabsContent>

        <TabsContent value="gold">
          <div className="bg-card border rounded-xl p-5">
            <div className="flex items-center justify-between mb-3"><h3 className="font-semibold font-display text-[var(--navy)]">Gold Standard</h3>
              {canWrite && <Button size="sm" variant="outline" onClick={() => setGoldModal(true)}>{gold_standard ? "Edit" : "Create"}</Button>}</div>
            {gold_standard ? (
              <div className="space-y-3 text-sm">
                {evidence.some((e) => e.freshness_warning) && (
                   <div className="flex items-start gap-2 border rounded-lg px-3 py-2 text-xs" data-testid="gold-stale-evidence-warning"><StatusBadge value="Gold Reverification Required" definitions={DEMO_STATUSES} compact /><span>Supporting evidence is stale: {evidence.filter((e) => e.freshness_warning).map((e) => e.document_name).join("; ")}. This Gold Standard may no longer reflect the current ordinance.</span></div>
                )}
                {gold_standard.review_status === "Approved" && !evidence.some((e) => e.verification_status === "Verified") && (
                   <div className="flex items-start gap-2 border rounded-lg px-3 py-2 text-xs" data-testid="gold-unverified-warning"><StatusBadge value="Insufficient Verified Evidence" definitions={GOLD_STANDARD_STATUSES} compact /><span>Approved without any Verified evidence — this Gold Standard's authority is not established. Verify a source or change the conclusion to "Insufficient Verified Evidence".</span></div>
                )}
                <div><span className="text-xs font-semibold text-muted-foreground uppercase">Answer</span><p className="prose-response mt-1">{gold_standard.answer}</p></div>
                <div><span className="text-xs font-semibold text-muted-foreground uppercase">Explanation</span><p className="prose-response mt-1">{gold_standard.explanation}</p></div>
                {gold_standard.limitations && <div><span className="text-xs font-semibold text-muted-foreground uppercase">Limitations</span><p className="prose-response mt-1">{gold_standard.limitations}</p></div>}
                 <div className="flex items-center gap-2 text-xs text-muted-foreground flex-wrap">Prepared: {gold_standard.prepared_by || "—"} · Reviewed: {gold_standard.reviewed_by || "—"} {gold_standard.version ? `· v${gold_standard.version}` : ""}<StatusBadge value={gold_standard.review_status === "Approved" && data.gold_stale ? "Approved — Reverification Required" : gold_standard.review_status} definitions={GOLD_STANDARD_STATUSES} compact testId="gold-status-label" /><span>· Supporting evidence: {evidence.length} ({evidence.filter((e) => e.verification_status === "Verified").length} verified)</span></div>
              </div>
            ) : <p className="text-sm text-muted-foreground">No Gold Standard yet. Establish the authoritative answer from evidence.</p>}
          </div>
        </TabsContent>

        <TabsContent value="evidence">
          <div className="space-y-3">
            {evidence.length === 0 && <p className="text-sm text-muted-foreground">No evidence linked. Link from Ordinance Evidence.</p>}
            {evidence.map((e) => (
              <div key={e.id} className="bg-card border rounded-xl p-4">
                <div className="flex items-center justify-between gap-2 flex-wrap">
                  <span className="font-semibold text-[var(--navy)]">{e.document_name}</span>
                  <VerificationBadge value={e.verification_status} />
                </div>
                <div className="text-xs text-muted-foreground mt-1 flex flex-wrap gap-x-3 gap-y-0.5" data-testid="evidence-provenance">
                  {e.jurisdiction && <span><b>Jurisdiction:</b> {e.jurisdiction}</span>}
                  {e.issuing_authority && <span><b>Authority:</b> {e.issuing_authority}</span>}
                  {e.document_version && <span><b>Version:</b> {e.document_version}</span>}
                  <span>{e.citation}{e.section ? ` · ${e.section}` : ""}{e.page_number ? ` · p.${e.page_number}` : ""}</span>
                  {e.effective_date && <span>Effective {e.effective_date}</span>}
                  {e.superseded_date && <span className="text-red-600 font-semibold">Superseded {e.superseded_date}</span>}
                  {e.verified_by && <span>Verified by {e.verified_by}{e.verified_date ? ` on ${e.verified_date}` : ""}</span>}
                  {e.source_url && <a href={e.source_url} target="_blank" rel="noreferrer" className="text-[var(--orange)] font-semibold hover:underline">Source ↗</a>}
                </div>
                {e.freshness_warning && (
                  <div className="mt-2 text-xs bg-red-50 border border-red-300 text-red-800 rounded-lg px-2.5 py-1.5 font-semibold" data-testid="evidence-freshness-warning">
                    ⚠ STALE: {e.freshness_warning}
                  </div>
                )}
                {e.conflicts_with && (
                  <div className="mt-2 text-xs bg-amber-50 border border-amber-300 text-amber-800 rounded-lg px-2.5 py-1.5 font-semibold" data-testid="evidence-conflict-warning">
                    ⚠ Conflicting evidence linked — reconcile before relying on this source for the Gold Standard.
                  </div>
                )}
                <p className="text-sm mt-2 prose-response bg-[var(--paper)] rounded p-2">{e.relevant_text}</p>
                <div className="mt-3 border-t pt-3">
                  <Attachments entityType="evidence" entityId={e.id} canWrite={canWrite} compact />
                </div>
              </div>
            ))}
          </div>
        </TabsContent>

        <TabsContent value="evaluation">
          {data.gold_stale && (
            <div className="bg-amber-50 border border-amber-300 text-amber-800 rounded-xl px-4 py-2.5 mb-3 text-sm" data-testid="eval-gold-stale-warning">
              ⚠ <b>Gold Standard authority under review</b> — supporting evidence is stale ({(data.gold_stale_evidence || []).join("; ")}). Evaluations remain historically valid but should be re-verified against the current ordinance.
            </div>
          )}
          <div className="bg-card border rounded-xl overflow-hidden">
            <TableSortControls columns={EVALUATION_COLUMNS} sort={evaluationSort} setSort={setEvaluationSort} defaultSort={defaultEvaluationSort} className="p-3 pb-0" />
            <table className="w-full text-sm">
              <thead className="bg-[var(--paper)]"><tr className="text-left">{EVALUATION_COLUMNS.map((column) => <SortableTableHeader key={column.key} column={column} sort={evaluationSort} onSort={(key) => setEvaluationSort((current) => nextSort(current, key))} />)}<th><span className="sr-only">Actions</span></th></tr></thead>
              <tbody>
                {evaluationRows.map(({ model: m, evaluation: ev }) => (
                  <tr key={m} className="border-t">
                    <td className="px-4 py-3 font-semibold" style={{ color: MODEL_COLORS[m] }}>{m}</td>
                    <td className="px-4 py-3">{ev ? <ScorePill score={ev.overall_score} /> : "—"}</td>
                    <td className="px-4 py-3">{ev?.system_recommended ? <span title={ev.system_explanation || ""}><ResultBadge value={ev.system_recommended} /></span> : <ResultBadge value="Not Evaluated" />}</td>
                    <td className="px-4 py-3">
                      <ResultBadge value={ev?.final_result || "Not Evaluated"} />
                      {ev?.override_reason && <div className="text-[10px] text-amber-700 mt-0.5" title={ev.override_reason}>⚠ overrode system: {ev.override_reason.slice(0, 60)}</div>}
                      {ev?.reviewed_at && <div className="text-[10px] text-muted-foreground">{ev.reviewer || ev.created_by || ""} · {new Date(ev.reviewed_at).toLocaleDateString()}</div>}
                    </td>
                    <td className="px-4 py-3 text-right">{canWrite && <Button size="sm" variant="outline" disabled={!!comparisonRun && slotState(comparisonRun, m) !== "completed"} title={comparisonRun && slotState(comparisonRun, m) !== "completed" ? "Complete this comparison slot before evaluating it" : undefined} onClick={() => setEvalModal(ev ? { ...ev } : { model: m, testcase_id: id, run_id: comparisonRun?.id, scores: {}, final_result: "Pass" })} data-testid={`eval-${m}-btn`}>{ev ? "Edit" : "Evaluate"}</Button>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </TabsContent>

        <TabsContent value="findings">
          {findings.length === 0 && <p className="text-sm text-muted-foreground">No findings for this test.</p>}
          <div className="space-y-2">
            {findings.map((f) => (
              <Link to={`/findings?id=${f.id}`} key={f.id} className="block bg-card border rounded-xl p-4 card-hover">
                <div className="flex items-center gap-2"><CritBadge value={f.criticality} /><span className="font-semibold text-[var(--navy)]">{f.title}</span></div>
                <div className="flex items-center gap-2 text-xs text-muted-foreground mt-1 flex-wrap"><span>{f.finding_type}</span><StatusBadge value={f.developer_status} definitions={FINDING_STATUSES} compact /><span>· Root cause: {f.root_cause || "—"}</span></div>
              </Link>
            ))}
          </div>
        </TabsContent>

        <TabsContent value="retests">
          {retests.length === 0 && (
            <div className="bg-card border rounded-xl p-8 text-center text-sm text-muted-foreground">
              No retests yet. Retests start from a finding — open a finding on this test and use <b>Start Retest</b> once its fix is ready.
              {findings.length > 0 && <div className="mt-2"><Link to={`/findings?id=${findings[0].id}`} className="text-[var(--orange)] font-semibold hover:underline">Open findings →</Link></div>}
            </div>
          )}
          {retests.map((r) => (
            <div key={r.id} className="bg-card border rounded-xl p-4 mb-3" data-testid="retest-card">
              <div className="flex items-center justify-between mb-2 flex-wrap gap-2">
                 <div className="flex items-center gap-2 text-sm font-semibold text-[var(--navy)] flex-wrap"><span>{r.finding_title || "Retest"}</span><StatusBadge value={r.status || "Completed"} definitions={RETEST_LIFECYCLE_STATUSES} compact /><span className="text-xs text-muted-foreground font-normal">Test Date: {formatTestDate(r.test_date)}{r.reviewer ? ` · ${r.reviewer}` : ""}</span></div>
                <div className="flex items-center gap-2">
                   {r.verdict && <StatusBadge value={r.verdict} definitions={RETEST_STATUSES} />}
                  {canWrite && r.status === "In Progress" && <Button size="sm" className="bg-[var(--orange)] hover:bg-[var(--orange-600)]" onClick={() => setRetestModal(r)} data-testid="complete-retest-btn">Complete Retest</Button>}
                </div>
              </div>
              {r.fix_description && <div className="text-xs bg-[var(--paper)] rounded p-2 mb-2"><b>Fix:</b> {r.fix_description}</div>}
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div><div className="text-xs font-semibold uppercase text-muted-foreground mb-1">Before · {r.original_bassett_version || r.original_version || "—"} {r.original_environment ? `(${r.original_environment})` : ""}</div><ResultBadge value={r.original_result} />{r.original_score != null && <span className="ml-2 text-xs font-bold">{r.original_score}/10</span>}<p className="text-sm mt-2 prose-response line-clamp-4">{r.original_response}</p></div>
                <div><div className="text-xs font-semibold uppercase text-muted-foreground mb-1">After · {r.new_bassett_version || r.new_version || "pending"} {r.new_environment ? `(${r.new_environment})` : ""}</div><ResultBadge value={r.new_result} />{r.new_score != null && <span className="ml-2 text-xs font-bold">{r.new_score}/10</span>}<p className="text-sm mt-2 prose-response line-clamp-4">{r.new_response || "Awaiting new response…"}</p></div>
              </div>
              {r.notes && <div className="text-xs text-muted-foreground mt-2">Reviewer notes: {r.notes}</div>}
            </div>
          ))}
        </TabsContent>

        <TabsContent value="discussion">
          <div className="bg-card border rounded-xl p-5">
            <CommentsThread entityType="testcases" entityId={id} canWrite={canWrite} />
          </div>
        </TabsContent>

        <TabsContent value="activity">
          <div className="bg-card border rounded-xl p-5 space-y-3">
            {activities.length === 0 && <p className="text-sm text-muted-foreground">No activity recorded yet — actions like response capture, evaluations, findings and retests will appear here automatically.</p>}
            {activities.map((a) => (
              <div key={a.id} className="flex gap-3 text-sm"><div className="mt-1.5 h-1.5 w-1.5 rounded-full bg-[var(--orange)] shrink-0" /><div><div>{a.action} <span className="text-muted-foreground">{a.detail}</span></div><div className="text-[11px] text-muted-foreground">{a.user} · {new Date(a.created_at).toLocaleString()}</div></div></div>
            ))}
          </div>
        </TabsContent>
      </Tabs>

      {respModal && <ResponseModal data={respModal} setData={setRespModal} tcId={id} prompts={tc.prompts} onDone={refresh} />}
      {evalModal && <EvalModal data={evalModal} setData={setEvalModal} config={config} tc={tc} onDone={refresh} />}
      {findModal && <FindingModal open={findModal} setOpen={setFindModal} tc={tc} project={project} config={config} onDone={refresh} />}
      {goldModal && <GoldModal open={goldModal} setOpen={setGoldModal} existing={gold_standard} tcId={id} evidence={evidence} onDone={refresh} />}
      {annotModal && <AnnotationModal data={annotModal} setData={setAnnotModal} tcId={id} config={config} onDone={refresh} />}
      {variantModal && <VariantModal tc={tc} setOpen={setVariantModal} nav={nav} />}
      {retestModal && <CompleteRetestModal rt={retestModal} setRt={setRetestModal} versions={config?.__versions} applicationTimeZone={config?.application_timezone} onDone={refresh} />}
      {runModal && <FormModal open onOpenChange={() => setRunModal(null)} title={`Run ${runModal.models.join(", ")}`} onSubmit={runModels} submitLabel={running ? "Running…" : "Run Models"}>
        <Field label="Test Date *"><Input required type="date" value={runModal.test_date} onChange={(e) => setRunModal({ ...runModal, test_date: e.target.value })} /></Field>
        <p className="text-xs text-muted-foreground">One Test Date applies to every model response in this comparison.</p>
      </FormModal>}
    </div>
  );
}

const RETEST_VERDICTS = ["Fixed", "Partially Fixed", "Not Fixed", "Unable to Verify", "New Regression Introduced"];

function CompleteRetestModal({ rt, setRt, onDone, applicationTimeZone }) {
  const [f, setF] = useState({ verdict: "Fixed", test_date: todayInTimeZone(applicationTimeZone), new_bassett_version: rt.new_bassett_version || "", new_environment: rt.new_environment || "Staging", new_response: "", new_score: "", new_result: "Pass", notes: "" });
  const set = (k, v) => setF({ ...f, [k]: v });
  const [saving, setSaving] = useState(false);
  const save = async () => {
    if (!f.new_response.trim()) return toast.error("Paste the new Bassett response");
    setSaving(true);
    try {
      await api.post(`/retests/${rt.id}/complete`, { ...f, new_score: f.new_score === "" ? null : Number(f.new_score) });
      toast.success(`Retest completed — verdict: ${f.verdict}. Finding status updated automatically.`);
      setRt(null); onDone();
    } catch (error) { toast.error(mutationError(error, "Unable to record retest verdict")); }
    finally { setSaving(false); }
  };
  return (
    <FormModal open onOpenChange={() => setRt(null)} title={`Complete Retest — ${rt.finding_title || rt.testcase_name}`} onSubmit={save} submitLabel={saving ? "Recording…" : "Record Verdict"} wide>
      <div className="text-xs bg-[var(--paper)] border rounded-lg p-2.5"><b>Before:</b> {rt.original_bassett_version || "—"} · {rt.original_result || "—"} {rt.original_score != null ? `· ${rt.original_score}/10` : ""} — this verdict will update the source finding and the test's retest history.</div>
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
        <Field label="Verdict"><ListSelect options={RETEST_VERDICTS} value={f.verdict} onChange={(v) => set("verdict", v)} testid="retest-verdict" /></Field>
        <Field label="New Bassett Version"><Input value={f.new_bassett_version} onChange={(e) => set("new_bassett_version", e.target.value)} placeholder="Bassett v2.0" data-testid="retest-version" /></Field>
        <Field label="Environment"><ListSelect options={["Production", "Staging", "Development"]} value={f.new_environment} onChange={(v) => set("new_environment", v)} /></Field>
      </div>
      <Field label="Test Date *"><Input required type="date" value={f.test_date} onChange={(e) => set("test_date", e.target.value)} /></Field>
      <Field label="New Bassett Response (raw)"><Textarea rows={4} value={f.new_response} onChange={(e) => set("new_response", e.target.value)} data-testid="retest-response" /></Field>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <Field label="New Score (0-10)"><Input type="number" min="0" max="10" step="0.1" value={f.new_score} onChange={(e) => set("new_score", e.target.value)} data-testid="retest-score" /></Field>
        <Field label="New Result"><ListSelect options={["Pass", "Pass with Minor Issues", "Needs Improvement", "Fail", "Critical Fail"]} value={f.new_result} onChange={(v) => set("new_result", v)} /></Field>
      </div>
      <Field label="Reviewer Notes"><Textarea rows={2} value={f.notes} onChange={(e) => set("notes", e.target.value)} /></Field>
    </FormModal>
  );
}

function mutationError(error, fallback) {
  if (error?.response?.status === 401) return "Your session has expired. Sign in again, then retry.";
  if (error?.response?.status === 403) return "You do not have permission to make this change.";
  if (error?.response?.status === 409) return "This record changed elsewhere. Refresh and retry.";
  return formatApiErrorDetail(error?.response?.data?.detail) || fallback;
}

function VariantModal({ tc, setOpen, nav }) {
  const [v, setV] = useState({
    name: `${tc.name} (Variant)`,
    scenario: tc.scenario || "",
    prompts: (tc.prompts || [{ turn: 1, text: "" }]).map((p) => ({ ...p })),
  });
  const [busy, setBusy] = useState(false);
  const setPrompt = (i, text) => setV((s) => { const p = [...s.prompts]; p[i] = { ...p[i], text }; return { ...s, prompts: p }; });
  const addPrompt = () => setV((s) => ({ ...s, prompts: [...s.prompts, { turn: s.prompts.length + 1, text: "" }] }));
  const rmPrompt = (i) => setV((s) => ({ ...s, prompts: s.prompts.filter((_, x) => x !== i).map((p, x) => ({ ...p, turn: x + 1 })) }));

  const save = async () => {
    if (!v.name.trim()) return toast.error("Variant name required");
    if (!v.prompts.some((p) => p.text.trim())) return toast.error("At least one prompt required");
    setBusy(true);
    try {
      const { data } = await api.post(`/testcases/${tc.id}/clone`, v);
      toast.success("Variant created — probe the scenario from a new angle");
      setOpen(false);
      nav(`/testcases/${data.id}`);
    } catch (e) {
      toast.error(formatApiErrorDetail(e.response?.data?.detail) || "Clone failed");
    } finally { setBusy(false); }
  };

  return (
    <FormModal open onOpenChange={() => setOpen(false)} title="Clone as Variant — tweak the prompts" onSubmit={save} submitLabel={busy ? "Creating…" : "Create Variant"} wide>
      <p className="text-xs text-muted-foreground -mt-1">Copies municipality, property, category, criticality, expected behaviors and the Gold Standard (as draft). Responses and evaluations start fresh.</p>
      <Field label="Variant Name"><Input value={v.name} onChange={(e) => setV({ ...v, name: e.target.value })} data-testid="variant-name" /></Field>
      <Field label="Scenario"><Textarea rows={2} value={v.scenario} onChange={(e) => setV({ ...v, scenario: e.target.value })} /></Field>
      <div>
        <div className="flex items-center justify-between mb-2">
          <span className="text-xs font-semibold text-muted-foreground">TWEAKED PROMPT SEQUENCE</span>
          <Button type="button" size="sm" variant="outline" onClick={addPrompt} data-testid="variant-add-prompt"><Plus size={14} /> Turn</Button>
        </div>
        {v.prompts.map((p, i) => (
          <div key={i} className="flex gap-2 mb-2 items-start">
            <div className="mt-2 text-xs font-bold text-[var(--orange)] w-14 shrink-0">Turn {p.turn}</div>
            <Textarea value={p.text} onChange={(e) => setPrompt(i, e.target.value)} rows={2} className="flex-1" data-testid={`variant-prompt-${i}`} />
            {v.prompts.length > 1 && <Button type="button" size="icon" variant="ghost" className="icon-action" aria-label={`Remove variant prompt turn ${p.turn}`} onClick={() => rmPrompt(i)}><Trash2 size={14} aria-hidden="true" /></Button>}
          </div>
        ))}
      </div>
    </FormModal>
  );
}

function AnnotationModal({ data, setData, tcId, config, onDone }) {
  const [type, setType] = useState("Incorrect Fact");
  const [note, setNote] = useState("");
  const save = async () => {
    await api.post("/annotations", {
      testcase_id: tcId, response_id: data.response_id, model: data.model,
      start: data.start, end: data.end, quoted_text: data.quoted_text,
      annotation_type: type, note,
    });
    toast.success("Annotation added");
    setData(null); onDone();
  };
  return (
    <FormModal open onOpenChange={() => setData(null)} title="Annotate Response Excerpt" onSubmit={save} submitLabel="Add Annotation">
      <div className="text-sm bg-amber-50 border border-amber-200 rounded-lg p-3">
        <span className="text-[10px] font-bold uppercase text-amber-700 block mb-1">Selected excerpt · {data.model}</span>
        “{(data.quoted_text || "").slice(0, 300)}{(data.quoted_text || "").length > 300 ? "…" : ""}”
      </div>
      <Field label="Issue Type"><ListSelect options={config?.annotation_types} value={type} onChange={setType} testid="annotation-type-select" /></Field>
      <Field label="Note (what's wrong here?)"><Textarea rows={3} value={note} onChange={(e) => setNote(e.target.value)} data-testid="annotation-note" /></Field>
    </FormModal>
  );
}

function ResponseModal({ data, setData, tcId, prompts, onDone }) {
  const save = async () => {
    if (data.manual_slot) {
      await api.post(`/testcases/${tcId}/runs/${data.run_id}/slots/${data.model}/complete`, {
        turns: [{ turn: data.turn, text: data.response }],
        citations: data.citations,
      });
      toast.success(`${data.model} comparison slot completed manually`);
    } else {
      await api.post("/responses", { ...data, testcase_id: tcId, capture_method: "paste" });
      toast.success("Response saved");
    }
    setData(null); onDone();
  };
  return (
    <FormModal open onOpenChange={() => setData(null)} title={data.manual_slot ? `Complete ${data.model} Slot Manually` : "Capture AI Response"} onSubmit={save} wide>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
      <Field label="Model"><ListSelect options={data.manual_slot ? [data.model] : MODELS} value={data.model} onChange={(v) => setData({ ...data, model: v })} /></Field>
        <Field label="Turn"><ListSelect options={(prompts || [{ turn: 1 }]).map((p) => String(p.turn))} value={String(data.turn)} onChange={(v) => setData({ ...data, turn: Number(v) })} /></Field>
      </div>
      <Field label="Response (raw — never modified)"><Textarea rows={6} value={data.response} onChange={(e) => setData({ ...data, response: e.target.value })} data-testid="resp-text" /></Field>
      <Field label="Citations / Sources"><Input value={data.citations} onChange={(e) => setData({ ...data, citations: e.target.value })} /></Field>
    </FormModal>
  );
}

function EvalModal({ data, setData, config, tc, onDone }) {
  const [drafting, setDrafting] = useState(false);
  const [calculation, setCalculation] = useState({
    overall_score: data.overall_score ?? data.weighted_score ?? null,
    system_recommended: data.system_recommended || null,
    system_explanation: data.system_explanation || "",
  });
  const [calculationPending, setCalculationPending] = useState(true);
  const [calculationError, setCalculationError] = useState("");
  const set = (k, v) => setData({ ...data, scores: { ...data.scores, [k]: v } });
  const setBehavior = (i, status) => {
    const br = [...(data.behavior_results || (tc?.expected_behaviors || []).map((b) => ({ text: b.text, status: b.status || "Not Met", note: "" })))];
    br[i] = { ...br[i], status };
    setData({ ...data, behavior_results: br });
  };
  const behaviors = data.behavior_results || (tc?.expected_behaviors || []).map((b) => ({ text: b.text, status: b.status || "Not Met", note: "" }));

  useEffect(() => {
    let active = true;
    setCalculationPending(true);
    setCalculationError("");
    api.post("/evaluations/score-preview", { scores: data.scores })
      .then(({ data: result }) => {
        if (active) setCalculation({
          overall_score: result?.overall_score ?? null,
          system_recommended: result?.system_recommended || "Not Enough Evidence",
          system_explanation: result?.system_explanation || "No scored dimensions.",
        });
      })
      .catch((error) => {
        if (active) setCalculationError(formatApiErrorDetail(error?.response?.data?.detail) || "Unable to calculate the system recommendation.");
      })
      .finally(() => { if (active) setCalculationPending(false); });
    return () => { active = false; };
  }, [data.scores]);

  const weighted = calculation.overall_score;
  const sysRec = calculation.system_recommended;
  const overridden = !!sysRec && !calculationError && data.final_result && data.final_result !== sysRec;

  const prescore = async () => {
    setDrafting(true);
    try {
      const { data: d } = await api.post(`/testcases/${data.testcase_id}/prescore`, { model: data.model });
      setData({
        ...data, scores: d.scores, final_result: d.final_result, notes: d.rationale,
        overall_score: d.overall_score, weighted_score: d.weighted_score,
        system_recommended: d.system_recommended, system_explanation: d.system_explanation,
        ai_prescored: true,
      });
      setCalculation(d);
      toast.success("AI draft ready — review and adjust before saving");
    } catch (e) {
      toast.error(formatApiErrorDetail(e.response?.data?.detail) || "AI pre-score failed");
    } finally { setDrafting(false); }
  };
  const save = async () => {
    try {
      if (hasScoredDimension(data.scores) && String(data.notes || "").trim().length < 20) {
        return toast.error("Explain the selected scores in the Score rationale using at least 20 characters.");
      }
      const previewResponse = await api.post("/evaluations/score-preview", { scores: data.scores });
      const authoritative = previewResponse.data || {};
      const isOverride = !!authoritative.system_recommended
        && data.final_result !== authoritative.system_recommended;
      if (isOverride && !(data.override_reason || "").trim()) {
        return toast.error("You changed the system recommendation — please give an override reason.");
      }
      const {
        overall_score, weighted_score, system_recommended, system_explanation, ...editable
      } = data;
      const body = {
        ...editable, behavior_results: behaviors,
        reviewer: data.reviewer || undefined, reviewed_at: new Date().toISOString(),
        override_reason: isOverride ? data.override_reason : "",
      };
      if (data.id) await api.put(`/evaluations/${data.id}`, withExpectedVersion(data, body)); else await api.post("/evaluations", body);
      // Reflect behavior verdicts on the Bassett test case record.
      if (data.model === "Bassett" && tc && behaviors.length) {
        await api.put(`/testcases/${tc.id}`, withExpectedVersion(tc, {
          expected_behaviors: behaviors.map((b) => ({ text: b.text, status: b.status })),
        }));
      }
      toast.success("Evaluation saved"); setData(null); onDone();
    } catch (error) {
      toast.error(staleUpdateMessage(error) || formatApiErrorDetail(error?.response?.data?.detail) || "Unable to save evaluation.");
      if (error?.response?.status === 409) onDone();
    }
  };
  return (
    <FormModal open onOpenChange={() => setData(null)} title={`Evaluate — ${data.model}`} onSubmit={save} submitDisabled={drafting || calculationPending || Boolean(calculationError)} wide>
      <div className="flex items-center justify-between gap-3 bg-[var(--paper)] border rounded-lg px-3 py-2">
        <div className="text-xs text-muted-foreground">
          {data.ai_prescored
            ? <span className="text-[var(--orange)] font-semibold">AI draft loaded — confirm or adjust each score before saving.</span>
            : "Let AI draft scores against the Gold Standard, then confirm or adjust."}
        </div>
        <Button type="button" size="sm" variant="outline" disabled={drafting} onClick={prescore} data-testid="ai-prescore-btn">
          {drafting ? <Loader2 size={14} className="mr-1 animate-spin" /> : <Sparkles size={14} className="mr-1" />}
          {drafting ? "Drafting…" : "AI Pre-Score"}
        </Button>
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
        {DIMS.map(([k, label]) => (
          <Field key={k} label={label} description={scoreRubricReason(data.scores[k])}>
            <Input type="number" min="0" max="10" step="1" value={data.scores[k] ?? ""} onChange={(e) => set(k, e.target.value === "" ? null : Number(e.target.value))} data-testid={`score-${k}`} />
          </Field>
        ))}
      </div>
      <details className="rounded-lg border bg-[var(--paper)] p-3" data-testid="score-rubric"><summary className="cursor-pointer text-sm font-semibold text-[var(--navy)]">View the shared 0–10 scoring rubric</summary><div className="mt-3 grid gap-1 text-xs">{SCORE_RUBRIC.map(([score, reason]) => <div key={score} className="grid grid-cols-[1.5rem_1fr] gap-2"><b>{score}</b><span>{reason}</span></div>)}</div></details>
      {behaviors.length > 0 && (
        <div className="border rounded-lg p-3">
          <div className="text-xs font-bold uppercase text-muted-foreground mb-2">Expected Behaviors — mark each one</div>
          {behaviors.map((b, i) => (
            <div key={i} className="flex items-center gap-2 py-1 text-sm">
              <span className="flex-1">{b.text}</span>
              <ListSelect options={["Met", "Partially Met", "Not Met", "N/A"]} value={b.status} onChange={(v) => setBehavior(i, v)} testid={`behavior-${i}`} />
            </div>
          ))}
        </div>
      )}
      <div className="bg-indigo-50 border border-indigo-200 rounded-lg px-3 py-2 text-sm" data-testid="system-recommendation">
        <b className="text-indigo-800">System recommends: {calculationPending ? "Calculating…" : calculationError ? "Unavailable" : sysRec}</b>
        <span className="text-xs text-indigo-700 ml-2">{calculationError || (weighted != null ? `weighted score ${weighted}/10` : "no dimensions scored yet")} {!calculationError && "— the reviewer decision below is final."}</span>
      </div>
      <Field label="Reviewer Final Result"><ListSelect options={[...(config?.pass_results || []), "Not Enough Evidence", "Not Evaluated"].filter((v, i, a) => a.indexOf(v) === i)} value={data.final_result} onChange={(v) => setData({ ...data, final_result: v })} testid="eval-result" /></Field>
      {overridden && (
        <Field label={`Override reason (system said ${sysRec})`}>
          <Textarea rows={2} value={data.override_reason || ""} onChange={(e) => setData({ ...data, override_reason: e.target.value })} data-testid="override-reason" />
        </Field>
      )}
      <Field label="Score rationale" required={hasScoredDimension(data.scores)} description="Identify the answer evidence supporting the scores. Minimum 20 characters when any dimension is scored."><Textarea rows={3} value={data.notes || ""} onChange={(e) => setData({ ...data, notes: e.target.value })} /></Field>
    </FormModal>
  );
}

function FindingModal({ open, setOpen, tc, project, config, onDone }) {
  const [f, setF] = useState({ title: "", finding_type: "Bassett error", criticality: tc.criticality || 3, developer_status: "New", description: "", testcase_id: tc.id, project_id: tc.project_id, category: tc.category, retest_required: true, retest_status: "Pending", status_history: [] });
  const set = (k, v) => setF({ ...f, [k]: v });
  const save = async () => { if (!f.title) return toast.error("Title required"); await api.post("/findings", f); toast.success("Finding created"); setOpen(false); onDone(); };
  return (
    <FormModal open={open} onOpenChange={setOpen} title="Create Finding (context preserved)" onSubmit={save} wide>
      <Field label="Title"><Input value={f.title} onChange={(e) => set("title", e.target.value)} data-testid="finding-title" /></Field>
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
        <Field label="Finding Type"><ListSelect options={config?.finding_types} value={f.finding_type} onChange={(v) => set("finding_type", v)} /></Field>
        <Field label="Criticality"><ListSelect options={["1", "2", "3", "4", "5"]} value={String(f.criticality)} onChange={(v) => set("criticality", Number(v))} /></Field>
        <Field label="Failure Mode"><ListSelect options={config?.failure_modes} value={(f.failure_modes || [])[0]} onChange={(v) => set("failure_modes", [v])} /></Field>
      </div>
      <Field label="Description"><Textarea rows={3} value={f.description} onChange={(e) => set("description", e.target.value)} /></Field>
      <Field label="Expected vs Actual Bassett Behavior"><Textarea rows={2} value={f.actual_behavior || ""} onChange={(e) => set("actual_behavior", e.target.value)} placeholder="What Bassett actually did" /></Field>
    </FormModal>
  );
}

function GoldModal({ open, setOpen, existing, tcId, evidence = [], onDone }) {
  const [g, setG] = useState(existing || { answer: "", explanation: "", limitations: "", version: "1", prepared_by: "", reviewed_by: "", review_status: "Draft", testcase_id: tcId });
  const [confirmingUnverifiedApproval, setConfirmingUnverifiedApproval] = useState(false);
  const set = (k, v) => setG({ ...g, [k]: v });
  const save = async (unverifiedApprovalConfirmed = false) => {
    if (g.review_status === "Insufficient Verified Evidence" && !(g.explanation || "").trim())
      return toast.error("Explain why 'Insufficient Verified Evidence' is the correct conclusion.");
    if (g.review_status === "Approved" && !evidence.some((e) => e.verification_status === "Verified") && !unverifiedApprovalConfirmed) {
      setConfirmingUnverifiedApproval(true);
      return;
    }
    try {
      if (g.id) await api.put(`/goldstandards/${g.id}`, withExpectedVersion(g, g)); else await api.post("/goldstandards", g);
      toast.success("Gold Standard saved"); setConfirmingUnverifiedApproval(false); setOpen(false); onDone();
    } catch (error) {
      toast.error(staleUpdateMessage(error) || formatApiErrorDetail(error?.response?.data?.detail) || "Unable to save Gold Standard.");
      if (error?.response?.status === 409) onDone();
    }
  };
  return (
    <>
    <FormModal open={open} onOpenChange={setOpen} title="Gold Standard" onSubmit={save} wide>
      <Field label="Gold Standard Answer"><Textarea rows={3} value={g.answer} onChange={(e) => set("answer", e.target.value)} data-testid="gold-answer" /></Field>
      <Field label="Explanation (required for Insufficient Verified Evidence)"><Textarea rows={3} value={g.explanation} onChange={(e) => set("explanation", e.target.value)} data-testid="gold-explanation" /></Field>
      <Field label="Limitations / caveats"><Textarea rows={2} value={g.limitations || ""} onChange={(e) => set("limitations", e.target.value)} /></Field>
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
        <Field label="Prepared By"><Input value={g.prepared_by} onChange={(e) => set("prepared_by", e.target.value)} /></Field>
        <Field label="Reviewed By"><Input value={g.reviewed_by} onChange={(e) => set("reviewed_by", e.target.value)} /></Field>
        <Field label="Version"><Input value={g.version || ""} onChange={(e) => set("version", e.target.value)} /></Field>
        <Field label="Approval Status"><ListSelect options={["Draft", "In Review", "Approved", "Insufficient Verified Evidence"]} value={g.review_status} onChange={(v) => set("review_status", v)} testid="gold-status" /></Field>
      </div>
      <p className="text-xs text-muted-foreground">Linked evidence: {evidence.length} ({evidence.filter((e) => e.verification_status === "Verified").length} verified).</p>
    </FormModal>
    <ConfirmActionDialog
      open={confirmingUnverifiedApproval}
      onOpenChange={setConfirmingUnverifiedApproval}
      title="Approve without verified evidence?"
      description="No Verified evidence is linked to this test. Approving a Gold Standard that relies only on unverified evidence weakens its authority. Your draft will remain open if you cancel."
      confirmLabel="Approve Gold Standard"
      destructive
      onConfirm={() => save(true)}
    />
    </>
  );
}

