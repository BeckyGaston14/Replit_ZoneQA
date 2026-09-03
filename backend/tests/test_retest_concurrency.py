"""Concurrency regression coverage for retest completion.

The test owns a disposable local PostgreSQL cluster and calls the FastAPI app
in-process.  It must never use the preview or production database.
"""

import asyncio
import getpass
import importlib
import socket
import subprocess
from pathlib import Path

import httpx
import pytest

from postgres_store import PostgresDatabase


def _unused_local_port() -> int:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        sock.bind(("127.0.0.1", 0))
        return sock.getsockname()[1]


@pytest.fixture
def isolated_database_url(tmp_path: Path):
    """Run one disposable PostgreSQL cluster for the integration test."""
    data_dir = tmp_path / "postgres"
    port = _unused_local_port()
    initdb = subprocess.run(
        [
            "initdb",
            "-D",
            str(data_dir),
            "--auth=trust",
            "--no-locale",
            "--encoding=UTF8",
        ],
        check=True,
        capture_output=True,
        text=True,
    )
    assert initdb.returncode == 0
    subprocess.run(
        [
            "pg_ctl",
            "-D",
            str(data_dir),
            "-l",
            str(tmp_path / "postgres.log"),
            "-o",
            f"-p {port} -h 127.0.0.1 -k {data_dir}",
            "-w",
            "start",
        ],
        check=True,
        capture_output=True,
        text=True,
    )
    try:
        yield f"postgresql://{getpass.getuser()}@127.0.0.1:{port}/postgres"
    finally:
        subprocess.run(
            ["pg_ctl", "-D", str(data_dir), "-m", "immediate", "-w", "stop"],
            check=True,
            capture_output=True,
            text=True,
        )


def test_concurrent_retest_completion_has_one_winner(isolated_database_url):
    async def scenario():
        server = importlib.import_module("server")
        isolated_db = PostgresDatabase(isolated_database_url)
        await isolated_db.connect()

        original_db = server.db
        actor = {
            "id": "concurrency-test-user",
            "name": "Concurrency Test User",
            "email": "concurrency-test@example.test",
            "role": "admin",
            "active": True,
        }
        testcase = {
            "id": "concurrency-test-case",
            "name": "Concurrent retest testcase",
        }
        finding = {
            "id": "concurrency-test-finding",
            "testcase_id": testcase["id"],
            "title": "Concurrent retest finding",
            "developer_status": "Ready for Retest",
            "retest_status": "In Progress",
            "status_history": [],
        }
        retest = {
            "id": "concurrency-test-retest",
            "finding_id": finding["id"],
            "testcase_id": testcase["id"],
            "finding_title": finding["title"],
            "status": "In Progress",
            "verdict": None,
            "created_at": "2026-09-01T00:00:00+00:00",
        }
        config = {
            "id": "global",
            "finding_statuses": [
                "New",
                "Confirmed",
                "In Development",
                "Ready for Retest",
                "Fixed",
            ],
        }

        try:
            server.db = isolated_db
            await isolated_db.users.insert_one(actor)
            await isolated_db.testcases.insert_one(testcase)
            await isolated_db.findings.insert_one(finding)
            await isolated_db.retests.insert_one(retest)
            await isolated_db.config.insert_one(config)
            server.app.dependency_overrides[server.require_writer] = lambda: actor

            async with httpx.AsyncClient(
                transport=httpx.ASGITransport(app=server.app),
                base_url="http://isolated.test",
            ) as client:
                responses = await asyncio.gather(
                    client.post(
                        f"/api/retests/{retest['id']}/complete",
                        json={"verdict": "Fixed", "new_response": "winner one", "new_bassett_version": "v2",
                              "new_environment": "Staging", "new_result": "Pass", "new_score": 9,
                              "completed_at": "2026-09-01T01:00:00+00:00", "test_date": "2026-09-01"},
                    ),
                    client.post(
                        f"/api/retests/{retest['id']}/complete",
                        json={"verdict": "Not Fixed", "new_response": "winner two", "new_bassett_version": "v2",
                              "new_environment": "Staging", "new_result": "Fail", "new_score": 1,
                              "completed_at": "2026-09-01T01:00:00+00:00", "test_date": "2026-09-01"},
                    ),
                )

            statuses = sorted(response.status_code for response in responses)
            assert statuses == [200, 409]
            winner_response = next(response for response in responses if response.status_code == 200)
            conflict_response = next(response for response in responses if response.status_code == 409)
            winner = winner_response.json()
            assert conflict_response.json()["detail"] == "Only an In Progress retest can be completed"

            persisted_retest = await isolated_db.retests.find_one({"id": retest["id"]})
            persisted_finding = await isolated_db.findings.find_one({"id": finding["id"]})
            assert persisted_retest["verdict"] == winner["verdict"]
            assert persisted_retest["status"] == "Completed"
            assert persisted_retest["outcome"] == persisted_retest["verdict"]
            expected_finding_status = {
                "Fixed": "Fixed",
                "Not Fixed": "In Development",
            }[persisted_retest["verdict"]]
            assert persisted_finding["developer_status"] == expected_finding_status
            assert persisted_finding["retest_status"] == persisted_retest["verdict"]

            retest_history = [
                entry
                for entry in persisted_finding["status_history"]
                if entry.get("note", "").startswith("Retest verdict:")
            ]
            assert len(retest_history) == 1
            assert retest_history[0]["to"] == persisted_finding["developer_status"]
            assert retest_history[0]["note"] == f"Retest verdict: {persisted_retest['verdict']}"

            activities = await isolated_db.activities.find({}).to_list(20)
            assert len(activities) == 2
            assert {activity["entity_type"] for activity in activities} == {"findings", "testcases"}
            assert {
                activity["action"] for activity in activities
            } == {f"retest completed · {persisted_retest['verdict']}"}
        finally:
            server.app.dependency_overrides.pop(server.require_writer, None)
            server.db = original_db
            await isolated_db.close()

    asyncio.run(scenario())


def test_generic_record_compare_and_swap_has_one_winner(isolated_database_url):
    async def scenario():
        isolated_db = PostgresDatabase(isolated_database_url)
        await isolated_db.connect()
        record = {
            "id": "generic-concurrency-project",
            "name": "Original",
            "revision": 1,
            "updated_at": "2026-09-01T00:00:00+00:00",
        }
        await isolated_db.projects.insert_one(record)

        async def save(name):
            return await isolated_db.projects.find_one_and_update(
                {"id": record["id"], "revision": 1},
                {"$set": {
                    "name": name,
                    "revision": 2,
                    "updated_at": f"2026-09-01T00:00:0{name[-1]}+00:00",
                }},
            )

        first, second = await asyncio.gather(save("Editor 1"), save("Editor 2"))
        assert sum(result is not None for result in (first, second)) == 1
        stored = await isolated_db.projects.find_one({"id": record["id"]})
        assert stored["revision"] == 2
        assert stored["name"] in {"Editor 1", "Editor 2"}
        await isolated_db.close()

    asyncio.run(scenario())


def test_concurrent_bassett_run_submission_creates_one_canonical_record(isolated_database_url):
    async def scenario():
        server = importlib.import_module("server")
        isolated_db = PostgresDatabase(isolated_database_url)
        await isolated_db.connect()
        original_db = server.db
        actor = {
            "id": "bassett-run-user", "name": "Bassett Tester",
            "email": "bassett-run@example.test", "role": "tester", "active": True,
        }
        definition = {
            "id": "bassett-run-scenario", "stable_id": "R-01",
            "workflow_stage": "Research", "report_type": "Property",
            "test_scenario": "Setback research", "complexity": "High",
            "why_it_matters": "Accuracy", "what_bassett_should_do": "Read the ordinance",
            "success_criteria": "Quote the controlling section", "priority": "P1 - High",
            "archived": False,
        }
        body = {
            "submission_id": "one-browser-submission",
            "scenario_id": definition["id"], "question_asked": "What is the setback?",
            "exact_bassett_answer": "Ten feet", "verified_correct_answer": "Twenty feet",
            "result": "Fail", "score": 25, "environment": "Staging", "test_date": "2026-09-01",
        }
        try:
            server.db = isolated_db
            await isolated_db.users.insert_one(actor)
            await isolated_db.bassett_scenarios.insert_one(definition)
            responses = await asyncio.gather(
                server.bassett_create_issue(dict(body), user=actor),
                server.bassett_create_issue(dict(body), user=actor),
            )
            assert responses[0]["id"] == responses[1]["id"]
            assert sorted(response["idempotent_replay"] for response in responses) == [False, True]
            issues = await isolated_db.bassett_issues.find({}).to_list(10)
            executions = await isolated_db.bassett_executions.find({}).to_list(10)
            history = await isolated_db.bassett_history.find({}).to_list(10)
            assert len(issues) == 1
            assert executions == []
            assert len(history) == 2
            assert issues[0]["definition_snapshot"]["stable_id"] == "R-01"
        finally:
            server.db = original_db
            await isolated_db.close()

    asyncio.run(scenario())


def test_bassett_run_creation_loses_cleanly_to_concurrent_archive(isolated_database_url):
    async def scenario():
        server = importlib.import_module("server")
        isolated_db = PostgresDatabase(isolated_database_url)
        await isolated_db.connect()
        original_db = server.db
        actor = {"id": "archive-race-user", "name": "Tester", "role": "tester", "active": True}
        definition = {
            "id": "archive-race-scenario", "stable_id": "R-02",
            "workflow_stage": "Research", "report_type": "Property",
            "test_scenario": "Archive race", "complexity": "High",
            "why_it_matters": "Accuracy", "what_bassett_should_do": "Read the ordinance",
            "success_criteria": "Quote the controlling section", "priority": "P1 - High",
            "archived": False,
        }
        body = {
            "submission_id": "archive-race-submission", "scenario_id": definition["id"],
            "question_asked": "What is allowed?", "exact_bassett_answer": "Answer",
            "verified_correct_answer": "Verified", "result": "Pass", "test_date": "2026-09-01",
        }
        try:
            server.db = isolated_db
            await isolated_db.users.insert_one(actor)
            await isolated_db.bassett_scenarios.insert_one(definition)
            async with isolated_db.pool.acquire() as connection:
                async with connection.transaction():
                    await connection.fetchrow(
                        'SELECT data FROM "bassett_scenarios" WHERE id=$1 FOR UPDATE',
                        definition["id"],
                    )
                    archived = {**definition, "archived": True, "archived_at": "2026-09-01T00:00:00+00:00"}
                    await isolated_db._replace("bassett_scenarios", archived, connection)
                    create_task = asyncio.create_task(
                        server.bassett_create_issue(dict(body), user=actor)
                    )
                    await asyncio.sleep(0.05)
                    assert not create_task.done()
            with pytest.raises(server.HTTPException) as exc:
                await create_task
            assert exc.value.status_code == 400
            assert "archived" in exc.value.detail
            assert await isolated_db.bassett_issues.count_documents({}) == 0
        finally:
            server.db = original_db
            await isolated_db.close()

    asyncio.run(scenario())