import { act } from "react";
import { createRoot } from "react-dom/client";

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

jest.mock("react-router-dom", () => ({
  useNavigate: () => jest.fn(),
  useSearchParams: () => [{ get: () => "" }],
}), { virtual: true });
jest.mock("@tanstack/react-query", () => ({
  useQuery: () => ({ data: [] }),
  useQueryClient: () => ({ invalidateQueries: jest.fn() }),
}));
jest.mock("../lib/api", () => ({ api: { get: jest.fn(() => Promise.resolve({ data: {} })), put: jest.fn() }, formatApiErrorDetail: () => "" }));
jest.mock("../lib/auth", () => ({ useAuth: () => ({ user: { id: "viewer-1", role: "viewer" } }) }));
jest.mock("../lib/hooks", () => ({
  useConfig: () => ({ data: {} }),
  useSave: () => ({ mutate: jest.fn() }),
  useCollection: () => ({ data: [] }),
  useSavedView: (_page, defaultState) => ({
    state: defaultState, updateState: jest.fn(), error: "", clearError: jest.fn(),
  }),
}));
jest.mock("../components/shared", () => ({
  PageHeader: () => null,
  CritBadge: () => null,
  ResultBadge: () => null,
  StatusBadge: () => null,
  StatusLegend: () => null,
  StatCard: () => null,
}));
jest.mock("../components/forms", () => ({
  FormModal: () => null,
  Field: ({ children }) => children,
  SelectOrAdd: () => null,
  ListSelect: () => null,
  DimSelect: () => null,
}));
jest.mock("../components/ImportCsvModal", () => ({ ImportCsvModal: () => null }));
jest.mock("../components/SortableTableHeader", () => ({ SortableTableHeader: ({ column }) => <th>{column.label}</th> }));
jest.mock("../components/TableSortControls", () => ({ TableSortControls: () => null }));
jest.mock("../components/TestCaseActions", () => ({ TestCaseActions: () => null }));
jest.mock("../lib/tableSorting", () => ({
  nextSort: jest.fn(),
  sortTableRows: (rows) => rows,
  usePersistentTableSort: (_key, _columns, defaultSort) => [defaultSort, jest.fn()],
}));
jest.mock("../components/ui/button", () => ({ Button: ({ children, ...props }) => <button {...props}>{children}</button> }));
jest.mock("../components/ui/input", () => ({ Input: (props) => <input {...props} /> }));
jest.mock("../components/ui/textarea", () => ({ Textarea: (props) => <textarea {...props} /> }));
jest.mock("../components/ui/select", () => ({
  Select: ({ children }) => <div>{children}</div>,
  SelectTrigger: ({ children }) => <button>{children}</button>,
  SelectValue: () => null,
  SelectContent: ({ children }) => <div>{children}</div>,
  SelectItem: ({ children }) => <div>{children}</div>,
}));
jest.mock("../components/ui/popover", () => ({
  Popover: ({ children }) => <>{children}</>,
  PopoverTrigger: ({ children }) => children,
  PopoverContent: ({ children }) => <div>{children}</div>,
}));
jest.mock("../components/ui/checkbox", () => ({ Checkbox: () => <input type="checkbox" /> }));
jest.mock("sonner", () => ({ toast: { success: jest.fn(), error: jest.fn() } }));

const TestCases = require("./TestCases").default;
const Regression = require("./Regression").default;
const { RunDetail } = require("./Regression");
const { GapRow } = require("./Coverage");

beforeEach(() => {
  require("../lib/api").api.get.mockResolvedValue({ data: {} });
});

function render(element, width = 320) {
  Object.defineProperty(window, "innerWidth", { configurable: true, value: width });
  const container = document.createElement("div");
  const root = createRoot(container);
  act(() => root.render(element));
  return { container, unmount: () => act(() => root.unmount()) };
}

test.each([320, 375])("Test Cases columns remain reachable in a %ipx horizontal scroll region", (width) => {
  const view = render(<TestCases />, width);
  const scrollRegion = view.container.querySelector('[data-testid="testcases-table-scroll"]');
  expect(scrollRegion.className).toContain("overflow-x-auto");
  expect(scrollRegion.querySelector("table").className).toContain("min-w-[720px]");
  view.unmount();
});

test.each([320, 375])("Regression history and expanded results remain reachable at %ipx", (width) => {
  let view = render(<Regression />, width);
  const history = view.container.querySelector('[data-testid="regression-runs-table-scroll"]');
  expect(history.className).toContain("overflow-x-auto");
  expect(history.querySelector("table").className).toContain("min-w-[720px]");
  view.unmount();

  view = render(<RunDetail run={{ id: "run-1", results: [], created_by: "QA" }} />, width);
  const results = view.container.querySelector('[data-testid="regression-results-table-scroll"]');
  expect(results.className).toContain("overflow-x-auto");
  expect(results.querySelector("table").className).toContain("min-w-[720px]");
  view.unmount();
});

test("Coverage status rows stack without hiding status text at 320px", () => {
  const view = render(<GapRow label="Setbacks" sub="Research" tests={0} evaluated={0} max={3} testid="coverage-narrow-row" />);
  const row = view.container.querySelector('[data-testid="coverage-narrow-row"]');
  expect(row.className).toContain("flex-col");
  expect(row.className).toContain("sm:flex-row");
  expect(row.textContent).toContain("0 tests");
  view.unmount();
});