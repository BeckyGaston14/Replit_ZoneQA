import { ArrowDown, ArrowUp, ArrowUpDown } from "lucide-react";

export function SortableTableHeader({ column, sort, onSort, className = "" }) {
  const active = sort.key === column.key;
  const directionLabel = active ? (sort.direction === "asc" ? "ascending" : "descending") : "not sorted";
  const DirectionIcon = active ? (sort.direction === "asc" ? ArrowUp : ArrowDown) : ArrowUpDown;
  return <th aria-sort={active ? directionLabel : "none"} className={`px-2.5 py-2 text-[11px] uppercase tracking-wide text-muted-foreground ${className}`}>
    <button
      type="button"
      className="inline-flex items-center gap-1 font-semibold hover:text-[var(--navy)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--orange)]"
      onClick={() => onSort(column.key)}
      aria-label={`Sort by ${column.label}, currently ${directionLabel}`}
    >
      <span>{column.label}</span><DirectionIcon size={13} aria-hidden="true" />
      <span className="sr-only">{active ? `Sorted ${directionLabel}` : "Not sorted"}</span>
    </button>
  </th>;
}