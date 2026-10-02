import { useEffect, useMemo, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api, formatApiErrorDetail, staleUpdateMessage, withExpectedVersion } from "../lib/api";
import { useAuth } from "../lib/auth";
import { PageHeader, Section, StatCard, MethodologyDisclosure } from "../components/shared";
import { Attachments } from "../components/Attachments";
import { CommentsThread } from "../components/CommentsThread";
import { AssigneePicker } from "../components/AssigneePicker";
import { Button } from "../components/ui/button";
import { LocalDrafts } from "../components/LocalDrafts";
import { Input } from "../components/ui/input";
import { FormModal, Field, ListSelect } from "../components/forms";
import { Textarea } from "../components/ui/textarea";
import { BassettTestRunForm, ScenarioDefinition, ScenarioSelector, createBassettTestRunDraft } from "../components/BassettTestRunForm";
import { AlertTriangle, Archive, ArchiveRestore, CheckCircle2, ClipboardCopy, ExternalLink, FileInput, FileOutput, Flag, Loader2, Pencil, Plus, RefreshCw, Search, ShieldAlert, X } from "lucide-react";
import { toast } from "sonner";
import { parseCsv } from "../lib/csv";
import { TableSortControls } from "../components/TableSortControls";
import { sortTableRows, usePersistentTableSort } from "../lib/tableSorting";
import { formatTestDate } from "../lib/testDates";
import { useFocusTrap } from "../lib/useFocusTrap";
import { FINDING_WORKFLOW_LABELS, workflowStatusLabel } from "../lib/workflowStatuses";
import { FINDING_STATUSES, StatusBadge } from "../lib/statusMaps";
import { normalizeEvaluationResult } from "../lib/evaluationResults";
import { ConfirmActionDialog } from "../components/ConfirmActionDialog";
import { ProjectScopeNav } from "../components/ProjectScopeNav";
import { BassettFindingTools, BassettFindingLifecycle } from "../components/BassettFindingTools";
import { loadBassettTestRunForEdit } from "../lib/bassettEditLoaders";
import { SEVERITY_LABELS, severityLabel } from "../lib/severity";
const defaultTestStatuses = ["Not Started", "In Review", "Engineering", "Closed / Resolved", "Ready for Retesting"];
const PERSONAL_FINDING_STATUS_LABELS = FINDING_WORKFLOW_LABELS;
const PERSONAL_FINDING_STATUSES = Object.fromEntries(Object.entries(FINDING_STATUSES).map(([value, definition]) => [value, {
  ...definition,
  label: PERSONAL_FINDING_STATUS_LABELS[value] || value,
}]));
const personalFindingStatusOptions = (statuses = []) => {
  const seenLabels = new Set();
  return statuses.filter((value) => {
    const label = PERSONAL_FINDING_STATUS_LABELS[value] || value;
    if (seenLabels.has(label)) return false;
    seenLabels.add(label);
    return true;
  });
};
const DEFAULT_RUN_SORT = { key: "test_date", direction: "desc" };

export async function persistBassettTestRun(form, apiClient = api) {
  const conversationFile = form.conversation_attachment;
  const conversationFiles = conversationFile && (typeof File === "undefined" || conversationFile instanceof File) ? [conversationFile] : [];
  const supportingFiles = (form.attachments || []).filter((file) => typeof File === "undefined" || file instanceof File);
  const convertSupportingFiles = Boolean(form.create_evidence_from_uploads && supportingFiles.length);
  const files = [...conversationFiles, ...(convertSupportingFiles ? [] : supportingFiles)];
  let issueId = form.id;
  let createdData = null;
  let savedIssue = null;
  if (form.id) {
    const body = { ...form };
    delete body.attachments;
    delete body.conversation_attachment;
    delete body.create_evidence_from_uploads;
    // Omit the primary scenario during ordinary edits so catalog refreshes do
    // not look like a reassignment. Send it only when the user deliberately
    // selects a different scenario in the edit form.
    const originalScenarioId = form._original_scenario_id || form.scenario_id;
    if (form.scenario_id === originalScenarioId) {
      delete body.scenario_id;
    }
    if (Array.isArray(body.scenario_ids) && form.scenario_id === originalScenarioId) {
      body.scenario_ids = body.scenario_ids.filter((scenarioId) => scenarioId !== form.scenario_id);
    }
    body.pending_attachment_count = files.length;
    const { data } = await apiClient.put(`/bassett/issues/${form.id}`, withExpectedVersion(form, body));
    savedIssue = data;
    if (form.create_finding && !form.finding_id) {
      await apiClient.post(`/bassett/issues/${form.id}/convert-to-finding`, {
        title: form.finding?.title,
        description: form.finding?.description,
        expected_behavior: form.finding?.expected_behavior || form.verified_correct_answer,
        finding_type: form.finding?.finding_type || form.issue_category,
        finding_type_detail: form.finding?.finding_type_detail,
        turn_id: form.finding_turn_id || undefined,
      });
    }
  } else {
    const body = { ...form };
    delete body.attachments;
    delete body.conversation_attachment;
    delete body.create_evidence_from_uploads;
    // Persist the record before uploading binary files. A rejected multipart
    // request must never discard an otherwise complete test run.
    body.pending_attachment_count = files.length;
    body.pending_conversation_attachment = Boolean(conversationFile);
    const { data } = await apiClient.post("/bassett/issues/workflow-json", body);
    createdData = data;
    issueId = data.issue?.id || data.id;
    savedIssue = data.issue || data;
  }
  let uploadFailures = 0;
  let evidenceFailures = 0;
  for (const file of files) {
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
  const createdEvidenceIds = [];
  if (convertSupportingFiles) {
    for (const file of supportingFiles) {
      try {
        const { data: evidenceRecord } = await apiClient.post("/evidence", {
          document_name: file.name,
          municipality_id: form.municipality_id,
          doc_type: "Other",
          notes: `Created from Bassett Test Run ${form.title || form.test_id || issueId}.`,
        });
        const upload = new FormData();
        upload.append("entity_type", "evidence");
        upload.append("entity_id", evidenceRecord.id);
        upload.append("file", file);
        await apiClient.post("/attachments/upload", upload, { timeout: 15000 });
        createdEvidenceIds.push(evidenceRecord.id);
      } catch {
        evidenceFailures += 1;
        const fallback = new FormData();
        fallback.append("entity_type", "bassett_issue");
        fallback.append("entity_id", issueId);
        fallback.append("file", file);
        try { await apiClient.post("/attachments/upload", fallback, { timeout: 15000 }); }
        catch { uploadFailures += 1; }
      }
    }
  }
  if (createdEvidenceIds.length) {
    const evidenceIds = [...new Set([...(form.evidence_ids || []), ...createdEvidenceIds])];
    await apiClient.put(`/bassett/issues/${issueId}`, withExpectedVersion(savedIssue || form, { evidence_ids: evidenceIds }));
  }
  return { issueId, uploadFailures, evidenceFailures, createdData };
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
  const [filters, setFilters] = useState(() => ({ status: "all", severity: "all", type: "all", retest: "all", project: searchParams.get("project_id") || "all", version: "all", result: "all", stage: "all", testType: "all", environment: "all", search: "", dateFrom: "", dateTo: "" }));
  const [quickView, setQuickView] = useState("");
  const [form, setForm] = useState(null);
  const [conflict, setConflict] = useState(null);
  const [rubricRemovalConflict, setRubricRemovalConflict] = useState(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState("");
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
    queryFn: async () => (await api.get(showingFindings ? "/bassett/findings" : "/bassett/issues", { params: { include_archived: true, status: showingFindings ? undefined : filters.status, severity: filters.severity, test_date_from: filters.dateFrom || undefined, test_date_to: filters.dateTo || undefined } })).data,
  });
  const scopedProjectId = filters.project !== "all" ? filters.project : "";
  const { data: metrics, isLoading: metricsLoading, isError: metricsError } = useQuery({
    queryKey: ["bassett-metrics", scopedProjectId],
    queryFn: async () => (await api.get("/bassett/metrics", { params: scopedProjectId ? { project_id: scopedProjectId } : {} })).data,
  });
  const { data: scenarios = [] } = useQuery({ queryKey: ["bassett-scenarios"], queryFn: async () => (await api.get("/bassett/test-bank")).data });
  const { data: rubricCatalog } = useQuery({ queryKey: ["bassett-rubric-catalog"], queryFn: async () => (await api.get("/bassett/rubric-catalog")).data, staleTime: 30 * 60_000, enabled: Boolean(form) });
  const { data: projects = [] } = useQuery({ queryKey: ["projects"], queryFn: async () => (await api.get("/projects")).data });
  const { data: municipalities = [] } = useQuery({ queryKey: ["municipalities"], queryFn: async () => (await api.get("/municipalities")).data, enabled: Boolean(form) });
  const { data: properties = [] } = useQuery({ queryKey: ["properties"], queryFn: async () => (await api.get("/properties")).data, enabled: Boolean(form) });
  const { data: users = [] } = useQuery({ queryKey: ["users"], queryFn: async () => (await api.get("/users")).data, enabled: Boolean(form) });
  const { data: versions = [] } = useQuery({ queryKey: ["versions"], queryFn: async () => (await api.get("/versions")).data, enabled: Boolean(form) });
  const { data: evidenceRecords = [] } = useQuery({ queryKey: ["evidence"], queryFn: async () => (await api.get("/evidence")).data, enabled: Boolean(form) });
  const { data: availableFindings = [] } = useQuery({ queryKey: ["bassett-findings-for-entry-form"], queryFn: async () => (await api.get("/bassett/findings")).data, enabled: Boolean(form) });
  const { data: config } = useQuery({ queryKey: ["config"], queryFn: async () => (await api.get("/config")).data });
  const testStatuses = config?.finding_statuses || config?.bassett_workflow_statuses || defaultTestStatuses;
  useEffect(() => {
    const projectId = searchParams.get("project_id");
    if (!showingFindings && searchParams.get("new_run") === "1" && projectId) {
      setForm(createBassettTestRunDraft({ project_id: projectId }, config?.application_timezone));
      const next = new URLSearchParams(searchParams);
      next.delete("new_run");
      setSearchParams(next, { replace: true });
    }
  }, [config?.application_timezone, searchParams, setSearchParams, showingFindings]);
  const canManage = ["admin", "qa_manager"].includes(user?.role);
  const canWrite = ["admin", "qa_manager", "tester", "developer"].includes(user?.role);
  const scenarioMap = useMemo(() => Object.fromEntries(scenarios.map((scenario) => [scenario.id, scenario])), [scenarios]);
  const runColumns = useMemo(() => [
    { key: "test_id", label: "Test ID", type: "test-id" },
    { key: "title", label: "Test Run", type: "natural", getValue: (row) => row.title || row.question_asked },
    { key: "scenario", label: "Primary Scenario", type: "test-id", getValue: (row) => scenarioMap[row.scenario_id]?.stable_id },
    { key: "severity", label: "Severity", type: "severity" },
    { key: "status", label: "Workflow status", type: "status", order: testStatuses },
    { key: "result", label: "Test Result", type: "status", order: ["Pass", "Pass with Minor Issues", "Needs Improvement", "Fail", "Critical Fail", "Not Evaluated"] },
    { key: "bassett_version", label: "Bassett version", type: "text" },
    { key: "environment", label: "Environment", type: "text" },
    { key: "test_date", label: "Test Date", type: "date" },
  ], [scenarioMap, testStatuses]);
  const [sort, setSort] = usePersistentTableSort(showingFindings ? "bassett-findings" : "bassett-test-runs", runColumns, showingFindings ? { key: "severity", direction: "asc" } : DEFAULT_RUN_SORT);

  const findingTypes = useMemo(() => [...new Set(issues.map((item) => item.finding_type).filter(Boolean))].sort(), [issues]);
  const findingVersions = useMemo(() => [...new Set(issues.map((item) => item.version_found || item.bassett_version).filter(Boolean))].sort(), [issues]);
  const findingOptions = useMemo(() => ({
    results: [...new Set(issues.map((item) => item.result).filter(Boolean))].sort(),
    stages: [...new Set(issues.map((item) => {
      const scenario = scenarioMap[item.scenario_id] || item.definition_snapshot || item.scenario_snapshot || {};
      const value = scenario.test_type || scenario.report_type || scenario.workflow_stage || item.workflow_stage;
      return value;
    }).filter(Boolean))].sort(),
    testTypes: [...new Set(issues.map((item) => item.test_type).filter(Boolean))].sort(),
    environments: [...new Set(issues.map((item) => item.environment).filter(Boolean))].sort(),
  }), [issues, scenarioMap]);
  const shown = useMemo(() => sortTableRows(issues.filter((issue) => {
    if (issue.deleted_at || Boolean(issue.archived || issue.status === "Archived") !== showArchived) return false;
    if (showingFindings && quickView === "in-review" && workflowStatusLabel(issue.developer_status) !== "In Review") return false;
    if (showingFindings && quickView === "not-started" && issue.developer_status !== "New") return false;
    if (showingFindings && quickView === "reported" && !['Planned', 'In Development'].includes(issue.developer_status)) return false;
    if (showingFindings && quickView === "retest" && issue.developer_status !== "Ready for Retest") return false;
    if (showingFindings && filters.status !== "all" && workflowStatusLabel(issue.developer_status) !== workflowStatusLabel(filters.status)) return false;
    if (showingFindings && filters.severity !== "all" && severityLabel(issue.severity) !== filters.severity) return false;
    if (showingFindings && filters.type !== "all" && issue.finding_type !== filters.type) return false;
    if (showingFindings && filters.retest !== "all" && (issue.retest_status || "Pending") !== filters.retest) return false;
    if (filters.project !== "all" && issue.project_id !== filters.project) return false;
    if (showingFindings && filters.version !== "all" && (issue.version_found || issue.bassett_version) !== filters.version) return false;
    if (showingFindings && filters.result !== "all" && issue.result !== filters.result) return false;
    if (showingFindings && filters.stage !== "all") {
      const scenario = scenarioMap[issue.scenario_id] || issue.definition_snapshot || issue.scenario_snapshot || {};
      const testBankType = scenario.test_type || scenario.report_type || scenario.workflow_stage || issue.workflow_stage;
      if (testBankType !== filters.stage) return false;
    }
    if (showingFindings && filters.testType !== "all" && issue.test_type !== filters.testType) return false;
    if (showingFindings && filters.environment !== "all" && issue.environment !== filters.environment) return false;
    if (showingFindings && filters.dateFrom && (!issue.test_date || issue.test_date < filters.dateFrom)) return false;
    if (showingFindings && filters.dateTo && (!issue.test_date || issue.test_date > filters.dateTo)) return false;
    const query = filters.search.trim().toLowerCase();
    return !query || [issue.title, issue.description, issue.question_asked, issue.exact_bassett_answer, issue.issue_category, issue.finding_type, issue.version_found, issue.assignee_name, issue.scenario_id]
      .some((value) => String(value || "").toLowerCase().includes(query));
  }), runColumns, sort, [{ key: "test_date", direction: "desc" }, "title"]), [issues, filters, quickView, runColumns, sort, scenarioMap, showArchived, showingFindings]);
  const defaultSort = showingFindings ? { key: "severity", direction: "asc" } : DEFAULT_RUN_SORT;
  const filtersActive = Boolean(quickView || filters.search || filters.dateFrom || filters.dateTo || Object.entries(filters).some(([key, value]) => !["search", "dateFrom", "dateTo"].includes(key) && value !== "all"));
  const clearFilters = () => {
    setQuickView("");
    setFilters({ status: "all", severity: "all", type: "all", retest: "all", project: "all", version: "all", result: "all", stage: "all", testType: "all", environment: "all", search: "", dateFrom: "", dateTo: "" });
    if (searchParams.has("project_id")) {
      const next = new URLSearchParams(searchParams);
      next.delete("project_id");
      setSearchParams(next, { replace: true });
    }
  };
  const applyQuickView = (view) => {
    const base = { status: "all", severity: "all", type: "all", retest: "all", project: "all", version: "all", result: "all", stage: "all", testType: "all", environment: "all", search: "", dateFrom: "", dateTo: "" };
    setQuickView(showingFindings ? view : "");
    if (showingFindings) setFilters(base);
    else if (view === "in-review") setFilters({ ...base, status: "In Review" });
    else if (view === "not-started") setFilters({ ...base, status: "Not Started" });
    else if (view === "reported") setFilters({ ...base, status: "Engineering" });
    else if (view === "retest") setFilters({ ...base, status: "Ready for Retesting" });
    else setFilters(base);
  };

  const save = async (formOverride = null) => {
    if (saving) return;
    const draft = formOverride && typeof formOverride === "object" && !formOverride.preventDefault
      ? formOverride
      : form;
    setSaveError("");
    setSaving(true);
    try {
      const { issueId, uploadFailures, evidenceFailures } = await persistBassettTestRun(draft);
      if (!draft.id) {
        setSelected(issueId);
        localStorage.removeItem("zoneqa:bassett-workflow-draft");
      }
      if (uploadFailures || evidenceFailures) {
        const warnings = [
          uploadFailures ? `${uploadFailures} attachment${uploadFailures === 1 ? "" : "s"} could not be uploaded` : "",
          evidenceFailures ? `${evidenceFailures} file${evidenceFailures === 1 ? "" : "s"} could not be converted to Ordinance Evidence and remained with the test run` : "",
        ].filter(Boolean).join("; ");
        toast.warning(`Test run saved, but ${warnings}.`);
      } else {
        toast.success(draft.id ? "Test run updated" : "Test run recorded");
      }
      setConflict(null);
      setRubricRemovalConflict(null);
      setForm(null);
      qc.invalidateQueries({ queryKey: ["attachments", "bassett_issue", issueId] });
      qc.invalidateQueries({ queryKey: ["bassett-test-runs"] });
      qc.invalidateQueries({ queryKey: ["bassett-metrics"] });
      qc.invalidateQueries({ queryKey: ["bassett-scenarios"] });
    } catch (error) {
      const conflictDetail = error?.response?.data?.detail;
      const rubricIds = scoredRubricRemovalIds(error);
      if (rubricIds) {
        setRubricRemovalConflict(rubricIds);
        setConflict(null);
        setSaveError("");
      } else if (error?.response?.status === 409 && conflictDetail?.code === "stale_update" && draft.id) {
        try { setConflict(await loadBassettTestRunForEdit({ id: draft.id })); } catch { setConflict({ revision: conflictDetail?.current_revision }); }
        const message = staleUpdateMessage(error) || "This test run changed elsewhere. Review your entries before reapplying them.";
        setSaveError(message);
        toast.error(message);
      } else {
        const message = actionError(error, "Unable to save test run");
        setSaveError(message);
        toast.error(message);
      }
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
      setRubricRemovalConflict(null);
      setSaveError("");
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
  const openNewTestRun = () => {
    try {
      setForm(createBassettTestRunDraft({}, config?.application_timezone));
    } catch (error) {
      toast.error(actionError(error, "Unable to open the test-run form"));
    }
  };

  return <div>
    <PageHeader stackedActions title={showingFindings ? "Bassett Findings" : "Bassett Test Runs"} subtitle={showingFindings ? "Findings created from Bassett-only testing. Model Comparison Findings remain separate." : "Record a Bassett test result, evidence, and follow-up. Passing test runs are not findings."}>
      {canManage && !showingFindings && <Button variant="outline" onClick={() => setShowImport(true)}><FileInput size={15} /> Import CSV</Button>}
      {!showingFindings && <Button type="button" variant="outline" onClick={exportCsv}><FileOutput size={15} /> Export CSV</Button>}
      {canWrite && !showingFindings && <LocalDrafts mode="bassett" onRecover={(draft) => setForm(createBassettTestRunDraft(draft, config?.application_timezone))} />}
      {showingFindings
        ? <BassettFindingTools records={shown} config={config} canWrite={canWrite} canManage={canManage} archived={showArchived} onToggleArchive={() => { setShowArchived((value) => !value); setSelected(null); }} onChanged={() => qc.invalidateQueries()} />
        : <Link to="/bassett/findings"><Button variant="outline">Bassett Findings</Button></Link>}
      {!showingFindings && <Button variant="outline" aria-pressed={showArchived} onClick={() => setShowArchived((value) => !value)}>{showArchived ? "Active test runs" : "Archived test runs"}</Button>}
      {canWrite && !showingFindings && <Button type="button" data-testid="new-bassett-test-run" onClick={openNewTestRun} className="relative z-10 bg-[var(--orange)] hover:bg-[var(--orange-600)]"><Plus size={15} /> New Bassett Test Run</Button>}
    </PageHeader>
    <ProjectScopeNav projects={projects} />
    <div className="mb-4 flex flex-wrap items-center gap-2" aria-label="Quick views">
      <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Quick views</span>
      <Button type="button" size="sm" variant="outline" onClick={() => applyQuickView("in-review")}>In Review</Button>
      <Button type="button" size="sm" variant="outline" onClick={() => applyQuickView("not-started")}>Not Started</Button>
      <Button type="button" size="sm" variant="outline" onClick={() => applyQuickView("reported")}>Engineering</Button>
      <Button type="button" size="sm" variant="outline" onClick={() => applyQuickView("retest")}>Ready for Retesting</Button>
      {filtersActive && <Button type="button" size="sm" variant="ghost" onClick={clearFilters}>Show All</Button>}
    </div>
    {metricsLoading && <div className="mb-3 rounded-lg border bg-[var(--paper)] px-4 py-3 text-sm text-muted-foreground" role="status" aria-live="polite">Calculating summary metrics… The records below are already available while ZoneQA finishes the totals.</div>}
    {metricsError && <div className="mb-3 rounded-lg border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-900" role="status">Summary metrics could not be loaded. The record list below is still available.</div>}
     <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-5 gap-3 mb-6">
       <StatCard label={showingFindings ? "Open Findings" : "Tests Needing Attention"} value={showingFindings ? (metrics?.findings?.open ?? 0) : (metrics?.test_runs?.attention ?? "—")} sub={showingFindings ? "excludes fixed and closed findings" : "Needs Improvement, Fail, Critical Fail, or legacy Blocked"} icon={Flag} accent="#f97316" />
       <StatCard label={showingFindings ? "New Findings" : "Not Started Test Runs"} value={showingFindings ? (metrics?.findings?.new ?? 0) : (metrics?.issues?.new ?? "—")} sub={showingFindings ? "newly recorded findings" : "Workflow status is Not Started."} icon={AlertTriangle} accent="#2563eb" />
       <StatCard label={showingFindings ? "High Findings" : "High Severity"} value={showingFindings ? (metrics?.findings?.high ?? 0) : (metrics?.issues?.high ?? "—")} sub="High severity" icon={ShieldAlert} accent="#ea580c" />
       <StatCard label={showingFindings ? "Critical Findings" : "Critical Severity"} value={showingFindings ? (metrics?.findings?.critical_count ?? 0) : (metrics?.issues?.critical_count ?? "—")} sub="Critical severity" icon={ShieldAlert} accent="#dc2626" />
       <StatCard label={showingFindings ? "Total Findings" : "Scenario coverage"} value={showingFindings ? (metrics?.findings?.total ?? 0) : (metrics ? `${metrics.test_runs.test_bank_coverage.percent}%` : "—")} sub={showingFindings ? "linked to Bassett-only testing" : (metrics ? `${metrics.test_runs.test_bank_coverage.covered}/${metrics.test_runs.test_bank_coverage.total} active scenarios with a qualifying completed evaluation` : "Draft and Not Evaluated runs are excluded")} icon={CheckCircle2} accent="#16a34a" />
    </div>
    <div className={showingFindings ? "grid gap-4 xl:grid-cols-[minmax(0,1fr)_minmax(320px,400px)]" : ""}>
    <Section title={showingFindings ? (showArchived ? "Archived Bassett findings" : "Bassett findings") : "Bassett test runs"} action={<span className="text-xs text-muted-foreground">{shown.length} shown · archived records stay in history</span>}>
      <div className="flex flex-wrap gap-2 mb-4">
        <div className="relative flex-1 min-w-[220px]"><Search size={15} className="absolute left-3 top-2.5 text-muted-foreground" /><Input aria-label={showingFindings ? "Search Bassett findings" : "Search Bassett test runs"} className="pl-9" placeholder={showingFindings ? "Search finding, test run, category, scenario…" : "Search question, response, category, scenario…"} value={filters.search} onChange={(e) => setFilters({ ...filters, search: e.target.value })} /></div>
         {!showingFindings && <select aria-label="Filter by Workflow status" className="h-9 rounded-md border bg-background px-3 text-sm" value={filters.status} onChange={(e) => setFilters({ ...filters, status: e.target.value })}><option value="all">All workflow statuses</option>{testStatuses.map((x) => <option key={x}>{x}</option>)}</select>}
         <select aria-label="Filter by severity" className="h-9 rounded-md border bg-background px-3 text-sm" value={filters.severity} onChange={(e) => setFilters({ ...filters, severity: e.target.value })}><option value="all">All severity</option>{SEVERITY_LABELS.map((x) => <option key={x}>{x}</option>)}</select>
        {showingFindings && <select aria-label="Filter by finding status" className="h-9 rounded-md border bg-background px-3 text-sm" value={filters.status} onChange={(e) => setFilters({ ...filters, status: e.target.value })}><option value="all">All workflow statuses</option>{personalFindingStatusOptions(config?.finding_statuses || []).map((x) => <option key={x} value={x}>{PERSONAL_FINDING_STATUS_LABELS[x] || x}</option>)}</select>}
        {!showingFindings && <select aria-label="Filter by testing project" className="h-9 rounded-md border bg-background px-3 text-sm" value={filters.project} onChange={(e) => setFilters({ ...filters, project: e.target.value })}><option value="all">All testing projects</option>{projects.map((project) => <option key={project.id} value={project.id}>{project.name}</option>)}</select>}
         {!showingFindings && <><Input aria-label="Test Date from" title="Test Date from" type="date" className="w-auto" value={filters.dateFrom} onChange={(e) => setFilters({ ...filters, dateFrom: e.target.value })} /><Input aria-label="Test Date to" title="Test Date to" type="date" className="w-auto" value={filters.dateTo} onChange={(e) => setFilters({ ...filters, dateTo: e.target.value })} /></>}
        {filtersActive && <Button type="button" size="sm" variant="outline" className="h-9 text-[var(--orange)]" onClick={clearFilters} data-testid="bassett-clear-filters"><X size={13} className="mr-1" /> Clear filters</Button>}
      </div>
      {showingFindings && <details className="mb-4 rounded-lg border bg-[var(--paper)] px-3 py-2">
        <summary className="cursor-pointer text-sm font-semibold text-[var(--navy)]">Additional filters</summary>
        <div className="mt-3 flex flex-wrap gap-2">
          {findingTypes.length > 1 && <select aria-label="Filter by finding category" className="h-9 rounded-md border bg-background px-3 text-sm" value={filters.type} onChange={(e) => setFilters({ ...filters, type: e.target.value })}><option value="all">All finding categories</option>{findingTypes.map((x) => <option key={x}>{x}</option>)}</select>}
          {findingVersions.length > 0 && <select aria-label="Filter by Bassett version" className="h-9 rounded-md border bg-background px-3 text-sm" value={filters.version} onChange={(e) => setFilters({ ...filters, version: e.target.value })}><option value="all">All Bassett versions</option>{findingVersions.map((x) => <option key={x}>{x}</option>)}</select>}
          <select aria-label="Filter by testing project" className="h-9 rounded-md border bg-background px-3 text-sm" value={filters.project} onChange={(e) => setFilters({ ...filters, project: e.target.value })}><option value="all">All testing projects</option>{projects.map((project) => <option key={project.id} value={project.id}>{project.name}</option>)}</select>
          <select aria-label="Filter by retest status" className="h-9 rounded-md border bg-background px-3 text-sm" value={filters.retest} onChange={(e) => setFilters({ ...filters, retest: e.target.value })}><option value="all">All retest states</option>{["Pending", "In Progress", "Fixed", "Partially Fixed", "Not Fixed"].map((x) => <option key={x}>{x}</option>)}</select>
          <select aria-label="Filter by test result" className="h-9 rounded-md border bg-background px-3 text-sm" value={filters.result} onChange={(e) => setFilters({ ...filters, result: e.target.value })}><option value="all">All test results</option>{findingOptions.results.map((x) => <option key={x}>{x}</option>)}</select>
          <select aria-label="Filter by Test Bank type" className="h-9 rounded-md border bg-background px-3 text-sm" value={filters.stage} onChange={(e) => setFilters({ ...filters, stage: e.target.value })}><option value="all">All Test Bank types</option>{findingOptions.stages.map((x) => <option key={x}>{x}</option>)}</select>
          <select aria-label="Filter by conversation format" className="h-9 rounded-md border bg-background px-3 text-sm" value={filters.testType} onChange={(e) => setFilters({ ...filters, testType: e.target.value })}><option value="all">All conversation formats</option>{findingOptions.testTypes.map((x) => <option key={x}>{x}</option>)}</select>
          <select aria-label="Filter by environment" className="h-9 rounded-md border bg-background px-3 text-sm" value={filters.environment} onChange={(e) => setFilters({ ...filters, environment: e.target.value })}><option value="all">All environments</option>{findingOptions.environments.map((x) => <option key={x}>{x}</option>)}</select>
          <fieldset className="basis-full mt-1 flex flex-wrap gap-2 border-t pt-2"><legend className="text-xs text-muted-foreground">Test Date</legend>
          <label className="text-xs text-muted-foreground">From <Input aria-label="Finding Test Date from" title="Test Date from" type="date" className="mt-1 w-auto" value={filters.dateFrom} onChange={(e) => setFilters({ ...filters, dateFrom: e.target.value })} /></label>
          <label className="text-xs text-muted-foreground">To <Input aria-label="Finding Test Date to" title="Test Date to" type="date" className="mt-1 w-auto" value={filters.dateTo} onChange={(e) => setFilters({ ...filters, dateTo: e.target.value })} /></label>
          </fieldset>
        </div>
      </details>}
      {showingFindings ? <div className="space-y-2" role="region" aria-label="Bassett findings list">
        {isLoading && <div className="border rounded-xl p-8 text-center text-sm text-muted-foreground">Loading Bassett findings… this may take a few seconds.</div>}
        {!isLoading && shown.map((finding) => <button type="button" key={finding.id} onClick={() => setSelected(finding.id)} aria-label={`View finding ${finding.title || "Untitled finding"}`} aria-pressed={selected === finding.id}
          className={`w-full text-left bg-card border rounded-xl p-4 card-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--orange)] focus-visible:ring-offset-2 ${selected === finding.id ? "border-[var(--orange)] border-2" : ""}`}>
          <div className="flex flex-wrap items-center gap-2 mb-1"><Pill tone={severityLabel(finding.severity) === "Critical" ? "red" : severityLabel(finding.severity) === "High" ? "orange" : "slate"}>{severityLabel(finding.severity) || "Not rated"}</Pill><StatusBadge value={workflowStatusLabel(finding.developer_status)} definitions={PERSONAL_FINDING_STATUSES} /><span className="text-xs text-muted-foreground">{finding.finding_type || "Other"}</span></div>
          <div className="font-semibold text-[var(--navy)]">{finding.title || "Untitled finding"}</div>
          <div className="text-xs text-muted-foreground mt-1">Found {finding.version_found || "version not specified"}{finding.assignee_name ? ` · @${finding.assignee_name}` : ""}</div>
        </button>)}
        {!isLoading && !shown.length && <div className="border rounded-xl p-8 text-center text-sm text-muted-foreground">No Bassett findings match these filters.</div>}
      </div> : <>
      <TableSortControls columns={runColumns} sort={sort} setSort={setSort} defaultSort={defaultSort} className="mb-3" />
       <div className="space-y-3" role="list" aria-label="Bassett test runs">
         {isLoading && <p role="status" className="p-8 text-center text-sm text-muted-foreground">Loading Bassett test runs…</p>}
         {shown.map((issue) => <article key={issue.id} role="listitem" className="rounded-xl border bg-card p-4">
           <button type="button" className="w-full text-left rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--orange)]" onClick={() => setSelected(issue.id)} aria-label={`Open ${issue.title || issue.question_asked}`}>
             <div className="flex flex-wrap items-center gap-2"><span className="text-xs font-semibold text-muted-foreground">{issue.test_id || "No Test ID"}</span><Pill tone={severityLabel(issue.severity) === "Critical" ? "red" : severityLabel(issue.severity) === "High" ? "orange" : "slate"}>{severityLabel(issue.severity) || "Not rated"}</Pill><StatusBadge value={issue.result || "Not Evaluated"} compact /></div>
             <div className="mt-2 font-semibold text-[var(--navy)]">{issue.title || issue.question_asked}</div>
             <div className="mt-1 line-clamp-2 text-xs text-muted-foreground">{issue.question_asked}</div>
           </button>
           <dl className="mt-3 grid grid-cols-2 gap-x-4 gap-y-2 border-t pt-3 text-xs lg:grid-cols-5">
             <div><dt className="text-muted-foreground">Scenario</dt><dd className="font-medium">{scenarioMap[issue.scenario_id]?.stable_id || "Not linked"}{(issue.scenario_ids || []).filter((id) => id !== issue.scenario_id).length > 0 ? ` +${(issue.scenario_ids || []).filter((id) => id !== issue.scenario_id).length}` : ""}</dd></div>
             <div><dt className="text-muted-foreground">Workflow</dt><dd className="font-medium">{issue.status || "—"}</dd></div>
             <div><dt className="text-muted-foreground">Test date</dt><dd className="font-medium">{formatTestDate(issue.test_date)}</dd></div>
             <div><dt className="text-muted-foreground">Bassett version</dt><dd className="font-medium">{issue.bassett_version || "Not specified"}</dd></div>
             <div><dt className="text-muted-foreground">Environment</dt><dd className="font-medium">{issue.environment || "—"}</dd></div>
           </dl>
           <div className="mt-3 flex justify-end border-t pt-2"><BassettRunActions issue={issue} canWrite={canWrite} canManage={canManage} editing={loadingEditId === issue.id} onEdit={openEdit} onArchive={setConfirmingArchive} onRestore={restore} /></div>
         </article>)}
         {!isLoading && !shown.length && <div className="rounded-xl border p-8 text-center text-sm text-muted-foreground">No Bassett test runs match these filters.</div>}
       </div>
      </>}
    </Section>
    {showingFindings && (selected
      ? <BassettFindingDetail id={selected} onClose={() => setSelected(null)} canManage={canManage} canWrite={canWrite && !showArchived} refresh={() => qc.invalidateQueries()} embedded />
      : <aside aria-label="Bassett Finding details" className="hidden xl:block"><div className="bg-card border rounded-xl p-8 text-center text-sm text-muted-foreground">Select a Bassett finding to view its details.</div></aside>)}
    </div>
     <MethodologyDisclosure title={showingFindings ? "How Bassett Finding metrics are calculated" : "How Bassett Test Run metrics are calculated"} testid="bassett-test-runs-methodology">
       {showingFindings ? (
         <><p>Finding counts reflect Bassett-only findings in the current visibility scope; fixed and closed findings are excluded from the open count. High and Critical counts are separate; the High + Critical findings total is their additive roll-up.</p><p>Project, version, severity, test result, Test Bank type, conversation format, environment, and test date come from the linked Bassett Test Run and Test Bank scenario when they are not stored directly on the finding.</p></>
       ) : (
         <>
            <p>Tests Needing Attention includes Test result values of Needs Improvement, Fail, Critical Fail, or legacy Blocked.</p>
            <p>Scenario coverage is the percentage of active Test Bank scenarios with a qualifying completed evaluation. Draft and Not Evaluated runs are excluded; workflow status does not remove a completed result.</p>
         </>
       )}
       <p>Archived records remain available in history but are excluded from active summary populations. The visible test-date filters define the displayed date range.</p>
     </MethodologyDisclosure>

     {selected && !showingFindings && <IssueDetail id={selected} onClose={() => setSelected(null)} onEdit={openEdit} onRestore={restore} canWrite={canWrite} canManage={canManage} refresh={() => qc.invalidateQueries()} />}
    {form && <BassettTestRunForm key={`${form.id || form.submission_id || "new"}:${form._draftRecoveryNonce || "initial"}`} form={form} setForm={setForm} scenarios={scenarios} rubricCatalog={rubricCatalog} versions={versions} projects={projects} municipalities={municipalities} properties={properties} users={users} evidenceRecords={evidenceRecords} availableFindings={availableFindings} config={config} onSubmit={save} onCancel={() => { setConflict(null); setRubricRemovalConflict(null); setSaveError(""); setForm(null); }} submitting={saving} conflictNotice={<>
      {saveError && <div role="alert" className="col-span-2 rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-800"><p className="font-semibold">Your changes were not saved.</p><p className="mt-1">{saveError}</p></div>}
      {conflict && <div role="alert" className="col-span-2 rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-800">
      <p className="font-semibold">Someone else saved this test run first. Your entries are still open for review.</p>
      <div className="mt-2 flex gap-2">
        <Button type="button" size="sm" variant="outline" onClick={() => { setForm(conflict); setConflict(null); }}>Load latest values</Button>
        <Button type="button" size="sm" onClick={() => { setForm((draft) => ({ ...draft, revision: conflict.revision, updated_at: conflict.updated_at, expected_revision: conflict.revision, expected_updated_at: undefined })); setConflict(null); }}>Keep my entries and reapply</Button>
      </div>
    </div>}
    {rubricRemovalConflict && <div role="alert" className="col-span-2 rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm text-amber-950">
      <p className="font-semibold">Previously scored rubric items need your review.</p>
      <p className="mt-1">The current selection omits {rubricRemovalConflict.join(", ")}. Keep them in this test run, or remove their saved scores and continue.</p>
      <div className="mt-2 flex flex-wrap gap-2">
        <Button type="button" size="sm" variant="outline" onClick={() => {
          setForm((draft) => ({ ...draft, selected_rubric_ids: [...new Set([...(draft.selected_rubric_ids || []), ...rubricRemovalConflict])], confirm_rubric_removal: false }));
          setRubricRemovalConflict(null);
          setSaveError("");
        }}>Keep previously scored items</Button>
        <Button type="button" size="sm" onClick={() => save({ ...form, confirm_rubric_removal: true })}>Remove old scores and save</Button>
      </div>
    </div>}
    </>} />}
    {showImport && <FormModal open onOpenChange={(open) => !open && setShowImport(false)} title="Review Bassett Test Run CSV" onSubmit={importPreview ? commitImport : previewImport} submitDisabled={importing || !importRows.length || Boolean(importPreview?.invalid)} submitLabel={importing ? "Importing…" : importPreview ? "Confirm Import Accepted Rows" : "Preview Rows"}>
      <p className="text-sm text-muted-foreground">Administrator-controlled import. Existing IDs are updated; no rows are written until validation succeeds.</p>
      <Input aria-label="Choose Bassett test run CSV" type="file" accept=".csv" onChange={loadCsv} />
      {!importPreview ? <div className="rounded-lg bg-[var(--paper)] p-3 text-sm">{importRows.length ? `${importFileName}: ${importRows.length} row(s) loaded and ready for review.` : <><b>Required columns for new test runs:</b> scenario_id, question_asked, exact_bassett_answer, verified_correct_answer. <span className="text-muted-foreground">Include id only when updating an existing test run.</span></>}</div> : <ImportReview preview={importPreview} />}
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
  const detail = error?.response?.data?.detail;
  if (error?.response?.status === 409 && detail?.code === "stale_update") return "This record changed elsewhere. Refresh and retry.";
  if (error?.response?.status === 413) return "The selected upload is too large. Your entries are still open; remove the file or upload a smaller copy and retry.";
  if (detail != null) return formatApiErrorDetail(detail);
  if (!error?.response) return `${fallback}. The server could not be reached; your entries are still open.`;
  return `${fallback}. Your entries are still open so you can retry.`;
}

export function scoredRubricRemovalIds(error) {
  const detail = error?.response?.data?.detail;
  if (error?.response?.status !== 409 || detail?.code !== "scored_rubric_removal_confirmation_required") return null;
  return Array.isArray(detail.rubric_ids) ? detail.rubric_ids : [];
}

function BassettFindingDetail({ id, onClose, canWrite, canManage, refresh, embedded = false }) {
  const drawerRef = useFocusTrap(true, onClose);
  const [statusForm, setStatusForm] = useState(null);
  const [editForm, setEditForm] = useState(null);
  const [submitting, setSubmitting] = useState(false);
  const { data: finding, isLoading, isError } = useQuery({
    queryKey: ["bassett-finding", id],
    queryFn: async () => (await api.get(`/findings/${id}`)).data,
  });
  const { data: availableRuns = [] } = useQuery({
    queryKey: ["bassett-runs-for-finding-links"],
    queryFn: async () => (await api.get("/bassett/issues", { params: { include_archived: true } })).data,
  });
  const { data: config } = useQuery({ queryKey: ["config"], queryFn: async () => (await api.get("/config")).data });
  const sourceRun = finding?.bassett_issue_id;
  const linkedRunIds = [...new Set([sourceRun, ...(finding?.linked_test_run_ids || [])].filter(Boolean))];
  const linkedRuns = linkedRunIds.map((runId) => availableRuns.find((run) => run.id === runId) || { id: runId });

  const copyIssueSummary = async () => {
    const runLines = linkedRuns.length
      ? linkedRuns.map((run) => `- ${run.title || run.question_asked || run.test_id || run.id} | ${run.result || "Not evaluated"} | ${run.bassett_version || "Version not specified"} | ${formatTestDate(run.test_date)}`)
      : ["- None linked"];
    const summary = [
      `Finding: ${finding.title || "Untitled finding"}`,
      `Severity: ${severityLabel(finding.severity) || "Not rated"}`,
      `Status: ${finding.developer_status || "New"}`,
      `Category: ${finding.finding_type || "Other"}`,
      `Description: ${finding.description || "Not recorded"}`,
      `Expected behavior: ${finding.expected_behavior || "Not recorded"}`,
      `Actual Bassett behavior: ${finding.actual_behavior || finding.description || "Not recorded"}`,
      "Linked test runs:",
      ...runLines,
      `Follow-up: ${finding.follow_up_action || "Not recorded"}`,
    ].join("\n");
    try {
      await navigator.clipboard.writeText(summary);
      toast.success("Developer handoff copied");
    } catch {
      toast.error("Unable to copy the developer handoff");
    }
  };

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
  const saveFinding = async () => {
    if (submitting) return;
    if (!String(editForm.finding_type || "").trim()) return toast.error("Select a Finding Category.");
    setSubmitting(true);
    try {
      const { data } = await api.put(`/findings/${id}`, withExpectedVersion(finding, {
        title: editForm.title,
        description: editForm.description,
        expected_behavior: editForm.expected_behavior,
        finding_type: editForm.finding_type,
        finding_type_detail: editForm.finding_type_detail,
        linked_test_run_ids: editForm.linked_test_run_ids,
      }));
      toast.success("Finding updated");
      setEditForm(null);
      refresh();
      return data;
    } catch (error) { toast.error(actionError(error, "Unable to update finding")); }
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

  return <div className={embedded ? "fixed inset-0 z-40 bg-black/20 flex justify-end xl:static xl:z-auto xl:block xl:bg-transparent" : "fixed inset-0 z-40 bg-black/20 flex justify-end"} onClick={(event) => event.target === event.currentTarget && onClose()} role="presentation">
    <aside ref={drawerRef} tabIndex="-1" role="dialog" aria-modal={embedded ? undefined : "true"} aria-labelledby="bassett-finding-detail-title" className={embedded ? "bg-card h-full w-full max-w-2xl overflow-y-auto p-6 shadow-xl xl:sticky xl:top-20 xl:h-auto xl:max-h-[calc(100vh-6rem)] xl:max-w-none xl:rounded-xl xl:border xl:shadow-none" : "bg-card h-full w-full max-w-2xl overflow-y-auto p-6 shadow-xl"}>
      <div className="flex items-start justify-between gap-4 mb-6">
        <div className="min-w-0">
          <div className="text-xs uppercase tracking-wide text-muted-foreground">Bassett Finding Details</div>
          <h2 id="bassett-finding-detail-title" className="text-xl font-bold font-display text-[var(--navy)] mt-1 break-words">{finding?.title || "Finding"}</h2>
        </div>
        <div className="flex shrink-0 gap-1">{finding && <Button type="button" variant="ghost" size="icon" onClick={copyIssueSummary} aria-label="Copy developer handoff" title="Copy developer handoff"><ClipboardCopy size={16} /></Button>}{canWrite && finding && <Button type="button" variant="ghost" size="icon" onClick={() => setEditForm({ title: finding.title || "", description: finding.description || "", expected_behavior: finding.expected_behavior || "", finding_type: finding.finding_type || "", finding_type_detail: finding.finding_type_detail || "", linked_test_run_ids: linkedRunIds })} aria-label="Edit Bassett Finding"><Pencil size={16} /></Button>}<Button type="button" variant="ghost" size="icon" onClick={onClose} aria-label="Close Bassett Finding Details"><X size={18} /></Button></div>
      </div>
      {isLoading && <div className="text-sm text-muted-foreground">Loading Bassett Finding Details…</div>}
      {isError && <div role="alert" className="rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-800">Unable to load this Bassett finding.</div>}
      {finding && <div className="space-y-5 text-sm">
        {canManage && <BassettFindingLifecycle finding={finding} onChanged={() => { refresh(); onClose(); }} />}
        <div className="flex flex-wrap gap-2"><Pill tone={severityLabel(finding.severity) === "Critical" ? "red" : severityLabel(finding.severity) === "High" ? "orange" : "slate"}>{severityLabel(finding.severity) || "Not rated"}</Pill><StatusBadge value={workflowStatusLabel(finding.developer_status)} definitions={PERSONAL_FINDING_STATUSES} /></div>
        <Info label="Finding Category" value={`${finding.finding_type || "Other"}${finding.finding_type_detail ? ` · ${finding.finding_type_detail}` : ""}`} />
        <Info label="Description" value={finding.description || "—"} />
        <Info label="Expected behavior" value={finding.expected_behavior || "—"} />
        {finding.actual_behavior && <Info label="Actual Bassett behavior" value={finding.actual_behavior} />}
        {finding.bassett_turn_id && <Info label="Linked turn" value={finding.bassett_turn_id} />}
        <div className="rounded-xl border p-4">
          <div className="font-semibold text-[var(--navy)] mb-2">Linked Test Runs ({linkedRuns.length})</div>
          {linkedRuns.length ? <div className="space-y-2">{linkedRuns.map((run, index) => <Link key={run.id} to={`/bassett/issues?open=${encodeURIComponent(run.id)}`} className="block rounded-lg border p-2 hover:border-[var(--orange)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--orange)]"><div className="font-semibold text-[var(--orange)]">{run.title || run.question_asked || run.test_id || run.id}{index === 0 && <span className="ml-2 text-[10px] uppercase text-muted-foreground">Primary</span>}</div><div className="mt-1 text-xs text-muted-foreground">{run.result || "Not evaluated"} · {run.bassett_version || "Version not specified"} · {formatTestDate(run.test_date)}</div></Link>)}</div>
            : <span className="text-muted-foreground">No Bassett Test Runs are linked.</span>}
        </div>
        <div className="rounded-xl border p-4">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div><div className="font-semibold text-[var(--navy)]">Follow-Up &amp; Retesting</div><div className="text-xs text-muted-foreground mt-1">Track internal review, ownership, and any validation needed after this finding.</div></div>
            {canWrite && <div className="flex flex-wrap gap-2"><Button size="sm" variant="outline" onClick={() => setStatusForm({ id, status: finding.developer_status || "New", follow_up_action: finding.follow_up_action || "", retest_date: finding.retest_date || "", resolution: finding.resolution || "", note: "" })}>Update Follow-Up</Button>{sourceRun && !["Fixed", "Closed", "Won't Fix", "Duplicate"].includes(finding.developer_status) && <Button size="sm" variant="outline" onClick={startRetest} disabled={submitting}><RefreshCw size={13} /> Start Retest</Button>}</div>}
          </div>
          <div className="mt-4 grid grid-cols-1 gap-4 sm:grid-cols-2">
            <Info label="Workflow status" value={workflowStatusLabel(finding.developer_status)} />
            <Info label="Retest status" value={finding.retest_status || "Pending"} />
            <div className="sm:col-span-2"><AssigneePicker entityType="findings" entityId={finding.id} assigneeId={finding.assignee_id} assigneeName={finding.assignee_name} canWrite={canWrite} onChanged={refresh} /></div>
            <Info label="Follow-up action" value={finding.follow_up_action || "No follow-up action recorded."} />
            <Info label="Target retest date" value={finding.retest_date ? formatTestDate(finding.retest_date) : "Not scheduled"} />
          </div>
          {finding.resolution && <div className="mt-4"><Info label="Resolution / follow-up notes" value={finding.resolution} /></div>}
        </div>
        {(finding.status_history || []).length > 0 && <div className="rounded-xl border p-4"><div className="font-semibold text-[var(--navy)] mb-2">Follow-up &amp; retest history</div><div className="space-y-1.5">{finding.status_history.map((item, index) => <div key={index} className="text-xs text-muted-foreground">{item.from ? workflowStatusLabel(item.from) : "—"} → <b className="text-[var(--navy)]">{workflowStatusLabel(item.to)}</b> · {item.by || "Unknown"}{item.at ? ` · ${new Date(item.at).toLocaleDateString()}` : ""}{item.note ? ` · ${item.note}` : ""}</div>)}</div></div>}
        <div className="rounded-xl border p-4"><Attachments entityType="finding" entityId={finding.id} canWrite={canWrite} /></div>
        <div className="rounded-xl border p-4"><CommentsThread entityType="findings" entityId={finding.id} canWrite={canWrite} /></div>
      </div>}
    </aside>
    {statusForm && <FormModal open onOpenChange={() => setStatusForm(null)} title="Update Follow-Up & Retesting" onSubmit={saveStatus} submitLabel={submitting ? "Saving…" : "Save follow-up"}>
      <Field label="Workflow status"><ListSelect options={config?.finding_statuses || []} value={workflowStatusLabel(statusForm.status)} onChange={(value) => setStatusForm({ ...statusForm, status: value })} /></Field>
      <Field label="Follow-up action"><Textarea rows={3} value={statusForm.follow_up_action} onChange={(event) => setStatusForm({ ...statusForm, follow_up_action: event.target.value })} placeholder="Describe the internal review, monitoring, correction, or validation needed." /></Field>
      <Field label="Target retest date"><Input type="date" value={statusForm.retest_date} onChange={(event) => setStatusForm({ ...statusForm, retest_date: event.target.value })} /></Field>
      <Field label="Resolution / follow-up notes"><Textarea rows={3} value={statusForm.resolution} onChange={(event) => setStatusForm({ ...statusForm, resolution: event.target.value })} /></Field>
      <Field label="History note"><Textarea rows={2} value={statusForm.note} onChange={(event) => setStatusForm({ ...statusForm, note: event.target.value })} placeholder="Optional note explaining this update." /></Field>
    </FormModal>}
    {editForm && <FormModal open onOpenChange={(open) => !open && setEditForm(null)} title="Edit Bassett Finding" onSubmit={saveFinding} submitLabel={submitting ? "Saving…" : "Save Changes"}>
      <Field label="Finding title" required><Input value={editForm.title} onChange={(event) => setEditForm({ ...editForm, title: event.target.value })} /></Field>
      <Field label="Finding Category" required description="Used by Bassett Findings filters and executive reporting."><select aria-label="Edit Finding Category" className="h-9 w-full rounded-md border bg-background px-3 text-sm" value={editForm.finding_type} onChange={(event) => setEditForm({ ...editForm, finding_type: event.target.value, ...(event.target.value.toLowerCase() === "other" ? {} : { finding_type_detail: "" }) })}><option value="">Select a finding category</option>{[...new Set([...(config?.finding_types || []), editForm.finding_type].filter(Boolean))].map((value) => <option key={value} value={value}>{value}</option>)}</select></Field>
      {String(editForm.finding_type).toLowerCase() === "other" && <Field label="Other category explanation" optional><Input value={editForm.finding_type_detail} onChange={(event) => setEditForm({ ...editForm, finding_type_detail: event.target.value })} /></Field>}
      <Field label="Finding description" description="Describe what Bassett did or why this needs follow-up."><Textarea rows={3} value={editForm.description} onChange={(event) => setEditForm({ ...editForm, description: event.target.value })} /></Field>
      <Field label="Expected behavior" description="Describe what Bassett should have done. Editing this does not change the linked test run."><Textarea rows={4} value={editForm.expected_behavior} onChange={(event) => setEditForm({ ...editForm, expected_behavior: event.target.value })} /></Field>
      <Field label="Related Test Runs" description="Select every test run that supports this finding. The original source remains the primary run.">
        <div className="max-h-64 space-y-2 overflow-y-auto rounded-lg border p-3">{availableRuns.length ? availableRuns.map((run) => { const checked = editForm.linked_test_run_ids.includes(run.id); const primary = run.id === sourceRun; return <label key={run.id} className="flex items-start gap-2 rounded-md p-2 hover:bg-muted"><input type="checkbox" className="mt-1" checked={checked} disabled={primary} onChange={(event) => setEditForm((current) => ({ ...current, linked_test_run_ids: event.target.checked ? [...new Set([...current.linked_test_run_ids, run.id])] : current.linked_test_run_ids.filter((runId) => runId !== run.id) }))} /><span><span className="block font-medium text-[var(--navy)]">{run.title || run.question_asked || run.test_id || run.id}{primary ? " (Primary)" : ""}</span><span className="block text-xs text-muted-foreground">{run.result || "Not evaluated"} · {run.bassett_version || "Version not specified"} · {formatTestDate(run.test_date)}</span></span></label>; }) : <p className="text-sm text-muted-foreground">No Bassett Test Runs are available.</p>}</div>
      </Field>
    </FormModal>}
  </div>;
}

function IssueDetail({ id, onClose, onEdit, onRestore, canWrite, canManage, refresh }) {
  const drawerRef = useFocusTrap(true, onClose);
  const [findingLinksForm, setFindingLinksForm] = useState(null);
  const [savingFindingLinks, setSavingFindingLinks] = useState(false);
  const { data: issue, isLoading } = useQuery({ queryKey: ["bassett-issue", id], queryFn: async () => (await api.get(`/bassett/issues/${id}`)).data });
  const { data: availableFindings = [] } = useQuery({ queryKey: ["bassett-findings-for-run-links"], queryFn: async () => (await api.get("/bassett/findings")).data });
  if (isLoading || !issue) return <div className="fixed inset-0 z-40 bg-black/20 flex justify-end" role="presentation"><div ref={drawerRef} tabIndex="-1" role="dialog" aria-modal="true" aria-label="Test Run Details" className="bg-card w-full max-w-xl p-6">Loading Test Run Details…</div></div>;
  const canonicalResult = normalizeEvaluationResult(issue.result);
  const linkedFindings = issue.findings?.length ? issue.findings : issue.finding?.id ? [issue.finding] : [];
  const linkedScenarios = issue.scenarios?.length ? issue.scenarios : issue.scenario ? [issue.scenario] : [];
  const needsFollowUp = ["Needs Improvement", "Fail", "Critical Fail"].includes(canonicalResult) || issue.status === "Blocked";
  const editFindingLinks = () => setFindingLinksForm({
    finding_ids: [...new Set([issue.finding_id, ...(issue.finding_ids || [])].filter(Boolean))],
  });
  const saveFindingLinks = async () => {
    if (savingFindingLinks) return;
    setSavingFindingLinks(true);
    try {
      await api.put(`/bassett/issues/${id}`, withExpectedVersion(issue, { finding_ids: findingLinksForm.finding_ids }));
      toast.success("Linked findings updated");
      setFindingLinksForm(null);
      refresh();
    } catch (error) { toast.error(actionError(error, "Unable to update linked findings")); }
    finally { setSavingFindingLinks(false); }
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
       toast.success("Test run moved to In Review");
       refresh();
     } catch (error) { toast.error(formatApiErrorDetail(error.response?.data?.detail)); }
   };
   const sendForRetest = async () => {
    try { await api.post(`/bassett/issues/${id}/send-for-retest`, {}); toast.success("Test run sent for retest"); refresh(); }
    catch (error) { toast.error(formatApiErrorDetail(error.response?.data?.detail)); }
  };
   return <div className="fixed inset-0 z-40 bg-black/20 flex justify-end" onClick={(event) => event.target === event.currentTarget && onClose()} role="presentation"><aside ref={drawerRef} tabIndex="-1" role="dialog" aria-modal="true" aria-labelledby="bassett-issue-detail-title" className="bg-card h-full w-full max-w-2xl overflow-y-auto p-6 shadow-xl">
     <div className="flex items-start justify-between gap-4 mb-6"><div className="min-w-0"><div className="text-xs uppercase tracking-wide text-muted-foreground">Test Run Details</div><h2 id="bassett-issue-detail-title" className="text-xl font-bold font-display text-[var(--navy)] mt-1 break-words">{issue.title || issue.question_asked}</h2><div className="flex flex-wrap gap-3 mt-2 text-xs"><div><div className="font-semibold uppercase tracking-wide text-muted-foreground">Workflow Status</div><Pill>{issue.status}</Pill></div><div><div className="font-semibold uppercase tracking-wide text-muted-foreground">Test Result</div><Pill tone={canonicalResult === "Fail" || canonicalResult === "Critical Fail" ? "red" : "slate"}>{canonicalResult}</Pill></div><div><div className="font-semibold uppercase tracking-wide text-muted-foreground">Severity</div><Pill tone={severityLabel(issue.severity) === "Critical" ? "red" : severityLabel(issue.severity) === "High" ? "orange" : "slate"}>{severityLabel(issue.severity) || "Not rated"}</Pill></div></div></div><Button type="button" variant="ghost" className="shrink-0" onClick={onClose} aria-label="Close Test Run Details">Close</Button></div>
     <div className="space-y-5 text-sm">
       <Info label="Test type" value={issue.test_type || "Single Prompt"} />
       <Info label="Conversation record" value={issue.conversation_source === "uploaded_conversation" ? `Uploaded Bassett conversation · ${issue.transcript_status === "confirmed" ? "transcript confirmed" : "transcript review required before Model Comparison"}` : "Entered in ZoneQA"} />
       {issue.test_type === "Multi-turn" ? <div className="rounded-xl border p-4">
         <div className="font-semibold text-[var(--navy)] mb-3">Chronological conversation</div>
         <div className="space-y-4">{(issue.turns || []).slice().sort((a, b) => Number(a.order || 0) - Number(b.order || 0)).map((turn, index) => <article key={turn.id} id={`bassett-turn-${turn.id}`} className={`rounded-lg border p-3 ${issue.finding_turn_id === turn.id ? "border-[var(--orange)] bg-orange-50/40" : ""}`}><div className="flex items-center justify-between gap-2"><h3 className="font-semibold text-[var(--navy)]">Turn {index + 1}</h3><span className="text-[11px] text-muted-foreground">ID: {turn.id}</span></div><Info label="Prompt / Question" value={turn.prompt} /><div className="mt-3"><Info label="Bassett Response" value={turn.response} /></div>{turn.citations?.length > 0 && <div className="mt-3"><Info label="Evidence / Source Links" value={turn.citations.join("\n")} /></div>}{turn.evaluator_notes && <div className="mt-3"><Info label="Notes" value={turn.evaluator_notes} /></div>}{issue.finding_turn_id === turn.id && <div className="mt-2 text-xs font-semibold text-[var(--orange)]">Linked finding targets this turn</div>}</article>)}</div>
       </div> : <><Info label="Prompt / Question" value={issue.question_asked || "Stored in the uploaded conversation"} /><Info label="Bassett Response" value={issue.exact_bassett_answer || "Stored in the uploaded conversation"} /></>}
       <Info label="Verified Answer / Gold Standard" value={issue.verified_correct_answer} />
       <Info label="Notes" value={issue.resolution || issue.notes || "No notes recorded."} />
        <details className="rounded-xl border p-4" open={Boolean(linkedFindings.length || issue.evidence_records?.length)}><summary className="cursor-pointer font-semibold text-[var(--navy)]">Linked records · {linkedFindings.length} finding{linkedFindings.length === 1 ? "" : "s"}, {issue.evidence_records?.length || 0} evidence record{issue.evidence_records?.length === 1 ? "" : "s"}</summary><div className="mt-3 grid grid-cols-1 sm:grid-cols-2 gap-3 text-xs"><Info label={`Test Scenarios (${linkedScenarios.length})`} value={linkedScenarios.length ? linkedScenarios.map((scenario, index) => `${scenario.stable_id || scenario.id}${index === 0 ? " (Primary)" : ""}`).join("\n") : "Not linked"} /><Info label={`Bassett Findings (${linkedFindings.length})`} value={linkedFindings.length ? <div className="space-y-1">{linkedFindings.map((finding) => <Link key={finding.id} to={`/bassett/findings?open=${encodeURIComponent(finding.id)}`} className="block font-semibold text-[var(--orange)] hover:underline">{finding.title || "Open Bassett Finding"}{finding.id === issue.finding_id ? " (Primary)" : ""}</Link>)}</div> : "Not linked"} /><Info label={`Ordinance Evidence (${issue.evidence_records?.length || 0})`} value={issue.evidence_records?.length ? <div className="space-y-1">{issue.evidence_records.map((record) => <Link key={record.id} to="/evidence" className="block font-semibold text-[var(--orange)] hover:underline">{record.document_name || record.id}{record.section ? ` · ${record.section}` : ""}</Link>)}</div> : "Not linked"} /><Info label="Bassett version" value={issue.bassett_version || "Not specified"} /><Info label="Tested By" value={issue.reporter || "—"} /></div><div className="flex flex-wrap gap-2 mt-4">{canWrite && <Button size="sm" variant="outline" onClick={editFindingLinks}><ExternalLink size={14} /> Manage Linked Findings</Button>}{needsFollowUp && canWrite && !issue.finding_id && <Button size="sm" variant="outline" onClick={convert}><Flag size={14} /> Create Bassett Finding</Button>}{needsFollowUp && canWrite && issue.finding_id && <Button size="sm" variant="outline" onClick={sendForRetest}>Send for Retest</Button>}</div></details>
      {(issue.definition_snapshots?.length || issue.definition_snapshot || issue.scenario_snapshot) ? <details className="rounded-xl border p-4"><summary className="cursor-pointer font-semibold text-[var(--navy)]">Scenario definitions used for this run</summary><div className="mt-3 space-y-5">{(issue.definition_snapshots?.length ? issue.definition_snapshots : [issue.definition_snapshot || issue.scenario_snapshot]).map((snapshot, index) => <div key={snapshot.id || index} className={index ? "border-t pt-4" : ""}><div className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">{index === 0 ? "Primary scenario" : `Additional scenario ${index}`}</div><ScenarioDefinition scenario={snapshot} /></div>)}</div></details> : <div className="rounded-xl border border-amber-300 bg-amber-50 p-4 text-sm text-amber-900">Legacy execution—definition snapshot unavailable.</div>}
      <details className="rounded-xl border p-4"><summary className="cursor-pointer font-semibold text-[var(--navy)]">Model Comparison options</summary><div className="mt-3">{issue.testcase_id ? <Link to={`/testcases/${issue.testcase_id}`} className="inline-flex h-8 items-center justify-center rounded-md border border-input px-3 text-xs font-medium shadow-sm hover:bg-accent hover:text-accent-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring">Open Model Comparison Test Case</Link> : canWrite ? <><Button size="sm" onClick={expand}>{issue.conversation_source === "uploaded_conversation" && issue.transcript_status !== "confirmed" ? "Prepare Transcript for Model Comparison" : "Expand to Full Model Comparison"}</Button>{issue.conversation_source === "uploaded_conversation" && issue.transcript_status !== "confirmed" && <p className="mt-2 text-xs text-muted-foreground">Edit this run and enter the prompts and responses. The uploaded file remains attached as the authoritative source.</p>}</> : <span className="text-sm text-muted-foreground">No Model Comparison has been created. This Bassett Test Run remains unchanged.</span>}</div></details>
      <details className="rounded-xl border p-4"><summary className="cursor-pointer font-semibold text-[var(--navy)]">Attachments</summary><div className="mt-3"><Attachments entityType="bassett_issue" entityId={issue.id} canWrite={canWrite && !issue.archived && issue.status !== "Archived"} /></div></details>
      <details className="rounded-xl border p-4"><summary className="cursor-pointer font-semibold text-[var(--navy)]">History ({(issue.history || []).length})</summary><div className="mt-3 space-y-3">{(issue.history || []).map((entry) => <div key={entry.id} className="border-l-2 border-[var(--orange)] pl-3"><div className="font-medium">{entry.action}</div><div className="text-xs text-muted-foreground">{entry.actor} · {new Date(entry.created_at).toLocaleString()}</div></div>)}</div></details>
    </div>
      <div className="mt-6 flex flex-wrap gap-2">{canWrite && !issue.archived && ["Not Started", "New"].includes(issue.status) && <Button type="button" className="bg-[var(--orange)] hover:bg-[var(--orange-600)]" onClick={triage}>Start Review</Button>}{canWrite && !issue.archived && issue.status !== "Archived" && <Button type="button" className="bg-[var(--navy)]" onClick={() => onEdit(issue)}>Edit Test Run</Button>}</div>
     {canManage && (issue.archived || issue.status === "Archived") && <Button type="button" className="mt-6" variant="outline" onClick={() => onRestore(issue)}><ArchiveRestore size={15} /> Restore Test Run</Button>}
     {findingLinksForm && <FormModal open onOpenChange={(open) => !open && setFindingLinksForm(null)} title="Manage Linked Findings" onSubmit={saveFindingLinks} submitLabel={savingFindingLinks ? "Saving…" : "Save Links"}>
       <p className="text-sm text-muted-foreground">Select every distinct finding supported by this test run. The original primary finding remains selected for compatibility.</p>
       <div className="max-h-72 space-y-2 overflow-y-auto rounded-lg border p-3">{availableFindings.length ? availableFindings.map((finding) => { const checked = findingLinksForm.finding_ids.includes(finding.id); const primary = finding.id === issue.finding_id; return <label key={finding.id} className="flex items-start gap-2 rounded-md p-2 hover:bg-muted"><input type="checkbox" className="mt-1" checked={checked} disabled={primary} onChange={(event) => setFindingLinksForm((current) => ({ finding_ids: event.target.checked ? [...new Set([...current.finding_ids, finding.id])] : current.finding_ids.filter((findingId) => findingId !== finding.id) }))} /><span><span className="block font-medium text-[var(--navy)]">{finding.title || finding.id}{primary ? " (Primary)" : ""}</span><span className="block text-xs text-muted-foreground">{finding.finding_type || "Finding"} · {severityLabel(finding.severity) || "Not rated"} · {finding.developer_status || "New"}</span></span></label>; }) : <p className="text-sm text-muted-foreground">No Bassett findings are available. Create a finding first, then return here to link it.</p>}</div>
     </FormModal>}
  </aside></div>;
}
function Info({ label, value }) { return <div><div className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground mb-1">{label}</div><div className="whitespace-pre-wrap">{value}</div></div>; }

export { ScenarioSelector, ScenarioDefinition, BassettFindingDetail, actionError, loadBassettTestRunForEdit };

