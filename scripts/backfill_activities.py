"""Restore activity events backfill for existing testcase records.
Recreates activities for responses, evaluations, findings, retests, golds.
"""
import asyncio
import os
import sys
import uuid
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "backend"))
from postgres_store import PostgresDatabase

async def main():
    db = PostgresDatabase(os.environ["DATABASE_URL"])
    await db.connect()
    inserted = 0

    def make(entity_type, entity_id, action, user, detail, created_at):
        return {
            "id": str(uuid.uuid4()),
            "entity_type": entity_type,
            "entity_id": entity_id,
            "action": action,
            "user": user or "System backfill",
            "detail": detail or "",
            "created_at": created_at,
            "_log": True,
        }

    async def insert(doc):
        nonlocal inserted
        existing = await db.activities.find_one({
            "entity_type": doc["entity_type"], "entity_id": doc["entity_id"],
            "action": doc["action"], "detail": doc["detail"], "created_at": doc["created_at"],
        })
        if existing:
            return
        await db.activities.insert_one(doc)
        inserted += 1

    # Responses
    async for r in db.responses.find({}, {"_id": 0}):
        tc = r.get("testcase_id")
        if not tc:
            continue
        detail = f"{r.get('model','')} turn {r.get('turn',1)}"
        await insert(make("testcases", tc, "response captured", "System backfill",
                          detail, r.get("created_at") or "2026-08-10T20:27:00+00:00"))

    # Evaluations
    async for e in db.evaluations.find({}, {"_id": 0}):
        tc = e.get("testcase_id")
        if not tc:
            continue
        detail = f"{e.get('model','')} {e.get('final_result','')}"
        await insert(make("testcases", tc, "evaluation completed", "System backfill",
                          detail.strip(), e.get("created_at") or "2026-08-10T20:27:00+00:00"))

    # Findings
    async for f in db.findings.find({}, {"_id": 0}):
        tc = f.get("testcase_id")
        if not tc:
            continue
        detail = f.get("title", "")
        await insert(make("testcases", tc, "finding created", "System backfill",
                          detail, f.get("created_at") or "2026-08-10T20:27:00+00:00"))

    # Retests
    async for rt in db.retests.find({}, {"_id": 0}):
        tc = rt.get("testcase_id")
        if not tc:
            continue
        detail = rt.get("finding_title", "")
        await insert(make("testcases", tc, "retest recorded", "System backfill",
                          detail, rt.get("created_at") or "2026-08-10T20:27:00+00:00"))

    # Gold standards
    async for g in db.goldstandards.find({}, {"_id": 0}):
        tc = g.get("testcase_id")
        if not tc:
            continue
        detail = f"status: {g.get('review_status','')}"
        await insert(make("testcases", tc, "gold standard recorded", "System backfill",
                          detail, g.get("created_at") or "2026-08-10T20:27:00+00:00"))

    print(f"Inserted {inserted} activity events")
    await db.close()

asyncio.run(main())
