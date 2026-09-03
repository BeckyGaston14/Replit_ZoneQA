import { act } from "react";
import { createRoot } from "react-dom/client";
import Findings from "./Findings";
import { api } from "../lib/api";

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const findings = [
  {
    id: "f1", title: "Incorrect setback", criticality: 4, finding_type: "Accuracy",
    developer_status: "New", retest_status: "Pending", testcase_id: "t1",
    version_found: "Bassett v2", description: "The setback is incorrect.",
  },
  {
    id: "f2", title: "Missing citation", criticality: 3, finding_type: "Citation",
    developer_status: "Confirmed", retest_status: "Pending", testcase_id: "t2",
    version_found: "Bassett v2", description: "The citation is missing.",
  },
];

let mockSearchParams;
const mockSetSearchParams = jest.fn();
const mockNavigate = jest.fn();

jest.mock("react-router-dom", () => ({
  useSearchParams: () => [mockSearchParams, mockSetSearchParams],
  useNavigate: () => mockNavigate,
}), { virtual: true });

jest.mock("@tanstack/react-query", () => ({
  useQuery: () => ({ data: findings }),
  useQueryClient: () => ({ invalidateQueries: jest.fn() }),
}));

jest.mock("../lib/api", () => ({
  api: { get: jest.fn(() => Promise.resolve({ data: {} })), post: jest.fn(), put: jest.fn() },
  formatApiErrorDetail: (value) => String(value || ""),
  CRIT_COLORS: { 3: "#f59e0b", 4: "#f97316" },
}));
jest.mock("../lib/hooks", () => ({
  useConfig: () => ({ data: { finding_statuses: ["New", "Confirmed"], finding_types: ["Accuracy", "Citation"] } }),
}));
jest.mock("../lib/auth", () => ({ useAuth: () => ({ user: { role: "viewer" } }) }));
jest.mock("../components/shared", () => ({
  PageHeader: ({ title }) => <h1>{title}</h1>,
  CritBadge: ({ value }) => <span>C{value}</span>,
}));
jest.mock("../components/Attachments", () => ({ Attachments: () => <div>Attachments</div> }));
jest.mock("../components/CommentsThread", () => ({ CommentsThread: () => <div>Comments</div> }));
jest.mock("../components/AssigneePicker", () => ({ AssigneePicker: () => <div>Assignee</div> }));
jest.mock("../components/ui/button", () => ({
  Button: ({ children, size, variant, ...props }) => <button {...props}>{children}</button>,
}));
jest.mock("../components/forms", () => ({
  FormModal: ({ children }) => <div>{children}</div>,
  Field: ({ children }) => <div>{children}</div>,
  ListSelect: () => <select />,
}));
jest.mock("../components/ui/textarea", () => ({ Textarea: (props) => <textarea {...props} /> }));
jest.mock("../components/ui/input", () => ({ Input: (props) => <input {...props} /> }));
jest.mock("sonner", () => ({ toast: { success: jest.fn(), error: jest.fn() } }));

function renderFindings(params = "") {
  mockSearchParams = new URLSearchParams(params);
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => root.render(<Findings />));
  return {
    container,
    unmount: () => {
      act(() => root.unmount());
      container.remove();
    },
  };
}

beforeEach(() => {
  mockSetSearchParams.mockClear();
  mockNavigate.mockClear();
  api.get.mockResolvedValue({ data: {} });
  window.matchMedia = jest.fn(() => ({
    matches: false,
    addEventListener: jest.fn(),
    removeEventListener: jest.fn(),
  }));
});

test("uses the explicit Model Comparison Findings title", () => {
  const view = renderFindings();
  expect(view.container.querySelector("h1").textContent).toBe("Model Comparison Findings");
  expect(view.container.textContent).not.toContain("Bassett Findings");
  view.unmount();
});

test("finding rows open and close a URL-synchronized details panel", () => {
  const view = renderFindings();
  const rows = view.container.querySelectorAll('[data-testid="finding-row"]');

  act(() => rows[0].click());

  const panel = view.container.querySelector('[data-testid="finding-panel"]');
  expect(panel.textContent).toContain("Finding details");
  expect(panel.textContent).toContain("Incorrect setback");
  expect(rows[0].getAttribute("aria-pressed")).toBe("true");
  expect(mockSetSearchParams).toHaveBeenLastCalledWith(expect.objectContaining({}));
  expect(mockSetSearchParams.mock.calls.at(-1)[0].get("id")).toBe("f1");

  const close = panel.querySelector('[aria-label="Close finding details"]');
  act(() => close.click());

  expect(panel.className).toContain("hidden");
  expect(mockSetSearchParams.mock.calls.at(-1)[0].has("id")).toBe(false);
  view.unmount();
});

test("a finding deep link opens the matching panel", () => {
  const view = renderFindings("id=f2");

  const panel = view.container.querySelector('[data-testid="finding-panel"]');
  expect(panel.textContent).toContain("Missing citation");
  expect(view.container.querySelectorAll('[data-testid="finding-row"]')[1].getAttribute("aria-pressed")).toBe("true");
  view.unmount();
});

test("a stale finding deep link shows a safe return state", () => {
  const view = renderFindings("id=missing");
  expect(view.container.querySelector('[data-testid="finding-not-found"]').textContent).toContain("not found");
  act(() => view.container.querySelector('[data-testid="finding-not-found"] button').click());
  expect(mockSetSearchParams.mock.calls.at(-1)[0].has("id")).toBe(false);
  view.unmount();
});

test("the mobile details drawer is modal, closes with Escape, and restores row focus", () => {
  window.matchMedia = jest.fn(() => ({
    matches: true,
    addEventListener: jest.fn(),
    removeEventListener: jest.fn(),
  }));
  const raf = jest.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => callback());
  const view = renderFindings();
  const row = view.container.querySelector('[data-testid="finding-row"]');

  act(() => row.click());
  const panel = view.container.querySelector('[data-testid="finding-panel"]');
  expect(panel.getAttribute("role")).toBe("dialog");
  expect(panel.getAttribute("aria-modal")).toBe("true");
  expect(panel.getAttribute("aria-labelledby")).toBe("finding-details-heading");

  act(() => document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
  expect(mockSetSearchParams.mock.calls.at(-1)[0].has("id")).toBe(false);
  expect(document.activeElement).toBe(row);
  expect(document.body.style.overflow).toBe("");

  view.unmount();
  raf.mockRestore();
});