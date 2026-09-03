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
  useQuery: ({ queryKey }) => {
    const data = queryKey[0] === "stats" ? { active_projects: 1, demo_approved: 1 }
      : queryKey[0] === "metrics" ? metrics
        : queryKey[0] === "perf" ? { scope: "Bassett version: Bassett v2", model_summary: [{ model: "Bassett", avg_score: 7.5 }, { model: "ChatGPT", avg_score: 6.5 }] }
          : [];
    return { data, isLoading: false, isError: false, refetch: jest.fn() };
  },
}));

jest.mock("../lib/api", () => ({ api: { get: jest.fn() } }));
jest.mock("../components/ui/button", () => ({
  Button: ({ children, asChild, ...props }) => asChild ? children : <button {...props}>{children}</button>,
}));
jest.mock("recharts", () => ({
  ResponsiveContainer: ({ children }) => <div>{children}</div>, BarChart: ({ children }) => <div>{children}</div>,
  Bar: ({ children }) => <div>{children}</div>, Cell: () => null, XAxis: () => null, YAxis: () => null, CartesianGrid: () => null, Tooltip: () => null,
}));

test("Dashboard cards are keyboard-accessible links to exact metric record sets", () => {
  const container = document.createElement("div");
  const root = createRoot(container);
  act(() => root.render(<Dashboard />));
  const cards = [...container.querySelectorAll('a[data-testid^="stat-"]')];
  expect(cards).toHaveLength(12);
  expect(container.querySelectorAll('[data-testid="dashboard-metric-group"]')).toHaveLength(4);
  expect(cards.map((card) => card.getAttribute("href"))).toContain("/dashboard/records/bassett-pass-rate");
  expect(cards.map((card) => card.getAttribute("href"))).toContain("/dashboard/records/all-model-evaluations");
  expect(cards.map((card) => card.getAttribute("href"))).toContain("/dashboard/records/retests");
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
  expect(container.querySelectorAll('[data-testid="dashboard-metric-group"]')).toHaveLength(4);
  expect(container.querySelectorAll('a[data-testid^="stat-"]')).toHaveLength(12);
  expect(container.textContent).toContain("Bassett Quality");
  expect(container.textContent).toContain("Finding Workflow");
  expect(container.textContent).toContain("Release Confidence");
  expect(container.textContent).toContain("Program Operations");

  act(() => root.unmount());
});

test("Average Score chart gives each visible model its own legend entry", () => {
  const container = document.createElement("div");
  const root = createRoot(container);
  act(() => root.render(<Dashboard />));

  const legend = container.querySelector('[aria-label="Model color legend"]');
  expect(legend).not.toBeNull();
  expect([...legend.querySelectorAll("span")].map((entry) => entry.textContent)).toEqual(["Bassett", "ChatGPT"]);
  expect(legend.textContent).not.toContain("Benchmarks");
  expect(container.textContent).not.toContain("Pass with Minor Issues");
  expect(container.textContent).not.toContain("Needs Improvement");
  expect(container.textContent).not.toContain("Critical Fail");
  expect(container.textContent).not.toContain("Not Evaluated");
  expect(container.textContent).toContain("Scale: 0–10");

  act(() => root.unmount());
  container.remove();
});