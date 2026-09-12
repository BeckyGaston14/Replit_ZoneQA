// The product uses five canonical severity labels everywhere a severity is
// displayed.  Findings retain their numeric criticality for filtering and
// scoring, but all user-facing labels go through this mapping.
export const SEVERITY_LABELS = ["Very Low", "Low", "Medium", "High", "Critical"];

export const SEVERITY_BY_NUMBER = Object.freeze({
  1: "Very Low",
  2: "Low",
  3: "Medium",
  4: "High",
  5: "Critical",
});

const LEGACY_LABELS = {
  informational: "Very Low",
  info: "Very Low",
  "very low": "Very Low",
  minor: "Low",
  low: "Low",
  moderate: "Medium",
  medium: "Medium",
  high: "High",
  critical: "Critical",
  "critical fail": "Critical",
};

export function severityLabel(value) {
  if (value === null || value === undefined || value === "") return null;
  const text = String(value).trim();
  // Keep numeric normalization aligned with the API: only an integer 1–5
  // (not coercible values such as true or "4.0") is a criticality.
  if ((typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= 5)
    || /^[1-5]$/.test(text)) {
    return SEVERITY_BY_NUMBER[Number(text)];
  }
  const normalized = text.toLowerCase().replace(/-/g, " ").replace(/\s+/g, " ");
  return LEGACY_LABELS[normalized] || String(value);
}

export function severityNumber(value) {
  const label = severityLabel(value);
  const index = SEVERITY_LABELS.indexOf(label);
  return index < 0 ? null : index + 1;
}

// Backend finding filters intentionally prefer an explicitly stored severity
// over legacy numeric criticality when both disagree. Keep that precedence in
// one helper so reports and exports cannot drift from API behavior.
export function findingSeverityLabel(finding = {}) {
  const hasSeverity = finding.severity !== null && finding.severity !== undefined && finding.severity !== "";
  return severityLabel(hasSeverity ? finding.severity : finding.criticality);
}

export function isHighOrCriticalSeverity(finding = {}) {
  const label = findingSeverityLabel(finding);
  return label === "High" || label === "Critical";
}
