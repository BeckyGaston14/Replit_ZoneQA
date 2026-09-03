---
name: Replit App Storage
description: The attachment storage integration and its Replit-specific setup constraint.
---

Use the published `replit-object-storage` Python package for Replit App Storage. It exposes the `replit.object_storage` import, authenticates through Replit's managed local identity sidecar, and uses the default bucket supplied to the app.

**Why:** The documented `replit-object-storage-python` package name is unavailable in this registry. The published package is named `replit-object-storage`; its managed authentication works in development where generic Google Application Default Credentials are absent. Its current dependency constraints require Python 3.12 and Google Cloud Storage 2.x.

**How to apply:** Keep attachment storage on the managed Replit client instead of restoring an Emergent fallback, but load its Google-backed client lazily so API health and authentication do not depend on storage imports. Attach an App Storage bucket before enabling uploads; legacy bytes must be copied and verified before attachment metadata is marked as Replit-backed.