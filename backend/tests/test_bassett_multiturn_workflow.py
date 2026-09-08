"""Non-production API workflow coverage for structured Bassett conversations."""

import json

from fastapi.testclient import TestClient

import server


class _Storage:
    def __init__(self):
        self.objects = {}
        self.deleted = []

    async def upload_bytes(self, path, data, _content_type):
        self.objects[path] = data

    async def download_bytes(self, path):
        return self.objects[path]

    async def delete(self, path):
        self.deleted.append(path)
        self.objects.pop(path, None)


class _Cursor:
    def __init__(self, rows):
        self.rows = rows

    def sort(self, *_args, **_kwargs):
        return self

    async def to_list(self, _limit):
        return [dict(row) for row in self.rows]


class _Collection:
    def __init__(self, database, name):
        self.database = database
        self.name = name

    def _matches(self, row, query):
        for key, expected in query.items():
            if key == "$or":
                if not any(self._matches(row, option) for option in expected):
                    return False
                continue
            actual = row.get(key)
            if isinstance(expected, dict):
                if "$ne" in expected and actual == expected["$ne"]:
                    return False
                if "$exists" in expected and (key in row) != expected["$exists"]:
                    return False
            elif actual != expected:
                return False
        return True

    def find(self, query=None, *_args, **_kwargs):
        query = query or {}
        return _Cursor([row for row in self.database.records.get(self.name, []) if self._matches(row, query)])

    async def find_one(self, query, *_args, **_kwargs):
        return next((dict(row) for row in self.database.records.get(self.name, []) if self._matches(row, query)), None)

    async def insert_one(self, document):
        if self.name == "attachments" and self.database.fail_attachment_metadata:
            raise RuntimeError("attachment metadata failure")
        self.database.records.setdefault(self.name, []).append(dict(document))

    async def update_one(self, query, update):
        row = next((row for row in self.database.records.get(self.name, []) if self._matches(row, query)), None)
        if row:
            row.update(update.get("$set", {}))

    async def find_one_and_update(self, query, update, **_kwargs):
        row = next((row for row in self.database.records.get(self.name, []) if self._matches(row, query)), None)
        if not row:
            return None
        row.update(update.get("$set", {}))
        return dict(row)


class _Database:
    def __init__(self):
        self.records = {
            "bassett_scenarios": [{
                "id": "scenario-1", "stable_id": "R-01", "workflow_stage": "Research",
                "report_type": "Property", "test_scenario": "Conversation test",
                "complexity": "Medium", "why_it_matters": "Accuracy",
                "what_bassett_should_do": "Answer carefully", "success_criteria": "Correct answer",
                "priority": "P1 - High", "archived": False,
            }],
            "config": [{"id": "global", "eval_dimensions": []}],
        }
        self.fail_workflow = False
        self.fail_attachment_metadata = False

    def __getitem__(self, name):
        return _Collection(self, name)

    def __getattr__(self, name):
        return _Collection(self, name)

    async def create_bassett_workflow(
        self, document, _creation_key, _snapshot_fields, finding=None,
        attachment_documents=(), history_documents=(), activity_document=None,
    ):
        if self.fail_workflow:
            raise RuntimeError("parent workflow persistence failure")
        stored = dict(document)
        if finding:
            stored["finding_id"] = finding["id"]
        self.records.setdefault("bassett_issues", []).append(stored)
        if finding:
            self.records.setdefault("findings", []).append(dict(finding))
        self.records.setdefault("attachments", []).extend(dict(item) for item in attachment_documents)
        self.records.setdefault("bassett_history", []).extend(dict(item) for item in history_documents)
        if activity_document:
            self.records.setdefault("activities", []).append(dict(activity_document))
        return stored, True


def test_three_turn_workflow_create_reopen_reorder_and_link_finding(monkeypatch):
    database = _Database()
    storage = _Storage()
    monkeypatch.setattr(server, "db", database)
    monkeypatch.setattr(server, "app_storage", storage)
    actor = {"id": "tester-1", "name": "Tester", "role": "tester"}
    server.app.dependency_overrides[server.get_current_user] = lambda: actor
    client = TestClient(server.app)
    turns = [
        {"id": "turn-1", "order": 1, "prompt": "First", "response": "Answer one"},
        {"id": "turn-2", "order": 2, "prompt": "Second", "response": "Answer two"},
        {"id": "turn-3", "order": 3, "prompt": "Third", "response": "Answer three"},
    ]
    payload = {
        "submission_id": "multiturn-workflow-test",
        "scenario_id": "scenario-1",
        "test_type": "Multi-turn",
        "turns": turns,
        "verified_correct_answer": "The verified conversation answer",
        "result": "Pass",
        "test_date": "2026-09-08",
        "create_finding": True,
        "finding": {
            "title": "Conversation finding",
            "description": "The response needs review.",
            "turn_id": "turn-1",
        },
    }
    try:
        created_response = client.post(
            "/api/bassett/issues/workflow",
            files=[
                ("payload", (None, json.dumps(payload))),
                ("files", ("evidence.txt", b"evidence", "text/plain")),
            ],
        )
        assert created_response.status_code == 200, created_response.text
        created = created_response.json()
        issue_id = created["issue"]["id"]
        finding_id = created["finding"]["id"]
        attachment_id = created["attachments"][0]["id"]
        assert created["issue"]["finding_id"] == finding_id
        assert database.records["findings"][0]["bassett_issue_id"] == issue_id
        assert created["attachments"][0]["original_filename"] == "evidence.txt"
        assert "storage_path" not in created["attachments"][0]
        assert len(storage.objects) == 1

        reopened = client.get(f"/api/bassett/issues/{issue_id}")
        assert reopened.status_code == 200
        assert [turn["id"] for turn in reopened.json()["turns"]] == ["turn-1", "turn-2", "turn-3"]
        assert reopened.json()["finding"]["id"] == finding_id

        listed = client.get("/api/attachments", params={
            "entity_type": "bassett_issue", "entity_id": issue_id,
        })
        assert listed.status_code == 200
        assert listed.json()[0]["id"] == attachment_id
        assert "storage_path" not in listed.json()[0]
        downloaded = client.get(f"/api/attachments/{attachment_id}/download")
        assert downloaded.status_code == 200
        assert downloaded.content == b"evidence"
        assert downloaded.headers["content-disposition"].startswith("attachment;")

        linked_findings = client.get("/api/bassett/findings")
        assert linked_findings.status_code == 200
        assert linked_findings.json()[0]["bassett_issue_id"] == issue_id

        edited_turns = [turns[1], turns[0], turns[2]]
        edited = client.put(f"/api/bassett/issues/{issue_id}", json={
            "test_type": "Multi-turn",
            "turns": [{**turn, "order": index} for index, turn in enumerate(edited_turns, start=1)],
            "expected_revision": 1,
        })
        assert edited.status_code == 200, edited.text
        assert [turn["prompt"] for turn in edited.json()["turns"]] == ["Second", "First", "Third"]

        linked = client.post(f"/api/bassett/issues/{issue_id}/link-finding", json={
            "finding_id": finding_id, "turn_id": "turn-2",
        })
        assert linked.status_code == 200, linked.text
        reopened_after_link = client.get(f"/api/bassett/issues/{issue_id}").json()
        assert reopened_after_link["finding_turn_id"] == "turn-2"
        assert reopened_after_link["finding"]["bassett_turn_id"] == "turn-2"
    finally:
        server.app.dependency_overrides.pop(server.get_current_user, None)


def test_workflow_and_attachment_metadata_failures_clean_up_private_objects(monkeypatch):
    database = _Database()
    storage = _Storage()
    monkeypatch.setattr(server, "db", database)
    monkeypatch.setattr(server, "app_storage", storage)
    actor = {"id": "tester-1", "name": "Tester", "role": "tester"}
    server.app.dependency_overrides[server.get_current_user] = lambda: actor
    client = TestClient(server.app, raise_server_exceptions=False)
    payload = {
        "submission_id": "cleanup-workflow-test",
        "scenario_id": "scenario-1",
        "test_type": "Single Prompt",
        "question_asked": "Question",
        "exact_bassett_answer": "Answer",
        "verified_correct_answer": "Verified",
        "result": "Fail",
        "test_date": "2026-09-08",
    }
    try:
        database.fail_workflow = True
        failed_parent = client.post("/api/bassett/issues/workflow", files=[
            ("payload", (None, json.dumps(payload))),
            ("files", ("parent.txt", b"parent", "text/plain")),
        ])
        assert failed_parent.status_code == 500
        assert storage.objects == {}
        assert len(storage.deleted) == 1

        database.fail_workflow = False
        created = client.post("/api/bassett/issues/workflow", files={
            "payload": (None, json.dumps({**payload, "submission_id": "metadata-cleanup-test"})),
        })
        assert created.status_code == 200
        issue_id = created.json()["issue"]["id"]
        database.fail_attachment_metadata = True
        failed_attachment = client.post("/api/attachments/upload", data={
            "entity_type": "bassett_issue", "entity_id": issue_id,
        }, files={"file": ("metadata.txt", b"metadata", "text/plain")})
        assert failed_attachment.status_code == 500
        assert storage.objects == {}
        assert len(database.records.get("attachments", [])) == 0
    finally:
        server.app.dependency_overrides.pop(server.get_current_user, None)