import {
  LEGACY_RUBRIC_REVISION,
  normalizeRubricCatalog,
  reconcileRubricSelection,
  reconcileScenarioRubricSelection,
  rubricScoresFromEvaluations,
  serializeComparisonPayload,
  removeRubricSelection,
  rubricDimensions,
  unassociatedRubricItems,
} from "./rubricCatalog";

const catalog = {
  revision: "2026-09-16",
  categories: [{ key: "property_zoning_rules", name: "Property & Zoning Rules" }],
  rubric_items: [
    { rubric_id: "G-01", evaluation_criterion: "Property", expected_behavior: "Identify it", passing_standard: "Correct" },
    { rubric_id: "G-02", evaluation_criterion: "District", expected_behavior: "Find it", passing_standard: "Correct" },
    { rubric_id: "G-03", evaluation_criterion: "Sources", expected_behavior: "Cite it", passing_standard: "Current" },
  ],
};
const scenarios = [
  { id: "s1", rubric_ids: ["G-01", "G-02"] },
  { id: "s2", rubric_ids: ["G-02", "G-03"] },
];

test("scenario defaults use a deduplicated union and preserve shared scores", () => {
  expect(reconcileRubricSelection({
    scenarios, scenarioIds: ["s1", "s2"], selectedRubricIds: ["G-01"], scores: { "G-02": 0, "G-99": 8 },
  })).toEqual({
    selectedRubricIds: ["G-01", "G-02", "G-03"],
    mappedRubricIds: ["G-01", "G-02", "G-03"],
    scores: { "G-02": 0 },
  });
});

test("criteria expose descriptions while additional criteria remain unassociated", () => {
  expect(rubricDimensions(catalog, ["G-01"])[0]).toEqual(expect.objectContaining({
    key: "G-01", question: "Identify it", description: "Correct",
  }));
  expect(unassociatedRubricItems(catalog, ["G-01"]).map((item) => item.rubric_id)).toEqual(["G-02", "G-03"]);
});

test("scored removal requires confirmation and zero is treated as scored", () => {
  expect(removeRubricSelection(["G-01"], "G-01", { "G-01": 0 }, () => false).confirmed).toBe(false);
  expect(removeRubricSelection(["G-01"], "G-01", { "G-01": 0 }, () => true).selectedIds).toEqual([]);
});

test("legacy revision is explicit", () => {
  expect(normalizeRubricCatalog(null).revision).toBeNull();
  expect(LEGACY_RUBRIC_REVISION).toBe("legacy12");
});

test("initialization is stable, new scenario mappings union, and unchecks survive", () => {
  const initialized = reconcileScenarioRubricSelection({
    scenarios, scenarioIds: ["s1"], selectedRubricIds: [], initialized: false,
  });
  expect(initialized.selectedRubricIds).toEqual(["G-01", "G-02"]);
  const changed = reconcileScenarioRubricSelection({
    scenarios, previousScenarioIds: ["s1"], scenarioIds: ["s1", "s2"],
    selectedRubricIds: ["G-01"], initialized: true,
  });
  expect(changed.selectedRubricIds).toEqual(["G-01", "G-03"]);
  const reloaded = reconcileScenarioRubricSelection({
    scenarios, previousScenarioIds: ["s1", "s2"], scenarioIds: ["s1", "s2"],
    selectedRubricIds: changed.selectedRubricIds, initialized: true,
  });
  expect(reloaded.selectedRubricIds).toEqual(["G-01", "G-03"]);
});

test("scenario removal preserves shared IDs and confirms scored removals", () => {
  const declined = reconcileScenarioRubricSelection({
    scenarios, previousScenarioIds: ["s1", "s2"], scenarioIds: ["s2"],
    selectedRubricIds: ["G-01", "G-02", "G-03"], scores: { "G-01": 0 },
    initialized: true, confirmRemoval: () => false,
  });
  expect(declined.confirmed).toBe(false);
  expect(declined.selectedRubricIds).toEqual(["G-01", "G-02", "G-03"]);
  const accepted = reconcileScenarioRubricSelection({
    scenarios, previousScenarioIds: ["s1", "s2"], scenarioIds: ["s2"],
    selectedRubricIds: ["G-01", "G-02", "G-03"], scores: { "G-01": 0 },
    initialized: true, confirmRemoval: () => true,
  });
  expect(accepted.selectedRubricIds).toEqual(["G-02", "G-03"]);
  expect(accepted.scores).toEqual({});
  expect(accepted.confirm_rubric_removal).toBe(true);
});

test("removal scoring aggregates each comparison model and counts zero", () => {
  expect(rubricScoresFromEvaluations({
    Bassett: { scores: {} },
    ChatGPT: { scores: { "G-02": 4 } },
    Claude: { scores: { "G-03": 0 } },
  })).toEqual({ "G-02": 4, "G-03": 0 });
});

test.each([
  ["ChatGPT", "G-02", 4],
  ["Claude", "G-03", 6],
  ["Claude zero", "G-04", 0],
])("a %s-only score requires removal confirmation", (_label, rubricId, score) => {
  const model = rubricId === "G-02" ? "ChatGPT" : "Claude";
  const scores = rubricScoresFromEvaluations({ [model]: { scores: { [rubricId]: score } } });
  expect(removeRubricSelection([rubricId], rubricId, scores, () => false).confirmed).toBe(false);
  expect(removeRubricSelection([rubricId], rubricId, scores, () => true).confirmed).toBe(true);
});

test("comparison payload includes explicit scored-removal confirmation", () => {
  const payload = serializeComparisonPayload({
    rubric_revision: "2026-09-16", confirm_rubric_removal: true,
    evaluations: { Bassett: { scores: { "G-01": 0 } } },
  });
  expect(payload.confirm_rubric_removal).toBe(true);
  expect(payload.evaluations.Bassett.rubric_scores).toEqual({ "G-01": 0 });
});
