import { SCORE_RUBRIC, hasScoredDimension, scoreRubricReason } from "./scoreRubric";

test("defines one behavioral reason for every integer score", () => {
  expect(SCORE_RUBRIC.map(([score]) => score)).toEqual([10, 9, 8, 7, 6, 5, 4, 3, 2, 1, 0]);
  expect(SCORE_RUBRIC.every(([, reason]) => reason.length > 20)).toBe(true);
});

test("describes selected scores and distinguishes missing evidence", () => {
  expect(scoreRubricReason(8)).toContain("Substantively correct");
  expect(scoreRubricReason(null)).toContain("Not scored");
  expect(hasScoredDimension({ accuracy: null, usefulness: "" })).toBe(false);
  expect(hasScoredDimension({ accuracy: 0 })).toBe(true);
});

