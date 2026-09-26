jest.mock('../models/db', () => jest.fn());
jest.mock('../services/autopay-eligibility', () => ({
  ...jest.requireActual('../services/autopay-eligibility'),
  getChargeableAutopayMethod: jest.fn(),
}));
jest.mock('../services/annual-prepay-renewals', () => ({ getCardExpiryExemptions: jest.fn() }));
jest.mock('../services/messaging/deferred-replay-registry', () => ({ invoiceStillCollectible: jest.fn() }));
jest.mock('../services/invoice-helpers', () => ({ selfPayAtDispatch: jest.fn() }));
jest.mock('../services/collections/rail-guard', () => ({ collectionsChannelPermitted: jest.fn() }));

const { etDateString, addETDays } = require('../utils/datetime-et');
const { getChargeableAutopayMethod } = require('../services/autopay-eligibility');
const { getCardExpiryExemptions } = require('../services/annual-prepay-renewals');
const { invoiceStillCollectible } = require('../services/messaging/deferred-replay-registry');
const { selfPayAtDispatch } = require('../services/invoice-helpers');
const { collectionsChannelPermitted } = require('../services/collections/rail-guard');
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
  collectionsChannelPermitted.mockResolvedValue(true);
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
    invoiceStillCollectible.mockResolvedValueOnce({ eligible: false, reason: 'invoice-terminal:paid' });
    await expect(billingEmailReplayEligible({ customer_id: customerId, invoice_id: 'inv-1',
      source_entry_point: 'invoice_followup_sequence' }, databaseWith()))
      .resolves.toMatchObject({ eligible: false, reason: 'invoice-terminal:paid' });

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
    await expect(billingEmailReplayEligible({ ...meta,
      collections_sibling_ledger_ids: ['untrusted-id'] }, databaseWith({ collections_contact_ledger: ledger })))
      .resolves.toEqual({ eligible: true });
    expect(collectionsChannelPermitted).toHaveBeenCalledWith(expect.objectContaining({
      customerId, channel: 'email', purpose: 'late_payment', excludeLedgerIds: ['own-email', 'sibling-sms'],
    }));
  });

  test('gate-off skips the ledger and policy; gate-on denial refuses', async () => {
    const database = databaseWith({ collections_contact_ledger: ledger });
    await expect(billingEmailReplayEligible(meta, database)).resolves.toEqual({ eligible: true });
    expect(database).not.toHaveBeenCalled();
    expect(collectionsChannelPermitted).not.toHaveBeenCalled();

    process.env.GATE_COLLECTIONS_POLICY = 'true';
    collectionsChannelPermitted.mockResolvedValueOnce(false);
    await expect(billingEmailReplayEligible(meta, database))
      .resolves.toEqual({ eligible: false, reason: 'collections-policy-denied', retryable: false });
  });
});

test('an unreadable eligibility dependency fails closed for retry', async () => {
  const chargeDate = etDateString(addETDays(new Date(), 1));
  await expect(billingEmailReplayEligible({ customer_id: customerId,
    source_entry_point: 'autopay_pre_charge_reminder', charge_date: chargeDate },
  databaseWith({ customers: new Error('database unavailable') })))
    .resolves.toEqual({ eligible: false, reason: 'billing-email-eligibility-unavailable', retryable: true });
});
