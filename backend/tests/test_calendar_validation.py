"""Focused calendar API validation regressions.

These tests exercise the shared CRUD path used by the calendar endpoints.  The
fake store keeps invalid writes entirely in memory, so no product data is
created or changed while testing validation behavior.
"""

import asyncio

import pytest
from fastapi import HTTPException

import server


ACTOR = {"id": "admin-1", "name": "Admin User", "role": "admin"}


class FakeCollection:
    def __init__(self, documents=None):
        self.documents = [dict(document) for document in (documents or [])]

    async def find_one(self, query, *_args, **_kwargs):
        identifier = query.get("id")
        for document in self.documents:
            if identifier is None or document.get("id") == identifier:
                return dict(document)
        return None

    async def insert_one(self, document):
        self.documents.append(dict(document))

    async def find_one_and_update(self, query, update, **_kwargs):
        document = await self.find_one(query)
        if not document:
            return None
        stored = next(item for item in self.documents if item["id"] == document["id"])
        stored.update(update.get("$set", {}))
        return dict(stored)


class FakeDb:
    def __init__(self, events=None):
        self.calendar_events = FakeCollection(events)
        self.activities = FakeCollection()

    def __getitem__(self, collection):
        return getattr(self, collection)


@pytest.mark.parametrize(
    ("payload", "missing"),
    [
        ({}, {"title", "date"}),
        ({"title": "   "}, {"title", "date"}),
        ({"date": "2026-12-15"}, {"title"}),
        ({"title": "Release", "date": "   "}, {"date"}),
    ],
)
def test_invalid_calendar_create_is_rejected_without_inserting(monkeypatch, payload, missing):
    fake_db = FakeDb()
    monkeypatch.setattr(server, "db", fake_db)

    with pytest.raises(HTTPException) as exc:
        asyncio.run(server.crud_create("calendar_events", payload, ACTOR))

    assert exc.value.status_code == 400
    assert missing.issubset(exc.value.detail)
    assert fake_db.calendar_events.documents == []


def test_valid_calendar_create_persists_optional_fields(monkeypatch):
    fake_db = FakeDb()
    monkeypatch.setattr(server, "db", fake_db)

    created = asyncio.run(
        server.crud_create(
            "calendar_events",
            {
                "title": "Release readiness",
                "date": "2026-12-15",
                "event_type": "milestone",
                "notes": "Review checklist",
            },
            ACTOR,
        )
    )

    assert created["title"] == "Release readiness"
    assert created["date"] == "2026-12-15"
    assert created["event_type"] == "milestone"
    assert created["notes"] == "Review checklist"
    assert len(fake_db.calendar_events.documents) == 1


def test_calendar_update_requires_merged_record_to_remain_complete(monkeypatch):
    existing = {
        "id": "event-1",
        "title": "Original title",
        "date": "2026-12-15",
        "event_type": "milestone",
        "revision": 1,
    }
    fake_db = FakeDb([existing])
    monkeypatch.setattr(server, "db", fake_db)

    with pytest.raises(HTTPException) as blank_title:
        asyncio.run(server.crud_update("calendar_events", "event-1", {"title": "   "}, ACTOR))
    assert blank_title.value.status_code == 400
    assert fake_db.calendar_events.documents[0]["title"] == "Original title"

    updated = asyncio.run(
        server.crud_update("calendar_events", "event-1", {"title": "Updated title"}, ACTOR)
    )
    assert updated["title"] == "Updated title"
    assert updated["date"] == "2026-12-15"

    updated = asyncio.run(
        server.crud_update("calendar_events", "event-1", {"date": "2027-01-05"}, ACTOR)
    )
    assert updated["title"] == "Updated title"
    assert updated["date"] == "2027-01-05"

    with pytest.raises(HTTPException) as blank_date:
        asyncio.run(server.crud_update("calendar_events", "event-1", {"date": ""}, ACTOR))
    assert blank_date.value.status_code == 400
    assert fake_db.calendar_events.documents[0]["date"] == "2027-01-05"