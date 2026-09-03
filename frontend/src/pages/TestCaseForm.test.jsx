import { validateTestCaseDraft } from "../lib/formValidation";

test("Test Case draft requires a name and at least one nonblank prompt", () => {
  expect(validateTestCaseDraft({ name: " ", prompts: [{ text: " " }] })).toEqual({
    name: "Test name is required.",
    prompts: "Add at least one nonblank prompt.",
  });
  expect(validateTestCaseDraft({ name: "Setback analysis", prompts: [{ text: "" }, { text: "Analyze the rear setback." }] })).toEqual({});
});