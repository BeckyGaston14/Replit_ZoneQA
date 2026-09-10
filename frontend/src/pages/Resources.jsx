import ResourceList from "../components/ResourceList";
import { useNavigate } from "react-router-dom";
import { useCollection } from "../lib/hooks";
import { useAuth } from "../lib/auth";
import { useState } from "react";
import { api } from "../lib/api";
import {
  PROJECT_SCHEMA,
  MUNICIPALITY_SCHEMA,
  PROPERTY_SCHEMA,
  VerificationBadge,
  createEvidenceSchema,
} from "../lib/resourceSchemas";

export { VerificationBadge };

export function Projects() {
  const navigate = useNavigate();
  const { data: bassettRuns = [] } = useCollection("bassett/issues");
  const [selectedRunIds, setSelectedRunIds] = useState([]);
  const availableRuns = bassettRuns.filter((run) => !run.archived && !run.project_id);
  const toggleRun = (runId) => setSelectedRunIds((current) => current.includes(runId)
    ? current.filter((id) => id !== runId)
    : [...current, runId]);
  return <ResourceList
    {...PROJECT_SCHEMA}
    rowLink={(project) => navigate(`/bassett/issues?project_id=${encodeURIComponent(project.id)}`)}
    rowAction={{
      label: (project) => `Add test run to ${project.name}`,
      onClick: (project) => navigate(`/bassett/issues?project_id=${encodeURIComponent(project.id)}&new_run=1`),
    }}
    onNewOpen={() => setSelectedRunIds([])}
    onCreateSuccess={async (project) => {
      if (selectedRunIds.length) await api.post(`/projects/${project.id}/link-bassett-runs`, { run_ids: selectedRunIds });
      setSelectedRunIds([]);
    }}
    renderCreateExtras={() => <fieldset className="rounded-xl border p-4">
      <legend className="px-2 text-xs font-bold uppercase tracking-wide text-muted-foreground">Existing Bassett test runs</legend>
      <p className="mb-3 text-xs text-muted-foreground">Optional. Select unassigned test runs to add to this project when it is saved.</p>
      {availableRuns.length ? <div className="max-h-56 space-y-2 overflow-y-auto rounded-lg border p-2" role="group" aria-label="Existing unassigned Bassett test runs">
        {availableRuns.map((run) => <label key={run.id} className="flex cursor-pointer items-start gap-2 rounded-md p-2 hover:bg-[var(--paper)]">
          <input type="checkbox" className="mt-0.5" checked={selectedRunIds.includes(run.id)} onChange={() => toggleRun(run.id)} />
          <span className="text-sm"><span className="font-semibold text-[var(--navy)]">{run.name || run.title || run.test_id || "Untitled test run"}</span><span className="block text-xs text-muted-foreground">{[run.test_id, run.result, run.test_date].filter(Boolean).join(" · ") || "No result or test date yet"}</span></span>
        </label>)}
      </div> : <p className="rounded-lg bg-muted p-3 text-sm text-muted-foreground">No unassigned Bassett test runs are available.</p>}
      {selectedRunIds.length > 0 && <p className="mt-2 text-xs font-semibold text-[var(--navy)]">{selectedRunIds.length} test run{selectedRunIds.length === 1 ? "" : "s"} will be linked.</p>}
    </fieldset>}
  />;
}

export function Municipalities() {
  return <ResourceList {...MUNICIPALITY_SCHEMA} />;
}

export function Properties() {
  return <ResourceList {...PROPERTY_SCHEMA} />;
}

export function Evidence() {
  const { data: municipalities = [] } = useCollection("municipalities");
  const { data: users = [] } = useCollection("users");
  const { user } = useAuth();
  return <ResourceList {...createEvidenceSchema(municipalities, users, user)} />;
}
