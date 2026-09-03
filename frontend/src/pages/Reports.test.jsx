import { act } from "react";
import { createRoot } from "react-dom/client";
import Reports from "./Reports";

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

jest.mock("react-router-dom", () => ({
  Link: ({ to, children }) => <a href={to}>{children}</a>,
}), { virtual: true });
jest.mock("../lib/api", () => ({ api: { get: jest.fn() } }));
jest.mock("../lib/hooks", () => ({ useConfig: () => ({ data: { eval_dimensions: [] } }) }));
jest.mock("../components/shared", () => ({
  PageHeader: ({ title, children }) => <header><h1>{title}</h1>{children}</header>,
}));
jest.mock("../components/ui/button", () => ({
  Button: ({ children, asChild, ...props }) => asChild ? children : <button {...props}>{children}</button>,
}));
jest.mock("sonner", () => ({ toast: { success: jest.fn(), error: jest.fn() } }));

test("offers truthful scoped exports and links to distinct live reports", () => {
  const container = document.createElement("div");
  const root = createRoot(container);
  act(() => root.render(<Reports />));

  expect(container.querySelectorAll("[data-testid='export-qa-data-json']")).toHaveLength(1);
  expect(container.querySelectorAll("[data-testid^='report-']")).toHaveLength(6);
  const links = [...container.querySelectorAll("a")].map((link) => link.getAttribute("href"));
  expect(links).toEqual(expect.arrayContaining([
    "/release", "/regression", "/comparison", "/findings", "/performance", "/executive",
  ]));
  expect(container.textContent).toContain("Release Readiness Data");
  expect(container.textContent).toContain("Municipality Testing Data");
  expect(container.textContent).toContain("Model Comparison Findings");
  expect(container.querySelector("button").className).toContain("w-full");
  expect(container.querySelector("button").className).toContain("sm:w-auto");
  act(() => root.unmount());
});

test("fetches the canonical report population in one operation", async () => {
  const { api } = require("../lib/api");
  api.get.mockResolvedValue({ data: {
    stats: { active_projects: 2 }, testcases: [], findings: [], evaluations: [],
    regression_runs: [], test_runs: [],
  } });
  URL.createObjectURL = jest.fn(() => "blob:qa-data");
  URL.revokeObjectURL = jest.fn();
  const click = jest.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
  const container = document.createElement("div");
  const root = createRoot(container);
  act(() => root.render(<Reports />));

  await act(async () => {
    container.querySelector("[data-testid='export-qa-data-json']").click();
    await Promise.resolve();
    await Promise.resolve();
  });

  expect(api.get).toHaveBeenCalledWith("/reports/data?kind=qa_summary");
  expect(click).toHaveBeenCalled();
  click.mockRestore();
  delete URL.createObjectURL;
  delete URL.revokeObjectURL;
  act(() => root.unmount());
});
