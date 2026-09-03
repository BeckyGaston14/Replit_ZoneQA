---
name: Gmail connector delivery
description: Durable guidance for sending application email through the Replit-managed Gmail connection.
---

Production email delivery uses the Replit-managed Gmail OAuth connection through the documented connector proxy contract; the Python connector package may not be available in the workspace registry. Development and tests use a mock sender.

**Why:** Provider credentials and OAuth tokens must remain managed by Replit, while local and automated environments need deterministic, non-delivering behavior.

**How to apply:** Keep sender/profile failures safe and non-sensitive, make account creation independent of delivery success, and expose only connection/configuration status to administrators.