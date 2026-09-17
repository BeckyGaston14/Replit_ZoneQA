import {
  LEGACY_RUBRIC_REVISION,
  normalizeRubricCatalog,
  reconcileRubricSelection,
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
