import {
  DEFAULT_TEST_CASE_VIEW,
  TEST_CASE_COLUMNS,
  TEST_CASE_VISIBLE_COLUMN_OPTIONS,
  normalizeTestCaseView,
} from "./testCaseDescriptors";
import {
  MUNICIPALITY_SCHEMA,
  PROJECT_SCHEMA,
  PROPERTY_SCHEMA,
  createEvidenceSchema,
} from "./resourceSchemas";

test("test-case descriptors retain persisted column keys and normalize legacy views", () => {
  expect(TEST_CASE_COLUMNS.map(({ key }) => key)).toEqual([
    "name", "project", "municipality", "category", "crit", "status", "result", "test_date",
  ]);
  expect(TEST_CASE_VISIBLE_COLUMN_OPTIONS.map(({ key }) => key)).toEqual([
    "project", "municipality", "category", "crit", "status", "result", "test_date",
  ]);
  expect(normalizeTestCaseView({
    filters: { status: "*", archived: "archived" },
    cols: { project: false },
  })).toEqual({
    filters: { ...DEFAULT_TEST_CASE_VIEW.filters, archived: "archived" },
    cols: { ...DEFAULT_TEST_CASE_VIEW.cols, project: false },
  });
});

test("resource schemas preserve required and relation-field contracts", () => {
  expect(PROJECT_SCHEMA.fields.find(({ key }) => key === "name").required).toBe(true);
  expect(PROJECT_SCHEMA.fields.find(({ key }) => key === "owner_id")).toEqual(expect.objectContaining({
    type: "relation",
    collection: "users",
  }));
  expect(MUNICIPALITY_SCHEMA.fields.filter(({ required }) => required).map(({ key }) => key)).toEqual(["name", "state"]);
  const propertyMunicipality = PROPERTY_SCHEMA.fields.find(({ key }) => key === "municipality_id");
  expect(propertyMunicipality).toEqual(expect.objectContaining({
    required: true,
    type: "relation",
    collection: "municipalities",
  }));

  const evidenceMunicipality = createEvidenceSchema([]).fields.find(({ key }) => key === "municipality_id");
  expect(evidenceMunicipality).toEqual(expect.objectContaining({
    required: true,
    type: "relation",
    collection: "municipalities",
  }));
});
