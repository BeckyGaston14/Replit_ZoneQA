import { api } from "./api";
import { LEGACY_RUBRIC_REVISION } from "./rubricCatalog";

export async function loadBassettTestRunForEdit(issue, apiClient = api) {
  const { data } = await apiClient.get(`/bassett/issues/${issue.id}`);
  const editMetadata = {
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
