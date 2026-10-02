import {
  BarChart3, Briefcase, Building2, CalendarDays, Columns3, FileText, Flag,
  FlaskConical, FolderKanban, Grid3X3, LayoutDashboard, Library, ListChecks,
  MapPin, Settings, ShieldCheck, Star, Swords, Trophy,
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
    id: "bassett-only-testing", label: "My QA Workflow",
    description: "Choose a scenario, record the test, track findings, and organize related work.",
    items: [
      { to: ROUTES.bassettBank, label: "Bassett Test Bank", icon: Library },
      { to: ROUTES.bassettRuns, label: "Bassett Test Runs", icon: ListChecks, testId: "nav-bassett-only-tests", routeKey: "bassett-test-runs" },
      { to: ROUTES.bassettFindings, label: "Bassett Findings", icon: Flag, routeKey: "bassett-findings" },
      { to: ROUTES.projects, label: "Testing Projects", icon: FolderKanban },
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
    description: "Manage reference data and application settings.",
    items: [
      { to: ROUTES.municipalities, label: "Municipalities", icon: Building2 },
      { to: ROUTES.properties, label: "Properties", icon: MapPin },
      { to: ROUTES.evidence, label: "Ordinance Evidence", icon: FileText },
      { to: ROUTES.admin, label: "Administration", icon: Settings, roles: ["admin", "qa_manager"] },
    ],
  },
  {
    id: "advanced-tools", label: "Advanced Tools",
    description: "Use scheduling, demo, and system-check tools when needed.",
    items: [
      { to: ROUTES.calendar, label: "Calendar", icon: CalendarDays },
      { to: ROUTES.demos, label: "Demo Library", icon: Star },
      { to: ROUTES.integrity, label: "Data Integrity", icon: ShieldCheck, roles: ["admin", "qa_manager"] },
    ],
  },
];

