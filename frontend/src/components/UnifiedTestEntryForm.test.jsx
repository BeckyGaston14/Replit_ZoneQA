import { act } from "react";
import { createRoot } from "react-dom/client";
import UnifiedTestEntryForm, {
  createBassettTestRunDraft,
  createComparisonTestDraft,
} from "./UnifiedTestEntryForm";
import { toast } from "sonner";

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

jest.mock("./forms", () => ({
  FormModal: ({ children, onSubmit }) => <div>{children}<button data-testid="submit" onClick={onSubmit}>Submit</button></div>,
  Field: ({ label, children }) => <label>{label}{children}</label>,
}));
jest.mock("./ui/input", () => ({ Input: (props) => <input {...props} /> }));
jest.mock("./ui/textarea", () => ({ Textarea: (props) => <textarea {...props} /> }));
jest.mock("./ui/button", () => ({ Button: ({ children, ...props }) => <button {...props}>{children}</button> }));
jest.mock("./ui/checkbox", () => ({ Checkbox: ({ checked, onCheckedChange }) => <input type="checkbox" checked={checked} onChange={(event) => onCheckedChange(event.target.checked)} /> }));
jest.mock("../lib/api", () => ({ api: { post: jest.fn() } }));
jest.mock("sonner", () => ({ toast: { success: jest.fn(), error: jest.fn() } }));

const scenario = {
  id: "scenario-1", stable_id: "R-01", workflow_stage: "Research",
  report_type: "Property", test_scenario: "Setback research", complexity: "High",
  why_it_matters: "Accuracy", what_bassett_should_do: "Read the ordinance",
  success_criteria: "Quote the controlling section", priority: "P1 - High",
};

function renderForm(mode, overrides = {}, props = {}) {
  const container = document.createElement("div");
  const root = createRoot(container);
  let latest;
  const base = mode === "comparison"
    ? createComparisonTestDraft({ scenario_id: scenario.id })
    : createBassettTestRunDraft({ scenario_id: scenario.id });
  function Harness() {
    const [form, setForm] = require("react").useState({ ...base, ...overrides });
    latest = form;
    return <UnifiedTestEntryForm
      mode={mode} form={form} setForm={setForm} scenarios={[scenario]}
      versions={[]} projects={[]} municipalities={[]} properties={[]} users={[]}
      onSubmit={jest.fn()} onCancel={jest.fn()} {...props}
    />;
  }
  act(() => root.render(<Harness />));
  return { container, root, latest: () => latest };
}

afterEach(() => {
  localStorage.clear();
  jest.clearAllMocks();
});

test("Bassett and comparison modes share the core section order while benchmarks stay comparison-only", () => {
  const bassett = renderForm("bassett");
  const comparison = renderForm("comparison");
  const commonSections = [
    "1. Test Setup", "2. Linked Records & Prompt", "3. Bassett Result",
    "4. Canonical Evaluation", "5. Findings & Ownership",
    "6. Sources, Documents & Notes", "7. Follow-up, Retesting & Regression",
  ];
  for (const section of commonSections) {
    expect(bassett.container.textContent).toContain(section);
    expect(comparison.container.textContent).toContain(section);
  }
  expect(bassett.container.textContent).not.toContain("Comparison-only sections");
  expect(comparison.container.textContent).toContain("Comparison-only sections");
  expect(comparison.container.textContent).toContain("ChatGPT response");
  expect(comparison.container.textContent).toContain("Claude response");
  expect(comparison.container.querySelector('textarea[placeholder="Never mixed into Bassett-only findings."]')).not.toBeNull();
  act(() => bassett.root.unmount());
  act(() => comparison.root.unmount());
});

test("guided workflow opens one section at a time and supports Previous and Next navigation", () => {
  const view = renderForm("bassett");
  const sections = [...view.container.querySelectorAll("details")];
  expect(sections).toHaveLength(7);
  expect(sections.filter((section) => section.open)).toHaveLength(1);
  expect(sections[0].open).toBe(true);

  act(() => [...view.container.querySelectorAll("button")].find((button) => button.textContent === "Next").click());
  expect(sections.filter((section) => section.open)).toHaveLength(1);
  expect(sections[1].open).toBe(true);

  act(() => [...view.container.querySelectorAll("button")].find((button) => button.textContent === "Previous").click());
  expect(sections[0].open).toBe(true);
  act(() => view.root.unmount());
});

test("invalid submission marks and opens the first incomplete section", () => {
  const view = renderForm("bassett");
  act(() => view.container.querySelector('[data-testid="submit"]').click());
  const sections = [...view.container.querySelectorAll("details")];
  expect(sections[1].open).toBe(true);
  expect(sections[1].querySelector("summary").textContent).toContain("Needs attention");
  expect(toast.error).toHaveBeenCalledWith("The question asked is required");
  act(() => view.root.unmount());
});

test("expanded comparison locks common Bassett fields but leaves benchmark fields editable", () => {
  const view = renderForm("comparison", {
    id: "tc-1", name: "Expanded case", question_asked: "Question",
    prompts: [{ turn: 1, text: "Question" }], exact_bassett_answer: "Bassett answer",
    gold_standard_answer: "Gold", test_date: "2026-09-01",
  }, { lockedCommon: true });
  const textareaByLabel = (label) => [...view.container.querySelectorAll("label")]
    .find((node) => node.textContent.startsWith(label))?.querySelector("textarea");
  expect(textareaByLabel("Prompt / question").disabled).toBe(true);
  expect(textareaByLabel("Bassett response").disabled).toBe(true);
  expect(textareaByLabel("ChatGPT response").disabled).toBe(false);
  expect(textareaByLabel("Claude response").disabled).toBe(false);
  expect(view.container.textContent).not.toContain("Test Bank scenarioSelect");
  act(() => view.root.unmount());
});

test("missing benchmark responses and scores remain explicit unavailable inputs and do not become zero", () => {
  const view = renderForm("comparison");
  expect(view.container.querySelector('textarea[placeholder="Leave blank to record unavailable."]')).not.toBeNull();
  expect(view.container.textContent).toContain("excluded from comparison metrics");
  const scoreInputs = [...view.container.querySelectorAll('input[type="number"]')];
  expect(scoreInputs.length).toBeGreaterThan(0);
  expect(scoreInputs.every((input) => input.value === "" && input.min === "0" && input.max === "10")).toBe(true);
  act(() => view.root.unmount());
});

test("comparison drafts save locally without File objects", () => {
  const view = renderForm("comparison", { name: "Draft", attachments: [new File(["x"], "evidence.txt")] });
  act(() => [...view.container.querySelectorAll("button")].find((button) => button.textContent === "Save draft").click());
  const saved = JSON.parse(localStorage.getItem("zoneqa:comparison-workflow-draft"));
  expect(saved.name).toBe("Draft");
  expect(saved.attachments).toEqual([]);
  expect(toast.success).toHaveBeenCalledWith("Draft saved on this device");
  act(() => view.root.unmount());
});

test("comparison editor renders stale-save recovery controls supplied by its page", () => {
  const view = renderForm("comparison", { id: "tc-1" }, {
    conflictNotice: <div role="alert"><p>Someone else saved this test case first.</p><button>Load latest values</button><button>Keep my entries and reapply</button></div>,
  });
  expect(view.container.querySelector('[role="alert"]').textContent).toContain("Someone else saved");
  expect(view.container.textContent).toContain("Load latest values");
  expect(view.container.textContent).toContain("Keep my entries and reapply");
  act(() => view.root.unmount());
});