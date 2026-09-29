export const SCORE_RUBRIC = Object.freeze([
  [10, "Use as delivered — fully correct, complete, and supported; no substantive changes are needed."],
  [9, "Presentation edits only — correct and fully usable; only wording, formatting, or presentation improvements are needed."],
  [8, "One minor correction — correct overall and usable; one minor omission or weakness should be corrected, but it does not affect the conclusion."],
  [7, "Limited corrections — the main conclusion is correct, but multiple minor issues or one limited substantive issue reduces confidence or usefulness."],
  [6, "Important correction required — partially correct and useful, but one important omission, unsupported statement, or reasoning problem must be resolved before use."],
  [5, "Substantial revision required — correct and incorrect or unsupported content are both significant; substantial review and revision are required."],
  [4, "Conclusion unreliable — some relevant information is present, but the conclusion or practical guidance cannot be relied upon."],
  [3, "Major errors — serious factual, legal, analytical, or completeness problems leave only a small amount of usable content."],
  [2, "Near-complete replacement — fundamentally incorrect, with minimal relevant understanding; nearly all of the answer must be replaced."],
  [1, "No meaningful answer — almost entirely incorrect, irrelevant, or nonresponsive, although it makes some attempt to address the question."],
  [0, "Complete failure — no usable response, fabricated content, an unjustified refusal, or no meaningful attempt to answer."],
]);

export function scoreRubricReason(value) {
  if (value === null || value === undefined || value === "" || value === "N/A" || !Number.isFinite(Number(value))) return "Not scored — missing evidence and Not Applicable (N/A) dimensions are excluded from the score, never treated as zero.";
  const score = Math.max(0, Math.min(10, Math.round(Number(value))));
  return SCORE_RUBRIC.find(([number]) => number === score)?.[1] || "";
}

export function hasScoredDimension(scores) {
  return Object.values(scores || {}).some((value) => value !== null && value !== "" && Number.isFinite(Number(value)));
}

