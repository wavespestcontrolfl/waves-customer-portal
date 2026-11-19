/**
 * Paid-at-the-visit receipt check (owner 2026-11-18): an invoice paid at its visit with no receipt after 2 hours rings
 * ONE Billing bell, closes itself once the receipt goes out. These tests hold the SQL filters as written, the ET
 * "paid at the visit" day rule, the skips (test customer, receipts off, a job in flight but not a failed one), the bell's
 * words and key, every close reason, and that one failing lookup neither stops the others nor closes its own bell.
 */
jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
jest.mock('../config/feature-gates', () => ({
  ...jest.requireActual('../config/feature-gates'),
  alertEpisodesLive: jest.fn(() => true),
}));
jest.mock('../services/admin-alert-episodes', () => ({
  raiseAdminAlertWithReopen: jest.fn(async () => ({ id: 'bell-1', deduped: false })),
  openAdminAlertKeys: jest.fn(async () => []),
  closeAdminAlertKeys: jest.fn(async () => 1),
}));

const logger = require('../services/logger');
const { alertEpisodesLive } = require('../config/feature-gates');
const episodes = require('../services/admin-alert-episodes');
const check = require('../services/paid-visit-receipt-check');

// 2026-11-18 14:50 ET; the window is paid_at between Nov 11 19:50 UTC and Nov 18 17:50 UTC.
const NOW = new Date('2026-11-18T19:50:00Z');
const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';
const keyOf = (id) => `paid-visit-no-receipt:${id}`;
// Paid 10:30 ET on the visit day, Nov 18.
const row = (id, extra = {}) => ({
  id, customer_id: `cust-${id.slice(0, 1)}`, invoice_number: `WPC-${id.slice(0, 1)}`, total: '125.00', payment_method: 'check',
  paid_at: new Date('2026-11-18T15:30:00Z'), status: 'paid', receipt_sent_at: null, archived_at: null,
  scheduled_date: '2026-11-18', first_name: 'Pat', last_name: 'Tester', ...extra,
});

let candidates;
let invoices;
let jobs;
let prefs;
let failing;
let sqlCalls;
function chain(table) {
  const q = { calls: [], filter: null };
  const rec = (name) => (...args) => { q.calls.push([name, ...args]); return q; };
  Object.assign(q, {
    join: rec('join'), joinRaw: rec('joinRaw'), leftJoin: rec('leftJoin'), whereNull: rec('whereNull'), whereNotIn: rec('whereNotIn'),
    where: (...args) => { q.calls.push(['where', ...args]); if (args[0] && typeof args[0] === 'object') q.filter = args[0]; return q; },
    select: async (...cols) => { sqlCalls.push({ table, calls: q.calls, cols }); return candidates; },
    first: async () => {
      if (failing?.table === table) throw Object.assign(new Error('boom: secret-token'), { code: 'XX000' });
      const id = q.filter?.id ?? q.filter?.invoice_id;
      if (table === 'invoices') return invoices.find((r) => r.id === id);
      if (table === 'receipt_delivery_jobs') return jobs[id] || undefined;
      if (table === 'notification_prefs') return prefs[q.filter.customer_id] || undefined;
      return undefined;
    },
  });
  return q;
}
const makeConn = () => jest.fn((table) => chain(table));

const raised = () => episodes.raiseAdminAlertWithReopen.mock.calls.map(([category, headline, why, opts]) => ({ category, headline, why, opts }));
const closed = () => episodes.closeAdminAlertKeys.mock.calls.map(([, keys, reason, opts]) => ({ keys, reason, resolution: opts.resolution }));
const run = () => check.runPaidVisitReceiptCheck({ now: NOW, conn: makeConn() });

beforeEach(() => {
  jest.clearAllMocks();
  candidates = [row(A)];
  invoices = [];
  jobs = {};
  prefs = {};
  failing = null;
  sqlCalls = [];
  alertEpisodesLive.mockReturnValue(true);
  episodes.openAdminAlertKeys.mockResolvedValue([]);
  episodes.closeAdminAlertKeys.mockResolvedValue(1);
  episodes.raiseAdminAlertWithReopen.mockResolvedValue({ id: 'bell-1', deduped: false, rang: true });
});

describe('what the query asks for', () => {
  test('every fixed rule is in the SQL, with the 7 day to 2 hour window', async () => {
    await run();
    const { calls } = sqlCalls[0];
    expect(calls).toEqual(expect.arrayContaining([
      // The visit, directly or through the invoice's service record (a post-completion invoice carries only that link).
      ['leftJoin', 'service_records as sr', 'sr.id', 'i.service_record_id'],
      ['joinRaw', 'JOIN scheduled_services AS s ON s.id = COALESCE(i.scheduled_service_id, sr.scheduled_service_id)'],
      ['where', 'i.status', 'paid'],
      // An accepted receipt text is stamped on its own (receipt_sms_sent_at): that customer has the receipt.
      ['whereNull', 'i.receipt_sent_at'], ['whereNull', 'i.receipt_sms_sent_at'], ['whereNull', 'i.archived_at'],
      ['where', 'i.total', '>', 0],
      ['whereNull', 'i.payer_statement_id'], ['whereNull', 'i.payer_id'],
      ['where', 'i.paid_at', '>=', new Date('2026-11-11T19:50:00Z')],
      ['where', 'i.paid_at', '<=', new Date('2026-11-18T17:50:00Z')],
    ]));
  });
});

describe('raising', () => {
  test('a paid-at-the-visit invoice with no receipt rings one billing bell with its own key, link and words', async () => {
    const out = await run();
    const [bell] = raised();
    expect(bell.category).toBe('billing');
    expect(bell.headline).toBe("Billing — send Pat Tester's receipt");
    // The figure is the invoice's total, not the tender (a last check can settle a part-paid invoice).
    expect(bell.why).toBe('The $125.00 invoice was paid by check at the Nov 18 visit; no receipt has gone out.');
    expect(bell.opts).toMatchObject({
      dedupeKey: keyOf(A), bell: true, link: `/admin/invoices?invoice=${A}`,
      metadata: expect.objectContaining({ invoiceId: A, customerId: 'cust-1', severity: 'needs-you', subject: { type: 'invoice', id: A }, who: 'person', doneWhen: 'receipt_sent' }),
    });
    expect(out).toMatchObject({ candidates: 1, raised: 1, failed: 0 });
  });

  test('the visit day is the ET day: 9:30 PM ET on Nov 17 (UTC Nov 18) is not the Nov 18 visit; 11:30 PM ET on the visit day is', async () => {
    candidates = [row(A, { paid_at: new Date('2026-11-18T02:30:00Z') }), row(B, { paid_at: new Date('2026-11-18T04:30:00Z'), scheduled_date: '2026-11-17' })];
    await run();
    // Nov 17 9:30 PM ET vs visit Nov 18: skipped. Nov 17 11:30 PM ET vs visit Nov 17: raised.
    expect(raised().map((b) => b.opts.dedupeKey)).toEqual([keyOf(B)]);
  });

  test('a visit date read as a UTC-midnight Date keeps its own calendar day', async () => {
    candidates = [row(A, { scheduled_date: new Date('2026-11-18T00:00:00Z') })];
    await run();
    expect(raised()).toHaveLength(1);
  });

  test('a reconciliation of an old check (paid on another day than the visit) rings nothing', async () => {
    candidates = [row(A, { scheduled_date: '2026-11-12' })];
    await run();
    expect(raised()).toEqual([]);
  });

  test('an internal test customer rings nothing', async () => {
    candidates = [row(A, { customer_id: '3274944a-f509-413c-9dee-a8b0cdb16493' })];
    await run();
    expect(raised()).toEqual([]);
  });

  test('a customer with payment receipts turned off rings nothing; one with no prefs row does', async () => {
    candidates = [row(A), row(B)];
    prefs = { 'cust-1': { payment_receipt: false }, 'cust-2': { payment_receipt: true } };
    await run();
    expect(raised().map((b) => b.opts.dedupeKey)).toEqual([keyOf(B)]);
  });

  test('a receipt job still in flight rings nothing; a completed or failed job with no receipt stamp rings', async () => {
    const C = '33333333-3333-4333-8333-333333333333';
    const D = '44444444-4444-4444-8444-444444444444';
    candidates = [row(A), row(B), row(C), row(D)];
    jobs = { [A]: { status: 'queued' }, [B]: { status: 'retry_scheduled' }, [C]: { status: 'failed' }, [D]: { status: 'completed', sms_result: { sent: false, reason: 'no-phone' } } };
    await check.runPaidVisitReceiptCheck({ now: NOW, conn: makeConn() });
    expect(raised().map((b) => b.opts.dedupeKey)).toEqual([keyOf(C), keyOf(D)]);
  });

  test('a carried receipt text never accepted rings only when the queue\'s own carried-receipt alert does not stand for it', async () => {
    candidates = [row(A), row(B)];
    jobs = {
      [A]: { status: 'completed', sms_result: { sent: false, reason: 'carried_by_visit_summary' } },
      [B]: { status: 'failed', sms_result: JSON.stringify({ sent: false, reason: 'carried_by_visit_summary' }) },
    };
    // The queue raised its alert for A only (its own raise can fail): B gets this bell, A keeps one bell.
    episodes.openAdminAlertKeys.mockImplementation(async (_conn, prefix) => (prefix === `summary-carried-receipt-email:${A}` ? [prefix] : []));
    await check.runPaidVisitReceiptCheck({ now: NOW, conn: makeConn() });
    expect(raised().map((b) => b.opts.dedupeKey)).toEqual([keyOf(B)]);
  });

  test('an operator send parked for reconciliation (outcome unknown) asks to check before sending again', async () => {
    const { RECONCILIATION_HOLD_ERROR } = require('../services/receipt-delivery-queue');
    candidates = [row(A)];
    jobs = { [A]: { status: 'failed', last_error: RECONCILIATION_HOLD_ERROR } };
    await run();
    const [bell] = raised();
    expect(bell.headline).toBe('Billing — check that Pat Tester got the receipt');
    expect(bell.why).toBe('The $125.00 invoice was paid by check at the Nov 18 visit; an earlier receipt send may have gone out.');
    expect(bell.opts.dedupeKey).toBe(keyOf(A));
  });

  test('a customer with no real name still gets a bell', async () => {
    candidates = [row(A, { first_name: null, last_name: null, payment_method: null })];
    await run();
    expect(raised()[0].headline).toBe("Billing — send a customer's receipt");
    expect(raised()[0].why).toBe('The $125.00 invoice was paid at the Nov 18 visit; no receipt has gone out.');
  });

  test('a name that breaks the alert rules becomes "a customer"', async () => {
    candidates = [row(A, { first_name: 'Pat 😀', last_name: 'T.' })];
    await run();
    expect(raised()[0].headline).toBe("Billing — send a customer's receipt");
  });

  test('a suppressed write (test customer) is not counted as raised', async () => {
    episodes.raiseAdminAlertWithReopen.mockResolvedValue({ id: null, suppressed: true, rang: false });
    expect(await run()).toMatchObject({ raised: 0, failed: 0 });
  });

  test('a standing bell\'s silent dedupe on the next pass is not counted as raised', async () => {
    episodes.raiseAdminAlertWithReopen.mockResolvedValue({ id: 'bell-1', deduped: true, rang: false });
    expect(await run()).toMatchObject({ candidates: 1, raised: 0, failed: 0 });
    expect(raised()).toHaveLength(1);
  });

  test('a job that delivered a leg rings nothing, even with no receipt stamp', async () => {
    candidates = [row(A), row(B)];
    jobs = {
      [A]: { status: 'completed', sms_result: { sent: false, reason: 'no-phone' }, email_result: { ok: true } },
      [B]: { status: 'failed', sms_result: { sent: true }, email_result: JSON.stringify({ ok: false, error: 'bounced' }) },
    };
    await run();
    expect(raised()).toEqual([]);
  });

  test('stands down while alert episodes are off', async () => {
    alertEpisodesLive.mockReturnValue(false);
    expect(await run()).toMatchObject({ skipped: 'episodes_off', raised: 0 });
    expect(raised()).toEqual([]);
    expect(episodes.openAdminAlertKeys).not.toHaveBeenCalled();
  });
});

describe('closing', () => {
  const open = (...ids) => episodes.openAdminAlertKeys.mockResolvedValue(ids.map(keyOf));

  test.each([
    ['receipt sent', { receipt_sent_at: new Date('2026-11-18T18:00:00Z') }, 'Receipt sent', null],
    ['receipt sent', { receipt_sms_sent_at: new Date('2026-11-18T18:00:00Z') }, 'Receipt sent', null],
    ['invoice void', { status: 'void' }, 'Invoice void', null],
    ['invoice archived', { archived_at: new Date('2026-11-18T18:00:00Z') }, 'Invoice archived', null],
    ['receipts turned off', {}, 'Receipts turned off', () => { prefs = { 'cust-1': { payment_receipt: false } }; }],
    ['receipt delivered', {}, 'Receipt delivered', () => { jobs = { [A]: { status: 'completed', email_result: { ok: true } } }; }],
    ['the visit text alert covers it', {}, 'The visit text alert covers it', () => { jobs = { [A]: { status: 'completed', sms_result: { sent: false, reason: 'carried_by_visit_summary' } } }; }],
  ])('%s closes the bell with a one-line resolution', async (why, change, resolution, arrange) => {
    candidates = [];
    invoices = [{ id: A, customer_id: 'cust-1', status: 'paid', receipt_sent_at: null, archived_at: null, ...change }];
    if (arrange) arrange();
    open(A);
    const out = await run();
    expect(closed()).toEqual([{ keys: [keyOf(A)], reason: why, resolution }]);
    expect(out.closed).toBe(1);
  });

  test('a receipt job still in flight keeps the bell open (it may still fail)', async () => {
    candidates = [];
    invoices = [{ id: A, customer_id: 'cust-1', status: 'paid', receipt_sent_at: null, archived_at: null }];
    jobs = { [A]: { status: 'queued' } };
    open(A);
    expect(await run()).toMatchObject({ closed: 0 });
    expect(closed()).toEqual([]);
  });

  test('a gone invoice or a key with no invoice id closes; a still-unreceipted paid invoice stands', async () => {
    candidates = [];
    invoices = [{ id: B, status: 'paid', receipt_sent_at: null, archived_at: null }];
    episodes.openAdminAlertKeys.mockResolvedValue([keyOf(A), keyOf(B), 'paid-visit-no-receipt:not-an-id']);
    await run();
    expect(closed().map((c) => [c.keys[0], c.reason])).toEqual([[keyOf(A), 'invoice gone'], ['paid-visit-no-receipt:not-an-id', 'invoice gone']]);
  });
});

describe('failing closed', () => {
  test('a failed receipt lookup raises nothing for that row, the other rows still run and the run throws at the end', async () => {
    candidates = [row(A), row(B)];
    const conn = makeConn();
    let calls = 0;
    const base = conn.getMockImplementation();
    conn.mockImplementation((table) => {
      const q = base(table);
      if (table === 'receipt_delivery_jobs') {
        const first = q.first;
        q.first = async () => { calls += 1; if (calls === 1) throw Object.assign(new Error('boom: secret-token'), { code: 'XX000' }); return first(); };
      }
      return q;
    });
    await expect(check.runPaidVisitReceiptCheck({ now: NOW, conn })).rejects.toThrow('1 paid-visit receipt check failed');
    expect(raised().map((b) => b.opts.dedupeKey)).toEqual([keyOf(B)]);
    expect(logger.warn).toHaveBeenCalledWith(`[paid-visit-receipt-check] check failed for invoice ${A}: XX000`);
    expect(JSON.stringify(logger.warn.mock.calls)).not.toContain('secret-token');
  });

  test('a failed invoice read for an open bell neither closes it nor stops the run, which throws', async () => {
    candidates = [];
    failing = { table: 'invoices' };
    episodes.openAdminAlertKeys.mockResolvedValue([keyOf(A)]);
    await expect(run()).rejects.toThrow('1 paid-visit receipt check failed');
    expect(closed()).toEqual([]);
  });
});
