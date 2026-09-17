export const LEGACY_RUBRIC_REVISION = "legacy12";

export function normalizeRubricCatalog(catalog) {
  if (!catalog || typeof catalog !== "object") return { revision: null, categories: [], rubric_items: [] };
  return {
    revision: catalog.revision || null,
    categories: Array.isArray(catalog.categories) ? catalog.categories : [],
    rubric_items: Array.isArray(catalog.rubric_items) ? catalog.rubric_items : [],
  };
}

export function rubricItemsById(catalog) {
  return Object.fromEntries(normalizeRubricCatalog(catalog).rubric_items.map((item) => [item.rubric_id, item]));
}

export function scenarioRubricIds(scenarios = [], scenarioIds = []) {
  const ids = new Set((scenarioIds || []).filter(Boolean));
  return [...new Set(scenarios
    .filter((scenario) => ids.has(scenario.id))
    .flatMap((scenario) => Array.isArray(scenario.rubric_ids) ? scenario.rubric_ids : []))];
}

export function unionScenarioRubricIds(scenarios = [], scenarioIds = [], existingIds = []) {
  return [...new Set([...(existingIds || []), ...scenarioRubricIds(scenarios, scenarioIds)])];
}

export function reconcileRubricSelection({
  scenarios = [], scenarioIds = [], selectedRubricIds = [], scores = {},
}) {
  const mapped = scenarioRubricIds(scenarios, scenarioIds);
  const selected = [...new Set([...(selectedRubricIds || []), ...mapped])];
  return {
    selectedRubricIds: selected,
    mappedRubricIds: mapped,
    scores: Object.fromEntries(Object.entries(scores || {}).filter(([id]) => selected.includes(id))),
  };
}

export function reconcileScenarioRubricSelection({
  scenarios = [], previousScenarioIds = [], scenarioIds = [], selectedRubricIds = [],
  scores = {}, initialized = false, confirmRemoval = () => true,
}) {
  const previousMapped = scenarioRubricIds(scenarios, previousScenarioIds);
  const mapped = scenarioRubricIds(scenarios, scenarioIds);
  if (!initialized) {
    return {
      selectedRubricIds: mapped,
      mappedRubricIds: mapped,
      previousScenarioIds: scenarioIds,
      scores: Object.fromEntries(Object.entries(scores || {}).filter(([id]) => mapped.includes(id))),
      confirm_rubric_removal: false,
      confirmed: true,
    };
  }
  const newlyMapped = mapped.filter((id) => !previousMapped.includes(id));
  const removed = previousMapped.filter((id) => !mapped.includes(id) && selectedRubricIds.includes(id));
  const scoredRemoved = removed.filter((id) => scores?.[id] !== undefined && scores[id] !== "" && scores[id] !== null && scores[id] !== "N/A");
  if (scoredRemoved.length && !scoredRemoved.every((id) => confirmRemoval(id))) {
    return { selectedRubricIds, mappedRubricIds: mapped, previousScenarioIds: scenarioIds, scores, confirm_rubric_removal: false, confirmed: false };
  }
  const selected = [...new Set([...selectedRubricIds, ...newlyMapped].filter((id) => !removed.includes(id) || !scoredRemoved.includes(id)))];
  return {
    selectedRubricIds: selected,
    mappedRubricIds: mapped,
    previousScenarioIds: scenarioIds,
    scores: Object.fromEntries(Object.entries(scores || {}).filter(([id]) => selected.includes(id))),
    confirm_rubric_removal: Boolean(scoredRemoved.length),
    confirmed: true,
  };
}

export function rubricDimensions(catalog, selectedIds = []) {
  const { rubric_items: items } = normalizeRubricCatalog(catalog);
  const selected = new Set(selectedIds);
  return items
    .filter((item) => selected.has(item.rubric_id))
    .map((item) => ({
      key: item.rubric_id,
      label: `${item.rubric_id} · ${item.evaluation_criterion}`,
      question: item.expected_behavior,
      description: item.passing_standard,
      rubric: item,
    }));
}

export function unassociatedRubricItems(catalog, mappedIds = []) {
  const mapped = new Set(mappedIds);
  return normalizeRubricCatalog(catalog).rubric_items.filter((item) => !mapped.has(item.rubric_id));
}

export function removeRubricSelection(selectedIds = [], rubricId, scores = {}, confirmRemoval = () => true) {
  if (!selectedIds.includes(rubricId)) return { selectedIds, confirmed: true };
  const scored = scores[rubricId] !== undefined && scores[rubricId] !== "" && scores[rubricId] !== null && scores[rubricId] !== "N/A";
  if (scored && !confirmRemoval(rubricId)) return { selectedIds, confirmed: false };
  return { selectedIds: selectedIds.filter((id) => id !== rubricId), confirmed: true };
}
