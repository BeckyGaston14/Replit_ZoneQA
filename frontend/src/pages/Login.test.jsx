import { act } from "react";
import { createRoot } from "react-dom/client";
import Login from "./Login";

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const mockLogin = jest.fn();
const mockNavigate = jest.fn();
let mockLocation = { state: undefined };

jest.mock("react-router-dom", () => ({
  useLocation: () => mockLocation,
  useNavigate: () => mockNavigate,
}), { virtual: true });

jest.mock("../lib/auth", () => ({ useAuth: () => ({ login: mockLogin }) }));
jest.mock("../components/ui/button", () => ({
  Button: ({ children, ...props }) => <button {...props}>{children}</button>,
}));
jest.mock("../components/ui/input", () => ({
  Input: (props) => <input {...props} />,
}));
jest.mock("../components/ui/label", () => ({
  Label: (props) => <label {...props} />,
}));
jest.mock("../lib/api", () => ({
  formatApiErrorDetail: (detail) => typeof detail === "string" ? detail : "Something went wrong.",
}));
jest.mock("sonner", () => ({ toast: { success: jest.fn() } }));

function renderLogin() {
  const container = document.createElement("div");
  const root = createRoot(container);
  act(() => root.render(<Login />));
  return { container, unmount: () => act(() => root.unmount()) };
}

function setInput(input, value) {
  act(() => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set;
    setter.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

beforeEach(() => {
  mockLogin.mockReset();
  mockNavigate.mockReset();
  mockLocation = { state: undefined };
});

test("Login has stable accessible fields and announces invalid credentials", async () => {
  mockLogin.mockRejectedValueOnce({ response: { data: { detail: "Invalid email or password" } } });
  const view = renderLogin();
  const email = view.container.querySelector("#login-email");
  const password = view.container.querySelector("#login-password");
  expect(view.container.querySelector('label[for="login-email"]')).not.toBeNull();
  expect(view.container.querySelector('label[for="login-password"]')).not.toBeNull();
  expect(email.getAttribute("autocomplete")).toBe("username");
  expect(password.getAttribute("autocomplete")).toBe("current-password");
  expect(email.getAttribute("aria-required")).toBe("true");

  setInput(email, "user@example.com");
  setInput(password, "incorrect-password");
  await act(async () => view.container.querySelector("form").dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));

  const error = view.container.querySelector('[role="alert"]');
  expect(error.textContent).toContain("Invalid email or password");
  expect(error.getAttribute("aria-live")).toBe("assertive");
  expect(email.getAttribute("aria-describedby")).toBe("login-error");
  view.unmount();
});

test("Login explains a backend cold start instead of showing a generic error", async () => {
  mockLogin.mockRejectedValueOnce({ response: { status: 503, data: {} } });
  const view = renderLogin();
  setInput(view.container.querySelector("#login-email"), "user@example.com");
  setInput(view.container.querySelector("#login-password"), "correct-password");
  await act(async () => view.container.querySelector("form").dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
  expect(view.container.querySelector('[role="alert"]').textContent).toContain("server is still starting");
  view.unmount();
});

test("successful Login safely returns to the originally requested internal page", async () => {
  mockLocation = { state: { from: "/comparison?tc=tc-1#detail" } };
  mockLogin.mockResolvedValueOnce({ id: "user-1" });
  const view = renderLogin();
  setInput(view.container.querySelector("#login-email"), "user@example.com");
  setInput(view.container.querySelector("#login-password"), "correct-password");
  await act(async () => view.container.querySelector("form").dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
  expect(mockNavigate).toHaveBeenCalledWith("/comparison?tc=tc-1#detail", { replace: true });
  view.unmount();
});

test.each([
  "https://untrusted.example/phish",
  "/\\untrusted.example",
])("Login ignores unsafe redirect state %s", async (from) => {
  mockLocation = { state: { from } };
  mockLogin.mockResolvedValueOnce({ id: "user-1" });
  const view = renderLogin();
  setInput(view.container.querySelector("#login-email"), "user@example.com");
  setInput(view.container.querySelector("#login-password"), "correct-password");
  await act(async () => view.container.querySelector("form").dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
  expect(mockNavigate).toHaveBeenCalledWith("/", { replace: true });
  view.unmount();
});