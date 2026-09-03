import { useState, useRef } from "react";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogFooter } from "./ui/dialog";
import { Button } from "./ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "./ui/select";
import { useCollection } from "../lib/hooks";
import { api } from "../lib/api";
import { useQueryClient } from "@tanstack/react-query";
import { Upload, FileSpreadsheet, CheckCircle2, AlertTriangle } from "lucide-react";
import { toast } from "sonner";
import { SortableTableHeader } from "./SortableTableHeader";
import { TableSortControls } from "./TableSortControls";
import { nextSort, sortTableRows } from "../lib/tableSorting";

const TARGETS = [
  ["", "— skip —"], ["name", "Test Name"], ["municipality", "Municipality"], ["state", "State"],
  ["category", "Category"], ["subcategory", "Subcategory"], ["test_type", "Test Type"],
  ["criticality", "Criticality (1-5)"], ["difficulty", "Difficulty (1-5)"], ["scenario", "Scenario"],
  ["purpose", "Purpose"], ["prompt", "Prompt"], ["expected_behavior", "Expected Behavior"], ["status", "Status"],
];

const SYNONYMS = {
  name: ["name", "testname", "test", "title", "testcase", "testcasename"],
  municipality: ["municipality", "city", "town", "jurisdiction", "muni"],
  state: ["state", "province"],
  category: ["category", "cat"],
  subcategory: ["subcategory", "subcat"],
  test_type: ["testtype", "type"],
  criticality: ["criticality", "severity", "priority", "crit"],
  difficulty: ["difficulty", "complexity"],
  scenario: ["scenario", "description", "context"],
  purpose: ["purpose", "objective", "goal", "expectedbehaviorsummary"],
  prompt: ["prompt", "question", "query", "input"],
  expected_behavior: ["expectedbehavior", "expected", "expectedresult", "expectedanswer"],
  status: ["status", "state2"],
};

// Small CSV parser with quoted-field support
function parseCSV(text) {
  const rows = [];
  let row = [], field = "", inQ = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQ) {
      if (c === '"') { if (text[i + 1] === '"') { field += '"'; i++; } else inQ = false; }
      else field += c;
    } else if (c === '"') inQ = true;
    else if (c === ",") { row.push(field); field = ""; }
    else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(field); field = "";
      if (row.some((f) => f.trim() !== "")) rows.push(row);
      row = [];
    } else field += c;
  }
  if (field !== "" || row.length) { row.push(field); if (row.some((f) => f.trim() !== "")) rows.push(row); }
  return rows;
}

function guessTarget(header) {
  const h = header.toLowerCase().replace(/[^a-z]/g, "");
  for (const [target, syns] of Object.entries(SYNONYMS)) if (syns.includes(h)) return target;
  return "";
}

export function ImportCsvModal({ open, onOpenChange }) {
  const qc = useQueryClient();
  const fileRef = useRef(null);
  const { data: projects = [] } = useCollection("projects");
  const [step, setStep] = useState(1); // 1=upload, 2=map, 3=result
  const [headers, setHeaders] = useState([]);
  const [rows, setRows] = useState([]);
  const [mapping, setMapping] = useState({});
  const [previewSort, setPreviewSort] = useState({ key: "name", direction: "asc" });
  const [projectId, setProjectId] = useState("");
  const [result, setResult] = useState(null);
  const [busy, setBusy] = useState(false);

  const reset = () => { setStep(1); setHeaders([]); setRows([]); setMapping({}); setResult(null); setBusy(false); };

  const onFile = (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      const parsed = parseCSV(String(reader.result));
      if (parsed.length < 2) { toast.error("CSV needs a header row and at least one data row"); return; }
      const hdrs = parsed[0].map((h) => h.trim());
      setHeaders(hdrs);
      setRows(parsed.slice(1));
      const m = {};
      hdrs.forEach((h, i) => { m[i] = guessTarget(h); });
      setMapping(m);
      setStep(2);
    };
    reader.readAsText(file);
  };

  const mappedRows = () => rows.map((r) => {
    const obj = {};
    headers.forEach((_, i) => { const t = mapping[i]; if (t) obj[t] = (r[i] || "").trim(); });
    return obj;
  });

  const doImport = async () => {
    if (!Object.values(mapping).includes("name")) return toast.error("Map at least one column to Test Name");
    setBusy(true);
    try {
      const { data } = await api.post("/import/testcases", { rows: mappedRows(), project_id: projectId || null });
      setResult(data);
      setStep(3);
      qc.invalidateQueries();
    } catch (e) {
      toast.error(e.response?.data?.detail || "Import failed");
    } finally { setBusy(false); }
  };

  const preview = mappedRows().slice(0, 4);
  const previewCols = TARGETS.filter(([k]) => k && Object.values(mapping).includes(k)).map(([k, l]) => [k, l]);
  const previewSortColumns = previewCols.map(([key, label]) => ({
    key, label, type: ["criticality", "difficulty"].includes(key) ? "number" : "natural",
  }));
  const effectivePreviewSort = previewSortColumns.some((column) => column.key === previewSort.key)
    ? previewSort
    : { key: previewSortColumns[0]?.key, direction: "asc" };

  return (
    <Dialog open={open} onOpenChange={(v) => { onOpenChange(v); if (!v) reset(); }}>
      <DialogContent className="max-w-3xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="font-display text-[var(--navy)] flex items-center gap-2"><FileSpreadsheet size={18} /> Bulk Import Test Cases (CSV)</DialogTitle>
          <DialogDescription>Choose a CSV file, map its columns, review the preview, and import the accepted test cases.</DialogDescription>
        </DialogHeader>

        {step === 1 && (
          <div className="py-6">
            <button type="button" className="w-full border-2 border-dashed rounded-xl p-10 text-center cursor-pointer hover:border-[var(--orange)] transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--orange)]" onClick={() => fileRef.current?.click()} data-testid="csv-dropzone" aria-label="Choose a CSV file">
              <Upload size={32} className="mx-auto text-muted-foreground mb-3" />
              <p className="font-semibold text-[var(--navy)]">Click to choose a CSV file</p>
              <p className="text-xs text-muted-foreground mt-1">First row must be column headers. Existing QA spreadsheets are auto-mapped — duplicates (same name + municipality) are skipped.</p>
            </button>
            <input ref={fileRef} type="file" accept=".csv,text/csv" className="hidden" aria-label="CSV file" onChange={onFile} data-testid="csv-file-input" />
          </div>
        )}

        {step === 2 && (
          <div className="space-y-4">
            <div className="text-sm text-muted-foreground">{rows.length} data rows detected. Map your CSV columns to test case fields:</div>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
              {headers.map((h, i) => (
                <div key={i} className="flex items-center gap-2 bg-[var(--paper)] rounded-lg px-3 py-2">
                  <span className="text-xs font-semibold text-[var(--navy)] flex-1 truncate" title={h}>{h}</span>
                  <span className="text-muted-foreground text-xs">→</span>
                    <Select value={mapping[i] || ""} onValueChange={(v) => setMapping({ ...mapping, [i]: v === "__skip" ? "" : v })}>
                     <SelectTrigger aria-label={`Map CSV column ${h}`} className="h-8 w-44 max-w-full text-xs" data-testid={`map-col-${i}`}><SelectValue placeholder="— skip —" /></SelectTrigger>
                    <SelectContent>{TARGETS.map(([k, l]) => <SelectItem key={k || "__skip"} value={k || "__skip"}>{l}</SelectItem>)}</SelectContent>
                  </Select>
                </div>
              ))}
            </div>
            <div className="flex items-center gap-3">
              <span className="text-xs font-semibold text-muted-foreground">ASSIGN TO PROJECT</span>
              <Select value={projectId} onValueChange={setProjectId}>
                 <SelectTrigger aria-label="Assign imported test cases to project" className="h-8 w-64 max-w-full text-xs" data-testid="import-project-select"><SelectValue placeholder="No project (optional)" /></SelectTrigger>
                <SelectContent>{projects.map((p) => <SelectItem key={p.id} value={p.id}>{p.name}</SelectItem>)}</SelectContent>
              </Select>
            </div>
            {previewCols.length > 0 && (
              <div>
                <TableSortControls columns={previewSortColumns} sort={effectivePreviewSort} setSort={setPreviewSort} defaultSort={{ key: previewSortColumns[0].key, direction: "asc" }} className="mb-2" />
               <div className="border rounded-lg overflow-x-auto" role="region" aria-label="CSV import preview table" tabIndex="0">
                <table className="w-full text-xs">
                  <thead className="bg-[var(--paper)]"><tr>{previewSortColumns.map((column) => <SortableTableHeader key={column.key} column={column} sort={effectivePreviewSort} onSort={(key) => setPreviewSort((current) => nextSort(current, key))} />)}</tr></thead>
                  <tbody>{sortTableRows(preview, previewSortColumns, effectivePreviewSort).map((r, i) => <tr key={i} className="border-t">{previewCols.map(([k]) => <td key={k} className="px-2 py-1.5 max-w-[180px] truncate">{r[k] || "—"}</td>)}</tr>)}</tbody>
                </table>
              </div>
              </div>
            )}
          </div>
        )}

        {step === 3 && result && (
          <div className="py-4 space-y-4" data-testid="import-result">
            <div className="flex items-center gap-3 bg-green-50 border border-green-200 rounded-xl p-4">
              <CheckCircle2 size={28} className="text-green-600" />
              <div>
                <div className="font-bold text-green-800">{result.created} test case{result.created === 1 ? "" : "s"} imported</div>
                <div className="text-xs text-green-700">{result.skipped.length} skipped · {result.total} total rows</div>
              </div>
            </div>
            {result.skipped.length > 0 && (
              <div className="border border-amber-200 bg-amber-50 rounded-xl p-4">
                <div className="flex items-center gap-2 font-semibold text-amber-800 text-sm mb-2"><AlertTriangle size={15} /> Skipped rows</div>
                <div className="space-y-1 max-h-40 overflow-y-auto">
                  {result.skipped.map((s, i) => <div key={i} className="text-xs text-amber-800">Row {s.row}: <b>{s.name || "(no name)"}</b> — {s.reason}</div>)}
                </div>
              </div>
            )}
          </div>
        )}

        <DialogFooter>
          {step === 2 && <Button variant="ghost" onClick={reset}>Back</Button>}
          {step === 2 && <Button disabled={busy} onClick={doImport} className="bg-[var(--orange)] hover:bg-[var(--orange-600)]" data-testid="import-submit-btn">{busy ? "Importing…" : `Import ${rows.length} rows`}</Button>}
          {step === 3 && <Button onClick={() => { onOpenChange(false); reset(); }} className="bg-[var(--navy)]" data-testid="import-done-btn">Done</Button>}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
