export const REPORTING_GROUPS = Object.freeze([
  {
    key: "answer_accuracy",
    label: "Answer Accuracy",
    dimensions: ["accuracy", "current_code", "calculation"],
  },
  {
    key: "regulatory_analysis",
    label: "Regulatory Analysis",
    dimensions: ["interpretation"],
  },
  {
    key: "context_limitations",
    label: "Context & Limitations",
    dimensions: ["context", "missing_info"],
  },
  {
    key: "conversation_handling",
    label: "Conversation Handling",
    dimensions: ["followup"],
  },
  {
    key: "evidence_quality",
    label: "Evidence Quality",
    dimensions: ["citation_accuracy", "source_quality"],
  },
  {
    key: "completeness",
    label: "Completeness",
    dimensions: ["completeness"],
  },
  {
    key: "professional_usefulness",
    label: "Professional Usefulness",
    dimensions: ["guidance", "usefulness"],
  },
]);

function numericScore(value) {
  if (value === null || value === undefined || value === "" || value === "N/A") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 && parsed <= 10 ? parsed : null;
}

export function calculateReportingGroups(evaluation, configuredDimensions = []) {
  const dimensions = new Map((configuredDimensions || []).map((dimension) => [
    dimension?.key,
    {
      ...dimension,
      weight: Number.isFinite(Number(dimension?.weight)) && Number(dimension.weight) > 0
        ? Number(dimension.weight)
        : 1,
    },
  ]));
  const scores = evaluation?.scores || {};
  return REPORTING_GROUPS.map((group) => {
    const appliedDimensions = group.dimensions.map((key) => {
      const dimension = dimensions.get(key) || { key, label: key, weight: 1 };
      const value = numericScore(scores[key]);
      return { ...dimension, value };
    }).filter((dimension) => dimension.value !== null);
    const denominator = appliedDimensions.reduce((sum, dimension) => sum + dimension.weight, 0);
    const numerator = appliedDimensions.reduce((sum, dimension) => sum + dimension.value * dimension.weight, 0);
    return {
      ...group,
      score: denominator ? Math.round((numerator / denominator) * 10) / 10 : null,
      scoredDimensions: appliedDimensions,
      underlyingDimensions: group.dimensions.map((key) => {
        const dimension = dimensions.get(key) || { key, label: key, weight: 1 };
        return { key, label: dimension.label || key, weight: dimension.weight };
      }),
    };
  });
}

export function aggregateReportingGroups(evaluations, configuredDimensions = []) {
  return REPORTING_GROUPS.map((group) => {
    const dimensions = new Map((configuredDimensions || []).map((dimension) => [
      dimension?.key,
      Number.isFinite(Number(dimension?.weight)) && Number(dimension.weight) > 0
        ? Number(dimension.weight)
        : 1,
    ]));
    let numerator = 0;
    let denominator = 0;
    let scoredValueCount = 0;
    (evaluations || []).forEach((evaluation) => {
      group.dimensions.forEach((key) => {
        const value = numericScore(evaluation?.scores?.[key]);
        if (value === null) return;
        const weight = dimensions.get(key) || 1;
        numerator += value * weight;
        denominator += weight;
        scoredValueCount += 1;
      });
    });
    return {
      ...group,
      score: denominator ? Math.round((numerator / denominator) * 10) / 10 : null,
      scoredValueCount,
      evaluationCount: evaluations?.length || 0,
      underlyingDimensions: group.dimensions.map((key) => {
        const dimension = (configuredDimensions || []).find((item) => item?.key === key);
        return { key, label: dimension?.label || key, weight: dimensions.get(key) || 1 };
      }),
    };
  });
}