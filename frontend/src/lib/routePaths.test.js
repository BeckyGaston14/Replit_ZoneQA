import { ROUTES, dashboardRecordPath } from "./routePaths";

test("core record and compatibility deep links remain stable", () => {
  expect(ROUTES.findings).toBe("/findings");
  expect(ROUTES.bassettFindings).toBe("/bassett/findings");
  expect(ROUTES.bassettFindingsLegacy).toBe("/bassett/issues/findings");
  expect(ROUTES.comparison).toBe("/comparison");
  expect(ROUTES.testcase).toBe("/testcases/:id");
  expect(dashboardRecordPath("release confidence")).toBe("/dashboard/records/release%20confidence");
});