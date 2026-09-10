import { useQuery } from "@tanstack/react-query";
import { Link, useSearchParams } from "react-router-dom";
import { api } from "../lib/api";
import { PageHeader, StatCard, StatusBadge, SampleDataBanner, sampleScopeIncludesData, MethodologyDisclosure } from "../components/shared";
import { COVERAGE_STATUSES } from "../lib/statusMaps";
import { Grid3X3, Building2, Tags, AlertTriangle, FlaskConical } from "lucide-react";
import { QueryState } from "../components/PageState";

export function coverageStatusForCount(tests, evaluated = 0) {
  if (tests === 0) return "not_represented";
  if (evaluated === 0) return "defined_not_evaluated";
  return evaluated >= tests ? "fully_evaluated" : "partially_evaluated";
}

const BASSETT_COVERAGE_STATUSES = Object.fromEntries(Object.entries(COVERAGE_STATUSES).map(([key, definition]) => [key, {
  ...definition,
  description: definition.description.replace(/test cases?/g, (match) => match === "test case" ? "scenario" : "scenarios"),
}]));

export function GapRow({ label, sub, tests, evaluated, testid, bassett = false }) {
  const status = coverageStatusForCount(tests, evaluated);
  const definitions = bassett ? BASSETT_COVERAGE_STATUSES : COVERAGE_STATUSES;
  const noun = bassett ? "scenario" : "test";
  return (
    <div className="mb-2 flex min-w-0 flex-col gap-2 rounded-lg bg-[var(--paper)] px-3 py-3 last:mb-0 sm:flex-row sm:items-center sm:justify-between sm:gap-4" data-testid={testid}>
      <div className="min-w-0 sm:flex-1">
        <div className="text-sm font-medium truncate text-[var(--navy)]">{label}</div>
        {sub && <div className="text-[11px] text-muted-foreground">{sub}</div>}
      </div>
      <div className="flex shrink-0 flex-wrap items-center gap-2 text-xs sm:justify-end sm:text-right">
        <StatusBadge value={status} definitions={definitions} compact />
        <span className="text-muted-foreground"><b className="text-[var(--navy)]">{evaluated} of {tests}</b> {noun}{tests === 1 ? "" : "s"} evaluated</span>
      </div>
    </div>
  );
}

function EmptyCoverage({ children }) {
  return <div className="rounded-lg bg-[var(--paper)] px-4 py-6 text-center text-sm text-muted-foreground">{children}</div>;
}

function PopulationSummary({ title, population }) {
  const total = population?.total_tests || 0;
  const evaluated = population?.evaluated_tests || 0;
  const percent = total ? Math.round((evaluated / total) * 1000) / 10 : 0;
  return <div className="rounded-xl border bg-card p-4">
    <div className="text-sm font-semibold text-[var(--navy)]">{title}</div>
    <div className="mt-2 flex flex-wrap gap-x-5 gap-y-1 text-xs text-muted-foreground">
      <span><b className="text-base text-[var(--navy)]">{evaluated}/{total}</b> evaluated</span>
      <span><b className="text-base text-[var(--navy)]">{percent}%</b> coverage</span>
      <span><b className="text-base text-[var(--navy)]">{population?.gap_count || 0}</b> uncovered groupings</span>
    </div>
  </div>;
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
  const total = s.total_tests || 0;
  const evaluated = s.evaluated_tests || 0;
  const remaining = Math.max(0, total - evaluated);
  const coverageRate = total ? Math.round((evaluated / total) * 1000) / 10 : 0;

  return (
    <div>
      <PageHeader title="Test Coverage" subtitle="Coverage across Bassett-only Test Bank scenarios and Model Comparison Test Cases.">
      </PageHeader>
      <div className="mb-5 inline-flex flex-wrap rounded-xl border bg-card p-1" role="group" aria-label="Coverage scope" data-testid="coverage-scope">
        {[["bassett", "Bassett Only"], ["comparison", "Model Comparison"], ["both", "Both"]].map(([value, label]) => <button key={value} type="button" aria-pressed={scope === value} onClick={() => setScope(value)} className={`rounded-lg px-4 py-2 text-sm font-medium transition-colors ${scope === value ? "bg-[var(--navy)] text-white" : "text-[var(--navy)] hover:bg-[var(--paper)]"}`}>{label}</button>)}
      </div>
      <SampleDataBanner show={sampleScopeIncludesData({ records: [d] })} />
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4 mb-4">
        <StatCard label="Scenarios Needing Evaluation" value={remaining} sub="active definitions without a qualifying evaluation" accent={remaining ? "#b45309" : "#16a34a"} icon={AlertTriangle} />
        <StatCard label="Evaluated" value={`${evaluated} of ${total}`} sub="active definitions" accent="#16215a" icon={FlaskConical} />
        <StatCard label="Coverage Rate" value={`${coverageRate}%`} sub="evaluated ÷ active definitions" accent="#15803d" icon={Grid3X3} />
        <StatCard label="Coverage Gaps by Attribute" value={s.gap_count} sub="supporting breakdown; not a count of unique tests" accent={s.gap_count ? "#dc2626" : "#16a34a"} icon={Tags} testid="coverage-gaps" />
      </div>
      {scope === "both" && <div className="mb-6 grid gap-3 md:grid-cols-2"><PopulationSummary title="Bassett-Only summary" population={bassettCounts} /><PopulationSummary title="Model Comparison summary" population={comparisonCounts} /></div>}

      <div className={scope === "both" ? "grid items-start gap-6 lg:grid-cols-2" : "space-y-8"}>
        {showBassett && <section aria-labelledby="bassett-coverage-heading" className="self-start">
          <div className="mb-3"><h2 id="bassett-coverage-heading" className="text-lg font-bold font-display text-[var(--navy)]">Bassett-Only Coverage</h2><p className="text-sm text-muted-foreground">Coverage of reusable Test Bank scenarios by their defining attributes.</p></div>
          <div className={`grid items-start gap-4 ${scope === "both" ? "" : "lg:grid-cols-2"}`}><div className="self-start bg-card border rounded-xl p-5" data-testid="coverage-workflow-stages">
          <div className="flex items-center justify-between mb-2">
            <h3 className="font-semibold font-display text-[var(--navy)]">Bassett-Only · Categories</h3>
            <Link to="/bassett/test-bank" className="text-xs text-[var(--orange)] font-semibold hover:underline">Open Test Bank →</Link>
          </div>
          {workflowStages.map((row) => <GapRow key={row.value} label={row.value} tests={row.tests} evaluated={row.evaluated} bassett />)}
          </div>

        <div className="space-y-4">
          <div className="bg-card border rounded-xl p-5" data-testid="coverage-complexity">
            <h3 className="font-semibold font-display text-[var(--navy)] mb-2">Bassett-Only · Complexity</h3>
            {complexities.map((row) => <GapRow key={row.value} label={row.value} tests={row.tests} evaluated={row.evaluated} bassett />)}
          </div>
          <div className="bg-card border rounded-xl p-5" data-testid="coverage-priority">
            <h3 className="font-semibold font-display text-[var(--navy)] mb-2">Bassett-Only · Priority</h3>
            {priorities.map((row) => <GapRow key={row.value} label={row.value} tests={row.tests} evaluated={row.evaluated} bassett />)}
          </div>
        </div></div>
        </section>}

        {showComparison && <section aria-labelledby="comparison-coverage-heading" className="self-start">
          <div className="mb-3"><h2 id="comparison-coverage-heading" className="text-lg font-bold font-display text-[var(--navy)]">Model Comparison Coverage</h2><p className="text-sm text-muted-foreground">Coverage of test cases evaluated across Bassett and benchmark models.</p></div>
          {comparisonCounts.total_tests ? <div className={`grid items-start gap-4 ${scope === "both" ? "" : "lg:grid-cols-2"}`}><>
        <div className="bg-card border rounded-xl p-5" data-testid="coverage-categories">
          <div className="flex items-center justify-between mb-2">
            <h3 className="font-semibold font-display text-[var(--navy)]">Categories</h3>
            <Link to="/testcases" className="text-xs text-[var(--orange)] font-semibold hover:underline">Add tests →</Link>
          </div>
          {categories.map((c) => <GapRow key={c.category} label={c.category} tests={c.tests} evaluated={c.evaluated} testid="coverage-cat-row" />)}
        </div>

        <div className="space-y-4">
          <div className="bg-card border rounded-xl p-5" data-testid="coverage-municipalities">
            <h3 className="font-semibold font-display text-[var(--navy)] mb-2">Municipalities</h3>
            {municipalities.length ? municipalities.map((m) => <GapRow key={m.id} label={m.name} sub={m.state} tests={m.tests} evaluated={m.evaluated} testid="coverage-muni-row" />) : <EmptyCoverage>No active Model Comparison test cases are linked to a municipality.</EmptyCoverage>}
          </div>
          <div className="bg-card border rounded-xl p-5" data-testid="coverage-criticality">
            <h3 className="font-semibold font-display text-[var(--navy)] mb-2">Criticality Levels</h3>
            {criticality.map((c) => <GapRow key={c.level} label={`${c.level} — ${c.label}`} tests={c.tests} evaluated={c.evaluated} testid="coverage-crit-row" />)}
          </div>
        </div>
        </></div> : <EmptyCoverage>No active Model Comparison test cases are available. Add a test case to begin measuring model-comparison coverage.</EmptyCoverage>}
        </section>}
       <MethodologyDisclosure title="How coverage metrics are calculated" testid="coverage-methodology">
         <p>Fully Evaluated means every active definition in the row has a qualifying completed evaluation. Partially Evaluated means only some definitions do. Defined, Not Evaluated means definitions exist but none has been evaluated; Not Represented means no active definition exists.</p>
         <p>Bassett-only coverage uses Test Bank category, complexity, and priority. Model Comparison coverage uses municipality, category, and criticality. Expanded or linked Bassett-only runs are excluded from the Bassett-only population to prevent double counting.</p>
         <p>Each row preserves its visible numerator and denominator as tests and evaluations. Sample visibility follows the current account scope.</p>
       </MethodologyDisclosure>
      </div>
    </div>
  );
}
