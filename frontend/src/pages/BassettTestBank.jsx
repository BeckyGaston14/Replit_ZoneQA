import { useMemo, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate } from "react-router-dom";
import { api, formatApiErrorDetail, staleUpdateMessage, withExpectedVersion } from "../lib/api";
import { useAuth } from "../lib/auth";
import { PageHeader, Section, StatCard } from "../components/shared";
import { StatusBadge } from "../lib/statusMaps";
import { Attachments } from "../components/Attachments";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import { Textarea } from "../components/ui/textarea";
import { Field, FormModal } from "../components/forms";
import { Activity, Archive, ArchiveRestore, CheckCircle2, Download, FlaskConical, Plus, Search, Upload, XCircle } from "lucide-react";
import { toast } from "sonner";
import { parseCsv } from "../lib/csv";
import { SortableTableHeader } from "../components/SortableTableHeader";
import { TableSortControls } from "../components/TableSortControls";
import { nextSort, sortTableRows, usePersistentTableSort } from "../lib/tableSorting";
import {
  TEST_BANK_SORT_COLUMNS,
} from "../lib/testBankSorting";
import { BassettTestRunForm, createBassettTestRunDraft } from "../components/BassettTestRunForm";
import { formatTestDate } from "../lib/testDates";
import { useFocusTrap } from "../lib/useFocusTrap";
import { TABLE_ACTION_CELL_CLASS, TABLE_CELL_CLASS, TABLE_CLASS, TABLE_EMPTY_CELL_CLASS, TABLE_HEAD_CLASS } from "../lib/tableStyles";
import { ConfirmActionDialog } from "../components/ConfirmActionDialog";
import { useSavedView } from "../lib/hooks";
import { focusFormError, validateScenarioDraft } from "../lib/formValidation";

const emptyScenario = {
  workflow_stage: "", report_type: "", test_scenario: "",
  complexity: "Medium", why_it_matters: "", what_bassett_should_do: "",
  success_criteria: "", priority: "Medium", project_id: "", testcase_id: "", version_id: "",
};
const DEFAULT_TEST_BANK_VIEW = { filters: { search: "", stage: "all" } };
const displayResult = (value) => value === "Incomplete" ? "Legacy: Incomplete" : value;

export function ResultPill({ value }) {
  return <StatusBadge value={value || "Not Evaluated"} compact />;
}

export default function BassettTestBank() {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const { user } = useAuth();
  const canManage = ["admin", "qa_manager"].includes(user?.role);
  const canExecute = user?.role !== "viewer";
  const { state: view, updateState: updateView, error: viewError, clearError: clearViewError } = useSavedView(
    "bassett-test-bank",
    DEFAULT_TEST_BANK_VIEW,
    (saved = {}) => ({
      filters: {
        search: typeof saved.filters?.search === "string" ? saved.filters.search : "",
        stage: typeof saved.filters?.stage === "string" && saved.filters.stage ? saved.filters.stage : "all",
      },
    }),
  );
  const search = view.filters.search;
  const stage = view.filters.stage;
  const [form, setForm] = useState(null);
  const [formErrors, setFormErrors] = useState({});
  const [scenarioError, setScenarioError] = useState("");
  const [savingScenario, setSavingScenario] = useState(false);
  const scenarioSubmitInFlight = useRef(false);
  const scenarioBaseline = useRef(null);
  const [conflict, setConflict] = useState(null);
  const [selected, setSelected] = useState(null);
  const [execute, setExecute] = useState(null);
  const [savingRun, setSavingRun] = useState(false);
  const [showImport, setShowImport] = useState(false);
  const [importRows, setImportRows] = useState([]);
  const [preview, setPreview] = useState(null);
  const [importFileName, setImportFileName] = useState("");
  const [importing, setImporting] = useState(false);
  const [showWorkflowManager, setShowWorkflowManager] = useState(false);
  const [confirmingArchive, setConfirmingArchive] = useState(null);
  const [showArchived, setShowArchived] = useState(false);
  const [stageDraft, setStageDraft] = useState({ name: "", code: "", position: "", active: true });
  const [stageConflict, setStageConflict] = useState(null);
  const { data: scenarios = [], isLoading } = useQuery({ queryKey: ["bassett-scenarios", "including-archived"], queryFn: async () => (await api.get("/bassett/test-bank?include_archived=true")).data });
  const { data: metrics } = useQuery({ queryKey: ["bassett-metrics"], queryFn: async () => (await api.get("/bassett/metrics")).data });
  const { data: projects = [] } = useQuery({ queryKey: ["projects"], queryFn: async () => (await api.get("/projects")).data });
  const { data: testcases = [] } = useQuery({ queryKey: ["testcases"], queryFn: async () => (await api.get("/testcases")).data });
  const { data: versions = [] } = useQuery({ queryKey: ["versions"], queryFn: async () => (await api.get("/versions")).data });
  const { data: config } = useQuery({ queryKey: ["config"], queryFn: async () => (await api.get("/config")).data });
  const { data: workflowStages = [] } = useQuery({ queryKey: ["bassett-workflow-stages"], queryFn: async () => (await api.get("/bassett/workflow-stages")).data });
  const testBankColumns = useMemo(() => TEST_BANK_SORT_COLUMNS.map((column) => column.key === "workflow_stage"
    ? { ...column, type: "status", order: workflowStages.map((item) => typeof item === "string" ? item : item.name || item.workflow_stage).filter(Boolean) }
    : column), [workflowStages]);
  const [sort, setSort] = usePersistentTableSort("bassett-test-bank", TEST_BANK_SORT_COLUMNS, { key: "stable_id", direction: "asc" });
  const stages = [...new Set([...workflowStages.map((stageDef) => typeof stageDef === "string" ? stageDef : stageDef.name || stageDef.workflow_stage), ...scenarios.map((s) => s.workflow_stage)].filter(Boolean))];
  const shown = useMemo(() => sortTableRows(scenarios.filter((scenario) => {
    const q = search.trim().toLowerCase();
    return Boolean(scenario.archived) === showArchived && (stage === "all" || scenario.workflow_stage === stage) &&
      (!q || [scenario.stable_id, scenario.test_scenario, scenario.report_type, scenario.why_it_matters]
        .some((value) => String(value || "").toLowerCase().includes(q)));
  }), testBankColumns, sort, ["stable_id", "test_scenario"]), [scenarios, search, stage, sort, testBankColumns, showArchived]);

  const saveScenario = async () => {
    const errors = validateScenarioDraft(form);
    if (Object.keys(errors).length > 0) {
      setFormErrors(errors);
      setScenarioError("Complete the required definition before saving. Your entries are still here.");
      setTimeout(() => focusFormError(Object.keys(errors)[0]), 0);
      return;
    }
    if (savingScenario || scenarioSubmitInFlight.current) return;
    scenarioSubmitInFlight.current = true;
    setSavingScenario(true);
    setFormErrors({});
    setScenarioError("");
    try {
      if (form.id) await api.put(`/bassett/scenarios/${form.id}`, withExpectedVersion(form, form));
      else await api.post("/bassett/scenarios", form);
      toast.success(form.id ? "Scenario updated" : "Scenario added to Test Bank"); setConflict(null); setForm(null); qc.invalidateQueries();
    } catch (error) {
      if (error?.response?.status === 409 && form.id) {
        try { setConflict((await api.get(`/bassett/scenarios/${form.id}`)).data); } catch { setConflict({ revision: error?.response?.data?.detail?.current_revision }); }
        toast.error(staleUpdateMessage(error) || "This scenario changed elsewhere. Review your entries before reapplying them.");
      } else {
        const message = importError(error, "Unable to save scenario");
        setScenarioError(`Your entries are still here. ${message}`);
        toast.error(message);
      }
    } finally { scenarioSubmitInFlight.current = false; setSavingScenario(false); }
  };
  const setScenarioField = (key, value) => {
    setForm((draft) => ({ ...draft, [key]: value }));
    setFormErrors((errors) => {
      if (!errors[key]) return errors;
      const next = { ...errors };
      delete next[key];
      return next;
    });
    setScenarioError("");
  };
  const setViewFilter = (key, value) => updateView((current) => ({
    ...current,
    filters: { ...current.filters, [key]: value },
  }));
  const recordExecution = async () => {
    if (savingRun) return;
    setSavingRun(true);
    try {
      const body = { ...execute };
      delete body.attachments;
      const payload = new FormData();
      payload.append("payload", JSON.stringify(body));
      (execute.attachments || []).forEach((file) => payload.append("files", file));
      const { data } = await api.post("/bassett/issues/workflow", payload);
      toast.success("Test run recorded");
      setExecute(null);
      qc.invalidateQueries({ queryKey: ["bassett-scenarios"] });
      qc.invalidateQueries({ queryKey: ["bassett-metrics"] });
      qc.invalidateQueries({ queryKey: ["bassett-test-runs"] });
      navigate(`/bassett/issues?open=${encodeURIComponent(data.issue?.id || data.id)}`);
    } catch (error) { toast.error(importError(error, "Unable to record test run")); }
    finally { setSavingRun(false); }
  };
  const archive = async (scenario) => {
    try { await api.post(`/bassett/scenarios/${scenario.id}/archive`); toast.success("Scenario archived"); setSelected(null); qc.invalidateQueries(); }
    catch (error) { toast.error(importError(error, "Unable to archive scenario")); }
    finally { setConfirmingArchive(null); }
  };
  const restore = async (scenario) => {
    try { await api.post(`/bassett/scenarios/${scenario.id}/restore`); toast.success("Scenario restored"); setSelected(null); qc.invalidateQueries(); }
    catch (error) { toast.error(importError(error, "Unable to restore scenario")); }
  };
  const exportCsv = async () => {
    try {
      const { data } = await api.get("/bassett/export/scenarios.csv", { responseType: "blob" });
      const link = document.createElement("a"); link.href = URL.createObjectURL(data); link.download = "bassett-test-bank.csv"; link.click(); URL.revokeObjectURL(link.href);
      toast.success("CSV export downloaded.");
    } catch (error) { toast.error(importError(error, "Unable to export Test Bank")); }
  };
  const loadCsv = (event) => {
    const file = event.target.files?.[0]; if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      setImportRows(parseCsv(reader.result));
      setImportFileName(file.name);
      setPreview(null);
    };
    reader.readAsText(file);
  };
  const previewImport = async () => {
    try {
      const { data } = await api.post("/bassett/reference-data/preview", { rows: importRows });
      setPreview(data);
    } catch (error) { toast.error(importError(error, "Unable to preview CSV")); }
  };
  const commitImport = async () => {
    if (preview?.invalid) return;
    setImporting(true);
    try {
      const { data } = await api.post("/bassett/reference-data/import", { rows: importRows });
      toast.success(`${data.imported} added, ${data.updated} updated`); setShowImport(false); setImportRows([]); setPreview(null); setImportFileName(""); qc.invalidateQueries();
    } catch (error) { toast.error(importError(error, "Unable to import reference data")); }
    finally { setImporting(false); }
  };
  const saveStage = async () => {
    try {
      if (stageDraft.id) await api.put(`/bassett/workflow-stages/${stageDraft.id}`, withExpectedVersion(stageDraft, {
        name: stageDraft.name, position: Number(stageDraft.position), active: stageDraft.active,
      }));
      else await api.post("/bassett/workflow-stages", {
        name: stageDraft.name, code: stageDraft.code, position: Number(stageDraft.position), active: stageDraft.active,
      });
      toast.success(stageDraft.id ? "Workflow stage updated" : "Workflow stage created");
      setStageConflict(null);
      setStageDraft({ name: "", code: "", position: "", active: true });
      qc.invalidateQueries({ queryKey: ["bassett-workflow-stages"] });
    } catch (error) {
      if (error?.response?.status === 409 && stageDraft.id) {
        const latest = workflowStages.find((stage) => stage.id === stageDraft.id);
        setStageConflict(latest || { revision: error?.response?.data?.detail?.current_revision });
        toast.error(staleUpdateMessage(error) || "This workflow stage changed elsewhere. Review your entries before reapplying them.");
        qc.invalidateQueries({ queryKey: ["bassett-workflow-stages"] });
      } else toast.error(importError(error, "Unable to save workflow stage"));
    }
  };
  const scenarioDirty = Boolean(form && scenarioBaseline.current && JSON.stringify(form) !== JSON.stringify(scenarioBaseline.current));

  return <div>
    <PageHeader title="Bassett Test Bank" subtitle="Bassett-only Research and Analysis scenarios with explicit success criteria and Bassett test run history. Pass test runs are not findings.">
      {canManage && <Button variant="outline" onClick={() => setShowImport(true)}><Upload /> Import reference data</Button>}
       {canManage && <Button variant="outline" onClick={() => setShowWorkflowManager(true)}>Manage stages & prefixes</Button>}
      <Button variant="outline" onClick={exportCsv}><Download /> Export</Button>
      <Button variant="outline" aria-pressed={showArchived} onClick={() => setShowArchived((value) => !value)}>{showArchived ? "Active scenarios" : "Archived scenarios"}</Button>
      {canManage && <Button onClick={() => { const draft = { ...emptyScenario }; scenarioBaseline.current = draft; setFormErrors({}); setScenarioError(""); setConflict(null); setForm(draft); }} className="bg-[var(--orange)] hover:bg-[var(--orange-600)]"><Plus /> Add scenario</Button>}
    </PageHeader>
    {viewError && <div role="alert" className="mb-3 rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900">{viewError} <button type="button" className="ml-2 font-semibold underline" onClick={clearViewError}>Dismiss</button></div>}
    <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-6">
      <StatCard label="Active scenarios" value={metrics?.scenarios.active ?? "—"} sub="Bassett Test Bank denominator" icon={FlaskConical} accent="#16215a" />
      <StatCard label="Test Runs Completed" value={metrics?.test_runs.test_bank_coverage.covered ?? "—"} sub="active scenarios with a completed canonical result" icon={Activity} accent="#2563eb" />
      <StatCard label="Pass rate" value={metrics?.test_runs.pass_rate != null ? `${metrics.test_runs.pass_rate}%` : "—"} sub={metrics ? `${metrics.test_runs.passed}/${metrics.test_runs.eligible} eligible test runs` : "Pass or Pass with Notes ÷ eligible runs"} icon={CheckCircle2} accent="#16a34a" />
      <StatCard label="Tests Needing Attention" value={metrics?.test_runs.attention ?? "—"} sub="Partial, Fail, or Blocked results" icon={XCircle} accent="#dc2626" />
    </div>
    <Section title="Scenario library" action={<span className="text-xs text-muted-foreground">{shown.length} active scenario(s)</span>}>
      <div className="flex flex-wrap gap-2 mb-4">
         <div className="relative flex-1 min-w-[240px]"><Search size={15} className="absolute left-3 top-2.5 text-muted-foreground" /><Input aria-label="Search Test Bank scenarios" className="pl-9" placeholder="Search ID, scenario, report type, purpose…" value={search} onChange={(e) => setViewFilter("search", e.target.value)} /></div>
         <select aria-label="Filter by workflow stage" className="h-9 rounded-md border bg-background px-3 text-sm" value={stage} onChange={(e) => setViewFilter("stage", e.target.value)}><option value="all">All workflow stages</option>{stages.map((x) => <option key={x}>{x}</option>)}</select>
         <span className="text-xs text-muted-foreground self-center">View saved to your account</span>
      </div>
      <TableSortControls columns={testBankColumns} sort={sort} setSort={setSort} defaultSort={{ key: "stable_id", direction: "asc" }} className="mb-3" />
       <div className="overflow-x-auto" role="region" aria-label="Bassett Test Bank scenario table" tabIndex="0" data-testid="bassett-test-bank-table-scroll"><table className={TABLE_CLASS}><thead className={TABLE_HEAD_CLASS}><tr>
        {testBankColumns.map((column) => <SortableTableHeader key={column.key} column={column} sort={sort} onSort={(key) => setSort((current) => nextSort(current, key))} />)}
        <th className="px-2.5 py-2 text-[11px] uppercase tracking-wide text-muted-foreground"><span className="sr-only">Actions</span></th>
      </tr></thead>
        <tbody>{isLoading ? <tr><td colSpan="8" className={TABLE_EMPTY_CELL_CLASS}>Loading Test Bank…</td></tr> : shown.map((scenario) => <tr key={scenario.id} className="border-t hover:bg-[var(--paper)]">
          <td className={`${TABLE_CELL_CLASS} font-bold text-[var(--orange)]`}><button type="button" className="w-full text-left rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--orange)] focus-visible:ring-offset-2" onClick={() => setSelected(scenario.id)} aria-label={`Open ${scenario.stable_id} scenario`}>{scenario.stable_id}</button></td><td className={`${TABLE_CELL_CLASS} font-semibold`}>{scenario.workflow_stage}</td><td className={TABLE_CELL_CLASS}>{scenario.report_type}</td>
          <td className={`${TABLE_CELL_CLASS} min-w-[260px]`}><div className="font-semibold text-[var(--navy)]">{scenario.test_scenario}</div><div className="text-xs text-muted-foreground mt-1 line-clamp-1">{scenario.why_it_matters}</div></td>
          <td className={TABLE_CELL_CLASS}>{scenario.complexity}</td><td className={TABLE_CELL_CLASS}>{scenario.priority}</td><td className={TABLE_CELL_CLASS}>{scenario.execution_count} test run(s)</td>
           <td className={TABLE_ACTION_CELL_CLASS}>{scenario.archived
             ? canManage && <Button size="sm" variant="outline" onClick={() => restore(scenario)}><ArchiveRestore size={14} /> Restore</Button>
             : canExecute && <Button size="sm" variant="outline" onClick={(e) => { e.stopPropagation(); setExecute(createBassettTestRunDraft({ scenario_id: scenario.id }, config?.application_timezone)); }}>Run Bassett Test</Button>}</td>
        </tr>)}{!isLoading && !shown.length && <tr><td colSpan="8" className={TABLE_EMPTY_CELL_CLASS}>No Test Bank scenarios match these filters.</td></tr>}</tbody>
      </table></div>
    </Section>

    {selected && <ScenarioDetail id={selected} canManage={canManage} canExecute={canExecute} close={() => setSelected(null)} edit={(scenario) => { scenarioBaseline.current = scenario; setSelected(null); setConflict(null); setFormErrors({}); setScenarioError(""); setForm(scenario); }} run={(scenario) => { setSelected(null); setExecute(createBassettTestRunDraft({ scenario_id: scenario.id }, config?.application_timezone)); }} archive={setConfirmingArchive} restore={restore} />}
    <ConfirmActionDialog
      open={!!confirmingArchive}
      onOpenChange={(open) => !open && setConfirmingArchive(null)}
      title={`Archive ${confirmingArchive?.stable_id || "scenario"}?`}
      description="The scenario will leave active Test Bank lists. Existing test runs, definition snapshots, attachments, and execution history remain available."
      confirmLabel="Archive scenario"
      onConfirm={() => archive(confirmingArchive)}
    />
    {form && <FormModal open onOpenChange={(open) => !open && (setConflict(null), setFormErrors({}), setScenarioError(""), setForm(null))} title={form.id ? `Edit ${form.stable_id}` : "Add Test Bank scenario"} onSubmit={saveScenario} submitLabel={savingScenario || scenarioSubmitInFlight.current ? "Saving…" : "Save"} submitDisabled={savingScenario || scenarioSubmitInFlight.current} dirty={scenarioDirty} errors={formErrors} onFocusFirstError={focusFormError} wide>
      {conflict && <div role="alert" className="col-span-2 rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-800">
        <p className="font-semibold">Someone else saved this scenario first. Your entries are still open for review.</p>
        <div className="mt-2 flex gap-2">
          <Button type="button" size="sm" variant="outline" onClick={() => { scenarioBaseline.current = conflict; setForm(conflict); setConflict(null); }}>Load latest values</Button>
          <Button type="button" size="sm" onClick={() => { setForm((draft) => ({ ...draft, expected_revision: conflict.revision, expected_updated_at: conflict.updated_at })); setConflict(null); }}>Keep my entries and reapply</Button>
        </div>
      </div>}
      {scenarioError && <p role="alert" className="rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-800">{scenarioError}</p>}
      {form.id && <div className="text-sm rounded-md bg-[var(--paper)] px-3 py-2"><b>Stable ID:</b> {form.stable_id} <span className="text-muted-foreground">Generated from the workflow stage prefix.</span></div>}
      <fieldset className="rounded-xl border p-4">
        <legend className="px-2 text-xs font-bold uppercase tracking-wide text-muted-foreground">Required scenario definition</legend>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <Field label="Workflow stage" required error={formErrors.workflow_stage}><select required data-testid="field-workflow_stage" className="h-9 w-full rounded-md border bg-background px-3 text-sm" value={form.workflow_stage} onChange={(e) => setScenarioField("workflow_stage", e.target.value)}><option value="">Select workflow stage</option>{stages.map((x) => <option key={x}>{x}</option>)}</select></Field>
          <Field label="Report type" required error={formErrors.report_type}><Input data-testid="field-report_type" value={form.report_type} onChange={(e) => setScenarioField("report_type", e.target.value)} placeholder="Property, zoning, feasibility…" /></Field>
          <Field label="Complexity" required error={formErrors.complexity}><select data-testid="field-complexity" className="h-9 w-full rounded-md border bg-background px-3 text-sm" value={form.complexity} onChange={(e) => setScenarioField("complexity", e.target.value)}>{["Low", "Moderate", "Medium", "High", "Very High"].map((x) => <option key={x}>{x}</option>)}</select></Field>
          <div className="sm:col-span-2"><Field label="Test scenario" required error={formErrors.test_scenario}><Textarea data-testid="field-test_scenario" rows={3} value={form.test_scenario} onChange={(e) => setScenarioField("test_scenario", e.target.value)} /></Field></div>
          <div className="sm:col-span-2"><Field label="Why it matters" required error={formErrors.why_it_matters}><Textarea data-testid="field-why_it_matters" rows={2} value={form.why_it_matters} onChange={(e) => setScenarioField("why_it_matters", e.target.value)} /></Field></div>
          <div className="sm:col-span-2"><Field label="What Bassett should do" required error={formErrors.what_bassett_should_do}><Textarea data-testid="field-what_bassett_should_do" rows={3} value={form.what_bassett_should_do} onChange={(e) => setScenarioField("what_bassett_should_do", e.target.value)} /></Field></div>
          <div className="sm:col-span-2"><Field label="Success criteria" required error={formErrors.success_criteria}><Textarea data-testid="field-success_criteria" rows={3} value={form.success_criteria} onChange={(e) => setScenarioField("success_criteria", e.target.value)} /></Field></div>
        </div>
      </fieldset>
      <fieldset className="rounded-xl border p-4">
        <legend className="px-2 text-xs font-bold uppercase tracking-wide text-muted-foreground">Outcome and prioritization</legend>
        <Field label="Priority"><select className="h-9 w-full rounded-md border bg-background px-3 text-sm" value={form.priority} onChange={(e) => setScenarioField("priority", e.target.value)}>{["P0 - Immediate", "P1 - High", "P2 - Medium", "Critical", "High", "Medium", "Low"].map((x) => <option key={x}>{x}</option>)}</select></Field>
      </fieldset>
      <details className="rounded-xl border p-4">
        <summary className="cursor-pointer font-semibold text-sm text-[var(--navy)]">Optional links</summary>
        <div className="mt-4 grid grid-cols-1 sm:grid-cols-2 gap-4">
          <Field label="Bassett version"><select className="h-9 w-full rounded-md border bg-background px-3 text-sm" value={form.version_id} onChange={(e) => setScenarioField("version_id", e.target.value)}><option value="">Any version</option>{versions.map((v) => <option key={v.id} value={v.id}>{v.name}</option>)}</select></Field>
          <Field label="Project"><select className="h-9 w-full rounded-md border bg-background px-3 text-sm" value={form.project_id} onChange={(e) => setScenarioField("project_id", e.target.value)}><option value="">Not linked</option>{projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</select></Field>
          <Field label="General test case"><select className="h-9 w-full rounded-md border bg-background px-3 text-sm" value={form.testcase_id} onChange={(e) => setScenarioField("testcase_id", e.target.value)}><option value="">Not linked</option>{testcases.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}</select></Field>
        </div>
      </details>
    </FormModal>}
    {execute && <BassettTestRunForm form={execute} setForm={setExecute} scenarios={scenarios} versions={versions} projects={projects} onSubmit={recordExecution} onCancel={() => setExecute(null)} submitting={savingRun} />}
    {showImport && <FormModal open onOpenChange={(open) => !open && setShowImport(false)} title="Review spreadsheet reference scenarios" onSubmit={preview ? commitImport : previewImport} submitLabel={importing ? "Importing…" : preview ? "Confirm import accepted rows" : "Preview rows"} wide>
      <p className="text-sm text-muted-foreground">Upload the Research/Analysis export as CSV. The preview validates stable IDs before any write. Re-importing the same IDs updates in place; startup never seeds them.</p>
      <Input aria-label="Choose Test Bank CSV" type="file" accept=".csv" onChange={loadCsv} />
      {preview ? <CsvReview preview={preview} /> : <div className="rounded-lg bg-[var(--paper)] p-3 text-sm">{importRows.length ? `${importFileName}: ${importRows.length} row(s) loaded and ready for preview.` : "Required columns: stable_id, workflow_stage, report_type, test_scenario, complexity, why_it_matters, what_bassett_should_do, success_criteria."}</div>}
    </FormModal>}
    {showWorkflowManager && <FormModal open onOpenChange={(open) => !open && setShowWorkflowManager(false)} title="Workflow stages & ID prefixes" onSubmit={saveStage} submitLabel={stageDraft.id ? "Save stage" : "Create stage"}>
      <p className="text-sm text-muted-foreground">Stages and prefixes are managed by the Test Bank service. Stable IDs are assigned automatically when a scenario is created.</p>
      {stageConflict && <div role="alert" className="rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-800"><p className="font-semibold">Someone else saved this workflow stage first. Your entries are still open for review.</p><div className="mt-2 flex gap-2"><Button size="sm" variant="outline" onClick={() => { setStageDraft(stageConflict); setStageConflict(null); }}>Load latest values</Button><Button size="sm" onClick={() => { setStageDraft((draft) => ({ ...draft, expected_revision: stageConflict.revision, expected_updated_at: stageConflict.updated_at })); setStageConflict(null); }}>Keep my entries and reapply</Button></div></div>}
      <div className="grid grid-cols-2 gap-2 rounded-md border p-3">
        <Input aria-label="Workflow stage name" placeholder="Stage name" value={stageDraft.name} onChange={(e) => setStageDraft({ ...stageDraft, name: e.target.value })} />
        <Input aria-label="Workflow stage code" disabled={!!stageDraft.id} placeholder="Code (e.g. R)" value={stageDraft.code} onChange={(e) => setStageDraft({ ...stageDraft, code: e.target.value.toUpperCase() })} />
        <Input aria-label="Workflow stage position" type="number" placeholder="Position" value={stageDraft.position} onChange={(e) => setStageDraft({ ...stageDraft, position: e.target.value })} />
        <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={stageDraft.active} onChange={(e) => setStageDraft({ ...stageDraft, active: e.target.checked })} /> Active</label>
      </div>
      <div className="space-y-2">{workflowStages.length ? workflowStages.map((stageDef) => {
        const name = typeof stageDef === "string" ? stageDef : stageDef.name || stageDef.workflow_stage;
        const prefix = typeof stageDef === "string" ? "" : stageDef.prefix || stageDef.id_prefix;
        return <button type="button" key={name} onClick={() => typeof stageDef !== "string" && (setStageConflict(null), setStageDraft({ ...stageDef, position: stageDef.position ?? "", active: stageDef.active !== false }))} className="w-full flex justify-between rounded-md border px-3 py-2 text-sm text-left hover:bg-[var(--paper)]"><span className="font-medium">{name}</span><span className="text-muted-foreground">{prefix ? `Prefix: ${prefix}` : "Prefix assigned by service"} · Edit</span></button>;
      }) : <p className="text-sm text-muted-foreground">No workflow stages are configured.</p>}</div>
    </FormModal>}
  </div>;
}
function CsvReview({ preview }) {
  return <div className={`rounded-lg border p-4 text-sm ${preview.invalid ? "border-red-300 bg-red-50" : "border-green-300 bg-green-50"}`}>
    <div className="font-semibold">{preview.total} rows reviewed · {preview.valid} accepted · {preview.invalid} rejected · {preview.updates} existing IDs</div>
    {preview.invalid > 0 && <div className="mt-2 text-red-700">Fix the rejected spreadsheet rows and upload again before importing.</div>}
    <div className="mt-3 max-h-40 overflow-auto space-y-1" aria-label="CSV row review">{(preview.rows || []).map((row) => <div key={row.row} className={row.valid ? "text-green-800" : "text-red-800"}>Row {row.row}: {row.valid ? "Accepted" : `Rejected — ${(row.errors || []).join("; ")}`}</div>)}</div>
  </div>;
}
function importError(error, fallback) {
  if (error?.response?.status === 401) return "Your session has expired. Sign in again, then retry.";
  if (error?.response?.status === 403) return "You do not have permission for this action.";
  if (error?.response?.status === 409) return "The import conflicts with newer data. Review and retry.";
  return formatApiErrorDetail(error?.response?.data?.detail) || fallback;
}

export function ScenarioDetail({ id, canManage, canExecute, close, edit, run, archive, restore }) {
  const qc = useQueryClient();
  const { data: scenario, isLoading } = useQuery({ queryKey: ["bassett-scenario", id], queryFn: async () => (await api.get(`/bassett/scenarios/${id}`)).data });
  const drawerRef = useFocusTrap(true, close);
  if (isLoading || !scenario) return <div className="fixed inset-0 z-40 bg-black/20 flex justify-end" role="presentation"><div ref={drawerRef} tabIndex="-1" role="dialog" aria-modal="true" aria-label="Scenario details" className="bg-card w-full max-w-2xl p-6">Loading scenario…</div></div>;
  const createFinding = async (execution) => {
    try { const { data } = await api.post(`/bassett/executions/${execution.id}/create-finding`, {}); toast.success(data.created ? "Finding created from this test run" : "Existing finding opened"); qc.invalidateQueries(); }
    catch (error) { toast.error(formatApiErrorDetail(error.response?.data?.detail)); }
  };
  const sendForRetest = async (execution) => {
    if (!execution.issue_id) return toast.error("Link this test run to a finding before sending it for retest.");
    try { await api.post(`/bassett/issues/${execution.issue_id}/send-for-retest`, {}); toast.success("Test run sent for retest"); qc.invalidateQueries(); }
    catch (error) { toast.error(formatApiErrorDetail(error.response?.data?.detail)); }
  };
  const expand = async (execution) => {
    if (!execution.issue_id) return toast.error("Link this test run to a finding before expanding it.");
    try {
      const { data } = await api.post(`/bassett/issues/${execution.issue_id}/expand`);
      window.location.assign(`/testcases?edit=${encodeURIComponent(data.testcase_id)}&mode=comparison&from_bassett=${encodeURIComponent(execution.issue_id)}`);
    }
    catch (error) { toast.error(formatApiErrorDetail(error.response?.data?.detail)); }
  };
  return <div className="fixed inset-0 z-40 bg-black/20 flex justify-end" onClick={(event) => event.target === event.currentTarget && close()} role="presentation"><aside ref={drawerRef} tabIndex="-1" role="dialog" aria-modal="true" aria-labelledby="bassett-scenario-detail-title" className="bg-card h-full w-full max-w-2xl overflow-y-auto p-6 shadow-xl">
    <div className="flex justify-between gap-4 mb-6"><div><div className="font-bold text-[var(--orange)]">{scenario.stable_id}</div><h2 id="bassett-scenario-detail-title" className="text-xl font-bold font-display text-[var(--navy)]">{scenario.test_scenario}</h2><div className="text-xs text-muted-foreground mt-2">{scenario.workflow_stage} · {scenario.report_type} · {scenario.complexity} complexity</div></div><Button type="button" variant="ghost" onClick={close} aria-label="Close scenario details">Close</Button></div>
    <div className="space-y-5"><Detail label="Why it matters" value={scenario.why_it_matters} /><Detail label="What Bassett should do" value={scenario.what_bassett_should_do} /><Detail label="Success criteria" value={scenario.success_criteria} />
      <Attachments entityType="bassett_scenario" entityId={scenario.id} canWrite={canExecute && !scenario.archived} />
      <div className="rounded-xl border p-4"><h3 className="font-semibold text-[var(--navy)] mb-3">Canonical Bassett Test Runs ({scenario.issues?.length || 0})</h3>{scenario.issues?.length ? scenario.issues.map((issue) => <div key={issue.id} className="border-t first:border-0 py-3 text-sm flex items-start justify-between gap-3"><div><ResultPill value={issue.result || "Not Evaluated"} /><div className="font-medium mt-1">{issue.title || issue.question_asked}</div><div className="text-xs text-muted-foreground mt-1">Test Date: {formatTestDate(issue.test_date)} · {issue.status}</div></div><Link to={`/bassett/issues?open=${encodeURIComponent(issue.id)}`} className="inline-flex h-8 items-center justify-center rounded-md border border-input px-3 text-xs font-medium shadow-sm hover:bg-accent hover:text-accent-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring">Open Run</Link></div>) : <p className="text-sm text-muted-foreground">No canonical test runs linked.</p>}</div>
      {!!scenario.executions?.length && <div className="rounded-xl border p-4"><h3 className="font-semibold text-[var(--navy)] mb-3">Legacy Test Runs ({scenario.executions.length})</h3>{scenario.executions.map((execution) => <div key={execution.id} className="border-t first:border-0 py-3 flex justify-between gap-3 text-sm"><div><ResultPill value={execution.result} /><div className="text-xs text-muted-foreground mt-1">Tested By: {execution.executed_by} · Test Date: {new Date(execution.executed_at).toLocaleString()} · {execution.bassett_version || "version not specified"}</div>{["Partial", "Fail", "Blocked"].includes(execution.result) && <div className="flex gap-2 mt-2">{canExecute && <Button size="sm" variant="outline" onClick={() => createFinding(execution)}>Create Finding</Button>}{canExecute && <Button size="sm" variant="outline" onClick={() => sendForRetest(execution)}>Send for Retest</Button>}{canExecute && <Button size="sm" variant="outline" onClick={() => expand(execution)}>Expand to Full Model Comparison</Button>}</div>}</div><span className="font-semibold">{execution.score != null ? `${execution.score}/100` : ""}</span></div>)}</div>}
    </div>
    <div className="flex flex-wrap gap-2 mt-6">{canExecute && !scenario.archived && <Button onClick={() => run(scenario)} className="bg-[var(--orange)]">Run Bassett Test</Button>}{canManage && !scenario.archived && <Button variant="outline" onClick={() => edit(scenario)}>Edit definition</Button>}{canManage && !scenario.archived && <Button variant="outline" onClick={() => archive(scenario)}><Archive /> Archive</Button>}{canManage && scenario.archived && <Button variant="outline" onClick={() => restore(scenario)}><ArchiveRestore /> Restore scenario</Button>}</div>
  </aside></div>;
}
function Detail({ label, value }) { return <div><div className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground mb-1">{label}</div><div className="text-sm whitespace-pre-wrap">{value}</div></div>; }