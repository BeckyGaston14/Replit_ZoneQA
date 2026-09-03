export const EVALUATION_SCORE_MIN = 0;
export const EVALUATION_SCORE_MAX = 10;
export const EVALUATION_SCORE_DOMAIN = [EVALUATION_SCORE_MIN, EVALUATION_SCORE_MAX];
export const EVALUATION_SCORE_TICKS = [0, 2, 4, 6, 8, 10];
export const EVALUATION_SCALE_LABEL = "Scale: 0–10";

export function evaluationScoreOrNull(value) {
  if (value === null || value === undefined || value === "") return null;
  const score = Number(value);
  if (!Number.isFinite(score) || score < EVALUATION_SCORE_MIN || score > EVALUATION_SCORE_MAX) return null;
  return score;
}

export function evaluationScorePercent(value) {
  const score = evaluationScoreOrNull(value);
  if (score === null) return null;
  return ((score - EVALUATION_SCORE_MIN) / (EVALUATION_SCORE_MAX - EVALUATION_SCORE_MIN)) * 100;
}

export function formatEvaluationScore(value) {
  const score = evaluationScoreOrNull(value);
  return score === null ? "Unavailable" : score.toFixed(1);
}