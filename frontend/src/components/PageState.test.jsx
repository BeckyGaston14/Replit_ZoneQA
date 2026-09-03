import { act } from "react";
import { createRoot } from "react-dom/client";
import { classifyRequestError, QueryState } from "./PageState";

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

jest.mock("./ui/button", () => ({
  Button: ({ children, asChild, ...props }) => asChild ? children : <button {...props}>{children}</button>,
}));

function renderState(query, props = {}) {
  const container = document.createElement("div");
  const root = createRoot(container);
  act(() => root.render(<QueryState query={query} resource="Test records" {...props} />));
  return { container, unmount: () => act(() => root.unmount()) };
}

test.each([
  [401, "session"],
  [403, "permission"],
  [404, "not-found"],
  [500, "recoverable"],
])("classifies HTTP %s request failures as %s", (status, expected) => {
  expect(classifyRequestError({ response: { status } })).toBe(expected);
});

test("renders distinct loading, session, permission, not-found, and retry states", () => {
  let view = renderState({ isLoading: true });
  expect(view.container.querySelector('[role="status"]').textContent).toContain("Loading");
  view.unmount();

  view = renderState({ isError: true, error: { response: { status: 401 } } });
  expect(view.container.textContent).toContain("session has expired");
  view.unmount();

  view = renderState({ isError: true, error: { response: { status: 403 } } });
  expect(view.container.textContent).toContain("Permission denied");
  view.unmount();

  const returnSafely = jest.fn();
  view = renderState({ isError: true, error: { response: { status: 404 } } }, { notFoundAction: returnSafely });
  act(() => view.container.querySelector("button").click());
  expect(returnSafely).toHaveBeenCalled();
  view.unmount();

  const retry = jest.fn();
  view = renderState({ isError: true, error: { response: { status: 500 } }, refetch: retry });
  act(() => view.container.querySelector("button").click());
  expect(retry).toHaveBeenCalled();
  view.unmount();
});