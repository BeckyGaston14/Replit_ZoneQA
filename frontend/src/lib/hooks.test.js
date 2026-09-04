import { useQuery } from "@tanstack/react-query";
import { useCollection, useConfig, useTestBank, useTestCases } from "./hooks";

jest.mock("@tanstack/react-query", () => ({ useQuery: jest.fn() }));
jest.mock("./api", () => ({ api: { get: jest.fn() } }));
let mockAuthState = { loading: true, user: null };
jest.mock("./auth", () => ({ useAuth: () => mockAuthState }));

beforeEach(() => useQuery.mockReset());

test("reference hooks share stable keys and a bounded user-session cache window", () => {
  mockAuthState = { loading: false, user: { id: "user-a" } };
  useCollection("projects");
  expect(useQuery).toHaveBeenLastCalledWith(expect.objectContaining({
    queryKey: ["projects", "user-a"],
    enabled: true,
    staleTime: 300000,
    gcTime: 1800000,
    refetchOnMount: false,
    refetchOnWindowFocus: false,
  }));

  useConfig();
  expect(useQuery).toHaveBeenLastCalledWith(expect.objectContaining({ queryKey: ["config", "user-a"], staleTime: 300000 }));
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
  await expect(options.queryFn()).resolves.toEqual([{ id: "project-a" }]);
});

test("shared hooks switch to a different user cache key without reusing the prior user", () => {
  mockAuthState = { loading: false, user: { id: "user-a" } };
  useConfig();
  expect(useQuery).toHaveBeenLastCalledWith(expect.objectContaining({ queryKey: ["config", "user-a"] }));
  mockAuthState = { loading: false, user: { id: "user-b" } };
  useConfig();
  expect(useQuery).toHaveBeenLastCalledWith(expect.objectContaining({ queryKey: ["config", "user-b"] }));
});