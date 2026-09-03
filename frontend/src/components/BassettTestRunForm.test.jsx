import { act } from "react";
import { createRoot } from "react-dom/client";
import { BassettTestRunForm, createBassettTestRunDraft } from "./BassettTestRunForm";
import { toast } from "sonner";

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

jest.mock("./forms", () => ({
  FormModal: ({ children, onOpenChange, onSubmit, submitDisabled }) => <div>
    {children}
    <button type="button" onClick={() => onOpenChange(false)}>Cancel</button>
    <button type="button" data-testid="submit" disabled={submitDisabled} onClick={onSubmit}>Record Test Run</button>
  </div>,
  Field: ({ label, children }) => <label>{label}{children}</label>,
}));

jest.mock("./ui/input", () => ({
  Input: (props) => <input {...props} />,
}));

jest.mock("./ui/textarea", () => ({
  Textarea: (props) => <textarea {...props} />,
}));

jest.mock("sonner", () => ({
  toast: { error: jest.fn() },
}));

const scenario = {
  id: "scenario-1", stable_id: "R-01", workflow_stage: "Research",
  report_type: "Property", test_scenario: "Setback research", complexity: "High",
  why_it_matters: "Prevents incorrect advice", what_bassett_should_do: "Read the ordinance",
  success_criteria: "Quotes the controlling section", priority: "P1 - High",
};

function renderForm(overrides = {}, props = {}) {
  const container = document.createElement("div");
  const root = createRoot(container);
  const form = createBassettTestRunDraft({ scenario_id: scenario.id, ...overrides });
  const defaults = {
    form, setForm: jest.fn(), scenarios: [scenario], versions: [], projects: [],
    onSubmit: jest.fn(), onCancel: jest.fn(),
  };
  act(() => root.render(<BassettTestRunForm {...defaults} {...props} />));
  return { container, root, form, ...defaults, ...props };
}

test("draft Test Date honors the configured timezone at a UTC boundary", () => {
  const instant = new Date("2026-09-01T02:00:00Z");
  expect(createBassettTestRunDraft({}, "Pacific/Honolulu", instant).test_date).toBe("2026-08-31");
  expect(createBassettTestRunDraft({}, "Asia/Tokyo", instant).test_date).toBe("2026-09-01");
});

test("shared run form shows every selected scenario definition field read-only", () => {
  const view = renderForm();
  expect(view.container.textContent).toContain("Read-only Test Bank definition");
  for (const value of [
    "R-01", "Research", "Property", "Setback research", "High",
    "Prevents incorrect advice", "Read the ordinance", "Quotes the controlling section", "P1 - High",
  ]) {
    expect(view.container.textContent).toContain(value);
  }
  expect(view.container.textContent).toContain("Question asked");
  expect(view.container.textContent).toContain("Exact Bassett answer");
  expect(view.container.textContent).toContain("Verified correct answer");
  expect(view.container.textContent).toContain("Evidence / context");
  expect(view.container.textContent).not.toContain("Score (0–100, optional)");
  act(() => view.root.unmount());
});

test("shared run form validates required execution fields before save", () => {
  const view = renderForm();
  act(() => view.container.querySelector('[data-testid="submit"]').click());
  expect(view.onSubmit).not.toHaveBeenCalled();
  expect(toast.error).toHaveBeenCalledWith("The question asked is required");
  act(() => view.root.unmount());
});

test("cancel closes the shared run form without submitting and submit locks while saving", () => {
  const view = renderForm({}, { submitting: true });
  expect(view.container.querySelector('[data-testid="submit"]').disabled).toBe(true);
  act(() => [...view.container.querySelectorAll("button")].find((button) => button.textContent === "Cancel").click());
  expect(view.onCancel).toHaveBeenCalledTimes(1);
  expect(view.onSubmit).not.toHaveBeenCalled();
  act(() => view.root.unmount());
});

