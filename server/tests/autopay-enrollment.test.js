jest.mock('../models/db', () => {
  const fn = jest.fn();
  fn.raw = jest.fn((sql) => sql);
  // enrollConsentedMethod wraps its read-modify-write in a transaction with
  // a FOR UPDATE customer lock; the unit tests exercise the logic, so the
  // mock trx is just the db mock itself.
  fn.transaction = jest.fn(async (cb) => cb(fn));
  return fn;
});
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/autopay-log', () => ({ logAutopay: jest.fn(async () => {}) }));
jest.mock('../services/payer', () => ({
  resolveForInvoice: jest.fn(async () => ({ payerId: null })),
}));
jest.mock('../services/card-enrollment-email', () => ({ sendAutopayEnrollmentConfirmation: jest.fn(async () => {}) }));

const db = require('../models/db');
const { logAutopay } = require('../services/autopay-log');
const { sendAutopayEnrollmentConfirmation } = require('../services/card-enrollment-email');
const PayerService = require('../services/payer');
const { enrollConsentedMethod } = require('../services/autopay-enrollment');

// A caller-owned transaction handle (the appointment auto-secure passes its
// outer trx as dbh, Codex #3361 r26 P1) — knex stamps isTransaction on
// transaction objects, and that marker is what flips the side-effect
// deferral (Codex #3361 r27 P1). Table reads delegate to the shared queue.
function makeCallerTrx() {
  const fn = jest.fn((table) => db(table));
  fn.raw = jest.fn((sql) => sql);
  fn.transaction = jest.fn(async (cb) => cb(fn));
  fn.isTransaction = true;
  return fn;
}

// Chainable query mock: builder methods return `this`; `.first()` resolves
// the configured value; `.update()` records its arg and resolves.
function qb({ first = null } = {}) {
  const q = {};
  ['where', 'whereNot', 'whereNotNull', 'whereIn', 'forUpdate', 'orderBy'].forEach((m) => { q[m] = jest.fn(() => q); });
  q.first = jest.fn(async () => first);
  q.update = jest.fn(async () => 1);
  return q;
}

function setQueues(queues) {
  const tables = new Map(Object.entries(queues));
  db.mockImplementation((table) => {
    const queue = tables.get(table);
    if (!queue || !queue.length) throw new Error(`unexpected db('${table}') call`);
    return queue.shift();
  });
}

const TARGET = { id: 'pm-new', customer_id: 'cust-1', method_type: 'card', stripe_payment_method_id: 'pm_stripe_new' };
// The locked customer row read at the top of the transaction — carries the
// ACH health and the current enrollment flags in one read.
const custRow = (over = {}) => ({
  id: 'cust-1', ach_status: null, autopay_enabled: false, autopay_payment_method_id: null, ...over,
});

describe('enrollConsentedMethod', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    PayerService.resolveForInvoice.mockResolvedValue({ payerId: null });
  });

  // Payer authority UNDER the enrollment lock (Codex #3395 r10 P1): caller
  // pre-checks run outside this transaction; an admin payer assignment
  // committing in between must still refuse here.
  test('a payer-billed account refuses inside the lock — no flags flipped, no log', async () => {
    setQueues({ customers: [qb({ first: custRow() })] });
    PayerService.resolveForInvoice.mockResolvedValue({ payerId: 'payer-1' });
    const out = await enrollConsentedMethod({ customerId: 'cust-1', paymentMethodId: 'pm-new', source: 'test' });
    expect(out).toEqual({ enrolled: false, reason: 'payer_billed' });
    expect(PayerService.resolveForInvoice).toHaveBeenCalledWith(expect.objectContaining({
      customerId: 'cust-1', throwOnError: true,
    }));
    expect(logAutopay).not.toHaveBeenCalled();
  });

  test('a payer-resolver failure THROWS (fail closed, transaction rolls back, caller retries)', async () => {
    setQueues({ customers: [qb({ first: custRow() })] });
    PayerService.resolveForInvoice.mockRejectedValue(new Error('payer lookup down'));
    await expect(enrollConsentedMethod({ customerId: 'cust-1', paymentMethodId: 'pm-new', source: 'test' }))
      .rejects.toThrow('payer lookup down');
    expect(logAutopay).not.toHaveBeenCalled();
  });

  test('no incumbent → target enrolls, claims default, customer flag + pointer set, logged', async () => {
    const unsetOthers = qb();
    const enrollTarget = qb();
    const custUpdate = qb();
    setQueues({
      customers: [qb({ first: custRow() }), custUpdate],
      payment_methods: [qb({ first: TARGET }), qb({ first: null }), unsetOthers, enrollTarget],
    });

    const result = await enrollConsentedMethod({ customerId: 'cust-1', paymentMethodId: 'pm-new', source: 'portal_add_card' });

    expect(result).toEqual({ enrolled: true, methodId: 'pm-new', inChargeMethodId: 'pm-new' });
    expect(unsetOthers.update).toHaveBeenCalledWith({ is_default: false });
    expect(enrollTarget.update).toHaveBeenCalledWith({ autopay_enabled: true, is_default: true });
    expect(custUpdate.update).toHaveBeenCalledWith({ autopay_enabled: true, autopay_payment_method_id: 'pm-new' });
    expect(logAutopay).toHaveBeenCalledWith('cust-1', 'autopay_enabled', expect.objectContaining({ paymentMethodId: 'pm-new' }));
  });

  test('healthy card incumbent keeps the default role — target enrolls non-default, pointer stays incumbent', async () => {
    const enrollTarget = qb();
    const custUpdate = qb();
    setQueues({
      customers: [qb({ first: custRow({ autopay_enabled: true, autopay_payment_method_id: 'pm-old' }) }), custUpdate],
      payment_methods: [qb({ first: TARGET }), qb({ first: { id: 'pm-old', method_type: 'card' } }), enrollTarget],
    });

    const result = await enrollConsentedMethod({ customerId: 'cust-1', paymentMethodId: 'pm-new', source: 'save_card_consent' });

    expect(result.enrolled).toBe(true);
    expect(result.inChargeMethodId).toBe('pm-old');
    expect(enrollTarget.update).toHaveBeenCalledWith({ autopay_enabled: true });
    expect(custUpdate.update).toHaveBeenCalledWith({ autopay_enabled: true, autopay_payment_method_id: 'pm-old' });
  });

  test('unhealthy bank incumbent (either alias) is NOT in charge — target claims default', async () => {
    const unsetOthers = qb();
    const enrollTarget = qb();
    const custUpdate = qb();
    setQueues({
      customers: [
        qb({ first: custRow({ ach_status: 'needs_verification', autopay_enabled: true, autopay_payment_method_id: 'pm-bank' }) }),
        custUpdate,
      ],
      payment_methods: [qb({ first: TARGET }), qb({ first: { id: 'pm-bank', method_type: 'us_bank_account' } }), unsetOthers, enrollTarget],
    });

    const result = await enrollConsentedMethod({ customerId: 'cust-1', paymentMethodId: 'pm-new', source: 'save_card_consent' });

    expect(result.enrolled).toBe(true);
    expect(result.inChargeMethodId).toBe('pm-new');
    expect(enrollTarget.update).toHaveBeenCalledWith({ autopay_enabled: true, is_default: true });
    expect(custUpdate.update).toHaveBeenCalledWith({ autopay_enabled: true, autopay_payment_method_id: 'pm-new' });
  });

  test('already fully enrolled on the same method → idempotent no-op, no duplicate log', async () => {
    const incumbent = { id: 'pm-new', method_type: 'card' };
    setQueues({
      customers: [qb({ first: custRow({ autopay_enabled: true, autopay_payment_method_id: 'pm-new' }) })],
      payment_methods: [qb({ first: TARGET }), qb({ first: incumbent })],
    });

    const result = await enrollConsentedMethod({ customerId: 'cust-1', paymentMethodId: 'pm-new', source: 'save_card_consent' });

    expect(result).toEqual({ enrolled: false, reason: 'already_enrolled', methodId: 'pm-new', inChargeMethodId: 'pm-new' });
    expect(logAutopay).not.toHaveBeenCalled();
  });

  test('a bank TARGET is refused while the customer ACH state is blocked (saved, not enrolled)', async () => {
    // customerOnAutopay refuses every non-card method while ach_status is
    // unhealthy — enrolling a fresh bank account would point collection at
    // a method it keeps rejecting (Codex #2507 round-5).
    const bankTarget = { ...TARGET, method_type: 'us_bank_account' };
    setQueues({
      customers: [qb({ first: custRow({ ach_status: 'needs_verification' }) })],
      payment_methods: [qb({ first: bankTarget })],
    });

    const result = await enrollConsentedMethod({ customerId: 'cust-1', paymentMethodId: 'pm-new', source: 'portal_add_card' });

    expect(result).toEqual({ enrolled: false, reason: 'ach_blocked', methodId: 'pm-new' });
    expect(logAutopay).not.toHaveBeenCalled();
  });

  test('unknown method → method_not_found (the /consent endpoint relies on this when the webhook has not mirrored yet)', async () => {
    setQueues({
      customers: [qb({ first: custRow() })],
      payment_methods: [qb({ first: null })],
    });
    const result = await enrollConsentedMethod({ customerId: 'cust-1', stripePaymentMethodId: 'pm_missing', source: 'save_card_consent' });
    expect(result).toEqual({ enrolled: false, reason: 'method_not_found' });
  });

  test('an Auto Pay disable AFTER the authorization moment refuses delayed enrollment', async () => {
    // ACH micro-deposit flow: authorized on day 0, customer disables Auto
    // Pay on day 2, webhook completes on day 4 — the stale authorization
    // must not re-enroll them.
    setQueues({
      customers: [qb({ first: custRow() })],
      autopay_log: [qb({ first: { id: 'log-1' } })],
    });

    const result = await enrollConsentedMethod({
      customerId: 'cust-1',
      paymentMethodId: 'pm-new',
      source: 'portal_add_bank',
      authorizedAt: new Date('2026-07-14T00:00:00Z'),
    });

    expect(result).toEqual({ enrolled: false, reason: 'opted_out_after_authorization' });
    expect(logAutopay).not.toHaveBeenCalled();
  });

  test('no later opt-out → authorizedAt passes through and enrollment proceeds', async () => {
    const unsetOthers = qb();
    const enrollTarget = qb();
    const custUpdate = qb();
    setQueues({
      customers: [qb({ first: custRow() }), custUpdate],
      autopay_log: [qb({ first: null })],
      payment_methods: [qb({ first: TARGET }), qb({ first: null }), unsetOthers, enrollTarget],
    });

    const result = await enrollConsentedMethod({
      customerId: 'cust-1',
      paymentMethodId: 'pm-new',
      source: 'portal_add_bank',
      authorizedAt: new Date('2026-07-14T00:00:00Z'),
    });

    expect(result).toEqual({ enrolled: true, methodId: 'pm-new', inChargeMethodId: 'pm-new' });
    expect(custUpdate.update).toHaveBeenCalledWith({ autopay_enabled: true, autopay_payment_method_id: 'pm-new' });
  });

  test('standalone mode still fires the enrollment email inline (target in charge)', async () => {
    setQueues({
      customers: [qb({ first: custRow() }), qb()],
      payment_methods: [qb({ first: TARGET }), qb({ first: null }), qb(), qb()],
    });

    const result = await enrollConsentedMethod({ customerId: 'cust-1', paymentMethodId: 'pm-new', source: 'portal_add_card' });

    expect(result.enrolled).toBe(true);
    expect(result.sendEnrollmentConfirmation).toBeUndefined();
    expect(sendAutopayEnrollmentConfirmation).toHaveBeenCalledWith({ customerId: 'cust-1', paymentMethodRowId: 'pm-new' });
  });
});

describe('enrollConsentedMethod — savepoint mode side effects honor the outer commit (Codex #3361 r27 P1)', () => {
  beforeEach(() => jest.clearAllMocks());

  test('audit rides the caller transaction as REQUIRED and the email is deferred to the returned callback', async () => {
    setQueues({
      customers: [qb({ first: custRow() }), qb()],
      payment_methods: [qb({ first: TARGET }), qb({ first: null }), qb(), qb()],
    });
    const callerTrx = makeCallerTrx();

    const result = await enrollConsentedMethod({
      customerId: 'cust-1',
      paymentMethodId: 'pm-new',
      source: 'save_card_consent',
      dbh: callerTrx,
    });

    expect(result.enrolled).toBe(true);
    // The audit row is written THROUGH the outer handle and a failure must
    // roll the enrollment back with it — never the global pool, never
    // warn-only: a rolled-back enrollment with a committed audit event
    // contradicts the all-or-nothing contract.
    expect(logAutopay).toHaveBeenCalledWith('cust-1', 'autopay_enabled', expect.objectContaining({
      db: callerTrx,
      required: true,
    }));
    // Nothing customer-facing fired before the outer commit — the email is
    // handed back for the caller's post-commit.
    expect(sendAutopayEnrollmentConfirmation).not.toHaveBeenCalled();
    expect(typeof result.sendEnrollmentConfirmation).toBe('function');
    result.sendEnrollmentConfirmation();
    expect(sendAutopayEnrollmentConfirmation).toHaveBeenCalledWith({ customerId: 'cust-1', paymentMethodRowId: 'pm-new' });
  });

  test('a healthy incumbent in charge → no email callback at all (the wrong-card rule, Codex #2698 r1)', async () => {
    setQueues({
      customers: [qb({ first: custRow({ autopay_enabled: true, autopay_payment_method_id: 'pm-old' }) }), qb()],
      payment_methods: [qb({ first: TARGET }), qb({ first: { id: 'pm-old', method_type: 'card' } }), qb()],
    });

    const result = await enrollConsentedMethod({
      customerId: 'cust-1',
      paymentMethodId: 'pm-new',
      source: 'save_card_consent',
      dbh: makeCallerTrx(),
    });

    expect(result.enrolled).toBe(true);
    expect(result.sendEnrollmentConfirmation).toBeUndefined();
    expect(sendAutopayEnrollmentConfirmation).not.toHaveBeenCalled();
  });
});
