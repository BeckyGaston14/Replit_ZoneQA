import { SCORE_RUBRIC, scoreRubricReason } from "../lib/scoreRubric";

export function ScoreSelect({ value, onChange, disabled = false, id, testId, ariaLabel }) {
  const selected = value === null || value === undefined || value === "" ? "" : String(value);
  return (
    <div className="space-y-1.5">
      <select
        id={id}
        aria-label={ariaLabel}
        data-testid={testId}
        className="h-10 w-full rounded-md border bg-background px-3 text-sm"
        value={selected}
        disabled={disabled}
        onChange={(event) => onChange(event.target.value === "" ? null : Number(event.target.value))}
      >
        <option value="">Not scored — insufficient evidence or not applicable</option>
        {SCORE_RUBRIC.map(([score, reason]) => (
          <option key={score} value={score}>{score} — {reason}</option>
        ))}
      </select>
      <p className="text-xs text-muted-foreground" aria-live="polite">{scoreRubricReason(value)}</p>
    </div>
  );
}

