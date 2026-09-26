jest.mock('../models/db', () => {
  const rows = [];
  const customers = new Map();
  const methods = new Map();
  const mockDb = jest.fn((table) => {
    const filters = {};
    let eventKey;
    let sibling;
    let siblingState;
    const q = {
      where: jest.fn((values) => { if (typeof values === 'object' && values) Object.assign(filters, values); return q; }),
      whereIn: jest.fn(() => q),
      whereRaw: jest.fn((sql, bindings) => {
        if (sql.includes('billing_channel_email_key')) eventKey = bindings[0];
        if (sql.includes('billing_email_siblings')) [sibling, siblingState] = bindings;
        return q;
      }),
      first: jest.fn(async () => {
        if (table === 'customers') return customers.get(filters.id) || null;
        if (table === 'payment_methods') return methods.get(filters.id) || null;
        return rows.find((row) => Object.entries(filters).every(([key, value]) => row[key] === value)
          && (!eventKey || row.metadata.billing_channel_email_key === eventKey)) || null;
      }),
      insert: jest.fn((value) => ({ returning: async () => {
        const row = { ...value, id: `queue-${rows.length + 1}`, metadata: JSON.parse(value.metadata) };
        rows.push(row);
        return [{ id: row.id }];
      } })),
      update: jest.fn(async (value) => {
        const row = rows.find((candidate) => candidate.id === filters.id);
        if (!row || row.metadata.billing_email_siblings[sibling] !== siblingState) return 0;
        row.metadata.billing_email_siblings[sibling] = value.metadata.bindings[1];
        return 1;
      }),
    };
    return q;
  });
  mockDb.raw = jest.fn((sql, bindings) => ({ sql, bindings }));
  mockDb._rows = rows;
  mockDb._customers = customers;
  mockDb._methods = methods;
  return mockDb;
});
jest.mock('../services/autopay-eligibility', () => ({
  ...jest.requireActual('../services/autopay-eligibility'),
  getChargeableAutopayMethod: jest.fn(),
}));
jest.mock('../services/annual-prepay-renewals', () => ({
  getCardExpiryExemptions: jest.fn(async () => ({ customerIds: new Set(), chargeMethodIdsByCustomer: new Map() })),
}));
jest.mock('../config/twilio-numbers', () => ({ getOutboundNumber: jest.fn(() => '+19415550000') }));
jest.mock('../utils/customer-comms-lock', () => {
  let chain = Promise.resolve();
  return { withCustomerCommsLock: jest.fn((database, _customerId, callback) => {
    const run = chain.then(() => callback(database));
    chain = run.catch(() => {});
    return run;
  }) };
});
jest.mock('../services/messaging/send-customer-message', () => ({ sendCustomerMessage: jest.fn() }));

const db = require('../models/db');
const { sendCustomerMessage } = require('../services/messaging/send-customer-message');
const { etDateString, addETDays } = require('../utils/datetime-et');
const { getChargeableAutopayMethod } = require('../services/autopay-eligibility');
const { getCardExpiryExemptions } = require('../services/annual-prepay-renewals');
const obligation = require('../services/messaging/billing-channel-email-obligation');
const customerId = '11111111-1111-4111-8111-111111111111';

beforeEach(() => {
  jest.clearAllMocks();
  db._rows.length = 0;
  db._customers.clear();
  db._methods.clear();
});

function notice() {
  return { customerId, purpose: 'payment_receipt', body: 'Your receipt is ready.',
    metadata: { original_message_type: 'receipt' } };
}

test('concurrent producers create one registered Email-only row with a blank phone and stable key', async () => {
  const result = { sent: false, retryable: true, deliveryOutcome: 'not_sent' };
  const [first, second] = await Promise.all([
    obligation.queueObligation(notice(), 'payment_receipt', 'receipt:event-1', result, ['sms']),
    obligation.queueObligation(notice(), 'payment_receipt', 'receipt:event-1', result, ['sms']),
  ]);
  expect(first).toMatchObject({ queued: true, id: 'queue-1' });
  expect(second).toMatchObject({ queued: true, duplicate: true });
  expect(db._rows).toHaveLength(1);
  expect(db._rows[0]).toMatchObject({ to_phone: '', status: 'scheduled',
    metadata: { entry_point: 'billing_channel_email_deferred', requires_registered_dispatch: true,
      channel: 'email', billingDeliveryLeg: 'email', notificationEventKey: 'receipt:event-1',
      billing_email_siblings: { sms: 'pending' } } });
});

test('uncertain acceptance is a durable blocked hold, never an automatic scheduled retry', async () => {
  await obligation.queueObligation(notice(), 'payment_receipt', 'receipt:uncertain',
    { sent: false, deliveryOutcome: 'uncertain' }, ['push']);
  expect(db._rows[0]).toMatchObject({ status: 'blocked',
    metadata: { billing_email_uncertain: true, billing_email_siblings: { push: 'pending' } } });
  expect(await obligation.findObligation(customerId, 'receipt:uncertain')).toMatchObject({
    blocked: true, deliveryOutcome: 'uncertain', siblingStates: { push: 'pending' },
  });
});

test('sibling claim and outcome transitions distinguish accepted from definitely not sent', async () => {
  await obligation.queueObligation(notice(), 'payment_receipt', 'receipt:event-2',
    { sent: false, retryable: true, deliveryOutcome: 'not_sent' }, ['sms']);
  expect(await obligation.claimSibling('queue-1', 'sms')).toBe(true);
  expect(await obligation.claimSibling('queue-1', 'sms')).toBe(false);
  expect(await obligation.transitionSibling('queue-1', 'sms', 'started', 'not_sent')).toBe(true);
  expect(await obligation.claimSibling('queue-1', 'sms')).toBe(true);
  expect(await obligation.transitionSibling('queue-1', 'sms', 'started', 'accepted')).toBe(true);
  expect(await obligation.claimSibling('queue-1', 'sms')).toBe(false);
});

test('registered replay invokes only canonical Email with original event key and a fresh recipient', async () => {
  await obligation.queueObligation(notice(), 'payment_receipt', 'receipt:event-3',
    { sent: false, retryable: true, deliveryOutcome: 'not_sent' }, ['sms']);
  sendCustomerMessage.mockResolvedValue({ sent: true, deliveryOutcome: 'accepted', channel: 'email' });
  const meta = { ...db._rows[0].metadata, scheduled_sms_log_id: 'queue-1' };
  await expect(obligation.replay(meta)).resolves.toMatchObject({ sent: true, deliveryOutcome: 'accepted' });
  expect(sendCustomerMessage).toHaveBeenCalledWith(expect.objectContaining({ to: '', channel: 'email',
    body: 'Your receipt is ready.', metadata: expect.objectContaining({
      billingDeliveryLeg: 'email', notificationEventKey: 'receipt:event-3',
    }) }));
  expect(sendCustomerMessage.mock.calls[0][0].metadata.billingDeliveryLeg).toBe('email');
});

test('scheduler pre-dispatch recheck accepts its metadata before it adds the queue id', async () => {
  await expect(obligation.recheck({ customer_id: customerId,
    notificationEventKey: 'receipt:event-3', billingDeliveryLeg: 'email', channel: 'email' }))
    .resolves.toEqual({ eligible: true });
});

test('canonical replay preserves a fresh preference refusal and never fans out to Text', async () => {
  await obligation.queueObligation(notice(), 'payment_receipt', 'receipt:event-4',
    { sent: false, retryable: true, deliveryOutcome: 'not_sent' }, ['sms']);
  sendCustomerMessage.mockResolvedValue({ sent: false, blocked: true,
    deliveryOutcome: 'not_sent', code: 'BILLING_EMAIL_NOT_SELECTED' });
  const meta = { ...db._rows[0].metadata, scheduled_sms_log_id: 'queue-1' };
  await expect(obligation.replay(meta)).resolves.toMatchObject({ sent: false, code: 'BILLING_EMAIL_NOT_SELECTED' });
  expect(sendCustomerMessage).toHaveBeenCalledTimes(1);
  expect(sendCustomerMessage.mock.calls[0][0].channel).toBe('email');
});

test('pre-charge replay refuses a paused customer before Email provider preparation', async () => {
  const chargeDate = etDateString(addETDays(new Date(), 3));
  db._customers.set(customerId, { id: customerId, active: true, autopay_enabled: true,
    monthly_rate: 49, billing_mode: 'monthly_membership', billing_day: Number(chargeDate.slice(-2)),
    autopay_paused_until: chargeDate });
  const meta = { customer_id: customerId, notificationEventKey: 'precharge:event',
    billingDeliveryLeg: 'email', channel: 'email', scheduled_sms_log_id: 'queue-1',
    source_entry_point: 'autopay_pre_charge_reminder', charge_date: chargeDate };
  await expect(obligation.recheck(meta)).resolves.toMatchObject({ eligible: false,
    reason: 'precharge-no-longer-eligible' });
  expect(sendCustomerMessage).not.toHaveBeenCalled();
});

test('card-expiry replay refuses a replaced card before Email provider preparation', async () => {
  db._customers.set(customerId, { id: customerId, active: true, autopay_enabled: true });
  db._methods.set('card-old', { id: 'card-old', customer_id: customerId,
    processor: 'stripe', autopay_enabled: true, stripe_payment_method_id: 'pm_old',
    method_type: 'card', exp_month: '10', exp_year: '2026' });
  getChargeableAutopayMethod.mockResolvedValue({ id: 'card-new' });
  const meta = { customer_id: customerId, notificationEventKey: 'expiry:event',
    billingDeliveryLeg: 'email', channel: 'email', scheduled_sms_log_id: 'queue-1',
    source_entry_point: 'autopay_card_expiry_warning', payment_method_id: 'card-old',
    expiry_month: '10', expiry_year: '2026' };
  await expect(obligation.recheck(meta)).resolves.toMatchObject({ eligible: false,
    reason: 'expiry-method-replaced' });
  expect(sendCustomerMessage).not.toHaveBeenCalled();
});

test.each(['autopay_card_expiry_warning', 'payment_expiry_workflow'])(
  '%s keeps a healthy default card selected after an expired pointer', async (source) => {
    const [thisYear, thisMonth] = etDateString().split('-').map(Number);
    const expiryYear = thisMonth === 12 ? thisYear + 1 : thisYear;
    const expiryMonth = thisMonth === 12 ? 1 : thisMonth + 1;
    db._customers.set(customerId, { id: customerId, active: true, autopay_enabled: true,
      pipeline_stage: 'active_customer', autopay_payment_method_id: 'card-expired' });
    db._methods.set('card-default', { id: 'card-default', customer_id: customerId,
      processor: 'stripe', autopay_enabled: true, stripe_payment_method_id: 'pm_default',
      method_type: 'card', exp_month: String(expiryMonth), exp_year: String(expiryYear) });
    getChargeableAutopayMethod.mockImplementation(async (_customer, _database, options) =>
      options.ignoreCardExpiry ? { id: 'card-expired' } : { id: 'card-default' });
    const meta = { customer_id: customerId, notificationEventKey: 'expiry:current-default',
      billingDeliveryLeg: 'email', channel: 'email', source_entry_point: source,
      payment_method_id: 'card-default', expiry_month: expiryMonth, expiry_year: expiryYear,
      expiry_stage: 'soon' };
    await expect(obligation.producerEligible(meta)).resolves.toEqual({ eligible: true });
    expect(getChargeableAutopayMethod.mock.calls.at(-1)[2].ignoreCardExpiry).toBeUndefined();
  },
);

describe('producerEligible refusal codes', () => {
  test('autopay_pre_charge_reminder refuses a malformed or missing charge date', async () => {
    await expect(obligation.producerEligible({ source_entry_point: 'autopay_pre_charge_reminder',
      customer_id: customerId, charge_date: 'not-a-date' }))
      .resolves.toEqual({ eligible: false, reason: 'charge-date-missing', retryable: false });
  });

  test('autopay_pre_charge_reminder refuses a charge date that is no longer three days out', async () => {
    await expect(obligation.producerEligible({ source_entry_point: 'autopay_pre_charge_reminder',
      customer_id: customerId, charge_date: '2000-01-01' }))
      .resolves.toEqual({ eligible: false, reason: 'charge-date-passed', retryable: false });
  });

  test.each(['autopay_card_expiry_warning', 'payment_expiry_workflow'])(
    '%s refuses when the expiry pin is incomplete', async (source) => {
      await expect(obligation.producerEligible({ source_entry_point: source, customer_id: customerId,
        payment_method_id: 'card-1', expiry_month: '6' }))
        .resolves.toEqual({ eligible: false, reason: 'expiry-pin-missing', retryable: false });
    },
  );

  test.each(['autopay_card_expiry_warning', 'payment_expiry_workflow'])(
    '%s refuses when the customer record is gone or inactive', async (source) => {
      await expect(obligation.producerEligible({ source_entry_point: source, customer_id: customerId,
        payment_method_id: 'card-1', expiry_month: '6', expiry_year: '2027' }))
        .resolves.toEqual({ eligible: false, reason: 'customer-no-longer-active', retryable: false });
    },
  );

  test('autopay_card_expiry_warning refuses when autopay has been turned off', async () => {
    db._customers.set(customerId, { id: customerId, active: true, autopay_enabled: false });
    await expect(obligation.producerEligible({ source_entry_point: 'autopay_card_expiry_warning',
      customer_id: customerId, payment_method_id: 'card-1', expiry_month: '6', expiry_year: '2027' }))
      .resolves.toEqual({ eligible: false, reason: 'autopay-disabled', retryable: false });
  });

  test.each(['autopay_card_expiry_warning', 'payment_expiry_workflow'])(
    '%s refuses when the pinned payment method is gone or no longer matches', async (source) => {
      db._customers.set(customerId, { id: customerId, active: true, autopay_enabled: true });
      await expect(obligation.producerEligible({ source_entry_point: source, customer_id: customerId,
        payment_method_id: 'card-missing', expiry_month: '6', expiry_year: '2027' }))
        .resolves.toEqual({ eligible: false, reason: 'expiry-method-changed', retryable: false });
    },
  );

  test('payment_expiry_workflow refuses a card whose expiry window has passed', async () => {
    const [year, month] = etDateString().split('-').map(Number);
    const farMonth = ((month + 5 - 1) % 12) + 1;
    const farYear = month + 5 > 12 ? year + 1 : year;
    db._customers.set(customerId, { id: customerId, active: true, pipeline_stage: 'active_customer' });
    db._methods.set('card-1', { id: 'card-1', customer_id: customerId, processor: 'stripe', autopay_enabled: true,
      stripe_payment_method_id: 'pm_1', method_type: 'card', exp_month: String(farMonth), exp_year: String(farYear) });
    getChargeableAutopayMethod.mockResolvedValue({ id: 'card-1' });
    await expect(obligation.producerEligible({ source_entry_point: 'payment_expiry_workflow', customer_id: customerId,
      payment_method_id: 'card-1', expiry_month: String(farMonth), expiry_year: String(farYear) }))
      .resolves.toEqual({ eligible: false, reason: 'expiry-window-passed', retryable: false });
  });

  test('payment_expiry_workflow refuses a former customer even inside the expiry window', async () => {
    const [year, month] = etDateString().split('-').map(Number);
    db._customers.set(customerId, { id: customerId, active: true, pipeline_stage: 'lost' });
    db._methods.set('card-1', { id: 'card-1', customer_id: customerId, processor: 'stripe', autopay_enabled: true,
      stripe_payment_method_id: 'pm_1', method_type: 'card', exp_month: String(month), exp_year: String(year) });
    getChargeableAutopayMethod.mockResolvedValue({ id: 'card-1' });
    await expect(obligation.producerEligible({ source_entry_point: 'payment_expiry_workflow', customer_id: customerId,
      payment_method_id: 'card-1', expiry_month: String(month), expiry_year: String(year) }))
      .resolves.toEqual({ eligible: false, reason: 'former-customer', retryable: false });
  });

  test('payment_expiry_workflow refuses a lapsed pipeline stage with no paid history or upcoming visit', async () => {
    const [year, month] = etDateString().split('-').map(Number);
    db._customers.set(customerId, { id: customerId, active: true, pipeline_stage: 'nurture' });
    db._methods.set('card-1', { id: 'card-1', customer_id: customerId, processor: 'stripe', autopay_enabled: true,
      stripe_payment_method_id: 'pm_1', method_type: 'card', exp_month: String(month), exp_year: String(year) });
    getChargeableAutopayMethod.mockResolvedValue({ id: 'card-1' });
    await expect(obligation.producerEligible({ source_entry_point: 'payment_expiry_workflow', customer_id: customerId,
      payment_method_id: 'card-1', expiry_month: String(month), expiry_year: String(year) }))
      .resolves.toEqual({ eligible: false, reason: 'payment-relationship-ended', retryable: false });
  });

  test('autopay_card_expiry_warning refuses a card outside its 60-day warning horizon', async () => {
    const [year, month] = etDateString().split('-').map(Number);
    const farMonth = ((month + 5 - 1) % 12) + 1;
    const farYear = month + 5 > 12 ? year + 1 : year;
    db._customers.set(customerId, { id: customerId, active: true, autopay_enabled: true });
    db._methods.set('card-1', { id: 'card-1', customer_id: customerId, processor: 'stripe', autopay_enabled: true,
      stripe_payment_method_id: 'pm_1', method_type: 'card', exp_month: String(farMonth), exp_year: String(farYear) });
    getChargeableAutopayMethod.mockResolvedValue({ id: 'card-1' });
    await expect(obligation.producerEligible({ source_entry_point: 'autopay_card_expiry_warning', customer_id: customerId,
      payment_method_id: 'card-1', expiry_month: String(farMonth), expiry_year: String(farYear), expiry_stage: 'soon' }))
      .resolves.toEqual({ eligible: false, reason: 'expiry-window-passed', retryable: false });
  });

  test('autopay_card_expiry_warning refuses when the expired/soon stage no longer matches the card', async () => {
    const [year, month] = etDateString().split('-').map(Number);
    db._customers.set(customerId, { id: customerId, active: true, autopay_enabled: true });
    db._methods.set('card-1', { id: 'card-1', customer_id: customerId, processor: 'stripe', autopay_enabled: true,
      stripe_payment_method_id: 'pm_1', method_type: 'card', exp_month: String(month), exp_year: String(year) });
    getChargeableAutopayMethod.mockResolvedValue({ id: 'card-1' });
    // The current month has not expired yet, but the stamped stage claims it already has.
    await expect(obligation.producerEligible({ source_entry_point: 'autopay_card_expiry_warning', customer_id: customerId,
      payment_method_id: 'card-1', expiry_month: String(month), expiry_year: String(year), expiry_stage: 'expired' }))
      .resolves.toEqual({ eligible: false, reason: 'expiry-stage-changed', retryable: false });
  });

  test('autopay_card_expiry_warning honors an annual-prepay card-expiry exemption', async () => {
    const [year, month] = etDateString().split('-').map(Number);
    db._customers.set(customerId, { id: customerId, active: true, autopay_enabled: true });
    db._methods.set('card-1', { id: 'card-1', customer_id: customerId, processor: 'stripe', autopay_enabled: true,
      stripe_payment_method_id: 'pm_1', method_type: 'card', exp_month: String(month), exp_year: String(year) });
    getChargeableAutopayMethod.mockResolvedValue({ id: 'card-1' });
    getCardExpiryExemptions.mockResolvedValueOnce({ customerIds: new Set([customerId]), chargeMethodIdsByCustomer: new Map() });
    await expect(obligation.producerEligible({ source_entry_point: 'autopay_card_expiry_warning', customer_id: customerId,
      payment_method_id: 'card-1', expiry_month: String(month), expiry_year: String(year), expiry_stage: 'soon' }))
      .resolves.toEqual({ eligible: false, reason: 'prepay-covered', retryable: false });
  });
});
