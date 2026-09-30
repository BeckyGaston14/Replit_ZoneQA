import { useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Eye, EyeOff, Pencil, Save, X } from "lucide-react";
import { toast } from "sonner";
import { api, staleUpdateMessage, withExpectedVersion } from "../lib/api";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { Label } from "./ui/label";

const scenarioFields = [
  ["test_scenario", "Scenario wording"],
  ["why_it_matters", "Why it matters"],
  ["what_bassett_should_do", "What Bassett should do"],
  ["success_criteria", "Success criteria"],
];

function TextArea({ id, value, onChange, rows = 3 }) {
  return <textarea id={id} rows={rows} value={value || ""} onChange={onChange} className="flex w-full rounded-md border border-input bg-background px-3 py-2 text-sm" />;
}

export function AdminScenarios() {
  const queryClient = useQueryClient();
  const [query, setQuery] = useState("");
  const [editing, setEditing] = useState(null);
  const [busy, setBusy] = useState(false);
  const scenariosQuery = useQuery({
    queryKey: ["admin-bassett-scenarios"],
    queryFn: async () => (await api.get("/bassett/scenarios?include_archived=true")).data,
  });
  const shown = useMemo(() => {
    const scenarios = scenariosQuery.data || [];
    const needle = query.trim().toLowerCase();
    return scenarios.filter((row) => !needle || [row.stable_id, row.workflow_stage, row.test_scenario]
      .some((value) => String(value || "").toLowerCase().includes(needle)));
  }, [query, scenariosQuery.data]);

  const refresh = async () => {
    await scenariosQuery.refetch();
    await queryClient.invalidateQueries({ queryKey: ["bassett-scenarios"] });
  };
  const save = async (event) => {
    event.preventDefault();
    setBusy(true);
    try {
      const payload = Object.fromEntries(scenarioFields.map(([key]) => [key, String(editing[key] || "").trim()]));
      await api.put(`/bassett/scenarios/${editing.id}`, withExpectedVersion(editing, payload));
      toast.success("Test scenario updated");
      setEditing(null);
      await refresh();
    } catch (error) {
      toast.error(staleUpdateMessage(error) || error.response?.data?.detail || "The test scenario could not be saved");
    } finally { setBusy(false); }
  };
  const toggle = async (scenario) => {
    setBusy(true);
    try {
      await api.post(`/bassett/scenarios/${scenario.id}/${scenario.archived ? "restore" : "archive"}`);
      toast.success(scenario.archived ? "Test scenario is available again" : "Test scenario hidden from new selections");
      await refresh();
    } catch (error) { toast.error(error.response?.data?.detail || "The scenario visibility could not be changed"); }
    finally { setBusy(false); }
  };

  return <div className="space-y-4">
    <div className="rounded-xl border bg-card p-4">
      <h2 className="font-display font-semibold text-[var(--navy)]">Test Scenarios</h2>
      <p className="mt-1 text-sm text-muted-foreground">Update the instructions shown during test entry. Hidden scenarios stay attached to existing records but are unavailable for new tests.</p>
      <Label htmlFor="admin-scenario-search" className="mt-3 block">Find a scenario</Label>
      <Input id="admin-scenario-search" className="mt-2" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search ID, category, or wording…" />
    </div>
    {editing && <form onSubmit={save} className="rounded-xl border border-[var(--orange)] bg-card p-4 space-y-3">
      <div className="flex items-center justify-between gap-2"><div><h3 className="font-semibold text-[var(--navy)]">Edit {editing.stable_id}</h3><p className="text-xs text-muted-foreground">The ID and category remain fixed so reports and historical links continue to work.</p></div><Button type="button" size="icon" variant="ghost" onClick={() => setEditing(null)} aria-label="Cancel scenario edit"><X size={16}/></Button></div>
      {scenarioFields.map(([key, label]) => <div key={key}><Label htmlFor={`scenario-${key}`}>{label}</Label><TextArea id={`scenario-${key}`} value={editing[key]} onChange={(event) => setEditing({ ...editing, [key]: event.target.value })} /></div>)}
      <div className="flex gap-2"><Button type="submit" disabled={busy}><Save size={14}/> Save Changes</Button><Button type="button" variant="outline" onClick={() => setEditing(null)}>Cancel</Button></div>
    </form>}
    <div className="rounded-xl border bg-card overflow-hidden">
      <div className="max-h-[620px] overflow-y-auto divide-y">
        {shown.map((scenario) => <div key={scenario.id} className={`p-4 ${scenario.archived ? "bg-slate-50 text-muted-foreground" : ""}`}>
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="min-w-0 flex-1"><div className="flex flex-wrap items-center gap-2"><strong className="text-[var(--navy)]">{scenario.stable_id}</strong><span className="rounded-full border px-2 py-0.5 text-xs">{scenario.workflow_stage || scenario.test_type}</span>{scenario.archived && <span className="rounded-full bg-slate-200 px-2 py-0.5 text-xs">Hidden</span>}</div><p className="mt-1 text-sm">{scenario.test_scenario}</p></div>
            <div className="flex gap-2"><Button type="button" size="sm" variant="outline" onClick={() => setEditing({ ...scenario })}><Pencil size={14}/> Edit</Button><Button type="button" size="sm" variant="outline" disabled={busy} onClick={() => toggle(scenario)}>{scenario.archived ? <Eye size={14}/> : <EyeOff size={14}/>} {scenario.archived ? "Show" : "Hide"}</Button></div>
          </div>
        </div>)}
        {!scenariosQuery.isLoading && !shown.length && <p className="p-6 text-center text-sm text-muted-foreground">No matching scenarios.</p>}
        {scenariosQuery.isLoading && <p className="p-6 text-center text-sm text-muted-foreground">Loading test scenarios…</p>}
      </div>
    </div>
  </div>;
}

export function AdminRubricItems() {
  const queryClient = useQueryClient();
  const [query, setQuery] = useState("");
  const [editing, setEditing] = useState(null);
  const [busy, setBusy] = useState(false);
  const catalogQuery = useQuery({
    queryKey: ["admin-rubric-catalog"],
    queryFn: async () => (await api.get("/bassett/rubric-catalog")).data,
  });
  const catalog = catalogQuery.data || { rubric_items: [], categories: [] };
  const categoryNames = Object.fromEntries((catalog.categories || []).map((category) => [category.key, category.name]));
  const shown = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return (catalog.rubric_items || []).filter((item) => !needle || [item.rubric_id, item.evaluation_criterion, item.expected_behavior, categoryNames[item.category]]
      .some((value) => String(value || "").toLowerCase().includes(needle)));
  }, [catalog.rubric_items, categoryNames, query]);
  const refresh = async () => {
    await catalogQuery.refetch();
    await queryClient.invalidateQueries({ queryKey: ["bassett-rubric-catalog"] });
  };
  const update = async (item, changes) => {
    setBusy(true);
    try {
      await api.put(`/bassett/rubric-items/${item.rubric_id}`, { ...changes, expected_revision: item.revision });
      toast.success(changes.active === false ? "Rubric item hidden from new selections" : changes.active === true ? "Rubric item is available again" : "Rubric item updated");
      setEditing(null);
      await refresh();
    } catch (error) { toast.error(staleUpdateMessage(error) || error.response?.data?.detail || "The rubric item could not be saved"); }
    finally { setBusy(false); }
  };
  const save = (event) => {
    event.preventDefault();
    update(editing, Object.fromEntries(["evaluation_criterion", "why_it_matters", "expected_behavior", "passing_standard"].map((key) => [key, String(editing[key] || "").trim()])));
  };

  return <div className="space-y-4">
    <div className="rounded-xl border bg-card p-4"><h2 className="font-display font-semibold text-[var(--navy)]">Rubric Evaluation Items</h2><p className="mt-1 text-sm text-muted-foreground">Revise the guidance used during evaluation or hide an item from new selections. Rubric IDs and categories stay fixed to preserve reporting and saved scores.</p><Label htmlFor="admin-rubric-search" className="mt-3 block">Find a rubric item</Label><Input id="admin-rubric-search" className="mt-2" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search ID, category, or wording…" /></div>
    {editing && <form onSubmit={save} className="rounded-xl border border-[var(--orange)] bg-card p-4 space-y-3"><div className="flex items-center justify-between gap-2"><div><h3 className="font-semibold text-[var(--navy)]">Edit {editing.rubric_id}</h3><p className="text-xs text-muted-foreground">{categoryNames[editing.category] || editing.category}</p></div><Button type="button" size="icon" variant="ghost" onClick={() => setEditing(null)} aria-label="Cancel rubric edit"><X size={16}/></Button></div>{[["evaluation_criterion", "Evaluation criterion"], ["why_it_matters", "Why it matters"], ["expected_behavior", "Expected behavior"], ["passing_standard", "Passing standard"]].map(([key, label]) => <div key={key}><Label htmlFor={`rubric-${key}`}>{label}</Label><TextArea id={`rubric-${key}`} value={editing[key]} onChange={(event) => setEditing({ ...editing, [key]: event.target.value })} /></div>)}<div className="flex gap-2"><Button type="submit" disabled={busy}><Save size={14}/> Save Changes</Button><Button type="button" variant="outline" onClick={() => setEditing(null)}>Cancel</Button></div></form>}
    <div className="rounded-xl border bg-card overflow-hidden"><div className="max-h-[620px] overflow-y-auto divide-y">{shown.map((item) => <div key={item.rubric_id} className={`p-4 ${item.active === false ? "bg-slate-50 text-muted-foreground" : ""}`}><div className="flex flex-wrap items-start justify-between gap-3"><div className="min-w-0 flex-1"><div className="flex flex-wrap items-center gap-2"><strong className="text-[var(--navy)]">{item.rubric_id}</strong><span className="rounded-full border px-2 py-0.5 text-xs">{categoryNames[item.category] || item.category}</span>{item.active === false && <span className="rounded-full bg-slate-200 px-2 py-0.5 text-xs">Hidden</span>}</div><p className="mt-1 text-sm font-medium">{item.evaluation_criterion}</p><p className="mt-1 text-xs text-muted-foreground">{item.expected_behavior}</p></div><div className="flex gap-2"><Button type="button" size="sm" variant="outline" onClick={() => setEditing({ ...item })}><Pencil size={14}/> Edit</Button><Button type="button" size="sm" variant="outline" disabled={busy} onClick={() => update(item, { active: item.active === false })}>{item.active === false ? <Eye size={14}/> : <EyeOff size={14}/>} {item.active === false ? "Show" : "Hide"}</Button></div></div></div>)}{!catalogQuery.isLoading && !shown.length && <p className="p-6 text-center text-sm text-muted-foreground">No matching rubric items.</p>}{catalogQuery.isLoading && <p className="p-6 text-center text-sm text-muted-foreground">Loading rubric items…</p>}</div></div>
  </div>;
}
