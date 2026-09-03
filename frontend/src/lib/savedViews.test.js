import { act } from "react";
import { createRoot } from "react-dom/client";
import { api } from "./api";
import { useSavedView } from "./savedViews";

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

jest.mock("./api", () => ({
  api: { get: jest.fn(), put: jest.fn() },
  formatApiErrorDetail: (detail) => String(detail || ""),
}));
let mockUserId = "user-one";
jest.mock("./auth", () => ({ useAuth: () => ({ user: { id: mockUserId } }) }));

function ViewHarness() {
  const { state, updateState, error } = useSavedView("projects", { filters: { status: "active" } });
  return <div>
    <span data-testid="status">{state.filters.status}</span>
    <span data-testid="error">{error}</span>
    <button type="button" onClick={() => updateState({ filters: { status: "archived" } })}>Archive view</button>
  </div>;
}

beforeEach(() => {
  mockUserId = "user-one";
  jest.useFakeTimers();
  api.get.mockReset().mockResolvedValue({ data: {} });
  api.put.mockReset();
});

test("switching users resets the old view before loading the new owner's server state", async () => {
  api.get
    .mockResolvedValueOnce({ data: { state: { filters: { status: "archived" } } } })
    .mockResolvedValueOnce({ data: { state: { filters: { status: "active" } } } });
  const container = document.createElement("div");
  const root = createRoot(container);
  await act(async () => root.render(<ViewHarness />));
  await act(async () => {});
  expect(container.querySelector('[data-testid="status"]').textContent).toBe("archived");

  mockUserId = "user-two";
  await act(async () => root.render(<ViewHarness />));
  await act(async () => {});

  expect(api.get).toHaveBeenCalledTimes(2);
  expect(container.querySelector('[data-testid="status"]').textContent).toBe("active");
  act(() => root.unmount());
});

afterEach(() => {
  jest.useRealTimers();
});

test("a rejected final saved-view write stays dirty and retries the latest state", async () => {
  api.put
    .mockRejectedValueOnce({ response: { data: { detail: "offline" } } })
    .mockResolvedValueOnce({ data: { ok: true } });
  const container = document.createElement("div");
  const root = createRoot(container);
  await act(async () => root.render(<ViewHarness />));
  await act(async () => {});

  act(() => container.querySelector("button").click());
  await act(async () => { jest.advanceTimersByTime(250); });
  await act(async () => {});

  expect(api.put).toHaveBeenCalledTimes(1);
  expect(container.querySelector('[data-testid="error"]').textContent).toContain("offline");

  await act(async () => { jest.advanceTimersByTime(1000); });
  await act(async () => {});

  expect(api.put).toHaveBeenCalledTimes(2);
  expect(api.put).toHaveBeenLastCalledWith("/views/projects", { state: { filters: { status: "archived" } } });
  expect(container.querySelector('[data-testid="error"]').textContent).toBe("");
  act(() => root.unmount());
});

test("persistent saved-view failures stop after the bounded retry attempts", async () => {
  api.put.mockRejectedValue({ response: { data: { detail: "offline" } } });
  const container = document.createElement("div");
  const root = createRoot(container);
  await act(async () => root.render(<ViewHarness />));
  await act(async () => {});

  act(() => container.querySelector("button").click());
  await act(async () => { jest.advanceTimersByTime(250); });
  await act(async () => {});
  await act(async () => { jest.advanceTimersByTime(1000); });
  await act(async () => {});
  await act(async () => { jest.advanceTimersByTime(2000); });
  await act(async () => {});

  expect(api.put).toHaveBeenCalledTimes(3);
  await act(async () => { jest.advanceTimersByTime(30000); });
  await act(async () => {});
  expect(api.put).toHaveBeenCalledTimes(3);
  expect(container.querySelector('[data-testid="error"]').textContent).toContain("offline");
  act(() => root.unmount());
});