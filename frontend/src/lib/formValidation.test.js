import { validateFormFields } from "./formValidation";

const fields = [
  { key: "name", label: "Name", required: true },
  { key: "municipality_id", label: "Municipality", type: "relation", required: true },
  { key: "source_url", label: "Source URL", type: "url" },
  { key: "effective_date", label: "Effective Date", type: "date" },
  { key: "score", label: "Score", type: "number", min: 0, max: 10 },
  { key: "status", label: "Status", type: "select", options: ["Draft", "Active"] },
];

test("validates required values, relations, URL formats, dates, numbers, and score ranges", () => {
  expect(validateFormFields(fields, {
    name: " ",
    municipality_id: "",
    source_url: "example.com",
    effective_date: "2026-02-30",
    score: 11,
    status: "Unexpected",
  })).toEqual({
    name: "Name is required.",
    municipality_id: "Municipality is required.",
    source_url: "Source URL must be a complete web address beginning with http:// or https://.",
    effective_date: "Effective Date must be a valid date.",
    score: "Score must be no more than 10.",
    status: "Choose a valid status.",
  });
});

test("validates date ranges while accepting valid optional values", () => {
  const options = { dateRanges: [{ start: "start_date", end: "target_date", startLabel: "Start Date", endLabel: "Target Date" }] };
  expect(validateFormFields([
    { key: "start_date", label: "Start Date", type: "date" },
    { key: "target_date", label: "Target Date", type: "date" },
  ], { start_date: "2026-09-02", target_date: "2026-09-01" }, options)).toEqual({
    target_date: "Target Date must be on or after Start Date.",
  });
  expect(validateFormFields(fields, {
    name: "Project", municipality_id: "municipality-1", source_url: "https://example.com/code",
    effective_date: "2026-09-01", score: "8.5", status: "Active",
  })).toEqual({});
});