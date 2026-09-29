import { api } from "./api";
import { LEGACY_RUBRIC_REVISION } from "./rubricCatalog";

export async function loadBassettTestRunForEdit(issue, apiClient = api) {
  const { data } = await apiClient.get(`/bassett/issues/${issue.id}`);
  const editMetadata = {
    _original_conversation_source: data?.conversation_source || "structured_text",
    _original_required_values: {
      question_asked: Boolean(String(data?.question_asked || "").trim()),
      exact_bassett_answer: Boolean(String(data?.exact_bassett_answer || "").trim()),
      verified_correct_answer: Boolean(String(data?.verified_correct_answer || "").trim()),
    },
  };
  if (data?.rubric_revision && data.rubric_revision !== LEGACY_RUBRIC_REVISION && data.rubric_scores) {
    return {
      ...data,
      ...editMetadata,
      // A persisted current-rubric run is already initialized. Without these
      // markers the entry form treats it like a new run, re-applies only the
      // scenario defaults, and can silently drop additional saved rubric
      // selections before the user edits a single score.
      rubric_selection_initialized: true,
      rubric_scenario_ids: Array.isArray(data.rubric_scenario_ids)
        ? [...data.rubric_scenario_ids]
        : [data.scenario_id, ...(data.scenario_ids || [])].filter(Boolean),
      evaluation_scores: { ...data.rubric_scores },
      ...(data.evaluations?.Bassett ? {
        evaluations: {
          ...data.evaluations,
          Bassett: { ...data.evaluations.Bassett, scores: { ...data.rubric_scores } },
        },
      } : {}),
    };
  }
  return { ...data, ...editMetadata };
}

export async function loadBassettScenarioForEdit(scenario, apiClient = api) {
  const { data } = await apiClient.get(`/bassett/scenarios/${scenario.id}`);
  return data;
}
