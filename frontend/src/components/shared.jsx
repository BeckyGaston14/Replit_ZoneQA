import { CRIT_COLORS } from "../lib/api";
import { cn } from "../lib/utils";
import { Link } from "react-router-dom";
import { StatusBadge, StatusLegend } from "../lib/statusMaps";
import { evaluationScoreOrNull, formatEvaluationScore } from "../lib/evaluationScale";
import { evaluationResultColor, evaluationResultDetails } from "../lib/evaluationResults";
import { useSampleVisibility } from "../lib/hooks";
import { Switch } from "./ui/switch";
import { Info } from "lucide-react";

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
  const details = evaluationResultDetails(value);
  return <StatusBadge value={details.isWorkflowState ? "Blocked" : details.result} />;
}

export function ScorePill({ score, status }) {
  const s = evaluationScoreOrNull(score);
  if (s === null) return <span className="text-xs text-muted-foreground" aria-label="Score unavailable">Unavailable</span>;
  const c = status ? evaluationResultColor(status) : (s >= 7.5 ? "#16a34a" : s >= 5 ? "#f59e0b" : "#dc2626");
  const formatted = formatEvaluationScore(s);
  return <span className="inline-flex items-center justify-center rounded-md px-2 py-0.5 text-sm font-bold text-white min-w-[42px]" style={{ background: c }} title={`${status || "Calculated"} score: ${formatted} out of 10`} aria-label={`${status || "Calculated"} score ${formatted} out of 10`}>{formatted}</span>;
}

export { StatusBadge, StatusLegend };

const DEFAULT_CALCULATION = {
  formula: "Calculated by the canonical reporting service from persisted QA records.",
  scope: "The current page scope and selected version or filters.",
  filters: "Page filters are applied when present; a value of “—” means the required data is unavailable.",
  treatment: "Sample data follows the page’s explicit sample scope. Retests and variants follow the page’s displayed scope.",
  denominator: "Only records with the required persisted values are included; missing values are not treated as zero.",
  rounding: "Values are rounded for display only; underlying persisted values remain unchanged.",
};

export function HowCalculated({ definition, calculation = {}, drillDown, className = "" }) {
  const details = { ...DEFAULT_CALCULATION, ...calculation, definition };
  return (
    <details className={cn("mt-3 border-t border-border/70 pt-2 text-xs", className)} data-testid="how-calculated">
      <summary className="cursor-pointer rounded-sm font-semibold text-[var(--navy)] underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--orange)]">
        How calculated
      </summary>
      <div className="mt-2 space-y-1.5 text-muted-foreground">
        {details.definition && <p><strong className="text-foreground">Definition:</strong> {details.definition}</p>}
        {details.formula && <p><strong className="text-foreground">Formula:</strong> {details.formula}</p>}
        {details.scope && <p><strong className="text-foreground">Scope:</strong> {details.scope}</p>}
        {details.filters && <p><strong className="text-foreground">Filters:</strong> {details.filters}</p>}
        {details.treatment && <p><strong className="text-foreground">Data handling:</strong> {details.treatment}</p>}
        {details.denominator && <p><strong className="text-foreground">Denominator:</strong> {details.denominator}</p>}
        {details.rounding && <p><strong className="text-foreground">Rounding:</strong> {details.rounding}</p>}
        {drillDown && <Link to={drillDown} className="inline-flex font-semibold text-[var(--orange)] underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--orange)]">Open exact records</Link>}
      </div>
    </details>
  );
}

function MetricInfo({ label, description }) {
  return (
    <details className="relative z-20" data-testid="metric-info">
      <summary
        className="flex h-7 w-7 cursor-pointer list-none items-center justify-center rounded-full bg-card/90 text-muted-foreground shadow-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--orange)] [&::-webkit-details-marker]:hidden"
        aria-label={`About ${label}`}
        title={`About ${label}`}
      >
        <Info size={15} aria-hidden="true" />
      </summary>
      <div role="tooltip" className="absolute right-0 top-9 z-30 w-64 rounded-lg border bg-card p-3 text-xs font-normal leading-5 text-foreground shadow-lg">
        {description}
      </div>
    </details>
  );
}

export function StatCard({ label, value, accent, icon: Icon, sub, testid, onClick, title, to, calculation, showCalculation = true }) {
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
    "relative bg-card rounded-xl border p-4 card-hover",
    (to || onClick) && "cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--orange)] focus-visible:ring-offset-2",
  );
  const accessibleName = title || `${label}: ${value}${sub ? `. ${sub}` : ""}`;
  if (to) {
    return <div className={classes}>
      <Link data-testid={testid} to={to} title={title} aria-label={accessibleName} aria-describedby={descriptionId} className="block rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--orange)] focus-visible:ring-offset-2">{content}</Link>
      {title && <div className="absolute right-14 top-3"><MetricInfo label={label} description={title} /></div>}
      {showCalculation && <HowCalculated definition={title || `${label}: ${value}`} calculation={calculation} drillDown={to} />}
    </div>;
  }
  if (onClick) {
    return <div className={classes}>
      <button type="button" data-testid={testid} onClick={onClick} title={title} aria-label={accessibleName} aria-describedby={descriptionId} className="w-full rounded-sm text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--orange)] focus-visible:ring-offset-2">{content}</button>
      {title && <div className="absolute right-14 top-3"><MetricInfo label={label} description={title} /></div>}
      {showCalculation && <HowCalculated definition={title || `${label}: ${value}`} calculation={calculation} />}
    </div>;
  }
  return <div data-testid={testid} className={classes}>{content}{title && <div className="absolute right-14 top-3"><MetricInfo label={label} description={title} /></div>}{showCalculation && <HowCalculated definition={title || `${label}: ${value}`} calculation={calculation} />}</div>;
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

export function SampleRecordsControl() {
  const {
    includeSampleRecords,
    setIncludeSampleRecords,
    isLoading,
    isSaving,
  } = useSampleVisibility();
  const busy = isLoading || isSaving;
  return (
    <label
      className={cn(
        "inline-flex items-center gap-2 rounded-lg border border-border bg-card px-2.5 py-1.5 text-xs text-foreground",
        busy && "opacity-70",
      )}
      data-testid="sample-records-control"
    >
      <Switch
        checked={includeSampleRecords}
        onCheckedChange={setIncludeSampleRecords}
        disabled={busy}
        aria-label="Show sample records"
        data-testid="show-sample-records-toggle"
      />
      <span>Show sample records</span>
    </label>
  );
}

const SAMPLE_MARKER = /\[SAMPLE\]|\(Sample\)/i;

export function isSampleDataRecord(record) {
  if (!record || typeof record !== "object") return false;
  if (record.sample_data === true || record.is_sample === true) return true;
  return ["name", "title", "version", "bassett_version", "release_number", "environment"]
    .some((key) => SAMPLE_MARKER.test(String(record[key] || "")));
}

export function sampleScopeIncludesData({ versions = [], records = [], selectedVersion = "" } = {}) {
  if ([...versions, ...records].some((record) => record?.sample_data_included === true)) return true;
  const selected = typeof selectedVersion === "object"
    ? selectedVersion
    : versions.find((version) => version?.id === selectedVersion || version?.name === selectedVersion);
  if (selectedVersion && (isSampleDataRecord(selected) || SAMPLE_MARKER.test(String(selectedVersion)))) return true;
  return [...versions, ...records].some(isSampleDataRecord);
}

export function SampleDataBanner({ show = false }) {
  if (!show) return null;
  return (
    <aside
      role="note"
      data-testid="sample-data-banner"
      className="mb-4 flex items-start gap-3 rounded-lg border border-amber-300 bg-amber-50 px-3 py-2.5 text-sm text-amber-950"
    >
      <span className="mt-0.5 text-base" aria-hidden="true">ⓘ</span>
      <div>
        <strong className="font-semibold">Demonstration data</strong>
        <p className="mt-0.5 text-xs text-amber-900">This view includes a sample version or [SAMPLE] record. It is not production QA evidence.</p>
      </div>
    </aside>
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
