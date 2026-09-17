import { act } from "react";
import { createRoot } from "react-dom/client";
import Dashboard from "./Dashboard";

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

jest.mock("react-router-dom", () => ({
  Link: ({ to, children, ...props }) => <a href={to} {...props}>{children}</a>,
}), { virtual: true });

jest.mock("@tanstack/react-query", () => ({ useQuery: jest.fn(), useQueryClient: () => ({ invalidateQueries: jest.fn(), setQueryData: jest.fn() }) }));
jest.mock("../lib/api", () => ({ api: { get: jest.fn() } }));
jest.mock("../lib/auth", () => ({ useAuth: () => ({ loading: false, user: { id: "user-a" } }) }));
jest.mock("../lib/hooks", () => ({
  useCollection: () => ({ data: [{ name: "Bassett v2", active: true }], isLoading: false }),
  useSampleVisibility: () => ({ includeSampleRecords: false, isLoading: false }),
}));
jest.mock("../components/ui/button", () => ({ Button: ({ children, asChild, ...props }) => asChild ? children : <button {...props}>{children}</button> }));
jest.mock("../components/shared", () => {
  const actual = jest.requireActual("../components/shared");
  return { ...actual };
});

const metrics = {
  active_version: "Bassett v2",
  bassett_only: { pass_rate: 50, label: "1 / 2 passed", evaluated: 2 },
  bassett_comparison: { pass_rate: 75, label: "3 / 4 passed", evaluated: 4 },
  tests_needing_attention: 3,
  scenario_coverage: "68%",
  findings: {
    bassett_open: 8, comparison_open: 4,
    by_severity: { "Very Low": { bassett: 1, comparison: 0 }, Low: { bassett: 2, comparison: 1 }, Medium: { bassett: 3, comparison: 1 }, High: { bassett: 1, comparison: 1 }, Critical: { bassett: 1, comparison: 1 } },
  },
};

const queryResult = (queryKey) => {
  const kind = queryKey[0];
  if (kind === "stats") return { data: { active_projects: 1 }, isLoading: false, isError: false, refetch: jest.fn() };
  if (kind === "metrics") return { data: metrics, isLoading: false, isError: false, refetch: jest.fn() };
  if (kind === "bassett-metrics") return { data: { test_runs: { attention: 3, definition: "Attention definition", test_bank_coverage: { percent: 68, covered: 17, total: 25 } } }, isLoading: false, isError: false, refetch: jest.fn() };
  if (kind === "perf" && queryKey[1] === "bassett") return { data: { rubric_revision: "2026-09-16", model_summary: [{ model: "Bassett", avg_score: 8, score_count: 2, passed: 1, failed: 2 }], rubric_categories: [
    { label: "Property & Zoning Rules", score: 0, count: 1 }, { label: "Sources & Citations", score: 7, count: 2 },
    { label: "Reasoning & Conversation", score: 5, count: 2 }, { label: "Analysis & Next Steps", score: 10, count: 1 },
    { label: "Documents & Municipal Records", score: 6, count: 1 },
  ], legacy_reporting_groups: [{ label: "Research Quality", score: 7.5, count: 2 }] }, isLoading: false, isError: false, refetch: jest.fn() };
  if (kind === "perf") return { data: { model_summary: [{ model: "Bassett", avg_score: 7.5, score_count: 3, passed: 3, failed: 1 }, { model: "ChatGPT", avg_score: 7, score_count: 4, passed: 2, failed: 2 }] }, isLoading: false, isError: false, refetch: jest.fn() };
  return { data: [], isLoading: false, isError: false, refetch: jest.fn() };
};

const { useQuery } = require("@tanstack/react-query");
const { api } = require("../lib/api");
beforeEach(() => {
  useQuery.mockImplementation(({ queryKey }) => queryResult(queryKey));
  api.get.mockReset();
});

function renderDashboard() {
  const container = document.createElement("div");
  const root = createRoot(container);
  act(() => root.render(<Dashboard />));
  return { container, root };
}

test("renders the exact hierarchy with responsive KPI and panel classes", () => {
  const { container, root } = renderDashboard();
  expect([...container.querySelectorAll("h2")].map((node) => node.textContent)).toEqual(["Primary KPIs", "Performance", "Current Rubric Performance / Legacy History", "Findings and action"]);
  expect(container.querySelector(".grid-cols-1.sm\\:grid-cols-2.xl\\:grid-cols-4")).not.toBeNull();
  expect(container.querySelector(".grid-cols-1.lg\\:grid-cols-2")).not.toBeNull();
  expect(container.querySelectorAll('a[data-testid^="stat-"]')).toHaveLength(4);
  expect(container.querySelector('[data-testid="stat-tests-needing-attention"]').textContent).toContain("3");
  expect(container.querySelector('[data-testid="stat-scenario-coverage"]').textContent).toContain("68%");
  expect(container.textContent).toContain("17/25 active scenarios evaluated");
  act(() => root.unmount());
});

test("separates performance scope requests and uses active-version KPI and exact severity drilldowns", async () => {
  const { container, root } = renderDashboard();
  const calls = useQuery.mock.calls.map(([options]) => options);
  expect(calls.filter((call) => call.queryKey?.[0] === "perf").map((call) => call.queryKey[1])).toEqual(["bassett", "comparison"]);
  expect(calls.filter((call) => call.queryKey?.[0] === "perf").every((call) => call.queryFn.toString().includes("scope"))).toBe(true);
  const hrefs = [...container.querySelectorAll("a")].map((node) => node.getAttribute("href"));
  expect(hrefs).toEqual(expect.arrayContaining([
    "/dashboard/records/bassett-only-pass-rate", "/dashboard/records/model-comparison-pass-rate",
    "/dashboard/records/bassett-tests-needing-attention", "/dashboard/records/scenario-coverage",
    "/dashboard/records/bassett-open-findings-very-low", "/dashboard/records/comparison-open-findings-critical",
  ]));
  const bassettMetricsCall = calls.find((call) => call.queryKey?.[0] === "bassett-metrics");
  api.get.mockResolvedValueOnce({ data: {} });
  await act(async () => bassettMetricsCall.queryFn({ signal: "signal" }));
  expect(api.get).toHaveBeenCalledWith("/bassett/metrics", {
    params: { version_id: "Bassett v2" },
    signal: "signal",
  });
  expect(container.textContent).toContain("Average score (n=2)");
  expect(container.textContent).toContain("Evaluated results3");
  act(() => root.unmount());
});

test("keeps all five severities, consolidates methodology, and toggles empty categories", () => {
  const { container, root } = renderDashboard();
  expect(["Very Low", "Low", "Medium", "High", "Critical"].every((label) => container.textContent.includes(label))).toBe(true);
  expect(container.querySelectorAll('[data-testid="dashboard-methodology"]').length).toBe(1);
  expect(container.querySelectorAll("summary").length).toBe(2);
  expect(container.querySelectorAll('[data-testid="dashboard-reporting-groups-methodology"]')).toHaveLength(1);
  expect(container.textContent).not.toContain("How calculated");
  const toggle = [...container.querySelectorAll("button")].find((button) => button.textContent.includes("Show categories without results"));
  expect(toggle).not.toBeNull();
  act(() => toggle.click());
  expect(toggle.textContent).toContain("Hide categories without results");
  act(() => root.unmount());
});

test("uses compact empty state wording without fixed chart heights", () => {
  useQuery.mockImplementation(({ queryKey }) => {
    const result = queryResult(queryKey);
    if (queryKey[0] === "perf") return { ...result, data: { model_summary: [] } };
    if (queryKey[0] === "bassett-metrics") return { ...result, data: { categories: [] } };
    return result;
  });
  const { container, root } = renderDashboard();
  expect(container.querySelectorAll('[role="status"]').length).toBeGreaterThan(0);
  expect(container.textContent).toContain("No evaluated records yet");
  expect(container.innerHTML).not.toContain("min-h-36");
  act(() => root.unmount());
});

test("renders retryable KPI and category errors instead of empty or N/A states", () => {
  useQuery.mockImplementation(({ queryKey }) => {
    const result = queryResult(queryKey);
    if (queryKey[0] === "bassett-metrics") return { ...result, data: undefined, isError: true };
    if (queryKey[0] === "perf" && queryKey[1] === "bassett") return { ...result, data: undefined, isError: true };
    return result;
  });
  const { container, root } = renderDashboard();
  expect(container.querySelectorAll('[role="alert"]')).toHaveLength(3);
  expect(container.textContent).not.toContain("Scenario CoverageN/A");
  expect(container.textContent).not.toContain("No evaluated records yet");
  act(() => root.unmount());
});