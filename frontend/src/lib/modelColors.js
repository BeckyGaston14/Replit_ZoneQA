// Model identity colors only. Do not reuse these for result, severity, finding,
// or workflow state; those meanings are defined by the semantic status palette.
// Each color has at least 4.5:1 contrast with white for model card headers and
// at least 4.5:1 contrast as text on a white surface.
export const MODEL_COLORS = Object.freeze({
  Bassett: "#C2410C",
  ChatGPT: "#0F766E",
  Claude: "#7E22CE",
});

export const MODEL_ORDER = Object.freeze(["Bassett", "ChatGPT", "Claude"]);

export function modelColor(model) {
  return MODEL_COLORS[model];
}