"""Admin user lifecycle and Bassett version management regression tests."""
import uuid
import secrets


def unique_email(prefix):
    return f"{prefix}-{uuid.uuid4().hex[:8]}@example.com"


class TestUserLifecycle:
    def test_update_deactivate_and_soft_delete_user(self, auth_client, base_url):
        email = unique_email("lifecycle")
        password = secrets.token_urlsafe(18)
        created = auth_client.post(f"{base_url}/api/users", json={
            "email": email, "name": "Lifecycle User", "role": "tester", "active": True
        })
        assert created.status_code == 200
        user_id = created.json()["user"]["id"]
        activation = auth_client.post(f"{base_url}/api/auth/activate", json={
            "token": created.json()["activation_path"].split("token=", 1)[1],
            "password": password,
        })
        assert activation.status_code == 200

        updated = auth_client.put(f"{base_url}/api/users/{user_id}", json={
            "name": "Updated Lifecycle User", "email": email, "role": "developer"
        })
        assert updated.status_code == 200
        assert updated.json()["name"] == "Updated Lifecycle User"

        impact = auth_client.get(f"{base_url}/api/users/{user_id}/impact")
        assert impact.status_code == 200
        assert "total_references" in impact.json()

        must_deactivate = auth_client.delete(f"{base_url}/api/users/{user_id}", params={"confirm": "true"})
        assert must_deactivate.status_code == 409

        assert auth_client.post(f"{base_url}/api/users/{user_id}/deactivate").status_code == 200

        inactive_login = auth_client.post(f"{base_url}/api/auth/login", json={
            "email": email, "password": password
        })
        assert inactive_login.status_code == 403

        deleted = auth_client.delete(f"{base_url}/api/users/{user_id}", params={"confirm": "true"})
        assert deleted.status_code == 200
        assert deleted.json()["history_preserved"] is True

        visible = auth_client.get(f"{base_url}/api/users").json()
        assert all(u["id"] != user_id for u in visible)

    def test_admin_cannot_deactivate_or_delete_self(self, auth_client, base_url):
        me = auth_client.get(f"{base_url}/api/auth/me").json()
        assert auth_client.post(f"{base_url}/api/users/{me['id']}/deactivate").status_code == 409
        assert auth_client.delete(
            f"{base_url}/api/users/{me['id']}", params={"confirm": "true"}
        ).status_code == 409

    def test_duplicate_email_is_rejected(self, auth_client, base_url):
        users = auth_client.get(f"{base_url}/api/users").json()
        target = next(u for u in users if u["id"] != auth_client.get(f"{base_url}/api/auth/me").json()["id"])
        result = auth_client.put(f"{base_url}/api/users/{target['id']}", json={
            "email": users[0]["email"]
        })
        if target["email"] != users[0]["email"]:
            assert result.status_code == 409


class TestBassettVersionManagement:
    def test_create_edit_and_delete_unreferenced_version(self, auth_client, base_url):
        suffix = uuid.uuid4().hex[:8]
        created = auth_client.post(f"{base_url}/api/versions", json={
            "name": f"TEST Bassett {suffix}", "release_number": f"test-{suffix}",
            "version_type": "Patch", "release_channel": "Development",
            "environment": "Development", "active": False
        })
        assert created.status_code == 200
        version = created.json()
        edited = auth_client.put(f"{base_url}/api/versions/{version['id']}", json={
            "version_type": "Hotfix", "release_channel": "Staging"
        })
        assert edited.status_code == 200
        assert edited.json()["version_type"] == "Hotfix"
        assert auth_client.delete(f"{base_url}/api/versions/{version['id']}").status_code == 200

    def test_invalid_version_type_is_rejected(self, auth_client, base_url):
        suffix = uuid.uuid4().hex[:8]
        result = auth_client.post(f"{base_url}/api/versions", json={
            "name": f"TEST Invalid {suffix}", "release_number": f"invalid-{suffix}",
            "version_type": "Made Up Type", "release_channel": "Development"
        })
        assert result.status_code == 400

    def test_referenced_version_cannot_be_deleted(self, auth_client, base_url):
        suffix = uuid.uuid4().hex[:8]
        version = auth_client.post(f"{base_url}/api/versions", json={
            "name": f"TEST Referenced {suffix}", "release_number": f"ref-{suffix}",
            "version_type": "Patch", "release_channel": "Development",
            "environment": "Development", "active": False
        }).json()
        testcase = auth_client.post(f"{base_url}/api/testcases", json={
            "name": f"TEST version guard {suffix}", "status": "Draft"
        }).json()
        evaluation = auth_client.post(f"{base_url}/api/evaluations", json={
            "testcase_id": testcase["id"], "model": "Bassett",
            "bassett_version": version["name"], "overall_score": 8, "final_result": "Pass"
        }).json()

        blocked = auth_client.delete(f"{base_url}/api/versions/{version['id']}")
        assert blocked.status_code == 409

        auth_client.delete(f"{base_url}/api/evaluations/{evaluation['id']}")
        auth_client.delete(f"{base_url}/api/testcases/{testcase['id']}")
        assert auth_client.delete(f"{base_url}/api/versions/{version['id']}").status_code == 200
