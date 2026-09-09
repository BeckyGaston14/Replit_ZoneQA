import { useEffect, useMemo, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api, formatApiErrorDetail, staleUpdateMessage, withExpectedVersion } from "../lib/api";
import { useAuth } from "../lib/auth";
import { PageHeader, Section, StatCard, MethodologyDisclosure, CritBadge } from "../components/shared";
import { Attachments } from "../components/Attachments";
import { CommentsThread } from "../components/CommentsThread";
import { AssigneePicker } from "../components/AssigneePicker";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import { FormModal, Field, ListSelect } from "../components/forms";
import { Textarea } from "../components/ui/textarea";
import { BassettTestRunForm, ScenarioDefinition, ScenarioSelector, createBassettTestRunDraft } from "../components/BassettTestRunForm";
import { AlertTriangle, Archive, ArchiveRestore, CheckCircle2, Download, ExternalLink, Flag, Loader2, Pencil, Plus, RefreshCw, Search, ShieldAlert, Upload, X } from "lucide-react";
import { toast } from "sonner";
import { parseCsv } from "../lib/csv";
import { SortableTableHeader } from "../components/SortableTableHeader";
import { TableSortControls } from "../components/TableSortControls";
import { nextSort, sortTableRows, usePersistentTableSort } from "../lib/tableSorting";
import { formatTestDate } from "../lib/testDates";
import { useFocusTrap } from "../lib/useFocusTrap";
import { FINDING_STATUSES, StatusBadge } from "../lib/statusMaps";
import { normalizeEvaluationResult } from "../lib/evaluationResults";
import { ConfirmActionDialog } from "../components/ConfirmActionDialog";
import { loadBassettTestRunForEdit } from "../lib/bassettEditLoaders";
import {
  TABLE_ACTION_CELL_CLASS, TABLE_CELL_CLASS, TABLE_CLASS, TABLE_EMPTY_CELL_CLASS,
  TABLE_FRAME_CLASS, TABLE_HEAD_CLASS,
} from "../lib/tableStyles";
const testStatuses = ["New", "Triaged", "In Progress", "Blocked", "Resolved", "Closed"];
const DEFAULT_RUN_SORT = { key: "test_date", direction: "desc" };

export async function persistBassettTestRun(form, apiClient = api) {
  const files = (form.attachments || []).filter((file) => typeof File === "undefined" || file instanceof File);
  let issueId = form.id;
  let createdData = null;
  if (form.id) {
    const body = { ...form };
    delete body.attachments;
    await apiClient.put(`/bassett/issues/${form.id}`, withExpectedVersion(form, body));
    if (form.create_finding && !form.finding_id) {
      await apiClient.post(`/bassett/issues/${form.id}/convert-to-finding`, {
        title: form.finding?.title,
        description: form.finding?.description,
        turn_id: form.finding_turn_id || undefined,
      });
    }
  } else {
    const body = { ...form };
    delete body.attachments;
    const payload = new FormData();
    payload.append("payload", JSON.stringify(body));
    for (const file of files) payload.append("files", file);
    const { data } = await apiClient.post("/bassett/issues/workflow", payload);
    createdData = data;
    issueId = data.issue?.id || data.id;
  }
  let uploadFailures = 0;
  for (const file of form.id ? files : []) {
    const upload = new FormData();
    upload.append("entity_type", "bassett_issue");
    upload.append("entity_id", issueId);
    upload.append("file", file);
    try {
      await apiClient.post("/attachments/upload", upload, { timeout: 15000 });
    } catch {
      uploadFailures += 1;
    }
  }
  return { issueId, uploadFailures, createdData };
}

function Pill({ children, tone = "slate" }) {
  const colors = { slate: "#64748b", orange: "#f97316", red: "#dc2626", green: "#16a34a", blue: "#2563eb" };
  return <span className="inline-flex rounded-full px-2 py-0.5 text-[11px] font-semibold text-white" style={{ background: colors[tone] }}>{children}</span>;
}

function bassettRunName(issue) {
  return issue.title || issue.question_asked || issue.test_id || "test run";
}

function isArchivedRun(issue) {
  return Boolean(issue.archived || issue.status === "Archived");
}

function isReadOnlyRun(issue) {
  return Boolean(issue.read_only || issue.readOnly || issue.editable === false);
}

export function BassettRunActions({ issue, canWrite, canManage, onEdit, onArchive, onRestore, editing = false }) {
  const name = bassettRunName(issue);
  const archived = isArchivedRun(issue);
  const readOnly = isReadOnlyRun(issue);
  const canEdit = canWrite && !archived && !readOnly;
  const canChangeLifecycle = canManage;
  if (!canEdit && !canChangeLifecycle) return null;

  const edit = (event) => {
    event?.stopPropagation();
    if (!editing) onEdit(issue);
  };
  const lifecycle = (event) => {
    event?.stopPropagation();
    if (archived) onRestore(issue);
    else onArchive(issue);
  };
  const editControl = canEdit && (
    <Button type="button" variant="ghost" size="icon" className="h-7 w-7" title={`Edit ${name}`} aria-label={`Edit ${name}`} disabled={editing} onClick={edit}>
      {editing ? <Loader2 size={14} className="animate-spin" aria-hidden="true" /> : <Pencil size={14} aria-hidden="true" />}
    </Button>
  );
  const lifecycleControl = canChangeLifecycle && (
    <Button type="button" variant="ghost" size="icon" className="h-7 w-7" title={`${archived ? "Restore" : "Archive"} ${name}`} aria-label={`${archived ? "Restore" : "Archive"} ${name}`} onClick={lifecycle}>
      {archived ? <ArchiveRestore size={14} aria-hidden="true" /> : <Archive size={14} aria-hidden="true" />}
    </Button>
  );

  return <div className="flex items-center justify-end gap-1" onClick={(event) => event.stopPropagation()}>{editControl}{lifecycleControl}</div>;
}

export default function BassettIssues() {
  const [searchParams, setSearchParams] = useSearchParams();
  const qc = useQueryClient();
  const { user } = useAuth();
  const [filters, setFilters] = useState({ status: "all", severity: "all", search: "", dateFrom: "", dateTo: "" });
  const [form, setForm] = useState(null);
  const [conflict, setConflict] = useState(null);
  const [saving, setSaving] = useState(false);
  const [loadingEditId, setLoadingEditId] = useState(null);
  const [confirmingArchive, setConfirmingArchive] = useState(null);
  const [showArchived, setShowArchived] = useState(false);
  const [selected, setSelected] = useState(null);
  const [showImport, setShowImport] = useState(false);
  const [importRows, setImportRows] = useState([]);
  const [importFileName, setImportFileName] = useState("");
  const [importPreview, setImportPreview] = useState(null);
  const [importing, setImporting] = useState(false);
  const showingFindings = searchParams.get("view") === "findings";
  useEffect(() => {
    const requested = searchParams.get("open");
    if (requested) {
      setSelected(requested);
      const next = new URLSearchParams(searchParams);
      next.delete("open");
      setSearchParams(next, { replace: true });
    }
  }, [searchParams, setSearchParams]);
  const { data: issues = [], isLoading } = useQuery({
    queryKey: ["bassett-test-runs", showingFindings, showArchived, filters.status, filters.severity, filters.dateFrom, filters.dateTo],
    queryFn: async () => (await api.get(showingFindings ? "/bassett/findings" : "/bassett/issues", { params: { include_archived: !showingFindings, status: filters.status, severity: filters.severity, test_date_from: filters.dateFrom || undefined, test_date_to: filters.dateTo || undefined } })).data,
  });
  const { data: metrics } = useQuery({ queryKey: ["bassett-metrics"], queryFn: async () => (await api.get("/bassett/metrics")).data });
  const { data: scenarios = [] } = useQuery({ queryKey: ["bassett-scenarios"], queryFn: async () => (await api.get("/bassett/test-bank")).data });
  const { data: generalSubtypes = [] } = useQuery({ queryKey: ["bassett-general-subtypes"], queryFn: async () => (await api.get("/bassett/general-subtypes")).data, staleTime: 30 * 60_000 });
  const { data: projects = [] } = useQuery({ queryKey: ["projects"], queryFn: async () => (await api.get("/projects")).data });
  const { data: municipalities = [] } = useQuery({ queryKey: ["municipalities"], queryFn: async () => (await api.get("/municipalities")).data });
  const { data: properties = [] } = useQuery({ queryKey: ["properties"], queryFn: async () => (await api.get("/properties")).data });
  const { data: users = [] } = useQuery({ queryKey: ["users"], queryFn: async () => (await api.get("/users")).data });
  const { data: versions = [] } = useQuery({ queryKey: ["versions"], queryFn: async () => (await api.get("/versions")).data });
  const { data: config } = useQuery({ queryKey: ["config"], queryFn: async () => (await api.get("/config")).data });
  const canManage = ["admin", "qa_manager"].includes(user?.role);
  const canWrite = ["admin", "qa_manager", "tester", "developer"].includes(user?.role);
  const scenarioMap = useMemo(() => Object.fromEntries(scenarios.map((scenario) => [scenario.id, scenario])), [scenarios]);
  const runColumns = useMemo(() => [
    { key: "test_id", label: "Test ID", type: "test-id" },
    { key: "title", label: "Test Run", type: "natural", getValue: (row) => row.title || row.question_asked },
    { key: "scenario", label: "Scenario", type: "test-id", getValue: (row) => scenarioMap[row.scenario_id]?.stable_id },
    { key: "severity", label: "Severity", type: "severity" },
    { key: "status", label: "Workflow status", type: "status", order: testStatuses },
    { key: "result", label: "Test result", type: "status", order: ["Pass", "Pass with Minor Issues", "Needs Improvement", "Fail", "Critical Fail", "Not Evaluated"] },
    { key: "bassett_version", label: "Bassett version", type: "text" },
    { key: "environment", label: "Environment", type: "text" },
    { key: "test_date", label: "Test Date", type: "date" },
  ], [scenarioMap]);
  const [sort, setSort] = usePersistentTableSort(showingFindings ? "bassett-findings" : "bassett-test-runs", runColumns, showingFindings ? { key: "severity", direction: "asc" } : DEFAULT_RUN_SORT);

  const shown = useMemo(() => sortTableRows(issues.filter((issue) => {
    if (!showingFindings && Boolean(issue.archived || issue.status === "Archived") !== showArchived) return false;
    const query = filters.search.trim().toLowerCase();
    return !query || [issue.title, issue.question_asked, issue.exact_bassett_answer, issue.issue_category, issue.scenario_id]
      .some((value) => String(value || "").toLowerCase().includes(query));
  }), runColumns, sort, [{ key: "test_date", direction: "desc" }, "title"]), [issues, filters.search, runColumns, sort, showArchived, showingFindings]);
  const defaultSort = showingFindings ? { key: "severity", direction: "asc" } : DEFAULT_RUN_SORT;

  const save = async () => {
    if (saving) return;
    setSaving(true);
    try {
      const { issueId, uploadFailures } = await persistBassettTestRun(form);
      if (!form.id) {
        setSelected(issueId);
        localStorage.removeItem("zoneqa:bassett-workflow-draft");
      }
      if (uploadFailures) {
        toast.warning(`Test run saved, but ${uploadFailures} attachment${uploadFailures === 1 ? "" : "s"} could not be uploaded. Open the saved run to retry.`);
      } else {
        toast.success(form.id ? "Test run updated" : "Test run recorded");
      }
      setConflict(null);
      setForm(null);
      qc.invalidateQueries({ queryKey: ["attachments", "bassett_issue", issueId] });
      qc.invalidateQueries({ queryKey: ["bassett-test-runs"] });
      qc.invalidateQueries({ queryKey: ["bassett-metrics"] });
      qc.invalidateQueries({ queryKey: ["bassett-scenarios"] });
    } catch (error) {
      if (error?.response?.status === 409 && form.id) {
        try { setConflict((await api.get(`/bassett/issues/${form.id}`)).data); } catch { setConflict({ revision: error?.response?.data?.detail?.current_revision }); }
        toast.error(staleUpdateMessage(error) || "This test run changed elsewhere. Review your entries before reapplying them.");
      } else toast.error(actionError(error, "Unable to save test run"));
    }
    finally { setSaving(false); }
  };
  const openEdit = async (issue) => {
    if (loadingEditId || !canWrite || isArchivedRun(issue) || isReadOnlyRun(issue)) return;
    setLoadingEditId(issue.id);
    try {
      const data = await loadBassettTestRunForEdit(issue);
      setSelected(null);
      setConflict(null);
      setForm(data);
    } catch (error) {
      toast.error(actionError(error, "Unable to open test run for editing"));
    } finally {
      setLoadingEditId(null);
    }
  };
  const archive = async (issue) => {
    try { await api.post(`/bassett/issues/${issue.id}/archive`); toast.success("Test run archived"); qc.invalidateQueries(); }
    catch (error) { toast.error(actionError(error, "Unable to archive test run")); }
    finally { setConfirmingArchive(null); }
  };
  const restore = async (issue) => {
    try { await api.post(`/bassett/issues/${issue.id}/restore`); toast.success("Test run restored"); setSelected(null); qc.invalidateQueries(); }
    catch (error) { toast.error(actionError(error, "Unable to restore test run")); }
  };
  const loadCsv = (event) => {
    const file = event.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      setImportRows(parseCsv(reader.result));
      setImportFileName(file.name);
      setImportPreview(null);
    };
    reader.readAsText(file);
  };
  const previewImport = async () => {
    try {
      const { data } = await api.post("/bassett/issues/csv/preview", { rows: importRows });
      setImportPreview(data);
      toast.success(`Preview ready: ${data.valid} accepted, ${data.invalid} rejected.`);
    } catch (error) { toast.error(actionError(error, "Unable to preview CSV")); }
  };
  const commitImport = async () => {
    if (!importPreview || importPreview.invalid) return;
    setImporting(true);
    try {
      const { data } = await api.post("/bassett/issues/csv/import", { rows: importRows });
      toast.success(`${data.imported} added, ${data.updated} updated`);
      setShowImport(false); setImportRows([]); setImportPreview(null); setImportFileName(""); qc.invalidateQueries();
    } catch (error) { toast.error(actionError(error, "Unable to import test runs")); }
    finally { setImporting(false); }
  };
  const exportCsv = async () => {
    try {
      const { data } = await api.get("/bassett/export/issues.csv", { responseType: "blob" });
      const link = document.createElement("a"); link.href = URL.createObjectURL(data); link.download = "bassett-issues.csv"; link.click(); URL.revokeObjectURL(link.href);
      toast.success("CSV export downloaded.");
    } catch (error) { toast.error(actionError(error, "Unable to export test runs")); }
  };

  return <div>
    <PageHeader title={showingFindings ? "Bassett Findings" : "Bassett Test Runs"} subtitle={showingFindings ? "Findings created from Bassett testing. General Findings and model-comparison findings remain separate." : "Record a Bassett test result, evidence, and follow-up. Passing test runs are not findings."}>
      {canManage && !showingFindings && <Button variant="outline" onClick={() => setShowImport(true)}><Upload size={15} /> Import CSV</Button>}
      {!showingFindings && <Button variant="outline" onClick={exportCsv}><Download size={15} /> Export</Button>}
      <Link to={showingFindings ? "/bassett/issues" : "/bassett/issues?view=findings"}><Button variant="outline">{showingFindings ? "Bassett Test Runs" : "Bassett Findings"}</Button></Link>
      {showingFindings && <Link to="/findings"><Button variant="outline">Model Comparison Findings</Button></Link>}
      {!showingFindings && <Button variant="outline" aria-pressed={showArchived} onClick={() => setShowArchived((value) => !value)}>{showArchived ? "Active test runs" : "Archived test runs"}</Button>}
      {canWrite && !showingFindings && <Button onClick={() => setForm(createBassettTestRunDraft({}, config?.application_timezone))} className="bg-[var(--orange)] hover:bg-[var(--orange-600)]"><Plus size={15} /> New Test Run</Button>}
    </PageHeader>
    <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-4 gap-3 mb-6">
       <StatCard label={showingFindings ? "Open Findings" : "Tests Needing Attention"} value={showingFindings ? (metrics?.findings?.open ?? 0) : (metrics?.test_runs?.attention ?? "—")} sub={showingFindings ? "excludes fixed and closed findings" : "Needs Improvement, Fail, Critical Fail, or Blocked"} icon={Flag} accent="#f97316" />
       <StatCard label={showingFindings ? "New Findings" : "Untriaged Test Runs"} value={showingFindings ? (metrics?.findings?.new ?? 0) : (metrics?.issues?.new ?? "—")} sub={showingFindings ? "newly recorded findings" : "Workflow status is New."} icon={AlertTriangle} accent="#2563eb" />
       <StatCard label={showingFindings ? "High severity findings" : "High severity"} value={showingFindings ? (metrics?.findings?.critical ?? 0) : (metrics?.issues?.critical ?? "—")} sub="high / critical severity" icon={ShieldAlert} accent="#dc2626" />
       <StatCard label={showingFindings ? "Total Findings" : "Scenario coverage"} value={showingFindings ? (metrics?.findings?.total ?? 0) : (metrics ? `${metrics.test_runs.test_bank_coverage.percent}%` : "—")} sub={showingFindings ? "linked to Bassett-only testing" : (metrics ? `${metrics.test_runs.test_bank_coverage.covered}/${metrics.test_runs.test_bank_coverage.total} active scenarios with a completed result` : "Drafts and Not Evaluated runs are excluded")} icon={CheckCircle2} accent="#16a34a" />
    </div>
    <Section title={showingFindings ? "Bassett findings" : "Bassett test runs"} action={<span className="text-xs text-muted-foreground">{shown.length} shown · archived records stay in history</span>}>
      <div className="flex flex-wrap gap-2 mb-4">
        <div className="relative flex-1 min-w-[220px]"><Search size={15} className="absolute left-3 top-2.5 text-muted-foreground" /><Input aria-label={showingFindings ? "Search Bassett findings" : "Search Bassett test runs"} className="pl-9" placeholder={showingFindings ? "Search finding, test run, category, scenario…" : "Search question, response, category, scenario…"} value={filters.search} onChange={(e) => setFilters({ ...filters, search: e.target.value })} /></div>
         <select aria-label="Filter by Workflow status" className="h-9 rounded-md border bg-background px-3 text-sm" value={filters.status} onChange={(e) => setFilters({ ...filters, status: e.target.value })}><option value="all">All workflow statuses</option>{testStatuses.map((x) => <option key={x}>{x}</option>)}</select>
         <select aria-label="Filter by severity" className="h-9 rounded-md border bg-background px-3 text-sm" value={filters.severity} onChange={(e) => setFilters({ ...filters, severity: e.target.value })}><option value="all">All severity</option>{["Critical", "High", "Medium", "Low"].map((x) => <option key={x}>{x}</option>)}</select>
        {!showingFindings && <><Input aria-label="Test date from" title="Test date from" type="date" className="w-auto" value={filters.dateFrom} onChange={(e) => setFilters({ ...filters, dateFrom: e.target.value })} /><Input aria-label="Test date to" title="Test date to" type="date" className="w-auto" value={filters.dateTo} onChange={(e) => setFilters({ ...filters, dateTo: e.target.value })} /></>}
      </div>
      <TableSortControls columns={runColumns} sort={sort} setSort={setSort} defaultSort={defaultSort} className="mb-3" />
       <div className={TABLE_FRAME_CLASS} role="region" aria-label={showingFindings ? "Bassett findings table" : "Bassett test runs table"} tabIndex="0" data-testid="bassett-runs-table-scroll">
          <table className={TABLE_CLASS}><thead className={TABLE_HEAD_CLASS}><tr>{runColumns.map((column) => <SortableTableHeader key={column.key} column={column} sort={sort} onSort={(key) => setSort((current) => nextSort(current, key))} />)}<th className="px-2.5 py-2 text-right text-[11px] uppercase tracking-wide text-muted-foreground">Actions</th></tr></thead>
             <tbody>{isLoading ? <tr><td colSpan="10" className="p-8 text-center text-muted-foreground"><span className="inline-flex items-center gap-2"><span className="h-4 w-4 animate-spin rounded-full border-2 border-current border-r-transparent" aria-hidden="true" />Loading {showingFindings ? "Bassett findings" : "Bassett test runs"}… this may take a few seconds.</span></td></tr> : shown.map((issue) => <tr key={issue.id} className="border-t hover:bg-[var(--paper)]">
             <td className="px-3 py-3 text-xs font-semibold text-[var(--navy)]">{issue.test_id || "—"}</td><td className={`${TABLE_CELL_CLASS} min-w-[270px]`}><button type="button" className="w-full text-left rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--orange)] focus-visible:ring-offset-2" onClick={() => setSelected(issue.id)} aria-label={`Open ${issue.title || issue.question_asked}`}><div className="font-semibold text-[var(--navy)]">{issue.title || issue.question_asked}</div><div className="text-xs text-muted-foreground line-clamp-1 mt-1">{issue.question_asked}</div></button></td>
            <td className="px-3 py-3 text-xs">{scenarioMap[issue.scenario_id]?.stable_id || "—"}</td>
            <td className="px-3 py-3"><Pill tone={issue.severity === "Critical" ? "red" : issue.severity === "High" ? "orange" : "slate"}>{issue.severity}</Pill></td>
             <td className="px-3 py-3 text-xs font-medium">{issue.status}</td><td className="px-3 py-3 text-xs"><StatusBadge value={issue.result || "Not Evaluated"} compact /></td><td className="px-3 py-3 text-xs">{issue.bassett_version || "Not specified"}</td><td className="px-3 py-3 text-xs">{issue.environment || "—"}</td><td className="px-3 py-3 text-xs"><time dateTime={issue.test_date || undefined}>{formatTestDate(issue.test_date)}</time></td>
             <td className={TABLE_ACTION_CELL_CLASS}><BassettRunActions issue={issue} canWrite={canWrite} canManage={canManage} editing={loadingEditId === issue.id} onEdit={openEdit} onArchive={setConfirmingArchive} onRestore={restore} /></td>
           </tr>)}{!isLoading && !shown.length && <tr><td colSpan="9" className={TABLE_EMPTY_CELL_CLASS}>{showingFindings ? "No Bassett findings match these filters." : "No Bassett test runs match these filters."}</td></tr>}</tbody>
            </table>
      </div>
    </Section>
     <MethodologyDisclosure title={showingFindings ? "How Bassett Finding metrics are calculated" : "How Bassett Test Run metrics are calculated"} testid="bassett-test-runs-methodology">
       {showingFindings ? (
         <p>Finding counts reflect Bassett-only findings in the current visibility scope; fixed and closed findings are excluded from the open count.</p>
       ) : (
         <>
            <p>Tests Needing Attention includes Test result values of Needs Improvement, Fail, Critical Fail, or Blocked.</p>
            <p>Scenario coverage is the percentage of active Test Bank scenarios with a completed Test result. Draft and Not Evaluated runs are excluded.</p>
         </>
       )}
       <p>Archived records remain available in history but are excluded from active summary populations. The visible test-date filters define the displayed date range.</p>
     </MethodologyDisclosure>

     {selected && (showingFindings
       ? <BassettFindingDetail id={selected} onClose={() => setSelected(null)} canWrite={canWrite} refresh={() => qc.invalidateQueries()} />
        : <IssueDetail id={selected} onClose={() => setSelected(null)} onEdit={openEdit} onRestore={restore} canWrite={canWrite} canManage={canManage} refresh={() => qc.invalidateQueries()} />)}
    {form && <BassettTestRunForm form={form} setForm={setForm} scenarios={scenarios} generalSubtypes={generalSubtypes} versions={versions} projects={projects} municipalities={municipalities} properties={properties} users={users} config={config} onSubmit={save} onCancel={() => { setConflict(null); setForm(null); }} submitting={saving} conflictNotice={conflict && <div role="alert" className="col-span-2 rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-800">
      <p className="font-semibold">Someone else saved this test run first. Your entries are still open for review.</p>
      <div className="mt-2 flex gap-2">
        <Button type="button" size="sm" variant="outline" onClick={() => { setForm(conflict); setConflict(null); }}>Load latest values</Button>
        <Button type="button" size="sm" onClick={() => { setForm((draft) => ({ ...draft, expected_revision: conflict.revision, expected_updated_at: conflict.updated_at })); setConflict(null); }}>Keep my entries and reapply</Button>
      </div>
    </div>} />}
    {showImport && <FormModal open onOpenChange={(open) => !open && setShowImport(false)} title="Review Bassett test run CSV" onSubmit={importPreview ? commitImport : previewImport} submitDisabled={importing || !importRows.length || Boolean(importPreview?.invalid)} submitLabel={importing ? "Importing…" : importPreview ? "Confirm import accepted rows" : "Preview rows"}>
      <p className="text-sm text-muted-foreground">Administrator-controlled import. Existing IDs are updated; no rows are written until validation succeeds.</p>
      <Input aria-label="Choose Bassett test run CSV" type="file" accept=".csv" onChange={loadCsv} />
      {!importPreview ? <div className="rounded-lg bg-[var(--paper)] p-3 text-sm">{importRows.length ? `${importFileName}: ${importRows.length} row(s) loaded and ready for review.` : "Expected columns include question_asked, exact_bassett_answer, and verified_correct_answer."}</div> : <ImportReview preview={importPreview} />}
    </FormModal>}
    <ConfirmActionDialog
      open={!!confirmingArchive}
      onOpenChange={(open) => !open && setConfirmingArchive(null)}
      title={`Archive “${confirmingArchive?.title || confirmingArchive?.question_asked || "test run"}”?`}
      description="The test run will leave active lists. Its immutable history, attachments, and links will remain available."
      confirmLabel="Archive test run"
      onConfirm={() => archive(confirmingArchive)}
    />
  </div>;
}

function ImportReview({ preview }) {
  return <div className={`rounded-lg border p-3 text-sm ${preview.invalid ? "border-red-300 bg-red-50" : "border-green-300 bg-green-50"}`}>
    <div className="font-semibold">{preview.total} rows reviewed · {preview.valid} accepted · {preview.invalid} rejected · {preview.updates} updates</div>
    {preview.invalid > 0 && <p className="mt-1 text-red-800">Correct rejected rows and upload again; imports are blocked while errors remain.</p>}
    <div className="mt-3 max-h-40 overflow-auto space-y-1" aria-label="CSV row review">{(preview.rows || []).map((row) => <div key={row.row} className={row.valid ? "text-green-800" : "text-red-800"}>Row {row.row}: {row.valid ? "Accepted" : `Rejected — ${(row.errors || []).join("; ")}`}</div>)}</div>
  </div>;
}
function actionError(error, fallback) {
  if (error?.response?.status === 401) return "Your session has expired. Sign in again, then retry.";
  if (error?.response?.status === 403) return "You do not have permission for this action.";
  if (error?.response?.status === 409) return "This record changed elsewhere. Refresh and retry.";
  return formatApiErrorDetail(error?.response?.data?.detail) || fallback;
}

function BassettFindingDetail({ id, onClose, canWrite, refresh }) {
  const drawerRef = useFocusTrap(true, onClose);
  const [statusForm, setStatusForm] = useState(null);
  const [submitting, setSubmitting] = useState(false);
  const { data: finding, isLoading, isError } = useQuery({
    queryKey: ["bassett-finding", id],
    queryFn: async () => (await api.get(`/findings/${id}`)).data,
  });
  const { data: config } = useQuery({ queryKey: ["config"], queryFn: async () => (await api.get("/config")).data });
  const sourceRun = finding?.bassett_issue_id;

  const saveStatus = async () => {
    if (submitting) return;
    setSubmitting(true);
    try {
      await api.post(`/findings/${id}/status`, statusForm);
      toast.success("Status updated");
      setStatusForm(null);
      refresh();
    } catch (error) { toast.error(actionError(error, "Unable to update status")); }
    finally { setSubmitting(false); }
  };
  const startRetest = async () => {
    if (!sourceRun || submitting) return;
    setSubmitting(true);
    try {
      await api.post(`/bassett/issues/${sourceRun}/send-for-retest`, {});
      toast.success("Bassett test run sent for retest");
      refresh();
    } catch (error) { toast.error(actionError(error, "Unable to start retest")); }
    finally { setSubmitting(false); }
  };

  return <div className="fixed inset-0 z-40 bg-black/20 flex justify-end" onClick={(event) => event.target === event.currentTarget && onClose()} role="presentation">
    <aside ref={drawerRef} tabIndex="-1" role="dialog" aria-modal="true" aria-labelledby="bassett-finding-detail-title" className="bg-card h-full w-full max-w-2xl overflow-y-auto p-6 shadow-xl">
      <div className="flex items-start justify-between gap-4 mb-6">
        <div className="min-w-0">
          <div className="text-xs uppercase tracking-wide text-muted-foreground">Bassett Finding Details</div>
          <h2 id="bassett-finding-detail-title" className="text-xl font-bold font-display text-[var(--navy)] mt-1 break-words">{finding?.title || "Finding"}</h2>
        </div>
        <Button type="button" variant="ghost" size="icon" className="shrink-0" onClick={onClose} aria-label="Close Bassett Finding Details"><X size={18} /></Button>
      </div>
      {isLoading && <div className="text-sm text-muted-foreground">Loading Bassett Finding Details…</div>}
      {isError && <div role="alert" className="rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-800">Unable to load this Bassett finding.</div>}
      {finding && <div className="space-y-5 text-sm">
        <div className="flex flex-wrap gap-2">{Number.isFinite(Number(finding.criticality)) ? <CritBadge value={finding.criticality} /> : <Pill tone={finding.severity === "Critical" ? "red" : "orange"}>{finding.severity || "Not rated"}</Pill>}<StatusBadge value={finding.developer_status || "New"} definitions={FINDING_STATUSES} /></div>
        <AssigneePicker entityType="findings" entityId={finding.id} assigneeId={finding.assignee_id} assigneeName={finding.assignee_name} canWrite={canWrite} onChanged={refresh} />
        <Info label="Description" value={finding.description || "—"} />
        <Info label="Expected behavior" value={finding.expected_behavior || "—"} />
        {finding.actual_behavior && <Info label="Actual Bassett behavior" value={finding.actual_behavior} />}
        {finding.bassett_turn_id && <Info label="Linked turn" value={finding.bassett_turn_id} />}
        <div className="rounded-xl border p-4">
          <div className="font-semibold text-[var(--navy)] mb-2">Relationships</div>
          {sourceRun
            ? <Link to={`/bassett/issues?open=${encodeURIComponent(sourceRun)}`} className="font-semibold text-[var(--orange)] hover:underline">Open source Bassett Test Run →</Link>
            : <span className="text-muted-foreground">No source Bassett Test Run is linked.</span>}
        </div>
        <div className="rounded-xl border p-4">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div><div className="font-semibold text-[var(--navy)]">Developer workflow</div><div className="text-xs text-muted-foreground mt-1">Retest: {finding.retest_status || "Pending"}</div></div>
            {canWrite && <div className="flex flex-wrap gap-2"><Button size="sm" variant="outline" onClick={() => setStatusForm({ id, status: finding.developer_status || "New", root_cause: finding.root_cause || "", resolution: finding.resolution || "", note: "" })}>Update Status</Button>{sourceRun && !["Fixed", "Closed", "Won't Fix", "Duplicate"].includes(finding.developer_status) && <Button size="sm" variant="outline" onClick={startRetest} disabled={submitting}><RefreshCw size={13} /> Start Retest</Button>}</div>}
          </div>
          {finding.root_cause && <div className="mt-3"><Info label="Root cause" value={finding.root_cause} /></div>}
          {finding.resolution && <div className="mt-3"><Info label="Resolution" value={finding.resolution} /></div>}
        </div>
        {(finding.status_history || []).length > 0 && <div className="rounded-xl border p-4"><div className="font-semibold text-[var(--navy)] mb-2">Status history</div><div className="space-y-1.5">{finding.status_history.map((item, index) => <div key={index} className="text-xs text-muted-foreground">{item.from || "—"} → <b className="text-[var(--navy)]">{item.to}</b> · {item.by || "Unknown"}{item.at ? ` · ${new Date(item.at).toLocaleDateString()}` : ""}{item.note ? ` · ${item.note}` : ""}</div>)}</div></div>}
        <div className="rounded-xl border p-4"><Attachments entityType="finding" entityId={finding.id} canWrite={canWrite} /></div>
        <div className="rounded-xl border p-4"><CommentsThread entityType="findings" entityId={finding.id} canWrite={canWrite} /></div>
      </div>}
    </aside>
    {statusForm && <FormModal open onOpenChange={() => setStatusForm(null)} title="Update Developer Status" onSubmit={saveStatus} submitLabel={submitting ? "Saving…" : "Save status"}>
      <Field label="Status"><ListSelect options={config?.finding_statuses || []} value={statusForm.status} onChange={(value) => setStatusForm({ ...statusForm, status: value })} /></Field>
      <Field label="Root Cause"><ListSelect options={config?.root_causes || []} value={statusForm.root_cause} onChange={(value) => setStatusForm({ ...statusForm, root_cause: value })} /></Field>
      <Field label="Resolution"><Textarea rows={3} value={statusForm.resolution} onChange={(event) => setStatusForm({ ...statusForm, resolution: event.target.value })} /></Field>
      <Field label="Note (added to history)"><Textarea rows={2} value={statusForm.note} onChange={(event) => setStatusForm({ ...statusForm, note: event.target.value })} /></Field>
    </FormModal>}
  </div>;
}

function IssueDetail({ id, onClose, onEdit, onRestore, canWrite, canManage, refresh }) {
  const drawerRef = useFocusTrap(true, onClose);
  const { data: issue, isLoading } = useQuery({ queryKey: ["bassett-issue", id], queryFn: async () => (await api.get(`/bassett/issues/${id}`)).data });
  const { data: generalSubtypes = [] } = useQuery({ queryKey: ["bassett-general-subtypes"], queryFn: async () => (await api.get("/bassett/general-subtypes")).data, staleTime: 30 * 60_000 });
  if (isLoading || !issue) return <div className="fixed inset-0 z-40 bg-black/20 flex justify-end" role="presentation"><div ref={drawerRef} tabIndex="-1" role="dialog" aria-modal="true" aria-label="Test Run Details" className="bg-card w-full max-w-xl p-6">Loading Test Run Details…</div></div>;
  const canonicalResult = normalizeEvaluationResult(issue.result);
  const needsFollowUp = ["Needs Improvement", "Fail", "Critical Fail"].includes(canonicalResult) || issue.status === "Blocked";
  const linkFinding = async () => {
    const findingId = window.prompt("Enter the existing general Finding ID to Link Test Run (no duplicate will be created):");
    if (!findingId) return;
    const turnId = issue.test_type === "Multi-turn"
      ? window.prompt("Optional: enter the turn ID to link this finding to. Leave blank for the overall conversation:", issue.finding_turn_id || "")
      : "";
    try { await api.post(`/bassett/issues/${id}/link-finding`, { finding_id: findingId, turn_id: turnId || undefined }); toast.success("Existing finding linked"); refresh(); }
    catch (error) { toast.error(formatApiErrorDetail(error.response?.data?.detail)); }
  };
  const convert = async () => {
    const turnId = issue.test_type === "Multi-turn"
      ? window.prompt("Optional: enter the turn ID to link this finding to. Leave blank for the overall conversation:", "")
      : "";
    try { await api.post(`/bassett/issues/${id}/convert-to-finding`, { turn_id: turnId || undefined }); toast.success("Finding created and linked to this test run"); refresh(); }
    catch (error) { toast.error(formatApiErrorDetail(error.response?.data?.detail)); }
  };
  const expand = async () => {
    try {
      const { data } = await api.post(`/bassett/issues/${id}/expand`);
      toast.success(data.created ? "Full AI comparison created" : "Existing comparison opened");
      window.location.assign(`/testcases?edit=${encodeURIComponent(data.testcase_id)}&mode=comparison&from_bassett=${encodeURIComponent(id)}`);
      } catch (error) {
        const detail = error.response?.data?.detail;
        toast.error(detail?.message || formatApiErrorDetail(detail));
      }
  };
   const triage = async () => {
     try {
       await api.post(`/bassett/issues/${id}/triage`, withExpectedVersion(issue, {}));
       toast.success("Test run marked as Triaged");
       refresh();
     } catch (error) { toast.error(formatApiErrorDetail(error.response?.data?.detail)); }
   };
   const sendForRetest = async () => {
    try { await api.post(`/bassett/issues/${id}/send-for-retest`, {}); toast.success("Test run sent for retest"); refresh(); }
    catch (error) { toast.error(formatApiErrorDetail(error.response?.data?.detail)); }
  };
   return <div className="fixed inset-0 z-40 bg-black/20 flex justify-end" onClick={(event) => event.target === event.currentTarget && onClose()} role="presentation"><aside ref={drawerRef} tabIndex="-1" role="dialog" aria-modal="true" aria-labelledby="bassett-issue-detail-title" className="bg-card h-full w-full max-w-2xl overflow-y-auto p-6 shadow-xl">
     <div className="flex items-start justify-between gap-4 mb-6"><div className="min-w-0"><div className="text-xs uppercase tracking-wide text-muted-foreground">Test Run Details</div><h2 id="bassett-issue-detail-title" className="text-xl font-bold font-display text-[var(--navy)] mt-1 break-words">{issue.title || issue.question_asked}</h2><div className="flex flex-wrap gap-3 mt-2 text-xs"><div><div className="font-semibold uppercase tracking-wide text-muted-foreground">Workflow status</div><Pill>{issue.status}</Pill></div><div><div className="font-semibold uppercase tracking-wide text-muted-foreground">Test result</div><Pill tone={canonicalResult === "Fail" || canonicalResult === "Critical Fail" ? "red" : "slate"}>{canonicalResult}</Pill></div><div><div className="font-semibold uppercase tracking-wide text-muted-foreground">Severity</div><Pill tone={issue.severity === "Critical" ? "red" : "orange"}>{issue.severity}</Pill></div></div></div><Button type="button" variant="ghost" className="shrink-0" onClick={onClose} aria-label="Close Test Run Details">Close</Button></div>
     <div className="space-y-5 text-sm"><Info label="Test type" value={issue.test_type || "Single Prompt"} />{issue.test_type === "Multi-turn" ? <div className="rounded-xl border p-4"><div className="font-semibold text-[var(--navy)] mb-3">Chronological conversation</div><div className="space-y-4">{(issue.turns || []).slice().sort((a, b) => Number(a.order || 0) - Number(b.order || 0)).map((turn, index) => <article key={turn.id} id={`bassett-turn-${turn.id}`} className={`rounded-lg border p-3 ${issue.finding_turn_id === turn.id ? "border-[var(--orange)] bg-orange-50/40" : ""}`}><div className="flex items-center justify-between gap-2"><h3 className="font-semibold text-[var(--navy)]">Turn {index + 1}</h3><span className="text-[11px] text-muted-foreground">ID: {turn.id}</span></div><Info label="Prompt" value={turn.prompt} /><div className="mt-3"><Info label="Bassett response" value={turn.response} /></div>{turn.citations?.length > 0 && <div className="mt-3"><Info label="Citations / sources" value={turn.citations.join("\n")} /></div>}{turn.evaluator_notes && <div className="mt-3"><Info label="Evaluator notes" value={turn.evaluator_notes} /></div>}{issue.finding_turn_id === turn.id && <div className="mt-2 text-xs font-semibold text-[var(--orange)]">Linked finding targets this turn</div>}</article>)}</div></div> : <><Info label="Question asked" value={issue.question_asked} /><Info label="Exact Bassett answer" value={issue.exact_bassett_answer} /></>}<Info label="Verified correct answer" value={issue.verified_correct_answer} /><Info label="Resolution / notes" value={issue.resolution || issue.notes || "No resolution recorded yet."} />
       {issue.general_subtype_ids?.length > 0 && <div className="rounded-xl border p-4"><div className="font-semibold text-[var(--navy)] mb-3">General test subtypes</div><div className="space-y-2">{generalSubtypes.filter((subtype) => issue.general_subtype_ids.includes(subtype.id)).map((subtype) => <div key={subtype.id} className="text-sm"><span className="font-semibold">{subtype.stable_id}</span> · {subtype.test_scenario}</div>)}</div></div>}
       <div className="rounded-xl border p-4"><div className="font-semibold text-[var(--navy)] mb-3">Relationships</div><div className="grid grid-cols-1 sm:grid-cols-2 gap-3 text-xs"><Info label="Test Bank scenario" value={issue.scenario?.stable_id || "Not linked"} /><Info label="Bassett Finding" value={issue.finding?.id ? <><Link to={`/bassett/issues?view=findings&open=${encodeURIComponent(issue.finding.id)}`} className="font-semibold text-[var(--orange)] hover:underline">Open Bassett Finding</Link>{issue.finding_turn_id ? <span className="block text-muted-foreground">Linked to turn {issue.turns?.findIndex((turn) => turn.id === issue.finding_turn_id) + 1}</span> : <span className="block text-muted-foreground">Linked to overall conversation</span>}</> : "Not linked"} /><Info label="Bassett version" value={issue.bassett_version || "Not specified"} /><Info label="Tested By" value={issue.reporter || "—"} /></div><div className="flex flex-wrap gap-2 mt-4">{canWrite && <Button size="sm" variant="outline" onClick={linkFinding}><ExternalLink size={14} /> Link Bassett Finding</Button>}{(issue.result === "Partial" || issue.result === "Fail" || issue.status === "Blocked") && canWrite && !issue.finding_id && <Button size="sm" variant="outline" onClick={convert}><Flag size={14} /> Create Bassett Finding</Button>}{(issue.result === "Partial" || issue.result === "Fail" || issue.status === "Blocked") && canWrite && issue.finding_id && <Button size="sm" variant="outline" onClick={sendForRetest}>Send for Retest</Button>}</div></div>
      {issue.definition_snapshot || issue.scenario_snapshot ? <div className="rounded-xl border p-4"><div className="font-semibold text-[var(--navy)] mb-3">Scenario definition snapshot</div><ScenarioDefinition scenario={issue.definition_snapshot || issue.scenario_snapshot} /></div> : <div className="rounded-xl border border-amber-300 bg-amber-50 p-4 text-sm text-amber-900">Legacy execution—definition snapshot unavailable.</div>}
      {(issue.result === "Partial" || issue.result === "Fail" || issue.status === "Blocked") && <div className="rounded-xl border p-4"><div className="font-semibold text-[var(--navy)] mb-3">Model Comparison follow-up</div>{issue.testcase_id ? <Link to={`/testcases/${issue.testcase_id}`} className="inline-flex h-8 items-center justify-center rounded-md border border-input px-3 text-xs font-medium shadow-sm hover:bg-accent hover:text-accent-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring">Open Model Comparison Test Case</Link> : canWrite ? <Button size="sm" onClick={expand}>Expand to Full Model Comparison</Button> : <span className="text-sm text-muted-foreground">No Model Comparison has been created. This Bassett Test Run remains unchanged.</span>}</div>}
      <Attachments entityType="bassett_issue" entityId={issue.id} canWrite={canWrite && !issue.archived && issue.status !== "Archived"} />
      <div className="rounded-xl border p-4"><div className="font-semibold text-[var(--navy)] mb-3">Immutable history</div><div className="space-y-3">{(issue.history || []).map((entry) => <div key={entry.id} className="border-l-2 border-[var(--orange)] pl-3"><div className="font-medium">{entry.action}</div><div className="text-xs text-muted-foreground">{entry.actor} · {new Date(entry.created_at).toLocaleString()}</div></div>)}</div></div>
    </div>
      <div className="mt-6 flex flex-wrap gap-2">{canWrite && !issue.archived && issue.status === "New" && <Button type="button" className="bg-[var(--orange)] hover:bg-[var(--orange-600)]" onClick={triage}>Mark as Triaged</Button>}{canWrite && !issue.archived && issue.status !== "Archived" && <Button type="button" className="bg-[var(--navy)]" onClick={() => onEdit(issue)}>Edit Test Run</Button>}</div>
     {canManage && (issue.archived || issue.status === "Archived") && <Button type="button" className="mt-6" variant="outline" onClick={() => onRestore(issue)}><ArchiveRestore size={15} /> Restore Test Run</Button>}
  </aside></div>;
}
function Info({ label, value }) { return <div><div className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground mb-1">{label}</div><div className="whitespace-pre-wrap">{value}</div></div>; }

export { ScenarioSelector, ScenarioDefinition, BassettFindingDetail, actionError, loadBassettTestRunForEdit };

