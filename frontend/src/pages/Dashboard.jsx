import { useQuery } from "@tanstack/react-query";
import { api } from "../lib/api";
import { Link } from "react-router-dom";
import { StatCard, PageHeader, Section, SrTable, SampleDataBanner, sampleScopeIncludesData, MethodologyDisclosure } from "../components/shared";
import { useCollection } from "../lib/hooks";
import { Button } from "../components/ui/button";
import {
  FolderKanban, CheckCircle2, XCircle, AlertTriangle, Flag, Wrench, RefreshCw, Star,
  ClipboardCheck, Activity as ActIcon,
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
    enabled: Boolean(m?.active_version),
    queryFn: async () => (await api.get("/analytics/performance", { params: { version: m.active_version || "" } })).data,
    retry: false,
  });
  const versionsQuery = useCollection("versions");

  if (stats.isLoading || metrics.isLoading) return <div>
    <PageHeader title="QA Dashboard" subtitle="Loading the latest persisted QA metrics." />
    <div className="grid gap-4 xl:grid-cols-2" aria-label="Loading dashboard sections">
      {["Quality metrics", "Finding workflow", "Program operations"].map((label) => <section key={label} className="rounded-xl border bg-card p-4">
        <h2 className="font-display font-semibold text-[var(--navy)]">{label}</h2>
        <DashboardState compact title={`Loading ${label.toLowerCase()}…`} />
      </section>)}
    </div>
  </div>;
  if (stats.isError || metrics.isError) {
    const error = stats.error || metrics.error;
    return <DashboardError error={error} retry={() => { stats.refetch(); metrics.refetch(); }} />;
  }

  const bc = m.bassett_current, comparison = m.bassett_comparison || bc;
  const bassettOnly = m.bassett_only || {
    pass_rate: null, label: "No eligible records", population_label: "Bassett-only Test Runs",
    definition: "Eligible standalone Bassett-only Test Runs for the active version.",
  };
  const ame = m.all_model_evaluations, fnd = m.findings;
  const versionLabel = m.active_version || "No active version";
  const sampleDataShown = sampleScopeIncludesData({
    versions: versionsQuery.data || [],
    selectedVersion: m.active_version || "",
    records: [m, s, perfQuery.data],
  });
  const cards = [
    { label: "Model Comparison — Bassett Pass Rate", value: comparison.pass_rate != null ? `${comparison.pass_rate}%` : "N/A", sub: `${comparison.label} · ${versionLabel}`, title: comparison.definition, icon: CheckCircle2, accent: "#16a34a", to: dashboardRecordPath("model-comparison-pass-rate") },
    { label: "Bassett-Only Pass Rate", value: bassettOnly.pass_rate != null ? `${bassettOnly.pass_rate}%` : "N/A", sub: `${bassettOnly.label} · ${versionLabel}`, title: bassettOnly.definition, icon: CheckCircle2, accent: "#0f766e", to: dashboardRecordPath("bassett-only-pass-rate") },
    { label: "Bassett Failed", value: comparison.failed, sub: `of ${comparison.evaluated} evaluated comparisons · ${versionLabel}`, title: comparison.definition, icon: XCircle, accent: "#dc2626", to: dashboardRecordPath("bassett-failed") },
    { label: "Bassett Avg Score", value: m.bassett_avg_score.value ?? "—", sub: `${m.bassett_avg_score.unit} · ${versionLabel}`, title: m.bassett_avg_score.definition, icon: ActIcon, accent: MODEL_COLORS.Bassett, to: dashboardRecordPath("bassett-score") },
    { label: "All Model Evaluations", value: ame.label, sub: "Bassett + ChatGPT + Claude mixed", title: ame.definition, icon: ClipboardCheck, accent: "#2f3f96", to: dashboardRecordPath("all-model-evaluations") },
    { label: "Open Findings", value: fnd.open, sub: `${fnd.open_critical} critical (C4-C5)`, title: fnd.definition, icon: Flag, accent: "#f97316", to: dashboardRecordPath("open-findings") },
    { label: "Awaiting Fix", value: fnd.awaiting_fix, sub: "open findings in dev", title: fnd.definition, icon: Wrench, accent: "#2f3f96", to: dashboardRecordPath("awaiting-fix") },
    { label: "Ready for Retest", value: fnd.ready_for_retest, sub: "findings awaiting retest", title: fnd.definition, icon: RefreshCw, accent: "#0ea5e9", to: dashboardRecordPath("ready-for-retest") },
    { label: "Active Projects", value: s.active_projects, sub: "testing projects", title: "Testing Projects whose status is Active.", icon: FolderKanban, accent: "#16215a", to: dashboardRecordPath("active-projects") },
    { label: "Demo Approved", value: s.demo_approved, sub: "demo library", title: "Demo records whose status is Approved.", icon: Star, accent: "#f59e0b", to: dashboardRecordPath("demo-approved") },
  ];
  const hasModelComparisonMetrics = Number(comparison.evaluated || 0) > 0;
  const groups = [
    { title: "Bassett Quality", description: hasModelComparisonMetrics ? "Current-version quality and model evaluation outcomes." : "Current-version Bassett-only quality.", cards: hasModelComparisonMetrics ? cards.slice(0, 5) : [cards[1]], showComparisonSetup: !hasModelComparisonMetrics },
    { title: "Finding Workflow", description: "Open issues moving from confirmation through retest.", cards: cards.slice(5, 8) },
    { title: "Program Operations", description: "Active projects and approved demonstration assets.", cards: cards.slice(8, 10) },
  ];

  const modelData = (perfQuery.data?.model_summary || [])
    .map((row) => ({ name: row.model, score: evaluationScoreOrNull(row.avg_score) }))
    .filter((row) => row.score !== null);
  return (
    <div>
      <PageHeader title="QA Dashboard" subtitle={`Scope: Active version: ${versionLabel} · Bassett dashboard scope · archived and unfinished records excluded.`} />
      <SampleDataBanner show={sampleDataShown} />
      {!m.active_version && <div role="alert" className="mb-4 flex flex-wrap items-center justify-between gap-3 rounded-xl border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-950">
        <span><strong>Set an active Bassett version</strong> to calculate current-version pass rates and average scores.</span>
        <Button asChild size="sm"><Link to="/admin">Manage Bassett versions</Link></Button>
      </div>}
      <div className="grid gap-4 mb-6 xl:grid-cols-2" aria-label="Dashboard metric groups">
        {groups.map((group) => <section key={group.title} className="rounded-xl border bg-card p-4" data-testid="dashboard-metric-group" aria-labelledby={`dashboard-${group.title.toLowerCase().replace(/\s+/g, "-")}`}>
          <div className="mb-3">
            <h2 id={`dashboard-${group.title.toLowerCase().replace(/\s+/g, "-")}`} className="font-display font-semibold text-[var(--navy)]">{group.title}</h2>
            <p className="text-xs text-muted-foreground">{group.description}</p>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            {group.cards.map((c) => <StatCard key={c.label} {...c} showInfo={false} showCalculation={false} testid={`stat-${c.label.toLowerCase().replace(/\s+/g, "-")}`} />)}
            {group.showComparisonSetup && <div className="flex min-h-36 flex-col justify-center rounded-xl border border-dashed bg-[var(--paper)] p-4 sm:col-span-1" data-testid="dashboard-comparison-setup">
              <h3 className="font-semibold text-[var(--navy)]">Model Comparison metrics are not available yet</h3>
              <p className="mt-1 text-xs text-muted-foreground">Complete a Model Comparison test for the active Bassett version to populate pass rate, failures, average score, and model evaluation metrics.</p>
              <Button asChild size="sm" variant="outline" className="mt-3 self-start"><Link to="/testcases">Open Model Comparison Test Cases</Link></Button>
            </div>}
          </div>
        </section>)}
      </div>

      <div className="min-w-0">
        <div className="min-w-0">
          <Section title="Bassett vs. Benchmark Models — Average Score">
            <p className="text-xs text-muted-foreground mb-3">{perfQuery.data?.scope || `Latest evaluations; Bassett limited to ${versionLabel}.`}</p>
            <p className="text-xs text-muted-foreground mb-3">Scale: 0–10. Missing model scores are unavailable and are not plotted as zero.</p>
            {perfQuery.isLoading ? <DashboardState compact title="Loading chart…" detail="Loading active-version model scores." /> : perfQuery.isError ? (
              <InlineError error={perfQuery.error} retry={perfQuery.refetch} />
            ) : modelData.length === 0 ? (
              <div className="flex min-h-36 flex-col items-center justify-center gap-3 rounded-lg border border-dashed px-4 py-8 text-center">
                <p className="text-sm text-muted-foreground">No scored model evaluations exist for this scope.</p>
                <Button asChild size="sm" variant="outline"><Link to="/testcases">Create or evaluate a comparison test case</Link></Button>
              </div>
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
      </div>
      <MethodologyDisclosure title="How dashboard metrics are calculated" testid="dashboard-methodology">
          <p>Dashboard cards use the active Bassett version and the current dashboard scope. Each Test Bank definition or Test Case contributes only its latest qualifying record.</p>
          <p>Pass includes <strong className="text-foreground">Pass</strong> and <strong className="text-foreground">Pass with Minor Issues</strong>. Incomplete, draft, not-evaluated, archived, and out-of-scope records are excluded. Retests and variants remain separate unless the card definition explicitly includes them.</p>
          <p>Model Comparison cards use complete, non-partial comparison runs. Bassett-only cards include eligible Single Prompt and Multi-Turn Conversation runs and exclude anything linked to or expanded into Model Comparison.</p>
          <p>Missing and N/A scores are unavailable rather than zero. Every card opens the exact numerator/denominator population used for its displayed metric, with source navigation to the relevant record.</p>
           <div data-testid="dashboard-reporting-groups-methodology">
             <h3 className="font-semibold text-sm text-[var(--navy)]">Bassett Reporting Groups</h3>
             <p className="mt-1">Seven reporting groups consolidate the 12 stored scoring dimensions. Configured weights apply only to applicable scored values; missing and N/A values are excluded, never treated as zero.</p>
           </div>
      </MethodologyDisclosure>
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

