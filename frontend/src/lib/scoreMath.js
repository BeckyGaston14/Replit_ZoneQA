export function numericScores(scores = {}, ids = null) {
  const allowed = ids ? new Set(ids) : null;
  return Object.entries(scores || {})
    .filter(([id, value]) => (!allowed || allowed.has(id))
      && value !== null && value !== "" && value !== "N/A" && Number.isFinite(Number(value)))
    .map(([id, value]) => ({ id, value: Number(value) }));
}

export function neutralAverage(scores = {}, ids = null) {
  const values = numericScores(scores, ids).map(({ value }) => value);
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
}

export function rubricScoreSummary(items = [], scores = {}) {
  const categoryValues = {};
  for (const item of items || []) {
    const value = numericScores(scores, [item.rubric_id])[0]?.value;
    if (value === undefined) continue;
    const category = item.category || "uncategorized";
    (categoryValues[category] ||= []).push(value);
  }
  return {
    overall: neutralAverage(scores, items.map((item) => item.rubric_id)),
    categories: Object.fromEntries(Object.entries(categoryValues).map(([category, values]) => [
      category, values.reduce((sum, value) => sum + value, 0) / values.length,
    ])),
  };
}

export function formatNeutralAverage(value) {
  return value === null || value === undefined ? "N/A" : Number(value).toFixed(1);
}
