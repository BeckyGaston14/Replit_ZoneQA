import { useEffect } from "react";
import { useSearchParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { api } from "../lib/api";
import { useCollection, useConfig, useSavedView } from "../lib/hooks";
import { PageHeader, StatCard, SrTable, StatusBadge, SampleDataBanner, sampleScopeIncludesData, MethodologyDisclosure, EmptyState } from "../components/shared";
import { fmtScore } from "../lib/format";
import { Trophy, TrendingDown, AlertOctagon, Target, FilterX } from "lucide-react";
import { RadarChart, PolarGrid, PolarAngleAxis, PolarRadiusAxis, Radar, Tooltip } from "recharts";
import { SortableTableHeader } from "../components/SortableTableHeader";
import { TableSortControls } from "../components/TableSortControls";
import { nextSort, sortTableRows, usePersistentTableSort } from "../lib/tableSorting";
import { TABLE_CLASS, TABLE_FRAME_CLASS, TABLE_HEAD_CLASS } from "../lib/tableStyles";
import { SafeResponsiveContainer } from "../components/SafeResponsiveContainer";
import { EVALUATION_SCALE_LABEL, EVALUATION_SCORE_DOMAIN, EVALUATION_SCORE_TICKS, evaluationScoreOrNull, formatEvaluationScore } from "../lib/evaluationScale";
import { MODEL_COLORS } from "../lib/modelColors";
import { Button } from "../components/ui/button";
import { CURRENT_RUBRIC_CATEGORIES } from "../lib/scoringGroups";
import { SEVERITY_LABELS } from "../lib/severity";
import { QueryState } from "../components/PageState";

const DIM_LABELS = { accuracy: "Accuracy", current_code: "Current Code", interpretation: "Interpretation", calculation: "Calculation", context: "Context", missing_info: "Missing Info", followup: "Follow-Up", citation_accuracy: "Citation", source_quality: "Source Quality", guidance: "Guidance", completeness: "Completeness", usefulness: "Usefulness" };
const ALL = "";
const DEFAULT_FILTERS = { scope: "both", version: ALL, environment: ALL, project_id: ALL, municipality_id: ALL, category: ALL, criticality: ALL, include_variants: "true", date_from: ALL, date_to: ALL };
const MODEL_COLUMNS = [
  { key: "model", label: "Model", type: "natural" },
  { key: "avg_score", label: "Avg Score", type: "score" },
  { key: "passed", label: "Passed", type: "count" },
  { key: "failed", label: "Failed", type: "count" },
];

export default function Performance() {
  const configQuery = useConfig();
  const versionsQuery = useCollection("versions");
  const projectsQuery = useCollection("projects");
  const munisQuery = useCollection("municipalities");
  const { data: config } = configQuery;
  const { data: versions = [] } = versionsQuery;
  const { data: projects = [] } = projectsQuery;
  const { data: munis = [] } = munisQuery;
  const [sp, setSp] = useSearchParams();
  const savedView = useSavedView("performance", { filters: DEFAULT_FILTERS }, (saved = {}) => ({ filters: { ...DEFAULT_FILTERS, ...(saved.filters || {}) } }));
  const savedFilters = savedView.state?.filters || DEFAULT_FILTERS;
  const flt = Object.fromEntries(Object.keys(DEFAULT_FILTERS).map((key) => [key, sp.has(key) ? sp.get(key) : savedFilters[key]]));
  const setFilter = (key, value) => {
    const next = { ...flt, [key]: value };
    savedView.updateState({ filters: next });
    const params = new URLSearchParams(sp);
    if (value === DEFAULT_FILTERS[key]) params.delete(key);
    else params.set(key, value);
    setSp(params);
  };
  const clearFilters = () => {
    savedView.updateState({ filters: DEFAULT_FILTERS });
    const params = new URLSearchParams(sp);
    Object.keys(DEFAULT_FILTERS).forEach((key) => params.delete(key));
    setSp(params);
  };
  const setPerformanceScope = (value) => {
    const next = { ...flt, scope: value, category: ALL, criticality: ALL, include_variants: "true" };
    savedView.updateState({ filters: next });
    const params = new URLSearchParams(sp);
    params.set("scope", value);
    params.delete("category");
    params.delete("criticality");
    params.delete("include_variants");
    setSp(params);
  };
  useEffect(() => {
    if (savedView.loading) return;
    const invalidProject = flt.project_id && !projectsQuery.isLoading && !projects.some((item) => item.id === flt.project_id);
    const invalidMunicipality = flt.municipality_id && !munisQuery.isLoading && !munis.some((item) => item.id === flt.municipality_id);
    const invalidVersion = flt.version && !versionsQuery.isLoading && !versions.some((item) => item.name === flt.version);
    if (!invalidProject && !invalidMunicipality && !invalidVersion) return;
    const next = {
      ...flt,
      project_id: invalidProject ? ALL : flt.project_id,
      municipality_id: invalidMunicipality ? ALL : flt.municipality_id,
      version: invalidVersion ? ALL : flt.version,
    };
    savedView.updateState({ filters: next });
    const params = new URLSearchParams(sp);
    if (invalidProject) params.delete("project_id");
    if (invalidMunicipality) params.delete("municipality_id");
    if (invalidVersion) params.delete("version");
    setSp(params, { replace: true });
  // URL state wins over the saved view; this effect only removes stale relation IDs.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [savedView.loading, projects, munis, versions, projectsQuery.isLoading, munisQuery.isLoading, versionsQuery.isLoading]);
  const defaultSort = { key: "model", direction: "asc" };
  const [sort, setSort] = usePersistentTableSort("performance-model-summary", MODEL_COLUMNS, defaultSort);

  const qs = Object.entries(flt).filter(([, v]) => v !== ALL && v !== "").map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join("&");
  const perfQuery = useQuery({ queryKey: ["perf", qs], queryFn: async ({ signal } = {}) => (await api.get(`/analytics/performance${qs ? `?${qs}` : ""}`, { signal })).data });
  const perf = perfQuery.data;
  const supportingQueries = [configQuery, versionsQuery, projectsQuery, munisQuery];
  const failed = supportingQueries.find((query) => query.isError) || (perfQuery.isError ? perfQuery : null);
  const loading = supportingQueries.some((query) => query.isLoading) || perfQuery.isLoading;

  const bassett = (perf?.model_summary || []).find((m) => m.model === "Bassett");
  const RADAR_SHORT = { accuracy: "Accuracy", citation_accuracy: "Citation", interpretation: "Interpret.", calculation: "Calc.", context: "Context", completeness: "Complete.", usefulness: "Useful.", current_code: "Current Code", missing_info: "Missing Info", followup: "Follow-Up", source_quality: "Source Qual.", guidance: "Guidance" };
  const dimensionRows = (perf?.rubric_categories || perf?.current_rubric_categories || CURRENT_RUBRIC_CATEGORIES.map((group) => ({ ...group, score: null }))).map((group) => ({ dim: group.label, full: group.label, score: evaluationScoreOrNull(group.score ?? group.avg_score), underlying: group.scored_value_count ?? group.scoredValueCount ?? group.count ?? 0 }));
  const radar = dimensionRows.filter((dimension) => dimension.score !== null);
  const hasFilters = Object.keys(DEFAULT_FILTERS).some((key) => flt[key] !== DEFAULT_FILTERS[key]);

  const sel = (key, opts, label, testid) => (
    <select key={key} value={flt[key]} onChange={(e) => setFilter(key, e.target.value)} aria-label={label} data-testid={testid}
      className="h-8 text-xs border rounded-lg px-2 bg-card text-[var(--navy)] max-w-[170px]">
      <option value={ALL}>{label}</option>
      {opts.map((o) => <option key={o.value ?? o} value={o.value ?? o}>{o.label ?? o}</option>)}
    </select>
  );

  return (
    <div>
      <PageHeader title="Bassett Performance & Reward" subtitle={perf ? `Scope: ${perf.scope}` : "Performance across Bassett-only and Model Comparison testing."} />
      <SampleDataBanner show={sampleScopeIncludesData({ versions, selectedVersion: flt.version, records: [perf] })} />
      {savedView.error && <div role="alert" className="mb-3 rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900">{savedView.error} <button type="button" className="ml-2 font-semibold underline" onClick={savedView.retry}>Retry saved view</button></div>}
      {failed && <QueryState query={failed} resource="performance data" testId="performance" />}
      {loading && !failed && <QueryState query={{ isLoading: true }} resource="performance data" testId="performance" />}
      {!loading && !failed && perf && <>
      {perf.insufficient_evidence && <div className="mb-4 rounded-xl border border-slate-300 bg-slate-50 p-4 text-sm text-slate-800" data-testid="performance-insufficient-evidence">Insufficient Evidence: this {perf.report_scope || "selected"} report has {perf.release_evidence?.evaluated || 0} of {perf.minimum_qualifying_tests} qualifying tests completed. Findings and metrics remain visible for investigation.</div>}
      <div className="flex items-center gap-2 mb-4 flex-wrap" data-testid="perf-filter-bar">
        <select value={flt.scope} onChange={(event) => setPerformanceScope(event.target.value)} aria-label="Performance scope" data-testid="perf-filter-scope" className="h-8 text-xs border rounded-lg px-2 bg-card text-[var(--navy)] max-w-[170px]">
          <option value="bassett">Bassett Only</option>
          <option value="comparison">Model Comparison</option>
          <option value="both">Both</option>
        </select>
        {sel("version", versions.map((v) => v.name), "All Bassett versions", "perf-filter-version")}
        {sel("environment", ["Production", "Staging", "Development"], "All environments", "perf-filter-environment")}
        {sel("project_id", projects.map((p) => ({ value: p.id, label: p.name })), "All projects", "perf-filter-project")}
        {sel("municipality_id", munis.map((m) => ({ value: m.id, label: `${m.name}, ${m.state}` })), "All municipalities", "perf-filter-municipality")}
        {sel("category", flt.scope === "bassett" ? ["Research", "Analysis"] : config?.categories || [], "All categories", "perf-filter-category")}
        {flt.scope !== "bassett" && sel("criticality", SEVERITY_LABELS.map((label, index) => ({ value: String(index + 1), label })), "All severity", "perf-filter-criticality")}
        {flt.scope !== "bassett" && sel("include_variants", [{ value: "true", label: "Variants included" }, { value: "false", label: "Variants excluded" }], "Variants included (default)", "perf-filter-variants")}
        <input type="date" value={flt.date_from} onChange={(e) => setFilter("date_from", e.target.value)} className="h-8 max-w-full text-xs border rounded-lg px-2 bg-card" data-testid="perf-filter-from" aria-label="Evaluated from date" title="Evaluated from date" />
        <input type="date" value={flt.date_to} onChange={(e) => setFilter("date_to", e.target.value)} className="h-8 max-w-full text-xs border rounded-lg px-2 bg-card" data-testid="perf-filter-to" aria-label="Evaluated to date" title="Evaluated to date" />
        {hasFilters && (
          <button className="h-8 text-xs px-2 rounded-lg border text-[var(--orange)] border-[var(--orange)]/40 hover:bg-orange-50 flex items-center gap-1" data-testid="perf-clear-filters"
            onClick={clearFilters}>
            <FilterX size={12} /> Clear
          </button>
        )}
      </div>
      {(perf.model_summary || []).length === 0 && <div className="mb-4" data-testid="performance-empty">
        <EmptyState
          title={hasFilters ? "No qualifying evaluations match these filters." : "No qualifying evaluations are available yet."}
          description={hasFilters ? "Clear the filters to review the full performance scope." : "Complete an eligible evaluation to populate performance reporting."}
          action={hasFilters ? <Button size="sm" variant="outline" onClick={clearFilters}>Clear filters</Button> : null}
          testid="performance-empty-state"
        />
      </div>}

      <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-6">
        <StatCard label="Overall Bassett Score" value={bassett ? fmtScore(bassett.avg_score) : "—"} sub="/ 10 avg" accent={MODEL_COLORS.Bassett} icon={Target} testid="perf-overall-score" title="Mean of the latest non-retest Bassett evaluation per test case within the active scope." />
        <StatCard label="Bassett Wins" value={perf.report_scope === "bassett" ? "—" : perf.wins} sub={perf.report_scope === "bassett" ? "requires Model Comparison" : "beat both benchmarks"} accent="#16a34a" icon={Trophy} />
        <StatCard label="Bassett Losses" value={perf.report_scope === "bassett" ? "—" : perf.losses} sub={perf.report_scope === "bassett" ? "requires Model Comparison" : "benchmark outperformed"} accent="#dc2626" icon={TrendingDown} />
        <StatCard label="Shared Failures" value={perf.report_scope === "bassett" ? "—" : perf.shared_failures} sub={perf.report_scope === "bassett" ? "requires Model Comparison" : "all compared models failed"} accent="#64748b" icon={AlertOctagon} />
      </div>

      <div className="mb-4">
        <div className="bg-card border rounded-xl p-5">
           <h3 className="font-semibold font-display text-[var(--navy)] mb-3">Current Rubric Categories</h3>
            <p className="text-xs text-muted-foreground mb-2">Revision {perf.rubric_revision || "2026-09-16"} · {EVALUATION_SCALE_LABEL}. Neutral-weight averages of selected criteria; zero is valid and missing, N/A, and unchecked criteria are excluded.</p>
           {radar.length < 3 ? <div role="status" className="rounded-lg border border-dashed p-6 text-sm text-muted-foreground">No complete current-rubric chart is available for this scope. Score at least three categories to display the radar; available values remain listed in the accessible table below.</div> : <SafeResponsiveContainer height={300} testId="performance-radar-chart">
            <RadarChart data={radar}>
              <PolarGrid gridType="polygon" /><PolarAngleAxis dataKey="dim" tick={{ fontSize: 10 }} />
              <PolarRadiusAxis domain={EVALUATION_SCORE_DOMAIN} ticks={EVALUATION_SCORE_TICKS} tick={{ fontSize: 10 }} axisLine={false} />
              <Tooltip formatter={(v) => [formatEvaluationScore(v), "Score (0–10)"]} labelFormatter={(l, p) => p?.[0]?.payload?.full || l} />
              <Radar dataKey="score" stroke={MODEL_COLORS.Bassett} fill={MODEL_COLORS.Bassett} fillOpacity={0.4} />
            </RadarChart>
          </SafeResponsiveContainer>}
           <SrTable caption="Current rubric category averages. Scale: 0 to 10." columns={["Current category", "Average score out of 10", "Scored criteria"]} rows={dimensionRows.map((r) => [r.full, formatEvaluationScore(r.score), `${r.underlying} scored criteria`])} />
        </div>
      </div>

      <div className={`${TABLE_FRAME_CLASS} p-5`} role="region" aria-label="Model summary table" tabIndex="0" data-testid="performance-table-scroll">
        <h3 className="font-semibold font-display text-[var(--navy)] mb-1">{perf.report_scope === "bassett" ? "Bassett Summary" : "Model Summary"}</h3>
        <p className="mb-3 text-xs text-muted-foreground">{perf.population_counts?.bassett_only || 0} Bassett-only · {perf.population_counts?.model_comparison || 0} Model Comparison Bassett evaluations</p>
        <TableSortControls columns={MODEL_COLUMNS} sort={sort} setSort={setSort} defaultSort={defaultSort} className="mb-2" />
        <table className={TABLE_CLASS}>
          <thead className={TABLE_HEAD_CLASS}><tr>{MODEL_COLUMNS.map((column) => <SortableTableHeader key={column.key} column={column} sort={sort} onSort={(key) => setSort((current) => nextSort(current, key))} />)}</tr></thead>
          <tbody>{sortTableRows(perf.model_summary || [], MODEL_COLUMNS, sort, ["model"]).map((m) => (
            <tr key={m.model} className="border-t" data-testid={`model-summary-${m.model.toLowerCase()}`}><td className="py-2 font-semibold" style={{ color: MODEL_COLORS[m.model] || "var(--navy)" }}>{m.model}</td><td>{fmtScore(m.avg_score)}</td><td><span className="inline-flex items-center gap-2"><StatusBadge value="Pass" compact /><span>{m.passed}</span></span></td><td><span className="inline-flex items-center gap-2"><StatusBadge value="Fail" compact /><span>{m.failed}</span></span></td></tr>
          ))}</tbody>
        </table>
      </div>
       <MethodologyDisclosure title="How performance metrics are calculated" testid="performance-methodology">
         <p>{perf.scope || "Current filtered performance scope."} The active filters above, including version, environment, project, municipality, category, criticality, variants, and evaluated date range, define the population.</p>
         <p>Overall scores are means of available 0–10 scores from the selected population. In Both, Bassett-only runs expanded or linked to Model Comparison are excluded to prevent double counting.</p>
         <p>Wins, losses, and shared failures use Model Comparison records only because Bassett-only runs have no benchmark response.</p>
         <p>Current rubric categories use neutral-weight averages of selected applicable criteria. Missing, N/A, and unchecked criteria are excluded and never treated as zero; zero is a valid score.</p>
       </MethodologyDisclosure>
      </>}
    </div>
  );
}
