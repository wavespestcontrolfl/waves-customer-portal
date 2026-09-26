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
jest.mock('../services/collections/rail-guard', () => ({ collectionsChannelPermitted: jest.fn() }));
jest.mock('../services/collections/contact-ledger', () => ({ markDelivered: jest.fn(async () => true) }));

const db = require('../models/db');
const { sendCustomerMessage } = require('../services/messaging/send-customer-message');
const { collectionsChannelPermitted } = require('../services/collections/rail-guard');
const collectionsContactLedgerMock = require('../services/collections/contact-ledger');
const { etDateString, addETDays } = require('../utils/datetime-et');
const { getChargeableAutopayMethod } = require('../services/autopay-eligibility');
const { getCardExpiryExemptions } = require('../services/annual-prepay-renewals');
const obligation = require('../services/messaging/billing-channel-email-obligation');
const customerId = '11111111-1111-4111-8111-111111111111';

beforeEach(() => {
  jest.clearAllMocks();
  delete process.env.GATE_COLLECTIONS_POLICY;
  db._rows.length = 0;
  db._customers.clear();
  db._methods.clear();
});

afterEach(() => {
  delete process.env.GATE_COLLECTIONS_POLICY;
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

test('a stored definite SendGrid rejection queues a retryable owner', async () => {
  db._rows.push({ idempotency_key: obligation.obligationKey('receipt:event-definite'), status: 'failed',
    error_message: 'SendGrid 400: The from address does not match a verified Sender Identity', metadata: {} });
  const result = { sent: false, retryable: true, deliveryOutcome: 'not_sent', code: 'EMAIL_PROVIDER_REJECTED' };
  const queued = await obligation.queueObligation(notice(), 'payment_receipt', 'receipt:event-definite', result, ['sms']);
  expect(queued).toMatchObject({ queued: true, uncertain: false });
  const row = db._rows.find((candidate) => candidate.id === queued.id);
  expect(row).toMatchObject({ status: 'scheduled', metadata: { billing_email_uncertain: false } });
});

test.each([
  ['a transport timeout', 'The operation was aborted due to timeout'],
  ['a provider 5xx', 'SendGrid 503: Service Unavailable'],
  ['an ambiguous 408', 'SendGrid 408: Request Timeout'],
])('%s on an earlier attempt stays held even when this caller reports not_sent', async (_label, errorMessage) => {
  db._rows.push({ idempotency_key: obligation.obligationKey('receipt:event-ambiguous'), status: 'failed',
    error_message: errorMessage, send_attempt_token: 'earlier-attempt', metadata: {} });
  const queued = await obligation.queueObligation(notice(), 'payment_receipt', 'receipt:event-ambiguous',
    { sent: false, retryable: true, deliveryOutcome: 'not_sent' }, ['sms']);
  expect(queued).toMatchObject({ queued: true, uncertain: true });
});

test('a stored definite rejection is retried by replay', async () => {
  db._rows.push({ idempotency_key: obligation.obligationKey('receipt:event-definite-replay'), status: 'failed',
    error_message: 'SendGrid 429: Too Many Requests', send_attempt_token: 'attempt-1', metadata: {} });
  const queued = await obligation.queueObligation(notice(), 'payment_receipt', 'receipt:event-definite-replay',
    { sent: false, retryable: true, deliveryOutcome: 'not_sent' }, ['sms']);
  const row = db._rows.find((candidate) => candidate.id === queued.id);
  sendCustomerMessage.mockResolvedValue({ sent: true, deliveryOutcome: 'accepted', channel: 'email' });
  await expect(obligation.replay({ ...row.metadata, scheduled_sms_log_id: queued.id }))
    .resolves.toMatchObject({ sent: true, deliveryOutcome: 'accepted' });
  expect(sendCustomerMessage).toHaveBeenCalledTimes(1);
});

test('a genuinely ambiguous in-flight collision row still holds even against a definite input result', async () => {
  // The row is NOT concluded (still 'queued', i.e. another caller's provider
  // handoff may still be in flight) — no evidence ties it to THIS attempt's
  // definite result, so it must stay held (don't weaken the uncertain
  // protections).
  db._rows.push({ idempotency_key: obligation.obligationKey('receipt:event-inflight'), status: 'queued', metadata: {} });
  const result = { sent: false, retryable: true, deliveryOutcome: 'not_sent' };
  const queued = await obligation.queueObligation(notice(), 'payment_receipt', 'receipt:event-inflight', result, ['sms']);
  expect(queued).toMatchObject({ queued: true, uncertain: true });
});

test('an ambiguous initial result still holds even against a concluded failed collision row', async () => {
  // The caller's OWN result is itself uncertain (e.g. a transport timeout) —
  // a concluded row alone must not override that.
  db._rows.push({ idempotency_key: obligation.obligationKey('receipt:event-ambiguous-input'), status: 'failed',
    error_message: 'transport response lost', metadata: {} });
  const result = { sent: false, deliveryOutcome: 'uncertain' };
  const queued = await obligation.queueObligation(notice(), 'payment_receipt', 'receipt:event-ambiguous-input', result, ['sms']);
  expect(queued).toMatchObject({ queued: true, uncertain: true });
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

test('a pre-fence replay exception is retryable, not blocked, when the provider was never reached', async () => {
  // sendCustomerMessage() throws before ever invoking the replay's own
  // preSendCheck (which would have claimed fence.providerStarted) — the
  // fence proves no provider request began, so this must be retryable
  // not_sent, never the durable uncertain/blocked hold.
  await obligation.queueObligation(notice(), 'payment_receipt', 'receipt:event-prefence',
    { sent: false, retryable: true, deliveryOutcome: 'not_sent' }, ['sms']);
  sendCustomerMessage.mockImplementationOnce(async () => { throw new Error('boom before the fence'); });
  const meta = { ...db._rows[0].metadata, scheduled_sms_log_id: 'queue-1' };
  await expect(obligation.replay(meta)).resolves.toEqual({ sent: false, blocked: false,
    deliveryOutcome: 'not_sent', retryable: true, code: 'BILLING_EMAIL_REPLAY_PRE_FENCE_ERROR' });
});

test('a pre-fence exception carrying an uncertain providerOutcome still holds as uncertain', async () => {
  // sendCustomerMessageCore tags every throw with its observed providerOutcome
  // — an uncertain one must still be trusted over the pre-fence default.
  await obligation.queueObligation(notice(), 'payment_receipt', 'receipt:event-prefence-uncertain',
    { sent: false, retryable: true, deliveryOutcome: 'not_sent' }, ['sms']);
  sendCustomerMessage.mockImplementationOnce(async () => {
    const err = new Error('ambiguous provider state');
    err.providerOutcome = { sent: false, deliveryOutcome: 'uncertain' };
    throw err;
  });
  const meta = { ...db._rows[0].metadata, scheduled_sms_log_id: 'queue-1' };
  await expect(obligation.replay(meta)).resolves.toMatchObject({ sent: false, blocked: true,
    deliveryOutcome: 'uncertain', code: 'BILLING_EMAIL_DELIVERY_UNCERTAIN' });
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

  test.each([[0, 'charge-date-passed'], [-1, 'charge-date-passed'], [4, 'charge-date-not-due']])(
    'autopay_pre_charge_reminder refuses a charge date %i ET days out', async (offset, reason) => {
      await expect(obligation.producerEligible({ source_entry_point: 'autopay_pre_charge_reminder',
        customer_id: customerId, charge_date: etDateString(addETDays(new Date(), offset)) }))
        .resolves.toEqual({ eligible: false, reason, retryable: false });
    },
  );

  test.each([1, 2, 3])('autopay_pre_charge_reminder keeps a charge %i ET days ahead in the notice window', async (offset) => {
    const verdict = await obligation.producerEligible({ source_entry_point: 'autopay_pre_charge_reminder',
      customer_id: customerId, charge_date: etDateString(addETDays(new Date(), offset)) });
    // No customer row is mocked, so the date check passes and the live
    // customer check refuses next.
    expect(verdict).toEqual({ eligible: false, reason: 'precharge-no-longer-eligible', retryable: false });
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

describe('producerEligible reuses the registry\'s full invoice collectibility recheck', () => {
  const invoiceId = 'invoice-collectibility-1';
  const reminderSource = 'invoice_followup_sequence';

  test('refuses a terminal invoice that selfPayAtDispatch alone would not catch', async () => {
    db._rows.push({ id: invoiceId, status: 'paid', total: 100, credit_applied: 0 });
    await expect(obligation.producerEligible({ customer_id: customerId, invoice_id: invoiceId,
      source_entry_point: reminderSource }))
      .resolves.toMatchObject({ eligible: false, reason: 'invoice-terminal:paid' });
  });

  test('refuses when the invoice\'s followup sequence has been stopped', async () => {
    db._rows.push({ id: invoiceId, status: 'sent', total: 100, credit_applied: 0 });
    db._rows.push({ id: 'sequence-1', status: 'stopped' });
    await expect(obligation.producerEligible({ customer_id: customerId, invoice_id: invoiceId,
      source_entry_point: reminderSource, followup_sequence_id: 'sequence-1' }))
      .resolves.toMatchObject({ eligible: false, reason: 'sequence-stopped' });
  });

  test('refuses when the live balance no longer matches the rendered amount', async () => {
    db._rows.push({ id: invoiceId, status: 'sent', total: 100, credit_applied: 0 });
    await expect(obligation.producerEligible({ customer_id: customerId, invoice_id: invoiceId,
      source_entry_point: reminderSource, rendered_amount: '50.00' }))
      .resolves.toMatchObject({ eligible: false, reason: 'amount-changed' });
  });

  test('remains eligible when both the collectibility recheck and the kept self-pay check agree', async () => {
    db._rows.push({ id: invoiceId, status: 'sent', total: 100, credit_applied: 0, payer_id: null });
    await expect(obligation.producerEligible({ customer_id: customerId, invoice_id: invoiceId,
      source_entry_point: reminderSource }))
      .resolves.toEqual({ eligible: true });
  });

  // codex r2 #4844 P1: payment-receipt sends carry an invoiceId too but fire
  // AFTER the payment that made the invoice terminal — the collectibility
  // recheck must apply only to the INVOICE_GUARDS reminder/dunning entry
  // points, never to a receipt-sourced obligation.
  test('a receipt-sourced obligation on a paid invoice stays eligible (self-pay check only)', async () => {
    db._rows.push({ id: invoiceId, status: 'paid', total: 100, credit_applied: 0, payer_id: null });
    await expect(obligation.producerEligible({ customer_id: customerId, invoice_id: invoiceId,
      source_entry_point: 'invoice_receipt_sms' }))
      .resolves.toEqual({ eligible: true });
    // No source_entry_point at all (legacy/unspecified) also bypasses it.
    await expect(obligation.producerEligible({ customer_id: customerId, invoice_id: invoiceId }))
      .resolves.toEqual({ eligible: true });
  });

  test('a reminder-sourced obligation on the same paid invoice still refuses', async () => {
    db._rows.push({ id: invoiceId, status: 'paid', total: 100, credit_applied: 0, payer_id: null });
    await expect(obligation.producerEligible({ customer_id: customerId, invoice_id: invoiceId,
      source_entry_point: reminderSource }))
      .resolves.toMatchObject({ eligible: false, reason: 'invoice-terminal:paid' });
  });
});

describe('collections policy recheck on INVOICE_GUARDS-sourced obligations (codex r2 #4844 P1)', () => {
  const invoiceId = 'invoice-collections-policy-1';
  const reminderSource = 'balance_reminder_late_payment_check';
  const ledgerId = 'ledger-reservation-1';

  beforeEach(() => {
    db._rows.push({ id: invoiceId, status: 'sent', total: 100, credit_applied: 0, payer_id: null });
  });

  test('gate on + denied refuses collections-policy-denied', async () => {
    process.env.GATE_COLLECTIONS_POLICY = 'true';
    collectionsChannelPermitted.mockResolvedValue(false);
    await expect(obligation.producerEligible({ customer_id: customerId, invoice_id: invoiceId,
      source_entry_point: reminderSource, collections_ledger_id: ledgerId }))
      .resolves.toEqual({ eligible: false, reason: 'collections-policy-denied', retryable: false });
  });

  test('gate on + permitted passes the persisted reservation id as an exclusion', async () => {
    process.env.GATE_COLLECTIONS_POLICY = 'true';
    collectionsChannelPermitted.mockResolvedValue(true);
    await expect(obligation.producerEligible({ customer_id: customerId, invoice_id: invoiceId,
      source_entry_point: reminderSource, collections_ledger_id: ledgerId }))
      .resolves.toEqual({ eligible: true });
    expect(collectionsChannelPermitted).toHaveBeenCalledWith(expect.objectContaining({
      customerId, invoiceId, channel: 'email', purpose: 'late_payment', excludeLedgerIds: [ledgerId],
    }));
  });

  test('no persisted reservation id passes an empty exclusion list (safe over-suppression direction)', async () => {
    process.env.GATE_COLLECTIONS_POLICY = 'true';
    collectionsChannelPermitted.mockResolvedValue(true);
    await expect(obligation.producerEligible({ customer_id: customerId, invoice_id: invoiceId,
      source_entry_point: reminderSource }))
      .resolves.toEqual({ eligible: true });
    expect(collectionsChannelPermitted).toHaveBeenCalledWith(expect.objectContaining({ excludeLedgerIds: [] }));
  });

  test('gate off never consults the rail guard', async () => {
    await expect(obligation.producerEligible({ customer_id: customerId, invoice_id: invoiceId,
      source_entry_point: reminderSource, collections_ledger_id: ledgerId }))
      .resolves.toEqual({ eligible: true });
    expect(collectionsChannelPermitted).not.toHaveBeenCalled();
  });

  test('a rail-guard lookup throw fails closed', async () => {
    process.env.GATE_COLLECTIONS_POLICY = 'true';
    collectionsChannelPermitted.mockRejectedValue(new Error('boom'));
    await expect(obligation.recheck({ customer_id: customerId, notificationEventKey: 'reminder:event',
      billingDeliveryLeg: 'email', channel: 'email', invoice_id: invoiceId,
      source_entry_point: reminderSource, collections_ledger_id: ledgerId }))
      .resolves.toMatchObject({ eligible: false });
  });

  test('a non-INVOICE_GUARDS source never consults the rail guard even with the gate on', async () => {
    process.env.GATE_COLLECTIONS_POLICY = 'true';
    await expect(obligation.producerEligible({ customer_id: customerId, invoice_id: invoiceId,
      source_entry_point: 'invoice_receipt_sms', collections_ledger_id: ledgerId }))
      .resolves.toEqual({ eligible: true });
    expect(collectionsChannelPermitted).not.toHaveBeenCalled();
  });
});

describe('collections ledger settlement after an accepted replay (codex r2 #4844 P1)', () => {
  const reminderSource = 'invoice_followup_sequence';
  const ledgerId = 'ledger-reservation-settle-1';

  test('an accepted dispatch settles the persisted reservation as delivered', async () => {
    await obligation.queueObligation({ customerId, purpose: 'late_payment', body: 'Your balance is due.',
      metadata: { original_message_type: 'reminder' }, entryPoint: reminderSource },
    'balance_reminder', 'reminder:event-settle', { sent: false, retryable: true, deliveryOutcome: 'not_sent' }, []);
    sendCustomerMessage.mockResolvedValue({ sent: true, deliveryOutcome: 'accepted', channel: 'email' });
    const meta = { ...db._rows[0].metadata, collections_ledger_id: ledgerId, scheduled_sms_log_id: 'queue-1' };
    await expect(obligation.replay(meta)).resolves.toMatchObject({ sent: true, deliveryOutcome: 'accepted' });
    expect(collectionsContactLedgerMock.markDelivered).toHaveBeenCalledWith({ id: ledgerId });
  });

  test('a dedupe-accepted replay (from canonical email evidence) also settles the reservation', async () => {
    await obligation.queueObligation({ customerId, purpose: 'late_payment', body: 'Your balance is due.',
      metadata: { original_message_type: 'reminder' }, entryPoint: reminderSource },
    'balance_reminder', 'reminder:event-dedupe', { sent: false, retryable: true, deliveryOutcome: 'not_sent' }, []);
    db._rows.push({ idempotency_key: obligation.obligationKey('reminder:event-dedupe'), status: 'delivered',
      provider_message_id: 'sg-1', metadata: {} });
    const meta = { ...db._rows.find((r) => r.id === 'queue-1').metadata, collections_ledger_id: ledgerId,
      scheduled_sms_log_id: 'queue-1' };
    await expect(obligation.replay(meta)).resolves.toMatchObject({ sent: true, deliveryOutcome: 'accepted', deduped: true });
    expect(collectionsContactLedgerMock.markDelivered).toHaveBeenCalledWith({ id: ledgerId });
    expect(sendCustomerMessage).not.toHaveBeenCalled();
  });

  test('no persisted reservation id never touches the ledger', async () => {
    await obligation.queueObligation({ customerId, purpose: 'late_payment', body: 'Your balance is due.',
      metadata: { original_message_type: 'reminder' }, entryPoint: reminderSource },
    'balance_reminder', 'reminder:event-no-ledger', { sent: false, retryable: true, deliveryOutcome: 'not_sent' }, []);
    sendCustomerMessage.mockResolvedValue({ sent: true, deliveryOutcome: 'accepted', channel: 'email' });
    const meta = { ...db._rows[0].metadata, scheduled_sms_log_id: 'queue-1' };
    await expect(obligation.replay(meta)).resolves.toMatchObject({ sent: true, deliveryOutcome: 'accepted' });
    expect(collectionsContactLedgerMock.markDelivered).not.toHaveBeenCalled();
  });
});

describe('a surviving provider fence reconciles against canonical email evidence first (codex r2 #4844 P2)', () => {
  test('definitive accepted evidence resolves accepted (deduped) even with a surviving fence', async () => {
    await obligation.queueObligation(notice(), 'payment_receipt', 'receipt:event-fence-accepted',
      { sent: false, retryable: true, deliveryOutcome: 'not_sent' }, []);
    // Simulate stale-claim recovery leaving the provider-started fence in
    // place on the owner row (process died after handoff, before the row
    // was marked sent) — mutate the row directly since the shared test-db
    // mock's update() is purpose-built only for the sibling-transition path.
    db._rows.find((r) => r.id === 'queue-1').metadata.billing_email_provider_started_at = new Date().toISOString();
    // SendGrid's own canonical acceptance evidence, recorded against the
    // same idempotency key, survived the crash.
    db._rows.push({ idempotency_key: obligation.obligationKey('receipt:event-fence-accepted'), status: 'delivered',
      provider_message_id: 'sg-fence-1', metadata: {} });
    const meta = { ...db._rows.find((r) => r.id === 'queue-1').metadata, scheduled_sms_log_id: 'queue-1' };
    await expect(obligation.replay(meta)).resolves.toMatchObject({ sent: true, deliveryOutcome: 'accepted', deduped: true });
    expect(sendCustomerMessage).not.toHaveBeenCalled();
  });

  test('a fence with no definitive provider evidence still stays uncertain', async () => {
    await obligation.queueObligation(notice(), 'payment_receipt', 'receipt:event-fence-unresolved',
      { sent: false, retryable: true, deliveryOutcome: 'not_sent' }, []);
    db._rows.find((r) => r.id === 'queue-1').metadata.billing_email_provider_started_at = new Date().toISOString();
    // No email_messages evidence at all for this key — the fence has
    // nothing definitive to reconcile against, so it must still hold.
    const meta = { ...db._rows.find((r) => r.id === 'queue-1').metadata, scheduled_sms_log_id: 'queue-1' };
    await expect(obligation.replay(meta)).resolves.toMatchObject({ sent: false, blocked: true,
      deliveryOutcome: 'uncertain', code: 'BILLING_EMAIL_DELIVERY_UNCERTAIN' });
    expect(sendCustomerMessage).not.toHaveBeenCalled();
  });
});

describe('collections_ledger_id persistence (codex r2 #4844 P1)', () => {
  test('a producer-supplied reservation id is persisted into the queued row metadata', async () => {
    const input = { customerId, purpose: 'late_payment', body: 'Your balance is due.',
      metadata: { original_message_type: 'reminder', collections_ledger_id: 'ledger-persist-1' },
      entryPoint: 'invoice_followup_sequence' };
    await obligation.queueObligation(input, 'balance_reminder', 'reminder:event-persist',
      { sent: false, retryable: true, deliveryOutcome: 'not_sent' }, []);
    expect(db._rows[0].metadata.collections_ledger_id).toBe('ledger-persist-1');
  });

  test('no reservation id in the enqueue input leaves the field null', async () => {
    await obligation.queueObligation(notice(), 'payment_receipt', 'receipt:event-no-ledger-persist',
      { sent: false, retryable: true, deliveryOutcome: 'not_sent' }, []);
    expect(db._rows[0].metadata.collections_ledger_id).toBeNull();
  });
});
