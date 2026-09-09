import { useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "../lib/api";
import { PageHeader, StatCard, WrapTick, SrTable, SampleDataBanner, sampleScopeIncludesData, MethodologyDisclosure } from "../components/shared";
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
  const [reportScope, setReportScope] = useState("both");
  const query = useQuery({
    queryKey: ["executive", reportScope],
    queryFn: async () => (await api.get("/analytics/executive", { params: { report_scope: reportScope } })).data,
  });
  const { data: d } = query;
  const trendChartRef = useRef(null);
  const failureModesChartRef = useRef(null);
  const categoriesChartRef = useRef(null);
  const [exportStatus, setExportStatus] = useState("idle");
  const [exportError, setExportError] = useState("");
  const [exportSuccess, setExportSuccess] = useState("");
  const exporting = exportStatus !== "idle";

  const downloadPdf = async () => {
    setExportError("");
    setExportSuccess("");
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
      const header = bytes && bytes.byteLength >= 5
        ? String.fromCharCode(...new Uint8Array(bytes).slice(0, 5))
        : "";
      if (!bytes || bytes.byteLength === 0) throw new Error("The generated PDF was empty.");
      if (header !== "%PDF-") throw new Error("The generated file was not a valid PDF.");
      setExportStatus("saving");
      await new Promise((resolve) => requestAnimationFrame(resolve));
      const blob = new Blob([bytes], { type: "application/pdf" });
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = `Bassett-Executive-Summary-${reportScope}-${new Date().toISOString().slice(0, 10)}.pdf`;
      document.body.appendChild(link);
      link.click();
      window.setTimeout(() => {
        link.remove();
        URL.revokeObjectURL(url);
      }, 1000);
      setExportSuccess("PDF downloaded successfully and is ready to share.");
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
  const reportingGroups = d.reporting_groups || [];
  const sampleDataShown = sampleScopeIncludesData({ records: [d] });
  const hasEvaluatedData = d.has_evaluated_data ?? Number(k.total_evaluated || 0) > 0;
   const chartCategories = (reportingGroups.length ? reportingGroups : categories).filter((category) => evaluationScoreOrNull(category.score ?? category.avg_score) !== null);

   const strongest = chartCategories[0];
   const weakest = chartCategories[chartCategories.length - 1];
  const bassettAverage = evaluationScoreOrNull(k.bassett_avg);
  const benchmarkAverage = evaluationScoreOrNull(k.benchmark_avg);
  const includesComparison = d.report_scope !== "bassett";
  const edge = bassettAverage !== null && benchmarkAverage !== null
    ? Math.round((bassettAverage - benchmarkAverage) * 10) / 10
    : null;

  const takeaways = [
    !includesComparison ? null : edge === null
      ? "Competitive score comparison is unavailable until Bassett and benchmark scores are recorded for the same scope."
      : edge >= 0
      ? `Bassett outscores the benchmark models by ${fmtPts(edge)} on average (${fmtScore(k.bassett_avg)} vs ${fmtScore(k.benchmark_avg)} / 10).`
      : `Bassett trails the benchmark models by ${fmtPts(edge)} on average (${fmtScore(k.bassett_avg)} vs ${fmtScore(k.benchmark_avg)} / 10).`,
    k.pass_rate == null
      ? "Pass rate is unavailable because no evaluated tests are in scope."
      : `Pass rate stands at ${fmtPct(k.pass_rate)} across ${plural(k.total_evaluated, "evaluated test")}.`,
    !includesComparison ? null : (k.wins || k.losses)
      ? `Head-to-head: Bassett won ${plural(k.wins, "test")} outright against ChatGPT & Claude and lost ${k.losses}.`
      : k.total_evaluated > 0
        ? "No outright head-to-head wins or losses are recorded in the current evaluated scope."
        : "Head-to-head results are unavailable until comparable model evaluations are recorded.",
    strongest && weakest && strongest !== weakest
       ? `Strongest reporting group: ${strongest.label || strongest.category} (${fmtScore(strongest.score ?? strongest.avg_score)}/10). Weakest: ${weakest.label || weakest.category} (${fmtScore(weakest.score ?? weakest.avg_score)}/10).`
      : null,
    k.open_critical > 0
      ? `${plural(k.open_critical, "open critical finding")} require${k.open_critical === 1 ? "s" : ""} resolution before the next release.`
      : k.total_evaluated > 0
        ? "No open critical findings are recorded in the current evaluated scope."
        : "Quality risk cannot be assessed until evaluated tests and findings are recorded.",
    (d.stale_gold_tests || []).length > 0
      ? `Reverification required: ${plural(d.stale_gold_tests.length, "evaluated test relies", "evaluated tests rely")} on a Gold Standard whose supporting evidence is stale (${d.stale_gold_tests.map((t) => t.name).slice(0, 3).join("; ")}).`
      : null,
  ].filter(Boolean);

  return (
    <div data-testid="exec-pdf-surface">
       <PageHeader title="Executive Summary" subtitle={`${d.scope || ""} · Generated ${new Date().toLocaleDateString()}.`}>
        <label className="flex items-center gap-2 text-sm" data-html2canvas-ignore="true">
          <span className="font-medium text-[var(--navy)]">Report scope</span>
          <select aria-label="Executive summary scope" value={reportScope} onChange={(event) => setReportScope(event.target.value)} className="h-9 rounded-md border bg-background px-3 text-sm">
            <option value="bassett">Bassett Only</option>
            <option value="comparison">Model Comparison</option>
            <option value="both">Both</option>
          </select>
        </label>
        <Button data-html2canvas-ignore="true" data-testid="download-pdf-btn" onClick={downloadPdf} disabled={exporting} className="bg-[var(--navy)] hover:bg-[#232f73]">
          {exporting ? <Loader2 size={15} className="mr-1 animate-spin" /> : <FileDown size={15} className="mr-1" />}
          {exportStatus === "generating" ? "Generating PDF…" : exportStatus === "saving" ? "Saving PDF…" : "Download PDF"}
        </Button>
      </PageHeader>
      <SampleDataBanner show={sampleDataShown} />
      {exportError && (
        <div role="alert" data-testid="pdf-export-error" className="mb-4 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800">
          {exportError}
        </div>
      )}
      {exportSuccess && (
        <div role="status" data-testid="pdf-export-success" className="mb-4 rounded-lg border border-green-200 bg-green-50 px-4 py-3 text-sm text-green-800">
          {exportSuccess}
        </div>
      )}
      {!hasEvaluatedData && (
        <div role="status" data-testid="executive-empty-state" className="mb-4 rounded-lg border border-sky-200 bg-sky-50 px-4 py-3 text-sm text-sky-900">
          No {d.sample_data_included ? "" : "non-sample "}evaluations are available in this scope.
        </div>
      )}

      <div className={`grid grid-cols-2 ${includesComparison ? "md:grid-cols-5" : "md:grid-cols-3"} gap-3 mb-6`}>
        <StatCard label="Bassett Overall Score" value={fmtScore(k.bassett_avg)} sub={includesComparison ? `benchmarks avg ${fmtScore(k.benchmark_avg)}` : `${d.population_counts?.bassett_only || 0} Bassett-only results`} accent={MODEL_COLORS.Bassett} icon={Target} testid="exec-bassett-avg" />
        <StatCard label="Pass Rate" value={fmtPct(k.pass_rate)} sub={`${k.total_evaluated} evaluated`} accent={k.pass_rate != null && k.pass_rate >= 85 ? "#16a34a" : "#f59e0b"} icon={Percent} />
        {includesComparison && <StatCard label="Bassett Wins" value={k.wins} sub={`${k.losses} losses`} accent="#16a34a" icon={Trophy} />}
        <StatCard label="Open Critical" value={k.open_critical} sub="findings crit 4-5" accent={k.open_critical ? "#dc2626" : "#16a34a"} icon={AlertTriangle} />
        {includesComparison && <StatCard label="Competitive Edge" value={edge === null ? "—" : edge >= 0 ? `+${edge}` : edge} sub="pts vs benchmarks" accent={edge === null ? "#64748b" : edge >= 0 ? "#16a34a" : "#dc2626"} icon={TrendingUp} />}
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
          <h3 className="font-semibold font-display text-[var(--navy)] mb-3">{includesComparison ? "Quarterly Accuracy Trend — Bassett vs Benchmarks" : "Quarterly Bassett-Only Accuracy Trend"}</h3>
          <p className="text-xs text-muted-foreground mb-2">Scale: 0–10. Missing values appear as gaps.</p>
          <div ref={trendChartRef} data-testid="exec-trend-chart-render" className="min-w-0">
            <SafeResponsiveContainer height={280} testId="exec-trend-responsive-chart">
              <LineChart data={trend} margin={{ top: 8, right: 16 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="#e5e7eb" />
                <XAxis dataKey="quarter" tick={{ fontSize: 12 }} />
                <YAxis domain={EVALUATION_SCORE_DOMAIN} ticks={EVALUATION_SCORE_TICKS} tick={{ fontSize: 12 }} />
                <Tooltip formatter={(value) => [formatEvaluationScore(value), "Score (0–10)"]} />
                <Legend wrapperStyle={{ fontSize: 12 }} />
                {Object.entries(MODEL_COLORS).filter(([model]) => includesComparison || model === "Bassett").map(([m, c]) => (
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
         <h3 className="font-semibold font-display text-[var(--navy)] mb-3">Bassett Reporting Group Performance</h3>
         <p className="text-xs text-muted-foreground mb-2">Scale: 0–10. Configured-weight averages of applicable underlying dimensions; missing and N/A values are excluded.</p>
         {chartCategories.length === 0 ? <div role="status" className="rounded-lg border border-dashed p-6 text-sm text-muted-foreground">No scored evaluation dimensions are available for this report scope. Complete the evaluation category scores—not only the overall result—to populate this chart.</div> : <div ref={categoriesChartRef} data-testid="exec-categories-chart-render" className="min-w-0">
           <SafeResponsiveContainer height={Math.max(200, chartCategories.length * 44)} testId="exec-categories-responsive-chart">
              <BarChart data={chartCategories.map((item) => ({ ...item, category: item.label || item.category, avg_score: item.score ?? item.avg_score }))} layout="vertical" margin={{ left: 20 }}>
               <XAxis type="number" domain={EVALUATION_SCORE_DOMAIN} ticks={EVALUATION_SCORE_TICKS} tick={{ fontSize: 11 }} />
               <YAxis type="category" dataKey="category" width={200} tick={<WrapTick width={195} />} interval={0} />
               <Tooltip formatter={(v) => [formatEvaluationScore(v), "Avg score (0–10)"]} />
                <Bar dataKey="avg_score" radius={[0, 6, 6, 0]}>
                  {chartCategories.map((c, i) => { const score = c.score ?? c.avg_score; return <Cell key={i} fill={score >= 7.5 ? "#16a34a" : score >= 5 ? "#f59e0b" : "#dc2626"} />; })}
               </Bar>
             </BarChart>
           </SafeResponsiveContainer>
         </div>}
         <SrTable caption="Bassett reporting-group performance. Scale: 0 to 10." columns={["Reporting group", "Average score out of 10", "Underlying dimensions"]} rows={chartCategories.map((c) => [(c.label || c.category), formatEvaluationScore(c.score ?? c.avg_score), (c.dimensions || c.underlyingDimensions || []).map((item) => item.label || item.key || item).join(", ")])} />
      </div>
       <MethodologyDisclosure title="How executive metrics are calculated" testid="executive-methodology">
         <p>Executive KPIs and charts summarize persisted QA evaluations, findings, and model comparisons for the displayed scope: {d.scope || "current reporting scope"}.</p>
         <p>Pass rate is passing evaluated tests divided by evaluated tests; scores are arithmetic means of available 0–10 scores; competitive edge is Bassett average minus benchmark average.</p>
         <p>Sample data follows the authenticated user's Show sample records preference. Missing scores are unavailable, not zero; stale Gold Standards are surfaced for reverification.</p>
       </MethodologyDisclosure>
    </div>
  );
}

