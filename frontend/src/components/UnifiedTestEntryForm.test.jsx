import { act } from "react";
import { createRoot } from "react-dom/client";
import UnifiedTestEntryForm, {
  createBassettTestRunDraft,
  createComparisonEditDraft,
  createComparisonTestDraft,
} from "./UnifiedTestEntryForm";
import { toast } from "sonner";

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

jest.mock("./forms", () => ({
  FormModal: ({ children, onSubmit, submitLabel = "Save" }) => <div>{children}<button type="submit" data-testid="submit" onClick={(event) => { event.preventDefault(); onSubmit(); }}>{submitLabel}</button></div>,
  Field: ({ label, description, children }) => <label>{label}{description && <span>{description}</span>}{children}</label>,
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
  const sections = [...view.container.querySelectorAll("summary[data-guided-section]")]
    .map((summary) => summary.closest("details"));
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
  const scoreSelects = [...view.container.querySelectorAll('select[aria-label$=" score"]')];
  expect(scoreSelects.length).toBeGreaterThan(0);
   expect(scoreSelects.every((select) => select.value === "" && select.options.length === 13)).toBe(true);
  act(() => view.root.unmount());
});

test("both form modes expose all twelve plain-language scoring questions and one primary save action", () => {
  const expectedQuestions = [
    "Did the answer get the facts right?",
    "Did it identify the correct current code or regulation?",
    "Did it interpret the law or regulation correctly?",
    "Did it calculate numbers, areas, or thresholds correctly?",
    "Did it understand the property, jurisdiction, and user context?",
    "Did it recognize important missing information?",
    "Did it handle follow-up questions and clarifications appropriately?",
    "Were the cited sources accurate and correctly connected to the claims?",
    "Did it use authoritative, relevant sources?",
    "Did it provide clear, practical next-step guidance?",
    "Did it cover all important parts of the question?",
    "Would this answer be professionally useful as delivered?",
  ];
  for (const mode of ["bassett", "comparison"]) {
    const view = renderForm(mode, { id: `${mode}-edit` });
    expectedQuestions.forEach((question) => expect(view.container.textContent).toContain(question));
    expect([...view.container.querySelectorAll('button[type="submit"]')]).toHaveLength(1);
    expect(view.container.querySelector('button[type="submit"]').textContent).toBe("Save changes");
    act(() => view.root.unmount());
  }
});

test("both evaluation form modes keep score labels and the shared rubric without repeated helper sentences", () => {
  for (const mode of ["bassett", "comparison"]) {
    const view = renderForm(mode, { id: `${mode}-score-edit` });
    const selects = [...view.container.querySelectorAll('select[aria-label$=" score"]')];
    expect(selects.length).toBeGreaterThan(0);
    expect(selects.every((select) => select.options[0].textContent.includes("Not scored"))).toBe(true);
    expect(selects.every((select) => select.options[1].textContent.includes("N/A — Not Applicable"))).toBe(true);
    expect(view.container.textContent).toContain("View the shared 0–10 scoring rubric");
    expect(view.container.textContent).not.toContain("missing evidence and Not Applicable");
    expect(selects.every((select) => select.parentElement.querySelector("p") === null)).toBe(true);
    act(() => view.root.unmount());
  }
});

test("both evaluation form modes show dimension names without exposing configured weights", () => {
  const expectedDimensions = [
    "Accuracy", "Current Code Identification", "Legal / Regulatory Interpretation",
    "Calculation Accuracy", "Context Understanding", "Missing Information Recognition",
    "Follow-Up Handling", "Citation Accuracy", "Source Quality", "Guidance Quality",
    "Completeness", "Usefulness",
  ];
  for (const mode of ["bassett", "comparison"]) {
    const view = renderForm(mode, { id: `${mode}-dimension-heading-edit` });
    expectedDimensions.forEach((dimension) => expect(view.container.textContent).toContain(dimension));
    expect(view.container.textContent).not.toMatch(/· weight \d+/);
    expect(view.container.textContent).not.toMatch(/weight \d+/);
    act(() => view.root.unmount());
  }
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

test("comparison edit hydration retains the existing records and revision", () => {
  const draft = createComparisonEditDraft({
    testcase: {
      id: "tc-1", name: "Existing comparison", revision: 7,
      updated_at: "2026-09-01T00:00:00Z", prompts: [{ turn: 1, text: "Existing prompt" }],
      comparison_result: "Pass", comparison_classification: "Tie",
    },
    gold_standard: { answer: "Verified answer" },
    responses: [{ id: "response-1", model: "Bassett", response: "Bassett response" }],
    evaluations: [{ id: "evaluation-1", model: "Bassett", scores: { accuracy: 9 }, final_result: "Pass" }],
    findings: [{ id: "finding-1", finding_scope: "comparison", title: "Comparison issue" }],
  });
  expect(draft.id).toBe("tc-1");
  expect(draft.expected_revision).toBe(7);
  expect(draft.question_asked).toBe("Existing prompt");
  expect(draft.gold_standard_answer).toBe("Verified answer");
  expect(draft.responses.Bassett.id).toBe("response-1");
  expect(draft.evaluations.Bassett.id).toBe("evaluation-1");
  expect(draft.comparison.findings).toEqual([{ id: "finding-1", finding_scope: "comparison", title: "Comparison issue" }]);
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

test("review summary exposes required and optional sections while preserving autosaved draft content", () => {
  jest.useFakeTimers();
  const view = renderForm("bassett", { question_asked: "Keep this question" });
  expect(view.container.querySelector('[data-testid="workflow-review-summary"]')).not.toBeNull();
  expect(view.container.querySelector('[data-testid="workflow-review-summary"]').textContent).toContain("(Required)");
  expect(view.container.querySelector('[data-testid="workflow-review-summary"]').textContent).toContain("(Optional)");
  act(() => jest.advanceTimersByTime(500));
  expect(JSON.parse(localStorage.getItem("zoneqa:bassett-workflow-draft")).question_asked).toBe("Keep this question");
  jest.useRealTimers();
  act(() => view.root.unmount());
});

test("multi-turn mode replaces single-prompt fields with an ordered turn builder", () => {
  const view = renderForm("bassett", {
    test_type: "Multi-turn",
    turns: [
      { id: "turn-1", order: 1, prompt: "First prompt", response: "First response", citations: [], evaluator_notes: "" },
      { id: "turn-2", order: 2, prompt: "Second prompt", response: "Second response", citations: [], evaluator_notes: "" },
    ],
  });
  expect(view.container.querySelector('[data-testid="multi-turn-builder"]')).not.toBeNull();
  expect(view.container.textContent).toContain("First prompt");
  expect(view.container.textContent).toContain("Second prompt");
  expect(view.container.textContent).not.toContain("Exact Bassett answer");
  const moveUp = view.container.querySelector('[aria-label="Move turn 2 up"]');
  act(() => moveUp.click());
  expect(view.latest().turns.map((turn) => turn.prompt)).toEqual(["Second prompt", "First prompt"]);
  expect(view.latest().turns.map((turn) => turn.order)).toEqual([1, 2]);
  act(() => view.root.unmount());
});

