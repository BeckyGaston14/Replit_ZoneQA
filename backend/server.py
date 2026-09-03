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
        "sender_email": status.get("sender_email"),
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
    if not confirm:
        raise HTTPException(400, "Deletion requires confirm=true")
    if id == admin["id"]:
        raise HTTPException(409, "You cannot delete your own current account. Ask another active administrator to do this.")
    target = await db.users.find_one({"id": id})
    if not target or target.get("deleted_at"):
        raise HTTPException(404, "User not found")
    if target.get("active", True):
        raise HTTPException(409, "Deactivate the user before deleting them")
    if target.get("role") == "admin" and await _active_admin_count(id) == 0:
        raise HTTPException(409, "The last active administrator cannot be deleted")
    impact = await _user_impact(id)
    # Soft-delete and anonymize authentication data. IDs remain intact so historical QA
    # records, comments, evaluations, and audit trails never become orphaned.
    tombstone = f"deleted-{id}@invalid.local"
    await db.users.update_one({"id": id}, {"$set": {
        "name": "Deleted User", "email": tombstone, "role": "viewer", "active": False,
        "password_hash": "", "auth_provider": "deleted", "deleted_at": now_iso(),
        "password_history": [],
        "deleted_by": admin["id"], "updated_at": now_iso(),
    }, "$unset": {"picture": ""}})
    await _revoke_all_user_sessions(id)
    await log_activity("users", id, "deleted (history preserved)", admin,
                       json.dumps({"previous_email": target.get("email"), **impact}))
    return {"ok": True, "history_preserved": True, **impact}

# ---------- Generic collection CRUD factory ----------
COLLECTIONS = {
    "projects": "projects",
    "municipalities": "municipalities",
    "properties": "properties",
    "testcases": "testcases",
    "responses": "responses",
    "goldstandards": "goldstandards",
    "evidence": "evidence",
    "evaluations": "evaluations",
    "findings": "findings",
    "retests": "retests",
    "regression_suites": "regression_suites",
    "regression_runs": "regression_runs",
    "demos": "demos",
    "models": "models",
    "versions": "versions",
    "comments": "comments",
    "annotations": "annotations",
    "claims": "claims",
    "calendar_events": "calendar_events",
    "test_runs": "test_runs",
    "activities": "activities",
    "config": "config",
}

AUTOMATED_ACTIVITY_RE = re.compile(r"pytest|TEST_iter|TEST_i8|curl smoke|automated.test", re.I)

async def log_activity(entity_type, entity_id, action, user, detail=""):
    doc = {
        "id": new_id(), "entity_type": entity_type, "entity_id": entity_id,
        "action": action, "user": user.get("name", "system") if isinstance(user, dict) else str(user),
        "detail": detail, "created_at": now_iso(), "_log": True,
    }
    # Write-time hygiene: activities generated by automated test tooling are tagged so they
    # never pollute user-facing feeds (admin can still view via ?include_test_data=true).
    if AUTOMATED_ACTIVITY_RE.search(f"{action} {detail}"):
        doc["source"] = "automated_test"
    await db.activities.insert_one(doc)

def clean(doc):
    doc = dict(doc)
    doc.pop("_id", None)
    return doc

async def crud_list(coll, filt=None, include_archived=False):
    filt = filt or {}
    if coll in ("testcases", "projects", "municipalities", "properties") and not include_archived and "archived" not in filt:
        filt = {**filt, "archived": {"$ne": True}}
    docs = await db[coll].find(filt, {"_id": 0}).to_list(5000)
    return docs

async def crud_get(coll, id):
    doc = await db[coll].find_one({"id": id}, {"_id": 0})
    if not doc:
        raise HTTPException(404, f"{coll} not found")
    return doc

async def _require_active_testcase(identifier):
    if not identifier:
        return
    # Include id: the document repository correctly returns an empty mapping
    # for an all-missing sparse projection, which must not look like a missing
    # testcase.
    testcase = await db.testcases.find_one({"id": identifier}, {"_id": 0, "id": 1, "archived": 1})
    if not testcase:
        raise HTTPException(400, "Test case does not exist")
    if testcase and testcase.get("archived"):
        raise HTTPException(409, "Archived test cases and their linked history are read-only")

async def _guard_testcase_linked_document(document, entity_type=None):
    if not document:
        return
    testcase_id = document.get("testcase_id")
    if entity_type in ("testcase", "testcases"):
        testcase_id = document.get("entity_id")
    await _require_active_testcase(testcase_id)

async def _require_active_testcase_ids(identifiers):
    if not isinstance(identifiers, list) or not identifiers:
        raise HTTPException(400, detail={"testcase_ids": "Regression suite requires at least one Test Case ID"})
    identifiers = list(dict.fromkeys(str(identifier).strip() for identifier in identifiers))
    invalid = [identifier for identifier in identifiers if not identifier]
    existing = await db.testcases.find(
        {"id": {"$in": identifiers}}, {"_id": 0, "id": 1, "archived": 1}
    ).to_list(len(identifiers))
    existing_ids = {testcase["id"] for testcase in existing}
    missing = sorted(set(identifiers) - existing_ids)
    if invalid or missing:
        raise HTTPException(400, detail={"testcase_ids": {
            "message": "Regression suite contains missing or invalid Test Case IDs",
            "missing": missing, "invalid": invalid,
        }})
    archived = [testcase for testcase in existing if testcase.get("archived")]
    if archived:
        raise HTTPException(409, "Regression suites cannot include archived test cases")
    return identifiers


async def _require_reference(collection, identifier, label, *, allow_archived=False):
    if identifier in (None, ""):
        return None
    record = await db[collection].find_one({"id": str(identifier)}, {"_id": 0})
    if not record:
        raise HTTPException(400, f"{label} does not exist")
    if not allow_archived and (record.get("archived") or record.get("status") == "Archived"):
        raise HTTPException(409, f"{label} is archived")
    return record


async def _validate_relationships(coll, doc):
    """Validate flexible JSON relationships before persistence."""
    testcase = None
    if coll == "testcases":
        project = await _require_reference("projects", doc.get("project_id"), "Project")
        municipality = await _require_reference("municipalities", doc.get("municipality_id"), "Municipality")
        property_record = await _require_reference("properties", doc.get("property_id"), "Property")
        parent = await _require_reference("testcases", doc.get("variant_of"), "Parent test case")
        if parent and parent.get("id") == doc.get("id"):
            raise HTTPException(400, "A test case cannot be its own variant parent")
        if property_record and municipality and property_record.get("municipality_id") not in (None, "", municipality["id"]):
            raise HTTPException(400, "Property does not belong to the selected municipality")
        if parent and project and parent.get("project_id") not in (None, "", project["id"]):
            raise HTTPException(400, "Variant parent does not belong to the selected project")
        for evidence_id in doc.get("evidence_ids") or []:
            await _require_reference("evidence", evidence_id, "Evidence")
        return

    if doc.get("testcase_id"):
        testcase = await _require_reference("testcases", doc["testcase_id"], "Test case")
    project = await _require_reference("projects", doc.get("project_id"), "Project")
    municipality = await _require_reference("municipalities", doc.get("municipality_id"), "Municipality")
    property_record = await _require_reference("properties", doc.get("property_id"), "Property")
    finding = await _require_reference("findings", doc.get("finding_id"), "Finding", allow_archived=True)
    await _require_reference("retests", doc.get("retest_id"), "Retest", allow_archived=True)
    await _require_reference("regression_runs", doc.get("regression_run_id"), "Regression run", allow_archived=True)
    await _require_reference("evidence", doc.get("conflicts_with"), "Conflicting evidence", allow_archived=True)
    if testcase and project and testcase.get("project_id") not in (None, "", project["id"]):
        raise HTTPException(400, "Test case does not belong to the selected project")
    if testcase and municipality and testcase.get("municipality_id") not in (None, "", municipality["id"]):
        raise HTTPException(400, "Test case does not belong to the selected municipality")
    if testcase and property_record and testcase.get("property_id") not in (None, "", property_record["id"]):
        raise HTTPException(400, "Test case does not belong to the selected property")
    if finding and testcase and finding.get("testcase_id") not in (None, "", testcase["id"]):
        raise HTTPException(400, "Finding does not belong to the selected test case")
    if coll == "properties" and property_record is None and municipality:
        return

async def _validate_user_references(coll, incoming, existing=None):
    """Do not allow a new write to point at a missing or inactive account.

    Historical records deliberately remain readable after a user is deactivated
    or deleted.  Consequently an unchanged value on an update is not rejected.
    """
    for field in USER_REFERENCE_FIELDS.get(coll, ()):
        if field not in incoming:
            continue
        value = incoming.get(field)
        if value in (None, "") or (existing and existing.get(field) == value):
            continue
        account = await db.users.find_one(
            {"id": str(value), "active": {"$ne": False}, "deleted_at": {"$exists": False}},
            {"_id": 0, "id": 1},
        )
        if not account:
            raise HTTPException(400, f"{field} must reference an active user")

def _require_fresh_version(existing, supplied):
    """Optional optimistic lock shared by normal JSON edit routes.

    Compatibility is intentional: pre-concurrency clients may omit both
    fields, while clients that supply either receive a useful conflict rather
    than silently overwriting another editor.
    """
    expected_updated_at = supplied.get("expected_updated_at")
    expected_revision = supplied.get("expected_revision")
    if expected_updated_at is not None and expected_updated_at != existing.get("updated_at"):
        raise HTTPException(409, detail={
            "code": "stale_update", "message": "This record has changed; reload before saving.",
            "expected_updated_at": expected_updated_at, "current_updated_at": existing.get("updated_at"),
            "current_revision": existing.get("revision", 1),
        })
    if expected_revision is not None:
        try:
            expected_revision = int(expected_revision)
        except (TypeError, ValueError):
            raise HTTPException(400, "expected_revision must be an integer")
        if expected_revision != int(existing.get("revision", 1)):
            raise HTTPException(409, detail={
                "code": "stale_update", "message": "This record has changed; reload before saving.",
                "expected_revision": expected_revision, "current_revision": existing.get("revision", 1),
                "current_updated_at": existing.get("updated_at"),
            })


RESOURCE_REQUIRED_FIELDS = {
    "projects": {"name": "Project name"},
    "municipalities": {"name": "Municipality name", "state": "State"},
    "properties": {
        "name": "Property name",
        "address": "Property address",
        "municipality_id": "Municipality",
    },
    "evidence": {
        "document_name": "Document name",
        "municipality_id": "Municipality",
    },
    "demos": {
        "testcase_id": "Test case",
        "why_good": "Why this is a strong demo",
    },
    "models": {"name": "Model name"},
}


def _validate_resource_required_fields(coll, document):
    errors = {
        field: f"{label} is required"
        for field, label in RESOURCE_REQUIRED_FIELDS.get(coll, {}).items()
        if not str(document.get(field) or "").strip()
    }
    if errors:
        raise HTTPException(400, detail=errors)


MODEL_ROLE_TYPES = {"Primary", "Benchmark"}


def _normalize_model(document, *, partial=False):
    """Keep model administration predictable without storing provider secrets."""
    normalized = dict(document)
    for field in ("name", "provider", "model_name"):
        if field in normalized:
            normalized[field] = str(normalized.get(field) or "").strip()
    if not partial or "role_type" in normalized:
        role_type = str(normalized.get("role_type") or "Benchmark").strip().title()
        if role_type not in MODEL_ROLE_TYPES:
            raise HTTPException(400, "Model type must be Primary or Benchmark")
        normalized["role_type"] = role_type
    if "active" in normalized:
        normalized["active"] = bool(normalized["active"])
    elif not partial:
        normalized["active"] = True
    return normalized


async def crud_create(coll, body, user):
    doc = dict(body)
    if coll == "models":
        if user.get("role") not in ("admin", "qa_manager"):
            raise HTTPException(403, "Only administrators and QA managers can manage models")
        doc = _normalize_model(doc)
    _validate_resource_required_fields(coll, doc)
    await _validate_user_references(coll, doc)
    if coll == "retests":
        raise HTTPException(409, "Retests must be started from a finding")
    if coll == "testcases":
        lifecycle_fields = {"archived", "archived_at", "archived_by", "archived_status"}
        if lifecycle_fields.intersection(doc):
            raise HTTPException(409, "Test case lifecycle fields can only be changed through archive and restore actions")
        _validate_and_normalize_testcase(doc)
    elif coll == "projects":
        _prepare_project_completion_input(doc)
    elif coll == "regression_suites":
        doc["testcase_ids"] = await _require_active_testcase_ids(doc.get("testcase_ids"))
    elif coll == "evaluations":
        await _apply_authoritative_evaluation_fields(doc)
    elif doc.get("testcase_id"):
        await _require_active_testcase(doc["testcase_id"])
    if coll == "evaluations":
        config = await db.config.find_one({"id": "global"}, {"_id": 0}) or DEFAULT_CONFIG
        doc = authoritative_score_update(
            doc, config.get("eval_dimensions", []), creating=True,
        )
        if doc.get("final_result") == doc["system_recommended"]:
            doc["override_reason"] = ""
    await _validate_relationships(coll, doc)
    if coll == "test_runs":
        doc["test_date"] = _validate_test_date(doc.get("test_date"))
    if coll == "findings":
        doc["developer_status"] = _validate_finding_status(
            doc.get("developer_status") or "New",
            await _configured_finding_statuses(),
        )
    if coll == "versions" and user.get("role") not in ("admin", "qa_manager"):
        raise HTTPException(403, "Only administrators and QA managers can manage Bassett versions")
    if coll == "versions":
        if not str(doc.get("name") or "").strip() or not str(doc.get("release_number") or "").strip():
            raise HTTPException(400, "Version name and release number are required")
        doc["name"] = str(doc["name"]).strip()
        doc["release_number"] = str(doc["release_number"]).strip()
        cfg = await db.config.find_one({"id": "global"}, {"_id": 0}) or DEFAULT_CONFIG
        if doc.get("version_type") and doc["version_type"] not in cfg.get("version_types", []):
            raise HTTPException(400, "Invalid Bassett version type")
        if doc.get("release_channel") and doc["release_channel"] not in cfg.get("release_channels", []):
            raise HTTPException(400, "Invalid release channel")
        duplicate = await db.versions.find_one({"$or": [{"name": doc.get("name")}, {"release_number": doc.get("release_number")}]})
        if duplicate:
            raise HTTPException(409, "A Bassett version with this name or release number already exists")
    if coll == "models" and await db.models.find_one({"name": doc["name"]}):
        raise HTTPException(409, "A model with this display name already exists")
    doc["id"] = doc.get("id") or new_id()
    doc["created_at"] = now_iso()
    doc["created_by"] = user["name"]
    doc["updated_at"] = now_iso()
    doc["revision"] = int(doc.get("revision") or 1)
    collection = db[coll]
    if coll == "versions" and doc.get("active") and hasattr(collection, "insert_active_version"):
        await collection.insert_active_version(doc)
    else:
        if coll == "versions" and doc.get("active"):
            await db.versions.update_many({}, {"$set": {"active": False}})
        await collection.insert_one(doc)
    await log_activity(coll, doc["id"], "created", user, doc.get("name") or doc.get("title") or "")
    return clean(doc)

async def crud_update(coll, id, body, user):
    if coll == "models":
        if user.get("role") not in ("admin", "qa_manager"):
            raise HTTPException(403, "Only administrators and QA managers can manage models")
        body = _normalize_model(body, partial=True)
    if coll == "versions" and user.get("role") not in ("admin", "qa_manager"):
        raise HTTPException(403, "Only administrators and QA managers can manage Bassett versions")
    if coll == "versions":
        cfg = await db.config.find_one({"id": "global"}, {"_id": 0}) or DEFAULT_CONFIG
        if body.get("version_type") and body["version_type"] not in cfg.get("version_types", []):
            raise HTTPException(400, "Invalid Bassett version type")
        if body.get("release_channel") and body["release_channel"] not in cfg.get("release_channels", []):
            raise HTTPException(400, "Invalid release channel")
        duplicate_filters = []
        if body.get("name"):
            duplicate_filters.append({"name": body["name"]})
        if body.get("release_number"):
            duplicate_filters.append({"release_number": body["release_number"]})
        if duplicate_filters and await db.versions.find_one({"id": {"$ne": id}, "$or": duplicate_filters}):
            raise HTTPException(409, "A Bassett version with this name or release number already exists")
    if coll == "regression_runs":
        existing = await db[coll].find_one({"id": id}, {"_id": 0, "locked": 1})
        if existing and existing.get("locked"):
            raise HTTPException(403, "Regression runs are locked historical records and cannot be edited")
    if coll == "testcases":
        lifecycle_fields = {"archived", "archived_at", "archived_by", "archived_status"}
        if lifecycle_fields.intersection(body):
            raise HTTPException(409, "Test case lifecycle fields can only be changed through archive and restore actions")
    existing_for_references = await db[coll].find_one({"id": id}, {"_id": 0})
    if not existing_for_references:
        raise HTTPException(404, "Not found")
    _validate_resource_required_fields(coll, {**existing_for_references, **body})
    if coll == "models" and body.get("name") and await db.models.find_one({"id": {"$ne": id}, "name": body["name"]}):
        raise HTTPException(409, "A model with this display name already exists")
    if existing_for_references.get("archived") or existing_for_references.get("status") == "Archived":
        raise HTTPException(409, "Archived records are immutable; historical reads are preserved")
    _require_fresh_version(existing_for_references, body)
    if coll == "projects":
        _prepare_project_completion_input(body, existing_for_references)
    if coll == "evaluations":
        await _apply_authoritative_evaluation_fields(body, existing_for_references)
    await _validate_user_references(coll, body, existing_for_references)
    if coll != "testcases":
        linked = await db[coll].find_one({"id": id}, {"_id": 0})
        await _guard_testcase_linked_document(linked)
        await _guard_testcase_linked_document(
            {**(linked or {}), **body},
            body.get("entity_type") or (linked or {}).get("entity_type"),
        )
        if coll == "regression_suites" and "testcase_ids" in body:
            body["testcase_ids"] = await _require_active_testcase_ids(body.get("testcase_ids"))
    body = {k: v for k, v in body.items() if k not in (
        "id", "created_at", "created_by", "_id", "expected_updated_at", "expected_revision", "revision",
    )}
    if coll == "evaluations":
        config = await db.config.find_one({"id": "global"}, {"_id": 0}) or DEFAULT_CONFIG
        body = authoritative_score_update(body, config.get("eval_dimensions", []))
        merged_evaluation = {**existing_for_references, **body}
        if merged_evaluation.get("final_result") == merged_evaluation.get("system_recommended"):
            body["override_reason"] = ""
    if coll in ("test_runs", "retests", "regression_runs") and "test_date" in body:
        body["test_date"] = _validate_test_date(body.get("test_date"))
    if coll == "findings" and "developer_status" in body:
        existing_finding = await db.findings.find_one({"id": id}, {"_id": 0})
        if not existing_finding:
            raise HTTPException(404, "Not found")
        requested_status = _validate_finding_status(
            body["developer_status"], await _configured_finding_statuses()
        )
        if requested_status != existing_finding.get("developer_status"):
            raise HTTPException(409, "Use the finding status workflow to change developer_status")
        body["developer_status"] = requested_status
    if coll == "retests" and {"status", "verdict", "outcome", "finding_id", "testcase_id"}.intersection(body):
        raise HTTPException(409, "Use the retest workflow endpoints to change retest state")
    if coll == "testcases":
        # Validate the resulting document, rather than treating a partial edit
        # as a replacement.  Older clients commonly update one field at a time.
        existing = await db[coll].find_one({"id": id}, {"_id": 0})
        if not existing:
            raise HTTPException(404, "Not found")
        if existing.get("archived"):
            raise HTTPException(409, "Archived test cases must be restored before editing")
        merged = {**existing, **body}
        _validate_and_normalize_testcase(merged)
        await _validate_relationships(coll, merged)
        body["name"] = merged["name"]
        body["prompts"] = merged["prompts"]
    else:
        await _validate_relationships(coll, {**(linked or {}), **body})
    body["updated_at"] = now_iso()
    body["revision"] = int(existing_for_references.get("revision", 1)) + 1
    # The revision predicate is checked while PostgreSQL holds a row lock.
    # This closes the read/check/write race: concurrent editors that started
    # from the same revision cannot both replace the record.
    write_revision = int(existing_for_references.get("revision", 1))
    revision_predicate = (
        {"$or": [{"revision": 1}, {"revision": {"$exists": False}}]}
        if write_revision == 1
        else {"revision": write_revision}
    )
    collection = db[coll]
    if coll == "versions" and body.get("active") and hasattr(collection, "activate_version"):
        res = await collection.activate_version(
            {"id": id, **revision_predicate}, {"$set": body}
        )
    else:
        if coll == "versions" and body.get("active"):
            await db.versions.update_many({"id": {"$ne": id}}, {"$set": {"active": False}})
        res = await collection.find_one_and_update(
            {"id": id, **revision_predicate},
            {"$set": body},
            return_document=True,
        )
    if not res:
        current = await db[coll].find_one({"id": id}, {"_id": 0})
        if not current:
            raise HTTPException(404, "Not found")
        raise HTTPException(409, detail={
            "code": "stale_update",
            "message": "Someone else saved changes to this record. Reload the latest version, review it, and reapply your edits.",
            "current_updated_at": current.get("updated_at"),
            "current_revision": current.get("revision", 1),
        })
    await log_activity(coll, id, "updated", user)
    return clean(res)

def _validate_and_normalize_testcase(doc):
    """Apply the API's canonical test-case input shape before it is stored."""
    name = str(doc.get("name") or "").strip()
    if not name:
        raise HTTPException(400, "Test case name is required")
    prompts = doc.get("prompts")
    if not isinstance(prompts, list):
        raise HTTPException(400, "Test case prompts must be a list")
    normalized = []
    for prompt in prompts:
        if isinstance(prompt, str):
            prompt = {"text": prompt}
        if not isinstance(prompt, dict):
            continue
        text = str(prompt.get("text") or "").strip()
        if not text:
            continue
        # Turns are defined by their submitted conversation order.  Re-numbering
        # makes duplicate, missing, and non-numeric client turn values harmless.
        normalized.append({**prompt, "turn": len(normalized) + 1, "text": text})
    if not normalized:
        raise HTTPException(400, "At least one nonblank test case prompt is required")
    doc["name"] = name
    doc["prompts"] = normalized
    if "test_date" in doc:
        doc["test_date"] = _validate_test_date(doc.get("test_date"), required=False)


COMPARISON_WORKFLOW_MODELS = ("Bassett", "ChatGPT", "Claude")
COMPARISON_WORKFLOW_FIELDS = (
    "comparison_result", "comparison_classification", "competitive_advantage",
    "competitive_gap", "comparison_notes",
)


async def _prepare_comparison_workflow(
    body: Dict[str, Any], user: Dict[str, Any], *, require_scenario: bool = True
):
    """Normalize the shared entry form into stable testcase child records."""
    if not isinstance(body, dict):
        raise HTTPException(400, "Workflow payload must be an object")
    testcase = dict(body.get("testcase") or {})
    if not testcase:
        testcase = {key: body.get(key) for key in (
            "name", "title", "prompts", "project_id", "municipality_id", "property_id",
            "scenario_id", "workflow_stage", "test_date", "bassett_version", "version_id",
            "status", "test_type", "category", "criticality", "difficulty", "assignee_id",
            "notes", "reproduction_steps", "environment", "priority",
        ) if key in body}
    scenario_id = str(testcase.get("scenario_id") or "").strip()
    if not scenario_id and require_scenario:
        raise HTTPException(400, detail={"scenario_id": "A Test Bank scenario is required"})
    scenario = {}
    if scenario_id:
        scenario = await _bassett_ref("bassett_scenarios", scenario_id, "Bassett scenario")
        if scenario.get("archived"):
            raise HTTPException(400, "Archived Test Bank scenarios cannot be used for new tests")
        testcase["scenario_id"] = scenario_id
        testcase["workflow_stage"] = scenario.get("workflow_stage")
    testcase["name"] = str(testcase.get("name") or testcase.get("title") or scenario.get("test_scenario") or "").strip()
    if not testcase.get("prompts"):
        question = str(body.get("question_asked") or body.get("prompt") or "").strip()
        testcase["prompts"] = [{"turn": 1, "text": question}] if question else []
    original_testcase_id = testcase.get("id")
    _validate_and_normalize_testcase(testcase)
    testcase.pop("id", None)
    testcase.pop("test_id", None)
    await _validate_user_references("testcases", testcase)
    await _validate_relationships("testcases", testcase)
    timestamp = now_iso()
    testcase.update({
        "status": testcase.get("status") or "Draft",
        "test_type": testcase.get("test_type") or "Competitive Benchmark",
        "test_date": _validate_test_date(testcase.get("test_date"), required=require_scenario),
        "created_at": timestamp, "updated_at": timestamp,
        "created_by": user.get("name"), "created_by_id": user.get("id"),
        "revision": 1, "archived": False, "comparison_mode": True,
    })
    gold_input = body.get("gold_standard") if isinstance(body.get("gold_standard"), dict) else {}
    verified_answer = str(
        gold_input.get("answer") or gold_input.get("verified_correct_answer")
        or body.get("verified_correct_answer") or body.get("gold_standard_answer") or ""
    ).strip()
    goldstandard = {
        "id": new_id(), "testcase_id": "",
        "answer": verified_answer, "verified_correct_answer": verified_answer,
        "review_status": gold_input.get("review_status") or "Draft",
        "source": gold_input.get("source") or "Unified comparison workflow",
        "explanation": gold_input.get("explanation") or "",
        "created_at": timestamp, "updated_at": timestamp, "created_by": user.get("name"),
    }
    responses, evaluations = [], []
    response_input = body.get("responses") if isinstance(body.get("responses"), dict) else {}
    evaluation_input = body.get("evaluations") if isinstance(body.get("evaluations"), dict) else {}
    configured = await db.config.find_one({"id": "global"}, {"_id": 0}) or DEFAULT_CONFIG
    allowed_results = set(configured.get("pass_results") or DEFAULT_CONFIG["pass_results"])
    for model in COMPARISON_WORKFLOW_MODELS:
        incoming_response = response_input.get(model)
        incoming_response = incoming_response if isinstance(incoming_response, dict) else {}
        raw_response = str(incoming_response.get("response") or "").strip()
        responses.append({
            "id": incoming_response.get("id") or new_id(), "testcase_id": "", "model": model,
            "response": raw_response, "availability": "available" if raw_response else "unavailable",
            "unavailable_reason": None if raw_response else "Not entered",
            "version": incoming_response.get("version") or "",
            "model_name": incoming_response.get("model_name") or incoming_response.get("model") or model,
            "model_version": incoming_response.get("model_version") or "",
            "test_date": incoming_response.get("test_date") or testcase["test_date"],
            "settings": incoming_response.get("settings") or {}, "citations": incoming_response.get("citations") or "",
            "created_at": timestamp, "updated_at": timestamp, "created_by": user.get("name"),
        })
        incoming_evaluation = evaluation_input.get(model)
        incoming_evaluation = incoming_evaluation if isinstance(incoming_evaluation, dict) else {}
        raw_scores = incoming_evaluation.get("scores") or {}
        authoritative = await _evaluation_score_fields(raw_scores)
        normalized_scores = {
            key: value for key, value in raw_scores.items()
            if value not in (None, "")
        }
        final_result = incoming_evaluation.get("final_result")
        if model == "Bassett" and not final_result:
            final_result = testcase.get("result")
        final_result = final_result or authoritative["system_recommended"] or "Not Evaluated"
        if final_result not in allowed_results:
            raise HTTPException(400, detail={"evaluations": f"Invalid {model} evaluation result"})
        evaluations.append({
            "id": incoming_evaluation.get("id") or new_id(), "testcase_id": "", "model": model,
            "scores": normalized_scores,
            "availability": "available" if authoritative["overall_score"] is not None else "unavailable",
            "unavailable_reason": None if authoritative["overall_score"] is not None else "Not entered",
            "status": "Completed" if authoritative["overall_score"] is not None else "Unavailable",
            "final_result": final_result,
            **{key: authoritative[key] for key in EVALUATION_DERIVED_FIELDS},
            "bassett_version": testcase.get("bassett_version") or "", "test_date": testcase["test_date"],
            "created_at": timestamp, "updated_at": timestamp, "created_by": user.get("name"),
        })
    comparison = body.get("comparison") if isinstance(body.get("comparison"), dict) else {}
    testcase.update({key: comparison.get(key) for key in COMPARISON_WORKFLOW_FIELDS if comparison.get(key) is not None})
    testcase["source_bassett_issue_id"] = testcase.get("source_bassett_issue_id") or body.get("source_bassett_issue_id")
    if testcase.get("source_bassett_issue_id"):
        source_issue = await _bassett_ref(
            "bassett_issues", testcase["source_bassett_issue_id"], "Source Bassett test"
        )
        if source_issue.get("testcase_id") not in (None, "", original_testcase_id):
            raise HTTPException(409, "Source Bassett test is already linked to another comparison")
    for model, field in (("Bassett", "bassett_evaluation_scores"), ("ChatGPT", "chatgpt_evaluation_scores"), ("Claude", "claude_evaluation_scores")):
        value = evaluation_input.get(model)
        testcase[field] = dict(value.get("scores") or {}) if isinstance(value, dict) else {}
    return testcase, goldstandard, responses, evaluations


def _comparison_finding_documents(body, testcase_id, user, timestamp):
    comparison = body.get("comparison") if isinstance(body.get("comparison"), dict) else {}
    values = comparison.get("findings") or body.get("comparison_findings") or []
    if isinstance(values, dict):
        values = [values]
    documents = []
    for value in values if isinstance(values, list) else []:
        if not isinstance(value, dict) or not str(value.get("title") or value.get("description") or "").strip():
            continue
        documents.append({
            "id": value.get("id") or new_id(), "testcase_id": testcase_id,
            "project_id": value.get("project_id"), "title": value.get("title") or "Comparison finding",
            "description": value.get("description") or "", "finding_type": value.get("finding_type") or "other",
            "criticality": value.get("criticality") or 3, "priority": value.get("priority") or "Medium",
            "developer_status": value.get("developer_status") or "New",
            "assignee_id": value.get("assignee_id"),
            "source": "model_comparison", "finding_scope": "comparison",
            "model": value.get("model") or "Comparison",
            "created_at": timestamp, "updated_at": timestamp, "created_by": user.get("name"), "revision": 1,
        })
    return documents


def _bassett_finding_document(body, testcase_id, user, timestamp):
    testcase = body.get("testcase") if isinstance(body.get("testcase"), dict) else body
    finding = testcase.get("finding") if isinstance(testcase.get("finding"), dict) else {}
    if not testcase.get("create_finding") and not finding:
        return None
    if not str(finding.get("title") or finding.get("description") or "").strip():
        return None
    return {
        "id": finding.get("id") or new_id(), "testcase_id": testcase_id,
        "project_id": testcase.get("project_id"), "title": finding.get("title") or "Bassett finding",
        "description": finding.get("description") or "", "finding_type": finding.get("finding_type") or "Bassett error",
        "criticality": finding.get("criticality") or testcase.get("criticality") or 3,
        "priority": finding.get("priority") or testcase.get("priority") or "Medium",
        "developer_status": finding.get("developer_status") or "New",
        "assignee_id": finding.get("assignee_id") or testcase.get("assignee_id"),
        "source": "bassett_only", "finding_scope": "bassett",
        "model": "Bassett", "created_at": timestamp, "updated_at": timestamp,
        "created_by": user.get("name"), "revision": 1,
    }


@api.post("/testcases/workflow")
async def testcase_workflow(
    payload: str = Form(...),
    files: List[UploadFile] = File(default=[]),
    user=Depends(require_writer),
):
    """Create a full Model Comparison entry using the shared workflow form."""
    try:
        body = json.loads(payload)
    except (TypeError, json.JSONDecodeError):
        raise HTTPException(400, "Workflow payload must be valid JSON")
    testcase, goldstandard, responses, evaluations = await _prepare_comparison_workflow(body, user)
    testcase_id = new_id()
    testcase["id"] = testcase_id
    goldstandard["testcase_id"] = testcase_id
    for document in (*responses, *evaluations):
        document["testcase_id"] = testcase_id
    findings = _comparison_finding_documents(body, testcase_id, user, testcase["created_at"])
    bassett_finding = _bassett_finding_document(body, testcase_id, user, testcase["created_at"])
    if bassett_finding:
        findings.append(bassett_finding)
    uploaded_paths, attachments = [], []
    try:
        for file in files or []:
            original_filename = file.filename or "attachment"
            ext = original_filename.rsplit(".", 1)[-1].lower() if "." in original_filename else ""
            if ext not in ALLOWED_EXT:
                raise HTTPException(400, f"File type .{ext} not allowed. Allowed: {', '.join(sorted(ALLOWED_EXT))}")
            try:
                file_bytes = await read_attachment_bytes(file)
            finally:
                await file.close()
            path = f"{APP_STORAGE_PREFIX}/uploads/testcase/{new_id()}.{ext}"
            await app_storage.upload_bytes(path, file_bytes, ALLOWED_CONTENT_TYPES[ext])
            uploaded_paths.append(path)
            attachments.append({
                "id": new_id(), "entity_type": "testcase", "entity_id": testcase_id,
                "storage_path": path, "storage_provider": "replit",
                "original_filename": original_filename, "content_type": ALLOWED_CONTENT_TYPES[ext],
                "size": len(file_bytes), "is_deleted": False, "uploaded_by_id": user["id"],
                "uploaded_by": user.get("name"), "created_at": testcase["created_at"],
                "updated_at": testcase["updated_at"],
            })
        activity = {
            "id": new_id(), "entity_type": "testcases", "entity_id": testcase_id,
            "action": "created", "user": user.get("name", "system"),
            "detail": testcase["name"], "created_at": testcase["created_at"], "_log": True,
        }
        creation_key = str(body.get("submission_id") or "").strip() or hashlib.sha256(
            f"{user['id']}|{testcase['scenario_id']}|{testcase['test_date']}|{testcase['name']}".encode()
        ).hexdigest()
        stored, created = await db.create_testcase_workflow(
            testcase, goldstandard, responses, evaluations, findings, attachments, activity,
            creation_key=creation_key,
        )
        if not created:
            await _uploaded_storage_cleanup(uploaded_paths)
            return {"testcase": clean(stored), "idempotent_replay": True}
        return {
            "testcase": clean(stored), "gold_standard": clean(goldstandard),
            "responses": [clean(item) for item in responses],
            "evaluations": [clean(item) for item in evaluations],
            "findings": [clean(item) for item in findings],
            "attachments": [clean(item) for item in attachments],
            "idempotent_replay": False,
        }
    except Exception:
        await _uploaded_storage_cleanup(uploaded_paths)
        raise


@api.post("/testcases/{id}/comparison-workflow")
async def update_testcase_workflow(
    id: str,
    payload: str = Form(...),
    files: List[UploadFile] = File(default=[]),
    user=Depends(require_writer),
):
    """Complete an expanded Bassett comparison without duplicating source records."""
    try:
        body = json.loads(payload)
    except (TypeError, json.JSONDecodeError):
        raise HTTPException(400, "Workflow payload must be valid JSON")
    current = await crud_get("testcases", id)
    if current.get("source_bassett_issue_id") and body.get("source_bassett_issue_id") not in (None, current.get("source_bassett_issue_id")):
        raise HTTPException(409, "The source Bassett relationship is locked")
    testcase, goldstandard, responses, evaluations = await _prepare_comparison_workflow(
        {**body, "testcase": {**current, **(body.get("testcase") or {}), "id": id}},
        user,
        require_scenario=False,
    )
    common_locked = {"project_id", "municipality_id", "property_id", "scenario_id", "test_date", "bassett_version"}
    requested = body.get("testcase") if isinstance(body.get("testcase"), dict) else {}
    if current.get("source_bassett_issue_id") and any(
        key in requested and requested.get(key) != current.get(key)
        for key in common_locked
    ):
        raise HTTPException(409, "Common Bassett-linked fields are locked after expansion")
    update_fields = (
        "name", "prompts", "project_id", "municipality_id", "property_id",
        "scenario_id", "workflow_stage", "test_date", "bassett_version", "version_id",
        "status", "test_type", "category", "criticality", "difficulty", "assignee_id",
        "notes", "reproduction_steps", "environment", "priority", "follow_up_action",
        "retest_target", "retest_date", "retest_id", "regression_run_id", "source_links",
        "comparison_result", "comparison_classification", "competitive_advantage",
        "competitive_gap", "comparison_notes", "bassett_evaluation_scores",
        "chatgpt_evaluation_scores", "claude_evaluation_scores",
    )
    testcase_updates = {key: testcase.get(key) for key in update_fields if key in testcase}
    testcase_updates["updated_at"] = now_iso()
    if current.get("source_bassett_issue_id"):
        for key in common_locked | {"name", "prompts", "version_id", "environment", "bassett_evaluation_scores"}:
            testcase_updates.pop(key, None)
    goldstandard["testcase_id"] = id
    for document in (*responses, *evaluations):
        document["testcase_id"] = id
    findings = _comparison_finding_documents(body, id, user, now_iso())
    bassett_finding = _bassett_finding_document(body, id, user, now_iso())
    if bassett_finding:
        findings.append(bassett_finding)
    uploaded_paths, attachments = [], []
    try:
        for file in files or []:
            original_filename = file.filename or "attachment"
            ext = original_filename.rsplit(".", 1)[-1].lower() if "." in original_filename else ""
            if ext not in ALLOWED_EXT:
                raise HTTPException(400, f"File type .{ext} not allowed. Allowed: {', '.join(sorted(ALLOWED_EXT))}")
            try:
                file_bytes = await read_attachment_bytes(file)
            finally:
                await file.close()
            path = f"{APP_STORAGE_PREFIX}/uploads/testcase/{new_id()}.{ext}"
            await app_storage.upload_bytes(path, file_bytes, ALLOWED_CONTENT_TYPES[ext])
            uploaded_paths.append(path)
            attachments.append({
                "id": new_id(), "entity_type": "testcase", "entity_id": id,
                "storage_path": path, "storage_provider": "replit",
                "original_filename": original_filename, "content_type": ALLOWED_CONTENT_TYPES[ext],
                "size": len(file_bytes), "is_deleted": False, "uploaded_by_id": user["id"],
                "uploaded_by": user.get("name"), "created_at": now_iso(), "updated_at": now_iso(),
            })
        stored = await db.update_testcase_workflow(
            id, testcase_updates, responses, evaluations, findings, attachments,
            goldstandard=goldstandard,
            expected_revision=body.get("expected_revision"),
        )
    except Exception:
        await _uploaded_storage_cleanup(uploaded_paths)
        raise
    if stored is None:
        await _uploaded_storage_cleanup(uploaded_paths)
        raise HTTPException(404, "Test case not found")
    if stored.get("error") == "stale":
        await _uploaded_storage_cleanup(uploaded_paths)
        raise HTTPException(409, detail={"code": "stale_update", "current_revision": stored["current"].get("revision", 1), "current_updated_at": stored["current"].get("updated_at")})
    if stored.get("error") == "revision_required":
        await _uploaded_storage_cleanup(uploaded_paths)
        raise HTTPException(409, detail={"code": "revision_required", "message": "Reload before saving this comparison", "current_revision": stored["current"].get("revision", 1)})
    if stored.get("error") == "archived":
        await _uploaded_storage_cleanup(uploaded_paths)
        raise HTTPException(409, "Archived test cases are immutable")
    return {
        "testcase": clean(stored),
        "responses": [clean(item) for item in responses],
        "evaluations": [clean(item) for item in evaluations],
        "findings": [clean(item) for item in findings],
    }


async def _testcase_dependency_counts(identifier):
    """Return every known testcase dependency, including flexible JSON links."""
    checks = {
        "responses": ("responses", {"testcase_id": identifier}),
        "evaluations": ("evaluations", {"testcase_id": identifier}),
        "gold_standards": ("goldstandards", {"testcase_id": identifier}),
        "findings": ("findings", {"testcase_id": identifier}),
        "retests": ("retests", {"testcase_id": identifier}),
        "test_runs": ("test_runs", {"testcase_id": identifier}),
        "demos": ("demos", {"testcase_id": identifier}),
        "annotations": ("annotations", {"testcase_id": identifier}),
        "claims": ("claims", {"testcase_id": identifier}),
        "comments": ("comments", {"entity_id": identifier}),
        "activities": ("activities", {"entity_id": identifier, "source": {"$ne": "testcase_lifecycle_audit"}, "action": {"$ne": "created"}}),
        "attachments": ("attachments", {"$or": [
            {"entity_id": identifier, "entity_type": {"$in": ["testcase", "testcases"]}},
            {"linked_testcase_id": identifier},
        ]}),
        "calendar_records": ("calendar_events", {"testcase_id": identifier}),
        "bassett_issues": ("bassett_issues", {"testcase_id": identifier}),
        "test_bank_links": ("bassett_scenarios", {"testcase_id": identifier}),
        "test_bank_executions": ("bassett_executions", {"testcase_id": identifier}),
        "regression_runs": ("regression_runs", {"testcase_ids": identifier}),
        "variants": ("testcases", {"variant_of": identifier}),
    }
    counts = {name: await db[collection].count_documents(query) for name, (collection, query) in checks.items()}
    testcase = await db.testcases.find_one({"id": identifier}, {"_id": 0, "evidence_ids": 1})
    counts["evidence"] = len((testcase or {}).get("evidence_ids") or [])
    counts["objects"] = counts["attachments"]
    counts["expanded_comparisons"] = 1 if (testcase or {}).get("bassett_issue_id") else 0
    return counts


async def _log_testcase_lifecycle(identifier, action, user, detail):
    await db.activities.insert_one({
        "id": new_id(), "entity_type": "testcases", "entity_id": identifier,
        "action": action, "user": user.get("name", "system"), "detail": detail,
        "created_at": now_iso(), "source": "testcase_lifecycle_audit", "_log": True,
    })


def _deletion_preflight_token(identifier, updated_at, dependencies):
    payload = json.dumps(
        {"id": identifier, "updated_at": updated_at, "dependencies": dependencies,
         "expires_at": (datetime.now(timezone.utc) + timedelta(minutes=10)).isoformat()},
        sort_keys=True, separators=(",", ":"),
    ).encode()
    encoded = base64.urlsafe_b64encode(payload).decode().rstrip("=")
    return f"{encoded}.{hmac.new(SESSION_SECRET.encode(), encoded.encode(), hashlib.sha256).hexdigest()}"


def _verify_deletion_preflight_token(token, identifier, updated_at, dependencies):
    try:
        encoded, signature = token.split(".", 1)
        expected = hmac.new(SESSION_SECRET.encode(), encoded.encode(), hashlib.sha256).hexdigest()
        if not hmac.compare_digest(signature, expected):
            raise ValueError
        payload = json.loads(base64.urlsafe_b64decode(encoded + "=" * (-len(encoded) % 4)))
        expires_at = datetime.fromisoformat(payload["expires_at"])
        if expires_at <= datetime.now(timezone.utc):
            raise ValueError
        if payload["id"] != identifier or payload["updated_at"] != updated_at or payload["dependencies"] != dependencies:
            raise ValueError
    except (ValueError, KeyError, TypeError, json.JSONDecodeError, UnicodeDecodeError):
        raise HTTPException(409, "Deletion preflight is stale. Run preflight again.")


@api.get("/testcases/{id}/deletion-preflight")
async def testcase_deletion_preflight(id: str, admin=Depends(require_roles("admin"))):
    testcase = await crud_get("testcases", id)
    dependencies = await _testcase_dependency_counts(id)
    blockers = {key: count for key, count in dependencies.items() if count}
    result = {
        "testcase": {"id": testcase["id"], "name": testcase.get("name", ""), "archived": bool(testcase.get("archived"))},
        "policy": {"allowed": not blockers, "requires_archive_for_dependencies": True},
        "dependencies": dependencies, "blockers": blockers,
        "preflight_token": _deletion_preflight_token(id, testcase.get("updated_at"), dependencies),
    }
    await _log_testcase_lifecycle(
        id, "permanent deletion preflight", admin,
        json.dumps({"allowed": not blockers, "dependencies": dependencies}),
    )
    return result


@api.post("/testcases/{id}/archive")
async def archive_testcase(id: str, user=Depends(require_roles("admin", "qa_manager"))):
    testcase = await crud_get("testcases", id)
    if testcase.get("archived"):
        return testcase
    updated = await db.testcases.find_one_and_update({"id": id}, {"$set": {
        "archived": True, "archived_at": now_iso(), "archived_by": user["id"],
        "archived_status": testcase.get("status"), "updated_at": now_iso(),
    }}, return_document=True)
    await _log_testcase_lifecycle(id, "archived", user, "History and linked records preserved")
    return clean(updated)


@api.post("/testcases/{id}/restore")
async def restore_testcase(id: str, user=Depends(require_roles("admin", "qa_manager"))):
    testcase = await crud_get("testcases", id)
    if not testcase.get("archived"):
        return testcase
    updated = await db.testcases.find_one_and_update({"id": id}, {"$set": {
        "archived": False, "status": testcase.get("archived_status") or testcase.get("status") or "Draft",
        "updated_at": now_iso(),
    }, "$unset": {"archived_at": "", "archived_by": "", "archived_status": ""}}, return_document=True)
    await _log_testcase_lifecycle(id, "restored", user, "Returned to active test case lists")
    return clean(updated)


@api.delete("/testcases/{id}/permanent")
async def permanently_delete_testcase(id: str, body: Dict[str, Any], admin=Depends(require_roles("admin"))):
    testcase = await crud_get("testcases", id)
    if not testcase.get("archived"):
        raise HTTPException(409, "Archive the test case before permanent deletion")
    if body.get("confirmation_id") != id or body.get("confirmation_title") != testcase.get("name"):
        raise HTTPException(400, "Type the exact test case ID and title to confirm deletion")
    reason = str(body.get("reason") or "").strip()
    if len(reason) < 3:
        raise HTTPException(400, "A deletion reason is required")
    dependencies = await _testcase_dependency_counts(id)
    _verify_deletion_preflight_token(body.get("preflight_token", ""), id, testcase.get("updated_at"), dependencies)
    if any(dependencies.values()):
        raise HTTPException(409, "This test case has dependencies. Archive it and retain its linked history.")
    audit = {
        "id": new_id(), "entity_id": id, "entity_type": "testcases",
        "action": "permanently deleted", "user": admin["name"],
        "detail": json.dumps({"reason": reason, "title": testcase.get("name"), "dependencies": dependencies}),
        "created_at": now_iso(), "source": "testcase_lifecycle_audit", "_log": True,
    }
    outcome = await db.permanent_delete_testcase(id, audit, testcase.get("updated_at"))
    if outcome.get("error") == "not_found":
        raise HTTPException(404, "Test case not found")
    if outcome.get("error") == "blocked":
        raise HTTPException(409, "This test case gained dependencies. Run preflight again and archive it instead.")
    if outcome.get("error") == "stale":
        raise HTTPException(409, "The test case lifecycle changed after preflight. Run preflight again.")
    return {"ok": True, "id": id, "audit_id": audit["id"]}

async def crud_delete(coll, id, user):
    if coll == "models":
        if user.get("role") not in ("admin", "qa_manager"):
            raise HTTPException(403, "Only administrators and QA managers can manage models")
        existing = await db.models.find_one({"id": id}, {"_id": 0})
        if not existing:
            raise HTTPException(404, "Model not found")
        name = existing.get("name")
        references = {
            "responses": await db.responses.count_documents({"model": name}),
            "evaluations": await db.evaluations.count_documents({"model": name}),
            "test_runs": await db.test_runs.count_documents({"models": name}),
        }
        references = {collection: count for collection, count in references.items() if count}
        if references:
            raise HTTPException(409, f"Model is used by historical records and cannot be deleted: {references}. Deactivate it instead.")
    if coll == "versions" and user.get("role") not in ("admin", "qa_manager"):
        raise HTTPException(403, "Only administrators and QA managers can manage Bassett versions")
    if coll == "versions":
        existing = await db.versions.find_one({"id": id}, {"_id": 0})
        if not existing:
            raise HTTPException(404, "Version not found")
        name = existing.get("name")
        checks = {
            "evaluations": {"bassett_version": name},
            "responses": {"model_version": name},
            "findings": {"version_found": name},
            "retests": {"$or": [{"original_bassett_version": name}, {"new_bassett_version": name}]},
            "regression_runs": {"bassett_version": name},
            "release_decisions": {"version": name},
            "bassett_issues": {"$or": [{"version_id": id}, {"bassett_version": name}]},
            "bassett_scenarios": {"$or": [{"version_id": id}, {"bassett_version": name}]},
            "bassett_executions": {"$or": [{"version_id": id}, {"bassett_version": name}]},
        }
        references = {collection: await db[collection].count_documents(query)
                      for collection, query in checks.items()}
        references = {collection: count for collection, count in references.items() if count}
        if references:
            raise HTTPException(409, f"Version is used by historical records and cannot be deleted: {references}")
    if coll in ("projects", "municipalities", "properties"):
        raise HTTPException(409, "Use the administrator archive and permanent-delete workflow after preflight.")
    # Testcases are never generic-deleted.  Keep this guard before any
    # repository read so lifecycle callers do not need a connected database.
    if coll == "testcases":
        raise HTTPException(409, "Test cases are archived by default. Use the administrator permanent-delete workflow after preflight.")
    existing_record = await db[coll].find_one({"id": id}, {"_id": 0})
    if existing_record and (existing_record.get("archived") or existing_record.get("status") == "Archived"):
        raise HTTPException(409, "Archived records are immutable; historical reads are preserved")
    if coll != "testcases":
        linked = await db[coll].find_one({"id": id}, {"_id": 0})
        await _guard_testcase_linked_document(linked)
    if coll == "regression_runs":
        existing = await db[coll].find_one({"id": id}, {"_id": 0, "locked": 1})
        if existing and existing.get("locked") and user.get("role") != "admin":
            raise HTTPException(403, "Locked regression runs can only be deleted by an administrator")
    else:
        try:
            deleted = await db[coll].delete_one({"id": id})
        except ForeignKeyViolationError:
            raise HTTPException(409, f"{coll} cannot be deleted while dependent records exist")
        if not deleted.deleted_count:
            raise HTTPException(404, "Not found")
    await log_activity(coll, id, "deleted", user)
    return {"ok": True}


async def _resource_dependency_counts(resource, identifier):
    checks = {
        "projects": {
            "test_cases": ("testcases", {"project_id": identifier}),
            "findings": ("findings", {"project_id": identifier}),
            "bassett_test_runs": ("bassett_issues", {"project_id": identifier}),
            "test_bank_scenarios": ("bassett_scenarios", {"project_id": identifier}),
            "attachments": ("attachments", {"entity_type": "project", "entity_id": identifier, "is_deleted": False}),
        },
        "municipalities": {
            "test_cases": ("testcases", {"municipality_id": identifier}),
            "properties": ("properties", {"municipality_id": identifier}),
            "evidence": ("evidence", {"municipality_id": identifier}),
            "bassett_test_runs": ("bassett_issues", {"municipality_id": identifier}),
        },
        "properties": {
            "test_cases": ("testcases", {"property_id": identifier}),
            "bassett_test_runs": ("bassett_issues", {"property_id": identifier}),
        },
    }[resource]
    return {name: await db[collection].count_documents(query) for name, (collection, query) in checks.items()}


@api.get("/resources/{resource}/{id}/deletion-preflight")
async def resource_deletion_preflight(resource: str, id: str, user=Depends(require_roles("admin"))):
    if resource not in ("projects", "municipalities", "properties"):
        raise HTTPException(404, "Unsupported resource")
    record = await db[resource].find_one({"id": id}, {"_id": 0})
    if not record:
        raise HTTPException(404, "Record not found")
    dependencies = await _resource_dependency_counts(resource, id)
    blockers = {name: count for name, count in dependencies.items() if count}
    return {"record": record, "dependencies": dependencies, "blockers": blockers, "allowed": not blockers,
            "preflight_token": _deletion_preflight_token(
                f"{resource}:{id}", record.get("updated_at"), dependencies
            )}

@api.post("/resources/{resource}/{id}/archive")
async def archive_resource(resource: str, id: str, user=Depends(require_roles("admin", "qa_manager"))):
    if resource not in ("projects", "municipalities", "properties"):
        raise HTTPException(404, "Unsupported resource")
    record = await crud_get(resource, id)
    if record.get("archived"):
        return record
    updated = await db[resource].find_one_and_update({"id": id}, {"$set": {
        "archived": True, "archived_at": now_iso(), "archived_by": user["id"],
        "archived_status": record.get("status"), "updated_at": now_iso(),
    }}, return_document=True)
    await log_activity(resource, id, "archived", user, "History and dependent records preserved")
    return clean(updated)

@api.post("/resources/{resource}/{id}/restore")
async def restore_resource(resource: str, id: str, user=Depends(require_roles("admin", "qa_manager"))):
    if resource not in ("projects", "municipalities", "properties"):
        raise HTTPException(404, "Unsupported resource")
    record = await crud_get(resource, id)
    if not record.get("archived"):
        return record
    updated = await db[resource].find_one_and_update({"id": id}, {"$set": {
        "archived": False, "status": record.get("archived_status") or record.get("status"),
        "updated_at": now_iso(),
    }, "$unset": {"archived_at": "", "archived_by": "", "archived_status": ""}}, return_document=True)
    await log_activity(resource, id, "restored", user, "History and dependent records preserved")
    return clean(updated)

@api.delete("/resources/{resource}/{id}/permanent")
async def permanently_delete_resource(resource: str, id: str, body: Dict[str, Any],
                                      admin=Depends(require_roles("admin"))):
    if resource not in ("projects", "municipalities", "properties"):
        raise HTTPException(404, "Unsupported resource")
    record = await crud_get(resource, id)
    if not record.get("archived"):
        raise HTTPException(409, "Archive the record before permanent deletion")
    if body.get("confirmation_id") != id or body.get("confirmation_title") != record.get("name"):
        raise HTTPException(400, "Type the exact record ID and title to confirm deletion")
    reason = str(body.get("reason") or "").strip()
    if len(reason) < 3:
        raise HTTPException(400, "A deletion reason is required")
    dependencies = await _resource_dependency_counts(resource, id)
    _verify_deletion_preflight_token(body.get("preflight_token", ""), f"{resource}:{id}",
                                     record.get("updated_at"), dependencies)
    if any(dependencies.values()):
        raise HTTPException(409, "This record has dependencies. Retain its archived history.")
    deleted = await db[resource].delete_one({"id": id, "updated_at": record.get("updated_at")})
    if not deleted.deleted_count:
        raise HTTPException(409, "The record changed after preflight. Run preflight again.")
    await log_activity(resource, id, "permanently deleted", admin,
                       json.dumps({"title": record.get("name"), "reason": reason,
                                   "history_preserved": True}))
    return {"ok": True, "id": id, "history_preserved": True}

def register_crud(name, coll):
    @api.get(f"/{name}")
    async def _list(include_archived: bool = False, user=Depends(get_current_user)):
        return await crud_list(coll, include_archived=include_archived)

    @api.get(f"/{name}/{{id}}")
    async def _get(id: str, user=Depends(get_current_user)):
        return await crud_get(coll, id)

    @api.post(f"/{name}")
    async def _create(body: Dict[str, Any], user=Depends(require_writer)):
        return await crud_create(coll, body, user)

    @api.put(f"/{name}/{{id}}")
    async def _update(id: str, body: Dict[str, Any], user=Depends(require_writer)):
        return await crud_update(coll, id, body, user)

    @api.delete(f"/{name}/{{id}}")
    async def _delete(id: str, user=Depends(require_writer)):
        return await crud_delete(coll, id, user)

for _n, _c in COLLECTIONS.items():
    if _n in ("config", "activities", "comments"):
        continue
    register_crud(_n, _c)

# ---------- Bassett testing workspace ----------
# This is deliberately separate from the general Findings/Test Cases
# collections.  References are validated here rather than adding new foreign
# keys so archiving a Bassett record never changes legacy delete behavior.
BASSETT_MANAGER_ROLES = {"admin", "qa_manager"}
BASSETT_WRITE_ROLES = {"admin", "qa_manager", "tester", "developer"}
BASSETT_ISSUE_STATUSES = ("New", "Triaged", "In Progress", "Blocked", "Resolved", "Closed", "Archived")
BASSETT_WORKFLOW_STAGE_NAMES = ("Research", "Analysis")
_BASSETT_LEGACY_ANALYSIS_ALIAS = " ".join(("report", "writing"))
# New test runs always use the first six values.  The final four values were
# written by the original workspace and deliberately remain accepted/readable:
# records are historical evidence, not data to silently migrate.
BASSETT_CANONICAL_RESULTS = ("Pass", "Pass with Notes", "Partial", "Fail", "Blocked", "Not Evaluated")
BASSETT_LEGACY_RESULTS = ("Pass", "Fail", "Blocked", "Incomplete")
BASSETT_RESULTS = tuple(dict.fromkeys((*BASSETT_CANONICAL_RESULTS, *BASSETT_LEGACY_RESULTS)))
BASSETT_RESULT_CANONICAL_EQUIVALENTS = {"Incomplete": "Not Evaluated"}
BASSETT_ISSUE_FIELDS = {
    "test_id", "title", "question_asked", "exact_bassett_answer", "verified_correct_answer",
    "issue_category", "severity", "priority", "environment", "reported_date", "test_date",
    "status", "assignee_id", "project_id", "testcase_id", "finding_id",
    "scenario_id", "workflow_stage", "version_id", "bassett_version", "retest_id",
    "regression_run_id", "municipality_id", "property_id", "notes",
    "resolution", "repro_steps", "evidence",
    "result", "verdict", "score", "evaluation_scores", "overall_score",
    "weighted_score", "system_recommended", "score_mode", "score_label",
    "weight_explanation", "follow_up_action", "retest_target", "retest_date",
    "source_links", "history_context", "score_rationale",
}
BASSETT_SCENARIO_FIELDS = {
    "workflow_stage", "report_type", "test_scenario", "complexity",
    "why_it_matters", "what_bassett_should_do", "success_criteria", "priority",
    "tags", "project_id", "testcase_id", "version_id", "bassett_version",
}
BASSETT_DEFINITION_SNAPSHOT_FIELDS = (
    "stable_id", "workflow_stage", "report_type", "test_scenario", "complexity",
    "why_it_matters", "what_bassett_should_do", "success_criteria", "priority",
)
BASSETT_COMPLEXITY_ORDER = ("low", "moderate", "medium", "high", "very high")
BASSETT_PRIORITY_ORDER = (
    "p0", "p0 - immediate", "critical",
    "p1", "p1 - high", "high",
    "p2", "p2 - medium", "medium",
    "low",
)

def _canonical_bassett_workflow_stage(value):
    raw = str(value or "").strip()
    normalized = " ".join(raw.split()).casefold()
    return {
        "research": "Research",
        "analysis": "Analysis",
        _BASSETT_LEGACY_ANALYSIS_ALIAS: "Analysis",
    }.get(normalized, raw)

def _normalize_bassett_stage_record(record):
    if not isinstance(record, dict):
        return record
    normalized = dict(record)
    for field in ("name", "workflow_stage"):
        if field in normalized:
            normalized[field] = _canonical_bassett_workflow_stage(normalized[field])
    return normalized

def _normalize_bassett_config_stages(stages):
    if not isinstance(stages, list):
        return stages
    normalized_stages = []
    seen_canonical = set()
    for stage in stages:
        normalized = (
            _canonical_bassett_workflow_stage(stage)
            if isinstance(stage, str)
            else _normalize_bassett_stage_record(stage)
        )
        name = normalized if isinstance(normalized, str) else normalized.get("name")
        if name in BASSETT_WORKFLOW_STAGE_NAMES:
            if name in seen_canonical:
                continue
            seen_canonical.add(name)
        normalized_stages.append(normalized)
    return normalized_stages

def _bassett_test_id_parts(value):
    raw = str(value or "").strip()
    match = re.fullmatch(r"([A-Za-z]+)\s*-\s*(\d+)", raw)
    if not match:
        return None
    return match.group(1).upper(), int(match.group(2))

def _bassett_sort_text(value):
    return str(value or "").strip().casefold()

def _bassett_domain_rank(value, order):
    normalized = _bassett_sort_text(value)
    try:
        return (0, order.index(normalized))
    except ValueError:
        return (1, normalized)

def _bassett_scenario_sort_key(scenario, key="stable_id"):
    value = scenario.get(key)
    blank = value is None or not str(value).strip()
    if key == "stable_id":
        parts = _bassett_test_id_parts(value)
        # Valid structured IDs always precede malformed/blank values. Prefix
        # and sequence are separate so R-10 never sorts before R-2.
        if parts:
            return (0, parts[0].casefold(), parts[1], _bassett_sort_text(value),
                    _bassett_sort_text(scenario.get("test_scenario")))
        return (2 if blank else 1, _bassett_sort_text(value),
                _bassett_sort_text(scenario.get("test_scenario")))
    if key == "workflow_stage":
        return _bassett_domain_rank(value, ())
    if key == "complexity":
        return (*_bassett_domain_rank(value, BASSETT_COMPLEXITY_ORDER),
                _bassett_sort_text(scenario.get("stable_id")))
    if key == "priority":
        return (*_bassett_domain_rank(value, BASSETT_PRIORITY_ORDER),
                _bassett_sort_text(scenario.get("stable_id")))
    if isinstance(value, (int, float)) and not isinstance(value, bool):
        return (0, value, _bassett_sort_text(scenario.get("stable_id")))
    return (1 if blank else 0, _bassett_sort_text(value),
            _bassett_sort_text(scenario.get("stable_id")))

def _sort_bassett_scenarios(scenarios, key="stable_id", direction="asc", workflow_stages=None):
    allowed = {"stable_id", "workflow_stage", "report_type", "test_scenario",
               "complexity", "priority", "execution_count"}
    key = key if key in allowed else "stable_id"
    descending = str(direction).lower() == "desc"
    rows = list(scenarios or [])
    stage_order = {}
    if workflow_stages:
        stage_order = {
            _bassett_sort_text(stage.get("name") or stage.get("workflow_stage")): index
            for index, stage in enumerate(workflow_stages)
            if isinstance(stage, dict)
        }

    def compare_values(left, right, value_key, apply_direction=True):
        left_value, right_value = left.get(value_key), right.get(value_key)
        left_blank = left_value is None or not str(left_value).strip()
        right_blank = right_value is None or not str(right_value).strip()
        if left_blank != right_blank:
            return 1 if left_blank else -1
        if left_blank:
            return 0

        if value_key == "stable_id":
            left_parts, right_parts = _bassett_test_id_parts(left_value), _bassett_test_id_parts(right_value)
            if bool(left_parts) != bool(right_parts):
                return -1 if left_parts else 1
            if left_parts and right_parts:
                result = (
                    (left_parts[0].casefold() > right_parts[0].casefold())
                    - (left_parts[0].casefold() < right_parts[0].casefold())
                ) or ((left_parts[1] > right_parts[1]) - (left_parts[1] < right_parts[1]))
            else:
                result = (
                    (_bassett_sort_text(left_value) > _bassett_sort_text(right_value))
                    - (_bassett_sort_text(left_value) < _bassett_sort_text(right_value))
                )
        elif value_key == "workflow_stage" and stage_order:
            left_stage, right_stage = _bassett_sort_text(left_value), _bassett_sort_text(right_value)
            left_known, right_known = left_stage in stage_order, right_stage in stage_order
            if left_known != right_known:
                return -1 if left_known else 1
            elif left_known:
                result = (stage_order[left_stage] > stage_order[right_stage]) - (
                    stage_order[left_stage] < stage_order[right_stage]
                )
            else:
                result = (
                    (left_stage > right_stage) - (left_stage < right_stage)
                )
        elif value_key == "complexity":
            order = BASSETT_COMPLEXITY_ORDER
            left_normalized, right_normalized = _bassett_sort_text(left_value), _bassett_sort_text(right_value)
            left_rank, right_rank = order.index(left_normalized) if left_normalized in order else None, order.index(right_normalized) if right_normalized in order else None
            if (left_rank is None) != (right_rank is None):
                return 1 if left_rank is None else -1
            else:
                result = (
                    (left_rank > right_rank) - (left_rank < right_rank)
                    if left_rank is not None
                    else (left_normalized > right_normalized) - (left_normalized < right_normalized)
                )
        elif value_key == "priority":
            order = BASSETT_PRIORITY_ORDER
            left_normalized, right_normalized = _bassett_sort_text(left_value), _bassett_sort_text(right_value)
            left_rank, right_rank = order.index(left_normalized) if left_normalized in order else None, order.index(right_normalized) if right_normalized in order else None
            if (left_rank is None) != (right_rank is None):
                return 1 if left_rank is None else -1
            else:
                result = (
                    (left_rank > right_rank) - (left_rank < right_rank)
                    if left_rank is not None
                    else (left_normalized > right_normalized) - (left_normalized < right_normalized)
                )
        elif isinstance(left_value, (int, float)) and not isinstance(left_value, bool) and isinstance(right_value, (int, float)) and not isinstance(right_value, bool):
            result = (left_value > right_value) - (left_value < right_value)
        else:
            left_text, right_text = _bassett_sort_text(left_value), _bassett_sort_text(right_value)
            result = (left_text > right_text) - (left_text < right_text)
        return -result if descending and apply_direction else result

    def compare_rows(left_pair, right_pair):
        result = compare_values(left_pair[1], right_pair[1], key)
        if result:
            return result
        result = compare_values(left_pair[1], right_pair[1], "stable_id", apply_direction=False)
        if result:
            return result
        result = compare_values(left_pair[1], right_pair[1], "test_scenario", apply_direction=False)
        return result or left_pair[0] - right_pair[0]

    # Explicitly decorate with source position: equal values remain in their
    # incoming order even on Python versions where sort stability is changed.
    decorated = list(enumerate(rows))
    decorated.sort(key=cmp_to_key(compare_rows))
    return [row for _, row in decorated]

def _require_bassett_writer(user):
    if user.get("role") not in BASSETT_WRITE_ROLES:
        raise HTTPException(403, "Bassett testers and analysts can create and execute tests")
    return user

def _require_bassett_manager(user):
    if user.get("role") not in BASSETT_MANAGER_ROLES:
        raise HTTPException(403, "Only administrators and QA managers can manage Bassett definitions")
    return user

def _bassett_result_details(result):
    """Describe a stored run result without mutating its historical value."""
    raw = str(result or "Not Evaluated")
    canonical = BASSETT_RESULT_CANONICAL_EQUIVALENTS.get(raw, raw)
    legacy = raw in BASSETT_LEGACY_RESULTS and raw not in BASSETT_CANONICAL_RESULTS
    return {
        "result": raw,
        "canonical_result": canonical,
        "legacy_result": legacy,
        # Pass/Fail/Blocked are valid in both vocabularies, so provenance
        # cannot be inferred for those values; this makes that compatibility
        # explicit without relabelling or rewriting the stored value.
        "legacy_compatible_result": raw in BASSETT_LEGACY_RESULTS,
        "result_label": f"{raw} (legacy; equivalent to {canonical})" if legacy else raw,
    }


def _canonical_bassett_result(result):
    return _bassett_result_details(result)["canonical_result"]

def _decorate_bassett_execution(execution):
    """Expose legacy provenance while retaining the exact persisted result."""
    execution = dict(execution)
    execution.update(_bassett_result_details(execution.get("result")))
    return execution

def _validate_issue_required(doc):
    labels = {
        "question_asked": "The question asked",
        "exact_bassett_answer": "The exact Bassett answer",
        "verified_correct_answer": "The verified correct answer",
    }
    for field, label in labels.items():
        if not str(doc.get(field) or "").strip():
            raise HTTPException(400, f"{label} is required")

def _validate_bassett_run_result(doc, allow_legacy=False):
    allowed = BASSETT_RESULTS if allow_legacy else BASSETT_CANONICAL_RESULTS
    result = str(doc.get("result") or "Not Evaluated")
    if result not in allowed:
        raise HTTPException(
            400,
            "Bassett result must be Pass, Pass with Notes, Partial, Fail, Blocked, or Not Evaluated",
        )
    score = doc.get("score")
    if score in (None, ""):
        score = None
    else:
        try:
            score = float(score)
        except (TypeError, ValueError):
            raise HTTPException(400, "Score must be a number")
        if score < 0 or score > 100:
            raise HTTPException(400, "Score must be between 0 and 100")
    doc["result"], doc["score"] = result, score
def _validate_scenario_required(doc):
    required = ("workflow_stage", "report_type", "test_scenario", "complexity",
                "why_it_matters", "what_bassett_should_do", "success_criteria")
    missing = [field for field in required if not str(doc.get(field) or "").strip()]
    if missing:
        raise HTTPException(400, f"Required scenario fields are missing: {', '.join(missing)}")

def _require_mutable_bassett_issue(issue):
    if issue.get("archived") or issue.get("status") == "Archived":
        raise HTTPException(409, "Archived issues are immutable; history and relationships are preserved")
    return issue

def _require_mutable_bassett_scenario(scenario):
    if scenario.get("archived"):
        raise HTTPException(409, "Archived scenarios are immutable; definitions and history are preserved")
    return scenario

async def _bassett_ref(collection, identifier, label, allow_archived=True):
    if not identifier:
        return None
    record = await db[collection].find_one({"id": str(identifier)}, {"_id": 0})
    if not record:
        raise HTTPException(400, f"{label} does not exist")
    if not allow_archived and (record.get("archived") or record.get("archived_at")):
        raise HTTPException(400, f"{label} is archived")
    return record

async def _validate_bassett_refs(doc, require_scenario=False):
    project = await _bassett_ref("projects", doc.get("project_id"), "Project")
    testcase = await _bassett_ref("testcases", doc.get("testcase_id"), "Test case", allow_archived=False)
    if project and testcase and testcase.get("project_id") and testcase["project_id"] != project["id"]:
        raise HTTPException(400, "Test case does not belong to the selected project")
    await _bassett_ref("findings", doc.get("finding_id"), "Finding")
    await _bassett_ref("retests", doc.get("retest_id"), "Retest")
    await _bassett_ref("regression_runs", doc.get("regression_run_id"), "Regression run")
    if doc.get("assignee_id"):
        assignee = await _bassett_ref("users", doc.get("assignee_id"), "Assignee")
        if assignee.get("active") is False or assignee.get("deleted_at"):
            raise HTTPException(400, "Assignee must be an active user")
    municipality = await _bassett_ref("municipalities", doc.get("municipality_id"), "Municipality")
    property_record = await _bassett_ref("properties", doc.get("property_id"), "Property")
    if property_record and municipality and property_record.get("municipality_id") not in (
        None, "", municipality["id"]
    ):
        raise HTTPException(400, "Property does not belong to the selected municipality")
    if doc.get("assignee_id"):
        assignee = await _bassett_ref("users", doc["assignee_id"], "Assignee", allow_archived=False)
        if assignee.get("active") is False or assignee.get("deleted_at"):
            raise HTTPException(400, "Assignee must be an active user")
    if doc.get("scenario_id"):
        await _bassett_ref("bassett_scenarios", doc["scenario_id"], "Bassett scenario", allow_archived=False)
    elif require_scenario:
        raise HTTPException(400, "A Bassett scenario is required")
    version_identifier = doc.get("version_id") or doc.get("bassett_version")
    if version_identifier:
        version = await db.versions.find_one(
            {"$or": [{"id": str(version_identifier)}, {"name": str(version_identifier)}]}, {"_id": 0}
        )
        if not version:
            raise HTTPException(400, "Bassett version does not exist")
        doc["version_id"] = version["id"]
        doc["bassett_version"] = version.get("name") or version["id"]
    return project, testcase

async def _workflow_stage(stage_name):
    canonical_name = _canonical_bassett_workflow_stage(stage_name)
    stage = await db.bassett_workflow_stages.find_one({"name": canonical_name}, {"_id": 0})
    if not stage and canonical_name in BASSETT_WORKFLOW_STAGE_NAMES:
        stage = await db.bassett_workflow_stages.find_one(
            {"code": "R" if canonical_name == "Research" else "A"}, {"_id": 0}
        )
    if not stage or not stage.get("active", True):
        raise HTTPException(400, "Invalid workflow stage")
    return _normalize_bassett_stage_record(stage)

async def _seed_bassett_catalog():
    """Add only absent canonical rows; existing non-identical rows are reported."""
    for definition in CANONICAL_SCENARIOS:
        existing = await db.bassett_scenarios.find_one({"stable_id": definition["stable_id"]}, {"_id": 0})
        if not existing:
            doc = {**definition, "id": f"bassett-catalog-{definition['stable_id']}",
                   "archived": False, "seeded": True, "created_at": now_iso(),
                   "created_by": "system", "updated_at": now_iso()}
            try:
                await db.bassett_scenarios.insert_one(doc)
            except UniqueViolationError:
                # Another startup instance won the exact canonical-ID insert.
                existing = await db.bassett_scenarios.find_one(
                    {"stable_id": definition["stable_id"]}, {"_id": 0}
                )
                if not existing or any(existing.get(key) != value for key, value in definition.items()):
                    logger.error("Bassett canonical seed conflict for %s; existing row was not overwritten",
                                 definition["stable_id"])
        elif any(existing.get(key) != value for key, value in definition.items()):
            logger.error("Bassett canonical seed conflict for %s; existing row was not overwritten",
                         definition["stable_id"])

async def _bassett_history(entity_type, entity_id, action, user, changes=None):
    entry = {
        "id": new_id(), "entity_type": entity_type, "entity_id": entity_id,
        "action": action, "changes": changes or {}, "actor_id": user.get("id"),
        "actor": user.get("name", "system"), "created_at": now_iso(),
    }
    await db.bassett_history.insert_one(entry)
    return entry

async def _bassett_scenario_links(scenario_id):
    issues = await db.bassett_issues.find({"scenario_id": scenario_id}, {"_id": 0}).to_list(5000)
    executions = await db.bassett_executions.find({"scenario_id": scenario_id}, {"_id": 0}).to_list(5000)
    return issues, executions

@api.get("/bassett/issues")
async def bassett_list_issues(
    status: Optional[str] = None, severity: Optional[str] = None,
    scenario_id: Optional[str] = None, include_archived: bool = False,
    test_date_from: Optional[str] = None, test_date_to: Optional[str] = None,
    user=Depends(get_current_user),
):
    query = {} if include_archived else {"archived": {"$ne": True}}
    if status and status != "all":
        query["status"] = status
    if severity and severity != "all":
        query["severity"] = severity
    if scenario_id:
        query["scenario_id"] = scenario_id
    date_from, date_to = _validate_date_range(test_date_from, test_date_to)
    if date_from or date_to:
        query["test_date"] = {
            **({"$gte": date_from} if date_from else {}),
            **({"$lte": date_to} if date_to else {}),
        }
    return await db.bassett_issues.find(query, {"_id": 0}).sort(
        [("test_date", -1), ("created_at", -1)]
    ).to_list(5000)

@api.get("/bassett/issues/{id}")
async def bassett_get_issue(id: str, user=Depends(get_current_user)):
    issue = await _bassett_ref("bassett_issues", id, "Issue")
    if issue.get("scenario_id"):
        issue["scenario"] = _normalize_bassett_stage_record(
            await db.bassett_scenarios.find_one({"id": issue["scenario_id"]}, {"_id": 0})
        )
    if issue.get("definition_snapshot"):
        issue["definition_snapshot"] = _normalize_bassett_stage_record(issue["definition_snapshot"])
    if issue.get("finding_id"):
        issue["finding"] = await db.findings.find_one({"id": issue["finding_id"]}, {"_id": 0})
    if issue.get("testcase_id"):
        testcase = await db.testcases.find_one({"id": issue["testcase_id"]}, {"_id": 0})
        if testcase:
            testcase["goldstandard"] = await db.goldstandards.find_one(
                {"testcase_id": testcase["id"]}, {"_id": 0}
            )
            testcase["responses"] = await db.responses.find(
                {"testcase_id": testcase["id"]}, {"_id": 0}
            ).to_list(100)
        issue["expansion"] = testcase
    issue["history"] = await db.bassett_history.find(
        {"entity_type": "issue", "entity_id": id}, {"_id": 0}
    ).sort("created_at", -1).to_list(5000)
    return issue

@api.post("/bassett/issues/{id}/expand")
async def bassett_expand_issue(id: str, user=Depends(get_current_user)):
    _require_bassett_writer(user)
    issue = await _bassett_ref("bassett_issues", id, "Issue")
    _require_mutable_bassett_issue(issue)
    scenario = _normalize_bassett_stage_record(
        await _bassett_ref("bassett_scenarios", issue.get("scenario_id"), "Bassett scenario")
    )
    snapshot = issue.get("definition_snapshot")
    snapshot = _normalize_bassett_stage_record(snapshot)
    if not snapshot or any(field not in snapshot for field in BASSETT_DEFINITION_SNAPSHOT_FIELDS):
        raise HTTPException(
            409,
            "Legacy issue has no complete immutable scenario snapshot and cannot be expanded automatically",
        )
    if issue.get("finding_id"):
        linked_finding = await _bassett_ref("findings", issue["finding_id"], "Finding")
        if linked_finding.get("testcase_id") and linked_finding.get("testcase_id") != issue.get("testcase_id"):
            raise HTTPException(409, "Linked finding already belongs to another test case")
        if linked_finding.get("project_id") and issue.get("project_id") and linked_finding["project_id"] != issue["project_id"]:
            raise HTTPException(409, "Linked finding belongs to another project")
    stamp = now_iso()
    testcase_id = new_id()
    # Preserve the issue's provenance and all usable test context; this is a
    # normal comparison record, not a lightweight link back to Bassett.
    testcase = {
        "id": testcase_id, "name": issue.get("title") or snapshot.get("test_scenario"),
        "prompts": [{"turn": 1, "text": issue["question_asked"]}],
        "bassett_issue_id": id, "scenario_id": scenario["id"],
        "source_bassett_issue_id": id, "source_issue_id": id,
        "comparison_mode": True, "revision": 1,
        "source_definition_snapshot": dict(snapshot),
        "project_id": issue.get("project_id") or scenario.get("project_id"),
        "municipality_id": issue.get("municipality_id"),
        "property_id": issue.get("property_id"),
        "version_id": issue.get("version_id") or scenario.get("version_id"),
        "bassett_version": issue.get("bassett_version") or scenario.get("bassett_version"),
        "scenario": snapshot.get("test_scenario"), "purpose": snapshot.get("why_it_matters"),
        "context": issue.get("repro_steps") or issue.get("notes", ""),
        "notes": issue.get("notes", ""), "reproduction_steps": issue.get("repro_steps", ""),
        "evidence_context": issue.get("evidence") or issue.get("evidence_context", ""),
        "test_date": issue.get("test_date"), "reported_date": issue.get("reported_date"),
        "environment": issue.get("environment"), "status": issue.get("status"),
        "priority": issue.get("priority"), "severity": issue.get("severity"),
        "assignee_id": issue.get("assignee_id"), "assignee_name": issue.get("assignee_name"),
        "bassett_test_result": issue.get("result") or issue.get("verdict"),
        "bassett_evaluation_scores": dict(issue.get("evaluation_scores") or {}),
        "bassett_overall_score": issue.get("overall_score"),
        "bassett_follow_up": {
            key: issue.get(key) for key in (
                "follow_up_action", "retest_target", "retest_date", "retest_id",
                "regression_run_id", "source_links", "history_context",
            ) if issue.get(key) is not None
        },
        "source_bassett_workflow": {
            key: issue.get(key) for key in (
                "id", "test_id", "scenario_id", "title", "question_asked",
                "exact_bassett_answer", "verified_correct_answer", "issue_category",
                "severity", "priority", "environment", "reported_date", "test_date",
                "status", "assignee_id", "project_id", "municipality_id", "property_id",
                "version_id", "bassett_version", "result", "verdict", "score",
                "evaluation_scores", "overall_score", "weighted_score",
                "system_recommended", "system_explanation", "score_mode", "score_label",
                "weight_explanation", "follow_up_action", "retest_target", "retest_date",
                "retest_id", "regression_run_id", "evidence", "notes", "repro_steps",
                "source_links", "history_context", "finding_id", "creation_key",
            ) if issue.get(key) is not None
        },
        "created_at": stamp, "updated_at": stamp, "created_by": user.get("name"),
    }
    goldstandard = {
        "id": new_id(), "testcase_id": testcase_id,
        "answer": issue["verified_correct_answer"], "verified_correct_answer": issue["verified_correct_answer"],
        "source": "Bassett issue expansion", "source_issue_id": id,
        "explanation": issue.get("notes") or issue.get("repro_steps", ""),
        "review_status": "Draft", "created_at": stamp, "created_by": user.get("name"),
    }
    responses = [{
        "id": new_id(), "testcase_id": testcase_id, "model": "Bassett",
        "response": issue["exact_bassett_answer"], "source_issue_id": id,
        "availability": "available" if str(issue.get("exact_bassett_answer") or "").strip() else "unavailable",
        "unavailable_reason": None if str(issue.get("exact_bassett_answer") or "").strip() else "Not entered",
        "created_at": stamp,
    }]
    evaluations = [{
        "id": new_id(), "testcase_id": testcase_id, "model": "Bassett",
        "status": "Completed" if issue.get("evaluation_scores") else "Draft",
        "availability": "available" if issue.get("overall_score") is not None else "unavailable",
        "unavailable_reason": None if issue.get("overall_score") is not None else "Not entered",
        "final_result": issue.get("evaluation_final_result")
        or issue.get("system_recommended") or "Not Evaluated",
        "scores": dict(issue.get("evaluation_scores") or {}),
        "overall_score": issue.get("overall_score"),
        "weighted_score": issue.get("weighted_score"),
        "system_recommended": issue.get("system_recommended"),
        "system_explanation": issue.get("system_explanation"),
        "score_mode": issue.get("score_mode"),
        "score_label": issue.get("score_label"),
        "weight_explanation": issue.get("weight_explanation"),
        "source_issue_id": id, "bassett_version": testcase.get("bassett_version"),
        "version_id": testcase.get("version_id"), "created_at": stamp,
        "updated_at": stamp, "created_by": user.get("name"),
    }]
    issue_attachments = await db.attachments.find(
        {"entity_type": "bassett_issue", "entity_id": id}, {"_id": 0}
    ).to_list(5000)
    attachment_copies = [{
        "id": attachment["id"], "source_attachment_id": attachment["id"],
        "source_issue_id": id, "linked_entity_type": "testcase",
        "linked_entity_id": testcase_id, "linked_testcase_id": testcase_id,
        "updated_at": stamp,
    } for attachment in issue_attachments]
    result = await db.expand_bassett_issue(
        id, testcase, goldstandard, responses, evaluations, attachment_copies
    )
    if not result:
        raise HTTPException(404, "Issue not found")
    if result.get("error") == "finding_conflict":
        raise HTTPException(409, "Linked finding changed during expansion; reload and try again")
    if result["created"]:
        await _bassett_history("issue", id, "expanded_to_testcase", user,
                               {"testcase_id": testcase_id, "scenario_snapshot": snapshot})
    return {
        "created": result["created"],
        "testcase_id": result["testcase"]["id"],
        "testcase": result["testcase"],
        "scenario": scenario,
    }

@api.post("/bassett/issues/{id}/expand-comparison")
async def bassett_expand_issue_comparison(id: str, user=Depends(get_current_user)):
    """Bassett-labelled entry point for the existing Expand comparison action."""
    return await bassett_expand_issue(id, user)

@api.get("/bassett/issues/{id}/history")
async def bassett_issue_history(id: str, user=Depends(get_current_user)):
    await _bassett_ref("bassett_issues", id, "Issue")
    return await db.bassett_history.find(
        {"entity_type": "issue", "entity_id": id}, {"_id": 0}
    ).sort("created_at", -1).to_list(5000)

@api.post("/bassett/issues")
async def bassett_create_issue(body: Dict[str, Any], user=Depends(get_current_user)):
    _require_bassett_writer(user)
    doc = {key: value for key, value in body.items() if key in BASSETT_ISSUE_FIELDS}
    doc["test_date"] = _validate_test_date(doc.get("test_date"))
    _validate_issue_required(doc)
    _validate_bassett_run_result(doc)
    if doc.get("status") not in (None, *BASSETT_ISSUE_STATUSES[:-1]):
        raise HTTPException(400, "Invalid issue status")
    await _validate_bassett_refs(doc, require_scenario=True)
    scenario = await db.bassett_scenarios.find_one({"id": doc["scenario_id"]}, {"_id": 0})
    _validate_scenario_required(scenario)
    creation_payload = "|".join(str(doc.get(key) or "").strip() for key in (
        "scenario_id", "test_date", "question_asked", "exact_bassett_answer", "verified_correct_answer",
        "bassett_version", "environment",
    ))
    server_creation_key = hashlib.sha256(f"{user['id']}|{creation_payload}".encode()).hexdigest()
    doc.update({
        "id": body.get("id") or new_id(), "status": doc.get("status") or "New",
        "issue_category": doc.get("issue_category") or "General",
        "severity": doc.get("severity") or "Medium", "priority": doc.get("priority") or "Medium",
        "reported_date": doc.get("reported_date"),
        "creation_key": str(body.get("submission_id") or "").strip() or server_creation_key,
        "reporter_id": user["id"], "reporter": user.get("name"), "archived": False,
        "created_at": now_iso(), "created_by": user.get("name"), "updated_at": now_iso(),
    })
    try:
        doc, created = await db.create_bassett_issue(
            doc, doc.get("creation_key"), BASSETT_DEFINITION_SNAPSHOT_FIELDS,
        )
    except UniqueViolationError:
        if doc.get("creation_key"):
            replay = await db.bassett_issues.find_one(
                {"creation_key": doc["creation_key"]}, {"_id": 0}
            )
            if replay:
                return {**replay, "idempotent_replay": True}
        raise HTTPException(409, "A test run with this ID already exists")
    except BassettScenarioUnavailableError as error:
        raise HTTPException(400, str(error))
    except BassettScenarioInvalidError as error:
        raise HTTPException(409, str(error))
    if created:
        await _bassett_history("issue", doc["id"], "created", user, {
            "status": doc["status"], "scenario_id": doc["scenario_id"], "result": doc["result"],
        })
        await _bassett_history("scenario", doc["scenario_id"], "test_run_recorded", user, {
            "test_run_id": doc["id"], "result": doc["result"],
        })
        await log_activity("bassett_issue", doc["id"], "created", user, doc.get("title", ""))
    return {**doc, "idempotent_replay": not created}

async def _prepare_bassett_workflow_document(body: Dict[str, Any], user: Dict[str, Any]):
    """Validate and normalize the unified Bassett workflow payload."""
    doc = {key: value for key, value in body.items() if key in BASSETT_ISSUE_FIELDS}
    doc["test_date"] = _validate_test_date(doc.get("test_date"))
    if doc.get("retest_date"):
        doc["retest_date"] = _validate_test_date(
            doc.get("retest_date"), required=False, field_name="Retest target date"
        )
    _validate_issue_required(doc)
    _validate_bassett_run_result(doc)
    if doc.get("status") not in (None, *BASSETT_ISSUE_STATUSES[:-1]):
        raise HTTPException(400, "Invalid test status")
    project, testcase = await _validate_bassett_refs(doc, require_scenario=True)
    scenario = await db.bassett_scenarios.find_one({"id": doc["scenario_id"]}, {"_id": 0})
    if not scenario:
        raise HTTPException(400, "Bassett scenario does not exist")
    _validate_scenario_required(scenario)
    doc["workflow_stage"] = _canonical_bassett_workflow_stage(
        scenario.get("workflow_stage")
    )
    doc["id"] = body.get("id") or new_id()

    raw_scores = body.get("evaluation_scores", body.get("scores", {}))
    if raw_scores is None:
        raw_scores = {}
    if not isinstance(raw_scores, dict):
        raise HTTPException(400, detail={"evaluation_scores": "Scores must be an object"})
    authoritative = await _evaluation_score_fields(raw_scores)
    cfg = await db.config.find_one({"id": "global"}, {"_id": 0}) or DEFAULT_CONFIG
    dimension_keys = [d.get("key") for d in cfg.get("eval_dimensions", []) if d.get("key")]
    doc["evaluation_scores"] = {
        key: raw_scores.get(key) for key in dimension_keys if key in raw_scores
    }
    doc.update({
        "overall_score": authoritative["overall_score"],
        "weighted_score": authoritative["weighted_score"],
        "system_recommended": authoritative["system_recommended"],
        "system_explanation": authoritative["system_explanation"],
        "score_mode": authoritative["score_mode"],
        "score_label": authoritative["score_label"],
        "weight_explanation": authoritative["weight_explanation"],
        "status": doc.get("status") or "New",
        "issue_category": doc.get("issue_category") or "General",
        "severity": doc.get("severity") or "Medium",
        "priority": doc.get("priority") or "Medium",
        "reported_date": doc.get("reported_date") or doc["test_date"],
        "reporter_id": user["id"],
        "reporter": user.get("name"),
        "archived": False,
        "created_at": now_iso(),
        "created_by": user.get("name"),
        "updated_at": now_iso(),
        "revision": 1,
    })
    return doc, scenario, project, testcase, authoritative

async def _uploaded_storage_cleanup(paths):
    for path in paths:
        try:
            await app_storage.delete(path)
        except ObjectStorageUnavailable as error:
            logger.error("Unable to clean up failed Bassett workflow object %s: %s", path, error)

@api.post("/bassett/issues/workflow")
async def bassett_create_workflow(
    payload: str = Form(...),
    files: List[UploadFile] = File(default=[]),
    user=Depends(get_current_user),
):
    """Create a Bassett-only run, finding, history, and attachments atomically."""
    _require_bassett_writer(user)
    try:
        body = json.loads(payload)
    except (TypeError, json.JSONDecodeError):
        raise HTTPException(400, "Workflow payload must be valid JSON")
    if not isinstance(body, dict):
        raise HTTPException(400, "Workflow payload must be an object")

    doc, scenario, project, testcase, authoritative = await _prepare_bassett_workflow_document(body, user)
    creation_payload = "|".join(str(doc.get(key) or "").strip() for key in (
        "scenario_id", "test_date", "question_asked", "exact_bassett_answer",
        "verified_correct_answer", "bassett_version", "environment",
    ))
    creation_key = str(body.get("submission_id") or "").strip() or hashlib.sha256(
        f"{user['id']}|{creation_payload}".encode()
    ).hexdigest()
    doc["creation_key"] = creation_key

    finding_input = body.get("finding") if isinstance(body.get("finding"), dict) else {}
    create_finding = bool(body.get("create_finding")) or bool(finding_input)
    finding = None
    if create_finding:
        finding = {
            "id": new_id(),
            "title": str(finding_input.get("title") or doc.get("title") or doc["question_asked"][:120]),
            "description": str(finding_input.get("description") or doc["exact_bassett_answer"]),
            "expected_behavior": str(
                finding_input.get("expected_behavior") or doc["verified_correct_answer"]
            ),
            "project_id": doc.get("project_id"),
            "testcase_id": doc.get("testcase_id"),
            "developer_status": finding_input.get("developer_status") or "New",
            "criticality": finding_input.get("criticality") or doc.get("severity", "Medium"),
            "priority": finding_input.get("priority") or doc.get("priority", "Medium"),
            "bassett_issue_id": doc["id"] if doc.get("id") else None,
            "created_at": now_iso(),
            "created_by": user.get("name"),
            "updated_at": now_iso(),
            "revision": 1,
        }

    uploaded_paths = []
    attachment_documents = []
    try:
        for file in files or []:
            original_filename = file.filename or "attachment"
            ext = original_filename.rsplit(".", 1)[-1].lower() if "." in original_filename else ""
            if ext not in ALLOWED_EXT:
                raise HTTPException(
                    400,
                    f"File type .{ext} not allowed. Allowed: {', '.join(sorted(ALLOWED_EXT))}",
                )
            try:
                file_bytes = await read_attachment_bytes(file)
            finally:
                await file.close()
            path = f"{APP_STORAGE_PREFIX}/uploads/bassett_issue/{new_id()}.{ext}"
            await app_storage.upload_bytes(path, file_bytes, ALLOWED_CONTENT_TYPES[ext])
            uploaded_paths.append(path)
            attachment_documents.append({
                "id": new_id(),
                "entity_type": "bassett_issue",
                "entity_id": doc["id"],
                "storage_path": path,
                "storage_provider": "replit",
                "original_filename": original_filename,
                "content_type": ALLOWED_CONTENT_TYPES[ext],
                "size": len(file_bytes),
                "is_deleted": False,
                "uploaded_by_id": user["id"],
                "uploaded_by": user["name"],
                "created_at": doc["created_at"],
                "updated_at": doc["updated_at"],
            })

        history_documents = [{
            "id": new_id(), "entity_type": "issue", "entity_id": doc["id"],
            "action": "created", "changes": {
                "status": doc["status"], "scenario_id": doc["scenario_id"],
                "result": doc["result"], "workflow": True,
            }, "actor_id": user.get("id"), "actor": user.get("name", "system"),
            "created_at": doc["created_at"],
        }, {
            "id": new_id(), "entity_type": "scenario", "entity_id": doc["scenario_id"],
            "action": "test_run_recorded", "changes": {
                "test_run_id": doc["id"], "result": doc["result"],
            }, "actor_id": user.get("id"), "actor": user.get("name", "system"),
            "created_at": doc["created_at"],
        }]
        if finding:
            history_documents.append({
                "id": new_id(), "entity_type": "issue", "entity_id": doc["id"],
                "action": "finding_created", "changes": {"finding_id": finding["id"]},
                "actor_id": user.get("id"), "actor": user.get("name", "system"),
                "created_at": doc["created_at"],
            })
        activity_document = {
            "id": new_id(), "entity_type": "bassett_issue", "entity_id": doc["id"],
            "action": "created", "user": user.get("name", "system"),
            "detail": doc.get("title", ""), "created_at": doc["created_at"], "_log": True,
        }
        result, created = await db.create_bassett_workflow(
            doc, creation_key, BASSETT_DEFINITION_SNAPSHOT_FIELDS, finding,
            attachment_documents, history_documents, activity_document,
        )
        if not created:
            await _uploaded_storage_cleanup(uploaded_paths)
            existing_finding = None
            if result.get("finding_id"):
                existing_finding = await db.findings.find_one(
                    {"id": result["finding_id"]}, {"_id": 0}
                )
            return {
                "issue": result, "finding": existing_finding, "attachments": [],
                "idempotent_replay": True,
            }
        return {
            "issue": result, "finding": finding, "attachments": attachment_documents,
            "evaluation": authoritative, "idempotent_replay": False,
        }
    except Exception:
        await _uploaded_storage_cleanup(uploaded_paths)
        raise

@api.put("/bassett/issues/{id}")
@api.patch("/bassett/issues/{id}")
async def bassett_update_issue(id: str, body: Dict[str, Any], user=Depends(get_current_user)):
    _require_bassett_writer(user)
    existing = await _bassett_ref("bassett_issues", id, "Issue")
    _require_mutable_bassett_issue(existing)
    _require_fresh_version(existing, body)
    incoming = {key: value for key, value in body.items() if key in BASSETT_ISSUE_FIELDS}
    if "scenario_id" in incoming and incoming["scenario_id"] != existing.get("scenario_id"):
        raise HTTPException(409, "A test run's Test Bank scenario link is immutable")
    if "test_date" in incoming:
        incoming["test_date"] = _validate_test_date(incoming.get("test_date"))
    if "status" in incoming:
        if incoming["status"] not in BASSETT_ISSUE_STATUSES[:-1]:
            raise HTTPException(400, "Invalid issue status")
        if incoming["status"] != existing.get("status") and user.get("role") not in BASSETT_MANAGER_ROLES:
            raise HTTPException(403, "Only QA managers and administrators can change issue lifecycle status")
    if "assignee_id" in incoming and user.get("role") not in BASSETT_MANAGER_ROLES:
        raise HTTPException(403, "Only QA managers and administrators can assign issues")
    merged = {**existing, **incoming}
    _validate_issue_required(merged)
    _validate_bassett_run_result(merged, allow_legacy=True)
    if "result" in incoming:
        incoming["result"] = merged["result"]
    if "score" in incoming:
        incoming["score"] = merged["score"]
    await _validate_bassett_refs(merged)
    changed = {key: [existing.get(key), merged.get(key)] for key in incoming if existing.get(key) != merged.get(key)}
    incoming["updated_at"] = now_iso()
    current_revision = int(existing.get("revision", 1))
    incoming["revision"] = current_revision + 1
    updated = await db.bassett_issues.find_one_and_update(
        {"id": id, "$or": [{"revision": current_revision}, {"revision": {"$exists": False}}]},
        {"$set": incoming},
        return_document=True,
    )
    if not updated:
        current = await db.bassett_issues.find_one({"id": id}, {"_id": 0})
        if not current:
            raise HTTPException(404, "Issue not found")
        raise HTTPException(409, detail={
            "code": "stale_update",
            "message": "Someone else saved this test run first. Reload it, review the latest values, and reapply your entries.",
            "current_revision": current.get("revision", 1),
            "current_updated_at": current.get("updated_at"),
        })
    if changed:
        await _bassett_history("issue", id, "updated", user, changed)
    return updated

@api.post("/bassett/issues/{id}/archive")
async def bassett_archive_issue(id: str, user=Depends(get_current_user)):
    _require_bassett_manager(user)
    issue = await _bassett_ref("bassett_issues", id, "Issue")
    if issue.get("archived"):
        return issue
    updated = await db.bassett_issues.find_one_and_update({"id": id}, {"$set": {
        "archived": True, "status": "Archived", "archived_at": now_iso(),
        "archived_by": user["id"], "archived_status": issue.get("status") or "New", "updated_at": now_iso(),
    }}, return_document=True)
    await _bassett_history("issue", id, "archived", user, {"history_preserved": True})
    return updated

@api.post("/bassett/issues/{id}/restore")
async def bassett_restore_issue(id: str, user=Depends(get_current_user)):
    _require_bassett_manager(user)
    issue = await _bassett_ref("bassett_issues", id, "Issue")
    if not issue.get("archived"):
        return issue
    restored_status = issue.get("archived_status")
    if not restored_status or restored_status == "Archived":
        restored_status = "New"
    updated = await db.bassett_issues.find_one_and_update({"id": id}, {
        "$set": {"archived": False, "status": restored_status, "updated_at": now_iso()},
        "$unset": {"archived_at": "", "archived_by": "", "archived_status": ""},
    }, return_document=True)
    await _bassett_history("issue", id, "restored", user, {"history_preserved": True})
    return updated

@api.post("/bassett/issues/{id}/link-finding")
async def bassett_link_finding(id: str, body: Dict[str, Any], user=Depends(get_current_user)):
    _require_bassett_writer(user)
    issue = await _bassett_ref("bassett_issues", id, "Issue")
    _require_mutable_bassett_issue(issue)
    finding = await _bassett_ref("findings", body.get("finding_id"), "Finding")
    if issue.get("testcase_id") and finding.get("testcase_id") not in (None, "", issue["testcase_id"]):
        raise HTTPException(409, "Finding belongs to a different Test Case")
    if issue.get("project_id") and finding.get("project_id") not in (None, "", issue["project_id"]):
        raise HTTPException(409, "Finding belongs to a different Project")
    await _validate_bassett_refs({"project_id": issue.get("project_id"), "testcase_id": issue.get("testcase_id"),
                                 "finding_id": finding["id"]})
    if issue.get("finding_id") and issue["finding_id"] != finding["id"]:
        raise HTTPException(409, "This issue is already linked to another finding")
    existing_issue_id = finding.get("bassett_issue_id")
    if existing_issue_id and existing_issue_id != id:
        raise HTTPException(409, "This finding is already linked to another Bassett issue")
    updated = await db.bassett_issues.find_one_and_update({"id": id}, {"$set": {
        "finding_id": finding["id"], "updated_at": now_iso()
    }}, return_document=True)
    await db.findings.update_one({"id": finding["id"]}, {"$set": {
        "bassett_issue_id": id, "updated_at": now_iso(),
    }})
    await _bassett_history("issue", id, "linked_finding", user, {"finding_id": finding["id"]})
    return updated

@api.post("/bassett/issues/{id}/convert-to-finding")
async def bassett_convert_to_finding(id: str, body: Dict[str, Any] = None, user=Depends(get_current_user)):
    _require_bassett_writer(user)
    issue = await _bassett_ref("bassett_issues", id, "Issue")
    _require_mutable_bassett_issue(issue)
    await _require_active_testcase(issue.get("testcase_id"))
    if issue.get("finding_id"):
        return await _bassett_ref("findings", issue["finding_id"], "Finding")
    finding = {
        "id": new_id(), "title": issue.get("title") or issue.get("question_asked", "")[:120],
        "description": issue.get("exact_bassett_answer", ""), "expected_behavior": issue.get("verified_correct_answer", ""),
        "project_id": issue.get("project_id"), "testcase_id": issue.get("testcase_id"),
        "developer_status": "New", "criticality": issue.get("severity", "Medium"),
        "bassett_issue_id": id, "created_at": now_iso(), "created_by": user.get("name"),
        "updated_at": now_iso(),
    }
    await db.findings.insert_one(finding)
    await db.bassett_issues.update_one({"id": id}, {"$set": {"finding_id": finding["id"], "updated_at": now_iso()}})
    await _bassett_history("issue", id, "converted_to_finding", user, {"finding_id": finding["id"]})
    return finding

@api.get("/bassett/scenarios")
@api.get("/bassett/test-bank")
async def bassett_list_scenarios(
    include_archived: bool = False, sort_by: str = "stable_id",
    sort_direction: str = "asc", user=Depends(get_current_user),
):
    allowed_sort_fields = {"stable_id", "workflow_stage", "report_type", "test_scenario",
                           "complexity", "priority", "execution_count"}
    if sort_by not in allowed_sort_fields:
        raise HTTPException(400, "Unsupported Test Bank sort field")
    if sort_direction not in {"asc", "desc"}:
        raise HTTPException(400, "Unsupported sort direction")
    query = {} if include_archived else {"archived": {"$ne": True}}
    scenarios = [
        _normalize_bassett_stage_record(scenario)
        for scenario in await db.bassett_scenarios.find(query, {"_id": 0}).to_list(5000)
    ]
    all_issues = await db.bassett_issues.find({}, {"_id": 0}).to_list(5000)
    all_executions = await db.bassett_executions.find({}, {"_id": 0}).to_list(5000)
    lineage_runs = _canonical_bassett_lineages(
        all_issues, all_executions,
        active_scenario_ids={scenario["id"] for scenario in scenarios},
    )
    for scenario in scenarios:
        scenario["issue_count"] = await db.bassett_issues.count_documents({"scenario_id": scenario["id"]})
        scenario["legacy_execution_count"] = await db.bassett_executions.count_documents({"scenario_id": scenario["id"]})
        scenario["execution_count"] = sum(
            run.get("scenario_id") == scenario["id"] for run in lineage_runs
        )
    workflow_stages = _normalize_bassett_config_stages(
        await db.bassett_workflow_stages.find({}, {"_id": 0}).sort(
            "position", 1
        ).to_list(100)
    )
    return _sort_bassett_scenarios(
        scenarios, sort_by, sort_direction, workflow_stages=workflow_stages,
    )

@api.get("/bassett/scenarios/{id}")
async def bassett_get_scenario(id: str, user=Depends(get_current_user)):
    scenario = _normalize_bassett_stage_record(
        await _bassett_ref("bassett_scenarios", id, "Bassett scenario")
    )
    scenario["issues"], scenario["executions"] = await _bassett_scenario_links(id)
    scenario["history"] = await db.bassett_history.find(
        {"entity_type": "scenario", "entity_id": id}, {"_id": 0}
    ).sort("created_at", -1).to_list(5000)
    return scenario

@api.post("/bassett/scenarios")
async def bassett_create_scenario(body: Dict[str, Any], user=Depends(get_current_user)):
    _require_bassett_manager(user)
    if "stable_id" in body or "id" in body:
        raise HTTPException(400, "Scenario stable IDs are assigned by the server")
    doc = {key: body.get(key) for key in BASSETT_SCENARIO_FIELDS if key in body}
    doc["workflow_stage"] = _canonical_bassett_workflow_stage(doc.get("workflow_stage"))
    stage = await _workflow_stage(str(doc.get("workflow_stage") or "").strip())
    _validate_scenario_required(doc)
    await _validate_bassett_refs(doc)
    doc.update({"id": new_id(),
                "priority": doc.get("priority") or "Medium", "archived": False,
                "created_at": now_iso(), "created_by": user.get("name"), "updated_at": now_iso()})
    try:
        doc = await db.create_bassett_scenario(doc, stage["code"])
    except UniqueViolationError:
        raise HTTPException(409, "A scenario already uses this stable ID")
    await _bassett_history("scenario", doc["id"], "created", user, {"stable_id": doc["stable_id"]})
    return doc

@api.get("/bassett/workflow-stages")
async def bassett_list_workflow_stages(user=Depends(get_current_user)):
    return _normalize_bassett_config_stages(
        await db.bassett_workflow_stages.find({}, {"_id": 0}).sort("position", 1).to_list(100)
    )

@api.post("/bassett/workflow-stages")
async def bassett_create_workflow_stage(body: Dict[str, Any], user=Depends(get_current_user)):
    _require_bassett_manager(user)
    name = _canonical_bassett_workflow_stage(body.get("name"))
    code = str(body.get("code") or "").strip().upper()
    if not name or not re.fullmatch(r"[A-Z]{1,8}", code):
        raise HTTPException(400, "Workflow stage name and uppercase code are required")
    created_at = now_iso()
    doc = {"id": new_id(), "name": name, "code": code, "position": body.get("position", 100),
           "active": bool(body.get("active", True)), "created_at": created_at,
           "updated_at": created_at, "revision": 1}
    try:
        await db.bassett_workflow_stages.insert_one(doc)
    except UniqueViolationError:
        raise HTTPException(409, "Workflow stage name or code already exists")
    return doc

@api.put("/bassett/workflow-stages/{id}")
async def bassett_update_workflow_stage(id: str, body: Dict[str, Any], user=Depends(get_current_user)):
    _require_bassett_manager(user)
    existing = await _bassett_ref("bassett_workflow_stages", id, "Workflow stage")
    _require_fresh_version(existing, body)
    changes = {key: body[key] for key in ("name", "position", "active") if key in body}
    if "name" in changes:
        changes["name"] = _canonical_bassett_workflow_stage(changes["name"])
    if "code" in body and str(body["code"]).upper() != existing.get("code"):
        raise HTTPException(409, "Workflow stage codes are immutable")
    if "name" in changes and not str(changes["name"]).strip():
        raise HTTPException(400, "Workflow stage name is required")
    changes["updated_at"] = now_iso()
    current_revision = int(existing.get("revision", 1))
    changes["revision"] = current_revision + 1
    try:
        updated = await db.bassett_workflow_stages.find_one_and_update(
            {"id": id, "$or": [{"revision": current_revision}, {"revision": {"$exists": False}}]},
            {"$set": changes}, return_document=True
        )
    except UniqueViolationError:
        raise HTTPException(409, "Workflow stage name already exists")
    if not updated:
        current = await db.bassett_workflow_stages.find_one({"id": id}, {"_id": 0})
        if not current:
            raise HTTPException(404, "Workflow stage not found")
        raise HTTPException(409, detail={
            "code": "stale_update",
            "message": "Someone else saved this workflow stage first. Reload the latest values and review your edits.",
            "current_revision": current.get("revision", 1),
            "current_updated_at": current.get("updated_at"),
        })
    return updated

@api.put("/bassett/scenarios/{id}")
@api.patch("/bassett/scenarios/{id}")
async def bassett_update_scenario(id: str, body: Dict[str, Any], user=Depends(get_current_user)):
    _require_bassett_manager(user)
    existing = await _bassett_ref("bassett_scenarios", id, "Bassett scenario")
    _require_mutable_bassett_scenario(existing)
    _require_fresh_version(existing, body)
    incoming = {key: value for key, value in body.items() if key in BASSETT_SCENARIO_FIELDS}
    if "workflow_stage" in incoming:
        incoming["workflow_stage"] = _canonical_bassett_workflow_stage(incoming["workflow_stage"])
    merged = {**existing, **incoming}
    _validate_scenario_required(merged)
    if "workflow_stage" in incoming:
        await _workflow_stage(str(incoming["workflow_stage"]).strip())
    await _validate_bassett_refs(merged)
    incoming["updated_at"] = now_iso()
    current_revision = int(existing.get("revision", 1))
    incoming["revision"] = current_revision + 1
    try:
        updated = await db.bassett_scenarios.find_one_and_update(
            {"id": id, "$or": [{"revision": current_revision}, {"revision": {"$exists": False}}]},
            {"$set": incoming},
            return_document=True,
        )
    except UniqueViolationError:
        raise HTTPException(409, "A non-archived scenario already uses this stable ID")
    if not updated:
        current = await db.bassett_scenarios.find_one({"id": id}, {"_id": 0})
        if not current:
            raise HTTPException(404, "Bassett scenario not found")
        raise HTTPException(409, detail={
            "code": "stale_update",
            "message": "Someone else saved this scenario first. Reload it, review the latest values, and reapply your entries.",
            "current_revision": current.get("revision", 1),
            "current_updated_at": current.get("updated_at"),
        })
    await _bassett_history("scenario", id, "updated", user, {"fields": list(incoming)})
    return updated

@api.post("/bassett/scenarios/{id}/archive")
async def bassett_archive_scenario(id: str, user=Depends(get_current_user)):
    _require_bassett_manager(user)
    scenario = await _bassett_ref("bassett_scenarios", id, "Bassett scenario")
    if not scenario.get("archived"):
        scenario = await db.bassett_scenarios.find_one_and_update({"id": id}, {"$set": {
            "archived": True, "archived_at": now_iso(), "archived_by": user["id"], "updated_at": now_iso()
        }}, return_document=True)
        await _bassett_history("scenario", id, "archived", user, {"history_preserved": True})
    return scenario

@api.post("/bassett/scenarios/{id}/restore")
async def bassett_restore_scenario(id: str, user=Depends(get_current_user)):
    _require_bassett_manager(user)
    scenario = await _bassett_ref("bassett_scenarios", id, "Bassett scenario")
    if not scenario.get("archived"):
        return scenario
    scenario = await db.bassett_scenarios.find_one_and_update({"id": id}, {
        "$set": {"archived": False, "updated_at": now_iso()},
        "$unset": {"archived_at": "", "archived_by": ""},
    }, return_document=True)
    await _bassett_history("scenario", id, "restored", user, {"history_preserved": True})
    return scenario

@api.get("/bassett/executions")
async def bassett_list_executions(scenario_id: Optional[str] = None, user=Depends(get_current_user)):
    query = {"scenario_id": scenario_id} if scenario_id else {}
    executions = await db.bassett_executions.find(query, {"_id": 0}).sort("executed_at", -1).to_list(5000)
    return [_decorate_bassett_execution(execution) for execution in executions]

@api.post("/bassett/scenarios/{id}/executions")
async def bassett_create_execution(id: str, body: Dict[str, Any], user=Depends(get_current_user)):
    _require_bassett_writer(user)
    raise HTTPException(
        410,
        "Legacy Bassett executions are read-only. Create a canonical Bassett Test Run with POST /api/bassett/issues.",
    )

@api.get("/bassett/findings")
async def bassett_findings(
    issue_id: Optional[str] = None, execution_id: Optional[str] = None,
    user=Depends(get_current_user),
):
    """Return only findings explicitly linked to a Bassett issue or test run."""
    findings = await db.findings.find({}, {"_id": 0}).to_list(5000)
    issues = await db.bassett_issues.find({}, {"_id": 0, "id": 1, "finding_id": 1}).to_list(5000)
    executions = await db.bassett_executions.find({}, {"_id": 0, "id": 1, "finding_id": 1}).to_list(5000)
    issue_links = {issue.get("finding_id"): issue["id"] for issue in issues if issue.get("finding_id")}
    execution_links = {run.get("finding_id"): run["id"] for run in executions if run.get("finding_id")}
    linked = []
    for finding in findings:
        linked_issue = finding.get("bassett_issue_id") or issue_links.get(finding.get("id"))
        linked_execution = finding.get("bassett_execution_id") or execution_links.get(finding.get("id"))
        if not linked_issue and not linked_execution:
            continue
        if issue_id and linked_issue != issue_id:
            continue
        if execution_id and linked_execution != execution_id:
            continue
        linked.append({**finding, "bassett_issue_id": linked_issue, "bassett_execution_id": linked_execution})
    return linked

@api.post("/bassett/executions/{id}/create-finding")
@api.post("/bassett/executions/{id}/findings")
async def bassett_execution_create_finding(id: str, body: Dict[str, Any] = None, user=Depends(get_current_user)):
    """Explicit, idempotent action; recording a failed run never creates a finding."""
    _require_bassett_writer(user)
    execution = await _bassett_ref("bassett_executions", id, "Bassett test run")
    existing = await db.findings.find_one({"bassett_execution_id": id}, {"_id": 0})
    if not existing and execution.get("finding_id"):
        existing = await db.findings.find_one({"id": execution["finding_id"]}, {"_id": 0})
    if existing:
        return {"created": False, "finding": existing}
    body = body or {}
    issue = None
    if execution.get("issue_id"):
        issue = await _bassett_ref("bassett_issues", execution["issue_id"], "Bassett issue")
        _require_mutable_bassett_issue(issue)
        if issue.get("finding_id"):
            existing = await _bassett_ref("findings", issue["finding_id"], "Finding")
            await db.bassett_executions.update_one({"id": id}, {"$set": {
                "finding_id": existing["id"], "updated_at": now_iso(),
            }})
            return {"created": False, "finding": existing}
    finding = {
        "id": new_id(),
        "title": body.get("title") or (issue or {}).get("title") or f"Bassett run {id}",
        "description": body.get("description") or (issue or {}).get("exact_bassett_answer") or execution.get("notes", ""),
        "expected_behavior": body.get("expected_behavior") or (issue or {}).get("verified_correct_answer", ""),
        "project_id": body.get("project_id") or (issue or {}).get("project_id"),
        "testcase_id": body.get("testcase_id") or (issue or {}).get("testcase_id"),
        "developer_status": "New", "criticality": body.get("criticality") or (issue or {}).get("severity", "Medium"),
        "bassett_execution_id": id, "bassett_issue_id": (issue or {}).get("id"),
        "created_at": now_iso(), "created_by": user.get("name"), "updated_at": now_iso(),
    }
    await _require_active_testcase(finding.get("testcase_id"))
    await db.findings.insert_one(finding)
    await db.bassett_executions.update_one({"id": id}, {"$set": {"finding_id": finding["id"], "updated_at": now_iso()}})
    if issue:
        await db.bassett_issues.update_one({"id": issue["id"]}, {"$set": {"finding_id": finding["id"], "updated_at": now_iso()}})
        await _bassett_history("issue", issue["id"], "finding_created_from_execution", user,
                               {"finding_id": finding["id"], "execution_id": id})
    await _bassett_history("execution", id, "finding_created", user, {"finding_id": finding["id"]})
    return {"created": True, "finding": finding}

@api.get("/bassett/metrics")
async def bassett_metrics(version_id: Optional[str] = None, environment: Optional[str] = None,
                           user=Depends(get_current_user)):
    scenarios = await db.bassett_scenarios.find({"archived": {"$ne": True}}, {"_id": 0}).to_list(5000)
    issues = await db.bassett_issues.find({"archived": {"$ne": True}}, {"_id": 0}).to_list(5000)
    executions = await db.bassett_executions.find({}, {"_id": 0}).to_list(10000)
    # A linked legacy execution and canonical issue describe one run.  Never
    # allow the migration representation to inflate coverage or pass rates.
    metric_runs = _canonical_bassett_lineages(
        issues, executions, active_scenario_ids={scenario["id"] for scenario in scenarios}
    )
    if version_id:
        metric_runs = [e for e in metric_runs if e.get("version_id") == version_id or e.get("bassett_version") == version_id]
    if environment:
        metric_runs = [e for e in metric_runs if e.get("environment") == environment]
    # Keep legacy result text intact, but calculate canonical metrics using its
    # documented equivalent (Incomplete == Not Evaluated).
    classified = [(e, _canonical_bassett_result(e.get("result"))) for e in metric_runs]
    completed = [e for e, result in classified if result != "Not Evaluated"]
    pass_rate_runs = [
        e for e in completed if _canonical_bassett_result(e.get("result")) != "Blocked"
    ]
    passed_runs = [
        e for e in pass_rate_runs if _canonical_bassett_result(e.get("result")) in ("Pass", "Pass with Notes")
    ]
    attention_runs = [
        e for e in completed if _canonical_bassett_result(e.get("result")) in ("Partial", "Fail", "Blocked")
    ]
    eligible = pass_rate_runs
    active_scenario_ids = {scenario["id"] for scenario in scenarios}
    completed_scenarios = {e.get("scenario_id") for e in completed if e.get("scenario_id") in active_scenario_ids}
    passed = passed_runs
    failure_breakdown = Counter(
        (next((s.get("workflow_stage") for s in scenarios if s["id"] == e.get("scenario_id")), "Unclassified"))
        for e in attention_runs if _canonical_bassett_result(e.get("result")) in ("Partial", "Fail")
    )
    all_findings = await db.findings.find({}, {"_id": 0, "id": 1, "bassett_issue_id": 1, "bassett_execution_id": 1}).to_list(5000)
    issue_finding_ids = {
        issue.get("finding_id") for issue in issues if issue.get("finding_id")
    }
    execution_finding_ids = {
        execution.get("finding_id") for execution in executions if execution.get("finding_id")
    }
    actual_findings = [
        finding for finding in all_findings
        if finding.get("bassett_issue_id") or finding.get("bassett_execution_id")
        or finding.get("id") in issue_finding_ids or finding.get("id") in execution_finding_ids
    ]
    covered_scenarios = {
        e.get("scenario_id") for e in metric_runs
        if _bassett_result_details(e.get("result"))["canonical_result"] != "Not Evaluated"
        and e.get("scenario_id") in active_scenario_ids
    }
    test_bank_coverage = {
        "total": len(scenarios), "covered": len(covered_scenarios),
        "percent": round(len(covered_scenarios) / len(scenarios) * 100, 1) if scenarios else 0,
    }
    return {
        "issues": {
            "total": len(issues), "new": sum(i.get("status") == "New" for i in issues),
            "open": sum(i.get("status") not in ("Resolved", "Closed") for i in issues),
            "critical": sum(str(i.get("severity", "")).lower() in ("critical", "high", "5", "4") for i in issues),
        },
        "scenarios": {"active": len(scenarios), "with_execution": len(completed_scenarios)},
        "executions": {
            "total": len(metric_runs), "eligible": len(eligible), "passed": len(passed),
            "failed": len(eligible) - len(passed), "blocked": sum(result == "Blocked" for _, result in classified),
            "incomplete": sum(result == "Not Evaluated" for _, result in classified),
            "completion_percent": round(len(completed_scenarios) / len(scenarios) * 100, 1) if scenarios else 0,
            "pass_percent": round(len(passed) / len(eligible) * 100, 1) if eligible else 0,
        },
        # Canonical test-run metrics.  `executions` remains above unchanged for
        # integrations that still consume the original Bassett workspace keys.
        "test_runs": {
            "total": len(metric_runs), "completed": len(completed), "attention": len(attention_runs),
            "eligible": len(pass_rate_runs), "passed": len(passed_runs),
            "failed": len(pass_rate_runs) - len(passed_runs),
            "blocked": sum(result == "Blocked" for _, result in classified),
            "incomplete": sum(result == "Not Evaluated" for _, result in classified),
            "actual_findings": len(actual_findings),
            "pass_rate": round(len(passed_runs) / len(pass_rate_runs) * 100, 1) if pass_rate_runs else None,
            "test_bank_coverage": test_bank_coverage,
            "test_bank": {"coverage": test_bank_coverage["percent"], **test_bank_coverage},
            "definition": "Completed excludes Not Evaluated (and legacy Incomplete). Attention is Partial, Fail, or Blocked. Pass rate excludes Blocked and Not Evaluated.",
        },
        "failure_breakdown": [{"label": key, "count": value} for key, value in failure_breakdown.most_common()],
        "scope": {"version_id": version_id, "environment": environment},
    }

def _bassett_csv_rows(resource, docs):
    fields = {
        "issues": ["id", "title", "question_asked", "exact_bassett_answer", "verified_correct_answer",
                   "issue_category", "severity", "priority", "status", "scenario_id", "finding_id",
                   "bassett_version", "environment", "test_date", "reported_date", "result", "score",
                   "resolution", "archived", "archived_at"],
        "scenarios": ["id", "stable_id", "workflow_stage", "report_type", "test_scenario", "complexity",
                      "why_it_matters", "what_bassett_should_do", "success_criteria", "priority",
                      "bassett_version", "project_id", "testcase_id", "archived", "archived_at"],
    }[resource]
    output = io.StringIO()
    writer = csv.DictWriter(output, fieldnames=fields, extrasaction="ignore")
    writer.writeheader()
    writer.writerows(
        _normalize_bassett_stage_record(doc) if resource == "scenarios" else doc
        for doc in docs
    )
    return output.getvalue()

@api.get("/bassett/export/{resource}.csv")
async def bassett_export_csv(resource: str, include_archived: bool = False, user=Depends(get_current_user)):
    if resource not in ("issues", "scenarios"):
        raise HTTPException(404, "Unknown Bassett export")
    collection = "bassett_" + resource
    scope = {} if include_archived else {"archived": {"$ne": True}}
    docs = await db[collection].find(scope, {"_id": 0}).sort("created_at", 1).to_list(10000)
    return Response(content=_bassett_csv_rows(resource, docs), media_type="text/csv",
                    headers={
                        "Content-Disposition": f'attachment; filename="bassett-{resource}-{"all" if include_archived else "active"}.csv"',
                        "X-Export-Scope": "all" if include_archived else "active",
                    })

async def _bassett_import_preview(resource, rows):
    if resource not in ("issues", "scenarios") or not isinstance(rows, list):
        raise HTTPException(400, "Rows must be a list for issues or scenarios")
    scenario_required = ["workflow_stage", "report_type", "test_scenario", "complexity",
                         "why_it_matters", "what_bassett_should_do", "success_criteria"]
    issue_required = ["question_asked", "exact_bassett_answer", "verified_correct_answer"]
    seen = set()
    preview = []
    for index, row in enumerate(rows):
        if not isinstance(row, dict):
            preview.append({"row": index + 1, "valid": False, "errors": ["Row must be an object"]})
            continue
        if resource == "scenarios" and "workflow_stage" in row:
            row["workflow_stage"] = _canonical_bassett_workflow_stage(row["workflow_stage"])
        stable = str(row.get("stable_id") or "").strip()
        key = stable if resource == "scenarios" else str(row.get("id") or "")
        existing_issue = (
            await db.bassett_issues.find_one({"id": key}, {"_id": 0})
            if resource == "issues" and key else None
        )
        required = scenario_required if resource == "scenarios" else [
            *(["scenario_id"] if not existing_issue else []), *issue_required,
        ]
        errors = [f"{field} is required" for field in required if not str(row.get(field) or "").strip()]
        if resource == "scenarios":
            requested_id = str(row.get("id") or "").strip()
            existing = (
                await db["bassett_scenarios"].find_one({"stable_id": stable}, {"_id": 0})
                if stable and not errors else None
            )
            # CSV exports include the database ID.  It is never a matching key:
            # a stable ID selects an existing record, and a new record receives
            # its ID (and stable ID) from the server.
            if stable and not existing:
                errors.append("stable_id is only allowed for an exact existing scenario")
            if requested_id and not stable:
                errors.append("Scenario row IDs are server assigned")
            if not errors:
                try:
                    await _workflow_stage(str(row.get("workflow_stage") or "").strip())
                except HTTPException as exc:
                    errors.append(str(exc.detail))
        if resource == "issues" and row.get("status") and row["status"] not in BASSETT_ISSUE_STATUSES[:-1]:
            errors.append("Invalid issue status")
        if resource == "issues":
            candidate = {**(existing_issue or {}), **row}
            for field in ("scenario_id", "test_date", "result"):
                if existing_issue and row.get(field) in (None, ""):
                    candidate[field] = existing_issue.get(field)
            if row.get("test_date") not in (None, ""):
                try:
                    row["test_date"] = _validate_test_date(row.get("test_date"))
                    candidate["test_date"] = row["test_date"]
                except HTTPException as exc:
                    errors.append(str(exc.detail))
            elif not existing_issue:
                errors.append("Test Date is required")
            supplied_result = str(row.get("result") or "").strip()
            if (
                existing_issue and supplied_result
                and supplied_result != str(existing_issue.get("result") or "")
                and supplied_result not in BASSETT_CANONICAL_RESULTS
            ):
                errors.append("A replacement result must use the canonical result vocabulary")
            try:
                _validate_bassett_run_result(
                    candidate,
                    allow_legacy=bool(
                        existing_issue and (
                            not supplied_result
                            or supplied_result == str(existing_issue.get("result") or "")
                        )
                    ),
                )
                if not existing_issue:
                    row["result"], row["score"] = candidate["result"], candidate["score"]
            except HTTPException as exc:
                errors.append(str(exc.detail))
            try:
                await _validate_bassett_refs(candidate, require_scenario=not existing_issue)
                if not existing_issue:
                    scenario = await db.bassett_scenarios.find_one(
                        {"id": str(candidate.get("scenario_id") or "")}, {"_id": 0}
                    )
                    _validate_scenario_required(scenario)
            except HTTPException as exc:
                errors.append(str(exc.detail))
        else:
            try:
                await _validate_bassett_refs(dict(row))
            except HTTPException as exc:
                errors.append(str(exc.detail))
        if key and key in seen:
            errors.append("Duplicate identifier in upload")
        if key:
            seen.add(key)
        preview.append({"row": index + 1, "identifier": key or None, "valid": not errors, "errors": errors, "data": row})
    existing = await db["bassett_" + resource].find({}, {"_id": 0, "id": 1, "stable_id": 1}).to_list(10000)
    existing_keys = (
        {str(r.get("stable_id")) for r in existing if r.get("stable_id")}
        if resource == "scenarios"
        else {str(r.get("id")) for r in existing}
    )
    return {"resource": resource, "total": len(preview), "valid": sum(x["valid"] for x in preview),
            "invalid": sum(not x["valid"] for x in preview), "updates": sum(x["identifier"] in existing_keys for x in preview),
            "rows": preview}

@api.post("/bassett/{resource}/csv/preview")
async def bassett_csv_preview(resource: str, body: Dict[str, Any], user=Depends(get_current_user)):
    return await _bassett_import_preview(resource, body.get("rows", []))

@api.post("/bassett/{resource}/csv/import")
async def bassett_csv_import(resource: str, body: Dict[str, Any], user=Depends(get_current_user)):
    _require_bassett_manager(user)
    preview = await _bassett_import_preview(resource, body.get("rows", []))
    if preview["invalid"]:
        raise HTTPException(400, "Fix invalid rows before importing")
    imported, updated = 0, 0
    collection = "bassett_" + resource
    operations = []
    for item in preview["rows"]:
        row = dict(item["data"])
        identifier = row.get("id")
        if resource == "scenarios":
            stable_id = str(row.get("stable_id") or "").strip()
            existing = await db[collection].find_one(
                {"stable_id": stable_id}, {"_id": 0}
            ) if stable_id else None
            if existing:
                _require_mutable_bassett_scenario(existing)
                row.pop("id", None)
                incoming = {key: value for key, value in row.items() if key in BASSETT_SCENARIO_FIELDS}
                incoming["workflow_stage"] = _canonical_bassett_workflow_stage(
                    incoming.get("workflow_stage", existing.get("workflow_stage"))
                )
                document = {**existing, **incoming, "updated_at": now_iso()}
                if "test_date" in incoming:
                    document["test_date"] = _validate_test_date(incoming.get("test_date"))
                _validate_scenario_required(document)
                await _validate_bassett_refs(document)
                operations.append((True, document))
                updated += 1
                continue
            document = {key: value for key, value in row.items() if key in BASSETT_SCENARIO_FIELDS}
            document["workflow_stage"] = _canonical_bassett_workflow_stage(document.get("workflow_stage"))
            _validate_scenario_required(document)
            await _validate_bassett_refs(document)
            stage = await _workflow_stage(str(document["workflow_stage"]).strip())
            document.update({
                "id": new_id(), "priority": document.get("priority") or "Medium",
                "archived": False, "created_at": now_iso(), "created_by": user.get("name"),
                "updated_at": now_iso(),
            })
            document["_stage_code"] = stage["code"]
        else:
            existing = await db[collection].find_one({"id": str(identifier)}, {"_id": 0}) if identifier else None
            if existing:
                _require_mutable_bassett_issue(existing)
                row.pop("id", None)
                incoming = {key: value for key, value in row.items() if key in BASSETT_ISSUE_FIELDS}
                for preserved_field in ("scenario_id", "test_date", "result"):
                    if incoming.get(preserved_field) in (None, ""):
                        incoming.pop(preserved_field, None)
                document = {**existing, **incoming, "updated_at": now_iso()}
                _validate_issue_required(document)
                if document.get("scenario_id") != existing.get("scenario_id"):
                    raise HTTPException(409, "A test run's Test Bank scenario link is immutable")
                _validate_bassett_run_result(document, allow_legacy=True)
                if document.get("status") not in BASSETT_ISSUE_STATUSES[:-1]:
                    raise HTTPException(400, "Invalid issue status")
                await _validate_bassett_refs(document)
                operations.append((True, document))
                updated += 1
                continue
            document = {key: value for key, value in row.items() if key in BASSETT_ISSUE_FIELDS}
            document["test_date"] = _validate_test_date(document.get("test_date"))
            _validate_issue_required(document)
            _validate_bassett_run_result(document)
            if document.get("status") not in (None, *BASSETT_ISSUE_STATUSES[:-1]):
                raise HTTPException(400, "Invalid issue status")
            await _validate_bassett_refs(document, require_scenario=True)
            document.update({
                "id": identifier or new_id(), "status": document.get("status") or "New",
                "issue_category": document.get("issue_category") or "General",
                "severity": document.get("severity") or "Medium",
                "priority": document.get("priority") or "Medium",
                "reported_date": document.get("reported_date"),
                "creation_key": f"csv:{identifier or new_id()}",
                "reporter_id": user["id"], "reporter": user.get("name"), "archived": False,
                "created_at": now_iso(), "created_by": user.get("name"), "updated_at": now_iso(),
                "_canonical_create": True,
            })
        operations.append((False, document))
        imported += 1
    try:
        standard_operations = [
            (exists, document) for exists, document in operations
            if not (resource == "scenarios" and "_stage_code" in document)
            and not document.get("_canonical_create")
        ]
        if standard_operations:
            await db.atomic_upsert_documents(collection, standard_operations)
        if resource == "scenarios":
            for _exists, document in operations:
                stage_code = document.pop("_stage_code", None)
                if stage_code:
                    document.update(await db.create_bassett_scenario(document, stage_code))
        elif resource == "issues":
            for index, (exists, document) in enumerate(operations):
                if exists or not document.pop("_canonical_create", False):
                    continue
                stored, created = await db.create_bassett_issue(
                    document, document.get("creation_key"), BASSETT_DEFINITION_SNAPSHOT_FIELDS,
                )
                operations[index] = (not created, stored)
    except BassettScenarioUnavailableError as error:
        raise HTTPException(400, str(error))
    except BassettScenarioInvalidError as error:
        raise HTTPException(409, str(error))
    except UniqueViolationError:
        raise HTTPException(409, "The import conflicts with an existing stable identifier")
    for exists, document in operations:
        await _bassett_history(
            "scenario" if resource == "scenarios" else "issue",
            document["id"], "import_updated" if exists else "import_created", user,
            {"source": "csv_import"},
        )
    return {"ok": True, "imported": imported, "updated": updated, "preview": preview}

@api.post("/bassett/reference-data/preview")
async def bassett_reference_preview(body: Dict[str, Any], user=Depends(get_current_user)):
    _require_bassett_manager(user)
    rows = body.get("rows", [])
    return await _bassett_import_preview("scenarios", rows)

@api.post("/bassett/reference-data/import")
async def bassett_reference_import(body: Dict[str, Any], user=Depends(get_current_user)):
    _require_bassett_manager(user)
    return await bassett_csv_import("scenarios", body, user)

# ---------- Relational fetch helpers ----------
@api.get("/testcases/{id}/full")
async def testcase_full(id: str, user=Depends(get_current_user)):
    tc = await crud_get("testcases", id)
    responses = await crud_list("responses", {"testcase_id": id})
    annotations = await crud_list("annotations", {"testcase_id": id})
    claims = await crud_list("claims", {"testcase_id": id})
    gold = await db.goldstandards.find_one({"testcase_id": id}, {"_id": 0})
    evals = await db.evaluations.find({"testcase_id": id}, {"_id": 0}).sort(
        [("created_at", -1), ("id", -1)]
    ).to_list(5000)
    evals = await _authoritative_evaluation_read_model(evals)
    findings = await crud_list("findings", {"testcase_id": id})
    retests = await crud_list("retests", {"testcase_id": id})
    activities = await db.activities.find({"entity_id": id, "source": {"$ne": "automated_test"}}, {"_id": 0}).sort("created_at", -1).to_list(200)
    evidence_ids = tc.get("evidence_ids", [])
    evidence = await db.evidence.find({"id": {"$in": evidence_ids}}, {"_id": 0}).to_list(200) if evidence_ids else []
    # Freshness: flag evidence older than the municipality's latest known ordinance amendment
    munis_map = {m["id"]: m for m in await crud_list("municipalities")}
    for ev in evidence:
        m = munis_map.get(ev.get("municipality_id"))
        lad = (m or {}).get("latest_amendment_date")
        eff = ev.get("effective_date")
        if ev.get("superseded_date"):
            ev["freshness_warning"] = f"Superseded on {ev['superseded_date']} — do not rely on this version."
        elif lad and eff and eff < lad:
            ev["freshness_warning"] = f"Predates {m['name']}'s latest known amendment ({lad}) — re-verify against the current ordinance."
    project = await db.projects.find_one({"id": tc.get("project_id")}, {"_id": 0})
    muni = await db.municipalities.find_one({"id": tc.get("municipality_id")}, {"_id": 0})
    prop = await db.properties.find_one({"id": tc.get("property_id")}, {"_id": 0})
    variants = await db.testcases.find({"variant_of": id}, {"_id": 0, "id": 1, "name": 1, "status": 1, "created_at": 1}).to_list(50)
    for v in variants:
        v_evals = await db.evaluations.find({"testcase_id": v["id"], "model": "Bassett"}, {"_id": 0, "final_result": 1, "created_at": 1}).sort(
            [("created_at", -1), ("id", -1)]
        ).to_list(1)
        v["latest_result"] = v_evals[0]["final_result"] if v_evals else None
    parent = await db.testcases.find_one({"id": tc.get("variant_of")}, {"_id": 0, "id": 1, "name": 1}) if tc.get("variant_of") else None
    test_runs = await db.test_runs.find({"testcase_id": id}, {"_id": 0}).sort("run_date", -1).to_list(50)
    latest_comparison = next(
        (run for run in test_runs if run.get("model_slots") or set(run.get("models") or []) == {"Bassett", "ChatGPT", "Claude"}),
        None,
    )
    gold_stale_evidence = [ev.get("document_name", "evidence") for ev in evidence if ev.get("freshness_warning")]
    return {"testcase": tc, "responses": responses, "gold_standard": gold, "evaluations": evals,
            "findings": findings, "retests": retests, "activities": activities, "evidence": evidence,
            "project": project, "municipality": muni, "property": prop, "annotations": annotations,
            "claims": claims, "variants": variants, "parent": parent, "test_runs": test_runs,
            "comparison": {"status": (latest_comparison or {}).get("status", "Incomplete"),
                           "complete": bool((latest_comparison or {}).get("comparison_complete")),
                           "model_slots": (latest_comparison or {}).get("model_slots", {})},
            "gold_stale": bool(gold and gold_stale_evidence), "gold_stale_evidence": gold_stale_evidence}

@api.get("/list/testcases-enriched")
async def testcases_enriched(include_archived: bool = False, user=Depends(get_current_user)):
    tcs = await crud_list("testcases", include_archived=include_archived)
    projects = {p["id"]: p for p in await crud_list("projects")}
    munis = {m["id"]: m for m in await crud_list("municipalities")}
    evals = await _exclude_incomplete_comparison_evaluations(
        await _authoritative_evaluation_read_model(await crud_list("evaluations"))
    )
    stale_map = await compute_stale_gold_map()
    eval_by_tc = {}
    for e in evals:
        eval_by_tc.setdefault(e["testcase_id"], []).append(e)
    for tc in tcs:
        tc["project_name"] = projects.get(tc.get("project_id"), {}).get("name")
        m = munis.get(tc.get("municipality_id"))
        tc["municipality_name"] = f"{m['name']}, {m['state']}" if m else None
        bassett_evals = [e for e in eval_by_tc.get(tc["id"], []) if e.get("model") == "Bassett"]
        latest_rows = latest_evaluations(bassett_evals, lambda evaluation: evaluation["testcase_id"])
        latest = latest_rows[0] if latest_rows else None
        tc["bassett_result"] = latest.get("final_result") if latest else None
        if not tc.get("test_date") and latest and latest.get("test_date"):
            tc["test_date"] = latest["test_date"]
            tc["test_date_source"] = "Latest Bassett evaluation"
        tc["gold_stale"] = tc["id"] in stale_map
    return tcs


@api.get("/list/projects-enriched")
async def projects_enriched(user=Depends(get_current_user)):
    projects = await crud_list("projects")
    testcases = await crud_list("testcases")
    projects = _enrich_project_completions(projects, testcases)
    users = {record["id"]: record for record in await crud_list("users") if record.get("active", True)}
    last_tested = await _current_project_last_tested_dates(projects)
    for project in projects:
        linked_owner = users.get(project.get("owner_id"), {})
        project["owner"] = linked_owner.get("name") or project.get("owner")
        project["last_tested_date"] = last_tested.get(project.get("id"))
        project["last_tested_scope"] = (
            "Latest explicit Test Date from an active linked Test Case, a completed linked "
            "standard Test Run, linked evaluation, or a recorded project-linked canonical Bassett run."
        )
    return projects

# ---------- Comments & Activity ----------
@api.get("/comments/{entity_id}")
async def get_comments(entity_id: str, user=Depends(get_current_user), include_test_data: str = "false"):
    filt = {"entity_id": entity_id}
    if include_test_data.lower() != "true":
        filt["source"] = {"$ne": "automated_test"}
    return await db.comments.find(filt, {"_id": 0}).sort("created_at", 1).to_list(500)

@api.post("/comments")
async def add_comment(body: Dict[str, Any], user=Depends(require_writer)):
    text = (body.get("text") or "").strip()
    if not text:
        raise HTTPException(400, "Comment text required")
    await _guard_testcase_linked_document(body, body.get("entity_type"))
    parent_id = body.get("parent_id")
    if parent_id:
        parent = await db.comments.find_one({"id": parent_id}, {"_id": 0})
        if not parent:
            raise HTTPException(404, "Parent comment not found")
        if parent.get("parent_id"):
            parent_id = parent["parent_id"]  # keep threads one level deep — reply to a reply attaches to the root
    # mentions: list of {id, name} chosen from the @-picker; validate against real users
    mentions = []
    for m in (body.get("mentions") or [])[:10]:
        u = await db.users.find_one({"id": m.get("id")}, {"_id": 0, "id": 1, "name": 1})
        if u:
            mentions.append({"id": u["id"], "name": u["name"]})
    doc = {"id": new_id(), "entity_id": body["entity_id"], "entity_type": body.get("entity_type", ""),
           "text": text, "author": user["name"], "author_id": user["id"],
           "parent_id": parent_id or None, "mentions": mentions, "deleted": False, "created_at": now_iso()}
    if AUTOMATED_ACTIVITY_RE.search(text):
        doc["source"] = "automated_test"
    await db.comments.insert_one(doc)
    if body.get("entity_type") in ("testcases", "findings"):
        detail = f"“{text[:80]}”" + (f" — mentioned {', '.join(m['name'] for m in mentions)}" if mentions else "")
        await log_activity(body["entity_type"], body["entity_id"], "commented", user, detail)
    return clean(doc)

@api.delete("/comments/{id}")
async def delete_comment(id: str, user=Depends(require_writer)):
    c = await db.comments.find_one({"id": id}, {"_id": 0})
    if not c:
        raise HTTPException(404, "Comment not found")
    await _guard_testcase_linked_document(c, c.get("entity_type"))
    if c.get("author_id") != user["id"] and user["role"] not in ("admin", "qa_manager"):
        raise HTTPException(403, "Only the author or an admin can delete this comment")
    # Soft delete so replies keep their thread context
    await db.comments.update_one({"id": id}, {"$set": {"deleted": True, "text": "", "mentions": [],
                                                       "deleted_by": user["name"], "deleted_at": now_iso()}})
    return {"ok": True}

# ---------- Assignments ----------
ASSIGNABLE = {"testcases": "testcases", "findings": "findings", "evaluations": "evaluations"}

@api.post("/assign")
async def assign_entity(body: Dict[str, Any], user=Depends(require_writer)):
    etype, eid = body.get("entity_type"), body.get("entity_id")
    if etype not in ASSIGNABLE:
        raise HTTPException(400, f"entity_type must be one of {list(ASSIGNABLE)}")
    doc = await db[ASSIGNABLE[etype]].find_one({"id": eid}, {"_id": 0})
    if not doc:
        raise HTTPException(404, f"{etype} not found")
    if etype == "testcases" and doc.get("archived"):
        raise HTTPException(409, "Archived test cases are read-only")
    assignee_id = body.get("assignee_id")
    if assignee_id:
        assignee = await db.users.find_one(
            {"id": assignee_id, "active": {"$ne": False}, "deleted_at": {"$exists": False}},
            {"_id": 0, "id": 1, "name": 1}
        )
        if not assignee:
            raise HTTPException(404, "Active assignee user not found")
        fields = {"assignee_id": assignee["id"], "assignee_name": assignee["name"],
                  "assigned_by": user["name"], "assigned_at": now_iso(), "updated_at": now_iso()}
        action = f"assigned to {assignee['name']}"
    else:
        fields = {"assignee_id": None, "assignee_name": None,
                  "assigned_by": user["name"], "assigned_at": now_iso(), "updated_at": now_iso()}
        action = "unassigned"
    await db[ASSIGNABLE[etype]].update_one({"id": eid}, {"$set": fields})
    await log_activity(etype, eid, action, user)
    return await crud_get(ASSIGNABLE[etype], eid)

@api.get("/activities")
async def all_activities(user=Depends(get_current_user), include_test_data: str = "false"):
    filt = {}
    if not (include_test_data.lower() == "true" and user["role"] in ("admin", "qa_manager")):
        filt = {"source": {"$ne": "automated_test"}}
    activities = await db.activities.find(filt, {"_id": 0}).sort("created_at", -1).to_list(300)
    return [_public_activity(activity, user["role"]) for activity in activities]


EMAIL_PATTERN = re.compile(r"\b([A-Z0-9._%+-])([A-Z0-9._%+-]*)(@)([A-Z0-9.-]+\.[A-Z]{2,})\b", re.I)
UUID_PATTERN = re.compile(r"\b[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b", re.I)


def _mask_email(value):
    def replace(match):
        local = match.group(1)
        return f"{local}***@{match.group(4)}"
    return EMAIL_PATTERN.sub(replace, str(value or ""))


def _safe_audit_value(value):
    if isinstance(value, dict):
        return {
            key: ("[masked]" if key.lower() in {"previous_email", "recipient", "recipient_email", "email"} else _safe_audit_value(item))
            for key, item in value.items()
        }
    if isinstance(value, list):
        return [_safe_audit_value(item) for item in value]
    if isinstance(value, str):
        return _mask_email(value)
    return value


def _activity_summary(activity):
    action = UUID_PATTERN.sub("record", _mask_email(activity.get("action") or "Activity recorded"))
    entity = str(activity.get("entity_type") or "").replace("_", " ").strip()
    if entity and entity.lower() not in action.lower():
        return f"{action} · {entity.title()}"
    return action


def _public_activity(activity, role):
    return {
        "id": activity.get("id"),
        "entity_type": activity.get("entity_type"),
        "summary": _activity_summary(activity),
        "user": _mask_email(activity.get("user") or "System"),
        "created_at": activity.get("created_at"),
        "audit_detail_available": role == "admin",
    }


@api.get("/activities/{id}")
async def activity_audit_detail(id: str, admin=Depends(require_roles("admin"))):
    activity = await db.activities.find_one({"id": id}, {"_id": 0})
    if not activity:
        raise HTTPException(404, "Audit activity not found")
    detail = activity.get("detail")
    if isinstance(detail, str):
        try:
            detail = json.loads(detail)
        except (TypeError, ValueError, json.JSONDecodeError):
            detail = UUID_PATTERN.sub("record", _mask_email(detail))
    return {
        "id": activity.get("id"),
        "entity_type": activity.get("entity_type"),
        "entity_id": activity.get("entity_id"),
        "action": _mask_email(activity.get("action")),
        "detail": _safe_audit_value(detail),
        "user": _mask_email(activity.get("user")),
        "created_at": activity.get("created_at"),
    }

# ---------- Finding status history ----------
FINDING_CLOSED_STATUSES = frozenset(("Fixed", "Closed", "Won't Fix", "Duplicate"))
# "Fix In Progress" was emitted by older retest records.  Keep counting it
# while all newly written workflow states use the configured "In Development".
FINDING_AWAITING_FIX_STATUSES = frozenset(("In Development", "Fix In Progress"))

def _finding_is_open(finding):
    # Archived findings are historical records, even when older data retained
    # an open developer status.  Keep this predicate shared by every KPI and
    # drill-down so archived records cannot inflate current risk counts.
    return (
        not finding.get("archived")
        and finding.get("status") != "Archived"
        and finding.get("developer_status") not in FINDING_CLOSED_STATUSES
    )

async def _configured_finding_statuses():
    config = await db.config.find_one({"id": "global"}, {"_id": 0}) or DEFAULT_CONFIG
    return config.get("finding_statuses") or DEFAULT_CONFIG["finding_statuses"]

def _validate_finding_status(status, allowed_statuses):
    if not isinstance(status, str) or not status.strip():
        raise HTTPException(400, "status is required")
    normalized = status.strip()
    if normalized not in allowed_statuses:
        raise HTTPException(400, "Invalid finding status")
    return normalized

def _require_retest_target_status(status, allowed_statuses):
    if status not in allowed_statuses:
        raise HTTPException(
            409,
            f"Retest verdict requires finding status '{status}', which is not configured",
        )
    return status

@api.post("/findings/{id}/status")
async def update_finding_status(id: str, body: Dict[str, Any], user=Depends(require_writer)):
    f = await crud_get("findings", id)
    await _guard_testcase_linked_document(f)
    status = _validate_finding_status(body.get("status"), await _configured_finding_statuses())
    history = f.get("status_history", [])
    history.append({"from": f.get("developer_status"), "to": status,
                    "by": user["name"], "at": now_iso(), "note": body.get("note", "")})
    await db.findings.update_one({"id": id}, {"$set": {
        "developer_status": status, "status_history": history, "updated_at": now_iso(),
        **({"resolution": body["resolution"]} if body.get("resolution") else {}),
        **({"root_cause": body["root_cause"]} if body.get("root_cause") else {}),
    }})
    await log_activity("findings", id, f"status → {status}", user)
    return await crud_get("findings", id)

# ---------- Config (admin lookups) ----------
@api.get("/config")
async def get_config(user=Depends(get_current_user)):
    doc = await db.config.find_one({"id": "global"}, {"_id": 0})
    doc = doc or {}
    if "bassett_workflow_stages" in doc:
        doc["bassett_workflow_stages"] = _normalize_bassett_config_stages(
            doc["bassett_workflow_stages"]
        )
    doc["application_timezone"] = _application_timezone_name(doc)
    integ = doc.get("integrations") or {}
    if integ:
        doc["integrations"] = {**integ, "bassett_api_key": "", "bassett_api_key_set": bool(integ.get("bassett_api_key"))}
    return doc

def _validate_bassett_url(value: str) -> str:
    candidate = str(value or "").strip()
    parsed = urlsplit(candidate)
    allowed = {
        item.strip().lower()
        for item in os.environ.get("BASSETT_ALLOWED_HOSTS", "api.zoneomics.com").split(",")
        if item.strip()
    }
    try:
        ipaddress.ip_address(parsed.hostname or "")
        is_ip = True
    except ValueError:
        is_ip = False
    if (
        parsed.scheme != "https"
        or not parsed.hostname
        or parsed.hostname.lower() not in allowed
        or is_ip
        or parsed.username
        or parsed.password
        or parsed.query
        or parsed.fragment
        or (parsed.port not in (None, 443))
    ):
        raise HTTPException(400, "Bassett API URL must use HTTPS on an approved host")
    return candidate

@api.put("/config")
async def update_config(body: Dict[str, Any], user=Depends(get_current_user)):
    if user["role"] not in ("admin", "qa_manager"):
        raise HTTPException(403, "Admin only")
    body["id"] = "global"
    if "bassett_workflow_stages" in body:
        body["bassett_workflow_stages"] = _normalize_bassett_config_stages(
            body["bassett_workflow_stages"]
        )
    if "application_timezone" in body:
        body["application_timezone"] = _application_timezone_name(body)
    if "integrations" in body:
        existing = await db.config.find_one({"id": "global"}, {"_id": 0}) or {}
        incoming = body["integrations"] or {}
        if "bassett_api_key" in incoming:
            raise HTTPException(400, "Send Bassett credentials only through X-Bassett-API-Key")
        if "bassett_api_url" in incoming:
            incoming["bassett_api_url"] = _validate_bassett_url(incoming["bassett_api_url"])
        merged = {**(existing.get("integrations") or {}), **incoming}
        merged.pop("bassett_api_key_set", None)
        merged["bassett_api_key"] = (existing.get("integrations") or {}).get("bassett_api_key", "")
        body["integrations"] = merged
    await db.config.update_one({"id": "global"}, {"$set": body}, upsert=True)
    return await get_config(user)

@api.put("/config/bassett-key")
async def update_bassett_key(request: Request, user=Depends(require_roles("admin", "qa_manager"))):
    key = request.headers.get("X-Bassett-API-Key", "").strip()
    if not key:
        raise HTTPException(400, "X-Bassett-API-Key is required")
    existing = await db.config.find_one({"id": "global"}, {"_id": 0}) or DEFAULT_CONFIG
    integrations = {**(existing.get("integrations") or {}), "bassett_api_key": key}
    await db.config.update_one(
        {"id": "global"}, {"$set": {"integrations": integrations}}, upsert=True
    )
    return {"ok": True, "bassett_api_key_set": True}

# ---------- Dashboard / Analytics ----------
async def _authoritative_evaluation_read_model(evaluations):
    """Recalculate legacy records before any dashboard, export, or comparison read."""
    config = await db.config.find_one({"id": "global"}, {"_id": 0}) or DEFAULT_CONFIG
    dimensions = config.get("eval_dimensions", [])
    return [
        {**evaluation, **score_evaluation(evaluation.get("scores"), dimensions)}
        for evaluation in evaluations
    ]


async def _exclude_incomplete_comparison_evaluations(evaluations):
    """Keep legacy unlinked evaluations, but exclude evaluations tied to a partial run."""
    run_ids = {e.get("run_id") for e in evaluations if e.get("run_id")}
    if not run_ids:
        return evaluations
    runs = await db.test_runs.find({"id": {"$in": list(run_ids)}}, {"_id": 0}).to_list(len(run_ids))
    eligible = {
        run["id"] for run in runs
        if run.get("status") == "Completed" and run.get("outcome") != "Partial"
        and run.get("comparison_complete", True)
    }
    return [e for e in evaluations if not e.get("run_id") or e["run_id"] in eligible]

async def _complete_comparison_evaluations(
    evaluations, *, version=None, environment=None, date_from=None, date_to=None
):
    """Return the latest complete, consistently scoped three-model comparison."""
    evaluations = await _authoritative_evaluation_read_model(evaluations)
    evaluations = await _exclude_incomplete_comparison_evaluations(evaluations)
    run_ids = {evaluation.get("run_id") for evaluation in evaluations if evaluation.get("run_id")}
    runs = await db.test_runs.find(
        {"id": {"$in": list(run_ids)}}, {"_id": 0}
    ).to_list(len(run_ids)) if run_ids else []
    run_by_id = {run["id"]: run for run in runs}
    groups = {}
    for evaluation in sorted(evaluations, key=lambda item: (item.get("created_at", ""), item.get("id", ""))):
        model = evaluation.get("model")
        if model not in ("Bassett", "ChatGPT", "Claude") or not evaluation.get("testcase_id"):
            continue
        key = ("run", evaluation["run_id"]) if evaluation.get("run_id") else ("legacy", evaluation["testcase_id"])
        groups.setdefault(key, {})[model] = evaluation

    latest_complete = {}
    for slots in groups.values():
        if not all(
            slots.get(model, {}).get("final_result") not in (None, "", "Not Evaluated")
            and slots.get(model, {}).get("overall_score") is not None
            and isinstance(slots.get(model, {}).get("scores"), dict)
            for model in COMPARISON_MODELS
        ):
            continue
        bassett = slots["Bassett"]
        run = run_by_id.get(bassett.get("run_id"), {})
        group_version = bassett.get("bassett_version") or run.get("bassett_version")
        group_environment = bassett.get("environment") or run.get("environment")
        group_date = run.get("run_date") or run.get("created_at") or max(
            (slot.get("created_at", "") for slot in slots.values()), default=""
        )
        if (version and group_version != version) or (environment and group_environment != environment):
            continue
        if (date_from and group_date[:10] < date_from) or (date_to and group_date[:10] > date_to):
            continue
        testcase_id = bassett["testcase_id"]
        order = (group_date, run.get("id") or bassett.get("run_id") or bassett.get("id", ""))
        if testcase_id not in latest_complete or order > latest_complete[testcase_id][0]:
            latest_complete[testcase_id] = (order, slots)
    return [
        slots[model] for _, slots in latest_complete.values()
        for model in COMPARISON_MODELS
    ]


async def _evaluation_read_model(
    evaluations, *, valid_testcase_ids=None, version=None, environment=None,
    date_from=None, date_to=None,
):
    """Build all canonical latest-evaluation views from one eligible population."""
    eligible = await _complete_comparison_evaluations(
        evaluations, version=version, environment=environment,
        date_from=date_from, date_to=date_to,
    )
    if valid_testcase_ids is not None:
        valid_testcase_ids = set(valid_testcase_ids)
        eligible = [
            evaluation for evaluation in eligible
            if evaluation.get("testcase_id") in valid_testcase_ids
        ]
    all_models = latest_evaluations(
        eligible, lambda evaluation: (evaluation["testcase_id"], evaluation.get("model"))
    )
    bassett = latest_evaluations(
        [evaluation for evaluation in all_models if evaluation.get("model") == "Bassett"],
        lambda evaluation: evaluation["testcase_id"],
    )
    return {"eligible": eligible, "all_models": all_models, "bassett": bassett}

@api.get("/dashboard/stats")
async def dashboard_stats(user=Depends(get_current_user)):
    projects = await crud_list("projects")
    tcs = await crud_list("testcases")
    findings = [
        finding for finding in await crud_list("findings")
        if not finding.get("archived") and finding.get("status") != "Archived"
        and finding.get("testcase_id") in {testcase["id"] for testcase in tcs}
    ]
    active = await db.versions.find_one({"active": True}, {"_id": 0})
    active_version = active.get("name", "") if active else ""
    evaluation_view = (
        await _evaluation_read_model(
            await crud_list("evaluations"),
            valid_testcase_ids={testcase["id"] for testcase in tcs},
            version=active_version,
        )
        if active_version
        else {"eligible": [], "all_models": [], "bassett": []}
    )
    demos = await crud_list("demos")
    regruns = await crud_list("regression_runs")
    latest_regression = _latest_regression_run(regruns, active_version)
    project_last_tested_dates = await _current_project_last_tested_dates(projects)

    def cnt(items, key, val):
        return len([i for i in items if i.get(key) == val])

    bassett_evals = evaluation_view["bassett"]
    bassett_summary = result_summary(bassett_evals)
    accuracy = average_score(bassett_evals, empty=0)

    open_findings = [f for f in findings if _finding_is_open(f)]
    return {
        "active_projects": cnt(projects, "status", "Active"),
        "tests_ready_review": cnt(tcs, "status", "Ready for Evaluation"),
        "tests_in_progress": cnt(tcs, "status", "Testing"),
        "tests_awaiting_evidence": cnt(tcs, "status", "Awaiting Evidence"),
        "bassett_passed": bassett_summary["passed"],
        "bassett_failed": bassett_summary["failed"],
        "critical_findings": len([f for f in findings if f.get("criticality", 0) >= 4]),
        "open_findings": len(open_findings),
        "awaiting_fix": len([f for f in open_findings if f.get("developer_status") in FINDING_AWAITING_FIX_STATUSES]),
        "ready_for_retest": cnt(findings, "developer_status", "Ready for Retest"),
        "regression_failures": latest_regression.get("failed", 0) if latest_regression else 0,
        "demo_approved": cnt(demos, "status", "Approved"),
        "bassett_accuracy": accuracy,
        "total_tests": len(tcs),
        "total_findings": len(findings),
        "project_last_tested_dates": project_last_tested_dates,
    }

@api.get("/analytics/performance")
async def analytics_performance(user=Depends(get_current_user),
                                version: str = "", environment: str = "", project_id: str = "",
                                municipality_id: str = "", category: str = "", criticality: str = "",
                                include_variants: str = "true", date_from: str = "", date_to: str = ""):
    tcs = {t["id"]: t for t in await crud_list("testcases")}
    # Test-case-level filters
    if project_id:
        tcs = {k: v for k, v in tcs.items() if v.get("project_id") == project_id}
    if municipality_id:
        tcs = {k: v for k, v in tcs.items() if v.get("municipality_id") == municipality_id}
    if category:
        tcs = {k: v for k, v in tcs.items() if v.get("category") == category}
    if criticality:
        tcs = {k: v for k, v in tcs.items() if str(v.get("criticality")) == criticality}
    if include_variants.lower() == "false":
        tcs = {k: v for k, v in tcs.items() if not v.get("variant_of")}
    evaluation_view = await _evaluation_read_model(
        await crud_list("evaluations"), valid_testcase_ids=tcs,
        version=version or None, environment=environment or None,
        date_from=date_from or None, date_to=date_to or None,
    )
    evals = evaluation_view["all_models"]
    scope_parts = ["Latest non-retest evaluation for each test case",
                   f"Bassett version: {version}" if version else "regardless of Bassett version",
                   f"environment: {environment}" if environment else None,
                   "variants excluded" if include_variants.lower() == "false" else "variants included",
                   f"category: {category}" if category else None,
                   f"criticality: {criticality}" if criticality else None,
                   f"from {date_from}" if date_from else None, f"to {date_to}" if date_to else None,
                   "retests excluded", "Pass includes 'Pass with Minor Issues'"]
    scope = " · ".join([p for p in scope_parts if p])
    munis = {m["id"]: m for m in await crud_list("municipalities")}
    config = await db.config.find_one({"id": "global"}, {"_id": 0}) or DEFAULT_CONFIG
    dims = [dimension["key"] for dimension in config.get("eval_dimensions", []) if dimension.get("key")]

    by_model = {}
    for e in evals:
        m = e.get("model", "?")
        by_model.setdefault(m, {"scores": [], "pass": 0, "fail": 0})
        if e.get("overall_score") is not None:
            by_model[m]["scores"].append(e["overall_score"])
        if e.get("final_result") in PASS_RESULTS:
            by_model[m]["pass"] += 1
        elif e.get("final_result") in FAIL_RESULTS:
            by_model[m]["fail"] += 1
    model_summary = [{"model": k, "avg_score": round(sum(v["scores"]) / len(v["scores"]), 1) if v["scores"] else None,
                       "score_count": len(v["scores"]), "passed": v["pass"], "failed": v["fail"]}
                      for k, v in by_model.items()]

    # by category (Bassett only)
    cat = {}
    for e in [x for x in evals if x.get("model") == "Bassett" and x.get("overall_score") is not None]:
        c = tcs.get(e["testcase_id"], {}).get("category", "Uncategorized")
        cat.setdefault(c, [])
        cat[c].append(e["overall_score"])
    by_category = [{"category": k, "avg_score": round(sum(v) / len(v), 1), "count": len(v)} for k, v in cat.items()]

    # dimension averages Bassett
    dim_avg = {}
    b = [e for e in evals if e.get("model") == "Bassett"]
    for d in dims:
        vals = [e["scores"][d] for e in b if e.get("scores", {}).get(d) is not None]
        dim_avg[d] = round(sum(vals) / len(vals), 1) if vals else None

    # competitive: wins/losses/shared failures
    wins = losses = shared_fail = 0
    by_tc = {}
    for e in evals:
        by_tc.setdefault(e["testcase_id"], {})[e.get("model")] = e
    for tid, models in by_tc.items():
        bs = models.get("Bassett", {}).get("overall_score")
        others = [models[m].get("overall_score") for m in models if m != "Bassett" and models[m].get("overall_score") is not None]
        if bs is None or not others:
            continue
        best_other = max(others)
        if bs > best_other + 0.5:
            wins += 1
        elif bs < best_other - 0.5:
            losses += 1
        if bs < 5 and all(o < 5 for o in others):
            shared_fail += 1

    return {"model_summary": model_summary, "by_category": by_category, "dimension_averages": dim_avg,
            "wins": wins, "losses": losses, "shared_failures": shared_fail, "scope": scope}

@api.get("/comparison/{testcase_id}")
async def comparison(testcase_id: str, user=Depends(get_current_user)):
    return await testcase_full(testcase_id, user)

# ---------- Bulk CSV import ----------
PASS_SET = PASS_RESULTS
FAIL_SET = FAIL_RESULTS
CLOSED_FINDING = FINDING_CLOSED_STATUSES

# ---------- Stale Gold Standard detection (shared helper) ----------
async def compute_stale_gold_map():
    """Return {testcase_id: [stale evidence titles]} where the test's supporting evidence is stale
    (superseded, or effective before the municipality's latest known ordinance amendment)."""
    munis = {m["id"]: m for m in await crud_list("municipalities")}
    evidence = {e["id"]: e for e in await crud_list("evidence")}
    out = {}
    for tc in await crud_list("testcases"):
        stale = []
        for eid in tc.get("evidence_ids", []):
            ev = evidence.get(eid)
            if not ev:
                continue
            m = munis.get(ev.get("municipality_id"))
            lad = (m or {}).get("latest_amendment_date")
            if ev.get("superseded_date") or (lad and ev.get("effective_date") and ev["effective_date"] < lad):
                stale.append(ev.get("document_name", "evidence"))
        if stale:
            out[tc["id"]] = stale
    return out

# ---------- Canonical export population ----------
async def _canonical_report_data(kind):
    """Return the current, link-valid records that may populate an export.

    Exports must not reconstruct this population in the browser: doing so used
    to include stale evaluation revisions, partial comparison slots, and
    records whose Test Case had been archived or deleted.
    """
    if kind not in {"qa_summary", "release", "regression", "comparison", "critical", "municipality"}:
        raise HTTPException(400, "Unknown report type")

    testcases = [
        testcase for testcase in await crud_list("testcases")
        if not testcase.get("archived") and testcase.get("status") != "Archived"
    ]
    testcase_ids = {testcase["id"] for testcase in testcases}
    projects = {project["id"]: project for project in await crud_list("projects")}
    municipalities = {municipality["id"]: municipality for municipality in await crud_list("municipalities")}
    stale_map = await compute_stale_gold_map()
    for testcase in testcases:
        project = projects.get(testcase.get("project_id"), {})
        municipality = municipalities.get(testcase.get("municipality_id"))
        testcase["project_name"] = project.get("name")
        testcase["municipality_name"] = (
            f"{municipality['name']}, {municipality['state']}" if municipality else None
        )
        testcase["gold_stale"] = testcase["id"] in stale_map

    raw_evaluations = [
        evaluation for evaluation in await crud_list("evaluations")
        if not evaluation.get("archived") and not evaluation.get("superseded")
        and evaluation.get("testcase_id") in testcase_ids
    ]
    # A linked run must be a completed, non-partial run.  Unlinked legacy
    # evaluations remain supported, but a dangling run link is not evidence.
    raw_evaluations = await _exclude_incomplete_comparison_evaluations(raw_evaluations)
    linked_run_ids = {evaluation.get("run_id") for evaluation in raw_evaluations if evaluation.get("run_id")}
    existing_run_ids = {
        run["id"] for run in await db.test_runs.find(
            {"id": {"$in": list(linked_run_ids)}}, {"_id": 0, "id": 1}
        ).to_list(len(linked_run_ids))
    } if linked_run_ids else set()
    evaluations = [
        evaluation for evaluation in await _authoritative_evaluation_read_model(raw_evaluations)
        if not evaluation.get("run_id") or evaluation["run_id"] in existing_run_ids
    ]
    evaluations = latest_evaluations(
        evaluations, lambda evaluation: (evaluation["testcase_id"], evaluation.get("model"))
    )

    findings = [
        finding for finding in await crud_list("findings")
        if not finding.get("archived") and finding.get("status") != "Archived"
        and finding.get("testcase_id") in testcase_ids
    ]
    runs = []
    for run in await crud_list("regression_runs"):
        if run.get("archived"):
            continue
        result_ids = {
            result.get("testcase_id") for result in run.get("results", [])
            if result.get("testcase_id") in testcase_ids
        }
        declared_ids = {identifier for identifier in run.get("testcase_ids", []) if identifier in testcase_ids}
        if not result_ids and not declared_ids:
            continue
        # Do not expose orphan members through an otherwise valid run.
        clean_run = dict(run)
        if "results" in clean_run:
            clean_run["results"] = [
                result for result in clean_run["results"] if result.get("testcase_id") in testcase_ids
            ]
        if "testcase_ids" in clean_run:
            clean_run["testcase_ids"] = [
                identifier for identifier in clean_run["testcase_ids"] if identifier in testcase_ids
            ]
        runs.append(clean_run)

    if kind != "regression":
        # A release report is current state, not a regression-history export.
        active = await db.versions.find_one({"active": True}, {"_id": 0})
        latest = _latest_regression_run(
            [run for run in runs if not active or run.get("bassett_version") == active.get("name")]
        )
        runs = [latest] if latest else []

    test_runs = [
        run for run in await db.test_runs.find(
            {"id": {"$in": list(linked_run_ids)}}, {"_id": 0}
        ).to_list(len(linked_run_ids))
    ] if linked_run_ids else []
    return {
        "testcases": testcases, "findings": findings, "evaluations": evaluations,
        "regression_runs": runs, "test_runs": test_runs,
    }


@api.get("/reports/data")
async def report_data(kind: str = "qa_summary", user=Depends(get_current_user)):
    """Canonical source records for a JSON report export."""
    records = await _canonical_report_data(kind)
    return {**records, "stats": await dashboard_stats(user)}

# ---------- Regression suite execution ----------
def _delta_status(baseline_result, current_result):
    b_pass = baseline_result in PASS_SET
    b_fail = baseline_result in FAIL_SET
    c_pass = current_result in PASS_SET
    c_fail = current_result in FAIL_SET
    if not current_result:
        return "not_evaluated"
    if baseline_result is None:
        return "new"
    if b_fail and c_pass:
        return "improved"
    if b_pass and c_fail:
        return "regressed"
    if c_pass:
        return "still_pass"
    if c_fail:
        return "still_fail"
    return "unchanged"

@api.post("/regression/suites/{id}/execute")
async def execute_regression_suite(id: str, body: Dict[str, Any], user=Depends(require_writer)):
    suite = await crud_get("regression_suites", id)
    if suite.get("archived") or suite.get("status") == "Archived":
        raise HTTPException(409, "Archived regression suites are immutable")
    version = (body.get("bassett_version") or "").strip()
    if not version:
        raise HTTPException(400, "bassett_version is required")
    tc_ids = await _require_active_testcase_ids(suite.get("testcase_ids"))
    tcs = {t["id"]: t for t in await db.testcases.find({"id": {"$in": tc_ids}}, {"_id": 0, "id": 1, "name": 1}).to_list(500)}
    archived_ids = [
        t["id"] for t in await db.testcases.find(
            {"id": {"$in": tc_ids}, "archived": True}, {"_id": 0, "id": 1}
        ).to_list(500)
    ]
    if archived_ids:
        raise HTTPException(409, "Suite contains archived test cases. Remove or restore them before execution.")

    # Current state: latest Bassett evaluation per test case at execution time
    evaluation_view = await _evaluation_read_model(
        await db.evaluations.find({"testcase_id": {"$in": tc_ids}}, {"_id": 0}).to_list(6000),
        valid_testcase_ids=tc_ids, version=version,
    )
    latest = {
        evaluation["testcase_id"]: evaluation
        for evaluation in evaluation_view["bassett"]
    }

    # Baseline: explicit run id, or the most recent prior run of this suite that has a per-test snapshot
    baseline_run = None
    if body.get("baseline_run_id"):
        baseline_run = await db.regression_runs.find_one({"id": body["baseline_run_id"], "suite_id": id}, {"_id": 0})
        if not baseline_run:
            raise HTTPException(404, "Baseline run not found for this suite")
    else:
        prior = await db.regression_runs.find({"suite_id": id, "results": {"$exists": True}}, {"_id": 0}) \
                                        .sort("created_at", -1).to_list(1)
        baseline_run = prior[0] if prior else None
    baseline_by_tc = {r["testcase_id"]: r for r in (baseline_run or {}).get("results", [])}

    results = []
    for tid in tc_ids:
        cur = latest.get(tid)
        base = baseline_by_tc.get(tid)
        cur_result = cur.get("final_result") if cur else None
        base_result = base.get("result") if base else None
        results.append({
            "testcase_id": tid,
            "testcase_name": tcs.get(tid, {}).get("name", "(deleted test case)"),
            "result": cur_result,
            "score": cur.get("overall_score") if cur else None,
            "eval_id": cur.get("id") if cur else None,
            "eval_version": cur.get("bassett_version") if cur else None,
            "baseline_result": base_result,
            "baseline_score": base.get("score") if base else None,
            "delta": _delta_status(base_result, cur_result),
        })

    passed = len([r for r in results if r["result"] in PASS_SET])
    failed = len([r for r in results if r["result"] in FAIL_SET])
    not_evaluated = len([r for r in results if r["delta"] == "not_evaluated"])
    if baseline_run:
        improved = len([r for r in results if r["delta"] == "improved"])
        worsened = len([r for r in results if r["delta"] == "regressed"])
        unchanged = len([r for r in results if r["delta"] in ("still_pass", "still_fail", "unchanged")])
        fixed = improved  # fail → pass against baseline
        newly_failing = worsened
    else:
        # No baseline: comparison metrics are NOT computable — store None (rendered as N/A), never zero.
        improved = worsened = unchanged = fixed = newly_failing = None

    run = {
        "id": new_id(), "suite_id": id, "suite_name": suite.get("name", ""),
        "bassett_version": version, "environment": body.get("environment", "Production"),
        "notes": body.get("notes", ""), "test_date": _validate_test_date(body.get("test_date")),
        "run_date": now_iso()[:10],
        "total": len(results), "passed": passed, "failed": failed,
        "improved": improved, "worsened": worsened, "unchanged": unchanged, "fixed": fixed,
        "newly_failing": newly_failing, "not_evaluated": not_evaluated,
        "unresolved": failed,
        "baseline_run_id": (baseline_run or {}).get("id"),
        "baseline_version": (baseline_run or {}).get("bassett_version"),
        "results": results, "locked": True,
        "created_at": now_iso(), "created_by": user["name"],
    }
    await db.regression_runs.insert_one(dict(run))
    await log_activity("regression_runs", run["id"], "executed", user,
                       f"{suite.get('name', '')} on {version}: {passed} passed / {failed} failed / {worsened if worsened is not None else 'N/A (no baseline)'} regressed")
    return run


@api.post("/import/testcases")
async def import_testcases(body: Dict[str, Any], user=Depends(require_writer)):
    rows = body.get("rows", [])
    if not rows:
        raise HTTPException(400, "No rows to import")
    project_id = body.get("project_id")
    existing = await db.testcases.find({}, {"_id": 0, "name": 1, "municipality_id": 1}).to_list(10000)
    munis = await crud_list("municipalities")
    muni_by_name = {m["name"].strip().lower(): m for m in munis}
    existing_keys = {((t.get("name") or "").strip().lower(), t.get("municipality_id") or "") for t in existing}
    existing_names = {(t.get("name") or "").strip().lower() for t in existing}

    created, skipped = [], []
    for i, row in enumerate(rows):
        name = (row.get("name") or "").strip()
        if not name:
            skipped.append({"row": i + 1, "name": "", "reason": "Missing test name"})
            continue
        prompt_text = (row.get("prompt") or "").strip()
        if not prompt_text:
            skipped.append({"row": i + 1, "name": name, "reason": "Missing prompt"})
            continue
        muni_id = ""
        mn = (row.get("municipality") or "").strip()
        if mn:
            key = mn.lower()
            if key not in muni_by_name:
                m = {"id": new_id(), "name": mn, "state": (row.get("state") or "").strip(),
                     "created_at": now_iso(), "created_by": user["name"], "source": "csv_import"}
                await db.municipalities.insert_one(dict(m))
                muni_by_name[key] = m
            muni_id = muni_by_name[key]["id"]
        dup_key = (name.lower(), muni_id)
        if dup_key in existing_keys or (not muni_id and name.lower() in existing_names):
            skipped.append({"row": i + 1, "name": name, "reason": "Duplicate (name + municipality already exists)"})
            continue
        def num(v, default):
            try:
                return max(1, min(5, int(float(v))))
            except (TypeError, ValueError):
                return default
        doc = {
            "id": new_id(), "name": name, "project_id": project_id or (row.get("project_id") or ""),
            "municipality_id": muni_id, "category": (row.get("category") or "").strip(),
            "subcategory": (row.get("subcategory") or "").strip(),
            "test_type": (row.get("test_type") or "Single Prompt").strip() or "Single Prompt",
            "criticality": num(row.get("criticality"), 3), "difficulty": num(row.get("difficulty"), 2),
            "scenario": (row.get("scenario") or "").strip(), "purpose": (row.get("purpose") or "").strip(),
            "status": (row.get("status") or "Draft").strip() or "Draft",
            "prompts": [{"turn": 1, "text": prompt_text}],
            "expected_behaviors": [{"text": (row.get("expected_behavior") or "").strip(), "status": "Not Met"}] if (row.get("expected_behavior") or "").strip() else [],
            "source": "csv_import", "created_at": now_iso(), "created_by": user["name"], "updated_at": now_iso(),
        }
        _validate_and_normalize_testcase(doc)
        await db.testcases.insert_one(dict(doc))
        existing_keys.add(dup_key)
        existing_names.add(name.lower())
        created.append(name)
    await log_activity("testcases", "bulk", "csv_import", user, f"{len(created)} created, {len(skipped)} skipped")
    return {"created": len(created), "skipped": skipped, "total": len(rows), "created_names": created[:100]}

# ---------- Release Readiness ----------
@api.get("/release-readiness")
async def release_readiness(version: str, user=Depends(get_current_user)):
    evaluation_view = await _evaluation_read_model(
        await crud_list("evaluations"), version=version,
    )
    tcs = {t["id"]: t for t in await crud_list("testcases")}
    evals = [
        evaluation for evaluation in evaluation_view["bassett"]
        if evaluation.get("testcase_id") in tcs
    ]
    evaluation_summary = result_summary(evals)
    passed = evaluation_summary["passed_records"]
    failed = evaluation_summary["failed_records"]
    critical_fails = [e for e in evals if e.get("final_result") == "Critical Fail"]
    evaluated = evaluation_summary["evaluated"]
    pass_rate = evaluation_summary["pass_rate"]
    avg_score = average_score(evals)

    all_findings = await crud_list("findings")
    open_findings = [f for f in all_findings if _finding_is_open(f)]
    version_findings = [f for f in open_findings if f.get("version_found") == version]
    open_crit5 = [f for f in version_findings if (f.get("criticality") or 0) >= 5]
    open_crit4 = [f for f in version_findings if (f.get("criticality") or 0) == 4]

    runs = [r for r in await crud_list("regression_runs") if r.get("bassett_version") == version]
    reg = _latest_regression_run(runs)
    newly_failing = (reg.get("newly_failing") or 0) if reg else 0

    blockers = []
    for f in open_crit5:
        blockers.append({"type": "Critical Finding", "label": f.get("title", ""), "detail": f"Criticality 5 · {f.get('developer_status')}", "link_id": f["id"], "link_type": "finding"})
    for e in critical_fails:
        tc = tcs.get(e["testcase_id"], {})
        blockers.append({"type": "Critical Fail Evaluation", "label": tc.get("name", e["testcase_id"]), "detail": f"Score {e.get('overall_score', '—')} · Critical Fail", "link_id": e["testcase_id"], "link_type": "testcase"})
    if newly_failing:
        blockers.append({"type": "Regression", "label": f"{newly_failing} newly failing regression test(s)", "detail": f"Suite: {reg.get('suite_name', '')}", "link_id": "", "link_type": ""})
    if evaluated and pass_rate < 70:
        blockers.append({"type": "Threshold Failure", "label": f"Pass rate {pass_rate}% is below the 70% NO-GO threshold",
                         "detail": f"{len(passed)} of {evaluated} evaluated tests passed for {version}", "link_id": "", "link_type": ""})

    # Stale Gold Standard warnings for tests evaluated on this version
    stale_map = await compute_stale_gold_map()
    stale_gold_tests = [{"testcase_id": tid, "name": tcs.get(tid, {}).get("name", "?"), "stale_evidence": stale_map[tid]}
                        for tid in stale_map if tid in {e["testcase_id"] for e in evals}]

    if open_crit5 or critical_fails or (evaluated and pass_rate < 70):
        recommendation, reason = "NO-GO", "Open criticality-5 findings, Critical Fail evaluations, or pass rate below 70%."
    elif open_crit4 or newly_failing or (evaluated and pass_rate < 85) or not evaluated:
        recommendation, reason = "CONDITIONAL", "High-criticality open findings, new regressions, or pass rate below 85% — release with mitigations."
    else:
        recommendation, reason = "GO", "Pass rate ≥ 85%, no critical blockers, no new regressions."

    failed_tests = [{"testcase_id": e["testcase_id"], "name": tcs.get(e["testcase_id"], {}).get("name", "?"),
                     "result": e.get("final_result"), "score": e.get("overall_score"),
                     "criticality": tcs.get(e["testcase_id"], {}).get("criticality")} for e in failed]
    decision = await db.release_decisions.find_one({"version": version}, {"_id": 0})
    if decision:
        snap = decision.get("snapshot") or {}
        if not snap:
            decision["state_changed"] = True
            decision["state_changed_detail"] = "This decision was recorded without a blocker snapshot (legacy record)."
        else:
            snap_labels = sorted(b.get("label", "") for b in snap.get("blockers", []))
            cur_labels = sorted(b.get("label", "") for b in blockers)
            changed = []
            if snap_labels != cur_labels:
                changed.append(f"blockers changed ({len(snap_labels)} at decision → {len(cur_labels)} now)")
            if snap.get("pass_rate") != pass_rate:
                changed.append(f"pass rate {snap.get('pass_rate')}% → {pass_rate}%")
            if snap.get("evaluated") != evaluated:
                changed.append(f"evaluated tests {snap.get('evaluated')} → {evaluated}")
            if snap.get("system_recommendation") != recommendation:
                changed.append(f"system recommendation {snap.get('system_recommendation')} → {recommendation}")
            decision["state_changed"] = bool(changed)
            decision["state_changed_detail"] = "; ".join(changed)
    return {"version": version, "recommendation": recommendation, "reason": reason,
            "decision": decision,
            "stale_gold_tests": stale_gold_tests,
            "pass_rate": pass_rate, "avg_score": avg_score, "evaluated": evaluated,
            "passed": len(passed), "failed": len(failed), "critical_fail_evals": len(critical_fails),
            "open_findings": len(open_findings), "open_findings_version": len(version_findings),
            "open_crit5": len(open_crit5), "open_crit4": len(open_crit4),
            "regression": reg, "newly_failing": newly_failing, "blockers": blockers,
            "failed_tests": failed_tests,
            "open_finding_list": [{"id": f["id"], "title": f.get("title"), "criticality": f.get("criticality"),
                                   "developer_status": f.get("developer_status"), "finding_type": f.get("finding_type")}
                                  for f in sorted(open_findings, key=lambda x: -(x.get("criticality") or 0))[:20]]}

# ---------- Live model runs ----------
BENCH_SYSTEM = "You are a helpful AI assistant. Answer the user's zoning and land-use questions directly and cite ordinance sections or sources when you can."
_comparison_run_locks = {}

async def _run_benchmark(provider, model_name, prompts):
    raise RuntimeError(
        f"{provider.title()} benchmark provider is not configured. "
        "Configure a supported AI provider before running this model."
    )

def _extract_bassett_text(payload):
    if isinstance(payload, dict):
        for k in ("answer", "response", "message", "result", "text", "output"):
            if payload.get(k):
                return payload[k] if isinstance(payload[k], str) else str(payload[k])
        if isinstance(payload.get("data"), dict):
            return _extract_bassett_text(payload["data"])
        import json as _json
        return _json.dumps(payload)[:5000]
    return str(payload)

async def _run_bassett(url, key, prompts):
    out = []
    headers = {"Content-Type": "application/json"}
    if key:
        headers["X-API-Key"] = key
    async with httpx.AsyncClient(timeout=90) as hc:
        for p in prompts:
            body = {"question": p["text"], "query": p["text"]}
            r = await hc.post(url, json=body, headers=headers)
            if r.status_code >= 400:
                raise RuntimeError(f"Bassett API request failed with status {r.status_code}")
            try:
                text = _extract_bassett_text(r.json())
            except ValueError:
                text = r.text[:5000]
            out.append({"turn": p["turn"], "text": text})
    return out

def _model_run_state(results):
    """Classify a multi-model execution without hiding partial or total failure."""
    captured_count = sum(1 for result in results.values() if result.get("ok"))
    if captured_count == len(results):
        return "Completed", "Success"
    if captured_count:
        return "Completed with Errors", "Partial"
    return "Failed", "Failure"

@api.post("/testcases/{id}/run")
async def run_models(id: str, body: Dict[str, Any], user=Depends(require_writer)):
    tc = await crud_get("testcases", id)
    if tc.get("archived"):
        raise HTTPException(409, "Archived test cases are read-only")
    prompts = [p for p in (tc.get("prompts") or []) if (p.get("text") or "").strip()]
    if not prompts:
        raise HTTPException(400, "Test case has no prompts to run")
    resume_id = body.get("resume_run_id")
    prior_run = None
    if resume_id:
        prior_run = await db.test_runs.find_one({"id": resume_id, "testcase_id": id}, {"_id": 0})
        if not prior_run:
            raise HTTPException(404, "Comparison run not found")
        slots = prior_run.get("model_slots") or {}
        models = [m for m in ("Bassett", "ChatGPT", "Claude")
                  if slots.get(m, {}).get("status") != "complete"]
        if not models:
            return {"run_id": resume_id, "status": "Completed", "outcome": "Success",
                    "results": prior_run.get("results", {}), "idempotent_replay": True}
    else:
        models = body.get("models") or ["Bassett", "ChatGPT", "Claude"]
    if (not resume_id and (len(models) != 3 or set(models) != {"Bassett", "ChatGPT", "Claude"})):
        raise HTTPException(400, "Model Comparison runs require exactly Bassett, ChatGPT, and Claude")
    test_date = _validate_test_date(body.get("test_date") or (prior_run or {}).get("test_date"))
    cfg = await db.config.find_one({"id": "global"}) or {}
    integ = cfg.get("integrations") or {}
    chatgpt_model = integ.get("chatgpt_model") or "gpt-5.4"
    claude_model = integ.get("claude_model") or "claude-sonnet-4-6"
    bassett_url = integ.get("bassett_api_url") or ""
    bassett_key = integ.get("bassett_api_key") or ""
    active_version = ""
    v = await db.versions.find_one({"active": True}, {"_id": 0})
    if v:
        active_version = v.get("name", "")

    async def run_one(m):
        try:
            if m == "ChatGPT":
                turns = await _run_benchmark("openai", chatgpt_model, prompts)
                mv = chatgpt_model
            elif m == "Claude":
                turns = await _run_benchmark("anthropic", claude_model, prompts)
                mv = claude_model
            elif m == "Bassett":
                if not bassett_url:
                    raise RuntimeError("Bassett API URL not configured. Set it in Administration → Integrations.")
                turns = await _run_bassett(_validate_bassett_url(bassett_url), bassett_key, prompts)
                mv = active_version
            else:
                raise RuntimeError(f"Unknown model {m}")
            return m, {"ok": True, "turns": turns, "model_version": mv}
        except Exception as e:
            logger.warning(f"Live run failed for {m}: {e}")
            return m, {"ok": False, "error": str(e)[:500]}

    attempted = dict(await asyncio.gather(*[run_one(m) for m in models]))
    results = dict((prior_run or {}).get("results") or {})
    results.update({m: ("captured" if r["ok"] else f"error: {r.get('error', '')[:200]}")
                    for m, r in attempted.items()})
    slots = dict((prior_run or {}).get("model_slots") or {})
    for model in ("Bassett", "ChatGPT", "Claude"):
        if model in attempted:
            result = attempted[model]
            slots[model] = {"status": "complete" if result["ok"] else "incomplete",
                            "error": None if result["ok"] else result.get("error", ""),
                            "updated_at": now_iso()}
        else:
            slots.setdefault(model, {"status": "incomplete", "error": "not attempted"})
    run_status, run_outcome = _model_run_state(
        {m: {"ok": slots[m]["status"] == "complete"} for m in ("Bassett", "ChatGPT", "Claude")}
    )
    # Record this execution as a Test Run and PRESERVE prior responses (mark superseded, never delete)
    run_values = {
        "testcase_id": id, "test_date": test_date, "run_date": now_iso(), "bassett_version": active_version,
        "environment": integ.get("environment", "Production"), "models": ["Bassett", "ChatGPT", "Claude"],
        "model_config": {"chatgpt_model": chatgpt_model, "claude_model": claude_model, "bassett_api_url": bassett_url},
        "capture_method": "live_api", "status": run_status, "outcome": run_outcome,
        "results": results, "model_slots": slots,
        "comparison_complete": run_status == "Completed",
    }
    if prior_run:
        await db.test_runs.update_one({"id": prior_run["id"]}, {"$set": {**run_values, "updated_at": now_iso()}})
        run_doc = {**prior_run, **run_values}
    else:
        run_doc = await crud_create("test_runs", run_values, user)
    captured = [m for m, slot in slots.items() if slot.get("status") == "complete"]
    for m, res in attempted.items():
        if not res["ok"]:
            continue
        if not prior_run:
            await db.responses.update_many({"testcase_id": id, "model": m, "superseded": {"$ne": True}},
                                           {"$set": {"superseded": True}})
        for t in res["turns"]:
            await db.responses.insert_one({"id": new_id(), "testcase_id": id, "model": m, "run_id": run_doc["id"],
                                           "model_version": res["model_version"], "turn": t["turn"],
                                           "response": t["text"], "citations": "", "capture_method": "live_api",
                                           "superseded": False, "environment": run_doc["environment"],
                                           "created_at": now_iso(), "created_by": user["name"]})
        await log_activity("testcases", id, f"live run captured · {m}", user)
    if captured and tc.get("status") in ("Draft", "Ready to Test"):
        await db.testcases.update_one({"id": id}, {"$set": {"status": "Testing", "updated_at": now_iso()}})
    return {"run_id": run_doc["id"], "status": run_status, "outcome": run_outcome,
            "complete": run_status == "Completed", "model_slots": slots,
            "results": {m: {k: v for k, v in r.items() if k != "turns"} for m, r in attempted.items()}}

@api.post("/testcases/{id}/runs/{run_id}/retry")
async def retry_model_comparison(id: str, run_id: str, body: Dict[str, Any],
                                 user=Depends(require_writer)):
    """Resume only incomplete slots; completed responses are immutable."""
    lock = _comparison_run_locks.setdefault(run_id, asyncio.Lock())
    async with lock:
        return await run_models(id, {**body, "resume_run_id": run_id}, user)

@api.post("/testcases/{id}/runs/{run_id}/slots/{model}/complete")
async def complete_benchmark_slot(id: str, run_id: str, model: str, body: Dict[str, Any],
                                  user=Depends(require_writer)):
    if model not in ("ChatGPT", "Claude"):
        raise HTTPException(400, "Only benchmark slots can be manually completed")
    lock = _comparison_run_locks.setdefault(run_id, asyncio.Lock())
    async with lock:
        run = await db.test_runs.find_one({"id": run_id, "testcase_id": id}, {"_id": 0})
        if not run:
            raise HTTPException(404, "Comparison run not found")
        slots = dict(run.get("model_slots") or {})
        if slots.get(model, {}).get("status") == "complete":
            raise HTTPException(409, "Successful model responses cannot be replaced")
        turns = body.get("turns") or ([{"turn": 1, "text": body.get("response", "")}] if body.get("response") else [])
        if not turns or any(not str(turn.get("text") or "").strip() for turn in turns):
            raise HTTPException(400, "A nonblank response is required for every turn")
        for turn in turns:
            await db.responses.insert_one({"id": new_id(), "testcase_id": id, "model": model, "run_id": run_id,
                "model_version": body.get("model_version") or "manual benchmark", "turn": turn.get("turn", 1),
                "response": str(turn["text"]), "capture_method": "manual", "superseded": False,
                "environment": run.get("environment"), "created_at": now_iso(), "created_by": user["name"]})
        slots[model] = {"status": "complete", "manual": True, "updated_at": now_iso()}
        status, outcome = _model_run_state({m: {"ok": slots.get(m, {}).get("status") == "complete"}
                                            for m in ("Bassett", "ChatGPT", "Claude")})
        await db.test_runs.update_one({"id": run_id}, {"$set": {"model_slots": slots, "status": status,
            "outcome": outcome, "comparison_complete": status == "Completed", "updated_at": now_iso()}})
        await log_activity("test_runs", run_id, f"benchmark slot completed · {model}", user)
        return {"run_id": run_id, "status": status, "complete": status == "Completed", "model_slots": slots}

# ---------- AI assist (pre-scoring & claim extraction) ----------
def _parse_llm_json(text):
    text = (text or "").strip()
    m = re.search(r"```(?:json)?\s*(.*?)```", text, re.S)
    if m:
        text = m.group(1).strip()
    m2 = re.search(r"[\[{].*[\]}]", text, re.S)
    if m2:
        text = m2.group(0)
    return json.loads(text)

async def _ai_assist_call(system, prompt):
    raise HTTPException(
        503,
        "AI assist is unavailable. Configure a supported AI provider before using pre-scoring or claim extraction.",
    )

@api.post("/testcases/{id}/prescore")
async def ai_prescore(id: str, body: Dict[str, Any], user=Depends(require_writer)):
    model = body.get("model") or "Bassett"
    tc = await crud_get("testcases", id)
    await _require_active_testcase(id)
    gold = await db.goldstandards.find_one({"testcase_id": id}, {"_id": 0})
    if not gold or not gold.get("answer"):
        raise HTTPException(400, "Create a Gold Standard answer first — AI pre-scoring evaluates against it.")
    responses = sorted(await crud_list("responses", {"testcase_id": id, "model": model}), key=lambda r: r.get("turn", 1))
    if not responses:
        raise HTTPException(400, f"No captured {model} response to score.")
    cfg = await db.config.find_one({"id": "global"}, {"_id": 0}) or {}
    dims = cfg.get("eval_dimensions", [])
    pass_results = cfg.get("pass_results", [])
    resp_text = "\n\n".join([f"[Turn {r.get('turn', 1)}] {r.get('response', '')}" +
                             (f"\nCitations: {r['citations']}" if r.get("citations") else "") for r in responses])
    prompt = f"""Evaluate this AI model's answer to a zoning question against the expert Gold Standard.

QUESTION / PROMPTS:
{chr(10).join([p.get('text', '') for p in tc.get('prompts', [])])}

GOLD STANDARD ANSWER (authoritative):
{gold.get('answer', '')}
Explanation: {gold.get('explanation', '')}

MODEL RESPONSE ({model}):
{resp_text}

Score each dimension 0-10 (10 = perfect). Use null for dimensions that don't apply (e.g. calculation when no math involved).
Dimensions (use these exact keys): {json.dumps([{'key': d['key'], 'label': d['label']} for d in dims])}

Then pick final_result from exactly one of: {json.dumps(pass_results)}

Return ONLY JSON, no other text:
{{"scores": {{"<key>": <0-10 or null>, ...}}, "final_result": "<one of the options>", "rationale": "<2-4 sentence justification citing specific discrepancies or matches with the Gold Standard>"}}"""
    raw = await _ai_assist_call("You are a strict, precise QA evaluator for zoning and land-use AI answers. You compare model answers to expert Gold Standards and never inflate scores.", prompt)
    try:
        draft = _parse_llm_json(raw)
    except (json.JSONDecodeError, ValueError):
        raise HTTPException(502, "AI returned an unparseable draft — try again.")
    scores = {d["key"]: draft.get("scores", {}).get(d["key"]) for d in dims}
    scores = {k: (max(0, min(10, int(v))) if v is not None else None) for k, v in scores.items()
              if not isinstance(v, str)}
    final = draft.get("final_result")
    if final not in pass_results:
        final = "Needs Improvement"
    await log_activity("testcases", id, f"AI pre-score drafted · {model}", user)
    authoritative = score_evaluation(scores, dims)
    return {
        "scores": scores, "final_result": final, "rationale": draft.get("rationale", ""),
        "model": model, **authoritative,
    }


def _evaluation_recommendation(weighted_score):
    if weighted_score is None:
        return "Not Enough Evidence"
    if weighted_score >= 8.5:
        return "Pass"
    if weighted_score >= 7:
        return "Pass with Minor Issues"
    if weighted_score >= 5:
        return "Needs Improvement"
    if weighted_score >= 3:
        return "Fail"
    return "Critical Fail"


EVALUATION_DERIVED_FIELDS = {
    "overall_score", "weighted_score", "system_recommended", "system_explanation",
    "score_mode", "score_label", "weight_explanation",
}


async def _evaluation_score_fields(scores, *, allow_unknown=False):
    """Calculate the persisted evaluation score from configured dimensions."""
    if scores is None:
        scores = {}
    if not isinstance(scores, dict):
        raise HTTPException(400, detail={"scores": "scores must be an object keyed by configured dimension"})
    cfg = await db.config.find_one({"id": "global"}, {"_id": 0}) or DEFAULT_CONFIG
    dimensions = cfg.get("eval_dimensions") or []
    dimension_keys = {dimension.get("key") for dimension in dimensions if dimension.get("key")}
    unknown = sorted(set(scores) - dimension_keys)
    if unknown and not allow_unknown:
        raise HTTPException(400, detail={"scores": f"Unknown evaluation dimension: {unknown[0]}"})
    for key, value in (scores or {}).items():
        if key not in dimension_keys:
            continue
        if value in (None, ""):
            continue
        if isinstance(value, bool):
            raise HTTPException(400, detail={"scores": f"{key} must be a number between 0 and 10"})
        try:
            numeric = float(value)
        except (TypeError, ValueError):
            raise HTTPException(400, detail={"scores": f"{key} must be a number between 0 and 10"})
        if not math.isfinite(numeric) or numeric < 0 or numeric > 10:
            raise HTTPException(400, detail={"scores": f"{key} must be a number between 0 and 10"})
    return score_evaluation(scores, dimensions)


async def _apply_authoritative_evaluation_fields(incoming, existing=None):
    """Ignore client-derived values and calculate them from the effective score map."""
    supplied_scores = "scores" in incoming
    scores = incoming.get("scores") if supplied_scores else (existing or {}).get("scores", {})
    for field in EVALUATION_DERIVED_FIELDS:
        incoming.pop(field, None)
    incoming.update(await _evaluation_score_fields(scores, allow_unknown=not supplied_scores))
    return incoming


@api.post("/evaluations/score-preview")
async def evaluation_score_preview(body: Dict[str, Any], user=Depends(require_writer)):
    return await _evaluation_score_fields(body.get("scores"))

@api.post("/responses/{id}/extract-claims")
async def extract_claims(id: str, user=Depends(require_writer)):
    resp = await crud_get("responses", id)
    await _guard_testcase_linked_document(resp)
    existing = await crud_list("claims", {"response_id": id})
    if existing:
        return existing
    prompt = f"""Split this AI zoning answer into its individual factual claims. A claim is one verifiable statement (a fact, number, regulation, permitted use, requirement, etc.). Attach the citation/source the answer gives for that claim, or "" if none is given.

ANSWER TEXT:
{resp.get('response', '')}

CITATIONS LISTED: {resp.get('citations', '') or 'none'}

Return ONLY a JSON array (max 12 claims, most important first):
[{{"claim_text": "<concise restatement of the claim>", "citation": "<source cited for it, or empty string>"}}]"""
    raw = await _ai_assist_call("You are a meticulous fact-checking assistant that decomposes zoning answers into atomic verifiable claims.", prompt)
    try:
        items = _parse_llm_json(raw)
        assert isinstance(items, list)
    except (json.JSONDecodeError, ValueError, AssertionError):
        raise HTTPException(502, "AI returned an unparseable claim list — try again.")
    docs = []
    for it in items[:12]:
        if not isinstance(it, dict) or not (it.get("claim_text") or "").strip():
            continue
        created_at = now_iso()
        d = {"id": new_id(), "testcase_id": resp["testcase_id"], "response_id": id,
             "model": resp.get("model", ""), "turn": resp.get("turn", 1),
             "claim_text": it["claim_text"].strip(), "citation": (it.get("citation") or "").strip(),
             "verdict": "Unreviewed", "note": "", "created_at": created_at, "created_by": user["name"],
             "updated_at": created_at, "revision": 1}
        await db.claims.insert_one(dict(d))
        docs.append(d)
    await log_activity("responses", id, f"claims extracted · {len(docs)}", user)
    return docs

# ---------- Saved views (per-user UI state) ----------
@api.get("/views/{page}")
async def get_view(page: str, user=Depends(get_current_user)):
    doc = await db.saved_views.find_one({"user_id": user["id"], "page": page}, {"_id": 0})
    return doc or {}

@api.put("/views/{page}")
async def put_view(page: str, body: Dict[str, Any], user=Depends(get_current_user)):
    await db.saved_views.update_one({"user_id": user["id"], "page": page},
                                    {"$set": {"user_id": user["id"], "page": page,
                                              "state": body.get("state", {}), "updated_at": now_iso()}}, upsert=True)
    return {"ok": True}

# ---------- Executive summary ----------
@api.get("/analytics/executive")
async def analytics_executive(user=Depends(get_current_user)):
    tcs = {t["id"]: t for t in await crud_list("testcases")}
    evaluation_view = await _evaluation_read_model(
        await crud_list("evaluations"), valid_testcase_ids=tcs,
    )
    evals = evaluation_view["all_models"]
    # Findings are retained for audit/history after archival, but are not current
    # analytical evidence.
    findings = [
        finding for finding in await crud_list("findings")
        if not finding.get("archived") and finding.get("status") != "Archived"
        and finding.get("testcase_id") in tcs
    ]
    scope = "Scope: latest evaluation per test case per model · all Bassett versions · retests excluded · Pass includes 'Pass with Minor Issues'"

    def quarter_of(iso):
        try:
            dt = datetime.fromisoformat(iso.replace("Z", "+00:00"))
            return f"Q{(dt.month - 1) // 3 + 1} {dt.year}", (dt.year, (dt.month - 1) // 3 + 1)
        except (ValueError, AttributeError):
            return None, None

    # quarterly trend per model
    buckets = {}
    for e in evals:
        if e.get("overall_score") is None:
            continue
        q, sort_key = quarter_of(e.get("created_at", ""))
        if not q:
            continue
        buckets.setdefault(sort_key, {"quarter": q})
        buckets[sort_key].setdefault(e.get("model", "?"), []).append(e["overall_score"])
    trend = []
    for k in sorted(buckets):
        row = {"quarter": buckets[k]["quarter"]}
        for m in ("Bassett", "ChatGPT", "Claude"):
            vals = buckets[k].get(m, [])
            if vals:
                row[m] = round(sum(vals) / len(vals), 1)
        trend.append(row)

    b = [e for e in evals if e.get("model") == "Bassett"]
    scored = [e for e in b if e.get("overall_score") is not None]
    bassett_avg = average_score(b)
    bassett_summary = result_summary(b)
    passed = bassett_summary["passed"]
    failed = bassett_summary["failed"]
    pass_rate = bassett_summary["pass_rate"]

    # wins/losses vs benchmarks
    by_tc = {}
    for e in evals:
        if e.get("overall_score") is not None:
            by_tc.setdefault(e["testcase_id"], {})[e.get("model")] = e["overall_score"]
    wins = losses = 0
    for tid, models in by_tc.items():
        bs = models.get("Bassett")
        others = [v for m, v in models.items() if m != "Bassett"]
        if bs is None or not others:
            continue
        if bs > max(others) + 0.5:
            wins += 1
        elif bs < max(others) - 0.5:
            losses += 1

    open_findings = [f for f in findings if f.get("developer_status") not in CLOSED_FINDING]
    open_critical = len([f for f in open_findings if (f.get("criticality") or 0) >= 4])

    # top failure modes across findings
    fm_counts = {}
    for f in findings:
        for fm in (f.get("failure_modes") or []):
            fm_counts[fm] = fm_counts.get(fm, 0) + 1
    failure_modes = sorted([{"mode": k, "count": v} for k, v in fm_counts.items()],
                           key=lambda x: -x["count"])[:8]

    # bassett by category
    cat = {}
    for e in scored:
        c = tcs.get(e["testcase_id"], {}).get("category") or "Uncategorized"
        cat.setdefault(c, []).append(e["overall_score"])
    categories = sorted([{"category": k, "avg_score": round(sum(v) / len(v), 1), "count": len(v)}
                         for k, v in cat.items()], key=lambda x: -x["avg_score"])

    bench_scores = [e["overall_score"] for e in evals if e.get("model") != "Bassett" and e.get("overall_score") is not None]
    bench_avg = round(sum(bench_scores) / len(bench_scores), 1) if bench_scores else None

    stale_map = await compute_stale_gold_map()
    evaluated_ids = {e["testcase_id"] for e in b}
    stale_gold = [{"testcase_id": tid, "name": tcs.get(tid, {}).get("name", "?")} for tid in stale_map if tid in evaluated_ids]

    return {"kpis": {"bassett_avg": bassett_avg, "benchmark_avg": bench_avg, "pass_rate": pass_rate,
                     "wins": wins, "losses": losses, "open_critical": open_critical,
                     "total_evaluated": passed + failed, "total_findings": len(findings)},
            "trend": trend, "failure_modes": failure_modes, "categories": categories, "scope": scope,
            "stale_gold_tests": stale_gold}

# ---------- Test Coverage ----------
@api.get("/analytics/coverage")
async def analytics_coverage(user=Depends(get_current_user)):
    tcs = await crud_list("testcases")
    munis = await crud_list("municipalities")
    cfg = await db.config.find_one({"id": "global"}, {"_id": 0}) or {}
    evals = await _authoritative_evaluation_read_model(await crud_list("evaluations"))
    evals = await _exclude_incomplete_comparison_evaluations(evals)
    evals = latest_evaluations(
        [
            evaluation for evaluation in evals
            if evaluation.get("model") == "Bassett" and evaluation.get("testcase_id")
            and evaluation.get("final_result") not in (None, "", "Not Evaluated")
        ],
        lambda evaluation: evaluation["testcase_id"],
    )
    evaluated_tc = {e["testcase_id"] for e in evals}

    by_muni = {}
    for t in tcs:
        by_muni.setdefault(t.get("municipality_id") or "", []).append(t)
    municipalities = []
    for m in munis:
        mt = by_muni.get(m["id"], [])
        municipalities.append({"id": m["id"], "name": m["name"], "state": m.get("state", ""),
                               "tests": len(mt), "evaluated": len([t for t in mt if t["id"] in evaluated_tc])})
    municipalities.sort(key=lambda x: x["tests"])

    categories = []
    for c in cfg.get("categories", []):
        ct = [t for t in tcs if t.get("category") == c]
        categories.append({"category": c, "tests": len(ct),
                           "evaluated": len([t for t in ct if t["id"] in evaluated_tc])})
    categories.sort(key=lambda x: x["tests"])

    crit_labels = cfg.get("criticality", {})
    criticality = []
    for lvl in range(1, 6):
        ct = [t for t in tcs if t.get("criticality") == lvl]
        criticality.append({"level": lvl, "label": crit_labels.get(str(lvl), str(lvl)), "tests": len(ct),
                            "evaluated": len([t for t in ct if t["id"] in evaluated_tc])})

    muni_gaps = [m for m in municipalities if m["tests"] == 0]
    cat_gaps = [c for c in categories if c["tests"] == 0]
    crit_gaps = [c for c in criticality if c["tests"] == 0]
    return {"municipalities": municipalities, "categories": categories, "criticality": criticality,
            "summary": {"total_tests": len(tcs), "evaluated_tests": len(evaluated_tc & {t["id"] for t in tcs}),
                        "munis_covered": len(munis) - len(muni_gaps), "munis_total": len(munis),
                        "categories_covered": len(categories) - len(cat_gaps), "categories_total": len(categories),
                        "crit_covered": 5 - len(crit_gaps), "gap_count": len(muni_gaps) + len(cat_gaps) + len(crit_gaps)}}

# ---------- Competitive Insights ----------
@api.get("/analytics/competitive")
async def analytics_competitive(user=Depends(get_current_user)):
    tcs = {t["id"]: t for t in await crud_list("testcases")}
    evaluation_view = await _evaluation_read_model(
        await crud_list("evaluations"), valid_testcase_ids=tcs,
    )
    evals = evaluation_view["all_models"]
    findings = await crud_list("findings")
    dims = [d["key"] for d in ((await db.config.find_one({"id": "global"}, {"_id": 0}) or {}).get("eval_dimensions", []))]

    by_tc = {}
    for e in evals:
        tid, m = e["testcase_id"], e.get("model")
        if e.get("overall_score") is not None:
            by_tc.setdefault(tid, {})[m] = e

    losses, wins = [], []
    records = {"ChatGPT": {"wins": 0, "losses": 0, "ties": 0}, "Claude": {"wins": 0, "losses": 0, "ties": 0}}
    for tid, models in by_tc.items():
        b = models.get("Bassett")
        if not b:
            continue
        bs = b["overall_score"]
        for bench in ("ChatGPT", "Claude"):
            o = models.get(bench)
            if not o:
                continue
            if o["overall_score"] > bs + 0.5:
                records[bench]["losses"] += 1
            elif o["overall_score"] < bs - 0.5:
                records[bench]["wins"] += 1
            else:
                records[bench]["ties"] += 1
        others = {m: models[m] for m in models if m != "Bassett"}
        if not others:
            continue
        best_m = max(others, key=lambda m: others[m]["overall_score"])
        best = others[best_m]
        tc = tcs.get(tid, {})
        reason_findings = [f for f in findings if f.get("testcase_id") == tid and
                           f.get("finding_type") in ("competitor advantage", "Bassett advantage")]
        entry = {"testcase_id": tid, "name": tc.get("name", "?"), "category": tc.get("category", ""),
                 "criticality": tc.get("criticality"), "bassett_score": bs,
                 "benchmark_model": best_m, "benchmark_score": best["overall_score"],
                 "delta": round(best["overall_score"] - bs, 1),
                 "bassett_notes": b.get("notes", ""), "benchmark_notes": best.get("notes", ""),
                 "bassett_result": b.get("final_result"),
                 "reasons": [{"id": f["id"], "title": f.get("title"), "type": f.get("finding_type")} for f in reason_findings],
                 # weakest Bassett dimensions vs the winning benchmark
                 "dimension_gaps": sorted([
                     {"dim": d, "bassett": b.get("scores", {}).get(d), "benchmark": best.get("scores", {}).get(d),
                      "gap": round((best.get("scores", {}).get(d) or 0) - (b.get("scores", {}).get(d) or 0), 1)}
                     for d in dims
                     if b.get("scores", {}).get(d) is not None and best.get("scores", {}).get(d) is not None
                 ], key=lambda x: -x["gap"])[:3]}
        if best["overall_score"] > bs + 0.5:
            losses.append(entry)
        elif bs > best["overall_score"] + 0.5:
            wins.append(entry)
    losses.sort(key=lambda x: -x["delta"])
    wins.sort(key=lambda x: x["delta"])

    # dimension averages Bassett vs benchmarks
    def dim_avgs(model_filter):
        out = {}
        for d in dims:
            vals = [e["scores"][d] for e in evals
                    if model_filter(e.get("model")) and e.get("scores", {}).get(d) is not None]
            out[d] = round(sum(vals) / len(vals), 1) if vals else None
        return out
    bassett_dims = dim_avgs(lambda m: m == "Bassett")
    bench_dims = dim_avgs(lambda m: m in ("ChatGPT", "Claude"))
    dimension_comparison = [{"dim": d, "bassett": bassett_dims[d], "benchmark": bench_dims[d],
                             "gap": round((bassett_dims[d] or 0) - (bench_dims[d] or 0), 1)}
                            for d in dims if bassett_dims[d] is not None and bench_dims[d] is not None]

    return {"records": records, "losses": losses, "wins": wins,
            "dimension_comparison": dimension_comparison,
            "summary": {"total_compared": len(by_tc), "losses": len(losses), "wins": len(wins),
                        "worst_gap": losses[0]["delta"] if losses else 0}}

# ---------- Calendar ----------
@api.get("/calendar/all-events")
async def calendar_all_events(user=Depends(get_current_user)):
    events = []
    for p in await crud_list("projects"):
        if p.get("start_date"):
            events.append({"id": f"proj-start-{p['id']}", "date": p["start_date"], "type": "project_start",
                           "label": f"{p['name']} — kickoff", "detail": p.get("status", ""), "readonly": True})
        if p.get("end_date") or p.get("due_date"):
            events.append({"id": f"proj-due-{p['id']}", "date": p.get("end_date") or p.get("due_date"),
                           "type": "deadline", "label": f"{p['name']} — deadline", "detail": p.get("status", ""), "readonly": True})
    for v in await crud_list("versions"):
        if v.get("release_date"):
            events.append({"id": f"rel-{v['id']}", "date": v["release_date"], "type": "release",
                           "label": f"{v['name']} release", "detail": v.get("environment", ""), "readonly": True})
    for r in await crud_list("regression_runs"):
        if r.get("run_date"):
            events.append({"id": f"reg-{r['id']}", "date": r["run_date"], "type": "regression",
                           "label": f"Regression run · {r.get('bassett_version', '')}",
                           "detail": f"{r.get('passed', 0)} passed / {r.get('failed', 0)} failed", "readonly": True})
    for c in await crud_list("calendar_events"):
        events.append({"id": c["id"], "date": c.get("date", ""), "type": c.get("event_type", "milestone"),
                       "label": c.get("title", ""), "detail": c.get("notes", ""), "readonly": False})
    events = [e for e in events if e.get("date")]
    events.sort(key=lambda e: e["date"])
    return events

# ---------- Attachments (Replit App Storage) ----------
APP_STORAGE_PREFIX = "zoneqa-bassett"

async def init_storage():
    return await app_storage.check_configuration()

ALLOWED_CONTENT_TYPES = {
    "pdf": "application/pdf",
    "png": "image/png",
    "jpg": "image/jpeg",
    "jpeg": "image/jpeg",
    "gif": "image/gif",
    "webp": "image/webp",
    "txt": "text/plain",
    "csv": "text/csv",
    "docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
}
ALLOWED_EXT = set(ALLOWED_CONTENT_TYPES)
MAX_UPLOAD = 20 * 1024 * 1024  # 20 MB
UPLOAD_READ_CHUNK = 1024 * 1024
ATTACH_ENTITY_COLLECTIONS = {
    "finding": "findings",
    "evidence": "evidence",
    "testcase": "testcases",
    "project": "projects",
    "bassett_issue": "bassett_issues",
    "bassett_scenario": "bassett_scenarios",
    "bassett_execution": "bassett_executions",
}
ATTACH_ENTITIES = set(ATTACH_ENTITY_COLLECTIONS)
ATTACHMENT_RESTORE_RETENTION = timedelta(days=30)

async def _require_mutable_attachment_parent(entity_type, entity_id):
    """Attachments inherit their parent's archive lock, not just testcase's lock."""
    collection = ATTACH_ENTITY_COLLECTIONS.get(entity_type)
    if not collection:
        raise HTTPException(400, "Invalid entity_type")
    parent = await db[collection].find_one({"id": entity_id}, {"_id": 0})
    if not parent:
        raise HTTPException(404, f"{entity_type.title()} not found")
    if parent.get("archived") or parent.get("status") == "Archived":
        raise HTTPException(409, "Archived parent records are immutable; attachments remain available as history")
    if entity_type == "bassett_execution" and parent.get("issue_id"):
        issue = await db.bassett_issues.find_one({"id": parent["issue_id"]}, {"_id": 0})
        if issue and (issue.get("archived") or issue.get("status") == "Archived"):
            raise HTTPException(409, "Archived parent records are immutable; attachments remain available as history")
    # A Bassett issue can be linked to an archived testcase even though the
    # issue itself is still visible.  That testcase's history is also locked.
    await _guard_testcase_linked_document(parent, entity_type)
    return parent

async def read_attachment_bytes(file: UploadFile) -> bytes:
    chunks = []
    total_size = 0
    while True:
        chunk = await file.read(min(UPLOAD_READ_CHUNK, MAX_UPLOAD - total_size + 1))
        if not chunk:
            return b"".join(chunks)
        total_size += len(chunk)
        if total_size > MAX_UPLOAD:
            raise HTTPException(400, "File exceeds 20 MB limit")
        chunks.append(chunk)

@api.post("/attachments/upload")
async def upload_attachment(entity_type: str = Form(...), entity_id: str = Form(...),
                            file: UploadFile = File(...), user=Depends(require_writer)):
    if entity_type not in ATTACH_ENTITIES:
        raise HTTPException(400, "Invalid entity_type")
    await _require_mutable_attachment_parent(entity_type, entity_id)
    ext = file.filename.rsplit(".", 1)[-1].lower() if "." in (file.filename or "") else ""
    if ext not in ALLOWED_EXT:
        raise HTTPException(400, f"File type .{ext} not allowed. Allowed: {', '.join(sorted(ALLOWED_EXT))}")
    try:
        data = await read_attachment_bytes(file)
    finally:
        await file.close()
    path = f"{APP_STORAGE_PREFIX}/uploads/{entity_type}/{new_id()}.{ext}"
    content_type = ALLOWED_CONTENT_TYPES[ext]
    try:
        await app_storage.upload_bytes(path, data, content_type)
    except ObjectStorageUnavailable as exc:
        logger.error("Attachment upload storage failure: %s", exc)
        raise HTTPException(503, "Replit App Storage is unavailable") from exc
    doc = {"id": new_id(), "entity_type": entity_type, "entity_id": entity_id,
           "storage_path": path, "storage_provider": "replit", "original_filename": file.filename,
           "content_type": content_type, "size": len(data),
            "is_deleted": False, "uploaded_by_id": user["id"], "uploaded_by": user["name"],
            "created_at": now_iso(), "updated_at": now_iso()}
    try:
        await db.attachments.insert_one(dict(doc))
    except Exception:
        try:
            await app_storage.delete(path)
        except ObjectStorageUnavailable as cleanup_error:
            logger.error("Attachment metadata write failed and object cleanup also failed for %s: %s",
                         path, cleanup_error)
        raise
    await log_activity(entity_type, entity_id, "attachment uploaded", user, file.filename)
    return clean(doc)

@api.get("/attachments")
async def list_attachments(entity_type: str, entity_id: str, user=Depends(get_current_user)):
    direct = await db.attachments.find(
        {"entity_type": entity_type, "entity_id": entity_id}, {"_id": 0}
    ).to_list(200)
    linked = await db.attachments.find(
        {"linked_entity_type": entity_type, "linked_entity_id": entity_id}, {"_id": 0}
    ).to_list(200)
    attachments = list({item["id"]: item for item in [*direct, *linked]}.values())
    now = datetime.now(timezone.utc)
    visible = []
    for attachment in attachments:
        if user.get("role") == "viewer" and attachment.get("is_deleted"):
            continue
        item = clean(attachment)
        if item.get("is_deleted"):
            item["status"] = "deleted"
            try:
                deleted_at = datetime.fromisoformat(str(item.get("deleted_at", "")).replace("Z", "+00:00"))
                if deleted_at.tzinfo is None:
                    deleted_at = deleted_at.replace(tzinfo=timezone.utc)
                restore_expires_at = deleted_at + ATTACHMENT_RESTORE_RETENTION
                if restore_expires_at >= now and not item.get("retention_expired_at"):
                    item["restore_expires_at"] = restore_expires_at.isoformat()
            except ValueError:
                pass
        visible.append(item)
    return visible

@api.get("/attachments/{id}/download")
async def download_attachment(id: str, user=Depends(get_current_user)):
    rec = await db.attachments.find_one({"id": id, "is_deleted": False}, {"_id": 0})
    if not rec:
        raise HTTPException(404, "Attachment not found")
    if rec.get("storage_provider") != "replit":
        raise HTTPException(409, "Attachment has not been migrated to Replit App Storage")
    try:
        content = await app_storage.download_bytes(rec["storage_path"])
    except ObjectNotFound:
        raise HTTPException(404, "Attachment content not found")
    except ObjectStorageUnavailable as exc:
        logger.error("Attachment download storage failure: %s", exc)
        raise HTTPException(503, "Replit App Storage is unavailable") from exc
    safe_name = (rec.get("original_filename") or "file").replace('"', "").replace("\r", "").replace("\n", "")
    ext = safe_name.rsplit(".", 1)[-1].lower() if "." in safe_name else ""
    content_type = ALLOWED_CONTENT_TYPES.get(ext, "application/octet-stream")
    disposition = "inline" if content_type.startswith("image/") else "attachment"
    return Response(content=content, media_type=content_type, headers={
        "Content-Disposition": f'{disposition}; filename="{safe_name}"',
        "X-Content-Type-Options": "nosniff",
    })

@api.delete("/attachments/{id}")
async def delete_attachment(id: str, user=Depends(require_writer)):
    attachment = await db.attachments.find_one({"id": id}, {"_id": 0})
    if not attachment:
        raise HTTPException(404, "Attachment not found")
    await _require_mutable_attachment_parent(attachment.get("entity_type"), attachment.get("entity_id"))
    deleted_at = now_iso()
    res = await db.attachments.find_one_and_update({"id": id}, {"$set": {
        "is_deleted": True, "deleted_at": deleted_at, "deleted_by_id": user["id"],
        "updated_at": deleted_at,
    }})
    if not res:
        raise HTTPException(404, "Attachment not found")
    await log_activity(res.get("entity_type", ""), res.get("entity_id", ""), "attachment removed", user,
                       res.get("original_filename", ""))
    return {"ok": True}

@api.post("/attachments/{id}/restore")
async def restore_attachment(id: str, user=Depends(require_writer)):
    attachment = await db.attachments.find_one({"id": id}, {"_id": 0})
    if not attachment:
        raise HTTPException(404, "Attachment not found")
    if not attachment.get("is_deleted"):
        return clean(attachment)
    await _require_mutable_attachment_parent(attachment.get("entity_type"), attachment.get("entity_id"))
    try:
        deleted_at = datetime.fromisoformat(str(attachment.get("deleted_at", "")).replace("Z", "+00:00"))
    except ValueError:
        raise HTTPException(409, "Attachment cannot be restored because its deletion retention date is unavailable")
    if deleted_at.tzinfo is None:
        deleted_at = deleted_at.replace(tzinfo=timezone.utc)
    if datetime.now(timezone.utc) - deleted_at > ATTACHMENT_RESTORE_RETENTION:
        raise HTTPException(409, "Attachment restore retention window has expired; referenced storage bytes were preserved")
    stamp = now_iso()
    restored = await db.attachments.find_one_and_update({"id": id, "is_deleted": True}, {"$set": {
        "is_deleted": False, "restored_at": stamp, "restored_by_id": user["id"], "updated_at": stamp,
    }, "$unset": {"deleted_at": "", "deleted_by_id": ""}})
    if not restored:
        raise HTTPException(409, "Attachment state changed; reload and try again")
    await log_activity(restored["entity_type"], restored["entity_id"], "attachment restored", user,
                       restored.get("original_filename", ""))
    return clean(restored)

@api.post("/attachments/retention/cleanup")
async def cleanup_expired_attachments(user=Depends(require_roles("admin"))):
    """Mark expired soft deletes for retention reporting; never delete storage bytes.

    Object paths may be referenced by historical exports, so expiry only closes
    the restore window and creates an auditable record.
    """
    cutoff = datetime.now(timezone.utc) - ATTACHMENT_RESTORE_RETENTION
    marked = []
    for attachment in await db.attachments.find(
        {"is_deleted": True}, {"_id": 0}
    ).to_list(10000):
        if attachment.get("retention_expired_at"):
            continue
        try:
            deleted_at = datetime.fromisoformat(str(attachment.get("deleted_at", "")).replace("Z", "+00:00"))
            if deleted_at.tzinfo is None:
                deleted_at = deleted_at.replace(tzinfo=timezone.utc)
        except ValueError:
            continue
        if deleted_at <= cutoff:
            stamp = now_iso()
            await db.attachments.update_one({"id": attachment["id"], "is_deleted": True}, {"$set": {
                "retention_expired_at": stamp, "retention_expired_by_id": user["id"], "updated_at": stamp,
            }})
            await log_activity(attachment.get("entity_type", "attachment"), attachment.get("entity_id", ""),
                               "attachment retention expired", user, attachment.get("original_filename", ""))
            marked.append(attachment["id"])
    return {"ok": True, "retention_days": ATTACHMENT_RESTORE_RETENTION.days,
            "expired_count": len(marked), "attachment_ids": marked,
            "storage_bytes_deleted": 0}

@api.get("/attachments/retention/report")
async def attachment_retention_report(user=Depends(require_roles("admin"))):
    attachments = await db.attachments.find({"is_deleted": True}, {"_id": 0}).to_list(10000)
    cutoff = datetime.now(timezone.utc) - ATTACHMENT_RESTORE_RETENTION
    expired = 0
    restorable = 0
    for attachment in attachments:
        try:
            stamp = datetime.fromisoformat(str(attachment.get("deleted_at", "")).replace("Z", "+00:00"))
            stamp = stamp.replace(tzinfo=timezone.utc) if stamp.tzinfo is None else stamp
            if stamp <= cutoff:
                expired += 1
            else:
                restorable += 1
        except ValueError:
            expired += 1
    return {"retention_days": ATTACHMENT_RESTORE_RETENTION.days, "soft_deleted": len(attachments),
            "restorable": restorable, "expired": expired, "storage_bytes_deleted": 0}

# ---------- Test variants (clone with tweaked prompts) ----------
@api.post("/testcases/{id}/clone")
async def clone_testcase(id: str, body: Dict[str, Any], user=Depends(require_writer)):
    src = await crud_get("testcases", id)
    await _require_active_testcase(id)
    new = {k: src.get(k) for k in ("project_id", "municipality_id", "property_id", "category", "subcategory",
                                   "test_type", "criticality", "difficulty", "scenario", "purpose",
                                   "prompts", "expected_behaviors", "bassett_version", "evidence_ids")}
    overrides = {k: v for k, v in body.items() if k in ("name", "prompts", "expected_behaviors",
                                                        "scenario", "purpose", "criticality", "difficulty")}
    new.update(overrides)
    new["name"] = (new.get("name") or "").strip() or f"{src['name']} (Variant)"
    new["status"] = "Draft"
    new["variant_of"] = id
    doc = await crud_create("testcases", new, user)
    # Copy the Gold Standard as a draft starting point (variant may need adjustments)
    gold = await db.goldstandards.find_one({"testcase_id": id}, {"_id": 0})
    if gold:
        g = dict(gold)
        g.update({"id": new_id(), "testcase_id": doc["id"], "review_status": "Draft",
                  "created_at": now_iso(), "created_by": user["name"]})
        await db.goldstandards.insert_one(dict(g))
    await log_activity("testcases", id, "variant created", user, doc["name"])
    return doc

@api.get("/testcases/{id}/variant-comparison")
async def variant_comparison(id: str, user=Depends(get_current_user)):
    tc = await crud_get("testcases", id)
    root_id = tc.get("variant_of") or id
    root = await db.testcases.find_one({"id": root_id}, {"_id": 0}) or tc
    variants = await db.testcases.find(
        {"variant_of": root_id, "archived": {"$ne": True}}, {"_id": 0}
    ).to_list(50)
    family = [root] + sorted(variants, key=lambda v: v.get("created_at", ""))
    ids = [t["id"] for t in family]
    evals = await _authoritative_evaluation_read_model(
        await crud_list("evaluations", {"model": "Bassett", "testcase_id": {"$in": ids}})
    )
    latest = {
        evaluation["testcase_id"]: evaluation
        for evaluation in latest_evaluations(evals, lambda evaluation: evaluation["testcase_id"])
    }
    resps = await db.responses.find({"model": "Bassett", "testcase_id": {"$in": ids}}, {"_id": 0}).to_list(500)
    resp_by_tc = {}
    for r in sorted(resps, key=lambda x: (x.get("turn", 1), x.get("created_at", ""))):
        resp_by_tc.setdefault(r["testcase_id"], []).append(r)
    items = []
    for t in family:
        e = latest.get(t["id"])
        items.append({"testcase": {k: t.get(k) for k in ("id", "name", "status", "prompts", "criticality", "variant_of")},
                      "evaluation": {"overall_score": e.get("overall_score"), "final_result": e.get("final_result"),
                                     "notes": e.get("notes", "")} if e else None,
                      "responses": [{"turn": r.get("turn", 1), "response": r.get("response", ""),
                                     "citations": r.get("citations", "")} for r in resp_by_tc.get(t["id"], [])]})
    scored = [i for i in items if i["evaluation"] and i["evaluation"]["overall_score"] is not None]
    best_id = max(scored, key=lambda i: i["evaluation"]["overall_score"])["testcase"]["id"] if len(scored) > 1 else None
    worst_id = min(scored, key=lambda i: i["evaluation"]["overall_score"])["testcase"]["id"] if len(scored) > 1 else None
    if best_id == worst_id:
        best_id = worst_id = None
    return {"root_id": root_id, "items": items, "best_id": best_id, "worst_id": worst_id}

# ---------- Unified metrics service (single source of truth for all dashboards) ----------
def _latest_per(evals, key):
    return latest_evaluations(evals, key)


def _regression_execution_key(run):
    return (run.get("created_at") or run.get("run_date") or "", run.get("id") or "")


def _latest_regression_run(runs, version=None):
    eligible = [run for run in runs if not version or run.get("bassett_version") == version]
    return max(eligible, key=_regression_execution_key) if eligible else None


def _regression_execution_date(run):
    return (run.get("run_date") or run.get("created_at") or "")[:10]

def _canonical_retest_executions(retests, testcases):
    """Return retest executions whose Test Case relationship is still active.

    Retests are workflow history for a finding, so a completed retest remains
    meaningful when its finding later moves to a terminal (or archived) state.
    The Test Case is the analytical ownership link: archived Test Cases and
    retests whose Test Case no longer exists must not appear in current
    dashboard populations.
    """
    active_testcase_ids = {
        testcase.get("id")
        for testcase in testcases
        if testcase.get("id")
        and not testcase.get("archived")
        and testcase.get("status") != "Archived"
    }
    return [
        retest for retest in retests
        if not retest.get("archived")
        and retest.get("status") != "Archived"
        and retest.get("testcase_id") in active_testcase_ids
    ]

@api.get("/metrics/summary")
async def metrics_summary(user=Depends(get_current_user)):
    tcs = await crud_list("testcases")
    valid_ids = {t["id"] for t in tcs}
    raw_evaluations = await crud_list("evaluations")
    all_view = await _evaluation_read_model(
        raw_evaluations, valid_testcase_ids=valid_ids,
    )
    findings = await crud_list("findings")
    retests = _canonical_retest_executions(await crud_list("retests"), tcs)
    runs = await crud_list("regression_runs")
    active = await db.versions.find_one({"active": True}, {"_id": 0})
    ver = active.get("name", "") if active else ""
    current_view = (
        await _evaluation_read_model(
            raw_evaluations, valid_testcase_ids=valid_ids, version=ver,
        )
        if ver
        else {"eligible": [], "all_models": [], "bassett": []}
    )

    def pack(subset, unit, definition):
        summary = result_summary(subset)
        return {
            "unit": unit, "passed": summary["passed"], "failed": summary["failed"],
            "evaluated": summary["evaluated"], "pass_rate": summary["pass_rate"],
            "label": f"{summary['passed']} of {summary['evaluated']} passed",
            "definition": definition,
        }

    # Latest Bassett evaluation per test case, current version, retests excluded
    b_cur = current_view["bassett"]
    # Latest Bassett evaluation per test case, any version
    b_all = all_view["bassett"]
    # Every model evaluation record (latest per testcase+model), all models mixed — labeled as such
    m_all = all_view["all_models"]

    scored = [e for e in b_cur if e.get("overall_score") is not None]
    open_f = [f for f in findings if _finding_is_open(f)]
    reg = _latest_regression_run(runs, ver)

    return {
        "active_version": ver,
        "test_cases": {"total": len(tcs), "unit": "test cases",
                       "definition": "All test case definitions, any status, variants included."},
        "bassett_current": pack(b_cur, "test cases (latest Bassett evaluation each)",
                                f"Latest Bassett evaluation per test case for {ver or 'active version'}. Pass includes 'Pass with Minor Issues'. Retests and historical runs excluded. Unevaluated tests excluded from denominator."),
        "bassett_all_versions": pack(b_all, "test cases (latest Bassett evaluation each)",
                                     "Latest Bassett evaluation per test case across all Bassett versions. Pass includes 'Pass with Minor Issues'."),
        "all_model_evaluations": pack(m_all, "model evaluations (Bassett + ChatGPT + Claude)",
                                      "Latest evaluation per test case per model — mixes Bassett with benchmark models; do not read as Bassett quality."),
        "bassett_avg_score": {"value": average_score(b_cur),
                              "unit": "avg overall score /10", "definition": f"Mean of latest Bassett evaluation scores per test case for {ver or 'the active version'}, n={len(scored)}."},
        "findings": {"open": len(open_f), "open_critical": len([f for f in open_f if (f.get("criticality") or 0) >= 4]),
                      "awaiting_fix": len([f for f in open_f if f.get("developer_status") in FINDING_AWAITING_FIX_STATUSES]),
                     "ready_for_retest": len([f for f in open_f if f.get("developer_status") == "Ready for Retest"]),
                      "unit": "findings", "definition": "Open excludes Fixed/Closed/Won't Fix/Duplicate; awaiting fix is In Development (plus legacy Fix In Progress)."},
        "retests": {"total": len(retests), "completed": len([r for r in retests if r.get("status") == "Completed"]),
                    "in_progress": len([r for r in retests if r.get("status") == "In Progress"]),
                    "unit": "retest executions",
                    "definition": "Active Test Case-linked, non-archived retest executions (status field); the same canonical records shown by the dashboard drill-down."},
        "regression_current": ({"version": ver, "passed": reg.get("passed", 0), "failed": reg.get("failed", 0),
                                "newly_failing": (reg.get("newly_failing") or 0), "suite": reg.get("suite_name", ""),
                                 "id": reg.get("id"), "execution_date": _regression_execution_date(reg),
                                 "test_date": reg.get("test_date") or _regression_execution_date(reg),
                                "label": f"Regression run for {ver}: {reg.get('passed', 0)} of {reg.get('passed', 0) + reg.get('failed', 0)} suite tests passed",
                                "unit": "regression executions",
                                "definition": "Most recent regression run for the active Bassett version; counts suite executions, not test case definitions."} if reg else None),
    }


@api.get("/dashboard/records/{metric}")
async def dashboard_metric_records(metric: str, user=Depends(get_current_user)):
    """Return the exact record population represented by a Dashboard card."""
    tcs = [
        testcase for testcase in await crud_list("testcases")
        if not testcase.get("archived") and testcase.get("status") != "Archived"
    ]
    tc_by_id = {t["id"]: t for t in tcs}
    valid_ids = set(tc_by_id)
    raw_evaluations = await crud_list("evaluations")
    all_view = await _evaluation_read_model(
        raw_evaluations, valid_testcase_ids=valid_ids,
    )
    findings = await crud_list("findings")
    retests = _canonical_retest_executions(await crud_list("retests"), tcs)
    projects = await crud_list("projects")
    projects = _enrich_project_completions(projects, tcs)
    demos = await crud_list("demos")
    runs = await crud_list("regression_runs")
    active = await db.versions.find_one({"active": True}, {"_id": 0})
    version = active.get("name", "") if active else ""
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

