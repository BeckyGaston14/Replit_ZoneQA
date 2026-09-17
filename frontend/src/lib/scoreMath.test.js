import { formatNeutralAverage, neutralAverage, rubricScoreSummary } from "./scoreMath";

test("missing and N/A are excluded while zero remains a score", () => {
  expect(neutralAverage({ a: 0, b: null, c: "", d: "N/A", e: 10 })).toBe(5);
  expect(neutralAverage({ a: null, b: "N/A" })).toBeNull();
});

test("category and overall averages are neutral arithmetic means", () => {
  expect(rubricScoreSummary([
    { rubric_id: "G-01", category: "property" },
    { rubric_id: "G-02", category: "property" },
    { rubric_id: "G-09", category: "sources" },
  ], { "G-01": 0, "G-02": 10, "G-09": 8 })).toEqual({
    overall: 6,
    categories: { property: 5, sources: 8 },
  });
  expect(formatNeutralAverage(null)).toBe("N/A");
});
