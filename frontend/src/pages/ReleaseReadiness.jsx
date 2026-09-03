import { useState, useEffect } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../lib/api";
import { useAuth } from "../lib/auth";
import { useCollection } from "../lib/hooks";
import { PageHeader, StatCard, CritBadge, ResultBadge, StatusBadge } from "../components/shared";
import { DEMO_STATUSES, FINDING_STATUSES, REGRESSION_DELTA_STATUSES, RELEASE_DECISIONS, readableTextColor, statusDefinition } from "../lib/statusMaps";
import { ListSelect } from "../components/forms";
import { Button } from "../components/ui/button";
import { Textarea } from "../components/ui/textarea";
import { toast } from "sonner";
import { Rocket, ShieldAlert, ShieldCheck, AlertTriangle, Percent, Gauge, Flag, TrendingDown, FlaskConical } from "lucide-react";
import { userRoleLabel } from "../lib/userValidation";
import { ConfirmActionDialog } from "../components/ConfirmActionDialog";
import { QueryState } from "../components/PageState";
import { fmtPct, fmtScore } from "../lib/format";

function DecisionPanel({ version, recommendation, blockers = [], onSaved, openSignal }) {
  const { user } = useAuth();
  const [open, setOpen] = useState(false);
  const [notes, setNotes] = useState("");
  const [riskAccepted, setRiskAccepted] = useState(false);
  const [followUp, setFollowUp] = useState("");
  const [saving, setSaving] = useState(false);
  const [confirmingDecision, setConfirmingDecision] = useState(null);
  useEffect(() => { if (openSignal) setOpen(true); }, [openSignal]);
  if (!user || !["admin", "qa_manager"].includes(user.role)) return null;
  const record = async (decision, overrideConfirmed = false) => {
    if (saving) return;
    const isOverride = decision !== recommendation && !(decision === "CONDITIONAL" && recommendation === "CONDITIONAL");
    if (isOverride) {
      if (notes.trim().length < 20) return toast.error("Overriding the system recommendation requires a structured rationale (min 20 characters).");
      if (!riskAccepted) return toast.error("You must explicitly accept the risk to override the system recommendation.");
      if (!overrideConfirmed) {
        setConfirmingDecision(decision);
        return;
      }
    }
    setSaving(true);
    try {
      await api.post("/release-readiness/decision", { version, decision, notes, risk_accepted: riskAccepted, follow_up: followUp });
      toast.success(`Final decision recorded: ${decision}${isOverride ? " (override — blocker snapshot stored)" : ""}`);
      setOpen(false); setNotes(""); setRiskAccepted(false); setFollowUp(""); setConfirmingDecision(null); onSaved();
    } catch (e) { toast.error(e.response?.data?.detail || "Failed to record decision"); }
    finally { setSaving(false); }
  };
  return (
    <div className="shrink-0">
      {!open ? (
        <Button size="sm" variant="outline" className="bg-white/70" onClick={() => setOpen(true)} data-testid="record-decision-btn">Record Final Decision</Button>
      ) : (
        <div className="bg-white border rounded-xl p-3 w-80 space-y-2 shadow-lg">
          <Textarea rows={2} placeholder="Structured rationale — why this decision is safe given the blockers…" value={notes} onChange={(e) => setNotes(e.target.value)} data-testid="decision-notes" />
          <Textarea rows={1} placeholder="Follow-up actions / conditions (optional)" value={followUp} onChange={(e) => setFollowUp(e.target.value)} data-testid="decision-followup" />
          <label className="flex items-start gap-2 text-xs cursor-pointer" data-testid="decision-risk-accept">
            <input type="checkbox" checked={riskAccepted} onChange={(e) => setRiskAccepted(e.target.checked)} className="mt-0.5" />
            I accept responsibility for releasing against the listed blockers (required for overrides)
          </label>
          <div className="flex gap-1.5">
            {["GO", "CONDITIONAL", "NO-GO"].map((decision) => {
              const definition = statusDefinition(decision, RELEASE_DECISIONS);
              const DecisionIcon = definition.icon;
              return <Button key={decision} size="sm" disabled={saving} className="flex-1" style={{ background: definition.color, color: readableTextColor(definition.color) }} title={definition.description} aria-label={`${definition.label}. ${definition.description}`} onClick={() => record(decision)} data-testid={decision === "GO" ? "decision-go" : decision === "CONDITIONAL" ? "decision-cond" : "decision-no-go"}><DecisionIcon size={13} aria-hidden="true" />{saving ? "Saving…" : definition.label}</Button>;
            })}
          </div>
          <button className="text-xs text-muted-foreground hover:underline" onClick={() => setOpen(false)}>Cancel</button>
        </div>
      )}
      <ConfirmActionDialog
        open={!!confirmingDecision}
        onOpenChange={(nextOpen) => !nextOpen && setConfirmingDecision(null)}
        title={`Record ${confirmingDecision || "override"} against the system recommendation?`}
        description={`System recommends ${recommendation} with ${blockers.length} open blocker${blockers.length === 1 ? "" : "s"}. The blocker snapshot, rationale, risk acceptance, reviewer ${user.name} (${userRoleLabel(user.role)}), and final decision will be stored immutably.`}
        confirmLabel="Record override"
        destructive
        busy={saving}
        onConfirm={() => record(confirmingDecision, true)}
      >
        <ul className="max-h-40 overflow-auto rounded-md border bg-[var(--paper)] p-3 text-xs space-y-1" aria-label="Blockers included in immutable snapshot">
          {blockers.length ? blockers.map((blocker, index) => <li key={`${blocker.type}-${blocker.label}-${index}`}><b>[{blocker.type}]</b> {blocker.label}</li>) : <li>No open blockers were reported.</li>}
        </ul>
      </ConfirmActionDialog>
    </div>
  );
}

export default function ReleaseReadiness() {
  const versionsQuery = useCollection("versions");
  const { data: versions = [], isLoading: versionsLoading, isError: versionsError, refetch: refetchVersions } = versionsQuery;
  const [sp, setSp] = useSearchParams();
  const [version, setVersion] = useState(sp.get("version") || "");
  const [reevalSignal, setReevalSignal] = useState(0);
  const qcRef = useQueryClient();

  useEffect(() => {
    const requested = sp.get("version");
    if (requested && versions.some((item) => item.name === requested)) {
      if (version !== requested) setVersion(requested);
    } else if (requested && versions.length) {
      const active = versions.find((v) => v.active);
      setVersion(active ? active.name : versions[versions.length - 1].name);
      const params = new URLSearchParams(sp);
      params.delete("version");
      setSp(params, { replace: true });
    } else if (!requested && !version && versions.length) {
      const active = versions.find((v) => v.active);
      setVersion(active ? active.name : versions[versions.length - 1].name);
    }
  }, [versions, version, sp, setSp]);
  const chooseVersion = (next) => {
    setVersion(next);
    const params = new URLSearchParams(sp);
    params.set("version", next);
    setSp(params);
  };

  const { data: r, isLoading, isError, error, refetch } = useQuery({
    queryKey: ["readiness", version],
    queryFn: async () => (await api.get(`/release-readiness?version=${encodeURIComponent(version)}`)).data,
    enabled: !!version,
  });

  const style = r ? statusDefinition(r.recommendation, RELEASE_DECISIONS) : null;

  return (
    <div>
      <PageHeader title="Release Readiness" subtitle="Per-version go/no-go view for leadership — pass rates, regressions and critical blockers.">
        <div className="w-56">
          <ListSelect options={versions.map((v) => v.name)} value={version} onChange={chooseVersion} placeholder="Bassett version" testid="readiness-version-select" />
        </div>
      </PageHeader>

       {versionsError && <QueryState query={versionsQuery} resource="Bassett versions" onRetry={refetchVersions} testId="readiness-versions" />}
       {versionsLoading && <QueryState query={versionsQuery} resource="Bassett versions" testId="readiness-versions" />}
      {!versionsLoading && !versionsError && versions.length === 0 && <div className="rounded-xl border border-amber-300 bg-amber-50 p-4 text-sm text-amber-900">No Bassett versions are available. Create a version before reviewing release readiness.</div>}
       {!!version && isLoading && <QueryState query={{ isLoading: true }} resource="release readiness" testId="readiness" />}
       {isError && <QueryState query={{ isError, error, refetch }} resource="release readiness" onRetry={refetch} testId="readiness" />}
      {r && style && (
        <>
          {r.decision && (() => {
            const dec = r.decision, snap = dec.snapshot || {};
            const isOverride = dec.override;
            const decisionStatus = isOverride && dec.decision === "GO" ? "GO WITH RISK ACCEPTANCE" : dec.decision;
            const decisionDefinition = statusDefinition(decisionStatus, RELEASE_DECISIONS);
            return (
              <div className="rounded-xl border-2 p-4 mb-4 bg-card" style={{ borderColor: decisionDefinition.color }} data-testid="reviewer-decision-banner">
                {dec.state_changed && (
                  <div className="flex items-center justify-between gap-3 border rounded-lg px-3 py-2 mb-3 text-sm flex-wrap" data-testid="decision-state-changed">
                    <span className="flex min-w-0 items-center gap-2"><StatusBadge value="CONDITIONAL" definitions={RELEASE_DECISIONS} compact /><span><b>Decision based on an earlier snapshot. Current release state has changed.</b>{dec.state_changed_detail ? ` (${dec.state_changed_detail})` : ""}</span></span>
                    <Button size="sm" className="bg-red-600 hover:bg-red-700 shrink-0" onClick={() => setReevalSignal((s) => s + 1)} data-testid="reevaluate-decision-btn">Re-evaluate Final Decision</Button>
                  </div>
                )}
                <div className="flex items-center gap-3 flex-wrap mb-2">
                  <div className="text-xs font-bold uppercase text-muted-foreground">Authorized Reviewer Final Decision</div>
                  <StatusBadge value={decisionStatus} definitions={RELEASE_DECISIONS} testId={isOverride ? "override-flag" : undefined} />
                </div>
                <dl className="grid sm:grid-cols-2 lg:grid-cols-4 gap-x-6 gap-y-1.5 text-sm" data-testid="decision-structured-fields">
                  <div><dt className="text-[10px] font-bold uppercase text-muted-foreground">Final Decision</dt><dd><StatusBadge value={decisionStatus} definitions={RELEASE_DECISIONS} compact /></dd></div>
                  <div><dt className="text-[10px] font-bold uppercase text-muted-foreground">Decision Type</dt><dd className={`font-semibold ${isOverride ? "text-amber-800" : "text-[var(--navy)]"}`}>{isOverride ? "Override" : "Aligned with system"}</dd></div>
                  <div><dt className="text-[10px] font-bold uppercase text-muted-foreground">System Recommendation at Decision</dt><dd><StatusBadge value={dec.system_recommendation_at_decision} definitions={RELEASE_DECISIONS} compact /></dd></div>
                  <div><dt className="text-[10px] font-bold uppercase text-muted-foreground">Risk Accepted</dt><dd className="font-semibold text-[var(--navy)]">{dec.risk_accepted ? "Yes" : "No"}</dd></div>
                  <div className="sm:col-span-2"><dt className="text-[10px] font-bold uppercase text-muted-foreground">Override Rationale</dt><dd>{dec.notes || "—"}</dd></div>
                  <div><dt className="text-[10px] font-bold uppercase text-muted-foreground">Decision Maker</dt><dd>{dec.decided_by}</dd></div>
                  <div><dt className="text-[10px] font-bold uppercase text-muted-foreground">Decision Date</dt><dd>{new Date(dec.decided_at).toLocaleString()}</dd></div>
                </dl>
                {dec.follow_up && <div className="text-xs text-muted-foreground mt-1.5">Follow-up: {dec.follow_up}</div>}
                {snap.blockers?.length > 0 && (
                  <details className="mt-2 text-sm" data-testid="decision-snapshot-blockers">
                    <summary className="cursor-pointer text-xs font-semibold text-[var(--navy)]">Blocker snapshot at decision time ({snap.blocker_count}) · pass rate {fmtPct(snap.pass_rate)} · {snap.evaluated} evaluated · avg {fmtScore(snap.avg_score)}</summary>
                    <ul className="mt-1.5 space-y-1">
                      {snap.blockers.map((b, i) => <li key={i} className="text-xs"><span className="font-bold uppercase text-red-700">[{b.type}]</span> {b.label} <span className="text-muted-foreground">— {b.detail}</span></li>)}
                    </ul>
                  </details>
                )}
                {isOverride && snap.blockers?.length > 0 && <div className="text-xs text-amber-900 mt-1.5 font-semibold">Risk explicitly accepted against the {snap.blocker_count} blocker(s) captured in the decision-time snapshot above.</div>}
              </div>
            );
          })()}
          <div className="rounded-xl border-2 p-6 mb-6 flex items-center gap-5 bg-card" style={{ borderColor: style.color }} data-testid="readiness-banner">
            <style.icon size={44} style={{ color: style.color }} />
            <div className="flex-1">
              <div className="text-[10px] font-bold uppercase tracking-wide text-muted-foreground">System Recommendation — final decision belongs to an authorized reviewer</div>
              <div className="mt-1" data-testid="readiness-recommendation"><StatusBadge value={r.recommendation} definitions={RELEASE_DECISIONS} /></div>
              <div className="text-sm mt-2 text-[var(--navy)]">{r.reason}</div>
               <div className="text-xs mt-1 text-muted-foreground">{r.version} · {r.evaluated} evaluated Bassett tests (latest complete comparison per test case for this version; Pass includes "Pass with Minor Issues")</div>
            </div>
            <DecisionPanel version={version} recommendation={r.recommendation} blockers={r.blockers} openSignal={reevalSignal} onSaved={() => qcRef.invalidateQueries({ queryKey: ["readiness", version] })} />
          </div>
          {r.evaluated === 0 && <div className="mb-4 rounded-xl border border-amber-300 bg-amber-50 p-4 text-sm text-amber-900">No completed Bassett evaluations exist for this version. Run and evaluate test cases before using this readiness recommendation for a release decision.</div>}

          <div className="grid grid-cols-2 md:grid-cols-5 gap-3 mb-6">
             <StatCard label="Pass Rate" value={fmtPct(r.pass_rate)} accent={r.pass_rate != null && r.pass_rate >= 85 ? "#16a34a" : r.pass_rate != null && r.pass_rate >= 70 ? "#f59e0b" : "#dc2626"} icon={Percent} testid="stat-pass-rate" />
             <StatCard label="Avg Score" value={fmtScore(r.avg_score)} accent="#2f3f96" icon={Gauge} />
            <StatCard label="Failed Tests" value={r.failed} accent="#dc2626" icon={FlaskConical} />
            <StatCard label="Open Findings" value={r.open_findings} sub={`${r.open_crit5} critical-5 · ${r.open_crit4} crit-4`} accent="#f47b20" icon={Flag} />
            <StatCard label="New Regressions" value={r.newly_failing} accent={r.newly_failing ? "#dc2626" : "#16a34a"} icon={TrendingDown} />
          </div>

          <div className="grid lg:grid-cols-2 gap-4">
            <div className="bg-card border rounded-xl p-5" data-testid="blockers-panel">
              <h3 className="font-semibold font-display text-[var(--navy)] mb-3 flex items-center gap-2"><ShieldAlert size={16} className="text-red-600" /> Release Blockers ({r.blockers.length})</h3>
              {r.blockers.length === 0 && <p className="text-sm text-green-700 font-medium">No blockers — clear for release.</p>}
              <div className="space-y-2">
                {r.blockers.map((b, i) => (
                  <div key={i} className="border rounded-lg p-3 bg-red-50/50">
                    <div className="text-[10px] font-bold uppercase text-red-600">{b.type}</div>
                    {b.link_type === "finding" ? (
                      <Link to={`/findings?id=${b.link_id}`} className="text-sm font-semibold text-[var(--navy)] hover:underline">{b.label}</Link>
                    ) : b.link_type === "testcase" ? (
                      <Link to={`/testcases/${b.link_id}`} className="text-sm font-semibold text-[var(--navy)] hover:underline">{b.label}</Link>
                    ) : (
                      <span className="text-sm font-semibold text-[var(--navy)]">{b.label}</span>
                    )}
                    <div className="text-xs text-muted-foreground mt-0.5">{b.detail}</div>
                  </div>
                ))}
              </div>
              {(r.stale_gold_tests || []).length > 0 && (
                <div className="mt-4 border-t pt-3" data-testid="readiness-stale-gold-panel">
                  <div className="mb-1.5"><StatusBadge value="Gold Reverification Required" definitions={DEMO_STATUSES} compact /> <span className="text-xs text-muted-foreground">({r.stale_gold_tests.length})</span></div>
                  <div className="space-y-1">
                    {r.stale_gold_tests.map((t) => (
                      <Link key={t.testcase_id} to={`/testcases/${t.testcase_id}`} className="block text-sm text-[var(--navy)] hover:underline">
                        {t.name} <span className="text-xs text-muted-foreground">— stale evidence: {t.stale_evidence.join("; ")}</span>
                      </Link>
                    ))}
                  </div>
                  <p className="text-[11px] text-muted-foreground mt-1.5">These tests were evaluated against a Gold Standard whose supporting evidence predates the latest ordinance amendment or was superseded.</p>
                </div>
              )}
            </div>

            <div className="space-y-4">
              <div className="bg-card border rounded-xl p-5">
                <h3 className="font-semibold font-display text-[var(--navy)] mb-3">Failed Tests · {r.version}</h3>
                {r.failed_tests.length === 0 && <p className="text-sm text-muted-foreground">No failed evaluations for this version.</p>}
                <div className="space-y-1.5">
                  {r.failed_tests.map((t) => (
                    <Link key={t.testcase_id} to={`/testcases/${t.testcase_id}`} className="flex items-center justify-between py-1.5 px-2 rounded-lg hover:bg-[var(--paper)] text-sm">
                      <span className="flex items-center gap-2"><CritBadge value={t.criticality} /><span className="font-medium text-[var(--navy)]">{t.name}</span></span>
                      <ResultBadge value={t.result} />
                    </Link>
                  ))}
                </div>
              </div>

              {r.regression && (
                <div className="bg-card border rounded-xl p-5">
                  <h3 className="font-semibold font-display text-[var(--navy)] mb-2">Regression Run · {r.regression.suite_name}</h3>
                  <div className="flex gap-5 text-sm">
                    <span className="inline-flex items-center gap-1"><StatusBadge value="still_pass" definitions={REGRESSION_DELTA_STATUSES} compact /> {r.regression.passed}</span>
                    <span className="inline-flex items-center gap-1"><StatusBadge value="still_fail" definitions={REGRESSION_DELTA_STATUSES} compact /> {r.regression.failed}</span>
                    <span className="inline-flex items-center gap-1"><StatusBadge value="improved" definitions={REGRESSION_DELTA_STATUSES} compact /> {r.regression.improved}</span>
                    <span className="inline-flex items-center gap-1"><StatusBadge value="regressed" definitions={REGRESSION_DELTA_STATUSES} compact /> {r.regression.newly_failing}</span>
                  </div>
                </div>
              )}

              <div className="bg-card border rounded-xl p-5">
                <h3 className="font-semibold font-display text-[var(--navy)] mb-3">Top Open Findings</h3>
                {r.open_finding_list.length === 0 && <p className="text-sm text-muted-foreground">No open findings.</p>}
                <div className="space-y-1.5">
                  {r.open_finding_list.map((f) => (
                    <Link key={f.id} to={`/findings?id=${f.id}`} className="flex items-center justify-between py-1.5 px-2 rounded-lg hover:bg-[var(--paper)] text-sm">
                      <span className="flex items-center gap-2"><CritBadge value={f.criticality} /><span className="font-medium text-[var(--navy)]">{f.title}</span></span>
                      <StatusBadge value={f.developer_status} definitions={FINDING_STATUSES} compact />
                    </Link>
                  ))}
                </div>
              </div>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
