---
name: Executive PDF layout
description: Deterministic A4 export rules for the Executive Summary report.
---

The Executive Summary PDF must compose text, KPI cards, tables, headers, and footers directly in jsPDF; only individual charts may be rasterized from their SVG containers.

**Why:** Whole-page responsive screenshots sliced by page height can split charts, orphan fragments, overlap adjacent sections, and create blank continuation pages.

**How to apply:** Give each section a bounded A4 placement, keep headings with their chart/table, repeat table headers on row-boundary page breaks, and validate rendered pages visually as well as with layout bounds.