---
name: Client query freshness
description: Defines which frontend requests may be reused and how mutations prevent stale cross-page data.
---

Only shared lookup dictionaries may use a bounded client freshness window. Mutable records, authentication or permissions, integrity output, release readiness and decisions, and report metrics must be stale immediately while retaining identical in-flight request deduplication.

**Why:** Broad navigation caching can show pre-mutation integrity, release, report, or user-scoped data. Slow-changing lookup reuse is useful, but only when every write removes inactive lookup caches and refreshes active consumers across all key shapes.

**How to apply:** Use authenticated query keys and cancellation signals. On lookup writes or sample-scope changes, remove inactive affected queries and invalidate/refetch active ones. Include every version, scope, and visibility dimension in data-bearing keys.

Public authentication screens may render while cookie-backed session discovery is pending, but stale bootstrap results must never override a newer login, logout, or expiry transition.

**Why:** Non-blocking public rendering improves sign-in startup but creates a race where a late signed-out response can clear a newly authenticated user.

**How to apply:** Keep session bootstrap single-flight, order auth mutations with a generation guard or equivalent, and test late bootstrap success and failure after login.