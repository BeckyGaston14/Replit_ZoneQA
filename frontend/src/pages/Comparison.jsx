import { useCallback, useEffect, useMemo, useState } from "react";
import { useSearchParams, useNavigate } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { api } from "../lib/api";
import { PageHeader, CritBadge, ResultBadge, ScorePill, StatusBadge } from "../components/shared";
import { Button } from "../components/ui/button";
import { Check, ChevronsUpDown, ExternalLink, Flag } from "lucide-react";
import { formatApiErrorDetail } from "../lib/api";
import { useAuth } from "../lib/auth";
import { useConfig } from "../lib/hooks";
import { calculateComparisonScore, comparisonDimensions, evaluationIsComplete } from "../lib/comparison";
import { toast } from "sonner";
import { COMPARISON_VERDICTS } from "../lib/statusMaps";
import { EVALUATION_SCALE_LABEL, evaluationScorePercent, formatEvaluationScore } from "../lib/evaluationScale";
import { MODEL_COLORS, MODEL_ORDER } from "../lib/modelColors";
import { QueryState } from "../components/PageState";

const MODELS = MODEL_ORDER;

function testCaseContext(testCase) {
  return [testCase.municipality_name, testCase.project_name, testCase.category].filter(Boolean).join(" · ");
}

function testCaseSearchText(testCase) {
  return [testCase.name, testCase.id, testCase.municipality_name, testCase.project_name, testCase.category, testCase.status]
    .filter(Boolean).join(" ");
}

export default function Comparison() {
  const [sp, setSp] = useSearchParams();
  const nav = useNavigate();
  const { user } = useAuth();
  const tcId = sp.get("tc");
  const { data: config } = useConfig();
  const testsQuery = useQuery({ queryKey: ["tc-enriched"], queryFn: async () => (await api.get("/list/testcases-enriched")).data });
  const { data: tcs = [], isLoading: testsLoading, isError: testsError, error: testsLoadError, refetch: refetchTests } = testsQuery;
  const { data, isLoading, isError, error, refetch } = useQuery({ queryKey: ["cmp", tcId], enabled: !!tcId, queryFn: async () => (await api.get(`/comparison/${tcId}`)).data });
  const [retrying, setRetrying] = useState(false);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [pickerQuery, setPickerQuery] = useState("");
  const selectTestCase = useCallback((id, options) => {
    const next = new URLSearchParams(sp);
    if (id) next.set("tc", id);
    else next.delete("tc");
    setSp(next, options);
  }, [sp, setSp]);

  const sortedTcs = useMemo(() => [...tcs].sort((left, right) => (
    String(left.name || "").localeCompare(String(right.name || ""), undefined, { sensitivity: "base" })
      || String(left.municipality_name || "").localeCompare(String(right.municipality_name || ""), undefined, { sensitivity: "base" })
      || String(left.project_name || "").localeCompare(String(right.project_name || ""), undefined, { sensitivity: "base" })
      || String(left.id || "").localeCompare(String(right.id || ""))
  )), [tcs]);
  const selectedTestCase = sortedTcs.find((testCase) => testCase.id === tcId);
  const filteredTcs = useMemo(() => {
    const normalizedQuery = pickerQuery.trim().toLocaleLowerCase();
    if (!normalizedQuery) return sortedTcs;
    return sortedTcs.filter((testCase) => testCaseSearchText(testCase).toLocaleLowerCase().includes(normalizedQuery));
  }, [pickerQuery, sortedTcs]);
  const dimensions = useMemo(() => comparisonDimensions(config?.eval_dimensions), [config?.eval_dimensions]);

  useEffect(() => {
    if (!sortedTcs.length) return;
    if (!tcId || !selectedTestCase) selectTestCase(sortedTcs[0].id, { replace: true });
  }, [sortedTcs, tcId, selectedTestCase, selectTestCase]);

  // The full-test API returns evaluations newest-first with an id tie-breaker.
  const evalFor = (m) => data?.evaluations.find((e) => e.model === m);
  const respFor = (m) => (data?.responses || []).filter((r) => r.model === m && !r.superseded).sort((a, b) => a.turn - b.turn);
  const responseValid = (model) => respFor(model).some((response) => typeof response.response === "string" && response.response.trim().length > 0);
  const scoreFor = (model) => calculateComparisonScore(evalFor(model), dimensions);
  const evaluationValid = (model) => evaluationIsComplete(evalFor(model), dimensions);
  const missing = MODELS.flatMap((model) => [
    ...(responseValid(model) ? [] : [`${model} response`]),
    ...(evaluationValid(model) ? [] : [`${model} evaluation`]),
  ]);
  const complete = !!data && missing.length === 0
    && (!data.comparison_run || data.comparison?.complete === true);
  const bScore = scoreFor("Bassett").score;
  const otherScores = ["ChatGPT", "Claude"].map((model) => scoreFor(model).score).filter((score) => score != null);
  const bestOther = otherScores.length ? Math.max(...otherScores) : null;
  let verdict = null;
  if (complete && bScore != null && data) {
    if (bScore > bestOther + 0.5) verdict = "Bassett Wins";
    else if (bScore < bestOther - 0.5) verdict = "Bassett Underperforms";
    else verdict = "Comparable";
  }
  const retryIncomplete = async () => {
    const incompleteModels = MODELS.filter((model) => !responseValid(model));
    if (!incompleteModels.length) return nav(`/testcases/${tcId}`);
    setRetrying(true);
    try {
      // The detail view determines the active comparison run and exposes the
      // same retry contract; this direct endpoint is intentionally only used
      // when the comparison payload includes its run identifier.
      const runId = data?.test_run?.id || data?.comparison_run?.id;
      if (!runId) return nav(`/testcases/${tcId}`);
      await api.post(`/testcases/${tcId}/runs/${runId}/retry`, { models: incompleteModels });
      toast.success(`Retry requested for ${incompleteModels.join(", ")}`);
      refetch();
    } catch (requestError) {
      toast.error(formatApiErrorDetail(requestError?.response?.data?.detail) || "Unable to retry incomplete models.");
    } finally { setRetrying(false); }
  };

  return (
    <div>
      <PageHeader title="AI Comparison" subtitle="Side-by-side Bassett vs. ChatGPT vs. Claude, anchored to the Gold Standard.">
        <div className="relative w-full max-w-full sm:w-80">
          <div>
              <Button
                type="button"
                variant="outline"
                role="combobox"
                aria-expanded={pickerOpen}
                aria-label="Select comparison test case"
                data-testid="cmp-select"
                className="w-full justify-between text-left font-normal"
                disabled={testsLoading || testsError || sortedTcs.length === 0}
                onClick={() => setPickerOpen((open) => !open)}
              >
                <span className="min-w-0 truncate">
                  {selectedTestCase ? selectedTestCase.name : "Select test case"}
                  {selectedTestCase && testCaseContext(selectedTestCase) && (
                    <span className="ml-2 text-xs text-muted-foreground">· {testCaseContext(selectedTestCase)}</span>
                  )}
                </span>
                <ChevronsUpDown size={15} className="ml-2 shrink-0 opacity-50" aria-hidden="true" />
              </Button>
            {pickerOpen && <div className="absolute right-0 top-full z-50 mt-1 w-[min(92vw,28rem)] rounded-md border bg-popover p-2 text-popover-foreground shadow-md">
              <input
                autoFocus
                value={pickerQuery}
                onChange={(event) => setPickerQuery(event.target.value)}
                placeholder="Search name, municipality, project, or category…"
                aria-label="Search comparison test cases"
                className="mb-2 flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-2 text-sm outline-none focus:ring-1 focus:ring-ring"
              />
              <div className="max-h-72 overflow-y-auto" role="listbox" aria-label="Eligible comparison test cases">
                {!filteredTcs.length && <p className="px-2 py-6 text-center text-sm text-muted-foreground">No eligible test cases found.</p>}
                {!!filteredTcs.length && (
                  <div className="mb-1 px-2 text-xs font-semibold text-muted-foreground">
                    {sortedTcs.length} eligible test case{sortedTcs.length === 1 ? "" : "s"}
                  </div>
                )}
                {filteredTcs.map((testCase) => (
                  <button
                    type="button"
                    key={testCase.id}
                    role="option"
                    aria-selected={tcId === testCase.id}
                    onClick={() => { selectTestCase(testCase.id); setPickerOpen(false); setPickerQuery(""); }}
                    data-testid={`cmp-option-${testCase.id}`}
                    className="flex w-full items-start gap-2 rounded-sm px-2 py-2 text-left text-sm outline-none hover:bg-accent focus:bg-accent"
                  >
                    <Check size={15} className={`mt-0.5 shrink-0 ${tcId === testCase.id ? "opacity-100" : "opacity-0"}`} aria-hidden="true" />
                    <span className="min-w-0">
                      <span className="block truncate font-medium">{testCase.name || "Untitled test case"}</span>
                      <span className="block truncate text-xs text-muted-foreground">
                        {testCaseContext(testCase) || testCase.id}
                      </span>
                    </span>
                  </button>
                ))}
              </div>
            </div>}
          </div>
        </div>
      </PageHeader>
      {(testsLoading || testsError) && <QueryState query={testsQuery} resource="comparison test cases" onRetry={refetchTests} testId="comparison-tests" />}
      {!testsLoading && !testsError && tcs.length === 0 && <div className="mb-3 rounded-xl border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900">No test cases are available for comparison yet. Create and evaluate a test case first.</div>}

       {!!tcId && isLoading && <QueryState query={{ isLoading }} resource="comparison" testId="comparison" />}
       {isError && <QueryState query={{ isError, error, refetch }} resource="Comparison" onRetry={refetch} notFoundAction={() => selectTestCase("")} testId="comparison" />}
       {!tcId && !testsLoading && tcs.length > 0 && <p className="text-sm text-muted-foreground">Select a test case to load its comparison.</p>}
       {data && (
        <>
          <div className="bg-card border rounded-xl p-4 mb-4 flex items-center justify-between flex-wrap gap-3">
            <div className="flex items-center gap-3">
              <CritBadge value={data.testcase.criticality} />
              <div>
                <div className="font-semibold font-display text-[var(--navy)]">{data.testcase.name}</div>
                <div className="text-xs text-muted-foreground">{data.municipality ? `${data.municipality.name}, ${data.municipality.state}` : ""} · {(data.testcase.prompts || [])[0]?.text}</div>
              </div>
            </div>
             {complete && verdict && <StatusBadge value={verdict} definitions={COMPARISON_VERDICTS} testId="cmp-verdict" />}
             <div className="flex flex-wrap items-center gap-2">
               <Button variant="outline" onClick={() => nav(`/findings?testcase_id=${tcId}`)} data-testid="cmp-findings-link"><ExternalLink size={14} className="mr-1" /> Findings</Button>
               <Button className="bg-[var(--orange)] hover:bg-[var(--orange-600)]" onClick={() => nav(`/testcases/${tcId}`)} data-testid="cmp-open-test"><Flag size={15} className="mr-1" /> Open Test</Button>
             </div>
          </div>
           {!complete && <div className="mb-4 rounded-xl border border-amber-300 bg-amber-50 p-4 text-amber-950" role="status" aria-live="polite" data-testid="incomplete-comparison">
             <div className="font-bold font-display">Incomplete Comparison</div>
             <p className="mt-1 text-sm">A verdict is unavailable until each model has a valid response and completed evaluation.</p>
             <p className="mt-2 text-xs font-semibold">Missing: {missing.join(", ")}.</p>
             <div className="mt-3 flex flex-wrap gap-2">
               {user?.role !== "viewer" && <Button size="sm" onClick={retryIncomplete} disabled={retrying}>{retrying ? "Retrying…" : "Retry incomplete models"}</Button>}
               <Button size="sm" variant="outline" onClick={() => nav(`/testcases/${tcId}`)}>Review / enter responses and evaluations</Button>
             </div>
           </div>}

          {data.gold_standard && (
            <div className={`rounded-xl p-4 mb-4 ${data.gold_stale ? "bg-[var(--navy)] text-white border-2 border-amber-400" : "bg-[var(--navy)] text-white"}`}>
              <div className="text-xs font-bold uppercase tracking-wide text-[var(--orange)] mb-1" data-testid="cmp-gold-label">
                {data.gold_stale ? "Gold Standard — Approved Historically, Reverification Required" : "Gold Standard (authoritative)"}
              </div>
              {data.gold_stale && (
                <div className="text-xs bg-amber-400/20 border border-amber-400/60 text-amber-200 rounded-lg px-2.5 py-1.5 mb-2" data-testid="cmp-gold-stale-warning">
                  ⚠ Supporting evidence is stale ({(data.gold_stale_evidence || []).join("; ")}) — this answer's authority is under review against the current ordinance.
                </div>
              )}
              <p className="text-sm prose-response">{data.gold_standard.answer}</p>
            </div>
          )}

           <p className="mb-2 text-xs text-muted-foreground">{EVALUATION_SCALE_LABEL} for every evaluation dimension. Missing dimensions are unavailable, not zero.</p>
          <div className="grid lg:grid-cols-3 gap-4">
             {MODELS.map((m) => { const ev = evalFor(m); const calculation = scoreFor(m); const scores = MODELS.map((x) => scoreFor(x).score).filter((score) => score != null); const win = complete && calculation.score != null && calculation.score === Math.max(...scores); return (
              <div key={m} className="bg-card border rounded-xl overflow-hidden flex min-w-0 flex-col" style={{ borderColor: win ? MODEL_COLORS[m] : undefined, borderWidth: win ? 2 : 1 }}>
                 <div className="px-4 py-2.5 text-white font-semibold font-display flex items-center justify-between gap-2" style={{ background: MODEL_COLORS[m] }}>
                   <span className="min-w-0 truncate">{m}{m === "Bassett" && " ★"}</span>{calculation.score != null ? <span className="flex shrink-0 items-center gap-1.5"><span className="sr-only">{calculation.scoreLabel}</span><ScorePill score={calculation.score} /></span> : <span className="text-xs font-semibold">Score unavailable</span>}
                </div>
                <div className="p-4 space-y-3 flex-1">
                  {respFor(m).length === 0 && <p className="text-sm text-muted-foreground">No response.</p>}
                  {respFor(m).map((r) => (
                    <div key={r.id}>
                      <div className="text-[10px] font-bold text-muted-foreground uppercase flex gap-2 flex-wrap items-center">
                        <span>Turn {r.turn} · Latest run</span>
                        {r.model_version && <span className="normal-case font-semibold text-[var(--navy)]">{r.model_version}</span>}
                        {r.capture_method && <span className="normal-case">{r.capture_method === "live_api" ? "Live API" : "Manual"}</span>}
                        {r.created_at && <span className="normal-case">{new Date(r.created_at).toLocaleDateString()}</span>}
                      </div>
                       <p className="text-sm prose-response break-words">{r.response}</p>{r.citations && <div className="mt-1 text-xs bg-[var(--paper)] rounded px-2 py-1 break-words"><b>Cite:</b> {r.citations}</div>}</div>
                  ))}
                </div>
                {ev && (
                  <div className="border-t p-3 space-y-1.5">
                     <div className="flex justify-between items-center mb-1 gap-2"><ResultBadge value={ev.final_result} /><span className="text-[10px] text-right text-muted-foreground" title={calculation.weightExplanation}>{calculation.scoreLabel}</span></div>
                     <p className="sr-only" data-testid={`cmp-weight-explanation-${m}`}>{calculation.weightExplanation}</p>
                     {dimensions.map(({ key: k, label: l }) => (
                       <div key={k} className="flex items-center justify-between gap-2 text-xs"><span className="min-w-0 truncate text-muted-foreground" title={l}>{l}</span>
                         <div className="flex shrink-0 items-center gap-2 w-32">{evaluationScorePercent(ev.scores?.[k]) !== null ? <><div className="h-1.5 flex-1 bg-[var(--paper)] rounded" role="img" aria-label={`${l}: ${formatEvaluationScore(ev.scores[k])} out of 10`}><div className="h-1.5 rounded" style={{ width: `${evaluationScorePercent(ev.scores[k])}%`, background: MODEL_COLORS[m] }} /></div><span className="w-8 text-right font-semibold">{formatEvaluationScore(ev.scores[k])}</span></> : <span className="ml-auto text-muted-foreground">Unavailable</span>}</div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            ); })}
          </div>
        </>
      )}
    </div>
  );
}
