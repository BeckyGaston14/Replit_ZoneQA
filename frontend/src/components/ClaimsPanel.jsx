import { useState } from "react";
import { api, formatApiErrorDetail, staleUpdateMessage, withExpectedVersion } from "../lib/api";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "./ui/select";
import { Sparkles, Trash2, Loader2, ListChecks } from "lucide-react";
import { toast } from "sonner";
import { MODEL_COLORS, MODEL_ORDER } from "../lib/modelColors";

const MODELS = MODEL_ORDER;
const VERDICTS = ["Unreviewed", "Verified", "Partially Correct", "Unsupported", "Incorrect"];
const VERDICT_STYLE = {
  "Unreviewed": { bg: "#f1f5f9", color: "#475569" },
  "Verified": { bg: "#dcfce7", color: "#166534" },
  "Partially Correct": { bg: "#fef3c7", color: "#92400e" },
  "Unsupported": { bg: "#e2e8f0", color: "#334155" },
  "Incorrect": { bg: "#fee2e2", color: "#991b1b" },
};

function NoteInput({ claim, canWrite, onSaved }) {
  const [val, setVal] = useState(claim.note || "");
  const save = async () => {
    if (val === (claim.note || "")) return;
    try {
      await api.put(`/claims/${claim.id}`, withExpectedVersion(claim, { note: val }));
      onSaved();
    } catch (error) {
      toast.error(staleUpdateMessage(error) || formatApiErrorDetail(error?.response?.data?.detail) || "Unable to save claim note.");
      if (error?.response?.status === 409) onSaved();
    }
  };
  return <Input className="h-7 text-xs" placeholder="Reviewer note…" value={val} disabled={!canWrite}
    onChange={(e) => setVal(e.target.value)} onBlur={save} data-testid={`claim-note-${claim.id}`} />;
}

export function ClaimsPanel({ responses, claims, canWrite, onRefresh }) {
  const [model, setModel] = useState("Bassett");
  const [extracting, setExtracting] = useState(false);

  const modelResponses = responses.filter((r) => r.model === model);
  const modelClaims = claims.filter((c) => c.model === model);
  const counts = VERDICTS.reduce((acc, v) => ({ ...acc, [v]: modelClaims.filter((c) => c.verdict === v).length }), {});

  const extract = async () => {
    setExtracting(true);
    try {
      for (const r of modelResponses) {
        await api.post(`/responses/${r.id}/extract-claims`);
      }
      toast.success("Claims extracted — assign a verdict to each");
      onRefresh();
    } catch (e) {
      toast.error(formatApiErrorDetail(e.response?.data?.detail) || "Extraction failed");
    } finally { setExtracting(false); }
  };

  const setVerdict = async (c, v) => {
    try {
      await api.put(`/claims/${c.id}`, withExpectedVersion(c, { verdict: v }));
      onRefresh();
    } catch (error) {
      toast.error(staleUpdateMessage(error) || formatApiErrorDetail(error?.response?.data?.detail) || "Unable to save claim verdict.");
      if (error?.response?.status === 409) onRefresh();
    }
  };
  const del = async (c) => { await api.delete(`/claims/${c.id}`); toast.success("Claim removed"); onRefresh(); };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div className="flex gap-1.5">
          {MODELS.map((m) => (
            <button key={m} onClick={() => setModel(m)} data-testid={`claims-model-${m}`}
              className={`px-3 py-1.5 rounded-full text-xs font-semibold transition-colors ${model === m ? "text-white" : "bg-[var(--paper)] text-muted-foreground hover:text-[var(--navy)]"}`}
              style={model === m ? { background: MODEL_COLORS[m] } : {}}>
              {m} <span className="opacity-70">· {claims.filter((c) => c.model === m).length}</span>
            </button>
          ))}
        </div>
        {canWrite && modelResponses.length > 0 && (
          <Button size="sm" variant="outline" disabled={extracting} onClick={extract} data-testid="extract-claims-btn">
            {extracting ? <Loader2 size={14} className="mr-1 animate-spin" /> : <Sparkles size={14} className="mr-1" />}
            {extracting ? "Extracting…" : "Extract claims with AI"}
          </Button>
        )}
      </div>

      {modelClaims.length > 0 && (
        <div className="flex gap-2 flex-wrap" data-testid="claims-summary">
          {VERDICTS.map((v) => counts[v] > 0 && (
            <span key={v} className="text-xs font-semibold rounded-full px-2.5 py-1" style={VERDICT_STYLE[v] && { background: VERDICT_STYLE[v].bg, color: VERDICT_STYLE[v].color }}>
              {counts[v]} {v}
            </span>
          ))}
        </div>
      )}

      {modelResponses.length === 0 && <p className="text-sm text-muted-foreground">No {model} response captured yet — capture a response first.</p>}
      {modelResponses.length > 0 && modelClaims.length === 0 && (
        <div className="bg-card border rounded-xl p-8 text-center">
          <ListChecks size={28} className="mx-auto text-muted-foreground mb-2" />
          <p className="text-sm text-muted-foreground">No claims yet for {model}. Use <b>Extract claims with AI</b> to decompose the response into verifiable claims, then verdict each one against its source.</p>
        </div>
      )}

      <div className="space-y-2">
        {modelClaims.map((c, i) => (
          <div key={c.id} className="bg-card border rounded-xl p-3.5 flex gap-3 items-start" data-testid="claim-row">
            <div className="h-6 w-6 rounded-md flex items-center justify-center text-[11px] font-bold text-white shrink-0 mt-0.5" style={{ background: MODEL_COLORS[model] }}>{i + 1}</div>
            <div className="flex-1 min-w-0 space-y-1.5">
              <p className="text-sm text-[var(--ink)]">{c.claim_text}</p>
              <div className="text-xs">
                {c.citation
                  ? <span className="bg-[var(--paper)] border rounded px-1.5 py-0.5 text-[var(--navy)] font-medium">Source: {c.citation}</span>
                  : <span className="text-amber-700 bg-amber-50 border border-amber-200 rounded px-1.5 py-0.5 font-medium">No citation given</span>}
              </div>
              <NoteInput claim={c} canWrite={canWrite} onSaved={onRefresh} />
            </div>
            <div className="flex items-center gap-1.5 shrink-0">
              <Select value={c.verdict} onValueChange={(v) => setVerdict(c, v)} disabled={!canWrite}>
                <SelectTrigger className="h-8 w-40 text-xs font-semibold" style={VERDICT_STYLE[c.verdict] && { background: VERDICT_STYLE[c.verdict].bg, color: VERDICT_STYLE[c.verdict].color }} data-testid={`claim-verdict-${c.id}`}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>{VERDICTS.map((v) => <SelectItem key={v} value={v}>{v}</SelectItem>)}</SelectContent>
              </Select>
              {canWrite && <button type="button" className="text-muted-foreground hover:text-destructive" aria-label={`Delete claim ${c.id}`} onClick={() => del(c)} data-testid={`claim-delete-${c.id}`}><Trash2 size={14} /></button>}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
