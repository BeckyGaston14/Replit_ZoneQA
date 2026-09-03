import { act } from "react";
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
  const { user, loading } = useAuth();
  return <div data-user={user?.id || ""} data-loading={String(loading)} />;
}

function renderProvider() {
  const container = document.createElement("div");
  const root = createRoot(container);
  act(() => root.render(<AuthProvider><Probe /></AuthProvider>));
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