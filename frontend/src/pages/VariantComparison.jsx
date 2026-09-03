import { useParams, useNavigate, Link } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { api } from "../lib/api";
import { PageHeader, CritBadge, ResultBadge, ScorePill } from "../components/shared";
import { ArrowLeft, GitBranch, Trophy, TrendingDown } from "lucide-react";

export default function VariantComparison() {
  const { id } = useParams();
  const nav = useNavigate();
  const { data: d, isLoading } = useQuery({
    queryKey: ["variant-comparison", id],
    queryFn: async () => (await api.get(`/testcases/${id}/variant-comparison`)).data,
  });

  if (isLoading || !d) return <div className="text-muted-foreground">Loading variant family…</div>;
  const { items, best_id, worst_id, root_id } = d;

  return (
    <div>
      <button onClick={() => nav(`/testcases/${id}`)} className="flex items-center gap-1 text-sm text-muted-foreground hover:text-[var(--navy)] mb-3"><ArrowLeft size={15} /> Back to test case</button>
      <PageHeader title="Variant Comparison" subtitle="The same scenario, different phrasings — side by side to reveal which wording trips Bassett up." />

      {items.length < 2 && (
        <div className="bg-card border rounded-xl p-8 text-center text-sm text-muted-foreground">
          No variants yet — use <b>Clone Variant</b> on the test case to probe this scenario from a new angle.
        </div>
      )}

      {best_id && (
        <div className="flex gap-3 mb-4 flex-wrap text-sm" data-testid="variant-verdict">
          <span className="flex items-center gap-1.5 bg-green-50 border border-green-200 text-green-800 rounded-full px-3 py-1 font-semibold">
            <Trophy size={14} /> Best phrasing: {items.find((i) => i.testcase.id === best_id)?.testcase.name}
          </span>
          <span className="flex items-center gap-1.5 bg-red-50 border border-red-200 text-red-800 rounded-full px-3 py-1 font-semibold">
            <TrendingDown size={14} /> Trips Bassett: {items.find((i) => i.testcase.id === worst_id)?.testcase.name}
          </span>
        </div>
      )}

      <div className="grid gap-4" style={{ gridTemplateColumns: `repeat(${Math.min(items.length, 3)}, minmax(0, 1fr))` }}>
        {items.map((it) => {
          const t = it.testcase;
          const isRoot = t.id === root_id;
          const ring = t.id === best_id ? "ring-2 ring-green-500" : t.id === worst_id ? "ring-2 ring-red-500" : "";
          return (
            <div key={t.id} className={`bg-card border rounded-xl overflow-hidden flex flex-col ${ring}`} data-testid="variant-col">
              <div className={`px-4 py-2.5 flex items-center justify-between ${isRoot ? "bg-[var(--navy)]" : "bg-indigo-500"} text-white`}>
                <span className="text-[10px] font-bold uppercase tracking-wide flex items-center gap-1.5">
                  <GitBranch size={12} /> {isRoot ? "Original" : "Variant"}
                </span>
                {it.evaluation && <ScorePill score={it.evaluation.overall_score} />}
              </div>
              <div className="p-4 space-y-3 flex-1">
                <div>
                  <Link to={`/testcases/${t.id}`} className="font-semibold text-[var(--navy)] hover:underline text-sm">{t.name}</Link>
                  <div className="flex items-center gap-2 mt-1"><CritBadge value={t.criticality} /><span className="text-[11px] text-muted-foreground">{t.status}</span></div>
                </div>
                <div>
                  <div className="text-[10px] font-bold uppercase text-muted-foreground mb-1">Phrasing</div>
                  {(t.prompts || []).map((p) => (
                    <div key={p.turn} className="text-sm bg-[var(--paper)] border rounded-lg p-2 mb-1.5">
                      {(t.prompts || []).length > 1 && <span className="text-[10px] font-bold text-[var(--orange)] mr-1">T{p.turn}</span>}
                      {p.text}
                    </div>
                  ))}
                </div>
                <div>
                  <div className="text-[10px] font-bold uppercase text-muted-foreground mb-1">Bassett Result</div>
                  {it.evaluation
                    ? <div className="flex items-center gap-2"><ResultBadge value={it.evaluation.final_result} />{it.evaluation.notes && <span className="text-xs text-muted-foreground truncate" title={it.evaluation.notes}>{it.evaluation.notes}</span>}</div>
                    : <span className="text-xs text-muted-foreground">Not evaluated yet</span>}
                </div>
                <div>
                  <div className="text-[10px] font-bold uppercase text-muted-foreground mb-1">Bassett Response</div>
                  {it.responses.length === 0 && <span className="text-xs text-muted-foreground">No response captured</span>}
                  {it.responses.map((r, i) => (
                    <p key={i} className="text-xs prose-response line-clamp-6 mb-1">{r.response}</p>
                  ))}
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
