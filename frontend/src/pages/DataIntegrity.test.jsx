import { act } from "react";
import { createRoot } from "react-dom/client";
import DataIntegrity from "./DataIntegrity";

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

var mockApi = { get: jest.fn(), post: jest.fn() };
var mockSetQueryData = jest.fn();
let mockCached = {
  has_result: true,
  checked_at: "2026-09-01T12:00:00Z",
  counts: { high: 0, medium: 0, low: 0 },
  issues: [],
};

jest.mock("../lib/api", () => ({
  api: {
    get: (...args) => mockApi.get(...args),
    post: (...args) => mockApi.post(...args),
  },
}));
jest.mock("../lib/auth", () => ({ useAuth: () => ({ user: { id: "admin-1", role: "admin" } }) }));
jest.mock("@tanstack/react-query", () => ({
  useQuery: ({ queryFn }) => {
    queryFn();
    return { data: mockCached, isLoading: false, isError: false, refetch: jest.fn() };
  },
  useQueryClient: () => ({ setQueryData: mockSetQueryData, invalidateQueries: jest.fn() }),
}));
jest.mock("react-router-dom", () => ({
  Link: ({ children, ...props }) => <a {...props}>{children}</a>,
}), { virtual: true });
jest.mock("../components/shared", () => ({
  PageHeader: ({ title, children }) => <header><h1>{title}</h1>{children}</header>,
  StatCard: ({ label, value }) => <div>{label}: {value}</div>,
  StatusBadge: ({ value }) => <span>{value}</span>,
  MethodologyDisclosure: ({ title, children }) => <details><summary>{title}</summary>{children}</details>,
}));
jest.mock("../components/ui/button", () => ({
  Button: ({ children, ...props }) => <button {...props}>{children}</button>,
}));
jest.mock("../components/ui/alert-dialog", () => ({
  AlertDialog: ({ children }) => <div>{children}</div>,
  AlertDialogContent: ({ children }) => <div>{children}</div>,
  AlertDialogHeader: ({ children }) => <div>{children}</div>,
  AlertDialogTitle: ({ children }) => <h2>{children}</h2>,
  AlertDialogDescription: ({ children }) => <div>{children}</div>,
  AlertDialogFooter: ({ children }) => <div>{children}</div>,
  AlertDialogCancel: ({ children, ...props }) => <button {...props}>{children}</button>,
  AlertDialogAction: ({ children, ...props }) => <button {...props}>{children}</button>,
}));
jest.mock("../components/SortableTableHeader", () => ({ SortableTableHeader: ({ column }) => <th>{column.label}</th> }));
jest.mock("../components/TableSortControls", () => ({ TableSortControls: () => null }));
jest.mock("../lib/tableSorting", () => ({
  nextSort: (sort) => sort,
  sortTableRows: (rows) => rows,
  usePersistentTableSort: (_key, _columns, fallback) => [fallback, jest.fn()],
}));

function renderPage() {
  const container = document.createElement("div");
  const root = createRoot(container);
  act(() => root.render(<DataIntegrity />));
  return { container, unmount: () => act(() => root.unmount()) };
}

beforeEach(() => {
  jest.clearAllMocks();
  mockCached = {
    has_result: true,
    checked_at: "2026-09-01T12:00:00Z",
    counts: { high: 0, medium: 0, low: 0 },
    issues: [],
  };
  mockApi.get.mockResolvedValue({ data: mockCached });
});

test("loads the latest stored result on visit without running validation", () => {
  const view = renderPage();
  expect(mockApi.get).toHaveBeenCalledWith("/admin/integrity", { signal: undefined });
  expect(mockApi.post).not.toHaveBeenCalled();
  expect(view.container.textContent).toContain("Last checked:");
  expect(view.container.textContent).toContain("Run integrity checks");
  expect(view.container.textContent).toContain("What integrity checks review");
  view.unmount();
});

test("manual integrity run shows progress and disables duplicate clicks", async () => {
  let resolveRun;
  mockApi.post.mockReturnValue(new Promise((resolve) => { resolveRun = resolve; }));
  const view = renderPage();
  const button = view.container.querySelector('[data-testid="run-integrity-btn"]');

  act(() => button.click());
  expect(button.disabled).toBe(true);
  expect(button.textContent).toContain("Running integrity checks");
  expect(view.container.querySelector('[data-testid="integrity-progress"]')).not.toBeNull();
  expect(mockApi.post).toHaveBeenCalledTimes(1);

  await act(async () => {
    resolveRun({ data: mockCached });
    await Promise.resolve();
  });
  expect(button.disabled).toBe(false);
  view.unmount();
});
