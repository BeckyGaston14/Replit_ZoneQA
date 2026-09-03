function validIsoDate(value) {
  return /^\d{4}-\d{2}-\d{2}$/.test(String(value || ""));
}

export function withinDateRange(value, from, to) {
  if (!from && !to) return true;
  if (!validIsoDate(value)) return false;
  if (from && value < from) return false;
  if (to && value > to) return false;
  return true;
}

function csvCell(value) {
  const text = String(value ?? "");
  return `"${text.replace(/"/g, '""')}"`;
}

export function tableRowsToCsv(rows, columns) {
  const header = columns.map((column) => csvCell(column.label)).join(",");
  const body = rows.map((row) => columns.map((column) => {
    const value = column.exportValue ? column.exportValue(row) : (column.getValue ? column.getValue(row) : row[column.key]);
    return csvCell(value);
  }).join(","));
  return [header, ...body].join("\n");
}

export function downloadCsv(filename, csv) {
  const url = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.click();
  URL.revokeObjectURL(url);
}