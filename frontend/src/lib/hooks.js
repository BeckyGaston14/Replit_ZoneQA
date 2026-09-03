import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "./api";
export { useSavedView } from "./savedViews";

export function useCollection(name, opts = {}) {
  return useQuery({ queryKey: [name], queryFn: async () => (await api.get(`/${name}`)).data, ...opts });
}

export function useConfig() {
  return useQuery({ queryKey: ["config"], queryFn: async () => (await api.get("/config")).data });
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
