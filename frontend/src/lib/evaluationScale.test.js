import {
  EVALUATION_SCORE_DOMAIN,
  EVALUATION_SCORE_TICKS,
  evaluationScoreOrNull,
  evaluationScorePercent,
  formatEvaluationScore,
} from "./evaluationScale";

test.each([
  [0, 0],
  [5, 50],
  [7.9, 79],
  [10, 100],
])("maps %s on the fixed 0–10 scale to %s%%", (score, percent) => {
  expect(evaluationScorePercent(score)).toBe(percent);
});

test("publishes a fixed domain and useful reference ticks", () => {
  expect(EVALUATION_SCORE_DOMAIN).toEqual([0, 10]);
  expect(EVALUATION_SCORE_TICKS).toEqual([0, 2, 4, 6, 8, 10]);
});

test.each([null, undefined, "", "not-a-score", NaN, -1, 11])(
  "keeps missing or invalid value %p unavailable",
  (value) => {
    expect(evaluationScoreOrNull(value)).toBeNull();
    expect(evaluationScorePercent(value)).toBeNull();
    expect(formatEvaluationScore(value)).toBe("Unavailable");
  },
);