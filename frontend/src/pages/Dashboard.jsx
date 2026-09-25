import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { AlertTriangle, CheckCircle2, ClipboardCheck, RefreshCw, SlidersHorizontal } from "lucide-react";
import { api } from "../lib/api";
import { Button } from "../components/ui/button";
import { PageHeader, Section, SampleDataBanner, sampleScopeIncludesData, MethodologyDisclosure, LimitedDataWarning, StatCard } from "../components/shared";
import { useCollection, useSampleVisibility } from "../lib/hooks";
import { useAuth } from "../lib/auth";
import { dashboardRecordPath } from "../lib/routePaths";
import { MODEL_COLORS } from "../lib/modelColors";
import { SEVERITY_LABELS } from "../lib/severity";
import { evaluationScoreOrNull, formatEvaluationScore } from "../lib/evaluationScale";
import { CURRENT_RUBRIC_CATEGORIES } from "../lib/scoringGroups";

const queryDefaults = { retry: false, staleTime: 0, gcTime: 5 * 60_000, refetchOnMount: true };

function first(...values) {
  return values.find((value) => value !== null && value !== undefined);
}

function severityRows(findings = {}, scope) {
  const source = findings.by_severity || {};
  return SEVERITY_LABELS.map((label) => {
    const slug = label.toLowerCase().replace(/\s+/g, "-");
    const candidates = [source[label], source[slug], source[slug.replace("-", "_")], source[SEVERITY_LABELS.indexOf(label) + 1]];
    const entry = candidates.find((value) => value !== undefined);
    const value = typeof entry === "object" ? first(entry?.[scope], entry?.count, entry?.total, entry?.open) : entry;
    return { label, slug, value: value == null ? 0 : value };
  });
}

function performanceRows(raw = []) {
  const entries = Array.isArray(raw) ? raw : Object.entries(raw).map(([name, value]) => ({ name, ...(typeof value === "object" ? value : { average_score: value }) }));
  return entries.map((entry) => ({
    name: entry.name || entry.label || entry.category || entry.group || entry.reporting_group || "Unnamed",
    score: evaluationScoreOrNull(first(entry.average_score, entry.avg_score, entry.score, entry.value)),
    evaluated: first(entry.evaluated, entry.count, entry.qualifying_count, entry.score_count, 0),
  }));
}

function useDashboardPerformance({ scope, activeVersion, userId, sampleScope, enabled }) {
  return useQuery({
    ...queryDefaults,
    queryKey: ["perf", scope, activeVersion, userId, sampleScope],
    enabled: enabled && Boolean(activeVersion),
    queryFn: async ({ signal }) => (await api.get("/analytics/performance", { params: { version: activeVersion, scope }, signal })).data,
  });
}

export default function Dashboard() {
  const auth = useAuth();
  const userId = auth?.user?.id || null;
  const sampleVisibility = useSampleVisibility();
  const sampleScope = sampleVisibility.includeSampleRecords ? "included" : "excluded";
  const enabled = (auth ? auth.loading === false && Boolean(userId) : true) && !sampleVisibility.isLoading;
  const options = { ...queryDefaults, enabled };
  const versionsQuery = useCollection("versions");
  const stats = useQuery({ ...options, queryKey: ["stats", userId, sampleScope], queryFn: async ({ signal }) => (await api.get("/dashboard/stats", { signal })).data });
  const metrics = useQuery({ ...options, queryKey: ["metrics", userId, sampleScope], queryFn: async ({ signal }) => (await api.get("/metrics/summary", { signal })).data });
  const m = metrics.data || {};
  const activeVersion = m.active_version || versionsQuery.data?.find((version) => version.active)?.name || "";
  const bassettMetrics = useQuery({
    ...options,
    queryKey: ["bassett-metrics", activeVersion, userId, sampleScope],
    enabled: enabled && Boolean(activeVersion),
    queryFn: async ({ signal }) => (await api.get("/bassett/metrics", { params: { version_id: activeVersion }, signal })).data,
  });
  const bassettPerformance = useDashboardPerformance({ scope: "bassett", activeVersion, userId, sampleScope, enabled });
  const comparisonPerformance = useDashboardPerformance({ scope: "comparison", activeVersion, userId, sampleScope, enabled });
  const s = stats.data || {};
  const findings = m.findings || {};
  const bassett = m.bassett_only || {};
  const comparison = m.bassett_comparison || {};
  const versionLoading = versionsQuery.isLoading || metrics.isLoading;
  const versionLabel = activeVersion || (versionLoading ? "Loading active version…" : "No active version");
  const sampleShown = sampleScopeIncludesData({ versions: versionsQuery.data || [], selectedVersion: activeVersion, records: [m, s, bassettMetrics.data] });
  const bassettWorkspace = bassettMetrics.data || {};
  const needsAttention = first(bassettWorkspace.test_runs?.attention, "N/A");
  const coverage = bassettWorkspace.test_runs?.test_bank_coverage;
  const kpis = [
    { label: "Bassett-Only Pass Rate", value: bassett.pass_rate == null ? "N/A" : `${bassett.pass_rate}%`, sub: `${first(bassett.label, "Bassett-only test runs")} · ${versionLabel}`, icon: CheckCircle2, accent: "#0f766e", to: dashboardRecordPath("bassett-only-pass-rate"), title: bassett.definition },
    { label: "Model Comparison Pass Rate", value: comparison.pass_rate == null ? "N/A" : `${comparison.pass_rate}%`, sub: `${first(comparison.label, "Model comparison runs")} · ${versionLabel}`, icon: CheckCircle2, accent: "#16a34a", to: dashboardRecordPath("model-comparison-pass-rate"), title: comparison.definition },
    { label: "Tests Needing Attention", value: needsAttention, sub: "Needs Improvement, Fail, Critical Fail, or Blocked", icon: AlertTriangle, accent: "#c2410c", to: dashboardRecordPath("bassett-tests-needing-attention"), title: bassettWorkspace.test_runs?.definition },
    { label: "Scenario Coverage", value: coverage ? `${coverage.percent}%` : "N/A", sub: coverage ? `${coverage.covered}/${coverage.total} active scenarios evaluated` : "Active Test Bank scenarios", icon: ClipboardCheck, accent: "#2f3f96", to: dashboardRecordPath("scenario-coverage"), title: bassettWorkspace.test_runs?.definition },
  ];
  const loadingAny = metrics.isLoading || bassettMetrics.isLoading;
  return (
    <div className="min-w-0">
      <PageHeader title="QA Dashboard" subtitle={`Scope: Active version: ${versionLabel} · Bassett dashboard scope · archived and unfinished records excluded.`} />
      <SampleDataBanner show={sampleShown} />
      {!versionLoading && !activeVersion && <div role="alert" className="mb-4 flex flex-wrap items-center justify-between gap-3 rounded-xl border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-950"><span><strong>Set an active Bassett version</strong> to calculate current-version metrics.</span><Button asChild size="sm"><Link to="/admin">Manage Bassett versions</Link></Button></div>}

      <section aria-labelledby="dashboard-kpis" className="mb-5">
        <h2 id="dashboard-kpis" className="mb-2 text-sm font-semibold uppercase tracking-wide text-muted-foreground">Primary KPIs</h2>
        {loadingAny && (!metrics.data || !bassettMetrics.data) ? <DashboardState title="Loading primary metrics…" /> : (metrics.isError || bassettMetrics.isError) ? <InlineError retry={() => Promise.all([metrics.refetch(), bassettMetrics.refetch()])} /> : <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">{kpis.map((card) => <StatCard key={card.label} {...card} showInfo={false} showCalculation={false} testid={`stat-${card.label.toLowerCase().replace(/\s+/g, "-")}`} />)}</div>}
      </section>

      <section aria-labelledby="dashboard-performance" className="mb-5">
        <h2 id="dashboard-performance" className="mb-2 text-sm font-semibold uppercase tracking-wide text-muted-foreground">Performance</h2>
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
          <PerformancePanel title="Bassett-Only Performance" query={bassettPerformance} data={bassettPerformance.data || {}} scope="bassett" version={versionLabel} />
          <PerformancePanel title="Model Comparison Performance" query={comparisonPerformance} data={comparisonPerformance.data || {}} scope="comparison" version={versionLabel} />
        </div>
      </section>

      <CategorySection query={bassettPerformance} />

      <section aria-labelledby="dashboard-findings" className="mb-5">
        <h2 id="dashboard-findings" className="mb-2 text-sm font-semibold uppercase tracking-wide text-muted-foreground">Findings and action</h2>
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
          <FindingsPanel title="Bassett Findings" scope="bassett" findings={findings} total={first(findings.bassett_open, findings.open, 0)} />
          <FindingsPanel title="Model Comparison Findings" scope="comparison" findings={findings} total={first(findings.comparison_open, 0)} />
        </div>
      </section>

      <MethodologyDisclosure title="How dashboard metrics are calculated" testid="dashboard-methodology">
        <p>Performance and action metrics use the active Bassett version and the current dashboard scope. Finding totals span unresolved findings across visible versions. Archived, unfinished, missing, and N/A records are excluded; missing scores are never treated as zero.</p>
        <p>Pass includes <strong className="text-foreground">Pass</strong> and <strong className="text-foreground">Pass with Minor Issues</strong>. Bassett-only and Model Comparison populations remain separate, and each link opens the exact source population used for its metric.</p>
      </MethodologyDisclosure>
    </div>
  );
}

function PerformancePanel({ title, query, data, scope, version }) {
  const rows = (data?.model_summary || data?.summary || []).map((row) => ({ name: row.model || row.name || "Model", score: evaluationScoreOrNull(first(row.avg_score, row.average_score, row.score)), evaluated: first(row.evaluated, row.score_count, row.count, 0) })).filter((row) => row.score !== null);
  const bassettRow = (data?.model_summary || []).find((row) => row.model === "Bassett");
  const average = first(data?.average_score, data?.avg_score, bassettRow?.avg_score);
  const scoreCount = first(bassettRow?.score_count, 0);
  const evaluatedResults = Number(bassettRow?.passed || 0) + Number(bassettRow?.failed || 0);
  const evaluated = first(data?.evaluated, data?.evaluated_count, evaluatedResults);
  const passRate = first(data?.pass_rate, data?.passRate, evaluatedResults ? Math.round((Number(bassettRow?.passed || 0) / evaluatedResults) * 1000) / 10 : null);
  return <Section title={title}><p className="mb-3 text-xs text-muted-foreground">Scope: {scope === "bassett" ? "Bassett-only" : "Model Comparison"} · {version}</p>
    {query.isLoading ? <DashboardState compact title="Loading performance…" /> : query.isError ? <InlineError retry={query.refetch} /> : rows.length === 0 ? <EmptyCompact /> : <div className="space-y-2">{rows.map((row) => <div key={row.name} className="grid grid-cols-[minmax(72px,1fr)_minmax(90px,2fr)_auto] items-center gap-2 text-xs"><span className="truncate font-medium">{row.name}</span><div className="h-2 overflow-hidden rounded-full bg-muted"><div className="h-full rounded-full" style={{ width: `${(row.score / 10) * 100}%`, background: MODEL_COLORS[row.name] || "var(--navy)" }} /></div><span className="font-mono text-muted-foreground">{formatEvaluationScore(row.score)}</span></div>)}</div>}
    <div className="mt-4 grid grid-cols-3 gap-2 border-t pt-3 text-xs"><Metric label={`Average score (n=${scoreCount})`} value={average == null ? "N/A" : formatEvaluationScore(average)} /><Metric label="Evaluated results" value={evaluated} /><Metric label="Pass rate" value={passRate == null ? "N/A" : `${passRate}%`} /></div>
    <LimitedDataWarning evaluated={evaluated} />
  </Section>;
}

function CategorySection({ query }) {
  const [showEmpty, setShowEmpty] = useState(false);
  const categories = useMemo(() => {
    const evaluated = performanceRows(query.data?.rubric_categories || query.data?.current_rubric_categories || query.data?.by_category || []);
    const byName = new Map(evaluated.map((row) => [row.name, row]));
    return [...new Set([...CURRENT_RUBRIC_CATEGORIES.map((category) => category.label), ...evaluated.map((row) => row.name)])]
      .map((name) => byName.get(name) || { name, score: null, evaluated: 0 });
  }, [query.data]);
  const visibleCategories = categories.filter((row) => showEmpty || Number(row.evaluated) > 0);
  return <section aria-labelledby="dashboard-categories" className="mb-5 rounded-xl border bg-card p-4"><div className="flex flex-wrap items-center justify-between gap-2"><div><h2 id="dashboard-categories" className="font-display font-semibold text-[var(--navy)]">Current Rubric Performance</h2><p className="text-xs text-muted-foreground">Current rubric scores are neutral-weight averages; missing, N/A, and unchecked criteria are excluded.</p></div><button type="button" className="inline-flex items-center gap-1 rounded-md border px-2 py-1 text-xs font-semibold focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--orange)]" aria-pressed={showEmpty} onClick={() => setShowEmpty((value) => !value)}><SlidersHorizontal size={13} /> {showEmpty ? "Hide categories without results" : "Show categories without results"}</button></div>
     {query.isLoading && !query.data ? <DashboardState compact title="Loading categories…" /> : query.isError ? <InlineError retry={query.refetch} /> : visibleCategories.length === 0 ? <EmptyCompact /> : <div className="mt-4"><CompactBars title={`Rubric categories · ${query.data?.rubric_revision || "current"}`} rows={visibleCategories} /></div>}
  </section>;
}

function CompactBars({ title, rows }) {
  return <div className="min-w-0"><h3 className="mb-2 text-xs font-semibold text-[var(--navy)]">{title}</h3>{rows.length === 0 ? <EmptyCompact /> : <div className="space-y-2">{rows.map((row) => <div key={row.name} className="grid grid-cols-[minmax(90px,1fr)_minmax(80px,2fr)_auto] items-center gap-2 text-xs"><span className="truncate" title={row.name}>{row.name}</span><div className="h-2 overflow-hidden rounded-full bg-muted">{row.score !== null && <div className="h-full rounded-full bg-[var(--orange)]" style={{ width: `${row.score * 10}%` }} />}</div><span className="font-mono text-muted-foreground">{row.score === null ? "N/A" : formatEvaluationScore(row.score)}</span></div>)}</div>}</div>;
}

function FindingsPanel({ title, scope, findings, total }) {
  const rows = severityRows(findings, scope);
  return <Section title={title}><div className="mb-3 flex items-baseline justify-between"><span className="text-xs text-muted-foreground">Unresolved findings</span><strong className="font-display text-xl text-[var(--navy)]">{total}</strong></div><div className="space-y-1.5">{rows.map((row) => <Link key={row.label} to={dashboardRecordPath(`${scope === "bassett" ? "bassett" : "comparison"}-open-findings-${row.slug}`)} className="grid grid-cols-[1fr_auto] rounded-md px-2 py-1.5 text-xs hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--orange)]"><span>{row.label}</span><span className="font-mono font-semibold">{row.value}</span></Link>)}</div></Section>;
}

function Metric({ label, value }) { return <div><div className="text-[10px] uppercase tracking-wide text-muted-foreground">{label}</div><div className="mt-0.5 font-semibold text-[var(--navy)]">{value}</div></div>; }
function EmptyCompact() { return <div role="status" className="rounded-md border border-dashed px-3 py-4 text-center text-xs text-muted-foreground">No evaluated records yet</div>; }
function DashboardState({ title, compact = false }) { return <div role="status" className={`${compact ? "py-4" : "py-8"} text-center text-sm text-muted-foreground`}><RefreshCw className="mx-auto mb-2 animate-spin" size={17} />{title}</div>; }
function InlineError({ retry }) { return <div role="alert" className="py-4 text-center text-xs text-muted-foreground">This section could not be loaded. <Button size="sm" variant="outline" className="ml-2" onClick={() => retry()}>Retry</Button></div>; }
