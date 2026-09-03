import { act } from "react";
import { createRoot } from "react-dom/client";
import TestCaseDetail from "./TestCaseDetail";

globalThis.IS_REACT_ACT_ENVIRONMENT = true;
let mockDetailSearch = new URLSearchParams();
const mockSetDetailSearch = jest.fn();

jest.mock("react-router-dom", () => ({
  Link: ({ children, to, ...props }) => <a href={to} {...props}>{children}</a>, useParams: () => ({ id: "tc-1" }), useNavigate: () => jest.fn(),
  useSearchParams: () => [mockDetailSearch, mockSetDetailSearch],
}), { virtual: true });
jest.mock("@tanstack/react-query", () => ({
  useQuery: ({ queryKey }) => ({ data: queryKey[0] === "tc-full" ? full : [], isLoading: false, isError: false }),
  useQueryClient: () => ({ invalidateQueries: jest.fn() }),
}));
jest.mock("../lib/hooks", () => ({ useConfig: () => ({ data: {} }) }));
jest.mock("../lib/auth", () => ({ useAuth: () => ({ user: { role: "admin" } }) }));
jest.mock("../lib/api", () => ({
  api: { get: jest.fn(), post: jest.fn(), put: jest.fn(), delete: jest.fn() },
  formatApiErrorDetail: () => "",
  staleUpdateMessage: (error) => error?.response?.status === 409 ? "stale update" : "",
  withExpectedVersion: (record, changes) => ({
    ...changes,
    ...(record?.updated_at ? { expected_updated_at: record.updated_at } : { expected_revision: record?.revision }),
  }),
  RESULT_COLORS: {},
}));
jest.mock("../components/shared", () => ({ CritBadge: () => null, ResultBadge: ({ value }) => <span>{value}</span>, ScorePill: ({ score }) => <span>{score}</span> }));
jest.mock("../components/AnnotatedResponse", () => ({ AnnotatedResponse: () => null }));
jest.mock("../components/CommentsThread", () => ({ CommentsThread: () => null }));
jest.mock("../components/AssigneePicker", () => ({ AssigneePicker: () => null }));
jest.mock("../components/ClaimsPanel", () => ({ ClaimsPanel: () => null }));
jest.mock("../components/Attachments", () => ({ Attachments: () => null }));
jest.mock("../components/TestCaseActions", () => ({ TestCaseActions: () => null }));
jest.mock("./Resources", () => ({ VerificationBadge: () => null }));
jest.mock("../components/ui/tabs", () => ({ Tabs: ({ children, value }) => <div data-testid="detail-tabs" data-value={value}>{children}</div>, TabsList: ({ children }) => <div>{children}</div>, TabsTrigger: ({ children }) => <button>{children}</button>, TabsContent: ({ children }) => <div>{children}</div> }));
jest.mock("../components/ui/button", () => ({ Button: ({ children, ...props }) => <button {...props}>{children}</button> }));
jest.mock("../components/ui/input", () => ({ Input: (props) => <input {...props} /> }));
jest.mock("../components/ui/textarea", () => ({ Textarea: (props) => <textarea {...props} /> }));
jest.mock("../components/forms", () => ({ FormModal: ({ children, onSubmit, title }) => <div data-modal-title={title}>{children}{onSubmit && <button data-testid="form-submit" onClick={onSubmit}>Submit form</button>}</div>, Field: ({ children }) => <div>{children}</div>, ListSelect: () => null }));
jest.mock("../components/SortableTableHeader", () => ({ SortableTableHeader: () => <th /> }));
jest.mock("../components/TableSortControls", () => ({ TableSortControls: () => null }));
jest.mock("../lib/tableSorting", () => ({ nextSort: jest.fn(), sortTableRows: (rows) => rows, usePersistentTableSort: () => [{ key: "model", direction: "asc" }, jest.fn()] }));
jest.mock("sonner", () => ({ toast: { success: jest.fn(), error: jest.fn(), info: jest.fn() } }));

const full = {
  testcase: {
    id: "tc-1", name: "Comparison", prompts: [{ turn: 1, text: "Prompt" }],
    expected_behaviors: [{ text: "Answer accurately", status: "Not Met" }],
    status: "Testing", revision: 4, updated_at: "2026-09-01T05:00:00+00:00",
  },
  responses: [{ id: "b", model: "Bassett", run_id: "run-1", turn: 1, response: "answer", superseded: false }],
  evaluations: [{
    id: "eval-1", testcase_id: "tc-1", run_id: "run-1", model: "Bassett",
    scores: { accuracy: 9 }, final_result: "Pass", revision: 2, updated_at: "2026-09-01T04:00:00+00:00",
  }],
  findings: [], retests: [], activities: [], evidence: [], annotations: [], claims: [], variants: [],
  test_runs: [{ id: "run-1", models: ["Bassett", "ChatGPT", "Claude"], status: "Completed with Errors", slot_status: { Bassett: "completed", ChatGPT: "failed", Claude: "unavailable" } }],
};

beforeEach(() => {
  mockDetailSearch = new URLSearchParams();
  mockSetDetailSearch.mockClear();
});

test("a direct Test Case Detail tab link restores the selected tab", () => {
  mockDetailSearch = new URLSearchParams("tab=findings");
  const container = document.createElement("div");
  const root = createRoot(container);
  act(() => root.render(<TestCaseDetail />));
  expect(container.querySelector('[data-testid="detail-tabs"]').getAttribute("data-value")).toBe("findings");
  act(() => root.unmount());
});

test("shows all comparison slots and labels failed slots incomplete", () => {
  const container = document.createElement("div");
  const root = createRoot(container);
  act(() => root.render(<TestCaseDetail />));
  expect(container.querySelector("[data-testid='slot-status-Bassett']").textContent).toContain("Completed");
  expect(container.querySelector("[data-testid='slot-status-ChatGPT']").textContent).toContain("Incomplete");
  expect(container.querySelector("[data-testid='slot-status-Claude']").textContent).toContain("Incomplete");
  expect(container.textContent).toContain("Resume Incomplete (2)");
  const completedWithErrors = container.querySelector('[aria-label^="Completed with Errors."]');
  expect(completedWithErrors).not.toBeNull();
  expect(completedWithErrors.textContent).toContain("Completed with Errors");
  expect(completedWithErrors.getAttribute("aria-label")).toContain("one or more model slots failed or were unavailable");
  expect(container.querySelector('[aria-label="Resume incomplete ChatGPT response"]')).not.toBeNull();
  expect(container.querySelector('[aria-label="Resume incomplete Claude response"]')).not.toBeNull();
  expect(container.querySelector("[data-testid='resp-col-ChatGPT']").className).toContain("min-w-0");
  act(() => root.unmount());
});

test("an expanded comparison links back to the unchanged original Bassett Test Run", () => {
  full.testcase.bassett_issue_id = "bassett-run-1";
  const container = document.createElement("div");
  const root = createRoot(container);
  act(() => root.render(<TestCaseDetail />));
  const originalRunLink = container.querySelector("[data-testid='back-to-bassett-run']");
  expect(originalRunLink.textContent).toContain("Original Bassett Test Run");
  expect(originalRunLink.getAttribute("href")).toBe("/bassett/issues?open=bassett-run-1");
  act(() => root.unmount());
  delete full.testcase.bassett_issue_id;
});

test("behavior verdict save includes the fetched test case version", async () => {
  const { api } = require("../lib/api");
  api.post.mockImplementation((url) => Promise.resolve({ data: url === "/evaluations/score-preview" ? {
    overall_score: 9,
    system_recommended: "Pass",
    system_explanation: "Server-calculated recommendation.",
  } : {} }));
  api.put.mockResolvedValue({ data: {} });
  const container = document.createElement("div");
  const root = createRoot(container);
  act(() => root.render(<TestCaseDetail />));

  await act(async () => {
    container.querySelector("[data-testid='eval-Bassett-btn']").click();
    await Promise.resolve();
    await Promise.resolve();
  });
  await act(async () => {
    container.querySelector("[data-modal-title='Evaluate — Bassett'] [data-testid='form-submit']").click();
  });

  expect(api.put).toHaveBeenCalledWith("/testcases/tc-1", expect.objectContaining({
    expected_updated_at: "2026-09-01T05:00:00+00:00",
    expected_behaviors: [{ text: "Answer accurately", status: "Not Met" }],
  }));
  act(() => root.unmount());
});