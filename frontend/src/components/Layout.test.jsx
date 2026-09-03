import { act } from "react";
import { createRoot } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import Layout, { SECTIONS } from "./Layout";

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

jest.mock("react-router-dom", () => {
  const React = require("react");
  return {
    MemoryRouter: ({ children }) => children,
    useLocation: () => {
      const url = new URL(global.__sidebarTestPath || "/", "https://zoneqa.test");
      return { pathname: url.pathname, search: url.search, hash: url.hash };
    },
    useNavigate: () => jest.fn(),
    Link: ({ to, children, className, ...props }) => {
      const content = typeof children === "function" ? children({ isActive: false }) : children;
      return React.createElement("a", {
        ...props,
        href: to,
        className,
      }, content);
    },
  };
}, { virtual: true });

jest.mock("../lib/auth", () => ({
  useAuth: () => ({ user: { id: "viewer-1", role: "viewer", name: "Viewer" }, logout: jest.fn() }),
}));

jest.mock("../lib/api", () => ({
  api: { get: jest.fn(() => Promise.resolve({ data: {} })) },
}));

jest.mock("@tanstack/react-query", () => ({
  useQuery: () => ({ data: {} }),
}));

jest.mock("./GlobalSearch", () => ({
  GlobalSearch: () => <div data-testid="global-search" />,
}));

function renderLayout(path = "/bassett/issues", children = <div data-testid="page-content">Page</div>) {
  global.__sidebarTestPath = path;
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => {
    root.render(
      <MemoryRouter initialEntries={[path]}>
        <Layout>{children}</Layout>
      </MemoryRouter>,
    );
  });
  return {
    container,
    unmount: () => act(() => root.unmount()),
  };
}

afterEach(() => {
  window.localStorage.clear();
  Object.defineProperty(window, "innerWidth", { configurable: true, value: 1024 });
  document.body.innerHTML = "";
});

test("section headings are native accessible controls and active routes stay expanded", () => {
  const view = renderLayout();
  const testingToggle = view.container.querySelector('[data-testid="nav-section-toggle-bassett-only-testing"]');
  const testingRegion = view.container.querySelector("#nav-section-bassett-only-testing");

  expect(testingToggle.tagName).toBe("BUTTON");
  expect(testingToggle.type).toBe("button");
  expect(testingToggle.getAttribute("aria-expanded")).toBe("true");
  expect(testingToggle.getAttribute("aria-controls")).toBe("nav-section-bassett-only-testing");
  expect(testingToggle.getAttribute("aria-label")).toMatch(/Collapse Bassett-Only Testing/);
  expect(testingRegion.getAttribute("aria-hidden")).toBe("false");
  expect(view.container.querySelector('[data-testid="nav-bassett-only-tests"]')).not.toBeNull();
  expect(view.container.textContent).not.toMatch(/issues to address/i);

  act(() => { testingToggle.click(); });
  expect(testingToggle.getAttribute("aria-expanded")).toBe("true");
  expect(view.container.querySelector('[data-testid="nav-bassett-only-tests"]')).not.toBeNull();
  view.unmount();
});

test("toggling a non-active group persists and collapse all keeps the active group reachable", () => {
  const view = renderLayout("/testcases");
  const administrationToggle = view.container.querySelector('[data-testid="nav-section-toggle-administration"]');
  const testingToggle = view.container.querySelector('[data-testid="nav-section-toggle-bassett-only-testing"]');
  expect(testingToggle.textContent).toContain("Bassett-Only Testing");
  expect(testingToggle.getAttribute("aria-label")).toMatch(/Expand Bassett-Only Testing/);
  expect(view.container.querySelector("#nav-section-bassett-only-testing").getAttribute("aria-hidden")).toBe("true");
  expect(view.container.querySelector('[data-testid="nav-model-comparison-test-cases"]')).not.toBeNull();
  act(() => { administrationToggle.click(); });
  expect(administrationToggle.getAttribute("aria-expanded")).toBe("true");
  act(() => { administrationToggle.click(); });
  expect(administrationToggle.getAttribute("aria-expanded")).toBe("false");
  expect(administrationToggle.getAttribute("aria-label")).toMatch(/Expand Administration/);

  act(() => { view.container.querySelector('[data-testid="collapse-all-nav"]').click(); });
  expect(view.container.querySelector('[data-testid="nav-section-toggle-model-comparison"]').getAttribute("aria-expanded")).toBe("true");
  expect(view.container.querySelector('[data-testid="nav-model-comparison-test-cases"]').getAttribute("aria-current")).toBe("page");
  expect(JSON.parse(window.localStorage.getItem("zoneqa.sidebar.groups.viewer-1"))).toMatchObject({
    "model-comparison": true,
    administration: false,
  });

  act(() => { view.container.querySelector('[data-testid="expand-all-nav"]').click(); });
  expect(view.container.querySelector('[data-testid="nav-section-toggle-administration"]').getAttribute("aria-expanded")).toBe("true");
  view.unmount();
});

test("permission-filtered navigation omits administrator-only links", () => {
  const view = renderLayout("/admin");
  expect(view.container.querySelector('[data-testid="nav-integrity"]')).toBeNull();
  expect(view.container.querySelector('[data-testid="nav-administration"]')).toBeNull();
  view.unmount();
});

test.each([320, 375, 768])("mobile navigation works as a drawer at %ipx and restores focus on Escape", (width) => {
  Object.defineProperty(window, "innerWidth", { configurable: true, value: width });
  const view = renderLayout();
  const openButton = view.container.querySelector('button[aria-label="Open navigation"]');
  const sidebar = view.container.querySelector("#primary-navigation");

  expect(openButton.className).toContain("lg:hidden");
  expect(sidebar.className).toContain("lg:translate-x-0");
  expect(sidebar.querySelector("nav").className).toContain("overflow-y-auto");
  expect(sidebar.className).toContain("-translate-x-full");
  expect(sidebar.hasAttribute("inert")).toBe(true);
  expect(sidebar.getAttribute("aria-hidden")).toBe("true");

  openButton.focus();
  act(() => { openButton.click(); });
  expect(openButton.getAttribute("aria-expanded")).toBe("true");
  expect(sidebar.className).toContain("translate-x-0");
  expect(sidebar.hasAttribute("inert")).toBe(false);
  expect(sidebar.hasAttribute("aria-hidden")).toBe(false);
  expect(document.activeElement.getAttribute("aria-label")).toBe("Close navigation");

  act(() => {
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  });
  expect(openButton.getAttribute("aria-expanded")).toBe("false");
  expect(sidebar.hasAttribute("inert")).toBe(true);
  expect(document.activeElement).toBe(openButton);
  view.unmount();
});

test("workflow navigation excludes dashboard record helper routes while destination counts remain available", () => {
  const overview = SECTIONS.find((section) => section.id === "overview");
  const testing = SECTIONS.find((section) => section.id === "bassett-only-testing");
  expect(SECTIONS).toHaveLength(6);
  expect(overview.items.map((item) => item.label)).toEqual(["Dashboard"]);
  expect(testing.items.map((item) => item.label)).toEqual(["Testing Projects", "Bassett Test Bank", "Bassett Test Runs", "Bassett Findings"]);
  expect(SECTIONS.flatMap((section) => section.items).some((item) => item.to.startsWith("/dashboard/records/"))).toBe(false);

  const view = renderLayout("/bassett/issues", <div data-testid="destination-count">12 open findings</div>);
  expect(view.container.querySelector('[data-testid="nav-test-cases"] .nav-count-badge')).toBeNull();
  expect(view.container.querySelector('[data-testid="destination-count"]').textContent).toContain("12");
  view.unmount();
});

test("the mobile drawer restores focus after close button, backdrop, and navigation closes", () => {
  Object.defineProperty(window, "innerWidth", { configurable: true, value: 320 });
  const view = renderLayout();
  const openButton = view.container.querySelector('button[aria-label="Open navigation"]');
  const closeAndAssert = (close) => {
    openButton.focus();
    act(() => { openButton.click(); });
    act(close);
    expect(document.activeElement).toBe(openButton);
  };

  closeAndAssert(() => view.container.querySelector('button[aria-label="Close navigation"]').click());
  closeAndAssert(() => view.container.querySelector('button[aria-label="Close navigation menu"]').click());
  closeAndAssert(() => view.container.querySelector('[data-testid="nav-bassett-only-tests"]').click());
  view.unmount();
});

test("no navigation section or rendered sidebar variant contains numeric count badges", () => {
  expect(SECTIONS.flatMap((section) => section.items).every((item) => item.count === undefined)).toBe(true);
  const view = renderLayout("/demos");
  expect(view.container.querySelectorAll(".nav-count-badge")).toHaveLength(0);
  view.unmount();
});

test("navigation uses the requested workflow groups and preserves distinct destinations", () => {
  expect(SECTIONS.map((section) => section.label)).toEqual([
    "Overview", "Bassett-Only Testing", "Model Comparison", "Findings & Retesting", "Insights & Reports", "Administration",
  ]);
  const testing = SECTIONS.find((section) => section.id === "bassett-only-testing");
  const modelComparison = SECTIONS.find((section) => section.id === "model-comparison");
  const administration = SECTIONS.find((section) => section.id === "administration");
  expect(testing.items.find((item) => item.to === "/bassett/test-bank").label).toBe("Bassett Test Bank");
  expect(modelComparison.items.map((item) => item.label)).toEqual(["AI Comparison", "Model Comparison Test Cases", "Model Comparison Findings"]);
  expect(administration.items).toEqual(expect.arrayContaining([
    expect.objectContaining({ to: "/calendar", label: "Calendar" }),
  ]));
});

test.each([
  ["/bassett/issues", "nav-bassett-only-tests"],
  ["/bassett/issues?open=run-1", "nav-bassett-only-tests"],
  ["/bassett/findings", "nav-bassett-findings"],
  ["/bassett/findings?open=finding-1#detail", "nav-bassett-findings"],
  ["/bassett/test-bank/scenario-1/edit", "nav-bassett-test-bank"],
])("exactly one navigation item owns %s", (route, expectedTestId) => {
  const view = renderLayout(route);
  const current = [...view.container.querySelectorAll('[aria-current="page"]')];
  expect(current).toHaveLength(1);
  expect(current[0].getAttribute("data-testid")).toBe(expectedTestId);
  view.unmount();
});

test.each(["/dashboard/records/active-projects", "/dashboard/records/open-findings", "/dashboard/records/bassett-score"])(
  "dashboard detail route %s remains unclaimed by primary navigation",
  (route) => {
    const view = renderLayout(route);
    expect(view.container.querySelectorAll('[aria-current="page"]')).toHaveLength(0);
    view.unmount();
  },
);