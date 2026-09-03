"""Small Gmail sender backed by Replit's managed connector proxy.

The connector proxy supplies OAuth access to the connected Gmail account. This
module intentionally does not persist, print, or return any provider token.
"""

from __future__ import annotations

import base64
from email.message import EmailMessage
from email.policy import SMTP
import html
import os
import subprocess
from typing import Any

import httpx


class EmailDeliveryError(RuntimeError):
    """A safe, user-facing email delivery failure."""


class GmailSender:
    connector_name = "google-mail"

    def __init__(self, *, timeout: float = 12.0):
        self.timeout = timeout

    @staticmethod
    def _base_url() -> str:
        hostname = os.environ.get("REPLIT_CONNECTORS_HOSTNAME", "").strip()
        if not hostname:
            raise EmailDeliveryError("Gmail connector is not configured")
        if not hostname.startswith(("http://", "https://")):
            hostname = f"https://{hostname}"
        return hostname.rstrip("/")

    @staticmethod
    def _cli_identity_token() -> str | None:
        audience = os.environ.get(
            "REPLIT_CONNECTORS_AUDIENCE", "https://connectors.replit.com"
        )
        if not audience.startswith(("http://", "https://")):
            audience = f"https://{audience}"
        try:
            completed = subprocess.run(
                ["replit", "identity", "create", "--audience", audience],
                check=True,
                capture_output=True,
                text=True,
                timeout=5,
            )
        except (OSError, subprocess.SubprocessError):
            return None
        token = completed.stdout.strip()
        return token or None

    @classmethod
    def _auth_headers(cls) -> dict[str, str]:
        # Deployment identity is preferred because it is audience-scoped and
        # short-lived. The Repl identity fallback is the supported local path.
        token = cls._cli_identity_token()
        if token:
            return {
                "Accept": "application/json",
                "Replit-Authentication": f"Bearer {token}",
            }
        repl_identity = os.environ.get("REPL_IDENTITY", "").strip()
        if repl_identity:
            return {
                "Accept": "application/json",
                "X-Replit-Token": f"repl {repl_identity}",
            }
        raise EmailDeliveryError("Gmail connector identity is unavailable")

    async def _request(
        self, method: str, path: str, *, json_body: dict[str, Any] | None = None
    ) -> httpx.Response:
        url = f"{self._base_url()}/api/v2/proxy{path}"
        headers = {**self._auth_headers(), "Connector-Name": self.connector_name}
        async with httpx.AsyncClient(timeout=self.timeout) as client:
            response = await client.request(method, url, headers=headers, json=json_body)
            if response.status_code == 401:
                # Rebuild the identity headers once; connector tokens can
                # expire between a status check and a send.
                headers = {
                    **self._auth_headers(),
                    "Connector-Name": self.connector_name,
                }
                response = await client.request(
                    method, url, headers=headers, json=json_body
                )
        return response

    @staticmethod
    def _check(response: httpx.Response) -> dict[str, Any]:
        if not 200 <= response.status_code < 300:
            raise EmailDeliveryError("Gmail delivery is unavailable")
        try:
            payload = response.json()
        except ValueError:
            return {}
        return payload if isinstance(payload, dict) else {}

    async def _profile(self) -> dict[str, Any]:
        try:
            response = await self._request("GET", "/gmail/v1/users/me/profile")
            payload = self._check(response)
        except (httpx.HTTPError, EmailDeliveryError) as error:
            if isinstance(error, EmailDeliveryError):
                raise
            raise EmailDeliveryError("Gmail delivery is unavailable") from error
        if not payload.get("emailAddress"):
            raise EmailDeliveryError("Gmail sender address is unavailable")
        return payload

    async def status(self) -> dict[str, Any]:
        try:
            await self._profile()
        except (httpx.HTTPError, EmailDeliveryError):
            return {"provider": "Gmail", "status": "disconnected"}
        return {"provider": "Gmail", "status": "connected"}

    async def send(
        self,
        *,
        recipient: str,
        recipient_name: str,
        role_label: str,
        activation_link: str,
    ) -> dict[str, Any]:
        profile = await self._profile()
        sender = str(profile["emailAddress"])
        safe_name = html.escape(recipient_name, quote=True)
        safe_role = html.escape(role_label, quote=True)
        safe_link = html.escape(activation_link, quote=True)

        message = EmailMessage(policy=SMTP)
        message["From"] = f"ZoneQA <{sender}>"
        message["To"] = recipient
        message["Subject"] = "Welcome to ZoneQA"
        message.set_content(
            f"""Welcome to ZoneQA, {recipient_name}.

An administrator created a {role_label} account for you. Use this secure,
single-use link within 24 hours to set your password:

{activation_link}

If you did not expect this invitation, you can ignore this email.

— The ZoneQA team
"""
        )
        message.add_alternative(
            f"""<!doctype html>
<html>
  <body style="margin:0;background:#f7f4ee;color:#172033;font-family:Arial,sans-serif">
    <div style="max-width:560px;margin:32px auto;padding:32px;background:#fff;border:1px solid #e5e0d8;border-radius:16px">
      <div style="font-size:12px;letter-spacing:.16em;font-weight:700;color:#c2410c">ZONEQA</div>
      <h1 style="margin:22px 0 10px;color:#172033;font-size:28px">Welcome, {safe_name}</h1>
      <p style="font-size:16px;line-height:1.6">An administrator created your <strong>{safe_role}</strong> account.</p>
      <p style="font-size:16px;line-height:1.6">Use the button below within 24 hours to create your private password.</p>
      <p style="margin:28px 0">
        <a href="{safe_link}" style="display:inline-block;padding:13px 20px;background:#c2410c;color:#fff;text-decoration:none;border-radius:8px;font-weight:700">Set up your account</a>
      </p>
      <p style="font-size:13px;line-height:1.6;color:#64748b">This link works once. If you did not expect this invitation, you can ignore this email.</p>
      <p style="font-size:13px;color:#64748b">— The ZoneQA team</p>
    </div>
  </body>
</html>""",
            subtype="html",
        )
        raw = base64.urlsafe_b64encode(message.as_bytes()).rstrip(b"=").decode("ascii")
        try:
            response = await self._request(
                "POST",
                "/gmail/v1/users/me/messages/send",
                json_body={"raw": raw},
            )
            self._check(response)
        except (httpx.HTTPError, EmailDeliveryError) as error:
            if isinstance(error, EmailDeliveryError):
                raise
            raise EmailDeliveryError("Gmail delivery is unavailable") from error
        return {"sent": True}

    async def send_password_reset(
        self,
        *,
        recipient: str,
        recipient_name: str,
        reset_link: str,
    ) -> dict[str, Any]:
        profile = await self._profile()
        sender = str(profile["emailAddress"])
        safe_name = html.escape(recipient_name, quote=True)
        safe_link = html.escape(reset_link, quote=True)
        message = EmailMessage(policy=SMTP)
        message["From"] = f"ZoneQA <{sender}>"
        message["To"] = recipient
        message["Subject"] = "Reset your ZoneQA password"
        message.set_content(
            f"""Hello {recipient_name}.

Use this secure, single-use link within one hour to create a new ZoneQA password:

{reset_link}

If you did not request this, you can ignore this email.

— The ZoneQA team
"""
        )
        message.add_alternative(
            f"""<!doctype html>
<html>
  <body style="margin:0;background:#f7f4ee;color:#172033;font-family:Arial,sans-serif">
    <div style="max-width:560px;margin:32px auto;padding:32px;background:#fff;border:1px solid #e5e0d8;border-radius:16px">
      <div style="font-size:12px;letter-spacing:.16em;font-weight:700;color:#c2410c">ZONEQA</div>
      <h1 style="margin:22px 0 10px;color:#172033;font-size:28px">Reset your password</h1>
      <p style="font-size:16px;line-height:1.6">Hello {safe_name}, use the button below within one hour to create a new ZoneQA password.</p>
      <p style="margin:28px 0">
        <a href="{safe_link}" style="display:inline-block;padding:13px 20px;background:#c2410c;color:#fff;text-decoration:none;border-radius:8px;font-weight:700">Reset password</a>
      </p>
      <p style="font-size:13px;line-height:1.6;color:#64748b">This link works once. If you did not request it, you can ignore this email.</p>
      <p style="font-size:13px;color:#64748b">— The ZoneQA team</p>
    </div>
  </body>
</html>""",
            subtype="html",
        )
        raw = base64.urlsafe_b64encode(message.as_bytes()).rstrip(b"=").decode("ascii")
        try:
            response = await self._request(
                "POST",
                "/gmail/v1/users/me/messages/send",
                json_body={"raw": raw},
            )
            self._check(response)
        except (httpx.HTTPError, EmailDeliveryError) as error:
            if isinstance(error, EmailDeliveryError):
                raise
            raise EmailDeliveryError("Gmail delivery is unavailable") from error
        return {"sent": True}


class MockEmailSender:
    """Safe sender for local development and unit tests."""

    def __init__(self):
        self.sent: list[dict[str, Any]] = []

    async def status(self) -> dict[str, Any]:
        return {"provider": "Mock email sender", "status": "connected"}

    async def send(self, **message: Any) -> dict[str, Any]:
        self.sent.append(dict(message))
        return {"sent": True}

    async def send_password_reset(self, **message: Any) -> dict[str, Any]:
        self.sent.append(dict(message))
        return {"sent": True}


def build_email_sender() -> GmailSender | MockEmailSender:
    configured = os.environ.get("EMAIL_SENDER_MODE", "").strip().lower()
    if configured == "mock" or (
        not configured and os.environ.get("APP_ENV", "development").lower()
        in {"development", "test"}
    ):
        return MockEmailSender()
    return GmailSender()