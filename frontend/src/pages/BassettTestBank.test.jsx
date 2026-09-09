import { act } from "react";
import { createRoot } from "react-dom/client";
import { loadBassettScenarioForEdit } from "../lib/bassettEditLoaders";
import { SortableTableHeader } from "../components/SortableTableHeader";
import { validateScenarioDraft } from "../lib/formValidation";

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

jest.mock("react-router-dom", () => ({
  Link: ({ children }) => <a>{children}</a>,
  useNavigate: () => jest.fn(),
}), { virtual: true });

test("sortable headers are keyboard-native controls and expose screen-reader sort state", () => {
  const container = document.createElement("div");
  const root = createRoot(container);
  const onSort = jest.fn();
  act(() => {
    root.render(<table><thead><tr><SortableTableHeader
      column={{ key: "stable_id", label: "Test ID" }}
      sort={{ key: "stable_id", direction: "asc" }}
      onSort={onSort}
    /></tr></thead></table>);
  });

  const header = container.querySelector("th");
  const button = container.querySelector("button");
  expect(header.getAttribute("aria-sort")).toBe("ascending");
  expect(button.tagName).toBe("BUTTON");
  expect(button.getAttribute("type")).toBe("button");
  expect(button.getAttribute("aria-label")).toMatch(/Sort by Test ID, currently ascending/);
  expect(button.textContent).toMatch(/Sorted ascending/);
  act(() => button.click());
  expect(onSort).toHaveBeenCalledWith("stable_id");
  act(() => root.unmount());
});

test("inactive headers announce that they are not sorted", () => {
  const container = document.createElement("div");
  const root = createRoot(container);
  act(() => {
    root.render(<table><thead><tr><SortableTableHeader
      column={{ key: "priority", label: "Priority" }}
      sort={{ key: "stable_id", direction: "asc" }}
      onSort={jest.fn()}
    /></tr></thead></table>);
  });
  expect(container.querySelector("th").getAttribute("aria-sort")).toBe("none");
  expect(container.querySelector("button").getAttribute("aria-label")).toMatch(/currently not sorted/);
  act(() => root.unmount());
});

test("scenario validation preserves exact required definition semantics", () => {
  const errors = validateScenarioDraft({
    workflow_stage: "Research",
    report_type: "",
    test_scenario: " ",
    complexity: "Medium",
    why_it_matters: "Required for due diligence",
    what_bassett_should_do: "Cite the controlling ordinance",
    success_criteria: "Uses the verified source",
  });
  expect(errors).toEqual({
    report_type: "Report type is required.",
    test_scenario: "Test scenario is required.",
  });
});

test("scenario edit loading preserves the complete definition and concurrency fields", async () => {
  const scenario = { id: "scenario-r01", stable_id: "R-01" };
  const complete = {
    ...scenario,
    test_scenario: "Research setback requirements",
    issues: [{ id: "run-1" }],
    executions: [{ id: "legacy-1" }],
    history: [{ id: "history-1" }],
    revision: 4,
    updated_at: "2026-09-08T12:00:00Z",
  };
  const apiClient = { get: jest.fn(() => Promise.resolve({ data: complete })) };

  await expect(loadBassettScenarioForEdit(scenario, apiClient)).resolves.toBe(complete);
  expect(apiClient.get).toHaveBeenCalledWith("/bassett/scenarios/scenario-r01");
});