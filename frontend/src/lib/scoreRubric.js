export const SCORE_RUBRIC = Object.freeze([
  [10, "Fully correct, complete, supported, and professionally usable; no meaningful change needed."],
  [9, "Correct and usable; only negligible wording or presentation improvement is possible."],
  [8, "Substantively correct; one minor omission or weakness does not affect the conclusion."],
  [7, "Mostly correct; limited omissions or imprecision reduce usefulness without changing the main conclusion."],
  [6, "Partially correct; a material omission or reasoning weakness requires review before use."],
  [5, "Mixed result; important portions are correct, but important portions are unsupported, incomplete, or incorrect."],
  [4, "Mostly incorrect or incomplete; some relevant reasoning exists, but the conclusion is unreliable."],
  [3, "Major errors; only limited usable content remains."],
  [2, "Fundamentally incorrect, with minimal relevant or supported analysis."],
  [1, "Almost entirely incorrect or nonresponsive."],
  [0, "No usable answer, unjustified refusal, fabrication, or complete failure to address the question."],
]);

export function scoreRubricReason(value) {
  if (value === null || value === undefined || value === "" || !Number.isFinite(Number(value))) return "Not scored — use blank when evidence is insufficient or the dimension does not apply.";
  const score = Math.max(0, Math.min(10, Math.round(Number(value))));
  return SCORE_RUBRIC.find(([number]) => number === score)?.[1] || "";
}

export function hasScoredDimension(scores) {
  return Object.values(scores || {}).some((value) => value !== null && value !== "" && Number.isFinite(Number(value)));
}

