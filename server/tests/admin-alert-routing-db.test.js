/**
 * Claude's queue routing against live Postgres (GATE_ALERT_CLAUDE_QUEUE): a routed row is written
 * Activity-only and stamped for Claude, stays off the bell through refreshes (a refresh never
 * rings it back), `needs-me --who claude` lists it, and the one-time mover stamps only the rows
 * the routing table matches. The routing rules themselves are in admin-alert-routing.test.js.
 * The mover runs inside a rolled-back transaction so it never touches another suite's rows.
 */
const SKIP = !process.env.DATABASE_URL;
const maybeDescribe = SKIP ? describe.skip : describe;

maybeDescribe('claude queue routing (live Postgres)', () => {
  let db;
  let NotificationService;
  let routing;
  const RUN = `claude-queue-test-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
  const key = (name) => `${RUN}:${name}`;
  const get = (id) => db('notifications').where({ id }).first();
  // This run's rows that the bell list would show (named keys only: tests share the run prefix).
  const bellRows = (...names) => NotificationService._private.excludeActivityOnlyFromBell(
    db('notifications').where({ recipient_type: 'admin' }).whereRaw("metadata->>'dedupeKey' = ANY(?)", [names.map(key)]));

  beforeAll(() => {
    db = require('../models/db');
    NotificationService = require('../services/notification-service');
    routing = require('../services/admin-alert-routing');
  });
  beforeEach(() => { process.env.GATE_ALERT_CLAUDE_QUEUE = 'true'; });
  afterAll(async () => {
    delete process.env.GATE_ALERT_CLAUDE_QUEUE;
    await db('notifications').whereRaw("starts_with(metadata->>'dedupeKey', ?)", [RUN]).del();
    await db.destroy();
  });

  // A canary-shaped fault and a Mac reminder row, written the way their emitters write them.
  const fault = (name, over = {}, body = 'Fixture body.') => NotificationService.notifyAdmin('review', 'Google review sync degraded for Venice', body, {
    link: '/admin/reviews', bell: true, dedupeKey: key(name), metadata: { reason: 'gbp_sync_degraded', cause: 'no_client' }, ...over,
  });
  const macRow = (name, meta = {}, opts = {}) => NotificationService.notifyAdmin('system', 'PR #6407 is live: flip its gate', 'Fixture body.', {
    link: '/admin', bell: true, dedupeKey: key(name), metadata: { opsJob: `${RUN}-job`, opsKind: 'ask', ...meta }, ...opts,
  });

  test('a fault and a Mac reminder are written Activity-only for Claude and never reach the bell list', async () => {
    const f = await fault('fault-1');
    const m = await macRow('mac-1');
    for (const [row, severity, className] of [[f, 'broken', 'gbp-sync-degraded'], [m, 'needs-you', 'ops-job']]) {
      const stored = await get(row.id);
      expect(stored.metadata).toMatchObject({ feed: 'activity', who: 'claude', severity, claudeQueue: className });
    }
    expect(await bellRows('fault-1', 'mac-1')).toHaveLength(0);
  });

  test('an owner ask stays in the bell', async () => {
    const ask = await macRow('mac-owner-ask', { opsWho: 'person' });
    expect((await get(ask.id)).metadata.feed).toBeUndefined();
    expect((await bellRows('mac-owner-ask')).map((r) => r.id)).toContain(ask.id);
  });

  test('gate off: the same fault lands in the bell as before', async () => {
    delete process.env.GATE_ALERT_CLAUDE_QUEUE;
    const f = await fault('fault-gate-off');
    const stored = await get(f.id);
    expect(stored.metadata.feed).toBeUndefined();
    expect(stored.metadata.who).toBeUndefined();
  });

  test('a refresh of a routed row stays off the bell and never un-reads or reopens it', async () => {
    const opts = { refreshOnDedupe: true, ringOnRefresh: () => false };
    const first = await fault('refresh-quiet', opts);
    await db('notifications').where({ id: first.id }).update({ read_at: db.fn.now() });
    const again = await fault('refresh-quiet', { ...opts, metadata: { reason: 'gbp_sync_degraded', cause: 'token_revoked' } }, 'Changed body.');
    expect(again.id).toBe(first.id);
    const stored = await get(first.id);
    expect(stored.metadata).toMatchObject({ cause: 'token_revoked', feed: 'activity', who: 'claude' });
    expect(stored.read_at).not.toBeNull();
    expect(stored.done_at).toBeNull();
  });

  test('a refresh that rings (the default) still leaves a routed row off the bell', async () => {
    const opts = { refreshOnDedupe: true };
    const first = await fault('refresh-ring', opts);
    await db('notifications').where({ id: first.id }).update({ read_at: db.fn.now() });
    const again = await fault('refresh-ring', { ...opts, metadata: { reason: 'gbp_sync_degraded', cause: 'changed' } }, 'Changed body.');
    expect(again).toMatchObject({ id: first.id, refreshed: true, rung: true });
    const stored = await get(first.id);
    expect(stored.metadata.feed).toBe('activity');
    expect(stored.read_at).toBeNull(); // a ringing refresh reopens it in Claude's queue
    expect(await bellRows('refresh-ring')).toHaveLength(0);
  });

  test('a row already in the bell (written before the gate) moves off it on a quiet refresh, without a ring', async () => {
    delete process.env.GATE_ALERT_CLAUDE_QUEUE;
    const old = await fault('old-bell-row', { refreshOnDedupe: true, ringOnRefresh: () => false });
    await db('notifications').where({ id: old.id }).update({ read_at: db.fn.now() });
    process.env.GATE_ALERT_CLAUDE_QUEUE = 'true';
    await fault('old-bell-row', { refreshOnDedupe: true, ringOnRefresh: () => false, metadata: { reason: 'gbp_sync_degraded', cause: 'new cause' } }, 'Changed body.');
    const stored = await get(old.id);
    expect(stored.metadata).toMatchObject({ feed: 'activity', who: 'claude' });
    expect(stored.read_at).not.toBeNull();
  });

  test('Claude to person: a queued reminder refreshed as an owner ask returns to the bell and rings', async () => {
    const opts = { refreshOnDedupe: true };
    const first = await macRow('to-person', { opsKind: 'ask' }, opts);
    expect((await get(first.id)).metadata).toMatchObject({ feed: 'activity', who: 'claude', claudeQueue: 'ops-job' });
    await db('notifications').where({ id: first.id }).update({ read_at: db.fn.now() });
    // Same text, only the assignment changed: it must not be swallowed as an identical repeat.
    const again = await macRow('to-person', { opsKind: 'ask', opsWho: 'person' }, opts);
    expect(again).toMatchObject({ id: first.id, refreshed: true, rung: true });
    const stored = await get(first.id);
    for (const gone of ['feed', 'who', 'severity', 'claudeQueue']) expect(stored.metadata).not.toHaveProperty(gone);
    expect(stored.metadata.opsWho).toBe('person');
    expect(stored.read_at).toBeNull();
    expect((await bellRows('to-person')).map((r) => r.id)).toEqual([first.id]);
  });

  test('Claude to person with the gate off at refresh time (rollback) also returns the row to the bell', async () => {
    const opts = { refreshOnDedupe: true };
    const first = await macRow('to-bell-gate-off', {}, opts);
    delete process.env.GATE_ALERT_CLAUDE_QUEUE;
    await macRow('to-bell-gate-off', {}, opts);
    expect((await bellRows('to-bell-gate-off')).map((r) => r.id)).toEqual([first.id]);
    expect((await get(first.id)).metadata).not.toHaveProperty('claudeQueue');
  });

  test('person to Claude still moves a bell row off the bell; an identical routed repeat is a plain dedupe', async () => {
    const opts = { refreshOnDedupe: true };
    const first = await macRow('to-claude', { opsWho: 'person' }, opts);
    expect((await bellRows('to-claude'))).toHaveLength(1);
    const moved = await macRow('to-claude', {}, opts);
    expect(moved).toMatchObject({ id: first.id, refreshed: true });
    expect((await get(first.id)).metadata).toMatchObject({ feed: 'activity', who: 'claude', claudeQueue: 'ops-job' });
    expect(await bellRows('to-claude')).toHaveLength(0);
    const repeat = await macRow('to-claude', {}, opts);
    expect(repeat.refreshed).toBeUndefined();
    expect(repeat).toMatchObject({ id: first.id, deduped: true });
  });

  test('a feed the emitter set itself is not cleared by a later refresh of a never-routed row', async () => {
    const opts = { refreshOnDedupe: true, ringOnRefresh: () => false };
    const row = await NotificationService.notifyAdmin('system', 'Own feed row', 'Body.', {
      link: '/admin', bell: true, dedupeKey: key('own-feed'), metadata: { feed: 'activity', who: 'person' }, ...opts,
    });
    await NotificationService.notifyAdmin('system', 'Own feed row', 'Changed body.', {
      link: '/admin', bell: true, dedupeKey: key('own-feed'), metadata: { feed: 'activity', who: 'person' }, ...opts,
    });
    expect((await get(row.id)).metadata).toMatchObject({ feed: 'activity', who: 'person' });
  });

  test('needs-me lists the routed rows under who=claude and none under who=person', async () => {
    const f = await fault('needs-me-fault');
    const { listNeedsMe } = require('../services/needs-me');
    const claude = await listNeedsMe({ who: 'claude', limit: 500 });
    expect(claude.items.find((i) => i.id === f.id)).toMatchObject({ who: 'claude', severity: 'broken', activityOnly: true });
    const person = await listNeedsMe({ who: 'person', limit: 500 });
    expect(person.items.find((i) => i.id === f.id)).toBeUndefined();
  }, 30000);

  test('the Activity feed loads routed rows (a needs-you ask and an fyi), and not an ordinary bell row', async () => {
    process.env.GATE_AGENT_ACTIVITY = 'true';
    const { getActivity } = require('../services/agent-activity');
    const ask = await macRow('feed-ask');
    const fyi = await macRow('feed-fyi', { opsKind: 'fyi' });
    const ownerAsk = await macRow('feed-owner-ask', { opsWho: 'person' });
    delete process.env.GATE_ALERT_CLAUDE_QUEUE;
    const plain = await NotificationService.notifyAdmin('system', 'Plain bell row', 'Body.', { link: '/admin', bell: true, dedupeKey: key('feed-plain') });
    process.env.GATE_ALERT_CLAUDE_QUEUE = 'true';
    try {
      const feed = await getActivity({ windowHours: 24 });
      const ids = feed.items.map((i) => i.notificationId);
      expect(ids).toEqual(expect.arrayContaining([ask.id, fyi.id]));
      expect(ids).not.toContain(plain.id);
      expect(ids).not.toContain(ownerAsk.id);
      expect(feed.items.find((i) => i.notificationId === ask.id)).toMatchObject({ agent: "Claude's queue", status: 'awaiting_review', link: '/admin' });
      expect(feed.items.find((i) => i.notificationId === fyi.id)).toMatchObject({ agent: "Claude's queue", status: 'completed' });
      // An old open routed row still shows, and the focus id finds a done one outside the window.
      await db('notifications').where({ id: ask.id }).update({ created_at: new Date('2026-01-01T00:00:00Z') });
      await db('notifications').where({ id: fyi.id }).update({ created_at: new Date('2026-01-01T00:00:00Z'), done_at: new Date('2026-01-02T00:00:00Z'), done_by: 'ops-bells' });
      const old = await getActivity({ windowHours: 24 });
      expect(old.items.map((i) => i.notificationId)).toContain(ask.id);
      expect(old.items.map((i) => i.notificationId)).not.toContain(fyi.id);
      const focused = await getActivity({ windowHours: 24, focus: fyi.id });
      expect(focused.items.map((i) => i.notificationId)).toContain(fyi.id);
    } finally {
      delete process.env.GATE_AGENT_ACTIVITY;
    }
  });

  describe('the one-time mover', () => {
    const insert = (trx, name, over) => trx('notifications').insert({
      recipient_type: 'admin', category: 'system', title: `Fixture ${name}`, body: 'Fixture body', link: '/admin',
      metadata: JSON.stringify({ dedupeKey: key(name), ...over.metadata }), ...over.row,
    }).returning('*').then(([r]) => r);

    test('stamps matching open rows only; dry run writes nothing; read and done state are left alone', async () => {
      const ROLLBACK = new Error('rollback');
      await expect(db.transaction(async (trx) => {
        const canary = await insert(trx, 'canary', { metadata: { dedupeKey: `sms-draft-canary:${RUN}` }, row: { read_at: new Date('2026-10-20T00:00:00Z') } });
        const mac = await insert(trx, 'mac', { metadata: { opsJob: 'tech-tips', opsKind: 'fyi' } });
        const ownerAsk = await insert(trx, 'owner-ask', { metadata: { opsJob: 'gate-flip', opsKind: 'ask', opsWho: 'person' } });
        const plain = await insert(trx, 'plain', { metadata: {} });
        const sms = await insert(trx, 'sms', { metadata: { opsJob: 'x' }, row: { category: 'inbound_sms' } });
        const digest = await insert(trx, 'digest', { metadata: { opsJob: 'x', kind: 'ACT' }, row: { category: 'ops_digest' } });
        const done = await insert(trx, 'done', { metadata: { opsJob: 'tech-tips' }, row: { done_at: new Date(), done_by: 'ops-bells' } });
        const read = (id) => trx('notifications').where({ id }).first();

        const dry = await routing.rerouteOpenRows(trx);
        expect(dry).toMatchObject({ execute: false, moved: 0 });
        expect(dry.matched).toBeGreaterThanOrEqual(2);
        expect((await read(canary.id)).metadata.feed).toBeUndefined();

        const live = await routing.rerouteOpenRows(trx, { execute: true });
        expect(live.moved).toBe(live.matched);
        const c = await read(canary.id);
        expect(c.metadata).toMatchObject({ feed: 'activity', who: 'claude', severity: 'broken', claudeQueue: 'sms-draft-canary', dedupeKey: `sms-draft-canary:${RUN}` });
        expect(c.read_at).not.toBeNull();
        expect(c.done_at).toBeNull();
        expect((await read(mac.id)).metadata).toMatchObject({ feed: 'activity', who: 'claude', severity: 'fyi', claudeQueue: 'ops-job' });
        for (const untouched of [ownerAsk, plain, sms, digest, done]) {
          expect((await read(untouched.id)).metadata.feed).toBeUndefined();
        }

        // A second run finds nothing of ours left.
        const again = await routing.rerouteOpenRows(trx, { execute: true });
        expect(again.byClass['sms-draft-canary']).toBeUndefined();
        throw ROLLBACK;
      })).rejects.toBe(ROLLBACK);
    });

    test('refuses to run while the gate is off', async () => {
      delete process.env.GATE_ALERT_CLAUDE_QUEUE;
      await expect(routing.rerouteOpenRows(db, { execute: true })).rejects.toThrow(/GATE_ALERT_CLAUDE_QUEUE is off/);
    });
  });
});
