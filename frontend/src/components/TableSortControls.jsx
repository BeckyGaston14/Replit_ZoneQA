import { ArrowDown, ArrowUp, RotateCcw } from "lucide-react";
import { Button } from "./ui/button";
import { nextSort } from "../lib/tableSorting";

export function TableSortControls({ columns, sort, setSort, defaultSort, className = "" }) {
  const reset = sort.key === defaultSort.key && sort.direction === defaultSort.direction;
  return <div className={`flex items-center gap-2 flex-wrap ${className}`} aria-label="Table sorting controls">
    <label className="text-xs font-semibold text-muted-foreground">
      Sort by{" "}
      <select
        value={sort.key}
        onChange={(event) => setSort({ key: event.target.value, direction: "asc" })}
        className="h-8 rounded-md border bg-card px-2 text-xs text-[var(--navy)]"
        aria-label="Sort by column"
      >
        {columns.map((column) => <option key={column.key} value={column.key}>{column.label}</option>)}
      </select>
    </label>
    <Button type="button" size="sm" variant="outline" className="h-8" onClick={() => setSort(nextSort(sort, sort.key))} aria-label={`Sort ${sort.direction === "asc" ? "descending" : "ascending"}`}>
      {sort.direction === "asc" ? <ArrowUp size={13} /> : <ArrowDown size={13} />}
      <span className="hidden sm:inline">{sort.direction === "asc" ? "Ascending" : "Descending"}</span>
    </Button>
    <Button type="button" size="sm" variant="ghost" className="h-8" disabled={reset} onClick={() => setSort(defaultSort)} aria-label="Restore default sort">
      <RotateCcw size={13} /><span className="hidden sm:inline">Default order</span>
    </Button>
  </div>;
}