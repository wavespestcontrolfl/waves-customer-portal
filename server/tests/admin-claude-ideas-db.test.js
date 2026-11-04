/**
 * "Send to Claude" for an idea against live Postgres (GATE_IB_SEND_TO_CLAUDE): the row lands with the exact metadata the Mac
 * launcher reads, Activity-only (not in the bell list, in Claude's queue) even with the bell policy on; the same idea
 * sent again while it is open is a duplicate that writes nothing; Undo closes the row as done by the admin; and Undo after a
 * Mac tab stamped `startedAt` is refused. Everything is the real database. Rows are this run's own (the idea text carries
 * the run tag) and are removed.
 */
const SKIP = !process.env.DATABASE_URL;
const maybeDescribe = SKIP ? describe.skip : describe;

maybeDescribe('send an idea to Claude (live Postgres)', () => {
  let db;
  let NotificationService;
  let sendIdeaToClaude;
  let cancelClaudeIdea;
  let ideaDedupeKey;
  const RUN = `idea-test-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
  const ADMIN = '11111111-1111-4111-8111-111111111111';
  const CUSTOMER = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const meta = (row) => (typeof row.metadata === 'string' ? JSON.parse(row.metadata) : row.metadata);
  const rowOf = (id) => db('notifications').where({ id }).first();
  const inBell = async (id) => (await NotificationService.getAdminNotifications(200, 0, { role: 'admin' })).some((r) => r.id === id);
  const send = (text, extra = {}) => sendIdeaToClaude({ text, by: ADMIN, ...extra });

  beforeAll(async () => {
    process.env.GATE_IB_SEND_TO_CLAUDE = 'true';
    // The bell policy is on: only the row's own Claude's-queue mark keeps it from being silenced (create(): routedToClaude).
    process.env.GATE_ADMIN_BELL_POLICY = 'true';
    db = require('../models/db');
    NotificationService = require('../services/notification-service');
    ({ sendIdeaToClaude, cancelClaudeIdea, ideaDedupeKey } = require('../services/admin-claude-ideas'));
  });
  afterAll(async () => {
    delete process.env.GATE_IB_SEND_TO_CLAUDE;
    delete process.env.GATE_ADMIN_BELL_POLICY;
    await db('notifications').where('recipient_type', 'admin').where('detail', 'like', `%${RUN}%`).del();
    await db.destroy();
  });

  test('the row carries the exact shape, is Activity-only and sits in Claude\'s queue', async () => {
    const idea = `Show the last tech note on the dispatch card ${RUN}.\nIt hides today.`;
    const out = await send(idea, {
      page: { route: '/admin/dispatch' }, ids: { customer_id: CUSTOMER, viewed_date: '2026-11-03' }, pasted: true,
    });
    expect(out.status).toBe(200);
    expect(out.body).toEqual(expect.objectContaining({ sent: true, message: expect.stringMatching(/^Sent to Claude\./) }));
    const row = await rowOf(out.body.id);
    expect(row).toEqual(expect.objectContaining({
      recipient_type: 'admin', category: 'system', title: 'Idea for Claude', link: '/admin/dispatch', done_at: null,
      body: `Show the last tech note on the dispatch card ${RUN}.`, detail: idea,
    }));
    const m = meta(row);
    expect(m).toEqual({
      feed: 'activity',
      who: 'claude',
      severity: 'needs-you',
      claudeQueue: 'sent-to-claude',
      dedupeKey: expect.stringMatching(/^owner-idea:[0-9a-f]{16}$/),
      sentToClaude: {
        at: out.body.at,
        by: ADMIN,
        kind: 'owner-idea',
        records: { customerId: CUSTOMER },
        page: { route: '/admin/dispatch' },
        viewedDate: '2026-11-03',
        pasted: true,
        was: { who: null, severity: null },
      },
    });
    // Not in the bell; in Claude's queue (needs-me lists it under Claude).
    expect(await inBell(row.id)).toBe(false);
    const { listNeedsMe } = require('../services/needs-me');
    const listed = (await listNeedsMe({ who: 'claude', role: 'admin' })).items.find((i) => i.id === row.id);
    expect(listed).toEqual(expect.objectContaining({ who: 'claude', sent: true }));
  });

  test('the same idea sent again while it is open is a duplicate and writes nothing; a longer idea is new', async () => {
    const first = await send(`Add a mowing day filter ${RUN}`);
    expect(first.status).toBe(200);
    const again = await send(`  add a MOWING  day\nfilter ${RUN}`);
    expect(again).toEqual({ status: 200, body: { duplicate: true, id: first.body.id } });
    const rows = await db('notifications').where('recipient_type', 'admin').whereRaw("metadata->>'dedupeKey' = ?", [ideaDedupeKey(`add a mowing day filter ${RUN}`)]);
    expect(rows).toHaveLength(1);
    expect((await send(`Add a mowing day filter ${RUN} for lawn visits`)).body.sent).toBe(true);
  });

  test('Undo closes the row as done by the admin; a closed idea can be sent again', async () => {
    const idea = `Colour the route map by crew ${RUN}`;
    const sent = await send(idea);
    const out = await cancelClaudeIdea(sent.body.id, { at: sent.body.at, by: ADMIN, role: 'admin' });
    expect(out).toEqual({ status: 200, body: { cancelled: true } });
    const row = await rowOf(sent.body.id);
    expect(row.done_at).not.toBeNull();
    expect(row.done_by).toBe(ADMIN);
    expect(row.resolution).toBe('Cancelled by the owner.');
    // A second Undo: done.
    expect(await cancelClaudeIdea(sent.body.id, { at: sent.body.at, by: ADMIN, role: 'admin' })).toEqual({ status: 409, body: { error: 'done' } });
    // The key is free again: the same idea is a new row.
    const resent = await send(idea);
    expect(resent.body.sent).toBe(true);
    expect(resent.body.id).not.toBe(sent.body.id);
  });

  test('Undo after a Mac tab started, or with a different send time, is refused and leaves the row open', async () => {
    const sent = await send(`Print the route sheet in crew order ${RUN}`);
    expect(await cancelClaudeIdea(sent.body.id, { at: '2020-01-01T00:00:00.000Z', by: ADMIN, role: 'admin' }))
      .toEqual({ status: 409, body: { error: 'changed' } });
    await db('notifications').where({ id: sent.body.id }).update({
      metadata: db.raw("jsonb_set(metadata, '{sentToClaude,startedAt}', to_jsonb(now()::text))"),
    });
    expect(await cancelClaudeIdea(sent.body.id, { at: sent.body.at, by: ADMIN, role: 'admin' }))
      .toEqual({ status: 409, body: { error: 'started' } });
    // The write itself refuses too (the in-transaction fence), whatever the read said.
    expect(await NotificationService.markAdminIdeaCancelled(sent.body.id, sent.body.at, ADMIN, 'Cancelled by the owner.')).toBe(0);
    expect((await rowOf(sent.body.id)).done_at).toBeNull();
  });
});
