---
name: Preview workflow reliability
description: Replit preview workflow behavior for this React and FastAPI project.
---

The React CRACO development server can compile and respond locally while Replit's workflow monitor still fails to register its port and terminates the workflow. Keep the lightweight Python server as the process registered to port 5000, and run CRACO behind it on an internal port so source updates still reach the preview through HMR. The proxy needs to tunnel both normal frontend requests and the HMR WebSocket, while `/api` continues to go directly to the backend. Retain an initial production build as a fallback if CRACO is unavailable.

**Why:** The monitor repeatedly timed out after CRACO reported a successful compile, leaving the preview unavailable even though the application itself was sound. Also, a CRACO server behind a proxy otherwise embeds its internal host and port in the HMR client, which cannot be reached from the Replit iframe.

**How to apply:** Keep the webview bound to `0.0.0.0:5000`; start CRACO on an auxiliary local port and explicitly configure its HMR WebSocket URL as `auto://0.0.0.0:0/ws` so the browser resolves it back to the webview origin. The production build must keep the backend URL empty, otherwise the frontend may bundle an `undefined/api` base path. Treat a future switch back to a direct CRACO webview as a workflow-platform compatibility change that needs explicit verification.

Run a self-contained proxy smoke check during preview startup, before CRACO launches. The check must cover frontend HTTP proxying, webpack-style WebSocket update messages, same-origin API forwarding, and production-build fallback.

**Why:** A listening preview port does not prove that source updates can reach the browser; frontend tooling can regress the WebSocket path while ordinary page loads continue to work.

**How to apply:** Keep the smoke fixtures independent of the real backend and frontend processes so startup failures identify proxy regressions deterministically.