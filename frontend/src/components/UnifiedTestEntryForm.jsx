import { useId, useMemo, useState } from "react";
import { FormModal, Field } from "./forms";
import { Input } from "./ui/input";
import { Textarea } from "./ui/textarea";
import { Checkbox } from "./ui/checkbox";
import { Button } from "./ui/button";
import { api } from "../lib/api";
import { toast } from "sonner";
import { todayInTimeZone } from "../lib/testDates";
import { SCORE_RUBRIC, hasScoredDimension, scoreRubricReason } from "../lib/scoreRubric";

export const BASSETT_RESULT_OPTIONS = ["Pass", "Pass with Notes", "Partial", "Fail", "Blocked", "Not Evaluated"];
export const COMPARISON_RESULT_OPTIONS = ["Pass", "Pass with Minor Issues", "Needs Improvement", "Fail", "Critical Fail", "Not Evaluated"];
export const COMPARISON_CLASSIFICATIONS = ["Bassett win", "ChatGPT win", "Claude win", "Tie", "Shared failure", "Incomplete"];
export const DEFAULT_DIMENSIONS = [
  ["accuracy", "Accuracy", 3], ["current_code", "Current Code Identification", 2],
  ["interpretation", "Legal / Regulatory Interpretation", 3], ["calculation", "Calculation Accuracy", 2],
  ["context", "Context Understanding", 2], ["missing_info", "Missing Information Recognition", 2],
  ["followup", "Follow-Up Handling", 1], ["citation_accuracy", "Citation Accuracy", 2],
  ["source_quality", "Source Quality", 1], ["guidance", "Guidance Quality", 1],
  ["completeness", "Completeness", 2], ["usefulness", "Usefulness", 3],
];
const DRAFT_KEYS = { bassett: "zoneqa:bassett-workflow-draft", comparison: "zoneqa:comparison-workflow-draft" };

export const emptyBassettTestRun = {
  title: "", question_asked: "", exact_bassett_answer: "", verified_correct_answer: "",
  issue_category: "General", severity: "Medium", priority: "Medium", environment: "",
  test_date: "", scenario_id: "", project_id: "", municipality_id: "", property_id: "",
  version_id: "", bassett_version: "", result: "Pass", score: "", notes: "", evidence: "",
  evaluation_scores: {}, create_finding: false, finding: {}, follow_up_action: "",
  retest_target: "", retest_date: "", source_links: "", attachments: [],
};

export function createBassettTestRunDraft(overrides = {}, timeZone, now = new Date()) {
  const submissionId = globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  return { ...emptyBassettTestRun, test_date: todayInTimeZone(timeZone, now), submission_id: submissionId, ...overrides };
}

export function createComparisonTestDraft(overrides = {}, timeZone, now = new Date()) {
  const submissionId = globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  return {
    name: "", prompts: [{ turn: 1, text: "" }], expected_behaviors: [], scenario_id: "",
    project_id: "", municipality_id: "", property_id: "", version_id: "", bassett_version: "",
    test_date: todayInTimeZone(timeZone, now), status: "Draft", test_type: "Competitive Benchmark",
    criticality: 3, difficulty: 2, environment: "", notes: "", reproduction_steps: "",
    gold_standard_answer: "", exact_bassett_answer: "", verified_correct_answer: "",
    result: "Not Evaluated", evaluation_scores: {}, create_finding: false, finding: {},
    assignee_id: "", follow_up_action: "", retest_target: "", retest_date: "",
    source_links: "", attachments: [], responses: {}, evaluations: {},
    comparison: { comparison_result: "Incomplete", comparison_classification: "Incomplete", findings: [] },
    submission_id: submissionId, ...overrides,
  };
}

export function ScenarioSelector({ scenarios, value, onChange, error }) {
  const id = useId();
  const [query, setQuery] = useState("");
  const shown = scenarios.filter((scenario) => [scenario.stable_id, scenario.test_scenario, scenario.workflow_stage, scenario.priority]
    .some((field) => String(field || "").toLowerCase().includes(query.toLowerCase())));
  const errorId = `${id}-error`;
  return <Field label="Test Bank scenario" required>
    <Input aria-label="Search Test Bank scenarios" placeholder="Search ID, scenario, stage, or priority…" value={query} onChange={(e) => setQuery(e.target.value)} />
    <select required aria-label="Test Bank scenario" aria-invalid={Boolean(error)} aria-describedby={error ? errorId : undefined} className="mt-2 h-9 w-full rounded-md border bg-background px-3 text-sm" value={value || ""} onChange={(e) => onChange(e.target.value)}>
      <option value="">Select a scenario</option>
      {shown.map((scenario) => <option key={scenario.id} value={scenario.id}>{scenario.stable_id} · {scenario.test_scenario} · {scenario.workflow_stage} · {scenario.priority}</option>)}
    </select>
    {error && <p id={errorId} role="alert" className="text-xs text-red-700">{error}</p>}
  </Field>;
}

export function ScenarioDefinition({ scenario }) {
  if (!scenario) return null;
  const fields = [["Stable ID", scenario.stable_id], ["Workflow stage", scenario.workflow_stage], ["Report type", scenario.report_type], ["Test scenario", scenario.test_scenario], ["Complexity", scenario.complexity], ["Why it matters", scenario.why_it_matters], ["What Bassett should do", scenario.what_bassett_should_do], ["Success criteria", scenario.success_criteria], ["Priority", scenario.priority]];
  return <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 text-sm">{fields.map(([label, value]) => <div key={label}><div className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground mb-1">{label}</div><div className="whitespace-pre-wrap">{value || "—"}</div></div>)}</div>;
}

function QuickAdd({ label, value, items, onChange, fields, defaults = {}, disabled }) {
  const id = useId();
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState({});
  const [options, setOptions] = useState(items);
  const collection = label === "Project" ? "projects" : label === "Municipality" ? "municipalities" : "properties";
  const create = async () => {
    const required = fields.find((field) => !String(draft[field.key] || "").trim());
    if (required) return toast.error(`${required.label} is required`);
    if (label === "Property" && !defaults.municipality_id) return toast.error("Select a municipality before adding a property");
    try {
      const { data } = await api.post(`/${collection}`, { ...defaults, ...draft });
      setOptions((current) => [...current.filter((item) => item.id !== data.id), data]);
      onChange(data.id); setDraft({}); setOpen(false); toast.success(`${label} added`);
    } catch { toast.error(`Unable to add ${label.toLowerCase()}`); }
  };
  return <div className="space-y-2">
    <div className="flex flex-wrap gap-2">
      <select id={`${id}-select`} aria-label={label} className="h-9 min-w-0 flex-[1_1_12rem] rounded-md border bg-background px-3 text-sm" value={value || ""} onChange={(e) => onChange(e.target.value)} disabled={disabled}>
        <option value="">Not linked</option>{options.map((item) => <option key={item.id} value={item.id}>{item.name || item.title || item.address}</option>)}
      </select>
      <Button type="button" variant="outline" size="sm" aria-expanded={open} aria-controls={`${id}-quick-add`} onClick={() => setOpen(!open)} disabled={disabled}>+ Add {label}</Button>
    </div>
    {open && <div id={`${id}-quick-add`} className="rounded-lg border bg-[var(--paper)] p-3 space-y-2">
      <div className="text-xs font-semibold">Quick add {label}</div>
      {fields.map((field) => <Field key={field.key} label={field.label} required><Input value={draft[field.key] || ""} onChange={(e) => setDraft({ ...draft, [field.key]: e.target.value })} /></Field>)}
      <div className="flex gap-2"><Button type="button" size="sm" onClick={create}>Create</Button><Button type="button" size="sm" variant="ghost" onClick={() => setOpen(false)}>Cancel</Button></div>
    </div>}
  </div>;
}

function EvaluationGrid({ model, scores, dimensions, onChange, locked }) {
  return <div className="space-y-3">
    <details className="rounded-lg border bg-[var(--paper)] p-3"><summary className="cursor-pointer text-sm font-semibold text-[var(--navy)]">View the shared 0–10 scoring rubric</summary><div className="mt-3 grid gap-1 text-xs">{SCORE_RUBRIC.map(([score, reason]) => <div key={score} className="grid grid-cols-[1.5rem_1fr] gap-2"><b>{score}</b><span>{reason}</span></div>)}</div></details>
    <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
      {dimensions.map((dimension) => <Field key={dimension.key} label={`${dimension.label} · weight ${dimension.weight}`} description={scoreRubricReason(scores?.[dimension.key])}>
        <Input type="number" min="0" max="10" step="1" value={scores?.[dimension.key] ?? ""} disabled={locked} onChange={(e) => onChange(model, dimension.key, e.target.value === "" ? null : Number(e.target.value))} />
      </Field>)}
    </div>
  </div>;
}

function GuidedSection({ index, title, active, status, onActivate, children, comparisonOnly = false }) {
  const panelId = `guided-section-${index}`;
  return <details
    open={active}
    className={`rounded-xl border p-3 sm:p-4 ${active ? "border-[var(--orange)]" : ""}`}
  >
    <summary
      data-guided-section={index}
      className="cursor-pointer list-none rounded-sm font-semibold text-[var(--navy)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--orange)]"
      aria-controls={panelId}
      aria-expanded={active}
      onClick={(event) => { event.preventDefault(); onActivate(index); }}
    >
      <span className="flex min-w-0 items-center justify-between gap-2">
        <span className="min-w-0">{title}</span>
        <span className={`shrink-0 text-xs font-medium ${status === "Needs attention" ? "text-red-700" : "text-muted-foreground"}`}>{status}</span>
      </span>
      {comparisonOnly && <span className="mt-1 block text-[11px] font-normal text-muted-foreground">Comparison only</span>}
    </summary>
    <div id={panelId} role="region" aria-label={title} className="mt-4">{children}</div>
  </details>;
}

function progressFor(form, mode) {
  const fields = mode === "bassett"
    ? [["scenario_id", form.scenario_id], ["question_asked", form.question_asked], ["exact_bassett_answer", form.exact_bassett_answer], ["verified_correct_answer", form.verified_correct_answer], ["test_date", form.test_date]]
    : [["scenario_id", form.scenario_id], ["name", form.name], ["prompt", form.prompts?.[0]?.text], ["gold_standard_answer", form.gold_standard_answer], ["exact_bassett_answer", form.exact_bassett_answer], ["test_date", form.test_date]];
  const complete = fields.filter(([, value]) => String(value || "").trim()).length;
  return { complete, total: fields.length, ready: complete === fields.length };
}

function validate(form, mode) {
  if (mode === "bassett") {
    const required = [
      ["scenario_id", "A Test Bank scenario is required"],
      ["question_asked", "The question asked is required"],
      ["exact_bassett_answer", "The exact Bassett answer is required"],
      ["verified_correct_answer", "The verified correct answer is required"],
      ["test_date", "The test date is required"],
    ];
    const missing = required.find(([key]) => !String(form[key] || "").trim());
    if (missing) return missing[1];
    if (!BASSETT_RESULT_OPTIONS.includes(form.result || "Not Evaluated")) return "Select a valid test result";
    if (hasScoredDimension(form.evaluation_scores) && String(form.score_rationale || "").trim().length < 20) return "Explain the Bassett scores in the Score rationale using at least 20 characters.";
    return null;
  }
  for (const model of ["Bassett", "ChatGPT", "Claude"]) {
    const evaluation = form.evaluations?.[model];
    if (hasScoredDimension(evaluation?.scores) && String(evaluation?.rationale || "").trim().length < 20) return `Explain the ${model} scores in the Score rationale using at least 20 characters.`;
  }
  if (form.id) return null;
  const progress = progressFor(form, mode);
  if (!progress.ready) return "Complete the scenario, test name, prompt, Gold Standard, Bassett response, and test date.";
  return null;
}

export default function UnifiedTestEntryForm({
  mode = "bassett", form, setForm, scenarios = [], versions = [], projects = [],
  municipalities = [], properties = [], users = [], config = {}, onSubmit, onCancel,
  onSaveDraft, submitting = false, conflictNotice = null, lockedCommon = false,
}) {
  const isComparison = mode === "comparison";
  const selectedScenario = scenarios.find((scenario) => scenario.id === form.scenario_id) || form.scenario;
  const dimensions = config.eval_dimensions?.length ? config.eval_dimensions : DEFAULT_DIMENSIONS.map(([key, label, weight]) => ({ key, label, weight }));
  const filteredProperties = useMemo(() => properties.filter((item) => !form.municipality_id || !item.municipality_id || item.municipality_id === form.municipality_id), [properties, form.municipality_id]);
  const progress = progressFor(form, mode);
  const [activeSection, setActiveSection] = useState(0);
  const [attemptedSections, setAttemptedSections] = useState(() => new Set());
  const [draftAvailable] = useState(() => {
    try { return Boolean(localStorage.getItem(DRAFT_KEYS[mode])); } catch { return false; }
  });
  const update = (key, value) => setForm((current) => ({ ...current, [key]: value }));
  const updateNested = (key, child, value) => setForm((current) => ({ ...current, [key]: { ...(current[key] || {}), [child]: value } }));
  const updatePrompt = (value) => setForm((current) => ({ ...current, question_asked: value, prompts: [{ turn: 1, text: value }] }));
  const updateResponse = (model, key, value) => setForm((current) => ({ ...current, responses: { ...(current.responses || {}), [model]: { ...(current.responses?.[model] || {}), [key]: value } }, ...(model === "Bassett" ? { exact_bassett_answer: key === "response" ? value : current.exact_bassett_answer } : {}) }));
  const updateEvaluation = (model, key, value) => setForm((current) => ({
    ...current,
    evaluations: {
      ...(current.evaluations || {}),
      [model]: {
        ...(current.evaluations?.[model] || {}),
        scores: { ...(current.evaluations?.[model]?.scores || {}), [key]: value },
      },
    },
    ...(model === "Bassett" ? { evaluation_scores: { ...(current.evaluation_scores || {}), [key]: value } } : {}),
  }));
  const updateEvaluationResult = (model, value) => setForm((current) => ({
    ...current,
    evaluations: {
      ...(current.evaluations || {}),
      [model]: { ...(current.evaluations?.[model] || {}), final_result: value },
    },
  }));
  const updateEvaluationRationale = (model, value) => setForm((current) => ({
    ...current,
    evaluations: { ...(current.evaluations || {}), [model]: { ...(current.evaluations?.[model] || {}), rationale: value } },
    ...(model === "Bassett" ? { score_rationale: value } : {}),
  }));
  const responseFor = (model) => form.responses?.[model] || (model === "Bassett" ? { response: form.exact_bassett_answer } : {});
  const evaluationFor = (model) => form.evaluations?.[model] || { scores: model === "Bassett" ? form.evaluation_scores : {} };
  const saveDraft = () => {
    try {
      localStorage.setItem(DRAFT_KEYS[mode], JSON.stringify({ ...form, attachments: [] }));
      toast.success("Draft saved on this device"); onSaveDraft?.();
    } catch { toast.error("Draft could not be saved on this device"); }
  };
  const recoverDraft = () => {
    try {
      const saved = JSON.parse(localStorage.getItem(DRAFT_KEYS[mode]) || "null");
      if (saved) { setForm((current) => ({ ...current, ...saved, submission_id: current.submission_id })); toast.success("Draft recovered"); }
    } catch { toast.error("Saved draft could not be recovered"); }
  };
  const sectionIssue = (index) => {
    if (index === 0) {
      if (!String(form.scenario_id || "").trim()) return "Select a Test Bank scenario.";
      if (isComparison && !String(form.name || "").trim()) return "Enter a test name.";
      if (!String(form.test_date || "").trim()) return "Enter a test date.";
    }
    if (index === 1) {
      if (!String(form.question_asked || form.prompts?.[0]?.text || "").trim()) return isComparison ? "Enter the prompt or question." : "Enter the question asked.";
      if (!String(form.verified_correct_answer || form.gold_standard_answer || "").trim()) return isComparison ? "Enter the Gold Standard answer." : "Enter the verified correct answer.";
    }
    if (index === 2 && !String(form.exact_bassett_answer || responseFor("Bassett").response || "").trim()) {
      return isComparison ? "Enter the Bassett response." : "Enter the exact Bassett answer.";
    }
    if (index === 4 && form.create_finding && !String(finding.title || "").trim()) return "Enter a finding title.";
    return null;
  };
  const sectionHasValue = (index) => {
    if (index === 3) return Object.values(evaluationFor("Bassett").scores || {}).some((value) => value !== null && value !== "");
    if (index === 4) return Boolean(form.create_finding || form.assignee_id);
    if (index === 5) return Boolean(form.source_links || form.evidence || form.notes || form.attachments?.length);
    if (index === 6) return Boolean(form.follow_up_action || form.retest_target || form.retest_date || form.regression_run_id);
    if (index === 7) return Boolean(responseFor("ChatGPT").response);
    if (index === 8) return Boolean(responseFor("Claude").response);
    if (index === 9) return ["ChatGPT", "Claude"].some((model) => Object.values(evaluationFor(model).scores || {}).some((value) => value !== null && value !== ""));
    if (index === 10) return Boolean(comparison.comparison_result && comparison.comparison_result !== "Incomplete");
    return !sectionIssue(index);
  };
  const sectionStatus = (index) => {
    if (attemptedSections.has(index) && sectionIssue(index)) return "Needs attention";
    return sectionHasValue(index) ? "Complete" : (index < 3 ? "Required" : "Optional");
  };
  const activateSection = (index, markCurrent = true) => {
    if (markCurrent) setAttemptedSections((current) => new Set(current).add(activeSection));
    setActiveSection(index);
    globalThis.setTimeout?.(() => globalThis.document?.querySelector(`[data-guided-section="${index}"]`)?.focus(), 0);
  };
  const submit = () => {
    const error = validate(form, mode);
    if (error) {
      const sectionCount = isComparison ? 11 : 7;
      setAttemptedSections(new Set(Array.from({ length: sectionCount }, (_, index) => index)));
      const firstInvalid = Array.from({ length: sectionCount }, (_, index) => index).find((index) => sectionIssue(index));
      if (firstInvalid !== undefined) activateSection(firstInvalid, false);
      return toast.error(error);
    }
    onSubmit();
  };
  const ownerOptions = users.filter((item) => item.active !== false && !item.deleted_at);
  const setMunicipality = (value) => setForm((current) => ({ ...current, municipality_id: value, property_id: "" }));
  const finding = form.finding || {};
  const comparison = form.comparison || {};
  const totalSections = isComparison ? 11 : 7;
  return <FormModal open onOpenChange={(open) => !open && onCancel()} title={`${form.id ? "Edit" : "Create"} ${isComparison ? "Model Comparison" : "Bassett-only test"}`} onSubmit={submit} submitLabel={form.id ? "Save changes" : `Create ${isComparison ? "Model Comparison" : "Bassett-only test"}`} wide submitDisabled={submitting}>
    <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-[var(--orange)] bg-orange-50 p-3">
      <div><div className="text-xs font-bold uppercase tracking-wide text-[var(--orange)]">Form mode</div><div className="text-lg font-semibold text-[var(--navy)]" data-testid="workflow-mode-label">{isComparison ? "Model comparison" : "Bassett-only test"}</div></div>
      <div className="text-right"><div className="text-xs font-semibold text-muted-foreground">Required completeness</div><div data-testid="workflow-completeness" className="font-semibold text-[var(--navy)]">{progress.complete}/{progress.total} required fields {progress.ready ? "· Ready" : "· In progress"}</div></div>
    </div>
    {conflictNotice}
    {!form.id && draftAvailable && <div className="rounded-lg border border-[var(--orange)] bg-orange-50 p-3 text-sm flex items-center justify-between gap-3"><span>A saved {isComparison ? "comparison" : "Bassett"} draft is available.</span><Button type="button" size="sm" variant="outline" onClick={recoverDraft}>Recover draft</Button></div>}

    <GuidedSection index={0} title="1. Test Setup" active={activeSection === 0} status={sectionStatus(0)} onActivate={activateSection}><div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
       {!lockedCommon && <div className="sm:col-span-2"><ScenarioSelector scenarios={scenarios} value={form.scenario_id} onChange={(value) => update("scenario_id", value)} error={attemptedSections.has(0) && !String(form.scenario_id || "").trim() ? "Test Bank scenario is required." : undefined} /></div>}
      {selectedScenario && <div className="sm:col-span-2 rounded-xl border bg-[var(--paper)] p-4"><div className="font-semibold mb-3">Read-only Test Bank definition</div><ScenarioDefinition scenario={selectedScenario} /></div>}
      <Field label="Sequential Test ID"><Input value={form.test_id || "Assigned on save"} readOnly className="bg-muted" /></Field>
      <Field label="Workflow stage"><Input value={form.workflow_stage || selectedScenario?.workflow_stage || "Selected from Test Bank"} readOnly className="bg-muted" /></Field>
      <Field label="Test name" required={isComparison} error={attemptedSections.has(0) && isComparison && !String(form.name || "").trim() ? "Test name is required." : undefined}><Input value={form.name || form.title || ""} disabled={lockedCommon} onChange={(e) => update(isComparison ? "name" : "title", e.target.value)} /></Field>
      <Field label="Bassett version"><select className="h-9 w-full rounded-md border bg-background px-3 text-sm" value={form.version_id || ""} disabled={lockedCommon} onChange={(e) => update("version_id", e.target.value)}><option value="">Not specified</option>{versions.map((version) => <option key={version.id} value={version.id}>{version.name}</option>)}</select></Field>
      <Field label="Test date" required error={attemptedSections.has(0) && !String(form.test_date || "").trim() ? "Test date is required." : undefined}><Input type="date" value={form.test_date || ""} disabled={lockedCommon} onChange={(e) => update("test_date", e.target.value)} /></Field>
      <Field label="Environment"><Input value={form.environment || ""} disabled={lockedCommon} onChange={(e) => update("environment", e.target.value)} placeholder="Production, Staging…" /></Field>
    </div></GuidedSection>

    <GuidedSection index={1} title="2. Linked Records & Prompt" active={activeSection === 1} status={sectionStatus(1)} onActivate={activateSection}><div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
      <Field label="Project"><QuickAdd label="Project" value={form.project_id} items={projects} onChange={(value) => update("project_id", value)} fields={[{ key: "name", label: "Project name" }]} disabled={lockedCommon} /></Field>
      <Field label="Municipality"><QuickAdd label="Municipality" value={form.municipality_id} items={municipalities} onChange={setMunicipality} fields={[{ key: "name", label: "Municipality name" }, { key: "state", label: "State" }]} disabled={lockedCommon} /></Field>
      <Field label="Property / address"><QuickAdd label="Property" value={form.property_id} items={filteredProperties} defaults={{ municipality_id: form.municipality_id }} onChange={(value) => update("property_id", value)} fields={[{ key: "name", label: "Property name" }, { key: "address", label: "Address" }]} disabled={lockedCommon} /></Field>
       <Field label={isComparison ? "Prompt / question" : "Question asked"} required error={attemptedSections.has(1) && !String(form.question_asked || form.prompts?.[0]?.text || "").trim() ? "Prompt or question is required." : undefined}><Textarea rows={3} value={form.question_asked || form.prompts?.[0]?.text || ""} disabled={lockedCommon} onChange={(e) => updatePrompt(e.target.value)} /></Field>
       <div className="sm:col-span-2"><Field label={isComparison ? "Verified answer / Gold Standard" : "Verified correct answer"} required error={attemptedSections.has(1) && !String(form.verified_correct_answer || form.gold_standard_answer || "").trim() ? "Verified answer is required." : undefined}><Textarea rows={4} value={form.verified_correct_answer || form.gold_standard_answer || ""} disabled={lockedCommon} onChange={(e) => setForm((current) => ({ ...current, verified_correct_answer: e.target.value, gold_standard_answer: e.target.value }))} /></Field></div>
    </div></GuidedSection>

    <GuidedSection index={2} title="3. Bassett Result" active={activeSection === 2} status={sectionStatus(2)} onActivate={activateSection}><div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
      <Field label={isComparison ? "Bassett response" : "Exact Bassett answer"} required error={attemptedSections.has(2) && !String(responseFor("Bassett").response || "").trim() ? "Bassett response is required." : undefined}><Textarea rows={6} value={responseFor("Bassett").response || ""} disabled={lockedCommon} onChange={(e) => updateResponse("Bassett", "response", e.target.value)} /></Field>
      <Field label="Status / verdict"><select className="h-9 w-full rounded-md border bg-background px-3 text-sm" value={form.result || "Not Evaluated"} onChange={(e) => update("result", e.target.value)}>{(isComparison ? COMPARISON_RESULT_OPTIONS : BASSETT_RESULT_OPTIONS).map((value) => <option key={value}>{value}</option>)}</select></Field>
      <Field label="Severity / criticality"><select className="h-9 w-full rounded-md border bg-background px-3 text-sm" value={form.severity || form.criticality || "Medium"} onChange={(e) => update("severity", e.target.value)}>{["Critical", "High", "Medium", "Low", "1", "2", "3", "4", "5"].map((value) => <option key={value}>{value}</option>)}</select></Field>
      <Field label="Priority"><select className="h-9 w-full rounded-md border bg-background px-3 text-sm" value={form.priority || "Medium"} onChange={(e) => update("priority", e.target.value)}>{["Critical", "High", "Medium", "Low"].map((value) => <option key={value}>{value}</option>)}</select></Field>
      <Field label="Category"><Input value={form.issue_category || form.category || ""} onChange={(e) => update(isComparison ? "category" : "issue_category", e.target.value)} /></Field>
    </div></GuidedSection>

    <GuidedSection index={3} title="4. Canonical Evaluation" active={activeSection === 3} status={sectionStatus(3)} onActivate={activateSection}><p className="text-xs text-muted-foreground">Use the same behavior-based integer rubric for every model and dimension. Score the evidence before choosing a verdict. Blank dimensions remain unavailable and are excluded from the denominator.</p><div className="mt-4 space-y-4"><h4 className="font-semibold text-sm text-[var(--navy)]">Bassett evaluation · calculated score</h4><EvaluationGrid model="Bassett" scores={evaluationFor("Bassett").scores} dimensions={dimensions} onChange={updateEvaluation} locked={lockedCommon} /><Field label="Bassett score rationale" required={hasScoredDimension(evaluationFor("Bassett").scores)} description="Cite the specific answer evidence that supports the selected numbers (minimum 20 characters when scored)."><Textarea rows={3} value={evaluationFor("Bassett").rationale || form.score_rationale || ""} onChange={(e) => updateEvaluationRationale("Bassett", e.target.value)} /></Field></div></GuidedSection>

    <GuidedSection index={4} title="5. Findings & Ownership" active={activeSection === 4} status={sectionStatus(4)} onActivate={activateSection}><div className="space-y-4">
      <label className="flex items-center gap-2 text-sm"><Checkbox aria-label="Create a linked Bassett finding" checked={Boolean(form.create_finding)} onCheckedChange={(checked) => update("create_finding", checked === true)} /> Create a linked Bassett finding</label>
      {form.create_finding && <div className="grid grid-cols-1 sm:grid-cols-2 gap-4"><Field label="Finding title" required error={attemptedSections.has(4) && !String(finding.title || "").trim() ? "Finding title is required." : undefined}><Input value={finding.title || ""} onChange={(e) => updateNested("finding", "title", e.target.value)} /></Field><Field label="Owner / assignee"><select className="h-9 w-full rounded-md border bg-background px-3 text-sm" value={form.assignee_id || ""} onChange={(e) => update("assignee_id", e.target.value)}><option value="">Unassigned</option>{ownerOptions.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></Field><Field label="Finding description"><Textarea rows={3} value={finding.description || ""} onChange={(e) => updateNested("finding", "description", e.target.value)} /></Field><Field label="Reproduction steps"><Textarea rows={3} value={form.reproduction_steps || ""} onChange={(e) => update("reproduction_steps", e.target.value)} /></Field></div>}
      {!form.create_finding && <Field label="Owner / assignee"><select className="h-9 w-full rounded-md border bg-background px-3 text-sm" value={form.assignee_id || ""} onChange={(e) => update("assignee_id", e.target.value)}><option value="">Unassigned</option>{ownerOptions.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></Field>}
    </div></GuidedSection>

    <GuidedSection index={5} title="6. Sources, Documents & Notes" active={activeSection === 5} status={sectionStatus(5)} onActivate={activateSection}><div className="space-y-4">
      <Field label={isComparison ? "Sources / evidence links" : "Evidence / context"}><Textarea rows={3} value={form.source_links || form.evidence || ""} onChange={(e) => update(isComparison ? "source_links" : "evidence", e.target.value)} placeholder="Citations, URLs, source context…" /></Field>
      <Field label="Notes / reproduction steps"><Textarea rows={4} value={form.notes || ""} onChange={(e) => update("notes", e.target.value)} /></Field>
      <Field label="Documents / images" description={form.attachments?.length ? `${form.attachments.length} file(s) selected` : "Files upload after the test record is saved; a failed upload will not discard the test."}><Input type="file" multiple accept=".pdf,.docx,.png,.jpg,.jpeg,.gif,.webp,.txt,.csv" onChange={(e) => update("attachments", Array.from(e.target.files || []))} /></Field>
    </div></GuidedSection>

    <GuidedSection index={6} title="7. Follow-up, Retesting & Regression" active={activeSection === 6} status={sectionStatus(6)} onActivate={activateSection}><div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
      <Field label="Follow-up action"><Textarea rows={3} value={form.follow_up_action || ""} onChange={(e) => update("follow_up_action", e.target.value)} /></Field>
      <Field label="Retest target"><Input value={form.retest_target || ""} onChange={(e) => update("retest_target", e.target.value)} /></Field>
      <Field label="Retest date"><Input type="date" value={form.retest_date || ""} onChange={(e) => update("retest_date", e.target.value)} /></Field>
      <Field label="Regression linkage"><Input value={form.regression_run_id || ""} onChange={(e) => update("regression_run_id", e.target.value)} placeholder="Regression run ID (optional)" /></Field>
    </div></GuidedSection>

    {isComparison && <div className="space-y-4 border-t-4 border-dashed border-[var(--orange)] pt-4">
      <div className="rounded-lg bg-[var(--paper)] p-3"><h3 className="font-semibold text-[var(--navy)]">Comparison-only sections</h3><p className="text-xs text-muted-foreground mt-1">These benchmark records and findings are separate from Bassett-only findings. Missing benchmark responses and scores are saved as unavailable and excluded from comparison metrics.</p></div>
      {["ChatGPT", "Claude"].map((model, modelIndex) => {
        const index = 7 + modelIndex;
        return <GuidedSection key={model} index={index} title={`${model} response, model metadata & settings`} active={activeSection === index} status={sectionStatus(index)} onActivate={activateSection} comparisonOnly><div className="grid grid-cols-1 sm:grid-cols-2 gap-4"><Field label={`${model} response`} description="Leave blank to record this response as unavailable."><Textarea rows={6} value={responseFor(model).response || ""} onChange={(e) => updateResponse(model, "response", e.target.value)} placeholder="Leave blank to record unavailable." /></Field><Field label="Model name"><Input value={responseFor(model).model_name || model} onChange={(e) => updateResponse(model, "model_name", e.target.value)} /></Field><Field label="Model version"><Input value={responseFor(model).version || ""} onChange={(e) => updateResponse(model, "version", e.target.value)} /></Field><Field label="Response date"><Input type="date" value={responseFor(model).test_date || form.test_date || ""} onChange={(e) => updateResponse(model, "test_date", e.target.value)} /></Field><Field label="Settings"><Textarea rows={2} value={typeof responseFor(model).settings === "string" ? responseFor(model).settings : JSON.stringify(responseFor(model).settings || {})} onChange={(e) => updateResponse(model, "settings", e.target.value)} placeholder="Temperature, system prompt, tools…" /></Field></div></GuidedSection>;
      })}
      <GuidedSection index={9} title="Benchmark evaluations & canonical scores" active={activeSection === 9} status={sectionStatus(9)} onActivate={activateSection} comparisonOnly><div className="space-y-6">{["ChatGPT", "Claude"].map((model) => <div key={model} className="space-y-3"><div className="grid grid-cols-1 sm:grid-cols-2 gap-3 items-end"><h4 className="font-semibold text-sm text-[var(--navy)]">{model} evaluation · calculated score</h4><Field label={`${model} verdict`}><select className="h-9 w-full rounded-md border bg-background px-3 text-sm" value={evaluationFor(model).final_result || "Not Evaluated"} onChange={(e) => updateEvaluationResult(model, e.target.value)}>{COMPARISON_RESULT_OPTIONS.map((value) => <option key={value}>{value}</option>)}</select></Field></div><EvaluationGrid model={model} scores={evaluationFor(model).scores} dimensions={dimensions} onChange={updateEvaluation} /><Field label={`${model} score rationale`} required={hasScoredDimension(evaluationFor(model).scores)} description="Cite specific evidence supporting the selected scores (minimum 20 characters when scored)."><Textarea rows={3} value={evaluationFor(model).rationale || ""} onChange={(e) => updateEvaluationRationale(model, e.target.value)} /></Field></div>)}</div></GuidedSection>
      <GuidedSection index={10} title="Benchmark result & competitive findings" active={activeSection === 10} status={sectionStatus(10)} onActivate={activateSection} comparisonOnly><div className="grid grid-cols-1 sm:grid-cols-2 gap-4"><Field label="Bassett-versus-benchmark result"><select className="h-9 w-full rounded-md border bg-background px-3 text-sm" value={comparison.comparison_result || "Incomplete"} onChange={(e) => updateNested("comparison", "comparison_result", e.target.value)}>{COMPARISON_RESULT_OPTIONS.map((value) => <option key={value}>{value}</option>)}</select></Field><Field label="Win / loss / tie / shared failure"><select className="h-9 w-full rounded-md border bg-background px-3 text-sm" value={comparison.comparison_classification || "Incomplete"} onChange={(e) => updateNested("comparison", "comparison_classification", e.target.value)}>{COMPARISON_CLASSIFICATIONS.map((value) => <option key={value}>{value}</option>)}</select></Field><Field label="Competitive advantage"><Textarea rows={3} value={comparison.competitive_advantage || ""} onChange={(e) => updateNested("comparison", "competitive_advantage", e.target.value)} /></Field><Field label="Competitive gap"><Textarea rows={3} value={comparison.competitive_gap || ""} onChange={(e) => updateNested("comparison", "competitive_gap", e.target.value)} /></Field><Field label="Comparison-specific findings"><Textarea rows={4} value={comparison.findings?.[0]?.description || ""} onChange={(e) => updateNested("comparison", "findings", [{ title: "Comparison finding", description: e.target.value }])} placeholder="Never mixed into Bassett-only findings." /></Field></div></GuidedSection>
    </div>}
    <div className="sticky bottom-0 z-10 flex flex-wrap items-center gap-2 border-t bg-background/95 py-3">
      <Button type="button" variant="outline" disabled={activeSection === 0} onClick={() => activateSection(activeSection - 1)}>Previous</Button>
      {activeSection < totalSections - 1 && <Button type="button" onClick={() => activateSection(activeSection + 1)}>Next</Button>}
      {!form.id && <Button type="button" variant="outline" className="sm:ml-auto" onClick={saveDraft}>Save draft</Button>}
    </div>
  </FormModal>;
}

