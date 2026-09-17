---
name: Test Bank catalog activation
description: Safety rule for activating revisioned Test Bank scenario and rubric catalogs.
---

Test Bank catalog revisions must be activated through an administrator-visible preview followed by an explicitly confirmed apply operation. Never archive or replace scenario definitions automatically during application startup or deployment.

**Why:** Activating a catalog archives active definitions and changes the population used by new testing and reporting. Startup-triggered activation could change production records without a reviewed change window, even when historical links remain intact.

**How to apply:** Keep catalog loading and validation available at runtime, but gate record reconciliation behind an idempotent admin action that reports archive/insert counts and preserves historical runs, scores, findings, attachments, and relationships.