import { NavLink, useSearchParams } from "react-router-dom";

export function ProjectScopeNav({ projects = [] }) {
  const [params] = useSearchParams();
  const projectId = params.get("project_id");
  if (!projectId) return null;
  const project = projects.find((item) => item.id === projectId);
  const encoded = encodeURIComponent(projectId);
  const tabs = [
    ["Bassett Test Runs", `/bassett/issues?project_id=${encoded}`],
    ["Model Comparison Test Cases", `/testcases?project_id=${encoded}`],
    ["Bassett Findings", `/bassett/findings?view=findings&project_id=${encoded}`],
    ["Model Comparison Findings", `/findings?project_id=${encoded}`],
  ];
  return <section className="mb-5 rounded-xl border bg-card p-3" aria-label="Testing project workspace" data-testid="project-scope-nav">
    <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
      <div><span className="text-[10px] font-bold uppercase tracking-wide text-muted-foreground">Testing project</span><h2 className="font-semibold text-[var(--navy)]">{project?.name || "Selected project"}</h2></div>
      <NavLink to="/projects" className="text-xs font-semibold text-[var(--orange)] hover:underline">All Testing Projects</NavLink>
    </div>
    <nav className="flex flex-wrap gap-2" aria-label="Project record types">
      {tabs.map(([label, to]) => <NavLink key={label} to={to} className={({ isActive }) => `rounded-lg border px-3 py-1.5 text-xs font-semibold ${isActive ? "border-[var(--navy)] bg-[var(--navy)] text-white" : "bg-background text-[var(--navy)] hover:bg-[var(--paper)]"}`}>{label}</NavLink>)}
    </nav>
  </section>;
}
