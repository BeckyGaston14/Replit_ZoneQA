import fs from "fs";
import path from "path";

const source = (name) => fs.readFileSync(path.join(__dirname, `${name}.jsx`), "utf8");

test("Test Bank run entry receives existing linked records and all shared lookups", () => {
  const text = source("BassettTestBank");
  for (const key of ["municipalities", "properties", "users", "evidenceRecords", "availableFindings", "config"]) {
    expect(text).toContain(`${key}={${key}}`);
  }
  expect(text).toContain('useCollection("municipalities")');
  expect(text).toContain('useCollection("properties")');
  expect(text).toContain('enabled: Boolean(form || execute)');
  expect(text).toContain('["P0 - Immediate", "P1 - High", "P2 - Medium", "P3 - Low"]');
  expect(text).not.toContain('"P2 - Medium", "Critical"');
});

test("performance uses its plain title and hides comparison cards for Bassett-only scope", () => {
  expect(source("Performance")).toContain('title="Bassett Performance"');
  expect(source("Performance")).not.toContain("Performance & Reward");
  expect(source("Performance")).toMatch(/perf.report_scope !== "bassett" && <>[\s\S]*label="Bassett Wins"[\s\S]*label="Shared Failures"[\s\S]*<\/>/);
});

test.each([
  ["CalendarPage", /QueryState query=\{calendarQuery\}/],
  ["Regression", /QueryState query=\{failed\}/],
  ["ReleaseReadiness", /resource="release readiness"/],
  ["Performance", /resource="performance data"/],
  ["TestCases", /resource="test cases"/],
])("%s uses the shared loading, session, permission, and retry state contract", (page, contract) => {
  expect(source(page)).toMatch(contract);
});

test("core selections and filters are URL- or server-backed for refresh and history restoration", () => {
  expect(source("CalendarPage")).toMatch(/params\.set\("month"/);
  expect(source("Regression")).toMatch(/params\.set\("run"/);
  expect(source("ReleaseReadiness")).toMatch(/params\.set\("version"/);
  expect(source("Performance")).toMatch(/useSavedView\("performance"/);
  expect(source("TestCases")).toMatch(/useSavedView\(\s*"testcases"/);
  expect(source("TestCaseDetail")).toMatch(/params\.set\("tab"/);
});

test.each(["CalendarPage", "Regression", "TestCases"])("%s hides primary write actions from viewers", (page) => {
  expect(source(page)).toMatch(/role !== "viewer"/);
});

test("Data Integrity results are stale immediately and refetch after repeat navigation", () => {
  expect(source("DataIntegrity")).toMatch(/queryKey: \["integrity"\][\s\S]*staleTime: 0,[\s\S]*refetchOnMount: true/);
  expect(source("DataIntegrity")).not.toMatch(/queryKey: \["integrity"\][\s\S]*staleTime: Infinity/);
});
