import { useState, useId, useRef, cloneElement, isValidElement } from "react";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogFooter } from "./ui/dialog";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { Label } from "./ui/label";
import { Textarea } from "./ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "./ui/select";
import { Plus } from "lucide-react";
import { api, formatApiErrorDetail } from "../lib/api";
import { useQueryClient } from "@tanstack/react-query";
import { useCollection } from "../lib/hooks";

export function Field({ label, children, required = false, error, description }) {
  const generatedId = useId();
  const id = isValidElement(children) && children.props.id ? children.props.id : generatedId;
  const errorId = `${id}-error`;
  const describedBy = [
    children?.props?.["aria-describedby"],
    description ? `${id}-description` : "",
    error ? errorId : "",
  ].filter(Boolean).join(" ") || undefined;
  const control = isValidElement(children) ? cloneElement(children, {
    id,
    required: children.props.required ?? required,
    "aria-invalid": Boolean(error),
    "aria-describedby": describedBy,
  }) : children;
  return <div className="space-y-1.5">
    <Label htmlFor={id} className="text-xs font-semibold text-muted-foreground">
      {label}{required && <span className="text-red-700" aria-hidden="true"> *</span>}
      {required && <span className="sr-only"> (required)</span>}
    </Label>
    {description && <p id={`${id}-description`} className="text-xs text-muted-foreground">{description}</p>}
    {control}
    {error && <p id={errorId} role="alert" className="text-xs text-red-700">{error}</p>}
  </div>;
}

// Searchable select with inline "Add new" for relational records
export function SelectOrAdd({ collection, valueField = "id", labelFn, value, onChange, placeholder, addFields, addDefaults = {}, requiredContext = [], testid, id, required = false, "aria-invalid": ariaInvalid, "aria-describedby": ariaDescribedby }) {
  const qc = useQueryClient();
  const { data: items = [] } = useCollection(collection);
  const [adding, setAdding] = useState(false);
  const [form, setForm] = useState({});
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const [fieldErrors, setFieldErrors] = useState({});
  const addPrefix = useId();
  const relatedLabel = collection.endsWith("ies") ? `${collection.slice(0, -3)}y`
    : collection.endsWith("s") ? collection.slice(0, -1) : collection;

  const create = async () => {
    if (pending) return;
    const missingContext = requiredContext.find(({ key }) => !String(addDefaults[key] || "").trim());
    if (missingContext) {
      setError(missingContext.message || `${missingContext.label || key} is required before adding this record.`);
      return;
    }
    const missing = (addFields || []).find((field) => field.required !== false && !String(form[field.key] || "").trim());
    if (missing) {
      setFieldErrors({ [missing.key]: `${missing.label} is required.` });
      return;
    }
    setPending(true);
    setError("");
    setFieldErrors({});
    try {
      const { data } = await api.post(`/${collection}`, { ...addDefaults, ...form });
      qc.setQueryData([collection], (current = []) => [...current.filter((item) => item[valueField] !== data[valueField]), data]);
      await qc.invalidateQueries({ predicate: (query) => query.queryKey.some((key) => String(key).startsWith(collection)) });
      onChange(data[valueField]);
      setAdding(false); setForm({}); setFieldErrors({});
    } catch (requestError) {
      setError(formatApiErrorDetail(requestError?.response?.data?.detail) || `Unable to add ${relatedLabel}. Check the values and try again.`);
    } finally {
      setPending(false);
    }
  };

  return (
    <div className="space-y-2">
      <div className="flex gap-2">
        <Select value={value || ""} onValueChange={onChange} disabled={pending}>
          <SelectTrigger id={id || testid || addPrefix} data-testid={testid} aria-required={required || undefined} aria-invalid={ariaInvalid || undefined} aria-describedby={ariaDescribedby} className="flex-1"><SelectValue placeholder={placeholder} /></SelectTrigger>
          <SelectContent>
            {items.map((it) => <SelectItem key={it[valueField]} value={it[valueField]}>{labelFn(it)}</SelectItem>)}
          </SelectContent>
        </Select>
        {addFields && (
          <Button type="button" variant="outline" size="icon" onClick={() => setAdding(!adding)} title="Add new" aria-label={`Add new ${relatedLabel}`}>
            <Plus size={16} />
          </Button>
        )}
      </div>
      {adding && (
        <div className="rounded-lg border bg-[var(--paper)] p-3 space-y-2">
           {addFields.map((f) => {
             const fieldId = `${addPrefix}-${f.key}`;
              const fieldErrorId = `${fieldId}-error`;
             return <div key={f.key} className="space-y-1">
                 <label htmlFor={fieldId} className="text-xs font-semibold text-muted-foreground">{f.label}{f.required !== false && <><span className="text-red-700" aria-hidden="true"> *</span><span className="sr-only"> (required)</span></>}</label>
               <Input id={fieldId} placeholder={f.label} value={form[f.key] || ""}
                  onChange={(e) => { setForm({ ...form, [f.key]: e.target.value }); setFieldErrors((current) => ({ ...current, [f.key]: "" })); setError(""); }}
                 onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); create(); } }}
                   required={f.required !== false} aria-invalid={Boolean(fieldErrors[f.key])} aria-describedby={fieldErrors[f.key] ? fieldErrorId : undefined} disabled={pending} className="h-8 text-sm" />
                {fieldErrors[f.key] && <p id={fieldErrorId} role="alert" className="text-xs text-red-700">{fieldErrors[f.key]}</p>}
             </div>;
           })}
           {error && <p role="alert" className="text-xs text-red-700">{error}</p>}
          <div className="flex gap-2">
             <Button type="button" size="sm" onClick={create} disabled={pending}>{pending ? "Adding…" : "Add"}</Button>
              <Button type="button" size="sm" variant="ghost" onClick={() => { setAdding(false); setError(""); setFieldErrors({}); }} disabled={pending}>Cancel</Button>
          </div>
        </div>
      )}
    </div>
  );
}

export function FormModal({ open, onOpenChange, title, description = "Complete the form fields, then save your changes or cancel.", children, onSubmit, submitLabel = "Save", wide, submitDisabled = false, dirty = false, errors = {}, onFocusFirstError }) {
  const [confirmClose, setConfirmClose] = useState(false);
  const submitGuard = useRef(false);
  const errorEntries = Object.entries(errors).filter(([, message]) => message);
  const requestClose = () => {
    if (dirty) setConfirmClose(true);
    else onOpenChange(false);
  };
  const handleOpenChange = (nextOpen) => {
    if (!nextOpen) requestClose();
    else onOpenChange(true);
  };
  const handleSubmit = (event) => {
    event.preventDefault();
    if (submitDisabled || submitGuard.current) return;
    submitGuard.current = true;
    try {
      const result = onSubmit?.();
      if (result && typeof result.then === "function") Promise.resolve(result).then(() => { submitGuard.current = false; }, () => { submitGuard.current = false; });
      else Promise.resolve().then(() => { submitGuard.current = false; });
    } catch (error) {
      submitGuard.current = false;
      throw error;
    }
  };
  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className={wide ? "w-[calc(100%_-_1rem)] max-w-2xl max-h-[90vh] overflow-y-auto sm:w-full" : "w-[calc(100%_-_1rem)] max-h-[90vh] overflow-y-auto sm:w-full"}>
        <DialogHeader>
          <DialogTitle className="font-display text-[var(--navy)]">{title}</DialogTitle>
          <DialogDescription className="sr-only">{description}</DialogDescription>
        </DialogHeader>
        <form className="space-y-4 py-2" onSubmit={handleSubmit} aria-busy={submitDisabled}>
          {errorEntries.length > 0 && <div role="alert" aria-label="Form errors" className="rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-800">
            <p className="font-semibold">Please fix {errorEntries.length === 1 ? "the highlighted field" : "the highlighted fields"} before saving.</p>
            <ul className="mt-1 list-disc pl-5">{errorEntries.map(([key, message]) => <li key={key}><button type="button" className="underline text-left" onClick={() => onFocusFirstError?.(key)}>{message}</button></li>)}</ul>
          </div>}
          {children}
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={requestClose}>Cancel</Button>
            <Button type="submit" data-testid="modal-submit-btn" disabled={submitDisabled} className="bg-[var(--orange)] hover:bg-[var(--orange-600)]">{submitLabel}</Button>
          </DialogFooter>
        </form>
        {confirmClose && <div role="alertdialog" aria-label="Unsaved changes" className="mt-3 rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm text-amber-950">
          <p className="font-semibold">You have unsaved changes.</p>
          <p className="mt-1">Keep editing or discard these entries?</p>
          <div className="mt-3 flex justify-end gap-2">
            <Button type="button" variant="outline" onClick={() => setConfirmClose(false)}>Keep editing</Button>
            <Button type="button" onClick={() => { setConfirmClose(false); onOpenChange(false); }}>Discard changes</Button>
          </div>
        </div>}
      </DialogContent>
    </Dialog>
  );
}

export function DimSelect({ config, keyName, value, onChange, testid, id, required, "aria-invalid": ariaInvalid, "aria-describedby": ariaDescribedby }) {
  const map = config?.[keyName] || {};
  return (
    <Select value={String(value || "")} onValueChange={(v) => onChange(Number(v))}>
      <SelectTrigger id={id || testid} data-testid={testid} aria-required={required || undefined} aria-invalid={ariaInvalid || undefined} aria-describedby={ariaDescribedby}><SelectValue placeholder="Select" /></SelectTrigger>
      <SelectContent>
        {Object.entries(map).map(([k, v]) => <SelectItem key={k} value={k}>{k} — {v}</SelectItem>)}
      </SelectContent>
    </Select>
  );
}

export function ListSelect({ options, value, onChange, placeholder, testid, id, required, "aria-invalid": ariaInvalid, "aria-describedby": ariaDescribedby }) {
  return (
    <Select value={value || ""} onValueChange={onChange}>
      <SelectTrigger id={id || testid} data-testid={testid} aria-required={required || undefined} aria-invalid={ariaInvalid || undefined} aria-describedby={ariaDescribedby}><SelectValue placeholder={placeholder} /></SelectTrigger>
      <SelectContent>{(options || []).map((option) => {
        const value = typeof option === "object" ? option.value : option;
        const label = typeof option === "object" ? option.label : option;
        return <SelectItem key={value} value={value}>{label}</SelectItem>;
      })}</SelectContent>
    </Select>
  );
}
