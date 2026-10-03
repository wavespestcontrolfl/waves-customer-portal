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
const Reservation = require('../services/billing-email-reservation');
const { claimVerdict, claimAttempt } = require('../services/collections/contact-ledger');
const { shouldRetryExistingMessage } = require('../services/email-template-library');

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
    await mockDatabase.schema.createTable('scheduled_services', (table) => {
      table.uuid('id').primary(); table.uuid('customer_id').notNullable();
      table.timestamp('balance_reminder_sent_at', { useTz: true });
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
    await mockDatabase('scheduled_services').del();
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

  const categoriesOf = async (id) => (await rowOf(id)).categories;
  const STAMP = 'recipient_replaced';

  test('a corrected email stops the pending retry: nothing more goes to the old address, a different address is untouched', async () => {
    const customerId = randomUUID();
    const toOld = scheduled(customerId);
    const toOther = scheduled(customerId, { recipient_email_snapshot: OTHER });
    await mockDatabase('email_messages').insert([toOld, toOther]);

    await expect(correct(customerId)).resolves.toBe(1);

    const stopped = await rowOf(toOld.id);
    expect(stopped).toMatchObject({ status: 'failed', provider_retry_next_at: null, error_message: REASON });
    expect(stopped.provider_retry_exhausted_at).toBeInstanceOf(Date);
    // Unlike `blocked`, a failed row with its unsent handoff evidence is reclaimed by the owner's re-issue.
    expect(shouldRetryExistingMessage(stopped)).toBe(true);
    expect(await rowOf(toOther.id)).toMatchObject({ status: 'failed', error_message: null });
    expect(await categoriesOf(toOther.id)).not.toContain(STAMP);

    // The retry sweep that would have re-sent the old copy now only finds the other row.
    const sweep = await retry.runDueRetries();
    expect(sweep).toMatchObject({ claimed: 1, sent: 1 });
    expect(sendgrid.sendOne).toHaveBeenCalledTimes(1);
    expect(sendgrid.sendOne).toHaveBeenCalledWith(expect.objectContaining({ to: OTHER }));
    expect(sendgrid.sendOne).not.toHaveBeenCalledWith(expect.objectContaining({ to: OLD }));
  });

  test('the address matches case-insensitively and ignoring stored whitespace; ownership never crosses to another customer', async () => {
    const customerId = randomUUID();
    const otherCustomerId = randomUUID();
    const leadId = randomUUID();
    const estimateId = randomUUID();
    const strangerLead = randomUUID();
    await mockDatabase('leads').insert([{ id: leadId, customer_id: customerId }, { id: strangerLead, customer_id: randomUUID() }]);
    await mockDatabase('estimates').insert({ id: estimateId, customer_id: customerId });
    const mixedCase = scheduled(customerId, { recipient_email_snapshot: 'Old.Typo@Example.com' });
    const padded = scheduled(customerId, { recipient_email_snapshot: '  old.typo@example.com  ' });
    const viaLead = scheduled(null, { recipient_type: 'lead', recipient_id: null, lead_id: leadId });
    const viaEstimate = scheduled(null, { recipient_type: 'lead', recipient_id: null, estimate_id: estimateId });
    const leadItself = scheduled(null, { recipient_type: 'lead', recipient_id: leadId, lead_id: leadId });
    const strangers = [
      scheduled(otherCustomerId),
      scheduled(null, { recipient_type: 'lead', recipient_id: null, lead_id: strangerLead }),
      // Names another customer outright, so the edited customer's estimate link does not make it theirs.
      scheduled(otherCustomerId, { estimate_id: estimateId, lead_id: leadId }),
    ];
    await mockDatabase('email_messages').insert([mixedCase, padded, viaLead, viaEstimate, leadItself, ...strangers]);

    await expect(correct(customerId)).resolves.toBe(5);

    for (const row of [mixedCase, padded, viaLead, viaEstimate, leadItself]) expect((await rowOf(row.id)).error_message).toBe(REASON);
    for (const row of strangers) {
      expect(await rowOf(row.id)).toMatchObject({ status: 'failed', error_message: null });
      expect(await categoriesOf(row.id)).not.toContain(STAMP);
    }
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
    const accepted = scheduled(customerId, { status: 'delivered', provider_retry_next_at: null, sent_at: new Date(), provider_message_id: 'provider-0' });
    await mockDatabase('email_messages').insert([summary, claimedUnsent, started, accepted]);

    await expect(correct(customerId)).resolves.toBe(1);

    expect(await rowOf(claimedUnsent.id)).toMatchObject({ status: 'failed', provider_retry_next_at: null, error_message: REASON });
    expect(await rowOf(summary.id)).toMatchObject({ status: 'failed', error_message: null });
    expect(await categoriesOf(summary.id)).not.toContain(STAMP);
    expect(await rowOf(started.id)).toMatchObject({ status: 'queued', provider_handoff_phase: 'started', error_message: null });
    expect(await rowOf(accepted.id)).toMatchObject({ status: 'delivered', error_message: null });
    // Delivered mail is history: nothing can re-arm it, so it carries no stamp.
    expect(await categoriesOf(accepted.id)).not.toContain(STAMP);
  });

  test('a request already at the provider, or accepted and blocked later, cannot re-arm the replaced address', async () => {
    const customerId = randomUUID();
    const startedToken = randomUUID();
    const started = scheduled(customerId, {
      status: 'queued', provider_retry_next_at: null, provider_retry_count: 1, queued_at: new Date(),
      send_attempt_token: startedToken, provider_handoff_attempt_token: startedToken, provider_handoff_phase: 'started',
    });
    // Sent to the old address and awaiting SendGrid's verdict: the block event arrives AFTER the correction.
    const sentAwaitingVerdict = scheduled(customerId, {
      status: 'sent', provider_retry_next_at: null, sent_at: new Date(), provider_message_id: 'provider-1',
    });
    await mockDatabase('email_messages').insert([started, sentAwaitingVerdict]);

    await correct(customerId);

    for (const row of [started, sentAwaitingVerdict]) {
      const stamped = await rowOf(row.id);
      expect(stamped.categories).toEqual(['email_template', STAMP]);
      // The block event's scheduling now refuses: no next retry is armed for the replaced address.
      expect(retry.isTransactionalRetryEligible(stamped)).toBe(false);
      expect(retry.retryStateForProviderBlock(stamped, new Date())).not.toHaveProperty('provider_retry_next_at');
    }
    // The worker's own state is untouched (no status, phase or token write): it settles as it would have.
    expect(await rowOf(started.id)).toMatchObject({ status: 'queued', provider_handoff_phase: 'started', send_attempt_token: startedToken });
    // Stamping twice does not duplicate the marker.
    await correct(customerId);
    expect((await rowOf(started.id)).categories).toEqual(['email_template', STAMP]);

    // Even a retry scheduled by some other writer is stopped at the claim, before any provider request.
    await mockDatabase('email_messages').where({ id: sentAwaitingVerdict.id })
      .update({ status: 'failed', provider_retry_next_at: new Date(Date.now() - 1000), provider_handoff_phase: 'rejected',
        provider_handoff_attempt_token: mockDatabase.ref('send_attempt_token') });
    const sweep = await retry.runDueRetries();
    expect(sweep).toMatchObject({ claimed: 1, sent: 0 });
    expect(sendgrid.sendOne).not.toHaveBeenCalled();
    expect(await rowOf(sentAwaitingVerdict.id)).toMatchObject({ status: 'failed', provider_retry_next_at: null, error_message: REASON });
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

    const outcome = await retry.retryOne(await rowOf(claimed.id).then((row) => ({ ...row, status: 'queued', categories: ['email_template'] })));

    expect(outcome).toMatchObject({ sent: false, stopped: true });
    expect(sendgrid.sendOne).not.toHaveBeenCalled();
    expect(await rowOf(claimed.id)).toMatchObject({ status: 'failed', error_message: REASON });
  });

  // A billing replay row and the reservation its sender holds.
  async function billingReplay(customerId, { previsit = false, delivered = previsit, resolved = false, row: rowOverrides = {} } = {}) {
    const ledgerId = randomUUID();
    const invoiceId = randomUUID();
    const appointmentId = randomUUID();
    const eventKey = previsit ? `previsit-balance:${appointmentId}` : `late-payment:${invoiceId}:14`;
    const source = previsit ? 'previsit_balance_reminder' : 'late_payment_checker';
    await mockDatabase('collections_contact_ledger').insert({
      id: ledgerId, customer_id: customerId, channel: 'email', purpose: 'late_payment',
      invoice_ids: JSON.stringify([invoiceId]), source, occurred_at: new Date(),
      metadata: JSON.stringify({ notificationEventKey: eventKey, ...(delivered ? { delivered: true } : {}), ...(resolved ? { resolved: true } : {}) }),
    });
    if (previsit) await mockDatabase('scheduled_services').insert({ id: appointmentId, customer_id: customerId, balance_reminder_sent_at: new Date() });
    const row = scheduled(customerId, {
      ...rowOverrides,
      template_key: 'billing.notice',
      suppression_group_key_snapshot: 'transactional_required',
      trigger_event_id: eventKey,
      idempotency_key: `billing_channel_email:${eventKey}:email`,
      categories: JSON.stringify(['billing']),
      payload_snapshot: { __billing_replay_context: {
        schema_version: 1, customer_id: customerId, ...(previsit ? { invoice_ids: [invoiceId] } : { invoice_id: invoiceId }),
        category: 'billing', source_entry_point: source, notificationEventKey: eventKey, collections_ledger_id: ledgerId,
        ...(previsit ? {
          rendered_amount: '100.00', invoice_quotes: [{ id: invoiceId, dueCents: 10000 }], dues_cents: 0, selected_channels: ['email'],
          appointment_id: appointmentId, appointment_date: '2030-06-10', appointment_rendered_on: '2030-06-09',
          appointment_service_type: 'Pest Control',
        } : {}),
      } },
    });
    await mockDatabase('email_messages').insert(row);
    return { row, ledgerId, appointmentId };
  }
  const ledgerMetadata = async (id) => (await mockDatabase('collections_contact_ledger').where({ id }).first()).metadata;

  test('a billing replay stopped this way reopens its reservation: the owning sender can claim it again and reach the corrected address', async () => {
    const customerId = randomUUID();
    const { row, ledgerId } = await billingReplay(customerId);

    await expect(correct(customerId)).resolves.toBe(1);

    const stopped = await rowOf(row.id);
    expect(stopped).toMatchObject({ status: 'failed', provider_retry_next_at: null, error_message: REASON });
    expect(shouldRetryExistingMessage(stopped)).toBe(true);
    const metadata = await ledgerMetadata(ledgerId);
    // Never `resolved`: claimVerdict refuses a resolved leg forever, which would mean the notice never goes out.
    expect(metadata).toMatchObject({ send_failed: true, code: 'email_not_sent' });
    expect(metadata.resolved).toBeUndefined();
    expect(claimVerdict({ id: ledgerId, metadata, reused: true })).toEqual({ allowed: true, reopen: true });
  });

  test('a previsit reminder stopped this way frees its appointment claim for a fresh rendering', async () => {
    const customerId = randomUUID();
    const { row, ledgerId, appointmentId } = await billingReplay(customerId, { previsit: true });

    await expect(correct(customerId)).resolves.toBe(1);

    expect(await rowOf(row.id)).toMatchObject({
      status: 'failed', error_message: 'Billing email old quote retired: ' + REASON,
    });
    expect(Reservation.BILLING_EMAIL_REQUOTE_REFUSAL_PREFIX).toBe('Billing email re-quote required: ');
    const metadata = await ledgerMetadata(ledgerId);
    expect(metadata.send_failed).toBe(true);
    expect(metadata.delivered).toBeUndefined();
    expect((await mockDatabase('scheduled_services').where({ id: appointmentId }).first()).balance_reminder_sent_at).toBeNull();
  });

  test('a sender-rendered dunning follow-up keeps its own settlement and reservation', async () => {
    const customerId = randomUUID();
    const followup = scheduled(customerId, {
      template_key: 'invoice.followup_7_day', suppression_group_key_snapshot: 'transactional_required',
      trigger_event_id: `customer_dunning_email:${randomUUID()}:1:d7`,
    });
    await mockDatabase('email_messages').insert(followup);

    await expect(correct(customerId)).resolves.toBe(0);

    expect(await rowOf(followup.id)).toMatchObject({ status: 'failed', error_message: null });
  });

  // SendGrid accepted the email (the sender stamped the reservation delivered and the row carries sent_at),
  // then the recipient's server blocked it: the webhook re-armed the row with the acceptance-time stamps intact.
  const acceptedThenBlocked = { sent_at: new Date(Date.now() - 60000), provider_message_id: 'provider-accepted' };

  test('an accepted-then-blocked billing email reopens its delivered reservation, and no repair re-stamps it delivered', async () => {
    const customerId = randomUUID();
    const { row, ledgerId } = await billingReplay(customerId, { delivered: true, row: acceptedThenBlocked });

    await expect(correct(customerId)).resolves.toBe(1);

    const stopped = await rowOf(row.id);
    // The acceptance-time stamp is cleared with the stop; the provider id stays for webhook matching.
    expect(stopped).toMatchObject({ status: 'failed', sent_at: null, provider_message_id: 'provider-accepted', error_message: REASON });
    const metadata = await ledgerMetadata(ledgerId);
    expect(metadata.delivered).toBeUndefined();
    expect(metadata).toMatchObject({ send_failed: true, code: 'email_not_sent' });
    expect(claimVerdict({ id: ledgerId, metadata, reused: true })).toEqual({ allowed: true, reopen: true });
    // The accepted-evidence repair must not read the blocked attempt as delivered again.
    const loaded = await mockDatabase('collections_contact_ledger').where({ id: ledgerId }).first();
    await Reservation.repairAcceptedBillingEmailReservations([loaded], mockDatabase);
    expect((await ledgerMetadata(ledgerId)).delivered).toBeUndefined();
    // The owning sender's next attempt claims it, and the row is reclaimable to the corrected address.
    expect(shouldRetryExistingMessage(stopped)).toBe(true);
    await expect(claimAttempt({ id: ledgerId, metadata, reused: true })).resolves.toEqual({ allowed: true });
  });

  test('a scheduled blocked previsit reminder with its original sent_at frees the appointment claim', async () => {
    const customerId = randomUUID();
    const { row, ledgerId, appointmentId } = await billingReplay(customerId, { previsit: true, row: acceptedThenBlocked });

    await expect(correct(customerId)).resolves.toBe(1);

    expect(await rowOf(row.id)).toMatchObject({ status: 'failed', sent_at: null, error_message: 'Billing email old quote retired: ' + REASON });
    expect((await ledgerMetadata(ledgerId)).delivered).toBeUndefined();
    expect((await mockDatabase('scheduled_services').where({ id: appointmentId }).first()).balance_reminder_sent_at).toBeNull();
  });

  test('a previsit release the cron lease deferred is completed by stale-claim recovery', async () => {
    const customerId = randomUUID();
    const { row, appointmentId } = await billingReplay(customerId, { previsit: true, row: acceptedThenBlocked });
    const lease = await mockDatabase.transaction(async (holder) => {
      await holder.raw('SELECT pg_advisory_xact_lock(hashtext(?))', ['cron:previsit-balance-reminder']);
      await correct(customerId);
      return (await mockDatabase('scheduled_services').where({ id: appointmentId }).first()).balance_reminder_sent_at;
    });
    // The lease was busy: the row is stopped and marked for the re-quote release, the claim still held.
    expect(lease).toBeInstanceOf(Date);
    expect((await rowOf(row.id)).error_message).toBe(`${Reservation.BILLING_EMAIL_REQUOTE_REFUSAL_PREFIX}${REASON}`);

    await retry.recoverStaleClaims();

    expect((await mockDatabase('scheduled_services').where({ id: appointmentId }).first()).balance_reminder_sent_at).toBeNull();
    expect((await rowOf(row.id)).error_message).toBe('Billing email old quote retired: ' + REASON);
  });

  test('a genuinely delivered billing email is never reopened or released, and a resolved or newer reservation is left alone', async () => {
    const customerId = randomUUID();
    // Delivered: no schedule, so the stop does not even select it.
    const delivered = await billingReplay(customerId, { delivered: true, row: {
      status: 'delivered', provider_retry_next_at: null, sent_at: new Date(), delivered_at: new Date(), provider_message_id: 'provider-d',
    } });
    // A block event after a delivery event: still scheduled, but delivery evidence keeps the leg closed and the stamp.
    const deliveredThenBlocked = await billingReplay(customerId, { delivered: true, row: { ...acceptedThenBlocked, delivered_at: new Date() } });
    const deliveredPrevisit = await billingReplay(customerId, { previsit: true, row: { ...acceptedThenBlocked, delivered_at: new Date() } });
    // Resolved by an earlier terminal refusal.
    const resolved = await billingReplay(customerId, { delivered: true, resolved: true, row: acceptedThenBlocked });

    await expect(correct(customerId)).resolves.toBe(3);

    expect(await rowOf(delivered.row.id)).toMatchObject({ status: 'delivered', error_message: null });
    expect((await ledgerMetadata(delivered.ledgerId)).delivered).toBe(true);
    expect((await rowOf(deliveredThenBlocked.row.id)).sent_at).toBeInstanceOf(Date);
    expect(await ledgerMetadata(deliveredThenBlocked.ledgerId)).toMatchObject({ delivered: true });
    expect((await ledgerMetadata(deliveredThenBlocked.ledgerId)).send_failed).toBeUndefined();
    expect((await mockDatabase('scheduled_services').where({ id: deliveredPrevisit.appointmentId }).first()).balance_reminder_sent_at).toBeInstanceOf(Date);
    expect(await ledgerMetadata(resolved.ledgerId)).toMatchObject({ delivered: true, resolved: true });
    expect((await ledgerMetadata(resolved.ledgerId)).send_failed).toBeUndefined();
  });

  test('a reopen for an attempt a newer one has replaced changes nothing', async () => {
    const customerId = randomUUID();
    const { row, ledgerId } = await billingReplay(customerId, { delivered: true, row: acceptedThenBlocked });
    await correct(customerId);
    // The owner reclaimed the row with a new attempt (new token, in flight again) and its acceptance stamped delivered.
    const newer = randomUUID();
    await mockDatabase('email_messages').where({ id: row.id }).update({
      status: 'sent', send_attempt_token: newer, provider_handoff_attempt_token: newer, provider_handoff_phase: 'started', sent_at: new Date(),
    });
    await mockDatabase('collections_contact_ledger').where({ id: ledgerId })
      .update({ metadata: mockDatabase.raw("(metadata - 'send_failed') || '{\"delivered\": true}'::jsonb") });
    const stale = { ...(await rowOf(row.id)), send_attempt_token: row.send_attempt_token, status: 'failed' };

    await expect(Reservation.reopenBillingEmailReservationForReissue(stale, mockDatabase)).resolves.toBe(false);

    expect(await ledgerMetadata(ledgerId)).toMatchObject({ delivered: true });
  });
});
