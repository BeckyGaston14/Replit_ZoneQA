import { api } from "./api";
import { LEGACY_RUBRIC_REVISION } from "./rubricCatalog";

export async function loadBassettTestRunForEdit(issue, apiClient = api) {
  const { data } = await apiClient.get(`/bassett/issues/${issue.id}`);
  if (data?.rubric_revision && data.rubric_revision !== LEGACY_RUBRIC_REVISION && data.rubric_scores) {
    return {
      ...data,
      evaluation_scores: { ...data.rubric_scores },
      ...(data.evaluations?.Bassett ? {
        evaluations: {
          ...data.evaluations,
          Bassett: { ...data.evaluations.Bassett, scores: { ...data.rubric_scores } },
        },
      } : {}),
    };
  }
  return data;
}

export async function loadBassettScenarioForEdit(scenario, apiClient = api) {
  const { data } = await apiClient.get(`/bassett/scenarios/${scenario.id}`);
  return data;
}