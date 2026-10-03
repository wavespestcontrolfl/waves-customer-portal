/**
 * B16 follow-up: the lifecycle of the "autopay parked on card authentication" office alert
 * (server/services/autopay-sca-parked.js).
 *
 *   - alertAutopayScaParked treats a NULL notifyAdmin result (its real failure shape) as a
 *     failed alert, not a delivery;
 *   - resolveParkedMonthlyRows (Customer 360 Charge now collected the month) supersedes only
 *     the customer's open, unarmed failed rows of THAT obligation month, and closes the alert
 *     key of each row it resolved;
 *   - closeScaParkedAlerts recomputes the key from a payments row and never throws.
 */
const mockState = { updates: [], wheres: [], rawBindings: [], resolvedRows: [], alreadySuperseded: [], inserts: [], healthRows: [], healthUpdates: [] };

jest.mock('../models/db', () => {
  function paymentsBuilder() {
    const b = {};
    ['where', 'whereNot', 'whereNull', 'whereRaw', 'andWhere', 'orWhere'].forEach((m) => {
      b[m] = jest.fn((...args) => {
        if (typeof args[0] === 'function') args[0].call(b, b);
        else mockState.wheres.push([m, ...args]);
        return b;
      });
    });
    b.update = jest.fn((payload) => { mockState.updates.push(payload); return b; });
    b.returning = jest.fn(() => Promise.resolve(mockState.resolvedRows));
    // the "rows already superseded by this collecting payment" read
    b.select = jest.fn(() => Promise.resolve(mockState.alreadySuperseded));
    return b;
  }
  // customer_health_alerts with just enough semantics to evaluate the fallback close: a live row
  // set, and an update that applies the recorded filters (equality, whereIn, the source-prefix
  // test, and the PI / payment-id OR group) to it.
  function healthBuilder() {
    const f = { eq: {}, in: {}, prefix: null, pis: null, ids: null };
    const b = {};
    b.insert = jest.fn((row) => {
      mockState.inserts.push(row);
      mockState.healthRows.push({ status: 'new', ...row, trigger_data: typeof row.trigger_data === 'string' ? JSON.parse(row.trigger_data) : row.trigger_data });
      return Promise.resolve([1]);
    });
    b.where = jest.fn((arg) => { if (typeof arg === 'function') arg.call(b, b); else Object.assign(f.eq, arg); return b; });
    b.whereIn = jest.fn((col, vals) => { f.in[col] = vals; return b; });
    const raw = (sql, bindings) => {
      if (/starts_with\(trigger_data->>'source'/.test(sql)) f.prefix = bindings[0];
      else if (/'stripe_payment_intent_id' = ANY/.test(sql)) f.pis = bindings[0];
      else if (/'payment_id' = ANY/.test(sql)) f.ids = bindings[0];
      return b;
    };
    b.whereRaw = jest.fn(raw);
    b.orWhereRaw = jest.fn(raw);
    b.update = jest.fn((payload) => {
      const hit = mockState.healthRows.filter((r) => Object.entries(f.eq).every(([k, v]) => String(r[k]) === String(v))
        && Object.entries(f.in).every(([k, v]) => v.includes(r[k]))
        && String(r.trigger_data?.source || '').startsWith(f.prefix || '')
        && ((f.pis || []).includes(String(r.trigger_data?.stripe_payment_intent_id)) || (f.ids || []).includes(String(r.trigger_data?.payment_id))));
      hit.forEach((r) => Object.assign(r, payload));
      mockState.healthUpdates.push(payload);
      return Promise.resolve(hit.length);
    });
    return b;
  }
  const db = jest.fn((table) => {
    if (table === 'payments') return paymentsBuilder();
    if (table === 'customer_health_alerts') return healthBuilder();
    throw new Error(`unexpected table ${table}`);
  });
  db.raw = jest.fn((sql, bindings) => { mockState.rawBindings.push([sql, bindings]); return { sql, bindings }; });
  db.fn = { now: () => 'NOW' };
  return db;
});
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
jest.mock('../services/notification-service', () => ({ notifyAdmin: jest.fn(), _private: { doneColumns: jest.fn(() => ({ done_at: 'now' })) } }));
jest.mock('../services/admin-alert-episodes', () => ({ closeAdminAlertKeys: jest.fn(async () => 1) }));

const NotificationService = require('../services/notification-service');
const { closeAdminAlertKeys } = require('../services/admin-alert-episodes');
const logger = require('../services/logger');
const Sca = require('../services/autopay-sca-parked');

const CUSTOMER = { id: 'cust-1', first_name: 'Pat', last_name: 'Synthetic' };
const SCA_ERR = () => Object.assign(new Error('Customer authentication required'), {
  code: 'STRIPE_REQUIRES_ACTION',
  stripePaymentIntentId: 'pi_sca_1',
  paymentRecord: { id: 'pay-sca-1', amount: '89.00', stripe_payment_intent_id: 'pi_sca_1' },
});
const PERIOD = { monthKey: '2026-10', monthStart: '2026-10-01', monthEnd: '2026-10-31' };

beforeEach(() => {
  jest.clearAllMocks();
  Object.assign(mockState, { updates: [], wheres: [], rawBindings: [], resolvedRows: [], alreadySuperseded: [], inserts: [], healthRows: [], healthUpdates: [] });
  NotificationService.notifyAdmin.mockResolvedValue({ id: 'n-1' });
});

describe('alertAutopayScaParked', () => {
  test('a written (or already standing) row is delivered: true, no fallback', async () => {
    await expect(Sca.alertAutopayScaParked(CUSTOMER, SCA_ERR(), { amount: 89, source: 'autopay' })).resolves.toBe(true);
    expect(NotificationService.notifyAdmin).toHaveBeenCalledTimes(1);
    expect(NotificationService.notifyAdmin.mock.calls[0][3].dedupeKey).toBe(Sca.scaParkedAlertKey('cust-1', 'pi_sca_1'));
    expect(mockState.inserts).toHaveLength(0);
  });

  test.each([
    ['resolves null (insert failed inside notifyAdmin)', () => NotificationService.notifyAdmin.mockResolvedValue(null)],
    ['rejects', () => NotificationService.notifyAdmin.mockRejectedValue(new Error('down'))],
  ])('notifyAdmin %s: false, error-level log, durable health-alert fallback', async (_label, arrange) => {
    arrange();
    await expect(Sca.alertAutopayScaParked(CUSTOMER, SCA_ERR(), { amount: 89, source: 'autopay' })).resolves.toBe(false);
    expect(logger.error.mock.calls.some((c) => /office alert NOT filed/.test(String(c[0])))).toBe(true);
    expect(mockState.inserts).toEqual([expect.objectContaining({
      customer_id: 'cust-1', alert_type: 'payment_failure', severity: 'high',
      title: expect.stringContaining('$89.00'),
    })]);
  });

  test('when even the fallback cannot be written it still resolves false (never throws) and logs CRITICAL', async () => {
    NotificationService.notifyAdmin.mockResolvedValue(null);
    const db = require('../models/db');
    db.mockImplementationOnce(() => { throw new Error('db down'); });
    await expect(Sca.alertAutopayScaParked(CUSTOMER, SCA_ERR(), { amount: 89, source: 'autopay' })).resolves.toBe(false);
    expect(logger.error.mock.calls.some((c) => /CRITICAL/.test(String(c[0])))).toBe(true);
  });
});

describe('resolveParkedMonthlyRows (Charge now collected the month)', () => {
  test('supersedes the open unarmed failed rows of that month, scoped to the customer, and closes each alert key', async () => {
    mockState.resolvedRows = [
      { id: 'pay-sca-1', customer_id: 'cust-1', stripe_payment_intent_id: 'pi_sca_1' },
      { id: 'pay-final-2', customer_id: 'cust-1', stripe_payment_intent_id: null },
    ];
    const resolved = await Sca.resolveParkedMonthlyRows('cust-1', PERIOD, 'pay-new');

    expect(resolved).toHaveLength(2);
    expect(mockState.updates).toEqual([expect.objectContaining({ superseded_by_payment_id: 'pay-new' })]);
    // scope: this customer, failed, not already superseded, not armed, not the collecting row, this month
    const wheres = JSON.stringify(mockState.wheres);
    expect(wheres).toContain('"customer_id":"cust-1"');
    expect(wheres).toContain('"status":"failed"');
    expect(mockState.wheres).toEqual(expect.arrayContaining([
      ['whereNull', 'superseded_by_payment_id'],
      ['whereNull', 'next_retry_at'],
      ['whereNot', { id: 'pay-new' }],
      ['whereRaw', "metadata->>'billed_month' = ?", ['2026-10']],
      ['andWhere', 'payment_date', '>=', '2026-10-01'],
      ['andWhere', 'payment_date', '<=', '2026-10-31'],
      ['andWhere', 'description', 'like', '%WaveGuard Monthly%'],
    ]));
    expect(closeAdminAlertKeys).toHaveBeenCalledTimes(1);
    const keys = closeAdminAlertKeys.mock.calls[0][1];
    expect(keys).toEqual(expect.arrayContaining([
      'autopay-sca-parked:cust-1:pi_sca_1', 'autopay-sca-parked:cust-1:pay-sca-1', 'autopay-sca-parked:cust-1:pay-final-2',
    ]));
    expect(closeAdminAlertKeys.mock.calls[0][2]).toBe('charge_collected');
  });

  test('nothing to resolve: no alert close', async () => {
    mockState.resolvedRows = [];
    await expect(Sca.resolveParkedMonthlyRows('cust-1', PERIOD, 'pay-new')).resolves.toEqual([]);
    expect(closeAdminAlertKeys).not.toHaveBeenCalled();
  });
});

describe('closeScaParkedAlerts', () => {
  test('recomputes the key from the payments row (PI and row id)', async () => {
    await Sca.closeScaParkedAlerts([{ id: 'pay-1', customer_id: 'cust-1', stripe_payment_intent_id: 'pi_x' }], 'charge_collected');
    expect(closeAdminAlertKeys.mock.calls[0][1]).toEqual(['autopay-sca-parked:cust-1:pi_x', 'autopay-sca-parked:cust-1:pay-1']);
  });

  test('a close failure never throws', async () => {
    closeAdminAlertKeys.mockRejectedValueOnce(new Error('db down'));
    await expect(Sca.closeScaParkedAlerts([{ id: 'p', customer_id: 'c', stripe_payment_intent_id: 'pi' }], 'x')).resolves.toBe(0);
  });
});

// The ONE entry point for "a payment is now paid": Charge now (paid at once) and the Stripe
// succeeded hook (an ACH Charge now replacement moving processing -> paid) both call it.
describe('settleParkedForPaidPayment', () => {
  // What an ACH Charge now replacement row looks like AFTER the succeeded webhook flipped it:
  // billed_month persisted from the charge, payment_date restamped to the (later) settlement day.
  const settledAchReplacement = (overrides = {}) => ({
    id: 'pay-ach-new', customer_id: 'cust-1', status: 'paid', stripe_payment_intent_id: 'pi_ach_new',
    payment_date: '2026-11-02', description: 'Manual charge — WaveGuard Silver',
    metadata: JSON.stringify({ billed_month: '2026-10', payment_state: 'paid', settled_event_at: '2026-11-02T14:00:00.000Z' }),
    ...overrides,
  });

  test('processing -> paid settlement of an ACH replacement: supersedes the parked row for ITS month and closes the ORIGINAL alert', async () => {
    mockState.resolvedRows = [{ id: 'pay-sca-1', customer_id: 'cust-1', stripe_payment_intent_id: 'pi_sca_orig' }];
    const resolved = await Sca.settleParkedForPaidPayment(settledAchReplacement());

    expect(resolved).toHaveLength(1);
    expect(mockState.updates).toEqual([expect.objectContaining({ superseded_by_payment_id: 'pay-ach-new' })]);
    // the month comes from the persisted billed_month, never from the settlement date (November)
    expect(mockState.wheres).toEqual(expect.arrayContaining([
      ['whereRaw', "metadata->>'billed_month' = ?", ['2026-10']],
      ['andWhere', 'payment_date', '>=', '2026-10-01'],
      ['andWhere', 'payment_date', '<=', '2026-10-31'],
      ['whereNot', { id: 'pay-ach-new' }],
    ]));
    const closedKeys = closeAdminAlertKeys.mock.calls.flatMap((c) => c[1]);
    expect(closedKeys).toEqual(expect.arrayContaining(['autopay-sca-parked:cust-1:pi_sca_orig', 'autopay-sca-parked:cust-1:pay-sca-1']));
  });

  test('a webhook replay is a no-op: nothing left to supersede, so no further close of resolved rows and no error', async () => {
    mockState.resolvedRows = [{ id: 'pay-sca-1', customer_id: 'cust-1', stripe_payment_intent_id: 'pi_sca_orig' }];
    await Sca.settleParkedForPaidPayment(settledAchReplacement());
    closeAdminAlertKeys.mockClear();
    mockState.resolvedRows = []; // the update (whereNull superseded_by_payment_id) now matches no row
    await expect(Sca.settleParkedForPaidPayment(settledAchReplacement())).resolves.toEqual([]);
    const closedKeys = closeAdminAlertKeys.mock.calls.flatMap((c) => c[1]);
    expect(closedKeys).not.toContain('autopay-sca-parked:cust-1:pi_sca_orig');
  });

  test.each([
    ['a non-monthly payment (no billed_month stamp)', { metadata: JSON.stringify({ payment_state: 'paid' }) }],
    ['a payment with a malformed billed_month', { metadata: JSON.stringify({ billed_month: 'October' }) }],
    ['a payment with no metadata', { metadata: null }],
  ])('%s settling supersedes nothing (it only closes an alert keyed to its own PI)', async (_label, overrides) => {
    mockState.resolvedRows = [{ id: 'pay-sca-1', customer_id: 'cust-1', stripe_payment_intent_id: 'pi_sca_orig' }];
    await expect(Sca.settleParkedForPaidPayment(settledAchReplacement(overrides))).resolves.toEqual([]);
    expect(mockState.updates).toHaveLength(0);
    expect(closeAdminAlertKeys.mock.calls.flatMap((c) => c[1])).not.toContain('autopay-sca-parked:cust-1:pi_sca_orig');
  });

  test('a payment that is not paid (still processing, failed) does nothing', async () => {
    await expect(Sca.settleParkedForPaidPayment(settledAchReplacement({ status: 'processing' }))).resolves.toEqual([]);
    expect(mockState.updates).toHaveLength(0);
    expect(closeAdminAlertKeys).not.toHaveBeenCalled();
  });

  test('a failure in the step never throws (it cannot fail the settlement or the charge)', async () => {
    const db = require('../models/db');
    // 1st db() call: the own-PI close's health read (let it through); 2nd: the supersede update
    db.mockImplementationOnce(db.getMockImplementation());
    db.mockImplementationOnce(() => { throw new Error('db down'); });
    await expect(Sca.settleParkedForPaidPayment(settledAchReplacement())).resolves.toEqual([]);
    expect(logger.error.mock.calls.some((c) => /could not resolve parked rows/.test(String(c[0])))).toBe(true);
  });
});

// The supersede commits BEFORE the alert close, and the next call no longer selects those rows.
// So a close that failed must be retried from the rows already superseded by this payment.
describe('recoverable alert close (supersede committed, close failed)', () => {
  const PAID = { id: 'pay-new', customer_id: 'cust-1', status: 'paid', metadata: JSON.stringify({ billed_month: '2026-10' }) };
  const ORIGINAL = { id: 'pay-sca-1', customer_id: 'cust-1', stripe_payment_intent_id: 'pi_sca_orig' };

  test('close throws after the supersede committed: logged at error level; a replay closes the original keys', async () => {
    mockState.resolvedRows = [ORIGINAL];
    closeAdminAlertKeys.mockRejectedValueOnce(new Error('notifications down'));
    await expect(Sca.settleParkedForPaidPayment(PAID)).resolves.toHaveLength(1);
    expect(mockState.updates).toHaveLength(1); // the supersede committed
    expect(logger.error.mock.calls.some((c) => /could not close the parked-charge alert/.test(String(c[0])))).toBe(true);

    // replay: the update now matches nothing (row is already superseded), but the row IS superseded by this payment
    closeAdminAlertKeys.mockClear();
    mockState.resolvedRows = [];
    mockState.alreadySuperseded = [ORIGINAL];
    await expect(Sca.settleParkedForPaidPayment(PAID)).resolves.toEqual([]);
    expect(closeAdminAlertKeys.mock.calls.flatMap((c) => c[1])).toEqual(expect.arrayContaining([
      'autopay-sca-parked:cust-1:pi_sca_orig', 'autopay-sca-parked:cust-1:pay-sca-1',
    ]));
    expect(mockState.wheres).toEqual(expect.arrayContaining([
      ['where', { customer_id: 'cust-1', superseded_by_payment_id: 'pay-new' }],
      ['whereNot', { id: 'pay-new' }],
    ]));
  });

  test('a row superseded by a DIFFERENT payment is not this payment\'s to close (query is scoped to this payment id)', async () => {
    await Sca.settleParkedForPaidPayment(PAID);
    const scoped = mockState.wheres.filter((w) => w[0] === 'where' && w[1] && w[1].superseded_by_payment_id);
    expect(scoped).toEqual([['where', { customer_id: 'cust-1', superseded_by_payment_id: 'pay-new' }]]);
  });

  test('closing keys that are already closed is a no-op: the real closer only touches rows not already auto-cleared', async () => {
    const { closeAdminAlertKeys: realClose } = jest.requireActual('../services/admin-alert-episodes');
    const calls = { raw: [], update: null };
    const qb = {};
    qb.where = jest.fn(() => qb);
    qb.whereRaw = jest.fn((sql) => { calls.raw.push(sql); return qb; });
    qb.update = jest.fn((payload) => { calls.update = payload; return Promise.resolve(0); });
    const conn = jest.fn(() => qb);
    conn.raw = jest.fn((sql, b) => ({ sql, b }));
    await expect(realClose(conn, ['autopay-sca-parked:cust-1:pi_sca_orig'], 'charge_collected')).resolves.toBe(0);
    // already-cleared rows are excluded by the predicate, so nothing is rewritten, re-versioned or re-rung
    expect(calls.raw.some((sql) => /autoCleared' IS DISTINCT FROM 'true'/.test(sql))).toBe(true);
  });
});

// When the bell insert fails, the fallback customer_health_alerts row tells staff to collect by hand.
// Collection must resolve it (the table's live states are new / acknowledged; resolved is
// status 'resolved' + resolved_at, as health-alerts.updateAlert writes it).
describe('health-alert fallback is resolved on collection', () => {
  const PAID = { id: 'pay-new', customer_id: 'cust-1', status: 'paid', metadata: JSON.stringify({ billed_month: '2026-10' }) };
  const row = (over) => ({ customer_id: 'cust-1', alert_type: 'payment_failure', status: 'new',
    trigger_data: { payment_id: 'x', stripe_payment_intent_id: 'pi_x', source: 'autopay_sca_parked_autopay' }, ...over });

  test('fallback created (bell insert returned null) -> settlement resolves it; replay is a no-op; others untouched', async () => {
    NotificationService.notifyAdmin.mockResolvedValue(null);
    await Sca.alertAutopayScaParked(CUSTOMER, SCA_ERR(), { amount: 89, source: 'autopay' });
    expect(mockState.healthRows).toHaveLength(1);
    // the fallback carries the identifiers the closer matches on
    expect(mockState.healthRows[0].trigger_data).toMatchObject({ payment_id: 'pay-sca-1', stripe_payment_intent_id: 'pi_sca_1' });
    const fallback = mockState.healthRows[0];
    // rows that must NOT be touched
    const otherCustomer = row({ customer_id: 'cust-2', trigger_data: { payment_id: 'pay-sca-1', stripe_payment_intent_id: 'pi_sca_1', source: 'autopay_sca_parked_autopay' } });
    const otherPi = row({ trigger_data: { payment_id: 'pay-other', stripe_payment_intent_id: 'pi_other', source: 'autopay_sca_parked_autopay' } });
    const ambiguousShape = row({ trigger_data: { payment_id: 'pay-sca-1', stripe_payment_intent_id: 'pi_sca_1', source: 'autopay_ambiguous_parked' } });
    const alreadyDone = row({ status: 'dismissed', trigger_data: { payment_id: 'pay-sca-1', stripe_payment_intent_id: 'pi_sca_1', source: 'autopay_sca_parked_autopay' } });
    mockState.healthRows.push(otherCustomer, otherPi, ambiguousShape, alreadyDone);

    // the parked row is superseded by the collecting payment
    mockState.resolvedRows = [{ id: 'pay-sca-1', customer_id: 'cust-1', stripe_payment_intent_id: 'pi_sca_1' }];
    await Sca.settleParkedForPaidPayment(PAID);

    expect(fallback).toMatchObject({ status: 'resolved', resolved_by: 'system', resolved_at: 'NOW' });
    expect(otherCustomer.status).toBe('new');
    expect(otherPi.status).toBe('new');
    expect(ambiguousShape.status).toBe('new');
    expect(alreadyDone.status).toBe('dismissed');

    // replay: only live rows are selected, so nothing is rewritten
    mockState.healthUpdates.length = 0;
    const resolvedAt = fallback.resolved_at;
    mockState.resolvedRows = [];
    mockState.alreadySuperseded = [{ id: 'pay-sca-1', customer_id: 'cust-1', stripe_payment_intent_id: 'pi_sca_1' }];
    await Sca.settleParkedForPaidPayment(PAID);
    expect(fallback).toMatchObject({ status: 'resolved', resolved_at: resolvedAt });
    expect(otherPi.status).toBe('new');
  });

  test('the payment\'s own PI (the original parked PI settling) also resolves its fallback', async () => {
    const own = row({ trigger_data: { payment_id: 'pay-sca-1', stripe_payment_intent_id: 'pi_sca_1', source: 'autopay_sca_parked_autopay_retry' } });
    mockState.healthRows.push(own);
    await Sca.settleParkedForPaidPayment({ id: 'pay-sca-1', customer_id: 'cust-1', status: 'paid', stripe_payment_intent_id: 'pi_sca_1', metadata: '{}' });
    expect(own.status).toBe('resolved');
  });

  test('a failure resolving the health alert is logged at error level and does not block the bell close', async () => {
    const db = require('../models/db');
    db.mockImplementationOnce(() => { throw new Error('db down'); }); // the health update
    await expect(Sca.closeScaParkedAlerts([{ id: 'p', customer_id: 'c', stripe_payment_intent_id: 'pi' }], 'x')).resolves.toBe(1);
    expect(logger.error.mock.calls.some((c) => /could not resolve the parked-charge health alert/.test(String(c[0])))).toBe(true);
    expect(closeAdminAlertKeys).toHaveBeenCalledTimes(1);
  });
});

// GATE_ADMIN_BELL_POLICY: with the gate on and no owner override for the billing category, the policy
// silences any admin notification without the explicit site tag, and notifyAdmin resolves a truthy
// { id: null, suppressed: true } with NO row. That is not a filed alert.
describe('bell policy: a needs-you money alert rings, and suppression is not "filed"', () => {
  test('the raise opts the alert into the bell (bell: true), which the policy honors with no owner override', async () => {
    await Sca.alertAutopayScaParked(CUSTOMER, SCA_ERR(), { amount: 89, source: 'autopay' });
    const opts = NotificationService.notifyAdmin.mock.calls[0][3];
    expect(opts.bell).toBe(true);

    const { bellAllowed } = jest.requireActual('../services/notification-bell-policy');
    // exactly what notifyAdmin hands the policy: category + the emitter's bell / bellDefault options
    await expect(bellAllowed({ category: NotificationService.notifyAdmin.mock.calls[0][0], options: { bell: opts.bell, bellDefault: opts.bellDefault } })).resolves.toBe(true);
    // the bug: without the tag the billing category is silenced by default
    await expect(bellAllowed({ category: 'billing', options: {} })).resolves.toBe(false);
  });

  test.each([
    ['policy suppression', { id: null, suppressed: true, reason: 'bell_policy' }],
    ['internal-test-customer suppression', { id: null, suppressed: true }],
    ['a result with no id', { id: null }],
  ])('%s is NOT a filed alert: returns false, error log, health-alert fallback written', async (_label, sentinel) => {
    NotificationService.notifyAdmin.mockResolvedValue(sentinel);
    await expect(Sca.alertAutopayScaParked(CUSTOMER, SCA_ERR(), { amount: 89, source: 'autopay' })).resolves.toBe(false);
    expect(logger.error.mock.calls.some((c) => /office alert NOT filed/.test(String(c[0])))).toBe(true);
    expect(mockState.inserts).toHaveLength(1);
  });

  test('a standing row of the same key (deduped: has an id) IS filed', async () => {
    NotificationService.notifyAdmin.mockResolvedValue({ id: 'n-9', deduped: true });
    await expect(Sca.alertAutopayScaParked(CUSTOMER, SCA_ERR(), { amount: 89, source: 'autopay' })).resolves.toBe(true);
    expect(mockState.inserts).toHaveLength(0);
  });
});
