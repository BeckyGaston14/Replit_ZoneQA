import { act } from "react";
import { createRoot } from "react-dom/client";
import ReleaseReadiness from "./ReleaseReadiness";

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

let mockReadinessPayload;
jest.mock("react-router-dom", () => ({
  Link: ({ children }) => <a>{children}</a>,
  useSearchParams: () => [new URLSearchParams("version=v1"), jest.fn()],
}), { virtual: true });
jest.mock("@tanstack/react-query", () => ({
  useQuery: () => ({ data: mockReadinessPayload, isLoading: false, isError: false, refetch: jest.fn() }),
  useQueryClient: () => ({ invalidateQueries: jest.fn() }),
}));
jest.mock("../lib/api", () => ({ api: { get: jest.fn(), post: jest.fn() } }));
jest.mock("../lib/auth", () => ({ useAuth: () => ({ user: { role: "admin", name: "QA Admin" } }) }));
jest.mock("../lib/hooks", () => ({
  useCollection: () => ({ data: [{ name: "v1", active: true }], isLoading: false, isError: false, refetch: jest.fn() }),
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
  ListSelect: ({ value }) => <select value={value} readOnly />,
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