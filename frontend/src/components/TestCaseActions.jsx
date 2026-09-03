import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { MoreHorizontal, Archive, ArchiveRestore, Pencil, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { api, formatApiErrorDetail } from "../lib/api";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { Textarea } from "./ui/textarea";
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel,
  DropdownMenuSeparator, DropdownMenuTrigger,
} from "./ui/dropdown-menu";
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from "./ui/dialog";
import { ConfirmActionDialog } from "./ConfirmActionDialog";

export function TestCaseActions({ testcase, user, onDeleted, onEdit, compact = false }) {
  const qc = useQueryClient();
  const [confirming, setConfirming] = useState(null);
  const [preflight, setPreflight] = useState(null);
  const [loadingPreflight, setLoadingPreflight] = useState(false);
  const [confirmationId, setConfirmationId] = useState("");
  const [confirmationTitle, setConfirmationTitle] = useState("");
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const canManage = ["admin", "qa_manager"].includes(user?.role);
  const isAdmin = user?.role === "admin";

  const refreshAll = () => qc.invalidateQueries();
  const lifecycle = async () => {
    setBusy(true);
    try {
      await api.post(`/testcases/${testcase.id}/${confirming}`);
      toast.success(confirming === "archive" ? "Test case archived" : "Test case restored");
      setConfirming(null);
      refreshAll();
    } catch (error) {
      toast.error(formatApiErrorDetail(error?.response?.data?.detail) || "Lifecycle action failed");
    } finally { setBusy(false); }
  };
  const loadPreflight = async () => {
    setLoadingPreflight(true);
    setPreflight({ loading: true });
    try {
      const { data } = await api.get(`/testcases/${testcase.id}/deletion-preflight`);
      setPreflight(data);
    } catch (error) {
      toast.error(formatApiErrorDetail(error?.response?.data?.detail) || "Unable to run deletion preflight");
      setPreflight(null);
    } finally { setLoadingPreflight(false); }
  };
  const permanentlyDelete = async () => {
    setBusy(true);
    try {
      await api.delete(`/testcases/${testcase.id}/permanent`, { data: {
        confirmation_id: confirmationId, confirmation_title: confirmationTitle,
        reason, preflight_token: preflight.preflight_token,
      } });
      toast.success("Unused test case permanently deleted");
      setPreflight(null);
      refreshAll();
      onDeleted?.();
    } catch (error) {
      toast.error(formatApiErrorDetail(error?.response?.data?.detail) || "Permanent deletion failed");
    } finally { setBusy(false); }
  };
  const allowed = preflight?.policy?.allowed;
  const exactConfirmation = confirmationId === testcase.id && confirmationTitle === testcase.name && reason.trim().length >= 3;

  return <>
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size={compact ? "icon" : "sm"} aria-label={`Actions for ${testcase.name}`} onClick={(event) => event.stopPropagation()}>
          <MoreHorizontal size={17} />{!compact && <span className="ml-1">Actions</span>}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" onClick={(event) => event.stopPropagation()}>
        <DropdownMenuLabel>Test case lifecycle</DropdownMenuLabel>
        <DropdownMenuSeparator />
        {onEdit && !testcase.archived && <DropdownMenuItem onSelect={() => onEdit(testcase)}>
          <Pencil size={15} className="mr-2" /> Edit test case
        </DropdownMenuItem>}
        {canManage ? <DropdownMenuItem onSelect={() => setConfirming(testcase.archived ? "restore" : "archive")}>
          {testcase.archived ? <ArchiveRestore size={15} className="mr-2" /> : <Archive size={15} className="mr-2" />}
          {testcase.archived ? "Restore" : "Archive"}
        </DropdownMenuItem> : <DropdownMenuItem disabled>No lifecycle actions available</DropdownMenuItem>}
        {isAdmin && testcase.archived && <>
          <DropdownMenuSeparator />
          <DropdownMenuItem className="text-red-700 focus:text-red-700" onSelect={loadPreflight}>
            <Trash2 size={15} className="mr-2" /> Review permanent deletion
          </DropdownMenuItem>
        </>}
      </DropdownMenuContent>
    </DropdownMenu>

    <ConfirmActionDialog
      open={!!confirming}
      onOpenChange={(open) => !open && setConfirming(null)}
      title={`${confirming === "archive" ? "Archive" : "Restore"} “${testcase.name}”?`}
      description={confirming === "archive"
        ? "The test case will leave active lists and metrics. Its findings, runs, evidence, attachments, comments, and complete history stay intact."
        : "The test case will return to active lists and calculations with its prior status and history."}
      confirmLabel={confirming === "archive" ? "Archive test case" : "Restore test case"}
      busy={busy}
      onConfirm={lifecycle}
    />

    <Dialog open={!!preflight} onOpenChange={(open) => !open && setPreflight(null)}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>Permanent deletion preflight</DialogTitle>
          <DialogDescription>Permanent deletion is administrator-only and is allowed only for an archived, completely unused test case.</DialogDescription>
        </DialogHeader>
        {loadingPreflight || preflight?.loading ? <p className="text-sm text-muted-foreground">Checking every known dependency…</p> : <>
          <div className={`rounded-lg border p-3 text-sm ${allowed ? "bg-green-50 border-green-200" : "bg-amber-50 border-amber-200"}`}>
            {allowed ? "Policy allows deletion: no dependencies were found." : "Policy blocks deletion. Keep this test case archived so linked history remains intact."}
          </div>
          <div className="max-h-44 overflow-auto grid grid-cols-2 gap-x-5 gap-y-1 text-xs border rounded-lg p-3" aria-label="Exact dependency counts">
            {Object.entries(preflight?.dependencies || {}).map(([key, count]) => <div key={key} className="flex justify-between gap-3"><span>{key.replaceAll("_", " ")}</span><b>{count}</b></div>)}
          </div>
          {allowed && <div className="space-y-3">
            <p className="text-xs text-red-700">This removes only the unused Test Case definition. Shared object bytes are never deleted automatically.</p>
            <Input aria-label="Exact test case ID" placeholder={`Type ID: ${testcase.id}`} value={confirmationId} onChange={(e) => setConfirmationId(e.target.value)} />
            <Input aria-label="Exact test case title" placeholder={`Type title: ${testcase.name}`} value={confirmationTitle} onChange={(e) => setConfirmationTitle(e.target.value)} />
            <Textarea aria-label="Deletion reason" placeholder="Required deletion reason" value={reason} onChange={(e) => setReason(e.target.value)} />
          </div>}
        </>}
        <DialogFooter>
          <Button variant="outline" onClick={() => setPreflight(null)}>Close</Button>
          {allowed && <Button variant="destructive" disabled={busy || !exactConfirmation} onClick={permanentlyDelete}>{busy ? "Deleting…" : "Permanently delete"}</Button>}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  </>;
}