# ZoneQA Bassett Testing

Internal QA, benchmarking, regression, and release-readiness application for
Bassett. PostgreSQL is authoritative and Replit App Storage holds attachment bytes.

## Runtime configuration

- `DATABASE_URL` (Replit-managed): required.
- `APP_ENV`: `development`, `test`, or `production`.
- `SESSION_SECRET`: required in production; used only to hash opaque sessions.
- `BOOTSTRAP_ADMIN_TOKEN`: required on a fresh production database until the first
  active administrator is created.
- `CORS_ORIGINS`: optional comma-separated exact origins. Same-origin traffic does
  not require CORS. Wildcards are rejected.
- Replit App Storage variables are managed by Replit.

No fallback credentials or automatic seed accounts are created. On an empty
database, submit the first administrator to `POST /api/auth/bootstrap` with the
one-time secret in `X-Bootstrap-Token`. The endpoint permanently refuses further
bootstrap attempts once an active administrator exists.

Administrators can enroll a password for legacy Google-only users from
Administration → Users & Roles; this preserves the existing PostgreSQL user ID,
role, and QA history while moving the account to password sign-in.

`BASSETT_ALLOWED_HOSTS` is an optional comma-separated exact hostname allowlist
(default: `api.zoneomics.com`). Bassett credentials are never sent to a URL that
does not pass this HTTPS allowlist.

## Run

The Replit workflow builds the React application once, starts the FastAPI backend
on internal port 8000, and serves the static SPA with same-origin `/api` proxying
on port 5000:

```sh
yarn --cwd frontend build
APP_ENV=production SERVE_MODE=production HOST=0.0.0.0 PORT=5000 \
  python scripts/start_production.py
```

Client routes use SPA fallback. The production process never launches the React
development server.

## Dependencies and tests

`pyproject.toml` is the authoritative Python runtime manifest.
`backend/requirements-test.txt` adds test-only packages.

```sh
python -m pytest backend/tests/test_production_readiness.py
yarn --cwd frontend build
python scripts/serve_frontend.py --smoke-test
```

AI assist and benchmark controls return a clear unavailable response until a
supported provider is configured. Bassett credentials are accepted only through
the dedicated `X-Bassett-API-Key` header and are never returned by the API.
