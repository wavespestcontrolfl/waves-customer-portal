/**
 * supersedeOlderDigests against live Postgres: the SQL a digest sender runs
 * after its row lands. A new owner-visible row closes every older OPEN row of
 * the same key; a quiet row never takes the slot from a standing bell row;
 * rows of other keys, ops-crons rows and rows a person closed stay as they
 * were. The unit shape of the callers is in unworked-comms-watcher.test.js and
 * parked-run-digest.test.js.
 */
const SKIP = !process.env.DATABASE_URL;
const maybeDescribe = SKIP ? describe.skip : describe;

maybeDescribe('ops digest supersede (live Postgres)', () => {
  let db;
  let trx;
  let digest;
  const key = `supersede-db-fixture-${Date.now()}`;

  beforeAll(async () => {
    db = require('../models/db');
    digest = require('../services/ops-digest');
  });
  beforeEach(async () => { trx = await db.transaction(); });
  afterEach(async () => { await trx.rollback(); });
  afterAll(async () => { await db.destroy(); });

  const add = async (hoursAgo, metadata = {}, cols = {}) => {
    const [row] = await trx('notifications').insert({
      recipient_type: 'admin', category: 'ops_digest', title: 'Fixture digest',
      created_at: new Date(Date.now() - hoursAgo * 60 * 60 * 1000),
      metadata: JSON.stringify({ opsKey: key, ...metadata }), ...cols,
    }).returning('*');
    return row;
  };
  const state = async () => {
    const rows = await trx('notifications').whereRaw("metadata->>'opsKey' = ?", [key]).orderBy('created_at', 'asc');
    return rows.map((r) => ({ id: r.id, open: r.done_at === null, by: r.done_by, resolution: r.resolution, meta: r.metadata }));
  };

  test('a new visible row closes the older open copies and names the producer', async () => {
    const oldest = await add(72, { dedupeKey: 'legacy' });
    const older = await add(48);
    const fresh = await add(0);
    expect(await digest.supersedeOlderDigests({ key, row: fresh, conn: trx, enabled: true })).toBe(2);

    const rows = await state();
    expect(rows.filter((r) => r.open).map((r) => r.id)).toEqual([fresh.id]);
    const closed = rows.filter((r) => !r.open);
    expect(closed.map((r) => r.id).sort()).toEqual([oldest.id, older.id].sort());
    for (const r of closed) {
      expect(r.by).toBe(key);
      expect(r.resolution).toMatch(/^Replaced by a newer digest/);
      expect(r.meta).toMatchObject({ resolved: true, resolvedBy: key, supersededBy: String(fresh.id) });
      expect(r.meta.dedupeKey).toBeUndefined();
    }
  });

  test('a sender that did not opt in closes nothing', async () => {
    await add(48);
    const fresh = await add(0);
    expect(await digest.supersedeOlderDigests({ key, row: fresh, conn: trx })).toBe(0);
    expect((await state()).filter((r) => r.open)).toHaveLength(2);
  });

  test('a second run closes nothing more', async () => {
    await add(48);
    const fresh = await add(0);
    await digest.supersedeOlderDigests({ key, row: fresh, conn: trx, enabled: true });
    expect(await digest.supersedeOlderDigests({ key, row: fresh, conn: trx, enabled: true })).toBe(0);
  });

  test('a quiet row closes itself and leaves the standing bell row open', async () => {
    const standing = await add(24, { rungAt: new Date().toISOString() });
    const quiet = await add(0, { quiet: true, feed: 'activity' });
    await add(48, { quiet: true, feed: 'activity' });
    await digest.supersedeOlderDigests({ key, row: quiet, conn: trx, enabled: true });
    expect((await state()).filter((r) => r.open).map((r) => r.id)).toEqual([standing.id]);
  });

  test('leaves other keys, ops-crons rows and rows a person closed alone', async () => {
    const other = await add(48, { opsKey: `${key}-other` });
    const cron = await add(48, { source: 'ops-crons' });
    const personDone = await add(48, {}, { done_at: new Date(), done_by: '42', resolution: 'Handled' });
    const fresh = await add(0);
    await digest.supersedeOlderDigests({ key, row: fresh, conn: trx, enabled: true });
    const after = await trx('notifications').whereIn('id', [other.id, cron.id, personDone.id]).select('id', 'done_at', 'done_by', 'resolution');
    const byId = new Map(after.map((r) => [r.id, r]));
    expect(byId.get(other.id).done_at).toBeNull();
    expect(byId.get(cron.id).done_at).toBeNull();
    expect(byId.get(personDone.id)).toMatchObject({ done_by: '42', resolution: 'Handled' });
  });
});
