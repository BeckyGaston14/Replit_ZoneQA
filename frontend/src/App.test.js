import { act } from "react";
import { createRoot } from "react-dom/client";
import { ConfiguredRoute, Protected } from "./App";

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const mockAuth = { user: null, loading: false };
let mockLocation = { pathname: "/comparison", search: "?tc=tc-1", hash: "#detail" };
jest.mock("@/App.css", () => ({}), { virtual: true });
jest.mock("@/index.css", () => ({}), { virtual: true });
jest.mock("@/lib/auth", () => ({ AuthProvider: ({ children }) => children, useAuth: () => mockAuth }), { virtual: true });
jest.mock("@/components/Layout", () => ({ children }) => <div data-testid="layout">{children}</div>, { virtual: true });
jest.mock("@/pages/Login", () => () => <div>Sign in page</div>, { virtual: true });
jest.mock("@/pages/ActivateUser", () => () => <div>Activate page</div>, { virtual: true });
jest.mock("@/pages/ForgotPassword", () => () => <div>Forgot password page</div>, { virtual: true });
jest.mock("@/pages/ResetPassword", () => () => <div>Reset password page</div>, { virtual: true });
jest.mock("@/lib/routeConfig", () => ({ APP_ROUTES: [] }), { virtual: true });
jest.mock("@/components/ui/sonner", () => ({ Toaster: () => null }), { virtual: true });
jest.mock("react-router-dom", () => ({
  BrowserRouter: ({ children }) => children,
  Routes: ({ children }) => children,
  Route: ({ element }) => element,
  Navigate: ({ to, state }) => <div data-testid="navigate" data-to={typeof to === "string" ? to : to.pathname} data-search={typeof to === "object" ? to.search : ""} data-hash={typeof to === "object" ? to.hash : ""} data-from={state?.from || ""} />,
  useLocation: () => mockLocation,
}), { virtual: true });

function renderProtected(roles, entry = "/comparison?tc=tc-1#detail") {
  const parsed = new URL(entry, "https://zoneqa.test");
  mockLocation = { pathname: parsed.pathname, search: parsed.search, hash: parsed.hash };
  const container = document.createElement("div");
  const root = createRoot(container);
  act(() => root.render(
    <Protected roles={roles}><div data-testid="protected-content">Authorized content</div></Protected>,
  ));
  return { container, unmount: () => act(() => root.unmount()) };
}

afterEach(() => {
  mockAuth.user = null;
  mockAuth.loading = false;
});

test("Protected exposes accessible loading feedback", () => {
  mockAuth.loading = true;
  const view = renderProtected();
  expect(view.container.querySelector('[role="status"]').textContent).toContain("Loading");
  view.unmount();
});

test("signed-out direct URL redirects to Login with the original authorized path", () => {
  const view = renderProtected();
  expect(view.container.querySelector('[data-testid="protected-content"]')).toBeNull();
  expect(view.container.querySelector('[data-testid="navigate"]').getAttribute("data-to")).toBe("/login");
  expect(view.container.querySelector('[data-testid="navigate"]').getAttribute("data-from")).toBe("/comparison?tc=tc-1#detail");
  view.unmount();
});

test("authenticated users access direct URLs while denied roles return home", () => {
  mockAuth.user = { id: "admin-1", role: "admin" };
  let view = renderProtected(["admin"]);
  expect(view.container.querySelector('[data-testid="protected-content"]')).not.toBeNull();
  view.unmount();

  mockAuth.user = { id: "viewer-1", role: "viewer" };
  view = renderProtected(["admin"]);
  expect(view.container.querySelector('[data-testid="protected-content"]')).toBeNull();
  expect(view.container.querySelector('[data-testid="navigate"]').getAttribute("data-to")).toBe("/");
  view.unmount();
});

test("compatibility routes add forced search state without dropping query strings or hashes", () => {
  mockLocation = { pathname: "/bassett/issues/findings", search: "?open=run-1", hash: "#history" };
  const container = document.createElement("div");
  const root = createRoot(container);
  act(() => root.render(<ConfiguredRoute route={{ component: () => <div>Findings</div>, forceSearch: { view: "findings" } }} />));
  const redirect = container.querySelector('[data-testid="navigate"]');
  expect(redirect.getAttribute("data-search")).toContain("open=run-1");
  expect(redirect.getAttribute("data-search")).toContain("view=findings");
  expect(redirect.getAttribute("data-hash")).toBe("#history");
  act(() => root.unmount());
});