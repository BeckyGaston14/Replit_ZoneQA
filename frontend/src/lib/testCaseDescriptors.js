export const ALL_TEST_CASES = "__all";

// Keep these keys stable: they are used by saved views and table-sort state.
export const TEST_CASE_COLUMNS = [
  { key: "name", label: "Test Name", type: "natural", alwaysVisible: true },
  { key: "project", label: "Project", type: "text", getValue: (row) => row.project_name },
  { key: "municipality", label: "Municipality", type: "text", getValue: (row) => row.municipality_name },
  { key: "category", label: "Category", type: "text" },
  { key: "crit", label: "Crit", type: "criticality", getValue: (row) => row.criticality },
  { key: "status", label: "Status", type: "status" },
  { key: "result", label: "Bassett Result", type: "status", getValue: (row) => row.bassett_result, order: ["Pass", "Pass with Notes", "Fail", "Not Evaluated"] },
  { key: "test_date", label: "Test Date", type: "date", exportValue: (row) => row.test_date || "Not recorded" },
];

export const TEST_CASE_VISIBLE_COLUMN_OPTIONS = TEST_CASE_COLUMNS
  .filter((column) => !column.alwaysVisible)
  .map(({ key, label }) => ({ key, label }));

export const DEFAULT_TEST_CASE_VIEW = {
  filters: {
    status: ALL_TEST_CASES,
    category: ALL_TEST_CASES,
    criticality: ALL_TEST_CASES,
    project_id: ALL_TEST_CASES,
    archived: "active",
    date_from: "",
    date_to: "",
  },
  cols: Object.fromEntries(TEST_CASE_VISIBLE_COLUMN_OPTIONS.map(({ key }) => [key, true])),
};

export function normalizeTestCaseView(saved = {}) {
  const filters = Object.fromEntries(Object.keys(DEFAULT_TEST_CASE_VIEW.filters).map((key) => {
    const value = saved.filters?.[key];
    return [
      key,
      typeof value === "string" && value && value !== "*"
        ? value
        : DEFAULT_TEST_CASE_VIEW.filters[key],
    ];
  }));
  return {
    filters,
    cols: { ...DEFAULT_TEST_CASE_VIEW.cols, ...(saved.cols || {}) },
  };
}

export const DEFAULT_TEST_CASE_SORT = { key: "name", direction: "asc" };