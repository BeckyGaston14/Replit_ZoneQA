---
name: Mobile data-table accessibility
description: Responsive and keyboard expectations for dense workspace tables.
---

Dense tables must preserve access to every column and row action at a 320px viewport. Use a clearly bounded horizontal scroll region with an explicit table minimum width, or provide a complete mobile card alternative.

**Why:** A responsive outer layout does not make wide tables usable; clipped or over-compressed columns made core Test Cases and Regression workflows unreliable on phones.

**How to apply:** When adding or changing a multi-column table, verify the scroll/card structure at 320px and add a DOM-level regression test that confirms all content remains reachable.