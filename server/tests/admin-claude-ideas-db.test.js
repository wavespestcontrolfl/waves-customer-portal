/**
 * "Send to Claude" for an idea against live Postgres (GATE_IB_SEND_TO_CLAUDE): the row lands with the exact metadata the Mac
 * launcher reads, Activity-only (not in the bell list, in Claude's queue) even with the bell policy on; the same idea
 * sent again while it is open is a duplicate that writes nothing; Undo closes the row as done by the admin; and Undo after a
 * Mac tab stamped `startedAt` is refused. The idea's words live in the stamp only and the row is owner-only (Codex security
 * review round 4): the Recently done list and the Activity feed (focus included) leave it out for any login but the owner.
 * Everything is the real database. Rows are this run's own (the idea text carries the run tag) and are removed.
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
    process.env.GATE_AGENT_ACTIVITY = 'true';
    db = require('../models/db');
    NotificationService = require('../services/notification-service');
    ({ sendIdeaToClaude, cancelClaudeIdea, ideaDedupeKey } = require('../services/admin-claude-ideas'));
  });
  afterAll(async () => {
    delete process.env.GATE_IB_SEND_TO_CLAUDE;
    delete process.env.GATE_ADMIN_BELL_POLICY;
    delete process.env.GATE_AGENT_ACTIVITY;
    await db('notifications').where('recipient_type', 'admin').whereRaw("metadata->'sentToClaude'->>'idea' LIKE ?", [`%${RUN}%`]).del();
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
      recipient_type: 'admin', category: 'system', title: 'Idea for Claude', link: '/admin', done_at: null,
      body: 'An idea from the owner.', detail: null,
    }));
    // The words are nowhere in the shared columns.
    expect(JSON.stringify([row.title, row.body, row.detail, row.link])).not.toContain(RUN);
    const m = meta(row);
    expect(m).toEqual({
      feed: 'activity',
      who: 'claude',
      severity: 'needs-you',
      claudeQueue: 'sent-to-claude',
      ownerOnly: true,
      dedupeKey: expect.stringMatching(/^owner-idea:[0-9a-f]{16}$/),
      sentToClaude: {
        at: out.body.at,
        by: ADMIN,
        kind: 'owner-idea',
        idea,
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
  test('the Recently done list leaves an owner-only row out unless the caller has full access', async () => {
    const sent = await send(`Print the crew sheet at seven ${RUN}`);
    await cancelClaudeIdea(sent.body.id, { at: sent.body.at, by: ADMIN, role: 'admin' });
    const ids = async (opts) => (await NotificationService.getAdminDoneNotifications({ role: 'admin', limit: 50, ...opts })).map((r) => r.id);
    expect(await ids({})).not.toContain(sent.body.id);
    expect(await ids({ fullAccess: false })).not.toContain(sent.body.id);
    expect(await ids({ fullAccess: true })).toContain(sent.body.id);
    // Nothing the list serves carries the words.
    const served = (await NotificationService.getAdminDoneNotifications({ role: 'admin', limit: 50, fullAccess: true })).find((r) => r.id === sent.body.id);
    expect(JSON.stringify(served)).not.toContain(RUN);
  });

  test('isAdminOwnerOnly reads the flag, and only for an owner-only row', async () => {
    const sent = await send(`Add a refresh button to the board ${RUN}`);
    expect(await NotificationService.isAdminOwnerOnly(sent.body.id, { role: 'admin' })).toBe(true);
    const [plain] = await db('notifications').insert({ recipient_type: 'admin', category: 'system', title: `Plain ${RUN}`, body: 'x', metadata: JSON.stringify({ claudeQueue: 'sent-to-claude', feed: 'activity' }) }).returning('id');
    try {
      expect(await NotificationService.isAdminOwnerOnly(plain.id, { role: 'admin' })).toBe(false);
    } finally {
      await db('notifications').where({ id: plain.id }).del();
    }
    expect(await NotificationService.isAdminOwnerOnly('00000000-0000-4000-8000-000000000000', { role: 'admin' })).toBe(false);
  });

  test('the Activity feed leaves an owner-only row out unless the caller has full access, focus included', async () => {
    const { getActivity } = require('../services/agent-activity');
    const sent = await send(`Show open slots on the board header ${RUN}`);
    const itemIds = (feed) => feed.items.map((i) => i.id);
    const key = `digest:${sent.body.id}`;
    expect(itemIds(await getActivity({ windowHours: 24 }))).not.toContain(key);
    expect(itemIds(await getActivity({ windowHours: 24, fullAccess: false, focus: sent.body.id }))).not.toContain(key);
    const owner = await getActivity({ windowHours: 24, fullAccess: true, focus: sent.body.id });
    expect(itemIds(owner)).toContain(key);
    // The item serves title + body (no detail, no raw metadata): the words are not in the feed even for the owner.
    expect(JSON.stringify(owner.items.find((i) => i.id === key))).not.toContain(RUN);
  });
});
