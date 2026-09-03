import { useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "../lib/api";
import { PageHeader, StatCard, WrapTick, SrTable } from "../components/shared";
import { fmtPct, fmtPts, fmtScore, plural } from "../lib/format";
import { Button } from "../components/ui/button";
import { Target, Percent, Trophy, AlertTriangle, TrendingUp, FileDown, Loader2 } from "lucide-react";
import { LineChart, Line, BarChart, Bar, XAxis, YAxis, Tooltip, Legend, Cell, CartesianGrid } from "recharts";
import jsPDF from "jspdf";
import html2canvas from "html2canvas";
import { toast } from "sonner";
import { EVALUATION_SCORE_DOMAIN, EVALUATION_SCORE_TICKS, evaluationScoreOrNull, formatEvaluationScore } from "../lib/evaluationScale";
import { MODEL_COLORS } from "../lib/modelColors";
import { captureExecutiveChart, renderExecutivePdf } from "../lib/executivePdf";
import { QueryState } from "../components/PageState";
import { SafeResponsiveContainer } from "../components/SafeResponsiveContainer";

export default function Executive() {
  const query = useQuery({ queryKey: ["executive"], queryFn: async () => (await api.get("/analytics/executive")).data });
  const { data: d } = query;
  const trendChartRef = useRef(null);
  const failureModesChartRef = useRef(null);
  const categoriesChartRef = useRef(null);
  const [exportStatus, setExportStatus] = useState("idle");
  const [exportError, setExportError] = useState("");
  const exporting = exportStatus !== "idle";

  const downloadPdf = async () => {
    setExportError("");
    setExportStatus("generating");
    try {
      // Only chart SVGs are rasterized. Text, cards, section boundaries, tables,
      // headers, and footers are drawn by the deterministic A4 renderer.
      const [trend, failureModes, categories] = await Promise.all([
        captureExecutiveChart(trendChartRef.current, html2canvas),
        captureExecutiveChart(failureModesChartRef.current, html2canvas),
        captureExecutiveChart(categoriesChartRef.current, html2canvas),
      ]);
      const pdf = new jsPDF({ orientation: "portrait", unit: "mm", format: "a4", compress: true });
      renderExecutivePdf({
        doc: pdf,
        data: d,
        chartImages: { trend, failureModes, categories },
        generated: new Date().toLocaleDateString(),
      });
      const bytes = pdf.output("arraybuffer");
      if (!bytes || bytes.byteLength === 0) throw new Error("The generated PDF was empty.");
      setExportStatus("saving");
      await new Promise((resolve) => requestAnimationFrame(resolve));
      pdf.save(`Bassett-Executive-Summary-${new Date().toISOString().slice(0, 10)}.pdf`);
      toast.success("PDF downloaded — ready to share");
    } catch (e) {
      const message = e instanceof Error && e.message
        ? `PDF export failed: ${e.message}`
        : "PDF export failed. Please try again.";
      setExportError(message);
      toast.error(message);
    } finally { setExportStatus("idle"); }
  };

  if (query.isLoading || query.isError) return <div><PageHeader title="Executive Summary" subtitle="Shareable QA outcomes and trends." /><QueryState query={query} resource="executive summary" testId="executive-query" /></div>;
  const { kpis: k, trend, failure_modes, categories } = d;
  const chartCategories = categories.filter((category) => evaluationScoreOrNull(category.avg_score) !== null);

  const strongest = categories[0];
  const weakest = categories[categories.length - 1];
  const edge = Number.isFinite(Number(k.bassett_avg)) && Number.isFinite(Number(k.benchmark_avg))
    ? Math.round((k.bassett_avg - k.benchmark_avg) * 10) / 10
    : null;

  const takeaways = [
    edge === null
      ? "Competitive score comparison is unavailable until Bassett and benchmark scores are recorded for the same scope."
      : edge >= 0
      ? `Bassett outscores the benchmark models by ${fmtPts(edge)} on average (${fmtScore(k.bassett_avg)} vs ${fmtScore(k.benchmark_avg)} / 10).`
      : `Bassett trails the benchmark models by ${fmtPts(edge)} on average (${fmtScore(k.bassett_avg)} vs ${fmtScore(k.benchmark_avg)} / 10).`,
    k.pass_rate == null
      ? "Pass rate is unavailable because no evaluated tests are in scope."
      : `Pass rate stands at ${fmtPct(k.pass_rate)} across ${plural(k.total_evaluated, "evaluated test")}.`,
    `Head-to-head: Bassett won ${plural(k.wins, "test")} outright against ChatGPT & Claude and lost ${k.losses}.`,
    strongest && weakest && strongest !== weakest
      ? `Strongest category: ${strongest.category} (${fmtScore(strongest.avg_score)}/10). Weakest: ${weakest.category} (${fmtScore(weakest.avg_score)}/10).`
      : null,
    k.open_critical > 0
      ? `${plural(k.open_critical, "open critical finding")} require${k.open_critical === 1 ? "s" : ""} resolution before the next release.`
      : `No open critical findings — quality risk is currently low.`,
    (d.stale_gold_tests || []).length > 0
      ? `Reverification required: ${plural(d.stale_gold_tests.length, "evaluated test relies", "evaluated tests rely")} on a Gold Standard whose supporting evidence is stale (${d.stale_gold_tests.map((t) => t.name).slice(0, 3).join("; ")}).`
      : null,
  ].filter(Boolean);

  return (
    <div data-testid="exec-pdf-surface">
      <PageHeader title="Executive Summary" subtitle={`${d.scope || ""} · Generated ${new Date().toLocaleDateString()}.`}>
        <Button data-html2canvas-ignore="true" data-testid="download-pdf-btn" onClick={downloadPdf} disabled={exporting} className="bg-[var(--navy)] hover:bg-[#232f73]">
          {exporting ? <Loader2 size={15} className="mr-1 animate-spin" /> : <FileDown size={15} className="mr-1" />}
          {exportStatus === "generating" ? "Generating PDF…" : exportStatus === "saving" ? "Saving PDF…" : "Download PDF"}
        </Button>
      </PageHeader>
      {exportError && (
        <div role="alert" data-testid="pdf-export-error" className="mb-4 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800">
          {exportError}
        </div>
      )}

      <div className="grid grid-cols-2 md:grid-cols-5 gap-3 mb-6">
        <StatCard label="Bassett Overall Score" value={fmtScore(k.bassett_avg)} sub={`benchmarks avg ${fmtScore(k.benchmark_avg)}`} accent={MODEL_COLORS.Bassett} icon={Target} testid="exec-bassett-avg" />
        <StatCard label="Pass Rate" value={fmtPct(k.pass_rate)} sub={`${k.total_evaluated} evaluated`} accent={k.pass_rate != null && k.pass_rate >= 85 ? "#16a34a" : "#f59e0b"} icon={Percent} />
        <StatCard label="Bassett Wins" value={k.wins} sub={`${k.losses} losses`} accent="#16a34a" icon={Trophy} />
        <StatCard label="Open Critical" value={k.open_critical} sub="findings crit 4-5" accent={k.open_critical ? "#dc2626" : "#16a34a"} icon={AlertTriangle} />
        <StatCard label="Competitive Edge" value={edge === null ? "—" : edge >= 0 ? `+${edge}` : edge} sub="pts vs benchmarks" accent={edge === null ? "#64748b" : edge >= 0 ? "#16a34a" : "#dc2626"} icon={TrendingUp} />
      </div>

      <div className="bg-[var(--navy)] text-white rounded-xl p-5 mb-6" data-testid="exec-takeaways">
        <h3 className="font-semibold font-display mb-3 text-[var(--orange)]">Executive Takeaways</h3>
        <ul className="space-y-1.5">
          {takeaways.map((t, i) => (
            <li key={i} className="flex gap-2.5 text-sm text-white/90"><span className="text-[var(--orange)] font-bold shrink-0">›</span>{t}</li>
          ))}
        </ul>
      </div>

      <div className="grid lg:grid-cols-2 gap-4">
        <div className="bg-card border rounded-xl p-5" data-testid="exec-trend-chart">
          <h3 className="font-semibold font-display text-[var(--navy)] mb-3">Quarterly Accuracy Trend — Bassett vs Benchmarks</h3>
          <p className="text-xs text-muted-foreground mb-2">Scale: 0–10. Missing values appear as gaps.</p>
          <div ref={trendChartRef} data-testid="exec-trend-chart-render" className="min-w-0">
            <SafeResponsiveContainer height={280} testId="exec-trend-responsive-chart">
              <LineChart data={trend} margin={{ top: 8, right: 16 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="#e5e7eb" />
                <XAxis dataKey="quarter" tick={{ fontSize: 12 }} />
                <YAxis domain={EVALUATION_SCORE_DOMAIN} ticks={EVALUATION_SCORE_TICKS} tick={{ fontSize: 12 }} />
                <Tooltip formatter={(value) => [formatEvaluationScore(value), "Score (0–10)"]} />
                <Legend wrapperStyle={{ fontSize: 12 }} />
                {Object.entries(MODEL_COLORS).map(([m, c]) => (
                  <Line key={m} type="monotone" dataKey={m} stroke={c} strokeWidth={2.5} dot={{ r: 5, fill: c }} connectNulls={false} />
                ))}
              </LineChart>
            </SafeResponsiveContainer>
          </div>
        </div>

        <div className="bg-card border rounded-xl p-5">
          <h3 className="font-semibold font-display text-[var(--navy)] mb-3">Top Failure Modes (all findings)</h3>
          {failure_modes.length === 0 ? <p className="text-sm text-muted-foreground">No failure modes recorded yet.</p> : (
            <div ref={failureModesChartRef} data-testid="exec-failure-modes-chart-render" className="min-w-0">
              <SafeResponsiveContainer height={Math.max(280, failure_modes.length * 44)} testId="exec-failure-responsive-chart">
                <BarChart data={failure_modes} layout="vertical" margin={{ left: 20 }}>
                  <XAxis type="number" allowDecimals={false} tick={{ fontSize: 11 }} />
                  <YAxis type="category" dataKey="mode" width={170} tick={<WrapTick width={165} />} interval={0} />
                  <Tooltip />
                  <Bar dataKey="count" radius={[0, 6, 6, 0]} fill="#dc2626" />
                </BarChart>
              </SafeResponsiveContainer>
            </div>
          )}
          {failure_modes.length > 0 && <SrTable caption="Top failure modes across findings" columns={["Failure mode", "Count"]} rows={failure_modes.map((f) => [f.mode, f.count])} />}
        </div>
      </div>

      <div className="bg-card border rounded-xl p-5 mt-4">
        <h3 className="font-semibold font-display text-[var(--navy)] mb-3">Bassett Category Performance</h3>
        <p className="text-xs text-muted-foreground mb-2">Scale: 0–10.</p>
         <div ref={categoriesChartRef} data-testid="exec-categories-chart-render" className="min-w-0">
           <SafeResponsiveContainer height={Math.max(200, chartCategories.length * 44)} testId="exec-categories-responsive-chart">
             <BarChart data={chartCategories} layout="vertical" margin={{ left: 20 }}>
               <XAxis type="number" domain={EVALUATION_SCORE_DOMAIN} ticks={EVALUATION_SCORE_TICKS} tick={{ fontSize: 11 }} />
               <YAxis type="category" dataKey="category" width={200} tick={<WrapTick width={195} />} interval={0} />
               <Tooltip formatter={(v) => [formatEvaluationScore(v), "Avg score (0–10)"]} />
               <Bar dataKey="avg_score" radius={[0, 6, 6, 0]}>
                 {chartCategories.map((c, i) => <Cell key={i} fill={c.avg_score >= 7.5 ? "#16a34a" : c.avg_score >= 5 ? "#f59e0b" : "#dc2626"} />)}
               </Bar>
             </BarChart>
           </SafeResponsiveContainer>
         </div>
        <SrTable caption="Bassett category performance. Scale: 0 to 10." columns={["Category", "Average score out of 10"]} rows={categories.map((c) => [c.category, formatEvaluationScore(c.avg_score)])} />
      </div>
    </div>
  );
}
