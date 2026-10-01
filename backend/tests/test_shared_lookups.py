import asyncio
from types import SimpleNamespace

import pytest
from fastapi import HTTPException
import server
from address_regions import US_REGIONS, CA_REGIONS, full_region, address_fields
from property_identity import normalize_state, normalize_zip


class Config:
    def __init__(self, values):
        self.values = {"id": "global", **values}

    async def find_one(self, *args):
        return dict(self.values)

    async def update_one(self, query, update, **kwargs):
        self.values.update(update["$set"])


def test_admin_workflow_list_drives_both_consumers(monkeypatch):
    monkeypatch.setattr(server, "_application_timezone_name", lambda config=None: "America/Chicago")
    config = Config({})
    monkeypatch.setattr(server, "db", SimpleNamespace(config=config))
    result = asyncio.run(server.update_config(
        {"finding_statuses": server.WORKFLOW_OPTIONS + ["Waiting on information"]},
        {"role": "admin"},
    ))
    assert result["finding_statuses"] == result["bassett_workflow_statuses"]
    assert asyncio.run(server._configured_bassett_issue_statuses())[-1] == "Waiting on information"
    assert asyncio.run(server._configured_finding_statuses())[-1] == "Waiting on information"
    assert server._validate_finding_status("In Review", result["finding_statuses"]) == "Confirmed"
    assert server._validate_finding_status("Needs Investigation", result["finding_statuses"]) == "Needs Investigation"
    assert server._require_retest_target_status("Fixed", result["finding_statuses"]) == "Fixed"


def test_custom_evaluation_results_survive_validation(monkeypatch):
    config = Config({"pass_results": ["Pass", "Awaiting confirmation"]})
    monkeypatch.setattr(server, "db", SimpleNamespace(config=config))
    assert asyncio.run(server._validate_configured_result("Awaiting confirmation")) == "Awaiting confirmation"
    with pytest.raises(HTTPException):
        asyncio.run(server._validate_configured_result("Unknown"))
    allowed = asyncio.run(server._configured_evaluation_results())
    run = {"result": "Awaiting confirmation", "test_type": "Multi-turn", "turns": [
        {"id": "t1", "prompt": "Question", "response": "Answer", "result": "Awaiting confirmation"}
    ]}
    server._validate_bassett_run_result(run, allowed_results=allowed)
    server._normalize_bassett_turns(run, allowed_results=allowed)
    assert run["result"] == run["turns"][0]["result"] == "Awaiting confirmation"


def test_address_names_and_canadian_regions_preserve_identity():
    assert len(US_REGIONS) == 51
    assert len(CA_REGIONS) == 13
    assert full_region("TX") == "Texas"
    assert full_region("ON") == "Ontario"
    assert full_region("Custom region") == "Custom region"
    assert address_fields({"state": "ON"}) == {"state": "Ontario", "country": "Canada"}
    assert address_fields({"state": "TX"}) == {"state": "Texas", "country": "USA"}
    assert normalize_state("Ontario") == normalize_state("ON")
    assert normalize_state("Texas") == normalize_state("TX")
    assert normalize_zip("M5V 3L9") == "M5V3L9"
    assert server._municipality_key("Dallas", "TX") == server._municipality_key("Dallas", "Texas")
