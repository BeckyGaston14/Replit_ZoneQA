export const FALLBACK_COMPARISON_DIMENSIONS = [
  { key: "accuracy", label: "Accuracy" },
  { key: "citation_accuracy", label: "Citation Quality" },
  { key: "interpretation", label: "Interpretation" },
  { key: "completeness", label: "Completeness" },
  { key: "usefulness", label: "Usefulness" },
];

export function comparisonDimensions(configuredDimensions) {
  if (!Array.isArray(configuredDimensions) || configuredDimensions.length === 0) {
    return FALLBACK_COMPARISON_DIMENSIONS;
  }
  return configuredDimensions
    .filter((dimension) => dimension && dimension.key)
    .map((dimension) => ({
      key: dimension.key,
      label: dimension.label || dimension.key,
      weight: dimension.weight,
    }));
}

function numericScore(value) {
  if (value === null || value === undefined || value === "") return null;
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric >= 0 && numeric <= 10 ? numeric : null;
}

export function calculateComparisonScore(evaluation, configuredDimensions) {
  const dimensions = comparisonDimensions(configuredDimensions);
  const entries = dimensions
    .map((dimension) => {
      const value = numericScore(evaluation?.scores?.[dimension.key]);
      const parsedWeight = Number(dimension.weight);
      const weight = Number.isFinite(parsedWeight) && parsedWeight > 0 ? parsedWeight : 1;
      return value === null ? null : { ...dimension, value, weight };
    })
    .filter(Boolean);
  const weightsActive = dimensions.some((dimension) => {
    const weight = Number(dimension.weight);
    return Number.isFinite(weight) && weight > 0 && weight !== 1;
  });
  if (!entries.length) {
    return {
      score: null,
      scoreLabel: weightsActive ? "Weighted score" : "Average score",
      weightExplanation: weightsActive
        ? "Configured weights apply to scored dimensions; missing dimensions are excluded."
        : "Arithmetic mean of scored dimensions; missing dimensions are excluded.",
      scoredDimensions: [],
      dimensions,
      weightsActive,
    };
  }
  const denominator = weightsActive
    ? entries.reduce((sum, entry) => sum + entry.weight, 0)
    : entries.length;
  const numerator = entries.reduce((sum, entry) => sum + entry.value * (weightsActive ? entry.weight : 1), 0);
  const score = Math.round((numerator / denominator) * 10) / 10;
  return {
    score,
    scoreLabel: weightsActive ? "Weighted score" : "Average score",
    weightExplanation: weightsActive
      ? "Configured weights apply to scored dimensions; missing dimensions are excluded."
      : "Arithmetic mean of scored dimensions; missing dimensions are excluded.",
    scoredDimensions: entries,
    dimensions,
    weightsActive,
  };
}

export function evaluationIsComplete(evaluation, configuredDimensions) {
  const score = configuredDimensions
    ? calculateComparisonScore(evaluation, configuredDimensions).score
    : evaluation?.overall_score;
  return !!evaluation
    && Number.isFinite(Number(score))
    && !!evaluation.final_result
    && evaluation.final_result !== "Not Evaluated"
    && !!evaluation.scores
    && typeof evaluation.scores === "object";
}