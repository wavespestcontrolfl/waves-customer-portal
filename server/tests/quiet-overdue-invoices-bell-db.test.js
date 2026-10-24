/**
 * Quiet overdue invoices bell (owner 2026-10-24) against live Postgres: the
 * standing row's whole life through the real notification service and alert
 * episodes, under the production bell policy (GATE_ADMIN_BELL_POLICY on, so a
 * billing row lands only because it asks to ring by default). A first list
 * rings; the next weekday's refresh with the same invoices is quiet (read and
 * done stay as a person left them); a new invoice rings again and moves the
 * row to the top; an empty list closes it done; a comeback rings. The rows
 * come from a stubbed loader, so other suites' invoices never join the list,
 * and the row carries this run's own key, so cleanup touches only rows this
 * suite wrote. It refuses any database but a private QA one or CI's.
 */
process.env.GATE_ADMIN_BELL_POLICY = 'true'; // read once, when feature-gates loads
const { randomUUID } = require('crypto');

// The legacy senders are retired in production; the run requires it.
jest.mock('../services/invoice-followups', () => ({ latePaymentCheckerRetiredLive: () => true }));

const SKIP = !process.env.DATABASE_URL;
const maybeDescribe = SKIP ? describe.skip : describe;

afterAll(async () => { if (!SKIP) await require('../models/db').destroy(); });

maybeDescribe('quiet overdue invoices bell (live Postgres)', () => {
  let db;
  let Quiet;
  let NotificationService;
  const KEY = `quiet-overdue-invoices-test-${randomUUID()}`;
  const MONDAY = new Date('2026-10-26T15:47:00Z');
  const TUESDAY = new Date('2026-10-27T15:47:00Z');

  beforeAll(() => {
    const target = new URL(process.env.DATABASE_URL);
    const privateQa = /^\/waves_qa_[a-f0-9]{32}$/.test(target.pathname);
    const ci = process.env.CI === 'true' && ['localhost', '127.0.0.1'].includes(target.hostname) && target.pathname === '/waves_test';
    if (!privateQa && !ci) throw new Error('Use a private QA or isolated CI database');
    process.env.GATE_BALANCE_REMINDER_LEGACY_OFF = 'true';
    db = require('../models/db');
    Quiet = require('../services/quiet-overdue-invoices');
    NotificationService = require('../services/notification-service');
  });
  afterAll(async () => {
    delete process.env.GATE_BALANCE_REMINDER_LEGACY_OFF;
    if (db) await rows().del();
  });

  const rows = () => db('notifications').where({ recipient_type: 'admin' }).whereRaw("metadata->>'dedupeKey' = ?", [KEY]);
  const standing = async () => {
    const all = await rows();
    expect(all).toHaveLength(1);
    return all[0];
  };
  const invoice = (id, daysLate, over = {}) => ({
    id, invoice_number: `QOI-${id.slice(0, 6)}`, customer_id: randomUUID(), total: '120.00', credit_applied: '0',
    first_name: 'Pat', last_name: 'Synthetic', seq_status: 'completed', next_touch_at: null, paused_until: null,
    stopped_by_admin_id: null, stopped_reason: null, autopay_failures_observed: 0, days_late: daysLate, hold_days: daysLate, ...over,
  });
  const run = (list, now) => Quiet.runQuietOverdueList({ now, gateEnabled: true, loadRows: async () => list, dedupeKey: KEY });

  test('raise, quiet refresh, a person\'s done, a new invoice rings, closed at zero, a comeback rings', async () => {
    const a = randomUUID();
    const b = randomUUID();
    const c = randomUUID();

    // 1. The first list rings: one unread billing row with the invoices as its item keys.
    await expect(run([invoice(a, 30), invoice(b, 20)], MONDAY)).resolves.toMatchObject({ count: 2, outcome: 'raised' });
    let row = await standing();
    expect(row.category).toBe('billing');
    expect(row.title).toBe('Billing — follow up on 2 quiet overdue invoices');
    expect(row.read_at).toBeNull();
    expect(row.metadata).toMatchObject({ itemKeys: [a, b].sort(), count: 2, area: 'Billing', severity: 'needs-you', doneWhen: 'count_zero' });
    expect(row.detail).toContain('30 days late');
    const firstId = row.id;

    // 2. A person reads it; the next weekday the same invoices are a day older: a quiet refresh.
    await db('notifications').where({ id: firstId }).update({ read_at: new Date('2026-10-26T16:00:00Z') });
    await expect(run([invoice(a, 31), invoice(b, 21)], TUESDAY)).resolves.toMatchObject({ outcome: 'refreshed' });
    row = await standing();
    expect(row.id).toBe(firstId);
    expect(row.detail).toContain('31 days late');
    expect(new Date(row.read_at).toISOString()).toBe('2026-10-26T16:00:00.000Z');

    // 3. A person marks it done: the same list stays done.
    expect(await NotificationService.markAdminDone([firstId], { by: '7', resolution: 'Calling both customers' })).toBe(1);
    await run([invoice(a, 32), invoice(b, 22)], TUESDAY);
    row = await standing();
    expect(row.done_at).not.toBeNull();
    expect(row.resolution).toBe('Calling both customers');

    // 4. A new invoice joins: the row rings again (unread, not done) and moves to the top.
    const before = new Date(row.created_at).getTime();
    await expect(run([invoice(a, 33), invoice(b, 23), invoice(c, 15)], TUESDAY)).resolves.toMatchObject({ count: 3, outcome: 'raised' });
    row = await standing();
    expect([row.read_at, row.done_at]).toEqual([null, null]);
    expect(new Date(row.created_at).getTime()).toBeGreaterThan(before);
    expect(row.metadata.itemKeys).toEqual([a, b, c].sort());

    // 5. Nothing quiet any more: the row closes itself as done.
    await expect(run([], TUESDAY)).resolves.toEqual({ count: 0, outcome: 'closed' });
    row = await standing();
    expect(row.done_by).toBe('episodes');
    expect(row.resolution).toBe('Every overdue invoice has reminders going out or is settled');
    expect(row.metadata.autoCleared).toBe(true);
    await expect(run([], TUESDAY)).resolves.toEqual({ count: 0, outcome: 'clear' });

    // 6. The same invoice comes back: a comeback rings even with no new item key.
    await expect(run([invoice(a, 40)], TUESDAY)).resolves.toMatchObject({ count: 1 });
    row = await standing();
    expect([row.read_at, row.done_at]).toEqual([null, null]);
    expect(row.metadata.autoCleared).toBe(false);
    expect(row.title).toBe('Billing — follow up on 1 quiet overdue invoice');
    expect(row.link).toBe(`/admin/invoices?invoice=${a}`);
  });
});
