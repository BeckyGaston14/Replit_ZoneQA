import { serializeComparisonEvaluations } from "../lib/rubricCatalog";

test("comparison serialization carries current rubric metadata and G scores for all models", () => {
  const serialized = serializeComparisonEvaluations({
    rubric_revision: "2026-09-30",
    selected_rubric_ids: ["R-01"],
    evaluation_scores: { "R-01": 7 },
    evaluations: {
      Bassett: { scores: { "R-01": 7 } },
      ChatGPT: { scores: { "R-01": 5 } },
      Claude: { scores: { "R-01": 9 } },
    },
  });
  for (const model of ["Bassett", "ChatGPT", "Claude"]) {
    expect(serialized[model]).toEqual(expect.objectContaining({
      rubric_revision: "2026-09-30",
      selected_rubric_ids: ["R-01"],
      rubric_scores: { "R-01": expect.any(Number) },
    }));
  }
});

test("legacy comparison evaluations are not rewritten", () => {
  const legacy = { Bassett: { scores: { accuracy: 4 } } };
  expect(serializeComparisonEvaluations({
    rubric_revision: "legacy12", evaluations: legacy,
  })).toBe(legacy);
});
