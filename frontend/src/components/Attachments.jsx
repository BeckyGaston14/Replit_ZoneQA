import { useEffect, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api, formatApiErrorDetail } from "../lib/api";
import { Button } from "./ui/button";
import { Paperclip, FileText, Download, Trash2, Loader2, ArchiveRestore } from "lucide-react";
import { toast } from "sonner";
import { ConfirmActionDialog } from "./ConfirmActionDialog";

const fmtSize = (b) => (b > 1048576 ? `${(b / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(b / 1024))} KB`);
const isImage = (ct) => (ct || "").startsWith("image/");

function AttachmentImage({ file }) {
  const [imageUrl, setImageUrl] = useState(null);
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let objectUrl;
    let active = true;
    api.get(`/attachments/${file.id}/download`, { responseType: "blob" })
      .then(({ data }) => {
        objectUrl = URL.createObjectURL(data);
        if (active) setImageUrl(objectUrl);
      })
      .catch(() => { if (active) setFailed(true); });
    return () => {
      active = false;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [file.id, attempt]);

  if (!imageUrl && failed) return (
    <div className="h-9 w-9 rounded border bg-muted shrink-0 flex items-center justify-center">
      <button type="button" className="text-[9px] font-semibold text-[var(--navy)] underline" onClick={() => { setFailed(false); setAttempt((value) => value + 1); }} aria-label={`Retry preview for ${file.original_filename}`}>Retry</button>
    </div>
  );
  if (!imageUrl) return <div className="h-9 w-9 rounded border bg-muted shrink-0" role="status" aria-label="Loading attachment preview" />;
  return (
    <a href={imageUrl} target="_blank" rel="noreferrer" className="shrink-0">
      <img src={imageUrl} alt={file.original_filename} className="h-9 w-9 rounded object-cover border" />
    </a>
  );
}

export function Attachments({ entityType, entityId, canWrite, compact = false }) {
  const qc = useQueryClient();
  const fileRef = useRef(null);
  const [uploading, setUploading] = useState(false);
  const [removing, setRemoving] = useState(null);
  const [restoring, setRestoring] = useState(null);
  const [confirmingRemoval, setConfirmingRemoval] = useState(null);
  const { data: files = [], isLoading, isError, error, refetch } = useQuery({
    queryKey: ["attachments", entityType, entityId],
    queryFn: async () => (await api.get(`/attachments?entity_type=${entityType}&entity_id=${entityId}`)).data,
    enabled: !!entityId,
  });
  const activeFileCount = files.filter((file) => !file.deleted_at && file.status !== "deleted").length;

  const refresh = () => qc.invalidateQueries({ queryKey: ["attachments", entityType, entityId] });

  const upload = async (e) => {
    const list = Array.from(e.target.files || []);
    if (!list.length) return;
    setUploading(true);
    try {
      for (const f of list) {
        const fd = new FormData();
        fd.append("entity_type", entityType);
        fd.append("entity_id", entityId);
        fd.append("file", f);
        await api.post("/attachments/upload", fd, { headers: { "Content-Type": "multipart/form-data" }, timeout: 15000 });
      }
      toast.success(`${list.length} file${list.length > 1 ? "s" : ""} attached`);
      refresh();
    } catch (err) {
      toast.error(formatApiErrorDetail(err.response?.data?.detail) || "Upload failed or timed out. The record is still saved; check App Storage and retry.");
    } finally { setUploading(false); if (fileRef.current) fileRef.current.value = ""; }
  };

  const del = async (f) => {
    setRemoving(f.id);
    try { await api.delete(`/attachments/${f.id}`); toast.success("Attachment removed. Its restoration deadline is now shown in the attachment list."); refresh(); }
    catch (err) { toast.error(formatApiErrorDetail(err.response?.data?.detail) || "Unable to remove attachment"); }
    finally { setRemoving(null); }
  };
  const restore = async (f) => {
    setRestoring(f.id);
    try { await api.post(`/attachments/${f.id}/restore`); toast.success("Attachment restored"); refresh(); }
    catch (err) { toast.error(formatApiErrorDetail(err.response?.data?.detail) || "This attachment can no longer be restored."); }
    finally { setRestoring(null); }
  };
  const download = async (f) => {
    try {
      const { data } = await api.get(`/attachments/${f.id}/download`, { responseType: "blob" });
      const objectUrl = URL.createObjectURL(data);
      const link = document.createElement("a");
      link.href = objectUrl;
      link.download = f.original_filename || "attachment";
      document.body.appendChild(link);
      link.click();
      link.remove();
      window.setTimeout(() => URL.revokeObjectURL(objectUrl), 0);
    } catch (err) {
      toast.error(formatApiErrorDetail(err.response?.data?.detail) || "Download failed");
    }
  };

  return (
    <div data-testid={`attachments-${entityType}`}>
      <div className="flex items-center justify-between mb-2">
        <span className="text-xs font-semibold uppercase text-muted-foreground flex items-center gap-1.5">
          <Paperclip size={12} /> Attachments{activeFileCount > 0 && ` (${activeFileCount})`}
        </span>
        {canWrite && (
          <>
            <Button type="button" size="sm" variant="outline" className="h-7 text-xs" disabled={uploading}
              onClick={() => fileRef.current?.click()} data-testid="attach-file-btn">
              {uploading ? <Loader2 size={12} className="mr-1 animate-spin" /> : <Paperclip size={12} className="mr-1" />}
              {uploading ? "Uploading…" : "Attach files"}
            </Button>
            <input ref={fileRef} type="file" multiple className="hidden" data-testid="attach-file-input"
              accept=".pdf,.docx,.png,.jpg,.jpeg,.gif,.webp,.txt,.csv" onChange={upload} />
          </>
        )}
      </div>
      {isLoading && <p role="status" className="text-xs text-muted-foreground">Loading attachments…</p>}
      {isError && <p role="alert" className="text-xs text-red-700">Unable to load attachments: {formatApiErrorDetail(error?.response?.data?.detail)} <button type="button" className="font-semibold underline" onClick={() => refetch()}>Retry</button></p>}
      {!isLoading && !isError && files.length === 0 && <p className="text-xs text-muted-foreground">{canWrite ? "No files yet — attach ordinance PDFs or screenshots." : "No attachments."}</p>}
      <div className={compact ? "space-y-1.5" : "grid sm:grid-cols-2 gap-2"}>
        {files.map((f) => (
          <div key={f.id} className="flex items-start gap-2 bg-[var(--paper)] border rounded-lg px-2.5 py-2 min-w-0" data-testid="attachment-item">
            {isImage(f.content_type)
              ? <AttachmentImage file={f} />
              : <FileText size={18} className="text-[var(--navy)] shrink-0" />}
            <div className="flex-1 min-w-0">
              <div className="text-xs font-medium text-[var(--navy)] break-words" title={f.original_filename}>{f.original_filename}</div>
               <div className="text-[10px] text-muted-foreground">{f.deleted_at || f.status === "deleted" ? (f.restore_expires_at ? `Deleted — restore by ${new Date(f.restore_expires_at).toLocaleDateString()}` : "Deleted — retention expired") : `${fmtSize(f.size)} · ${f.uploaded_by}`}</div>
            </div>
             {!f.deleted_at && f.status !== "deleted" && <button type="button" onClick={() => download(f)} aria-label={`Download ${f.original_filename}`} title="Open / download" className="icon-action shrink-0 inline-flex items-center justify-center rounded text-muted-foreground hover:text-[var(--navy)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--orange)]" data-testid="attachment-download">
              <Download size={14} aria-hidden="true" />
             </button>}
              {canWrite && (f.deleted_at || f.status === "deleted") && f.restore_expires_at && <button type="button" disabled={restoring === f.id} title="Restore attachment" aria-label={`Restore ${f.original_filename}`} className="icon-action shrink-0 inline-flex items-center justify-center rounded text-muted-foreground hover:text-[var(--navy)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--orange)] disabled:opacity-50" onClick={() => restore(f)}>{restoring === f.id ? <Loader2 size={14} className="animate-spin" aria-hidden="true" /> : <ArchiveRestore size={14} aria-hidden="true" />}</button>}
             {canWrite && !f.deleted_at && f.status !== "deleted" && (
               removing === f.id ? <span className="text-[10px] text-muted-foreground">Removing…</span> : (
                  <button type="button" title="Remove" aria-label={`Remove ${f.original_filename}`} className="icon-action shrink-0 inline-flex items-center justify-center rounded text-muted-foreground hover:text-destructive focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--orange)]" onClick={() => {
                   setConfirmingRemoval(f);
                 }} data-testid="attachment-delete">
                    <Trash2 size={14} aria-hidden="true" />
                 </button>
               )
            )}
          </div>
        ))}
      </div>
      <ConfirmActionDialog
        open={!!confirmingRemoval}
        onOpenChange={(open) => !open && setConfirmingRemoval(null)}
        title={`Remove “${confirmingRemoval?.original_filename || "attachment"}”?`}
        description="This is a soft removal. The restoration deadline will be displayed after removal."
        confirmLabel="Remove attachment"
        destructive
        busy={removing === confirmingRemoval?.id}
        onConfirm={async () => {
          const file = confirmingRemoval;
          await del(file);
          setConfirmingRemoval(null);
        }}
      />
    </div>
  );
}

