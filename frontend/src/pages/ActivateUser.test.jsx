import { act } from "react";
import { createRoot } from "react-dom/client";
import ActivateUser from "./ActivateUser";

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

var mockPost;
const mockNavigate = jest.fn();
let mockToken = "";

jest.mock("react-router-dom", () => ({
  useSearchParams: () => [new URLSearchParams(mockToken ? `token=${mockToken}` : "")],
  useNavigate: () => mockNavigate,
}), { virtual: true });
jest.mock("../lib/api", () => ({
  api: { post: (...args) => mockPost(...args) },
  formatApiErrorDetail: (detail) => typeof detail === "string" ? detail : "Something went wrong.",
}));
jest.mock("../components/ui/button", () => ({
  Button: ({ children, ...props }) => <button {...props}>{children}</button>,
}));
jest.mock("../components/ui/input", () => ({
  Input: (props) => <input {...props} />,
}));
jest.mock("../components/ui/label", () => ({
  Label: (props) => <label {...props} />,
}));
mockPost = jest.fn();

function renderActivation() {
  const container = document.createElement("div");
  const root = createRoot(container);
  act(() => root.render(<ActivateUser />));
  return { container, unmount: () => act(() => root.unmount()) };
}

function setInput(input, value) {
  act(() => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set;
    setter.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

async function submitWith(password, confirm = password) {
  const view = renderActivation();
  setInput(view.container.querySelector("#activation-password"), password);
  setInput(view.container.querySelector("#activation-confirm"), confirm);
  await act(async () => view.container.querySelector("form").dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
  return view;
}

beforeEach(() => {
  mockPost.mockReset();
  mockNavigate.mockReset();
  mockToken = "valid-token-123456789012345";
});

test("activation fields expose stable IDs, required state, and password autocomplete", () => {
  const view = renderActivation();
  expect(view.container.querySelector('label[for="activation-password"]')).not.toBeNull();
  expect(view.container.querySelector('label[for="activation-confirm"]')).not.toBeNull();
  expect(view.container.querySelector("#activation-password").getAttribute("autocomplete")).toBe("new-password");
  expect(view.container.querySelector("#activation-confirm").getAttribute("autocomplete")).toBe("new-password");
  expect(view.container.querySelector("#activation-password").getAttribute("aria-required")).toBe("true");
  view.unmount();
});

test("activation validates missing token, password requirements, and mismatch accessibly", async () => {
  mockToken = "";
  let view = await submitWith("a-strong-password-123");
  expect(view.container.querySelector('[role="alert"]').textContent).toContain("missing its setup token");
  view.unmount();

  mockToken = "valid-token-123456789012345";
  view = await submitWith("short");
  expect(view.container.querySelector('[role="alert"]').textContent).toContain("at least 12 characters");
  view.unmount();

  view = await submitWith("a-strong-password-123", "different-password-123");
  expect(view.container.querySelector('[role="alert"]').textContent).toContain("do not match");
  expect(mockPost).not.toHaveBeenCalled();
  view.unmount();
});

test("invalid or expired activation links retain a plain-language alert", async () => {
  mockPost.mockRejectedValueOnce({ response: { data: { detail: "This activation link is invalid, expired, or already used" } } });
  const view = await submitWith("a-strong-password-123");
  expect(view.container.querySelector('[role="alert"]').textContent).toContain("invalid, expired, or already used");
  expect(view.container.querySelector('[role="alert"]').getAttribute("aria-live")).toBe("assertive");
  view.unmount();
});

test("successful activation reports status and routes active users home", async () => {
  jest.useFakeTimers();
  mockPost.mockResolvedValueOnce({ data: { activated: true } });
  const view = await submitWith("a-strong-password-123");
  expect(view.container.querySelector('[role="status"]').textContent).toContain("Password set successfully");
  act(() => jest.advanceTimersByTime(900));
  expect(mockNavigate).toHaveBeenCalledWith("/");
  view.unmount();
  jest.useRealTimers();
});

test("activation preserves the inactive-user outcome without signing in", async () => {
  mockPost.mockResolvedValueOnce({ data: { activated: false } });
  const view = await submitWith("a-strong-password-123");
  expect(view.container.textContent).toContain("this account is inactive");
  expect(view.container.querySelector("button").textContent).toContain("Go to sign in");
  expect(mockNavigate).not.toHaveBeenCalled();
  view.unmount();
});