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
  expect(PROJECT_SCHEMA.dateFilterLabel).toBe("Last Qualifying Test");
  expect(PROJECT_SCHEMA.columns.find(({ key }) => key === "last_tested_date").label).toBe("Last Qualifying Test");
  expect(PROJECT_SCHEMA.fields.find(({ key }) => key === "name").required).toBe(true);
  expect(PROJECT_SCHEMA.fields.find(({ key }) => key === "owner_id")).toEqual(expect.objectContaining({
    type: "relation",
    collection: "users",
  }));
  expect(PROJECT_SCHEMA.fields.find(({ key }) => key === "version_id")).toEqual(expect.objectContaining({
    label: "Bassett Version",
    type: "relation",
    collection: "versions",
  }));
  expect(MUNICIPALITY_SCHEMA.fields.filter(({ required }) => required).map(({ key }) => key)).toEqual(["name", "state"]);
  expect(MUNICIPALITY_SCHEMA.fields.find(({ key }) => key === "muni_type")).toEqual(expect.objectContaining({
    type: "select",
    configKey: "municipality_types",
  }));
  expect(MUNICIPALITY_SCHEMA.filterFields).toContainEqual(expect.objectContaining({
    key: "muni_type",
    configKey: "municipality_types",
  }));
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

  const evidenceSchema = createEvidenceSchema([]);
  expect(evidenceSchema.newLabel).toBe("New Ordinance Evidence");
  expect(evidenceSchema.emptyStateTitle).toBe("No ordinance evidence records have been created yet.");
  expect(evidenceSchema.emptyActionLabel).toBe("Create an ordinance evidence record.");
  expect(evidenceSchema.fields.map(({ key }) => key)).not.toEqual(expect.arrayContaining([
    "jurisdiction", "citation", "conflicts_with",
  ]));
  expect(evidenceSchema.fields.find(({ key }) => key === "section")).toEqual(expect.objectContaining({
    label: "Code Section #",
    group: "reference",
  }));
  expect(evidenceSchema.fields.map(({ key }) => key)).not.toEqual(expect.arrayContaining([
    "document_version", "issuing_authority", "verification_status", "verified_by", "verified_date",
    "effective_date", "superseded_date",
  ]));
  expect(evidenceSchema.columns.map(({ key }) => key)).toEqual(["document_name", "doc_type", "section"]);
});
