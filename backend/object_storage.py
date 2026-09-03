"""Replit App Storage adapter for private ZoneQA attachment bytes."""

import asyncio
import os
from typing import Any, Optional


class ObjectStorageUnavailable(RuntimeError):
    """The Replit App Storage bucket or its managed credentials are unavailable."""


class ObjectNotFound(FileNotFoundError):
    """A requested object does not exist in the configured bucket."""


class ReplitObjectStorage:
    """Async wrapper around Replit's managed App Storage Python client."""

    def __init__(self, bucket_id: Optional[str] = None):
        self._bucket_id = bucket_id
        self._client: Optional[Any] = None

    @property
    def bucket_id(self) -> str:
        bucket_id = (
            self._bucket_id
            or os.environ.get("REPLIT_OBJECT_STORAGE_BUCKET_ID")
            or os.environ.get("DEFAULT_OBJECT_STORAGE_BUCKET_ID")
        )
        if not bucket_id:
            raise ObjectStorageUnavailable(
                "Replit App Storage is not configured. Attach an App Storage bucket to this Repl."
            )
        return bucket_id

    def _storage_client(self) -> Any:
        try:
            from replit.object_storage import Client

            if self._client is None:
                self._client = Client(self.bucket_id)
            return self._client
        except Exception as exc:
            raise ObjectStorageUnavailable(
                "Unable to authenticate with Replit App Storage."
            ) from exc

    def _upload_bytes(self, object_name: str, data: bytes, content_type: str) -> None:
        del content_type  # The managed SDK stores bytes; the app retains MIME type metadata.
        try:
            self._storage_client().upload_from_bytes(object_name, data)
        except Exception as exc:
            raise ObjectStorageUnavailable("Replit App Storage upload failed.") from exc

    async def upload_bytes(self, object_name: str, data: bytes, content_type: str) -> None:
        await asyncio.to_thread(self._upload_bytes, object_name, data, content_type)

    def _download_bytes(self, object_name: str) -> bytes:
        try:
            from replit.object_storage.errors import ObjectNotFoundError
        except Exception as exc:
            raise ObjectStorageUnavailable(
                "Unable to load Replit App Storage dependencies."
            ) from exc
        try:
            return self._storage_client().download_as_bytes(object_name)
        except ObjectNotFoundError as exc:
            raise ObjectNotFound(object_name) from exc
        except Exception as exc:
            raise ObjectStorageUnavailable("Replit App Storage read failed.") from exc

    async def download_bytes(self, object_name: str) -> bytes:
        return await asyncio.to_thread(self._download_bytes, object_name)

    def _delete(self, object_name: str) -> None:
        try:
            self._storage_client().delete(object_name, ignore_not_found=True)
        except Exception as exc:
            raise ObjectStorageUnavailable("Replit App Storage delete failed.") from exc

    async def delete(self, object_name: str) -> None:
        await asyncio.to_thread(self._delete, object_name)

    async def check_configuration(self) -> str:
        """Validate bucket configuration without issuing a storage request."""
        return self.bucket_id


app_storage = ReplitObjectStorage()