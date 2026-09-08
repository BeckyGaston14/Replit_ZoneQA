"""Non-production API workflow coverage for structured Bassett conversations."""

import json

from fastapi.testclient import TestClient

import server


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

    def __getitem__(self, name):
        return _Collection(self, name)

    def __getattr__(self, name):
        return _Collection(self, name)

    async def create_bassett_workflow(
        self, document, _creation_key, _snapshot_fields, finding=None,
        attachment_documents=(), history_documents=(), activity_document=None,
    ):
        self.records.setdefault("bassett_issues", []).append(dict(document))
        if finding:
            self.records.setdefault("findings", []).append(dict(finding))
        self.records.setdefault("bassett_history", []).extend(dict(item) for item in history_documents)
        if activity_document:
            self.records.setdefault("activities", []).append(dict(activity_document))
        return dict(document), True


def test_three_turn_workflow_create_reopen_reorder_and_link_finding(monkeypatch):
    database = _Database()
    monkeypatch.setattr(server, "db", database)
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
    }
    try:
        created_response = client.post(
            "/api/bassett/issues/workflow",
            files={"payload": (None, json.dumps(payload))},
        )
        assert created_response.status_code == 200, created_response.text
        issue_id = created_response.json()["issue"]["id"]

        reopened = client.get(f"/api/bassett/issues/{issue_id}")
        assert reopened.status_code == 200
        assert [turn["id"] for turn in reopened.json()["turns"]] == ["turn-1", "turn-2", "turn-3"]

        edited_turns = [turns[1], turns[0], turns[2]]
        edited = client.put(f"/api/bassett/issues/{issue_id}", json={
            "test_type": "Multi-turn",
            "turns": [{**turn, "order": index} for index, turn in enumerate(edited_turns, start=1)],
            "expected_revision": 1,
        })
        assert edited.status_code == 200, edited.text
        assert [turn["prompt"] for turn in edited.json()["turns"]] == ["Second", "First", "Third"]

        database.records["findings"] = [{
            "id": "finding-1", "title": "Turn finding", "project_id": None, "testcase_id": None,
        }]
        linked = client.post(f"/api/bassett/issues/{issue_id}/link-finding", json={
            "finding_id": "finding-1", "turn_id": "turn-2",
        })
        assert linked.status_code == 200, linked.text
        reopened_after_link = client.get(f"/api/bassett/issues/{issue_id}").json()
        assert reopened_after_link["finding_turn_id"] == "turn-2"
        assert reopened_after_link["finding"]["bassett_turn_id"] == "turn-2"
    finally:
        server.app.dependency_overrides.pop(server.get_current_user, None)