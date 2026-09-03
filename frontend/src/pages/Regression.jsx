import { useEffect, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api, formatApiErrorDetail, staleUpdateMessage, withExpectedVersion } from "../lib/api";
import { useAuth } from "../lib/auth";
import { PageHeader, StatCard, ResultBadge, StatusBadge } from "../components/shared";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import { Textarea } from "../components/ui/textarea";
import { FormModal, Field, ListSelect } from "../components/forms";
import { Select, SelectTrigger, SelectValue, SelectContent, SelectItem } from "../components/ui/select";
import { CheckCircle2, XCircle, TrendingUp, TrendingDown, Play, Plus, Pencil, Lock, ChevronDown, ChevronRight } from "lucide-react";
import { toast } from "sonner";
import { SortableTableHeader } from "../components/SortableTableHeader";
import { TableSortControls } from "../components/TableSortControls";
import { nextSort, sortTableRows, usePersistentTableSort } from "../lib/tableSorting";
import { formatTestDate, todayInTimeZone } from "../lib/testDates";
import { TABLE_CLASS, TABLE_FRAME_CLASS, TABLE_HEAD_CLASS } from "../lib/tableStyles";
import { REGRESSION_DELTA_STATUSES, REGRESSION_RUN_STATUSES } from "../lib/statusMaps";
import { QueryState } from "../components/PageState";
const RUN_COLUMNS = [
  { key: "bassett_version", label: "Bassett Version", type: "version" },
  { key: "suite_name", label: "Suite", type: "text" },
  { key: "test_date", label: "Regression Run Date", type: "date", getValue: (row) => row.test_date || (row.run_date || row.created_at || "").slice(0, 10) },
  { key: "execution_date", label: "Recorded on", type: "date", getValue: (row) => (row.run_date || row.created_at || "").slice(0, 10) },
  { key: "total", label: "Total", type: "count" },
  { key: "passed", label: "Passed", type: "count" },
  { key: "failed", label: "Failed", type: "count" },
  { key: "improved", label: "Improved", type: "count" },
  { key: "worsened", label: "Regressed", type: "count" },
  { key: "baseline_version", label: "Baseline", type: "version" },
];
const RESULT_COLUMNS = [
  { key: "testcase_name", label: "Test Case", type: "natural" },
  { key: "baseline_result", label: "Baseline", type: "status" },
  { key: "result", label: "Current", type: "status" },
  { key: "score", label: "Score", type: "score" },
  { key: "delta", label: "Change", type: "status", order: ["regressed", "still_fail", "new", "unchanged", "still_pass", "improved", "not_evaluated"] },
];

function DeltaChip({ delta }) {
  return <StatusBadge value={delta} definitions={REGRESSION_DELTA_STATUSES} compact testId={`delta-${delta}`} />;
}

export function RunDetail({ run }) {
  const defaultSort = { key: "testcase_name", direction: "asc" };
  const [sort, setSort] = usePersistentTableSort(`regression-results-${run.id}`, RESULT_COLUMNS, defaultSort);
  if (!run.results) {
    return <div className="flex items-center gap-2 px-4 py-3 text-sm text-muted-foreground bg-[var(--paper)]"><StatusBadge value="Legacy Run" definitions={REGRESSION_RUN_STATUSES} compact /> Per-test snapshot was not recorded for runs created before suite execution was operationalized.</div>;
  }
  return (
    <div className="bg-[var(--paper)] px-4 py-3" data-testid="run-detail">
      <div className="text-xs text-muted-foreground mb-2">
        Baseline: {run.baseline_version ? <b className="text-[var(--navy)]">{run.baseline_version}</b> : "none (first snapshot run)"}
        {run.notes && <span> · Notes: {run.notes}</span>}
        {run.environment && <span> · {run.environment}</span>}
        <span> · Executed by {run.created_by}</span>
      </div>
      <TableSortControls columns={RESULT_COLUMNS} sort={sort} setSort={setSort} defaultSort={defaultSort} className="mb-2" />
      <div className="overflow-x-auto rounded-lg border bg-card" data-testid="regression-results-table-scroll" role="region" aria-label="Regression result details table" tabIndex="0">
      <table className={TABLE_CLASS}>
        <thead className="text-left"><tr className="border-b">
          {RESULT_COLUMNS.map((column) => <SortableTableHeader key={column.key} column={column} sort={sort} onSort={(key) => setSort((current) => nextSort(current, key))} />)}
        </tr></thead>
        <tbody>
          {sortTableRows(run.results, RESULT_COLUMNS, sort, ["testcase_name"]).map((r) => (
            <tr key={r.testcase_id} className="border-b last:border-0" data-testid="run-result-row">
              <td className="px-3 py-2 font-medium text-[var(--navy)]">
                <a href={`/testcases/${r.testcase_id}`} className="hover:underline" onClick={(e) => e.stopPropagation()}>{r.testcase_name}</a>
              </td>
              <td className="px-3 py-2">{r.baseline_result ? <span className="inline-flex items-center gap-1"><ResultBadge value={r.baseline_result} />{r.baseline_score != null && <span className="text-xs">{r.baseline_score}</span>}</span> : <span className="text-xs text-muted-foreground">—</span>}</td>
              <td className="px-3 py-2"><ResultBadge value={r.result || "Not Evaluated"} /></td>
              <td className="px-3 py-2 text-xs font-semibold">{r.score != null ? r.score : "—"}</td>
              <td className="px-3 py-2"><DeltaChip delta={r.delta} /></td>
            </tr>
          ))}
        </tbody>
      </table>
      </div>
    </div>
  );
}

export default function Regression() {
  const qc = useQueryClient();
  const { user } = useAuth();
  const canWrite = user && user.role !== "viewer";
  const [sp, setSp] = useSearchParams();
  const runsQuery = useQuery({ queryKey: ["regression_runs"], queryFn: async () => (await api.get("/regression_runs")).data });
  const suitesQuery = useQuery({ queryKey: ["regression_suites"], queryFn: async () => (await api.get("/regression_suites")).data });
  const testsQuery = useQuery({ queryKey: ["testcases"], queryFn: async () => (await api.get("/testcases")).data });
  const versionsQuery = useQuery({ queryKey: ["versions"], queryFn: async () => (await api.get("/versions")).data });
  const configQuery = useQuery({ queryKey: ["config"], queryFn: async () => (await api.get("/config")).data });
  const runs = runsQuery.data || [], suites = suitesQuery.data || [], tcs = testsQuery.data || [], versions = versionsQuery.data || [], config = configQuery.data;
  const loading = [runsQuery, suitesQuery, testsQuery, versionsQuery, configQuery].some((query) => query.isLoading);
  const failed = [runsQuery, suitesQuery, testsQuery, versionsQuery, configQuery].find((query) => query.isError);
  const retry = () => [runsQuery, suitesQuery, testsQuery, versionsQuery, configQuery].forEach((query) => query.refetch());

  const [suiteForm, setSuiteForm] = useState(null); // {id?, name, description, testcase_ids, search}
  const [runForm, setRunForm] = useState(null); // {suite, bassett_version, environment, notes, baseline_run_id}
  const [expanded, setExpandedState] = useState(sp.get("run"));
  useEffect(() => setExpandedState(sp.get("run")), [sp]);
  const setExpanded = (id) => {
    setExpandedState(id);
    const params = new URLSearchParams(sp);
    if (id) params.set("run", id);
    else params.delete("run");
    setSp(params);
  };
  const [running, setRunning] = useState(false);
  const [savingSuite, setSavingSuite] = useState(false);
  const defaultRunSort = { key: "execution_date", direction: "desc" };
  const [runSort, setRunSort] = usePersistentTableSort("regression-runs", RUN_COLUMNS, defaultRunSort);

  const chronological = sortTableRows(runs, RUN_COLUMNS, defaultRunSort, ["bassett_version"]);
  const latest = chronological[0];
  const sorted = sortTableRows(runs, RUN_COLUMNS, runSort, ["execution_date", "test_date", "bassett_version"]);

  const saveSuite = async () => {
    if (!suiteForm.name.trim()) return toast.error("Suite name required");
    if (suiteForm.testcase_ids.length === 0) return toast.error("Select at least one test case");
    if (savingSuite) return;
    const payload = { name: suiteForm.name, description: suiteForm.description, testcase_ids: suiteForm.testcase_ids };
    setSavingSuite(true);
    try {
      if (suiteForm.id) await api.put(`/regression_suites/${suiteForm.id}`, withExpectedVersion(suiteForm, payload));
      else await api.post("/regression_suites", payload);
      toast.success(suiteForm.id ? "Suite updated" : "Suite created");
      setSuiteForm(null);
      qc.invalidateQueries({ queryKey: ["regression_suites"] });
    } catch (error) {
      toast.error(staleUpdateMessage(error) || formatApiErrorDetail(error?.response?.data?.detail) || "Unable to save regression suite.");
      if (error?.response?.status === 409) qc.invalidateQueries({ queryKey: ["regression_suites"] });
    } finally { setSavingSuite(false); }
  };

  const executeRun = async () => {
    if (!runForm.bassett_version) return toast.error("Select a Bassett version");
    setRunning(true);
    try {
      const { data: run } = await api.post(`/regression/suites/${runForm.suite.id}/execute`, {
        bassett_version: runForm.bassett_version, environment: runForm.environment,
        notes: runForm.notes, test_date: runForm.test_date, baseline_run_id: runForm.baseline_run_id || null,
      });
      toast.success(`Suite executed on ${run.bassett_version}: ${run.passed} passed, ${run.failed} failed${run.worsened ? `, ${run.worsened} REGRESSED` : ""}`);
      setRunForm(null);
      setExpanded(run.id);
      qc.invalidateQueries({ queryKey: ["regression_runs"] });
    } catch (e) {
      toast.error(e.response?.data?.detail || "Execution failed");
    } finally { setRunning(false); }
  };

  const suiteRuns = (sid) => runs.filter((r) => r.suite_id === sid && r.results);

  return (
    <div>
      <PageHeader title="Regression Testing" subtitle="Bassett release suites rerun against locked historical baselines. This is separate from Bassett-only test runs and model-comparison findings." />
      {failed && <QueryState query={failed} resource="regression data" onRetry={retry} testId="regression" />}
      {loading && !failed && <QueryState query={{ isLoading: true }} resource="regression data" testId="regression" />}
      {!loading && !failed && versions.length === 0 && canWrite && <div className="mb-4 rounded-xl border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900">Create a Bassett version before running a regression suite.</div>}
      {!loading && !failed && expanded && !runs.some((run) => run.id === expanded) && <div role="alert" className="mb-4 rounded-xl border border-amber-300 bg-amber-50 p-3 text-sm text-amber-950">That regression run was not found or is no longer available. <Button size="sm" variant="outline" className="ml-3" onClick={() => setExpanded(null)}>Return to run history</Button></div>}
      {!loading && !failed && (
        <>
      {latest && (
        <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-4 gap-3 mb-6">
          <StatCard label={`Passed (${latest.bassett_version})`} value={latest.passed} accent="#16a34a" icon={CheckCircle2} testid="stat-passed" />
          <StatCard label="Failed" value={latest.failed} accent="#dc2626" icon={XCircle} testid="stat-failed" />
          <StatCard label="Improved vs Baseline" value={latest.improved == null ? "N/A" : latest.improved} sub={latest.improved == null ? "no baseline selected" : undefined} accent="#2f3f96" icon={TrendingUp} testid="stat-improved" />
          <StatCard label="New Regressions" value={latest.newly_failing == null ? "N/A" : latest.newly_failing} sub={latest.newly_failing == null ? "no baseline selected" : undefined} accent="#f47b20" icon={TrendingDown} testid="stat-regressions" />
        </div>
      )}

      <div className="flex items-center justify-between mb-3">
        <h2 className="font-semibold font-display text-[var(--navy)]">Regression Suites</h2>
        {canWrite && (
          <Button size="sm" className="bg-[var(--orange)] hover:bg-[var(--orange-600)]" data-testid="new-suite-btn"
            onClick={() => setSuiteForm({ name: "", description: "", testcase_ids: [], search: "" })}>
            <Plus size={14} className="mr-1" /> New Suite
          </Button>
        )}
      </div>
       {suites.length === 0 && <div className="bg-card border rounded-xl p-6 text-center text-sm text-muted-foreground mb-6">No regression suites have been created yet.</div>}
      {suites.map((s) => (
        <div key={s.id} className="bg-card border rounded-xl p-5 mb-4" data-testid="suite-card">
          <div className="flex items-start justify-between gap-3">
            <div>
              <h3 className="font-semibold font-display text-[var(--navy)]">{s.name}</h3>
              <p className="text-sm text-muted-foreground">{s.description} · {(s.testcase_ids || []).length} tests · {suiteRuns(s.id).length} snapshot run{suiteRuns(s.id).length === 1 ? "" : "s"}</p>
            </div>
            {canWrite && (
              <div className="flex gap-2 shrink-0">
                <Button size="sm" variant="outline" data-testid="edit-suite-btn"
                  onClick={() => setSuiteForm({ id: s.id, name: s.name, description: s.description || "", testcase_ids: s.testcase_ids || [], search: "", revision: s.revision, updated_at: s.updated_at })}>
                  <Pencil size={13} className="mr-1" /> Edit
                </Button>
                <Button size="sm" className="bg-[var(--navy)] hover:bg-[#232f73]" data-testid="run-suite-btn"
                    disabled={versions.length === 0} onClick={() => setRunForm({ suite: s, bassett_version: "", environment: "Production", notes: "", test_date: todayInTimeZone(config?.application_timezone), baseline_run_id: "" })}>
                  <Play size={13} className="mr-1" /> Run Suite
                </Button>
              </div>
            )}
          </div>
        </div>
      ))}

      <h2 className="font-semibold font-display text-[var(--navy)] mb-3 mt-6">Run History <span className="text-xs font-normal text-muted-foreground">— click a row to see the per-test baseline comparison</span></h2>
      <TableSortControls columns={RUN_COLUMNS} sort={runSort} setSort={setRunSort} defaultSort={defaultRunSort} className="mb-3" />
      <div className={TABLE_FRAME_CLASS} data-testid="regression-runs-table-scroll">
        <table className={TABLE_CLASS}>
          <thead className={TABLE_HEAD_CLASS}><tr><th><span className="sr-only">Expand details</span></th>{RUN_COLUMNS.map((column) => <SortableTableHeader key={column.key} column={column} sort={runSort} onSort={(key) => setRunSort((current) => nextSort(current, key))} />)}</tr></thead>
          <tbody>
             {sorted.map((r) => (
              <RunRow key={r.id} r={r} expanded={expanded === r.id} onToggle={() => setExpanded(expanded === r.id ? null : r.id)} />
            ))}
            {sorted.length === 0 && <tr><td colSpan={RUN_COLUMNS.length + 1} className="px-4 py-10 text-center text-sm text-muted-foreground">{suites.length ? "No regression runs have been recorded yet." : "Create a suite before recording a regression run."}</td></tr>}
          </tbody>
        </table>
      </div>

      {suiteForm && (
        <FormModal open onOpenChange={() => !savingSuite && setSuiteForm(null)} title={suiteForm.id ? "Edit Suite" : "New Regression Suite"} onSubmit={saveSuite} submitLabel={savingSuite ? "Saving…" : suiteForm.id ? "Save Suite" : "Create Suite"} wide>
          <Field label="Suite Name"><Input value={suiteForm.name} onChange={(e) => setSuiteForm({ ...suiteForm, name: e.target.value })} data-testid="suite-name-input" placeholder="Core Regression Suite" /></Field>
          <Field label="Description"><Textarea rows={2} value={suiteForm.description} onChange={(e) => setSuiteForm({ ...suiteForm, description: e.target.value })} /></Field>
          <Field label={`Test Cases (${suiteForm.testcase_ids.length} selected)`}>
            <Input value={suiteForm.search} onChange={(e) => setSuiteForm({ ...suiteForm, search: e.target.value })} placeholder="Search tests…" className="mb-2" data-testid="suite-tc-search" />
            <div className="max-h-56 overflow-y-auto border rounded-lg divide-y">
              {tcs.length === 0 && <p className="px-3 py-3 text-sm text-muted-foreground">No test cases are available. Create a test case before building a regression suite.</p>}
              {tcs.filter((t) => t.name.toLowerCase().includes(suiteForm.search.toLowerCase())).map((t) => (
                <label key={t.id} className="flex items-center gap-2 px-3 py-1.5 text-sm cursor-pointer hover:bg-[var(--paper)]" data-testid="suite-tc-option">
                  <input type="checkbox" checked={suiteForm.testcase_ids.includes(t.id)}
                    onChange={(e) => setSuiteForm({ ...suiteForm, testcase_ids: e.target.checked ? [...suiteForm.testcase_ids, t.id] : suiteForm.testcase_ids.filter((x) => x !== t.id) })} />
                  <span className="text-[var(--navy)]">{t.name}</span>
                  <span className="text-[10px] text-muted-foreground ml-auto">{t.category}</span>
                </label>
              ))}
            </div>
          </Field>
        </FormModal>
      )}

      {runForm && (
        <FormModal open onOpenChange={() => !running && setRunForm(null)} title={`Run Suite: ${runForm.suite.name}`} onSubmit={executeRun} submitLabel={running ? "Executing…" : "Execute Suite"}>
          <p className="text-xs text-muted-foreground -mt-1">Snapshots the latest Bassett evaluation of each of the {(runForm.suite.testcase_ids || []).length} tests and compares against the baseline. The run is locked once recorded.</p>
          {suiteRuns(runForm.suite.id).length === 0 && (
            <div className="flex items-start gap-2 text-xs bg-card border rounded-lg p-2" data-testid="no-baseline-warning">
              <StatusBadge value="No Baseline" definitions={REGRESSION_RUN_STATUSES} compact />
              <span>No baseline run exists for this suite yet — Improved / Regressed / Newly Failing / Fixed will be recorded as <b>N/A</b> (not 0) for this first snapshot run.</span>
            </div>
          )}
          <Field label="Bassett Version"><ListSelect options={versions.map((v) => v.name)} value={runForm.bassett_version} onChange={(v) => setRunForm({ ...runForm, bassett_version: v })} placeholder="Select version" testid="run-version-select" /></Field>
          <Field label="Environment"><ListSelect options={["Production", "Staging", "Development"]} value={runForm.environment} onChange={(v) => setRunForm({ ...runForm, environment: v })} /></Field>
          <Field label="Regression Run Date" description="The business date this regression suite represents. Recorded on is the system timestamp created when the run is saved."><Input required type="date" value={runForm.test_date} onChange={(e) => setRunForm({ ...runForm, test_date: e.target.value })} /></Field>
          <Field label="Baseline Run (defaults to latest snapshot)">
            <Select value={runForm.baseline_run_id || "__auto"} onValueChange={(v) => setRunForm({ ...runForm, baseline_run_id: v === "__auto" ? "" : v })}>
              <SelectTrigger data-testid="run-baseline-select"><SelectValue placeholder="Auto — latest snapshot run" /></SelectTrigger>
              <SelectContent>
                <SelectItem value="__auto">Auto — latest snapshot run</SelectItem>
                {suiteRuns(runForm.suite.id).map((r) => <SelectItem key={r.id} value={r.id}>{r.bassett_version} · {r.run_date} ({r.passed}P/{r.failed}F)</SelectItem>)}
              </SelectContent>
            </Select>
          </Field>
          <Field label="Notes"><Textarea rows={2} value={runForm.notes} onChange={(e) => setRunForm({ ...runForm, notes: e.target.value })} placeholder="e.g. v2.0 release candidate check" /></Field>
        </FormModal>
      )}
        </>
      )}
    </div>
  );
}

function RunRow({ r, expanded, onToggle }) {
  return (
    <>
      <tr className={`border-t hover:bg-[var(--paper)]/60 ${expanded ? "bg-[var(--paper)]/60" : ""}`} data-testid="run-row">
        <td className="pl-3 py-3 w-6 text-muted-foreground"><button type="button" className="rounded p-1 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--orange)]" onClick={onToggle} aria-label={`${expanded ? "Collapse" : "Expand"} regression run for ${r.bassett_version}`} aria-expanded={expanded}>{expanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}</button></td>
        <td className="px-4 py-3 font-semibold text-[var(--navy)]">
          <span className="flex items-center gap-1.5">{r.bassett_version}{r.locked && <Lock size={11} className="text-muted-foreground" title="Locked historical record" />}</span>
        </td>
        <td className="px-4 py-3 text-xs text-muted-foreground">{r.suite_name}</td>
         <td className="px-4 py-3"><time dateTime={r.test_date || (r.run_date || r.created_at || "").slice(0, 10) || undefined}>{formatTestDate(r.test_date || (r.run_date || r.created_at || "").slice(0, 10))}</time></td>
         <td className="px-4 py-3"><time dateTime={(r.run_date || r.created_at || "").slice(0, 10) || undefined}>{formatTestDate((r.run_date || r.created_at || "").slice(0, 10))}</time></td>
        <td className="px-4 py-3">{r.total}</td>
        <td className="px-4 py-3 text-green-700 font-semibold">{r.passed}</td>
        <td className="px-4 py-3 text-red-600 font-semibold">{r.failed}</td>
        <td className="px-4 py-3">{r.results && r.improved == null ? <span className="text-xs text-muted-foreground" title="No baseline selected — comparison not computable">N/A</span> : r.improved}</td>
        <td className="px-4 py-3 text-orange-600 font-semibold">{r.results && r.worsened == null ? <span className="text-xs text-muted-foreground font-normal" title="No baseline selected — comparison not computable">N/A</span> : r.worsened}</td>
        <td className="px-4 py-3 text-xs text-muted-foreground">{r.baseline_version || (r.results ? "—" : "legacy")}</td>
      </tr>
      {expanded && <tr><td colSpan={RUN_COLUMNS.length + 1} className="p-0 border-t"><RunDetail run={r} /></td></tr>}
    </>
  );
}
