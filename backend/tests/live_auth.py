"""Cookie/CSRF helpers for opt-in live integration tests.

Credentials must come from the environment. Nothing in this module prints or
persists them, and tests skip when the required account is not provisioned.
"""

import os
from urllib.parse import quote

import pytest
import requests

LIVE_ENABLED = os.environ.get("ZONEQA_RUN_LIVE_TESTS", "").strip().lower() in {"1", "true", "yes"}
requires_live = pytest.mark.skipif(
    not LIVE_ENABLED,
    reason="live HTTP/TLS tests require ZONEQA_RUN_LIVE_TESTS=1 and provisioned credentials",
)

def base_url():
    configured = os.environ.get("ZONEQA_TEST_BASE_URL") or os.environ.get("REACT_APP_BACKEND_URL")
    if not configured and os.environ.get("REPLIT_DEV_DOMAIN"):
        configured = f"https://{os.environ['REPLIT_DEV_DOMAIN']}"
    return (configured or "http://127.0.0.1:5000").rstrip("/")


def credentials(role):
    prefix = f"ZONEQA_TEST_{role.upper()}"
    email = os.environ.get(f"{prefix}_EMAIL")
    password = os.environ.get(f"{prefix}_PASSWORD")
    if not email or not password:
        pytest.skip(f"Provision {prefix}_EMAIL and {prefix}_PASSWORD to run this test")
    return {"email": email, "password": password}


def login_headers(url, role="admin"):
    return headers_from_login(url, credentials(role))


def headers_from_login(url, account):
    session = requests.Session()
    response = session.post(
        f"{url}/api/auth/login",
        json=account,
        timeout=30,
    )
    assert response.status_code == 200, f"login failed: {response.status_code}"
    session_cookie = session.cookies.get("zq_session")
    csrf = session.cookies.get("zq_csrf")
    assert session_cookie and csrf, "Login did not issue secure session cookies"
    return {
        "Content-Type": "application/json",
        "Cookie": f"zq_session={quote(session_cookie)}; zq_csrf={quote(csrf)}",
        "X-CSRF-Token": csrf,
    }