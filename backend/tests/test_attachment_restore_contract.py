import asyncio
from copy import deepcopy

import server


def _matches(document, query):
    return all(document.get(key) == value for key, value in query.items())


class _Cursor:
    def __init__(self, documents):
        self.documents = documents

    async def to_list(self, _limit):
        return deepcopy(self.documents)


class _Collection:
    def __init__(self, documents=None):
        self.documents = [deepcopy(document) for document in (documents or [])]

    def find(self, query, _projection=None):
        return _Cursor([document for document in self.documents if _matches(document, query)])

    async def find_one(self, query, _projection=None):
        return next((deepcopy(document) for document in self.documents if _matches(document, query)), None)

    async def find_one_and_update(self, query, update, **_kwargs):
        for document in self.documents:
            if not _matches(document, query):
                continue
            document.update(update.get("$set", {}))
            for key in update.get("$unset", {}):
                document.pop(key, None)
            return deepcopy(document)
        return None

    async def insert_one(self, document):
        self.documents.append(deepcopy(document))


class _Db:
    def __init__(self):
        self.attachments = _Collection([{
            "id": "attachment-1",
            "entity_type": "finding",
            "entity_id": "finding-1",
            "original_filename": "proof.pdf",
            "is_deleted": False,
        }])
        self.findings = _Collection([{"id": "finding-1", "status": "Open"}])
        self.activities = _Collection()

    def __getitem__(self, name):
        return getattr(self, name)


def test_writer_can_delete_refresh_and_restore_while_viewer_only_sees_active(monkeypatch):
    database = _Db()
    monkeypatch.setattr(server, "db", database)
    writer = {"id": "writer-1", "name": "Writer", "role": "tester"}
    viewer = {"id": "viewer-1", "name": "Viewer", "role": "viewer"}

    async def exercise_contract():
        await server.delete_attachment("attachment-1", user=writer)

        writer_list = await server.list_attachments("finding", "finding-1", user=writer)
        assert len(writer_list) == 1
        deleted = writer_list[0]
        assert deleted["status"] == "deleted"
        assert deleted["is_deleted"] is True
        assert deleted["restore_expires_at"]

        assert await server.list_attachments("finding", "finding-1", user=viewer) == []

        restored = await server.restore_attachment("attachment-1", user=writer)
        assert restored["is_deleted"] is False

        refreshed = await server.list_attachments("finding", "finding-1", user=writer)
        assert len(refreshed) == 1
        assert refreshed[0]["is_deleted"] is False
        assert "restore_expires_at" not in refreshed[0]

    asyncio.run(exercise_contract())