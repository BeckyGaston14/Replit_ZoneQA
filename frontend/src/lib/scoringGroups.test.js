import { REPORTING_GROUPS, aggregateReportingGroups, calculateReportingGroups } from "./scoringGroups";

const dimensions = [
  { key: "accuracy", label: "Accuracy", weight: 3 },
  { key: "current_code", label: "Current Code", weight: 2 },
  { key: "calculation", label: "Calculation", weight: 2 },
  { key: "interpretation", label: "Interpretation", weight: 3 },
  { key: "context", label: "Context", weight: 2 },
  { key: "missing_info", label: "Missing Info", weight: 2 },
  { key: "followup", label: "Follow-Up", weight: 1 },
  { key: "citation_accuracy", label: "Citation", weight: 2 },
  { key: "source_quality", label: "Source Quality", weight: 1 },
  { key: "guidance", label: "Guidance", weight: 1 },
  { key: "completeness", label: "Completeness", weight: 2 },
  { key: "usefulness", label: "Usefulness", weight: 3 },
];

test("defines exactly seven reporting groups covering all twelve stored dimensions", () => {
  expect(REPORTING_GROUPS).toHaveLength(7);
  expect(REPORTING_GROUPS.flatMap((group) => group.dimensions).sort()).toEqual(
    dimensions.map((dimension) => dimension.key).sort(),
  );
});

test("uses configured weights and excludes missing or N/A values", () => {
  const groups = calculateReportingGroups({
    scores: { accuracy: 10, current_code: 0, calculation: null, interpretation: "N/A" },
  }, dimensions);
  expect(groups.find((group) => group.key === "answer_accuracy").score).toBe(6);
  expect(groups.find((group) => group.key === "regulatory_analysis").score).toBeNull();
});

test("aggregates values and weights directly rather than averaging averages", () => {
  const groups = aggregateReportingGroups([
    { scores: { accuracy: 10, current_code: 0 } },
    { scores: { accuracy: 0 } },
  ], dimensions);
  const accuracy = groups.find((group) => group.key === "answer_accuracy");
  expect(accuracy.score).toBe(3.8);
  expect(accuracy.scoredValueCount).toBe(3);
});