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
    const b = {
      where(c) { Object.entries(c).forEach(([k, v]) => conds.push((r) => r[k] === v)); return b; },
      whereRaw(_sql, [key]) { conds.push((r) => (typeof r.metadata === 'string' ? JSON.parse(r.metadata) : r.metadata || {}).dedupeKey === key); return b; },
      first: async () => (mockRows[table] || []).find((r) => conds.every((c) => c(r))) || null,
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
test('a quiet refresh (ringOnRefresh false) that is ALSO an audience flip still applies feed/quiet — an audience flip always wins', async () => {
  await NotificationService.notifyAdmin('ops_digest', 'Reviews — sync down', null, {
    dedupeKey: 'k-audience-flip', refreshOnDedupe: true, detail: 'same report',
    metadata: { kind: 'FIX', audience: 'engineering', feed: 'activity' },
  });
  mockRows.notifications[0].read_at = new Date('2026-09-01T12:00:00Z');
  // ringOnRefresh says "no news" (quiet) — but the kind/audience/feed
  // changed, so the routing must still land even though read_at does not
  // clear (this is not new information the owner needs to re-read, only a
  // reclassification of where it belongs).
  const flipped = await NotificationService.notifyAdmin('ops_digest', 'Reviews — sync down', null, {
    dedupeKey: 'k-audience-flip', refreshOnDedupe: true, ringOnRefresh: () => false, detail: 'same report',
    metadata: { kind: 'ACT', audience: 'owner', feed: null, quiet: false },
  });
  expect(flipped.refreshed).toBe(true);
  expect(flipped.rung).toBe(false);
  const row = mockRows.notifications[0];
  expect(row.read_at).not.toBeNull(); // not cleared — this refresh did not ring
  const meta = JSON.parse(row.metadata);
  expect(meta.kind).toBe('ACT');
  expect(meta.audience).toBe('owner');
  expect(meta.feed).toBeNull(); // applied despite the quiet refresh
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

// ringGate (admin-alerts-ring scope 2026-09-28): for a PLAIN (no dedupeKey)
// admin row — the shape most senders use, one fresh insert per run — this
// decides whether THIS insert rings, inside the same transaction as the
// insert itself.
describe('ringGate (no dedupeKey)', () => {
  test('ringGate() -> true leaves the caller\'s own metadata untouched', async () => {
    const row = await NotificationService.notifyAdmin('ops_digest', 'Backlog check', 'body', {
      metadata: { count: 5, feed: null, quiet: false },
      ringGate: async () => true,
    });
    expect(row.suppressed).toBeUndefined();
    const meta = JSON.parse(mockRows.notifications[0].metadata);
    expect(meta).toEqual({ count: 5, feed: null, quiet: false });
  });

  test('ringGate() -> false rewrites ONLY quiet/feed — every other field the caller composed stands', async () => {
    await NotificationService.notifyAdmin('ops_digest', 'Backlog check', 'body', {
      metadata: { count: 5, feed: null, quiet: false, opsKey: 'k' },
      ringGate: async () => false,
    });
    const meta = JSON.parse(mockRows.notifications[0].metadata);
    expect(meta).toEqual({ count: 5, feed: 'activity', quiet: true, opsKey: 'k' });
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
