import { act } from "react";
import { createRoot } from "react-dom/client";
import { SampleRecordsControl, SampleRecordsHiddenNotice } from "./shared";
import { useSampleVisibility } from "../lib/hooks";

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

jest.mock("react-router-dom", () => ({
  Link: ({ children, to, ...props }) => <a href={to} {...props}>{children}</a>,
}), { virtual: true });

jest.mock("../lib/hooks", () => ({
  useSampleVisibility: jest.fn(),
}));

afterEach(() => jest.clearAllMocks());

function render(component) {
  const container = document.createElement("div");
  const root = createRoot(container);
  act(() => root.render(component));
  return {
    container,
    unmount: () => act(() => root.unmount()),
  };
}

test("the global control is keyboard-operable and persists the requested scope", () => {
  const setIncludeSampleRecords = jest.fn();
  useSampleVisibility.mockReturnValue({
    includeSampleRecords: false,
    setIncludeSampleRecords,
    isLoading: false,
    isSaving: false,
  });
  const view = render(<SampleRecordsControl />);
  const toggle = view.container.querySelector("[role='switch']");

  expect(toggle.getAttribute("aria-label")).toBe("Show sample records");
  expect(view.container.textContent).toContain("Show sample records");
  act(() => toggle.click());
  expect(setIncludeSampleRecords).toHaveBeenCalledWith(true);
  view.unmount();
});

test("hidden scope notice is neutral and offers one-click reveal", () => {
  const setIncludeSampleRecords = jest.fn();
  useSampleVisibility.mockReturnValue({
    includeSampleRecords: false,
    setIncludeSampleRecords,
    isLoading: false,
    isSaving: false,
  });
  const view = render(<SampleRecordsHiddenNotice />);
  const reveal = [...view.container.querySelectorAll("button")].find(
    (button) => button.textContent === "Show them",
  );

  expect(view.container.textContent).toContain("Sample records hidden");
  expect(view.container.getAttribute("role")).not.toBe("alert");
  act(() => reveal.click());
  expect(setIncludeSampleRecords).toHaveBeenCalledWith(true);
  view.unmount();
});