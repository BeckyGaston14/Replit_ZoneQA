---
name: Production auth storage
description: Why production authentication reuses indexed generic PostgreSQL records.
---

Store opaque sessions as individually indexed records in the existing PostgreSQL
config table, keyed by a one-way digest. Serialize first-administrator bootstrap
with a PostgreSQL advisory lock inside the user-creation transaction.

**Why:** Production remediation explicitly prohibited schema changes, while user
metadata scans were neither scalable nor safe for concurrent bootstrap requests.

**How to apply:** Keep session lookup/revocation keyed and atomic. Do not move
sessions back into per-user arrays or split bootstrap checking from creation
unless an explicit database migration replaces this design.

User deactivation must change account state, recheck the last-active-admin
guard, and revoke every opaque session for that user in one PostgreSQL
transaction.

**Why:** A separate state update and session cleanup can leave either a disabled
account with a reported failure or a concurrent administrator race that removes
all active administrators.

**How to apply:** Serialize administrator lifecycle mutations with a transaction
lock, preserve historical user IDs and references, and keep permanent deletion
as a separate guarded lifecycle step.

Password-reset tokens should also be stored as individually indexed config records
using only a digest, with expiration, single-use consumption, prior-token
revocation, and password/session changes performed in one transaction.

**Why:** Recovery links are bearer credentials; plaintext persistence or a
separate token-consumption write permits replay, leakage, or concurrent resets.

**How to apply:** Keep raw reset tokens only in the one-time delivery/administrator
response, return generic public recovery messages, and never include tokens or
password material in audit records or public user objects.