# Authentication testing

ZoneQA uses password verification only at login, then issues an opaque server-side
session. The browser receives:

- `zq_session`: HttpOnly, SameSite=Lax, Secure in production
- `zq_csrf`: SameSite=Lax, Secure in production; copied to `X-CSRF-Token` for writes

No authentication token is returned in JSON or stored in browser storage.

## Required checks

1. A successful login sets both cookies and `/api/auth/me` returns the active user.
2. A protected request without `zq_session` returns 401.
3. A write with a session but no matching CSRF header returns 403.
4. Logout requires CSRF, revokes the current session, and clears both cookies.
5. Expired sessions return 401 and inactive users return 403.
6. Requests from origins outside `CORS_ORIGINS` receive no cross-origin permission.
7. `/api/auth/bootstrap` works only when `BOOTSTRAP_ADMIN_TOKEN` is configured and
   there is no active administrator; the token is supplied only in
   `X-Bootstrap-Token`.

Integration tests must receive credentials through test-only environment variables.
Never commit or display passwords or bootstrap tokens.