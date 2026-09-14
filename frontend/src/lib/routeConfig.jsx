import { lazy } from "react";
import { ROUTES } from "./routePaths";
export { NAV_SECTIONS } from "./navigationConfig";

export { ROUTES } from "./routePaths";

const Dashboard = lazy(() => import("../pages/Dashboard"));
const DashboardRecords = lazy(() => import("../pages/DashboardRecords"));
const Performance = lazy(() => import("../pages/Performance"));
const TestCases = lazy(() => import("../pages/TestCases"));
const TestCaseDetail = lazy(() => import("../pages/TestCaseDetail"));
const VariantComparison = lazy(() => import("../pages/VariantComparison"));
const Comparison = lazy(() => import("../pages/Comparison"));
const Findings = lazy(() => import("../pages/Findings"));
const Regression = lazy(() => import("../pages/Regression"));
const ReleaseReadiness = lazy(() => import("../pages/ReleaseReadiness"));
const Executive = lazy(() => import("../pages/Executive"));
const Coverage = lazy(() => import("../pages/Coverage"));
const Insights = lazy(() => import("../pages/Insights"));
const CalendarPage = lazy(() => import("../pages/CalendarPage"));
const Demos = lazy(() => import("../pages/Demos"));
const Reports = lazy(() => import("../pages/Reports"));
const Admin = lazy(() => import("../pages/Admin"));
const DataIntegrity = lazy(() => import("../pages/DataIntegrity"));
const AccountSecurity = lazy(() => import("../pages/AccountSecurity"));
const AuditDetail = lazy(() => import("../pages/AuditDetail"));
const BassettIssues = lazy(() => import("../pages/BassettIssues"));
const BassettTestBank = lazy(() => import("../pages/BassettTestBank"));
const Projects = lazy(() => import("../pages/Resources").then((module) => ({ default: module.Projects })));
const Municipalities = lazy(() => import("../pages/Resources").then((module) => ({ default: module.Municipalities })));
const Properties = lazy(() => import("../pages/Resources").then((module) => ({ default: module.Properties })));
const Evidence = lazy(() => import("../pages/Resources").then((module) => ({ default: module.Evidence })));

export const APP_ROUTES = [
  { path: ROUTES.dashboard, component: Dashboard },
  { path: ROUTES.dashboardRecord, component: DashboardRecords },
  { path: ROUTES.performance, component: Performance },
  { path: ROUTES.projects, component: Projects },
  { path: ROUTES.testcases, component: TestCases },
  { path: ROUTES.testcase, component: TestCaseDetail },
  { path: ROUTES.variants, component: VariantComparison },
  { path: ROUTES.municipalities, component: Municipalities },
  { path: ROUTES.properties, component: Properties },
  { path: ROUTES.comparison, component: Comparison },
  { path: ROUTES.findings, component: Findings },
  { path: ROUTES.bassettRuns, component: BassettIssues },
  { path: ROUTES.bassettFindings, component: BassettIssues, forceSearch: { view: "findings" } },
  { path: ROUTES.bassettFindingsLegacy, component: BassettIssues, forceSearch: { view: "findings" } },
  { path: ROUTES.bassettBank, component: BassettTestBank },
  { path: ROUTES.regression, component: Regression },
  { path: ROUTES.release, component: ReleaseReadiness },
  { path: ROUTES.executive, component: Executive },
  { path: ROUTES.coverage, component: Coverage },
  { path: ROUTES.insights, component: Insights },
  { path: ROUTES.calendar, component: CalendarPage },
  { path: ROUTES.evidence, component: Evidence },
  { path: ROUTES.demos, component: Demos },
  { path: ROUTES.reports, component: Reports },
  { path: ROUTES.admin, component: Admin, roles: ["admin", "qa_manager"] },
  { path: ROUTES.integrity, component: DataIntegrity, roles: ["admin", "qa_manager"] },
  { path: ROUTES.security, component: AccountSecurity },
  { path: ROUTES.auditDetail, component: AuditDetail, roles: ["admin"] },
];
