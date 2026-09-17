import { LEGACY_RUBRIC_REVISION } from "./rubricCatalog";

export const CURRENT_RUBRIC_REVISION = "2026-09-16";
export const CURRENT_RUBRIC_CATEGORIES = Object.freeze([
  { key: "property_zoning_rules", label: "Property & Zoning Rules", rubricIds: Object.freeze(["G-01", "G-02", "G-03", "G-04", "G-05", "G-06", "G-07", "G-08"]) },
  { key: "sources_citations", label: "Sources & Citations", rubricIds: Object.freeze(["G-09", "G-10"]) },
  { key: "reasoning_conversation", label: "Reasoning & Conversation", rubricIds: Object.freeze(["G-11", "G-12", "G-13", "G-14", "G-15", "G-16", "G-17", "G-18", "G-19", "G-20"]) },
  { key: "analysis_next_steps", label: "Analysis & Next Steps", rubricIds: Object.freeze(["G-21", "G-22", "G-23", "G-24", "G-25"]) },
  { key: "documents_municipal_records", label: "Documents & Municipal Records", rubricIds: Object.freeze(["G-26", "G-27", "G-28", "G-29", "G-30", "G-31"]) },
]);

/** The seven dimension groups are historical legacy12 reporting only. */
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
  if (value === null || value === undefined || value === "" || value === "N/A" || value === "NA" || value === "Missing") return null;
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

function categoryDefinitions(catalog) {
  const categories = catalog?.categories || catalog;
  if (!Array.isArray(categories) || !categories.length) return CURRENT_RUBRIC_CATEGORIES;
  return categories.map((category) => ({
    key: category.key,
    label: category.name || category.label || category.key,
    rubricIds: category.rubric_ids || category.rubricIds || [],
  }));
}

function selectedRubricIds(evaluation, definitions) {
  const selected = Array.isArray(evaluation?.selected_rubric_ids)
    ? evaluation.selected_rubric_ids
    : Array.isArray(evaluation?.selectedRubricIds) ? evaluation.selectedRubricIds : [];
  return new Set(selected);
}

function rubricScoreMap(evaluation) {
  return evaluation?.rubric_scores || evaluation?.rubricScores || {};
}

function rubricRow(category, numerator, denominator, scoredValueCount, evaluationCount) {
  return {
    ...category,
    rubric_ids: category.rubricIds,
    dimensions: category.rubricIds,
    score: denominator ? Math.round((numerator / denominator) * 10) / 10 : null,
    avg_score: denominator ? Math.round((numerator / denominator) * 10) / 10 : null,
    scoredValueCount,
    scored_value_count: scoredValueCount,
    evaluationCount,
    evaluation_count: evaluationCount,
    count: scoredValueCount,
    numerator,
    denominator,
  };
}

export function calculateRubricCategories(evaluation, catalog) {
  const definitions = categoryDefinitions(catalog);
  const selected = selectedRubricIds(evaluation, definitions);
  const scores = rubricScoreMap(evaluation);
  return definitions.map((category) => {
    let numerator = 0;
    let denominator = 0;
    let scoredValueCount = 0;
    category.rubricIds.forEach((rubricId) => {
      if (!selected.has(rubricId)) return;
      const value = numericScore(scores[rubricId]);
      if (value === null) return;
      numerator += value;
      denominator += 1;
      scoredValueCount += 1;
    });
    return rubricRow(category, numerator, denominator, scoredValueCount, 1);
  });
}

export function aggregateRubricCategories(evaluations, catalog) {
  const definitions = categoryDefinitions(catalog);
  const rows = definitions.map((category) => ({ category, numerator: 0, denominator: 0, scoredValueCount: 0 }));
  (evaluations || []).forEach((evaluation) => {
    const selected = selectedRubricIds(evaluation, definitions);
    const scores = rubricScoreMap(evaluation);
    rows.forEach((row) => row.category.rubricIds.forEach((rubricId) => {
      if (!selected.has(rubricId)) return;
      const value = numericScore(scores[rubricId]);
      if (value === null) return;
      row.numerator += value;
      row.denominator += 1;
      row.scoredValueCount += 1;
    }));
  });
  return rows.map(({ category, numerator, denominator, scoredValueCount }) =>
    rubricRow(category, numerator, denominator, scoredValueCount, evaluations?.length || 0));
}

export function currentRubricMetrics(evaluations, catalog) {
  const current = (evaluations || []).filter((evaluation) =>
    (evaluation?.rubric_revision || evaluation?.rubricRevision) === CURRENT_RUBRIC_REVISION
  );
  const categories = aggregateRubricCategories(current, catalog);
  const scored = categories.reduce((all, category) => all + category.scoredValueCount, 0);
  const values = current.flatMap((evaluation) => {
    const selected = selectedRubricIds(evaluation, categoryDefinitions(catalog));
    return Object.entries(rubricScoreMap(evaluation))
      .filter(([id, value]) => selected.has(id) && numericScore(value) !== null)
      .map(([, value]) => numericScore(value));
  });
  return {
    revision: CURRENT_RUBRIC_REVISION,
    categories,
    score_count: scored,
    overall_score: values.length ? Math.round((values.reduce((sum, value) => sum + value, 0) / values.length) * 10) / 10 : null,
    evaluation_count: current.length,
  };
}

export function isLegacyEvaluation(evaluation) {
  return !evaluation?.rubric_revision || evaluation.rubric_revision === LEGACY_RUBRIC_REVISION;
}