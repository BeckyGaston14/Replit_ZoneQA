import sys
from pathlib import Path

import pytest
from fastapi import HTTPException

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from server import _validate_date_range, _validate_test_date


@pytest.mark.parametrize("value", ["2024-02-29", "2026-09-01"])
def test_valid_test_dates_remain_iso_date_only(value):
    assert _validate_test_date(value) == value


@pytest.mark.parametrize("value", [None, "", "2026-9-1", "09/01/2026", "2025-02-29", "not-a-date"])
def test_invalid_or_missing_new_test_dates_are_rejected(value):
    with pytest.raises(HTTPException) as error:
        _validate_test_date(value)
    assert error.value.status_code == 400


def test_missing_historical_test_date_is_preserved_as_missing():
    assert _validate_test_date(None, required=False) is None


def test_inverted_test_date_range_is_rejected():
    with pytest.raises(HTTPException) as error:
        _validate_date_range("2026-09-02", "2026-09-01")
    assert error.value.status_code == 400
