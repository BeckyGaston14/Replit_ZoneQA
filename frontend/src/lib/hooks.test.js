import { useQuery } from "@tanstack/react-query";
import { useCollection, useConfig, useTestBank, useTestCases } from "./hooks";

jest.mock("@tanstack/react-query", () => ({ useQuery: jest.fn() }));

beforeEach(() => useQuery.mockReset());

test("reference hooks share stable keys and a bounded user-session cache window", () => {
  useCollection("projects");
  expect(useQuery).toHaveBeenLastCalledWith(expect.objectContaining({
    queryKey: ["projects"],
    staleTime: 300000,
    gcTime: 1800000,
    refetchOnMount: false,
    refetchOnWindowFocus: false,
  }));

  useConfig();
  expect(useQuery).toHaveBeenLastCalledWith(expect.objectContaining({ queryKey: ["config"], staleTime: 300000 }));
});

test("enriched records and Test Bank use predictable active/all cache keys", () => {
  useTestCases();
  expect(useQuery).toHaveBeenLastCalledWith(expect.objectContaining({ queryKey: ["tc-enriched", "active"] }));
  useTestCases({ includeArchived: true });
  expect(useQuery).toHaveBeenLastCalledWith(expect.objectContaining({ queryKey: ["tc-enriched", "all"] }));
  useTestBank();
  expect(useQuery).toHaveBeenLastCalledWith(expect.objectContaining({ queryKey: ["bassett-scenarios", "active"] }));
  useTestBank({ includeArchived: true });
  expect(useQuery).toHaveBeenLastCalledWith(expect.objectContaining({ queryKey: ["bassett-scenarios", "including-archived"] }));
});