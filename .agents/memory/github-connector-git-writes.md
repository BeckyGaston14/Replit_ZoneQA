---
name: GitHub connector Git writes
description: Safe fallback behavior when Git CLI credentials cannot use an attached GitHub connector.
---

When normal Git authentication fails but an authorized GitHub connector is available, any Git Data API fallback must require the expected remote parent and verify the resulting tree SHA against the tested local tree before updating a branch.

**Why:** Shell-output transport can alter path delimiters or truncate large encoded files even when the wrapper does not clearly report truncation. That can create a syntactically valid but incorrect remote tree.

**How to apply:** Prefer normal `git push`. If connector fallback is unavoidable, read workspace files directly inside the authenticated sandbox, use non-force reference updates, and fetch afterward to verify exact tree equality, raw path validity, and zero content diff.