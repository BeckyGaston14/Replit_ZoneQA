---
name: Autoscale startup readiness
description: Why production frontend readiness must not wait synchronously for backend initialization.
---

For Autoscale publishing, open the public HTTP port and serve the built SPA before waiting for backend initialization to complete. Keep backend startup bounded but long enough for cold dependency imports, explicitly relay child-process output, and terminate the process if the backend exits or never becomes healthy.

**Why:** Production dependency imports and database initialization can exceed two minutes on a cold container. If the public server is opened only afterward, the platform's root readiness probe fails; if the outer timeout is too short, it kills a backend that is about to become healthy and creates a restart loop.

**How to apply:** Keep `GET /` available promptly, return retryable JSON `503` responses (with a clear message and `Retry-After`) for API calls made before backend readiness, relay unbuffered backend output, and keep the outer health deadline above observed cold-import time. If a live child emits no startup lines, log import boundaries and request a Python stack dump before termination.