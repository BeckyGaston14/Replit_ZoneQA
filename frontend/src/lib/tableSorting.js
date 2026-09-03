import { useState } from "react";

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });

export const DOMAIN_ORDERS = {
  complexity: ["Low", "Moderate", "Medium", "High", "Very High"],
  priority: ["P0", "P0 - Immediate", "Critical", "P1", "P1 - High", "High", "P2", "P2 - Medium", "Medium", "Low"],
  severity: ["Critical", "High", "Medium", "Low", "Informational"],
  criticality: [5, 4, 3, 2, 1, 0],
  role: ["admin", "qa_manager", "tester", "developer", "viewer"],
  active: [true, false],
};

const valueOf = (row, column) => column.getValue ? column.getValue(row) : row?.[column.key];
const blank = (value) => value === null || value === undefined || String(value).trim() === "";
const text = (value) => String(value ?? "").trim();

function parsed(value, type) {
  if (type === "number" || type === "percentage" || type === "score" || type === "count") {
    const result = typeof value === "number" ? value : Number(String(value).replace(/[%,$]/g, ""));
    return Number.isFinite(result) ? { valid: true, value: result } : { valid: false };
  }
  if (type === "date" || type === "datetime") {
    const result = value instanceof Date ? value.getTime() : Date.parse(value);
    return Number.isFinite(result) ? { valid: true, value: result } : { valid: false };
  }
  if (type === "version") {
    const match = text(value).match(/(?:^|[^0-9])v?(\d+(?:\.\d+)*)(?:[^0-9]|$)/i);
    return match ? { valid: true, value: match[1].split(".").map(Number), suffix: text(value) } : { valid: false };
  }
  if (type === "test-id") {
    const match = /^([a-z]+)\s*-\s*(\d+)$/i.exec(text(value));
    return match ? { valid: true, value: [match[1].toUpperCase(), Number(match[2])] } : { valid: false };
  }
  return { valid: true, value };
}

function compareArrays(left, right) {
  const length = Math.max(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    const a = left[index] ?? 0;
    const b = right[index] ?? 0;
    const result = typeof a === "number" && typeof b === "number" ? a - b : collator.compare(String(a), String(b));
    if (result) return result;
  }
  return 0;
}

function compareDomain(left, right, order) {
  const normalize = (value) => typeof value === "string" ? value.trim().toLowerCase() : value;
  const normalizedOrder = order.map(normalize);
  const a = normalizedOrder.indexOf(normalize(left));
  const b = normalizedOrder.indexOf(normalize(right));
  if ((a >= 0) !== (b >= 0)) return a >= 0 ? -1 : 1;
  return a >= 0 ? a - b : collator.compare(text(left), text(right));
}

export function compareTableValues(left, right, column, direction = "asc") {
  const leftBlank = blank(left);
  const rightBlank = blank(right);
  if (leftBlank !== rightBlank) return leftBlank ? 1 : -1;
  if (leftBlank) return 0;

  const order = column.order || DOMAIN_ORDERS[column.type];
  if (order) {
    const leftKnown = order.some((item) => String(item).toLowerCase() === text(left).toLowerCase());
    const rightKnown = order.some((item) => String(item).toLowerCase() === text(right).toLowerCase());
    if (leftKnown !== rightKnown) return leftKnown ? -1 : 1;
    const result = compareDomain(left, right, order);
    return direction === "desc" ? -result : result;
  }

  const a = parsed(left, column.type);
  const b = parsed(right, column.type);
  if (a.valid !== b.valid) return a.valid ? -1 : 1;
  let result;
  if (!a.valid) result = collator.compare(text(left), text(right));
  else if (Array.isArray(a.value)) result = compareArrays(a.value, b.value);
  else if (typeof a.value === "number") result = a.value - b.value;
  else result = collator.compare(text(a.value), text(b.value));
  return direction === "desc" ? -result : result;
}

export function sortTableRows(rows, columns, sort, tieBreakers = []) {
  const column = columns.find((item) => item.key === sort?.key) || columns[0];
  const direction = sort?.direction === "desc" ? "desc" : "asc";
  return (rows || []).map((row, index) => ({ row, index })).sort((left, right) => {
    const primary = compareTableValues(valueOf(left.row, column), valueOf(right.row, column), column, direction);
    if (primary) return primary;
    for (const tieDefinition of tieBreakers) {
      const key = typeof tieDefinition === "string" ? tieDefinition : tieDefinition.key;
      const tieDirection = typeof tieDefinition === "string" ? "asc" : tieDefinition.direction || "asc";
      const tieColumn = columns.find((item) => item.key === key) || { key, type: "natural" };
      const tie = compareTableValues(valueOf(left.row, tieColumn), valueOf(right.row, tieColumn), tieColumn, tieDirection);
      if (tie) return tie;
    }
    return left.index - right.index;
  }).map(({ row }) => row);
}

export function nextSort(current, key) {
  return current?.key === key
    ? { key, direction: current.direction === "asc" ? "desc" : "asc" }
    : { key, direction: "asc" };
}

function storageKey(tableId) {
  return `zoneqa.table-sort.${tableId}`;
}

export function readTableSort(storage, tableId, columns, defaultSort) {
  try {
    const saved = JSON.parse(storage?.getItem(storageKey(tableId)) || "null");
    if (columns.some((column) => column.key === saved?.key) && ["asc", "desc"].includes(saved?.direction)) return saved;
  } catch {}
  return defaultSort;
}

export function usePersistentTableSort(tableId, columns, defaultSort) {
  const storage = typeof window === "undefined" ? null : window.localStorage;
  const [sort, setSortState] = useState(() => readTableSort(storage, tableId, columns, defaultSort));
  const setSort = (next) => {
    setSortState((current) => {
      const value = typeof next === "function" ? next(current) : next;
      try { storage?.setItem(storageKey(tableId), JSON.stringify(value)); } catch {}
      return value;
    });
  };
  return [sort, setSort];
}