import {
  compareTableValues,
  nextSort,
  readTableSort,
  sortTableRows,
} from "./tableSorting";

const column = (type, extra = {}) => ({ key: "value", label: "Value", type, ...extra });
const values = (items, definition, direction = "asc") =>
  sortTableRows(items.map((value, index) => ({ id: index, value })), [definition], { key: "value", direction }).map((row) => row.value);

test("natural identifiers and semantic Bassett versions sort numerically", () => {
  expect(values(["TC-10", "TC-2", "tc-01"], column("natural"))).toEqual(["tc-01", "TC-2", "TC-10"]);
  expect(values(["Bassett v2.10.0", "v2.2", "v10.0", "invalid"], column("version")))
    .toEqual(["v2.2", "Bassett v2.10.0", "v10.0", "invalid"]);
});

test("numbers, percentages, scores, and dates use typed comparisons", () => {
  expect(values(["10", "2", null], column("number"))).toEqual(["2", "10", null]);
  expect(values(["90%", "8%", ""], column("percentage"), "desc")).toEqual(["90%", "8%", ""]);
  expect(values(["2025-12-01", "2026-01-02", "bad"], column("date"), "desc")).toEqual(["2026-01-02", "2025-12-01", "bad"]);
});

test("domain ranks are predictable and unknown values stay last both ways", () => {
  expect(values(["Low", "Critical", "Unknown", null], column("severity"))).toEqual(["Critical", "Low", "Unknown", null]);
  expect(values(["Low", "Critical", "Unknown", null], column("severity"), "desc")).toEqual(["Low", "Critical", "Unknown", null]);
  expect(values(["viewer", "admin", "tester"], column("role"))).toEqual(["admin", "tester", "viewer"]);
  expect(values([false, true, null], column("active"))).toEqual([true, false, null]);
});

test("stable tie breakers prevent equal rows from jumping", () => {
  const rows = [{ name: "Same", email: "z@example.com" }, { name: "same", email: "a@example.com" }];
  const columns = [column("text", { key: "name" }), column("text", { key: "email" })];
  expect(sortTableRows(rows, columns, { key: "name", direction: "asc" }, ["email"]).map((row) => row.email))
    .toEqual(["a@example.com", "z@example.com"]);
});

test("toggle, persisted state validation, and default restoration are deterministic", () => {
  expect(nextSort({ key: "name", direction: "asc" }, "name")).toEqual({ key: "name", direction: "desc" });
  expect(nextSort({ key: "name", direction: "desc" }, "date")).toEqual({ key: "date", direction: "asc" });
  const columns = [column("text", { key: "name" })];
  const defaultSort = { key: "name", direction: "asc" };
  const storage = { getItem: () => JSON.stringify({ key: "name", direction: "desc" }) };
  expect(readTableSort(storage, "users", columns, defaultSort)).toEqual({ key: "name", direction: "desc" });
  expect(readTableSort({ getItem: () => JSON.stringify({ key: "secret", direction: "sideways" }) }, "users", columns, defaultSort)).toEqual(defaultSort);
});

test("comparison helper keeps invalid values behind valid values in descending order", () => {
  expect(compareTableValues("bad", "2026-01-01", column("date"), "desc")).toBeGreaterThan(0);
});