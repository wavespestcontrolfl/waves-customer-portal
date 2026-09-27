// Opt-in PostgreSQL proof for the legacy previsit Text authority. The suite
// uses real canonical/Twilio code, a disposable schema, and a mocked SDK transport.
let mockPg;
let mockProbeParent = false;
const mockCreate = jest.fn();
jest.mock('../models/db', () => {
  const database = (...args) => mockPg(...args);
  database.transaction = (callback) => mockPg.transaction(async (trx) => {
    const result = await callback(trx);
    if (mockProbeParent) expect((await trx.raw('SELECT 1 AS usable')).rows[0].usable).toBe(1);
    return result;
  });
  database.raw = (...args) => mockPg.raw(...args);
  return database;
});
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

jest.mock('twilio', () => () => ({ messages: { create: mockCreate } }));
jest.mock('../config', () => ({ ...jest.requireActual('../config'),
  twilio: { accountSid: 'ACsynthetic', authToken: 'synthetic' } }));
jest.mock('../config/feature-gates', () => ({ ...jest.requireActual('../config/feature-gates'),
  isEnabled: (gate) => gate === 'twilioSms' }));
jest.mock('../routes/admin-sms-templates', () => ({ isTemplateActive: async () => true }));
jest.mock('../services/conversations', () => ({ recordTouchpoint: async () => null }));
jest.mock('../services/disclaimed-number-holds', () => ({ disclaimedNumberBlocksSend: async () => false }));
jest.mock('../services/messaging/audit', () => ({ persistAudit: async () => ({ id: 'qa' }) }));
jest.mock('../services/messaging/validators/send-window', () => ({ checkSendWindow: () => ({ ok: true }) }));
jest.mock('../services/messaging/validators/line-type', () => ({ checkLineType: () => ({ ok: true }) }));
jest.mock('../services/messaging/compliance-contact-checks', () => ({ checkContactCompliance: () => ({ ok: true }) }));
jest.mock('../services/messaging/push-channel-routing', () => ({
  ...jest.requireActual('../services/messaging/push-channel-routing'),
  wantsAppFirst: jest.fn(async () => false), gatePushRoutingOn: jest.fn(() => false),
  attemptPushFirst: jest.fn(async () => ({ delivered: true, sid: 'push:qa', acceptedAt: new Date() })),
  sendCompanionPush: jest.fn(async () => ({})),
}));

const { randomUUID } = require('node:crypto');
const knex = require('knex');
const { sendCustomerMessage } = require('../services/messaging/send-customer-message');
const PushRouting = require('../services/messaging/push-channel-routing');
const { _test } = require('../services/previsit-balance-reminder');
const { addETDays, etDateString } = require('../utils/datetime-et');

const connection = process.env.APP_TEST_DATABASE_URL;
const postgres = connection ? describe : describe.skip;
const schema = `previsit_text_authority_${randomUUID().replaceAll('-', '')}`;
const customerId = randomUUID();
const visitId = randomUUID();
const invoiceId = randomUUID();
const failedPaymentId = randomUUID();
const phone = '+19415550100';
let admin;
let writer;
let visit;
let quotedInvoice;

function authority(overrides = {}) {
  return _test.previsitQuoteAuthority({
    visit,
    quotedInvoices: [quotedInvoice],
    quotedDuesCents: 0,
    ledgerId: randomUUID(),
    ...overrides,
  });
}

async function runAtProviderBoundary(guard = authority(), metadata = {}) {
  return sendCustomerMessage({
    to: phone, body: 'Your recurring service balance is $96.60.', channel: 'sms',
    audience: 'customer', purpose: 'billing', customerId,
    entryPoint: 'previsit_balance_reminder', ...guard,
    metadata: { fromNumber: '+19415550101', ...metadata },
  });
}

postgres('previsit Text billing authority (PostgreSQL)', () => {
  beforeAll(async () => {
    const target = new URL(connection);
    const privateQa = /^\/waves_qa_[a-f0-9]{32}$/.test(target.pathname);
    const ci = process.env.CI === 'true'
      && ['localhost', '127.0.0.1'].includes(target.hostname)
      && target.pathname === '/waves_test';
    if (!privateQa && !ci) throw new Error('Use a verified private QA database or the isolated CI database');

    admin = knex({ client: 'pg', connection, pool: { min: 0, max: 1 } });
    await admin.schema.createSchema(schema);
    mockPg = knex({ client: 'pg', connection, searchPath: [schema], pool: { min: 0, max: 5 } });
    writer = knex({ client: 'pg', connection, searchPath: [schema], pool: { min: 0, max: 6 } });
    for (const table of ['customers', 'scheduled_services', 'invoices', 'payments', 'activity_log', 'invoice_followup_sequences',
      'collections_flags', 'messaging_suppression', 'collections_contact_ledger', 'call_log', 'notification_prefs', 'sms_log', 'payers']) {
      await mockPg.raw('CREATE TABLE ?? (LIKE ?? INCLUDING ALL)', [table, `public.${table}`]);
    }
    await mockPg.raw('ALTER TABLE scheduled_services ADD CONSTRAINT previsit_visit_customer_fk FOREIGN KEY (customer_id) REFERENCES customers(id)');
    await mockPg.raw('ALTER TABLE invoices ADD CONSTRAINT previsit_invoice_customer_fk FOREIGN KEY (customer_id) REFERENCES customers(id)');
    await mockPg.raw('ALTER TABLE payments ADD CONSTRAINT previsit_payment_customer_fk FOREIGN KEY (customer_id) REFERENCES customers(id)');
    await mockPg.raw('ALTER TABLE sms_log ADD CONSTRAINT previsit_sms_log_customer_fk FOREIGN KEY (customer_id) REFERENCES customers(id)');

    await mockPg.raw('ALTER TABLE invoices ADD CONSTRAINT previsit_invoice_visit_fk FOREIGN KEY (scheduled_service_id) REFERENCES scheduled_services(id)');

    const scheduledDate = etDateString(addETDays(new Date(), 3));
    await mockPg('customers').insert({
      id: customerId,
      account_id: customerId,
      is_primary_profile: true,
      first_name: 'QA',
      last_name: 'Fixture',
      phone,
      email: 'previsit-authority@example.invalid',
      address_line1: '100 QA Way',
      city: 'Bradenton',
      state: 'FL',
      zip: '34201',
      active: true,
      billing_mode: 'per_visit',
    });
    await mockPg('scheduled_services').insert({
      id: visitId,
      customer_id: customerId,
      scheduled_date: scheduledDate,
      service_type: 'Pest Control',
      status: 'confirmed',
      is_recurring: true,
      balance_reminder_sent_at: new Date(),
    });
    const dueDate = etDateString(addETDays(new Date(), -14));
    await mockPg('invoices').insert({
      id: invoiceId,
      token: randomUUID().replaceAll('-', ''),
      invoice_number: `QA-${invoiceId.slice(0, 8)}`,
      customer_id: customerId,
      scheduled_service_id: visitId,
      service_date: dueDate,
      due_date: dueDate,
      status: 'sent',
      total: 96.60,
      credit_applied: 0,
      line_items: JSON.stringify([]),
    });
    await mockPg('payments').insert({
      id: failedPaymentId,
      customer_id: customerId,
      payment_date: dueDate,
      amount: 49,
      status: 'failed',
      description: 'WaveGuard Monthly QA',
      metadata: { billed_month: dueDate.slice(0, 7) },
    });
    visit = {
      id: visitId,
      customer_id: customerId,
      phone,
      scheduled_date: scheduledDate,
      service_type: 'Pest Control',
    };
    quotedInvoice = await mockPg('invoices').where({ id: invoiceId }).first();
  }, 30000);

  beforeEach(() => {
    mockCreate.mockReset().mockResolvedValue({ sid: `SM${'a'.repeat(32)}` });
    PushRouting.wantsAppFirst.mockResolvedValue(false);
    PushRouting.gatePushRoutingOn.mockReturnValue(false);
    PushRouting.sendCompanionPush.mockClear();
  });

  afterEach(async () => {
    mockProbeParent = false;
    delete process.env.GATE_COLLECTIONS_POLICY;
    await mockPg('collections_contact_ledger').del();
    await mockPg('notification_prefs').del();
    await mockPg('payments').whereNot({ id: failedPaymentId }).del();
    await mockPg('invoices').where({ id: invoiceId }).update({ status: 'sent', credit_applied: 0 });
    await mockPg('invoices').whereNot({ id: invoiceId }).del();
    await mockPg('payments').where({ id: failedPaymentId }).update({ status: 'failed' });
    quotedInvoice = await mockPg('invoices').where({ id: invoiceId }).first();
  });

  afterAll(async () => {
    await mockPg?.destroy();
    await writer?.destroy();
    if (admin) { await admin.schema.dropSchemaIfExists(schema, true); await admin.destroy(); }
  });

  test('provider freeze holds payment, credit, new-debt, dues, and failed-payment writers', async () => {
    let entered;
    let release;
    const atProvider = new Promise((resolve) => { entered = resolve; });
    const continueProvider = new Promise((resolve) => { release = resolve; });
    mockCreate.mockImplementationOnce(async () => {
      entered();
      await continueProvider;
      return { sid: `SM${'a'.repeat(32)}` };
    });
    const ineligibleId = randomUUID();
    await mockPg('invoices').insert({ ...quotedInvoice, id: ineligibleId, token: randomUUID(),
      invoice_number: `QA-${ineligibleId.slice(0, 8)}`, status: 'paid', line_items: JSON.stringify([]) });
    const sending = runAtProviderBoundary();
    await Promise.race([atProvider, sending.then((result) => { throw new Error(`Provider never entered: ${JSON.stringify(result)}`); })]);

    const newInvoiceId = randomUUID();
    const newPaymentId = randomUUID();
    const mutations = [
      (trx) => trx('invoices').where({ id: invoiceId }).update({ status: 'paid' }),
      (trx) => trx('invoices').where({ id: ineligibleId }).update({ status: 'sent' }),
      (trx) => trx('invoices').where({ id: invoiceId }).update({ credit_applied: 20 }),
      (trx) => trx('invoices').insert({
        id: newInvoiceId,
        token: randomUUID().replaceAll('-', ''),
        invoice_number: `QA-${newInvoiceId.slice(0, 8)}`,
        customer_id: customerId,
        scheduled_service_id: visitId,
        due_date: etDateString(addETDays(new Date(), -14)),
        status: 'sent',
        total: 25,
        line_items: JSON.stringify([]),
      }),
      (trx) => trx('payments').insert({
        id: newPaymentId,
        customer_id: customerId,
        payment_date: new Date(),
        amount: 49,
        status: 'paid',
        description: 'WaveGuard Monthly QA',
        metadata: { billed_month: etDateString(new Date()).slice(0, 7) },
      }),
      (trx) => trx('payments').where({ id: failedPaymentId }).update({ status: 'paid' }),
    ];
    let proofError;
    try {
      for (const mutate of mutations) {
        await expect(writer.transaction(async (trx) => {
          await trx.raw("SET LOCAL lock_timeout = '100ms'");
          await mutate(trx);
        })).rejects.toMatchObject({ code: '55P03' });
      }
    } catch (err) {
      proofError = err;
    } finally {
      release();
    }
    await expect(sending).resolves.toMatchObject({ sent: true, providerMessageId: `SM${'a'.repeat(32)}` });
    if (proofError) throw proofError;
    expect(mockCreate).toHaveBeenCalledTimes(1);
    expect(await mockPg('sms_log').where({ customer_id: customerId, twilio_sid: `SM${'a'.repeat(32)}` }).first('id')).toBeDefined();
    for (const mutate of mutations) await writer.transaction(mutate);
  }, 30000);

  test('writer-first inverse row lock fails retryably with zero provider calls and leaves the connection usable', async () => {
    mockProbeParent = true;
    await writer.transaction(async (writerTrx) => {
      await writerTrx('payments').where({ id: failedPaymentId }).forUpdate().first();
      await expect(runAtProviderBoundary())
        .resolves.toMatchObject({ sent: false, code: 'PREVISIT_AUTHORITY_UNAVAILABLE', retryable: true });
    });
    expect(mockCreate).not.toHaveBeenCalled();
    await expect(mockPg('customers').where({ id: customerId }).first('id')).resolves.toMatchObject({ id: customerId });
  }, 15000);

  test.each([
    ['invoices', invoiceId, { credit_applied: 1 }],
    ['scheduled_services', visitId, { is_recurring: false }],
    ['scheduled_services', visitId, { status: 'cancelled' }],
    ['customers', customerId, { phone: '+19415550102' }],
  ])('a committed %s change refuses the frozen quote before Twilio', async (table, id, changes) => {
    const original = await mockPg(table).where({ id }).first(Object.keys(changes));
    try {
      await writer(table).where({ id }).update(changes);
      await expect(runAtProviderBoundary()).resolves.toMatchObject({ sent: false, retryable: true });
      expect(mockCreate).not.toHaveBeenCalled();
    } finally { await mockPg(table).where({ id }).update(original); }
  }, 15000);

  test('a live monthly collector advisory claim refuses without entering provider dispatch', async () => {
    mockProbeParent = true;
    const payment = await mockPg('payments').where({ id: failedPaymentId }).first();
    await mockPg('payments').del();
    const conn = await writer.client.acquireConnection();
    try {
      await conn.query({
        text: 'SELECT pg_advisory_lock(hashtext($1))',
        values: [`cron:billing-customer:${customerId}`],
      });
      await expect(runAtProviderBoundary())
        .resolves.toMatchObject({ sent: false, code: 'PREVISIT_AUTHORITY_UNAVAILABLE', retryable: true });
    } finally {
      await conn.query({
        text: 'SELECT pg_advisory_unlock(hashtext($1))',
        values: [`cron:billing-customer:${customerId}`],
      });
      await writer.client.releaseConnection(conn);
      await mockPg('payments').insert(payment);
    }
    expect(mockCreate).not.toHaveBeenCalled();
  }, 15000);

  test('the first partial policy snapshot leaves the original reservation pending until the same quote recovers', async () => {
    process.env.GATE_COLLECTIONS_POLICY = 'true';
    const second = { ...quotedInvoice, id: randomUUID(), token: randomUUID(), invoice_number: `QA-${randomUUID().slice(0, 8)}` };
    await mockPg('invoices').insert({ ...second, line_items: JSON.stringify([]) });
    const ledgerId = randomUUID();
    await mockPg('collections_contact_ledger').insert({ id: ledgerId, customer_id: customerId,
      channel: 'sms', purpose: 'balance_reminder', source: 'previsit_balance_reminder',
      invoice_ids: JSON.stringify([invoiceId, second.id]), metadata: { pending: true } });
    const followups = require('../services/invoice-followups');
    const original = followups.isDunningStopped;
    const stop = jest.spyOn(followups, 'isDunningStopped').mockImplementation(async (id, database) => {
      if (id === second.id) return database.transaction((sp) => sp.raw('SELECT missing_previsit_dunning_column'));
      return original(id, database);
    });
    const evaluate = jest.spyOn(require('../services/collections/contact-policy'), 'evaluate');
    try {
      await expect(runAtProviderBoundary(authority({ quotedInvoices: [quotedInvoice, second], ledgerId })))
        .resolves.toMatchObject({ sent: false, code: 'PREVISIT_AUTHORITY_UNAVAILABLE', retryable: true });
      expect(evaluate).toHaveBeenCalledTimes(1);
      expect((await evaluate.mock.results[0].value).eligibleInvoiceIds).toEqual([invoiceId]);
      expect(mockCreate).not.toHaveBeenCalled();
      expect((await mockPg('collections_contact_ledger').where({ id: ledgerId }).first()).metadata).toEqual({ pending: true });
      stop.mockRestore();
      await expect(runAtProviderBoundary(authority({ quotedInvoices: [quotedInvoice, second], ledgerId })))
        .resolves.toMatchObject({ sent: true });
      expect(mockCreate).toHaveBeenCalledTimes(1);
    } finally { stop.mockRestore(); evaluate.mockRestore(); }
  }, 15000);

  test('automatic companion App delivery follows fenced Text acceptance; explicit App omits SMS authority', async () => {
    PushRouting.gatePushRoutingOn.mockReturnValue(true);
    mockCreate.mockImplementationOnce(async () => {
      expect(PushRouting.sendCompanionPush).not.toHaveBeenCalled();
      await expect(writer.transaction(async (trx) => {
        await trx.raw("SET LOCAL lock_timeout = '100ms'");
        await trx('invoices').where({ id: invoiceId }).update({ credit_applied: 1 });
      })).rejects.toMatchObject({ code: '55P03' });
      return { sid: `SM${'a'.repeat(32)}` };
    });
    await expect(runAtProviderBoundary()).resolves.toMatchObject({ sent: true });
    expect(PushRouting.sendCompanionPush).toHaveBeenCalledTimes(1);
    PushRouting.wantsAppFirst.mockResolvedValue(true);
    const guard = authority();
    const handoff = jest.fn(guard.withSmsHandoff);
    await expect(runAtProviderBoundary({ ...guard, withSmsHandoff: handoff })).resolves.toMatchObject({ sent: true });
    await mockPg('notification_prefs').insert({ customer_id: customerId, billing_channels: ['push'] });
    const explicit = await runAtProviderBoundary({ ...guard, withSmsHandoff: handoff },
      { billingDeliveryCategory: 'billing', billingDeliveryLeg: 'push', appOnly: true });
    expect(explicit).toEqual(expect.objectContaining({ sent: true }));
    expect(handoff).not.toHaveBeenCalled();
    expect(mockCreate).toHaveBeenCalledTimes(1);
  }, 15000);

});
