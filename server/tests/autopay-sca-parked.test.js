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
const mockState = { updates: [], wheres: [], rawBindings: [], resolvedRows: [], inserts: [] };

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
    return b;
  }
  const db = jest.fn((table) => {
    if (table === 'payments') return paymentsBuilder();
    if (table === 'customer_health_alerts') return { insert: jest.fn((row) => { mockState.inserts.push(row); return Promise.resolve([1]); }) };
    throw new Error(`unexpected table ${table}`);
  });
  db.raw = jest.fn((sql, bindings) => { mockState.rawBindings.push([sql, bindings]); return { sql, bindings }; });
  return db;
});
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
jest.mock('../services/notification-service', () => ({ notifyAdmin: jest.fn() }));
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
  Object.assign(mockState, { updates: [], wheres: [], rawBindings: [], resolvedRows: [], inserts: [] });
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
