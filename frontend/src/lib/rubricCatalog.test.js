import {
  LEGACY_RUBRIC_REVISION,
  normalizeRubricCatalog,
  reconcileRubricSelection,
  reconcileScenarioRubricSelection,
  rubricScoresFromEvaluations,
  serializeComparisonPayload,
  removeRubricSelection,
  rubricDimensions,
  rubricCategoryKey,
  rubricCategoryName,
  unassociatedRubricItems,
} from "./rubricCatalog";

const catalog = {
  revision: "2026-10-01",
  categories: [{ key: "property_zoning_rules", name: "Property & Zoning Rules" }],
  rubric_items: [
    { rubric_id: "R-01", evaluation_criterion: "Property", expected_behavior: "Identify it", passing_standard: "Correct" },
    { rubric_id: "R-02", evaluation_criterion: "District", expected_behavior: "Find it", passing_standard: "Correct" },
    { rubric_id: "R-03", evaluation_criterion: "Sources", expected_behavior: "Cite it", passing_standard: "Current" },
  ],
};
const scenarios = [
  { id: "s1", rubric_ids: ["R-01", "R-02"] },
  { id: "s2", rubric_ids: ["R-02", "R-03"] },
];

test("scenario defaults use a deduplicated union and preserve shared scores", () => {
  expect(reconcileRubricSelection({
    scenarios, scenarioIds: ["s1", "s2"], selectedRubricIds: ["R-01"], scores: { "R-02": 0, "G-99": 8 },
  })).toEqual({
    selectedRubricIds: ["R-01", "R-02", "R-03"],
    mappedRubricIds: ["R-01", "R-02", "R-03"],
    scores: { "R-02": 0 },
  });
});

test("criteria expose descriptions while additional criteria remain unassociated", () => {
  expect(rubricDimensions(catalog, ["R-01"])[0]).toEqual(expect.objectContaining({
    key: "R-01", question: "Identify it", description: "Correct",
  }));
  expect(unassociatedRubricItems(catalog, ["R-01"]).map((item) => item.rubric_id)).toEqual(["R-02", "R-03"]);
});

test("scored removal requires confirmation and zero is treated as scored", () => {
  expect(removeRubricSelection(["R-01"], "R-01", { "R-01": 0 }, () => false).confirmed).toBe(false);
  expect(removeRubricSelection(["R-01"], "R-01", { "R-01": 0 }, () => true).selectedIds).toEqual([]);
});

test("legacy revision is explicit", () => {
  expect(normalizeRubricCatalog(null).revision).toBeNull();
  expect(LEGACY_RUBRIC_REVISION).toBe("legacy12");
});

test("rubric category helpers accept stored keys and display names", () => {
  expect(rubricCategoryKey(catalog, "Property & Zoning Rules")).toBe("property_zoning_rules");
  expect(rubricCategoryKey(catalog, "property_zoning_rules")).toBe("property_zoning_rules");
  expect(rubricCategoryName(catalog, "property_zoning_rules")).toBe("Property & Zoning Rules");
  expect(rubricCategoryKey(catalog, "Custom category")).toBe("Custom category");
  expect(rubricCategoryName(catalog, "")).toBe("Not assigned");
});

test("initialization is stable, new scenario mappings union, and unchecks survive", () => {
  const initialized = reconcileScenarioRubricSelection({
    scenarios, scenarioIds: ["s1"], selectedRubricIds: [], initialized: false,
  });
  expect(initialized.selectedRubricIds).toEqual(["R-01", "R-02"]);
  const changed = reconcileScenarioRubricSelection({
    scenarios, previousScenarioIds: ["s1"], scenarioIds: ["s1", "s2"],
    selectedRubricIds: ["R-01"], initialized: true,
  });
  expect(changed.selectedRubricIds).toEqual(["R-01", "R-03"]);
  const reloaded = reconcileScenarioRubricSelection({
    scenarios, previousScenarioIds: ["s1", "s2"], scenarioIds: ["s1", "s2"],
    selectedRubricIds: changed.selectedRubricIds, initialized: true,
  });
  expect(reloaded.selectedRubricIds).toEqual(["R-01", "R-03"]);
});

test("scenario removal preserves shared IDs and confirms scored removals", () => {
  const declined = reconcileScenarioRubricSelection({
    scenarios, previousScenarioIds: ["s1", "s2"], scenarioIds: ["s2"],
    selectedRubricIds: ["R-01", "R-02", "R-03"], scores: { "R-01": 0 },
    initialized: true, confirmRemoval: () => false,
  });
  expect(declined.confirmed).toBe(false);
  expect(declined.selectedRubricIds).toEqual(["R-01", "R-02", "R-03"]);
  const accepted = reconcileScenarioRubricSelection({
    scenarios, previousScenarioIds: ["s1", "s2"], scenarioIds: ["s2"],
    selectedRubricIds: ["R-01", "R-02", "R-03"], scores: { "R-01": 0 },
    initialized: true, confirmRemoval: () => true,
  });
  expect(accepted.selectedRubricIds).toEqual(["R-02", "R-03"]);
  expect(accepted.scores).toEqual({});
  expect(accepted.confirm_rubric_removal).toBe(true);
});

test("removal scoring aggregates each comparison model and counts zero", () => {
  expect(rubricScoresFromEvaluations({
    Bassett: { scores: {} },
    ChatGPT: { scores: { "R-02": 4 } },
    Claude: { scores: { "R-03": 0 } },
  })).toEqual({ "R-02": 4, "R-03": 0 });
});

test.each([
  ["ChatGPT", "R-02", 4],
  ["Claude", "R-03", 6],
  ["Claude zero", "R-04", 0],
])("a %s-only score requires removal confirmation", (_label, rubricId, score) => {
  const model = rubricId === "R-02" ? "ChatGPT" : "Claude";
  const scores = rubricScoresFromEvaluations({ [model]: { scores: { [rubricId]: score } } });
  expect(removeRubricSelection([rubricId], rubricId, scores, () => false).confirmed).toBe(false);
  expect(removeRubricSelection([rubricId], rubricId, scores, () => true).confirmed).toBe(true);
});

test("comparison payload includes explicit scored-removal confirmation", () => {
  const payload = serializeComparisonPayload({
    rubric_revision: "2026-10-01", confirm_rubric_removal: true,
    evaluations: { Bassett: { scores: { "R-01": 0 } } },
  });
  expect(payload.confirm_rubric_removal).toBe(true);
  expect(payload.evaluations.Bassett.rubric_scores).toEqual({ "R-01": 0 });
});
