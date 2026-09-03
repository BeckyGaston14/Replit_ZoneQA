import {
  BarChart3, Briefcase, Building2, CalendarDays, Columns3, FileText, Flag,
  FlaskConical, FolderKanban, Grid3X3, LayoutDashboard, Library, ListChecks,
  MapPin, RefreshCw, Rocket, Settings, ShieldCheck, Star, Swords, Trophy,
} from "lucide-react";
import { ROUTES } from "./routePaths";

export const NAV_SECTIONS = [
  {
    id: "overview", label: "Overview",
    description: "Start here for the current QA picture and guided next steps.",
    items: [
      { to: ROUTES.dashboard, label: "Dashboard", icon: LayoutDashboard, end: true },
    ],
  },
  {
    id: "bassett-only-testing", label: "Bassett-Only Testing",
    description: "Configure projects, select canonical scenarios, and run Bassett without other models.",
    items: [
      { to: ROUTES.projects, label: "Testing Projects", icon: FolderKanban },
      { to: ROUTES.bassettBank, label: "Bassett Test Bank", icon: Library },
      { to: ROUTES.bassettRuns, label: "Bassett Test Runs", icon: ListChecks, testId: "nav-bassett-only-tests", routeKey: "bassett-test-runs" },
      { to: ROUTES.bassettFindings, label: "Bassett Findings", icon: Flag, routeKey: "bassett-findings" },
    ],
  },
  {
    id: "model-comparison", label: "Model Comparison",
    description: "Review standard test cases, full Bassett vs ChatGPT vs Claude runs, and their findings.",
    items: [
      { to: ROUTES.comparison, label: "AI Comparison", icon: Columns3 },
      { to: ROUTES.testcases, label: "Model Comparison Test Cases", icon: FlaskConical },
      { to: ROUTES.findings, label: "Model Comparison Findings", icon: Flag },
    ],
  },
  {
    id: "findings-retesting", label: "Findings & Retesting",
    description: "Review issues, retest fixes, compare regressions, and make release decisions.",
    items: [
      { to: ROUTES.regression, label: "Regression Testing", icon: RefreshCw },
      { to: ROUTES.release, label: "Release Readiness", icon: Rocket },
    ],
  },
  {
    id: "insights-reports", label: "Insights & Reports",
    description: "Analyze coverage and performance, then share the evidence.",
    items: [
      { to: ROUTES.performance, label: "Bassett Performance", icon: Trophy },
      { to: ROUTES.coverage, label: "Test Coverage", icon: Grid3X3 },
      { to: ROUTES.insights, label: "Competitive Insights", icon: Swords },
      { to: ROUTES.executive, label: "Executive Summary", icon: Briefcase },
      { to: ROUTES.reports, label: "Reports", icon: BarChart3 },
    ],
  },
  {
    id: "administration", label: "Administration",
    description: "Manage reference data, schedules, demos, and restricted system controls.",
    items: [
      { to: ROUTES.municipalities, label: "Municipalities", icon: Building2 },
      { to: ROUTES.properties, label: "Properties", icon: MapPin },
      { to: ROUTES.evidence, label: "Ordinance Evidence", icon: FileText },
      { to: ROUTES.demos, label: "Demo Library", icon: Star },
      { to: ROUTES.calendar, label: "Calendar", icon: CalendarDays },
      { to: ROUTES.admin, label: "Administration", icon: Settings, roles: ["admin", "qa_manager"] },
      { to: ROUTES.integrity, label: "Data Integrity", icon: ShieldCheck, roles: ["admin", "qa_manager"] },
    ],
  },
];