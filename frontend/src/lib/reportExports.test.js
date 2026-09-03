import { buildReportPayload } from "./reportExports";

const records = {
  testcases: [
    { id: "release-test", municipality_id: "muni-1" },
    { id: "comparison-test", municipality_id: "muni-1" },
    { id: "critical-test", municipality_id: "" },
    { id: "unrelated-test", municipality_id: "" },
  ],
  findings: [
    { id: "critical-finding", testcase_id: "critical-test", criticality: 5 },
    { id: "minor-finding", testcase_id: "release-test", criticality: 2 },
  ],
  evaluations: [
    { id: "bassett-release", testcase_id: "release-test", model: "Bassett", final_result: "Pass", overall_score: 8, scores: {} },
    { id: "bassett-comparison", testcase_id: "comparison-test", run_id: "complete-run", model: "Bassett", final_result: "Pass", overall_score: 8, scores: {} },
    { id: "chatgpt-comparison", testcase_id: "comparison-test", run_id: "complete-run", model: "ChatGPT", final_result: "Pass", overall_score: 8, scores: {} },
    { id: "claude-comparison", testcase_id: "comparison-test", run_id: "complete-run", model: "Claude", final_result: "Pass", overall_score: 8, scores: {} },
    { id: "incomplete-bassett", testcase_id: "unrelated-test", model: "Bassett", final_result: "Not Evaluated", overall_score: null, scores: {} },
  ],
  regressionRuns: [
    { id: "regression-run", results: [{ testcase_id: "release-test" }] },
  ],
  testRuns: [
    { id: "complete-run", status: "Completed", outcome: "Success", comparison_complete: true },
  ],
};

const ids = (records, key) => records[key].map((record) => record.id);

test("report payloads contain distinct filtered record sets", () => {
  expect(ids(buildReportPayload({ kind: "qa_summary", ...records }), "testcases")).toEqual([
    "release-test", "comparison-test", "critical-test", "unrelated-test",
  ]);
  expect(ids(buildReportPayload({ kind: "release", ...records }), "findings")).toEqual(["critical-finding"]);
  expect(ids(buildReportPayload({ kind: "regression", ...records }), "regression_runs")).toEqual(["regression-run"]);
  expect(ids(buildReportPayload({ kind: "comparison", ...records }), "evaluations")).toEqual([
    "bassett-comparison", "chatgpt-comparison", "claude-comparison",
  ]);
  expect(ids(buildReportPayload({ kind: "critical", ...records }), "testcases")).toEqual(["critical-test"]);
  expect(ids(buildReportPayload({ kind: "municipality", ...records }), "testcases")).toEqual([
    "release-test", "comparison-test",
  ]);
});

test("report payload preserves the JSON envelope and records counts", () => {
  const payload = buildReportPayload({
    kind: "critical",
    stats: { total_tests: 4 },
    generated: "2026-09-01T00:00:00.000Z",
    ...records,
  });
  expect(payload).toEqual(expect.objectContaining({
    generated: "2026-09-01T00:00:00.000Z",
    report: "critical",
    stats: { total_tests: 4 },
    scope: expect.stringContaining("Criticality"),
    record_counts: { testcases: 1, findings: 1, evaluations: 0, regression_runs: 0 },
  }));
});

test("comparison report rejects partial, incomplete, and mixed-run evaluations", () => {
  const completeEvaluation = (id, testcaseId, runId, model) => ({
    id, testcase_id: testcaseId, run_id: runId, model, final_result: "Pass", overall_score: 8, scores: { accuracy: 8 },
  });
  const payload = buildReportPayload({
    kind: "comparison",
    testcases: [{ id: "partial" }, { id: "mixed" }, { id: "incomplete" }],
    findings: [],
    evaluations: [
      completeEvaluation("partial-b", "partial", "partial-run", "Bassett"),
      completeEvaluation("partial-g", "partial", "partial-run", "ChatGPT"),
      completeEvaluation("partial-c", "partial", "partial-run", "Claude"),
      completeEvaluation("mixed-b", "mixed", "mixed-b-run", "Bassett"),
      completeEvaluation("mixed-g", "mixed", "mixed-g-run", "ChatGPT"),
      completeEvaluation("mixed-c", "mixed", "mixed-c-run", "Claude"),
      completeEvaluation("incomplete-b", "incomplete", "incomplete-run", "Bassett"),
      completeEvaluation("incomplete-g", "incomplete", "incomplete-run", "ChatGPT"),
      { ...completeEvaluation("incomplete-c", "incomplete", "incomplete-run", "Claude"), overall_score: null },
    ],
    testRuns: [
      { id: "partial-run", status: "Completed with Errors", outcome: "Partial", comparison_complete: false },
      { id: "mixed-b-run", status: "Completed", outcome: "Success", comparison_complete: true },
      { id: "mixed-g-run", status: "Completed", outcome: "Success", comparison_complete: true },
      { id: "mixed-c-run", status: "Completed", outcome: "Success", comparison_complete: true },
      { id: "incomplete-run", status: "Completed", outcome: "Success", comparison_complete: true },
    ],
  });
  expect(payload.testcases).toEqual([]);
  expect(payload.evaluations).toEqual([]);
});

test("release report retains regression snapshots with only not-evaluated tests", () => {
  const payload = buildReportPayload({
    kind: "release",
    testcases: [{ id: "not-evaluated" }],
    findings: [],
    evaluations: [],
    regressionRuns: [{
      id: "not-evaluated-run",
      results: [{ testcase_id: "not-evaluated", result: null, delta: "not_evaluated" }],
    }],
  });
  expect(ids(payload, "regression_runs")).toEqual(["not-evaluated-run"]);
  expect(ids(payload, "testcases")).toEqual(["not-evaluated"]);
});

test("exports exclude archived, superseded, partial, and orphan-linked records", () => {
  const payload = buildReportPayload({
    kind: "release",
    testcases: [{ id: "active" }, { id: "archived", archived: true }],
    findings: [
      { id: "active-finding", testcase_id: "active", criticality: 5 },
      { id: "archived-finding", testcase_id: "active", criticality: 5, archived: true },
    ],
    evaluations: [
      { id: "current", testcase_id: "active", model: "Bassett", final_result: "Pass", scores: { accuracy: 8 } },
      { id: "superseded", testcase_id: "active", model: "Bassett", superseded: true, final_result: "Pass", scores: { accuracy: 8 } },
      { id: "partial", testcase_id: "active", run_id: "partial-run", model: "Bassett", final_result: "Pass", scores: { accuracy: 8 } },
      { id: "orphan", testcase_id: "missing", model: "Bassett", final_result: "Pass", scores: { accuracy: 8 } },
    ],
    regressionRuns: [{ id: "mixed-run", testcase_ids: ["active", "archived"] }],
    testRuns: [{ id: "partial-run", status: "Completed with Errors", outcome: "Partial", comparison_complete: false }],
    evaluationDimensions: [{ key: "accuracy" }],
  });
  expect(ids(payload, "testcases")).toEqual(["active"]);
  expect(ids(payload, "findings")).toEqual(["active-finding"]);
  expect(ids(payload, "evaluations")).toEqual(["current"]);
  expect(payload.regression_runs[0].testcase_ids).toEqual(["active"]);
});