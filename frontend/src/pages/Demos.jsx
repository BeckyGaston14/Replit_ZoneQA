import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { api } from "../lib/api";
import { PageHeader, StatusBadge } from "../components/shared";
import { DEMO_STATUSES } from "../lib/statusMaps";
import { QueryState } from "../components/PageState";

export default function Demos() {
  const demosQuery = useQuery({ queryKey: ["demos"], queryFn: async () => (await api.get("/demos")).data });
  const testcasesQuery = useQuery({ queryKey: ["tc-enriched"], queryFn: async () => (await api.get("/list/testcases-enriched")).data });
  const demos = demosQuery.data || [];
  const tcs = testcasesQuery.data || [];
  const tcMap = Object.fromEntries(tcs.map((t) => [t.id, t]));
  const failedQuery = demosQuery.isError ? demosQuery : testcasesQuery.isError ? testcasesQuery : null;

  return (
    <div>
      <PageHeader title="Demo Library" subtitle="Human-approved examples of Bassett at its strongest — curated for customer demos." />
      {(demosQuery.isLoading || testcasesQuery.isLoading) && <QueryState query={{ isLoading: true }} resource="demo library" testId="demos-query" />}
      {failedQuery && <QueryState query={failedQuery} resource="demo library" testId="demos-query" />}
      {!demosQuery.isLoading && !testcasesQuery.isLoading && !failedQuery && demos.length === 0 && <p className="text-muted-foreground">No demo-approved tests yet.</p>}
      {!failedQuery && (
      <div className="grid md:grid-cols-2 gap-4">
        {demos.map((d) => { const tc = tcMap[d.testcase_id]; return (
           <Link key={d.id} to={`/testcases/${d.testcase_id}`} className="block bg-card border rounded-xl p-5 card-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--orange)] focus-visible:ring-offset-2" data-testid="demo-card">
             <div className="flex items-center gap-2 mb-2 flex-wrap"><StatusBadge value={d.status || "Approved"} definitions={DEMO_STATUSES} compact /><span className="text-xs text-muted-foreground">{d.bassett_version}</span>
              {tc?.gold_stale && <StatusBadge value="Gold Reverification Required" definitions={DEMO_STATUSES} compact testId="demo-stale-gold-flag" />}
            </div>
            <h3 className="font-semibold font-display text-[var(--navy)]">{tc?.name || "Test"}</h3>
            <p className="text-sm text-muted-foreground mt-1">{tc?.municipality_name}</p>
            <div className="mt-3 bg-[var(--paper)] rounded-lg p-3"><span className="text-xs font-bold uppercase text-[var(--orange)]">Why this is a strong demo</span><p className="text-sm mt-1">{d.why_good}</p></div>
            <div className="text-xs text-muted-foreground mt-2">Approved by {d.approved_by}</div>
          </Link>
        ); })}
      </div>
      )}
    </div>
  );
}
