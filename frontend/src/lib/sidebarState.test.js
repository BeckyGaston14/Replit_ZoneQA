import {
  activeSectionId,
  defaultExpanded,
  preferenceKey,
  readExpandedPreferences,
  sectionId,
  setAllSections,
  toggleSection,
  visibleSectionItems,
  writeExpandedPreferences,
  navItemMatches,
} from "./sidebarState";

const bassettItems = [
  { to: "/bassett/issues", label: "Bassett Test Runs", routeKey: "bassett-test-runs" },
  { to: "/bassett/issues?view=findings", label: "Bassett Findings", routeKey: "bassett-findings" },
  { to: "/bassett/test-bank", label: "Test Bank" },
];

const sections = [
  {
    id: "work",
    items: [
      { to: "/", end: true },
      { to: "/testcases" },
    ],
  },
  {
    id: "bassett-testing",
    items: [
      { to: "/bassett/issues" },
      { to: "/bassett/test-bank" },
    ],
  },
  {
    id: "system",
    items: [
      { to: "/admin" },
      { to: "/integrity", adminOnly: true },
    ],
  },
];

function storage(initial = {}) {
  const values = { ...initial };
  return {
    getItem: (key) => values[key] || null,
    setItem: (key, value) => { values[key] = value; },
    values,
  };
}

test("first-time users see Overview while advanced workflow groups stay collapsed", () => {
  expect(defaultExpanded(["overview", "testing", "administration"])).toEqual({
    overview: true,
    testing: false,
    administration: false,
  });
});

test("section IDs and preferences are namespaced per user", () => {
  expect(sectionId("Bassett Testing")).toBe("bassett-testing");
  expect(preferenceKey("user-42")).toBe("zoneqa.sidebar.groups.user-42");
  expect(preferenceKey()).toBe("zoneqa.sidebar.groups.anonymous");
});

test("collapsed preferences persist and invalid values safely fall back to expanded", () => {
  const saved = storage({ "sidebar": JSON.stringify({ work: false, unknown: false }) });
  expect(readExpandedPreferences(saved, "sidebar", ["work", "system"])).toEqual({ work: false, system: false });
  writeExpandedPreferences(saved, "sidebar", { work: false, system: true });
  expect(JSON.parse(saved.values.sidebar)).toEqual({ work: false, system: true });

  const broken = { getItem: () => "{not-json", setItem: () => {} };
  expect(readExpandedPreferences(broken, "sidebar", ["overview", "testing"])).toEqual({ overview: true, testing: false });
});

test("active routes resolve to their group, including nested routes", () => {
  expect(activeSectionId(sections, "/")).toBe("work");
  expect(activeSectionId(sections, "/testcases/abc")).toBe("work");
  expect(activeSectionId(sections, "/bassett/test-bank")).toBe("bassett-testing");
  expect(activeSectionId(sections, "/not-a-route")).toBeNull();
});

test("toggling and bulk controls never hide the active group", () => {
  const expanded = { work: true, "bassett-testing": true, system: true };
  expect(toggleSection(expanded, "system", "work")).toEqual({ work: true, "bassett-testing": true, system: false });
  expect(toggleSection(expanded, "work", "work")).toEqual(expanded);
  expect(setAllSections(expanded, Object.keys(expanded), false, "bassett-testing")).toEqual({
    work: false,
    "bassett-testing": true,
    system: false,
  });
  expect(setAllSections(expanded, Object.keys(expanded), true, "bassett-testing")).toEqual({
    work: true,
    "bassett-testing": true,
    system: true,
  });
});

test("permission filtering preserves allowed links and removes administrator-only links", () => {
  expect(visibleSectionItems(sections[2], { role: "viewer" }).map((item) => item.to)).toEqual(["/admin"]);
  expect(visibleSectionItems(sections[2], { role: "admin" }).map((item) => item.to)).toEqual(["/admin", "/integrity"]);
});

test("active group remains expanded on narrow layouts", () => {
  const collapsed = { work: false, "bassett-testing": false, system: false };
  const active = activeSectionId(sections, "/bassett/issues");
  expect(setAllSections(collapsed, Object.keys(collapsed), false, active)[active]).toBe(true);
});

test("Bassett siblings have exclusive ownership across list, detail, query, hash, and trailing-slash routes", () => {
  const runs = bassettItems.find((item) => item.routeKey === "bassett-test-runs");
  const findings = bassettItems.find((item) => item.routeKey === "bassett-findings");
  const bank = bassettItems.find((item) => item.to === "/bassett/test-bank");
  const cases = [
    ["/bassett/issues", runs],
    ["/bassett/issues/new", runs],
    ["/bassett/issues/run-1", runs],
    ["/bassett/issues/run-1/edit", runs],
    ["/bassett/issues?open=run-1#history", runs],
    ["/bassett/issues/", runs],
    ["/bassett/issues?view=findings", findings],
    ["/bassett/issues?view=findings&open=finding-1#details", findings],
    ["/bassett/findings/finding-1", findings],
    ["/bassett/issues/findings/finding-1/edit", findings],
    ["/bassett/test-bank", bank],
    ["/bassett/test-bank/scenario-1", bank],
    ["/bassett/test-bank/scenario-1/edit", bank],
    ["/bassett/test-bank/scenario-1/run", bank],
    ["/bassett/test-bank?run=scenario-1#run", bank],
  ];
  for (const [route, owner] of cases) {
    const active = bassettItems.filter((item) => navItemMatches(item, route));
    expect(active).toEqual([owner]);
  }
});

test("all current navigation routes resolve to at most one item, including detail and comparison links", () => {
  const allItems = sections.flatMap((section) => section.items).concat(bassettItems);
  const routes = [
    "/", "/projects", "/projects/p-1", "/testcases", "/testcases/t-1", "/testcases/t-1/edit",
    "/findings?id=f-1", "/comparison", "/comparison/t-1", "/regression", "/release",
    "/performance", "/coverage", "/reports", "/municipalities/", "/evidence",
    "/demos", "/admin", "/integrity",
  ];
  for (const route of routes) {
    expect(allItems.filter((item) => navItemMatches(item, route)).length).toBeLessThanOrEqual(1);
  }
});

test("back and forward route transitions change exactly one active Bassett child without permission changes", () => {
  const routeOwner = (route) => bassettItems.filter((item) => navItemMatches(item, route)).map((item) => item.label);
  expect(routeOwner("/bassett/issues")).toEqual(["Bassett Test Runs"]);
  expect(routeOwner("/bassett/issues?view=findings")).toEqual(["Bassett Findings"]);
  expect(routeOwner("/bassett/test-bank/one")).toEqual(["Test Bank"]);
  expect(routeOwner("/bassett/issues?open=one")).toEqual(["Bassett Test Runs"]);
});