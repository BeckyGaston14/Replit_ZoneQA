import { CRIT_COLORS, RESULT_COLORS } from "../lib/api";
import { cn } from "../lib/utils";
import { Link } from "react-router-dom";
import { StatusBadge, StatusLegend } from "../lib/statusMaps";
import { evaluationScoreOrNull, formatEvaluationScore } from "../lib/evaluationScale";

export function CritBadge({ value }) {
  if (!value) return <span className="text-muted-foreground text-xs">—</span>;
  return (
    <span data-testid={`crit-badge-${value}`} className="inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-bold text-white"
      style={{ background: CRIT_COLORS[value] }} title={`Criticality ${value}`}>
      C{value}
    </span>
  );
}

export function ResultBadge({ value }) {
  return <StatusBadge value={value || "Not Evaluated"} />;
}

export function ScorePill({ score, status }) {
  const s = evaluationScoreOrNull(score);
  if (s === null) return <span className="text-xs text-muted-foreground" aria-label="Score unavailable">Unavailable</span>;
  const c = RESULT_COLORS[status] || (s >= 7.5 ? "#16a34a" : s >= 5 ? "#f59e0b" : "#dc2626");
  const formatted = formatEvaluationScore(s);
  return <span className="inline-flex items-center justify-center rounded-md px-2 py-0.5 text-sm font-bold text-white min-w-[42px]" style={{ background: c }} title={`${status || "Calculated"} score: ${formatted} out of 10`} aria-label={`${status || "Calculated"} score ${formatted} out of 10`}>{formatted}</span>;
}

export { StatusBadge, StatusLegend };

export function StatCard({ label, value, accent, icon: Icon, sub, testid, onClick, title, to }) {
  const descriptionId = testid ? `${testid}-description` : undefined;
  const content = (
    <>
      <div className="flex items-start justify-between">
        <div>
          <div className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">{label}</div>
          <div className="mt-2 text-3xl font-bold font-display" style={{ color: accent || "var(--navy)" }}>{value}</div>
          {sub && <div className="mt-1 text-xs text-muted-foreground">{sub}</div>}
        </div>
        {Icon && <div className="rounded-lg p-2" style={{ background: (accent || "#16215a") + "18" }}><Icon size={18} style={{ color: accent || "#16215a" }} /></div>}
      </div>
      {title && <span id={descriptionId} className="sr-only">{title}</span>}
    </>
  );
  const classes = cn(
    "bg-card rounded-xl border p-4 card-hover",
    (to || onClick) && "cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--orange)] focus-visible:ring-offset-2",
  );
  const accessibleName = title || `${label}: ${value}${sub ? `. ${sub}` : ""}`;
  if (to) {
    return <Link data-testid={testid} to={to} title={title} aria-label={accessibleName} aria-describedby={descriptionId} className={classes}>{content}</Link>;
  }
  if (onClick) {
    return <button type="button" data-testid={testid} onClick={onClick} title={title} aria-label={accessibleName} aria-describedby={descriptionId} className={cn(classes, "w-full text-left")}>{content}</button>;
  }
  return <div data-testid={testid} className={classes}>{content}</div>;
}

export function Section({ title, children, action }) {
  return (
    <div className="bg-card rounded-xl border p-5">
      <div className="flex items-center justify-between mb-4">
        <h3 className="text-base font-semibold font-display text-[var(--navy)]">{title}</h3>
        {action}
      </div>
      {children}
    </div>
  );
}

export function PageHeader({ title, subtitle, children }) {
  return (
    <div className="flex items-end justify-between mb-6 flex-wrap gap-3">
      <div>
        <h1 className="text-2xl font-bold font-display text-[var(--navy)]">{title}</h1>
        {subtitle && <p className="text-sm text-muted-foreground mt-1">{subtitle}</p>}
      </div>
      <div className="flex w-full flex-wrap items-center gap-2 sm:w-auto sm:justify-end">{children}</div>
    </div>
  );
}

// Recharts custom tick: wraps long category labels onto up to two lines instead of truncating.
export function WrapTick({ x, y, payload, width = 150, fontSize = 10 }) {
  const label = String(payload?.value ?? "");
  const maxChars = Math.max(10, Math.floor(width / (fontSize * 0.58)));
  let lines = [label];
  if (label.length > maxChars) {
    const words = label.split(" ");
    let l1 = "", l2 = "";
    for (const w of words) {
      if ((l1 + " " + w).trim().length <= maxChars && !l2) l1 = (l1 + " " + w).trim();
      else l2 = (l2 + " " + w).trim();
    }
    if (l2.length > maxChars) l2 = l2.slice(0, maxChars - 1) + "…";
    lines = [l1, l2];
  }
  return (
    <text x={x} y={y} textAnchor="end" fill="#64748b" fontSize={fontSize} aria-label={label}>
      {lines.map((l, i) => (
        <tspan key={i} x={x} dy={i === 0 ? (lines.length > 1 ? "-0.2em" : "0.32em") : "1.1em"}>{l}</tspan>
      ))}
    </text>
  );
}

// Screen-reader-accessible table alternative for charts (visually hidden, keyboard/AT reachable).
export function SrTable({ caption, columns, rows }) {
  return (
    <table className="sr-only">
      <caption>{caption}</caption>
      <thead><tr>{columns.map((c) => <th key={c} scope="col">{c}</th>)}</tr></thead>
      <tbody>{rows.map((r, i) => <tr key={i}>{r.map((cell, j) => <td key={j}>{cell}</td>)}</tr>)}</tbody>
    </table>
  );
}
