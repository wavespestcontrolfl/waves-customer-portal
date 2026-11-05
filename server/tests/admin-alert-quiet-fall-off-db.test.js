/**
 * Admin alert quiet fall-off against live Postgres: what falls off, what stays, the gate states, the guarded
 * write, Reopen and its 72-hour hold, a ring bringing a fallen-off alert back, the relevance sweep leaving
 * quiet-72h rows alone, and the undo script's function. Synthetic data only; every fixture row carries the title
 * below and the pass is scoped to it, so it never touches another suite's rows.
 */
const SKIP = !process.env.DATABASE_URL;
const maybeDescribe = SKIP ? describe.skip : describe;

const HOUR = 60 * 60 * 1000;
const TITLE = 'Quiet fall-off fixture alert';

maybeDescribe('admin alert quiet fall-off (live Postgres)', () => {
  let db;
  let fallOff;
  let NotificationService;
  const made = [];
  const fixtures = { customers: [], scheduled_services: [] };
  const now = new Date();
  const ago = (hours, from = now) => new Date(from.getTime() - hours * HOUR);
  const scope = (q) => q.where('title', TITLE);

  beforeAll(() => {
    db = require('../models/db');
    fallOff = require('../services/admin-alert-quiet-fall-off');
    NotificationService = require('../services/notification-service');
  });
  afterAll(async () => {
    await db('notifications').where({ title: TITLE }).del();
    for (const table of ['scheduled_services', 'customers']) {
      if (fixtures[table].length) await db(table).whereIn('id', fixtures[table]).del();
    }
    await db.destroy();
  });
  beforeEach(() => db('notifications').where({ title: TITLE }).del());

  const bell = async (row) => {
    const [r] = await db('notifications').insert({
      recipient_type: 'admin', category: 'alert', title: TITLE, body: 'Fixture body.', created_at: ago(100), ...row,
      metadata: JSON.stringify(row.metadata || {}),
    }).returning('*');
    made.push(r.id);
    return r;
  };
  const get = (id) => db('notifications').where({ id }).first();
  const meta = (r) => (typeof r.metadata === 'string' ? JSON.parse(r.metadata) : r.metadata);
  const run = (mode, extra = {}) => fallOff.runAdminAlertQuietFallOff({ now, mode, scope, ...extra });

  test('a quiet row closes: who, why, read at the close; nothing deleted', async () => {
    const quiet = await bell({});
    const out = await run('true');
    expect(out).toMatchObject({ closed: 1 });
    const row = await get(quiet.id);
    expect([row.done_by, row.resolution, row.done_at.getTime()]).toEqual(['quiet-72h', 'No new activity for 3 days', now.getTime()]);
    expect(row.read_at.getTime()).toBe(now.getTime());
  });

  test('a person\'s earlier read stands', async () => {
    const readAt = ago(90);
    const read = await bell({ read_at: readAt });
    await run('true');
    expect((await get(read.id)).read_at.getTime()).toBe(readAt.getTime());
  });

  test('a recently rung row, a recently bumped created_at, a fresh observedAt and a fresh lastFailureAt stay', async () => {
    const rung = await bell({ metadata: { rungAt: ago(10).toISOString() } });
    const bumped = await bell({ created_at: ago(10) });
    const observed = await bell({ metadata: { observedAt: ago(10).toISOString() } });
    const failed = await bell({ metadata: { lastFailureAt: ago(10).toISOString() } });
    const justUnder = await bell({ metadata: { rungAt: ago(71.9).toISOString() } });
    expect((await run('true')).closed).toBe(0);
    for (const r of [rung, bumped, observed, failed, justUnder]) expect((await get(r.id)).done_at).toBeNull();
  });

  test('an old rungAt does not keep a row; junk and far-future stamps are ignored and never throw', async () => {
    const oldRung = await bell({ metadata: { rungAt: ago(80).toISOString() } });
    const junk = await bell({ metadata: { rungAt: 'not a time', observedAt: '2026-13-99', lastFailureAt: 12 } });
    const future = await bell({ metadata: { rungAt: new Date(now.getTime() + 400 * HOUR).toISOString() } });
    expect((await run('true')).closed).toBe(3);
    for (const r of [oldRung, junk, future]) expect((await get(r.id)).done_by).toBe('quiet-72h');
  });

  test('an Activity-only row and a Claude-queue row are untouched', async () => {
    const activity = await bell({ metadata: { feed: 'activity' } });
    const queued = await bell({ metadata: { claudeQueue: 'idea', who: 'claude', feed: 'activity' } });
    const sentOnly = await bell({ metadata: { sentToClaude: { at: ago(90).toISOString() } } });
    expect((await run('true')).closed).toBe(0);
    for (const r of [activity, queued, sentOnly]) expect((await get(r.id)).done_at).toBeNull();
  });

  test('billing and payment alerts stay until settled; another category falls', async () => {
    const billing = await bell({ category: 'billing' });
    const payment = await bell({ category: 'payment' });
    const other = await bell({ category: 'schedule' });
    expect((await run('true')).closed).toBe(1);
    expect((await get(billing.id)).done_at).toBeNull();
    expect((await get(payment.id)).done_at).toBeNull();
    expect((await get(other.id)).done_by).toBe('quiet-72h');
  });

  test('a row an emitter re-raises by itself stays; one raised only by a new event falls', async () => {
    const periodic = await bell({ metadata: { dedupeKey: 'sms-draft-canary:fixture' } });
    const event = await bell({ metadata: { dedupeKey: 'stock-shortfall:fixture' } });
    await run('true');
    expect((await get(periodic.id)).done_at).toBeNull();
    expect((await get(event.id)).done_by).toBe('quiet-72h');
  });

  test('a row that is already done, and a customer row, are untouched', async () => {
    const person = '0b1f6c1e-3c64-4f8e-9d7a-5a2f3e9b1c10';
    const done = await bell({ done_at: ago(2), done_by: person, resolution: 'Called them' });
    const customer = await bell({ recipient_type: 'customer' });
    expect((await run('true')).closed).toBe(0);
    expect((await get(done.id)).done_by).toBe(person);
    expect((await get(customer.id)).done_at).toBeNull();
  });

  test('gate off and gate shadow write nothing; shadow counts', async () => {
    const quiet = await bell({});
    expect(await run('off')).toEqual({ skipped: true, reason: 'gate_off' });
    expect(await run('shadow')).toMatchObject({ wouldClose: 1, closed: 0, byCategory: { alert: 1 } });
    expect((await get(quiet.id)).done_at).toBeNull();
    expect((await get(quiet.id)).read_at).toBeNull();
  });

  test('the cap per tick leaves the rest for the next tick', async () => {
    for (let i = 0; i < 5; i += 1) await bell({});
    expect((await run('true', { pageSize: 2, cap: 3 })).closed).toBe(3);
    expect((await run('true', { pageSize: 2, cap: 3 })).closed).toBe(2);
  });

  test('the guarded UPDATE does not close a row whose rungAt moved after the read', async () => {
    const rang = await bell({});
    const quiet = await bell({});
    const cutoff = ago(72);
    const candidates = await fallOff.selectCandidates(db, { cutoff, now, cursor: null, limit: 10, scope });
    expect(candidates.map((c) => c.id).sort()).toEqual([rang.id, quiet.id].sort());
    await db('notifications').where({ id: rang.id }).update({ metadata: JSON.stringify({ rungAt: ago(0.01).toISOString() }) });
    const landed = await fallOff.closeBatch(db, candidates.map((c) => c.id), { cutoff, now, scope });
    expect(landed.map((r) => r.id)).toEqual([quiet.id]);
    expect((await get(rang.id)).done_at).toBeNull();
  });

  describe('Reopen', () => {
    const reopen = async (id, at = now) => {
      const { t } = await db('notifications').where({ id }).first(db.raw('done_at::text AS t'));
      return NotificationService.reopenAdminDone(id, { expectedDoneAt: t, now: at });
    };

    test('a quiet-72h row is listed reopenable and a Reopen re-opens it; the rule then waits 72 hours from the Reopen', async () => {
      const quiet = await bell({});
      await run('true');
      const listed = (await NotificationService.getAdminDoneNotifications({ role: 'admin', limit: 200 })).find((r) => r.id === quiet.id);
      expect(listed).toMatchObject({ done_by: 'quiet-72h', reopenable: true });

      expect(await reopen(quiet.id)).toBe('reopened');
      const reopened = await get(quiet.id);
      expect([reopened.done_at, reopened.done_by, reopened.resolution]).toEqual([null, null, null]);
      expect(meta(reopened).quietHoldFrom).toBe(now.toISOString());

      expect((await run('true', { now: ago(-71, now) })).closed).toBe(0);
      expect((await get(quiet.id)).done_at).toBeNull();
      expect((await run('true', { now: ago(-73, now) })).closed).toBe(1);
      expect((await get(quiet.id)).done_by).toBe('quiet-72h');
    });

    test('a system close other than quiet-72h still has no Reopen', async () => {
      const relevance = await bell({ done_at: ago(1), done_by: 'relevance', resolution: 'Moved on' });
      const listed = (await NotificationService.getAdminDoneNotifications({ role: 'admin', limit: 200 })).find((r) => r.id === relevance.id);
      expect(listed.reopenable).toBe(false);
      const token = (await db('notifications').where({ id: relevance.id }).first(db.raw('done_at::text AS t'))).t;
      expect(await NotificationService.reopenAdminDone(relevance.id, { expectedDoneAt: token })).toBe('not_reopenable');
    });

    test('a real close of the subject takes a quiet-72h row over', async () => {
      const quiet = await bell({});
      await run('true');
      const taken = await NotificationService._private.openToCloser(db('notifications').where({ id: quiet.id }), 'dispatch')
        .update(NotificationService._private.doneColumns({ by: 'dispatch', resolution: 'Visit moved', keepExisting: true }));
      expect(taken).toBe(1);
      const row = await get(quiet.id);
      expect([row.done_by, row.resolution]).toEqual(['dispatch', 'Visit moved']);
    });

    test('the undo function reopens only quiet-72h rows closed since the time given, and stamps the hold', async () => {
      const a = await bell({});
      const other = await bell({ done_at: ago(1), done_by: 'relevance', resolution: 'Moved on' });
      await run('true');
      const before = await fallOff.reopenQuietFallOff({ since: ago(1).toISOString(), scope });
      expect(before).toEqual({ found: 1, reopened: 0, byCategory: { alert: 1 } });
      expect((await get(a.id)).done_by).toBe('quiet-72h');
      const late = await fallOff.reopenQuietFallOff({ since: ago(-1).toISOString(), apply: true, scope });
      expect(late.found).toBe(0);
      const applied = await fallOff.reopenQuietFallOff({ since: ago(1).toISOString(), apply: true, now, scope });
      expect(applied).toMatchObject({ found: 1, reopened: 1 });
      expect((await get(a.id)).done_at).toBeNull();
      expect(meta(await get(a.id)).quietHoldFrom).toBe(now.toISOString());
      expect((await get(other.id)).done_by).toBe('relevance');
    });
  });

  describe('a new emission rings a fallen-off alert back', () => {
    const key = 'quiet-fall-off-fixture:a';
    const emit = (body, opts = {}) => NotificationService.notifyAdmin('alert', TITLE, body, {
      dedupeKey: key, refreshOnDedupe: true, ringOnRefresh: () => true, ...opts,
    });

    test('changed content reopens the same row, rings it, and clears the hold stamp', async () => {
      const first = await emit('First text.');
      expect(first?.id).toBeTruthy();
      made.push(first.id);
      await db('notifications').where({ id: first.id }).update({ created_at: ago(100) });
      await run('true');
      expect((await get(first.id)).done_by).toBe('quiet-72h');

      // A Reopen stamps the hold; the alert falls again after another 72 quiet hours.
      const token = (await db('notifications').where({ id: first.id }).first(db.raw('done_at::text AS t'))).t;
      await NotificationService.reopenAdminDone(first.id, { expectedDoneAt: token, now: ago(80) });
      expect(meta(await get(first.id)).quietHoldFrom).toBeTruthy();
      await run('true');
      expect((await get(first.id)).done_by).toBe('quiet-72h');

      const again = await emit('Second text, changed.');
      expect(again).toMatchObject({ id: first.id, refreshed: true, rung: true });
      const row = await get(first.id);
      expect([row.done_at, row.done_by, row.read_at]).toEqual([null, null, null]);
      expect(meta(row).rungAt).toBeTruthy();
      expect(meta(row).quietHoldFrom).toBeUndefined();
      // And the freshly rung row survives the next pass.
      expect((await run('true')).closed).toBe(0);
    });

    test('a dedupeOpenOnly emitter raises a fresh row once the old one fell off', async () => {
      const first = await emit('Open-only text.', { dedupeOpenOnly: true });
      made.push(first.id);
      await db('notifications').where({ id: first.id }).update({ created_at: ago(100) });
      await run('true');
      const second = await emit('Open-only text.', { dedupeOpenOnly: true });
      expect(second.id).not.toBe(first.id);
      expect((await get(second.id)).done_at).toBeNull();
    });
  });

  test('a relevance put-back is news: the row older than 72 hours is not closed again until 72 hours after the put-back', async () => {
    const { etDateString } = require('../utils/datetime-et');
    const relevance = require('../services/admin-alert-relevance');
    const [customer] = await db('customers').insert({ first_name: 'Putback', phone: '+15555557011' }).returning('id');
    fixtures.customers.push(customer.id);
    const [visit] = await db('scheduled_services').insert({
      customer_id: customer.id, scheduled_date: etDateString(ago(72)), service_type: 'General Pest Control', status: 'on_site',
    }).returning('id');
    fixtures.scheduled_services.push(visit.id);
    const retiredAt = ago(1);
    // As the relevance sweep wrote it an hour ago; the alert itself is 4 days old and the visit is stuck again.
    const bellRow = await bell({
      read_at: retiredAt, done_at: retiredAt, done_by: 'relevance', resolution: 'Visit is no longer in progress',
      metadata: {
        dedupeKey: `stale-visit:${visit.id}:putback`, scheduled_service_id: visit.id,
        retired: { by: 'alert-relevance', reason: 'Visit is no longer in progress', at: retiredAt.toISOString() },
      },
    });
    await relevance.runAdminAlertRelevanceSweep({ now });
    const back = await get(bellRow.id);
    expect([back.done_at, back.done_by]).toEqual([null, null]);
    expect(meta(back).retired).toBeUndefined();
    expect(meta(back).quietHoldFrom).toEqual(expect.any(String));

    expect((await run('true', { now: ago(-71, now) })).closed).toBe(0);
    expect((await get(bellRow.id)).done_at).toBeNull();
    expect((await run('true', { now: ago(-73, now) })).closed).toBe(1);
    expect((await get(bellRow.id)).done_by).toBe('quiet-72h');
  });

  test('the relevance sweep does not re-arm or re-judge a quiet-72h row, and the row carries no retired stamp', async () => {
    const quiet = await bell({});
    await run('true');
    const relevance = require('../services/admin-alert-relevance');
    await relevance.runAdminAlertRelevanceSweep({ now });
    const row = await get(quiet.id);
    expect([row.done_by, row.resolution]).toEqual(['quiet-72h', 'No new activity for 3 days']);
    expect(meta(row).retired).toBeUndefined();
  });
});
