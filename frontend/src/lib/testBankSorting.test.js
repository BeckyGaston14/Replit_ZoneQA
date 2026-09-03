import {
  DEFAULT_TEST_BANK_SORT,
  TEST_BANK_SORT_COLUMNS,
  nextTestBankSort,
  parseStructuredTestId,
  readStoredTestBankSort,
  sortTestBankScenarios,
  writeStoredTestBankSort,
} from "./testBankSorting";

const rows = (ids) => ids.map((stable_id, index) => ({
  id: `scenario-${index}`,
  stable_id,
  workflow_stage: stable_id?.toUpperCase().startsWith("A-") ? "Analysis" : "Research",
  test_scenario: `Scenario ${index}`,
  complexity: "Medium",
  priority: "P2",
  execution_count: index,
}));

test("defaults to natural Test ID ascending and keeps prefixes grouped", () => {
  expect(DEFAULT_TEST_BANK_SORT).toEqual({ key: "stable_id", direction: "asc" });
  expect(sortTestBankScenarios(rows(["R-10", "A-12", "R-02", "A-01", "R-09", "A-02"]))
    .map((row) => row.stable_id))
    .toEqual(["A-01", "A-02", "A-12", "R-02", "R-09", "R-10"]);
});

test("Test ID descending reverses valid groups and sequences but leaves malformed values last", () => {
  const sorted = sortTestBankScenarios(rows(["R-2", "R-10", "r-01", "bad", "", "A-12"]), "stable_id", "desc");
  expect(sorted.map((row) => row.stable_id)).toEqual(["R-10", "R-2", "r-01", "A-12", "bad", ""]);
  expect(parseStructuredTestId(" r-001 ")).toMatchObject({ valid: true, prefix: "R", sequence: 1 });
  expect(parseStructuredTestId("R2").valid).toBe(false);
});

test("domain columns use configured order in both directions", () => {
  const input = [
    { id: "1", stable_id: "R-01", complexity: "Very High", priority: "P2" },
    { id: "2", stable_id: "R-02", complexity: "Low", priority: "P0" },
    { id: "3", stable_id: "R-03", complexity: "Moderate", priority: "P1" },
    { id: "4", stable_id: "R-04", complexity: "Unknown", priority: "P9" },
  ];
  expect(sortTestBankScenarios(input, "complexity").map((row) => row.complexity))
    .toEqual(["Low", "Moderate", "Very High", "Unknown"]);
  expect(sortTestBankScenarios(input, "complexity", "desc").map((row) => row.complexity))
    .toEqual(["Very High", "Moderate", "Low", "Unknown"]);
  expect(sortTestBankScenarios(input, "priority").map((row) => row.priority))
    .toEqual(["P0", "P1", "P2", "P9"]);
});

test("text, numeric values, blank values, and equal ties are predictable", () => {
  const input = [
    { id: "first", stable_id: "R-01", report_type: "zoning", execution_count: 2 },
    { id: "second", stable_id: "R-02", report_type: "Assessment", execution_count: 10 },
    { id: "third", stable_id: "R-03", report_type: "assessment", execution_count: 1 },
    { id: "blank", stable_id: "R-04", report_type: "", execution_count: null },
  ];
  expect(sortTestBankScenarios(input, "report_type").map((row) => row.id))
    .toEqual(["second", "third", "first", "blank"]);
  expect(sortTestBankScenarios(input, "execution_count").map((row) => row.id))
    .toEqual(["third", "first", "second", "blank"]);
  expect(sortTestBankScenarios([
    { id: "a", stable_id: "R-01", test_scenario: "same", priority: "P1" },
    { id: "b", stable_id: "R-01", test_scenario: "same", priority: "P1" },
  ], "priority").map((row) => row.id)).toEqual(["a", "b"]);
});

test("sort toggle selects ascending on a new column and alternates the active column", () => {
  expect(TEST_BANK_SORT_COLUMNS.map((column) => column.key)).toEqual([
    "stable_id", "workflow_stage", "report_type", "test_scenario",
    "complexity", "priority", "execution_count",
  ]);
  expect(nextTestBankSort(DEFAULT_TEST_BANK_SORT, "priority")).toEqual({ key: "priority", direction: "asc" });
  expect(nextTestBankSort(DEFAULT_TEST_BANK_SORT, "stable_id")).toEqual({ key: "stable_id", direction: "desc" });
  expect(nextTestBankSort({ key: "stable_id", direction: "desc" }, "stable_id")).toEqual({ key: "stable_id", direction: "asc" });
});

test("chosen sorting survives navigation and invalid stored state falls back safely", () => {
  const values = new Map();
  const storage = {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
  };
  writeStoredTestBankSort(storage, { key: "complexity", direction: "desc" });
  expect(readStoredTestBankSort(storage)).toEqual({ key: "complexity", direction: "desc" });
  storage.setItem("zoneqa:test-bank-sort", JSON.stringify({ key: "not-a-column", direction: "sideways" }));
  expect(readStoredTestBankSort(storage)).toEqual(DEFAULT_TEST_BANK_SORT);
});