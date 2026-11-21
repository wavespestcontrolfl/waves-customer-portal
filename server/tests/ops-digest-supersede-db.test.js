/**
 * supersedeOlderDigests against live Postgres: the SQL a digest sender runs
 * after its row lands. A new owner-visible row closes every older OPEN row of
 * the same key; a quiet row never takes the slot from a standing bell row;
 * rows of other keys, ops-crons rows and rows a person closed stay as they
 * were. With whereMeta, only rows whose metadata contains it close. The unit shape of the callers is in unworked-comms-watcher.test.js and
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

  // hoursAgo 0 leaves created_at to the column default (now(), microseconds),
  // as production inserts do; a JS Date would only carry milliseconds.
  const add = async (hoursAgo, metadata = {}, cols = {}) => {
    const [row] = await trx('notifications').insert({
      recipient_type: 'admin', category: 'ops_digest', title: 'Fixture digest',
      ...(hoursAgo ? { created_at: new Date(Date.now() - hoursAgo * 60 * 60 * 1000) } : {}),
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

  test('leaves other keys, ops-crons rows and rows a system closer already closed alone', async () => {
    const other = await add(48, { opsKey: `${key}-other` });
    const cron = await add(48, { source: 'ops-crons' });
    const systemDone = await add(48, {}, { done_at: new Date(), done_by: 'relevance', resolution: 'Cleared earlier' });
    const fresh = await add(0);
    await digest.supersedeOlderDigests({ key, row: fresh, conn: trx, enabled: true });
    const after = await trx('notifications').whereIn('id', [other.id, cron.id, systemDone.id]).select('id', 'done_at', 'done_by', 'resolution');
    const byId = new Map(after.map((r) => [r.id, r]));
    expect(byId.get(other.id).done_at).toBeNull();
    expect(byId.get(cron.id).done_at).toBeNull();
    expect(byId.get(systemDone.id)).toMatchObject({ done_by: 'relevance', resolution: 'Cleared earlier' });
  });

  // The lead-to-cash sweep (owner 2026-11-20): a new alert replaces only the older alerts stamped as standing-state
  // only. An alert that records a moving-window failure (a failed closeout), and one written before the stamp existed, stay open.
  test('whereMeta closes only the older rows whose metadata contains it', async () => {
    const replaceable = await add(72, { standingOnly: true });
    const windowRecord = await add(48, { standingOnly: false });
    const legacy = await add(24);
    const fresh = await add(0, { standingOnly: true });
    expect(await digest.supersedeOlderDigests({ key, row: fresh, conn: trx, enabled: true, whereMeta: { standingOnly: true } })).toBe(1);

    const rows = await state();
    expect(rows.filter((r) => r.open).map((r) => r.id).sort()).toEqual([windowRecord.id, legacy.id, fresh.id].sort());
    expect(rows.find((r) => r.id === replaceable.id)).toMatchObject({ open: false, by: key });
  });

  // resolveOpsDigest runs on the pool, not on a caller transaction, so these rows are written for real and removed after.
  test('resolveOpsDigest whereMeta retires only the rows whose metadata contains it', async () => {
    const cleanKey = `${key}-clean-run`;
    const insert = async (metadata) => (await db('notifications').insert({
      recipient_type: 'admin', category: 'ops_digest', title: 'Fixture digest', metadata: JSON.stringify({ opsKey: cleanKey, ...metadata }),
    }).returning('*'))[0];
    try {
      const replaceable = await insert({ standingOnly: true });
      const windowRecord = await insert({ standingOnly: false });
      const legacy = await insert({});
      expect(await digest.resolveOpsDigest({ key: cleanKey, source: null, resolvedBy: `${cleanKey}:clean-run`, whereMeta: { standingOnly: true } })).toBe(1);
      const after = await db('notifications').whereRaw("metadata->>'opsKey' = ?", [cleanKey]).select('id', 'done_at', 'metadata');
      const byId = new Map(after.map((r) => [r.id, r]));
      expect(byId.get(replaceable.id).done_at).not.toBeNull();
      expect(byId.get(replaceable.id).metadata).toMatchObject({ resolved: true, resolvedBy: `${cleanKey}:clean-run` });
      expect(byId.get(windowRecord.id).done_at).toBeNull();
      expect(byId.get(legacy.id).done_at).toBeNull();
    } finally {
      await db('notifications').whereRaw("metadata->>'opsKey' = ?", [cleanKey]).del();
    }
  });

  test('an older row a person closed is taken over: stays Done, keeps their resolution, and a stale Reopen is refused', async () => {
    const NotificationService = require('../services/notification-service');
    const doneAt = new Date(Date.now() - 6 * 60 * 60 * 1000);
    const personDone = await add(48, {}, { done_at: doneAt, done_by: '42', resolution: 'Handled' });
    const fresh = await add(0);
    expect(await digest.supersedeOlderDigests({ key, row: fresh, conn: trx, enabled: true })).toBe(1);

    const [row] = await trx('notifications').where({ id: personDone.id });
    expect(row.done_at.getTime()).toBe(doneAt.getTime());
    expect(row.resolution).toBe('Handled');
    expect(row.done_by).toBe(key);
    expect(row.metadata).toMatchObject({ resolved: true, supersededBy: String(fresh.id) });
    await expect(NotificationService.reopenAdminDone(personDone.id, { expectedDoneAt: doneAt.toISOString() }, trx)).resolves.toBe('not_reopenable');
    expect((await trx('notifications').where({ id: personDone.id }).first('done_at')).done_at).not.toBeNull();
    // a second run writes nothing more
    expect(await digest.supersedeOlderDigests({ key, row: fresh, conn: trx, enabled: true })).toBe(0);
  });
});
