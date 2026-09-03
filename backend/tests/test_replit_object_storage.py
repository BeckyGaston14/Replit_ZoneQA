import asyncio

import pytest

from object_storage import ObjectStorageUnavailable, ReplitObjectStorage
from replit.object_storage.errors import ObjectNotFoundError


class FakeStorageClient:
    def __init__(self):
        self.objects = {}

    def upload_from_bytes(self, name, data):
        self.objects[name] = data

    def download_as_bytes(self, name):
        if name not in self.objects:
            raise ObjectNotFoundError("missing")
        return self.objects[name]

    def delete(self, name, ignore_not_found=False):
        if name not in self.objects and not ignore_not_found:
            raise ObjectNotFoundError("missing")
        self.objects.pop(name, None)


def test_missing_bucket_configuration_fails_explicitly(monkeypatch):
    monkeypatch.delenv("REPLIT_OBJECT_STORAGE_BUCKET_ID", raising=False)
    monkeypatch.delenv("DEFAULT_OBJECT_STORAGE_BUCKET_ID", raising=False)

    with pytest.raises(ObjectStorageUnavailable, match="not configured"):
        ReplitObjectStorage().bucket_id


def test_upload_download_and_missing_object(monkeypatch):
    client = FakeStorageClient()
    storage = ReplitObjectStorage("test-bucket")
    monkeypatch.setattr(storage, "_storage_client", lambda: client)

    asyncio.run(storage.upload_bytes("uploads/finding/test.txt", b"attachment", "text/plain"))
    assert asyncio.run(storage.download_bytes("uploads/finding/test.txt")) == b"attachment"

    asyncio.run(storage.delete("uploads/finding/test.txt"))
    with pytest.raises(FileNotFoundError):
        asyncio.run(storage.download_bytes("uploads/finding/test.txt"))