import fs from "fs";
import path from "path";

const page = (name) => fs.readFileSync(path.join(__dirname, `${name}.jsx`), "utf8");

test.each([
  ["Performance", /StatusBadge value="Pass"/],
  ["DataIntegrity", /INTEGRITY_CHECK_STATUSES/],
  ["ReleaseReadiness", /StatusBadge value=\{decisionStatus\}/],
  ["Admin", /ACTIVITY_STATUSES/],
  ["Demos", /Gold Reverification Required/],
  ["Coverage", /StatusBadge value=\{status\}/],
  ["CalendarPage", /CALENDAR_EVENT_STATES/],
  ["Regression", /ResultBadge value=\{r\.result \|\| "Not Evaluated"\}/],
  ["TestCaseDetail", /TEST_WORKFLOW_STATUSES/],
])("%s renders status values through a shared semantic consumer", (name, expected) => {
  expect(page(name)).toMatch(expected);
});

test.each([
  "Performance",
  "DataIntegrity",
  "ReleaseReadiness",
  "Admin",
  "Demos",
  "Coverage",
  "CalendarPage",
  "Regression",
])("%s has no decorative StatusLegend row", (name) => {
  expect(page(name)).not.toContain("<StatusLegend");
});

test("Test Case Detail keeps only its compact expected-behavior legend", () => {
  const source = page("TestCaseDetail");
  expect(source.match(/<StatusLegend/g)).toHaveLength(1);
  expect(source).toContain('label="Expected behavior status legend"');
});

test("unknown calendar event types are not relabeled as milestones", () => {
  const source = page("CalendarPage");
  expect(source).not.toContain('CALENDAR_EVENT_STATUSES[e.type] ? e.type : "milestone"');
  expect(source).toContain('e.type || "Unknown Event"');
});