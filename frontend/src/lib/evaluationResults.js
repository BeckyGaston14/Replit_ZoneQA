export const CANONICAL_EVALUATION_RESULTS = [
  "Pass",
  "Pass with Minor Issues",
  "Needs Improvement",
  "Fail",
  "Critical Fail",
  "Not Evaluated",
];

export const LEGACY_EVALUATION_RESULT_ALIASES = {
  "Pass with Notes": "Pass with Minor Issues",
  Partial: "Needs Improvement",
  Incomplete: "Not Evaluated",
  Blocked: "Not Evaluated",
  "Not Enough Evidence": "Not Evaluated",
};

export const EVALUATION_RESULT_COLORS = {
  Pass: "#16a34a",
  "Pass with Minor Issues": "#f59e0b",
  "Needs Improvement": "#f59e0b",
  Fail: "#dc2626",
  "Critical Fail": "#b91c1c",
  "Not Evaluated": "#94a3b8",
};

export function normalizeEvaluationResult(value) {
  const raw = String(value ?? "").trim();
  return LEGACY_EVALUATION_RESULT_ALIASES[raw]
    || (CANONICAL_EVALUATION_RESULTS.includes(raw) ? raw : "Not Evaluated");
}

export function evaluationResultDetails(value) {
  const raw = String(value ?? "").trim() || "Not Evaluated";
  return {
    rawResult: raw,
    result: normalizeEvaluationResult(raw),
    isWorkflowState: raw === "Blocked",
    isLegacy: Object.prototype.hasOwnProperty.call(LEGACY_EVALUATION_RESULT_ALIASES, raw),
  };
}

export function evaluationResultColor(value) {
  return EVALUATION_RESULT_COLORS[normalizeEvaluationResult(value)] || "#64748b";
}

export function isEvaluatedResult(value) {
  return ["Pass", "Pass with Minor Issues", "Needs Improvement", "Fail", "Critical Fail"]
    .includes(normalizeEvaluationResult(value));
}
