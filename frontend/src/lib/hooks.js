import { useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "./api";
import { useAuth } from "./auth";
export { useSavedView } from "./savedViews";

const REFERENCE_QUERY_OPTIONS = {
  staleTime: 5 * 60_000,
  gcTime: 30 * 60_000,
  refetchOnWindowFocus: false,
  refetchOnMount: false,
};

function useAuthQueryOptions(defaultKey, options = {}) {
  const auth = useAuth() || {};
  const userId = auth.user?.id || null;
  const authReady = auth.loading === false && Boolean(userId);
  const { queryKey = defaultKey, enabled = true, ...queryOptions } = options;
  return {
    ...REFERENCE_QUERY_OPTIONS,
    ...queryOptions,
    queryKey: [...queryKey, userId],
    enabled: authReady && enabled,
  };
}

export function useCollection(name, opts = {}) {
  return useQuery({
    queryFn: async () => (await api.get(`/${name}`)).data,
    ...useAuthQueryOptions([name], opts),
  });
}

export function useConfig(opts = {}) {
  return useQuery({
    queryFn: async () => (await api.get("/config")).data,
    ...useAuthQueryOptions(["config"], opts),
  });
}

export function useSampleVisibility() {
  const auth = useAuth() || {};
  const userId = auth.user?.id || null;
  const qc = useQueryClient();
  const [optimisticValue, setOptimisticValue] = useState(null);
  const [isSaving, setIsSaving] = useState(false);
  const query = useQuery({
    queryFn: async () => (await api.get("/preferences/sample-visibility")).data,
    ...useAuthQueryOptions(["sample-visibility"]),
  });
  useEffect(() => setOptimisticValue(null), [userId]);
  const setIncludeSampleRecords = async (includeSampleRecords) => {
    const nextValue = Boolean(includeSampleRecords);
    setOptimisticValue(nextValue);
    setIsSaving(true);
    try {
      const { data } = await api.put("/preferences/sample-visibility", {
        include_sample_records: nextValue,
      });
      setOptimisticValue(data.include_sample_records === true);
      qc?.setQueryData(["sample-visibility", userId], data);
      qc?.invalidateQueries();
    } catch (error) {
      setOptimisticValue(null);
      throw error;
    } finally {
      setIsSaving(false);
    }
  };
  return {
    ...query,
    includeSampleRecords: optimisticValue ?? query.data?.include_sample_records === true,
    setIncludeSampleRecords,
    isSaving,
  };
}

export function useTestCases({ includeArchived = false, ...opts } = {}) {
  return useQuery({
    queryFn: async () => (await api.get(`/list/testcases-enriched?include_archived=${includeArchived}`)).data,
    ...useAuthQueryOptions(["tc-enriched", includeArchived ? "all" : "active"], opts),
  });
}

export function useTestBank({ includeArchived = false, ...opts } = {}) {
  return useQuery({
    queryFn: async () => (await api.get(`/bassett/test-bank?include_archived=${includeArchived}`)).data,
    ...useAuthQueryOptions(["bassett-scenarios", includeArchived ? "including-archived" : "active"], opts),
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
