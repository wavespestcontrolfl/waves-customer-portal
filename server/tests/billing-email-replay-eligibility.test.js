jest.mock('../models/db', () => jest.fn());
jest.mock('../services/autopay-eligibility', () => ({
  ...jest.requireActual('../services/autopay-eligibility'),
  getChargeableAutopayMethod: jest.fn(),
}));
jest.mock('../services/annual-prepay-renewals', () => ({
  getCardExpiryExemptions: jest.fn(),
  _private: { invoiceDunningActiveToday: jest.fn() },
}));
jest.mock('../services/messaging/deferred-replay-registry', () => ({ invoiceStillCollectible: jest.fn() }));
jest.mock('../services/invoice-helpers', () => ({
  selfPayAtDispatch: jest.fn(),
  isInvoiceCollectibleStatus: jest.fn((status) => ['draft', 'sent', 'overdue'].includes(status)),
  invoiceAmountDue: jest.fn((invoice) => Number(invoice.total) - Number(invoice.credit_applied || 0)),
  invoiceWithdrawnFromCustomer: jest.fn(() => false),
}));
jest.mock('../services/collections/rail-guard', () => ({ collectionsChannelPermitted: jest.fn() }));
jest.mock('../services/estimate-deposits', () => ({ assertInvoiceDepositSettlementReady: jest.fn() }));

const { etDateString, addETDays } = require('../utils/datetime-et');
const { getChargeableAutopayMethod } = require('../services/autopay-eligibility');
const { getCardExpiryExemptions } = require('../services/annual-prepay-renewals');
const { invoiceDunningActiveToday } = require('../services/annual-prepay-renewals')._private;
const { invoiceStillCollectible } = require('../services/messaging/deferred-replay-registry');
const { selfPayAtDispatch } = require('../services/invoice-helpers');
const { collectionsChannelPermitted } = require('../services/collections/rail-guard');
const { assertInvoiceDepositSettlementReady } = require('../services/estimate-deposits');
const { billingEmailReplayEligible } = require('../services/messaging/billing-email-replay-eligibility');

const customerId = '11111111-1111-4111-8111-111111111111';

function matching(row, conditions) {
  return Object.entries(conditions).every(([key, value]) => String(row[key]) === String(value));
}

function databaseWith(seed = {}) {
  return jest.fn((table) => {
    if (seed[table] instanceof Error) throw seed[table];
    const predicates = [];
    const rows = seed[table] || [];
    const filtered = () => rows.filter((row) => predicates.every((predicate) => predicate(row)));
    const query = {
      where: jest.fn((column, operator, value) => {
        if (column && typeof column === 'object') predicates.push((row) => matching(row, column));
        else if (operator === '>=') predicates.push((row) => String(row[column]) >= String(value));
        else predicates.push((row) => String(row[column]) === String(operator));
        return query;
      }),
      whereIn: jest.fn((column, values) => {
        predicates.push((row) => values.includes(row[column]));
        return query;
      }),
      whereNotNull: jest.fn((column) => {
        predicates.push((row) => row[column] != null);
        return query;
      }),
      whereRaw: jest.fn((_sql, [eventKey]) => {
        predicates.push((row) => row.metadata?.notificationEventKey === eventKey);
        return query;
      }),
      orderBy: jest.fn(() => query),
      forUpdate: jest.fn(() => query),
      first: jest.fn(async () => filtered()[0] || null),
      select: jest.fn(async () => filtered()),
    };
    return query;
  });
}

function expiryFixture(overrides = {}) {
  const [year, month] = etDateString().split('-').map(Number);
  const customer = { id: customerId, active: true, autopay_enabled: true, pipeline_stage: 'active_customer' };
  const method = { id: 'card-1', customer_id: customerId, processor: 'stripe', autopay_enabled: true,
    stripe_payment_method_id: 'pm_1', method_type: 'card', is_default: true, exp_month: month, exp_year: year };
  return {
    meta: { customer_id: customerId, source_entry_point: 'payment_expiry_workflow', payment_method_id: method.id,
      expiry_month: month, expiry_year: year, ...overrides.meta },
    database: databaseWith({ customers: [{ ...customer, ...overrides.customer }],
      payment_methods: [{ ...method, ...overrides.method }], payments: overrides.payments || [],
      scheduled_services: overrides.scheduled_services || [] }),
  };
}

beforeAll(() => {
  jest.useFakeTimers().setSystemTime(new Date('2026-09-26T16:00:00Z'));
});

beforeEach(() => {
  jest.clearAllMocks();
  delete process.env.GATE_COLLECTIONS_POLICY;
  getChargeableAutopayMethod.mockResolvedValue({ id: 'card-1' });
  getCardExpiryExemptions.mockResolvedValue({ customerIds: new Set(), chargeMethodIdsByCustomer: new Map() });
  invoiceStillCollectible.mockResolvedValue({ eligible: true });
  selfPayAtDispatch.mockReturnValue(async () => ({ ok: true }));
  collectionsChannelPermitted.mockResolvedValue({ allowed: true, durable: false });
  invoiceDunningActiveToday.mockResolvedValue(false);
  assertInvoiceDepositSettlementReady.mockResolvedValue(undefined);
});

afterAll(() => jest.useRealTimers());

describe('pre-charge replay eligibility', () => {
  test.each([1, 3])('keeps a live monthly-member reminder at T+%i ET', async (days) => {
    const chargeDate = etDateString(addETDays(new Date(), days));
    const database = databaseWith({ customers: [{ id: customerId, active: true, autopay_enabled: true,
      monthly_rate: 89, billing_mode: 'monthly_membership', billing_day: Number(chargeDate.slice(-2)) }] });
    await expect(billingEmailReplayEligible({ customer_id: customerId,
      source_entry_point: 'autopay_pre_charge_reminder', charge_date: chargeDate }, database))
      .resolves.toEqual({ eligible: true });
  });

  test.each([
    ['today', 0, {}],
    ['T+4', 4, {}],
    ['a non-monthly lane', 1, { billing_mode: 'per_visit' }],
    ['an inactive customer', 1, { active: false }],
  ])('refuses %s', async (_label, days, customerPatch) => {
    const chargeDate = etDateString(addETDays(new Date(), days));
    const customer = { id: customerId, active: true, autopay_enabled: true, monthly_rate: 89,
      billing_mode: 'monthly_membership', billing_day: Number(chargeDate.slice(-2)), ...customerPatch };
    const verdict = await billingEmailReplayEligible({ customer_id: customerId,
      source_entry_point: 'autopay_pre_charge_reminder', charge_date: chargeDate }, databaseWith({ customers: [customer] }));
    expect(verdict.eligible).toBe(false);
  });
});

describe('card-expiry replay eligibility', () => {
  test('keeps the pinned current-month card for a live customer', async () => {
    const { meta, database } = expiryFixture();
    await expect(billingEmailReplayEligible(meta, database)).resolves.toEqual({ eligible: true });
    expect(getCardExpiryExemptions).toHaveBeenCalledWith('2026-10-31', database);
  });

  test('refuses a changed pin and a relationship that no longer exists', async () => {
    const changed = expiryFixture({ method: { exp_month: 12 } });
    await expect(billingEmailReplayEligible(changed.meta, changed.database))
      .resolves.toMatchObject({ eligible: false, reason: 'expiry-method-changed' });
    const ended = expiryFixture({ customer: { pipeline_stage: 'nurture' } });
    await expect(billingEmailReplayEligible(ended.meta, ended.database))
      .resolves.toMatchObject({ eligible: false, reason: 'payment-relationship-ended' });
  });

  test('preserves the Monday stage pin and annual-prepay exemption', async () => {
    const staged = expiryFixture({ meta: { source_entry_point: 'autopay_card_expiry_warning', expiry_stage: 'expired' } });
    await expect(billingEmailReplayEligible(staged.meta, staged.database))
      .resolves.toMatchObject({ eligible: false, reason: 'expiry-stage-changed' });

    const covered = expiryFixture({ meta: { source_entry_point: 'autopay_card_expiry_warning', expiry_stage: 'soon' } });
    getCardExpiryExemptions.mockResolvedValueOnce({ customerIds: new Set([customerId]), chargeMethodIdsByCustomer: new Map() });
    await expect(billingEmailReplayEligible(covered.meta, covered.database))
      .resolves.toMatchObject({ eligible: false, reason: 'prepay-covered' });
  });
});

describe('invoice replay eligibility', () => {
  test('uses canonical collectibility for reminder sources, but lets paid-invoice receipts reach ownership', async () => {
    const database = databaseWith();
    invoiceStillCollectible.mockResolvedValueOnce({ eligible: false, reason: 'invoice-terminal:paid' });
    await expect(billingEmailReplayEligible({ customer_id: customerId, invoice_id: 'inv-1',
      source_entry_point: 'invoice_followup_sequence' }, database))
      .resolves.toMatchObject({ eligible: false, reason: 'invoice-terminal:paid' });
    expect(invoiceStillCollectible).toHaveBeenCalledWith(expect.objectContaining({ invoice_id: 'inv-1' }), database);

    invoiceStillCollectible.mockClear();
    await expect(billingEmailReplayEligible({ customer_id: customerId, invoice_id: 'inv-paid',
      source_entry_point: 'invoice_receipt_sms' }, databaseWith())).resolves.toEqual({ eligible: true });
    expect(invoiceStillCollectible).not.toHaveBeenCalled();
    expect(selfPayAtDispatch).toHaveBeenCalledWith('inv-paid', expect.any(Function));
  });

  test.each([
    ['INVOICE_UNREADABLE', true],
    ['INVOICE_PAYER_BILLED', false],
  ])('classifies %s ownership refusal', async (code, retryable) => {
    selfPayAtDispatch.mockReturnValueOnce(async () => ({ ok: false, code }));
    await expect(billingEmailReplayEligible({ customer_id: customerId, invoice_id: 'inv-1',
      source_entry_point: 'invoice_receipt_sms' }, databaseWith()))
      .resolves.toEqual({ eligible: false, reason: code, retryable });
  });
});

describe('balance-reminder visit identity', () => {
  const meta = { customer_id: customerId, source_entry_point: 'balance_reminder_workflow', appointment_id: 'visit-1',
    appointment_date: '2026-09-28', appointment_service_type: 'General Pest Control', appointment_rendered_on: '2026-09-26' };

  test('requires every frozen visit pin', async () => {
    for (const key of ['appointment_id', 'appointment_date', 'appointment_service_type', 'appointment_rendered_on']) {
      await expect(billingEmailReplayEligible({ ...meta, [key]: null }, databaseWith()))
        .resolves.toMatchObject({ eligible: false, reason: 'balance-reminder-visit-pin-missing' });
    }
  });

  test('refuses yesterday\'s relative timing copy even when the visit is unchanged', async () => {
    await expect(billingEmailReplayEligible({ ...meta, appointment_rendered_on: '2026-09-25' }, databaseWith()))
      .resolves.toMatchObject({ eligible: false, reason: 'balance-reminder-copy-stale' });
  });

  test.each([
    ['customer', { customer_id: 'other-customer' }],
    ['status', { status: 'cancelled' }],
    ['date', { scheduled_date: new Date('2026-09-29T00:00:00Z') }],
    ['service label', { service_type: 'Lawn Care' }],
  ])('refuses a changed visit %s', async (_label, patch) => {
    const visit = { id: 'visit-1', customer_id: customerId, status: 'pending',
      scheduled_date: new Date('2026-09-28T00:00:00Z'), service_type: 'General Pest Control', ...patch };
    await expect(billingEmailReplayEligible(meta, databaseWith({ scheduled_services: [visit] })))
      .resolves.toMatchObject({ eligible: false, reason: 'balance-reminder-visit-changed' });
  });

  test('accepts the same pending visit when PostgreSQL returns its date as a Date', async () => {
    const visit = { id: 'visit-1', customer_id: customerId, status: 'pending',
      scheduled_date: new Date('2026-09-28T00:00:00Z'), service_type: 'General Pest Control' };
    await expect(billingEmailReplayEligible(meta, databaseWith({ scheduled_services: [visit] })))
      .resolves.toEqual({ eligible: true });
  });
});

describe('collections-policy replay eligibility', () => {
  const meta = { customer_id: customerId, source_entry_point: 'invoice_followup_sequence',
    notificationEventKey: 'invoice-followup:seq-1:day-3', collections_ledger_id: 'own-email' };
  const ledgerSource = 'invoice_followups';
  const ledger = [
    { id: 'own-email', customer_id: customerId, source: ledgerSource,
      metadata: { notificationEventKey: meta.notificationEventKey } },
    { id: 'sibling-sms', customer_id: customerId, source: ledgerSource,
      metadata: { notificationEventKey: meta.notificationEventKey } },
    { id: 'other-customer', customer_id: 'other', source: ledgerSource,
      metadata: { notificationEventKey: meta.notificationEventKey } },
    { id: 'other-source', customer_id: customerId, source: 'late_payment_checker',
      metadata: { notificationEventKey: meta.notificationEventKey } },
    { id: 'other-event', customer_id: customerId, source: ledgerSource,
      metadata: { notificationEventKey: 'different' } },
  ];

  test('derives exclusions from the persisted own event and ignores producer-supplied sibling ids', async () => {
    process.env.GATE_COLLECTIONS_POLICY = 'true';
    const database = databaseWith({ collections_contact_ledger: ledger });
    await expect(billingEmailReplayEligible({ ...meta,
      collections_sibling_ledger_ids: ['untrusted-id'] }, database))
      .resolves.toEqual({ eligible: true });
    expect(collectionsChannelPermitted).toHaveBeenCalledWith(expect.objectContaining({
      customerId, channel: 'email', purpose: 'late_payment', excludeLedgerIds: ['own-email', 'sibling-sms'], detail: true,
      database,
    }));
  });

  test('gate-off skips the ledger and policy; gate-on denial refuses', async () => {
    const database = databaseWith({ collections_contact_ledger: ledger });
    await expect(billingEmailReplayEligible(meta, database)).resolves.toEqual({ eligible: true });
    expect(database).not.toHaveBeenCalled();
    expect(collectionsChannelPermitted).not.toHaveBeenCalled();

    process.env.GATE_COLLECTIONS_POLICY = 'true';
    collectionsChannelPermitted.mockResolvedValueOnce({ allowed: false, durable: true });
    await expect(billingEmailReplayEligible(meta, database))
      .resolves.toEqual({ eligible: false, reason: 'collections-policy-denied', retryable: false });
  });

  test('keeps temporary policy denials retryable, including cooldowns and caught read failures', async () => {
    process.env.GATE_COLLECTIONS_POLICY = 'true';
    collectionsChannelPermitted.mockResolvedValueOnce({ allowed: false, durable: false });
    await expect(billingEmailReplayEligible(meta, databaseWith({ collections_contact_ledger: ledger })))
      .resolves.toEqual({ eligible: false, reason: 'collections-policy-denied', retryable: true });
  });
});

test('an unreadable eligibility dependency fails closed for retry', async () => {
  const chargeDate = etDateString(addETDays(new Date(), 1));
  await expect(billingEmailReplayEligible({ customer_id: customerId,
    source_entry_point: 'autopay_pre_charge_reminder', charge_date: chargeDate },
  databaseWith({ customers: new Error('database unavailable') })))
    .resolves.toEqual({ eligible: false, reason: 'billing-email-eligibility-unavailable', retryable: true });
});

test.each(['previsit-quote-changed', 'balance-reminder-copy-stale', 'balance-reminder-visit-changed', null])(
  'previsit replay preserves only a declared supersession signal (%s)', async (supersessionReason) => {
    const reason = 'collections policy denied selected channel before dispatch';
    const guard = jest.spyOn(require('../services/previsit-balance-reminder'), 'previsitReplayQuoteEligible')
      .mockResolvedValue({ ok: false, code: 'PREVISIT_QUOTE_CHANGED', reason, supersessionReason, retryable: true });
    try {
      await expect(billingEmailReplayEligible({ source_entry_point: 'previsit_balance_reminder' }, databaseWith()))
        .resolves.toEqual({ eligible: false, reason: supersessionReason || reason, retryable: true });
    } finally { guard.mockRestore(); }
  },
);

describe('annual-prepay payment reminder replay', () => {
  const firstVisitDate = '2026-09-27';
  const meta = {
    customer_id: customerId,
    invoice_id: 'inv-annual',
    source_entry_point: 'annual_prepay_payment_reminder',
    notificationEventKey: 'annual-prepay-payment:term-annual:1:2026-09-27',
    collections_ledger_id: 'ledger-email',
    annual_prepay_term_id: 'term-annual',
    first_visit_date: firstVisitDate,
    days_out: 1,
    rendered_amount: '350.00',
  };
  const term = { id: 'term-annual', customer_id: customerId, prepay_invoice_id: 'inv-annual',
    status: 'payment_pending', term_start: firstVisitDate, first_visit_date: null };
  const invoice = { id: 'inv-annual', customer_id: customerId, status: 'sent',
    total: '392.04', credit_applied: '42.04', payer_id: null };
  const database = (patch = {}) => databaseWith({
    annual_prepay_terms: [{ ...term, ...patch.term }],
    invoices: [{ ...invoice, ...patch.invoice }],
    collections_contact_ledger: [],
    notification_prefs: patch.prefs === undefined
      ? [{ customer_id: customerId, billing_channels: ['email'] }]
      : patch.prefs instanceof Error ? patch.prefs : patch.prefs ? [patch.prefs] : [],
  });

  test('accepts the bound unpaid term and current credited amount', async () => {
    await expect(billingEmailReplayEligible(meta, database())).resolves.toEqual({ eligible: true });
  });

  test('rejects a queued event whose key names a different promised visit', async () => {
    await expect(billingEmailReplayEligible({ ...meta, first_visit_date: '2026-09-28' }, database()))
      .resolves.toMatchObject({ eligible: false, reason: 'annual-prepay-reminder-pin-missing' });
  });

  test.each([
    ['missing row', null],
    ['cleared legacy mode', { customer_id: customerId, billing_channels: null }],
    ['empty explicit choice', { customer_id: customerId, billing_channels: [] }],
    ['Text selected', { customer_id: customerId, billing_channels: ['sms'] }],
    ['App selected', { customer_id: customerId, billing_channels: ['push'] }],
  ])('holds queued annual Email replay after %s', async (_label, prefs) => {
    await expect(billingEmailReplayEligible(meta, database({ prefs })))
      .resolves.toEqual({ eligible: false, reason: 'annual-prepay-email-not-selected', retryable: true });
  });

  test('an unreadable choice fails closed with a static retryable reason', async () => {
    await expect(billingEmailReplayEligible(meta, database({ prefs: new Error('private SQL binding') })))
      .resolves.toEqual({ eligible: false, reason: 'annual-prepay-choice-unavailable', retryable: true });
  });

  test.each(['sms', 'push'])('the %s final handoff retains its own channel authority', async (channel) => {
    await expect(billingEmailReplayEligible({ ...meta, delivery_channel: channel }, database({ prefs: null })))
      .resolves.toEqual({ eligible: true });
  });

  test.each([
    ['declined', { term: { status: 'cancelled' } }, 'annual-prepay-term-settled'],
    ['paid', { invoice: { status: 'paid' } }, 'annual-prepay-invoice-settled'],
    ['changed quote', { invoice: { credit_applied: '50.00' } }, 'annual-prepay-amount-changed'],
    ['rebound invoice', { term: { prepay_invoice_id: 'another-invoice' } }, 'annual-prepay-term-binding-changed'],
    ['moved visit', { term: { first_visit_date: etDateString(addETDays(new Date(), 2)) } },
      'annual-prepay-first-visit-changed'],
  ])('refuses a %s reminder', async (_label, patch, reason) => {
    await expect(billingEmailReplayEligible(meta, database(patch)))
      .resolves.toMatchObject({ eligible: false, reason });
  });

  test('keeps a failed dunning preparation read retryable', async () => {
    invoiceDunningActiveToday.mockRejectedValueOnce(new Error('read failed'));
    await expect(billingEmailReplayEligible(meta, database()))
      .resolves.toEqual({ eligible: false, reason: 'annual-prepay-dunning-unavailable', retryable: true });
  });

  test('retries while a received deposit still needs invoice reconciliation', async () => {
    assertInvoiceDepositSettlementReady.mockRejectedValueOnce(new Error('deposit pending'));
    const held = database(); held.isTransaction = true;
    await expect(billingEmailReplayEligible(meta, held))
      .resolves.toEqual({ eligible: false, reason: 'annual-prepay-deposit-settlement-pending', retryable: true });
    expect(assertInvoiceDepositSettlementReady).toHaveBeenCalledWith(held, expect.any(Object), { lock: true });
  });

  test('rechecks collections as off-ledger debt with the current leg excluded', async () => {
    process.env.GATE_COLLECTIONS_POLICY = 'true';
    const own = { id: 'ledger-email', customer_id: customerId, source: 'annual_prepay_payment_reminder',
      metadata: { notificationEventKey: meta.notificationEventKey } };
    await expect(billingEmailReplayEligible(meta, databaseWith({
      annual_prepay_terms: [term], invoices: [invoice], collections_contact_ledger: [own],
      notification_prefs: [{ customer_id: customerId, billing_channels: ['email'] }],
    }))).resolves.toEqual({ eligible: true });
    expect(collectionsChannelPermitted).toHaveBeenCalledWith(expect.objectContaining({
      invoiceId: null, invoiceIds: [], offLedgerBalanceCents: 35000,
      excludeLedgerIds: ['ledger-email'], channel: 'email',
    }));
  });

  test('retries an incomplete first policy snapshot instead of sending on partial debt', async () => {
    process.env.GATE_COLLECTIONS_POLICY = 'true';
    collectionsChannelPermitted.mockResolvedValueOnce({
      allowed: true, durable: false, balanceIncomplete: 'payer resolve failed',
    });
    await expect(billingEmailReplayEligible(meta, database()))
      .resolves.toEqual({ eligible: false, reason: 'collections-policy-unavailable', retryable: true });
    expect(collectionsChannelPermitted).toHaveBeenCalledTimes(1);
  });
});
