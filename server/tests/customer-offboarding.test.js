// Deposit-stage cancel-signup orchestration: eligibility fails closed, the
// void-before-refund order holds, the refund is face-only, and the email
// states the ledger-verified refunded total.

let mockDbHandler = () => { throw new Error('db handler not configured'); };
const callOrder = [];

jest.mock('../models/db', () => {
  const mock = jest.fn((...args) => mockDbHandler(...args));
  mock.fn = { now: jest.fn(() => 'NOW') };
  mock.transaction = jest.fn(async (cb) => cb({}));
  return mock;
});
jest.mock('../services/logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
}));

const mockVoidInvoice = jest.fn(async (id) => {
  callOrder.push(`void:${id}`);
  return { invoice_number: `WPC-${id}` };
});
const mockVoidOpenInvoices = jest.fn(async () => {});
jest.mock('../services/invoice', () => ({
  voidInvoice: (...args) => mockVoidInvoice(...args),
  voidOpenInvoicesForCancelledService: (...args) => mockVoidOpenInvoices(...args),
}));

const mockTransition = jest.fn(async ({ jobId }) => { callOrder.push(`cancel:${jobId}`); });
jest.mock('../services/job-status', () => ({
  transitionJobStatus: (...args) => mockTransition(...args),
}));
jest.mock('../services/appointment-reminders', () => ({
  handleCancellation: jest.fn(async () => {}),
}));
jest.mock('../services/call-booking-catalog', () => ({
  cancelCallFollowUpsForParentCancel: jest.fn(async () => 0),
}));
const mockCardHold = jest.fn(async () => ({ handled: false }));
jest.mock('../services/estimate-card-holds', () => ({
  handleCardHoldCancellation: (...args) => mockCardHold(...args),
}));

const mockTrackCancel = jest.fn(async () => ({ ok: true }));
jest.mock('../services/track-transitions', () => ({
  cancel: (...args) => mockTrackCancel(...args),
}));

const mockRefundUnconsumed = jest.fn(async () => {
  callOrder.push('refund');
  return { refunded: 49 };
});
jest.mock('../services/estimate-deposits', () => ({
  refundUnconsumedDeposits: (...args) => mockRefundUnconsumed(...args),
}));

const mockSendEmail = jest.fn(async () => ({ ok: true }));
jest.mock('../services/payment-lifecycle-email', () => ({
  sendCancellationRefundIssued: (...args) => mockSendEmail(...args),
}));

const mockTriggerNotification = jest.fn(async () => {});
jest.mock('../services/notification-triggers', () => ({
  triggerNotification: (...args) => mockTriggerNotification(...args),
}));

const CustomerOffboarding = require('../services/customer-offboarding');

function chain({ rows = [], first = undefined, update = 1 } = {}) {
  const c = {};
  ['where', 'whereIn', 'whereNot', 'whereNotIn', 'whereNull', 'whereNotNull', 'orWhereNotNull', 'select', 'orderBy'].forEach((m) => {
    c[m] = jest.fn(() => c);
  });
  c.first = jest.fn(async () => first);
  c.update = jest.fn(async () => update);
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
const DEPOSIT_CREDITED = {
  id: 'dep-1', estimate_id: 'est-1', status: 'credited', amount: '49.00',
  credited_amount: '49.00', refunded_amount: '0.00', card_surcharge: '0.00',
  credited_invoice_id: 'inv-1', customer_id: 'cust-1',
};
const UNPAID_INVOICE = {
  id: 'inv-1', invoice_number: 'WPC-2026-0001', status: 'sent', total: '371.00',
  payment_recorded_at: null, annual_prepay_term_id: 'term-1',
  line_items: JSON.stringify([
    { amount: 420, description: 'plan' },
    { amount: -49, category: 'deposit_credit', estimate_id: 'est-1' },
  ]),
};
const PENDING_TERM = {
  id: 'term-1', status: 'payment_pending', plan_label: 'WaveGuard Bronze — Annual Prepay',
  prepay_invoice_id: 'inv-1', prepay_amount: '420.00', term_start: null, term_end: null,
};
const VISITS = [
  { id: 'v-1', status: 'pending', scheduled_date: '2026-07-09', service_type: 'quarterly', track_state: null },
  { id: 'v-2', status: 'confirmed', scheduled_date: '2026-10-09', service_type: 'quarterly', track_state: 'scheduled' },
];

// Preview's db-call order: customers → estimate_deposits → invoices (credit
// scan per credited deposit, + stamped fallback when the line-scan misses)
// → annual_prepay_terms → invoices (per term not already mapped) →
// scheduled_services (cancellable, in-progress) → invoices (paid visit
// invoices, only when cancellable visits exist).
function previewQueues({ customer = CUSTOMER, deposits = [DEPOSIT_CREDITED], invoicesQueue, terms = [PENDING_TERM], visits = VISITS, inProgress = [] } = {}) {
  return {
    customers: [chain({ first: customer })],
    estimate_deposits: [chain({ rows: deposits })],
    invoices: invoicesQueue || [chain({ rows: [UNPAID_INVOICE] }), chain({ rows: [] })],
    annual_prepay_terms: [chain({ rows: terms })],
    scheduled_services: [chain({ rows: visits }), chain({ rows: inProgress })],
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  callOrder.length = 0;
});

describe('previewCancelSignup — eligibility fails closed', () => {
  it('eligible: credited deposit on an unpaid invoice, pending term, open visits', async () => {
    setDbQueues(previewQueues());
    const p = await CustomerOffboarding.previewCancelSignup('cust-1');
    expect(p.eligible).toBe(true);
    expect(p.refundTotal).toBe(49);
    expect(p.invoices).toHaveLength(1);
    expect(p.visits).toHaveLength(2);
  });

  it('blocks when the deposit credit sits on a PAID invoice — refund that payment instead', async () => {
    const paidInvoice = { ...UNPAID_INVOICE, status: 'paid' };
    setDbQueues(previewQueues({
      invoicesQueue: [
        chain({ rows: [paidInvoice] }), // credit scan
        chain({ first: paidInvoice }), // term prepay lookup (not in void map since blocked)
        chain({ rows: [] }), // paid-visit-invoice check
      ],
    }));
    const p = await CustomerOffboarding.previewCancelSignup('cust-1');
    expect(p.eligible).toBe(false);
    expect(p.blockers.join(' ')).toMatch(/refund that payment instead/);
  });

  it('voids EVERY invoice carrying the credit when it split across invoices', async () => {
    const second = {
      ...UNPAID_INVOICE,
      id: 'inv-2',
      invoice_number: 'WPC-2026-0002',
      annual_prepay_term_id: null,
    };
    setDbQueues(previewQueues({
      invoicesQueue: [
        chain({ rows: [UNPAID_INVOICE, second] }), // credit scan finds both lines
        chain({ rows: [] }), // paid-visit-invoice check
      ],
    }));
    const p = await CustomerOffboarding.previewCancelSignup('cust-1');
    expect(p.eligible).toBe(true);
    expect(p.invoices.map((i) => i.id).sort()).toEqual(['inv-1', 'inv-2']);
  });

  it('blocks when the annual prepay term has collected money', async () => {
    setDbQueues(previewQueues({ terms: [{ ...PENDING_TERM, status: 'active' }] }));
    const p = await CustomerOffboarding.previewCancelSignup('cust-1');
    expect(p.eligible).toBe(false);
    expect(p.blockers.join(' ')).toMatch(/out of scope/);
  });

  it('blocks when there is nothing refundable', async () => {
    setDbQueues(previewQueues({
      deposits: [{ ...DEPOSIT_CREDITED, refunded_amount: '49.00' }],
      invoicesQueue: [
        chain({ first: UNPAID_INVOICE }), // term prepay lookup (no credit scan — deposit skipped)
        chain({ rows: [] }), // paid-visit-invoice check
      ],
    }));
    const p = await CustomerOffboarding.previewCancelSignup('cust-1');
    expect(p.eligible).toBe(false);
    expect(p.blockers.join(' ')).toMatch(/no refundable deposit/);
  });

  it('blocks while a deposit refund is already in flight', async () => {
    setDbQueues(previewQueues({
      deposits: [DEPOSIT_CREDITED, { ...DEPOSIT_CREDITED, id: 'dep-2', status: 'refunding' }],
    }));
    const p = await CustomerOffboarding.previewCancelSignup('cust-1');
    expect(p.eligible).toBe(false);
    expect(p.blockers.join(' ')).toMatch(/in flight/);
  });

  it('blocks when a visit is in progress (tech en route / on property)', async () => {
    setDbQueues(previewQueues({ inProgress: [{ id: 'v-9', status: 'en_route' }] }));
    const p = await CustomerOffboarding.previewCancelSignup('cust-1');
    expect(p.eligible).toBe(false);
    expect(p.blockers.join(' ')).toMatch(/en_route.*dispatch board/);
  });

  it('blocks when a LIVE track_state leads a still-cancellable status', async () => {
    setDbQueues(previewQueues({
      visits: [
        { ...VISITS[0], track_state: 'on_property' }, // tracker leads status=pending
        VISITS[1],
      ],
    }));
    const p = await CustomerOffboarding.previewCancelSignup('cust-1');
    expect(p.eligible).toBe(false);
    expect(p.blockers.join(' ')).toMatch(/on_property.*dispatch board/);
    // The live-tracked visit must not appear in the cancellable list either.
    expect(p.visits.map((v) => v.id)).toEqual(['v-2']);
  });

  it('blocks when a cancellable visit already has a PAID invoice — money beyond the deposit', async () => {
    setDbQueues(previewQueues({
      invoicesQueue: [
        chain({ rows: [UNPAID_INVOICE] }), // credit scan
        chain({ rows: [{ id: 'vinv-1', invoice_number: 'WPC-2026-0009', status: 'paid' }] }), // paid visit invoice
      ],
    }));
    const p = await CustomerOffboarding.previewCancelSignup('cust-1');
    expect(p.eligible).toBe(false);
    expect(p.blockers.join(' ')).toMatch(/money collected beyond the deposit/);
  });

  it('blocks a DECIDED paid term (renewed) — still a paid coverage window', async () => {
    setDbQueues(previewQueues({ terms: [{ ...PENDING_TERM, status: 'renewed' }] }));
    const p = await CustomerOffboarding.previewCancelSignup('cust-1');
    expect(p.eligible).toBe(false);
    expect(p.blockers.join(' ')).toMatch(/out of scope/);
  });

  it('allows a credit-covered PREPAID invoice through (no payment recorded — voidInvoice restores its credit)', async () => {
    setDbQueues(previewQueues({
      invoicesQueue: [
        chain({ rows: [{ ...UNPAID_INVOICE, status: 'prepaid', payment_recorded_at: null }] }),
        chain({ rows: [] }),
      ],
    }));
    const p = await CustomerOffboarding.previewCancelSignup('cust-1');
    expect(p.eligible).toBe(true);
    expect(p.invoices).toHaveLength(1);
  });
});

describe('cancelSignupAndRefundDeposit — order and side effects', () => {
  function executeQueues({ ledgerRefunded = '49.00', stragglers = [] } = {}) {
    const q = previewQueues();
    // step 2: recurrence flip, per-visit track_state normalize (×2), the
    // straggler re-query, then a normalize per straggler; step 3 tier/rate
    // clear; step 5 ledger re-read + notification name lookup.
    q.scheduled_services.push(
      chain({ update: 1 }), // recurring_ongoing flip
      chain({ update: 1 }), // v-1 track normalize
      chain({ update: 1 }), // v-2 track normalize
      chain({ rows: stragglers }),
      ...stragglers.map(() => chain({ update: 1 })),
    );
    q.customers.push(chain({ update: 1 }), chain({ first: { first_name: 'Taylor', last_name: 'Morgan' } }));
    q.estimate_deposits.push(chain({ rows: [{ refunded_amount: ledgerRefunded }] }));
    return q;
  }

  it('voids first, cancels visits, clears tier, refunds face-only, then emails the ledger total', async () => {
    setDbQueues(executeQueues());
    const result = await CustomerOffboarding.cancelSignupAndRefundDeposit('cust-1', { actorId: 'tech-1' });

    // Void strictly precedes every visit cancel and the refund; the refund is last.
    expect(callOrder[0]).toBe('void:inv-1');
    expect(callOrder[callOrder.length - 1]).toBe('refund');
    expect(callOrder).toEqual(['void:inv-1', 'cancel:v-1', 'cancel:v-2', 'refund']);

    expect(mockRefundUnconsumed).toHaveBeenCalledWith({
      estimateId: 'est-1',
      reason: 'cancel_signup',
      includeSurchargeShare: false,
    });
    // Business-initiated cancel: hold fees waived on every visit.
    expect(mockCardHold).toHaveBeenCalledTimes(2);
    for (const call of mockCardHold.mock.calls) {
      expect(call[0].waiveFee).toBe(true);
    }
    // Customer-visible tracker cancelled for every visit too.
    expect(mockTrackCancel).toHaveBeenCalledTimes(2);
    expect(mockSendEmail).toHaveBeenCalledWith(expect.objectContaining({
      customerId: 'cust-1',
      refundAmount: 49,
      // Amount-keyed: a retry that refunds more sends a corrected email
      // instead of deduping against the partial one.
      idempotencyKey: 'account.cancellation_refund:cust-1:dep-1:4900',
    }));
    expect(mockTriggerNotification).toHaveBeenCalledWith('payment_refunded', expect.objectContaining({ amount: 49 }));
    expect(result).toMatchObject({
      invoicesVoided: ['WPC-inv-1'],
      visitsCancelled: 2,
      visitFailures: [],
      tierCleared: true,
      refunded: 49,
    });
  });

  it('refuses to run when ineligible', async () => {
    setDbQueues(previewQueues({ terms: [{ ...PENDING_TERM, status: 'active' }] }));
    await expect(CustomerOffboarding.cancelSignupAndRefundDeposit('cust-1'))
      .rejects.toMatchObject({ status: 409 });
    expect(mockVoidInvoice).not.toHaveBeenCalled();
    expect(mockRefundUnconsumed).not.toHaveBeenCalled();
  });

  it('a void failure aborts BEFORE any visit or money is touched', async () => {
    mockVoidInvoice.mockRejectedValueOnce(new Error('payment applied while voiding'));
    setDbQueues(executeQueues());
    await expect(CustomerOffboarding.cancelSignupAndRefundDeposit('cust-1'))
      .rejects.toThrow('payment applied while voiding');
    expect(mockTransition).not.toHaveBeenCalled();
    expect(mockRefundUnconsumed).not.toHaveBeenCalled();
    expect(mockSendEmail).not.toHaveBeenCalled();
  });

  it('a failed refund skips the email AND the admin bell (no $0.00 "refund issued")', async () => {
    mockRefundUnconsumed.mockImplementationOnce(async () => { callOrder.push('refund'); return { refunded: 0 }; });
    setDbQueues(executeQueues({ ledgerRefunded: '0.00' }));
    const result = await CustomerOffboarding.cancelSignupAndRefundDeposit('cust-1');
    expect(mockSendEmail).not.toHaveBeenCalled();
    expect(mockTriggerNotification).not.toHaveBeenCalled();
    expect(result.email).toMatchObject({ skipped: true, reason: 'no_refund_recorded' });
  });

  it('a per-application signup clears billing_mode and per_application_fee with the tier', async () => {
    const q = executeQueues();
    q.customers[0] = chain({ first: { ...CUSTOMER, billing_mode: 'per_application' } });
    // Capture before the run — setDbQueues consumes the arrays.
    const tierChain = q.customers[1];
    setDbQueues(q);
    await CustomerOffboarding.cancelSignupAndRefundDeposit('cust-1');
    const tierUpdate = tierChain.update.mock.calls[0][0];
    expect(tierUpdate).toMatchObject({
      waveguard_tier: null,
      monthly_rate: null,
      billing_mode: null,
      per_application_fee: null,
    });
  });

  it('one stuck visit does not strand the refund — failure isolated and reported', async () => {
    mockTransition.mockImplementationOnce(async () => { throw new Error('invalid transition'); });
    setDbQueues(executeQueues());
    const result = await CustomerOffboarding.cancelSignupAndRefundDeposit('cust-1');
    expect(result.visitsCancelled).toBe(1);
    expect(result.visitFailures).toEqual([{ id: 'v-1', reason: 'invalid transition' }]);
    expect(result.refunded).toBe(49);
  });

  it('sweeps stragglers minted by a racing auto-extension after the recurrence flip', async () => {
    setDbQueues(executeQueues({ stragglers: [{ id: 'v-99', status: 'pending' }] }));
    const result = await CustomerOffboarding.cancelSignupAndRefundDeposit('cust-1');
    expect(result.visitsCancelled).toBe(3);
    expect(mockTransition).toHaveBeenCalledWith(expect.objectContaining({ jobId: 'v-99' }));
  });
});
