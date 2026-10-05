/**
 * findPriorRungRow / decideRingForNewRow against live Postgres, the SQL as
 * deliverOpsDigest and the ingest route run it. ops-digest-ring.test.js fakes
 * the query builder, so it could not see that the lookback's ORDER BY did not
 * parse: every owner-audience digest failed its bell write and was emailed
 * instead from 2026-09-28 to 2026-10-03.
 */
const SKIP = !process.env.DATABASE_URL;
const maybeDescribe = SKIP ? describe.skip : describe;

maybeDescribe('ops digest ring lookback (live Postgres)', () => {
  let db;
  let trx;
  let digest;
  const alertClass = `ring-db-fixture-${Date.now()}`;

  beforeAll(async () => {
    db = require('../models/db');
    digest = require('../services/ops-digest');
    trx = await db.transaction();
  });
  afterAll(async () => {
    await trx?.rollback();
    await db.destroy();
  });

  const rung = (hoursAgo, metadata) => trx('notifications').insert({
    recipient_type: 'admin', category: 'ops_digest', title: 'Fixture digest',
    metadata: JSON.stringify({ alertClass, rungAt: new Date(Date.now() - hoursAgo * 60 * 60 * 1000).toISOString(), ...metadata }),
  });

  test('the query runs, and the comparison point is the most recent ring of the class', async () => {
    await expect(digest.findPriorRungRow(trx, { alertClass, source: null, key: alertClass })).resolves.toBeUndefined();
    await expect(digest.decideRingForNewRow(trx, { alertClass, source: null, key: alertClass, count: 5 })).resolves.toBe(true);

    await rung(48, { count: 9 });
    await rung(2, { count: 5 });
    await rung(1, { count: 99, quiet: true, feed: 'activity' });
    await rung(1, { count: 99, source: 'ops-crons' });
    await rung(24 * 8, { count: 1 });

    const prior = await digest.findPriorRungRow(trx, { alertClass, source: null, key: alertClass });
    expect(prior.metadata.count).toBe(5);
    await expect(digest.decideRingForNewRow(trx, { alertClass, source: null, key: alertClass, count: 5 })).resolves.toBe(false);
    await expect(digest.decideRingForNewRow(trx, { alertClass, source: null, key: alertClass, count: 6 })).resolves.toBe(true);
  });
});
