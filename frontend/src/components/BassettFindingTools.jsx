import { useState } from "react";
import { Link } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { api, formatApiErrorDetail } from "../lib/api";
import { parseCsv } from "../lib/csv";
import { DRAFT_KEYS, deleteLocalDraft } from "../lib/localDrafts";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { Textarea } from "./ui/textarea";
import { Field, FormModal } from "./forms";
import { LocalDrafts } from "./LocalDrafts";
import { ConfirmActionDialog } from "./ConfirmActionDialog";
import { FileInput, FileOutput, Plus } from "lucide-react";
import { toast } from "sonner";

export const FINDING_CSV_COLUMNS = ["title", "description", "expected_behavior", "finding_type", "severity", "developer_status", "linked_test_run_ids"];
export function findingCsv(records) {
  const cell = (value) => {
    let text = Array.isArray(value) ? value.join(";") : String(value || "");
    if (/^[=+@\-\t\r]/.test(text)) text = `'${text}`;
    return `"${text.replace(/"/g, '""')}"`;
  };
  return [FINDING_CSV_COLUMNS.join(","), ...records.map((record) => FINDING_CSV_COLUMNS.map((key) => cell(record[key])).join(","))].join("\r\n");
}
const blank = () => ({ title: "", description: "", expected_behavior: "", finding_type: "Bassett error", severity: "Medium", developer_status: "Not Started", linked_test_run_ids: [] });
const errorText = (error) => formatApiErrorDetail(error?.response?.data?.detail) || "Unable to save finding. Your entries are preserved.";

export function BassettFindingTools({ records, config, canWrite, canManage, archived, onToggleArchive, onChanged }) {
  const [form, setForm] = useState(null);
  const [importRows, setImportRows] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const { data: runs = [] } = useQuery({ queryKey: ["bassett-runs-for-new-finding"], queryFn: async () => (await api.get("/bassett/issues")).data, enabled: Boolean(form) });
  const save = async () => {
    if (busy) return;
    setBusy(true); setError("");
    try {
      await api.post("/bassett/findings", form);
      try { deleteLocalDraft("finding"); } catch { /* Saved record is authoritative. */ }
      setForm(null); onChanged(); toast.success("Bassett finding created");
    } catch (e) { setError(errorText(e)); }
    finally { setBusy(false); }
  };
  const saveDraft = () => {
    try { localStorage.setItem(DRAFT_KEYS.finding, JSON.stringify(form)); toast.success("Finding draft saved on this browser"); }
    catch { setError("Draft could not be saved. Keep this form open and try again."); }
  };
  const exportRows = () => {
    const url = URL.createObjectURL(new Blob(["\uFEFF", findingCsv(records)], { type: "text/csv;charset=utf-8" }));
    const link = document.createElement("a"); link.href = url; link.download = archived ? "archived-bassett-findings.csv" : "bassett-findings.csv"; link.click(); URL.revokeObjectURL(url);
  };
  const loadCsv = async (event) => {
    setError(""); setImportRows([]);
    try {
      const file = event.target.files?.[0]; if (!file) return;
      const rows = parseCsv(await file.text());
      if (!rows.length || rows.some((row) => !row.title?.trim())) throw new Error("Each row must include a non-empty title column.");
      setImportRows(rows.map((row) => ({ ...blank(), ...Object.fromEntries(FINDING_CSV_COLUMNS.filter((key) => row[key]).map((key) => [key, row[key]])), linked_test_run_ids: (row.linked_test_run_ids || "").split(";").map((id) => id.trim()).filter(Boolean) })));
    } catch (e) { setError(e.message || "Unable to read CSV"); }
  };
  const importCsv = async () => {
    if (busy || !importRows?.length) return;
    setBusy(true); setError(""); let completed = 0;
    try {
      for (const row of importRows) { await api.post("/bassett/findings", row); completed += 1; }
      setImportRows(null); toast.success(`${completed} findings imported`);
    } catch (e) {
      setImportRows(importRows.slice(completed));
      setError(`${completed} saved. Only the remaining rows will be retried. ${errorText(e)}`);
    } finally { setBusy(false); onChanged(); }
  };
  return <>
    {canManage && <Button variant="outline" onClick={() => { setError(""); setImportRows([]); }}><FileInput size={15} /> Import CSV</Button>}
    <Button variant="outline" onClick={exportRows}><FileOutput size={15} /> Export CSV</Button>
    {canWrite && <LocalDrafts mode="finding" onRecover={(draft) => { setError(""); setForm({ ...blank(), ...draft }); }} />}
    <Button asChild variant="outline"><Link to="/bassett/issues">Bassett Test Runs</Link></Button>
    <Button variant="outline" aria-pressed={archived} onClick={onToggleArchive}>{archived ? "Active Findings" : "Archived Findings"}</Button>
    {canWrite && <Button className="bg-[var(--orange)] hover:bg-[var(--orange-600)]" onClick={() => { setError(""); setForm(blank()); }}><Plus size={15} /> New Bassett Finding</Button>}
    {form && <FormModal open title="New Bassett Finding" onOpenChange={(open) => !busy && !open && setForm(null)} onSubmit={save} submitDisabled={busy || !form.title.trim()} submitLabel={busy ? "Saving…" : "Create Finding"}>
      {error && <p role="alert" className="text-destructive">{error}</p>}
      <Field label="Finding title" required><Input value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} /></Field>
      <Field label="What went wrong?"><Textarea value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} /></Field>
      <Field label="Expected behavior"><Textarea value={form.expected_behavior} onChange={(e) => setForm({ ...form, expected_behavior: e.target.value })} /></Field>
      {[['finding_type', 'Finding Category', config?.finding_types || ['Bassett error']], ['severity', 'Severity', ['Very Low', 'Low', 'Medium', 'High', 'Critical']], ['developer_status', 'Workflow Status', config?.finding_statuses || ['Not Started', 'In Review', 'Engineering', 'Ready for Retesting', 'Closed / Resolved']]].map(([key, label, options]) => <Field key={key} label={label}><select aria-label={label} className="h-9 w-full rounded-md border px-3 bg-background" value={form[key]} onChange={(e) => setForm({ ...form, [key]: e.target.value })}>{[...new Set([form[key], ...options])].map((option) => <option key={option}>{option}</option>)}</select></Field>)}
      <details className="rounded-lg border p-3"><summary className="cursor-pointer">Linked Test Runs ({form.linked_test_run_ids.length})</summary><div className="mt-2 max-h-48 overflow-auto space-y-2">{runs.map((run) => <label key={run.id} className="flex gap-2"><input type="checkbox" checked={form.linked_test_run_ids.includes(run.id)} onChange={(e) => setForm({ ...form, linked_test_run_ids: e.target.checked ? [...form.linked_test_run_ids, run.id] : form.linked_test_run_ids.filter((id) => id !== run.id) })} />{run.test_id} · {run.title || run.question_asked || run.id}</label>)}</div></details>
      <Button type="button" variant="outline" disabled={busy} onClick={saveDraft}>Save Draft</Button>
    </FormModal>}
    {importRows !== null && <FormModal open title="Import Bassett Findings CSV" onOpenChange={(open) => !busy && !open && setImportRows(null)} onSubmit={importCsv} submitDisabled={busy || !importRows.length} submitLabel={busy ? "Importing…" : `Import ${importRows.length} findings`}>
      <p><strong>Required column:</strong> title</p><p className="text-sm">Optional columns: description, expected_behavior, finding_type, severity, developer_status, linked_test_run_ids (separate run IDs with semicolons). Each row creates a new finding; existing findings are not overwritten.</p>
      <Input aria-label="Choose findings CSV" type="file" accept=".csv" disabled={busy} onChange={loadCsv} />
      {error && <p role="alert" className="text-destructive">{error}</p>}
      <ul className="max-h-48 overflow-auto">{importRows.map((row, index) => <li key={index}>{index + 1}. {row.title}</li>)}</ul>
    </FormModal>}
  </>;
}

export function BassettFindingLifecycle({ finding, onChanged }) {
  const [action, setAction] = useState(null);
  const [title, setTitle] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const submit = async () => {
    if (busy) return;
    if (action === "delete" && title !== finding.title) { setError("Enter the exact finding title."); return; }
    setBusy(true);
    try { await api.post(`/bassett/findings/${finding.id}/lifecycle`, { action, confirmation_title: title }); setAction(null); onChanged(); toast.success(`Finding ${action === "delete" ? "deleted" : action === "archive" ? "archived" : "restored"}`); }
    catch (e) { setError(errorText(e)); }
    finally { setBusy(false); }
  };
  return <div className="flex flex-wrap gap-2">
    <Button variant="outline" size="sm" onClick={() => { setError(""); setAction(finding.archived ? "restore" : "archive"); }}>{finding.archived ? "Restore Finding" : "Archive Finding"}</Button>
    <Button variant="outline" size="sm" onClick={() => { setError(""); setTitle(""); setAction("delete"); }}>Delete Finding</Button>
    <ConfirmActionDialog open={Boolean(action)} onOpenChange={(open) => !busy && !open && setAction(null)} title={`${action === "delete" ? "Delete" : action === "archive" ? "Archive" : "Restore"} ${finding.title}?`} description={action === "delete" ? "Remove this finding from active and archived lists. Its stored history is retained for safety. Linked test runs and their uploads are not deleted. Enter the finding title to confirm." : "Linked test runs and history are preserved. Archived findings can be restored here."} confirmLabel={action === "delete" ? "Delete Finding" : action === "archive" ? "Archive Finding" : "Restore Finding"} onConfirm={submit} busy={busy} destructive={action === "delete"}>
      {action === "delete" && <Input aria-label="Confirm finding title" value={title} onChange={(e) => setTitle(e.target.value)} />}{error && <p role="alert">{error}</p>}
    </ConfirmActionDialog>
  </div>;
}

export function ArchivedRunDelete({ issue, onChanged }) {
  const [open, setOpen] = useState(false);
  const [confirmation, setConfirmation] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const title = issue.title || issue.question_asked || issue.id;
  const remove = async () => {
    if (busy) return;
    if (confirmation !== title) { setError("Enter the exact test run title."); return; }
    setBusy(true);
    try {
      await api.post(`/bassett/issues/${issue.id}/delete-archived`, { confirmation_title: confirmation });
      setOpen(false); onChanged(); toast.success("Archived test run deleted");
    } catch (e) { setError(errorText(e)); }
    finally { setBusy(false); }
  };
  return <><Button type="button" size="sm" variant="outline" onClick={() => { setOpen(true); setError(""); setConfirmation(""); }}>Delete Test Run</Button>
    <ConfirmActionDialog open={open} onOpenChange={(value) => !busy && setOpen(value)} title={`Delete ${title}?`} description="Remove this test run from the archive. Linked findings and uploaded files are preserved, and stored history is retained for safety. Enter the exact test run title to confirm." confirmLabel="Delete Test Run" destructive busy={busy} onConfirm={remove}>
      <Input aria-label="Confirm test run title" value={confirmation} onChange={(event) => setConfirmation(event.target.value)} />
      {error && <p role="alert">{error}</p>}
    </ConfirmActionDialog></>;
}
