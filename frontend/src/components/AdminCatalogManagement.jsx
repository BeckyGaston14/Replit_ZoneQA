import { useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowDown, ArrowUp, Eye, EyeOff, Pencil, Plus, Save, Trash2, X } from "lucide-react";
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
  const hiddenCount = useMemo(
    () => (scenariosQuery.data || []).filter((scenario) => scenario.archived).length,
    [scenariosQuery.data],
  );

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
  const remove = async (scenario) => {
    if (!globalThis.confirm?.(`Permanently delete ${scenario.stable_id}? This is allowed only when no saved records use it.`)) return;
    setBusy(true);
    try {
      await api.delete(`/bassett/scenarios/${scenario.id}?confirm=true`);
      toast.success("Test scenario permanently deleted");
      if (editing?.id === scenario.id) setEditing(null);
      await refresh();
    } catch (error) {
      const detail = error.response?.data?.detail;
      toast.error(typeof detail === "string" ? detail : detail?.message || "The scenario could not be deleted");
    } finally { setBusy(false); }
  };
  const removeAllHidden = async () => {
    if (!globalThis.confirm?.(`Permanently delete all ${hiddenCount} hidden test scenarios? Scenarios used by saved records will be retained automatically.`)) return;
    setBusy(true);
    try {
      const { data } = await api.delete("/bassett/scenarios/archived?confirm=true");
      if (data.retained_count) {
        toast.success(`${data.deleted_count} hidden scenarios deleted; ${data.retained_count} retained because saved records use them.`);
      } else {
        toast.success(`${data.deleted_count} hidden scenarios permanently deleted.`);
      }
      setEditing(null);
      await refresh();
    } catch (error) {
      const detail = error.response?.data?.detail;
      toast.error(typeof detail === "string" ? detail : detail?.message || "The hidden scenarios could not be deleted");
    } finally { setBusy(false); }
  };

  return <div className="space-y-4">
    <div className="rounded-xl border bg-card p-4">
      <h2 className="font-display font-semibold text-[var(--navy)]">Test Scenarios</h2>
      <p className="mt-1 text-sm text-muted-foreground">Update the instructions shown during test entry. Hidden scenarios stay attached to existing records but are unavailable for new tests.</p>
      <div className="mt-3 flex flex-wrap items-end justify-between gap-3">
        <div className="min-w-[240px] flex-1"><Label htmlFor="admin-scenario-search" className="block">Find a scenario</Label>
      <Input id="admin-scenario-search" className="mt-2" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search ID, category, or wording…" />
        </div>
        {hiddenCount > 0 && <Button type="button" variant="destructive" disabled={busy} onClick={removeAllHidden}><Trash2 size={14}/> Delete all hidden scenarios ({hiddenCount})</Button>}
      </div>
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
            <div className="flex flex-wrap gap-2"><Button type="button" size="sm" variant="outline" disabled={scenario.archived} title={scenario.archived ? "Show this scenario before editing it" : undefined} onClick={() => setEditing({ ...scenario })}><Pencil size={14}/> Edit</Button><Button type="button" size="sm" variant="outline" disabled={busy} onClick={() => toggle(scenario)}>{scenario.archived ? <Eye size={14}/> : <EyeOff size={14}/>} {scenario.archived ? "Show" : "Hide"}</Button><Button type="button" size="sm" variant="destructive" disabled={busy} onClick={() => remove(scenario)}><Trash2 size={14}/> Delete</Button></div>
          </div>
        </div>)}
        {!scenariosQuery.isLoading && !shown.length && <p className="p-6 text-center text-sm text-muted-foreground">No matching scenarios.</p>}
        {scenariosQuery.isLoading && <p className="p-6 text-center text-sm text-muted-foreground">Loading test scenarios…</p>}
      </div>
    </div>
  </div>;
}

export function AdminScenarioRubrics() {
  const queryClient = useQueryClient();
  const [query, setQuery] = useState("");
  const [selectedScenarioId, setSelectedScenarioId] = useState("");
  const [selectedRubricIds, setSelectedRubricIds] = useState([]);
  const [busy, setBusy] = useState(false);
  const scenariosQuery = useQuery({
    queryKey: ["admin-bassett-scenarios"],
    queryFn: async () => (await api.get("/bassett/scenarios?include_archived=true")).data,
  });
  const catalogQuery = useQuery({
    queryKey: ["admin-rubric-catalog"],
    queryFn: async () => (await api.get("/bassett/rubric-catalog")).data,
  });
  const scenarios = useMemo(() => scenariosQuery.data || [], [scenariosQuery.data]);
  const catalog = catalogQuery.data || { rubric_items: [], categories: [] };
  const rubricItems = (catalog.rubric_items || []).filter((item) => item.deleted !== true);
  const selectedScenario = scenarios.find((scenario) => scenario.id === selectedScenarioId);
  const shownScenarios = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return scenarios.filter((scenario) => !needle || [scenario.stable_id, scenario.workflow_stage, scenario.test_scenario]
      .some((value) => String(value || "").toLowerCase().includes(needle)));
  }, [query, scenarios]);
  const selectScenario = (scenario) => {
    const availableIds = new Set(rubricItems.map((item) => item.rubric_id));
    setSelectedScenarioId(scenario.id);
    setSelectedRubricIds((scenario.rubric_ids || []).filter((id) => availableIds.has(id)));
  };
  const toggleRubric = (rubricId) => {
    setSelectedRubricIds((current) => current.includes(rubricId)
      ? current.filter((id) => id !== rubricId)
      : [...current, rubricId]);
  };
  const save = async () => {
    if (!selectedScenario) return;
    if (!selectedRubricIds.length) {
      toast.error("Select at least one rubric evaluation for this scenario");
      return;
    }
    setBusy(true);
    try {
      await api.put(`/bassett/scenarios/${selectedScenario.id}`, withExpectedVersion(selectedScenario, {
        rubric_ids: selectedRubricIds,
      }));
      toast.success(`Rubric evaluations updated for ${selectedScenario.stable_id}`);
      const refreshed = await scenariosQuery.refetch();
      const latest = (refreshed.data || []).find((scenario) => scenario.id === selectedScenario.id);
      if (latest) setSelectedRubricIds([...(latest.rubric_ids || [])]);
      await queryClient.invalidateQueries({ queryKey: ["bassett-scenarios"] });
    } catch (error) {
      const detail = error.response?.data?.detail;
      toast.error(staleUpdateMessage(error) || (typeof detail === "string" ? detail : detail?.rubric_ids) || "The rubric associations could not be saved");
    } finally { setBusy(false); }
  };

  return <div className="space-y-4">
    <div className="rounded-xl border bg-card p-4">
      <h2 className="font-display font-semibold text-[var(--navy)]">Scenario Rubric Associations</h2>
      <p className="mt-1 text-sm text-muted-foreground">Choose a test scenario, then select every rubric evaluation that should appear by default when that scenario is used. Existing test runs keep their saved evaluations and scores.</p>
      <Label htmlFor="admin-association-search" className="mt-3 block">Find a scenario</Label>
      <Input id="admin-association-search" className="mt-2" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search ID, category, or wording…" />
    </div>
    <div className="grid gap-4 lg:grid-cols-[minmax(260px,0.8fr)_minmax(0,1.6fr)]">
      <div className="rounded-xl border bg-card overflow-hidden">
        <div className="max-h-[680px] overflow-y-auto divide-y">
          {shownScenarios.map((scenario) => <button key={scenario.id} type="button" onClick={() => selectScenario(scenario)} className={`block w-full p-4 text-left hover:bg-slate-50 ${selectedScenarioId === scenario.id ? "bg-orange-50 ring-2 ring-inset ring-[var(--orange)]" : ""}`}>
            <div className="flex flex-wrap items-center gap-2"><strong className="text-[var(--navy)]">{scenario.stable_id}</strong><span className="rounded-full border px-2 py-0.5 text-xs">{scenario.workflow_stage || scenario.test_type}</span>{scenario.archived && <span className="rounded-full bg-slate-200 px-2 py-0.5 text-xs">Hidden</span>}</div>
            <p className="mt-1 line-clamp-2 text-sm">{scenario.test_scenario}</p>
            <p className="mt-1 text-xs text-muted-foreground">{(scenario.rubric_ids || []).length} rubric evaluation{(scenario.rubric_ids || []).length === 1 ? "" : "s"}</p>
          </button>)}
          {!scenariosQuery.isLoading && !shownScenarios.length && <p className="p-6 text-center text-sm text-muted-foreground">No matching scenarios.</p>}
          {scenariosQuery.isLoading && <p className="p-6 text-center text-sm text-muted-foreground">Loading test scenarios…</p>}
        </div>
      </div>
      <div className="rounded-xl border bg-card p-4">
        {!selectedScenario ? <div className="flex min-h-[280px] items-center justify-center text-center text-sm text-muted-foreground">Select a scenario to review or change its rubric evaluations.</div> : <div className="space-y-5">
          <div><div className="flex flex-wrap items-center gap-2"><h3 className="font-semibold text-[var(--navy)]">{selectedScenario.stable_id}</h3><span className="rounded-full border px-2 py-0.5 text-xs">{selectedRubricIds.length} selected</span></div><p className="mt-1 text-sm">{selectedScenario.test_scenario}</p></div>
          {(catalog.categories || []).map((category) => {
            const items = rubricItems.filter((item) => item.category === category.key);
            if (!items.length) return null;
            return <fieldset key={category.key} className="rounded-lg border p-3"><legend className="px-1 text-sm font-semibold text-[var(--navy)]">{category.name}</legend><div className="mt-1 space-y-2">{items.map((item) => <label key={item.rubric_id} className={`flex gap-3 rounded-md border p-3 ${item.active === false ? "bg-slate-50 text-muted-foreground" : "cursor-pointer hover:bg-slate-50"}`}><input type="checkbox" className="mt-1 h-4 w-4" checked={selectedRubricIds.includes(item.rubric_id)} disabled={item.active === false && !selectedRubricIds.includes(item.rubric_id)} onChange={() => toggleRubric(item.rubric_id)} /><span><span className="font-semibold">{item.rubric_id}</span>{item.active === false && <span className="ml-2 rounded-full bg-slate-200 px-2 py-0.5 text-xs">Hidden</span>}<span className="mt-0.5 block text-sm">{item.evaluation_criterion}</span></span></label>)}</div></fieldset>;
          })}
          <div className="sticky bottom-0 flex flex-wrap items-center justify-between gap-3 border-t bg-card pt-4"><p className="text-xs text-muted-foreground">Changes set the defaults for future uses of this scenario.</p><Button type="button" onClick={save} disabled={busy}>{busy ? "Saving…" : "Save Associations"}</Button></div>
        </div>}
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
  const availableItems = (catalog.rubric_items || []).filter((item) => item.deleted !== true);
  const shown = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return (catalog.rubric_items || []).filter((item) => item.deleted !== true).filter((item) => !needle || [item.rubric_id, item.evaluation_criterion, item.expected_behavior, categoryNames[item.category]]
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
      return true;
    } catch (error) { toast.error(staleUpdateMessage(error) || error.response?.data?.detail || "The rubric item could not be saved"); return false; }
    finally { setBusy(false); }
  };
  const startAdd = () => setEditing({
    is_new: true,
    position: availableItems.length + 1,
    category: catalog.categories?.[0]?.key || "",
    evaluation_complexity: "Moderate",
    evaluation_criterion: "",
    why_it_matters: "",
    expected_behavior: "",
    passing_standard: "",
  });
  const save = async (event) => {
    event.preventDefault();
    const fields = ["evaluation_criterion", "evaluation_complexity", "why_it_matters", "expected_behavior", "passing_standard", "category"];
    const payload = {
      ...Object.fromEntries(fields.map((key) => [key, String(editing[key] || "").trim()])),
      position: Number(editing.position),
    };
    if (editing.is_new) {
      setBusy(true);
      try {
        await api.post("/bassett/rubric-items", payload);
        toast.success("Rubric item added and numbers updated");
        setEditing(null);
        await refresh();
      } catch (error) { toast.error(error.response?.data?.detail || "The rubric item could not be added"); }
      finally { setBusy(false); }
      return;
    }
    const currentPosition = availableItems.findIndex((item) => item.rubric_id === editing.rubric_id) + 1;
    const updated = await update(editing, payload);
    if (!updated) return;
    if (payload.position && payload.position !== currentPosition) {
      setBusy(true);
      try {
        await api.post("/bassett/rubric-items/reorder", { rubric_id: editing.rubric_id, position: payload.position });
        toast.success("Rubric numbers and scenario links updated");
        await refresh();
      } catch (error) { toast.error(error.response?.data?.detail || "The rubric item order could not be changed"); }
      finally { setBusy(false); }
    }
  };
  const move = async (item, change) => {
    const currentPosition = availableItems.findIndex((candidate) => candidate.rubric_id === item.rubric_id) + 1;
    const position = currentPosition + change;
    if (position < 1 || position > availableItems.length) return;
    setBusy(true);
    try {
      await api.post("/bassett/rubric-items/reorder", { rubric_id: item.rubric_id, position });
      toast.success("Rubric numbers and scenario links updated");
      setEditing(null);
      await refresh();
    } catch (error) { toast.error(error.response?.data?.detail || "The rubric item order could not be changed"); }
    finally { setBusy(false); }
  };
  const remove = async (item) => {
    if (!globalThis.confirm?.(`Permanently remove ${item.rubric_id} from future evaluations? Historical scores will be preserved.`)) return;
    setBusy(true);
    try {
      await api.delete(`/bassett/rubric-items/${item.rubric_id}?confirm=true`);
      toast.success("Rubric item removed from future evaluations");
      if (editing?.rubric_id === item.rubric_id) setEditing(null);
      await refresh();
    } catch (error) {
      const detail = error.response?.data?.detail;
      toast.error(typeof detail === "string" ? detail : detail?.message || "The rubric item could not be deleted");
    } finally { setBusy(false); }
  };

  return <div className="space-y-4">
    <div className="rounded-xl border bg-card p-4"><div className="flex flex-wrap items-start justify-between gap-3"><div><h2 className="font-display font-semibold text-[var(--navy)]">Rubric Evaluation Items</h2><p className="mt-1 text-sm text-muted-foreground">Add, edit, hide, delete, or move items. Moving an item automatically renumbers the current list and updates Test Scenario associations; saved test-run snapshots keep their original labels and scores.</p></div><Button type="button" onClick={startAdd}><Plus size={16}/> Add Rubric Item</Button></div><Label htmlFor="admin-rubric-search" className="mt-3 block">Find a rubric item</Label><Input id="admin-rubric-search" className="mt-2" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search ID, category, or wording…" /></div>
    {editing && <form onSubmit={save} className="rounded-xl border border-[var(--orange)] bg-card p-4 space-y-3"><div className="flex items-center justify-between gap-2"><div><h3 className="font-semibold text-[var(--navy)]">{editing.is_new ? "Add Rubric Item" : `Edit ${editing.rubric_id}`}</h3><p className="text-xs text-muted-foreground">Choose its number to place it in the list. Later items will be renumbered automatically.</p></div><Button type="button" size="icon" variant="ghost" onClick={() => setEditing(null)} aria-label="Cancel rubric edit"><X size={16}/></Button></div><div className="grid gap-3 sm:grid-cols-3"><div><Label htmlFor="rubric-position">Rubric number</Label><Input id="rubric-position" type="number" min="1" max={availableItems.length + (editing.is_new ? 1 : 0)} value={editing.position || availableItems.findIndex((item) => item.rubric_id === editing.rubric_id) + 1} onChange={(event) => setEditing({ ...editing, position: event.target.value })} /></div><div><Label htmlFor="rubric-category">Category</Label><select id="rubric-category" className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm" value={editing.category || ""} onChange={(event) => setEditing({ ...editing, category: event.target.value })}>{(catalog.categories || []).map((category) => <option key={category.key} value={category.key}>{category.name}</option>)}</select></div><div><Label htmlFor="rubric-complexity">Evaluation complexity</Label><select id="rubric-complexity" className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm" value={editing.evaluation_complexity || "Moderate"} onChange={(event) => setEditing({ ...editing, evaluation_complexity: event.target.value })}>{["Low", "Moderate", "High", "Very High"].map((value) => <option key={value}>{value}</option>)}</select></div></div>{[["evaluation_criterion", "Evaluation criterion"], ["why_it_matters", "Why it matters"], ["expected_behavior", "Expected behavior"], ["passing_standard", "Passing standard"]].map(([key, label]) => <div key={key}><Label htmlFor={`rubric-${key}`}>{label}</Label><TextArea id={`rubric-${key}`} value={editing[key]} onChange={(event) => setEditing({ ...editing, [key]: event.target.value })} /></div>)}<div className="flex gap-2"><Button type="submit" disabled={busy}><Save size={14}/> {editing.is_new ? "Add Item" : "Save Changes"}</Button><Button type="button" variant="outline" onClick={() => setEditing(null)}>Cancel</Button></div></form>}
    <div className="rounded-xl border bg-card overflow-hidden"><div className="max-h-[620px] overflow-y-auto divide-y">{shown.map((item) => { const position = availableItems.findIndex((candidate) => candidate.rubric_id === item.rubric_id) + 1; return <div key={item.rubric_id} className={`p-4 ${item.active === false ? "bg-slate-50 text-muted-foreground" : ""}`}><div className="flex flex-wrap items-start justify-between gap-3"><div className="min-w-0 flex-1"><div className="flex flex-wrap items-center gap-2"><strong className="text-[var(--navy)]">{item.rubric_id}</strong><span className="rounded-full border px-2 py-0.5 text-xs">{categoryNames[item.category] || item.category}</span>{item.active === false && <span className="rounded-full bg-slate-200 px-2 py-0.5 text-xs">Hidden</span>}</div><p className="mt-1 text-sm font-medium">{item.evaluation_criterion}</p><p className="mt-1 text-xs text-muted-foreground">{item.expected_behavior}</p></div><div className="flex flex-wrap gap-2"><Button type="button" size="icon" variant="outline" disabled={busy || position <= 1 || query.trim()} onClick={() => move(item, -1)} aria-label={`Move ${item.rubric_id} up`} title="Move up and renumber"><ArrowUp size={14}/></Button><Button type="button" size="icon" variant="outline" disabled={busy || position >= availableItems.length || query.trim()} onClick={() => move(item, 1)} aria-label={`Move ${item.rubric_id} down`} title="Move down and renumber"><ArrowDown size={14}/></Button><Button type="button" size="sm" variant="outline" onClick={() => setEditing({ ...item, position })}><Pencil size={14}/> Edit</Button><Button type="button" size="sm" variant="outline" disabled={busy} onClick={() => update(item, { active: item.active === false })}>{item.active === false ? <Eye size={14}/> : <EyeOff size={14}/>} {item.active === false ? "Show" : "Hide"}</Button><Button type="button" size="sm" variant="destructive" disabled={busy} onClick={() => remove(item)}><Trash2 size={14}/> Delete</Button></div></div></div>; })}{!catalogQuery.isLoading && !shown.length && <p className="p-6 text-center text-sm text-muted-foreground">No matching rubric items.</p>}{catalogQuery.isLoading && <p className="p-6 text-center text-sm text-muted-foreground">Loading rubric items…</p>}</div></div>
  </div>;
}
