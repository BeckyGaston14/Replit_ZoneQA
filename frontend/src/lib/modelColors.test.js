import { contrastRatio } from "./statusMaps";
import { MODEL_COLORS, MODEL_ORDER } from "./modelColors";

test("model palette is fixed, distinct, and readable on white", () => {
  expect(MODEL_ORDER).toEqual(["Bassett", "ChatGPT", "Claude"]);
  expect(new Set(Object.values(MODEL_COLORS)).size).toBe(3);

  Object.values(MODEL_COLORS).forEach((color) => {
    expect(contrastRatio(color, "#ffffff")).toBeGreaterThanOrEqual(4.5);
  });
});