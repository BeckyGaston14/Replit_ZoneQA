"""Iteration 5 — managed object storage attachment tests.

Covers upload/list/download/delete round-trip via cookie authentication,
rejection paths (bad ext, bad entity_type, viewer 403, unauthenticated 401),
and evidence entity_type parity.
"""
import io
import secrets
import pytest
import requests
import uuid
from .live_auth import base_url, headers_from_login, login_headers

BASE_URL = base_url()

# 1x1 PNG bytes (real image)
TINY_PNG = (
    b"\x89PNG\r\n\x1a\n\x00\x00\x00\rIHDR\x00\x00\x00\x01\x00\x00\x00\x01"
    b"\x08\x02\x00\x00\x00\x90wS\xde\x00\x00\x00\x0cIDATx\x9cc\xf8\xcf\xc0"
    b"\x00\x00\x00\x03\x00\x01\xa5\x8bDW\x00\x00\x00\x00IEND\xaeB`\x82"
)
TINY_TXT = b"Hello ZoneQA attachment test - iteration 5"


# ---------- fixtures local to this file (independent of conftest for clarity) ----------
@pytest.fixture(scope="module")
def admin_token():
    return login_headers(BASE_URL, "admin")


@pytest.fixture(scope="module")
def viewer_token():
    return login_headers(BASE_URL, "viewer")


@pytest.fixture(scope="module")
def admin_headers(admin_token):
    return admin_token


@pytest.fixture(scope="module")
def viewer_headers(viewer_token):
    return viewer_token


@pytest.fixture(scope="module")
def finding_id(admin_headers):
    r = requests.get(f"{BASE_URL}/api/findings", headers=admin_headers)
    assert r.status_code == 200
    findings = r.json()
    assert len(findings) >= 1
    return findings[0]["id"]


@pytest.fixture(scope="module")
def evidence_id(admin_headers):
    r = requests.get(f"{BASE_URL}/api/evidence", headers=admin_headers)
    assert r.status_code == 200
    ev = r.json()
    assert len(ev) >= 1
    return ev[0]["id"]


# helper — every id we create gets soft-deleted in teardown regardless of test path
_CREATED = []


@pytest.fixture(scope="module", autouse=True)
def cleanup(admin_headers):
    yield
    for aid in _CREATED:
        try:
            requests.delete(f"{BASE_URL}/api/attachments/{aid}", headers=admin_headers)
        except Exception:
            pass


def _upload(headers, entity_type, entity_id, filename, content, ct):
    files = {"file": (filename, io.BytesIO(content), ct)}
    data = {"entity_type": entity_type, "entity_id": entity_id}
    # requests will set multipart headers correctly if we DON'T send our own Content-Type
    hdrs = {k: v for k, v in headers.items() if k.lower() != "content-type"}
    return requests.post(f"{BASE_URL}/api/attachments/upload", headers=hdrs, files=files, data=data)


# ---------- happy path: finding + txt + png round trip ----------
class TestAttachmentRoundTrip:
    def test_upload_txt_to_finding(self, admin_headers, finding_id):
        r = _upload(admin_headers, "finding", finding_id, "TEST_iter5_note.txt", TINY_TXT, "text/plain")
        assert r.status_code == 200, r.text
        d = r.json()
        assert d["entity_type"] == "finding" and d["entity_id"] == finding_id
        assert d["original_filename"] == "TEST_iter5_note.txt"
        assert d["storage_path"].startswith("zoneqa-bassett/uploads/finding/")
        assert d["size"] == len(TINY_TXT)
        assert d["content_type"] == "text/plain"
        assert "id" in d
        _CREATED.append(d["id"])
        pytest.txt_id = d["id"]

    def test_upload_png_to_finding(self, admin_headers, finding_id):
        r = _upload(admin_headers, "finding", finding_id, "TEST_iter5.png", TINY_PNG, "image/png")
        assert r.status_code == 200, r.text
        d = r.json()
        assert d["content_type"] == "image/png"
        assert d["storage_path"].endswith(".png")
        assert d["size"] == len(TINY_PNG)
        _CREATED.append(d["id"])
        pytest.png_id = d["id"]

    def test_list_returns_both(self, admin_headers, finding_id):
        r = requests.get(f"{BASE_URL}/api/attachments",
                         params={"entity_type": "finding", "entity_id": finding_id},
                         headers=admin_headers)
        assert r.status_code == 200
        ids = {a["id"] for a in r.json()}
        assert pytest.txt_id in ids and pytest.png_id in ids

    def test_download_cookie_txt_exact_bytes(self, admin_headers):
        r = requests.get(f"{BASE_URL}/api/attachments/{pytest.txt_id}/download", headers=admin_headers)
        assert r.status_code == 200
        assert r.content == TINY_TXT
        assert "text/plain" in r.headers.get("Content-Type", "")

    def test_download_cookie_png_exact_bytes(self, admin_headers):
        r = requests.get(f"{BASE_URL}/api/attachments/{pytest.png_id}/download", headers=admin_headers)
        assert r.status_code == 200
        assert r.content == TINY_PNG
        assert r.headers.get("Content-Type", "").startswith("image/png")

    def test_download_rejects_query_token(self, admin_token):
        r = requests.get(f"{BASE_URL}/api/attachments/{pytest.png_id}/download",
                         params={"auth": "obsolete-query-auth-is-rejected"})
        assert r.status_code == 401

    def test_delete_soft_deletes(self, admin_headers, finding_id):
        r = requests.delete(f"{BASE_URL}/api/attachments/{pytest.txt_id}", headers=admin_headers)
        assert r.status_code == 200
        # Writers can refresh the list and still reach the restore action.
        lst = requests.get(f"{BASE_URL}/api/attachments",
                           params={"entity_type": "finding", "entity_id": finding_id},
                           headers=admin_headers).json()
        deleted = next(a for a in lst if a["id"] == pytest.txt_id)
        assert deleted["is_deleted"] is True
        assert deleted["status"] == "deleted"
        assert deleted["restore_expires_at"]
        # Viewers never receive deleted-file metadata.
        viewer_headers = login_headers(BASE_URL, "viewer")
        viewer_list = requests.get(
            f"{BASE_URL}/api/attachments",
            params={"entity_type": "finding", "entity_id": finding_id},
            headers=viewer_headers,
        ).json()
        assert pytest.txt_id not in {a["id"] for a in viewer_list}
        # download 404
        r2 = requests.get(f"{BASE_URL}/api/attachments/{pytest.txt_id}/download", headers=admin_headers)
        assert r2.status_code == 404
        restored = requests.post(
            f"{BASE_URL}/api/attachments/{pytest.txt_id}/restore",
            headers=admin_headers,
        )
        assert restored.status_code == 200, restored.text
        refreshed = requests.get(
            f"{BASE_URL}/api/attachments",
            params={"entity_type": "finding", "entity_id": finding_id},
            headers=admin_headers,
        ).json()
        active = next(a for a in refreshed if a["id"] == pytest.txt_id)
        assert active["is_deleted"] is False
        assert "restore_expires_at" not in active
        assert requests.get(
            f"{BASE_URL}/api/attachments/{pytest.txt_id}/download",
            headers=admin_headers,
        ).status_code == 200


# ---------- rejection paths ----------
class TestAttachmentRejections:
    def test_disallowed_extension(self, admin_headers, finding_id):
        r = _upload(admin_headers, "finding", finding_id, "bad.sh", b"#!/bin/sh\n", "application/octet-stream")
        assert r.status_code == 400
        assert ".sh" in r.text.lower() or "not allowed" in r.text.lower()

    def test_disallowed_exe(self, admin_headers, finding_id):
        r = _upload(admin_headers, "finding", finding_id, "bad.exe", b"MZ", "application/octet-stream")
        assert r.status_code == 400

    def test_invalid_entity_type(self, admin_headers, finding_id):
        r = _upload(admin_headers, "banana", finding_id, "x.txt", b"x", "text/plain")
        assert r.status_code == 400
        assert "entity" in r.text.lower()

    def test_viewer_upload_403(self, viewer_headers, finding_id):
        r = _upload(viewer_headers, "finding", finding_id, "TEST_iter5_viewer.txt", b"nope", "text/plain")
        assert r.status_code == 403

    def test_viewer_delete_403(self, admin_headers, viewer_headers, finding_id):
        # admin creates, viewer tries to delete
        up = _upload(admin_headers, "finding", finding_id, "TEST_iter5_delme.txt", b"delme", "text/plain")
        assert up.status_code == 200
        aid = up.json()["id"]
        _CREATED.append(aid)
        r = requests.delete(f"{BASE_URL}/api/attachments/{aid}", headers=viewer_headers)
        assert r.status_code == 403

    def test_unauthenticated_download(self, admin_headers, finding_id):
        up = _upload(admin_headers, "finding", finding_id, "TEST_iter5_auth.txt", b"secret", "text/plain")
        assert up.status_code == 200
        aid = up.json()["id"]
        _CREATED.append(aid)
        # no header
        r = requests.get(f"{BASE_URL}/api/attachments/{aid}/download")
        assert r.status_code == 401
        # malformed session cookie
        r2 = requests.get(
            f"{BASE_URL}/api/attachments/{aid}/download",
            headers={"Cookie": "zq_session=invalid"},
        )
        assert r2.status_code == 401

    def test_client_supplied_mime_type_is_not_trusted(self, admin_headers, finding_id):
        up = _upload(admin_headers, "finding", finding_id, "TEST_iter5_mime.txt", b"<script>alert(1)</script>", "text/html")
        assert up.status_code == 200, up.text
        aid = up.json()["id"]
        _CREATED.append(aid)
        assert up.json()["content_type"] == "text/plain"
        downloaded = requests.get(f"{BASE_URL}/api/attachments/{aid}/download", headers=admin_headers)
        assert downloaded.status_code == 200
        assert downloaded.headers["Content-Type"].startswith("text/plain")
        assert downloaded.headers["X-Content-Type-Options"] == "nosniff"
        assert downloaded.headers["Content-Disposition"].startswith("attachment;")

    def test_upload_rejects_file_over_limit(self, admin_headers, finding_id):
        response = _upload(
            admin_headers, "finding", finding_id, "TEST_iter5_large.txt",
            b"x" * (20 * 1024 * 1024 + 1), "text/plain",
        )
        assert response.status_code == 400
        assert "20 mb" in response.text.lower()

    def test_deactivated_user_cannot_download_with_session_cookie(self, admin_headers, finding_id):
        email = f"TEST_attachment_inactive_{uuid.uuid4().hex[:8]}@example.com"
        password = secrets.token_urlsafe(18)
        created = requests.post(
            f"{BASE_URL}/api/users",
            headers=admin_headers,
            json={"email": email, "name": "Attachment Test", "role": "tester", "active": True},
        )
        assert created.status_code == 200, created.text
        user_id = created.json()["user"]["id"]
        activation_path = created.json()["activation_path"]
        attachment_id = None
        try:
            activated = requests.post(
                f"{BASE_URL}/api/auth/activate",
                json={"token": activation_path.split("token=", 1)[1], "password": password},
            )
            assert activated.status_code == 200, activated.text
            user_headers = headers_from_login(BASE_URL, {"email": email, "password": password})
            uploaded = _upload(admin_headers, "finding", finding_id, "TEST_iter5_inactive.txt", b"private", "text/plain")
            assert uploaded.status_code == 200, uploaded.text
            attachment_id = uploaded.json()["id"]
            _CREATED.append(attachment_id)

            deactivated = requests.post(f"{BASE_URL}/api/users/{user_id}/deactivate", headers=admin_headers)
            assert deactivated.status_code == 200, deactivated.text
            blocked = requests.get(
                f"{BASE_URL}/api/attachments/{attachment_id}/download",
                headers=user_headers,
            )
            assert blocked.status_code == 403
        finally:
            if attachment_id:
                requests.delete(f"{BASE_URL}/api/attachments/{attachment_id}", headers=admin_headers)
            requests.delete(
                f"{BASE_URL}/api/users/{user_id}",
                headers=admin_headers,
                params={"confirm": "true"},
            )


# ---------- evidence entity ----------
class TestEvidenceEntity:
    def test_upload_and_list_evidence(self, admin_headers, evidence_id):
        r = _upload(admin_headers, "evidence", evidence_id, "TEST_iter5_ev.png", TINY_PNG, "image/png")
        assert r.status_code == 200, r.text
        aid = r.json()["id"]
        _CREATED.append(aid)
        lst = requests.get(f"{BASE_URL}/api/attachments",
                           params={"entity_type": "evidence", "entity_id": evidence_id},
                           headers=admin_headers).json()
        assert aid in {a["id"] for a in lst}
        # download
        dl = requests.get(f"{BASE_URL}/api/attachments/{aid}/download", headers=admin_headers)
        assert dl.status_code == 200 and dl.content == TINY_PNG

    def test_viewer_can_list_but_not_upload(self, viewer_headers, evidence_id):
        # viewer can GET list (get_current_user, not require_writer)
        r = requests.get(f"{BASE_URL}/api/attachments",
                         params={"entity_type": "evidence", "entity_id": evidence_id},
                         headers=viewer_headers)
        assert r.status_code == 200
        # but cannot upload
        up = _upload(viewer_headers, "evidence", evidence_id, "TEST_iter5_v_ev.txt", b"nope", "text/plain")
        assert up.status_code == 403


# ---------- direct test case and testing project attachments ----------
class TestTestCaseAndProjectAttachments:
    def _round_trip(self, admin_headers, entity_type, collection, payload):
        created = requests.post(f"{BASE_URL}/api/{collection}", headers=admin_headers, json=payload)
        assert created.status_code == 200, created.text
        entity_id = created.json()["id"]
        attachment_id = None
        try:
            filename = f"TEST_attachment_{uuid.uuid4().hex[:8]}.png"
            uploaded = _upload(admin_headers, entity_type, entity_id, filename, TINY_PNG, "image/png")
            assert uploaded.status_code == 200, uploaded.text
            attachment = uploaded.json()
            attachment_id = attachment["id"]
            _CREATED.append(attachment_id)
            assert attachment["entity_type"] == entity_type
            assert attachment["entity_id"] == entity_id

            listed = requests.get(
                f"{BASE_URL}/api/attachments",
                params={"entity_type": entity_type, "entity_id": entity_id},
                headers=admin_headers,
            )
            assert listed.status_code == 200
            assert attachment_id in {item["id"] for item in listed.json()}

            downloaded = requests.get(
                f"{BASE_URL}/api/attachments/{attachment_id}/download",
                headers=admin_headers,
            )
            assert downloaded.status_code == 200
            assert downloaded.content == TINY_PNG
        finally:
            if attachment_id:
                requests.delete(f"{BASE_URL}/api/attachments/{attachment_id}", headers=admin_headers)
            requests.delete(f"{BASE_URL}/api/{collection}/{entity_id}", headers=admin_headers)

    def test_testcase_image_attachment_round_trip(self, admin_headers):
        self._round_trip(
            admin_headers,
            "testcase",
            "testcases",
            {"name": f"TEST attachment testcase {uuid.uuid4().hex[:8]}", "status": "Draft"},
        )

    def test_project_image_attachment_round_trip(self, admin_headers):
        self._round_trip(
            admin_headers,
            "project",
            "projects",
            {"name": f"TEST attachment project {uuid.uuid4().hex[:8]}", "status": "Active"},
        )

    def test_upload_rejects_missing_parent_record(self, admin_headers):
        missing_id = f"missing-{uuid.uuid4()}"
        for entity_type in ("testcase", "project"):
            response = _upload(
                admin_headers, entity_type, missing_id,
                f"TEST_missing_{entity_type}.txt", TINY_TXT, "text/plain",
            )
            assert response.status_code == 404
