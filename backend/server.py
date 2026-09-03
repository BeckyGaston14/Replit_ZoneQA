Warning: truncated output (original token count: 93119)
Total output lines: 7183

from dotenv import load_dotenv
from pathlib import Path
ROOT_DIR = Path(__file__).parent
load_dotenv(ROOT_DIR / '.env')

import os, uuid, logging, json, re, hashlib, hmac, secrets, ipaddress, csv, io, base64, math, time
from collections import Counter
from functools import cmp_to_key
from urllib.parse import urlsplit
from datetime import date, datetime, timezone, timedelta
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError
from typing import List, Optional, Any, Dict

import bcrypt, httpx, asyncio
from asyncpg.exceptions import ForeignKeyViolationError, UniqueViolationError
from fastapi import FastAPI, APIRouter, HTTPException, Depends, Request, Response, UploadFile, File, Form, Query
from starlette.middleware.cors import CORSMiddleware
from starlette.responses import JSONResponse
from pydantic import BaseModel, Field, EmailStr
from object_storage import ObjectNotFound, ObjectStorageUnavailable, app_storage
from postgres_store import (
    BassettScenarioInvalidError,
    BassettScenarioUnavailableError,
    PostgresDatabase,
)
from bassett_catalog import CANONICAL_SCENARIOS
from evaluation_metrics import (
    COMPARISON_MODELS,
    EVALUATED_RESULTS,
    FAIL_RESULTS,
    PASS_RESULTS,
    authoritative_score_update,
    average_score,
    latest_evaluations,
    result_summary,
    score_evaluation,
)
from gmail_sender import EmailDeliveryError, MockEmailSender, build_email_sender

APP_ENV = os.environ.get("APP_ENV", "development").strip().lower()
if APP_ENV not in {"development", "test", "production"}:
    raise RuntimeError("APP_ENV must be development, test, or production")


def _configured_worker_count() -> int:
    """Return the configured process count without making malformed config safe."""
    raw_value = (
        os.environ.get("WEB_CONCURRENCY")
        or os.environ.get("UVICORN_WORKERS")
        or os.environ.get("WORKERS")
        or "1"
    )
    try:
        workers = int(raw_value)
    except ValueError as error:
        raise RuntimeError("Worker count must be a positive integer") from error
    if workers < 1:
        raise RuntimeError("Worker count must be a positive integer")
    return workers


def _validate_session_secret_configuration(
    app_env: str, session_secret: str, worker_count: int
) -> None:
    if not session_secret and (app_env == "production" or worker_count > 1):
        raise RuntimeError(
            "SESSION_SECRET must be configured in production or when using multiple workers"
        )


SESSION_SECRET_CONFIGURED = os.environ.get("SESSION_SECRET", "").strip()
_validate_session_secret_configuration(
    APP_ENV, SESSION_SECRET_CONFIGURED, _configured_worker_count()
)

db = PostgresDatabase(os.environ["DATABASE_URL"])
email_sender = build_email_sender()

SESSION_COOKIE = "zq_session"
CSRF_COOKIE = "zq_csrf"
SESSION_TTL = timedelta(hours=12)
# A development/test fallback is intentionally process-local.  It is forbidden
# for production and multi-worker processes above, where every process must use
# the same configured key to locate opaque database-backed sessions.
SESSION_SECRET = SESSION_SECRET_CONFIGURED or secrets.token_urlsafe(32)
BOOTSTRAP_ADMIN_TOKEN = os.environ.get("BOOTSTRAP_ADMIN_TOKEN")
COOKIE_SECURE = APP_ENV == "production" or os.environ.get("COOKIE_SECURE", "").lower() == "true"

app = FastAPI(title="ZoneQA Bassett Testing")
api = APIRouter(prefix="/api")

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("zoneqa")


def _positive_timeout(name: str, default: float) -> float:
    raw_value = os.environ.get(name, str(default))
    try:
        value = float(raw_value)
    except ValueError as error:
        raise RuntimeError(f"{name} must be a positive number of seconds") from error
    if not math.isfinite(value) or value <= 0:
        raise RuntimeError(f"{name} must be a positive number of seconds")
    return value


DATABASE_STARTUP_TIMEOUT = _positive_timeout("DATABASE_STARTUP_TIMEOUT", 30)


def now_iso():
    return datetime.now(timezone.utc).isoformat()

TEST_DATE_MIN = date(1900, 1, 1)
PROJECT_COMPLETION_MODES = ("automatic", "manual")
PROJECT_COMPLETED_TEST_STATUSES = frozenset({
    "Evaluated", "Retested", "Closed", "Complete", "Completed",
})

def _validate_test_date(value, *, required=True, field_name="Test Date"):
    if value in (None, ""):
        if required:
            raise HTTPException(400, f"{field_name} is required")
        return None
    if not isinstance(value, str) or not re.fullmatch(r"\d{4}-\d{2}-\d{2}", value):
        raise HTTPException(400, f"{field_name} must use YYYY-MM-DD format")
    try:
        parsed = date.fromisoformat(value)
    except ValueError:
        raise HTTPException(400, f"{field_name} is not a valid calendar date")
    upper = datetime.now(timezone.utc).date() + timedelta(days=366)
    if parsed < TEST_DATE_MIN or parsed > upper:
        raise HTTPException(400, f"{field_name} must be between {TEST_DATE_MIN.isoformat()} and {upper.isoformat()}")
    return parsed.isoformat()

def _validate_date_range(date_from=None, date_to=None):
    start = _validate_test_date(date_from, required=False, field_name="From date")
    end = _validate_test_date(date_to, required=False, field_name="To date")
    if start and end and start > end:
        raise HTTPException(400, "From date cannot be after To date")
    return start, end


def _validate_project_completion_override(value):
    if value in (None, ""):
        return 0
    try:
        number = float(value)
    except (TypeError, ValueError):
        raise HTTPException(400, "Completion override must be a number between 0 and 100")
    if not 0 <= number <= 100:
        raise HTTPException(400, "Completion override must be a number between 0 and 100")
    return int(number) if number.is_integer() else round(number, 1)


def _project_completion(project, testcases):
    """Return one explainable completion value for a project.

    Projects created before completion_mode existed default to automatic.
    A value is a manual override only when the record explicitly says so.
    Automatic completion only counts active test cases currently linked to
    this project.
    """
    project_id = project.get("id")
    active_tests = [
        testcase for testcase in testcases
        if testcase.get("project_id") == project_id and not testcase.get("archived")
    ]
    total = len(active_tests)
    completed = sum(
        testcase.get("status") in PROJECT_COMPLETED_TEST_STATUSES
        for testcase in active_tests
    )
    automatic_percent = round(completed / total * 100, 1) if total else None

    mode = project.get("completion_mode")
    if mode not in PROJECT_COMPLETION_MODES:
        mode = "automatic"
    if mode == "manual":
        percent = _validate_project_completion_override(
            project.get("completion_override", project.get("completion"))
        )
        source = "Manual override"
    else:
        percent = automatic_percent
        source = "Linked active test cases"

    return {
        "completion": percent,
        "completion_percent": percent,
        "completion_mode": mode,
        "completion_source": source,
        "completion_completed": completed,
        "completion_total": total,
        "completion_override": (
            _validate_project_completion_override(
                project.get("completion_override", project.get("completion"))
            )
            if mode == "manual" else None
        ),
        "completion_status": (
            "No active linked test cases"
            if not total and mode == "automatic"
            else f"{completed}/{total} active linked test cases completed"
            if mode == "automatic"
            else "Manual override"
        ),
        "completion_definition": (
            "Completed active linked test cases divided by all active linked test cases"
            if mode == "automatic"
            else "Explicit project completion override"
        ),
    }


def _enrich_project_completions(projects, testcases):
    return [{**project, **_project_completion(project, testcases)} for project in projects]


def _prepare_project_completion_input(incoming, existing=None):
    """Normalize project completion writes while preserving legacy clients."""
    existing = existing or {}
    merged = {**existing, **incoming}
    mode = merged.get("completion_mode")
    if mode not in PROJECT_COMPLETION_MODES:
        mode = "automatic"
    if mode == "manual":
        override = _validate_project_completion_override(
            incoming.get(
                "completion_override",
                existing.get("completion_override", merged.get("completion")),
            )
        )
        incoming["completion_mode"] = "manual"
        incoming["completion_override"] = override
        # Keep the original field synchronized for legacy consumers.
        incoming["completion"] = override
    else:
        incoming["completion_mode"] = "automatic"
        incoming["completion_override"] = None
        # A computed value sent back by an enriched UI must never become a
        # persisted manual value.
        incoming.pop("completion", None)
    return incoming


def _bassett_lineage_key(run):
    """Stable identity for a canonical run and its legacy execution mirror.

    Old imports stored the execution separately; newer records store the
    canonical run as a Bassett issue.  An execution carrying any of these
    links is therefore not another test -- it is the same execution lineage.
    """
    if run.get("_lineage_key"):
        return run["_lineage_key"]
    issue_id = run.get("issue_id") or run.get("bassett_issue_id") or run.get("source_issue_id")
    if issue_id:
        return f"issue:{issue_id}"
    return f"record:{run.get('id')}"


def _canonical_bassett_lineages(issues, executions, *, active_scenario_ids=None):
    """Return one authoritative record per Bassett execution lineage.

    Canonical issue records win over their legacy execution representation.
    Archived records and runs for archived/missing scenarios are deliberately
    not analytical evidence.  Keeping this in one helper prevents a dashboard
    card, CSV, and release conclusion from disagreeing about the denominator.
    """
    active_scenario_ids = set(active_scenario_ids) if active_scenario_ids is not None else None
    chosen = {}
    # Issues are canonical.  Process executions second, replacing only where
    # no canonical issue exists.  Preserve genuinely standalone legacy rows.
    for source, runs in (("issue", issues), ("execution", executions)):
        for run in runs:
            if run.get("archived"):
                continue
            scenario_id = run.get("scenario_id")
            if active_scenario_ids is not None and scenario_id not in active_scenario_ids:
                continue
            key = f"issue:{run.get('id')}" if source == "issue" else _bassett_lineage_key(run)
            current = chosen.get(key)
            if current is None or (source == "issue" and current.get("_lineage_source") != "issue"):
                chosen[key] = {**run, "_lineage_source": source, "_lineage_key": key}
    return list(chosen.values())


def _eligible_completed_bassett_runs(issues, executions, *, active_scenario_ids=None):
    """Canonical, completed Bassett evidence used by every analytical surface."""
    return [
        run for run in _canonical_bassett_lineages(
            issues, executions, active_scenario_ids=active_scenario_ids
        )
        if _canonical_bassett_result(run.get("result")) != "Not Evaluated"
    ]


def _project_last_tested_dates(
    projects, testcases, test_runs, bassett_runs, bassett_executions=None, evaluations=None
):
    """Derive project testing recency only from explicit, trustworthy Test Dates.

    Scope: active Test Cases currently linked to the project; their own test_date;
    completed standard Test Runs and evaluations linked to those Test Cases; and
    recorded canonical Bassett runs whose project link agrees with the Test Case's
    current project.
    Reusable Test Bank definitions, archived Test Cases, orphan/cross-project runs,
    failed/in-progress executions, and timestamp fallbacks are excluded.
    """
    project_ids = {project.get("id") for project in projects}
    active_tests = {
        testcase.get("id"): testcase
        for testcase in testcases
        if testcase.get("id") and testcase.get("project_id") in project_ids and not testcase.get("archived")
    }
    candidates = {project_id: [] for project_id in project_ids}

    def add(project_id, value):
        try:
            valid = _validate_test_date(value, required=False)
        except HTTPException:
            return
        if valid and project_id in candidates:
            candidates[project_id].append(valid)

    for testcase in active_tests.values():
        add(testcase.get("project_id"), testcase.get("test_date"))
    for run in test_runs:
        testcase = active_tests.get(run.get("testcase_id"))
        if testcase and run.get("status") in ("Completed", "Completed with Errors"):
            add(testcase.get("project_id"), run.get("test_date"))
    for evaluation in evaluations or []:
        testcase = active_tests.get(evaluation.get("testcase_id"))
        if testcase:
            add(testcase.get("project_id"), evaluation.get("test_date"))
    # Do not use a timestamp fallback.  Recency is a business Test Date and
    # canonical completed evidence only.
    for run in _eligible_completed_bassett_runs(bassett_runs, bassett_executions or []):
        testcase = active_tests.get(run.get("testcase_id"))
        project_id = testcase.get("project_id") if testcase else None
        if testcase and run.get("project_id") == project_id and run.get("result"):
            add(project_id, run.get("test_date"))
    return {project_id: max(values) if values else None for project_id, values in candidates.items()}


async def _current_project_last_tested_dates(projects=None):
    projects = projects if projects is not None else await crud_list("projects")
    active_scenario_ids = {
        scenario["id"] for scenario in await db.bassett_scenarios.find(
            {"archived": {"$ne": True}}, {"_id": 0, "id": 1}
        ).to_list(5000)
    }
    issues = await db.bassett_issues.find({"archived": {"$ne": True}}, {"_id": 0}).to_list(5000)
    executions = await db.bassett_executions.find({"archived": {"$ne": True}}, {"_id": 0}).to_list(5000)
    evaluations = await _exclude_incomplete_comparison_evaluations(
        await _authoritative_evaluation_read_model(await crud_list("evaluations"))
    )
    return _project_last_tested_dates(
        projects,
        await crud_list("testcases"),
        await crud_list("test_runs"),
        _canonical_bassett_lineages(issues, executions, active_scenario_ids=active_scenario_ids),
        evaluations=evaluations,
    )

def _validate_execution_timestamps(started_at=None, completed_at=None):
    if not started_at or not completed_at:
        return
    try:
        started = datetime.fromisoformat(str(started_at).replace("Z", "+00:00"))
        completed = datetime.fromisoformat(str(completed_at).replace("Z", "+00:00"))
    except ValueError:
        raise HTTPException(400, "Started At and Completed At must be valid ISO timestamps")
    if completed < started:
        raise HTTPException(400, "Completed At cannot be before Started At")

def _application_timezone_name(config=None):
    configured = (config or {}).get("application_timezone") or os.environ.get("APP_TIMEZONE") or "America/New_York"
    try:
        ZoneInfo(configured)
    except ZoneInfoNotFoundError:
        raise HTTPException(500, "The configured application timezone is invalid")
    return configured

def new_id():
    return str(uuid.uuid4())

def hash_password(pw: str) -> str:
    return bcrypt.hashpw(pw.encode(), bcrypt.gensalt()).decode()

def verify_password(pw: str, hashed: str) -> bool:
    try:
        return bcrypt.checkpw(pw.encode(), hashed.encode())
    except Exception:
        return False

def _digest(value: str) -> str:
    return hmac.new(SESSION_SECRET.encode(), value.encode(), hashlib.sha256).hexdigest()

def _cookie_kwargs():
    return {
        "httponly": True,
        "secure": COOKIE_SECURE,
        "samesite": "lax",
        "path": "/",
    }

async def _issue_session(user, response: Response):
    raw_session = secrets.token_urlsafe(32)
    raw_csrf = secrets.token_urlsafe(32)
    expires_at = (datetime.now(timezone.utc) + SESSION_TTL).isoformat()
    session_id = f"auth_session:{_digest(raw_session)}"
    await db.create_auth_session({
        "id": session_id,
        "user_id": user["id"],
        "csrf_hash": _digest(raw_csrf),
        "expires_at": expires_at,
    })
    response.set_cookie(SESSION_COOKIE, raw_session, max_age=int(SESSION_TTL.total_seconds()), **_cookie_kwargs())
    response.set_cookie(CSRF_COOKIE, raw_csrf, max_age=int(SESSION_TTL.total_seconds()),
                        httponly=False, secure=COOKIE_SECURE, samesite="lax", path="/")

async def _revoke_session(user, raw_session: str):
    await db.revoke_auth_session(f"auth_session:{_digest(raw_session)}")

async def _lookup_session(raw_session: str):
    if not raw_session or len(raw_session) > 256:
        raise HTTPException(401, "Not authenticated")
    session_id = f"auth_session:{_digest(raw_session)}"
    session = await db.get_auth_session(session_id)
    if not session:
        raise HTTPException(401, "Not authenticated")
    try:
        expired = datetime.fromisoformat(session["expires_at"]) <= datetime.now(timezone.utc)
    except (KeyError, TypeError, ValueError):
        expired = True
    if expired:
        await db.revoke_auth_session(session_id)
        raise HTTPException(401, "Session expired")
    user = await db.users.find_one({"id": session.get("user_id")}, {"_id": 0})
    if not user:
        await db.revoke_auth_session(session_id)
        raise HTTPException(401, "User not found")
    return user, session

async def get_user_from_session(raw_session: str):
    match, _session = await _lookup_session(raw_session)
    user = {k: v for k, v in match.items() if k not in {"_id", "password_hash", "password_history", "session_tokens"}}
    if not user:
        raise HTTPException(401, "User not found")
    if user.get("active") is False or user.get("deleted_at"):
        raise HTTPException(403, "This account is inactive")
    return user

async def get_current_user(request: Request):
    return await get_user_from_session(request.cookies.get(SESSION_COOKIE))

def _csrf_is_valid(session, supplied: str, cookie_value: str) -> bool:
    return bool(
        supplied
        and cookie_value
        and hmac.compare_digest(supplied, cookie_value)
        and hmac.compare_digest(session.get("csrf_hash", ""), _digest(supplied))
    )

def require_roles(*roles):
    async def checker(user=Depends(get_current_user)):
        if roles and user["role"] not in roles:
            raise HTTPException(403, "Insufficient permissions")
        return user
    return checker

# Writers = everyone except read-only viewers
async def require_writer(user=Depends(get_current_user)):
    if user["role"] == "viewer":
        raise HTTPException(403, "Viewers have read-only access")
    return user

# ---------- Auth models ----------
class RegisterIn(BaseModel):
    email: EmailStr
    password: str
    name: str
    role: str = "tester"

class LoginIn(BaseModel):
    email: EmailStr
    password: str

class BootstrapIn(BaseModel):
    email: EmailStr
    password: str = Field(min_length=12, max_length=128)
    name: str = Field(min_length=1, max_length=120)

class UserCreateIn(BaseModel):
    email: EmailStr
    name: str = Field(min_length=1, max_length=120)
    role: str
    active: bool = True
    send_welcome_email: bool = True

class UserEditIn(BaseModel):
    email: Optional[EmailStr] = None
    name: Optional[str] = Field(default=None, max_length=120)
    role: Optional[str] = None
    new_password: Optional[str] = None
    new_password_confirmation: Optional[str] = None
    expected_revision: Optional[int] = None
    expected_updated_at: Optional[str] = None

class PasswordChangeIn(BaseModel):
    current_password: str = Field(min_length=1, max_length=256)
    new_password: str = Field(min_length=12, max_length=128)
    new_password_confirmation: str = Field(min_length=1, max_length=128)

class PasswordResetRequestIn(BaseModel):
    email: EmailStr

class PasswordResetIn(BaseModel):
    token: str = Field(min_length=20, max_length=256)
    new_password: str = Field(min_length=12, max_length=128)
    new_password_confirmation: str = Field(min_length=1, max_length=128)

class ActivateUserIn(BaseModel):
    token: str = Field(min_length=20, max_length=256)
    password: str = Field(min_length=12, max_length=128)

# ---------- Auth endpoints ----------
@api.get("/health")
async def health():
    await db.config.count_documents({})
    return {"ok": True, "database": "postgresql"}

@api.post("/auth/register")
async def register(body: RegisterIn, response: Response, admin=Depends(require_roles("admin"))):
    email = body.email.lower()
    if body.role not in ("admin", "qa_manager", "tester", "developer", "viewer"):
        raise HTTPException(400, "Invalid role")
    if await db.users.find_one({"email": email}):
        raise HTTPException(400, "Email already registered")
    created_at = now_iso()
    user = {"id": new_id(), "email": email, "name": body.name, "role": body.role,
            "password_hash": hash_password(body.password), "created_at": created_at,
            "updated_at": created_at, "revision": 1, "active": True}
    await db.users.insert_one(user)
    return {"user": {k: user[k] for k in ("id", "email", "name", "role")}}

@api.post("/auth/login")
async def login(body: LoginIn, response: Response):
    email = body.email.lower()
    user = await db.users.find_one({"email": email})
    if not user or not verify_password(body.password, user.get("password_hash", "")):
        raise HTTPException(401, "Invalid email or password")
    if user.get("active") is False or user.get("deleted_at"):
        raise HTTPException(403, "This account is inactive")
    await _issue_session(user, response)
    return {"user": {k: user[k] for k in ("id", "email", "name", "role")}}

PASSWORD_RESET_MESSAGE = "If an account matches that email, a password reset link has been sent."
PASSWORD_RESET_ERROR = "This password reset link is invalid, expired, or already used."
_LOCAL_RATE_LIMITS: dict[str, tuple[float, int]] = {}

def _client_key(request: Request) -> str:
    return request.client.host if request.client else "unknown"

def _rate_limit_setting(name: str, default: int, maximum: int = 100) -> int:
    try:
        value = int(os.environ.get(name, str(default)))
    except ValueError:
        value = default
    return max(1, min(value, maximum))

async def _consume_rate_limit(key: str, *, limit: int, window_seconds: int) -> dict[str, Any]:
    identifier = f"auth_rate:{_digest(key)}"
    consume = getattr(db, "consume_auth_rate_limit", None)
    if callable(consume):
        return await consume(identifier, now_iso(), limit, window_seconds)
    now = time.monotonic()
    started, attempts = _LOCAL_RATE_LIMITS.get(identifier, (now, 0))
    if now - started >= window_seconds:
        started, attempts = now, 0
    if attempts >= limit:
        return {"allowed": False, "retry_after": max(1, window_seconds - int(now - started))}
    _LOCAL_RATE_LIMITS[identifier] = (started, attempts + 1)
    return {"allowed": True, "remaining": limit - attempts - 1}

def _rate_limit_or_raise(result: dict[str, Any], message: str = "Too many attempts. Try again later."):
    if not result.get("allowed", False):
        raise HTTPException(429, message, headers={"Retry-After": str(result.get("retry_after", 60))})

def _password_reused(password: str, user: dict[str, Any]) -> bool:
    hashes = [user.get("password_hash", ""), *user.get("password_history", [])]
    return any(candidate and verify_password(password, candidate) for candidate in hashes)

def _public_user(user: dict[str, Any]) -> dict[str, Any]:
    return {
        key: value for key, value in user.items()
        if key not in {"_id", "password_hash", "password_history", "session_tokens"}
    }

def _password_reset_link(raw_token: str) -> str:
    app_url = _configured_app_url()
    if not app_url:
        raise EmailDeliveryError("ZoneQA published URL is not configured")
    return f"{app_url}/reset-password?token={raw_token}"

async def _get_password_reset(identifier: str):
    getter = getattr(db, "get_password_reset", None)
    if callable(getter):
        return await getter(identifier)
    return await db.config.find_one({"id": identifier})

async def _record_password_reset_status(user_id: str, status: str, attempted_at: str,
                                        error_message: str | None = None,
                                        sent_at: str | None = None):
    values = {
        "password_reset_status": status,
        "password_reset_last_attempted_at": attempted_at,
        "password_reset_last_error": error_message,
        "updated_at": attempted_at,
    }
    if sent_at:
        values["password_reset_sent_at"] = sent_at
    await db.users.update_one({"id": user_id}, {"$set": values})

async def _send_password_reset_email(user: dict[str, Any], raw_token: str) -> dict[str, Any]:
    attempted_at = now_iso()
    try:
        sent = await email_sender.send_password_reset(
            recipient=user["email"],
            recipient_name=user["name"],
            reset_link=_password_reset_link(raw_token),
        )
        if not sent.get("sent", True):
            raise EmailDeliveryError("Password reset email could not be sent")
    except (EmailDeliveryError, httpx.HTTPError) as error:
        message = (
            "Password reset email was not sent because the published app URL is not configured."
            if str(error) == "ZoneQA published URL is not configured"
            else "Password reset email could not be sent. The password was not changed."
        )
        await _record_password_reset_status(user["id"], "failed", attempted_at, message)
        return {"requested": True, "sent": False, "status": "failed", "message": message}
    sent_at = now_iso()
    await _record_password_reset_status(user["id"], "sent", attempted_at, None, sent_at)
    return {"requested": True, "sent": bool(sent.get("sent", True)), "status": "sent"}

def _reset_token_document(raw_token: str, user_id: str, actor_id: str | None, now: str) -> dict[str, Any]:
    return {
        "id": f"password_reset:{_digest(raw_token)}",
        "purpose": "password_reset",
        "user_id": user_id,
        "expires_at": (datetime.fromisoformat(now) + timedelta(hours=1)).isoformat(),
        "used_at": None,
        "revoked_at": None,
        "created_at": now,
        "created_by_id": actor_id,
    }

async def _rotate_password_reset(user_id: str, actor_id: str | None, now: str):
    raw_token = secrets.token_urlsafe(32)
    rotate = getattr(db, "rotate_password_reset", None)
    if not callable(rotate):
        raise HTTPException(503, "Password reset is unavailable")
    result = await rotate(
        user_id,
        _reset_token_document(raw_token, user_id, actor_id, now),
        now,
        _rate_limit_setting("PASSWORD_RESET_COOLDOWN_SECONDS", 60, 3600),
    )
    return result, raw_token

@api.post("/auth/password/change")
async def change_password(
    body: PasswordChangeIn,
    request: Request,
    response: Response,
    user=Depends(get_current_user),
):
    _rate_limit_or_raise(await _consume_rate_limit(
        f"change:{user['id']}:{_client_key(request)}",
        limit=_rate_limit_setting("PASSWORD_CHANGE_ATTEMPTS", 5),
        window_seconds=_rate_limit_setting("PASSWORD_CHANGE_WINDOW_SECONDS", 900, 86400),
    ))
    if body.new_password != body.new_password_confirmation:
        raise HTTPException(400, "New passwords do not match")
    current = await db.users.find_one({"id": user["id"]})
    if not current or not verify_password(body.current_password, current.get("password_hash", "")):
        raise HTTPException(400, "Unable to change password. Check your current password and try again.")
    if _password_reused(body.new_password, current):
        raise HTTPException(400, "Choose a password you have not used recently.")
    timestamp = now_iso()
    activity = {
        "id": new_id(), "entity_type": "users", "entity_id": user["id"],
        "action": "password changed", "user": user.get("name", "user"),
        "detail": "Self-service password change; all prior sessions revoked",
        "created_at": timestamp, "_log": True,
    }
    change = getattr(db, "change_password_with_current", None)
    if not callable(change):
        raise HTTPException(503, "Password change is unavailable")
    result = await change(
        user["id"],
        current.get("password_hash", ""),
        hash_password(body.new_password),
        [current.get("password_hash", ""), *current.get("password_history", [])],
        timestamp,
        activity,
    )
    if result.get("error") in {"stale_password", "not_found", "inactive"}:
        raise HTTPException(400, "Unable to change password. Check your current password and try again.")
    await _issue_session(result["user"], response)
    return {"ok": True, "user": result["user"], "sessions_revoked": result["sessions_revoked"]}

@api.post("/auth/forgot-password")
async def forgot_password(body: PasswordResetRequestIn, request: Request):
    _rate_limit_or_raise(await _consume_rate_limit(
        f"forgot-ip:{_client_key(request)}",
        limit=_rate_limit_setting("FORGOT_PASSWORD_ATTEMPTS", 5),
        window_seconds=_rate_limit_setting("FORGOT_PASSWORD_WINDOW_SECONDS", 900, 86400),
    ), "Too many password reset requests. Try again later.")
    email = str(body.email).strip().lower()
    target = await db.users.find_one({"email": email, "deleted_at": {"$exists": False}})
    if target and target.get("active") is not False:
        _rate_limit_or_raise(await _consume_rate_limit(
            f"forgot-account:{_digest(email)}",
            limit=_rate_limit_setting("FORGOT_PASSWORD_ACCOUNT_ATTEMPTS", 3),
            window_seconds=_rate_limit_setting("FORGOT_PASSWORD_WINDOW_SECONDS", 900, 86400),
        ), "Too many password reset requests. Try again later.")
        result, raw_token = await _rotate_password_reset(target["id"], None, now_iso())
        if result.get("error") == "cooldown":
            # Account-level cooldowns are intentionally indistinguishable from
            # unknown-email requests to prevent account enumeration.
            return {"ok": True, "message": PASSWORD_RESET_MESSAGE}
        if result.get("user"):
            email_result = await _send_password_reset_email(result["user"], raw_token)
            await log_activity("users", target["id"],
                               "password reset requested" if email_result["sent"] else "password reset delivery failed",
                               {"name": "system"},
                               json.dumps({"source": "self-service", "email_sent": email_result["sent"]}))
    return {"ok": True, "message": PASSWORD_RESET_MESSAGE}

@api.post("/auth/reset-password")
async def reset_password(body: PasswordResetIn, request: Request):
    _rate_limit_or_raise(await _consume_rate_limit(
        f"reset:{_client_key(request)}",
        limit=_rate_limit_setting("PASSWORD_RESET_ATTEMPTS", 10),
        window_seconds=_rate_limit_setting("PASSWORD_RESET_WINDOW_SECONDS", 900, 86400),
    ))
    if body.new_password != body.new_password_confirmation:
        raise HTTPException(400, "New passwords do not match")
    reset_id = f"password_reset:{_digest(body.token)}"
    token = await _get_password_reset(reset_id)
    if not token or not token.get("user_id") or token.get("used_at") or token.get("revoked_at"):
        raise HTTPException(400, PASSWORD_RESET_ERROR)
    try:
        token_expired = datetime.fromisoformat(token["expires_at"]) <= datetime.now(timezone.utc)
    except (KeyError, TypeError, ValueError):
        token_expired = True
    if token_expired:
        raise HTTPException(400, PASSWORD_RESET_ERROR)
    target = await db.users.find_one({"id": token["user_id"]})
    if not target or _password_reused(body.new_password, target):
        raise HTTPException(400, PASSWORD_RESET_ERROR if not target else "Choose a password you have not used recently.")
    timestamp = now_iso()
    consume = getattr(db, "consume_password_reset_with_password", None)
    if not callable(consume):
        raise HTTPException(503, "Password reset is unavailable")
    result = await consume(
        reset_id, timestamp, hash_password(body.new_password),
        [target.get("password_hash", ""), *target.get("password_history", [])],
        target.get("password_hash"),
        {
            "id": new_id(), "entity_type": "users", "entity_id": target["id"],
            "action": "password reset completed", "user": "system",
            "detail": "Password reset link consumed; all prior sessions revoked",
            "created_at": timestamp, "_log": True,
        },
    )
    if result.get("error"):
        raise HTTPException(400, PASSWORD_RESET_ERROR)
    return {"ok": True, "message": "Your password was reset. You can now sign in."}

@api.post("/auth/activate")
async def activate_user(body: ActivateUserIn, response: Response):
    now = now_iso()
    user = await db.activate_user_with_password(
        f"user_setup:{_digest(body.token)}",
        now,
        hash_password(body.password),
    )
    if not user:
        raise HTTPException(400, "This activation link is invalid, expired, or already used")
    await log_activity(
        "users",
        user["id"],
        "password setup completed",
        user,
        json.dumps({"activated_at": now}),
    )
    activated = user.get("active") is not False
    if activated:
        await _issue_session(user, response)
    return {
        "ok": True,
        "activated": activated,
        "user": {k: user[k] for k in ("id", "email", "name", "role")},
    }

@api.post("/auth/bootstrap")
async def bootstrap_admin(body: BootstrapIn, request: Request, response: Response):
    if not BOOTSTRAP_ADMIN_TOKEN:
        raise HTTPException(503, "Administrator bootstrap is not configured")
    supplied = request.headers.get("X-Bootstrap-Token", "")
    if not hmac.compare_digest(supplied, BOOTSTRAP_ADMIN_TOKEN):
        raise HTTPException(401, "Invalid bootstrap token")
    email = body.email.lower()
    user = {
        "id": new_id(), "email": email, "name": body.name.strip(), "role": "admin",
        "password_hash": hash_password(body.password), "created_at": now_iso(),
        "active": True, "auth_provider": "password",
    }
    try:
        created = await db.bootstrap_admin(user)
    except ForeignKeyViolationError:
        created = False
    if not created:
        raise HTTPException(409, "Administrator bootstrap has already been completed")
    await _issue_session(user, response)
    logger.info("One-time administrator bootstrap completed")
    return {"user": {k: user[k] for k in ("id", "email", "name", "role")}}

@api.post("/auth/logout")
async def logout(request: Request, response: Response, user=Depends(get_current_user)):
    stored_user, _session = await _lookup_session(request.cookies.get(SESSION_COOKIE, ""))
    await _revoke_session(stored_user, request.cookies.get(SESSION_COOKIE, ""))
    response.delete_cookie(SESSION_COOKIE, path="/", secure=COOKIE_SECURE, samesite="lax")
    response.delete_cookie(CSRF_COOKIE, path="/", secure=COOKIE_SECURE, samesite="lax")
    return {"ok": True}

@api.get("/auth/me")
async def me(user=Depends(get_current_user)):
    return user

USER_ROLES = ("admin", "qa_manager", "tester", "developer", "viewer")
USER_ROLE_LABELS = {
    "admin": "Administrator", "qa_manager": "QA Manager", "tester": "Tester",
    "developer": "Developer", "viewer": "Viewer",
}
USER_REFERENCE_FIELDS = {
    "projects": ("owner_id",),
    "testcases": ("assignee_id", "assigned_to_id", "created_by_id"),
    "findings": ("assignee_id", "assigned_to_id", "created_by_id"),
    "retests": ("reviewer_id", "assigned_to_id", "created_by_id"),
    "regression_runs": ("started_by_id", "reviewer_id", "created_by_id"),
    "comments": ("author_id",),
    "attachments": ("uploaded_by_id",),
    "calendar_events": ("owner_id", "created_by_id"),
}


def _configured_app_url() -> str | None:
    configured = os.environ.get("ZONEQA_APP_URL", "").strip().rstrip("/")
    if not configured:
        return None
    parsed = urlsplit(configured)
    if parsed.scheme not in {"http", "https"} or not parsed.netloc:
        return None
    if parsed.query or parsed.fragment or parsed.username or parsed.password:
        return None
    return configured


def _activation_link(raw_setup: str) -> str:
    app_url = _configured_app_url()
    if not app_url:
        raise EmailDeliveryError("ZoneQA published URL is not configured")
    return f"{app_url}/activate?token={raw_setup}"


def _email_failure_message(error: Exception) -> str:
    if str(error) == "ZoneQA published URL is not configured":
        return "Welcome email was not sent because the published app URL is not configured."
    return "Welcome email could not be sent. The user was still created."


async def _record_welcome_email_status(
    user_id: str,
    *,
    status: str,
    attempted_at: str,
    error_message: str | None = None,
    sent_at: str | None = None,
) -> None:
    values = {
        "welcome_email_status": status,
        "welcome_email_last_attempted_at": attempted_at,
        "welcome_email_last_error": error_message,
        "updated_at": attempted_at,
    }
    if sent_at:
        values["welcome_email_sent_at"] = sent_at
    await db.users.update_one(
        {"id": user_id},
        {"$set": values},
    )


async def _send_welcome_email(user: dict[str, Any], raw_setup: str) -> dict[str, Any]:
    attempted_at = now_iso()
    try:
        sent = await email_sender.send(
            recipient=user["email"],
            recipient_name=user["name"],
            role_label=USER_ROLE_LABELS[user["role"]],
            activation_link=_activation_link(raw_setup),
        )
    except (EmailDeliveryError, httpx.HTTPError) as error:
        message = _email_failure_message(error)
        await _record_welcome_email_status(
            user["id"],
            status="failed",
            attempted_at=attempted_at,
            error_message=message,
        )
        return {"requested": True, "sent": False, "status": "failed", "message": message}
    sent_at = now_iso()
    await _record_welcome_email_status(
        user["id"],
        status="sent",
        attempted_at=attempted_at,
        error_message=None,
        sent_at=sent_at,
    )
    return {"requested": True, "sent": bool(sent.get("sent", True)), "status": "sent"}

async def _active_admin_count(exclude_id=None):
    query = {"role": "admin", "active": {"$ne": False}, "deleted_at": {"$exists": False}}
    if exclude_id:
        query["id"] = {"$ne": exclude_id}
    return await db.users.count_documents(query)

async def _revoke_all_user_sessions(user_id: str) -> int:
    revoke_all = getattr(db, "revoke_auth_sessions_for_user", None)
    if revoke_all is None:
        return 0
    return await revoke_all(user_id)

async def _user_impact(user_id):
    references = {}
    for collection, fields in USER_REFERENCE_FIELDS.items():
        per_collection = {}
        for field in fields:
            count = await db[collection].count_documents({field: user_id})
            if count:
                per_collection[field] = count
        if per_collection:
            references[collection] = per_collection
    return {
        "references": references,
        "total_references": sum(sum(fields.values()) for fields in references.values()),
    }

@api.get("/users")
async def list_users(include_deleted: bool = False, user=Depends(get_current_user)):
    is_admin = user.get("role") == "admin"
    query = {} if include_deleted and is_admin else {
        "deleted_at": {"$exists": False},
        **({} if is_admin else {"active": {"$ne": False}}),
    }
    records = await db.users.find(query, {"_id": 0}).to_list(1000)
    if not is_admin:
        return [{"id": record.get("id"), "name": record.get("name")} for record in records]
    return [
        {
            **{key: value for key, value in record.items()
               if key not in {"password_hash", "password_history"}},
            "password_login_ready": bool(record.get("password_hash")),
        }
        for record in records
    ]

@api.post("/users")
async def create_user(
    body: UserCreateIn,
    admin=Depends(require_roles("admin")),
):
    name = body.name.strip()
    email = str(body.email).strip().lower()
    if not name:
        raise HTTPException(400, "Name is required")
    if body.role not in USER_ROLES:
        raise HTTPException(400, "Invalid role")
    if await db.users.find_one({"email": email, "deleted_at": {"$exists": False}}):
        raise HTTPException(409, "Another user already uses this email")

    raw_setup = secrets.token_urlsafe(32)
    expires_at = (datetime.now(timezone.utc) + timedelta(hours=24)).isoformat()
    user = {
        "id": new_id(),
        "email": email,
        "name": name,
        "role": body.role,
        "active": body.active,
        "auth_provider": "password_setup",
        "welcome_email_status": (
            "pending" if body.send_welcome_email and body.active
            else "blocked" if body.send_welcome_email
            else "not_requested"
        ),
        "welcome_email_requested": body.send_welcome_email,
        "welcome_email_last_attempted_at": None,
        "welcome_email_sent_at": None,
        "welcome_email_last_error": None,
        "activation_expires_at": expires_at,
        "created_at": now_iso(),
        "created_by": admin["name"],
        "created_by_id": admin["id"],
        "revision": 1,
    }
    user["updated_at"] = user["created_at"]
    setup = {
        "id": f"user_setup:{_digest(raw_setup)}",
        "purpose": "user_activation",
        "user_id": user["id"],
        "expires_at": expires_at,
        "used_at": None,
        "revoked_at": None,
        "created_at": user["created_at"],
        "created_by_id": admin["id"],
    }
    try:
        await db.create_user_with_setup(user, setup)
    except UniqueViolationError:
        raise HTTPException(409, "Another user already uses this email")
    await log_activity(
        "users",
        user["id"],
        "created",
        admin,
        json.dumps({"created_by_id": admin["id"], "created_at": user["created_at"],
                    "role": USER_ROLE_LABELS[body.role]}),
    )
    welcome_email = {
        "requested": body.send_welcome_email,
        "sent": False,
        "status": "not_requested",
    }
    if body.send_welcome_email and body.active:
        welcome_email = await _send_welcome_email(user, raw_setup)
        await log_activity(
            "users",
            user["id"],
            "welcome email sent" if welcome_email["sent"] else "welcome email failed",
            admin,
            json.dumps({
                "requested": True,
                "status": welcome_email["status"],
                "recipient": email,
            }),
        )
    elif body.send_welcome_email:
        welcome_email = {
            "requested": True,
            "sent": False,
            "status": "blocked",
            "message": "Welcome email cannot be sent to a deactivated user.",
        }
        await log_activity(
            "users",
            user["id"],
            "welcome email blocked",
            admin,
            json.dumps({"requested": True, "reason": "inactive at creation"}),
        )
    else:
        await log_activity(
            "users",
            user["id"],
            "welcome email skipped",
            admin,
            json.dumps({"requested": False}),
        )
    return {
        "user": user,
        "activation_path": f"/activate?token={raw_setup}",
        "activation_expires_at": expires_at,
        "welcome_email": welcome_email,
    }


@api.get("/admin/email/status")
async def email_status(admin=Depends(require_roles("admin"))):
    status = await email_sender.status()
    mode = os.environ.get("EMAIL_SENDER_MODE", "").strip().lower()
    return {
        "provider": status.get("provider", "Gmail"),
        "status": status.get("status", "disconnected"),
        "mode": mode or ("mock" if APP_ENV in {"development", "test"} else "gmail"),
        "published_url_configured": bool(_configured_app_url()),
    }

class AdminPasswordResetIn(BaseModel):
    confirm: bool = False

@api.post("/users/{id}/password-reset")
async def request_password_reset(
    id: str,
    body: AdminPasswordResetIn,
    request: Request,
    admin=Depends(require_roles("admin")),
):
    if not body.confirm:
        raise HTTPException(400, "Confirm sending a password reset link")
    target = await db.users.find_one({"id": id})
    if not target or target.get("deleted_at"):
        raise HTTPException(404, "User not found")
    if target.get("active") is False:
        raise HTTPException(409, "Password reset links cannot be sent to a deactivated user")
    _rate_limit_or_raise(await _consume_rate_limit(
        f"admin-reset:{admin['id']}:{id}:{_client_key(request)}",
        limit=_rate_limit_setting("ADMIN_PASSWORD_RESET_ATTEMPTS", 5),
        window_seconds=_rate_limit_setting("ADMIN_PASSWORD_RESET_WINDOW_SECONDS", 900, 86400),
    ), "Too many reset requests. Try again later.")
    timestamp = now_iso()
    result, raw_token = await _rotate_password_reset(id, admin["id"], timestamp)
    if result.get("error") == "not_found":
        raise HTTPException(404, "User not found")
    if result.get("error") == "inactive":
        raise HTTPException(409, "Password reset links cannot be sent to a deactivated user")
    if result.get("error") == "cooldown":
        raise HTTPException(
            429,
            "Password reset is on cooldown. Try again later.",
            headers={"Retry-After": str(result.get("remaining", 60))},
        )
    email_result = await _send_password_reset_email(result.get("user", target), raw_token)
    await log_activity(
        "users",
        id,
        "password reset link sent" if email_result["sent"] else "password reset delivery failed",
        admin,
        json.dumps({
            "source": "administrator",
            "recipient": target["email"],
            "email_sent": email_result["sent"],
        }),
    )
    return {
        "ok": True,
        "reset_path": f"/reset-password?token={raw_token}",
        "expires_in_seconds": 3600,
        "email": email_result,
    }


def _welcome_email_cooldown_seconds() -> int:
    raw = os.environ.get("WELCOME_EMAIL_COOLDOWN_SECONDS", "60")
    try:
        value = int(raw)
    except ValueError:
        return 60
    return max(1, min(value, 3600))


@api.post("/users/{id}/welcome-email")
async def resend_welcome_email(id: str, admin=Depends(require_roles("admin"))):
    target = await db.users.find_one({"id": id})
    if not target or target.get("deleted_at"):
        raise HTTPException(404, "User not found")
    if target.get("active") is False:
        raise HTTPException(409, "Welcome email cannot be sent to a deactivated user")
    if target.get("password_hash") or target.get("activated_at"):
        raise HTTPException(
            409,
            "This user has already activated their account. Direct them to password reset instead.",
        )
    if not _configured_app_url():
        raise HTTPException(
            503,
            "Welcome email is unavailable because the published app URL is not configured.",
        )

    now = datetime.now(timezone.utc)
    last_attempted = target.get("welcome_email_last_attempted_at")
    if last_attempted:
        try:
            elapsed = (now - datetime.fromisoformat(last_attempted)).total_seconds()
        except (TypeError, ValueError):
            elapsed = _welcome_email_cooldown_seconds()
        remaining = _welcome_email_cooldown_seconds() - int(elapsed)
        if remaining > 0:
            raise HTTPException(
                429,
                f"Welcome email resend is on cooldown. Try again in {remaining} seconds.",
            )

    raw_setup = secrets.token_urlsafe(32)
    timestamp = now.isoformat()
    expires_at = (now + timedelta(hours=24)).isoformat()
    setup = {
        "id": f"user_setup:{_digest(raw_setup)}",
        "purpose": "user_activation",
        "user_id": id,
        "expires_at": expires_at,
        "used_at": None,
        "revoked_at": None,
        "created_at": timestamp,
        "created_by_id": admin["id"],
    }
    rotate_setup = getattr(db, "rotate_user_setup", None)
    if rotate_setup is None:
        raise HTTPException(503, "Welcome email resend is unavailable")
    rotated = await rotate_setup(
        id, setup, timestamp, _welcome_email_cooldown_seconds()
    )
    if rotated.get("error") == "not_found":
        raise HTTPException(404, "User not found")
    if rotated.get("error") == "inactive":
        raise HTTPException(409, "Welcome email cannot be sent to a deactivated user")
    if rotated.get("error") == "activated":
        raise HTTPException(
            409,
            "This user has already activated their account. Direct them to password reset instead.",
        )
    if rotated.get("error") == "cooldown":
        raise HTTPException(
            429,
            f"Welcome email resend is on cooldown. Try again in {rotated.get('remaining', _welcome_email_cooldown_seconds())} seconds.",
        )

    await _record_welcome_email_status(
        id,
        status="pending",
        attempted_at=timestamp,
        error_message=None,
    )
    updated_user = {**target, "activation_expires_at": expires_at}
    welcome_email = await _send_welcome_email(updated_user, raw_setup)
    await log_activity(
        "users",
        id,
        "welcome email resent" if welcome_email["sent"] else "welcome email resend failed",
        admin,
        json.dumps({
            "requested": True,
            "status": welcome_email["status"],
            "recipient": target["email"],
        }),
    )
    return {"ok": True, "welcome_email": welcome_email, "activation_expires_at": expires_at}

@api.get("/users/{id}/impact")
async def user_impact(id: str, admin=Depends(require_roles("admin"))):
    target = await db.users.find_one({"id": id}, {"_id": 0, "password_hash": 0, "password_history": 0})
    if not target:
        raise HTTPException(404, "User not found")
    return {**await _user_impact(id), "user": target}

async def _legacy_update_user_profile(id: str, body: UserEditIn, admin):
    """Compatibility path for non-Postgres test adapters; production uses the atomic store method."""
    fields_set = getattr(body, "model_fields_set", None)
    if fields_set is None:
        fields_set = getattr(body, "__fields_set__", set())
    if fields_set.intersection({"new_password", "new_password_confirmation"}):
        raise HTTPException(
            400,
            "Administrators cannot set passwords directly. Send a password reset link instead.",
        )
    raw_body = body.model_dump(exclude_none=True) if hasattr(body, "model_dump") else body.dict(exclude_none=True)
    target = await db.users.find_one({"id": id})
    if not target or target.get("deleted_at"):
        raise HTTPException(404, "User not found")
    _require_fresh_version(target, raw_body)
    allowed = {}
    if body.name is not None:
        name = body.name.strip()
        if not name:
            raise HTTPException(400, "Name is required")
        allowed["name"] = name
    if body.email is not None:
        email = str(body.email).strip().lower()
        duplicate = await db.users.find_one({"email": email, "id": {"$ne": id}, "deleted_at": {"$exists": False}})
        if duplicate:
            raise HTTPException(409, "Another active user already uses this email")
        allowed["email"] = email
    if body.role is not None:
        if body.role not in USER_ROLES:
            raise HTTPException(400, "Invalid role")
        allowed["role"] = body.role
    if not allowed:
        raise HTTPException(400, "No editable fields supplied")
    current_revision = int(target.get("revision", 1))
    allowed["updated_at"] = now_iso()
    allowed["revision"] = current_revision + 1
    result = await db.users.find_one_and_update(
        {"id": id, "$or": [{"revision": current_revision}, {"revision": {"$exists": False}}]},
        {"$set": allowed}, projection={"_id": 0, "password_hash": 0, "password_history": 0}, return_document=True,
    )
    if not result:
        current = await db.users.find_one({"id": id}, {"_id": 0, "password_hash": 0})
        raise HTTPException(409, detail={
            "code": "stale_update",
            "message": "Someone else saved this user first. Reload the latest values and review your edits.",
            "current_revision": current.get("revision", 1) if current else current_revision,
            "current_updated_at": current.get("updated_at") if current else None,
        })
    detail = ", ".join(sorted(allowed.keys()))
    await log_activity("users", id, "profile updated", admin, detail)
    return result

@api.put("/users/{id}")
async def update_user(id: str, body: UserEditIn, admin=Depends(require_roles("admin"))):
    if isinstance(body, dict):
        if any(field in body for field in ("new_password", "new_password_confirmation", "password", "password_confirmation")):
            raise HTTPException(
                400,
                "Administrators cannot set passwords directly. Send a password reset link instead.",
            )
        body = UserEditIn(**body)
    fields_set = getattr(body, "model_fields_set", None)
    if fields_set is None:
        fields_set = getattr(body, "__fields_set__", set())
    if fields_set.intersection({"new_password", "new_password_confirmation"}):
        raise HTTPException(
            400,
            "Administrators cannot set passwords directly. Send a password reset link instead.",
        )
    atomic_update = getattr(db, "update_user_profile", None)
    if not callable(atomic_update):
        return await _legacy_update_user_profile(id, body, admin)
    changes = {}
    if body.name is not None:
        name = body.name.strip()
        if not name:
            raise HTTPException(400, "Name is required")
        changes["name"] = name
    if body.email is not None:
        email = str(body.email).strip().lower()
        if not email:
            raise HTTPException(400, "Email is required")
        changes["email"] = email
    if body.role is not None:
        role = body.role
        if role not in USER_ROLES:
            raise HTTPException(400, "Invalid role")
        changes["role"] = role

    if not changes:
        raise HTTPException(400, "No editable fields supplied")

    detail_parts = sorted(changes.keys())
    detail = ", ".join(detail_parts)
    if "role" in changes:
        detail = f"{detail}: {USER_ROLE_LABELS[changes['role']]}"
    activity = {
        "id": new_id(),
        "entity_type": "users",
        "entity_id": id,
        "action": "profile updated",
        "user": admin.get("name", "system"),
        "detail": detail,
        "created_at": now_iso(),
        "_log": True,
    }
    try:
        result = await atomic_update(
            id,
            changes,
            expected_revision=body.expected_revision,
            expected_updated_at=body.expected_updated_at,
            timestamp=activity["created_at"],
            activity=activity,
        )
    except UniqueViolationError:
        raise HTTPException(409, "Another active user already uses this email")
    if result.get("error") == "not_found":
        raise HTTPException(404, "User not found")
    if result.get("error") == "duplicate_email":
        raise HTTPException(409, "Another active user already uses this email")
    if result.get("error") == "last_active_admin":
        raise HTTPException(409, "The last active administrator cannot be demoted")
    if result.get("error") == "stale_update":
        raise HTTPException(409, detail={
            "code": "stale_update",
            "message": "Someone else saved this user first. Reload the latest values and review your edits.",
            "current_revision": result.get("current_revision"),
            "current_updated_at": result.get("current_updated_at"),
        })
    return result

@api.put("/users/{id}/role")
async def update_user_role(id: str, body: Dict[str, Any], admin=Depends(require_roles("admin"))):
    return await update_user(id, UserEditIn(
        role=body.get("role"),
        expected_revision=body.get("expected_revision"),
        expected_updated_at=body.get("expected_updated_at"),
    ), admin)

@api.put("/users/{id}/password")
async def set_user_password(id: str, body: Dict[str, Any], admin=Depends(require_roles("admin"))):
    raise HTTPException(
        410,
        "Administrators cannot set passwords directly. Send a password reset link instead.",
    )

@api.post("/users/{id}/deactivate")
async def deactivate_user(id: str, admin=Depends(require_roles("admin"))):
    if id == admin["id"]:
        raise HTTPException(409, "You cannot deactivate your own current account. Ask another active administrator to do this.")
    target = await db.users.find_one({"id": id})
    if not target or target.get("deleted_at"):
        raise HTTPException(404, "User not found")
    stamp = now_iso()
    deactivate_atomically = getattr(db, "deactivate_user_and_revoke_sessions", None)
    if deactivate_atomically is not None:
        outcome = await deactivate_atomically(id, admin["id"], stamp)
        if outcome.get("error") == "not_found":
            raise HTTPException(404, "User not found")
        if outcome.get("error") == "last_active_admin":
            raise HTTPException(409, "The last active administrator cannot be deactivated")
        sessions_revoked = outcome["sessions_revoked"]
    else:
        if target.get("role") == "admin" and await _active_admin_count(id) == 0:
            raise HTTPException(409, "The last active administrator cannot be deactivated")
        if target.get("active") is False:
            return {"ok": True, "active": False, "sessions_revoked": 0}
        await db.users.update_one({"id": id}, {"$set": {"active": False, "deactivated_at": stamp,
                                                         "deactivated_by": admin["id"], "updated_at": stamp}})
        sessions_revoked = await _revoke_all_user_sessions(id)
    await log_activity("users", id, "deactivated", admin, json.dumps({
        "active": False, "sessions_revoked": sessions_revoked,
        "history_preserved": True,
    }))
    return {"ok": True, "active": False, "sessions_revoked": sessions_revoked}

@api.post("/users/{id}/reactivate")
async def reactivate_user(id: str, admin=Depends(require_roles("admin"))):
    target = await db.users.find_one({"id": id, "deleted_at": {"$exists": False}})
    if not target:
        raise HTTPException(404, "User not found")
    await db.users.update_one({"id": id}, {"$set": {"active": True, "updated_at": now_iso()},
                                               "$unset": {"deactivated_at": "", "deactivated_by": ""}})
    await log_activity("users", id, "reactivated", admin, json.dumps({"active": True}))
    return {"ok": True, "active": True}

@api.delete("/users/{id}")
async def delete_user(id: str, confirm: bool = False, admin=Depends(require_roles("admin"))):
    if if id == admin["id"]:        raise HTTPException(409, "You cannot delete your own current account. Ask another active administrator to do this.")ame", "") if active else ""
    current_view = await _evaluation_read_model(
        raw_evaluations, valid_testcase_ids=valid_ids, version=version or None,
    )
    current_bassett = current_view["bassett"]
    all_models = all_view["all_models"]
    open_findings = [f for f in findings if _finding_is_open(f)]
    latest_regression = _latest_regression_run(runs, version)

    definitions = {
        "bassett-pass-rate": ("Bassett pass-rate denominator", [e for e in current_bassett if e.get("final_result") in EVALUATED_RESULTS],
                              f"Latest pass/fail Bassett evaluation per active Test Case for {version or 'the active version'}."),
        "bassett-failed": ("Bassett failed", [e for e in current_bassett if e.get("final_result") in FAIL_SET],
                            f"Latest Bassett evaluation per active Test Case for {version or 'the active version'} with a failing result."),
        "bassett-score": ("Bassett score records", [e for e in current_bassett if e.get("overall_score") is not None],
                           f"Scored latest Bassett evaluations for {version or 'the active version'} used by the average."),
        "all-model-evaluations": ("All model evaluations", [e for e in all_models if e.get("final_result") in EVALUATED_RESULTS],
                                   "Latest pass/fail evaluation per active Test Case and model."),
        "open-findings": ("Open findings", open_findings, "Findings not in a closed terminal status."),
        "awaiting-fix": ("Awaiting fix", [f for f in open_findings if f.get("developer_status") in FINDING_AWAITING_FIX_STATUSES],
                          "Open Findings in In Development or the legacy Fix In Progress status."),
        "ready-for-retest": ("Ready for retest", [f for f in open_findings if f.get("developer_status") == "Ready for Retest"],
                              "Open Findings whose developer status is Ready for Retest."),
        "regression-current": ("Latest regression run", [latest_regression] if latest_regression else [],
                                f"Most recently executed regression run for {version or 'the active version'}."),
        "test-cases": ("Active Test Cases", tcs, "All active, non-archived Test Case definitions."),
        "active-projects": ("Active Testing Projects", [p for p in projects if p.get("status") == "Active"],
                            "Testing Projects whose status is Active."),
        "retests": ("Retest executions", retests,
                    "Active Test Case-linked, non-archived retest executions."),
        "demo-approved": ("Approved demos", [d for d in demos if d.get("status") == "Approved"],
                           "Demo records whose status is Approved."),
    }
    if metric not in definitions:
        raise HTTPException(404, "Unknown Dashboard metric")
    title, records, definition = definitions[metric]

    def present(record):
        testcase = tc_by_id.get(record.get("testcase_id"))
        if metric in ("bassett-pass-rate", "bassett-failed", "bassett-score", "all-model-evaluations"):
            return {
                "id": record["id"], "name": (testcase or {}).get("name", record.get("testcase_id", "Unknown Test Case")),
                "type": record.get("model", "Evaluation"), "status": record.get("final_result") or record.get("status"),
                "value": record.get("overall_score"), "date": (record.get("created_at") or "")[:10],
                "secondary": record.get("bassett_version") or record.get("environment"), "to": f"/testcases/{record.get('testcase_id')}",
            }
        if metric in ("open-findings", "awaiting-fix", "ready-for-retest"):
            return {
                "id": record["id"], "name": record.get("title", "Finding"), "type": "Finding",
                "status": record.get("developer_status"), "value": record.get("criticality"),
                "date": (record.get("created_at") or "")[:10], "secondary": (testcase or {}).get("name"),
                "to": f"/findings?id={record['id']}",
            }
        if metric == "retests":
            return {
                "id": record["id"], "name": record.get("finding_title") or record.get("testcase_name") or "Retest",
                "type": "Retest", "status": record.get("status"), "value": record.get("verdict") or record.get("outcome"),
                "date": record.get("test_date") or (record.get("created_at") or "")[:10],
                "secondary": (testcase or {}).get("name"), "to": f"/testcases/{record.get('testcase_id')}",
            }
        if metric == "regression-current":
            return {
                "id": record["id"], "name": record.get("suite_name") or "Regression run", "type": "Regression",
                "status": f"{record.get('passed', 0)} passed / {record.get('failed', 0)} failed",
                 "value": record.get("bassett_version"), "date": record.get("test_date") or _regression_execution_date(record),
                 "secondary": "Regression Run Date",
                 "to": f"/regression?run={record['id']}",
            }
        if metric == "active-projects":
            return {"id": record["id"], "name": record.get("name", "Project"), "type": "Project",
                    "status": record.get("status"), "value": record.get("completion"),
                    "date": "", "secondary": f"{record.get('completion_source', 'Project completion')} · {record.get('owner') or 'Unassigned'}",
                    "to": f"/projects?record={record['id']}"}
        if metric == "demo-approved":
            return {"id": record["id"], "name": record.get("title") or record.get("name") or "Demo", "type": "Demo",
                    "status": record.get("status"), "value": None, "date": (record.get("created_at") or "")[:10],
                    "secondary": (testcase or {}).get("name"), "to": "/demos"}
        return {"id": record["id"], "name": record.get("name", "Test Case"), "type": "Test Case",
                "status": record.get("status"), "value": record.get("criticality"),
                "date": record.get("test_date"), "secondary": record.get("category"),
                "to": f"/testcases/{record['id']}"}

    return {"metric": metric, "title": title, "definition": definition,
            "active_version": version, "count": len(records), "records": [present(record) for record in records]}

# ---------- Finding → Retest workflow ----------
RETEST_VERDICTS = ["Fixed", "Partially Fixed", "Not Fixed", "Unable to Verify", "New Regression Introduced"]
VERDICT_TO_FINDING = {"Fixed": "Fixed", "Partially Fixed": "In Development", "Not Fixed": "In Development",
                      "Unable to Verify": "Ready for Retest", "New Regression Introduced": "Confirmed"}

def _validate_retest_completion(body):
    """Validate completion evidence before changing either retest or finding."""
    errors = {}
    verdict = body.get("verdict")
    if verdict not in RETEST_VERDICTS:
        errors["verdict"] = f"must be one of {RETEST_VERDICTS}"
    response = str(body.get("new_response") or "").strip()
    if not response:
        errors["new_response"] = "must be nonblank"
    version = str(body.get("new_bassett_version") or "").strip()
    if not version:
        errors["new_bassett_version"] = "is required"
    environment = str(body.get("new_environment") or "").strip()
    if not environment:
        errors["new_environment"] = "is required"
    result = str(body.get("new_result") or "").strip()
    if result not in (*PASS_SET, *FAIL_SET):
        errors["new_result"] = "must be a normalized Pass, Pass with Minor Issues, Fail, or Critical Fail result"
    try:
        score = float(body.get("new_score"))
        if score < 0 or score > 10:
            raise ValueError()
    except (TypeError, ValueError):
        errors["new_score"] = "must be a number from 0 to 10"
        score = None
    completed_at = body.get("completed_at")
    try:
        parsed = datetime.fromisoformat(str(completed_at).replace("Z", "+00:00"))
        if parsed.tzinfo is None:
            raise ValueError()
    except (TypeError, ValueError):
        errors["completed_at"] = "must be an explicit timezone-aware ISO-8601 timestamp"
    if errors:
        raise HTTPException(400, detail={"message": "Invalid retest completion fields", "fields": errors})
    return verdict, response, version, environment, result, score, str(completed_at)

@api.post("/findings/{id}/start-retest")
async def start_retest(id: str, body: Dict[str, Any], user=Depends(require_writer)):
    f = await crud_get("findings", id)
    if f.get("archived") or f.get("status") == "Archived":
        raise HTTPException(409, "Archived findings are immutable; retests remain historical records")
    tc = await db.testcases.find_one({"id": f.get("testcase_id")}, {"_id": 0})
    if not tc:
        raise HTTPException(409, "Finding is orphaned: its test case no longer exists")
    await _require_active_testcase(f.get("testcase_id"))
    active_retest = await db.retests.find_one({"finding_id": id, "status": "In Progress"}, {"_id": 0, "id": 1})
    if active_retest:
        raise HTTPException(409, "An active retest already exists for this finding")
    # Prefer the response/evaluation from the finding's originating version so 'original' is accurate
    ver = f.get("version_found", "")
    orig_resp = await db.responses.find({"testcase_id": f.get("testcase_id"), "model": "Bassett",
                                         "model_version": ver}, {"_id": 0}).sort("created_at", -1).to_list(1)
    if not orig_resp:
        orig_resp = await db.responses.find({"testcase_id": f.get("testcase_id"), "model": "Bassett"},
                                            {"_id": 0}).sort("created_at", -1).to_list(1)
    orig_eval = await db.evaluations.find({"testcase_id": f.get("testcase_id"), "model": "Bassett",
                                           "bassett_version": ver}, {"_id": 0}).sort("created_at", -1).to_list(1)
    if not orig_eval:
        orig_eval = await db.evaluations.find({"testcase_id": f.get("testcase_id"), "model": "Bassett"},
                                              {"_id": 0}).sort("created_at", -1).to_list(1)
    doc = {"finding_id": id, "testcase_id": f.get("testcase_id"),
           "finding_title": f.get("title", ""), "testcase_name": tc.get("name", "") if tc else "",
           "original_bassett_version": f.get("version_found", ""), "original_environment": f.get("environment", "Production"),
           "original_response": (orig_resp[0].get("response", "") if orig_resp else ""),
           "original_score": (orig_eval[0].get("overall_score") if orig_eval else None),
           "original_result": (orig_eval[0].get("final_result") if orig_eval else None),
           "original_failure_modes": f.get("failure_modes", []),
           "expected_corrected_behavior": body.get("expected_corrected_behavior", f.get("recommended_correction", "")),
           "fix_description": body.get("fix_description", f.get("fix_description", "")),
           "new_bassett_version": body.get("new_bassett_version", ""), "new_environment": body.get("new_environment", "Staging"),
           "status": "In Progress", "verdict": None, "started_by": user["name"], "retest_date": None,
           "new_response": "", "new_score": None, "new_result": None, "reviewer": "", "notes": ""}
    doc.update({
        "id": new_id(), "created_at": now_iso(), "created_by": user["name"],
        "updated_at": now_iso(),
    })
    if not await db.insert_active_retest(doc):
        raise HTTPException(409, "An active retest already exists for this finding")
    created = clean(doc)
    await log_activity("retests", doc["id"], "created", user, doc.get("finding_title", ""))
    await db.findings.update_one({"id": id}, {"$set": {"retest_status": "In Progress", "updated_at": now_iso()}})
    await log_activity("findings", id, "retest started", user, created["id"])
    await log_activity("testcases", f.get("testcase_id"), "retest started", user, f.get("title", ""))
    return created

@api.post("/bassett/issues/{id}/send-for-retest")
async def bassett_send_issue_for_retest(id: str, body: Dict[str, Any], user=Depends(get_current_user)):
    """Authorized Bassett action that delegates to the established retest workflow."""
    _require_bassett_writer(user)
    issue = await _bassett_ref("bassett_issues", id, "Bassett issue")
    _require_mutable_bassett_issue(issue)
    if not issue.get("finding_id"):
        raise HTTPException(409, "Create or link a finding before sending this Bassett issue for retest")
    retest = await start_retest(issue["finding_id"], body or {}, user)
    await db.bassett_issues.update_one({"id": id}, {"$set": {
        "retest_id": retest["id"], "updated_at": now_iso(),
    }})
    await _bassett_history("issue", id, "sent_for_retest", user, {
        "finding_id": issue["finding_id"], "retest_id": retest["id"],
    })
    return retest

@api.post("/retests/{id}/complete")
async def complete_retest(id: str, body: Dict[str, Any], user=Depends(require_writer)):
    existing_retest = await crud_get("retests", id)
    await _guard_testcase_linked_document(existing_retest)
    finding = await db.findings.find_one({"id": existing_retest.get("finding_id")}, {"_id": 0})
    if not finding:
        raise HTTPException(409, "Retest is orphaned: linked finding no longer exists")
    if finding.get("archived") or finding.get("status") == "Archived":
        raise HTTPException(409, "Archived findings are immutable; retests remain historical records")
    verdict, response, version, environment, new_result, score, completed_at = _validate_retest_completion(body)
    upd = {"verdict": verdict, "outcome": verdict, "status": "Completed",
           "test_date": _validate_test_date(body.get("test_date")), "retest_date": completed_at,
           "completed_at": completed_at, "reviewer": user["name"],
           "new_response": response, "new_score": score, "new_result": new_result, "notes": body.get("notes", ""),
           "new_bassett_version": version, "new_environment": environment,
           "updated_at": completed_at}
    f_status = _require_retest_target_status(
        VERDICT_TO_FINDING[verdict],
        await _configured_finding_statuses(),
    )
    result = await db.complete_retest_transition(
        id,
        upd,
        f_status,
        {"to": f_status, "by": user["name"], "at": completed_at, "note": f"Retest verdict: {verdict}"},
    )
    if result.get("error") == "not_found":
        raise HTTPException(404, "retests not found")
    if result.get("error") == "invalid_state":
        raise HTTPException(409, "Only an In Progress retest can be completed")
    if result.get("error") == "orphaned":
        raise HTTPException(409, "Retest is orphaned: it has no linked finding")
    if result.get("error") == "finding_not_found":
        raise HTTPException(404, "Linked finding not found")
    await log_activity("findings", result["finding_id"], f"retest completed · {verdict}", user)
    await log_activity("testcases", result["testcase_id"], f"retest completed · {verdict}", user, result["finding_title"])
    return result["retest"]

# ---------- Release readiness reviewer decision ----------
@api.post("/release-readiness/decision")
async def readiness_decision(body: Dict[str, Any], user=Depends(get_current_user)):
    if user["role"] not in ("admin", "qa_manager"):
        raise HTTPException(403, "Only Admin or QA Manager can record a release decision")
    version = body.get("version")
    decision = body.get("decision")
    if decision not in ("GO", "CONDITIONAL", "NO-GO"):
        raise HTTPException(400, "decision must be GO, CONDITIONAL or NO-GO")
    # Server-side override detection: never trust the client's flag
    rr = await release_readiness(version=version, user=user)
    is_override = decision != rr["recommendation"]
    # Immutable decision-time snapshot — captured server-side from the live readiness computation
    snapshot = {
        "version": version, "environment": body.get("environment", "Production"),
        "decision_date": now_iso(), "system_recommendation": rr["recommendation"],
        "recommendation_reason": rr["reason"],
        "pass_rate": rr["pass_rate"], "evaluated": rr["evaluated"], "passed": rr["passed"],
        "failed": rr["failed"], "avg_score": rr["avg_score"],
        "open_findings": rr["open_findings"], "open_crit5": rr["open_crit5"], "open_crit4": rr["open_crit4"],
        "critical_fail_evals": rr["critical_fail_evals"], "newly_failing_regressions": rr["newly_failing"],
        "blocker_count": len(rr["blockers"]),
        "blockers": [{"type": b["type"], "label": b["label"], "detail": b["detail"],
                      "link_id": b.get("link_id", ""), "link_type": b.get("link_type", "")} for b in rr["blockers"]],
    }
    doc = {"version": version, "decision": decision, "notes": body.get("notes", ""),
           "override": is_override, "risk_accepted": bool(body.get("risk_accepted")),
           "system_recommendation_at_decision": rr["recommendation"],
           "follow_up": body.get("follow_up", ""),
           "snapshot": snapshot,
           "blockers_at_decision": [b["label"] for b in rr["blockers"]],
           "decided_by": user["name"], "decided_at": now_iso()}
    if is_override and (len(doc["notes"].strip()) < 20 or not doc["risk_accepted"]):
        raise HTTPException(400, "Overriding the system recommendation requires a structured rationale (≥20 chars) and explicit risk acceptance.")
    prev = await db.release_decisions.find_one({"version": version}, {"_id": 0})
    if prev:
        history = prev.get("decision_history", []) + [{k: prev.get(k) for k in ("decision", "notes", "decided_by", "decided_at")}]
        doc["decision_history"] = history
    await db.release_decisions.update_one({"version": version}, {"$set": doc}, upsert=True)
    await log_activity("release", version, f"release decision · {decision}", user, body.get("notes", ""))
    return doc

# ---------- Data Integrity validation (admin) ----------
@api.get("/admin/integrity")
async def data_integrity(user=Depends(get_current_user)):
    if user["role"] not in ("admin", "qa_manager"):
        raise HTTPException(403, "Admin or QA Manager only")
    issues = []
    def add(entity_type, entity_id, name, problem, severity, repair, link="", repair_action=None):
        issues.append({"entity_type": entity_type, "entity_id": entity_id, "name": name,
                       "problem": problem, "severity": severity, "repair": repair, "link": link,
                       "repair_action": repair_action})

    tcs = {t["id"]: t for t in await crud_list("testcases", include_archived=True)}
    evals = await _exclude_incomplete_comparison_evaluations(await crud_list("evaluations"))
    responses = await crud_list("responses")
    findings = await crud_list("findings")
    retests = await crud_list("retests")
    golds = await crud_list("goldstandards")
    projects = {p["id"]: p for p in await crud_list("projects", include_archived=True)}
    munis = {m["id"]: m for m in await crud_list("municipalities", include_archived=True)}
    props = {p["id"]: p for p in await crud_list("properties", include_archived=True)}
    evidence = await crud_list("evidence")
    runs = await crud_list("regression_runs")
    decisions = await db.release_decisions.find({}, {"_id": 0}).to_list(100)
    versions = await crud_list("versions")

    b_evals_by_tc = {}
    for e in sorted([x for x in evals if x.get("model") == "Bassett"], key=lambda x: x.get("created_at", "")):
        b_evals_by_tc.setdefault(e["testcase_id"], []).append(e)

    # Core record completeness. These checks keep the page from reporting a
    # misleading clean result when the UI has to synthesize dates or display
    # blank administrative metadata.
    for tid, tc in tcs.items():
        if tc.get("archived") or tc.get("test_date"):
            continue
        dated_evaluations = [
            evaluation for evaluation in b_evals_by_tc.get(tid, [])
            if evaluation.get("test_date")
        ]
        repair_action = None
        repair = "Enter the actual business Test Date on the test case"
        if dated_evaluations:
            repair = "Backfill the Test Date from the latest dated Bassett evaluation"
            repair_action = {
                "key": "backfill_test_date",
                "label": "Backfill Test Date",
                "destructive": False,
                "effect": "Copies the latest valid Bassett evaluation Test Date to the test case. The evaluation is unchanged.",
            }
        add("testcase", tid, tc.get("name", "?"), "Active test case has no recorded Test Date",
            "medium", repair, f"/testcases/{tid}", repair_action)

    for evidence_record in evidence:
        if not (evidence_record.get("issuing_authority") or "").strip():
            add("evidence", evidence_record["id"], evidence_record.get("document_name", "?"),
                "Ordinance evidence has no Issuing Authority", "low",
                "Identify the government department or other authority that issued the source", "/evidence")

    for version in versions:
        missing_metadata = [
            label for field, label in (("version_type", "Version Type"), ("release_channel", "Release Channel"))
            if not (version.get(field) or "").strip()
        ]
        if missing_metadata:
            add("version", version["id"], version.get("name", "?"),
                f"Bassett version is missing: {', '.join(missing_metadata)}", "low",
                "Edit the version and select the missing administrative values", "/admin")

    active_testcases = [tc for tc in tcs.values() if not tc.get("archived")]
    for project_id, project in projects.items():
        if project.get("archived"):
            continue
        if not project.get("owner_id"):
            add("project", project_id, project.get("name", "?"),
                "Project owner is not linked to a ZoneQA user", "medium",
                "Select an active user in the project Owner field", "/projects")
        municipality_ids = {
            tc.get("municipality_id") for tc in active_testcases
            if tc.get("project_id") == project_id and tc.get("municipality_id") in munis
        }
        if len(municipality_ids) > 1:
            names = sorted(
                f"{munis[mid].get('name')}, {munis[mid].get('state')}" for mid in municipality_ids
            )
            add("project", project_id, project.get("name", "?"),
                f"Linked test cases span multiple municipalities: {', '.join(names)}", "low",
                "Confirm the cross-municipality grouping is intentional; otherwise reassign the test cases", "/projects")

    # 1/2. Status vs evaluation contradictions
    for tid, tc in tcs.items():
        has_eval = tid in b_evals_by_tc
        if tc.get("status") in ("Evaluated", "Complete", "Completed") and not has_eval:
            add("testcase", tid, tc.get("name", "?"), f"Status '{tc.get('status')}' but no Bassett evaluation exists",
                "high", "Complete a Bassett evaluation or reset status to Draft/Testing", f"/testcases/{tid}",
                {"key": "reset_status_draft", "label": "Reset status to Draft", "destructive": False,
                 "effect": "Sets the test case status back to 'Draft'. No evaluations, responses or findings are touched."})
        if tc.get("status") == "Draft" and has_eval:
            add("testcase", tid, tc.get("name", "?"), "Draft test has a final Bassett evaluation result",
                "medium", "Update status to Evaluated or archive the stray evaluation", f"/testcases/{tid}",
                {"key": "set_status_evaluated", "label": "Set status to Evaluated", "destructive": False,
                 "effect": "Sets the test case status to 'Evaluated' so it matches its existing Bassett evaluation."})

    # 3. Variant with evaluation but no own response (possible inherited records)
    for tid, tc in tcs.items():
        if tc.get("variant_of") and tid in b_evals_by_tc:
            own_resp = [r for r in responses if r["testcase_id"] == tid]
            if not own_resp:
                add("testcase", tid, tc.get("name", "?"), "Variant has an evaluation but no response of its own — result may be inherited from the parent",
                    "high", "Capture the variant's own Bassett response or reset the variant to Draft / Not Evaluated", f"/testcases/{tid}",
                    {"key": "reset_variant_draft", "label": "Reset variant to Draft / Not Evaluated", "destructive": True,
                     "effect": "Deletes the variant's inherited evaluation record(s) and resets its status to 'Draft'. The parent test is untouched. This cannot be undone."})

    # 4. Completed retests missing required fields
    REQUIRED_RETEST = [("outcome", "outcome"), ("completed_at", "completion date"), ("reviewer", "reviewer"),
                       ("new_bassett_version", "after-version"), ("new_environment", "after-environment"),
                       ("new_response", "after-response"), ("new_result", "final evaluation result")]
    for rt in retests:
        if rt.get("status") == "Completed":
            missing = [label for k, label in REQUIRED_RETEST if not rt.get(k)]
            if missing:
                add("retest", rt["id"], rt.get("finding_title") or rt.get("testcase_name", "retest"),
                    f"Completed retest missing: {', '.join(missing)}", "medium",
                    "Backfill the missing completion fields", f"/testcases/{rt.get('testcase_id')}",
                    {"key": "backfill_retest", "label": "Backfill completion fields", "destructive": False,
                     "effect": "Fills missing fields from existing data: outcome from the recorded result, completion date from the retest date, reviewer from the initiator. Nothing is overwritten."})
        if rt.get("verdict") and rt.get("status") != "Completed":
            add("retest", rt["id"], rt.get("finding_title") or rt.get("testcase_name", "retest"),
                f"Retest has outcome '{rt.get('verdict')}' but status is '{rt.get('status')}' (should be Completed)",
                "high", "Set status=Completed for retests with a recorded outcome", f"/testcases/{rt.get('testcase_id')}",
                {"key": "complete_retest_status", "label": "Set status to Completed", "destructive": False,
                 "effect": "Marks the retest status 'Completed' so it matches its recorded outcome."})

    # 5. Finding marked Fixed without a completed retest (when retest required)
    completed_by_finding = {rt.get("finding_id") for rt in retests if rt.get("status") == "Completed" and rt.get("finding_id")}
    for f in findings:
        if f.get("developer_status") == "Fixed" and f.get("retest_required") and f["id"] not in completed_by_finding:
            add("finding", f["id"], f.get("title", "?"), "Marked Fixed but no completed retest exists (retest required)",
                "high", "Run and complete a retest, or remove the retest-required flag with justification", f"/findings?id={f['id']}")

    # 6. Release decisions missing a blocker snapshot
    for d in decisions:
        if not d.get("snapshot"):
            add("release_decision", d.get("version", "?"), f"Decision {d.get('decision')} · {d.get('version')}",
                "Release decision recorded without an immutable blocker snapshot", "high",
                "Re-record the decision (a snapshot is now captured automatically)", "/release",
                {"key": "recompute_snapshot", "label": "Backfill snapshot from current state", "destructive": False,
                 "effect": "Captures a snapshot of the CURRENT release state and attaches it to this decision, clearly flagged as a backfill (not decision-time data). The decision itself is unchanged."})

    # 7. Regression snapshot runs without a baseline
    for r in runs:
        if r.get("results") and not r.get("baseline_run_id"):
            add("regression_run", r["id"], f"{r.get('suite_name')} · {r.get('bassett_version')} · {r.get('run_date')}",
                "Regression run has no baseline — improved/regressed cannot be computed (shown as N/A)",
                "low", "Execute a new run selecting this run as baseline to enable comparisons", "/regression")

    # 8. Approved Gold Standards relying on stale evidence
    stale_map = await compute_stale_gold_map()
    golds_by_tc = {g.get("testcase_id"): g for g in golds}
    for tid, titles in stale_map.items():
        g = golds_by_tc.get(tid)
        if g and g.get("review_status") == "Approved":
            add("goldstandard", g.get("id", tid), tcs.get(tid, {}).get("name", "?"),
                f"Approved Gold Standard relies on stale evidence: {', '.join(titles)}",
                "high", "Re-verify evidence against the current ordinance, then re-approve", f"/testcases/{tid}")

    # 9. Unresolved foreign keys
    for tid, tc in tcs.items():
        for field, pool, label, sev in (("project_id", projects, "project", "medium"),
                                        ("municipality_id", munis, "municipality", "medium"),
                                        ("property_id", props, "property", "low")):
            if tc.get(field) and tc[field] not in pool:
                add("testcase", tid, tc.get("name", "?"), f"References a {label} that no longer exists", sev,
                    f"Clear the broken reference, then reassign a valid {label}", f"/testcases/{tid}",
                    {"key": "clear_reference", "label": f"Clear broken {label} reference", "destructive": False,
                     "params": {"field": field},
                     "effect": f"Removes the reference to the deleted {label}. You can reassign a valid {label} afterwards from the test case form."})
    for coll_name, docs in (("evaluation", evals), ("response", responses), ("finding", findings)):
        for d in docs:
            if d.get("testcase_id") and d["testcase_id"] not in tcs:
                add(coll_name, d["id"], d.get("title") or d.get("model", coll_name),
                    "Orphaned — references a deleted test case", "medium", "Delete the orphaned record or restore the test case", "",
                    {"key": "delete_orphan", "label": "Delete orphaned record", "destructive": True,
                     "params": {"collection": coll_name + "s"},
                     "effect": "Permanently deletes this record. Its parent test case no longer exists, so it cannot appear anywhere in the app. This cannot be undone."})
    # 10. User references are JSON fields and older imports can contain an
    # account that was later removed.  They are safe to clear, never retarget.
    active_users = {u["id"] for u in await db.users.find(
        {"active": {"$ne": False}, "deleted_at": {"$exists": False}}, {"_id": 0, "id": 1}
    ).to_list(5000)}
    for collection, fields in USER_REFERENCE_FIELDS.items():
        for document in await crud_list(collection):
            for field in fields:
                if document.get(field) and document[field] not in active_users:
                    add(collection[:-1], document["id"], document.get("name") or document.get("title") or document["id"],
                        f"References a missing or inactive user in {field}", "medium",
                        "Clear the historical user reference; do not substitute another user.", "",
                        {"key": "clear_user_reference", "label": f"Clear invalid {field}", "destructive": False,
                         "params": {"collection": collection, "field": field},
                         "effect": "Clears only the unresolved user ID. Historical content is preserved."})
    for finding in findings:
        if finding.get("project_id") and finding["project_id"] not in projects:
            add("finding", finding["id"], finding.get("title", "?"), "Orphaned — references a deleted project",
                "high", "Clear the broken project reference", "",
                {"key": "clear_finding_reference", "label": "Clear broken project reference", "destructive": False,
                 "params": {"field": "project_id"}})
        if finding.get("testcase_id") and finding["testcase_id"] not in tcs:
            add("finding", finding["id"], finding.get("title", "?"), "Orphaned — references a deleted test case",
                "high", "Clear the broken test-case reference", "",
                {"key": "clear_finding_reference", "label": "Clear broken test-case reference", "destructive": False,
                 "params": {"field": "testcase_id"}})

    # 11. Unnamed reference records
    for label, docs, field in (("municipality", munis.values(), "name"), ("property", props.values(), "name"),
                               ("project", projects.values(), "name"), ("evidence", evidence, "document_name"),
                               ("version", versions, "name")):
        for d in docs:
            if not (d.get(field) or "").strip():
                add(label, d["id"], "(unnamed)", f"{label.capitalize()} record has no {field}", "medium", f"Set a {field} or delete the record", "")

    # 11. Dashboard vs canonical metrics reconciliation
    integrity_view = await _evaluation_read_model(
        await crud_list("evaluations"), valid_testcase_ids=tcs,
    )
    canon_passed = result_summary(integrity_view["bassett"])["passed"]
    stats = await dashboard_stats(user)
    if stats["bassett_passed"] != canon_passed:
        add("metrics", "dashboard", "Dashboard stats", f"Dashboard bassett_passed={stats['bassett_passed']} does not reconcile with canonical latest-eval count={canon_passed}",
            "high", "Dashboard must use the canonical latest-evaluation-per-test-case record set", "/")

    order = {"high": 0, "medium": 1, "low": 2}
    issues.sort(key=lambda x: order.get(x["severity"], 3))
    return {"issues": issues, "counts": {"high": len([i for i in issues if i['severity'] == 'high']),
                                         "medium": len([i for i in issues if i['severity'] == 'medium']),
                                         "low": len([i for i in issues if i['severity'] == 'low'])},
            "checked_at": now_iso()}

# ---------- One-click integrity repairs (admin, guided confirmation in UI) ----------
@api.post("/admin/integrity/repair")
async def integrity_repair(body: Dict[str, Any], user=Depends(get_current_user)):
    if user["role"] != "admin":
        raise HTTPException(403, "Administrator only")
    key, eid = body.get("key"), body.get("entity_id")
    params = body.get("params") or {}
    if not key or not eid:
        raise HTTPException(400, "key and entity_id are required")

    if key == "reset_status_draft":
        tc = await db.testcases.find_one({"id": eid}, {"_id": 0})
        if not tc:
            raise HTTPException(404, "Test case not found")
        if await db.evaluations.count_documents({"testcase_id": eid, "model": "Bassett"}):
            raise HTTPException(409, "A Bassett evaluation now exists — repair no longer applicable")
        await db.testcases.update_one({"id": eid}, {"$set": {"status": "Draft", "updated_at": now_iso()}})
        detail = f"status '{tc.get('status')}' → 'Draft' (no evaluation existed)"

    elif key == "set_status_evaluated":
        tc = await db.testcases.find_one({"id": eid}, {"_id": 0})
        if not tc:
            raise HTTPException(404, "Test case not found")
        if not await db.evaluations.count_documents({"testcase_id": eid, "model": "Bassett"}):
            raise HTTPException(409, "No Bassett evaluation exists — repair no longer applicable")
        await db.testcases.update_one({"id": eid}, {"$set": {"status": "Evaluated", "updated_at": now_iso()}})
        detail = "status 'Draft' → 'Evaluated' (matches existing evaluation)"

    elif key == "backfill_test_date":
        tc = await db.testcases.find_one({"id": eid}, {"_id": 0})
        if not tc:
            raise HTTPException(404, "Test case not found")
        if tc.get("test_date"):
            raise HTTPException(409, "Test case already has a Test Date")
        evaluations = await db.evaluations.find(
            {"testcase_id": eid, "model": "Bassett", "test_date": {"$nin": [None, ""]}}, {"_id": 0}
        ).to_list(5000)
        valid_dates = []
        for evaluation in evaluations:
            try:
                valid_dates.append(_validate_test_date(evaluation.get("test_date"), required=False))
            except HTTPException:
                continue
        valid_dates = [value for value in valid_dates if value]
        if not valid_dates:
            raise HTTPException(409, "No valid Bassett evaluation Test Date is available to backfill")
        test_date = max(valid_dates)
        await db.testcases.update_one(
            {"id": eid}, {"$set": {"test_date": test_date, "updated_at": now_iso()}}
        )
        detail = f"Test Date → {test_date} (latest dated Bassett evaluation)"

    elif key == "reset_variant_draft":
        tc = await db.testcases.find_one({"id": eid}, {"_id": 0})
        if not tc or not tc.get("variant_of"):
            raise HTTPException(404, "Variant test case not found")
        if await db.responses.count_documents({"testcase_id": eid}):
            raise HTTPException(409, "Variant now has its own response — repair no longer applicable")
        deleted = await db.evaluations.delete_many({"testcase_id": eid})
        await db.testcases.update_one({"id": eid}, {"$set": {"status": "Draft", "updated_at": now_iso()}})
        detail = f"deleted {deleted.deleted_count} inherited evaluation(s), status → 'Draft'"

    elif key == "backfill_retest":
        rt = await db.retests.find_one({"id": eid}, {"_id": 0})
        if not rt:
            raise HTTPException(404, "Retest not found")
        upd = {}
        if not rt.get("outcome"):
            upd["outcome"] = rt.get("verdict") or ("Fixed" if rt.get("new_result") in PASS_SET else "Not Fixed" if rt.get("new_result") else None)
            if not upd["outcome"]:
                upd.pop("outcome")
        if not rt.get("verdict") and upd.get("outcome"):
            upd["verdict"] = upd["outcome"]
        if not rt.get("completed_at"):
            upd["completed_at"] = rt.get("retest_date") or rt.get("created_at") or now_iso()
        if not rt.get("reviewer"):
            upd["reviewer"] = rt.get("retested_by") or rt.get("started_by") or user["name"]
        if not rt.get("new_environment"):
            upd["new_environment"] = "Staging"
        if not upd:
            raise HTTPException(409, "Nothing to backfill from existing data — fill remaining fields manually")
        await db.retests.update_one({"id": eid}, {"$set": {**upd, "updated_at": now_iso()}})
        detail = f"backfilled: {', '.join(upd)}"

    elif key == "complete_retest_status":
        rt = await db.retests.find_one({"id": eid}, {"_id": 0})
        if not rt or not rt.get("verdict"):
            raise HTTPException(409, "Retest has no recorded outcome — repair not applicable")
        await db.retests.update_one({"id": eid}, {"$set": {"status": "Completed", "outcome": rt.get("outcome") or rt["verdict"],
                                                           "completed_at": rt.get("completed_at") or rt.get("retest_date") or now_iso(),
                                                           "updated_at": now_iso()}})
        detail = f"status → 'Completed' (outcome {rt['verdict']})"

    elif key == "recompute_snapshot":
        dec = await db.release_decisions.find_one({"version": eid}, {"_id": 0})
        if not dec:
            raise HTTPException(404, "Release decision not found")
        if dec.get("snapshot"):
            raise HTTPException(409, "Decision already has a snapshot")
        rr = await release_readiness(version=eid, user=user)
        snapshot = {"version": eid, "environment": "Production", "decision_date": dec.get("decided_at"),
                    "system_recommendation": rr["recommendation"], "recommendation_reason": rr["reason"],
                    "pass_rate": rr["pass_rate"], "evaluated": rr["evaluated"], "passed": rr["passed"],
                    "failed": rr["failed"], "avg_score": rr["avg_score"], "open_findings": rr["open_findings"],
                    "open_crit5": rr["open_crit5"], "open_crit4": rr["open_crit4"],
                    "critical_fail_evals": rr["critical_fail_evals"], "newly_failing_regressions": rr["newly_failing"],
                    "blocker_count": len(rr["blockers"]), "blockers": rr["blockers"],
                    "backfilled": True, "backfilled_at": now_iso(), "backfilled_by": user["name"]}
        await db.release_decisions.update_one({"version": eid}, {"$set": {"snapshot": snapshot}})
        detail = f"snapshot backfilled from current state ({len(rr['blockers'])} blockers)"

    elif key == "clear_reference":
        field = params.get("field")
        if field not in ("project_id", "municipality_id", "property_id"):
            raise HTTPException(400, "Invalid reference field")
        tc = await db.testcases.find_one({"id": eid}, {"_id": 0})
        if not tc:
            raise HTTPException(404, "Test case not found")
        ref_coll = {"project_id": "projects", "municipality_id": "municipalities", "property_id": "properties"}[field]
        if tc.get(field) and await db[ref_coll].count_documents({"id": tc[field]}):
            raise HTTPException(409, "Reference now resolves — repair no longer applicable")
        await db.testcases.update_one({"id": eid}, {"$set": {field: None, "updated_at": now_iso()}})
        detail = f"cleared broken {field}"

    elif key == "clear_user_reference":
        coll, field = params.get("collection"), params.get("field")
        if coll not in USER_REFERENCE_FIELDS or field not in USER_REFERENCE_FIELDS[coll]:
            raise HTTPException(400, "Invalid user reference field")
        document = await db[coll].find_one({"id": eid}, {"_id": 0})
        if not document:
            raise HTTPException(404, "Record not found")
        value = document.get(field)
        if not value or await db.users.find_one(
            {"id": value, "active": {"$ne": False}, "deleted_at": {"$exists": False}}, {"_id": 0}
        ):
            raise HTTPException(409, "User reference now resolves — repair no longer applicable")
        await db[coll].update_one({"id": eid}, {"$set": {field: None, "updated_at": now_iso()}})
        detail = f"cleared unresolved {field}"

    elif key == "clear_finding_reference":
        field = params.get("field")
        if field not in ("project_id", "testcase_id"):
            raise HTTPException(400, "Invalid Finding reference field")
        finding = await db.findings.find_one({"id": eid}, {"_id": 0})
        if not finding:
            raise HTTPException(404, "Finding not found")
        collection = "projects" if field == "project_id" else "testcases"
        if finding.get(field) and await db[collection].count_documents({"id": finding[field]}):
            raise HTTPException(409, "Reference now resolves — repair no longer applicable")
        await db.findings.update_one({"id": eid}, {"$set": {field: None, "updated_at": now_iso()}})
        detail = f"cleared orphaned Finding {field}"

    elif key == "delete_orphan":
        coll = params.get("collection")
        if coll not in ("evaluations", "responses", "findings"):
            raise HTTPException(400, "Invalid collection")
        doc = await db[coll].find_one({"id": eid}, {"_id": 0})
        if not doc:
            raise HTTPException(404, "Record not found")
        if doc.get("testcase_id") and await db.testcases.count_documents({"id": doc["testcase_id"]}):
            raise HTTPException(409, "Parent test case exists — record is not orphaned")
        await db[coll].delete_one({"id": eid})
        detail = f"deleted orphaned {coll[:-1]}"

    else:
        raise HTTPException(400, f"Unknown repair key '{key}'")

    await log_activity("integrity", eid, f"integrity repair · {key}", user,
                       f"{body.get('record_name', '')} — {detail}".strip(" —"))
    return {"ok": True, "key": key, "entity_id": eid, "detail": detail}

# ---------- Global Search ----------
@api.get("/search")
async def global_search(q: str = "", user=Depends(get_current_user)):
    q = q.strip()
    if len(q) < 2:
        return {"query": q, "groups": []}
    rx = {"$regex": re.escape(q), "$options": "i"}
    munis = {m["id"]: m for m in await crud_list("municipalities")}
    projects = {p["id"]: p for p in await crud_list("projects")}

    async def find(coll, fields, limit=5):
        or_ = [{f: rx} for f in fields] + [{"id": q}]
        return await db[coll].find({"$or": or_}, {"_id": 0}).to_list(limit)

    groups = []
    tcs = await find("testcases", ["name", "description", "prompt", "category"])
    if tcs:
        groups.append({"label": "Test Cases", "items": [
            {"type": "Test Case", "id": t["id"], "name": t.get("name", ""), "link": f"/testcases/{t['id']}",
             "context": " · ".join(x for x in [t.get("category"), munis.get(t.get("municipality_id"), {}).get("name")] if x),
             "status": t.get("status"), "criticality": t.get("criticality")} for t in tcs]})
    # failure_modes is an array. Some database adapters cannot apply a scalar
    # case-insensitive regex to it, which previously caused the entire search to fail.
    fs = await find("findings", ["title", "description", "root_cause", "finding_type", "actual_behavior"])
    if fs:
        groups.append({"label": "Findings", "items": [
            {"type": "Finding", "id": f["id"], "name": f.get("title", ""), "link": "/findings",
             "context": " · ".join(x for x in [f.get("finding_type"), (", ".join(f.get("failure_modes", [])) if isinstance(f.get("failure_modes"), list) else f.get("failure_modes"))] if x),
             "status": f.get("developer_status"), "criticality": f.get("criticality")} for f in fs]})
    ps = await find("properties", ["name", "address", "zone_code"])
    if ps:
        groups.append({"label": "Properties", "items": [
            {"type": "Property", "id": p["id"], "name": p.get("name") or p.get("address", ""), "link": "/properties",
             "context": " · ".join(x for x in [p.get("address"), munis.get(p.get("municipality_id"), {}).get("name")] if x),
             "status": None, "criticality": None} for p in ps]})
    ms = await find("municipalities", ["name", "state", "ordinance_source"])
    if ms:
        groups.append({"label": "Municipalities", "items": [
            {"type": "Municipality", "id": m["id"], "name": f"{m.get('name', '')}, {m.get('state', '')}", "link": "/municipalities",
             "context": m.get("ordinance_source", ""), "status": None, "criticality": None} for m in ms]})
    prj = await find("projects", ["name", "description", "goal"])
    if prj:
        groups.append({"label": "Projects", "items": [
            {"type": "Project", "id": p["id"], "name": p.get("name", ""), "link": "/projects",
             "context": (p.get("description") or "")[:60], "status": p.get("status"), "criticality": None} for p in prj]})
    evs = await find("evidence", ["document_name", "citation", "relevant_text", "jurisdiction"])
    if evs:
        groups.append({"label": "Evidence", "items": [
            {"type": "Evidence", "id": e["id"], "name": e.get("document_name", ""), "link": "/evidence",
             "context": " · ".join(x for x in [e.get("citation"), munis.get(e.get("municipality_id"), {}).get("name")] if x),
             "status": e.get("verification_status"), "criticality": None} for e in evs]})
    suites = await find("regression_suites", ["name", "description"])
    if suites:
        groups.append({"label": "Regression Suites", "items": [
            {"type": "Regression Suite", "id": s["id"], "name": s.get("name", ""), "link": "/regression",
             "context": f"{len(s.get('testcase_ids', []))} tests", "status": None, "criticality": None} for s in suites]})
    demos = await find("demos", ["use_case", "why_good"])
    if demos:
        groups.append({"label": "Demo Library", "items": [
            {"type": "Demo", "id": d["id"], "name": d.get("use_case", ""), "link": "/demos",
             "context": d.get("bassett_version", ""), "status": d.get("status"), "criticality": None} for d in demos]})
    return {"query": q, "groups": groups, "total": sum(len(g["items"]) for g in groups)}

# ---------- Seed ----------
@api.post("/seed")
async def seed(confirm: bool = False, user=Depends(get_current_user)):
    if APP_ENV == "production":
        raise HTTPException(404, "Not found")
    if user["role"] != "admin":
        raise HTTPException(403, "Admin only")
    if not confirm:
        raise HTTPException(400, "Development seed reset requires confirm=true")
    await run_seed()
    return {"ok": True}

app.include_router(api)

@app.middleware("http")
async def csrf_protection(request: Request, call_next):
    public_mutations = {
        "/api/auth/login",
        "/api/auth/bootstrap",
        "/api/auth/forgot-password",
        "/api/auth/reset-password",
    }
    if request.method in {"POST", "PUT", "PATCH", "DELETE"} and request.url.path not in public_mutations:
        raw_session = request.cookies.get(SESSION_COOKIE)
        if raw_session:
            try:
                _user, session = await _lookup_session(raw_session)
            except HTTPException as exc:
                return JSONResponse({"detail": exc.detail}, status_code=exc.status_code)
            supplied = request.headers.get("X-CSRF-Token", "")
            cookie_value = request.cookies.get(CSRF_COOKIE, "")
            if not _csrf_is_valid(session, supplied, cookie_value):
                return JSONResponse({"detail": "CSRF validation failed"}, status_code=403)
    return await call_next(request)

def _cors_origins():
    origins = [
        origin.strip().rstrip("/")
        for origin in os.environ.get("CORS_ORIGINS", "").split(",")
        if origin.strip()
    ]
    if "*" in origins:
        raise RuntimeError("CORS_ORIGINS may not contain '*'")
    invalid = [
        origin for origin in origins
        if not re.fullmatch(r"https?://[A-Za-z0-9.-]+(?::\d+)?", origin)
        or (APP_ENV == "production" and not origin.startswith("https://"))
    ]
    if invalid:
        raise RuntimeError("CORS_ORIGINS must contain explicit HTTP(S) origins")
    return origins

app.add_middleware(
    CORSMiddleware,
    allow_credentials=True,
    allow_origins=_cors_origins(),
    allow_methods=["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allow_headers=[
        "Content-Type",
        "X-CSRF-Token",
        "X-Bootstrap-Token",
        "X-Bassett-API-Key",
    ],
)

# ---------- Startup ----------
DEFAULT_CONFIG = {
    "id": "global",
    "application_timezone": "America/New_York",
    "criticality": {"1": "Minor", "2": "Low", "3": "Moderate", "4": "High", "5": "Critical"},
    "difficulty": {"1": "Basic", "2": "Standard", "3": "Advanced", "4": "Complex", "5": "Expert"},
    "test_statuses": ["Draft", "Ready to Test", "Testing", "Awaiting Evidence", "Ready for Evaluation",
                      "Evaluated", "Retest Required", "Retested", "Closed"],
    "finding_statuses": ["New", "Confirmed", "Needs Investigation", "Planned", "In Development",
                         "Ready for Retest", "Fixed", "Won't Fix", "Duplicate", "Closed"],
    "categories": ["Property & Regulatory Identification", "Zoning Code Requirements",
                   "Special Districts / Entitlements", "Municipal Research", "Compliance",
                   "Risk Assessment", "Agency / Due Diligence", "Conversational Performance",
                   "Source / Citation Performance", "Calculation Performance", "Workflow / UX"],
    "test_types": ["Single Prompt", "Multi-Turn Conversation", "Property Scenario", "Municipality Research",
                   "Ordinance Interpretation", "Calculation", "Missing Information", "Ambiguous Question",
                   "Adversarial / Edge Case", "Regression", "Competitive Benchmark", "Demo Candidate",
                   "Source Verification", "Workflow Test"],
    "failure_modes": ["Incorrect Fact", "Incorrect Zoning District", "Wrong Jurisdiction", "Wrong Ordinance",
                      "Outdated Regulation", "Incorrect Interpretation", "Missing Regulation", "Missed Overlay",
                      "Missed PD/PUD", "Incorrect Calculation", "Unsupported Assumption", "Hallucination",
                      "Hallucinated Citation", "Incorrect Citation", "Weak Source", "Missing Citation",
                      "Failed to Recognize Missing Information", "Failed to Ask Clarifying Question",
                      "Asked Unnecessary Clarifying Question", "Context Lost", "Contradicted Earlier Answer",
                      "Incomplete Answer", "Overly Confident Answer", "Poor Next-Step Guidance",
                      "Excessive Response", "Insufficient Response", "Workflow / UX Issue", "Other"],
    "root_causes": ["Data Coverage", "Source Retrieval", "Source Ranking", "Ordinance Parsing", "Search",
                    "RAG / Retrieval", "Reasoning", "Calculation", "Prompting", "Context Window / Memory",
                    "Citation Generation", "Tool Selection", "User Experience", "Backend", "Frontend", "Unknown"],
    "finding_types": ["Bassett error", "citation problem", "outdated ordinance", "incorrect interpretation",
                      "incorrect calculation", "missing context", "hallucination", "incomplete response",
                      "failure to ask follow-up", "unnecessary follow-up", "poor guidance", "UX issue",
                      "competitor advantage", "Bassett advantage", "enhancement opportunity", "regression", "other"],
    "eval_dimensions": [
        {"key": "accuracy", "label": "Accuracy", "weight": 3},
        {"key": "current_code", "label": "Current Code Identification", "weight": 2},
        {"key": "interpretation", "label": "Legal / Regulatory Interpretation", "weight": 3},
        {"key": "calculation", "label": "Calculation Accuracy", "weight": 2},
        {"key": "context", "label": "Context Understanding", "weight": 2},
        {"key": "missing_info", "label": "Missing Information Recognition", "weight": 2},
        {"key": "followup", "label": "Follow-Up Handling", "weight": 1},
        {"key": "citation_accuracy", "label": "Citation Accuracy", "weight": 2},
        {"key": "source_quality", "label": "Source Quality", "weight": 1},
        {"key": "guidance", "label": "Guidance Quality", "weight": 1},
        {"key": "completeness", "label": "Completeness", "weight": 2},
        {"key": "usefulness", "label": "Usefulness", "weight": 3},
    ],
    "pass_results": ["Pass", "Pass with Minor Issues", "Needs Improvement", "Fail", "Critical Fail",
                     "Not Enough Evidence", "Not Evaluated"],
    "roles": ["admin", "qa_manager", "tester", "developer", "viewer"],
    "environments": ["Production", "Staging", "Development", "Experimental"],
    "version_types": ["Major", "Minor", "Patch", "Hotfix", "Experimental"],
    "release_channels": ["Production", "Staging", "Development", "Experimental"],
    "demo_statuses": ["Not Reviewed", "Potential Demo", "Needs Cleanup", "Approved", "Retired"],
    "bassett_workflow_stages": [
        {"name": "Research", "code": "R", "position": 1},
        {"name": "Analysis", "code": "A", "position": 2},
    ],
    "annotation_types": ["Incorrect Fact", "Citation Problem", "Hallucination", "Outdated Regulation",
                         "Misinterpretation", "Incorrect Calculation", "Missing Context", "Unsupported Claim", "Other"],
    "integrations": {"bassett_api_url": "https://api.zoneomics.com/v2/ask", "bassett_api_key": "",
                     "chatgpt_model": "gpt-5.4", "claude_model": "claude-sonnet-4-6"},
}

@app.on_event("startup")
async def startup():
    logger.info(
        "Starting database initialization with a %.1f-second timeout",
        DATABASE_STARTUP_TIMEOUT,
    )
    try:
        await asyncio.wait_for(
            db.connect(connect_timeout=DATABASE_STARTUP_TIMEOUT),
            timeout=DATABASE_STARTUP_TIMEOUT,
        )
    except asyncio.TimeoutError as error:
        logger.error(
            "Database initialization timed out after %.1f seconds before the health endpoint became available",
            DATABASE_STARTUP_TIMEOUT,
        )
        try:
            await asyncio.wait_for(db.close(), timeout=5)
        except Exception:
            logger.exception("Database cleanup failed after initialization timeout")
        raise RuntimeError(
            f"Database initialization timed out after {DATABASE_STARTUP_TIMEOUT:g} seconds"
        ) from error
    except Exception as error:
        logger.exception(
            "Database initialization failed before the health endpoint became available (%s)",
            type(error).__name__,
        )
        try:
            await asyncio.wait_for(db.close(), timeout=5)
        except Exception:
            logger.exception("Database cleanup failed after initialization error")
        raise
    logger.info("Database initialization completed")
    await db.users.create_index("email", unique=True)
    await db.users.create_index("id", unique=True)
    if (
        APP_ENV == "production"
        and not BOOTSTRAP_ADMIN_TOKEN
        and not await db.users.count_documents(
            {"role": "admin", "active": {"$ne": False}, "deleted_at": {"$exists": False}}
        )
    ):
        raise RuntimeError(
            "BOOTSTRAP_ADMIN_TOKEN must be configured until the first administrator is created"
        )
    try:
        await init_storage()
        logger.info("Object storage initialized")
    except Exception as e:
        logger.error(f"Object storage init failed: {e}")
    if not await db.config.find_one({"id": "global"}):
        await db.config.insert_one(dict(DEFAULT_CONFIG))
    else:
        cfg = await db.config.find_one({"id": "global"})
        patch = {}
        if "integrations" not in cfg:
            patch["integrations"] = DEFAULT_CONFIG["integrations"]
        if "annotation_types" not in cfg:
            patch["annotation_types"] = DEFAULT_CONFIG["annotation_types"]
        if "version_types" not in cfg:
            patch["version_types"] = DEFAULT_CONFIG["version_types"]
        if "release_channels" not in cfg:
            patch["release_channels"] = DEFAULT_CONFIG["release_channels"]
        if "bassett_workflow_stages" not in cfg:
            patch["bassett_workflow_stages"] = DEFAULT_CONFIG["bassett_workflow_stages"]
        else:
            normalized_stages = _normalize_bassett_config_stages(cfg["bassett_workflow_stages"])
            if normalized_stages != cfg["bassett_workflow_stages"]:
                patch["bassett_workflow_stages"] = normalized_stages
        if patch:
            await db.config.update_one({"id": "global"}, {"$set": patch})
    # These are system definitions, not client-provided defaults.  Preserve
    # administrator changes while making a fresh installation immediately usable.
    for name, code, position in (("Research", "R", 1), ("Analysis", "A", 2)):
        existing_stage = await db.bassett_workflow_stages.find_one({"code": code})
        if not existing_stage:
            await db.bassett_workflow_stages.insert_one({
                "id": f"bassett-stage-{code}", "name": name, "code": code,
                "position": position, "active": True, "seeded": True,
                "created_at": now_iso(), "updated_at": now_iso(),
            })
    await _seed_bassett_catalog()

@app.on_event("shutdown")
async def shutdown():
    await db.close()

from seed_data import run_seed_impl
async def run_seed():
    await run_seed_impl(db, new_id, now_iso)

