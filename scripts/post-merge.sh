#!/usr/bin/env bash
set -euo pipefail

# Keep the merge hook deterministic and non-interactive. Database migrations
# run from the backend startup handler, so this hook only validates the
# application dependencies and source before workflow reconciliation.
python -m py_compile \
  backend/server.py \
  backend/postgres_store.py \
  backend/object_storage.py \
  scripts/serve_frontend.py \
  scripts/start_production.py

python - <<'PY'
import asyncpg
import fastapi
from replit.object_storage import Client

print("Backend dependency imports verified")
PY

yarn --cwd frontend install --frozen-lockfile --non-interactive >/dev/null
python -m pip check >/dev/null
echo "Post-merge setup checks passed"