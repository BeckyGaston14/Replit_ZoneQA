import { act } from "react";
import { createRoot } from "react-dom/client";
import BassettIssues, { BassettRunActions, ScenarioSelector, actionError, loadBassettTestRunForEdit, persistBassettTestRun } from "./BassettIssues";
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
  CritBadge: ({ value }) => <span>C{value}</span>,
  HowCalculated: () => null,
  MethodologyDisclosure: ({ title, children }) => <details><summary>{title}</summary>{children}</details>,
}));

jest.mock("../components/ui/button", () => ({
  Button: ({ children, asChild, ...props }) => asChild ? children : <button {...props}>{children}</button>,
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
  api: { get: jest.fn(() => Promise.resolve({ data: [] })), post: jest.fn(), put: jest.fn() },
  formatApiErrorDetail: (detail) => String(detail || ""),
  staleUpdateMessage: () => "",
  withExpectedVersion: (_form, body) => body,
}));

jest.mock("@tanstack/react-query", () => ({
  useQuery: ({ queryKey }) => ({
    data: queryKey[0] === "bassett-metrics"
      ? { issues: { open: 0, new: 0, critical: 0 }, test_runs: { attention: 2, pass_rate: 50, passed: 1, eligible: 2, test_bank_coverage: { percent: 75, covered: 3, total: 4 } }, scenarios: { active: 4 } }
      : queryKey[0] === "bassett-test-runs"
        ? mockIssues
      : queryKey[0] === "bassett-issue"
        ? mockIssues.find((issue) => issue.id === queryKey[1])
      : queryKey[0] === "bassett-finding"
        ? { id: queryKey[1], title: "Conversation finding", description: "Needs review", developer_status: "New", criticality: "High", bassett_issue_id: "run-1" }
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

jest.mock("../components/CommentsThread", () => ({
  CommentsThread: () => null,
}));

jest.mock("../components/AssigneePicker", () => ({
  AssigneePicker: () => null,
}));

jest.mock("../components/forms", () => ({
  FormModal: () => null,
  Field: ({ children }) => children,
  ListSelect: () => <select />,
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
  expect(container.textContent).toContain("Workflow status");
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
  expect(container.textContent).toContain("Model Comparison Findings");
  const header = container.querySelector("header");
  const navigation = header.querySelector('[data-testid="findings-cross-navigation"]');
  const contextualShortcut = header.querySelector('a[href="/bassett/issues"]');
  expect(navigation).not.toBeNull();
  expect(contextualShortcut).not.toBeNull();
  expect(navigation.compareDocumentPosition(contextualShortcut) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  expect(contextualShortcut.textContent).toBe("Bassett Test Runs");
  expect(contextualShortcut.querySelector("button")).toBeNull();
  expect(container.textContent).toContain("Select a Bassett finding to view its details.");
  const additionalFilters = container.querySelector("details");
  expect(additionalFilters.querySelector('[aria-label="Filter by Workflow status"]')).not.toBeNull();
  expect(additionalFilters.querySelector('[aria-label="Filter by retest status"]')).not.toBeNull();
  act(() => root.unmount());
});

test("Bassett finding detail links back to its source run", () => {
  mockBassettSearchParams = new URLSearchParams("view=findings&open=finding-1");
  const container = document.createElement("div");
  const root = createRoot(container);
  act(() => root.render(<BassettIssues />));
  expect(container.querySelector('a[href="/bassett/issues?open=run-1"]').textContent).toContain("run-1");
  act(() => root.unmount());
});

test("save orchestration persists the run before uploading new-run files", async () => {
  const existingApi = {
    put: jest.fn(() => Promise.resolve({ data: {} })),
    post: jest.fn(() => Promise.resolve({ data: {} })),
  };
  await persistBassettTestRun({
    id: "run-1",
    create_finding: true,
    finding_turn_id: "turn-2",
    issue_category: "citation problem",
    finding: { title: "Turn finding", description: "Needs review", finding_type: "citation problem", finding_type_detail: "" },
  }, existingApi);
  expect(existingApi.put).toHaveBeenCalledWith("/bassett/issues/run-1", expect.any(Object));
  expect(existingApi.post).toHaveBeenCalledWith("/bassett/issues/run-1/convert-to-finding", {
    title: "Turn finding", description: "Needs review", expected_behavior: undefined,
    finding_type: "citation problem", finding_type_detail: "", turn_id: "turn-2",
  });

  const file = new File(["evidence"], "evidence.txt", { type: "text/plain" });
  const createApi = { post: jest.fn(() => Promise.resolve({ data: { issue: { id: "run-2" } } })) };
  const result = await persistBassettTestRun({ attachments: [file], scenario_id: "scenario-1" }, createApi);
  expect(result.issueId).toBe("run-2");
  expect(createApi.post.mock.calls[0]).toEqual([
    "/bassett/issues/workflow-json",
    expect.objectContaining({
      scenario_id: "scenario-1",
      pending_attachment_count: 1,
      pending_conversation_attachment: false,
    }),
  ]);
  expect(createApi.post.mock.calls[1][0]).toBe("/attachments/upload");
  expect(createApi.post.mock.calls[1][1].get("file")).toBe(file);

  const conversationFile = new File(["conversation"], "conversation.pdf", { type: "application/pdf" });
  const sourceFile = new File(["ordinance"], "ordinance.pdf", { type: "application/pdf" });
  await persistBassettTestRun({ conversation_attachment: conversationFile, attachments: [sourceFile], scenario_id: "scenario-1" }, createApi);
  expect(createApi.post.mock.calls[2]).toEqual([
    "/bassett/issues/workflow-json",
    expect.objectContaining({
      scenario_id: "scenario-1",
      pending_attachment_count: 2,
      pending_conversation_attachment: true,
    }),
  ]);
  expect(createApi.post.mock.calls[2][1]).not.toHaveProperty("conversation_attachment");
  expect(createApi.post.mock.calls[3][1].get("file")).toBe(conversationFile);
  expect(createApi.post.mock.calls[4][1].get("file")).toBe(sourceFile);

  const failure = { response: { status: 400, data: { detail: "Finding turn linkage is invalid" } } };
  await expect(persistBassettTestRun({ id: "run-3", create_finding: true }, {
    put: jest.fn(() => Promise.resolve({ data: {} })),
    post: jest.fn(() => Promise.reject(failure)),
  })).rejects.toBe(failure);
  expect(actionError(failure, "Unable to save test run")).toBe("Finding turn linkage is invalid");
  expect(actionError({ response: { status: 500, data: {} } }, "Unable to save test run")).toContain("entries are still open");
  expect(actionError({}, "Unable to save test run")).toContain("server could not be reached");
});

test("editing preserves concurrency fields and does not upload existing attachment metadata", async () => {
  const existingApi = {
    put: jest.fn(() => Promise.resolve({ data: {} })),
    post: jest.fn(),
  };
  await persistBassettTestRun({
    id: "run-1",
    revision: 8,
    updated_at: "2026-09-08T12:00:00Z",
    attachments: [{ id: "attachment-1", original_filename: "ordinance.pdf" }],
  }, existingApi);
  expect(existingApi.put).toHaveBeenCalledWith("/bassett/issues/run-1", expect.objectContaining({
    revision: 8,
    updated_at: "2026-09-08T12:00:00Z",
  }));
  expect(existingApi.put.mock.calls[0][1]).not.toHaveProperty("attachments");
  expect(existingApi.post).not.toHaveBeenCalled();
});

test("supporting uploads can become linked Ordinance Evidence without duplicate test-run attachments", async () => {
  const file = new File(["ordinance"], "zoning-code.pdf", { type: "application/pdf" });
  const apiClient = {
    post: jest.fn((url) => {
      if (url === "/bassett/issues/workflow-json") return Promise.resolve({ data: { issue: { id: "run-4", revision: 1, updated_at: "2026-09-24T12:00:00Z" } } });
      if (url === "/evidence") return Promise.resolve({ data: { id: "evidence-4" } });
      return Promise.resolve({ data: {} });
    }),
    put: jest.fn(() => Promise.resolve({ data: {} })),
  };

  const result = await persistBassettTestRun({
    title: "Ordinance test",
    scenario_id: "scenario-1",
    municipality_id: "municipality-1",
    evidence_ids: ["existing-evidence"],
    attachments: [file],
    create_evidence_from_uploads: true,
  }, apiClient);

  expect(result).toEqual(expect.objectContaining({ issueId: "run-4", uploadFailures: 0, evidenceFailures: 0 }));
  expect(apiClient.post).toHaveBeenCalledWith("/evidence", expect.objectContaining({
    document_name: "zoning-code.pdf", municipality_id: "municipality-1", verification_status: "Unverified",
  }));
  const uploads = apiClient.post.mock.calls.filter(([url]) => url === "/attachments/upload");
  expect(uploads).toHaveLength(1);
  expect(uploads[0][1].get("entity_type")).toBe("evidence");
  expect(apiClient.put).toHaveBeenCalledWith("/bassett/issues/run-4", expect.objectContaining({
    evidence_ids: ["existing-evidence", "evidence-4"],
  }));
});

test("scenario selector searches and displays the full scenario identity", () => {
  const container = document.createElement("div");
  const root = createRoot(container);
  const onChange = jest.fn();
  act(() => {
    root.render(<ScenarioSelector value="" category="Research" onCategoryChange={jest.fn()} onChange={onChange} scenarios={[
      { id: "one", stable_id: "R-01", test_scenario: "Setback research", workflow_stage: "Research", priority: "High" },
      { id: "two", stable_id: "A-01", test_scenario: "Analysis review", workflow_stage: "Analysis", priority: "Low" },
    ]} />);
  });
  const scenarioPicker = container.querySelector('button[aria-label="Test Scenario"]');
  act(() => scenarioPicker.click());
  expect(container.textContent).toContain("R-01 · Setback research");
  expect(container.textContent).toContain("Research · High");
  const search = container.querySelector('input[aria-label="Search Test Scenario records"]');
  act(() => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set;
    setter.call(search, "setback");
    search.dispatchEvent(new Event("input", { bubbles: true }));
  });
  expect(container.textContent).toContain("R-01 · Setback research");
  expect(container.textContent).not.toContain("A-01 · Analysis review");
  act(() => root.unmount());
});

test("scenario selector presents General Research consistently as Research", () => {
  const container = document.createElement("div");
  const root = createRoot(container);
  act(() => {
    root.render(<ScenarioSelector value="" category="General Research" onCategoryChange={jest.fn()} onChange={jest.fn()} scenarios={[
      { id: "one", stable_id: "R-01", test_scenario: "Property research", workflow_stage: "Research", test_type: "General Research", catalog_revision: "2026-09-16", priority: "P0 - Immediate" },
    ]} />);
  });
  expect(container.textContent).toContain("Research");
  expect(container.textContent).not.toContain("General Research");
  const scenarioPicker = container.querySelector('button[aria-label="Test Scenario"]');
  act(() => scenarioPicker.click());
  expect(container.textContent).toContain("Research · P0 - Immediate");
  act(() => root.unmount());
});

test("attention test runs expose current result and follow-up actions", () => {
  const container = document.createElement("div");
  const root = createRoot(container);
  act(() => {
    root.render(<ScenarioDetail id="scenario-1" canManage={false} canExecute close={jest.fn()} edit={jest.fn()} run={jest.fn()} archive={jest.fn()} />);
  });
  expect(container.textContent).toContain("Canonical Bassett Test Runs");
  expect(container.textContent).toContain("Needs Improvement");
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
  expect(container.textContent).toContain("Scenario coverage75%");
  act(() => root.unmount());

  const bankContainer = document.createElement("div");
  const bankRoot = createRoot(bankContainer);
  act(() => bankRoot.render(<BassettTestBank />));
  expect(bankContainer.textContent).toContain("Scenario coverage3");
  expect(bankContainer.textContent).toContain("Pass rate50%");
  expect(bankContainer.textContent).toContain("Tests Needing Attention2");
  act(() => bankRoot.unmount());
});

test("test results use the current vocabulary when legacy values are supplied", () => {
  const container = document.createElement("div");
  const root = createRoot(container);
  act(() => {
    root.render(<><ResultPill value="Pass with Notes" /><ResultPill value="Incomplete" /></>);
  });
  expect(container.textContent).toContain("Pass with Minor Issues");
  expect(container.textContent).toContain("Not Evaluated");
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
  expect(drawer.querySelector('a[href="/bassett/findings?open=finding-1"]').textContent).toContain("Bassett Finding");
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

test("row edit loads the complete current test run before opening the form", async () => {
  const issue = { id: "run-615", title: "615 Bland Boulevard", revision: 7, updated_at: "2026-09-08T12:00:00Z" };
  const complete = {
    ...issue,
    scenario: { id: "scenario-1", stable_id: "R-01" },
    evaluation_scores: { accuracy: 9 },
    attachments: [{ id: "attachment-1", original_filename: "ordinance.pdf" }],
    history: [{ id: "history-1", action: "created" }],
    status: "In Progress",
  };
  const apiClient = { get: jest.fn(() => Promise.resolve({ data: complete })) };

  await expect(loadBassettTestRunForEdit(issue, apiClient)).resolves.toBe(complete);
  expect(apiClient.get).toHaveBeenCalledWith("/bassett/issues/run-615");
});

test("authorized active rows expose direct edit and lifecycle actions with accessible names", () => {
  const issue = { id: "run-615", title: "615 Bland Boulevard", status: "New" };
  const onEdit = jest.fn();
  const onArchive = jest.fn();
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);

  act(() => root.render(<BassettRunActions issue={issue} canWrite canManage onEdit={onEdit} onArchive={onArchive} onRestore={jest.fn()} />));

  const edit = container.querySelector('button[aria-label="Edit 615 Bland Boulevard"]');
  const archive = container.querySelector('button[aria-label="Archive 615 Bland Boulevard"]');
  const actions = container.querySelector('button[aria-label="Actions for 615 Bland Boulevard"]');
  expect(edit).not.toBeNull();
  expect(edit.title).toBe("Edit 615 Bland Boulevard");
  expect(archive).not.toBeNull();
  expect(actions).toBeNull();
  act(() => edit.click());
  expect(onEdit).toHaveBeenCalledWith(issue);
  act(() => archive.click());
  expect(onArchive).toHaveBeenCalledWith(issue);

  act(() => root.unmount());
  container.remove();
});

test("narrow layouts retain direct pencil and lifecycle controls without an ellipsis menu", () => {
  const issue = { id: "run-615", title: "615 Bland Boulevard", status: "New" };
  const onEdit = jest.fn();
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);

  act(() => root.render(<BassettRunActions issue={issue} canWrite canManage onEdit={onEdit} onArchive={jest.fn()} onRestore={jest.fn()} />));
  const edit = container.querySelector('button[aria-label="Edit 615 Bland Boulevard"]');
  const archive = container.querySelector('button[aria-label="Archive 615 Bland Boulevard"]');
  expect(edit).not.toBeNull();
  expect(archive).not.toBeNull();
  expect(container.querySelector('button[aria-label="Actions for 615 Bland Boulevard"]')).toBeNull();
  act(() => edit.click());
  expect(onEdit).toHaveBeenCalledWith(issue);

  act(() => root.unmount());
  container.remove();
});

test("viewers, archived rows, and read-only rows never expose an enabled edit control", () => {
  const issue = { id: "run-1", title: "A test run", status: "New" };
  const archived = { ...issue, status: "Archived", archived: true };
  const readOnly = { ...issue, read_only: true };
  const container = document.createElement("div");
  const root = createRoot(container);
  document.body.appendChild(container);

  act(() => root.render(<BassettRunActions issue={issue} canWrite={false} canManage={false} onEdit={jest.fn()} onArchive={jest.fn()} onRestore={jest.fn()} />));
  expect(container.querySelector("button")).toBeNull();
  act(() => root.render(<BassettRunActions issue={archived} canWrite canManage onEdit={jest.fn()} onArchive={jest.fn()} onRestore={jest.fn()} />));
  expect(container.querySelector('button[aria-label="Edit A test run"]')).toBeNull();
  expect(container.querySelector('button[aria-label="Restore A test run"]')).not.toBeNull();
  act(() => root.render(<BassettRunActions issue={readOnly} canWrite canManage={false} onEdit={jest.fn()} onArchive={jest.fn()} onRestore={jest.fn()} />));
  expect(container.querySelector("button")).toBeNull();

  act(() => root.unmount());
  container.remove();
});

