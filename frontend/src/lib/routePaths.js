export const ROUTES = {
  dashboard: "/",
  dashboardRecord: "/dashboard/records/:metric",
  performance: "/performance",
  projects: "/projects",
  testcases: "/testcases",
  testcase: "/testcases/:id",
  variants: "/testcases/:id/variants",
  municipalities: "/municipalities",
  properties: "/properties",
  comparison: "/comparison",
  findings: "/findings",
  bassettRuns: "/bassett/issues",
  bassettFindings: "/bassett/findings",
  bassettFindingsLegacy: "/bassett/issues/findings",
  bassettBank: "/bassett/test-bank",
  regression: "/regression",
  release: "/release",
  executive: "/executive",
  coverage: "/coverage",
  insights: "/insights",
  calendar: "/calendar",
  evidence: "/evidence",
  demos: "/demos",
  reports: "/reports",
  admin: "/admin",
  integrity: "/integrity",
  security: "/security",
  auditDetail: "/admin/audit/:id",
};

export function dashboardRecordPath(metric) {
  return ROUTES.dashboardRecord.replace(":metric", encodeURIComponent(metric));
}