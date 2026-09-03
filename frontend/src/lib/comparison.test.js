import { calculateComparisonScore, evaluationIsComplete } from "./comparison";

describe("comparison completeness", () => {
  const evaluation = {
    overall_score: 8,
    final_result: "Pass",
    scores: { accuracy: 8 },
  };

  test("accepts a scored terminal evaluation", () => {
    expect(evaluationIsComplete(evaluation)).toBe(true);
  });

  test("rejects Not Evaluated even when score fields are populated", () => {
    expect(evaluationIsComplete({ ...evaluation, final_result: "Not Evaluated" })).toBe(false);
  });
});

describe("comparison score reconciliation", () => {
  const dimensions = [
    { key: "accuracy", label: "Accuracy", weight: 1 },
    { key: "citation_accuracy", label: "Citation Quality", weight: 1 },
    { key: "interpretation", label: "Interpretation", weight: 1 },
    { key: "completeness", label: "Completeness", weight: 1 },
    { key: "usefulness", label: "Usefulness", weight: 1 },
  ];

  test("matches the screenshot's unweighted headline scores", () => {
    expect(calculateComparisonScore({ scores: { accuracy: 9, citation_accuracy: 9, interpretation: 9, completeness: 9, usefulness: 9 } }, dimensions).score).toBe(9);
    expect(calculateComparisonScore({ scores: { accuracy: 5, citation_accuracy: 5, interpretation: 5, completeness: 4, usefulness: 5 } }, dimensions).score).toBe(4.8);
    expect(calculateComparisonScore({ scores: { accuracy: 6, citation_accuracy: 5, interpretation: 6, completeness: 5, usefulness: 6 } }, dimensions).score).toBe(5.6);
  });

  test("uses active weights and excludes unavailable dimensions", () => {
    expect(calculateComparisonScore({ scores: { accuracy: 9, citation_accuracy: 5 } }, [
      { key: "accuracy", label: "Accuracy", weight: 3 },
      { key: "citation_accuracy", label: "Citation Quality", weight: 1 },
    ])).toEqual(expect.objectContaining({ score: 8, scoreLabel: "Weighted score", weightsActive: true }));
    expect(calculateComparisonScore({ scores: { accuracy: 9, citation_accuracy: null } }, dimensions)).toEqual(expect.objectContaining({
      score: 9,
      scoreLabel: "Average score",
      scoredDimensions: [expect.objectContaining({ key: "accuracy", value: 9 })],
    }));
  });
});