/**
 * Admin alert retention against live Postgres: the batch writer (what it
 * writes, what it leaves, the version fence), the whole sweep in the three gate
 * states, and the undo. The rules themselves are in admin-alert-retention.test.js.
 * Synthetic data only; every fixture row is found by the title prefix below, so
 * the sweep is scoped to them and never touches another suite's rows.
 */
const SKIP = !process.env.DATABASE_URL;
const maybeDescribe = SKIP ? describe.skip : describe;

const DAY = 24 * 60 * 60 * 1000;
const TITLE = 'Retention fixture alert';

maybeDescribe('admin alert retention (live Postgres)', () => {
  let db;
  let retention;
  let NotificationService;
  const made = [];
  const runs = [];
  const now = new Date();
  const ago = (days) => new Date(now.getTime() - days * DAY);

  beforeAll(() => {
    db = require('../models/db');
    retention = require('../services/admin-alert-retention');
    NotificationService = require('../services/notification-service');
  });
  afterAll(async () => {
    if (made.length) await db('notifications').whereIn('id', made).del();
    if (runs.length) await db('audit_log').whereRaw("metadata->>'runId' = ANY(?::text[])", [runs]).del();
    await db.destroy();
  });

  const bell = async (row) => {
    const [r] = await db('notifications').insert({
      recipient_type: 'admin', category: 'alert', title: TITLE, body: 'Fixture body.', ...row,
      metadata: JSON.stringify(row.metadata || {}),
    }).returning('*');
    made.push(r.id);
    return r;
  };
  const get = (id) => db('notifications').where({ id }).first();
  const meta = (r) => (typeof r.metadata === 'string' ? JSON.parse(r.metadata) : r.metadata);
  const version = async (id) => (await db('notifications').where({ id }).first('id', db.raw(`${NotificationService._private.NOTIFICATION_VERSION_SQL} AS version`))).version;

  test('expireBatch marks done: who, why, the run stamp; read state untouched; nothing deleted', async () => {
    const readAt = ago(33);
    const unread = await bell({ created_at: ago(40) });
    const read = await bell({ created_at: ago(40), read_at: readAt });
    const at = new Date(now.getTime() + 1000);
    const rows = [{ id: unread.id, version: await version(unread.id) }, { id: read.id, version: await version(read.id) }];

    const n = await retention.expireBatch(db, rows, 'age30', { runId: 'run-writer', now: at });

    expect(n).toBe(2);
    const a = await get(unread.id);
    const b = await get(read.id);
    expect([a.done_by, a.resolution, a.done_at.getTime()]).toEqual(['retention', 'Expired: no action in 30 days', at.getTime()]);
    expect(a.read_at).toBeNull();
    expect(b.read_at.getTime()).toBe(readAt.getTime());
    expect(meta(a).retention).toEqual({ run: 'run-writer', rule: 'age30', at: at.toISOString() });
    expect(a.created_at.getTime()).toBe(unread.created_at.getTime());
  });

  test('the FYI rule writes its own resolution', async () => {
    const fyi = await bell({ created_at: ago(9), metadata: { severity: 'fyi' } });
    await retention.expireBatch(db, [{ id: fyi.id, version: await version(fyi.id) }], 'fyi7', { runId: 'run-fyi', now });
    expect((await get(fyi.id)).resolution).toBe('FYI expired after 7 days');
  });

  test('a row refreshed since it was judged, a row already done, and a customer row are left alone', async () => {
    const refreshed = await bell({ created_at: ago(40), metadata: { dedupeKey: 'k1' } });
    const judgedVersion = await version(refreshed.id);
    await db('notifications').where({ id: refreshed.id }).update({ body: 'Refreshed by its emitter.' });
    const person = '0b1f6c1e-3c64-4f8e-9d7a-5a2f3e9b1c10';
    const doneAt = ago(2);
    const alreadyDone = await bell({ created_at: ago(40), done_at: doneAt, done_by: person, resolution: 'Called them' });
    const customer = await bell({ created_at: ago(40), recipient_type: 'customer' });

    const n = await retention.expireBatch(db, [
      { id: refreshed.id, version: judgedVersion },
      { id: alreadyDone.id, version: await version(alreadyDone.id) },
      { id: customer.id, version: await version(customer.id) },
    ], 'age30', { runId: 'run-fence', now });

    expect(n).toBe(0);
    expect((await get(refreshed.id)).done_at).toBeNull();
    const kept = await get(alreadyDone.id);
    expect([kept.done_by, kept.resolution]).toEqual([person, 'Called them']);
    expect((await get(customer.id)).done_at).toBeNull();
  });

  test('the sweep: shadow records one audit row and changes nothing; true expires and records; a refreshed row stays', async () => {
    // Fresh fixture set, scoped by a unique title.
    const mk = (over) => bell({ title: TITLE, ...over });
    const old1 = await mk({ created_at: ago(70) });
    const old2 = await mk({ created_at: ago(50), read_at: ago(49) });
    const old3 = await mk({ created_at: ago(32), category: 'billing' });
    const fyi = await mk({ created_at: ago(10), metadata: { severity: 'fyi' } });
    const young = await mk({ created_at: ago(3) });
    const standing = await mk({ created_at: ago(90), metadata: { rungAt: ago(1).toISOString(), dedupeKey: 'standing:1' } });
    const canary = await mk({ created_at: ago(45), metadata: { dedupeKey: 'sms-draft-canary:smsDraftDefault' } });
    const mine = [old1, old2, old3, fyi, young, standing, canary].map((r) => r.id);
    // Rows from earlier tests in this file are done or fenced out already; scope to the unique run.
    const runNow = new Date(now.getTime() + 5000);
    runs.push(runNow.toISOString());
    const onlyMine = (q) => q.whereIn('id', mine);

    const shadow = await retention.runAdminAlertRetention({ now: runNow, mode: 'shadow', scope: onlyMine });
    expect(shadow).toMatchObject({ mode: 'shadow', written: 0, scanned: 6, kept: { refreshed: 1 } });
    expect(shadow.expire.byRule).toEqual({ age30: 4, fyi7: 1 });
    expect(shadow.ringRisk.emitters['sms-draft-canary'].ringsWithoutNewEvent).toBe(1);
    expect((await db('notifications').whereIn('id', mine).whereNotNull('done_at').count('* as c').first()).c).toBe('0');
    const shadowAudit = await db('audit_log').where({ action: 'admin_alert_retention.shadow' }).whereRaw("metadata->>'runId' = ?", [runNow.toISOString()]);
    expect(shadowAudit).toHaveLength(1);
    expect(shadowAudit[0].metadata.expire.total).toBe(5);

    const live = await retention.runAdminAlertRetention({ now: runNow, mode: 'true', scope: onlyMine, batchSize: 2 });
    expect(live).toMatchObject({ mode: 'true', written: 5, batches: 3 });
    const done = await db('notifications').whereIn('id', mine).whereNotNull('done_at').pluck('id');
    expect(done.sort()).toEqual([old1.id, old2.id, old3.id, fyi.id, canary.id].sort());
    expect((await get(young.id)).done_at).toBeNull();
    expect((await get(standing.id)).done_at).toBeNull();
    expect((await get(old2.id)).read_at).not.toBeNull();
    expect(await db('audit_log').where({ action: 'admin_alert_retention.expire' }).whereRaw("metadata->>'runId' = ?", [runNow.toISOString()])).toHaveLength(1);

    // The bell no longer lists what expired; the rows still exist.
    const open = await NotificationService.getAdminNotifications(500, 0, { role: 'admin' });
    const openIds = new Set(open.map((r) => r.id));
    expect(openIds.has(old1.id)).toBe(false);
    expect((await db('notifications').whereIn('id', mine).count('* as c').first()).c).toBe('7');

    // A second run finds nothing more.
    const again = await retention.runAdminAlertRetention({ now: runNow, mode: 'true', scope: onlyMine });
    expect(again.written).toBe(0);
  });

  test('gate off writes nothing and records nothing', async () => {
    const old = await bell({ created_at: ago(80) });
    const out = await retention.runAdminAlertRetention({ now, mode: 'off', scope: (q) => q.where('id', old.id) });
    expect(out).toEqual({ skipped: true, reason: 'gate_off' });
    expect((await get(old.id)).done_at).toBeNull();
  });

  test('undo: dry run changes nothing; execute reopens one run exactly, keeping read state; other closers and runs stay', async () => {
    const readAt = ago(20);
    const a = await bell({ created_at: ago(60) });
    const b = await bell({ created_at: ago(60), read_at: readAt });
    const otherRun = await bell({ created_at: ago(60) });
    const lateCloser = await bell({ created_at: ago(60) });
    const at = new Date(now.getTime() + 9000);
    for (const [r, run] of [[a, 'run-undo'], [b, 'run-undo'], [lateCloser, 'run-undo'], [otherRun, 'run-other']]) {
      await retention.expireBatch(db, [{ id: r.id, version: await version(r.id) }], 'age30', { runId: run, now: at });
    }
    // A later closer takes one over (an emitter's own close).
    await db('notifications').where({ id: lateCloser.id }).update({ done_by: 'episodes', resolution: 'Cleared' });

    const dry = await retention.undoRetentionRun({ run: 'run-undo' });
    expect(dry).toMatchObject({ found: 2, reopened: 0, execute: false });
    expect((await get(a.id)).done_at).not.toBeNull();

    const result = await retention.undoRetentionRun({ run: 'run-undo', execute: true, now });
    expect(result).toMatchObject({ found: 2, reopened: 2, execute: true });
    const ra = await get(a.id);
    const rb = await get(b.id);
    expect([ra.done_at, ra.done_by, ra.resolution]).toEqual([null, null, null]);
    expect(rb.read_at.getTime()).toBe(readAt.getTime());
    expect(ra.read_at).toBeNull();
    expect(meta(ra).retention).toBeUndefined();
    expect(meta(ra).retentionUndone).toEqual({ run: 'run-undo', at: now.toISOString() });
    expect((await get(lateCloser.id)).done_by).toBe('episodes');
    expect((await get(otherRun.id)).done_by).toBe('retention');

    // Idempotent: nothing left to reopen.
    expect(await retention.undoRetentionRun({ run: 'run-undo', execute: true })).toMatchObject({ found: 0, reopened: 0 });
    const listed = await retention.listRetentionRuns();
    expect(listed.find((r) => r.run === 'run-other')).toBeTruthy();
    expect(listed.find((r) => r.run === 'run-undo')).toBeUndefined();
  });
});
