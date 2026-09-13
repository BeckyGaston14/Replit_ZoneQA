import { act } from "react";
import { createRoot } from "react-dom/client";
import { useQuery } from "@tanstack/react-query";
import { api } from "../lib/api";
import ReleaseReadiness from "./ReleaseReadiness";

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

let mockReadinessPayload;
let mockSearchParams = new URLSearchParams("version=v1");
const mockSetSearchParams = jest.fn();
jest.mock("react-router-dom", () => ({
  Link: ({ children }) => <a>{children}</a>,
  useSearchParams: () => [mockSearchParams, mockSetSearchParams],
}), { virtual: true });
jest.mock("@tanstack/react-query", () => ({
  useQuery: jest.fn(() => ({ data: mockReadinessPayload, isLoading: false, isError: false, refetch: jest.fn() })),
  useQueryClient: () => ({ invalidateQueries: jest.fn() }),
}));
jest.mock("../lib/api", () => ({ api: { get: jest.fn(), post: jest.fn() } }));
jest.mock("../lib/auth", () => ({ useAuth: () => ({ user: { role: "admin", name: "QA Admin" } }) }));
jest.mock("../lib/hooks", () => ({
  useCollection: () => ({ data: [{ name: "v1", active: true }, { name: "v2", active: false }], isLoading: false, isError: false, refetch: jest.fn() }),
}));
jest.mock("../components/shared", () => ({
  PageHeader: ({ children }) => <header>{children}</header>,
  StatCard: ({ label, value }) => <div>{label}: {value}</div>,
  CritBadge: () => null,
  ResultBadge: () => null,
  StatusBadge: ({ value }) => <span>{value}</span>,
  SampleDataBanner: () => null,
  sampleScopeIncludesData: () => false,
  MethodologyDisclosure: ({ children }) => <div>{children}</div>,
}));
jest.mock("../components/forms", () => ({
  ListSelect: ({ value, onChange, options = [], testid }) => <select value={value} onChange={(event) => onChange?.(event.target.value)} data-testid={testid}>{options.map((option) => <option key={option} value={option}>{option}</option>)}</select>,
}));
jest.mock("../components/ui/button", () => ({
  Button: ({ children, ...props }) => <button {...props}>{children}</button>,
}));
jest.mock("../components/ui/textarea", () => ({
  Textarea: (props) => <textarea {...props} />,
}));
jest.mock("../components/ConfirmActionDialog", () => ({ ConfirmActionDialog: () => null }));
jest.mock("../components/PageState", () => ({ QueryState: () => null }));
jest.mock("sonner", () => ({ toast: { success: jest.fn(), error: jest.fn() } }));

const payload = (evaluated) => ({
  version: "v1", scope: "both", recommendation: evaluated >= 50 ? "GO" : "INSUFFICIENT-EVIDENCE",
  reason: evaluated >= 50
    ? "Ready"
    : `Insufficient Evidence — ${evaluated} qualifying ${evaluated === 1 ? "test is" : "tests are"} available; release readiness requires at least 50.`,
  evaluated, minimum_qualifying_tests: 50, comparison_evaluated: evaluated,
  bassett_only_evaluated: 0, insufficient_evidence: evaluated < 50,
  blockers: [], pass_rate: 100, avg_score: 9, failed: 0, open_findings: 0,
  open_crit5: 0, open_crit4: 0, newly_failing: 0, decision: null,
  failed_tests: [],
  open_finding_list: [],
});

beforeEach(() => {
  mockSearchParams = new URLSearchParams("version=v1");
  mockSetSearchParams.mockReset();
  mockSetSearchParams.mockImplementation((next) => { mockSearchParams = next; });
  useQuery.mockReset();
  useQuery.mockImplementation(() => ({ data: mockReadinessPayload, isLoading: false, isError: false, refetch: jest.fn() }));
  api.get.mockReset();
});

function renderReadiness() {
  const container = document.createElement("div");
  const root = createRoot(container);
  act(() => root.render(<ReleaseReadiness />));
  return { container, root };
}

test.each([0, 1, 49, 50, 51])("GO control follows the evidence threshold at %i", (evaluated) => {
  mockReadinessPayload = payload(evaluated);
  const container = document.createElement("div");
  const root = createRoot(container);
  act(() => root.render(<ReleaseReadiness />));
  act(() => container.querySelector("[data-testid='record-decision-btn']").click());
  if (evaluated >= 50) {
    expect(container.querySelector("[data-testid='decision-go']")).not.toBeNull();
  } else {
    expect(container.querySelector("[data-testid='decision-go']")).toBeNull();
  }
  act(() => root.unmount());
});

test.each([
  [1, "1 qualifying test is available"],
  [49, "49 qualifying tests are available"],
])("insufficient evidence uses neutral blocker copy and correct grammar at %i", (evaluated, availabilityCopy) => {
  mockReadinessPayload = payload(evaluated);
  const container = document.createElement("div");
  const root = createRoot(container);
  act(() => root.render(<ReleaseReadiness />));

  expect(container.textContent).toContain(availabilityCopy);
  expect(container.textContent).toContain("No blockers identified; additional qualifying tests are still required before a release recommendation can be made.");
  expect(container.textContent).not.toContain("No blockers — clear for release.");
  act(() => root.unmount());
});

test("sufficient evidence retains the clear-for-release blocker copy", () => {
  mockReadinessPayload = payload(50);
  const container = document.createElement("div");
  const root = createRoot(container);
  act(() => root.render(<ReleaseReadiness />));

  expect(container.textContent).toContain("No blockers — clear for release.");
  expect(container.textContent).not.toContain("additional qualifying tests are still required");
  act(() => root.unmount());
});

test.each([
  {
    name: "insufficient evidence without blockers",
    evaluated: 12,
    blockers: [],
    expected: "I acknowledge that fewer than 50 qualifying tests have been completed and accept responsibility for making a release decision with insufficient evidence.",
  },
  {
    name: "insufficient evidence with unresolved blockers",
    evaluated: 12,
    blockers: [{ type: "finding", label: "Critical finding", detail: "Open", link_type: "finding", link_id: "f1" }],
    expected: "I acknowledge that fewer than 50 qualifying tests have been completed and that unresolved blockers remain, and accept responsibility for making a release decision with insufficient evidence.",
  },
  {
    name: "sufficient evidence with blockers",
    evaluated: 50,
    blockers: [{ type: "finding", label: "Critical finding", detail: "Open", link_type: "finding", link_id: "f1" }],
    expected: "I accept responsibility for releasing against the listed blockers (required for overrides)",
  },
  {
    name: "sufficient evidence without blockers",
    evaluated: 50,
    blockers: [],
    expected: "I accept responsibility for overriding the system recommendation (required for overrides)",
  },
])("uses the correct acknowledgement for $name", ({ evaluated, blockers, expected }) => {
  mockReadinessPayload = { ...payload(evaluated), blockers };
  const { container, root } = renderReadiness();
  act(() => container.querySelector("[data-testid='record-decision-btn']").click());

  expect(container.querySelector("[data-testid='decision-risk-accept']").textContent).toContain(expected);
  act(() => root.unmount());
});

test("explains Conditional Go as a manual override using the API threshold and keeps automatic Go absent", () => {
  mockReadinessPayload = {
    ...payload(12),
    minimum_qualifying_tests: 37,
    insufficient_evidence: true,
    recommendation: "INSUFFICIENT-EVIDENCE",
  };
  const { container, root } = renderReadiness();

  expect(container.querySelector("[data-testid='final-decision-guidance']").textContent).toBe(
    "An authorized Conditional Go is a documented manual override, not the system recommendation. The system remains Insufficient Evidence until at least 37 qualifying tests have been completed.",
  );
  act(() => container.querySelector("[data-testid='record-decision-btn']").click());
  expect(container.querySelector("[data-testid='decision-go']")).toBeNull();
  expect(container.querySelector("[data-testid='decision-cond']")).not.toBeNull();
  act(() => root.unmount());
});

test("version and scope changes create distinct readiness requests and pass cancellation signals", async () => {
  mockReadinessPayload = payload(50);
  api.get.mockResolvedValue({ data: mockReadinessPayload });
  const { container, root } = renderReadiness();

  expect(useQuery.mock.calls.at(-1)[0].queryKey).toEqual(["readiness", "v1", "both"]);
  act(() => {
    const versionSelect = container.querySelector("[data-testid='readiness-version-select']");
    versionSelect.value = "v2";
    versionSelect.dispatchEvent(new Event("change", { bubbles: true }));
  });
  expect(useQuery.mock.calls.at(-1)[0].queryKey).toEqual(["readiness", "v2", "both"]);
  act(() => {
    const scopeSelect = container.querySelector("[data-testid='readiness-scope-select']");
    scopeSelect.value = "comparison";
    scopeSelect.dispatchEvent(new Event("change", { bubbles: true }));
  });
  const scopedOptions = useQuery.mock.calls.at(-1)[0];
  expect(scopedOptions.queryKey).toEqual(["readiness", "v2", "comparison"]);
  const signal = new AbortController().signal;
  await scopedOptions.queryFn({ signal });
  expect(api.get).toHaveBeenCalledWith("/release-readiness?version=v2&scope=comparison", { signal });
  act(() => root.unmount());
});