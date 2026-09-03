import { useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useCollection, useSave, useDelete, useConfig, useSavedView } from "../lib/hooks";
import { useAuth } from "../lib/auth";
import { PageHeader } from "./shared";
import { FormModal, Field, SelectOrAdd, ListSelect, DimSelect } from "./forms";
import { Attachments } from "./Attachments";
import { Button } from "./ui/button";
import { SortableTableHeader } from "./SortableTableHeader";
import { TableSortControls } from "./TableSortControls";
import { nextSort, sortTableRows, usePersistentTableSort } from "../lib/tableSorting";
import { Input } from "./ui/input";
import { Textarea } from "./ui/textarea";
import { Plus, Pencil, Trash2, MoreHorizontal, Archive, ArchiveRestore } from "lucide-react";
import { toast } from "sonner";
import { Download } from "lucide-react";
import { downloadCsv, tableRowsToCsv, withinDateRange } from "../lib/tableData";
import { api, formatApiErrorDetail } from "../lib/api";
import {
  TABLE_ACTION_CELL_CLASS, TABLE_CELL_CLASS, TABLE_CLASS, TABLE_EMPTY_CELL_CLASS,
  TABLE_FRAME_CLASS, TABLE_HEAD_CLASS,
} from "../lib/tableStyles";
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel,
  DropdownMenuSeparator, DropdownMenuTrigger,
} from "./ui/dropdown-menu";
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from "./ui/dialog";
import { ConfirmActionDialog } from "./ConfirmActionDialog";
import { focusFormError, validateFormFields } from "../lib/formValidation";
import { QueryState } from "./PageState";

// schema field: {key,label,type,options,collection,labelFn,addFields,render,col}
export default function ResourceList({ title, subtitle, collection, columns, fields, initial = {}, rowLink, attachable, singular, dataEndpoint, dateFilterColumn, exportFilename, parentLifecycle = false, dateRanges = [] }) {
  const lifecycleEndpoint = `/resources/${collection}`;
  const listEndpoint = dataEndpoint || `/${collection}`;
  const defaultView = {
    filters: {
      archived: parentLifecycle ? "active" : "all",
      date_from: "",
      date_to: "",
    },
  };
  const savedView = useSavedView(
    collection,
    defaultView,
    (saved = {}) => ({
      filters: {
        ...defaultView.filters,
        ...(saved.filters || {}),
        archived: parentLifecycle && !["active", "archived", "all"].includes(saved.filters?.archived)
          ? "active"
          : (saved.filters?.archived || defaultView.filters.archived),
      },
    }),
  );
  const { state: view, updateState: updateView, error: viewError, retry: retryView } = savedView;
  const collectionQuery = useCollection(collection, parentLifecycle ? {
    queryKey: [`${collection}-including-archived`],
    queryFn: async () => (await api.get(`${listEndpoint}${listEndpoint.includes("?") ? "&" : "?"}include_archived=true`)).data,
  } : dataEndpoint ? {
    queryKey: [`${collection}-enriched`],
    queryFn: async () => (await api.get(dataEndpoint)).data,
  } : {});
  const { data = [], isLoading, isError, error, refetch } = collectionQuery;
  const { data: config } = useConfig();
  const { user } = useAuth();
  const queryClient = useQueryClient();
  const save = useSave(collection);
  const del = useDelete(collection);
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState(initial);
  const [confirmingLifecycle, setConfirmingLifecycle] = useState(null);
  const [preflight, setPreflight] = useState(null);
  const [loadingPreflight, setLoadingPreflight] = useState(false);
  const [confirmationId, setConfirmationId] = useState("");
  const [confirmationTitle, setConfirmationTitle] = useState("");
  const [deletionReason, setDeletionReason] = useState("");
  const [lifecycleBusy, setLifecycleBusy] = useState(false);
  const [formErrors, setFormErrors] = useState({});
  const [serverError, setServerError] = useState("");
  const [dateFilterError, setDateFilterError] = useState("");
  const [baseRecord, setBaseRecord] = useState(null);
  const [conflictRecord, setConflictRecord] = useState(null);
  const submitInFlight = useRef(false);
  const [confirmingDelete, setConfirmingDelete] = useState(null);
  const sortColumns = columns.map((column) => ({ type: "text", ...column }));
  const defaultSort = { key: sortColumns[0].key, direction: "asc" };
  const [sort, setSort] = usePersistentTableSort(collection, sortColumns, defaultSort);
  const isArchived = (row) => Boolean(row.archived || row.archived_at || row.status === "Archived");
  const showArchived = parentLifecycle && view.filters.archived === "archived";
  const lifecycleData = parentLifecycle
    ? data.filter((row) => view.filters.archived === "all" || (showArchived ? isArchived(row) : !isArchived(row)))
    : data;
  const filteredData = dateFilterColumn
    ? lifecycleData.filter((row) => withinDateRange(row[dateFilterColumn], view.filters.date_from, view.filters.date_to))
    : lifecycleData;
  const sortedData = sortTableRows(filteredData, sortColumns, sort, columns.slice(0, 2).map((column) => column.key));
  const hasFilters = view.filters.date_from || view.filters.date_to
    || (parentLifecycle && view.filters.archived !== defaultView.filters.archived);
  const clearFilters = () => updateView({ ...view, filters: defaultView.filters });

  const resetFormState = () => { setFormErrors({}); setServerError(""); setConflictRecord(null); };
  const openNew = () => { setForm({ ...initial }); setBaseRecord(null); resetFormState(); setOpen(true); };
  const openEdit = (row) => { setForm({ ...row }); setBaseRecord(row); resetFormState(); setOpen(true); };
  const validate = () => {
    const errors = validateFormFields(fields, form, { dateRanges });
    setFormErrors(errors);
    setServerError("");
    const firstError = Object.keys(errors)[0];
    if (firstError) setTimeout(() => focusFormError(firstError), 0);
    return Object.keys(errors).length === 0;
  };
  const submit = () => {
    if (submitInFlight.current || save.isPending) return false;
    if (!validate()) return;
    submitInFlight.current = true;
    const versionedForm = { ...form };
    if (form.expected_updated_at) versionedForm.expected_updated_at = form.expected_updated_at;
    else if (form.updated_at) versionedForm.expected_updated_at = form.updated_at;
    else if (form.revision != null) versionedForm.expected_revision = form.revision;
    save.mutate(versionedForm, {
       onSuccess: () => { submitInFlight.current = false; setOpen(false); resetFormState(); toast.success("Saved"); },
      onError: (error) => {
         submitInFlight.current = false;
        if (error?.response?.status === 409) {
          toast.error("This record changed elsewhere. Reload it and review your entries before reapplying them.");
          Promise.resolve(api.get(listEndpoint)).then(({ data: latest } = {}) => {
            setConflictRecord((latest || []).find((item) => item.id === form.id) || { revision: error?.response?.data?.detail?.current_revision });
          }).catch(() => setConflictRecord({ revision: error?.response?.data?.detail?.current_revision }));
          setServerError("Someone else saved this record first. Your entries are still here. Review what changed, then load the latest values or reapply your entries.");
        } else {
          const message = formatApiErrorDetail(error?.response?.data?.detail) || "Unable to save record.";
          setServerError(message);
          toast.error(message);
        }
       },
    });
    return true;
  };
  const set = (k, v) => {
    setForm((f) => ({ ...f, [k]: v }));
    setFormErrors((errors) => {
      if (!errors[k]) return errors;
      const next = { ...errors };
      delete next[k];
      return next;
    });
    setServerError("");
  };
  const setSavedFilter = (key, value) => updateView((current) => ({
    ...current,
    filters: { ...current.filters, [key]: value },
  }));
  const setDateFilter = (key, value) => {
    const other = key === "date_from" ? view.filters.date_to : view.filters.date_from;
    if (value && other && (key === "date_from" ? value > other : value < other)) {
      setDateFilterError("Start date must be on or before end date.");
      return;
    }
    setDateFilterError("");
    setSavedFilter(key, value);
  };
  const requiredFields = fields.filter((field) => field.required);
  const outcomeFields = fields.filter((field) => !field.required && (field.section === "outcome"
    || ["status", "priority", "verification_status", "completion_mode", "completion_override"].includes(field.key)));
  const optionalFields = fields.filter((field) => !field.required && !outcomeFields.includes(field));
  const renderField = (f) => (
    <div key={f.key} className={f.col === 2 ? "col-span-2" : ""}>
      <Field label={f.label} required={f.required} error={formErrors[f.key]}>
        {f.type === "textarea" ? (
          <Textarea value={form[f.key] || ""} onChange={(e) => set(f.key, e.target.value)} rows={3} data-testid={`field-${f.key}`} />
        ) : f.type === "select" ? (
          <ListSelect options={f.options || config?.[f.configKey] || []} value={form[f.key]} onChange={(v) => set(f.key, v)} placeholder={f.label} testid={`field-${f.key}`} required={f.required} />
        ) : f.type === "dim" ? (
          <DimSelect config={config} keyName={f.configKey} value={form[f.key]} onChange={(v) => set(f.key, v)} testid={`field-${f.key}`} required={f.required} />
        ) : f.type === "relation" ? (
          <SelectOrAdd collection={f.collection} labelFn={f.labelFn} value={form[f.key]} onChange={(v) => set(f.key, v)} placeholder={`Select ${f.label}`} addFields={f.addFields} testid={`field-${f.key}`} required={f.required} />
        ) : (
          <Input type={f.type || "text"} min={f.min} max={f.max} value={form[f.key] || ""} onChange={(e) => set(f.key, e.target.value)} data-testid={`field-${f.key}`} />
        )}
      </Field>
    </div>
  );
  const refreshAll = () => queryClient.invalidateQueries();
  const lifecycle = async () => {
    const { row, action } = confirmingLifecycle;
    setLifecycleBusy(true);
    try {
      await api.post(`${lifecycleEndpoint}/${row.id}/${action}`);
      toast.success(`${singular || "Record"} ${action === "archive" ? "archived" : "restored"}`);
      setConfirmingLifecycle(null);
      refreshAll();
    } catch (error) {
      toast.error(formatApiErrorDetail(error?.response?.data?.detail) || "Lifecycle action failed.");
    } finally { setLifecycleBusy(false); }
  };
  const loadPreflight = async (row) => {
    setLoadingPreflight(true);
    setPreflight({ row, loading: true });
    setConfirmationId("");
    setConfirmationTitle("");
    setDeletionReason("");
    try {
      const { data: review } = await api.get(`${lifecycleEndpoint}/${row.id}/deletion-preflight`);
      setPreflight({ row, ...review });
    } catch (error) {
      toast.error(formatApiErrorDetail(error?.response?.data?.detail) || "Unable to run deletion preflight.");
      setPreflight(null);
    } finally { setLoadingPreflight(false); }
  };
  const permanentlyDelete = async () => {
    setLifecycleBusy(true);
    try {
      await api.delete(`${lifecycleEndpoint}/${preflight.row.id}/permanent`, { data: {
        confirmation_id: confirmationId, confirmation_title: confirmationTitle,
        reason: deletionReason, preflight_token: preflight.preflight_token,
      } });
      toast.success(`${singular || "Record"} permanently deleted`);
      setPreflight(null);
      refreshAll();
    } catch (error) {
      toast.error(formatApiErrorDetail(error?.response?.data?.detail) || "Permanent deletion failed.");
    } finally { setLifecycleBusy(false); }
  };
  const reviewDelete = async (row) => {
    if (parentLifecycle) {
      loadPreflight(row);
      return;
    }
    if (["projects", "municipalities", "properties"].includes(collection)) {
      try {
        const { data: review } = await api.get(`/resources/${collection}/${row.id}/deletion-preflight`);
        if (!review.allowed) {
          const summary = Object.entries(review.blockers).map(([name, count]) => `${count} ${name.replaceAll("_", " ")}`).join(", ");
          toast.error(`Deletion blocked: ${summary}. Archive or reassign those records first.`);
          return;
        }
      } catch (error) {
        toast.error(error?.response?.data?.detail?.message || error?.response?.data?.detail || "Unable to review dependencies.");
        return;
      }
    }
    setConfirmingDelete(row);
  };
  const canManageLifecycle = ["admin", "qa_manager"].includes(user?.role);
  const canWrite = user?.role !== "viewer";
  const isAdmin = user?.role === "admin";
  const preflightAllowed = preflight?.policy?.allowed ?? preflight?.allowed;
  const exactDeletionConfirmation = preflight && confirmationId === preflight.row.id
    && confirmationTitle === preflight.row.name && deletionReason.trim().length >= 3;
   const conflictChanges = conflictRecord ? fields.filter((field) =>
    JSON.stringify(baseRecord?.[field.key] ?? null) !== JSON.stringify(conflictRecord?.[field.key] ?? null)
  ) : [];
  const formDirty = Boolean(open && fields.some((field) =>
    JSON.stringify(form?.[field.key] ?? "") !== JSON.stringify((baseRecord || initial)?.[field.key] ?? "")
  ));

  return (
    <div>
      <PageHeader title={title} subtitle={subtitle}>
        {exportFilename && <Button variant="outline" onClick={() => downloadCsv(exportFilename, tableRowsToCsv(sortedData, sortColumns))} aria-label={`Export filtered ${title} as CSV`}><Download size={15} className="mr-1" /> Export</Button>}
        {parentLifecycle && <Button variant="outline" onClick={() => setSavedFilter("archived", showArchived ? "active" : "archived")} aria-pressed={showArchived}>
          {showArchived ? "Active records" : "Archived records"}
        </Button>}
        {user?.role !== "viewer" && <Button data-testid={`add-${collection}-btn`} onClick={openNew} className="bg-[var(--orange)] hover:bg-[var(--orange-600)]"><Plus size={16} className="mr-1" /> New</Button>}
      </PageHeader>
      {viewError && <div role="alert" className="mb-3 rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900">{viewError} <button type="button" className="ml-2 font-semibold underline" onClick={retryView}>Retry saved view</button></div>}
      {dateFilterError && <div role="alert" className="mb-3 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800">{dateFilterError}</div>}
      {dateFilterColumn && <div className="flex items-center gap-2 mb-3 flex-wrap" aria-label={`${title} date filters`}>
        <label className="text-xs text-muted-foreground">Last Tested from <Input type="date" value={view.filters.date_from} onChange={(event) => setDateFilter("date_from", event.target.value)} className="h-8 w-36 text-xs" aria-label="Last Tested Date from" aria-invalid={Boolean(dateFilterError)} /></label>
        <label className="text-xs text-muted-foreground">to <Input type="date" value={view.filters.date_to} onChange={(event) => setDateFilter("date_to", event.target.value)} className="h-8 w-36 text-xs" aria-label="Last Tested Date to" aria-invalid={Boolean(dateFilterError)} /></label>
        <span className="text-xs text-muted-foreground ml-auto">{filteredData.length} of {data.length} projects</span>
      </div>}
      <TableSortControls columns={sortColumns} sort={sort} setSort={setSort} defaultSort={defaultSort} className="mb-3" />
      {(isLoading || isError) && <QueryState query={collectionQuery} resource={title} onRetry={refetch} testId={`${collection}-query`} />}
      {!isLoading && !isError &&
      <div className={TABLE_FRAME_CLASS} role="region" aria-label={`${title} table`} tabIndex="0" data-testid={`${collection}-table-scroll`}>
        <table className={TABLE_CLASS}>
          <thead className={TABLE_HEAD_CLASS}>
            <tr>{sortColumns.map((c) => <SortableTableHeader key={c.key} column={c} sort={sort} onSort={(key) => setSort((current) => nextSort(current, key))} className="px-4 font-semibold text-xs" />)}
              <th className="px-2.5 py-2 w-20"><span className="sr-only">Actions</span></th></tr>
          </thead>
          <tbody>
             {filteredData.length === 0 && <tr><td colSpan={columns.length + 1} className={TABLE_EMPTY_CELL_CLASS}>
               {data.length === 0 ? `No ${title.toLowerCase()} have been created yet.` : "No records match the current filters."}
               {hasFilters && <Button type="button" size="sm" variant="outline" className="ml-3" onClick={clearFilters}>Clear filters</Button>}
             </td></tr>}
            {sortedData.map((row) => (
              <tr key={row.id} data-testid={`${collection}-row`} className={`border-t ${canWrite && !isArchived(row) ? "hover:bg-[var(--paper)]" : "bg-slate-50/60"}`}>
                {columns.map((c, index) => <td key={c.key} className={TABLE_CELL_CLASS}>
                  {index === 0 && canWrite && !isArchived(row) ? (
                    <button type="button" className="w-full text-left font-inherit focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--orange)] focus-visible:ring-offset-2 rounded"
                      onClick={() => rowLink ? rowLink(row) : openEdit(row)} aria-label={`${rowLink ? "Open" : "Edit"} ${row.name || row.document_name || singular || "record"}`}>
                      {c.render ? c.render(row) : (row[c.key] ?? "—")}
                    </button>
                  ) : (c.render ? c.render(row) : (row[c.key] ?? "—"))}
                </td>)}
                <td className={TABLE_ACTION_CELL_CLASS} onClick={(e) => e.stopPropagation()}>
                  <div className="flex gap-1">
                    {canWrite && !isArchived(row) && <Button type="button" size="icon" variant="ghost" className="h-7 w-7" aria-label={`Edit ${row.name || row.document_name || singular || "record"}`} onClick={() => openEdit(row)}><Pencil size={13} /></Button>}
                     {parentLifecycle && canWrite ? <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <Button size="icon" variant="ghost" className="h-7 w-7" aria-label={`Actions for ${row.name || singular || "record"}`}><MoreHorizontal size={15} /></Button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end">
                        <DropdownMenuLabel>{singular || "Record"} lifecycle</DropdownMenuLabel>
                        <DropdownMenuSeparator />
                        {canManageLifecycle ? <DropdownMenuItem onSelect={() => setConfirmingLifecycle({ row, action: isArchived(row) ? "restore" : "archive" })}>
                          {isArchived(row) ? <ArchiveRestore size={15} className="mr-2" /> : <Archive size={15} className="mr-2" />}
                          {isArchived(row) ? "Restore" : "Archive"}
                        </DropdownMenuItem> : <DropdownMenuItem disabled>No lifecycle actions available</DropdownMenuItem>}
                        {isAdmin && isArchived(row) && <><DropdownMenuSeparator /><DropdownMenuItem className="text-red-700 focus:text-red-700" onSelect={() => loadPreflight(row)}><Trash2 size={15} className="mr-2" /> Review permanent deletion</DropdownMenuItem></>}
                      </DropdownMenuContent>
                    </DropdownMenu> : canWrite && <Button type="button" size="icon" variant="ghost" className="h-7 w-7 text-destructive" aria-label={`Review deletion of ${row.name || row.document_name || singular || "record"}`} onClick={() => reviewDelete(row)}><Trash2 size={13} /></Button>}
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>}

      <FormModal open={open} onOpenChange={setOpen} title={form.id ? `Edit ${singular || title}` : `New ${singular || title}`} onSubmit={submit} submitDisabled={save.isPending || submitInFlight.current} submitLabel={save.isPending || submitInFlight.current ? "Saving…" : "Save"} dirty={formDirty} errors={formErrors} onFocusFirstError={focusFormError} wide>
        {serverError && <div role="alert" className="rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-800">
          <p className="font-semibold">{serverError}</p>
          {conflictRecord && <div className="mt-3">
            <p className="text-xs">The latest saved version is revision {conflictRecord.revision || "unknown"}.</p>
            {conflictChanges.length > 0 ? <div className="mt-2 max-h-44 overflow-auto rounded border border-red-200 bg-white p-2">
              <p className="text-xs font-semibold">Values changed by the other editor:</p>
              <ul className="mt-1 space-y-2 text-xs">
                {conflictChanges.map((field) => <li key={field.key}>
                  <span className="font-semibold">{field.label}:</span>
                  <span className="block">Latest saved value: {String(conflictRecord[field.key] ?? "blank")}</span>
                  <span className="block">Your entered value: {String(form[field.key] ?? "blank")}</span>
                </li>)}
              </ul>
            </div> : <p className="mt-2 text-xs">The record revision changed, but no editable field differences were detected.</p>}
            <div className="mt-2 flex flex-wrap gap-2">
              <Button type="button" size="sm" variant="outline" onClick={() => { setForm(conflictRecord); setBaseRecord(conflictRecord); setConflictRecord(null); setServerError(""); }}>Load latest values</Button>
              <Button type="button" size="sm" onClick={() => {
                setForm((current) => ({ ...current, expected_revision: conflictRecord.revision, expected_updated_at: conflictRecord.updated_at }));
                setBaseRecord(conflictRecord); setConflictRecord(null); setServerError("");
              }}>Keep my entries and reapply</Button>
            </div>
          </div>}
        </div>}
        {requiredFields.length > 0 && <fieldset className="rounded-xl border p-4">
          <legend className="px-2 text-xs font-bold uppercase tracking-wide text-muted-foreground">Required information</legend>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">{requiredFields.filter((f) => !f.showWhen || f.showWhen(form)).map(renderField)}</div>
        </fieldset>}
        {outcomeFields.length > 0 && <fieldset className="rounded-xl border p-4">
          <legend className="px-2 text-xs font-bold uppercase tracking-wide text-muted-foreground">Outcome and workflow</legend>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">{outcomeFields.filter((f) => !f.showWhen || f.showWhen(form)).map(renderField)}</div>
        </fieldset>}
        {optionalFields.length > 0 && <details className="rounded-xl border p-4">
          <summary className="cursor-pointer font-semibold text-sm text-[var(--navy)]">Optional details</summary>
          <div className="mt-4 grid grid-cols-1 sm:grid-cols-2 gap-4">{optionalFields.filter((f) => !f.showWhen || f.showWhen(form)).map(renderField)}</div>
        </details>}
        {attachable && form.id && (
          <div className="border-t pt-4 mt-2">
            <Attachments entityType={attachable} entityId={form.id} canWrite={user && user.role !== "viewer" && !isArchived(form)} />
          </div>
        )}
      </FormModal>

      <ConfirmActionDialog
        open={!!confirmingLifecycle}
        onOpenChange={(nextOpen) => !nextOpen && setConfirmingLifecycle(null)}
        title={`${confirmingLifecycle?.action === "archive" ? "Archive" : "Restore"} “${confirmingLifecycle?.row.name || singular || "record"}”?`}
        description={confirmingLifecycle?.action === "archive"
          ? `The ${singular?.toLowerCase() || "record"} will leave active lists. Linked test cases, evidence, attachments, and history remain intact.`
          : `The ${singular?.toLowerCase() || "record"} will return to active lists with its linked history intact.`}
        confirmLabel={confirmingLifecycle?.action === "archive" ? "Archive record" : "Restore record"}
        busy={lifecycleBusy}
        onConfirm={lifecycle}
      />
      <ConfirmActionDialog
        open={!!confirmingDelete}
        onOpenChange={(nextOpen) => !nextOpen && setConfirmingDelete(null)}
        title={`Delete “${confirmingDelete?.name || singular || "record"}”?`}
        description="This is allowed only when no dependent records exist. The action cannot be undone."
        confirmLabel="Delete record"
        destructive
        onConfirm={() => {
          const row = confirmingDelete;
          setConfirmingDelete(null);
          del.mutate(row.id, { onError: (error) => toast.error(error?.response?.data?.detail?.message || error?.response?.data?.detail || "Deletion failed.") });
        }}
      />

      <Dialog open={!!preflight} onOpenChange={(open) => !open && setPreflight(null)}>
        <DialogContent className="max-w-2xl">
          <DialogHeader><DialogTitle>Permanent deletion preflight</DialogTitle><DialogDescription>Permanent deletion is administrator-only. It is allowed only for an archived, unused {singular?.toLowerCase() || "record"}.</DialogDescription></DialogHeader>
          {loadingPreflight || preflight?.loading ? <p className="text-sm text-muted-foreground">Checking every known dependency…</p> : <>
            <div className={`rounded-lg border p-3 text-sm ${preflightAllowed ? "bg-green-50 border-green-200" : "bg-amber-50 border-amber-200"}`}>{preflightAllowed ? "Policy allows deletion: no dependencies were found." : "Policy blocks deletion. Keep this record archived so linked history remains intact."}</div>
            <div className="max-h-44 overflow-auto grid grid-cols-2 gap-x-5 gap-y-1 text-xs border rounded-lg p-3" aria-label="Exact dependency counts">
              {Object.entries(preflight?.dependencies || {}).map(([key, count]) => <div key={key} className="flex justify-between gap-3"><span>{key.replaceAll("_", " ")}</span><b>{count}</b></div>)}
            </div>
            {preflightAllowed && <div className="space-y-3">
              <p className="text-xs text-red-700">This permanently removes only this unused record. Linked history is never deleted automatically.</p>
              <Input aria-label={`Exact ${singular || "record"} ID`} placeholder={`Type ID: ${preflight.row.id}`} value={confirmationId} onChange={(event) => setConfirmationId(event.target.value)} />
              <Input aria-label={`Exact ${singular || "record"} title`} placeholder={`Type name: ${preflight.row.name}`} value={confirmationTitle} onChange={(event) => setConfirmationTitle(event.target.value)} />
              <Textarea aria-label="Deletion reason" placeholder="Required deletion reason" value={deletionReason} onChange={(event) => setDeletionReason(event.target.value)} />
            </div>}
          </>}
          <DialogFooter><Button variant="outline" onClick={() => setPreflight(null)}>Close</Button>{preflightAllowed && <Button variant="destructive" disabled={lifecycleBusy || !exactDeletionConfirmation} onClick={permanentlyDelete}>{lifecycleBusy ? "Deleting…" : "Permanently delete"}</Button>}</DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
