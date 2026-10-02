import { Suspense } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

test("retired release and regression pages are absent from routes and navigation", () => {
  const { APP_ROUTES, NAV_SECTIONS } = require("./routeConfig");
  for (const path of ["/release", "/regression", "/integrity"]) {
    expect(APP_ROUTES.some((route) => route.path === path)).toBe(false);
    expect(NAV_SECTIONS.flatMap((section) => section.items).some((item) => item.to === path)).toBe(false);
  }
  const administration = NAV_SECTIONS.find((section) => section.id === "administration");
  expect(administration.items.map((item) => item.label)).toEqual(expect.arrayContaining(["Calendar", "Demo Library"]));
  expect(NAV_SECTIONS.some((section) => section.id === "advanced-tools")).toBe(false);
});

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
