export function validateFormFields(fields, form, { dateRanges = [] } = {}) {
  const errors = {};
  const optionsFor = (field) => (field.options || []).map((option) => typeof option === "object" ? option.value : option);

  fields.forEach((field) => {
    const value = form?.[field.key];
    const empty = value == null || String(value).trim() === "";
    if (field.required && empty) {
      errors[field.key] = `${field.label} is required.`;
      return;
    }
    if (empty) return;

    if (field.type === "url" || field.validation === "url") {
      try {
        const url = new URL(String(value));
        if (!["http:", "https:"].includes(url.protocol)) throw new Error("unsupported protocol");
      } catch {
        errors[field.key] = `${field.label} must be a complete web address beginning with http:// or https://.`;
      }
    }

    if (field.type === "date" || field.validation === "date") {
      const parsedDate = new Date(`${value}T00:00:00Z`);
      const validDate = /^\d{4}-\d{2}-\d{2}$/.test(String(value))
        && !Number.isNaN(parsedDate.getTime())
        && parsedDate.toISOString().slice(0, 10) === value;
      if (!validDate) errors[field.key] = `${field.label} must be a valid date.`;
    }

    if (field.type === "number" || field.validation === "number") {
      const number = Number(value);
      if (!Number.isFinite(number)) errors[field.key] = `${field.label} must be a number.`;
      else if (field.integer && !Number.isInteger(number)) errors[field.key] = `${field.label} must be a whole number.`;
      else if (field.min != null && number < field.min) errors[field.key] = `${field.label} must be at least ${field.min}.`;
      else if (field.max != null && number > field.max) errors[field.key] = `${field.label} must be no more than ${field.max}.`;
    }

    if (field.type === "select" && field.options?.length && !optionsFor(field).includes(value)) {
      errors[field.key] = `Choose a valid ${field.label.toLowerCase()}.`;
    }
  });

  dateRanges.forEach(({ start, end, startLabel, endLabel }) => {
    const startValue = form?.[start];
    const endValue = form?.[end];
    if (startValue && endValue && !errors[start] && !errors[end] && startValue > endValue) {
      errors[end] = `${endLabel || end} must be on or after ${startLabel || start}.`;
    }
  });
  return errors;
}

export function validateTestCaseDraft(draft) {
  const errors = {};
  if (!(draft?.name || "").trim()) errors.name = "Test name is required.";
  if (!(draft?.prompts || []).some((prompt) => (prompt.text || "").trim())) errors.prompts = "Add at least one nonblank prompt.";
  return errors;
}

export function validateScenarioDraft(draft) {
  const labels = {
    workflow_stage: "Workflow stage",
    report_type: "Report type",
    test_scenario: "Test scenario",
    complexity: "Complexity",
    why_it_matters: "Why it matters",
    what_bassett_should_do: "What Bassett should do",
    success_criteria: "Success criteria",
  };
  return Object.fromEntries(Object.entries(labels)
    .filter(([key]) => !String(draft?.[key] || "").trim())
    .map(([key, label]) => [key, `${label} is required.`]));
}

export function focusFormError(fieldKey) {
  if (!fieldKey || typeof document === "undefined") return;
  const selector = fieldKey === "prompts"
    ? '[data-testid="prompt-0"]'
    : `[data-testid="field-${fieldKey}"], [data-testid="tc-${fieldKey}"], [data-testid="${fieldKey}"], #${String(fieldKey).replace(/[^a-zA-Z0-9_-]/g, "")}`;
  const control = document.querySelector(selector);
  if (control && typeof control.focus === "function") control.focus();
}
