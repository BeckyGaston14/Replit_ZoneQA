import { act } from "react";
import { createRoot } from "react-dom/client";
import BassettIssues, { ScenarioSelector } from "./BassettIssues";
import BassettTestBank, { ResultPill, ScenarioDetail } from "./BassettTestBank";

globalThis.IS_REACT_ACT_ENVIRONMENT = true;
let mockIssues = [];
let mockIssueLoading = false;
let mockBassettSearchParams = new URLSearchParams();

jest.mock("react-router-dom", () => ({
  Link: ({ children, to }) => <a href={to}>{children}</a>,
  useNavigate: () => jest.fn(),
  useSearchParams: () => [mockBassettSearchParams, jest.fn()],
}), { virtual: true });

jest.mock("../components/shared", () => ({
  PageHeader: ({ title, children }) => <header><h1>{title}</h1>{children}</header>,
  Section: ({ title, children }) => <section><h2>{title}</h2>{children}</section>,
  StatCard: ({ label, value }) => <div><span>{label}</span><span>{value}</span></div>,
}));

jest.mock("../components/ui/button", () => ({
  Button: ({ children, ...props }) => <button {...props}>{children}</button>,
}));

jest.mock("../components/ui/input", () => ({
  Input: (props) => <input {...props} />,
}));

jest.mock("../components/ui/textarea", () => ({
  Textarea: (props) => <textarea {...props} />,
}));

jest.mock("../lib/auth", () => ({
  useAuth: () => ({ user: { id: "viewer-1", role: "viewer", name: "Viewer" } }),
}));

jest.mock("../lib/api", () => ({
  api: { get: jest.fn(() => Promise.resolve({ data: [] })) },
  formatApiErrorDetail: (detail) => String(detail || ""),
}));

jest.mock("@tanstack/react-query", () => ({
  useQuery: ({ queryKey }) => ({
    data: queryKey[0] === "bassett-metrics"
      ? { issues: { open: 0, new: 0, critical: 0 }, test_runs: { attention: 2, pass_rate: 50, passed: 1, eligible: 2, test_bank_coverage: { percent: 75, covered: 3, total: 4 } }, scenarios: { active: 4 } }
      : queryKey[0] === "bassett-test-runs"
        ? mockIssues
      : queryKey[0] === "bassett-issue"
        ? mockIssues.find((issue) => issue.id === queryKey[1])
      : queryKey[0] === "bassett-scenario"
        ? { id: "scenario-1", stable_id: "R-01", test_scenario: "Setback research", workflow_stage: "Research", report_type: "Property", complexity: "Medium", issues: [{ id: "run-1", result: "Partial", status: "New", test_date: "2025-01-01", question_asked: "Question" }], executions: [] }
        : [],
    isLoading: queryKey[0] === "bassett-issue" ? mockIssueLoading : false,
  }),
  useQueryClient: () => ({ invalidateQueries: jest.fn() }),
}));

jest.mock("../components/Attachments", () => ({
  Attachments: () => null,
}));

jest.mock("../components/forms", () => ({
  FormModal: () => null,
  Field: ({ children }) => children,
}));

jest.mock("sonner", () => ({
  toast: { success: jest.fn(), error: jest.fn() },
}));

beforeEach(() => {
  mockIssues = [];
  mockIssueLoading = false;
  mockBassettSearchParams = new URLSearchParams();
});

test("Bassett Test Runs page uses test-run terminology and no retired issue labels", () => {
  const container = document.createElement("div");
  const root = createRoot(container);

  act(() => {
    root.render(<BassettIssues />);
  });

  expect(container.textContent).toContain("Bassett Test Runs");
  expect(container.textContent).toContain("Tests Needing Attention");
  expect(container.textContent).toContain("Test Status");
  expect(container.textContent).not.toMatch(/issues to address|issue register|record issue|loading issues|bassett only tests/i);
  act(() => root.unmount());
});

test("Bassett findings view is explicitly labeled and stays in the Bassett-only workspace", () => {
  mockBassettSearchParams = new URLSearchParams("view=findings");
  const container = document.createElement("div");
  const root = createRoot(container);
  act(() => root.render(<BassettIssues />));
  expect(container.querySelector("h1").textContent).toBe("Bassett Findings");
  expect(container.textContent).toContain("Bassett Test Runs");
  expect(container.textContent).not.toContain("Model Comparison Findings");
  act(() => root.unmount());
});

test("scenario selector searches and displays the full scenario identity", () => {
  const container = document.createElement("div");
  const root = createRoot(container);
  const onChange = jest.fn();
  act(() => {
    root.render(<ScenarioSelector value="" onChange={onChange} scenarios={[
      { id: "one", stable_id: "R-01", test_scenario: "Setback research", workflow_stage: "Research", priority: "High" },
      { id: "two", stable_id: "A-01", test_scenario: "Analysis review", workflow_stage: "Analysis", priority: "Low" },
    ]} />);
  });
  expect(container.textContent).toContain("R-01 · Setback research · Research · High");
  const search = container.querySelector('input[aria-label="Search Test Bank scenarios"]');
  act(() => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set;
    setter.call(search, "analysis");
    search.dispatchEvent(new Event("input", { bubbles: true }));
  });
  expect(container.textContent).toContain("A-01 · Analysis review · Analysis · Low");
  expect(container.textContent).not.toContain("R-01 · Setback research");
  act(() => root.unmount());
});

test("attention test runs expose current result and follow-up actions", () => {
  const container = document.createElement("div");
  const root = createRoot(container);
  act(() => {
    root.render(<ScenarioDetail id="scenario-1" canManage={false} canExecute close={jest.fn()} edit={jest.fn()} run={jest.fn()} archive={jest.fn()} />);
  });
  expect(container.textContent).toContain("Canonical Bassett Test Runs");
  expect(container.textContent).toContain("Partial");
  expect(container.textContent).toContain("Test Date:");
  expect(container.textContent).toContain("Open Run");
  expect(container.querySelector('a').getAttribute("href")).toBe("/bassett/issues?open=run-1");
  expect(container.textContent).not.toMatch(/linked issues|execution history/i);
  act(() => root.unmount());
});

test("dashboards render canonical attention and coverage metrics", () => {
  const container = document.createElement("div");
  const root = createRoot(container);
  act(() => root.render(<BassettIssues />));
  expect(container.textContent).toContain("Tests Needing Attention2");
  expect(container.textContent).toContain("Evaluated scenario coverage75%");
  act(() => root.unmount());

  const bankContainer = document.createElement("div");
  const bankRoot = createRoot(bankContainer);
  act(() => bankRoot.render(<BassettTestBank />));
  expect(bankContainer.textContent).toContain("Test Runs Completed3");
  expect(bankContainer.textContent).toContain("Pass rate50%");
  expect(bankContainer.textContent).toContain("Tests Needing Attention2");
  act(() => bankRoot.unmount());
});

test("test results use the current vocabulary and visibly mark legacy incomplete results", () => {
  const container = document.createElement("div");
  const root = createRoot(container);
  act(() => {
    root.render(<><ResultPill value="Pass with Notes" /><ResultPill value="Incomplete" /></>);
  });
  expect(container.textContent).toContain("Pass with Notes");
  expect(container.textContent).toContain("Legacy: Incomplete");
  act(() => root.unmount());
});

test("viewer rows use a named button and the async details drawer traps and restores focus", () => {
  mockIssues = [{
    id: "run-1",
    title: "Setback answer check",
    question_asked: "What is the setback?",
    exact_bassett_answer: "Ten feet",
    verified_correct_answer: "Ten feet",
    severity: "Low",
    status: "New",
    result: "Fail",
    environment: "Staging",
    test_date: "2025-01-01",
    testcase_id: "test-1",
    finding_id: "finding-1",
    finding: { id: "finding-1" },
    history: [],
  }];
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => root.render(<BassettIssues />));

  const openButton = container.querySelector('button[aria-label="Open Setback answer check"]');
  expect(openButton).not.toBeNull();
  expect(container.querySelector('button[aria-label^="Archive "]')).toBeNull();
  expect(container.textContent).not.toContain("New Test Run");

  openButton.focus();
  mockIssueLoading = true;
  act(() => openButton.click());
  let drawer = document.body.querySelector('[role="dialog"][aria-modal="true"]');
  expect(drawer).not.toBeNull();
  expect(drawer.textContent).toContain("Loading Test Run Details");

  mockIssueLoading = false;
  act(() => root.render(<BassettIssues />));
  drawer = document.body.querySelector('[role="dialog"][aria-modal="true"]');
  expect(document.activeElement.getAttribute("aria-label")).toBe("Close Test Run Details");
  expect(drawer.textContent).not.toContain("Edit Test Run");
  expect(drawer.querySelector("a button")).toBeNull();
  expect(drawer.textContent).toContain("Bassett Finding");
  expect(drawer.querySelector('a[href="/bassett/findings?open=finding-1"]').textContent).toBe("Open Bassett Finding");
  expect(drawer.querySelector('a[href="/testcases/test-1"]').textContent).toBe("Open Model Comparison Test Case");
  act(() => {
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", bubbles: true }));
  });
  expect(document.activeElement.getAttribute("aria-label")).toBe("Close Test Run Details");

  act(() => {
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  });
  expect(document.body.querySelector('[role="dialog"][aria-modal="true"]')).toBeNull();
  expect(document.activeElement).toBe(openButton);
  act(() => root.unmount());
  container.remove();
});

