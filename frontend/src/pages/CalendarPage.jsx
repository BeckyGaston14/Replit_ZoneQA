import { useEffect, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api, formatApiErrorDetail } from "../lib/api";
import { useAuth } from "../lib/auth";
import { PageHeader, StatusBadge } from "../components/shared";
import { CALENDAR_EVENT_STATES, CALENDAR_EVENT_STATUSES } from "../lib/statusMaps";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import { Textarea } from "../components/ui/textarea";
import { FormModal, Field, ListSelect } from "../components/forms";
import { ChevronLeft, ChevronRight, Plus, X } from "lucide-react";
import { toast } from "sonner";
import { QueryState } from "../components/PageState";

const ADD_TYPES = [["regression", "Regression Run"], ["deadline", "Deadline"], ["release", "Release"], ["milestone", "Milestone"]];

const fmt = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
const monthKey = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
const parseMonth = (value) => {
  if (!/^\d{4}-\d{2}$/.test(value || "")) return null;
  const [year, month] = value.split("-").map(Number);
  if (month < 1 || month > 12) return null;
  return new Date(year, month - 1, 1);
};

export default function CalendarPage() {
  const qc = useQueryClient();
  const { user } = useAuth();
  const canWrite = user && user.role !== "viewer";
  const [sp, setSp] = useSearchParams();
  const { data: events = [], ...calendarQuery } = useQuery({ queryKey: ["calendar"], queryFn: async () => (await api.get("/calendar/all-events")).data });
  const [month, setMonthState] = useState(() => parseMonth(sp.get("month")) || new Date(new Date().getFullYear(), new Date().getMonth(), 1));
  const [addModal, setAddModal] = useState(null);
  const [actionError, setActionError] = useState("");
  useEffect(() => {
    const next = parseMonth(sp.get("month"));
    if (next) setMonthState(next);
  }, [sp]);
  const setMonth = (next) => {
    setMonthState(next);
    const params = new URLSearchParams(sp);
    params.set("month", monthKey(next));
    setSp(params);
  };

  const byDate = {};
  events.forEach((e) => { byDate[e.date] = byDate[e.date] || []; byDate[e.date].push(e); });

  // build 6-week grid
  const first = new Date(month);
  const start = new Date(first);
  start.setDate(1 - first.getDay());
  const cells = Array.from({ length: 42 }, (_, i) => { const d = new Date(start); d.setDate(start.getDate() + i); return d; });
  const todayStr = fmt(new Date());
  const monthLabel = month.toLocaleDateString(undefined, { month: "long", year: "numeric" });

  const del = async (e) => {
    try { await api.delete(`/calendar_events/${e.id}`); toast.success("Event removed"); qc.invalidateQueries({ queryKey: ["calendar"] }); }
    catch (error) { const message = calendarError(error, "Unable to remove event"); setActionError(message); toast.error(message); }
  };
  const upcoming = events.filter((e) => e.date >= todayStr).slice(0, 8);

  return (
    <div>
      <PageHeader title="Testing Calendar" subtitle="Project deadlines, Bassett releases and scheduled regression runs.">
        {canWrite && <Button className="bg-[var(--orange)] hover:bg-[var(--orange-600)]" onClick={() => setAddModal({ date: fmt(new Date()), event_type: "regression", title: "", notes: "" })} data-testid="add-event-btn"><Plus size={15} className="mr-1" /> Schedule Event</Button>}
      </PageHeader>
      {actionError && <div role="alert" className="mb-3 rounded-lg border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-800">{actionError} <button type="button" className="ml-2 font-semibold underline" onClick={() => setActionError("")}>Dismiss</button></div>}

      <QueryState query={calendarQuery} resource="calendar" testId="calendar" />
      {!calendarQuery.isLoading && !calendarQuery.isError && <div className="grid lg:grid-cols-4 gap-4">
        <div className="lg:col-span-3 bg-card border rounded-xl overflow-hidden">
          <div className="flex items-center justify-between px-4 py-3 border-b">
            <button type="button" className="p-1.5 rounded-lg hover:bg-[var(--paper)]" aria-label="Previous month" onClick={() => setMonth(new Date(month.getFullYear(), month.getMonth() - 1, 1))} data-testid="cal-prev"><ChevronLeft size={17} /></button>
            <div className="font-display font-bold text-[var(--navy)]" data-testid="cal-month-label">{monthLabel}</div>
            <button type="button" className="p-1.5 rounded-lg hover:bg-[var(--paper)]" aria-label="Next month" onClick={() => setMonth(new Date(month.getFullYear(), month.getMonth() + 1, 1))} data-testid="cal-next"><ChevronRight size={17} /></button>
          </div>
          <div className="grid grid-cols-7 border-b bg-[var(--paper)]">
            {["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].map((d) => <div key={d} className="px-2 py-1.5 text-[10px] font-bold uppercase text-muted-foreground text-center">{d}</div>)}
          </div>
          <div className="grid grid-cols-7" data-testid="calendar-grid">
            {cells.map((d, i) => {
              const ds = fmt(d);
              const inMonth = d.getMonth() === month.getMonth();
              const evs = byDate[ds] || [];
              return (
                <div key={i} className={`min-h-[92px] border-b border-r p-1.5 ${inMonth ? "" : "bg-[var(--paper)]/60"} ${ds === todayStr ? "bg-orange-50" : ""}`}>
                  {canWrite ? <button type="button" aria-label={`Schedule event on ${ds}`} className={`w-full rounded text-left text-[11px] font-semibold mb-1 hover:bg-[var(--paper)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--orange)] ${inMonth ? "text-[var(--navy)]" : "text-muted-foreground/50"} ${ds === todayStr ? "text-[var(--orange)]" : ""}`}
                    onClick={() => setAddModal({ date: ds, event_type: "regression", title: "", notes: "" })}>{d.getDate()}</button>
                    : <div className={`text-[11px] font-semibold mb-1 ${inMonth ? "text-[var(--navy)]" : "text-muted-foreground/50"} ${ds === todayStr ? "text-[var(--orange)]" : ""}`}>{d.getDate()}</div>}
                  <div className="space-y-1">
                    {evs.slice(0, 3).map((e) => (
                       <div key={e.id} className="group flex items-center gap-1 text-[10px] font-medium rounded px-1 py-0.5 leading-tight"
                         title={`${e.label}${e.detail ? " · " + e.detail : ""}`}
                        onClick={(ev) => ev.stopPropagation()} data-testid="cal-event">
                         <span className="shrink-0"><StatusBadge value={e.type || "Unknown Event"} definitions={CALENDAR_EVENT_STATUSES} compact /></span>
                         <span className="truncate flex-1 text-[var(--navy)]">{e.label}</span>
                        {!e.readonly && canWrite && <button type="button" className="opacity-0 group-hover:opacity-100 shrink-0" aria-label={`Delete ${e.label}`} onClick={() => del(e)} data-testid={`del-event-${e.id}`}><X size={10} /></button>}
                      </div>
                    ))}
                    {evs.length > 3 && <div className="text-[9px] text-muted-foreground">+{evs.length - 3} more</div>}
                  </div>
                </div>
              );
            })}
          </div>
        </div>

        <div className="space-y-4">
          <div className="bg-card border rounded-xl p-4" data-testid="upcoming-events">
            <h3 className="font-semibold font-display text-[var(--navy)] text-sm mb-2">Upcoming</h3>
             {upcoming.length === 0 && <p className="text-xs text-muted-foreground">{events.length === 0 ? "No calendar events have been scheduled yet." : "Nothing scheduled ahead — click a day to schedule a regression run or deadline."}</p>}
            <div className="space-y-2">
              {upcoming.map((e) => (
                <div key={e.id} className="flex gap-2 text-xs">
                   <div className="flex flex-col items-start gap-1">
                     <StatusBadge value={e.type || "Unknown Event"} definitions={CALENDAR_EVENT_STATUSES} compact />
                     <StatusBadge value={e.readonly ? "Read-only" : "Editable"} definitions={CALENDAR_EVENT_STATES} compact />
                   </div>
                   <div><div className="font-medium text-[var(--navy)]">{e.label}</div><div className="text-muted-foreground">{e.date}{e.detail ? ` · ${e.detail}` : ""}</div></div>
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>}

      {addModal && <AddEventModal data={addModal} setData={setAddModal} onDone={() => qc.invalidateQueries({ queryKey: ["calendar"] })} onError={setActionError} />}
    </div>
  );
}

function AddEventModal({ data, setData, onDone, onError }) {
  const set = (k, v) => setData({ ...data, [k]: v });
  const [saving, setSaving] = useState(false);
  const save = async () => {
    if (saving) return;
    if (!data.title.trim()) return toast.error("Title required");
    setSaving(true);
    try {
      await api.post("/calendar_events", { title: data.title, date: data.date, event_type: data.event_type, notes: data.notes });
      toast.success("Event scheduled"); setData(null); onDone();
    } catch (error) { const message = calendarError(error, "Unable to schedule event"); onError(message); toast.error(message); }
    finally { setSaving(false); }
  };
  return (
    <FormModal open onOpenChange={() => setData(null)} title="Schedule Event" onSubmit={save} submitLabel={saving ? "Scheduling…" : "Schedule"}>
      <Field label="Title"><Input value={data.title} onChange={(e) => set("title", e.target.value)} placeholder="e.g. v2.0 regression run" data-testid="event-title" /></Field>
      <div className="grid grid-cols-2 gap-3">
        <Field label="Date"><Input type="date" value={data.date} onChange={(e) => set("date", e.target.value)} data-testid="event-date" /></Field>
        <Field label="Type"><ListSelect options={ADD_TYPES.map(([k]) => k)} value={data.event_type} onChange={(v) => set("event_type", v)} testid="event-type" /></Field>
      </div>
      <Field label="Notes"><Textarea rows={2} value={data.notes} onChange={(e) => set("notes", e.target.value)} /></Field>
    </FormModal>
  );
}

function calendarError(error, fallback) {
  if (error?.response?.status === 401) return "Your session has expired. Sign in again, then retry.";
  if (error?.response?.status === 403) return "You do not have permission to change the calendar.";
  if (error?.response?.status === 409) return "This calendar event changed elsewhere. Refresh and retry.";
  return formatApiErrorDetail(error?.response?.data?.detail) || fallback;
}
