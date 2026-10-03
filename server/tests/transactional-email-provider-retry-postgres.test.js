// B15: a correction of the customer's email stops the provider-block retries
// still addressed to the address it replaced. Real SQL against a private
// schema: the ownership, address and phase filters are what keep a stop from
// reaching another customer's mail, a different address, a visit summary or a
// request already at the provider, and mocks cannot prove a filter.
const SKIP = !process.env.DATABASE_URL;
const { randomUUID } = require('node:crypto');
const knex = require('knex');

let mockDatabase;
jest.mock('../models/db', () => {
  const database = (...args) => mockDatabase(...args);
  database.transaction = (...args) => mockDatabase.transaction(...args);
  database.raw = (...args) => mockDatabase.raw(...args);
  Object.defineProperty(database, 'client', { get: () => mockDatabase.client });
  return database;
});
jest.mock('../models/marker-db', () => () => require('../models/db'));
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/sendgrid-mail', () => ({
  serviceGroupId: jest.fn(() => 222),
  clearBlockedAddress: jest.fn(async () => ({ cleared: true })),
  sendOne: jest.fn(async () => ({ messageId: 'provider-1' })),
  isDefiniteRejection: jest.fn(() => false),
}));
jest.mock('../services/email-template-library', () => ({
  ...jest.requireActual('../services/email-template-library'),
  loadTemplateByKey: jest.fn(async (key) => ({ template: { template_key: key } })),
  activeSuppressionFor: jest.fn(async () => null),
}));
jest.mock('../services/notification-service', () => ({ notifyAdmin: jest.fn() }));

const retry = require('../services/transactional-email-provider-retry');
const sendgrid = require('../services/sendgrid-mail');
const { BILLING_EMAIL_TERMINAL_REFUSAL_PREFIX } = require('../services/billing-email-reservation');

const postgres = SKIP ? describe.skip : describe;
const schema = `email_retry_replaced_${randomUUID().replaceAll('-', '')}`;
const REASON = 'Customer email was corrected; retry to the replaced address stopped.';
const OLD = 'old.typo@example.com';
const OTHER = 'billing.contact@example.com';
let admin;

postgres('provider-block retries after a customer email correction (PostgreSQL)', () => {
  beforeAll(async () => {
    const target = new URL(process.env.DATABASE_URL);
    const privateQa = /^\/waves_qa_[a-f0-9]{32}$/.test(target.pathname);
    const ci = process.env.CI === 'true'
      && ['localhost', '127.0.0.1'].includes(target.hostname)
      && target.pathname === '/waves_test';
    if (!privateQa && !ci) throw new Error('Use a verified private QA database or the isolated CI database');
    admin = knex({ client: 'pg', connection: process.env.DATABASE_URL, pool: { min: 0, max: 1 } });
    await admin.schema.createSchema(schema);
    mockDatabase = knex({ client: 'pg', connection: process.env.DATABASE_URL,
      searchPath: [schema], pool: { min: 0, max: 4 } });
    await mockDatabase.schema.createTable('email_messages', (table) => {
      table.uuid('id').primary().defaultTo(mockDatabase.raw('gen_random_uuid()'));
      table.string('template_key');
      table.string('recipient_type');
      table.string('recipient_id');
      table.uuid('lead_id');
      table.uuid('estimate_id');
      table.string('recipient_email_snapshot');
      table.string('subject_snapshot');
      table.text('html_snapshot');
      table.text('text_snapshot');
      table.string('suppression_group_key_snapshot');
      table.string('trigger_event_id');
      table.string('idempotency_key');
      table.jsonb('payload_snapshot');
      table.jsonb('categories');
      table.boolean('has_attachments').notNullable().defaultTo(false);
      table.string('provider_message_id');
      table.string('send_attempt_token');
      table.string('provider_handoff_attempt_token');
      table.string('provider_handoff_phase');
      table.string('status');
      table.text('error_message');
      table.timestamp('provider_retry_exhausted_at', { useTz: true });
      table.timestamp('provider_retry_next_at', { useTz: true });
      table.integer('provider_retry_count').notNullable().defaultTo(0);
      table.timestamp('queued_at', { useTz: true });
      table.timestamp('sent_at', { useTz: true });
      table.timestamp('delivered_at', { useTz: true });
      table.timestamp('opened_at', { useTz: true });
      table.timestamp('clicked_at', { useTz: true });
      table.timestamp('updated_at', { useTz: true });
    });
    await mockDatabase.schema.createTable('leads', (table) => {
      table.uuid('id').primary(); table.string('customer_id');
    });
    await mockDatabase.schema.createTable('estimates', (table) => {
      table.uuid('id').primary(); table.string('customer_id');
    });
    await mockDatabase.schema.createTable('collections_contact_ledger', (table) => {
      table.uuid('id').primary();
      table.uuid('customer_id').notNullable();
      table.string('channel', 20).notNullable();
      table.string('purpose', 40).notNullable();
      table.jsonb('invoice_ids').notNullable();
      table.timestamp('occurred_at', { useTz: true }).notNullable();
      table.string('source', 60).notNullable();
      table.jsonb('metadata');
    });
  }, 30000);

  beforeEach(() => jest.clearAllMocks());
  afterEach(async () => {
    await mockDatabase('email_messages').del();
    await mockDatabase('collections_contact_ledger').del();
    await mockDatabase('leads').del();
    await mockDatabase('estimates').del();
  });
  afterAll(async () => {
    await mockDatabase?.destroy();
    if (admin) { await admin.schema.dropSchemaIfExists(schema, true); await admin.destroy(); }
  });

  // A provider-block retry waiting on its schedule.
  function scheduled(customerId, overrides = {}) {
    const attemptToken = randomUUID();
    return {
      id: randomUUID(),
      template_key: 'quote.request_received',
      recipient_type: 'customer',
      recipient_id: customerId,
      recipient_email_snapshot: OLD,
      subject_snapshot: 'We received your request',
      html_snapshot: '<p>Hello</p>',
      text_snapshot: 'Hello',
      suppression_group_key_snapshot: 'service_operational',
      categories: JSON.stringify(['email_template']),
      status: 'failed',
      send_attempt_token: attemptToken,
      provider_handoff_attempt_token: attemptToken,
      provider_handoff_phase: 'rejected',
      provider_retry_count: 0,
      provider_retry_next_at: new Date(Date.now() - 1000),
      ...overrides,
    };
  }
  const correct = (customerId, oldEmail = OLD) => mockDatabase.transaction(
    (trx) => retry.stopRetriesForReplacedEmail(trx, { customerId, oldEmail }),
  );
  const rowOf = (id) => mockDatabase('email_messages').where({ id }).first();

  test('a corrected email stops the pending retry: nothing more goes to the old address, a different address is untouched', async () => {
    const customerId = randomUUID();
    const toOld = scheduled(customerId);
    const toOther = scheduled(customerId, { recipient_email_snapshot: OTHER });
    await mockDatabase('email_messages').insert([toOld, toOther]);

    await expect(correct(customerId)).resolves.toBe(1);

    const stopped = await rowOf(toOld.id);
    expect(stopped).toMatchObject({ status: 'blocked', provider_retry_next_at: null, error_message: REASON });
    expect(stopped.provider_retry_exhausted_at).toBeInstanceOf(Date);
    expect(await rowOf(toOther.id)).toMatchObject({ status: 'failed', error_message: null });

    // The retry sweep that would have re-sent the old copy now only finds the other row.
    const sweep = await retry.runDueRetries();
    expect(sweep).toMatchObject({ claimed: 1, sent: 1 });
    expect(sendgrid.sendOne).toHaveBeenCalledTimes(1);
    expect(sendgrid.sendOne).toHaveBeenCalledWith(expect.objectContaining({ to: OTHER }));
    expect(sendgrid.sendOne).not.toHaveBeenCalledWith(expect.objectContaining({ to: OLD }));
  });

  test('the address matches case-insensitively and ownership covers the customer\'s own leads and estimates only', async () => {
    const customerId = randomUUID();
    const leadId = randomUUID();
    const estimateId = randomUUID();
    const strangerLead = randomUUID();
    await mockDatabase('leads').insert([{ id: leadId, customer_id: customerId }, { id: strangerLead, customer_id: randomUUID() }]);
    await mockDatabase('estimates').insert({ id: estimateId, customer_id: customerId });
    const mixedCase = scheduled(customerId, { recipient_email_snapshot: 'Old.Typo@Example.com' });
    const viaLead = scheduled(null, { recipient_type: 'lead', recipient_id: null, lead_id: leadId });
    const viaEstimate = scheduled(null, { recipient_type: 'lead', recipient_id: null, estimate_id: estimateId });
    const strangers = [
      scheduled(randomUUID()),
      scheduled(null, { recipient_type: 'lead', recipient_id: null, lead_id: strangerLead }),
    ];
    await mockDatabase('email_messages').insert([mixedCase, viaLead, viaEstimate, ...strangers]);

    await expect(correct(customerId)).resolves.toBe(3);

    for (const row of [mixedCase, viaLead, viaEstimate]) expect((await rowOf(row.id)).status).toBe('blocked');
    for (const row of strangers) expect(await rowOf(row.id)).toMatchObject({ status: 'failed', error_message: null });
  });

  test('a visit summary keeps its own fence; a request already at the provider is left to its worker; an unsent claim is stopped', async () => {
    const customerId = randomUUID();
    const token = () => randomUUID();
    const summary = scheduled(customerId, { template_key: 'service.visit_summary', trigger_event_id: `visit_summary:${randomUUID()}` });
    const claimedUnsentToken = token();
    const claimedUnsent = scheduled(customerId, {
      status: 'queued', provider_retry_next_at: null, provider_retry_count: 1, queued_at: new Date(),
      send_attempt_token: claimedUnsentToken, provider_handoff_attempt_token: claimedUnsentToken, provider_handoff_phase: 'pending',
    });
    const startedToken = token();
    const started = scheduled(customerId, {
      status: 'queued', provider_retry_next_at: null, provider_retry_count: 1, queued_at: new Date(),
      send_attempt_token: startedToken, provider_handoff_attempt_token: startedToken, provider_handoff_phase: 'started',
    });
    const accepted = scheduled(customerId, { status: 'sent', provider_retry_next_at: null, sent_at: new Date(), provider_message_id: 'provider-0' });
    await mockDatabase('email_messages').insert([summary, claimedUnsent, started, accepted]);

    await expect(correct(customerId)).resolves.toBe(1);

    expect(await rowOf(claimedUnsent.id)).toMatchObject({ status: 'blocked', provider_retry_next_at: null, error_message: REASON });
    expect(await rowOf(summary.id)).toMatchObject({ status: 'failed', error_message: null });
    expect(await rowOf(started.id)).toMatchObject({ status: 'queued', provider_handoff_phase: 'started', error_message: null });
    expect(await rowOf(accepted.id)).toMatchObject({ status: 'sent', error_message: null });
  });

  test('a claim stopped before its request loses the marker and makes no provider request', async () => {
    const customerId = randomUUID();
    const claimToken = randomUUID();
    const claimed = scheduled(customerId, {
      status: 'queued', provider_retry_next_at: null, provider_retry_count: 1, queued_at: new Date(),
      send_attempt_token: claimToken, provider_handoff_attempt_token: claimToken, provider_handoff_phase: 'pending',
    });
    await mockDatabase('email_messages').insert(claimed);
    await correct(customerId);

    const outcome = await retry.retryOne(await rowOf(claimed.id).then((row) => ({ ...row, status: 'queued' })));

    expect(outcome).toMatchObject({ sent: false, stopped: true });
    expect(sendgrid.sendOne).not.toHaveBeenCalled();
    expect(await rowOf(claimed.id)).toMatchObject({ status: 'blocked', error_message: REASON });
  });

  test('a billing replay stopped this way resolves its reservation like a refused retry', async () => {
    const customerId = randomUUID();
    const ledgerId = randomUUID();
    const invoiceId = randomUUID();
    const eventKey = `late-payment:${invoiceId}:14`;
    await mockDatabase('collections_contact_ledger').insert({
      id: ledgerId, customer_id: customerId, channel: 'email', purpose: 'late_payment',
      invoice_ids: JSON.stringify([invoiceId]), source: 'late_payment_checker', occurred_at: new Date(),
      metadata: JSON.stringify({ notificationEventKey: eventKey }),
    });
    const billing = scheduled(customerId, {
      template_key: 'billing.notice',
      suppression_group_key_snapshot: 'transactional_required',
      trigger_event_id: eventKey,
      idempotency_key: `billing_channel_email:${eventKey}:email`,
      categories: JSON.stringify(['billing']),
      payload_snapshot: { __billing_replay_context: {
        schema_version: 1, customer_id: customerId, invoice_id: invoiceId, category: 'billing',
        source_entry_point: 'late_payment_checker', notificationEventKey: eventKey, collections_ledger_id: ledgerId,
      } },
    });
    await mockDatabase('email_messages').insert(billing);

    await expect(correct(customerId)).resolves.toBe(1);

    expect(await rowOf(billing.id)).toMatchObject({
      status: 'blocked', provider_retry_next_at: null,
      error_message: `${BILLING_EMAIL_TERMINAL_REFUSAL_PREFIX}${REASON}`,
    });
    const reservation = await mockDatabase('collections_contact_ledger').where({ id: ledgerId }).first();
    expect(reservation.metadata).toMatchObject({ send_failed: true, resolved: true, resolution: 'email_terminal_refusal' });
  });
});
