import { api } from "./api";

export async function loadBassettTestRunForEdit(issue, apiClient = api) {
  const { data } = await apiClient.get(`/bassett/issues/${issue.id}`);
  return data;
}

export async function loadBassettScenarioForEdit(scenario, apiClient = api) {
  const { data } = await apiClient.get(`/bassett/scenarios/${scenario.id}`);
  return data;
}