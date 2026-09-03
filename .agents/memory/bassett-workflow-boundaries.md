---
name: Bassett workflow boundaries
description: Durable constraints for Bassett test creation and promotion
---

Bassett-only test creation and promotion must not manufacture ChatGPT or Claude responses, evaluations, or comparison-completion state. Evidence files should remain one attachment record with a linked testcase relationship when promoted, so the original Bassett evidence chain and retention behavior stay intact.

**Why:** Bassett records are authoritative source evidence, while model comparisons are a separate workflow. Synthetic benchmark slots distort denominators and scores, and copied attachment metadata creates ambiguous ownership.

**How to apply:** Preserve Bassett-only records in reporting unless a user explicitly expands them into a comparison; when expanding, create only the Bassett response/evaluation and link existing evidence rather than copying file records.