// Audit repro r2-cancel-plan-and-offboarding-4: cancelSignupAndRefundDeposit
// reports the CUMULATIVE ledger refunded_amount (which includes a partial
// dashboard refund taken weeks earlier) as "refunded today" in the customer
// email and admin bell, and compares that cumulative against the preview's
// per-run remainder for the "refund complete" check.
// Harness copied from server/tests/customer-offboarding.test.js (unedited).

let mockDbHandler = () => { throw new Error('db handler not configured'); };
const callOrder = [];

jest.mock('../models/db', () => {
  const mock = jest.fn((...args) => mockDbHandler(...args));
  mock.fn = { now: jest.fn(() => 'NOW') };
  mock.transaction = jest.fn(async (cb) => cb(mock));
  mock.raw = jest.fn(async () => ({ rows: [] }));
  return mock;
});
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

const mockVoidInvoice = jest.fn(async (id) => { callOrder.push(`void:${id}`); return { invoice_number: `WPC-${id}` }; });
jest.mock('../services/invoice', () => ({
  voidInvoice: (...args) => mockVoidInvoice(...args),
  voidOpenInvoicesForCancelledService: jest.fn(async () => {}),
  CANCELLED_SERVICE_RESOLVED_STATUSES: ['void', 'paid', 'cancelled'],
}));
jest.mock('../services/job-status', () => ({ transitionJobStatus: jest.fn(async () => {}) }));
jest.mock('../services/tech-visit-notifications', () => ({ notifyVisitCancelled: jest.fn() }));
jest.mock('../services/appointment-reminders', () => ({ handleCancellation: jest.fn(async () => {}) }));
jest.mock('../services/call-booking-catalog', () => ({ cancelCallFollowUpsForParentCancel: jest.fn(async () => 0) }));
jest.mock('../services/estimate-card-holds', () => ({ handleCardHoldCancellation: jest.fn(async () => ({ handled: false, reason: 'no_hold' })) }));
jest.mock('../services/appointment-card-request', () => ({ handleAppointmentCardCancellation: jest.fn(async () => ({ handled: false, released: true, reason: 'no_card_request' })) }));
jest.mock('../services/track-transitions', () => ({ cancel: jest.fn(async () => ({ ok: true })) }));
jest.mock('../services/plan-rate-ledger', () => ({ syncScalarWriteToLedger: jest.fn(async () => {}) }));

const mockRefundUnconsumed = jest.fn();
jest.mock('../services/estimate-deposits', () => ({ refundUnconsumedDeposits: (...args) => mockRefundUnconsumed(...args) }));
const mockSendEmail = jest.fn(async () => ({ ok: true }));
jest.mock('../services/payment-lifecycle-email', () => ({ sendCancellationRefundIssued: (...args) => mockSendEmail(...args) }));
const mockTriggerNotification = jest.fn(async () => {});
jest.mock('../services/notification-triggers', () => ({ triggerNotification: (...args) => mockTriggerNotification(...args) }));

const CustomerOffboarding = require('../services/customer-offboarding');

function chain({ rows = [], first = undefined, update = 1 } = {}) {
  const c = {};
  ['where', 'whereIn', 'whereNot', 'whereNotIn', 'whereNull', 'whereNotNull', 'orWhereNotNull', 'whereRaw', 'select', 'orderBy', 'leftJoin', 'join'].forEach((m) => { c[m] = jest.fn(() => c); });
  c.first = jest.fn(async () => first);
  c.update = jest.fn(async () => update);
  c.insert = jest.fn(async () => [1]);
  c.then = (resolve, reject) => Promise.resolve(rows).then(resolve, reject);
  return c;
}
function setDbQueues(queues) {
  const tableQueues = new Map(Object.entries(queues));
  mockDbHandler = (table) => {
    const queue = tableQueues.get(table);
    if (!queue || !queue.length) throw new Error(`Unexpected db table ${table} (queue exhausted)`);
    return queue.shift();
  };
}

const CUSTOMER = { id: 'cust-1', first_name: 'Taylor', last_name: 'Morgan', waveguard_tier: 'Bronze', billing_mode: 'annual_prepay', active: true };
const UNPAID_INVOICE = { id: 'inv-1', invoice_number: 'WPC-2026-0001', status: 'sent', total: '371.00', payment_recorded_at: null, annual_prepay_term_id: 'term-1', line_items: '[]' };
const PENDING_TERM = { id: 'term-1', status: 'payment_pending', plan_label: 'WaveGuard Bronze — Annual Prepay', prepay_invoice_id: 'inv-1', prepay_amount: '420.00' };
const VISITS = [{ id: 'v-1', status: 'pending', scheduled_date: '2026-07-09', service_type: 'quarterly', track_state: null }];

const visitChains = (status = 'pending', track = null) => [
  chain({ first: { status, track_state: track } }),
  chain({ first: { track_state: track } }),
  chain({ update: 1 }),
];

// Received (uncredited) deposits: preview does no invoice credit scan, so the
// invoices queue is: term prepay lookup (first) → paid-visit check → execute-time re-queries.
function queues({ deposits, ledgerRows }) {
  return {
    customers: [chain({ first: CUSTOMER }), chain({ first: { billing_mode: null } }), chain({ update: 1 }), chain({ first: { first_name: 'Taylor', last_name: 'Morgan' } })],
    'estimate_deposits as ed': [chain({ rows: deposits })],
    estimate_deposits: [chain({ rows: ledgerRows })],
    invoices: [chain({ first: UNPAID_INVOICE }), chain({ rows: [] }), chain({ rows: [] }), chain({ rows: [] })],
    annual_prepay_terms: [chain({ rows: [PENDING_TERM] })],
    scheduled_services: [
      chain({ rows: VISITS }), chain({ rows: [] }),
      chain({ rows: [{ id: 'v-1', customer_id: 'cust-1', recurring_pattern: 'quarterly' }] }), chain({ update: 1 }),
      ...visitChains('pending', null),
      chain({ rows: [] }), chain({ rows: [] }),
    ],
    'estimate_card_holds as h': [chain({ rows: [] }), chain({ rows: [] })],
    appointment_reminders: [chain({ first: undefined })],
    recurring_plan_alerts: [chain(), chain()],
  };
}

beforeEach(() => { jest.clearAllMocks(); callOrder.length = 0; });

describe('r2-cancel-plan-and-offboarding-4 — cumulative refunded_amount reported as this run\'s refund', () => {
  it('a $200 deposit with a $50 prior dashboard refund: sweep returns 150, email/bell must say 150 (currently 200)', async () => {
    const deposit = { id: 'dep-1', estimate_id: 'est-1', status: 'received', amount: '200.00', credited_amount: '0.00', refunded_amount: '50.00', card_surcharge: '0.00', credited_invoice_id: null, customer_id: 'cust-1' };
    mockRefundUnconsumed.mockResolvedValueOnce({ refunded: 150 });
    // Terminal stamp is cumulative (estimate-deposits.js:1116): 50 + 150 = 200.
    setDbQueues(queues({ deposits: [deposit], ledgerRows: [{ refunded_amount: '200.00' }] }));

    const result = await CustomerOffboarding.cancelSignupAndRefundDeposit('cust-1');
    expect(result.refunded).toBe(150); // the sweep's own figure is right
    expect(result.refundIncomplete).toBeUndefined();
    expect(mockSendEmail).toHaveBeenCalledTimes(1);
    expect(mockSendEmail.mock.calls[0][0].refundAmount).toBe(150);
    expect(mockTriggerNotification).toHaveBeenCalledWith('payment_refunded', expect.objectContaining({ amount: 150 }));
  });

  it('multi-deposit: prior partial refund on dep-1 masks a FAILED dep-2 refund — email sent as complete', async () => {
    const dep1 = { id: 'dep-1', estimate_id: 'est-1', status: 'received', amount: '200.00', credited_amount: '0.00', refunded_amount: '100.00', card_surcharge: '0.00', credited_invoice_id: null, customer_id: 'cust-1' };
    const dep2 = { id: 'dep-2', estimate_id: 'est-2', status: 'received', amount: '100.00', credited_amount: '0.00', refunded_amount: '0.00', card_surcharge: '0.00', credited_invoice_id: null, customer_id: 'cust-1' };
    // preview.refundTotal = 100 (dep-1 remainder) + 100 (dep-2) = 200
    mockRefundUnconsumed
      .mockResolvedValueOnce({ refunded: 100 }) // est-1 remainder refunded → ledger 200
      .mockResolvedValueOnce({ refunded: 0 }); // est-2 Stripe failure → ledger stays 0
    setDbQueues(queues({ deposits: [dep1, dep2], ledgerRows: [{ refunded_amount: '200.00' }, { refunded_amount: '0.00' }] }));

    const result = await CustomerOffboarding.cancelSignupAndRefundDeposit('cust-1');
    expect(result.refunded).toBe(100);
    // Only 100 of the 200 this run owed moved — this must be flagged partial.
    expect(result.refundIncomplete).toBeDefined();
    expect(mockSendEmail).not.toHaveBeenCalled();
  });
});
