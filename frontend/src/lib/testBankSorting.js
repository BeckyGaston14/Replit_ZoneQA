export const DEFAULT_TEST_BANK_SORT = { key: "stable_id", direction: "asc" };
export const TEST_BANK_SORT_STORAGE_KEY = "zoneqa:test-bank-sort";

export const TEST_BANK_SORT_COLUMNS = [
  { key: "stable_id", label: "Test ID", type: "test-id" },
  { key: "workflow_stage", label: "Workflow Stage", type: "text" },
  { key: "report_type", label: "Report Type", type: "text" },
  { key: "test_scenario", label: "Test Scenario", type: "text" },
  { key: "complexity", label: "Complexity", type: "complexity" },
  { key: "priority", label: "Priority", type: "priority" },
  { key: "execution_count", label: "Test Runs", type: "number" },
];

const COMPLEXITY_ORDER = ["low", "moderate", "medium", "high", "very high"];
const PRIORITY_ORDER = [
  "p0", "p0 - immediate", "critical",
  "p1", "p1 - high", "high",
  "p2", "p2 - medium", "medium",
  "low",
];

export function parseStructuredTestId(value) {
  const raw = String(value ?? "").trim();
  const match = /^([a-z]+)\s*-\s*(\d+)$/i.exec(raw);
  if (!match) return { valid: false, raw, prefix: "", sequence: null };
  return {
    valid: true,
    raw,
    prefix: match[1].toLocaleUpperCase(),
    sequence: Number(match[2]),
  };
}

function normalized(value) {
  return String(value ?? "").trim().toLocaleLowerCase();
}

function compareText(left, right) {
  return normalized(left).localeCompare(normalized(right), undefined, {
    numeric: true,
    sensitivity: "base",
  });
}

function compareRank(left, right, order) {
  const leftValue = normalized(left);
  const rightValue = normalized(right);
  const leftRank = order.indexOf(leftValue);
  const rightRank = order.indexOf(rightValue);
  const leftKnown = leftRank >= 0;
  const rightKnown = rightRank >= 0;
  if (leftKnown && rightKnown) return leftRank - rightRank;
  if (leftKnown) return -1;
  if (rightKnown) return 1;
  return compareText(left, right);
}

function compareDomain(left, right, order, direction) {
  const leftRank = order.indexOf(normalized(left));
  const rightRank = order.indexOf(normalized(right));
  const leftKnown = leftRank >= 0;
  const rightKnown = rightRank >= 0;
  if (leftKnown !== rightKnown) return leftKnown ? -1 : 1;
  const comparison = leftKnown ? leftRank - rightRank : compareText(left, right);
  return direction === "desc" ? -comparison : comparison;
}

function compareStructuredId(left, right) {
  const a = parseStructuredTestId(left);
  const b = parseStructuredTestId(right);
  if (a.valid && b.valid) {
    return compareText(a.prefix, b.prefix) || a.sequence - b.sequence;
  }
  if (a.valid) return -1;
  if (b.valid) return 1;
  return compareText(a.raw, b.raw);
}

function comparePrimary(left, right, type) {
  if (type === "structured-id" || type === "test-id") return compareStructuredId(left, right);
  if (type === "workflow-stage") return compareText(left, right);
  if (type === "complexity") return compareRank(left, right, COMPLEXITY_ORDER);
  if (type === "priority") return compareRank(left, right, PRIORITY_ORDER);
  if (type === "number") {
    const a = Number(left);
    const b = Number(right);
    if (Number.isFinite(a) && Number.isFinite(b)) return a - b;
    if (Number.isFinite(a)) return -1;
    if (Number.isFinite(b)) return 1;
  }
  return compareText(left, right);
}

function isBlank(value) {
  return value === null || value === undefined || String(value).trim() === "";
}

function compareWithBlankLast(left, right, type, direction) {
  const leftBlank = isBlank(left);
  const rightBlank = isBlank(right);
  if (leftBlank && rightBlank) return 0;
  if (leftBlank) return 1;
  if (rightBlank) return -1;
  if (type === "structured-id" || type === "test-id") {
    const leftId = parseStructuredTestId(left);
    const rightId = parseStructuredTestId(right);
    if (leftId.valid !== rightId.valid) return leftId.valid ? -1 : 1;
  }
  if (type === "complexity") return compareDomain(left, right, COMPLEXITY_ORDER, direction);
  if (type === "priority") return compareDomain(left, right, PRIORITY_ORDER, direction);
  const comparison = comparePrimary(left, right, type);
  return direction === "desc" ? -comparison : comparison;
}

function definitionFor(key) {
  return TEST_BANK_SORT_COLUMNS.find((column) => column.key === key) || TEST_BANK_SORT_COLUMNS[0];
}

export function sortTestBankScenarios(items, key = DEFAULT_TEST_BANK_SORT.key, direction = DEFAULT_TEST_BANK_SORT.direction) {
  const definition = definitionFor(key);
  const safeDirection = direction === "desc" ? "desc" : "asc";
  return (items || [])
    .map((item, index) => ({ item, index }))
    .sort((left, right) => {
      const primary = compareWithBlankLast(
        left.item?.[definition.key],
        right.item?.[definition.key],
        definition.type,
        safeDirection,
      );
      if (primary) return primary;
      const idTieBreak = compareWithBlankLast(
        left.item?.stable_id,
        right.item?.stable_id,
        "structured-id",
        "asc",
      );
      if (idTieBreak) return idTieBreak;
      const scenarioTieBreak = compareText(left.item?.test_scenario, right.item?.test_scenario);
      return scenarioTieBreak || left.index - right.index;
    })
    .map(({ item }) => item);
}

export function nextTestBankSort(current, key) {
  if (current?.key === key) {
    return { key, direction: current.direction === "asc" ? "desc" : "asc" };
  }
  return { key, direction: "asc" };
}

export function readStoredTestBankSort(storage) {
  try {
    const parsed = JSON.parse(storage?.getItem(TEST_BANK_SORT_STORAGE_KEY) || "null");
    const validKey = TEST_BANK_SORT_COLUMNS.some((column) => column.key === parsed?.key);
    if (validKey && ["asc", "desc"].includes(parsed?.direction)) return parsed;
  } catch {
    // Invalid browser state must never prevent the Test Bank from rendering.
  }
  return DEFAULT_TEST_BANK_SORT;
}

export function writeStoredTestBankSort(storage, sort) {
  try {
    storage?.setItem(TEST_BANK_SORT_STORAGE_KEY, JSON.stringify(sort));
  } catch {
    // Sorting remains functional when browser storage is unavailable.
  }
}