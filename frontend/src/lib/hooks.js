import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "./api";
export { useSavedView } from "./savedViews";

const REFERENCE_QUERY_OPTIONS = {
  staleTime: 5 * 60_000,
  gcTime: 30 * 60_000,
  refetchOnWindowFocus: false,
  refetchOnMount: false,
};

export function useCollection(name, opts = {}) {
  return useQuery({
    queryKey: [name],
    queryFn: async () => (await api.get(`/${name}`)).data,
    ...REFERENCE_QUERY_OPTIONS,
    ...opts,
  });
}

export function useConfig() {
  return useQuery({
    queryKey: ["config"],
    queryFn: async () => (await api.get("/config")).data,
    ...REFERENCE_QUERY_OPTIONS,
  });
}

export function useTestCases({ includeArchived = false, ...opts } = {}) {
  return useQuery({
    queryKey: ["tc-enriched", includeArchived ? "all" : "active"],
    queryFn: async () => (await api.get(`/list/testcases-enriched?include_archived=${includeArchived}`)).data,
    ...opts,
  });
}

export function useTestBank({ includeArchived = false, ...opts } = {}) {
  return useQuery({
    queryKey: ["bassett-scenarios", includeArchived ? "including-archived" : "active"],
    queryFn: async () => (await api.get(`/bassett/test-bank?include_archived=${includeArchived}`)).data,
    ...opts,
  });
}

export function useSave(name) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, ...body }) => id ? (await api.put(`/${name}/${id}`, body)).data : (await api.post(`/${name}`, body)).data,
    onSuccess: () => qc.invalidateQueries(),
  });
}

export function useDelete(name) {
  const qc = useQueryClient();
  return useMutation({ mutationFn: async (id) => (await api.delete(`/${name}/${id}`)).data, onSuccess: () => qc.invalidateQueries() });
}
