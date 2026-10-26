/**
 * Unbilled visits bell (owner 2026-10-25, Air Jobs Plan step 3) against live
 * Postgres: the standing row's whole life through the real notification service
 * and alert episodes, under the production bell policy (GATE_ADMIN_BELL_POLICY
 * on, so a billing row lands only because it asks to ring by default). A first
 * list rings; the next day's refresh with the same visits is quiet (read and
 * done stay as a person left them); a new visit rings again and moves the row
 * to the top; an empty list closes it done; a comeback rings. The list comes
 * from a stubbed loader, so other suites' visits never join it, and the row
 * carries this run's own key, so cleanup touches only rows this suite wrote. It
 * refuses any database but a private QA one or CI's.
 */
process.env.GATE_ADMIN_BELL_POLICY = 'true'; // read once, when feature-gates loads
const { randomUUID } = require('crypto');

const SKIP = !process.env.DATABASE_URL;
const maybeDescribe = SKIP ? describe.skip : describe;

afterAll(async () => { if (!SKIP) await require('../models/db').destroy(); });

maybeDescribe('unbilled visits bell (live Postgres)', () => {
  let db;
  let Unbilled;
  let NotificationService;
  const KEY = `unbilled-visits-test-${randomUUID()}`;

  beforeAll(() => {
    const target = new URL(process.env.DATABASE_URL);
    const privateQa = /^\/waves_qa_[a-f0-9]{32}$/.test(target.pathname);
    const ci = process.env.CI === 'true' && ['localhost', '127.0.0.1'].includes(target.hostname) && target.pathname === '/waves_test';
    if (!privateQa && !ci) throw new Error('Use a private QA or isolated CI database');
    db = require('../models/db');
    Unbilled = require('../services/unbilled-visits-list');
    NotificationService = require('../services/notification-service');
  });
  afterAll(async () => {
    if (db) await rows().del();
  });

  const rows = () => db('notifications').where({ recipient_type: 'admin' }).whereRaw("metadata->>'dedupeKey' = ?", [KEY]);
  const standing = async () => {
    const all = await rows();
    expect(all).toHaveLength(1);
    return all[0];
  };
  const visit = (id, completedAt, over = {}) => ({
    scheduled_service_id: id, service_record_id: randomUUID(), customer_id: randomUUID(), customer: 'Pat Synthetic',
    service_type: 'Quarterly Pest Control Service', price: 120, prepaid: 0, completed_at: completedAt, monthly_rate: 0,
    billing_mode: null, billable: true, leak_kind: 'uninvoiced', voided_invoice_number: null,
    billed_elsewhere_invoice_number: null, billed_elsewhere_invoice_status: null, ...over,
  });
  const run = (leaks) => Unbilled.runUnbilledVisitsList({ gateEnabled: true, loadList: async () => ({ leaks, needs_review: [] }), dedupeKey: KEY });

  test('raise, quiet refresh, a person\'s done, a new visit rings, closed at zero, a comeback rings', async () => {
    const a = randomUUID();
    const b = randomUUID();
    const c = randomUUID();

    // 1. The first list rings: one unread billing row with the visits as its item keys.
    await expect(run([visit(a, '2026-10-20T15:00:00Z'), visit(b, '2026-10-22T15:00:00Z')])).resolves.toMatchObject({ count: 2, outcome: 'raised' });
    let row = await standing();
    expect(row.category).toBe('billing');
    expect(row.title).toBe('Billing — bill or mark free 2 unbilled visits');
    expect(row.read_at).toBeNull();
    expect(row.link).toBe('/admin/billing-recovery');
    expect(row.metadata).toMatchObject({ itemKeys: [a, b].sort(), count: 2, totalUnbilled: 240, area: 'Billing', severity: 'needs-you', doneWhen: 'count_zero' });
    expect(row.detail).toContain('done Oct 20');
    const firstId = row.id;

    // 2. A person reads it; the next day the same visits are listed again: a quiet refresh.
    await db('notifications').where({ id: firstId }).update({ read_at: new Date('2026-10-26T12:00:00Z') });
    await expect(run([visit(a, '2026-10-20T15:00:00Z'), visit(b, '2026-10-22T15:00:00Z', { price: 130 })])).resolves.toMatchObject({ outcome: 'refreshed' });
    row = await standing();
    expect(row.id).toBe(firstId);
    expect(row.detail).toContain('$130.00');
    expect(new Date(row.read_at).toISOString()).toBe('2026-10-26T12:00:00.000Z');

    // 3. A person marks it done: the same list stays done.
    expect(await NotificationService.markAdminDone([firstId], { by: '7', resolution: 'Billing both today' })).toBe(1);
    await run([visit(a, '2026-10-20T15:00:00Z'), visit(b, '2026-10-22T15:00:00Z')]);
    row = await standing();
    expect(row.done_at).not.toBeNull();
    expect(row.resolution).toBe('Billing both today');

    // 4. A new visit joins: the row rings again (unread, not done) and moves to the top.
    const before = new Date(row.created_at).getTime();
    await expect(run([visit(a, '2026-10-20T15:00:00Z'), visit(b, '2026-10-22T15:00:00Z'), visit(c, '2026-10-25T15:00:00Z')])).resolves.toMatchObject({ count: 3, outcome: 'raised' });
    row = await standing();
    expect([row.read_at, row.done_at]).toEqual([null, null]);
    expect(new Date(row.created_at).getTime()).toBeGreaterThan(before);
    expect(row.metadata.itemKeys).toEqual([a, b, c].sort());

    // 5. No visit waits any more: the row closes itself as done.
    await expect(run([])).resolves.toEqual({ count: 0, outcome: 'closed' });
    row = await standing();
    expect(row.done_by).toBe('episodes');
    expect(row.resolution).toBe('No visit from the last 30 days is waiting to be billed');
    expect(row.metadata.autoCleared).toBe(true);
    await expect(run([])).resolves.toEqual({ count: 0, outcome: 'clear' });

    // 6. The same visit comes back: a comeback rings even with no new item key.
    await expect(run([visit(a, '2026-10-20T15:00:00Z')])).resolves.toMatchObject({ count: 1 });
    row = await standing();
    expect([row.read_at, row.done_at]).toEqual([null, null]);
    expect(row.metadata.autoCleared).toBe(false);
    expect(row.title).toBe("Billing — bill or mark free Pat Synthetic's visit");
  });
});
