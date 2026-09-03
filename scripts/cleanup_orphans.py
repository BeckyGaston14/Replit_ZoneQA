"""Clean orphaned PostgreSQL records created by automated test flows."""
import asyncio
import os
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "backend"))
from postgres_store import PostgresDatabase

async def main():
    db = PostgresDatabase(os.environ["DATABASE_URL"])
    await db.connect()
    tc_ids = {t['id'] async for t in db.testcases.find({}, {'id': 1})}
    for coll in ('evaluations', 'responses', 'annotations', 'claims', 'goldstandards', 'retests'):
        r = await db[coll].delete_many({'testcase_id': {'$nin': list(tc_ids)}})
        if r.deleted_count:
            print(f'{coll}: deleted {r.deleted_count} orphans')
    # activity churn on entities that no longer exist (created by automated test flows)
    n = 0
    finding_ids = {f['id'] async for f in db.findings.find({}, {'id': 1})}
    async for a in db.activities.find({'source': {'$ne': 'automated_test'},
                                       'entity_type': {'$in': ['testcases', 'findings']},
                                       'action': {'$regex': '^(assigned to|unassigned|deleted)'}}):
        pool = tc_ids if a['entity_type'] == 'testcases' else finding_ids
        if a.get('entity_id') not in pool:
            await db.activities.update_one({'id': a['id']}, {'$set': {'source': 'automated_test'}})
            n += 1
    print(f'orphan-entity activities tagged automated: {n}')
    await db.close()

asyncio.run(main())
