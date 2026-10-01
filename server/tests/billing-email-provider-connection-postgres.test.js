// Real provider preparation under billing authority with a one-slot pool.
// Only the HTTP transport and template/suppression lookup are mocked.
let mockPg;
let mockMarkerPg;
jest.mock('../models/marker-db', () => () => mockMarkerPg);
jest.mock('../models/db', () => {
  const database = (...args) => mockPg(...args);
  database.transaction = (...args) => mockPg.transaction(...args);
  database.raw = (...args) => mockPg.raw(...args);
  return database;
});
jest.mock('../services/email-template-library', () => ({
  ...jest.requireActual('../services/email-template-library'),
  loadTemplateByKey: async () => ({ template: { template_key: 'billing.notice' } }),
  activeSuppressionFor: async () => null,
}));
jest.mock('../services/customer-contact', () => ({
  getInvoiceEmailRecipients: (customer) => [{ email: customer.email, name: 'QA' }],
}));
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

const { randomUUID } = require('node:crypto');
const knex = require('knex');
const sendgrid = require('../services/sendgrid-mail');
const { dispatchUnderBillingEmailAuthority } = require('../services/billing-channel-email-authority');
const { etDateString, addETDays } = require('../utils/datetime-et');
const { claimDueRetries, recoverStaleClaims, retryOne } = require('../services/transactional-email-provider-retry');
const { recordSuppression } = require('../services/messaging/validators/suppression');
const { runBillingEmailProviderReplayHandoff } = require('../services/billing-email-provider-replay');
const { correctedAddressOwnedByOther, dispatchRecoveryMessage } = require('../services/email-bounce-recovery');
const ownershipMigration = require('../models/migrations/20260927000150_billing_email_ownership_assignment_locks');
const { lockEmailOwnershipForSend } = require('../utils/customer-comms-lock');
const connection = process.env.APP_TEST_DATABASE_URL;
const postgres = connection ? describe : describe.skip;
const schema = `billing_provider_connection_${randomUUID().replaceAll('-', '')}`;
const customerId = randomUUID();
const originalApiKey = process.env.SENDGRID_API_KEY;
const originalFetch = global.fetch;
let admin;
let writer;

async function waitForPhoneLock(pid) {
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) {
    const result = await admin.raw("SELECT EXISTS (SELECT 1 FROM pg_locks WHERE pid = ? AND locktype = 'advisory' AND NOT granted) AS waiting", [pid]);
    if (result.rows[0].waiting) return;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error('Expected a concurrent phone-lock waiter');
}

function billingReplayRow(chargeDate, overrides = {}) {
  const event = `precharge:${customerId}:${chargeDate}`;
  const attempt = randomUUID();
  return {
    id: randomUUID(), template_key: 'billing.notice', recipient_type: 'customer', recipient_id: customerId,
    recipient_email_snapshot: 'qa@example.invalid', trigger_event_id: event,
    idempotency_key: `billing_channel_email:${event}:email`, subject_snapshot: 'Synthetic precharge',
    html_snapshot: '<p>Synthetic precharge</p>', text_snapshot: 'Synthetic precharge',
    suppression_group_key_snapshot: 'transactional_required',
    payload_snapshot: { __billing_replay_context: { schema_version: 1, customer_id: customerId,
      category: 'billing', source_entry_point: 'autopay_pre_charge_reminder', notificationEventKey: event, charge_date: chargeDate } },
    categories: JSON.stringify(['email_template', 'billing']), send_attempt_token: attempt,
    provider_handoff_attempt_token: attempt, provider_handoff_phase: 'pending', status: 'queued', provider_retry_count: 1,
    ...overrides,
  };
}

postgres('billing Email provider preparation on its held connection', () => {
  beforeAll(async () => {
    const target = new URL(connection);
    const privateQa = /^\/waves_qa_[a-f0-9]{32}$/.test(target.pathname);
    const ci = process.env.CI === 'true' && ['localhost', '127.0.0.1'].includes(target.hostname)
      && target.pathname === '/waves_test';
    if (!privateQa && !ci) throw new Error('Use a verified private QA database or the isolated CI database');
    admin = knex({ client: 'pg', connection, pool: { min: 0, max: 1 } });
    await admin.schema.createSchema(schema);
    mockPg = knex({ client: 'pg', connection, searchPath: [schema],
      pool: { min: 0, max: 1 }, acquireConnectionTimeout: 1500 });
    mockMarkerPg = knex({ client: 'pg', connection, searchPath: [schema], pool: { min: 0, max: 1 } });
    writer = knex({ client: 'pg', connection, searchPath: [schema], pool: { min: 0, max: 1 } });
    await mockPg.schema.createTable('customers', (table) => {
      table.uuid('id').primary(); table.text('email'); table.text('phone'); table.timestamp('deleted_at');
      table.boolean('active'); table.boolean('autopay_enabled'); table.decimal('monthly_rate');
      table.integer('billing_day'); table.text('billing_mode');
      for (const column of ['service_contact_email', 'service_contact2_email', 'service_contact3_email']) table.text(column);
    });
    await mockPg.schema.createTable('notification_prefs', (table) => {
      table.uuid('customer_id').primary().references('id').inTable('customers'); table.boolean('email_enabled');
      table.specificType('billing_channels', 'text[]');
      table.text('billing_email');
      table.boolean('payment_receipt');
    });
    await mockPg.schema.createTable('messaging_suppression', (table) => {
      table.text('phone').primary(); table.text('reason'); table.boolean('active'); table.timestamp('created_at');
      table.text('source'); table.text('captured_body'); table.timestamp('cleared_at');
    });
    await mockPg.schema.createTable('estimates', (table) => {
      table.uuid('id').primary(); table.text('token'); table.jsonb('estimate_data');
      table.uuid('customer_id').references('id').inTable('customers');
      for (const column of ['status', 'expires_at', 'property_id', 'estimate_group_id',
        'customer_name', 'customer_phone', 'customer_email', 'address', 'notes', 'monthly_total',
        'annual_total', 'onetime_total', 'show_one_time_option', 'bill_by_invoice', 'waveguard_tier',
        'service_interest', 'category', 'source']) table.text(column);
    });
    await mockPg.schema.createTable('leads', (table) => {
      table.uuid('id').primary(); table.uuid('customer_id'); table.text('email');
    });
    // The bounce-recovery phase marker (dispatch_started_at) is written on the marker connection at the provider boundary.
    await mockPg.schema.createTable('email_bounce_recoveries', (table) => {
      table.uuid('recovery_message_id'); table.jsonb('metadata'); table.timestamp('updated_at');
    });
    await mockPg.schema.createTable('email_messages', (table) => {
      table.uuid('id').primary();
      for (const key of ['template_key', 'recipient_type', 'recipient_id', 'recipient_email_snapshot',
        'trigger_event_id', 'idempotency_key', 'subject_snapshot', 'html_snapshot', 'text_snapshot',
        'suppression_group_key_snapshot', 'send_attempt_token', 'provider_handoff_attempt_token',
        'provider_handoff_phase', 'status', 'provider_message_id', 'error_message']) table.text(key);
      table.jsonb('payload_snapshot'); table.jsonb('categories'); table.integer('provider_retry_count');
      table.boolean('has_attachments').notNullable().defaultTo(false);
      for (const key of ['sent_at', 'queued_at', 'updated_at', 'provider_retry_next_at', 'provider_retry_exhausted_at']) table.timestamp(key);
    });
    // The billing email authority reads the collections hold at the provider boundary (any active
    // collection_hold waits): the real table's shape.
    await mockPg.raw('CREATE TABLE collections_flags (LIKE public.collections_flags INCLUDING ALL)');
    await ownershipMigration.up(mockPg);
    await mockPg.raw('CREATE TABLE retry_commit_guard (message_id uuid REFERENCES email_messages(id) DEFERRABLE INITIALLY DEFERRED)');
    await mockPg('customers').insert({ id: customerId, email: 'qa@example.invalid' });
    await mockPg('notification_prefs').insert({ customer_id: customerId,
      email_enabled: true, billing_channels: ['email'] });

    // Minimal invoices shape for the invoiceId dispatch below: just enough
    // columns for withInvoiceDepositSettlement's own lock+read (payer_id,
    // total, notes for its deposit-provenance scan), selfPayAtDispatch's
    // ownership recheck (payer_id, scheduled_send_error), and
    // billingEmailPreSendCheck's own re-read (send_claim_token).
    await mockPg.schema.createTable('invoices', (table) => {
      table.uuid('id').primary(); table.uuid('customer_id'); table.uuid('payer_id');
      table.text('status'); table.text('send_claim_token'); table.text('scheduled_send_error');
      table.text('total'); table.decimal('credit_applied'); table.jsonb('line_items'); table.text('notes');
    });
  }, 30000);

  beforeEach(() => {
    process.env.SENDGRID_API_KEY = 'SG.synthetic-no-network';
    global.fetch = jest.fn(async () => ({ ok: true, headers: { get: () => 'synthetic-provider-id' } }));
  });
  afterEach(() => {
    global.fetch = originalFetch;
    if (originalApiKey === undefined) delete process.env.SENDGRID_API_KEY;
    else process.env.SENDGRID_API_KEY = originalApiKey;
  });
  afterAll(async () => {
    if (mockPg) await ownershipMigration.down(mockPg);
    await mockMarkerPg?.destroy();
    await mockPg?.destroy();
    await writer?.destroy();
    if (admin) { await admin.schema.dropSchemaIfExists(schema, true); await admin.destroy(); }
  });

  test.each(['refuse', 'rewrite'])('%s checks allow no-phone customers and never acquire a second slot', async (policy) => {
    const estimateId = randomUUID();
    const token = randomUUID().replaceAll('-', '');
    const queries = [];
    const collect = (query) => { if (/"estimates"/.test(query.sql)) queries.push(query); };
    mockPg.on('query', collect);
    const state = { boundaryBlock: null, handoffStarted: false, providerAccepted: false };
    try {
      const outcome = await dispatchUnderBillingEmailAuthority({
        input: { customerId, metadata: { billingDeliveryCategory: 'billing' } },
        recipientEmail: 'qa@example.invalid', state,
        dispatch: async (database, providerBoundaryCheck) => {
          expect(database.isTransaction).toBe(true);
          await database('estimates').insert({ id: estimateId, token, status: 'accepted', estimate_data: {} });
          await sendgrid.sendOne({
            to: 'qa@example.invalid', subject: 'Synthetic billing update',
            html: `<a href="https://example.invalid/estimate/${token}">Review</a>`,
            text: `https://example.invalid/estimate/${token}`, withheldLinkPolicy: policy,
            database, providerBoundaryCheck,
          });
        },
      });
      expect(outcome).toEqual({ ok: true });
      expect(state.providerAccepted).toBe(true);
      expect(global.fetch).toHaveBeenCalledTimes(1);
      expect(queries.filter((query) => /^select/i.test(query.sql)).length).toBeGreaterThanOrEqual(2);
      expect(new Set(queries.map((query) => query.__knexTxId)).size).toBe(1);
      expect(queries[0].__knexTxId).toBeTruthy();
    } finally { mockPg.removeListener('query', collect); }
  }, 15000);

  // Invoice delivery's explicit billing Email leg (send-customer-message.js
  // billingEmailLeg) composes billingEmailPreSendCheck into preSendCheck
  // here — invoice.js's own hook re-reads `invoices` by id through the SAME
  // database it is given, never opening a fresh root-pool connection. This
  // pool has exactly ONE slot: a hook that reached through the plain `db`
  // module instead of its given `database` would starve on the still-open
  // outer transaction and this test would time out.
  test('an invoiceId dispatch composes the invoice pre-send check under the SAME held connection, never a second slot', async () => {
    const invoiceId = randomUUID();
    await mockPg('invoices').insert({
      id: invoiceId, customer_id: customerId, status: 'sending', send_claim_token: 'qa-claim',
      total: '50.00', credit_applied: 0, line_items: JSON.stringify([]),
    });
    const queries = [];
    const collect = (query) => { if (/"invoices"/.test(query.sql)) queries.push(query); };
    mockPg.on('query', collect);
    const state = { boundaryBlock: null, handoffStarted: false, providerAccepted: false };
    // Stand-in for invoice.js's billingEmailPreSendCheck: re-reads the
    // invoice by id through the given locked handle and checks the SAME
    // send-claim precondition checkInvoiceDeliveryPreconditions runs first.
    const billingEmailPreSendCheck = jest.fn(async ({ database }) => {
      const current = await database('invoices').where({ id: invoiceId }).first();
      return current?.send_claim_token === 'qa-claim'
        ? { ok: true }
        : { ok: false, code: 'send_claim_lost', reason: 'Invoice send claim changed; delivery not attempted' };
    });
    try {
      const outcome = await dispatchUnderBillingEmailAuthority({
        input: { customerId, invoiceId, metadata: { billingDeliveryCategory: 'billing' } },
        recipientEmail: 'qa@example.invalid', state,
        // Exactly how providerPreparationCheck (send-customer-message.js)
        // calls it: channel + the locked database it was itself given.
        preSendCheck: async ({ database }) => billingEmailPreSendCheck({ channel: 'email', database }),
        dispatch: async (database) => {
          expect(database.isTransaction).toBe(true);
          await sendgrid.sendOne({
            to: 'qa@example.invalid', subject: 'Synthetic invoice notice',
            html: '<p>Your invoice is ready.</p>', text: 'Your invoice is ready.', database,
          });
        },
      });
      expect(outcome).toEqual({ ok: true });
      expect(state.providerAccepted).toBe(true);
      expect(billingEmailPreSendCheck).toHaveBeenCalledTimes(1);
      expect(new Set(queries.map((query) => query.__knexTxId)).size).toBe(1);
      expect(queries[0].__knexTxId).toBeTruthy();
    } finally { mockPg.removeListener('query', collect); }
  }, 15000);

  // Owner ruling 2026-09-26: the portal-wide email switch never blocks a
  // billing email, so the replay sends the same way whether it is on or off.
  test.each([true, false])('full billing replay on one root slot sends regardless of the portal-wide email switch (%s)', async (emailEnabled) => {
    const chargeDate = etDateString(addETDays(new Date(), 1));
    await mockPg('customers').where({ id: customerId }).update({ active: true, autopay_enabled: true,
      monthly_rate: 100, billing_day: Number(chargeDate.slice(-2)), billing_mode: 'monthly_membership' });
    await mockPg('notification_prefs').where({ customer_id: customerId })
      .update({ email_enabled: true, billing_channels: ['email'] });
    await mockPg('notification_prefs').where({ customer_id: customerId }).update({ email_enabled: emailEnabled });
    const estimateToken = randomUUID().replaceAll('-', '');
    await mockPg('estimates').insert({ id: randomUUID(), token: estimateToken, status: 'accepted', estimate_data: {} });
    const stored = billingReplayRow(chargeDate, {
      html_snapshot: `<a href="https://example.invalid/estimate/${estimateToken}">Review</a>`,
    });
    const attempt = stored.send_attempt_token;
    await mockPg('email_messages').insert(stored);
    global.fetch.mockImplementation(async (_url, options) => {
      if (options.method === 'POST') {
        expect(await mockMarkerPg('email_messages').where({ id: stored.id }).first()).toMatchObject({
          provider_handoff_phase: 'started', provider_handoff_attempt_token: attempt,
        });
      }
      return { ok: true, headers: { get: () => 'synthetic-provider-id' } };
    });
    const outcome = await retryOne(stored);
    const saved = await mockPg('email_messages').where({ id: stored.id }).first();
    expect(outcome).toMatchObject({ sent: true });
    expect(saved).toMatchObject({ status: 'sent', sent_at: expect.any(Date) });
    expect(global.fetch).toHaveBeenCalledTimes(2);
  }, 15000);

  test.each([false, true])('the actual billing bounce callback fences raw assignments and phantom inserts (busy=%s)', async (busy) => {
    const chargeDate = etDateString(addETDays(new Date(), 1));
    const corrected = 'qa.billing-boundary@gmail.com';
    const alias = 'qabilling-boundary+owner@googlemail.com';
    const original = 'qa.billing-boundary@gmial.com';
    const otherId = randomUUID();
    const insertionOwner = randomUUID();
    const estimateId = randomUUID();
    const leadId = randomUUID();
    const message = { id: randomUUID(), status: 'queued', subject_snapshot: 'Synthetic recovery', send_attempt_token: randomUUID() };
    await mockPg('customers').where({ id: customerId }).update({ email: original, phone: null, active: true,
      autopay_enabled: true, monthly_rate: 100, billing_day: Number(chargeDate.slice(-2)), billing_mode: 'monthly_membership' });
    await mockPg('notification_prefs').where({ customer_id: customerId }).update({ email_enabled: true, billing_channels: ['email'] });
    await mockPg('customers').insert([{ id: otherId, email: 'qa-other@example.invalid' }, { id: insertionOwner }]);
    await mockPg('notification_prefs').insert({ customer_id: otherId, billing_email: 'qa-other@example.invalid' });
    await mockPg('estimates').insert({ id: estimateId, customer_id: otherId, customer_email: 'qa-other@example.invalid' });
    await mockPg('leads').insert({ id: leadId, customer_id: otherId, email: 'qa-other@example.invalid' });
    await mockPg('email_messages').insert({ id: message.id, status: 'queued' });
    const assignment = busy ? await writer.transaction() : null;
    if (assignment) await assignment('leads').where({ id: leadId }).update({ email: alias });
    const sources = [['customers', 'email', 'id', otherId], ['notification_prefs', 'billing_email', 'customer_id', otherId],
      ['estimates', 'customer_email', 'id', estimateId], ['leads', 'email', 'id', leadId]];
    global.fetch.mockImplementation(async (_url, options) => {
      expect(JSON.parse(options.body).personalizations[0].to[0].email).toBe(corrected);
      for (const [table, column, key, id] of sources) {
        for (const address of [corrected, alias]) {
          await expect(writer.transaction(async trx => {
            await trx.raw("SET LOCAL lock_timeout = '100ms'");
            await trx.raw('UPDATE ?? SET ?? = ? WHERE ?? = ?', [table, column, address, key, id]);
          })).rejects.toMatchObject({ code: '55P03' });
          await expect(writer.transaction(async trx => {
            await trx.raw("SET LOCAL lock_timeout = '100ms'");
            await trx(table).insert({ [key]: key === 'customer_id' ? insertionOwner : randomUUID(),
              ...(table !== 'customers' && key !== 'customer_id' ? { customer_id: insertionOwner } : {}), [column]: address });
          })).rejects.toMatchObject({ code: '55P03' });
        }
      }
      return { ok: true, headers: { get: () => 'synthetic-billing-bounce-id' } };
    });
    try {
      await expect(dispatchRecoveryMessage({ message, categories: [], correctedEmail: corrected, ownCustomerId: customerId,
        bouncedMessage: billingReplayRow(chargeDate, { recipient_email_snapshot: original }) }))
        .resolves.toEqual(busy ? { ok: false, error: 'Email ownership assignment in progress' } : { ok: true, messageRowId: message.id });
      expect(global.fetch).toHaveBeenCalledTimes(busy ? 0 : 1);
    } finally {
      if (assignment && !assignment.isCompleted()) await assignment.rollback();
      await mockPg('notification_prefs').where({ customer_id: otherId }).del();
      await mockPg('estimates').where({ id: estimateId }).del();
      await mockPg('leads').where({ id: leadId }).del();
      await mockPg('customers').whereIn('id', [otherId, insertionOwner]).del();
      await mockPg('customers').where({ id: customerId }).update({ email: 'qa@example.invalid' });
    }
  }, 20000);

  test.each(['available', 'other-owner', 'gmail-alias', 'original-changed'])(
    'corrected billing bounce destination remains authorized at actual HTTP: %s', async (condition) => {
      const chargeDate = etDateString(addETDays(new Date(), 1));
      const corrected = 'qa.billing@gmail.com';
      const alias = 'qabilling+owner@googlemail.com';
      const original = 'qa.billing@gmial.com';
      const otherId = randomUUID();
      await mockPg('customers').where({ id: customerId }).update({
        email: condition === 'original-changed' ? 'qa-new@example.invalid' : original,
        phone: null, active: true, autopay_enabled: true, monthly_rate: 100,
        billing_day: Number(chargeDate.slice(-2)), billing_mode: 'monthly_membership',
      });
      await mockPg('notification_prefs').where({ customer_id: customerId }).update({
        email_enabled: true, billing_channels: ['email'],
      });
      await mockPg('customers').insert({ id: otherId, email: condition === 'other-owner' ? corrected
        : condition === 'gmail-alias' ? alias : 'qa-other@example.invalid' });
      const stored = billingReplayRow(chargeDate, { recipient_email_snapshot: ` ${original.toUpperCase()} ` });
      const ownershipCheck = jest.fn(async ({ database }) => {
        await lockEmailOwnershipForSend(database, corrected);
        return await correctedAddressOwnedByOther(corrected, customerId, database)
          ? { ok: false, code: 'CORRECTED_EMAIL_OWNED_BY_OTHER', reason: 'corrected_owned_by_other' } : { ok: true };
      });
      global.fetch.mockImplementation(async (_url, options) => {
        expect(JSON.parse(options.body).personalizations[0].to[0].email).toBe(corrected);
        // The original recipient cannot change and neither an exact nor a
        // Gmail-equivalent destination can be assigned while HTTP is in flight.
        await expect(writer.transaction(async (trx) => {
          await trx.raw("SET LOCAL lock_timeout = '100ms'");
          await trx('customers').where({ id: customerId }).update({ email: 'qa-new@example.invalid' });
        })).rejects.toMatchObject({ code: '55P03' });
        for (const address of [corrected, alias]) {
          await expect(writer.transaction(async (trx) => {
            await trx.raw("SET LOCAL lock_timeout = '100ms'");
            await trx.raw('UPDATE customers SET email = ? WHERE id = ?', [address, otherId]);
          })).rejects.toMatchObject({ code: '55P03' });
        }
        return { ok: true, headers: { get: () => 'synthetic-bounce-id' } };
      });
      try {
        const outcome = await runBillingEmailProviderReplayHandoff(stored, async (database, providerBoundaryCheck) => {
          await sendgrid.sendOne({ to: corrected, subject: stored.subject_snapshot,
            html: stored.html_snapshot, text: stored.text_snapshot, database, providerBoundaryCheck });
        }, { recipientEmail: corrected, authorityRecipientEmail: stored.recipient_email_snapshot,
          providerBoundaryCheck: ownershipCheck });
        if (condition === 'available') {
          expect(outcome).toEqual({ handled: true, allowed: true });
          expect(global.fetch).toHaveBeenCalledTimes(1);
          expect(ownershipCheck).toHaveBeenCalledTimes(1);
        } else {
          expect(outcome).toMatchObject({ handled: true, allowed: false, code: condition === 'original-changed'
            ? 'EMAIL_RECIPIENT_CHANGED' : 'CORRECTED_EMAIL_OWNED_BY_OTHER' });
          expect(global.fetch).not.toHaveBeenCalled();
        }
      } finally {
        await mockPg('customers').where({ id: otherId }).delete();
        await mockPg('customers').where({ id: customerId }).update({ email: 'qa@example.invalid' });
      }
    }, 15000,
  );

  // #4843 gate checklist: a billing row whose producer stored no replay
  // contract (the monthly payment receipt, say) re-authorizes the customer
  // notice written on the row through the Email authority before its retry,
  // instead of retrying on the generic path with only a suppression check.
  function unregisteredRow(templateKey, categories, overrides = {}) {
    const key = `monthly_billing_success:${randomUUID()}`;
    return billingReplayRow('2026-01-01', {
      template_key: templateKey,
      payload_snapshot: { first_name: 'QA', notification_body: 'Payment received' },
      categories: JSON.stringify(categories),
      trigger_event_id: key,
      idempotency_key: `billing_channel_email:${key}:email`,
      ...overrides,
    });
  }

  test.each([
    ['billing.notice', ['email_template', 'billing']],
    ['billing.receipt_notice', ['email_template', 'billing', 'payment_receipt']],
  ])('an unregistered %s retries through the Email authority', async (templateKey, categories) => {
    const stored = unregisteredRow(templateKey, categories);
    await mockPg('email_messages').insert(stored);
    await expect(retryOne(stored)).resolves.toMatchObject({ sent: true });
    await expect(mockPg('email_messages').where({ id: stored.id }).first()).resolves.toMatchObject({
      status: 'sent', sent_at: expect.any(Date), provider_retry_exhausted_at: null,
    });
    expect(global.fetch).toHaveBeenCalledTimes(2);
  }, 15000);

  test('an unregistered billing row waits while the customer has dropped Email', async () => {
    await mockPg('notification_prefs').where({ customer_id: customerId }).update({ billing_channels: ['sms'] });
    try {
      const stored = unregisteredRow('billing.notice', ['email_template', 'billing']);
      await mockPg('email_messages').insert(stored);
      await expect(retryOne(stored)).resolves.toMatchObject({ sent: false, error: { code: 'BILLING_PREFERENCES_CHANGED' } });
      await expect(mockPg('email_messages').where({ id: stored.id }).first()).resolves.toMatchObject({
        status: 'failed', provider_retry_next_at: expect.any(Date), provider_retry_exhausted_at: null,
      });
      expect(global.fetch).not.toHaveBeenCalled();
    } finally {
      await mockPg('notification_prefs').where({ customer_id: customerId }).update({ billing_channels: ['email'] });
    }
  }, 15000);

  // Payment receipts sent before billing.receipt_notice existed used
  // billing.notice; their retries keep working.
  test('a pre-migration receipt on billing.notice still retries through the Email authority', async () => {
    const stored = unregisteredRow('billing.notice', ['email_template', 'billing', 'payment_receipt']);
    await mockPg('email_messages').insert(stored);
    await expect(retryOne(stored)).resolves.toMatchObject({ sent: true });
    expect(global.fetch).toHaveBeenCalledTimes(2);
  }, 15000);

  // A receipt still honors notification_prefs.payment_receipt, like the
  // first send (receipt-delivery-queue.js).
  test('a customer who turned receipts off gets no retried receipt', async () => {
    await mockPg('notification_prefs').where({ customer_id: customerId }).update({ payment_receipt: false });
    try {
      const stored = unregisteredRow('billing.receipt_notice', ['email_template', 'billing', 'payment_receipt']);
      await mockPg('email_messages').insert(stored);
      await expect(retryOne(stored)).resolves.toMatchObject({ sent: false, stopped: true, reason: 'receipt_opted_out' });
      await expect(mockPg('email_messages').where({ id: stored.id }).first()).resolves.toMatchObject({
        status: 'blocked', provider_retry_next_at: null,
      });
      expect(global.fetch).not.toHaveBeenCalled();
    } finally {
      await mockPg('notification_prefs').where({ customer_id: customerId }).update({ payment_receipt: null });
    }
  }, 15000);

  test('an autopay pre-charge reminder honors the receipt switch on its retry', async () => {
    const chargeDate = etDateString(addETDays(new Date(), 1));
    await mockPg('notification_prefs').where({ customer_id: customerId }).update({ payment_receipt: false });
    try {
      const stored = billingReplayRow(chargeDate);
      await mockPg('email_messages').insert(stored);
      await expect(retryOne(stored)).resolves.toMatchObject({ sent: false, stopped: true, reason: 'receipt_opted_out' });
      expect(global.fetch).not.toHaveBeenCalled();
    } finally {
      await mockPg('notification_prefs').where({ customer_id: customerId }).update({ payment_receipt: null });
    }
  }, 15000);

  test('an unregistered row that does not carry its notice identity is refused, never resent', async () => {
    const stored = unregisteredRow('billing.notice', ['email_template', 'billing'], {
      idempotency_key: `billing_channel_email:another-notice-${randomUUID()}:email`,
    });
    await mockPg('email_messages').insert(stored);
    await expect(retryOne(stored)).resolves.toMatchObject({ sent: false, stopped: true });
    await expect(mockPg('email_messages').where({ id: stored.id }).first()).resolves.toMatchObject({
      status: 'blocked', provider_retry_next_at: null,
    });
    expect(global.fetch).not.toHaveBeenCalled();
  }, 15000);

  test('a stale recovery that wins after the started marker prevents the provider request', async () => {
    const chargeDate = etDateString(addETDays(new Date(), 1));
    await mockPg('customers').where({ id: customerId }).update({ active: true, autopay_enabled: true,
      monthly_rate: 100, billing_day: Number(chargeDate.slice(-2)), billing_mode: 'monthly_membership' });
    await mockPg('notification_prefs').where({ customer_id: customerId })
      .update({ email_enabled: true, billing_channels: ['email'] });
    const now = new Date();
    const stored = billingReplayRow(chargeDate, {
      queued_at: new Date(now.getTime() - 20 * 60 * 1000), updated_at: new Date(now.getTime() - 20 * 60 * 1000),
    });
    await mockPg('email_messages').insert(stored);
    const markerDatabase = mockMarkerPg;
    mockMarkerPg = (table) => {
      const query = markerDatabase(table);
      if (table !== 'email_messages') return query;
      const update = query.update.bind(query);
      query.update = async (patch) => {
        const count = await update(patch);
        const rootDatabase = mockPg;
        mockPg = writer;
        try { await recoverStaleClaims(now, writer); } finally { mockPg = rootDatabase; }
        return count;
      };
      return query;
    };
    try {
      await expect(retryOne(stored)).resolves.toEqual({ sent: false, stopped: true, reason: 'claim_lost' });
      expect(global.fetch.mock.calls.filter(([, options]) => options.method === 'POST')).toHaveLength(0);
      await expect(mockPg('email_messages').where({ id: stored.id }).first()).resolves.toMatchObject({
        status: 'failed', provider_handoff_phase: 'started', provider_retry_exhausted_at: expect.any(Date),
      });
    } finally {
      mockMarkerPg = markerDatabase;
    }
  }, 15000);

  test('the final retry claim lock survives provider acceptance and its token-scoped settlement', async () => {
    const chargeDate = etDateString(addETDays(new Date(), 1));
    await mockPg('customers').where({ id: customerId }).update({ active: true, autopay_enabled: true,
      monthly_rate: 100, billing_day: Number(chargeDate.slice(-2)), billing_mode: 'monthly_membership' });
    await mockPg('notification_prefs').where({ customer_id: customerId })
      .update({ email_enabled: true, billing_channels: ['email'] });
    const now = new Date();
    const stored = billingReplayRow(chargeDate, {
      queued_at: new Date(now.getTime() - 20 * 60 * 1000), updated_at: new Date(now.getTime() - 20 * 60 * 1000),
    });
    await mockPg('email_messages').insert(stored);
    const rootDatabase = mockPg;
    let recovery;
    let recoverySettled = false;
    global.fetch.mockImplementation(async (_url, options) => {
      if (options.method !== 'POST') return { ok: true, headers: { get: () => null } };
      mockPg = writer;
      recovery = recoverStaleClaims(now, writer).finally(() => { recoverySettled = true; });
      await new Promise(resolve => setTimeout(resolve, 50));
      expect(recoverySettled).toBe(false);
      return { ok: true, headers: { get: () => 'synthetic-provider-id' } };
    });
    try {
      await expect(retryOne(stored)).resolves.toMatchObject({ sent: true });
      await expect(recovery).resolves.toBe(0);
      await expect(writer('email_messages').where({ id: stored.id }).first()).resolves.toMatchObject({
        status: 'sent', send_attempt_token: stored.send_attempt_token,
        provider_message_id: 'synthetic-provider-id', sent_at: expect.any(Date),
      });
    } finally {
      mockPg = rootDatabase;
    }
  }, 15000);

  test.each([false, true])('acceptance is reconciled only when durable after a commit failure (committed: %s)', async (committed) => {
    const chargeDate = etDateString(addETDays(new Date(), 1));
    await mockPg('customers').where({ id: customerId }).update({ active: true, autopay_enabled: true,
      monthly_rate: 100, billing_day: Number(chargeDate.slice(-2)), billing_mode: 'monthly_membership' });
    await mockPg('notification_prefs').where({ customer_id: customerId })
      .update({ email_enabled: true, billing_channels: ['email'] });
    const stored = billingReplayRow(chargeDate);
    await mockPg('email_messages').insert(stored);
    const originalTransaction = Object.getOwnPropertyDescriptor(mockPg, 'transaction');
    let injectFailure = true;
    Object.defineProperty(mockPg, 'transaction', { configurable: true, value: async (callback) => {
      const inject = injectFailure;
      injectFailure = false;
      const result = await originalTransaction.value.call(mockPg, async (trx) => {
        const outcome = await callback(trx);
        // The deferred FK rejects COMMIT after the acceptance UPDATE ran.
        if (inject && !committed) await trx('retry_commit_guard').insert({ message_id: randomUUID() });
        return outcome;
      });
      if (inject) throw new Error('Synthetic lost commit acknowledgement');
      return result;
    } });
    const reservation = require('../services/billing-email-reservation');
    const delivered = jest.spyOn(reservation, 'markBillingEmailReservationDelivered').mockResolvedValue(true);
    try {
      const outcome = await retryOne(stored);
      const saved = await mockPg('email_messages').where({ id: stored.id }).first();
      expect(global.fetch.mock.calls.filter(([, options]) => options.method === 'POST')).toHaveLength(1);
      expect(saved.provider_retry_next_at).toBeNull();
      if (committed) {
        expect(outcome).toMatchObject({ sent: true });
        expect(saved).toMatchObject({ status: 'sent', sent_at: expect.any(Date) });
        expect(delivered).toHaveBeenCalledWith(expect.objectContaining({ id: stored.id, sent_at: expect.any(Date) }));
      } else {
        expect(outcome).toMatchObject({ sent: false, uncertain: true });
        expect(saved).toMatchObject({ status: 'failed', sent_at: null, provider_retry_exhausted_at: expect.any(Date) });
        expect(delivered).not.toHaveBeenCalled();
      }
    } finally {
      Object.defineProperty(mockPg, 'transaction', originalTransaction);
      delivered.mockRestore();
    }
  }, 15000);

  test('a Text-only billing choice defers the same row until Email is selected again', async () => {
    const chargeDate = etDateString(addETDays(new Date(), 1));
    await mockPg('customers').where({ id: customerId }).update({ active: true, autopay_enabled: true,
      monthly_rate: 100, billing_day: Number(chargeDate.slice(-2)), billing_mode: 'monthly_membership' });
    await mockPg('notification_prefs').where({ customer_id: customerId }).update({
      email_enabled: true, billing_channels: ['sms'],
    });
    const stored = billingReplayRow(chargeDate);
    const attempt = stored.send_attempt_token;
    await mockPg('email_messages').insert(stored);

    const deferred = await retryOne(stored);
    const scheduled = await mockPg('email_messages').where({ id: stored.id }).first();
    expect(deferred).toMatchObject({ sent: false, error: { code: 'BILLING_PREFERENCES_CHANGED' } });
    expect(scheduled).toMatchObject({ status: 'failed', provider_retry_next_at: expect.any(Date),
      provider_retry_exhausted_at: null, provider_handoff_phase: 'pending' });
    expect(global.fetch).not.toHaveBeenCalled();

    await mockPg('notification_prefs').where({ customer_id: customerId }).update({ billing_channels: ['email'] });
    await mockPg('email_messages').where({ id: stored.id }).update({ provider_retry_next_at: new Date(0) });
    const [claimed] = await claimDueRetries(1, new Date());
    expect(claimed).toMatchObject({ id: stored.id, status: 'queued', provider_retry_count: 2,
      provider_handoff_phase: 'pending' });
    expect(claimed.send_attempt_token).not.toBe(attempt);
    expect(claimed.provider_handoff_attempt_token).toBe(claimed.send_attempt_token);

    await expect(retryOne(claimed)).resolves.toMatchObject({ sent: true });
    await expect(mockPg('email_messages').where({ id: stored.id }).first()).resolves.toMatchObject({
      status: 'sent', sent_at: expect.any(Date), provider_message_id: 'synthetic-provider-id',
    });
    expect(global.fetch).toHaveBeenCalledTimes(2);
  }, 15000);

  test('an all-channel DNC added after the first attempt blocks replay before provider work', async () => {
    const phone = '+19415550100';
    const chargeDate = etDateString(addETDays(new Date(), 1));
    await mockPg('customers').where({ id: customerId }).update({ active: true, autopay_enabled: true,
      monthly_rate: 100, billing_day: Number(chargeDate.slice(-2)), billing_mode: 'monthly_membership', phone });
    await mockPg('notification_prefs').where({ customer_id: customerId }).update({
      email_enabled: true, billing_channels: ['email'],
    });
    await mockPg('messaging_suppression').insert({ phone, reason: 'manual_dnc', active: true, created_at: new Date() });
    const stored = billingReplayRow(chargeDate);
    await mockPg('email_messages').insert(stored);
    try {
      await expect(retryOne(stored)).resolves.toMatchObject({ sent: false, stopped: true });
      await expect(mockPg('email_messages').where({ id: stored.id }).first()).resolves.toMatchObject({
        status: 'blocked', provider_retry_next_at: null, provider_retry_exhausted_at: expect.any(Date),
      });
      expect(global.fetch).not.toHaveBeenCalled();
    } finally {
      await mockPg('messaging_suppression').where({ phone }).delete();
      await mockPg('customers').where({ id: customerId }).update({ phone: null });
    }
  }, 15000);

  test.each([
    ['manual_dnc', 'SUPPRESSED_MANUAL_DNC'],
    ['mystery_reason', 'SUPPRESSED_OTHER'],
  ])('%s blocks provider work under the held transaction', async (reason, code) => {
    const phone = '+19415550100';
    await mockPg('customers').where({ id: customerId }).update({ phone });
    await mockPg('messaging_suppression').insert({ phone, reason, active: true, created_at: new Date() });
    const dispatch = jest.fn(async (database) => sendgrid.sendOne({
      to: 'qa@example.invalid', subject: 'Suppressed billing update', html: '<p>Blocked</p>', text: 'Blocked', database,
    }));
    const state = { boundaryBlock: null, handoffStarted: false, providerAccepted: false };
    try {
      await expect(dispatchUnderBillingEmailAuthority({
        input: { customerId, metadata: { billingDeliveryCategory: 'billing' } },
        recipientEmail: 'qa@example.invalid', state, dispatch,
      })).resolves.toEqual({ ok: false });
      expect(state.boundaryBlock).toMatchObject({ code, blocked: true });
      expect(dispatch).not.toHaveBeenCalled();
      expect(global.fetch).not.toHaveBeenCalled();
    } finally {
      await mockPg('messaging_suppression').where({ phone }).delete();
      await mockPg('customers').where({ id: customerId }).update({ phone: null });
    }
  }, 15000);

  test('an unreadable all-channel suppression store returns a retryable hold', async () => {
    const phone = '+19415550100';
    await mockPg('customers').where({ id: customerId }).update({ phone });
    await mockPg.schema.renameTable('messaging_suppression', 'messaging_suppression_unavailable');
    const dispatch = jest.fn();
    const state = { boundaryBlock: null, handoffStarted: false, providerAccepted: false };
    try {
      await expect(dispatchUnderBillingEmailAuthority({
        input: { customerId, metadata: { billingDeliveryCategory: 'billing' } },
        recipientEmail: 'qa@example.invalid', state, dispatch,
      })).resolves.toEqual({ ok: false });
      expect(state.boundaryBlock).toMatchObject({ code: 'BILLING_EMAIL_RECHECK_FAILED', retryable: true,
        reason: 'Billing email authority could not be verified' });
      expect(dispatch).not.toHaveBeenCalled();
      expect(global.fetch).not.toHaveBeenCalled();
    } finally {
      await mockPg.schema.renameTable('messaging_suppression_unavailable', 'messaging_suppression');
      await mockPg('customers').where({ id: customerId }).update({ phone: null });
    }
  }, 15000);

  // A landline fact, a STOP text and a wrong-number flag are about the phone:
  // none of them stops a payment email (owner ruling 2026-09-27 for the
  // last two). A staff do-not-contact does (below).
  test.each(['non_mobile', 'opt_out', 'opt_out_keyword', 'opt_out_natural_language', 'wrong_number'])('a %s phone suppression still permits authorized Email dispatch', async (reason) => {
    const phone = '+19415550100';
    await mockPg('customers').where({ id: customerId }).update({ phone });
    await mockPg('messaging_suppression').insert({ phone, reason, active: true });
    const state = { boundaryBlock: null, handoffStarted: false, providerAccepted: false };
    try {
      expect(await dispatchUnderBillingEmailAuthority({
        input: { customerId, metadata: { billingDeliveryCategory: 'billing' } },
        recipientEmail: 'qa@example.invalid', state,
        dispatch: (database, providerBoundaryCheck) => sendgrid.sendOne({
          to: 'qa@example.invalid', subject: 'Synthetic update',
          html: '<p>Authorized Email</p>', text: 'Authorized Email', database, providerBoundaryCheck,
        }),
      })).toEqual({ ok: true });
      expect(state.providerAccepted).toBe(true);
      expect(global.fetch).toHaveBeenCalledTimes(1);
    } finally {
      await mockPg('messaging_suppression').where({ phone }).delete();
      await mockPg('customers').where({ id: customerId }).update({ phone: null });
    }
  }, 15000);

  // Owner ruling 2026-09-27: the shared check serves every billing email
  // sender, so a customer who never chose a billing channel keeps Email.
  test.each([
    ['no explicit billing choice', () => mockPg('notification_prefs').where({ customer_id: customerId }).update({ billing_channels: null })],
    ['no notification_prefs row', () => mockPg('notification_prefs').where({ customer_id: customerId }).delete()],
  ])('%s keeps authorized Email dispatch', async (_label, arrange) => {
    await arrange();
    const state = { boundaryBlock: null, handoffStarted: false, providerAccepted: false };
    try {
      expect(await dispatchUnderBillingEmailAuthority({
        input: { customerId, metadata: { billingDeliveryCategory: 'billing' } },
        recipientEmail: 'qa@example.invalid', state,
        dispatch: (database) => sendgrid.sendOne({ to: 'qa@example.invalid', subject: 'Synthetic update',
          html: '<p>Authorized Email</p>', text: 'Authorized Email', database }),
      })).toEqual({ ok: true });
      expect(state.providerAccepted).toBe(true);
      expect(global.fetch).toHaveBeenCalledTimes(1);
    } finally {
      await mockPg('notification_prefs').insert({ customer_id: customerId, email_enabled: true, billing_channels: ['email'] })
        .onConflict('customer_id').merge();
    }
  }, 15000);

  // A staff do-not-contact is the one phone suppression that stops a payment
  // email, so a later STOP, wrong-number reply or carrier opt-out recorded
  // over it keeps it; over any other reason the newer record still wins.
  test.each(['opt_out', 'opt_out_keyword', 'wrong_number'])('a %s recorded over a staff do-not-contact keeps the payment email blocked', async (reason) => {
    const phone = '+19415550100';
    await mockPg('customers').where({ id: customerId }).update({ phone });
    await mockPg('messaging_suppression').insert({ phone, reason: 'manual_dnc', source: 'staff', active: true, created_at: new Date() });
    const dispatch = jest.fn();
    const state = { boundaryBlock: null, handoffStarted: false, providerAccepted: false };
    try {
      expect(await recordSuppression({ phone, reason, source: 'inbound_stop' })).toEqual({ ok: true });
      expect(await mockPg('messaging_suppression').where({ phone }).first('reason', 'source', 'active'))
        .toEqual({ reason: 'manual_dnc', source: 'staff', active: true });
      await expect(dispatchUnderBillingEmailAuthority({
        input: { customerId, metadata: { billingDeliveryCategory: 'billing' } },
        recipientEmail: 'qa@example.invalid', state, dispatch,
      })).resolves.toEqual({ ok: false });
      expect(state.boundaryBlock).toMatchObject({ code: 'SUPPRESSED_MANUAL_DNC' });
      expect(dispatch).not.toHaveBeenCalled();
    } finally {
      await mockPg('messaging_suppression').where({ phone }).delete();
      await mockPg('customers').where({ id: customerId }).update({ phone: null });
    }
  }, 15000);

  test('a newer phone fact still replaces an older one', async () => {
    const phone = '+19415550100';
    await mockPg('messaging_suppression').insert({ phone, reason: 'opt_out_keyword', active: true, created_at: new Date() });
    try {
      expect(await recordSuppression({ phone, reason: 'wrong_number', source: 'inbound_wrong_number' })).toEqual({ ok: true });
      expect(await mockPg('messaging_suppression').where({ phone }).first('reason')).toEqual({ reason: 'wrong_number' });
    } finally {
      await mockPg('messaging_suppression').where({ phone }).delete();
    }
  }, 15000);

  test('a prior suppression writer commits before the handoff recheck and blocks dispatch', async () => {
    const phone = '+19415550100';
    await mockPg('customers').where({ id: customerId }).update({ phone });
    const { rows: [{ pid }] } = await mockPg.raw('SELECT pg_backend_pid() AS pid');
    const suppression = await writer.transaction();
    const state = { boundaryBlock: null, handoffStarted: false, providerAccepted: false };
    const dispatch = jest.fn();
    let sending;
    try {
      expect(await recordSuppression({ phone, reason: 'manual_dnc', dbh: suppression })).toEqual({ ok: true });
      sending = dispatchUnderBillingEmailAuthority({
        input: { customerId, metadata: { billingDeliveryCategory: 'billing' } },
        recipientEmail: 'qa@example.invalid', state, dispatch,
      });
      await waitForPhoneLock(pid);
      // A phone-first writer can still take recipient rows: the waiting
      // sender must not hold them before acquiring the shared phone lock.
      await suppression('customers').where({ id: customerId }).update({ phone });
      await suppression.commit();
      expect(await sending).toEqual({ ok: false });
      expect(state.boundaryBlock).toMatchObject({ code: 'SUPPRESSED_MANUAL_DNC' });
      expect(dispatch).not.toHaveBeenCalled();
      expect(global.fetch).not.toHaveBeenCalled();
    } finally {
      if (!suppression.isCompleted()) await suppression.rollback();
      await sending;
      await mockPg('messaging_suppression').where({ phone }).delete();
      await mockPg('customers').where({ id: customerId }).update({ phone: null });
    }
  }, 15000);

  test('a later suppression writer cannot commit between authorization and provider dispatch', async () => {
    const phone = '+19415550100';
    await mockPg('customers').where({ id: customerId }).update({ phone });
    const { rows: [{ pid }] } = await writer.raw('SELECT pg_backend_pid() AS pid');
    const state = { boundaryBlock: null, handoffStarted: false, providerAccepted: false };
    let suppression;
    let committed = false;
    try {
      const result = await dispatchUnderBillingEmailAuthority({
        input: { customerId, metadata: { billingDeliveryCategory: 'billing' } },
        recipientEmail: 'qa@example.invalid', state,
        preSendCheck: async () => {
          suppression = recordSuppression({ phone, reason: 'manual_dnc', dbh: writer })
            .then(outcome => { committed = true; return outcome; });
          await waitForPhoneLock(pid);
          return { ok: true };
        },
        dispatch: async (database, providerBoundaryCheck) => {
          expect(committed).toBe(false);
          await sendgrid.sendOne({ to: 'qa@example.invalid', subject: 'Synthetic billing update',
            html: '<p>Authorized</p>', text: 'Authorized', database, providerBoundaryCheck });
          expect(committed).toBe(false);
        },
      });
      expect(result).toEqual({ ok: true });
      expect(global.fetch).toHaveBeenCalledTimes(1);
      expect(await suppression).toEqual({ ok: true });
      expect(committed).toBe(true);
    } finally {
      await suppression;
      await mockPg('messaging_suppression').where({ phone }).delete();
      await mockPg('customers').where({ id: customerId }).update({ phone: null });
    }
  }, 15000);
});
