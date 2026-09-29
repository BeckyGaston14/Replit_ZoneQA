import { loadBassettTestRunForEdit } from "./bassettEditLoaders";

test("current revision hydration opens G rubric scores in editable state", async () => {
  const apiClient = { get: jest.fn().mockResolvedValue({
    data: {
      id: "run-1", scenario_id: "scenario-1", rubric_revision: "2026-09-29",
      conversation_source: "uploaded_conversation",
      rubric_scores: { "G-01": 8 }, evaluation_scores: { accuracy: 2 },
      evaluations: { Bassett: { scores: { accuracy: 2 } } },
    },
  }) };
  const result = await loadBassettTestRunForEdit({ id: "run-1" }, apiClient);
  expect(result.evaluation_scores).toEqual({ "G-01": 8 });
  expect(result.evaluations.Bassett.scores).toEqual({ "G-01": 8 });
  expect(result.rubric_selection_initialized).toBe(true);
  expect(result.rubric_scenario_ids).toEqual(["scenario-1"]);
  expect(result._original_conversation_source).toBe("uploaded_conversation");
});

test("legacy12 hydration leaves legacy evaluation scores untouched", async () => {
  const apiClient = { get: jest.fn().mockResolvedValue({
    data: { id: "run-legacy", rubric_revision: "legacy12", rubric_scores: { "G-01": 8 }, evaluation_scores: { accuracy: 2 } },
  }) };
  const result = await loadBassettTestRunForEdit({ id: "run-legacy" }, apiClient);
  expect(result.evaluation_scores).toEqual({ accuracy: 2 });
});
