import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "./api";
import { useAuth } from "./auth";
export { useSavedView } from "./savedViews";

const REFERENCE_QUERY_OPTIONS = {
  staleTime: 5 * 60_000,
  gcTime: 30 * 60_000,
  refetchOnWindowFocus: false,
  refetchOnMount: false,
};

const LIVE_QUERY_OPTIONS = {
  staleTime: 0,
  gcTime: 5 * 60_000,
  refetchOnWindowFocus: false,
  refetchOnMount: true,
};

const BOUNDED_REFERENCE_COLLECTIONS = new Set(["versions"]);

function invalidateQueryGroup(queryClient, group) {
  queryClient.removeQueries({
    predicate: (cachedQuery) => cachedQuery.queryKey?.[0] === group
      && cachedQuery.getObserversCount() === 0,
  });
  return queryClient.invalidateQueries({
    predicate: (cachedQuery) => cachedQuery.queryKey?.[0] === group,
    refetchType: "active",
  });
}

export function invalidateVersionQueries(queryClient) {
  return invalidateQueryGroup(queryClient, "versions");
}

export function invalidateConfigQueries(queryClient) {
  return invalidateQueryGroup(queryClient, "config");
}

export async function invalidateForSampleVisibility(queryClient) {
  queryClient.removeQueries({
    predicate: (cachedQuery) => cachedQuery.queryKey?.[0] !== "sample-visibility"
      && cachedQuery.getObserversCount() === 0,
  });
  await queryClient.invalidateQueries({
    predicate: (cachedQuery) => cachedQuery.queryKey?.[0] !== "sample-visibility",
    refetchType: "active",
  });
}

function useAuthQueryOptions(defaultKey, options = {}, defaults = LIVE_QUERY_OPTIONS) {
  const auth = useAuth() || {};
  const userId = auth.user?.id || null;
  const authReady = auth.loading === false && Boolean(userId);
  const { queryKey = defaultKey, enabled = true, ...queryOptions } = options;
  return {
    ...defaults,
    ...queryOptions,
    queryKey: [...queryKey, userId],
    enabled: authReady && enabled,
  };
}

export function useCollection(name, opts = {}) {
  return useQuery({
    queryFn: async ({ signal } = {}) => (await api.get(`/${name}`, { signal })).data,
    ...useAuthQueryOptions([name], opts, BOUNDED_REFERENCE_COLLECTIONS.has(name) ? REFERENCE_QUERY_OPTIONS : LIVE_QUERY_OPTIONS),
  });
}

export function useConfig(opts = {}) {
  return useQuery({
    queryFn: async ({ signal } = {}) => (await api.get("/config", { signal })).data,
    ...useAuthQueryOptions(["config"], opts, REFERENCE_QUERY_OPTIONS),
  });
}

export function useSampleVisibility() {
  const auth = useAuth() || {};
  const userId = auth.user?.id || null;
  const qc = useQueryClient();
  const [optimisticValue, setOptimisticValue] = useState(null);
  const [isSaving, setIsSaving] = useState(false);
  const query = useQuery({
    queryFn: async ({ signal } = {}) => (await api.get("/preferences/sample-visibility", { signal })).data,
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
      if (qc) {
        // Inactive page queries are configured not to refetch on mount. Remove
        // them so a previously visited page cannot briefly restore records from
        // the old visibility scope, then refresh everything currently visible.
        await invalidateForSampleVisibility(qc);
      }
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
    queryFn: async ({ signal } = {}) => (await api.get(`/list/testcases-enriched?include_archived=${includeArchived}`, { signal })).data,
    ...useAuthQueryOptions(["tc-enriched", includeArchived ? "all" : "active"], opts),
  });
}

export function useTestBank({ includeArchived = false, ...opts } = {}) {
  return useQuery({
    queryFn: async ({ signal } = {}) => (await api.get(`/bassett/test-bank?include_archived=${includeArchived}`, { signal })).data,
    ...useAuthQueryOptions(["bassett-scenarios", includeArchived ? "including-archived" : "active"], opts),
  });
}

export function useGeneralSubtypes(opts = {}) {
  return useQuery({
    queryFn: async ({ signal } = {}) => (await api.get("/bassett/general-subtypes", { signal })).data,
    ...useAuthQueryOptions(["bassett-general-subtypes"], opts, REFERENCE_QUERY_OPTIONS),
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
