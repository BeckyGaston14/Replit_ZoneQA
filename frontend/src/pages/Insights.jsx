import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { api } from "../lib/api";
import { PageHeader, StatCard, CritBadge, WrapTick, SrTable } from "../components/shared";
import { Swords, TrendingDown, Trophy, Gauge } from "lucide-react";
import { BarChart, Bar, XAxis, YAxis, Tooltip, Legend } from "recharts";
import { EVALUATION_SCORE_DOMAIN, EVALUATION_SCORE_TICKS, evaluationScoreOrNull, formatEvaluationScore } from "../lib/evaluationScale";
import { MODEL_COLORS } from "../lib/modelColors";
import { QueryState } from "../components/PageState";
import { SafeResponsiveContainer } from "../components/SafeResponsiveContainer";

const DIM_LABELS = { accuracy: "Accuracy", current_code: "Current Code", interpretation: "Interpretation", calculation: "Calculation", context: "Context", missing_info: "Missing Info", followup: "Follow-Up", citation_accuracy: "Citation", source_quality: "Source Quality", guidance: "Guidance", completeness: "Completeness", usefulness: "Usefulness" };

function BattleCard({ e, type }) {
  return (
    <div className={`bg-card border rounded-xl p-4 ${type === "loss" ? "border-l-4 border-l-red-500" : "border-l-4 border-l-green-500"}`} data-testid={type === "loss" ? "insight-loss-card" : "insight-win-card"}>
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div className="min-w-0">
          <div className="flex items-center gap-2"><CritBadge value={e.criticality} />
            <Link to={`/testcases/${e.testcase_id}`} className="font-semibold text-[var(--navy)] hover:underline truncate">{e.name}</Link>
          </div>
          <div className="text-xs text-muted-foreground mt-0.5">{e.category}</div>
        </div>
        <div className="flex items-center gap-2 text-sm shrink-0">
          <span className="font-bold" style={{ color: MODEL_COLORS.Bassett }}>Bassett {e.bassett_score}</span>
          <span className="text-muted-foreground text-xs">vs</span>
          <span className="font-bold" style={{ color: MODEL_COLORS[e.benchmark_model] }}>{e.benchmark_model} {e.benchmark_score}</span>
          <span className={`text-xs font-bold rounded-full px-2 py-0.5 ${type === "loss" ? "bg-red-100 text-red-700" : "bg-green-100 text-green-700"}`}>
            {type === "loss" ? `−${e.delta}` : `+${Math.abs(e.delta)}`}
          </span>
        </div>
      </div>
      <div className="mt-2 grid md:grid-cols-2 gap-2 text-xs">
        <div className="bg-[var(--paper)] rounded-lg p-2">
          <span className="font-bold" style={{ color: MODEL_COLORS.Bassett }}>Bassett:</span> {e.bassett_notes || e.bassett_result || "—"}
        </div>
        <div className="bg-[var(--paper)] rounded-lg p-2">
          <span className="font-bold" style={{ color: MODEL_COLORS[e.benchmark_model] }}>{e.benchmark_model}:</span> {e.benchmark_notes || "—"}
        </div>
      </div>
      {type === "loss" && e.dimension_gaps?.length > 0 && (
        <div className="mt-2 flex gap-1.5 flex-wrap">
          <span className="text-[10px] font-bold uppercase text-muted-foreground mt-0.5">Biggest gaps:</span>
          {e.dimension_gaps.filter((g) => g.gap > 0).map((g) => (
            <span key={g.dim} className="text-[11px] bg-red-50 border border-red-200 text-red-700 rounded-full px-2 py-0.5">
              {DIM_LABELS[g.dim] || g.dim} −{g.gap}
            </span>
          ))}
        </div>
      )}
      {e.reasons?.length > 0 && (
        <div className="mt-2 space-y-1">
          {e.reasons.map((r) => (
            <Link key={r.id} to={`/findings?id=${r.id}`} className="block text-xs text-[var(--navy)] hover:underline">↳ Finding: {r.title} <span className="text-muted-foreground">({r.type})</span></Link>
          ))}
        </div>
      )}
    </div>
  );
}

export default function Insights() {
  const query = useQuery({ queryKey: ["competitive"], queryFn: async () => (await api.get("/analytics/competitive")).data });
  const { data: d } = query;
  if (query.isLoading || query.isError) return <div><PageHeader title="Competitive Insights" subtitle="Exactly where benchmark models beat Bassett — and why." /><QueryState query={query} resource="competitive insights" testId="insights-query" /></div>;
  const { records, losses, wins, dimension_comparison, summary } = d;
  const dimensionRows = dimension_comparison.map((x) => ({
    dim: DIM_LABELS[x.dim] || x.dim,
    Bassett: evaluationScoreOrNull(x.bassett),
    Benchmarks: evaluationScoreOrNull(x.benchmark),
  }));
  const dimData = dimensionRows.filter((row) => row.Bassett !== null || row.Benchmarks !== null);
  const weakest = [...dimension_comparison].sort((a, b) => a.gap - b.gap).filter((x) => x.gap < 0).slice(0, 3);
  const comparisonCount = Object.values(records || {}).reduce((total, record) => total + (record?.wins || 0) + (record?.losses || 0) + (record?.ties || 0), 0);

  return (
    <div>
      <PageHeader title="Competitive Insights" subtitle="Exactly where ChatGPT or Claude beat Bassett — and why." />
      {comparisonCount === 0 && (
        <div className="mb-6 rounded-xl border border-blue-200 bg-blue-50 p-4 text-sm text-blue-900" role="status">
          No comparable Bassett and benchmark evaluations are in scope yet. Competitive wins, losses, and dimension gaps will appear after the same test cases have evaluated scores for Bassett and at least one benchmark model.
        </div>
      )}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-6">
        <StatCard label="Benchmark Losses" value={summary.losses} sub={`worst gap −${summary.worst_gap}`} accent="#dc2626" icon={TrendingDown} testid="insights-losses" />
        <StatCard label="Bassett Wins" value={summary.wins} sub="beat best benchmark" accent="#16a34a" icon={Trophy} />
        <StatCard label="vs ChatGPT" value={`${records.ChatGPT.wins}-${records.ChatGPT.losses}-${records.ChatGPT.ties}`} sub="W-L-T head-to-head" accent={MODEL_COLORS.ChatGPT} icon={Swords} />
        <StatCard label="vs Claude" value={`${records.Claude.wins}-${records.Claude.losses}-${records.Claude.ties}`} sub="W-L-T head-to-head" accent={MODEL_COLORS.Claude} icon={Swords} />
      </div>

      {weakest.length > 0 && (
        <div className="bg-red-50 border border-red-200 rounded-xl p-4 mb-6 text-sm text-red-800" data-testid="insights-weakness-banner">
          <b>Where benchmarks lead:</b> {weakest.map((w) => `${DIM_LABELS[w.dim] || w.dim} (−${Math.abs(w.gap)})`).join(" · ")}
        </div>
      )}

      <div className="grid lg:grid-cols-2 gap-4 mb-6">
        <div className="space-y-3">
          <h3 className="font-semibold font-display text-[var(--navy)] flex items-center gap-2"><TrendingDown size={16} className="text-red-600" /> Tests where a benchmark beat Bassett ({losses.length})</h3>
          {losses.length === 0 && <p className="text-sm text-muted-foreground bg-card border rounded-xl p-4">{comparisonCount === 0 ? "No head-to-head results are available yet." : "No benchmark losses — Bassett leads or ties on every compared test."}</p>}
          {losses.map((e) => <BattleCard key={e.testcase_id} e={e} type="loss" />)}
          <h3 className="font-semibold font-display text-[var(--navy)] flex items-center gap-2 pt-2"><Trophy size={16} className="text-green-600" /> Tests where Bassett beat both benchmarks ({wins.length})</h3>
          {wins.map((e) => <BattleCard key={e.testcase_id} e={e} type="win" />)}
        </div>

        <div className="bg-card border rounded-xl p-5 h-fit" data-testid="insights-dim-chart">
          <h3 className="font-semibold font-display text-[var(--navy)] mb-3 flex items-center gap-2"><Gauge size={16} /> Dimension Averages — Bassett vs Benchmarks</h3>
          <p className="text-xs text-muted-foreground mb-2">Scale: 0–10. Missing values are unavailable and are not plotted as zero.</p>
          <SafeResponsiveContainer height={Math.max(300, dimData.length * 40)} testId="insights-dimension-chart">
            <BarChart data={dimData} layout="vertical" margin={{ left: 10 }}>
              <XAxis type="number" domain={EVALUATION_SCORE_DOMAIN} ticks={EVALUATION_SCORE_TICKS} tick={{ fontSize: 11 }} />
              <YAxis type="category" dataKey="dim" width={140} tick={<WrapTick width={135} />} interval={0} />
              <Tooltip formatter={(value, name) => [formatEvaluationScore(value), `${name} score (0–10)`]} />
              <Legend wrapperStyle={{ fontSize: 12 }} />
              <Bar dataKey="Bassett" fill={MODEL_COLORS.Bassett} radius={[0, 4, 4, 0]} barSize={10} />
              <Bar dataKey="Benchmarks" fill="#2f3f96" radius={[0, 4, 4, 0]} barSize={10} />
            </BarChart>
          </SafeResponsiveContainer>
          <SrTable caption="Dimension averages — Bassett vs benchmarks. Scale: 0 to 10. Missing values are unavailable." columns={["Dimension", "Bassett score out of 10", "Benchmark score out of 10"]} rows={dimensionRows.map((x) => [x.dim, formatEvaluationScore(x.Bassett), formatEvaluationScore(x.Benchmarks)])} />
        </div>
      </div>
    </div>
  );
}

