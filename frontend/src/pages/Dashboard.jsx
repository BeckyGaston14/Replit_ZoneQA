import { useQuery } from "@tanstack/react-query";
import { api } from "../lib/api";
import { Link } from "react-router-dom";
import { StatCard, PageHeader, Section, SrTable } from "../components/shared";
import { Button } from "../components/ui/button";
import {
  FolderKanban, CheckCircle2, XCircle, AlertTriangle, Flag, Wrench, RefreshCw, Star,
  ClipboardCheck, Clock, FileClock, Activity as ActIcon,
} from "lucide-react";
import { BarChart, Bar, XAxis, YAxis, Tooltip, Cell } from "recharts";
import { dashboardRecordPath } from "../lib/routePaths";
import { EVALUATION_SCORE_DOMAIN, EVALUATION_SCORE_TICKS, evaluationScoreOrNull, formatEvaluationScore } from "../lib/evaluationScale";
import { MODEL_COLORS, MODEL_ORDER } from "../lib/modelColors";
import { SafeResponsiveContainer } from "../components/SafeResponsiveContainer";

export default function Dashboard() {
  const stats = useQuery({ queryKey: ["stats"], queryFn: async () => (await api.get("/dashboard/stats")).data, retry: false });
  const metrics = useQuery({ queryKey: ["metrics"], queryFn: async () => (await api.get("/metrics/summary")).data, retry: false });
  const s = stats.data, m = metrics.data;
  const perfQuery = useQuery({
    queryKey: ["perf", m?.active_version],
    enabled: !!m,
    queryFn: async () => (await api.get("/analytics/performance", { params: { version: m.active_version || "" } })).data,
    retry: false,
  });
  const activityQuery = useQuery({ queryKey: ["acts"], queryFn: async () => (await api.get("/activities")).data, retry: false });

  if (stats.isLoading || metrics.isLoading) return <DashboardState title="Loading dashboard…" detail="Loading canonical metrics and project status." />;
  if (stats.isError || metrics.isError) {
    const error = stats.error || metrics.error;
    return <DashboardError error={error} retry={() => { stats.refetch(); metrics.refetch(); }} />;
  }

  const bc = m.bassett_current, ame = m.all_model_evaluations, fnd = m.findings;
  const versionLabel = m.active_version || "No active version";
  const cards = [
    { label: `Bassett Pass Rate (${versionLabel})`, value: bc.pass_rate != null ? `${bc.pass_rate}%` : "—", sub: `${bc.label} · latest eval per test`, title: bc.definition, icon: CheckCircle2, accent: "#16a34a", to: dashboardRecordPath("bassett-pass-rate") },
    { label: "Bassett Failed", value: bc.failed, sub: `of ${bc.evaluated} evaluated tests (${versionLabel})`, title: bc.definition, icon: XCircle, accent: "#dc2626", to: dashboardRecordPath("bassett-failed") },
    { label: "Bassett Avg Score", value: m.bassett_avg_score.value ?? "—", sub: `${m.bassett_avg_score.unit} · ${versionLabel}`, title: m.bassett_avg_score.definition, icon: ActIcon, accent: MODEL_COLORS.Bassett, to: dashboardRecordPath("bassett-score") },
    { label: "All Model Evaluations", value: ame.label, sub: "Bassett + ChatGPT + Claude mixed", title: ame.definition, icon: ClipboardCheck, accent: "#2f3f96", to: dashboardRecordPath("all-model-evaluations") },
    { label: "Open Findings", value: fnd.open, sub: `${fnd.open_critical} critical (C4-C5)`, title: fnd.definition, icon: Flag, accent: "#f97316", to: dashboardRecordPath("open-findings") },
    { label: "Awaiting Fix", value: fnd.awaiting_fix, sub: "open findings in dev", title: fnd.definition, icon: Wrench, accent: "#2f3f96", to: dashboardRecordPath("awaiting-fix") },
    { label: "Ready for Retest", value: fnd.ready_for_retest, sub: "findings awaiting retest", title: fnd.definition, icon: RefreshCw, accent: "#0ea5e9", to: dashboardRecordPath("ready-for-retest") },
    { label: "Regression (latest run)", value: m.regression_current ? `${m.regression_current.passed}/${m.regression_current.passed + m.regression_current.failed}` : "—", sub: m.regression_current ? `Regression Run Date ${m.regression_current.test_date || m.regression_current.execution_date || "not recorded"}` : `no run for ${versionLabel}`, title: m.regression_current?.definition, icon: FileClock, accent: "#dc2626", to: dashboardRecordPath("regression-current") },
    { label: "Total Test Cases", value: m.test_cases.total, sub: `${bc.evaluated} evaluated on ${versionLabel} · ${m.test_cases.total - bc.evaluated} not yet`, title: m.test_cases.definition, icon: ClipboardCheck, accent: "#16215a", to: dashboardRecordPath("test-cases") },
    { label: "Active Projects", value: s.active_projects, sub: "testing projects", title: "Testing Projects whose status is Active.", icon: FolderKanban, accent: "#16215a", to: dashboardRecordPath("active-projects") },
    { label: "Retest Executions", value: m.retests.total, sub: `${m.retests.completed} completed`, title: m.retests.definition, icon: Clock, accent: "#64748b", to: dashboardRecordPath("retests") },
    { label: "Demo Approved", value: s.demo_approved, sub: "demo library", title: "Demo records whose status is Approved.", icon: Star, accent: "#f59e0b", to: dashboardRecordPath("demo-approved") },
  ];
  const groups = [
    { title: "Bassett Quality", description: "Current-version quality and model evaluation outcomes.", cards: cards.slice(0, 4) },
    { title: "Finding Workflow", description: "Open issues moving from confirmation through retest.", cards: cards.slice(4, 7) },
    { title: "Release Confidence", description: "Regression coverage, active test inventory, and retest execution.", cards: [cards[7], cards[8], cards[10]] },
    { title: "Program Operations", description: "Active projects and approved demonstration assets.", cards: [cards[9], cards[11]] },
  ];

  const modelData = (perfQuery.data?.model_summary || [])
    .map((row) => ({ name: row.model, score: evaluationScoreOrNull(row.avg_score) }))
    .filter((row) => row.score !== null);
  return (
    <div>
      <PageHeader title="QA Dashboard" subtitle={`Every card opens its exact canonical record set. Active version: ${versionLabel}.`} />
      <div className="grid gap-4 mb-6 xl:grid-cols-2" aria-label="Dashboard metric groups">
        {groups.map((group) => <section key={group.title} className="rounded-xl border bg-card p-4" data-testid="dashboard-metric-group" aria-labelledby={`dashboard-${group.title.toLowerCase().replace(/\s+/g, "-")}`}>
          <div className="mb-3">
            <h2 id={`dashboard-${group.title.toLowerCase().replace(/\s+/g, "-")}`} className="font-display font-semibold text-[var(--navy)]">{group.title}</h2>
            <p className="text-xs text-muted-foreground">{group.description}</p>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            {group.cards.map((c) => <StatCard key={c.label} {...c} testid={`stat-${c.label.toLowerCase().replace(/\s+/g, "-")}`} />)}
          </div>
        </section>)}
      </div>

      <div className="grid min-w-0 grid-cols-1 lg:grid-cols-3 gap-4">
        <div className="min-w-0 lg:col-span-2">
          <Section title="Bassett vs. Benchmark Models — Average Score">
            <p className="text-xs text-muted-foreground mb-3">{perfQuery.data?.scope || `Latest evaluations; Bassett limited to ${versionLabel}.`}</p>
            <p className="text-xs text-muted-foreground mb-3">Scale: 0–10. Missing model scores are unavailable and are not plotted as zero.</p>
            {perfQuery.isLoading ? <DashboardState compact title="Loading chart…" detail="Loading active-version model scores." /> : perfQuery.isError ? (
              <InlineError error={perfQuery.error} retry={perfQuery.refetch} />
            ) : modelData.length === 0 ? (
              <div className="h-[260px] flex items-center justify-center text-sm text-muted-foreground">No scored model evaluations exist for this scope.</div>
            ) : <SafeResponsiveContainer height={260} testId="dashboard-model-chart">
              <BarChart data={modelData}>
                <XAxis dataKey="name" tick={{ fontSize: 13 }} />
                <YAxis domain={EVALUATION_SCORE_DOMAIN} ticks={EVALUATION_SCORE_TICKS} tick={{ fontSize: 12 }} />
                <Tooltip formatter={(value) => [formatEvaluationScore(value), "Average score (0–10)"]} />
                <Bar dataKey="score" radius={[6, 6, 0, 0]}>
                  {modelData.map((d, i) => <Cell key={i} fill={MODEL_COLORS[d.name] || "#64748b"} />)}
                </Bar>
              </BarChart>
            </SafeResponsiveContainer>}
            <SrTable caption={`Average model scores. Scale: 0 to 10. ${perfQuery.data?.scope || ""}`} columns={["Model", "Average score out of 10"]} rows={modelData.map((row) => [row.name, formatEvaluationScore(row.score)])} />
            <div className="flex gap-4 mt-3 text-xs text-muted-foreground flex-wrap" aria-label="Model color legend">
              {MODEL_ORDER.filter((model) => modelData.some((row) => row.name === model)).map((model) => (
                <span key={model} className="flex items-center gap-2"><i className="h-3 w-3 rounded" style={{ background: MODEL_COLORS[model] }} />{model}</span>
              ))}
            </div>
          </Section>
        </div>
        <Section title="Recent Activity">
          <div className="space-y-3 max-h-[300px] overflow-y-auto">
            {activityQuery.isLoading ? <DashboardState compact title="Loading activity…" /> : activityQuery.isError ? (
              <InlineError error={activityQuery.error} retry={activityQuery.refetch} />
            ) : (activityQuery.data || []).length === 0 ? (
              <div className="py-8 text-center text-sm text-muted-foreground">No recent activity.</div>
            ) : (activityQuery.data || []).slice(0, 12).map((a) => (
              <div key={a.id} className="flex min-w-0 gap-3 text-sm">
                <div className="mt-1 h-1.5 w-1.5 rounded-full bg-[var(--orange)] shrink-0" />
                <div className="min-w-0">
                  <div className="break-words text-[var(--ink)]">{a.summary || "Activity recorded"}</div>
                  <div className="break-words text-[11px] text-muted-foreground">{a.user} · {new Date(a.created_at).toLocaleString()}</div>
                  {a.audit_detail_available && <Link className="mt-1 inline-block text-xs font-semibold text-[var(--orange)] underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--orange)]" to={`/admin/audit/${a.id}`}>View audit details</Link>}
                </div>
              </div>
            ))}
          </div>
        </Section>
      </div>
    </div>
  );
}

function isAuthenticationError(error) {
  return error?.response?.status === 401 || error?.response?.status === 403;
}

function DashboardState({ title, detail, compact = false }) {
  return <div role="status" className={`${compact ? "py-8" : "min-h-[40vh]"} flex flex-col items-center justify-center text-center`}>
    <RefreshCw className="animate-spin text-[var(--orange)] mb-2" size={20} />
    <div className="font-semibold text-[var(--navy)]">{title}</div>
    {detail && <div className="text-sm text-muted-foreground mt-1">{detail}</div>}
  </div>;
}

function DashboardError({ error, retry }) {
  if (isAuthenticationError(error)) {
    return <div role="alert" className="min-h-[40vh] flex flex-col items-center justify-center text-center">
      <div className="font-semibold text-[var(--navy)]">Your session has expired</div>
      <p className="text-sm text-muted-foreground mt-1 mb-3">Sign in again to view Dashboard data.</p>
      <Button asChild><Link to="/login">Sign in</Link></Button>
    </div>;
  }
  return <div role="alert" className="min-h-[40vh] flex flex-col items-center justify-center text-center">
    <div className="font-semibold text-[var(--navy)]">Dashboard data could not be loaded</div>
    <p className="text-sm text-muted-foreground mt-1 mb-3">The canonical metrics service returned an error.</p>
    <Button variant="outline" onClick={retry}><RefreshCw size={14} className="mr-1" /> Retry</Button>
  </div>;
}

function InlineError({ error, retry }) {
  return <div role="alert" className="py-8 text-center">
    <p className="text-sm text-muted-foreground">{isAuthenticationError(error) ? "Your session expired." : "This section could not be loaded."}</p>
    <Button size="sm" variant="outline" className="mt-2" onClick={() => retry()}><RefreshCw size={13} className="mr-1" /> Retry</Button>
  </div>;
}
