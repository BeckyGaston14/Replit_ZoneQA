import fs from "fs";
import path from "path";

const source = (name) => fs.readFileSync(path.join(__dirname, `${name}.jsx`), "utf8");

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