from pathlib import Path


SERVER_SOURCE = Path(__file__).resolve().parents[1] / "server.py"


def test_backend_server_source_is_complete_and_contains_current_features():
    source = SERVER_SOURCE.read_text(encoding="utf-8")

    assert "Warning: truncated output" not in source
    assert len(source.splitlines()) >= 7000
    compile(source, str(SERVER_SOURCE), "exec")

    for required_source in (
        '@api.post("/sample-data")',
        'if user["role"] != "admin":',
        "async def dashboard_stats",
        "async def metrics_summary",
        "from gmail_sender import",
        '"models": "models"',
        "def _normalize_model",
    ):
        assert required_source in source