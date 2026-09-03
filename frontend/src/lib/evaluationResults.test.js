import {
  CANONICAL_EVALUATION_RESULTS,
  evaluationResultDetails,
  evaluationResultColor,
  normalizeEvaluationResult,
} from "./evaluationResults";

test("keeps one canonical evaluation vocabulary", () => {
  expect(CANONICAL_EVALUATION_RESULTS).toEqual([
    "Pass",
    "Pass with Minor Issues",
    "Needs Improvement",
    "Fail",
    "Critical Fail",
    "Not Evaluated",
  ]);
});

test.each([
  ["Pass with Notes", "Pass with Minor Issues"],
  ["Partial", "Needs Improvement"],
  ["Blocked", "Not Evaluated"],
  ["Not Enough Evidence", "Not Evaluated"],
])("normalizes %s to %s", (raw, canonical) => {
  expect(normalizeEvaluationResult(raw)).toBe(canonical);
});

test("marks blocked as workflow state and uses canonical colors", () => {
  expect(evaluationResultDetails("Blocked")).toMatchObject({
    result: "Not Evaluated",
    isWorkflowState: true,
  });
  expect(evaluationResultColor("Pass with Notes")).toBe("#f59e0b");
});