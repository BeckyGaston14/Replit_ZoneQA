export const DRAFT_KEYS = { bassett: "zoneqa:bassett-workflow-draft", comparison: "zoneqa:comparison-workflow-draft" };

export function hasDraftContent(form) {
  return Boolean([form.title, form.name, form.question_asked, form.exact_bassett_answer, form.verified_correct_answer, form.scenario_id, form.notes]
    .some((value) => String(value || "").trim()) || form.attachments?.length
    || form.turns?.some((turn) => turn.prompt || turn.response));
}

export function readLocalDraft(mode) {
  const raw = localStorage.getItem(DRAFT_KEYS[mode]);
  if (!raw) return null;
  const saved = JSON.parse(raw);
  if (!saved || typeof saved !== "object" || Array.isArray(saved) || saved.id) {
    throw new Error("Invalid draft");
  }
  return saved;
}

export function deleteLocalDraft(mode) {
  localStorage.removeItem(DRAFT_KEYS[mode]);
}
