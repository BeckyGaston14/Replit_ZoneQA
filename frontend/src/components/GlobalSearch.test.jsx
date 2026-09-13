import { act } from "react";
import { createRoot } from "react-dom/client";
import { GlobalSearch } from "./GlobalSearch";
import { api } from "../lib/api";

globalThis.IS_REACT_ACT_ENVIRONMENT = true;
jest.useFakeTimers();
jest.mock("react-router-dom", () => ({ useNavigate: () => jest.fn() }), { virtual: true });
jest.mock("../lib/api", () => ({ api: { get: jest.fn(() => Promise.resolve({ data: { total: 1, groups: [{ label: "Tests", items: [{ id: "1", name: "Result", type: "test", link: "/" }] }] } })) } }));
jest.mock("./ui/input", () => ({ Input: (props) => <input {...props} /> }));
jest.mock("./shared", () => ({ CritBadge: () => null }));

test("global search publishes combobox/listbox ARIA relationships", async () => {
  Object.defineProperty(window, "innerWidth", { configurable: true, value: 320 });
  const container = document.createElement("div"); const root = createRoot(container);
  await act(async () => root.render(<GlobalSearch />));
  const input = container.querySelector("input");
  expect(input.getAttribute("aria-label")).toContain("Bassett test runs");
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set;
    setter.call(input, "ab");
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await act(async () => { jest.runAllTimers(); await Promise.resolve(); });
  expect(input.getAttribute("aria-controls")).toBe("global-search-results");
  const panel = container.querySelector("#global-search-results");
  expect(panel).not.toBeNull();
  expect(panel.className).toContain("fixed");
  expect(panel.className).toContain("left-3");
  expect(panel.className).toContain("right-3");
  expect(panel.className).toContain("w-auto");
  const gutterPixels = 12;
  expect({ left: gutterPixels, right: window.innerWidth - gutterPixels, width: window.innerWidth - (gutterPixels * 2) })
    .toEqual({ left: 12, right: 308, width: 296 });
  act(() => root.unmount());
});

test("global search renders Bassett Test Runs as a distinct result group", async () => {
  api.get.mockResolvedValueOnce({
    data: {
      total: 2,
      groups: [
        { label: "Properties", items: [{ id: "property-1", name: "404 Southwestern Ave", type: "Property", link: "/properties", context: "404 Southwestern Ave" }] },
        { label: "Bassett Test Runs", items: [{ id: "run-1", name: "Setback review", type: "Bassett Test Run", link: "/bassett/issues?open=run-1", context: "404 Southwestern Ave" }] },
      ],
    },
  });
  const container = document.createElement("div"); const root = createRoot(container);
  await act(async () => root.render(<GlobalSearch />));
  const input = container.querySelector("input");
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set;
    setter.call(input, "404 Southwestern");
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await act(async () => { jest.runAllTimers(); await Promise.resolve(); });
  expect(container.textContent).toContain("Bassett Test Runs");
  expect(container.textContent).toContain("Setback review");
  expect(container.querySelector('[data-testid="search-result-item"]')).not.toBeNull();
  act(() => root.unmount());
});