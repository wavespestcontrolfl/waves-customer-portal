// notifyAdmin dedupe + refreshOnDedupe (codex GH r30 P2 on C3): a keyed
// bell that already exists is returned untouched by default; with
// refreshOnDedupe the standing row is rewritten — title/body/metadata —
// and surfaced unread again ONLY when the content changed, so a retried
// run whose failure set moved never leaves the office reading an obsolete
// error list, and an identical re-emission never re-bells.

jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/internal-test-customers', () => ({ isInternalTestCustomerId: () => false }));

let mockRows;
let mockUpdates;
jest.mock('../models/db', () => {
  const builder = (table) => {
    const conds = [];
    let order = null;
    const b = {
      where(c) { Object.entries(c).forEach(([k, v]) => conds.push((r) => r[k] === v)); return b; },
      whereRaw(_sql, [key]) { conds.push((r) => (typeof r.metadata === 'string' ? JSON.parse(r.metadata) : r.metadata || {}).dedupeKey === key); return b; },
      // The dedupe lookup reads the newest row first (orderBy created_at desc).
      orderBy(col, dir) { order = { col, dir }; return b; },
      first: async () => {
        const hits = (mockRows[table] || []).filter((r) => conds.every((c) => c(r)));
        if (order) hits.sort((x, y) => (new Date(y[order.col] || 0) - new Date(x[order.col] || 0)) * (order.dir === 'desc' ? 1 : -1));
        return hits[0] || null;
      },
      update: async (patch) => { const hit = (mockRows[table] || []).filter((r) => conds.every((c) => c(r))); hit.forEach((r) => Object.assign(r, patch)); mockUpdates.push(patch); return hit.length; },
      insert: (row) => ({ returning: async () => { const created = { id: `n-${(mockRows[table] ||= []).length + 1}`, ...row }; mockRows[table].push(created); return [created]; } }),
    };
    return b;
  };
  const fn = jest.fn((table) => builder(table));
  fn.transaction = async (cb) => { const trx = jest.fn((table) => builder(table)); trx.raw = jest.fn(async () => {}); return cb(trx); };
  return fn;
});

const NotificationService = require('../services/notification-service');

beforeEach(() => {
  mockRows = { notifications: [] };
  mockUpdates = [];
});

test('a keyed bell is created once; an identical re-emission is a plain dedupe (no rewrite, no re-bell)', async () => {
  const first = await NotificationService.notifyAdmin('service', 'Cancel plan needs review', 'failed: sms', { dedupeKey: 'admin_cancel_review:r1', refreshOnDedupe: true, metadata: { processingErrors: ['sms'] } });
  expect(first.deduped).toBe(false);
  mockRows.notifications[0].read_at = new Date('2026-09-01T12:00:00Z');
  const again = await NotificationService.notifyAdmin('service', 'Cancel plan needs review', 'failed: sms', { dedupeKey: 'admin_cancel_review:r1', refreshOnDedupe: true, metadata: { processingErrors: ['sms'] } });
  expect(again.deduped).toBe(true);
  expect(again.refreshed).toBeUndefined();
  expect(mockUpdates).toEqual([]);
  expect(mockRows.notifications[0].read_at).not.toBeNull();
});

test('refreshOnDedupe rewrites a standing bell whose content CHANGED and surfaces it unread — the latest error set replaces the obsolete one', async () => {
  await NotificationService.notifyAdmin('service', 'Cancel plan needs review', 'failed: confirmation_sms_not_sent', { dedupeKey: 'admin_cancel_review:r1', refreshOnDedupe: true, metadata: { requestId: 'r1', processingErrors: ['confirmation_sms_not_sent'] } });
  mockRows.notifications[0].read_at = new Date('2026-09-01T12:00:00Z');
  const moved = await NotificationService.notifyAdmin('service', 'Cancel plan needs review', 'failed: prepay_refund_task', { dedupeKey: 'admin_cancel_review:r1', refreshOnDedupe: true, metadata: { requestId: 'r1', processingErrors: ['prepay_refund_task'] } });
  expect(moved.deduped).toBe(true);
  expect(moved.refreshed).toBe(true);
  expect(mockRows.notifications).toHaveLength(1);
  const row = mockRows.notifications[0];
  expect(row.body).toBe('failed: prepay_refund_task');
  expect(row.read_at).toBeNull();
  expect(JSON.parse(row.metadata)).toEqual(expect.objectContaining({ dedupeKey: 'admin_cancel_review:r1', processingErrors: ['prepay_refund_task'] }));
});

test('without refreshOnDedupe the old behavior stands — the existing row is returned untouched even when the content differs', async () => {
  await NotificationService.notifyAdmin('service', 'Alert', 'first body', { dedupeKey: 'k1' });
  const again = await NotificationService.notifyAdmin('service', 'Alert', 'second body', { dedupeKey: 'k1' });
  expect(again.deduped).toBe(true);
  expect(mockRows.notifications[0].body).toBe('first body');
  expect(mockUpdates).toEqual([]);
});

test('a customer merge refreshes the standing bell destination even when its wording is unchanged', async () => {
  const opts = { dedupeKey: 'sms-commitment:fixture', refreshOnDedupe: true };
  await NotificationService.notifyAdmin('alert', 'SMS needs follow-up', 'Open the customer profile', {
    ...opts, link: '/admin/customers?customerId=loser', metadata: { customerId: 'loser' },
  });
  mockRows.notifications[0].read_at = new Date();
  const moved = await NotificationService.notifyAdmin('alert', 'SMS needs follow-up', 'Open the customer profile', {
    ...opts, link: '/admin/customers?customerId=winner', metadata: { customerId: 'winner' },
  });
  expect(moved.refreshed).toBe(true);
  expect(mockRows.notifications).toHaveLength(1);
  expect(mockRows.notifications[0]).toMatchObject({ link: '/admin/customers?customerId=winner', read_at: null });
  expect(JSON.parse(mockRows.notifications[0].metadata).customerId).toBe('winner');
});

test('a content refresh without a supplied link preserves the existing destination', async () => {
  const opts = { dedupeKey: 'sms-commitment:fixture', refreshOnDedupe: true };
  await NotificationService.notifyAdmin('alert', 'SMS needs follow-up', 'Before', {
    ...opts, link: '/admin/customers?customerId=fixture',
  });
  await NotificationService.notifyAdmin('alert', 'SMS needs follow-up', 'After', opts);
  expect(mockRows.notifications[0].link).toBe('/admin/customers?customerId=fixture');
});

// ringOnRefresh (admin-alerts-ring scope, owner ruling 2026-09-28): a
// refresh's CONTENT still updates either way — only whether it re-bells
// (clears read_at) is gated, and a non-ringing refresh must not let its own
// feed/quiet opinion flip the row's current bell visibility.
test('ringOnRefresh(false): content updates, read_at stays, and feed/quiet are dropped from the merge — the row keeps its current visibility', async () => {
  await NotificationService.notifyAdmin('ops_digest', 'Backlog check', 'body v1', {
    dedupeKey: 'ring-fixture', refreshOnDedupe: true, metadata: { count: 5, feed: null, quiet: false },
  });
  mockRows.notifications[0].read_at = new Date('2026-09-01T12:00:00Z');
  const refreshed = await NotificationService.notifyAdmin('ops_digest', 'Backlog check', 'body v2', {
    dedupeKey: 'ring-fixture', refreshOnDedupe: true, ringOnRefresh: () => false,
    // This call's OWN feed/quiet opinion (as if it were a fresh, quiet
    // insert) — ignored, because this refresh does not ring.
    metadata: { count: 5, feed: 'activity', quiet: true },
  });
  expect(refreshed.refreshed).toBe(true);
  expect(refreshed.rung).toBe(false);
  const row = mockRows.notifications[0];
  expect(row.body).toBe('body v2');
  expect(row.read_at).not.toBeNull();
  const meta = JSON.parse(row.metadata);
  expect(meta.feed).toBeNull(); // kept from before the refresh, not flipped to 'activity'
  expect(meta.quiet).toBe(false); // kept from before the refresh, not flipped to true
  expect(meta.count).toBe(5); // every other field still merges normally
});

test('ringOnRefresh(true): read_at clears and the caller\'s own feed/quiet apply like any other field', async () => {
  await NotificationService.notifyAdmin('ops_digest', 'Backlog check', 'body v1', {
    dedupeKey: 'ring-fixture-2', refreshOnDedupe: true, metadata: { count: 5, feed: 'activity', quiet: true },
  });
  mockRows.notifications[0].read_at = new Date('2026-09-01T12:00:00Z');
  const refreshed = await NotificationService.notifyAdmin('ops_digest', 'Backlog check', 'body v2', {
    dedupeKey: 'ring-fixture-2', refreshOnDedupe: true, ringOnRefresh: () => true,
    metadata: { count: 9, feed: null, quiet: false },
  });
  expect(refreshed.rung).toBe(true);
  const row = mockRows.notifications[0];
  expect(row.read_at).toBeNull();
  const meta = JSON.parse(row.metadata);
  expect(meta.feed).toBeNull();
  expect(meta.quiet).toBe(false);
  expect(meta.count).toBe(9);
});

test('omitting ringOnRefresh preserves today\'s behavior exactly — any content change still re-bells', async () => {
  await NotificationService.notifyAdmin('ops_digest', 'Backlog check', 'body v1', { dedupeKey: 'ring-default', refreshOnDedupe: true });
  mockRows.notifications[0].read_at = new Date('2026-09-01T12:00:00Z');
  const refreshed = await NotificationService.notifyAdmin('ops_digest', 'Backlog check', 'body v2', { dedupeKey: 'ring-default', refreshOnDedupe: true });
  expect(refreshed.refreshed).toBe(true);
  expect(refreshed.rung).toBe(true);
  expect(mockRows.notifications[0].read_at).toBeNull();
});

// An audience flip (owner<->engineering) changes which surface the row
// belongs to, not merely whether it rings — codex r3's routingChanged
// trigger plus this scope's ringOnRefresh must combine so a quiet flip
// still applies its feed (never leaves the owner's action hidden behind a
// stale feed:'activity', or a now-engineering row still showing in the bell).
test('an engineering -> owner flip rings into the bell even when ringOnRefresh says no news (it may have been read in Activity)', async () => {
  await NotificationService.notifyAdmin('ops_digest', 'Reviews — sync down', null, {
    dedupeKey: 'k-audience-flip', refreshOnDedupe: true, detail: 'same report',
    metadata: { kind: 'FIX', audience: 'engineering', feed: 'activity' },
  });
  mockRows.notifications[0].read_at = new Date('2026-09-01T12:00:00Z');
  const flipped = await NotificationService.notifyAdmin('ops_digest', 'Reviews — sync down', null, {
    dedupeKey: 'k-audience-flip', refreshOnDedupe: true, ringOnRefresh: () => false, detail: 'same report',
    metadata: { kind: 'ACT', audience: 'owner', feed: null, quiet: false },
  });
  expect(flipped.refreshed).toBe(true);
  expect(flipped.rung).toBe(true);
  const row = mockRows.notifications[0];
  expect(row.read_at).toBeNull();
  const meta = JSON.parse(row.metadata);
  expect(meta.kind).toBe('ACT');
  expect(meta.audience).toBe('owner');
  expect(meta.feed).toBeNull();
});

test('a quiet refresh (ringOnRefresh false) that is ALSO an owner -> engineering flip still applies the new feed — an audience flip always routes', async () => {
  await NotificationService.notifyAdmin('ops_digest', 'Reviews — sync down', null, {
    dedupeKey: 'k-audience-flip-down', refreshOnDedupe: true, detail: 'same report',
    metadata: { kind: 'ACT', audience: 'owner', feed: null, quiet: false },
  });
  mockRows.notifications[0].read_at = new Date('2026-09-01T12:00:00Z');
  const flipped = await NotificationService.notifyAdmin('ops_digest', 'Reviews — sync down', null, {
    dedupeKey: 'k-audience-flip-down', refreshOnDedupe: true, ringOnRefresh: () => false, detail: 'same report',
    metadata: { kind: 'FIX', audience: 'engineering', feed: 'activity' },
  });
  expect(flipped.refreshed).toBe(true);
  expect(flipped.rung).toBe(false);
  const row = mockRows.notifications[0];
  expect(row.read_at).not.toBeNull(); // not cleared — this refresh did not ring
  const meta = JSON.parse(row.metadata);
  expect(meta.audience).toBe('engineering');
  expect(meta.feed).toBe('activity'); // applied despite the quiet refresh
});

test('a quiet refresh with NO audience change drops feed/quiet from the merge, same as before this flip rule existed', async () => {
  await NotificationService.notifyAdmin('ops_digest', 'Backlog check', 'body v1', {
    dedupeKey: 'k-no-flip', refreshOnDedupe: true, metadata: { kind: 'ACT', audience: 'owner', feed: null, quiet: false },
  });
  mockRows.notifications[0].read_at = new Date('2026-09-01T12:00:00Z');
  const refreshed = await NotificationService.notifyAdmin('ops_digest', 'Backlog check', 'body v2', {
    dedupeKey: 'k-no-flip', refreshOnDedupe: true, ringOnRefresh: () => false,
    metadata: { kind: 'ACT', audience: 'owner', feed: 'activity', quiet: true },
  });
  expect(refreshed.rung).toBe(false);
  const meta = JSON.parse(mockRows.notifications[0].metadata);
  expect(meta.feed).toBeNull(); // kept from before — same audience, so no override
  expect(meta.quiet).toBe(false);
});

// A refresh that rings must be visible: the ingest route precomputes quiet
// from its 7-day lookback (which can find this very row), while the ring
// itself comes from ringOnRefresh — a ringing refresh never lands quiet.
test('a ringing refresh whose caller marked it quiet still lands in the bell (quiet false, feed cleared)', async () => {
  await NotificationService.notifyAdmin('ops_digest', 'Voicemail — 2 calls to return', null, {
    dedupeKey: 'k-ring-quiet', refreshOnDedupe: true, metadata: { kind: 'ACT', audience: 'owner', feed: null, quiet: false, count: 2 },
  });
  mockRows.notifications[0].read_at = new Date('2026-09-01T12:00:00Z');
  const grew = await NotificationService.notifyAdmin('ops_digest', 'Voicemail — 3 calls to return', null, {
    dedupeKey: 'k-ring-quiet', refreshOnDedupe: true, ringOnRefresh: () => true,
    metadata: { kind: 'ACT', audience: 'owner', feed: 'activity', quiet: true, count: 3 },
  });
  expect(grew.rung).toBe(true);
  const row = mockRows.notifications[0];
  expect(row.read_at).toBeNull();
  const meta = JSON.parse(row.metadata);
  expect(meta.quiet).toBe(false);
  expect(meta.feed).toBeNull();
  // rungAt advances on this ring (admin-alerts-ring-v2 follow-up).
  expect(typeof meta.rungAt).toBe('string');
});

// admin-alerts-ring-v2 follow-up: the OPPOSITE direction of the test above —
// an existing OWNER row that was quiet (feed:'activity', quiet:true, e.g.
// gbp-sync-health flipped to FIX and rang once) is refreshed by an
// ENGINEERING emission with the default ring (no ringOnRefresh supplied).
// The merge must not leave a stale `quiet:true` standing on a row that no
// longer has owner semantics at all — engineering rows never carry `quiet`.
test('an engineering emission refreshing an owner-quiet row drops the stale quiet key; feed stays its own activity', async () => {
  await NotificationService.notifyAdmin('ops_digest', 'Reviews — sync down', null, {
    dedupeKey: 'k-owner-quiet-to-engineering', refreshOnDedupe: true,
    metadata: { kind: 'FIX', audience: 'owner', feed: 'activity', quiet: true, count: 1 },
  });
  mockRows.notifications[0].read_at = new Date('2026-09-01T12:00:00Z');
  const refreshed = await NotificationService.notifyAdmin('ops_digest', 'Reviews — sync down', null, {
    dedupeKey: 'k-owner-quiet-to-engineering', refreshOnDedupe: true,
    metadata: { kind: 'FIX', audience: 'engineering', feed: 'activity', count: 2 },
  });
  expect(refreshed.rung).toBe(true); // omitted ringOnRefresh defaults to true
  const meta = JSON.parse(mockRows.notifications[0].metadata);
  expect(meta.audience).toBe('engineering');
  expect(meta.feed).toBe('activity'); // this emission's own — never forced
  expect(meta).not.toHaveProperty('quiet'); // dropped, not carried over as stale true
});

// ringGate (admin-alerts-ring scope 2026-09-28): for a PLAIN (no dedupeKey)
// admin row — the shape most senders use, one fresh insert per run — this
// decides whether THIS insert rings, inside the same transaction as the
// insert itself.
describe('ringGate (no dedupeKey)', () => {
  test('a FRESH keyed insert (dedupeKey found no standing row) takes the ring gate too — a rotated key never rings on its own', async () => {
    await NotificationService.notifyAdmin('ops_digest', 'Agent gaps', 'body', {
      dedupeKey: 'agent-gap-digest:2026-W40', metadata: { count: 3, feed: null, quiet: false },
      ringGate: async () => false,
    });
    const meta = JSON.parse(mockRows.notifications[0].metadata);
    expect(meta.quiet).toBe(true);
    expect(meta.feed).toBe('activity');
    expect(meta.dedupeKey).toBe('agent-gap-digest:2026-W40');
  });

  test('ringGate() -> true leaves the caller\'s own metadata untouched, plus a rungAt ring stamp', async () => {
    const row = await NotificationService.notifyAdmin('ops_digest', 'Backlog check', 'body', {
      metadata: { count: 5, feed: null, quiet: false },
      ringGate: async () => true,
    });
    expect(row.suppressed).toBeUndefined();
    const meta = JSON.parse(mockRows.notifications[0].metadata);
    // rungAt (admin-alerts-ring-v2 follow-up): findPriorRungRow's 7-day
    // baseline is measured from the last ring, not created_at.
    expect(meta).toMatchObject({ count: 5, feed: null, quiet: false });
    expect(typeof meta.rungAt).toBe('string');
  });

  test('ringGate() -> false rewrites ONLY quiet/feed — every other field the caller composed stands', async () => {
    await NotificationService.notifyAdmin('ops_digest', 'Backlog check', 'body', {
      metadata: { count: 5, feed: null, quiet: false, opsKey: 'k' },
      ringGate: async () => false,
    });
    const meta = JSON.parse(mockRows.notifications[0].metadata);
    expect(meta).toEqual({ count: 5, feed: 'activity', quiet: true, opsKey: 'k' }); // no rungAt — this insert did not ring
  });

  test('omitting ringGate is a plain insert, unaffected — every other admin emitter with no dedupeKey', async () => {
    await NotificationService.notifyAdmin('service', 'Plain alert', 'body', { metadata: { anything: 1 } });
    expect(mockRows.notifications).toHaveLength(1);
    expect(JSON.parse(mockRows.notifications[0].metadata)).toEqual({ anything: 1 });
  });
});

test('a changed backlog version refreshes the same bell once even when the count and wording stay the same', async () => {
  const opts = { dedupeKey: 'callback-backlog', refreshOnDedupe: true, dedupeVersion: 'initial' };
  const first = await NotificationService.notifyAdmin('alert', '6 callbacks are due', 'Open the callbacks', opts);
  mockRows.notifications[0].read_at = new Date();
  const changed = await NotificationService.notifyAdmin('alert', '6 callbacks are due', 'Open the callbacks', { ...opts, dedupeVersion: 'reopened' });
  expect(changed).toMatchObject({ id: first.id, refreshed: true, read_at: null });
  mockRows.notifications[0].read_at = new Date();
  const repeat = await NotificationService.notifyAdmin('alert', '6 callbacks are due', 'Open the callbacks', { ...opts, dedupeVersion: 'reopened' });
  expect(repeat.refreshed).toBeUndefined();
  expect(repeat.read_at).not.toBeNull();
  expect(mockRows.notifications).toHaveLength(1);
  expect(mockUpdates).toHaveLength(1);
});

// Ring-only-on-change stamps are content too (admin-alerts-ring-v2
// follow-up): a standing row's title/body/link/routing can stay byte
// identical while count/newCount/itemKeys still change — that must still
// trigger the refresh (and ringOnRefresh's evaluation), or a swapped item
// or a grown backlog never re-bells.
describe('ring metadata (count/newCount/itemKeys) alone triggers a refresh', () => {
  test('count changing, with identical title/body/link, still refreshes and re-bells', async () => {
    const opts = { dedupeKey: 'ring-metadata-count', refreshOnDedupe: true, metadata: { count: 5 } };
    await NotificationService.notifyAdmin('ops_digest', 'Backlog check', 'body', opts);
    mockRows.notifications[0].read_at = new Date('2026-09-01T12:00:00Z');
    const refreshed = await NotificationService.notifyAdmin('ops_digest', 'Backlog check', 'body', {
      ...opts, metadata: { count: 6 },
    });
    expect(refreshed.refreshed).toBe(true);
    expect(refreshed.rung).toBe(true);
    expect(mockRows.notifications[0].read_at).toBeNull();
    expect(JSON.parse(mockRows.notifications[0].metadata).count).toBe(6);
  });

  test('itemKeys changing (a different item, same count), with identical title/body/link, still refreshes', async () => {
    const opts = { dedupeKey: 'ring-metadata-itemkeys', refreshOnDedupe: true, metadata: { count: 5, itemKeys: ['a', 'b'] } };
    await NotificationService.notifyAdmin('ops_digest', 'Backlog check', 'body', opts);
    mockRows.notifications[0].read_at = new Date('2026-09-01T12:00:00Z');
    const refreshed = await NotificationService.notifyAdmin('ops_digest', 'Backlog check', 'body', {
      ...opts, metadata: { count: 5, itemKeys: ['a', 'c'] },
    });
    expect(refreshed.refreshed).toBe(true);
    expect(refreshed.rung).toBe(true);
    expect(JSON.parse(mockRows.notifications[0].metadata).itemKeys).toEqual(['a', 'c']);
  });

  test('an itemKeys array unchanged in VALUE (different reference, same order) is not a change', async () => {
    const opts = { dedupeKey: 'ring-metadata-itemkeys-stable', refreshOnDedupe: true, metadata: { count: 5, itemKeys: ['a', 'b'] } };
    await NotificationService.notifyAdmin('ops_digest', 'Backlog check', 'body', opts);
    mockRows.notifications[0].read_at = new Date('2026-09-01T12:00:00Z');
    const repeat = await NotificationService.notifyAdmin('ops_digest', 'Backlog check', 'body', {
      ...opts, metadata: { count: 5, itemKeys: ['a', 'b'] },
    });
    expect(repeat.refreshed).toBeUndefined();
    expect(mockRows.notifications[0].read_at).not.toBeNull(); // untouched — no refresh happened
  });
});

test('with several rows under one key the dedupe lookup refreshes the NEWEST one, never an older row', async () => {
  const meta = (dedupeVersion) => JSON.stringify({ dedupeKey: 'k-multi', dedupeVersion });
  mockRows.notifications = [
    { id: 'n-old', recipient_type: 'admin', title: 'Alert', body: 'b', link: null, created_at: '2026-08-01T00:00:00Z', read_at: null, metadata: meta('v0') },
    { id: 'n-new', recipient_type: 'admin', title: 'Alert', body: 'b', link: null, created_at: '2026-09-01T00:00:00Z', read_at: new Date('2026-09-02T00:00:00Z'), metadata: meta('v1') },
  ];
  const out = await NotificationService.notifyAdmin('alert', 'Alert', 'b', { dedupeKey: 'k-multi', dedupeVersion: 'v2', refreshOnDedupe: true });
  expect(out).toMatchObject({ id: 'n-new', refreshed: true });
  expect(mockRows.notifications[1].read_at).toBeNull();
  expect(JSON.parse(mockRows.notifications[1].metadata).dedupeVersion).toBe('v2');
  expect(JSON.parse(mockRows.notifications[0].metadata).dedupeVersion).toBe('v0');
});

// A standing row written before the brevity guard covered its category holds
// the whole text in `body` and no `detail`. The guard going live must not read
// that as new content: the same text arriving again stays a plain dedupe.
describe('a standing row stored uncut, before the body guard covered its category', () => {
  const LONG = `Promises made on calls with no follow-up within an hour: ${'callback promised to a caller; '.repeat(6)}end.`;
  const seed = (extra = {}) => mockRows.notifications.push({
    id: 'n-old', recipient_type: 'admin', category: 'alert', title: 'Follow-ups overdue', body: LONG, detail: null,
    link: '/admin/communications#tab=owed', read_at: new Date('2026-09-29T12:00:00Z'), created_at: new Date('2026-09-29T11:00:00Z'),
    metadata: JSON.stringify({ dedupeKey: 'k-uncut' }), ...extra,
  });

  test('the same text re-emitted is not a change: no rewrite, no re-bell', async () => {
    seed();
    const again = await NotificationService.notifyAdmin('alert', 'Follow-ups overdue', LONG, { dedupeKey: 'k-uncut', refreshOnDedupe: true, link: '/admin/communications#tab=owed' });
    expect(again.deduped).toBe(true);
    expect(again.refreshed).toBeUndefined();
    expect(mockUpdates).toEqual([]);
    expect(mockRows.notifications[0].read_at).not.toBeNull();
  });

  test('different text is a change, and the rewrite stores the guard form (one-sentence body, full text in detail)', async () => {
    seed();
    const next = `${LONG} One more.`;
    const moved = await NotificationService.notifyAdmin('alert', 'Follow-ups overdue', next, { dedupeKey: 'k-uncut', refreshOnDedupe: true, link: '/admin/communications#tab=owed' });
    expect(moved.refreshed).toBe(true);
    expect(mockRows.notifications[0].body.length).toBeLessThanOrEqual(110);
    expect(mockRows.notifications[0].detail).toBe(next);
  });

  test('a refresh for another reason (the title moved) also stores the guard form', async () => {
    seed();
    const moved = await NotificationService.notifyAdmin('alert', 'Follow-ups overdue (2)', LONG, { dedupeKey: 'k-uncut', refreshOnDedupe: true, link: '/admin/communications#tab=owed' });
    expect(moved.refreshed).toBe(true);
    expect(mockRows.notifications[0].body.length).toBeLessThanOrEqual(110);
    expect(mockRows.notifications[0].detail).toBe(LONG);
  });
});

// The mirror of the block above, after ADMIN_BODY_GUARD_ALL is killed: a row
// stored cut (full text in `detail`) and the same whole text arriving uncut
// must not re-ring every standing alert once.
describe('a standing row stored cut, then re-emitted with the body guard killed', () => {
  const LONG = `A recurring visit is still awaiting placement: ${'review availability and preferences; '.repeat(5)}end.`;
  const OLD_ENV = process.env.ADMIN_BODY_GUARD_ALL;
  afterEach(() => { if (OLD_ENV === undefined) delete process.env.ADMIN_BODY_GUARD_ALL; else process.env.ADMIN_BODY_GUARD_ALL = OLD_ENV; });

  test('the same text is not a change; different text rewrites the row whole and clears detail', async () => {
    const first = await NotificationService.notifyAdmin('alert', 'Placement needed', LONG, { dedupeKey: 'k-cut', refreshOnDedupe: true });
    expect(first.deduped).toBe(false);
    expect(mockRows.notifications[0].detail).toBe(LONG);
    mockRows.notifications[0].read_at = new Date('2026-09-29T12:00:00Z');

    process.env.ADMIN_BODY_GUARD_ALL = 'off';
    const again = await NotificationService.notifyAdmin('alert', 'Placement needed', LONG, { dedupeKey: 'k-cut', refreshOnDedupe: true });
    expect(again.refreshed).toBeUndefined();
    expect(mockUpdates).toEqual([]);
    expect(mockRows.notifications[0].read_at).not.toBeNull();

    const next = `${LONG} Changed.`;
    const moved = await NotificationService.notifyAdmin('alert', 'Placement needed', next, { dedupeKey: 'k-cut', refreshOnDedupe: true });
    expect(moved.refreshed).toBe(true);
    expect(mockRows.notifications[0].body).toBe(next);
    expect(mockRows.notifications[0].detail).toBeNull();
  });
});
