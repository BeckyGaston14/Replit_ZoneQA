import { act } from "react";
import { createRoot } from "react-dom/client";
import { SampleRecordsControl } from "./shared";
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

test("the Administration control is keyboard-operable and persists the requested scope", () => {
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