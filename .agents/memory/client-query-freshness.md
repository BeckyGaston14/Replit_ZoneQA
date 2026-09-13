---
name: Client query freshness
description: Defines which frontend requests may be reused and how mutations prevent stale cross-page data.
---

Only shared lookup dictionaries may use a bounded client freshness window. Mutable records, authentication or permissions, integrity output, release readiness and decisions, and report metrics must be stale immediately while retaining identical in-flight request deduplication.

**Why:** Broad navigation caching can show pre-mutation integrity, release, report, or user-scoped data. Slow-changing lookup reuse is useful, but only when every write removes inactive lookup caches and refreshes active consumers across all key shapes.

**How to apply:** Use authenticated query keys and cancellation signals. On lookup writes or sample-scope changes, remove inactive affected queries and invalidate/refetch active ones. Include every version, scope, and visibility dimension in data-bearing keys.