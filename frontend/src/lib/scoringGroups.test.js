import {
  CURRENT_RUBRIC_CATEGORIES,
  REPORTING_GROUPS,
  aggregateReportingGroups,
  aggregateRubricCategories,
  calculateReportingGroups,
  calculateRubricCategories,
} from "./scoringGroups";

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

test("calculates all five current categories from selected rubric scores with neutral denominators", () => {
  const scores = {
    "G-01": 0, "G-09": 10, "G-11": 8, "G-21": "N/A", "G-26": 6,
    "G-02": "", "G-10": 4, "G-12": 2, "G-22": 10, "G-27": "Missing",
  };
  const categories = calculateRubricCategories({
    rubric_revision: "2026-09-16",
    selected_rubric_ids: ["G-01", "G-09", "G-10", "G-11", "G-12", "G-21", "G-22", "G-26", "G-27"],
    rubric_scores: scores,
  });
  expect(categories).toHaveLength(5);
  expect(categories.map((category) => category.label)).toEqual(CURRENT_RUBRIC_CATEGORIES.map((category) => category.label));
  expect(categories.map((category) => category.score)).toEqual([0, 7, 5, 10, 6]);
  expect(categories.map((category) => category.scoredValueCount)).toEqual([1, 2, 2, 1, 1]);
});

test("aggregates current rubric values without mixing legacy evaluations", () => {
  const current = [
    { rubric_revision: "2026-09-16", selected_rubric_ids: ["G-01", "G-09"], rubric_scores: { "G-01": 0, "G-09": 10 } },
    { rubric_revision: "2026-09-16", selected_rubric_ids: ["G-01", "G-09"], rubric_scores: { "G-01": 10, "G-09": "N/A" } },
  ];
  const rows = aggregateRubricCategories(current);
  expect(rows.find((row) => row.key === "property_zoning_rules").score).toBe(5);
  expect(rows.find((row) => row.key === "sources_citations").score).toBe(10);
  expect(rows.reduce((count, row) => count + row.scoredValueCount, 0)).toBe(3);
});

test("does not score rubric values that are present but explicitly unchecked", () => {
  const rows = calculateRubricCategories({
    rubric_revision: "2026-09-16",
    selected_rubric_ids: [],
    rubric_scores: { "G-01": 10, "G-09": 9 },
  });
  expect(rows.every((row) => row.score === null)).toBe(true);
  expect(rows.every((row) => row.denominator === 0)).toBe(true);
});