import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { api } from "../lib/api";
import { PageHeader, StatCard, StatusBadge } from "../components/shared";
import { COVERAGE_STATUSES, statusDefinition } from "../lib/statusMaps";
import { Grid3X3, Building2, Tags, AlertTriangle, FlaskConical } from "lucide-react";
import { QueryState } from "../components/PageState";

export function coverageStatusForCount(value) {
  return value === 0 ? "no_tests" : value < 2 ? "thin" : "covered";
}

function CoverageBar({ value, max }) {
  const pct = max ? Math.min(100, (value / max) * 100) : 0;
  const status = coverageStatusForCount(value);
  return (
    <div className="h-2 w-full rounded-full bg-[var(--paper)] overflow-hidden" role="img" aria-label={`${statusDefinition(status, COVERAGE_STATUSES).label}: ${value} tests`}>
      <div className="h-full rounded-full" style={{ width: `${pct}%`, background: statusDefinition(status, COVERAGE_STATUSES).color }} />
    </div>
  );
}

export function GapRow({ label, sub, tests, evaluated, max, testid }) {
  const status = coverageStatusForCount(tests);
  return (
    <div className="flex min-w-0 flex-col gap-2 py-2 border-b last:border-0 sm:flex-row sm:items-center sm:gap-3" data-testid={testid}>
      <div className="min-w-0 sm:w-56 sm:shrink-0">
        <div className="text-sm font-medium truncate text-[var(--navy)]">{label}</div>
        {sub && <div className="text-[11px] text-muted-foreground">{sub}</div>}
      </div>
      <div className="flex-1"><CoverageBar value={tests} max={max} /></div>
      <div className="flex shrink-0 flex-wrap items-center gap-2 text-xs sm:w-48 sm:justify-end sm:text-right">
        <StatusBadge value={status} definitions={COVERAGE_STATUSES} compact />
        <span className="text-muted-foreground"><b className="text-[var(--navy)]">{tests}</b> test{tests === 1 ? "" : "s"} · {evaluated} evaluation{evaluated === 1 ? "" : "s"}</span>
      </div>
    </div>
  );
}

export default function Coverage() {
  const query = useQuery({ queryKey: ["coverage"], queryFn: async () => (await api.get("/analytics/coverage")).data });
  const { data: d } = query;
  if (query.isLoading || query.isError) return <div><PageHeader title="Test Coverage" subtitle="Where the test suite is thin." /><QueryState query={query} resource="test coverage" testId="coverage-query" /></div>;
  const { summary: s, municipalities, categories, criticality } = d;
  const maxMuni = Math.max(1, ...municipalities.map((m) => m.tests));
  const maxCat = Math.max(1, ...categories.map((c) => c.tests));
  const maxCrit = Math.max(1, ...criticality.map((c) => c.tests));

  return (
    <div>
      <PageHeader title="Test Coverage" subtitle="Where the test suite is thin — municipalities, categories and criticality levels lacking tests." />
      <div className="grid grid-cols-2 md:grid-cols-5 gap-3 mb-6">
        <StatCard label="Coverage Gaps" value={s.gap_count} accent={s.gap_count ? "#dc2626" : "#16a34a"} icon={AlertTriangle} testid="coverage-gaps" />
        <StatCard label="Total Tests" value={s.total_tests} sub={`${s.evaluated_tests} evaluated`} accent="#16215a" icon={FlaskConical} />
        <StatCard label="Municipalities" value={`${s.munis_covered}/${s.munis_total}`} sub="with tests" accent="#2f3f96" icon={Building2} />
        <StatCard label="Categories" value={`${s.categories_covered}/${s.categories_total}`} sub="with tests" accent="#f47b20" icon={Tags} />
        <StatCard label="Criticality Levels" value={`${s.crit_covered}/5`} sub="with tests" accent="#0ea5e9" icon={Grid3X3} />
      </div>

      <div className="grid lg:grid-cols-2 gap-4">
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
      </div>
    </div>
  );
}
