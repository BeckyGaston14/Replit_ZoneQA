import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { api } from "../lib/api";
import { useAuth } from "../lib/auth";
import { PageHeader, StatCard, StatusBadge } from "../components/shared";
import { INTEGRITY_CHECK_STATUSES, INTEGRITY_SEVERITIES } from "../lib/statusMaps";
import { Button } from "../components/ui/button";
import { AlertDialog, AlertDialogContent, AlertDialogHeader, AlertDialogTitle, AlertDialogDescription, AlertDialogFooter, AlertDialogCancel, AlertDialogAction } from "../components/ui/alert-dialog";
import { ShieldCheck, ShieldAlert, AlertTriangle, Info, Wrench, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { SortableTableHeader } from "../components/SortableTableHeader";
import { TableSortControls } from "../components/TableSortControls";
import { nextSort, sortTableRows, usePersistentTableSort } from "../lib/tableSorting";
import { TABLE_CLASS, TABLE_FRAME_CLASS, TABLE_HEAD_CLASS } from "../lib/tableStyles";

const INTEGRITY_COLUMNS = [
  { key: "severity", label: "Severity", type: "severity" },
  { key: "entity_type", label: "Entity", type: "text" },
  { key: "name", label: "Record", type: "natural" },
  { key: "problem", label: "Problem", type: "text" },
  { key: "repair", label: "Recommended Repair", type: "text" },
];

function RepairDialog({ issue, onClose, onDone }) {
  const ra = issue.repair_action;
  const [ack, setAck] = useState(false);
  const [busy, setBusy] = useState(false);

  const run = async () => {
    setBusy(true);
    try {
      const { data } = await api.post("/admin/integrity/repair", { key: ra.key, entity_id: issue.entity_id, params: ra.params || {}, record_name: issue.name });
      toast.success(`Repaired: ${data.detail}`);
      onDone();
      onClose();
    } catch (e) {
      toast.error(e.response?.data?.detail || "Repair failed");
    } finally { setBusy(false); }
  };

  return (
    <AlertDialog open onOpenChange={(o) => !o && onClose()}>
      <AlertDialogContent data-testid="repair-dialog">
        <AlertDialogHeader>
          <AlertDialogTitle className="font-display text-[var(--navy)] flex items-center gap-2"><Wrench size={17} className="text-[var(--orange)]" /> {ra.label}</AlertDialogTitle>
          <AlertDialogDescription asChild>
            <div className="space-y-3 text-sm text-left">
              <div className="bg-[var(--paper)] rounded-lg p-3 space-y-1">
                <div><span className="text-[10px] font-bold uppercase text-muted-foreground">Record</span><div className="font-semibold text-[var(--navy)]">{issue.name}</div></div>
                <div><span className="text-[10px] font-bold uppercase text-muted-foreground">Problem</span><div>{issue.problem}</div></div>
              </div>
              <div className={`rounded-lg p-3 border ${ra.destructive ? "bg-red-50 border-red-300" : "bg-sky-50 border-sky-200"}`}>
                <span className={`text-[10px] font-bold uppercase ${ra.destructive ? "text-red-700" : "text-sky-700"}`}>What this repair will do</span>
                <div className="mt-0.5" data-testid="repair-effect">{ra.effect}</div>
              </div>
              {ra.destructive && (
                <label className="flex items-start gap-2 text-xs cursor-pointer text-red-800" data-testid="repair-destructive-ack">
                  <input type="checkbox" checked={ack} onChange={(e) => setAck(e.target.checked)} className="mt-0.5" />
                  I understand this permanently modifies or deletes QA data and cannot be undone.
                </label>
              )}
            </div>
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel data-testid="repair-cancel">Cancel</AlertDialogCancel>
          <AlertDialogAction disabled={busy || (ra.destructive && !ack)} onClick={(e) => { e.preventDefault(); run(); }} data-testid="repair-confirm"
            className={ra.destructive ? "bg-red-600 hover:bg-red-700" : "bg-[var(--navy)] hover:bg-[#232f73]"}>
            {busy ? <Loader2 size={14} className="mr-1 animate-spin" /> : null} Apply Repair
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

export default function DataIntegrity() {
  const { user } = useAuth();
  const qc = useQueryClient();
  const [repairing, setRepairing] = useState(null);
  const defaultSort = { key: "severity", direction: "asc" };
  const [sort, setSort] = usePersistentTableSort("data-integrity", INTEGRITY_COLUMNS, defaultSort);
  const allowed = user && ["admin", "qa_manager"].includes(user.role);
  const { data: d, error, isLoading, isError, refetch } = useQuery({
    queryKey: ["integrity"],
    queryFn: async () => (await api.get("/admin/integrity")).data,
    enabled: allowed,
  });

  if (!allowed) return <div className="bg-card border rounded-xl p-8 text-center text-muted-foreground" data-testid="integrity-forbidden">Data Integrity is restricted to Administrators and QA Managers.</div>;

  return (
    <div>
      <PageHeader title="Data Integrity" subtitle="Automated validation of relational consistency, historical snapshots and metric reconciliation. Safe issues offer a one-click repair with guided confirmation — substantive QA judgments always stay manual." />
      {isLoading && <div className="text-muted-foreground" role="status">Running integrity validation…</div>}
      {isError && <div className="rounded-xl border border-red-200 bg-red-50 p-4 text-sm text-red-800" role="alert">Failed to run integrity checks: {error?.response?.data?.detail || "Request failed."} <Button size="sm" variant="outline" className="ml-2" onClick={() => refetch()}>Retry</Button></div>}
      {d && (
        <>
      <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-4 gap-3 mb-6">
        <StatCard label="High Severity" value={d.counts.high} accent="#dc2626" icon={ShieldAlert} testid="integrity-high" />
        <StatCard label="Medium Severity" value={d.counts.medium} accent="#f59e0b" icon={AlertTriangle} testid="integrity-medium" />
        <StatCard label="Low / Informational" value={d.counts.low} accent="#0ea5e9" icon={Info} testid="integrity-low" />
        <StatCard label="Checks Status" value={<StatusBadge value={d.issues.length === 0 ? "clean" : "attention"} definitions={INTEGRITY_CHECK_STATUSES} />} sub={d.issues.length === 0 ? "No inconsistencies detected" : `${d.issues.length} issue${d.issues.length === 1 ? "" : "s"} require review`} icon={ShieldCheck} />
      </div>

      {d.issues.length === 0 ? (
               <div className="bg-card border rounded-xl p-8 text-center font-semibold" data-testid="integrity-clean"><StatusBadge value="clean" definitions={INTEGRITY_CHECK_STATUSES} /><p className="mt-2 text-[var(--navy)]">All integrity checks passed — no inconsistencies detected.</p></div>
      ) : (
        <><TableSortControls columns={INTEGRITY_COLUMNS} sort={sort} setSort={setSort} defaultSort={defaultSort} className="mb-3" />
         <div className={TABLE_FRAME_CLASS} data-testid="integrity-table-scroll">
           <table className={TABLE_CLASS}>
            <thead className={TABLE_HEAD_CLASS}><tr>
              {INTEGRITY_COLUMNS.map((column) => <SortableTableHeader key={column.key} column={column} sort={sort} onSort={(key) => setSort((current) => nextSort(current, key))} />)}<th><span className="sr-only">Actions</span></th>
            </tr></thead>
            <tbody>
              {sortTableRows(d.issues, INTEGRITY_COLUMNS, sort, ["entity_type", "name"]).map((i, idx) => (
                <tr key={idx} className="border-t align-top" data-testid="integrity-issue-row">
                   <td className="px-4 py-3"><StatusBadge value={i.severity} definitions={INTEGRITY_SEVERITIES} compact /></td>
                  <td className="px-4 py-3 text-xs text-muted-foreground capitalize">{i.entity_type}<div className="text-[10px] font-mono opacity-60">{String(i.entity_id).slice(0, 8)}</div></td>
                  <td className="px-4 py-3 font-semibold text-[var(--navy)]">
                    {i.link ? <Link to={i.link} className="hover:underline">{i.name}</Link> : i.name}
                  </td>
                  <td className="px-4 py-3">{i.problem}</td>
                  <td className="px-4 py-3 text-xs text-muted-foreground">{i.repair}</td>
                  <td className="px-4 py-3 text-right">
                    {i.repair_action ? (
                      <Button size="sm" variant="outline" className="border-[var(--orange)]/50 text-[var(--orange)] hover:bg-orange-50" onClick={() => setRepairing(i)} data-testid="repair-btn">
                        <Wrench size={13} className="mr-1" /> Repair
                      </Button>
                    ) : (
                      <span className="text-[10px] text-muted-foreground uppercase font-semibold" title="This issue requires human judgment and cannot be auto-repaired" data-testid="manual-only-tag">Manual review</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div></>
      )}
      <p className="text-xs text-muted-foreground mt-3">Last checked: {new Date(d.checked_at).toLocaleString()}</p>

      {repairing && <RepairDialog issue={repairing} onClose={() => setRepairing(null)} onDone={() => qc.invalidateQueries({ queryKey: ["integrity"] })} />}
        </>
      )}
    </div>
  );
}
