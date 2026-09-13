import { act } from "react";
import { createRoot } from "react-dom/client";
import Dashboard from "./Dashboard";

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

jest.mock("react-router-dom", () => ({
  Link: ({ to, children, ...props }) => <a href={to} {...props}>{children}</a>,
}), { virtual: true });

const metrics = {
  active_version: "Bassett v2", bassett_current: { pass_rate: 50, passed: 1, failed: 1, evaluated: 2, label: "1 / 2 passed", definition: "Current definition" },
  bassett_avg_score: { value: 7.5, unit: "avg overall score /10", definition: "Score definition" },
  all_model_evaluations: { label: "3 / 4 evaluated", definition: "Evaluation definition" },
  findings: { open: 2, open_critical: 1, awaiting_fix: 1, ready_for_retest: 1, definition: "Finding definition" },
  regression_current: { passed: 2, failed: 1, execution_date: "2026-08-31", test_date: "2026-08-30", definition: "Regression definition" },
  test_cases: { total: 3, definition: "Test definition" }, retests: { total: 2, completed: 1, definition: "Retest definition" },
};

jest.mock("@tanstack/react-query", () => ({
  useQuery: jest.fn(),
  useQueryClient: () => ({
    setQueryData: jest.fn(),
    removeQueries: jest.fn(),
    invalidateQueries: jest.fn(),
  }),
}));

jest.mock("../lib/api", () => ({ api: { get: jest.fn() } }));
jest.mock("../lib/auth", () => ({ useAuth: () => ({ loading: false, user: { id: "user-a" } }) }));
jest.mock("../components/ui/button", () => ({
  Button: ({ children, asChild, ...props }) => asChild ? children : <button {...props}>{children}</button>,
}));
jest.mock("../components/shared", () => {
  const actual = jest.requireActual("../components/shared");
  return { ...actual, HowCalculated: ({ children }) => <div data-testid="how-calculated">{children}</div> };
});
jest.mock("recharts", () => ({
  ResponsiveContainer: ({ children }) => <div>{children}</div>, BarChart: ({ children }) => <div>{children}</div>,
  Bar: ({ children }) => <div>{children}</div>, Cell: () => null, XAxis: () => null, YAxis: () => null, CartesianGrid: () => null, Tooltip: () => null,
}));

const defaultUseQuery = ({ queryKey }) => {
  const data = queryKey[0] === "stats" ? { active_projects: 1, demo_approved: 1 }
    : queryKey[0] === "metrics" ? metrics
      : queryKey[0] === "perf" ? { scope: "Bassett version: Bassett v2", model_summary: [{ model: "Bassett", avg_score: 7.5 }, { model: "ChatGPT", avg_score: 6.5 }] }
        : [];
  return { data, isLoading: false, isError: false, refetch: jest.fn() };
};

const { useQuery } = require("@tanstack/react-query");

beforeEach(() => {
  // resetMocks clears implementations as well as call history in the Jest
  // config, so reinstall the baseline for every test before any overrides.
  useQuery.mockImplementation(defaultUseQuery);
});

test("Dashboard cards are keyboard-accessible links to exact metric record sets", () => {
  const container = document.createElement("div");
  const root = createRoot(container);
  act(() => root.render(<Dashboard />));
  const cards = [...container.querySelectorAll('a[data-testid^="stat-"]')];
  expect(cards).toHaveLength(10);
  expect(container.querySelectorAll('[data-testid="dashboard-metric-group"]')).toHaveLength(3);
  expect(cards.map((card) => card.getAttribute("href"))).toContain("/dashboard/records/model-comparison-pass-rate");
  expect(cards.map((card) => card.getAttribute("href"))).toContain("/dashboard/records/bassett-only-pass-rate");
  expect(cards.map((card) => card.getAttribute("href"))).toContain("/dashboard/records/all-model-evaluations");
  expect(cards.map((card) => card.getAttribute("href"))).not.toContain("/dashboard/records/retests");
  expect(cards.map((card) => card.getAttribute("href"))).not.toContain("/dashboard/records/regression-current");
  expect(cards.every((card) => card.getAttribute("aria-describedby"))).toBe(true);
  expect(container.textContent).toContain("Active version: Bassett v2");
  expect(container.textContent).toContain("Bassett version: Bassett v2");
  expect(container.querySelector("table caption").textContent).toContain("Average model scores");
  act(() => root.unmount());
});

test("Dashboard starts with metric groups and does not render the redundant workspace path", () => {
  const container = document.createElement("div");
  const root = createRoot(container);
  act(() => root.render(<Dashboard />));

  expect(container.querySelector('[data-testid="workspace-path"]')).toBeNull();
  expect(container.querySelector("h1").textContent).toBe("QA Dashboard");
  expect(container.querySelectorAll('[data-testid="dashboard-metric-group"]')).toHaveLength(3);
  expect(container.querySelectorAll('a[data-testid^="stat-"]')).toHaveLength(10);
  expect(container.textContent).toContain("Bassett Quality");
  expect(container.textContent).toContain("Finding Workflow");
  expect(container.textContent).not.toContain("Release Confidence");
  expect(container.textContent).not.toContain("Regression (latest run)");
  expect(container.textContent).not.toContain("Retest Executions");
  expect(container.textContent).toContain("Program Operations");
  expect(container.textContent).toContain("Model Comparison — Bassett Pass Rate");
  expect(container.textContent).toContain("Bassett-Only Pass Rate");
  expect(container.textContent).toContain("N/A");
  expect(container.textContent).toContain("Limited data — 2 evaluated records");

  act(() => root.unmount());
});

test("dashboard methodology has one collapsed keyboard-accessible disclosure without an empty reporting-groups panel", () => {
  const container = document.createElement("div");
  const root = createRoot(container);
  act(() => root.render(<Dashboard />));

  const infos = [...container.querySelectorAll('[data-testid="metric-info"]')];
  expect(infos).toHaveLength(0);
  const methodology = container.querySelector('[data-testid="dashboard-methodology"]');
  expect(container.querySelectorAll('[data-testid="dashboard-methodology"]')).toHaveLength(1);
  expect(methodology.open).toBe(false);
  expect(methodology.querySelectorAll("summary")).toHaveLength(1);
  expect(methodology.querySelector("summary").textContent).toBe("How dashboard metrics are calculated");
  expect(methodology.querySelector("summary").getAttribute("class")).toContain("focus-visible");
  expect(methodology.querySelectorAll("details")).toHaveLength(0);
  expect(container.querySelector('[data-testid="dashboard-reporting-groups-panel"]')).toBeNull();
  expect(methodology.querySelector("h3").textContent).toBe("Bassett Reporting Groups");

  act(() => methodology.querySelector("summary").click());
  expect(methodology.open).toBe(true);
  expect(methodology.textContent).toContain("Seven reporting groups consolidate the 12 stored scoring dimensions.");
  expect(container.textContent.match(/How calculated/g)).toBeNull();

  act(() => root.unmount());
  container.remove();
});

test("Average Score chart gives each visible model its own legend entry", () => {
  const container = document.createElement("div");
  const root = createRoot(container);
  act(() => root.render(<Dashboard />));

  const legend = container.querySelector('[aria-label="Model color legend"]');
  expect(legend).not.toBeNull();
  expect([...legend.querySelectorAll("span")].map((entry) => entry.textContent)).toEqual(["Bassett", "ChatGPT"]);
  expect(legend.textContent).not.toContain("Benchmarks");
  expect(container.textContent).toContain("Scale: 0–10");

  act(() => root.unmount());
  container.remove();
});

test("starts performance query from the parallel active-version reference, not metrics resolution", () => {
  const original = useQuery.getMockImplementation();
  useQuery.mockImplementation(({ queryKey }) => {
    if (queryKey[0] === "stats") return { data: { active_projects: 0, demo_approved: 0 }, isLoading: false, isError: false, refetch: jest.fn() };
    if (queryKey[0] === "metrics") return { data: undefined, isLoading: true, isError: false, refetch: jest.fn() };
    if (queryKey[0] === "versions") return { data: [{ id: "v1", name: "Bassett v2", active: true }], isLoading: false, isError: false, refetch: jest.fn() };
    return { data: { model_summary: [] }, isLoading: false, isError: false, refetch: jest.fn() };
  });

  const container = document.createElement("div");
  const root = createRoot(container);
  act(() => root.render(<Dashboard />));

  const perfCall = useQuery.mock.calls.find(([options]) => options.queryKey?.[0] === "perf");
  expect(useQuery.mock.calls.filter(([options]) => options.queryKey?.[0] === "perf")).toHaveLength(1);
  expect(useQuery.mock.calls.find(([options]) => options.queryKey?.[0] === "stats")?.[0]).toEqual(expect.objectContaining({
    queryKey: ["stats", "user-a", "excluded"],
    staleTime: 0,
  }));
  expect(useQuery.mock.calls.find(([options]) => options.queryKey?.[0] === "metrics")?.[0]).toEqual(expect.objectContaining({
    queryKey: ["metrics", "user-a", "excluded"],
    staleTime: 0,
  }));
  expect(perfCall?.[0]).toEqual(expect.objectContaining({
    queryKey: ["perf", "Bassett v2", "user-a", "excluded"],
    enabled: true,
  }));
  expect(container.querySelector('[aria-label="Loading dashboard sections"]')).not.toBeNull();

  act(() => root.unmount());
  useQuery.mockImplementation(original);
  container.remove();
});

test("dashboard renders available groups while a different mutable snapshot is still loading", () => {
  const original = useQuery.getMockImplementation();
  useQuery.mockImplementation(({ queryKey }) => {
    if (queryKey[0] === "stats") return {
      data: { active_projects: 3, demo_approved: 2 }, isLoading: false, isError: false, refetch: jest.fn(),
    };
    if (queryKey[0] === "metrics") return {
      data: undefined, isLoading: true, isError: false, refetch: jest.fn(),
    };
    if (queryKey[0] === "versions") return {
      data: [{ id: "v1", name: "Bassett v2", active: true }], isLoading: false, isError: false, refetch: jest.fn(),
    };
    return { data: { model_summary: [] }, isLoading: false, isError: false, refetch: jest.fn() };
  });

  const container = document.createElement("div");
  const root = createRoot(container);
  act(() => root.render(<Dashboard />));

  expect(container.querySelector("h1").textContent).toBe("QA Dashboard");
  expect(container.querySelector('[data-testid="dashboard-metric-group"]').textContent).toContain("Loading quality metrics");
  expect(container.textContent).toContain("Active Projects");
  expect(container.textContent).toContain("Program Operations");
  expect(container.querySelector('[aria-label="Loading dashboard sections"]')).not.toBeNull();

  act(() => root.unmount());
  useQuery.mockImplementation(original);
  container.remove();
});
