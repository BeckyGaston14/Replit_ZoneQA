---
name: Bassett workflow terminology
description: Canonical naming, compatibility, and ownership boundaries for Bassett workflows.
---

The two canonical Bassett workflow stages are Research and Analysis. Never relabel Analysis as a writing stage, and preserve all A-stage IDs, stored Analysis values, relationships, and sequence allocation.

**Why:** A prior request to rename Analysis was explicitly corrected as an error.

**How to apply:** Use Research and Analysis across UI, validation, CSV, metrics, configuration, tests, and documentation. A transient legacy alias may be accepted only as input and normalized to Analysis without changing IDs or creating duplicate records.

Bassett-only Test Bank scenarios, Test Runs, and Findings are a distinct workflow from full Bassett vs ChatGPT vs Claude Test Cases, comparisons, and Findings. Expansion creates an explicit cross-workflow link; it never moves, merges, or relabels the Bassett-only source record.

**Why:** Similar record names previously made workflow ownership ambiguous and risked presenting linked records as a single lifecycle.

**How to apply:** Keep separate navigation groups, contextual page titles, filters, routes, active-route ownership, empty states, and create actions. Use qualified labels such as “Bassett Findings” and “Model Comparison Findings” whenever both meanings could apply.