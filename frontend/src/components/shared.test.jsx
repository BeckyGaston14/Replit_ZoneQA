import { act } from "react";
import { createRoot } from "react-dom/client";
import { HowCalculated, ResultBadge, ScorePill, StatCard } from "./shared";

jest.mock("react-router-dom", () => ({
  Link: ({ children, to, ...props }) => <a href={to} {...props}>{children}</a>,
}), { virtual: true });

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

test.each([
  "Pass",
  "Pass with Minor Issues",
  "Needs Improvement",
  "Fail",
  "Critical Fail",
])("score and result use the same semantic color for %s", (status) => {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);

  act(() => root.render(<><ResultBadge value={status} /><ScorePill score={7.2} status={status} /></>));

  const [result, score] = container.querySelectorAll("span");
  expect(score.style.background).toBe(result.style.background);

  act(() => root.unmount());
  container.remove();
});

test("How calculated disclosure exposes the metric contract and exact-record link", () => {
  const container = document.createElement("div");
  const root = createRoot(container);
  act(() => root.render(<HowCalculated
    definition="A persisted QA metric"
    calculation={{
      formula: "passed ÷ eligible",
      scope: "Current release",
      filters: "Selected version",
      treatment: "Retests excluded; missing scores unavailable",
      denominator: "Eligible evaluated tests",
      rounding: "One decimal place",
    }}
    drillDown="/dashboard/records/example"
  />));
  expect(container.textContent).toContain("How calculated");
  expect(container.textContent).toContain("passed ÷ eligible");
  expect(container.textContent).toContain("Retests excluded");
  expect(container.querySelector('a[href="/dashboard/records/example"]').textContent).toBe("Open exact records");
  act(() => root.unmount());
});

test("summary cards do not render repeated methodology dropdowns by default", () => {
  const container = document.createElement("div");
  const root = createRoot(container);
  act(() => root.render(<StatCard label="Pass rate" value="80%" title="Unique population definition" testid="summary-card" />));

  expect(container.querySelector('[data-testid="how-calculated"]')).toBeNull();
  expect(container.querySelector('[data-testid="metric-info"]').getAttribute("aria-label")).toBe("About Pass rate");

  act(() => root.unmount());
  container.remove();
});
