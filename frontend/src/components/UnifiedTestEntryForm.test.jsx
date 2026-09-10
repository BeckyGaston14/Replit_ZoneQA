import { act } from "react";
import { createRoot } from "react-dom/client";
import UnifiedTestEntryForm, {
  createBassettTestRunDraft,
  bassettVersionRequirementMessage,
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
    "1. Test Setup", "2. Linked Records & Prompt", "3. Bassett Test Result",
    "4. Canonical Evaluation", "5. Findings & Ownership",
    "6. Sources, Documents & Notes", "7. Follow-up, Retesting & Regression",
  ];
  for (const section of commonSections) {
    expect(bassett.container.textContent).toContain(section);
    expect(comparison.container.textContent).toContain(section);
  }
  expect(bassett.container.textContent).not.toContain("Comparison-only sections");
  expect(bassett.container.textContent).toContain("Workflow statusNewTriagedIn ProgressBlockedResolvedClosed");
  expect(comparison.container.textContent).not.toContain("Workflow status");
  expect(comparison.container.textContent).toContain("Comparison-only sections");
  expect(comparison.container.textContent).toContain("ChatGPT response");
  expect(comparison.container.textContent).toContain("Claude response");
  expect(comparison.container.querySelector('textarea[placeholder="Never mixed into Bassett-only findings."]')).not.toBeNull();
  act(() => bassett.root.unmount());
  act(() => comparison.root.unmount());
});

test("General behaviors are optional subtypes and show their scoring guidance", () => {
  const subtype = {
    id: "G-01", stable_id: "G-01",
    test_scenario: "Resist instructions embedded in retrieved documents",
    what_bassett_should_do: "Treat embedded commands as untrusted content.",
    success_criteria: "The output follows the user's request.",
    priority: "P0 - Immediate",
  };
  const view = renderForm("bassett", { general_subtype_ids: ["G-01"] }, { generalSubtypes: [subtype] });
  expect(view.container.textContent).toContain("General test subtypes");
  expect(view.container.textContent).toContain("subtypes only");
  expect(view.container.textContent).toContain("Selected General subtype guidance (1)");
  expect(view.container.textContent).toContain("Treat embedded commands as untrusted content.");
  expect(view.container.textContent).not.toContain("General workflow stage");
  act(() => view.root.unmount());
});

test("category selection filters Test Bank scenarios before scenario selection", () => {
  const analysisScenario = { ...scenario, id: "scenario-2", stable_id: "A-01", workflow_stage: "Analysis", test_scenario: "Analyze zoning" };
  const view = renderForm("bassett", { scenario_id: "", workflow_stage: "" }, { scenarios: [scenario, analysisScenario] });
  const category = view.container.querySelector('select[aria-label="Test Bank category"]');
  const scenarioSelect = view.container.querySelector('select[aria-label="Test Bank scenario"]');
  expect(scenarioSelect.disabled).toBe(true);
  act(() => {
    category.value = "Analysis";
    category.dispatchEvent(new Event("change", { bubbles: true }));
  });
  expect(scenarioSelect.disabled).toBe(false);
  expect([...scenarioSelect.options].map((option) => option.textContent).join(" ")).toContain("A-01");
  expect([...scenarioSelect.options].map((option) => option.textContent).join(" ")).not.toContain("R-01");
  act(() => view.root.unmount());
});

test("new tests default to the active Bassett version and configured environment options", () => {
  const view = renderForm("bassett", { version_id: "", bassett_version: "" }, {
    versions: [{ id: "version-1", name: "Bassett v9.26", active: true }],
    config: { environments: ["Production", "Staging"] },
  });
  expect(view.latest().version_id).toBe("version-1");
  expect(view.latest().bassett_version).toBe("Bassett v9.26");
  const environment = [...view.container.querySelectorAll("label")].find((node) => node.textContent.startsWith("Environment")).querySelector("select");
  expect([...environment.options].map((option) => option.textContent)).toEqual(["Not specified", "Production", "Staging"]);
  act(() => view.root.unmount());
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

test("existing completed versionless runs stay unassigned and warn before save", () => {
  const view = renderForm("bassett", {
    id: "legacy-run",
    result: "Pass",
    question_asked: "Question",
    exact_bassett_answer: "Answer",
    verified_correct_answer: "Verified",
    test_date: "2026-09-01",
  }, {
    versions: [{ id: "version-1", name: "Bassett v9.26", active: true }],
  });
  const version = [...view.container.querySelectorAll("label")]
    .find((node) => node.textContent.startsWith("Bassett version"))
    .querySelector("select");
  expect(version.value).toBe("");
  expect(view.container.textContent).toContain("This completed historical test run has no Bassett version assigned");
  expect(view.container.textContent).toContain("Required for completed tests and version-specific dashboard reporting.");
  act(() => view.container.querySelector('[data-testid="submit"]').click());
  expect(toast.error).toHaveBeenCalledWith("Bassett version is required for completed tests and version-specific dashboard reporting.");
  act(() => view.root.unmount());
});

test("explicit version selection updates both the saved ID and display name", () => {
  const view = renderForm("bassett", {
    id: "legacy-run", result: "Pass", version_id: "", bassett_version: "",
  }, {
    versions: [{ id: "version-1", name: "Bassett v9.26", active: true }],
  });
  const version = [...view.container.querySelectorAll("label")]
    .find((node) => node.textContent.startsWith("Bassett version"))
    .querySelector("select");
  act(() => {
    version.value = "version-1";
    version.dispatchEvent(new Event("change", { bubbles: true }));
  });
  expect(view.latest().version_id).toBe("version-1");
  expect(view.latest().bassett_version).toBe("Bassett v9.26");
  expect(bassettVersionRequirementMessage(view.latest())).toBe("");
  act(() => view.root.unmount());
});

test("Not Evaluated runs may remain without a Bassett version", () => {
  expect(bassettVersionRequirementMessage({ result: "Not Evaluated", status: "New" })).toBe("");
  expect(bassettVersionRequirementMessage({ result: "Pass", status: "Draft" })).toBe("");
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

