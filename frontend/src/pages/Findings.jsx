import { useState, useEffect, useRef, useCallback } from "react";
import { useSearchParams, useNavigate } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api, formatApiErrorDetail } from "../lib/api";
import { useConfig } from "../lib/hooks";
import { useSavedView } from "../lib/savedViews";
import { useAuth } from "../lib/auth";
import { PageHeader, CritBadge } from "../components/shared";
import { FINDING_STATUSES, StatusBadge } from "../lib/statusMaps";
import { Attachments } from "../components/Attachments";
import { CommentsThread } from "../components/CommentsThread";
import { AssigneePicker } from "../components/AssigneePicker";
import { Button } from "../components/ui/button";
import { Textarea } from "../components/ui/textarea";
import { FormModal, Field, ListSelect } from "../components/forms";
import { Input } from "../components/ui/input";
import { Columns3, RefreshCw, X } from "lucide-react";
import { toast } from "sonner";
import { QueryState } from "../components/PageState";

const ALL = "__all";
const DEFAULT_FILTERS = { status: ALL, criticality: ALL, type: ALL, retest: ALL, version: ALL };

function normalizeFilters(saved = {}, config, findings) {
  const allowed = {
    status: config?.finding_statuses || [],
    criticality: ["1", "2", "3", "4", "5"],
    type: config?.finding_types || [],
    retest: ["Pending", "In Progress", "Fixed", "Partially Fixed", "Not Fixed"],
    version: [...new Set(findings.map((f) => f.version_found).filter(Boolean))],
  };
  return Object.fromEntries(Object.keys(DEFAULT_FILTERS).map((key) => {
    const value = saved[key];
    return value === ALL || (typeof value === "string" && allowed[key].includes(value)) ? [key, value] : [key, ALL];
  }));
}

export default function Findings() {
  const [sp, setSp] = useSearchParams();
  const nav = useNavigate();
  const qc = useQueryClient();
  const { user } = useAuth();
  const { data: config } = useConfig();
  const findingsQuery = useQuery({ queryKey: ["findings"], queryFn: async () => (await api.get("/findings")).data });
  const { data: findings = [] } = findingsQuery;
  const testcaseFilter = sp.get("testcase_id") || ALL;
  const [sel, setSel] = useState(null);
  const [statusForm, setStatusForm] = useState(null);
  const [retestForm, setRetestForm] = useState(null);
  const { state: savedView, updateState: updateSavedView, error: viewError, retry: retryView } = useSavedView("findings", { filters: DEFAULT_FILTERS });
  const flt = normalizeFilters(savedView?.filters, config, findings);
  const [submitting, setSubmitting] = useState(false);
  const panelRef = useRef(null);
  const closeButtonRef = useRef(null);
  const selectedRowRef = useRef(null);
  const [mobilePanel, setMobilePanel] = useState(false);

  useEffect(() => {
    if (!window.matchMedia) return undefined;
    const media = window.matchMedia("(max-width: 1023px)");
    const update = () => setMobilePanel(media.matches);
    update();
    media.addEventListener?.("change", update);
    return () => media.removeEventListener?.("change", update);
  }, []);

  const setFilter = (key, value) => {
    const next = { ...flt, [key]: value };
    updateSavedView({ filters: next });
  };

  useEffect(() => {
    const id = sp.get("id");
    if (!id) {
      setSel(null);
      return;
    }
    if (findings.length) setSel(findings.find((finding) => finding.id === id) || null);
  }, [sp, findings]);

  const openFinding = (finding, trigger) => {
    selectedRowRef.current = trigger || null;
    const next = new URLSearchParams(sp);
    next.set("id", finding.id);
    setSel(finding);
    setSp(next);
  };

  const closeFinding = useCallback(() => {
    const next = new URLSearchParams(sp);
    next.delete("id");
    setSel(null);
    setSp(next);
    requestAnimationFrame(() => selectedRowRef.current?.focus());
  }, [sp, setSp]);

  useEffect(() => {
    if (!sel || !mobilePanel) return undefined;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    closeButtonRef.current?.focus();
    const onKeyDown = (event) => {
      if (event.key === "Escape") {
        event.preventDefault();
        closeFinding();
        return;
      }
      if (event.key !== "Tab") return;
      const focusable = [...(panelRef.current?.querySelectorAll(
        'button:not([disabled]), a[href], input:not([disabled]), textarea:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])',
      ) || [])].filter((element) => element.getClientRects().length > 0);
      if (!focusable.length) {
        event.preventDefault();
        panelRef.current?.focus();
        return;
      }
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      document.body.style.overflow = previousOverflow;
    };
  }, [sel, mobilePanel, closeFinding]);

  const startRetest = async () => {
    if (submitting) return;
    setSubmitting(true);
    try {
      const { data: rt } = await api.post(`/findings/${retestForm.id}/start-retest`, retestForm);
      toast.success("Retest started — complete it from the test case's Retests tab");
      setRetestForm(null); qc.invalidateQueries();
      nav(`/testcases/${rt.testcase_id}`);
    } catch (error) { toast.error(mutationMessage(error, "Unable to start retest")); }
    finally { setSubmitting(false); }
  };

  const shown = findings.filter((f) =>
    (testcaseFilter === ALL || f.testcase_id === testcaseFilter) &&
    (flt.status === ALL || f.developer_status === flt.status) &&
    (flt.criticality === ALL || String(f.criticality) === flt.criticality) &&
    (flt.type === ALL || f.finding_type === flt.type) &&
    (flt.retest === ALL || (f.retest_status || "Pending") === flt.retest) &&
    (flt.version === ALL || f.version_found === flt.version));
  const filtersActive = Object.values(flt).some((value) => value !== ALL);
  const clearFilters = () => updateSavedView({ filters: DEFAULT_FILTERS });
  const selectedId = sp.get("id");
  const staleSelection = !findingsQuery.isLoading && !findingsQuery.isError && selectedId
    && !findings.some((finding) => finding.id === selectedId);

  const saveStatus = async () => {
    if (submitting) return;
    setSubmitting(true);
    try {
      await api.post(`/findings/${statusForm.id}/status`, statusForm);
      toast.success("Status updated"); setStatusForm(null); qc.invalidateQueries();
      const fresh = (await api.get("/findings")).data; setSel(fresh.find((f) => f.id === statusForm.id));
    } catch (error) { toast.error(mutationMessage(error, "Unable to update status")); }
    finally { setSubmitting(false); }
  };

  return (
    <div>
      <PageHeader title="Model Comparison Findings" subtitle="Findings from full Bassett vs ChatGPT vs Claude comparisons. Bassett-only findings are managed separately in Bassett Test Runs." />
      {viewError && <div role="alert" className="mb-3 rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900">{viewError} <button type="button" className="ml-2 font-semibold underline" onClick={retryView}>Retry saved view</button></div>}
      {(findingsQuery.isLoading || findingsQuery.isError) && <QueryState query={findingsQuery} resource="model comparison findings" testId="findings" />}
      {staleSelection && <div role="alert" className="mb-3 rounded-xl border border-amber-300 bg-amber-50 p-4 text-sm text-amber-950" data-testid="finding-not-found">That finding was not found or is no longer available. <Button size="sm" variant="outline" className="ml-3" onClick={closeFinding}>Return to findings</Button></div>}
      {!findingsQuery.isLoading && !findingsQuery.isError && <>
      <div className="flex items-center gap-2 mb-3 flex-wrap" data-testid="findings-filter-bar">
        {[["status", config?.finding_statuses, "All statuses"], ["criticality", ["1", "2", "3", "4", "5"], "All criticality"], ["type", config?.finding_types, "All types"], ["retest", ["Pending", "In Progress", "Fixed", "Partially Fixed", "Not Fixed"], "All retest states"]].map(([key, opts, label]) => (
          <select key={key} value={flt[key]} onChange={(e) => setFilter(key, e.target.value)} data-testid={`filter-${key}`}
            className="h-8 text-xs border rounded-lg px-2 bg-card text-[var(--navy)]">
            <option value={ALL}>{label}</option>
            {(opts || []).map((o) => <option key={o} value={o}>{key === "criticality" ? `Criticality ${o}` : o}</option>)}
          </select>
        ))}
        <span className="text-xs text-muted-foreground ml-auto">{shown.length} of {findings.length} findings</span>
      </div>
      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(360px,420px)]">
        <div className="space-y-2">
          {shown.length === 0 && <div className="bg-card border rounded-xl p-6 text-center text-sm text-muted-foreground">{findings.length === 0 ? "No model comparison findings have been recorded yet." : "No findings match the current filters."}{filtersActive && <Button size="sm" variant="outline" className="ml-3" onClick={clearFilters}>Clear filters</Button>}</div>}
          {shown.map((f) => (
             <button type="button" key={f.id} onClick={(event) => openFinding(f, event.currentTarget)} data-testid="finding-row"
               aria-label={`View finding ${f.title}`} aria-pressed={sel?.id === f.id}
               className={`w-full text-left bg-card border rounded-xl p-4 card-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--orange)] focus-visible:ring-offset-2 ${sel?.id === f.id ? "border-[var(--orange)] border-2" : ""}`}>
              <div className="flex items-center gap-2 mb-1"><CritBadge value={f.criticality} />
                <StatusBadge value={f.developer_status} definitions={FINDING_STATUSES} />
                <span className="text-xs text-muted-foreground">{f.finding_type}</span>
              </div>
              <div className="font-semibold text-[var(--navy)]">{f.title}</div>
              <div className="text-xs text-muted-foreground mt-1">Root cause: {f.root_cause || "—"} · Found {f.version_found}{f.assignee_name ? <span> · <span className="font-semibold text-[var(--orange)]">@{f.assignee_name}</span></span> : ""}</div>
            </button>
          ))}
        </div>

        {sel && <button type="button" aria-label="Close finding details"
          className="fixed inset-0 z-40 bg-slate-950/40 lg:hidden" onClick={closeFinding} />}
        <aside aria-label="Finding details" aria-labelledby={sel ? "finding-details-heading" : undefined}
          aria-modal={sel && mobilePanel ? "true" : undefined} role={sel && mobilePanel ? "dialog" : undefined}
          ref={panelRef} tabIndex={sel && mobilePanel ? -1 : undefined} data-testid="finding-panel"
          className={sel
            ? "fixed inset-y-0 right-0 z-50 w-full max-w-xl overflow-y-auto bg-background p-4 shadow-2xl lg:static lg:z-auto lg:w-auto lg:max-w-none lg:overflow-visible lg:bg-transparent lg:p-0 lg:shadow-none"
            : "hidden lg:block"}>
          {!sel ? <div className="bg-card border rounded-xl p-8 text-center text-muted-foreground">Select a finding to view details.</div> : (
            <div className="bg-card border rounded-xl p-5 lg:sticky lg:top-20 lg:max-h-[calc(100vh-6rem)] lg:overflow-y-auto">
              <div className="flex items-start justify-between gap-2 mb-3">
                <div>
                  <div className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Finding details</div>
                  <div className="flex items-center gap-2 mt-1"><CritBadge value={sel.criticality} /><span className="text-xs text-muted-foreground">{sel.finding_type}</span></div>
                </div>
                <Button ref={closeButtonRef} type="button" size="icon" variant="ghost" onClick={closeFinding} aria-label="Close finding details">
                  <X size={18} />
                </Button>
              </div>
              <h2 id="finding-details-heading" className="text-lg font-bold font-display text-[var(--navy)] break-words">{sel.title}</h2>
              <Button size="sm" variant="outline" className="mt-3" onClick={() => nav(`/comparison?tc=${sel.testcase_id}`)} data-testid="view-comparison-btn"><Columns3 size={14} className="mr-1" /> View in AI Comparison</Button>
              <div className="mt-2">
                <AssigneePicker entityType="findings" entityId={sel.id} assigneeId={sel.assignee_id} assigneeName={sel.assignee_name} canWrite={user && user.role !== "viewer"} onChanged={(updated) => setSel(updated)} />
              </div>
              <div className="mt-3 space-y-2 text-sm">
                <div><span className="text-xs font-semibold uppercase text-muted-foreground">Description</span><p className="prose-response">{sel.description}</p></div>
                {sel.actual_behavior && <div><span className="text-xs font-semibold uppercase text-muted-foreground">Actual Bassett Behavior</span><p className="prose-response">{sel.actual_behavior}</p></div>}
                <div className="flex flex-wrap gap-1 mt-2">{(sel.failure_modes || []).map((m) => <span key={m} className="text-xs bg-red-50 text-red-700 px-2 py-0.5 rounded-full">{m}</span>)}</div>
              </div>

              <div className="mt-4 border-t pt-4">
                <div className="flex items-center justify-between mb-2">
                  <span className="text-xs font-semibold uppercase text-muted-foreground">Developer Workflow</span>
                  {user && user.role !== "viewer" && <Button size="sm" className="bg-[var(--orange)] hover:bg-[var(--orange-600)]" onClick={() => setStatusForm({ id: sel.id, status: sel.developer_status, root_cause: sel.root_cause, resolution: sel.resolution || "", note: "" })} data-testid="update-status-btn">Update Status</Button>}
                </div>
                <div className="text-sm">Status: <b>{sel.developer_status}</b> · Retest: {sel.retest_status || "Pending"}</div>
                {sel.resolution && <p className="text-sm mt-1 prose-response bg-[var(--paper)] p-2 rounded">{sel.resolution}</p>}
                {user && user.role !== "viewer" && !["Fixed", "Closed", "Won't Fix", "Duplicate"].includes(sel.developer_status) && sel.retest_status !== "In Progress" && (
                  <Button size="sm" variant="outline" className="mt-2 border-[var(--orange)] text-[var(--orange)] hover:bg-orange-50"
                    onClick={() => setRetestForm({ id: sel.id, fix_description: sel.resolution || "", expected_corrected_behavior: sel.recommended_correction || "", new_bassett_version: "" })} data-testid="start-retest-btn">
                    <RefreshCw size={13} className="mr-1" /> Start Retest
                  </Button>
                )}
                {sel.retest_status === "In Progress" && <div className="text-xs text-sky-700 font-semibold mt-2">Retest in progress — complete it on the test case's Retests tab.</div>}
              </div>

              {(sel.status_history || []).length > 0 && (
                <div className="mt-4 border-t pt-3">
                  <span className="text-xs font-semibold uppercase text-muted-foreground">Status History</span>
                  <div className="mt-2 space-y-1.5">{sel.status_history.map((h, i) => (
                    <div key={i} className="text-xs text-muted-foreground">{h.from || "—"} → <b className="text-[var(--navy)]">{h.to}</b> · {h.by} · {new Date(h.at).toLocaleDateString()}{h.note && ` · ${h.note}`}</div>
                  ))}</div>
                </div>
              )}

              <div className="mt-4 border-t pt-4">
                <Attachments entityType="finding" entityId={sel.id} canWrite={user && user.role !== "viewer"} />
              </div>
              <div className="mt-4 border-t pt-4">
                <CommentsThread entityType="findings" entityId={sel.id} canWrite={user && user.role !== "viewer"} />
              </div>
              <Button variant="link" className="px-0 mt-2" onClick={() => nav(`/testcases/${sel.testcase_id}`)}>Open source test case →</Button>
            </div>
          )}
        </aside>
      </div>
      </>}

      {retestForm && (
        <FormModal open onOpenChange={() => setRetestForm(null)} title="Start Retest" onSubmit={startRetest} submitLabel={submitting ? "Starting…" : "Start Retest"}>
          <p className="text-xs text-muted-foreground -mt-1">Captures the original failing context (version, response, evaluation, failure modes) and opens a retest on the source test case.</p>
          <Field label="Fix Description"><Textarea rows={2} value={retestForm.fix_description} onChange={(e) => setRetestForm({ ...retestForm, fix_description: e.target.value })} data-testid="retest-fix-desc" /></Field>
          <Field label="Expected Corrected Behavior"><Textarea rows={2} value={retestForm.expected_corrected_behavior} onChange={(e) => setRetestForm({ ...retestForm, expected_corrected_behavior: e.target.value })} /></Field>
          <Field label="New Bassett Version (if known)"><Input value={retestForm.new_bassett_version} onChange={(e) => setRetestForm({ ...retestForm, new_bassett_version: e.target.value })} placeholder="Bassett v2.0" /></Field>
        </FormModal>
      )}

      {statusForm && (
        <FormModal open onOpenChange={() => setStatusForm(null)} title="Update Developer Status" onSubmit={saveStatus} submitLabel={submitting ? "Saving…" : "Save status"}>
          <Field label="Status"><ListSelect options={config?.finding_statuses} value={statusForm.status} onChange={(v) => setStatusForm({ ...statusForm, status: v })} testid="status-select" /></Field>
          <Field label="Root Cause"><ListSelect options={config?.root_causes} value={statusForm.root_cause} onChange={(v) => setStatusForm({ ...statusForm, root_cause: v })} /></Field>
          <Field label="Resolution"><Textarea rows={3} value={statusForm.resolution} onChange={(e) => setStatusForm({ ...statusForm, resolution: e.target.value })} /></Field>
          <Field label="Note (added to history)"><Textarea rows={2} value={statusForm.note} onChange={(e) => setStatusForm({ ...statusForm, note: e.target.value })} /></Field>
        </FormModal>
      )}
    </div>
  );
}

function mutationMessage(error, fallback) {
  const status = error?.response?.status;
  if (status === 401) return "Your session has expired. Sign in again, then retry.";
  if (status === 403) return "You do not have permission to make this change.";
  if (status === 409) return "This finding changed elsewhere. Refresh and retry.";
  return formatApiErrorDetail(error?.response?.data?.detail) || fallback;
}
