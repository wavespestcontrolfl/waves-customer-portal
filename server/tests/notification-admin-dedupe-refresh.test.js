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
