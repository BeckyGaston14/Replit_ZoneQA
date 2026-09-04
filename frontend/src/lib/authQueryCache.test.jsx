import { act } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { AuthQueryCacheBoundary } from "./authQueryCache";

let mockAuthState = { user: { id: "user-a" } };
jest.mock("./auth", () => ({ useAuth: () => mockAuthState }));

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

test("clears the previous user's cache before rendering the switched user's children", () => {
  const queryClient = new QueryClient();
  queryClient.setQueryData(["projects", "user-a"], [{ id: "private-a" }]);
  const container = document.createElement("div");
  const root = createRoot(container);

  act(() => root.render(
    <QueryClientProvider client={queryClient}>
      <AuthQueryCacheBoundary><div data-testid="ready">Ready</div></AuthQueryCacheBoundary>
    </QueryClientProvider>,
  ));
  expect(container.querySelector('[data-testid="ready"]')).not.toBeNull();

  mockAuthState = { user: { id: "user-b" } };
  act(() => root.render(
    <QueryClientProvider client={queryClient}>
      <AuthQueryCacheBoundary><div data-testid="ready">Ready</div></AuthQueryCacheBoundary>
    </QueryClientProvider>,
  ));

  expect(queryClient.getQueryData(["projects", "user-a"])).toBeUndefined();
  expect(container.querySelector('[data-testid="ready"]')).not.toBeNull();
  act(() => root.unmount());
});