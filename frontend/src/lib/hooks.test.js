import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { invalidateConfigQueries, invalidateForSampleVisibility, invalidateVersionQueries, useCollection, useConfig, useDelete, useSave, useTestBank, useTestCases } from "./hooks";

jest.mock("@tanstack/react-query", () => ({ useMutation: jest.fn(), useQuery: jest.fn(), useQueryClient: jest.fn() }));
jest.mock("./api", () => ({ api: { get: jest.fn() } }));
let mockAuthState = { loading: true, user: null };
jest.mock("./auth", () => ({ useAuth: () => mockAuthState }));

beforeEach(() => {
  useQuery.mockReset();
  useMutation.mockReset();
  useQueryClient.mockReset();
});

test("reference hooks share stable keys and a bounded user-session cache window", () => {
  mockAuthState = { loading: false, user: { id: "user-a" } };
  useCollection("versions");
  expect(useQuery).toHaveBeenLastCalledWith(expect.objectContaining({
    queryKey: ["versions", "user-a"],
    enabled: true,
    staleTime: 300000,
    gcTime: 1800000,
    refetchOnMount: false,
    refetchOnWindowFocus: false,
  }));

  useConfig();
  expect(useQuery).toHaveBeenLastCalledWith(expect.objectContaining({ queryKey: ["config", "user-a"], staleTime: 300000 }));
});

test("mutable collections and record lists refetch on repeat navigation instead of serving bounded stale data", () => {
  mockAuthState = { loading: false, user: { id: "user-a" } };
  useCollection("projects");
  expect(useQuery).toHaveBeenLastCalledWith(expect.objectContaining({
    queryKey: ["projects", "user-a"],
    staleTime: 0,
    refetchOnMount: true,
  }));
  useTestCases();
  expect(useQuery).toHaveBeenLastCalledWith(expect.objectContaining({ staleTime: 0, refetchOnMount: true }));
  useTestBank();
  expect(useQuery).toHaveBeenLastCalledWith(expect.objectContaining({ staleTime: 0, refetchOnMount: true }));
});

test("enriched records and Test Bank use predictable active/all cache keys", () => {
  mockAuthState = { loading: false, user: { id: "user-a" } };
  useTestCases();
  expect(useQuery).toHaveBeenLastCalledWith(expect.objectContaining({ queryKey: ["tc-enriched", "active", "user-a"], enabled: true }));
  useTestCases({ includeArchived: true });
  expect(useQuery).toHaveBeenLastCalledWith(expect.objectContaining({ queryKey: ["tc-enriched", "all", "user-a"], enabled: true }));
  useTestBank();
  expect(useQuery).toHaveBeenLastCalledWith(expect.objectContaining({ queryKey: ["bassett-scenarios", "active", "user-a"], enabled: true }));
  useTestBank({ includeArchived: true });
  expect(useQuery).toHaveBeenLastCalledWith(expect.objectContaining({ queryKey: ["bassett-scenarios", "including-archived", "user-a"], enabled: true }));
});

test("shared hooks wait for auth initialization, then resolve with the authenticated user", async () => {
  mockAuthState = { loading: true, user: null };
  useCollection("projects");
  expect(useQuery).toHaveBeenLastCalledWith(expect.objectContaining({ enabled: false, queryKey: ["projects", null] }));

  mockAuthState = { loading: false, user: { id: "user-a" } };
  const { api } = require("./api");
  api.get.mockResolvedValueOnce({ data: [{ id: "project-a" }] });
  useCollection("projects");
  const options = useQuery.mock.calls.at(-1)[0];
  expect(options.enabled).toBe(true);
  const signal = new AbortController().signal;
  await expect(options.queryFn({ signal })).resolves.toEqual([{ id: "project-a" }]);
  expect(api.get).toHaveBeenCalledWith("/projects", { signal });
});

test("identical in-flight and repeat lookup requests reuse the same bounded result", async () => {
  const { QueryClient } = jest.requireActual("@tanstack/react-query");
  const { api } = require("./api");
  mockAuthState = { loading: false, user: { id: "user-a" } };
  api.get.mockResolvedValue({ data: [{ name: "v1" }] });
  useCollection("versions");
  const options = useQuery.mock.calls.at(-1)[0];
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });

  const [first, second] = await Promise.all([
    client.fetchQuery(options),
    client.fetchQuery(options),
  ]);
  expect(first).toEqual(second);
  expect(api.get).toHaveBeenCalledTimes(1);
  await client.fetchQuery(options);
  expect(api.get).toHaveBeenCalledTimes(1);
  client.clear();
});

test("identical in-flight live requests deduplicate but completed mutable data is refetched", async () => {
  const { QueryClient } = jest.requireActual("@tanstack/react-query");
  const { api } = require("./api");
  mockAuthState = { loading: false, user: { id: "user-a" } };
  api.get.mockResolvedValue({ data: [{ id: "project-a" }] });
  useCollection("projects");
  const options = useQuery.mock.calls.at(-1)[0];
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });

  await Promise.all([client.fetchQuery(options), client.fetchQuery(options)]);
  expect(api.get).toHaveBeenCalledTimes(1);
  await client.fetchQuery(options);
  expect(api.get).toHaveBeenCalledTimes(2);
  client.clear();
});

test("version writes invalidate both admin and authenticated lookup key shapes", async () => {
  const removeQueries = jest.fn();
  const invalidateQueries = jest.fn().mockResolvedValue(undefined);
  await invalidateVersionQueries({ removeQueries, invalidateQueries });
  const removePredicate = removeQueries.mock.calls[0][0].predicate;
  const invalidateOptions = invalidateQueries.mock.calls[0][0];
  expect(removePredicate({ queryKey: ["versions", "user-a"], getObserversCount: () => 0 })).toBe(true);
  expect(removePredicate({ queryKey: ["versions", "user-a"], getObserversCount: () => 1 })).toBe(false);
  expect(invalidateOptions.predicate({ queryKey: ["versions"] })).toBe(true);
  expect(invalidateOptions.predicate({ queryKey: ["versions", "user-a"] })).toBe(true);
  expect(invalidateOptions.predicate({ queryKey: ["readiness", "v1"] })).toBe(false);
  expect(invalidateOptions.refetchType).toBe("active");
});

test("config writes remove inactive user-scoped lookups and refetch active config queries", async () => {
  const removeQueries = jest.fn();
  const invalidateQueries = jest.fn().mockResolvedValue(undefined);
  await invalidateConfigQueries({ removeQueries, invalidateQueries });
  const removePredicate = removeQueries.mock.calls[0][0].predicate;
  const invalidateOptions = invalidateQueries.mock.calls[0][0];

  expect(removePredicate({ queryKey: ["config", "user-a"], getObserversCount: () => 0 })).toBe(true);
  expect(removePredicate({ queryKey: ["config", "user-a"], getObserversCount: () => 1 })).toBe(false);
  expect(invalidateOptions.predicate({ queryKey: ["config"] })).toBe(true);
  expect(invalidateOptions.predicate({ queryKey: ["config", "user-a"] })).toBe(true);
  expect(invalidateOptions.predicate({ queryKey: ["versions", "user-a"] })).toBe(false);
  expect(invalidateOptions.refetchType).toBe("active");
});

test("sample visibility changes remove inactive stale data and refetch active non-preference queries", async () => {
  const removeQueries = jest.fn();
  const invalidateQueries = jest.fn().mockResolvedValue(undefined);
  await invalidateForSampleVisibility({ removeQueries, invalidateQueries });
  const removePredicate = removeQueries.mock.calls[0][0].predicate;
  const invalidateOptions = invalidateQueries.mock.calls[0][0];

  expect(removePredicate({ queryKey: ["projects", "user-a"], getObserversCount: () => 0 })).toBe(true);
  expect(removePredicate({ queryKey: ["projects", "user-a"], getObserversCount: () => 1 })).toBe(false);
  expect(removePredicate({ queryKey: ["sample-visibility", "user-a"], getObserversCount: () => 0 })).toBe(false);
  expect(invalidateOptions.predicate({ queryKey: ["readiness", "v1", "both"] })).toBe(true);
  expect(invalidateOptions.predicate({ queryKey: ["sample-visibility", "user-a"] })).toBe(false);
  expect(invalidateOptions.refetchType).toBe("active");
});

test("create, edit, archive, and delete mutation hooks invalidate cached lookups and live data", () => {
  const invalidateQueries = jest.fn();
  useQueryClient.mockReturnValue({ invalidateQueries });
  useSave("projects");
  const saveOptions = useMutation.mock.calls.at(-1)[0];
  saveOptions.onSuccess();
  useDelete("projects");
  const deleteOptions = useMutation.mock.calls.at(-1)[0];
  deleteOptions.onSuccess();
  expect(invalidateQueries).toHaveBeenCalledTimes(2);
  expect(invalidateQueries).toHaveBeenNthCalledWith(1);
  expect(invalidateQueries).toHaveBeenNthCalledWith(2);
});

test("shared hooks switch to a different user cache key without reusing the prior user", () => {
  mockAuthState = { loading: false, user: { id: "user-a" } };
  useConfig();
  expect(useQuery).toHaveBeenLastCalledWith(expect.objectContaining({ queryKey: ["config", "user-a"] }));
  mockAuthState = { loading: false, user: { id: "user-b" } };
  useConfig();
  expect(useQuery).toHaveBeenLastCalledWith(expect.objectContaining({ queryKey: ["config", "user-b"] }));
});