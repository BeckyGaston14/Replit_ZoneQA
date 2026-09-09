import pytest
from fastapi import HTTPException

import server
from general_subtypes import GENERAL_TEST_SUBTYPES


def test_general_subtypes_are_stable_secondary_classifications():
    assert len(GENERAL_TEST_SUBTYPES) == 20
    assert [item["id"] for item in GENERAL_TEST_SUBTYPES] == [f"G-{number:02d}" for number in range(1, 21)]
    assert all("test_type" not in item for item in GENERAL_TEST_SUBTYPES)
    assert all("workflow_stage" not in item for item in GENERAL_TEST_SUBTYPES)


def test_general_subtype_ids_are_normalized_without_duplicates():
    assert server._normalize_general_subtype_ids(["g-02", "G-01", "G-02", ""]) == ["G-02", "G-01"]


def test_unknown_general_subtype_is_rejected():
    with pytest.raises(HTTPException) as error:
        server._normalize_general_subtype_ids(["G-99"])
    assert error.value.status_code == 400
