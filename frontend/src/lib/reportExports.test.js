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

test("critical exports use canonical severity precedence for legacy and mismatched findings", () => {
  const payload = buildReportPayload({
    kind: "critical",
    testcases: [
      { id: "severity-low" },
      { id: "severity-critical" },
      { id: "legacy-critical" },
      { id: "criticality-fallback" },
      { id: "invalid-severity" },
    ],
    findings: [
      { id: "severity-low-finding", testcase_id: "severity-low", severity: "Low", criticality: 5 },
      { id: "severity-critical-finding", testcase_id: "severity-critical", severity: "Critical", criticality: 1 },
      { id: "legacy-critical-finding", testcase_id: "legacy-critical", severity: "Critical Fail", criticality: 1 },
      { id: "criticality-fallback-finding", testcase_id: "criticality-fallback", severity: "", criticality: 4 },
      { id: "invalid-severity-finding", testcase_id: "invalid-severity", severity: "4.0", criticality: 5 },
    ],
    evaluations: [],
  });

  expect(ids(payload, "findings")).toEqual([
    "severity-critical-finding",
    "legacy-critical-finding",
    "criticality-fallback-finding",
  ]);
  expect(ids(payload, "testcases")).toEqual([
    "severity-critical",
    "legacy-critical",
    "criticality-fallback",
  ]);
});

test("report payload exposes separate High and Critical severity totals", () => {
  const payload = buildReportPayload({
    kind: "qa_summary",
    testcases: [
      { id: "high-case" },
      { id: "critical-case" },
      { id: "medium-case" },
    ],
    findings: [
      { id: "high", testcase_id: "high-case", severity: "High", criticality: 5 },
      { id: "critical", testcase_id: "critical-case", severity: "Critical", criticality: 4 },
      { id: "medium", testcase_id: "medium-case", severity: "Medium", criticality: 3 },
    ],
    evaluations: [],
  });
  expect(payload.severity_summary).toMatchObject({
    high: 1,
    critical: 1,
    high_critical_total: 2,
  });
  expect(payload.severity_summary.labels.high_critical_total).toBe("High + Critical total");
});

test("release export preserves readiness population metadata and standalone rows", () => {
  const payload = buildReportPayload({
    kind: "release",
    testcases: [{ id: "comparison-case" }],
    findings: [],
    evaluations: [{
      id: "bassett-comparison",
      testcase_id: "comparison-case",
      model: "Bassett",
      final_result: "Pass",
      overall_score: 9,
    }],
    bassettOnlyEvaluations: [{ id: "standalone", result: "Pass", score: 9 }],
    releaseEvidence: { evaluated: 2, minimum: 50, sufficient: false, label: "2 of 50 qualifying tests completed" },
    releaseReadiness: { version: "v1", scope: "both", evaluated: 2, evidence_status: { evaluated: 2, minimum: 50 } },
    insufficientEvidence: true,
  });
  expect(payload.release_readiness.scope).toBe("both");
  expect(payload.release_evidence.evaluated).toBe(2);
  expect(payload.bassett_only_evaluations).toHaveLength(1);
  expect(payload.evaluations).toHaveLength(1);
});

test.each(["bassett", "comparison", "both"])(
  "release export detail population matches readiness evidence for %s",
  (selectedScope) => {
    [0, 1, 49, 50, 51].forEach((evaluated) => {
      const standaloneCount = selectedScope === "comparison"
        ? 0
        : selectedScope === "bassett" ? evaluated : Math.floor(evaluated / 2);
      const comparisonCount = evaluated - standaloneCount;
      const testcases = Array.from({ length: comparisonCount }, (_, index) => ({
        id: `comparison-${index}`,
      }));
      const evaluations = testcases.map((testcase, index) => ({
        id: `comparison-evaluation-${index}`,
        testcase_id: testcase.id,
        model: "Bassett",
        final_result: "Pass",
        overall_score: 9,
      }));
      const standalone = Array.from({ length: standaloneCount }, (_, index) => ({
        id: `standalone-${index}`,
        result: "Pass",
        score: 9,
      }));
  const payload = buildReportPayload({
    kind: "release",
    testcases,
    findings: [],
    evaluations,
    bassettOnlyEvaluations: standalone,
    releaseEvidence: {
      evaluated, minimum: 50, sufficient: evaluated >= 50,
      label: `${evaluated} of 50 qualifying tests completed`,
    },
    releaseReadiness: { version: "v-selected", scope: selectedScope, evaluated },
    insufficientEvidence: evaluated < 50,
  });
      expect(payload.release_readiness?.scope).toBe(selectedScope);
      expect(payload.release_readiness?.evaluated).toBe(evaluated);
      expect(payload.release_evidence.evaluated).toBe(evaluated);
      expect(
        payload.evaluations.length + (payload.bassett_only_evaluations || []).length,
      ).toBe(evaluated);
      expect(payload.insufficient_evidence).toBe(evaluated < 50);
      if (selectedScope === "comparison") {
        expect(payload).not.toHaveProperty("bassett_only_evaluations");
      }
    });
  },
);

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
    scope: expect.stringContaining("Separate High and Critical"),
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