import { act } from "react";
import { createRoot } from "react-dom/client";

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

jest.mock("@tanstack/react-query", () => ({
  useMutation: () => ({ mutate: jest.fn() }),
  useQueryClient: () => ({ invalidateQueries: jest.fn() }),
}));
jest.mock("../lib/api", () => ({
  api: { get: jest.fn(), post: jest.fn(), delete: jest.fn() },
  formatApiErrorDetail: (detail) => String(detail || ""),
}));
let mockRole = "admin";
jest.mock("../lib/auth", () => ({ useAuth: () => ({ user: { role: mockRole } }) }));
jest.mock("../components/shared", () => ({ PageHeader: ({ title, children }) => <header><h1>{title}</h1>{children}</header> }));
jest.mock("../components/forms", () => ({
  FormModal: ({ open, onSubmit, children }) => open ? <div>{children}<button onClick={onSubmit}>Save modal</button></div> : null, Field: ({ children }) => children, SelectOrAdd: () => null, ListSelect: () => null, DimSelect: () => null,
}));
jest.mock("../components/Attachments", () => ({ Attachments: () => null }));
jest.mock("./SortableTableHeader", () => ({ SortableTableHeader: ({ column }) => <th>{column.label}</th> }));
jest.mock("./TableSortControls", () => ({ TableSortControls: () => null }));
jest.mock("../lib/tableSorting", () => ({
  nextSort: jest.fn(), sortTableRows: (rows) => rows, usePersistentTableSort: () => [{ key: "name", direction: "asc" }, jest.fn()],
}));
jest.mock("../lib/hooks", () => ({
  useCollection: (name) => ({
    data: name === "projects"
      ? [{ id: "project-active", name: "Active project" }, { id: "project-archived", name: "Archived project", archived: true }]
      : [],
  }),
  useSavedView: (_page, defaultState) => {
    const React = require("react");
    const [state, updateState] = React.useState(defaultState);
    return { state, updateState, error: "", clearError: jest.fn() };
  },
  useSave: () => ({ mutate: (...args) => global.__resourceSaveMutate?.(...args) }), useDelete: () => ({ mutate: jest.fn() }), useConfig: () => ({ data: {} }),
}));
jest.mock("./ui/button", () => ({ Button: ({ children, ...props }) => <button {...props}>{children}</button> }));
jest.mock("./ui/input", () => ({ Input: (props) => <input {...props} /> }));
jest.mock("./ui/textarea", () => ({ Textarea: (props) => <textarea {...props} /> }));
jest.mock("./ui/dropdown-menu", () => ({
  DropdownMenu: ({ children }) => <>{children}</>,
  DropdownMenuTrigger: ({ children }) => children,
  DropdownMenuContent: ({ children }) => <div>{children}</div>,
  DropdownMenuItem: ({ children, onSelect, ...props }) => <button {...props} onClick={onSelect}>{children}</button>,
  DropdownMenuLabel: ({ children }) => <span>{children}</span>,
  DropdownMenuSeparator: () => null,
}));
jest.mock("./ui/alert-dialog", () => ({
  AlertDialog: ({ children, open }) => open ? <div>{children}</div> : null,
  AlertDialogContent: ({ children }) => <div>{children}</div>,
  AlertDialogHeader: ({ children }) => <div>{children}</div>,
  AlertDialogTitle: ({ children }) => <h2>{children}</h2>,
  AlertDialogDescription: ({ children }) => <p>{children}</p>,
  AlertDialogFooter: ({ children }) => <div>{children}</div>,
  AlertDialogAction: ({ children, ...props }) => <button {...props}>{children}</button>,
  AlertDialogCancel: ({ children }) => <button>{children}</button>,
}));
jest.mock("./ui/dialog", () => ({
  Dialog: ({ children, open }) => open ? <div>{children}</div> : null,
  DialogContent: ({ children }) => <div>{children}</div>,
  DialogHeader: ({ children }) => <div>{children}</div>,
  DialogTitle: ({ children }) => <h2>{children}</h2>,
  DialogDescription: ({ children }) => <p>{children}</p>,
  DialogFooter: ({ children }) => <div>{children}</div>,
}));
jest.mock("sonner", () => ({ toast: { success: jest.fn(), error: jest.fn() } }));

const ResourceList = require("./ResourceList").default;
const { api: mockApi } = require("../lib/api");

const click = (element) => act(() => element.dispatchEvent(new MouseEvent("click", { bubbles: true })));
const setInput = (element, value) => {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set;
  setter.call(element, value);
  element.dispatchEvent(new Event("input", { bubbles: true }));
};

test("stale resource save tells the reviewer to reload and review", async () => {
  global.__resourceSaveMutate = (_record, options) => options.onError({ response: { status: 409, data: { detail: "stale" } } });
  mockApi.get.mockResolvedValueOnce({ data: [{ id: "project-active", name: "Fresh project", revision: 2 }] });
  const container = document.createElement("div");
  const root = createRoot(container);
  await act(async () => root.render(<ResourceList title="Projects" singular="Project" collection="projects" parentLifecycle columns={[{ key: "name", label: "Project" }]} fields={[]} />));
  await act(async () => {
    container.querySelector('[aria-label="Edit Active project"]').click();
  });
  await act(async () => {
    [...container.querySelectorAll("button")].find((button) => button.textContent === "Save modal").click();
  });
  await act(async () => {});
  const { toast } = require("sonner");
  expect(toast.error).toHaveBeenCalledWith(expect.stringContaining("Reload it and review"));
  expect(container.textContent).toContain("Load latest values");
  expect(container.textContent).toContain("Keep my entries and reapply");
  expect(mockApi.get).toHaveBeenCalledWith("/projects");
  global.__resourceSaveMutate = undefined;
  act(() => root.unmount());
});

beforeEach(() => {
  mockRole = "admin";
  global.__resourceSaveMutate = undefined;
});

test("parent lifecycle hides archived records and sends the fresh preflight token for exact permanent deletion", async () => {
  mockApi.get.mockResolvedValue({ data: { allowed: true, dependencies: { test_cases: 0, attachments: 0 }, preflight_token: "fresh-token" } });
  mockApi.delete.mockResolvedValue({ data: { ok: true } });
  const container = document.createElement("div");
  const root = createRoot(container);
  await act(async () => {
    root.render(<ResourceList title="Projects" singular="Project" collection="projects" parentLifecycle columns={[{ key: "name", label: "Project" }]} fields={[]} />);
  });

  expect(container.textContent).toContain("Active project");
  expect(container.textContent).not.toContain("Archived project");
  click([...container.querySelectorAll("button")].find((button) => button.textContent.includes("Archived records")));
  expect(container.textContent).toContain("Archived project");
  click([...container.querySelectorAll("button")].find((button) => button.textContent.includes("Review permanent deletion")));
  await act(async () => {});
  expect(container.querySelector('[aria-label="Exact dependency counts"]')).not.toBeNull();
  expect(container.textContent).toContain("test cases");

  const inputs = container.querySelectorAll("input");
  await act(async () => {
    setInput(inputs[0], "project-archived");
    setInput(inputs[1], "Archived project");
  });
  const reason = container.querySelector("textarea");
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value").set;
    setter.call(reason, "Duplicate record");
    reason.dispatchEvent(new Event("input", { bubbles: true }));
  });
  click([...container.querySelectorAll("button")].find((button) => button.textContent.includes("Permanently delete")));
  await act(async () => {});
  expect(mockApi.delete).toHaveBeenCalledWith("/resources/projects/project-archived/permanent", {
    data: expect.objectContaining({ confirmation_id: "project-archived", confirmation_title: "Archived project", reason: "Duplicate record", preflight_token: "fresh-token" }),
  });
  act(() => root.unmount());
});

test("viewer lists are genuinely read-only while retaining export and filters", async () => {
  mockRole = "viewer";
  const container = document.createElement("div");
  const root = createRoot(container);
  await act(async () => {
    root.render(<ResourceList title="Projects" singular="Project" collection="projects" exportFilename="projects.csv" columns={[{ key: "name", label: "Project" }]} fields={[]} />);
  });

  expect(container.querySelector('[data-testid="add-projects-btn"]')).toBeNull();
  expect(container.querySelector('[aria-label^="Edit "]')).toBeNull();
  expect(container.querySelector('[aria-label^="Review deletion"]')).toBeNull();
  expect(container.querySelector('[data-testid="projects-row"] td:first-child button')).toBeNull();
  expect(container.querySelector('[aria-label="Export filtered Projects as CSV"]')).not.toBeNull();
  act(() => root.unmount());
});

test("resource date filters reject an inverted range with actionable feedback", async () => {
  const container = document.createElement("div");
  const root = createRoot(container);
  await act(async () => root.render(<ResourceList title="Projects" singular="Project" collection="projects" dateFilterColumn="last_tested_date" columns={[{ key: "name", label: "Project" }]} fields={[]} />));
  const from = container.querySelector('[aria-label="Last Tested Date from"]');
  const to = container.querySelector('[aria-label="Last Tested Date to"]');
  await act(async () => {
    setInput(from, "2026-09-02");
    setInput(to, "2026-09-01");
  });
  expect(container.querySelector('[role="alert"]').textContent).toContain("Start date must be on or before end date.");
  expect(to.getAttribute("aria-invalid")).toBe("true");
  act(() => root.unmount());
});