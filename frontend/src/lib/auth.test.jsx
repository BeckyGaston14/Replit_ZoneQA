import { act, StrictMode } from "react";
import { createRoot } from "react-dom/client";
import {
  AuthProvider, AUTH_BOOTSTRAP_RETRY_DELAY_MS, AUTH_EXPIRED_EVENT, useAuth,
} from "./auth";

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

var mockGet;
var mockPost;
jest.mock("./api", () => ({
  api: { get: (...args) => mockGet(...args), post: (...args) => mockPost(...args) },
  isDefinitiveAuthFailure: (error) => (
    error?.response?.status === 401
    || (error?.response?.status === 403 && /inactive/i.test(error?.response?.data?.detail || ""))
  ),
}));
mockGet = jest.fn();
mockPost = jest.fn();

function Probe() {
  const { user, loading, login } = useAuth();
  return <div data-user={user?.id || ""} data-loading={String(loading)}>
    <button onClick={() => login("user@example.com", "password")}>Log in</button>
  </div>;
}

function renderProvider({ strict = false, bootstrapRetries } = {}) {
  const container = document.createElement("div");
  const root = createRoot(container);
  const provider = <AuthProvider bootstrapRetries={bootstrapRetries}><Probe /></AuthProvider>;
  act(() => root.render(strict ? <StrictMode>{provider}</StrictMode> : provider));
  return { container, unmount: () => act(() => root.unmount()) };
}

afterEach(() => {
  mockGet.mockReset();
  mockPost.mockReset();
});

test("AuthProvider exposes loading then authenticated state", async () => {
  let resolve;
  mockGet.mockReturnValueOnce(new Promise((finish) => { resolve = finish; }));
  const view = renderProvider();
  expect(view.container.firstChild.getAttribute("data-loading")).toBe("true");
  await act(async () => resolve({ data: { id: "user-1", role: "tester" } }));
  expect(view.container.firstChild.getAttribute("data-loading")).toBe("false");
  expect(view.container.firstChild.getAttribute("data-user")).toBe("user-1");
  view.unmount();
});

test("AuthProvider clears the user when a protected request reports session expiry", async () => {
  mockGet.mockResolvedValueOnce({ data: { id: "user-1", role: "tester" } });
  const view = renderProvider();
  await act(async () => Promise.resolve());
  expect(view.container.firstChild.getAttribute("data-user")).toBe("user-1");
  act(() => window.dispatchEvent(new Event(AUTH_EXPIRED_EVENT)));
  expect(view.container.firstChild.getAttribute("data-user")).toBe("");
  view.unmount();
});

test("AuthProvider treats auth-me failure as signed out", async () => {
  mockGet.mockRejectedValueOnce({ response: { status: 401 } });
  const view = renderProvider();
  await act(async () => Promise.resolve());
  expect(view.container.firstChild.getAttribute("data-loading")).toBe("false");
  expect(view.container.firstChild.getAttribute("data-user")).toBe("");
  expect(mockGet).toHaveBeenCalledTimes(1);
  view.unmount();
});

test("AuthProvider shares the pending session check across Strict Mode mounts", async () => {
  let resolve;
  mockGet.mockReturnValueOnce(new Promise((finish) => { resolve = finish; }));
  const view = renderProvider({ strict: true, bootstrapRetries: 0 });
  expect(mockGet).toHaveBeenCalledTimes(1);
  expect(view.container.firstChild.getAttribute("data-loading")).toBe("true");
  await act(async () => resolve({ data: { id: "user-1", role: "tester" } }));
  expect(view.container.firstChild.getAttribute("data-user")).toBe("user-1");
  view.unmount();
});

test("changing from public to protected retry policy does not repeat the session check", async () => {
  mockGet.mockResolvedValueOnce({ data: { id: "user-1", role: "tester" } });
  const container = document.createElement("div");
  const root = createRoot(container);
  await act(async () => {
    root.render(<AuthProvider bootstrapRetries={0}><Probe /></AuthProvider>);
  });
  await act(async () => {
    root.render(<AuthProvider bootstrapRetries={2}><Probe /></AuthProvider>);
  });
  expect(mockGet).toHaveBeenCalledTimes(1);
  expect(container.firstChild.getAttribute("data-user")).toBe("user-1");
  act(() => root.unmount());
});

test("a late session success cannot overwrite a newer successful login", async () => {
  let resolveSession;
  mockGet.mockReturnValueOnce(new Promise((resolve) => { resolveSession = resolve; }));
  mockPost.mockResolvedValueOnce({ data: { user: { id: "new-user", role: "tester" } } });
  const view = renderProvider({ bootstrapRetries: 0 });

  await act(async () => view.container.querySelector("button").click());
  expect(view.container.firstChild.getAttribute("data-user")).toBe("new-user");
  await act(async () => resolveSession({ data: { id: "old-user", role: "tester" } }));
  expect(view.container.firstChild.getAttribute("data-user")).toBe("new-user");
  view.unmount();
});

test("a late session 401 cannot clear a newer successful login", async () => {
  let rejectSession;
  mockGet.mockReturnValueOnce(new Promise((resolve, reject) => { rejectSession = reject; }));
  mockPost.mockResolvedValueOnce({ data: { user: { id: "new-user", role: "tester" } } });
  const view = renderProvider({ bootstrapRetries: 0 });

  await act(async () => view.container.querySelector("button").click());
  await act(async () => rejectSession({ response: { status: 401 } }));
  expect(view.container.firstChild.getAttribute("data-user")).toBe("new-user");
  expect(view.container.firstChild.getAttribute("data-loading")).toBe("false");
  view.unmount();
});

test("AuthProvider retries a transient auth bootstrap failure without clearing a session", async () => {
  jest.useFakeTimers();
  mockGet
    .mockRejectedValueOnce({ response: { status: 503 } })
    .mockResolvedValueOnce({ data: { id: "user-1", role: "tester" } });
  const view = renderProvider();
  await act(async () => Promise.resolve());
  expect(view.container.firstChild.getAttribute("data-loading")).toBe("true");
  await act(async () => jest.advanceTimersByTime(AUTH_BOOTSTRAP_RETRY_DELAY_MS));
  expect(mockGet).toHaveBeenCalledTimes(2);
  expect(view.container.firstChild.getAttribute("data-user")).toBe("user-1");
  expect(view.container.firstChild.getAttribute("data-loading")).toBe("false");
  view.unmount();
  jest.useRealTimers();
});

test("remounting the provider revalidates the cookie-backed session", async () => {
  mockGet.mockResolvedValue({ data: { id: "user-1", role: "tester" } });
  let view = renderProvider();
  await act(async () => Promise.resolve());
  view.unmount();
  view = renderProvider();
  await act(async () => Promise.resolve());
  expect(mockGet).toHaveBeenCalledTimes(2);
  expect(view.container.firstChild.getAttribute("data-user")).toBe("user-1");
  view.unmount();
});