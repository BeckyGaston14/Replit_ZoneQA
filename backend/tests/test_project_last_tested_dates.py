"""Pure read-only checks for project Last Tested Date derivation."""

from server import _project_completion, _project_last_tested_dates


def derive(projects=None, testcases=None, test_runs=None, bassett_runs=None, evaluations=None):
    return _project_last_tested_dates(
        projects or [{"id": "p1"}, {"id": "p2"}],
        testcases or [],
        test_runs or [],
        bassett_runs or [],
        evaluations=evaluations or [],
    )


def test_never_tested_project_has_no_invented_date():
    assert derive() == {"p1": None, "p2": None}


def test_latest_explicit_testcase_and_completed_execution_date_wins():
    result = derive(
        testcases=[{"id": "t1", "project_id": "p1", "test_date": "2026-01-02"}],
        test_runs=[
            {"id": "r1", "testcase_id": "t1", "status": "Completed", "test_date": "2026-02-03"},
            {"id": "r2", "testcase_id": "t1", "status": "Failed", "test_date": "2026-12-31"},
        ],
    )
    assert result["p1"] == "2026-02-03"


def test_current_project_assignment_controls_history_without_cross_project_leakage():
    result = derive(
        testcases=[{"id": "t1", "project_id": "p2", "test_date": "2026-03-04"}],
        test_runs=[{"id": "r1", "testcase_id": "t1", "status": "Completed", "test_date": "2026-04-05"}],
        bassett_runs=[
            {"id": "b1", "testcase_id": "t1", "project_id": "p1", "result": "Pass", "test_date": "2026-12-31"},
            {"id": "b2", "testcase_id": "t1", "project_id": "p2", "result": "Pass", "test_date": "2026-05-06"},
        ],
    )
    assert result == {"p1": None, "p2": "2026-05-06"}


def test_archived_or_orphaned_records_and_reusable_definitions_are_excluded():
    result = derive(
        testcases=[
            {"id": "archived", "project_id": "p1", "archived": True, "test_date": "2026-12-31"},
            {"id": "active", "project_id": "p1"},
        ],
        test_runs=[
            {"testcase_id": "missing", "status": "Completed", "test_date": "2026-11-30"},
            {"testcase_id": "archived", "status": "Completed", "test_date": "2026-10-31"},
        ],
        bassett_runs=[
            {"testcase_id": "active", "project_id": None, "result": "Pass", "test_date": "2026-09-30"},
            {"scenario_id": "definition-only", "project_id": "p1", "test_date": "2026-08-31"},
        ],
    )
    assert result["p1"] is None


def test_linked_completed_cases_reach_full_completion_regardless_of_project_size():
    testcases = [
        {"id": f"t{i}", "project_id": "p1", "status": "Evaluated"}
        for i in range(5)
    ]
    testcases += [
        {"id": "archived", "project_id": "p1", "status": "Evaluated", "archived": True},
        {"id": "unlinked", "project_id": "other", "status": "Evaluated"},
    ]

    result = _project_completion(
        {"id": "p1", "completion_mode": "automatic"},
        testcases,
    )

    assert result["completion"] == 100
    assert result["completion_completed"] == 5
    assert result["completion_total"] == 5
    assert "5/5" in result["completion_status"]


def test_explicit_evaluation_date_contributes_to_project_recency():
    result = derive(
        testcases=[{"id": "t1", "project_id": "p1"}],
        evaluations=[{"testcase_id": "t1", "model": "Bassett", "test_date": "2026-08-26"}],
    )
    assert result["p1"] == "2026-08-26"


def test_project_completion_reaches_full_completion_at_ten_cases():
    testcases = [
        {"id": f"t{i}", "project_id": "p1", "status": "Closed"}
        for i in range(10)
    ]

    result = _project_completion(
        {"id": "p1", "completion_mode": "automatic"},
        testcases,
    )

    assert result["completion"] == 100
    assert result["completion_definition"].startswith("Completed active linked")


def test_linked_but_incomplete_cases_do_not_count_toward_completion():
    testcases = [
        {"id": f"done-{i}", "project_id": "p1", "status": "Evaluated"}
        for i in range(4)
    ] + [
        {"id": f"open-{i}", "project_id": "p1", "status": "Testing"}
        for i in range(6)
    ]

    result = _project_completion(
        {"id": "p1", "completion_mode": "automatic"},
        testcases,
    )

    assert result["completion"] == 40
    assert result["completion_completed"] == 4
    assert result["completion_total"] == 10


def test_project_completion_ignores_legacy_value_without_explicit_manual_mode():
    result = _project_completion(
        {"id": "p1", "completion": 73},
        [{"id": "t1", "project_id": "p1", "status": "Evaluated"}],
    )

    assert result["completion"] == 100
    assert result["completion_mode"] == "automatic"
    assert result["completion_source"] == "Linked active test cases"
    assert result["completion_override"] is None


def test_project_completion_preserves_explicit_manual_override():
    result = _project_completion(
        {"id": "p1", "completion_mode": "manual", "completion_override": 73},
        [{"id": "t1", "project_id": "p1", "status": "Evaluated"}],
    )

    assert result["completion"] == 73
    assert result["completion_mode"] == "manual"
    assert result["completion_source"] == "Manual override"
    assert result["completion_override"] == 73


def test_project_completion_has_explicit_empty_automatic_state():
    result = _project_completion(
        {"id": "p1", "completion_mode": "automatic"},
        [],
    )

    assert result["completion"] is None
    assert result["completion_total"] == 0
    assert result["completion_status"] == "No active linked test cases"
