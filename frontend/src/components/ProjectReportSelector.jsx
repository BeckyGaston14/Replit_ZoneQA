import { useEffect, useState } from "react";
import { api } from "../lib/api";

export const initialReportProject = () => new URLSearchParams(window.location.search).get("project_id") || "";
export const projectSummaryUrl = (id) => `/executive?project_id=${encodeURIComponent(id)}&report_scope=both`;

export default function ProjectReportSelector({ value, onChange }) {
  const [projects, setProjects] = useState([]);
  const [error, setError] = useState(false);
  useEffect(() => {
    let active = true;
    const request = api.get("/projects");
    request?.then(({ data }) => {
      if (active) setProjects(Array.isArray(data) ? data : data?.items || []);
    }).catch(() => { if (active) setError(true); });
    return () => { active = false; };
  }, []);
  return <label className="flex flex-col gap-1 text-sm">
    <span className="font-medium">Testing project</span>
    <select aria-label="Summary testing project" className="h-9 max-w-full rounded-md border bg-background px-3" value={value} onChange={(event) => onChange(event.target.value)}>
      <option value="">All projects</option>
      {value && !projects.some((p) => p.id === value) && <option value={value}>Selected project</option>}
      {projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
    </select>
    {error && <span role="alert">Project list could not be loaded. Refresh to retry.</span>}
  </label>;
}
