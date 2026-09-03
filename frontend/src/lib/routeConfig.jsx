import Dashboard from "../pages/Dashboard";
import DashboardRecords from "../pages/DashboardRecords";
import Performance from "../pages/Performance";
import TestCases from "../pages/TestCases";
import TestCaseDetail from "../pages/TestCaseDetail";
import VariantComparison from "../pages/VariantComparison";
import Comparison from "../pages/Comparison";
import Findings from "../pages/Findings";
import Regression from "../pages/Regression";
import ReleaseReadiness from "../pages/ReleaseReadiness";
import Executive from "../pages/Executive";
import Coverage from "../pages/Coverage";
import Insights from "../pages/Insights";
import CalendarPage from "../pages/CalendarPage";
import Demos from "../pages/Demos";
import Reports from "../pages/Reports";
import Admin from "../pages/Admin";
import DataIntegrity from "../pages/DataIntegrity";
import AccountSecurity from "../pages/AccountSecurity";
import AuditDetail from "../pages/AuditDetail";
import BassettIssues from "../pages/BassettIssues";
import BassettTestBank from "../pages/BassettTestBank";
import { Projects, Municipalities, Properties, Evidence } from "../pages/Resources";
import { ROUTES } from "./routePaths";
export { NAV_SECTIONS } from "./navigationConfig";

export { ROUTES } from "./routePaths";

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
