const COMPARISON_MODELS = new Set(["Bassett", "ChatGPT", "Claude"]);
import { calculateComparisonScore } from "./comparison";

const REPORT_SCOPES = {
  qa_summary: "All persisted QA records.",
  release: "Bassett evaluations, critical findings, and regression snapshots across recorded releases.",
  regression: "Historical regression snapshots and their included test results.",
  comparison: "Complete Bassett, ChatGPT, and Claude evaluations grouped by test case.",
  critical: "Criticality 4–5 findings and the related QA records.",
  municipality: "Test cases with a municipality and their related QA records.",
};

function relatedRecords(source, testcaseIds) {
  const { testcases, findings, evaluations, regression_runs: regressionRuns } = source;
  const relatedRuns = regressionRuns?.filter((run) =>
    (run.results || []).some((result) => testcaseIds.has(result.testcase_id))
    || (run.testcase_ids || []).some((id) => testcaseIds.has(id))
  );

  return {
    testcases: testcases.filter((testcase) => testcaseIds.has(testcase.id)),
    findings: findings.filter((finding) => testcaseIds.has(finding.testcase_id)),
    evaluations: evaluations.filter((evaluation) => testcaseIds.has(evaluation.testcase_id)),
    ...(regressionRuns === undefined ? {} : { regression_runs: relatedRuns }),
  };
}

function testcaseIdsFromRegressionRuns(regressionRuns = []) {
  return regressionRuns.flatMap((run) => [
    ...(run.results || []).map((result) => result.testcase_id),
    ...(run.testcase_ids || []),
  ]);
}

function canonicalSource(source) {
  const testcases = source.testcases.filter((testcase) =>
    !testcase.archived && testcase.status !== "Archived",
  );
  const testcaseIds = new Set(testcases.map((testcase) => testcase.id));
  const testRunsById = new Map((source.test_runs || []).map((run) => [run.id, run]));
  const evaluations = source.evaluations.filter((evaluation) => {
    if (evaluation.archived || evaluation.superseded || !testcaseIds.has(evaluation.testcase_id)) return false;
    if (!evaluation.run_id) return true; // supported legacy record
    const run = testRunsById.get(evaluation.run_id);
    return !run || (run.status === "Completed" && run.outcome !== "Partial" && run.comparison_complete !== false);
  });
  const regressionRuns = (source.regression_runs || []).map((run) => ({
    ...run,
    ...(run.results ? { results: run.results.filter((result) => testcaseIds.has(result.testcase_id)) } : {}),
    ...(run.testcase_ids ? { testcase_ids: run.testcase_ids.filter((id) => testcaseIds.has(id)) } : {}),
  })).filter((run) => !run.archived && (run.results?.length || run.testcase_ids?.length));
  return {
    ...source,
    testcases,
    findings: source.findings.filter((finding) =>
      !finding.archived && finding.status !== "Archived" && testcaseIds.has(finding.testcase_id),
    ),
    evaluations,
    ...(source.regression_runs === undefined ? {} : { regression_runs: regressionRuns }),
  };
}

function buildReleaseRecords(source) {
  const criticalFindings = source.findings.filter((finding) => Number(finding.criticality) >= 4);
  const testcaseIds = new Set([
    ...source.evaluations
      .filter((evaluation) => evaluation.model === "Bassett")
      .map((evaluation) => evaluation.testcase_id),
    ...criticalFindings.map((finding) => finding.testcase_id),
    ...testcaseIdsFromRegressionRuns(source.regression_runs),
  ]);
  const records = relatedRecords(source, testcaseIds);
  return {
    ...records,
    findings: criticalFindings,
    evaluations: records.evaluations.filter((evaluation) => evaluation.model === "Bassett"),
    ...(source.regression_runs === undefined ? {} : { regression_runs: source.regression_runs }),
  };
}

function buildRegressionRecords(source) {
  const regressionRuns = source.regression_runs || [];
  const testcaseIds = new Set(testcaseIdsFromRegressionRuns(regressionRuns));
  return {
    ...relatedRecords(source, testcaseIds),
    regression_runs: regressionRuns,
  };
}

function buildComparisonRecords(source) {
  const runsById = new Map((source.test_runs || []).map((run) => [run.id, run]));
  const eligibleRunIds = new Set(
    (source.test_runs || [])
      .filter((run) => run.status === "Completed" && run.outcome !== "Partial" && run.comparison_complete !== false)
      .map((run) => run.id),
  );
  const groups = new Map();
  [...source.evaluations]
    .sort((left, right) =>
      (left.created_at || "").localeCompare(right.created_at || "")
      || (left.id || "").localeCompare(right.id || "")
    )
    .forEach((evaluation) => {
      if (
        !COMPARISON_MODELS.has(evaluation.model)
        || !evaluation.testcase_id
        || (evaluation.run_id && !eligibleRunIds.has(evaluation.run_id))
      ) return;
      const key = evaluation.run_id ? `run:${evaluation.run_id}` : `legacy:${evaluation.testcase_id}`;
      if (!groups.has(key)) groups.set(key, new Map());
      groups.get(key).set(evaluation.model, evaluation);
    });

  const latestComplete = new Map();
  groups.forEach((slots) => {
    const complete = [...COMPARISON_MODELS].every((model) => {
      const evaluation = slots.get(model);
      return evaluation
        && evaluation.final_result
        && evaluation.final_result !== "Not Evaluated"
        && evaluation.overall_score != null
        && evaluation.scores
        && typeof evaluation.scores === "object"
        && !Array.isArray(evaluation.scores);
    });
    if (!complete) return;

    const selected = [...COMPARISON_MODELS].map((model) => slots.get(model));
    const testcaseId = selected[0].testcase_id;
    if (!selected.every((evaluation) => evaluation.testcase_id === testcaseId)) return;
    const run = runsById.get(selected[0].run_id) || {};
    const groupDate = run.run_date || run.created_at
      || selected.reduce((latest, evaluation) => evaluation.created_at > latest ? evaluation.created_at : latest, "");
    const order = `${groupDate}\u0000${run.id || selected[0].run_id || selected[0].id || ""}`;
    if (!latestComplete.has(testcaseId) || order > latestComplete.get(testcaseId).order) {
      latestComplete.set(testcaseId, { order, evaluations: selected });
    }
  });
  const testcaseIds = new Set(latestComplete.keys());
  const records = relatedRecords(source, testcaseIds);
  return { ...records, evaluations: [...latestComplete.values()].flatMap((group) => group.evaluations) };
}

function buildCriticalRecords(source) {
  const criticalFindings = source.findings.filter((finding) => Number(finding.criticality) >= 4);
  const testcaseIds = new Set(criticalFindings.map((finding) => finding.testcase_id));
  const records = relatedRecords(source, testcaseIds);
  return { ...records, findings: criticalFindings };
}

function buildMunicipalityRecords(source) {
  const testcaseIds = new Set(source.testcases.filter((testcase) => testcase.municipality_id).map((testcase) => testcase.id));
  return relatedRecords(source, testcaseIds);
}

const BUILDERS = {
  qa_summary: (source) => ({
    testcases: source.testcases,
    findings: source.findings,
    evaluations: source.evaluations,
    ...(source.regression_runs === undefined ? {} : { regression_runs: source.regression_runs }),
  }),
  release: buildReleaseRecords,
  regression: buildRegressionRecords,
  comparison: buildComparisonRecords,
  critical: buildCriticalRecords,
  municipality: buildMunicipalityRecords,
};

export function buildReportPayload({ kind, stats, testcases = [], findings = [], evaluations = [], regressionRuns, testRuns, evaluationDimensions, generated = new Date().toISOString() }) {
  const scoredEvaluations = evaluationDimensions ? evaluations.map((evaluation) => {
    const calculation = calculateComparisonScore(evaluation, evaluationDimensions);
    return {
      ...evaluation,
      overall_score: calculation.score,
      weighted_score: calculation.score,
      score_mode: calculation.weightsActive ? "weighted" : "average",
      score_label: calculation.scoreLabel,
      weight_explanation: calculation.weightExplanation,
      system_recommended: calculation.score === null
        ? "Not Enough Evidence"
        : calculation.score >= 8.5 ? "Pass"
          : calculation.score >= 7 ? "Pass with Minor Issues"
            : calculation.score >= 5 ? "Needs Improvement"
              : calculation.score >= 3 ? "Fail"
                : "Critical Fail",
    };
  }) : evaluations;
  const source = canonicalSource({
    testcases,
    findings,
    evaluations: scoredEvaluations,
    ...(regressionRuns === undefined ? {} : { regression_runs: regressionRuns }),
    ...(testRuns === undefined ? {} : { test_runs: testRuns }),
  });
  const records = (BUILDERS[kind] || BUILDERS.qa_summary)(source);
  return {
    generated,
    report: kind,
    scope: REPORT_SCOPES[kind] || REPORT_SCOPES.qa_summary,
    evaluation_score_scale: {
      minimum: 0,
      maximum: 10,
      missing: "unavailable",
      normalization: "none",
    },
    stats,
    ...records,
    record_counts: Object.fromEntries(
      Object.entries(records)
        .filter(([, value]) => Array.isArray(value))
        .map(([key, value]) => [key, value.length]),
    ),
  };
}

export { REPORT_SCOPES };