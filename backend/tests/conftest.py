import pytest
import requests
from .live_auth import base_url as configured_base_url, login_headers

BASE_URL = configured_base_url()


@pytest.fixture(scope="session")
def api_client():
    s = requests.Session()
    s.headers.update({"Content-Type": "application/json"})
    return s


@pytest.fixture(scope="session")
def auth_client():
    s = requests.Session()
    s.headers.update(login_headers(BASE_URL, "admin"))
    return s


@pytest.fixture(scope="session")
def base_url():
    return BASE_URL
