import { act } from "react";
import { createRoot } from "react-dom/client";
import { useQuery } from "@tanstack/react-query";
import Coverage from "./Coverage";
import Demos from "./Demos";
import Executive from "./Executive";
import Insights from "./Insights";

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

jest.mock("@tanstack/react-query", () => ({ useQuery: jest.fn() }));
jest.mock("react-router-dom", () => ({ Link: ({ children, ...props }) => <a {...props}>{children}</a> }), { virtual: true });
jest.mock("recharts", () => new Proxy({}, { get: () => () => null }));
jest.mock("jspdf", () => jest.fn());
jest.mock("html2canvas", () => jest.fn());
jest.mock("../components/shared", () => ({
  PageHeader: ({ title }) => <h1>{title}</h1>,
  StatCard: () => null,
  StatusBadge: () => null,
  CritBadge: () => null,
  WrapTick: () => null,
  SrTable: () => null,
}));

function renderPage(Component) {
  const container = document.createElement("div");
  const root = createRoot(container);
  act(() => root.render(<Component />));
  return { container, unmount: () => act(() => root.unmount()) };
}

beforeEach(() => {
  useQuery.mockReset();
});

test.each([
  ["Executive Summary", Executive],
  ["Test Coverage", Coverage],
  ["Competitive Insights", Insights],
])("%s distinguishes an API failure from empty data", (_name, Component) => {
  useQuery.mockReturnValue({ isLoading: false, isError: true, error: new Error("offline"), refetch: jest.fn() });
  const view = renderPage(Component);
  expect(view.container.querySelector('[role="alert"]')).not.toBeNull();
  expect(view.container.textContent).toContain("Unable to load");
  expect(view.container.textContent).toContain("Retry");
  view.unmount();
});

test("Demo Library distinguishes a testcase lookup failure from an empty library", () => {
  useQuery
    .mockReturnValueOnce({ isLoading: false, isError: false, data: [{ id: "demo-1", testcase_id: "tc-1" }] })
    .mockReturnValueOnce({ isLoading: false, isError: true, error: new Error("offline"), refetch: jest.fn() });
  const view = renderPage(Demos);
  expect(view.container.querySelector('[role="alert"]')).not.toBeNull();
  expect(view.container.textContent).not.toContain("No demo-approved tests yet");
  view.unmount();
});