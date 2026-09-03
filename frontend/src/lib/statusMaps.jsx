import {
  AlertTriangle, Ban, CalendarDays, CheckCircle2, Circle, Clock3, Flag,
  HelpCircle, Info, Loader2, Rocket, ShieldAlert, Star, XCircle,
} from "lucide-react";
import { RESULT_COLORS } from "./api";

const resultIcon = {
  Pass: CheckCircle2,
  "Pass with Notes": AlertTriangle,
  "Pass with Minor Issues": AlertTriangle,
  "Needs Improvement": AlertTriangle,
  Partial: AlertTriangle,
  Blocked: Ban,
  Fail: XCircle,
  "Critical Fail": ShieldAlert,
  "Not Enough Evidence": HelpCircle,
  "Not Evaluated": Circle,
  Incomplete: Clock3,
};

export const RESULT_STATUSES = Object.fromEntries(
  Object.entries({
    Pass: "Meets the approved expectations.",
    "Pass with Notes": "Passes with reviewer notes or minor concerns.",
    "Pass with Minor Issues": "Passes with minor issues that do not block acceptance.",
    "Needs Improvement": "Does not yet meet the preferred quality threshold.",
    Partial: "Only part of the expected behavior was verified.",
    Blocked: "Testing could not be completed.",
    Fail: "Does not meet the approved expectations.",
    "Critical Fail": "Has a severe quality or safety failure.",
    "Not Enough Evidence": "There is not enough verified evidence to decide.",
    "Not Evaluated": "No final evaluation has been recorded.",
    Incomplete: "A legacy or interrupted run is incomplete.",
  }).map(([label, description]) => [label, {
    label: label === "Incomplete" ? "Legacy: Incomplete" : label,
    description,
    color: RESULT_COLORS?.[label] || "#64748b",
    icon: resultIcon[label] || HelpCircle,
  }]),
);

export const FINDING_STATUSES = {
  New: { color: "#64748b", icon: Circle, description: "Newly recorded and not yet triaged." },
  Confirmed: { color: "#0369a1", icon: CheckCircle2, description: "Confirmed as a reproducible finding." },
  "Needs Investigation": { color: "#7c3aed", icon: HelpCircle, description: "More investigation is required." },
  Planned: { color: "#1d4ed8", icon: Clock3, description: "Accepted and planned for future work." },
  "In Development": { color: "#2f3f96", icon: Loader2, description: "A fix is being developed." },
  "Ready for Retest": { color: "#b45309", icon: AlertTriangle, description: "A fix is ready for QA retesting." },
  Fixed: { color: "#15803d", icon: CheckCircle2, description: "The fix passed verification." },
  Closed: { color: "#334155", icon: CheckCircle2, description: "The finding is closed." },
  "Won't Fix": { color: "#475569", icon: Ban, description: "The finding was intentionally declined." },
  Duplicate: { color: "#64748b", icon: Ban, description: "The finding duplicates another record." },
};

export const REGRESSION_DELTA_STATUSES = {
  improved: { label: "Improved", color: "#15803d", icon: CheckCircle2, description: "The current result improved compared with the selected baseline." },
  regressed: { label: "Regressed", color: "#b91c1c", icon: ShieldAlert, description: "The current result is worse than the selected baseline." },
  still_pass: { label: "Still Passing", color: "#047857", icon: CheckCircle2, description: "The test passed in both the baseline and current run." },
  still_fail: { label: "Still Failing", color: "#be123c", icon: XCircle, description: "The test failed in both the baseline and current run." },
  new: { label: "New (no baseline)", color: "#0369a1", icon: Circle, description: "No matching result exists in the selected baseline." },
  not_evaluated: { label: "Not Evaluated", color: "#475569", icon: HelpCircle, description: "The current run has no completed evaluation." },
  unchanged: { label: "Unchanged", color: "#475569", icon: Circle, description: "The result did not change compared with the baseline." },
};

export const EXPECTED_BEHAVIOR_STATUSES = {
  Met: { color: "#15803d", icon: CheckCircle2, description: "The response met this expected behavior." },
  "Partially Met": { color: "#b45309", icon: AlertTriangle, description: "The response met only part of this expected behavior." },
  "Not Met": { color: "#b91c1c", icon: XCircle, description: "The response did not meet this expected behavior." },
  "N/A": { color: "#475569", icon: Ban, description: "This expected behavior does not apply to the response." },
};

export const RETEST_STATUSES = {
  Fixed: { color: "#15803d", icon: CheckCircle2, description: "The retest verified that the finding was fixed." },
  "Partially Fixed": { color: "#b45309", icon: AlertTriangle, description: "The retest verified only part of the intended fix." },
  "Not Fixed": { color: "#b91c1c", icon: XCircle, description: "The retest did not verify the intended fix." },
};

export const ACTIVITY_STATUSES = {
  Active: { color: "#15803d", icon: CheckCircle2, description: "This account or record is active." },
  Inactive: { color: "#b45309", icon: Ban, description: "This account or record is inactive." },
};

export const INTEGRITY_SEVERITIES = {
  high: { label: "High", color: "#b91c1c", icon: ShieldAlert, description: "A high-severity integrity issue requires prompt review." },
  medium: { label: "Medium", color: "#b45309", icon: AlertTriangle, description: "A medium-severity integrity issue should be reviewed." },
  low: { label: "Low", color: "#0369a1", icon: Info, description: "A low-severity or informational integrity issue." },
};

export const INTEGRITY_CHECK_STATUSES = {
  clean: { label: "Clean", color: "#15803d", icon: CheckCircle2, description: "All integrity checks passed." },
  attention: { label: "Attention Required", color: "#b45309", icon: AlertTriangle, description: "One or more integrity issues require review." },
};

export const RELEASE_DECISIONS = {
  GO: { label: "Go", color: "#15803d", icon: CheckCircle2, description: "The release meets the current readiness criteria." },
  CONDITIONAL: { label: "Conditional Go", color: "#b45309", icon: AlertTriangle, description: "The release may proceed only with the stated conditions." },
  "NO-GO": { label: "No-Go", color: "#b91c1c", icon: ShieldAlert, description: "The release does not meet the current readiness criteria." },
  "GO WITH RISK ACCEPTANCE": { color: "#92400e", icon: AlertTriangle, description: "An authorized reviewer approved release while explicitly accepting documented risk." },
};

export const COMPARISON_VERDICTS = {
  "Bassett Wins": { color: "#15803d", icon: CheckCircle2, description: "Bassett scored meaningfully higher than both benchmark models." },
  "Bassett Underperforms": { color: "#b91c1c", icon: ShieldAlert, description: "At least one benchmark model scored meaningfully higher than Bassett." },
  Comparable: { color: "#b45309", icon: AlertTriangle, description: "Bassett and the benchmark models scored within the comparable range." },
};

export const DEMO_STATUSES = {
  Approved: { color: "#2f3f96", icon: Star, description: "Approved for use in customer demonstrations." },
  "Gold Reverification Required": { color: "#b45309", icon: AlertTriangle, description: "The Gold Standard uses stale evidence and must be reverified before use." },
};

export const COVERAGE_STATUSES = {
  no_tests: { label: "No Tests", color: "#b91c1c", icon: XCircle, description: "No active test cases cover this area." },
  thin: { label: "Thin Coverage", color: "#b45309", icon: AlertTriangle, description: "Only one active test case covers this area." },
  covered: { label: "Covered", color: "#15803d", icon: CheckCircle2, description: "At least two active test cases cover this area." },
};

export const CALENDAR_EVENT_STATUSES = {
  release: { label: "Release", color: "#c2410c", icon: Rocket, description: "A scheduled Bassett release." },
  regression: { label: "Regression Run", color: "#0369a1", icon: Loader2, description: "A scheduled regression test run." },
  deadline: { label: "Deadline", color: "#b91c1c", icon: Flag, description: "A project or testing deadline." },
  project_start: { label: "Project Kickoff", color: "#2f3f96", icon: CalendarDays, description: "The scheduled start of a testing project." },
  milestone: { label: "Milestone", color: "#15803d", icon: CheckCircle2, description: "A scheduled project or release milestone." },
};

export const CALENDAR_EVENT_STATES = {
  "Read-only": { color: "#475569", icon: Ban, description: "This event is generated from another record and cannot be edited here." },
  Editable: { color: "#0369a1", icon: CalendarDays, description: "This calendar event can be edited by an authorized user." },
};

export const REGRESSION_RUN_STATUSES = {
  "Legacy Run": { color: "#475569", icon: Clock3, description: "This historical run does not include a per-test snapshot." },
  "No Baseline": { color: "#0369a1", icon: Info, description: "This is the first snapshot and has no baseline comparison." },
};

export const TEST_CASE_STATUSES = {
  Draft: { color: "#64748b", icon: Circle, description: "The test case is still being prepared." },
  Active: { color: "#0369a1", icon: CheckCircle2, description: "The test case is active and available for testing." },
  Testing: { color: "#2f3f96", icon: Loader2, description: "Testing is currently in progress." },
  Complete: { color: "#15803d", icon: CheckCircle2, description: "The test workflow is complete." },
  Completed: { color: "#15803d", icon: CheckCircle2, description: "The test workflow is complete." },
  Archived: { color: "#475569", icon: Ban, description: "The test case is archived and read-only." },
};

export const TEST_WORKFLOW_STATUSES = {
  Complete: { color: "#15803d", icon: CheckCircle2, description: "Every required workflow stage is complete." },
  Incomplete: { color: "#b45309", icon: AlertTriangle, description: "One or more required workflow stages still need attention." },
};

export const COMPARISON_RUN_STATUSES = {
  Completed: { color: "#15803d", icon: CheckCircle2, description: "All expected model slots completed." },
  "Completed with Errors": { color: "#b45309", icon: AlertTriangle, description: "The run completed, but one or more model slots failed or were unavailable." },
  Running: { color: "#2f3f96", icon: Loader2, description: "The model comparison is currently running." },
  Failed: { color: "#b91c1c", icon: XCircle, description: "The model comparison did not complete." },
};

export const COMPARISON_SLOT_STATUSES = {
  completed: { label: "Completed", color: "#15803d", icon: CheckCircle2, description: "This model slot completed." },
  incomplete: { label: "Incomplete", color: "#b45309", icon: AlertTriangle, description: "This model slot failed, was unavailable, or is incomplete." },
};

export const GOLD_STANDARD_STATUSES = {
  Approved: { color: "#15803d", icon: CheckCircle2, description: "The Gold Standard was approved against its supporting evidence." },
  Draft: { color: "#64748b", icon: Circle, description: "The Gold Standard is still under review." },
  "Insufficient Verified Evidence": { color: "#b45309", icon: HelpCircle, description: "There is not enough verified evidence to establish an authoritative answer." },
  "Approved — Reverification Required": { color: "#b45309", icon: AlertTriangle, description: "The approved Gold Standard relies on stale evidence and must be reverified." },
};

export const RETEST_LIFECYCLE_STATUSES = {
  Pending: { color: "#64748b", icon: Clock3, description: "The retest is waiting to begin." },
  "In Progress": { color: "#2f3f96", icon: Loader2, description: "The retest is in progress." },
  Completed: { color: "#15803d", icon: CheckCircle2, description: "The retest has been completed." },
};

function channel(value) {
  const normalized = value.replace("#", "");
  return [0, 2, 4].map((offset) => parseInt(normalized.slice(offset, offset + 2), 16) / 255);
}

export function relativeLuminance(color) {
  const [r, g, b] = channel(color).map((value) => value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

export function contrastRatio(first, second) {
  const [lighter, darker] = [relativeLuminance(first), relativeLuminance(second)].sort((a, b) => b - a);
  return (lighter + 0.05) / (darker + 0.05);
}

export function readableTextColor(background) {
  return contrastRatio(background, "#ffffff") >= 4.5 ? "#ffffff" : "#111827";
}

export function statusDefinition(value, definitions = RESULT_STATUSES) {
  const definition = definitions[value];
  if (definition) return { label: value, ...definition };
  return { label: value || "Unknown", color: "#64748b", icon: HelpCircle, description: "No status definition is available." };
}

export function StatusBadge({ value, definitions = RESULT_STATUSES, compact = false, testId }) {
  const definition = statusDefinition(value, definitions);
  const Icon = definition.icon;
  return (
    <span
      data-testid={testId}
      className={`inline-flex items-center gap-1 rounded-full font-semibold text-white whitespace-nowrap ${compact ? "px-1.5 py-0.5 text-[10px]" : "px-2 py-0.5 text-xs"}`}
      style={{ background: definition.color, color: readableTextColor(definition.color) }}
      title={`${definition.label}: ${definition.description}`}
      aria-label={`${definition.label}. ${definition.description}`}
    >
      <Icon size={compact ? 10 : 12} aria-hidden="true" />
      {definition.label}
    </span>
  );
}

export function StatusLegend({ values, definitions = RESULT_STATUSES, label = "Status legend" }) {
  return (
    <div className="flex flex-wrap items-center gap-2 text-xs" role="list" aria-label={label}>
      {values.map((value) => <span role="listitem" key={value}><StatusBadge value={value} definitions={definitions} compact /></span>)}
    </div>
  );
}