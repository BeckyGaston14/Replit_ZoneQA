import { act } from "react";
import { createRoot } from "react-dom/client";
import {
  ACTIVITY_STATUSES,
  CALENDAR_EVENT_STATES,
  CALENDAR_EVENT_STATUSES,
  COMPARISON_RUN_STATUSES,
  COMPARISON_SLOT_STATUSES,
  COVERAGE_STATUSES,
  DEMO_STATUSES,
  GOLD_STANDARD_STATUSES,
  INTEGRITY_CHECK_STATUSES,
  INTEGRITY_SEVERITIES,
  REGRESSION_DELTA_STATUSES,
  REGRESSION_RUN_STATUSES,
  RELEASE_DECISIONS,
  RESULT_STATUSES,
  RETEST_LIFECYCLE_STATUSES,
  StatusBadge,
  TEST_CASE_STATUSES,
  TEST_WORKFLOW_STATUSES,
  contrastRatio,
  readableTextColor,
  statusDefinition,
} from "./statusMaps";

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

function normalizeCssColor(color) {
  const value = String(color).trim().toLowerCase();
  const hex = value.match(/^#([0-9a-f]{6})$/);
  if (hex) return hex[1];
  const rgb = value.match(/^rgb\(\s*(\d+),\s*(\d+),\s*(\d+)\s*\)$/);
  return rgb ? rgb.slice(1).map((channel) => Number(channel).toString(16).padStart(2, "0")).join("") : value;
}

const consumers = [
  ACTIVITY_STATUSES,
  CALENDAR_EVENT_STATES,
  CALENDAR_EVENT_STATUSES,
  COMPARISON_RUN_STATUSES,
  COMPARISON_SLOT_STATUSES,
  COVERAGE_STATUSES,
  DEMO_STATUSES,
  GOLD_STANDARD_STATUSES,
  INTEGRITY_CHECK_STATUSES,
  INTEGRITY_SEVERITIES,
  REGRESSION_DELTA_STATUSES,
  REGRESSION_RUN_STATUSES,
  RELEASE_DECISIONS,
  RESULT_STATUSES,
  RETEST_LIFECYCLE_STATUSES,
  TEST_CASE_STATUSES,
  TEST_WORKFLOW_STATUSES,
];

test.each(consumers.flatMap((definitions) => Object.keys(definitions).map((value) => [value, definitions])))(
  "%s has an accessible shared status definition with sufficient text contrast",
  (value, definitions) => {
    const definition = statusDefinition(value, definitions);
    expect(definition.description).toBeTruthy();
    expect(definition.icon).toBeTruthy();
    expect(contrastRatio(definition.color, readableTextColor(definition.color))).toBeGreaterThanOrEqual(4.5);
  },
);

test("shared badges expose label and description to screen readers and handle unknown values", () => {
  const container = document.createElement("div");
  const root = createRoot(container);
  act(() => root.render(<><StatusBadge value="Active" definitions={ACTIVITY_STATUSES} /><StatusBadge value="Unmapped State" definitions={ACTIVITY_STATUSES} /></>));
  const badges = container.querySelectorAll("span");
  expect(badges[0].getAttribute("aria-label")).toContain("Active.");
  expect(badges[1].getAttribute("aria-label")).toBe("Unmapped State. No status definition is available.");
  expect(badges[0].querySelector("svg")).not.toBeNull();
  expect(badges[1].querySelector("svg")).not.toBeNull();
  expect(normalizeCssColor(badges[0].style.color)).toBe(normalizeCssColor(readableTextColor(ACTIVITY_STATUSES.Active.color)));
  expect(badges[0].className).toContain("whitespace-nowrap");
  act(() => root.unmount());
});

test.each([
  ["Bassett Performance", "Pass", RESULT_STATUSES],
  ["Data Integrity", "clean", INTEGRITY_CHECK_STATUSES],
  ["Release Readiness", "GO", RELEASE_DECISIONS],
  ["Administration", "Inactive", ACTIVITY_STATUSES],
  ["Demo Library", "Gold Reverification Required", DEMO_STATUSES],
  ["Test Coverage", "no_tests", COVERAGE_STATUSES],
  ["Calendar", "Read-only", CALENDAR_EVENT_STATES],
  ["Regression", "regressed", REGRESSION_DELTA_STATUSES],
  ["Test Case Detail", "Incomplete", TEST_WORKFLOW_STATUSES],
])("%s has a shared semantic mapping for %s", (_consumer, value, definitions) => {
  const definition = statusDefinition(value, definitions);
  expect(definition.label).toBeTruthy();
  expect(definition.description).toBeTruthy();
  expect(definition.icon).toBeTruthy();
});