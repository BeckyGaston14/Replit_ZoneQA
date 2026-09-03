---
name: Atomic record edits
description: Concurrency rule for editable records and conflict recovery.
---

Employee-editable records must use a revision predicate while holding the
database row lock, then increment the revision in the same write. A separate
read-time freshness check is useful for early feedback but is not the lock.

**Why:** Two requests can both pass a separate freshness check before either
unconditional write runs, causing one employee's changes to disappear.

**How to apply:** Route every editable update path, including specialized
workflows, through a row-level compare-and-swap. Return a structured 409 when
the predicate loses, and preserve the user's draft while showing the latest
field values before reapplication.

When an administrator edit also changes credentials, persist the profile,
credential, audit event, and credential-session revocation in the same
transaction.

**Why:** A successful profile save followed by a failed password save leaves
the account in a misleading partial state; an unrevoked session also keeps an
old credential usable.

**How to apply:** Use the credential-aware atomic operation for the complete
edit form, including password-only and combined updates; keep compatibility
endpoints delegated to that operation.