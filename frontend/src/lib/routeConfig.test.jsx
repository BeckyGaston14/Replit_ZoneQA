import { Suspense } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const mockDashboardFactory = jest.fn();
jest.mock("../pages/Dashboard", () => {
  mockDashboardFactory();
  return {
    __esModule: true,
    default: () => <div data-testid="dashboard-route">Dashboard loaded</div>,
  };
});

test("authenticated routes are lazy and still resolve after navigation", async () => {
  let APP_ROUTES;
  jest.isolateModules(() => {
    ({ APP_ROUTES } = require("./routeConfig"));
  });

  expect(mockDashboardFactory).not.toHaveBeenCalled();
  const dashboard = APP_ROUTES.find((route) => route.path === "/");
  const DashboardRoute = dashboard.component;
  const container = document.createElement("div");
  const root = createRoot(container);

  await act(async () => {
    root.render(
      <Suspense fallback={<div data-testid="route-loading">Loading page…</div>}>
        <DashboardRoute />
      </Suspense>,
    );
  });

  expect(mockDashboardFactory).toHaveBeenCalledTimes(1);
  expect(container.querySelector('[data-testid="dashboard-route"]')).not.toBeNull();
  act(() => root.unmount());
});