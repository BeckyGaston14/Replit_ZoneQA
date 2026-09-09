import { useQuery } from "@tanstack/react-query";
import { Link, useSearchParams } from "react-router-dom";
import { api } from "../lib/api";
import { PageHeader, StatCard, StatusBadge, SampleDataBanner, sampleScopeIncludesData, MethodologyDisclosure } from "../components/shared";
import { COVERAGE_STATUSES, statusDefinition } from "../lib/statusMaps";
import { Grid3X3, Building2, Tags, AlertTriangle, FlaskConical } from "lucide-react";
import { QueryState } from "../components/PageState";

export function coverageStatusForCount(value) {
  return value === 0 ? "no_tests" : value < 2 ? "thin" : "covered";
}

const BASSETT_COVERAGE_STATUSES = Object.fromEntries(Object.entries(COVERAGE_STATUSES).map(([key, definition]) => [key, {
  ...definition,
  description: definition.description.replace(/test cases?/g, (match) => match === "test case" ? "scenario" : "scenarios"),
}]));

function CoverageBar({ value, max, definitions = COVERAGE_STATUSES, noun = "tests" }) {
  const pct = max ? Math.min(100, (value / max) * 100) : 0;
  const status = coverageStatusForCount(value);
  return (
    <div className="h-2 w-full rounded-full bg-[var(--paper)] overflow-hidden" role="img" aria-label={`${statusDefinition(status, definitions).label}: ${value} ${noun}`}>
      <div className="h-full rounded-full" style={{ width: `${pct}%`, background: statusDefinition(status, definitions).color }} />
    </div>
  );
}

export function GapRow({ label, sub, tests, evaluated, max, testid, bassett = false }) {
  const status = coverageStatusForCount(tests);
  const definitions = bassett ? BASSETT_COVERAGE_STATUSES : COVERAGE_STATUSES;
  const noun = bassett ? "scenario" : "test";
  return (
    <div className="flex min-w-0 flex-col gap-2 py-2 border-b last:border-0 sm:flex-row sm:items-center sm:gap-3" data-testid={testid}>
      <div className="min-w-0 sm:w-56 sm:shrink-0">
        <div className="text-sm font-medium truncate text-[var(--navy)]">{label}</div>
        {sub && <div className="text-[11px] text-muted-foreground">{sub}</div>}
      </div>
      <div className="flex-1"><CoverageBar value={tests} max={max} definitions={definitions} noun={`${noun}${tests === 1 ? "" : "s"}`} /></div>
      <div className="flex shrink-0 flex-wrap items-center gap-2 text-xs sm:w-48 sm:justify-end sm:text-right">
        <StatusBadge value={status} definitions={definitions} compact />
        <span className="text-muted-foreground"><b className="text-[var(--navy)]">{tests}</b> {noun}{tests === 1 ? "" : "s"} · {evaluated} evaluation{evaluated === 1 ? "" : "s"}</span>
      </div>
    </div>
  );
}

export default function Coverage() {
  const [sp, setSp] = useSearchParams();
  const scope = ["bassett", "comparison", "both"].includes(sp.get("scope")) ? sp.get("scope") : "both";
  const setScope = (value) => {
    const next = new URLSearchParams(sp);
    if (value === "both") next.delete("scope"); else next.set("scope", value);
    setSp(next);
  };
  const query = useQuery({ queryKey: ["coverage", scope], queryFn: async () => (await api.get(`/analytics/coverage?scope=${scope}`)).data });
  const { data: d } = query;
  if (query.isLoading || query.isError) return <div><PageHeader title="Test Coverage" subtitle="Where the test suite is thin." /><QueryState query={query} resource="test coverage" testId="coverage-query" /></div>;
  const { summary: s, municipalities, categories, criticality, workflow_stages: workflowStages = [], complexities = [], priorities = [] } = d;
  const showComparison = scope !== "bassett";
  const showBassett = scope !== "comparison";
  const bassettCounts = d.population_counts?.bassett_only || {};
  const comparisonCounts = d.population_counts?.model_comparison || {};
  const maxMuni = Math.max(1, ...municipalities.map((m) => m.tests));
  const maxCat = Math.max(1, ...categories.map((c) => c.tests));
  const maxCrit = Math.max(1, ...criticality.map((c) => c.tests));
  const maxWorkflow = Math.max(1, ...workflowStages.map((row) => row.tests));
  const maxComplexity = Math.max(1, ...complexities.map((row) => row.tests));
  const maxPriority = Math.max(1, ...priorities.map((row) => row.tests));

  return (
    <div>
      <PageHeader title="Test Coverage" subtitle="Coverage across Bassett-only Test Bank scenarios and Model Comparison Test Cases.">
        <label className="flex items-center gap-2 text-sm">
          <span className="font-medium text-[var(--navy)]">Coverage scope</span>
          <select aria-label="Coverage scope" value={scope} onChange={(event) => setScope(event.target.value)} className="h-9 rounded-md border bg-background px-3 text-sm" data-testid="coverage-scope">
            <option value="bassett">Bassett Only</option>
            <option value="comparison">Model Comparison</option>
            <option value="both">Both</option>
          </select>
        </label>
      </PageHeader>
      <SampleDataBanner show={sampleScopeIncludesData({ records: [d] })} />
      <div className="grid grid-cols-2 md:grid-cols-5 gap-3 mb-6">
        <StatCard label="Coverage Gaps" value={s.gap_count} accent={s.gap_count ? "#dc2626" : "#16a34a"} icon={AlertTriangle} testid="coverage-gaps" />
        <StatCard label="Total Tests" value={s.total_tests} sub={`${s.evaluated_tests} evaluated`} accent="#16215a" icon={FlaskConical} />
        {showBassett && <StatCard label="Bassett-Only Scenarios" value={bassettCounts.total_tests || 0} sub={`${bassettCounts.evaluated_tests || 0} evaluated`} accent="#f47b20" icon={Grid3X3} />}
        {showComparison && <StatCard label="Model Comparison Cases" value={comparisonCounts.total_tests || 0} sub={`${comparisonCounts.evaluated_tests || 0} evaluated`} accent="#2f3f96" icon={FlaskConical} />}
        {scope === "bassett" && <StatCard label="Workflow Stages" value={`${workflowStages.filter((row) => row.tests > 0).length}/${workflowStages.length}`} sub="with scenarios" accent="#2f3f96" icon={Tags} />}
        {scope === "comparison" && <StatCard label="Municipalities" value={`${s.munis_covered}/${s.munis_total}`} sub="with tests" accent="#2f3f96" icon={Building2} />}
        {showComparison && <StatCard label="Categories" value={`${s.categories_covered}/${s.categories_total}`} sub="with tests" accent="#f47b20" icon={Tags} />}
        {showComparison && <StatCard label="Criticality Levels" value={`${s.crit_covered}/5`} sub="with tests" accent="#0ea5e9" icon={Grid3X3} />}
      </div>

      <div className="grid lg:grid-cols-2 gap-4">
        {showBassett && <div className="bg-card border rounded-xl p-5" data-testid="coverage-workflow-stages">
          <div className="flex items-center justify-between mb-2">
            <h3 className="font-semibold font-display text-[var(--navy)]">Bassett-Only · Workflow Stages</h3>
            <Link to="/bassett/test-bank" className="text-xs text-[var(--orange)] font-semibold hover:underline">Open Test Bank →</Link>
          </div>
          {workflowStages.map((row) => <GapRow key={row.value} label={row.value} tests={row.tests} evaluated={row.evaluated} max={maxWorkflow} bassett />)}
        </div>}

        {showBassett && <div className="space-y-4">
          <div className="bg-card border rounded-xl p-5" data-testid="coverage-complexity">
            <h3 className="font-semibold font-display text-[var(--navy)] mb-2">Bassett-Only · Complexity</h3>
            {complexities.map((row) => <GapRow key={row.value} label={row.value} tests={row.tests} evaluated={row.evaluated} max={maxComplexity} bassett />)}
          </div>
          <div className="bg-card border rounded-xl p-5" data-testid="coverage-priority">
            <h3 className="font-semibold font-display text-[var(--navy)] mb-2">Bassett-Only · Priority</h3>
            {priorities.map((row) => <GapRow key={row.value} label={row.value} tests={row.tests} evaluated={row.evaluated} max={maxPriority} bassett />)}
          </div>
        </div>}

        {showComparison && <>
        <div className="bg-card border rounded-xl p-5" data-testid="coverage-categories">
          <div className="flex items-center justify-between mb-2">
            <h3 className="font-semibold font-display text-[var(--navy)]">Categories</h3>
            <Link to="/testcases" className="text-xs text-[var(--orange)] font-semibold hover:underline">Add tests →</Link>
          </div>
          {categories.map((c) => <GapRow key={c.category} label={c.category} tests={c.tests} evaluated={c.evaluated} max={maxCat} testid="coverage-cat-row" />)}
        </div>

        <div className="space-y-4">
          <div className="bg-card border rounded-xl p-5" data-testid="coverage-municipalities">
            <h3 className="font-semibold font-display text-[var(--navy)] mb-2">Municipalities</h3>
            {municipalities.map((m) => <GapRow key={m.id} label={m.name} sub={m.state} tests={m.tests} evaluated={m.evaluated} max={maxMuni} testid="coverage-muni-row" />)}
          </div>
          <div className="bg-card border rounded-xl p-5" data-testid="coverage-criticality">
            <h3 className="font-semibold font-display text-[var(--navy)] mb-2">Criticality Levels</h3>
            {criticality.map((c) => <GapRow key={c.level} label={`${c.level} — ${c.label}`} tests={c.tests} evaluated={c.evaluated} max={maxCrit} testid="coverage-crit-row" />)}
          </div>
        </div>
        </>}
       <MethodologyDisclosure title="How coverage metrics are calculated" testid="coverage-methodology">
         <p>Coverage counts the latest qualifying result per active test definition in the selected scope. Both combines the two populations without merging unlike dimensions.</p>
         <p>Bassett-only coverage uses Test Bank workflow stage, complexity, and priority. Model Comparison coverage uses municipality, category, and criticality. Expanded or linked Bassett-only runs are excluded from the Bassett-only population to prevent double counting.</p>
         <p>Each row preserves its visible numerator and denominator as tests and evaluations. Sample visibility follows the current account scope.</p>
       </MethodologyDisclosure>
      </div>
    </div>
  );
}
