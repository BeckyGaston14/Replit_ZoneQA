import { act } from "react";
import { createRoot } from "react-dom/client";

globalThis.IS_REACT_ACT_ENVIRONMENT = true;
let mockComparison;
const mockNavigate = jest.fn();
const mockSetSearchParams = jest.fn();
let mockComparisonTests = [{ id: "tc-1", name: "Case", municipality_name: "Austin, TX", project_name: "Residential", category: "Zoning" }];
jest.mock("react-router-dom", () => ({ useSearchParams: () => [{ get: () => "tc-1" }, mockSetSearchParams], useNavigate: () => mockNavigate }), { virtual: true });
jest.mock("@tanstack/react-query", () => ({ useQuery: (options) => options.queryKey[0] === "tc-enriched" ? { data: mockComparisonTests } : { data: mockComparison, isLoading: false, isError: false, refetch: jest.fn() } }));
jest.mock("../lib/auth", () => ({ useAuth: () => ({ user: { role: "tester" } }) }));
jest.mock("../lib/api", () => ({ api: { post: jest.fn() }, formatApiErrorDetail: () => "request failed" }));
jest.mock("sonner", () => ({ toast: { success: jest.fn(), error: jest.fn() } }));
jest.mock("../components/shared", () => ({ PageHeader: ({ children }) => <div>{children}</div>, CritBadge: () => null, ResultBadge: () => null, ScorePill: () => null, StatusBadge: ({ value, testId }) => <span data-testid={testId}>{value}</span> }));
jest.mock("../components/ui/select", () => ({ Select: ({ children }) => <div>{children}</div>, SelectContent: ({ children }) => <div>{children}</div>, SelectItem: ({ children }) => <div>{children}</div>, SelectTrigger: ({ children, ...props }) => <button {...props}>{children}</button>, SelectValue: () => null }));
jest.mock("../components/ui/button", () => ({ Button: ({ children, ...props }) => <button {...props}>{children}</button> }));
const Comparison = require("./Comparison").default;

const base = () => ({ testcase: { name: "Case", criticality: 3, prompts: [] }, responses: [], evaluations: [] });
function render() {
  const container = document.createElement("div"); const root = createRoot(container);
  act(() => root.render(<Comparison />));
  return { container, unmount: () => act(() => root.unmount()) };
}
afterEach(() => { mockNavigate.mockClear(); mockSetSearchParams.mockClear(); mockComparisonTests = [{ id: "tc-1", name: "Case", municipality_name: "Austin, TX", project_name: "Residential", category: "Zoning" }]; document.body.innerHTML = ""; });

test("incomplete comparison names missing records and never renders a verdict", () => {
  mockComparison = base();
  const view = render();
  expect(view.container.querySelector("[data-testid=incomplete-comparison]").textContent).toContain("Bassett response");
  expect(view.container.textContent).toContain("ChatGPT evaluation");
  expect(view.container.querySelector("[data-testid=cmp-verdict]")).toBeNull();
  expect(view.container.textContent).toContain("Retry incomplete models");
  view.unmount();
});

test("complete comparison renders a verdict only after all response and evaluation requirements exist", () => {
  mockComparison = base();
  ["Bassett", "ChatGPT", "Claude"].forEach((model, index) => {
    mockComparison.responses.push({ id: model, model, turn: 1, response: "valid response" });
    mockComparison.evaluations.push({ id: `e${model}`, model, overall_score: 8 + index, final_result: "Pass", scores: { accuracy: 8 } });
  });
  const view = render();
  expect(view.container.querySelector("[data-testid=incomplete-comparison]")).toBeNull();
  expect(view.container.querySelector("[data-testid=cmp-verdict]")).not.toBeNull();
  view.unmount();
});

test("test-case selector stays within the 320px content column", () => {
  Object.defineProperty(window, "innerWidth", { configurable: true, value: 320 });
  mockComparison = base();
  const view = render();
  const selectorContainer = view.container.querySelector('[data-testid="cmp-select"]').parentElement.parentElement;
  expect(selectorContainer.className).toContain("w-full");
  expect(selectorContainer.className).toContain("max-w-full");
  expect(selectorContainer.className).toContain("sm:w-80");
  expect(selectorContainer.className.split(/\s+/)).not.toContain("w-80");
  view.unmount();
});

test("searchable picker exposes every eligible test case with context and selection", () => {
  mockComparisonTests = [
    { id: "tc-2", name: "Bravo Case", municipality_name: "Dallas, TX", project_name: "Commercial", category: "Entitlements" },
    { id: "tc-1", name: "Alpha Case", municipality_name: "Austin, TX", project_name: "Residential", category: "Zoning" },
  ];
  mockComparison = base();
  const view = render();
  act(() => view.container.querySelector("[data-testid=cmp-select]").click());
  expect(view.container.querySelector("[data-testid=cmp-option-tc-1]")).not.toBeNull();
  expect(view.container.querySelector("[data-testid=cmp-option-tc-2]")).not.toBeNull();
  expect(view.container.textContent).toContain("Austin, TX");
  expect(view.container.textContent).toContain("Dallas, TX");
  act(() => view.container.querySelector("[data-testid=cmp-option-tc-2]").click());
  expect(mockSetSearchParams).toHaveBeenCalledWith(expect.any(URLSearchParams), undefined);
  expect([...mockSetSearchParams.mock.calls[0][0].entries()]).toContainEqual(["tc", "tc-2"]);
  view.unmount();
});

test.each([320, 375])("response cards wrap long content at %ipx without widening the grid", (width) => {
  Object.defineProperty(window, "innerWidth", { configurable: true, value: width });
  mockComparison = base();
  mockComparison.responses.push({
    id: "long",
    model: "Bassett",
    turn: 1,
    response: "A".repeat(500),
    citations: "https://example.test/" + "b".repeat(300),
  });
  const view = render();
  const card = [...view.container.querySelectorAll(".grid > div")].find((element) => element.textContent.includes("Bassett"));
  expect(card.className).toContain("min-w-0");
  expect(card.querySelector(".prose-response").className).toContain("break-words");
  expect(card.textContent).toContain("A".repeat(100));
  view.unmount();
});