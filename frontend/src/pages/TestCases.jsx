import { useEffect, useRef, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { api, formatApiErrorDetail, withExpectedVersion, staleUpdateMessage } from "../lib/api";
import { useConfig, useSave, useCollection, useSavedView } from "../lib/hooks";
import {
  ALL_TEST_CASES,
  DEFAULT_TEST_CASE_SORT,
  DEFAULT_TEST_CASE_VIEW,
  TEST_CASE_COLUMNS,
  TEST_CASE_VISIBLE_COLUMN_OPTIONS,
  normalizeTestCaseView,
} from "../lib/testCaseDescriptors";
import { useAuth } from "../lib/auth";
import { PageHeader } from "../components/shared";
import { CritBadge, ResultBadge } from "../components/shared";
import { FormModal, Field, SelectOrAdd, ListSelect, DimSelect } from "../components/forms";
import UnifiedTestEntryForm, { createComparisonTestDraft } from "../components/UnifiedTestEntryForm";
import { ImportCsvModal } from "../components/ImportCsvModal";
import { SortableTableHeader } from "../components/SortableTableHeader";
import { TableSortControls } from "../components/TableSortControls";
import { TestCaseActions } from "../components/TestCaseActions";
import { nextSort, sortTableRows, usePersistentTableSort } from "../lib/tableSorting";
import { downloadCsv, tableRowsToCsv, withinDateRange } from "../lib/tableData";
import { formatTestDate } from "../lib/testDates";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import { Textarea } from "../components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../components/ui/select";
import { Popover, PopoverContent, PopoverTrigger } from "../components/ui/popover";
import { Checkbox } from "../components/ui/checkbox";
import { Download, Plus, Trash2, X, Upload, SlidersHorizontal, Columns3 } from "lucide-react";
import { toast } from "sonner";
import { focusFormError, validateTestCaseDraft } from "../lib/formValidation";
import {
  TABLE_ACTION_CELL_CLASS, TABLE_CELL_CLASS, TABLE_CLASS, TABLE_EMPTY_CELL_CLASS,
  TABLE_FRAME_CLASS, TABLE_HEAD_CLASS,
} from "../lib/tableStyles";
import { QueryState } from "../components/PageState";

const MUNI_ADD = [{ key: "name", label: "Municipality" }, { key: "state", label: "State" }];
export { TEST_CASE_COLUMNS };

export default function TestCases() {
  const nav = useNavigate();
  const { user } = useAuth();
  const canWrite = user && user.role !== "viewer";
  const [sp, setSp] = useSearchParams();
  const q = (sp.get("q") || "").toLowerCase();
  const { data: config } = useConfig();
  const { state: view, updateState: updateView, error: viewError, retry: retryView, loading: viewLoading } = useSavedView(
    "testcases", DEFAULT_TEST_CASE_VIEW, normalizeTestCaseView,
  );
  const { data = [], isLoading, isError, error, refetch } = useQuery({ queryKey: ["tc-enriched", view.filters.archived], queryFn: async () => (await api.get(`/list/testcases-enriched?include_archived=${view.filters.archived !== "active"}`)).data });
  const projectsQuery = useCollection("projects");
  const { data: projects = [] } = projectsQuery;
  const { data: scenarios = [] } = useQuery({ queryKey: ["bassett-scenarios"], queryFn: async () => (await api.get("/bassett/test-bank")).data });
  const { data: municipalities = [] } = useQuery({ queryKey: ["municipalities"], queryFn: async () => (await api.get("/municipalities")).data });
  const { data: properties = [] } = useQuery({ queryKey: ["properties"], queryFn: async () => (await api.get("/properties")).data });
  const { data: users = [] } = useQuery({ queryKey: ["users"], queryFn: async () => (await api.get("/users")).data });
  const { data: versions = [] } = useQuery({ queryKey: ["versions"], queryFn: async () => (await api.get("/versions")).data });
  const save = useSave("testcases");
  const [open, setOpen] = useState(false);
  const [importOpen, setImportOpen] = useState(false);
  const [f, setF] = useState(null);
  const [formErrors, setFormErrors] = useState({});
  const [serverError, setServerError] = useState("");
  const [conflict, setConflict] = useState(null);
  const submitInFlight = useRef(false);
  const formBaseline = useRef(null);
  const [sort, setSort] = usePersistentTableSort("testcases", TEST_CASE_COLUMNS, DEFAULT_TEST_CASE_SORT);
  const setFilter = (k, val) => updateView({ ...view, filters: { ...view.filters, [k]: val } });
  const toggleCol = (k) => updateView({ ...view, cols: { ...view.cols, [k]: !view.cols[k] } });
  const activeFilters = Object.entries(view.filters).filter(([key, value]) => value && value !== ALL_TEST_CASES && !(key === "archived" && value === "active")).length;
  useEffect(() => {
    const selected = view.filters.project_id;
    if (viewLoading || projectsQuery.isLoading || selected === ALL_TEST_CASES || projects.some((project) => project.id === selected)) return;
    updateView((current) => ({ ...current, filters: { ...current.filters, project_id: ALL_TEST_CASES } }));
  // updateView is stable for the mounted saved-view owner.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view.filters.project_id, viewLoading, projectsQuery.isLoading, projects]);
  const clearFilters = () => {
    updateView({ ...view, filters: DEFAULT_TEST_CASE_VIEW.filters });
    if (sp.has("q")) {
      const params = new URLSearchParams(sp);
      params.delete("q");
      setSp(params);
    }
  };

  const openNew = () => {
    const draft = createComparisonTestDraft({}, config?.application_timezone);
    setF(draft);
    formBaseline.current = draft;
    setFormErrors({});
    setServerError("");
    setConflict(null);
    setOpen(true);
  };
  const openEdit = (testcase) => {
    api.get(`/testcases/${testcase.id}/full`)
      .then(({ data }) => openComparisonEdit(data))
      .catch((error) => toast.error(formatApiErrorDetail(error?.response?.data?.detail) || "Unable to open the comparison workflow."));
  };
  const openComparisonEdit = (full) => {
    const testcase = full.testcase || full;
    const responses = Object.fromEntries((full.responses || []).map((response) => [response.model, response]));
    const evaluations = Object.fromEntries((full.evaluations || []).map((evaluation) => [evaluation.model, evaluation]));
    const bassettResponse = responses.Bassett?.response || "";
    const gold = full.gold_standard || full.goldstandard || {};
    const draft = {
      ...createComparisonTestDraft({}, config?.application_timezone),
      ...testcase,
      id: testcase.id,
      name: testcase.name || "",
      question_asked: testcase.prompts?.[0]?.text || "",
      gold_standard_answer: gold.answer || gold.verified_correct_answer || "",
      verified_correct_answer: gold.answer || gold.verified_correct_answer || "",
      exact_bassett_answer: bassettResponse,
      responses, evaluations,
      evaluation_scores: evaluations.Bassett?.scores || {},
      result: evaluations.Bassett?.final_result || testcase.bassett_result || "Not Evaluated",
      comparison: {
        comparison_result: testcase.comparison_result || "Incomplete",
        comparison_classification: testcase.comparison_classification || "Incomplete",
        competitive_advantage: testcase.competitive_advantage || "",
        competitive_gap: testcase.competitive_gap || "",
        findings: (full.findings || []).filter((finding) => finding.finding_scope === "comparison"),
      },
      expected_revision: testcase.revision || 1,
      expected_updated_at: testcase.updated_at,
      attachments: [],
    };
    setF(draft);
    formBaseline.current = draft;
    setFormErrors({});
    setServerError("");
    setConflict(null);
    setOpen(true);
  };
  const editRequested = sp.get("edit");
  const loadedEdit = useRef("");
  useEffect(() => {
    if (!editRequested || loadedEdit.current === editRequested || !canWrite) return;
    loadedEdit.current = editRequested;
    api.get(`/testcases/${editRequested}/full`).then(({ data }) => {
      openComparisonEdit(data);
      const next = new URLSearchParams(sp);
      next.delete("edit"); next.delete("mode"); next.delete("from_bassett");
      setSp(next, { replace: true });
    }).catch((error) => toast.error(formatApiErrorDetail(error?.response?.data?.detail) || "Unable to open the comparison workflow."));
  }, [editRequested, canWrite]); // eslint-disable-line react-hooks/exhaustive-deps
  const set = (k, v) => {
    setF((s) => ({ ...s, [k]: v }));
    setFormErrors((errors) => {
      if (!errors[k]) return errors;
      const next = { ...errors };
      delete next[k];
      return next;
    });
    setServerError("");
  };
  const setPrompt = (i, v) => {
    setF((s) => { const p = [...s.prompts]; p[i] = { ...p[i], text: v }; return { ...s, prompts: p }; });
    setFormErrors((errors) => {
      if (!errors.prompts) return errors;
      const next = { ...errors };
      delete next.prompts;
      return next;
    });
    setServerError("");
  };
  const addPrompt = () => setF((s) => ({ ...s, prompts: [...s.prompts, { turn: s.prompts.length + 1, text: "" }] }));
  const rmPrompt = (i) => setF((s) => ({ ...s, prompts: s.prompts.filter((_, x) => x !== i).map((p, x) => ({ ...p, turn: x + 1 })) }));
  const addEB = () => setF((s) => ({ ...s, expected_behaviors: [...s.expected_behaviors, { text: "", status: "Not Met" }] }));
  const setEB = (i, v) => setF((s) => { const e = [...s.expected_behaviors]; e[i] = { ...e[i], text: v }; return { ...s, expected_behaviors: e }; });

  const submit = () => {
    if (submitInFlight.current || save.isPending) return false;
    const errors = f.id ? {} : validateTestCaseDraft(f);
    if (Object.keys(errors).length > 0) {
      setFormErrors(errors);
      setServerError("Complete the required fields before saving. Your entries are still here.");
      setTimeout(() => focusFormError(Object.keys(errors)[0]), 0);
      return;
    }
    setFormErrors({});
    setServerError("");
    submitInFlight.current = true;
    if (!f.id) {
      const body = { testcase: { ...f }, gold_standard: { answer: f.gold_standard_answer || f.verified_correct_answer }, responses: f.responses || {}, evaluations: f.evaluations || {}, comparison: f.comparison || {}, submission_id: f.submission_id };
      delete body.testcase.attachments;
      const payload = new FormData();
      payload.append("payload", JSON.stringify(body));
      (f.attachments || []).forEach((file) => payload.append("files", file));
      api.post("/testcases/workflow", payload).then(({ data: r }) => {
        submitInFlight.current = false; setOpen(false); setF(null); setConflict(null);
        toast.success("Model comparison created"); nav(`/testcases/${r.testcase.id}`);
      }).catch((error) => { submitInFlight.current = false; setServerError(`Your entries are still here. ${formatApiErrorDetail(error?.response?.data?.detail) || "Unable to create model comparison."}`); toast.error(formatApiErrorDetail(error?.response?.data?.detail) || "Unable to create model comparison."); });
      return true;
    }
    if (f.id) {
      const body = {
        testcase: { ...f },
        responses: f.responses || {},
        evaluations: f.evaluations || {},
        comparison: f.comparison || {},
        source_bassett_issue_id: f.source_bassett_issue_id,
        expected_revision: f.expected_revision,
      };
      delete body.testcase.attachments;
      const workflowPayload = new FormData();
      workflowPayload.append("payload", JSON.stringify(body));
      (f.attachments || []).forEach((file) => workflowPayload.append("files", file));
      api.post(`/testcases/${f.id}/comparison-workflow`, workflowPayload).then(() => {
        submitInFlight.current = false; setOpen(false); setF(null); setConflict(null);
        toast.success("Model comparison updated");
        nav(`/testcases/${f.id}`);
      }).catch((error) => {
        submitInFlight.current = false;
        if (error?.response?.status === 409) {
          Promise.resolve(api.get(`/testcases/${f.id}/full`))
            .then(({ data: latest } = {}) => setConflict(latest || { testcase: { revision: error?.response?.data?.detail?.current_revision } }))
            .catch(() => setConflict({ revision: error?.response?.data?.detail?.current_revision }));
          setServerError(staleUpdateMessage(error) || "Someone else saved this test case first. Your entries are still here.");
          return;
        }
        setServerError(`Your entries are still here. ${formatApiErrorDetail(error?.response?.data?.detail) || "Unable to update model comparison."}`);
        toast.error(formatApiErrorDetail(error?.response?.data?.detail) || "Unable to update model comparison.");
      });
      return true;
    }
    return true;
  };
  const setDateFilter = (key, value) => {
    const other = key === "date_from" ? view.filters.date_to : view.filters.date_from;
    if (value && other && (key === "date_from" ? value > other : value < other)) {
      toast.error("Start date must be on or before end date.");
      return;
    }
    setFilter(key, value);
  };
  const exportRows = () => {
    try {
      downloadCsv("zoneqa-testcases.csv", tableRowsToCsv(sortedRows, activeSortColumns));
      toast.success(`Exported ${sortedRows.length} test case${sortedRows.length === 1 ? "" : "s"}.`);
    } catch (error) { toast.error("Unable to export test cases. Please retry."); }
  };

  const rows = data.filter((t) => {
    const searchable = [
      t.id, t.name, t.municipality_name, t.municipality, t.project_name, t.project,
      t.category, t.scenario, t.purpose,
      ...(t.prompts || []).map((prompt) => typeof prompt === "string" ? prompt : prompt?.text),
      ...(t.expected_behaviors || []).map((behavior) => typeof behavior === "string" ? behavior : behavior?.text),
    ].filter(Boolean).join(" ").toLowerCase();
    if (q && !searchable.includes(q)) return false;
    const fl = view.filters;
    if (fl.status !== ALL_TEST_CASES && t.status !== fl.status) return false;
    if (fl.category !== ALL_TEST_CASES && t.category !== fl.category) return false;
    if (fl.criticality !== ALL_TEST_CASES && String(t.criticality) !== fl.criticality) return false;
    if (fl.project_id !== ALL_TEST_CASES && t.project_id !== fl.project_id) return false;
    if (fl.archived === "archived" && !t.archived) return false;
    if (fl.archived === "active" && t.archived) return false;
    if (!withinDateRange(t.test_date, fl.date_from, fl.date_to)) return false;
    return true;
  });

  const activeSortColumns = TEST_CASE_COLUMNS
    .map((column) => column.key === "status" ? { ...column, order: config?.test_statuses || [] } : column)
    .filter((column) => column.key === "name" || view.cols[column.key]);
  const effectiveSort = activeSortColumns.some((column) => column.key === sort.key) ? sort : DEFAULT_TEST_CASE_SORT;
  const sortedRows = sortTableRows(rows, activeSortColumns, effectiveSort, ["name", "id"]);
  const formDirty = Boolean(f && formBaseline.current && JSON.stringify(f) !== JSON.stringify(formBaseline.current));

  return (
    <div>
      <PageHeader title="Model Comparison Test Cases" subtitle="Standard test cases for full Bassett vs ChatGPT vs Claude comparisons, evaluated against Gold Standards.">
        <Button variant="outline" onClick={exportRows} aria-label={`Export ${sortedRows.length} filtered Test Cases as CSV`}><Download size={15} className="mr-1" /> Export</Button>
        {canWrite && <Button data-testid="import-csv-btn" variant="outline" onClick={() => setImportOpen(true)}><Upload size={15} className="mr-1" /> Import CSV</Button>}
        {canWrite && <Button data-testid="add-testcase-btn" onClick={openNew} className="bg-[var(--orange)] hover:bg-[var(--orange-600)]"><Plus size={16} className="mr-1" /> New Test Case</Button>}
      </PageHeader>
      {canWrite && <ImportCsvModal open={importOpen} onOpenChange={setImportOpen} />}
      {viewError && <div role="alert" className="mb-3 rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900">{viewError} <button type="button" className="ml-2 font-semibold underline" onClick={retryView}>Retry saved view</button></div>}

      <div className="flex items-center gap-2 mb-3 flex-wrap" data-testid="tc-filter-bar">
        <SlidersHorizontal size={15} className="text-muted-foreground" />
        <Select value={view.filters.status} onValueChange={(v) => setFilter("status", v)}>
          <SelectTrigger className="h-8 w-40 text-xs" data-testid="filter-status"><SelectValue /></SelectTrigger>
          <SelectContent><SelectItem value={ALL_TEST_CASES}>All statuses</SelectItem>{(config?.test_statuses || []).map((s) => <SelectItem key={s} value={s}>{s}</SelectItem>)}</SelectContent>
        </Select>
        <Select value={view.filters.category} onValueChange={(v) => setFilter("category", v)}>
          <SelectTrigger className="h-8 w-48 text-xs" data-testid="filter-category"><SelectValue /></SelectTrigger>
          <SelectContent><SelectItem value={ALL_TEST_CASES}>All categories</SelectItem>{(config?.categories || []).map((c) => <SelectItem key={c} value={c}>{c}</SelectItem>)}</SelectContent>
        </Select>
        <Select value={view.filters.criticality} onValueChange={(v) => setFilter("criticality", v)}>
          <SelectTrigger className="h-8 w-36 text-xs" data-testid="filter-criticality"><SelectValue /></SelectTrigger>
          <SelectContent><SelectItem value={ALL_TEST_CASES}>All criticality</SelectItem>{["1", "2", "3", "4", "5"].map((c) => <SelectItem key={c} value={c}>Criticality {c}</SelectItem>)}</SelectContent>
        </Select>
        <Select value={view.filters.project_id} onValueChange={(v) => setFilter("project_id", v)}>
          <SelectTrigger className="h-8 w-44 text-xs" data-testid="filter-project"><SelectValue /></SelectTrigger>
          <SelectContent><SelectItem value={ALL_TEST_CASES}>All projects</SelectItem>{projects.map((p) => <SelectItem key={p.id} value={p.id}>{p.name}</SelectItem>)}</SelectContent>
        </Select>
        <Select value={view.filters.archived} onValueChange={(v) => setFilter("archived", v)}>
          <SelectTrigger className="h-8 w-36 text-xs" data-testid="filter-archived"><SelectValue /></SelectTrigger>
          <SelectContent><SelectItem value="active">Active</SelectItem><SelectItem value="archived">Archived</SelectItem><SelectItem value="all">All</SelectItem></SelectContent>
        </Select>
        <label className="text-xs text-muted-foreground">Test Date from <Input type="date" value={view.filters.date_from} onChange={(event) => setDateFilter("date_from", event.target.value)} className="h-8 w-36 text-xs" aria-label="Test Date from" /></label>
        <label className="text-xs text-muted-foreground">to <Input type="date" value={view.filters.date_to} onChange={(event) => setDateFilter("date_to", event.target.value)} className="h-8 w-36 text-xs" aria-label="Test Date to" /></label>
        {(activeFilters > 0 || q) && (
          <button className="text-xs text-[var(--orange)] font-semibold hover:underline flex items-center gap-1" onClick={clearFilters} data-testid="clear-filters-btn">
            <X size={12} /> Clear ({activeFilters + (q ? 1 : 0)})
          </button>
        )}
        <span className="text-xs text-muted-foreground ml-auto">{rows.length} of {data.length} tests · view saved to your account</span>
        <Popover>
          <PopoverTrigger asChild>
            <Button variant="outline" size="sm" className="h-8 text-xs" data-testid="columns-btn"><Columns3 size={13} className="mr-1" /> Columns</Button>
          </PopoverTrigger>
          <PopoverContent align="end" className="w-52">
            <div className="text-xs font-semibold text-muted-foreground uppercase mb-2">Visible columns</div>
            <div className="space-y-2">
              {TEST_CASE_VISIBLE_COLUMN_OPTIONS.map(({ key, label }) => (
                <label key={key} className="flex items-center gap-2 text-sm cursor-pointer" data-testid={`col-toggle-${key}`}>
                  <Checkbox checked={!!view.cols[key]} onCheckedChange={() => toggleCol(key)} /> {label}
                </label>
              ))}
            </div>
          </PopoverContent>
        </Popover>
      </div>
      <TableSortControls columns={activeSortColumns} sort={effectiveSort} setSort={setSort} defaultSort={DEFAULT_TEST_CASE_SORT} className="mb-3" />

      {(isLoading || isError) && <QueryState query={{ isLoading, isError, error, refetch }} resource="test cases" onRetry={refetch} testId="testcases" />}
      {!isLoading && !isError && <div className={TABLE_FRAME_CLASS} data-testid="testcases-table-scroll">
        <table className={TABLE_CLASS}>
          <thead className={TABLE_HEAD_CLASS}>
            <tr>{activeSortColumns.map((column) => <SortableTableHeader key={column.key} column={column} sort={effectiveSort} onSort={(key) => setSort((current) => nextSort(current, key))} className="px-4 font-semibold text-xs" />)}<th className="px-2 text-right">Actions</th></tr>
          </thead>
          <tbody>
            {sortedRows.map((t) => (
              <tr key={t.id} data-testid="testcase-row" className="border-t hover:bg-[var(--paper)]">
                <td className={`${TABLE_CELL_CLASS} font-semibold text-[var(--navy)]`}><button type="button" className="w-full text-left rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--orange)] focus-visible:ring-offset-2" onClick={() => nav(`/testcases/${t.id}`)} aria-label={`Open ${t.name}`}>{t.name}</button></td>
                {view.cols.project && <td className={`${TABLE_CELL_CLASS} text-muted-foreground`}>{t.project_name || "—"}</td>}
                {view.cols.municipality && <td className={TABLE_CELL_CLASS}>{t.municipality_name || "—"}</td>}
                {view.cols.category && <td className={TABLE_CELL_CLASS}>{t.category || "—"}</td>}
                {view.cols.crit && <td className={TABLE_CELL_CLASS}><CritBadge value={t.criticality} /></td>}
                {view.cols.status && <td className={TABLE_CELL_CLASS}>{t.status}</td>}
                {view.cols.result && <td className={TABLE_CELL_CLASS}><ResultBadge value={t.bassett_result} /></td>}
                {view.cols.test_date && <td className={TABLE_CELL_CLASS}><time dateTime={t.test_date || undefined}>{formatTestDate(t.test_date)}</time></td>}
                 <td className={TABLE_ACTION_CELL_CLASS}>{canWrite && <TestCaseActions testcase={t} user={user} onEdit={openEdit} compact />}</td>
              </tr>
            ))}
            {rows.length === 0 && <tr><td colSpan={activeSortColumns.length + 1} className={TABLE_EMPTY_CELL_CLASS}>{data.length === 0 ? "No test cases have been created yet." : "No test cases match the current filters."}{data.length > 0 && <Button size="sm" variant="outline" className="ml-3" onClick={clearFilters}>Clear filters</Button>}</td></tr>}
          </tbody>
        </table>
      </div>}

      {f && <UnifiedTestEntryForm
        mode="comparison" form={f} setForm={setF} scenarios={scenarios} versions={versions}
        projects={projects} municipalities={municipalities} properties={properties} users={users}
        config={config} onSubmit={submit} onCancel={() => { setConflict(null); setF(null); }}
        submitting={save.isPending || submitInFlight.current}
        lockedCommon={Boolean(f.source_bassett_issue_id)}
        conflictNotice={(serverError || conflict) && <div role="alert" className="rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-800">
          <p className="font-semibold">{serverError || "This comparison changed elsewhere. Your entries are still open."}</p>
          {conflict && <div className="mt-2 flex flex-wrap gap-2">
            <Button type="button" size="sm" variant="outline" onClick={() => {
              openComparisonEdit(conflict.testcase ? conflict : { testcase: conflict });
            }}>Load latest values</Button>
            <Button type="button" size="sm" onClick={() => {
              const latest = conflict.testcase || conflict;
              setF((draft) => ({
                ...draft,
                expected_revision: latest.revision || 1,
                expected_updated_at: latest.updated_at,
              }));
              setConflict(null);
              setServerError("");
            }}>Keep my entries and reapply</Button>
          </div>}
        </div>}
      />}
    </div>
  );
}
