#!/usr/bin/env python3
"""Run the narrow, idempotent sample-data integrity repair batch once."""

import asyncio
import json
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "backend"))

from integrity_repairs import repair_integrity_batch
from postgres_store import PostgresDatabase


async def main():
    database = PostgresDatabase(os.environ["DATABASE_URL"])
    await database.connect()
    try:
        report = await repair_integrity_batch(database)
        print(json.dumps(report, indent=2, sort_keys=True))
    finally:
        await database.close()


if __name__ == "__main__":
    asyncio.run(main())