export const WORKFLOW_STATUSES = ["Not Started", "In Review", "Engineering", "Ready for Retesting", "Closed / Resolved"];
export const FINDING_WORKFLOW_LABELS = {
  New: "Not Started", Confirmed: "In Review", "Needs Investigation": "In Review",
  Planned: "Engineering", "In Development": "Engineering",
  "Ready for Retest": "Ready for Retesting", Fixed: "Closed / Resolved",
  Closed: "Closed / Resolved", "Won't Fix": "Closed / Resolved", Duplicate: "Closed / Resolved",
};
export const workflowStatusLabel = (value) => FINDING_WORKFLOW_LABELS[value] || value || "Not Started";
