import { tableRowsToCsv, withinDateRange } from "./tableData";
import { compareTableValues } from "./tableSorting";
import { userRoleLabel, USER_ROLES } from "./userValidation";

test("date ranges include trustworthy ISO dates and exclude missing dates when constrained", () => {
  expect(withinDateRange("2026-09-01", "2026-08-01", "2026-09-30")).toBe(true);
  expect(withinDateRange("2026-07-31", "2026-08-01", "")).toBe(false);
  expect(withinDateRange(null, "", "")).toBe(true);
  expect(withinDateRange(null, "2026-01-01", "")).toBe(false);
});

test("date columns sort chronologically with missing values last", () => {
  const column = { key: "test_date", type: "date" };
  expect(compareTableValues("2025-12-31", "2026-01-01", column, "asc")).toBeLessThan(0);
  expect(compareTableValues("2025-12-31", "2026-01-01", column, "desc")).toBeGreaterThan(0);
  expect(compareTableValues(null, "2026-01-01", column, "asc")).toBeGreaterThan(0);
});

test("CSV exports explicit dates and user-facing missing-value labels", () => {
  const columns = [
    { key: "name", label: "Test Name" },
    { key: "test_date", label: "Test Date", exportValue: (row) => row.test_date || "Not recorded" },
  ];
  expect(tableRowsToCsv([{ name: "Dated", test_date: "2026-09-01" }, { name: "Historic", test_date: null }], columns))
    .toBe('"Test Name","Test Date"\n"Dated","2026-09-01"\n"Historic","Not recorded"');
});

test("professional role labels map to unchanged backend values", () => {
  expect(USER_ROLES).toEqual(["admin", "qa_manager", "tester", "developer", "viewer"]);
  expect(USER_ROLES.map(userRoleLabel)).toEqual(["Administrator", "QA Manager", "Tester", "Developer", "Viewer"]);
});