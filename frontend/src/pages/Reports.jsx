import { useEffect, useState } from "react";
import { api } from "../lib/api";
import { PageHeader, MethodologyDisclosure } from "../components/shared";
import { Button } from "../components/ui/button";
import { FileDown, FileText } from "lucide-react";
import { toast } from "sonner";
import { buildReportPayload } from "../lib/reportExports";
import { downloadCsv, tableRowsToCsv } from "../lib/tableData";
import { useConfig } from "../lib/hooks";
import { ImportCsvModal } from "../components/ImportCsvModal";

const EXPORT_REPORTS = [
  { key: "qa_summary", title: "Bassett QA Summary", desc: "Overall pass/fail, accuracy, and open findings." },
  { key: "release", title: "Release Readiness Data", desc: "Bassett evaluations, separate High and Critical severity findings, and regression snapshots across releases." },
  { key: "regression", title: "Regression Test Data", desc: "Historical regression runs and their included test results." },
  { key: "comparison", title: "Model Comparison Data", desc: "Complete Bassett vs. ChatGPT vs. Claude evaluations by test case." },
  { key: "critical", title: "High + Critical Findings Data", desc: "Separate High and Critical severity findings and their related QA records." },
  { key: "municipality", title: "Municipality Testing Data", desc: "Test coverage, results, and findings for each jurisdiction." },
];

export default function Reports() {
  const { data: config } = useConfig();
  const [importOpen, setImportOpen] = useState(false);
  const [versions, setVersions] = useState([]);
  const [version, setVersion] = useState("");
  const [scope, setScope] = useState("both");
  useEffect(() => {
    const request = api.get("/versions");
    if (!request?.then) return;
    request.then(({ data }) => {
      const rows = Array.isArray(data) ? data : data?.items || [];
      setVersions(rows);
      setVersion((current) => current || rows.find((item) => item.active)?.name || rows[0]?.name || "");
    }).catch(() => {});
  }, []);
  const exportData = async (kind) => {
    try {
      const needsRegressionRuns = ["release", "regression"].includes(kind);
      const needsTestRuns = kind === "comparison";
      const selected = kind === "release"
        ? `&version=${encodeURIComponent(version)}&scope=${encodeURIComponent(scope)}`
        : "";
      const { data } = await api.get(`/reports/data?kind=${encodeURIComponent(kind)}${selected}`);
      const payload = buildReportPayload({
        kind,
        stats: data.stats,
        releaseEvidence: data.release_evidence,
        minimumQualifyingTests: data.minimum_qualifying_tests,
        insufficientEvidence: data.insufficient_evidence,
        releaseReadiness: data.release_readiness,
        bassettOnlyEvaluations: data.bassett_only_evaluations,
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
        ["category", "Category"], ["criticality", "Severity"], ["status", "Workflow status"],
        ["bassett_result", "Bassett test result"], ["gold_stale", "Gold Reverification Required"],
        ["test_date", "Test Date"],
      ].map(([key, label]) => ({ key, label }));
      downloadCsv("zoneqa-testcases.csv", tableRowsToCsv(data.testcases, columns));
      toast.success("Model Comparison test cases exported (CSV)");
    } catch (error) {
      toast.error(error.response?.data?.detail || "Unable to export test cases. Please retry.");
    }
  };

  return (
    <div>
      <PageHeader title="Reports & Exports" subtitle="Generated from persisted QA records — never static.">
        <Button variant="outline" className="w-full sm:w-auto" onClick={() => setImportOpen(true)}><FileText size={15} className="mr-1" /> Import CSV</Button>
        <Button variant="outline" className="w-full sm:w-auto" onClick={exportCSV}><FileDown size={15} className="mr-1" /> Export CSV</Button>
      </PageHeader>
      <div className="flex flex-wrap items-end gap-3 mb-5">
        <label className="text-sm font-medium">Readiness version
          <select className="block mt-1 h-9 rounded-md border bg-background px-2" value={version} onChange={(event) => setVersion(event.target.value)}>
            {versions.map((item) => <option key={item.name} value={item.name}>{item.name}</option>)}
          </select>
        </label>
        <label className="text-sm font-medium">Readiness scope
          <select className="block mt-1 h-9 rounded-md border bg-background px-2" value={scope} onChange={(event) => setScope(event.target.value)}>
            <option value="both">Both populations</option>
            <option value="bassett">Bassett-only</option>
            <option value="comparison">Model Comparison</option>
          </select>
        </label>
      </div>
      {importOpen && <ImportCsvModal open={importOpen} onOpenChange={setImportOpen} />}

      <h2 className="mb-3 text-sm font-bold uppercase tracking-wide text-muted-foreground">Data exports</h2>
      <div className="grid md:grid-cols-2 lg:grid-cols-3 gap-4 mb-6">
        {EXPORT_REPORTS.map((report) => (
          <div key={report.key} className="bg-card border rounded-xl p-5 card-hover">
            <div className="flex items-center gap-2 mb-2"><div className="rounded-lg p-2 bg-[var(--navy)]/10"><FileDown size={18} className="text-[var(--navy)]" /></div><h3 className="font-semibold font-display text-[var(--navy)]">{report.title}</h3></div>
            <p className="text-sm text-muted-foreground mb-3">{report.desc}</p>
            <Button size="sm" variant="outline" onClick={() => exportData(report.key)} data-testid={`report-${report.key}`} aria-label={`Download ${report.title} as JSON`}>
              <FileDown size={14} className="mr-1" />
              <span data-testid={report.key === "qa_summary" ? "export-qa-data-json" : undefined}>Download JSON</span>
            </Button>
          </div>
        ))}
      </div>

       <MethodologyDisclosure title="How report data is calculated and scoped" testid="reports-methodology">
         <p>Exports are generated from the canonical persisted report population at the moment an export is requested.</p>
         <p>The selected export endpoint assembles the requested test cases, findings, evaluations, and related snapshots into one JSON or CSV payload using the authenticated user's current visibility scope.</p>
         <p>Retests, variants, missing values, and evidence relationships retain the same rules as the corresponding live report; missing values remain explicit rather than fabricated. Exported source values are not rounded by the card display.</p>
       </MethodologyDisclosure>
    </div>
  );
}
