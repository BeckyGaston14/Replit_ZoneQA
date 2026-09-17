import { act } from "react";
import { createRoot } from "react-dom/client";
import { RubricCriteriaSelector, ScenarioSelector } from "./UnifiedTestEntryForm";

jest.mock("./forms", () => ({ FormModal: ({ children }) => <div>{children}</div>, Field: ({ label, children }) => <div>{label}{children}</div> }));
jest.mock("./ui/input", () => ({ Input: (props) => <input {...props} /> }));
jest.mock("./ui/textarea", () => ({ Textarea: (props) => <textarea {...props} /> }));
jest.mock("./ui/button", () => ({ Button: ({ children, ...props }) => <button {...props}>{children}</button> }));
jest.mock("./ui/checkbox", () => ({ Checkbox: () => <input type="checkbox" /> }));
jest.mock("./ConfirmActionDialog", () => ({ ConfirmActionDialog: () => null }));

globalThis.IS_REACT_ACT_ENVIRONMENT = true;
let container, root;
beforeEach(() => { container = document.createElement("div"); root = createRoot(container); });
afterEach(() => { act(() => root.unmount()); jest.restoreAllMocks(); });

test("new scenario picker excludes archived scenarios but preserves an existing historical selection", () => {
  const scenarios = [
    { id: "new", stable_id: "R-01", workflow_stage: "Research", test_scenario: "Current" },
    { id: "old", stable_id: "R-01", workflow_stage: "Research", test_scenario: "Historical", archived: true },
  ];
  const render = (value) => act(() => root.render(<ScenarioSelector scenarios={scenarios} value={value} category="Research" onChange={() => {}} onCategoryChange={() => {}} />));
  render("");
  expect(container.querySelector('option[value="old"]')).toBeNull();
  expect(container.querySelector('option[value="new"]')).not.toBeNull();
  render("old");
  expect(container.querySelector('option[value="old"]')).not.toBeNull();
});

test.each([undefined, null, "", "N/A"])("unchecking an unscored criterion (%s) does not ask for confirmation", (score) => {
  const confirm = jest.spyOn(globalThis, "confirm").mockReturnValue(true);
  const onChange = jest.fn();
  const catalog = { revision: "2026-09-16", categories: [{ key: "sources", name: "Sources & Citations" }], rubric_items: [{ rubric_id: "G-09", category: "sources", evaluation_criterion: "Citations" }] };
  act(() => root.render(<RubricCriteriaSelector catalog={catalog} mappedIds={["G-09"]} selectedIds={["G-09"]} scores={{ "G-09": score }} onChange={onChange} />));
  expect(container.textContent).toContain("Sources & Citations");
  act(() => container.querySelector('input[type="checkbox"]').click());
  expect(confirm).not.toHaveBeenCalled();
  expect(onChange).toHaveBeenCalledWith([], { confirm_rubric_removal: false });
});

test("zero is a entered score and requires confirmation before exclusion", () => {
  const confirm = jest.spyOn(globalThis, "confirm").mockReturnValue(false);
  const onChange = jest.fn();
  const catalog = { categories: [{ key: "sources", name: "Sources & Citations" }], rubric_items: [{ rubric_id: "G-09", category: "sources" }] };
  act(() => root.render(<RubricCriteriaSelector catalog={catalog} mappedIds={["G-09"]} selectedIds={["G-09"]} scores={{ "G-09": 0 }} onChange={onChange} />));
  act(() => container.querySelector('input[type="checkbox"]').click());
  expect(confirm).toHaveBeenCalledTimes(1);
  expect(onChange).not.toHaveBeenCalled();
});
