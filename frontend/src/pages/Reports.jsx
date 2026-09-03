import { api } from "../lib/api";
import { PageHeader } from "../components/shared";
import { Button } from "../components/ui/button";
import { FileDown, FileText } from "lucide-react";
import { Link } from "react-router-dom";
import { toast } from "sonner";
import { buildReportPayload } from "../lib/reportExports";
import { downloadCsv, tableRowsToCsv } from "../lib/tableData";
import { ROUTES } from "../lib/routePaths";
import { useConfig } from "../lib/hooks";

const EXPORT_REPORTS = [
  { key: "qa_summary", title: "Bassett QA Summary", desc: "Overall pass/fail, accuracy, and open findings." },
  { key: "release", title: "Release Readiness Data", desc: "Bassett evaluations, critical findings, and regression snapshots across releases." },
  { key: "regression", title: "Regression Test Data", desc: "Historical regression runs and their included test results." },
  { key: "comparison", title: "Model Comparison Data", desc: "Complete Bassett vs. ChatGPT vs. Claude evaluations by test case." },
  { key: "critical", title: "Critical Findings Data", desc: "All criticality 4–5 findings and their related QA records." },
  { key: "municipality", title: "Municipality Testing Data", desc: "Test coverage, results, and findings for each jurisdiction." },
];

const LIVE_REPORTS = [
  { to: ROUTES.release, title: "Release Readiness", desc: "Current release blockers, regression results, and recommendation." },
  { to: ROUTES.regression, title: "Regression", desc: "Versioned regression suites and immutable run history." },
  { to: ROUTES.comparison, title: "Model Comparison", desc: "Bassett, ChatGPT, and Claude results for complete comparisons." },
  { to: ROUTES.findings, title: "Model Comparison Findings", desc: "Filter findings from Bassett vs. benchmark-model comparisons by status and criticality." },
  { to: ROUTES.performance, title: "Performance", desc: "Filter scores and coverage by version, project, municipality, and category." },
  { to: ROUTES.executive, title: "Executive Summary", desc: "Shareable QA narrative, trends, and key takeaways." },
];

export default function Reports() {
  const { data: config } = useConfig();
  const exportData = async (kind) => {
    try {
      const needsRegressionRuns = ["release", "regression"].includes(kind);
      const needsTestRuns = kind === "comparison";
      const { data } = await api.get(`/reports/data?kind=${encodeURIComponent(kind)}`);
      const payload = buildReportPayload({
        kind,
        stats: data.stats,
        testcases: data.testcases,
        findings: data.findings,
        evaluations: data.evaluations,
        evaluationDimensions: config?.eval_dimensions,
        regressionRuns: needsRegressionRuns ? data.regression_runs : undefined,
        testRuns: needsTestRuns ? data.test_runs : undefined,
      });
      const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a"); a.href = url; a.download = `zoneqa-${kind}.json`; a.click();
      URL.revokeObjectURL(url);
      toast.success("Report data exported (JSON)");
    } catch (error) {
      toast.error(error.response?.data?.detail || "Unable to export report data. Please retry.");
    }
  };

  const exportCSV = async () => {
    try {
      const { data } = await api.get("/reports/data?kind=qa_summary");
      const columns = [
        ["name", "Test Name"], ["project_name", "Project"], ["municipality_name", "Municipality"],
        ["category", "Category"], ["criticality", "Criticality"], ["status", "Status"],
        ["bassett_result", "Bassett Result"], ["gold_stale", "Gold Reverification Required"],
        ["test_date", "Test Date"],
      ].map(([key, label]) => ({ key, label }));
      downloadCsv("zoneqa-testcases.csv", tableRowsToCsv(data.testcases, columns));
      toast.success("Test cases exported (CSV)");
    } catch (error) {
      toast.error(error.response?.data?.detail || "Unable to export test cases. Please retry.");
    }
  };

  return (
    <div>
      <PageHeader title="Reports & Exports" subtitle="Generated from persisted QA records — never static.">
        <Button variant="outline" className="w-full sm:w-auto" onClick={exportCSV}><FileDown size={15} className="mr-1" /> Export Test Cases CSV</Button>
      </PageHeader>

      <h2 className="mb-3 text-sm font-bold uppercase tracking-wide text-muted-foreground">Data exports</h2>
      <div className="grid md:grid-cols-2 lg:grid-cols-3 gap-4 mb-6">
        {EXPORT_REPORTS.map((report) => (
          <div key={report.key} className="bg-card border rounded-xl p-5 card-hover">
            <div className="flex items-center gap-2 mb-2"><div className="rounded-lg p-2 bg-[var(--navy)]/10"><FileDown size={18} className="text-[var(--navy)]" /></div><h3 className="font-semibold font-display text-[var(--navy)]">{report.title}</h3></div>
            <p className="text-sm text-muted-foreground mb-3">{report.desc}</p>
            <Button size="sm" variant="outline" onClick={() => exportData(report.key)} data-testid={`report-${report.key}`}>
              <FileDown size={14} className="mr-1" />
              {report.key === "qa_summary" ? <span data-testid="export-qa-data-json">Export JSON</span> : "Export JSON"}
            </Button>
          </div>
        ))}
      </div>

      <h2 className="mb-3 text-sm font-bold uppercase tracking-wide text-muted-foreground">Live reports</h2>
      <div className="grid md:grid-cols-2 lg:grid-cols-3 gap-4">
        {LIVE_REPORTS.map((report) => (
          <div key={report.to} className="bg-card border rounded-xl p-5 card-hover">
            <div className="flex items-center gap-2 mb-2"><div className="rounded-lg p-2 bg-[var(--navy)]/10"><FileText size={18} className="text-[var(--navy)]" /></div><h3 className="font-semibold font-display text-[var(--navy)]">{report.title}</h3></div>
            <p className="text-sm text-muted-foreground mb-3">{report.desc}</p>
            <Button size="sm" variant="outline" asChild><Link to={report.to}>Open report</Link></Button>
          </div>
        ))}
      </div>
    </div>
  );
}
