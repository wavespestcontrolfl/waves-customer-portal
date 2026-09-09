// Existing CI PostgreSQL pass; private synthetic schema, mocked delivery.
const SKIP = !process.env.DATABASE_URL;
const { randomUUID } = require('crypto');
const knex = require('knex');
let mockDatabase;
const mockSendEmail = jest.fn(async () => ({ sent: true }));
const mockSendSms = jest.fn();
const mockTierLabelStatus = jest.fn(async () => 'not_label');
jest.mock('../models/db', () => {
  const proxy = (...args) => mockDatabase(...args);
  Object.defineProperty(proxy, 'schema', { get: () => mockDatabase.schema });
  proxy.transaction = fn => mockDatabase.transaction(fn);
  proxy.raw = (...args) => mockDatabase.raw(...args);
  return proxy;
});
jest.mock('../services/logger', () => ({ warn: jest.fn(), error: jest.fn(), info: jest.fn() }));
jest.mock('../services/self-booking-plan-sync', () => ({ tierLabelStatus: (...args) => mockTierLabelStatus(...args) }));
jest.mock('../services/messaging/send-customer-message', () => ({ sendCustomerMessage: (...args) => mockSendSms(...args) }));
jest.mock('../services/sendgrid-mail', () => ({ isConfigured: () => true }));
jest.mock('../services/email-template-library', () => ({ sendTemplate: (...args) => mockSendEmail(...args), redactEmailAddresses: value => value }));
const welcome = require('../services/new-recurring-welcome-sms');

(SKIP ? describe.skip : describe)('one-time welcome PostgreSQL queue contracts', () => {
  const schema = `app_audience_${randomUUID().replaceAll('-', '')}`;
  const customerId = randomUUID();
  const serviceId = randomUUID();
  let customer;
  let service;

  beforeAll(async () => {
    mockDatabase = knex({ client: 'pg', connection: process.env.DATABASE_URL, searchPath: [schema], pool: { min: 0, max: 5 } });
    const db = mockDatabase;
    await db.raw('CREATE SCHEMA ??', [schema]);
    await db.schema.createTable('customers', t => {
      t.uuid('id').primary(); t.string('first_name'); t.string('email'); t.string('phone');
      t.boolean('active'); t.timestamp('deleted_at');
    });
    await db.schema.createTable('scheduled_services', t => {
      t.uuid('id').primary(); t.uuid('customer_id').references('id').inTable('customers');
      t.boolean('is_recurring'); t.string('status'); t.date('scheduled_date'); t.timestamp('created_at').defaultTo(db.fn.now());
    });
    await db.schema.createTable('service_records', t => {
      t.uuid('id').primary(); t.uuid('customer_id'); t.string('status'); t.date('service_date');
    });
    await db.schema.createTable('sms_sequences', t => {
      t.uuid('id').primary().defaultTo(db.raw('gen_random_uuid()'));
      t.uuid('customer_id').references('id').inTable('customers'); t.string('sequence_type', 30).notNullable();
      t.integer('step').defaultTo(0); t.string('status').notNullable(); t.timestamp('next_send_at'); t.jsonb('metadata'); t.timestamps(true, true);
      t.check("status IN ('active', 'completed', 'cancelled', 'paused', 'sending', 'converted', 'escalated')");
    });
    await db.schema.createTable('notification_prefs', t => { t.uuid('customer_id').primary(); t.boolean('email_enabled'); });
    await db.schema.createTable('email_messages', t => { t.uuid('id').primary().defaultTo(db.raw('gen_random_uuid()')); t.string('idempotency_key').unique(); t.string('status'); });
    await db.schema.createTable('sms_log', t => { t.uuid('id').primary().defaultTo(db.raw('gen_random_uuid()')); t.uuid('customer_id'); t.string('direction'); t.string('message_type'); t.string('status'); });
  });

  beforeEach(async () => {
    jest.clearAllMocks();
    process.env.GATE_ONE_TIME_WELCOME_EMAIL = 'true';
    mockTierLabelStatus.mockResolvedValue('not_label');
    for (const table of ['sms_sequences', 'scheduled_services', 'service_records', 'notification_prefs', 'email_messages', 'sms_log', 'customers']) await mockDatabase(table).del();
    [customer] = await mockDatabase('customers').insert({ id: customerId, first_name: 'Fixture', email: 'fixture@example.invalid', phone: '+19415550101', active: true }).returning('*');
    [service] = await mockDatabase('scheduled_services').insert({ id: serviceId, customer_id: customerId, is_recurring: false, status: 'confirmed', scheduled_date: '2030-01-02' }).returning('*');
  });

  afterAll(async () => {
    delete process.env.GATE_ONE_TIME_WELCOME_EMAIL;
    if (mockDatabase) { await mockDatabase.raw('DROP SCHEMA ?? CASCADE', [schema]); await mockDatabase.destroy(); }
  });

  test('racing booking callbacks enqueue once, and racing sweeps deliver email once with no SMS', async () => {
    const outcomes = await Promise.all([welcome.queueOneTimeWelcomeEmail(service), welcome.queueOneTimeWelcomeEmail(service)]);
    expect(outcomes.filter(r => r.queued)).toHaveLength(1);
    const rows = await mockDatabase('sms_sequences');
    expect(rows).toHaveLength(1);
    expect(rows[0].sequence_type).toBe(welcome.EMAIL_SEQUENCE_TYPE);
    await mockDatabase('sms_sequences').update({ next_send_at: new Date(Date.now() - 1000) });
    await Promise.all([welcome.processDueWelcomes(), welcome.processDueWelcomes()]);
    expect(mockSendEmail).toHaveBeenCalledTimes(1);
    expect(mockSendSms).not.toHaveBeenCalled();
    expect((await mockDatabase('sms_sequences').first()).status).toBe('completed');
    await welcome.processDueWelcomes();
    expect(mockSendEmail).toHaveBeenCalledTimes(1);
  });

  test.each([false, true])('racing coordinator calls enqueue once (email only: %s)', async emailOnly => {
    const input = { customer, scheduledServiceId: serviceId, emailOnly };
    const outcomes = await Promise.all([welcome.sendNewRecurringWelcome(input), welcome.sendNewRecurringWelcome(input)]);
    expect(outcomes.filter(result => result.queued)).toHaveLength(1);
    const rows = await mockDatabase('sms_sequences');
    expect(rows).toHaveLength(1);
    expect(rows[0].sequence_type).toBe(emailOnly ? welcome.EMAIL_SEQUENCE_TYPE : welcome.SEQUENCE_TYPE);
  });

  test('the email queue tombstone does not consume the existing recurring SMS guard', async () => {
    await welcome.queueOneTimeWelcomeEmail(service);
    await mockDatabase('sms_sequences').update({ status: 'completed' });
    expect(await welcome.sendNewRecurringWelcome({ customer, scheduledServiceId: serviceId })).toMatchObject({ queued: true });
    expect((await mockDatabase('sms_sequences')).map(r => r.sequence_type).sort()).toEqual([welcome.SEQUENCE_TYPE, welcome.EMAIL_SEQUENCE_TYPE].sort());
  });

  test('a legacy completed appointment blocks the new one-time audience', async () => {
    await mockDatabase('scheduled_services').insert({ id: randomUUID(), customer_id: customerId, is_recurring: false, status: 'completed', created_at: new Date(Date.now() - 86400000) });
    expect(await welcome.queueOneTimeWelcomeEmail(service)).toMatchObject({ queued: false, reason: 'not_new_customer' });
    expect(await mockDatabase('sms_sequences')).toHaveLength(0);
  });

  test.each(['cancelled', 'rescheduled', 'gate_off'])('delivery rechecks %s before email', async mode => {
    await welcome.queueOneTimeWelcomeEmail(service);
    await mockDatabase('sms_sequences').update({ next_send_at: new Date(Date.now() - 1000) });
    if (mode === 'gate_off') process.env.GATE_ONE_TIME_WELCOME_EMAIL = 'false';
    else await mockDatabase('scheduled_services').where({ id: serviceId }).update({ status: mode });
    await welcome.processDueWelcomes();
    const row = await mockDatabase('sms_sequences').first();
    expect(row.status).toBe('cancelled');
    // A parked reschedule request (legacy flip, no booked replacement) is
    // not an open booking; the rebooked visit re-enters through the tagger.
    if (mode === 'rescheduled') expect(row.metadata).toMatchObject({ skip_reason: 'booking_not_open' });
    expect(mockSendEmail).not.toHaveBeenCalled();
    expect(mockSendSms).not.toHaveBeenCalled();
  });

  test('a parked reschedule request is not enqueued, and the rebooked visit still is', async () => {
    await mockDatabase('scheduled_services').where({ id: serviceId }).update({ status: 'rescheduled' });
    expect(await welcome.queueOneTimeWelcomeEmail({ ...service, status: 'rescheduled' })).toMatchObject({ queued: false, reason: 'booking_not_open' });
    expect(await mockDatabase('sms_sequences')).toHaveLength(0);
    const rebookedId = randomUUID();
    const [rebooked] = await mockDatabase('scheduled_services').insert({ id: rebookedId, customer_id: customerId, is_recurring: false, status: 'confirmed', scheduled_date: '2030-01-09' }).returning('*');
    expect(await welcome.queueOneTimeWelcomeEmail(rebooked)).toMatchObject({ queued: true });
  });

  test('a cancelled email queue row is a tombstone, not a guard: the rebooked visit re-enters and delivers once', async () => {
    await welcome.queueOneTimeWelcomeEmail(service);
    await mockDatabase('sms_sequences').update({ next_send_at: new Date(Date.now() - 1000) });
    await mockDatabase('scheduled_services').where({ id: serviceId }).update({ status: 'cancelled' });
    await welcome.processDueWelcomes();
    expect((await mockDatabase('sms_sequences').first()).status).toBe('cancelled');
    const [rebooked] = await mockDatabase('scheduled_services').insert({ id: randomUUID(), customer_id: customerId, is_recurring: false, status: 'confirmed', scheduled_date: '2030-01-09' }).returning('*');
    expect(await welcome.queueOneTimeWelcomeEmail(rebooked)).toMatchObject({ queued: true });
    const rows = await mockDatabase('sms_sequences').orderBy('created_at');
    expect(rows.map(r => r.status)).toEqual(['cancelled', 'active']);
    await mockDatabase('sms_sequences').where({ id: rows[1].id }).update({ next_send_at: new Date(Date.now() - 1000) });
    await welcome.processDueWelcomes();
    expect(mockSendEmail).toHaveBeenCalledTimes(1);
    expect((await mockDatabase('sms_sequences').where({ id: rows[1].id }).first()).status).toBe('completed');
  });

  test('a cancel-and-rebook inside the delay retires the queued row, and the rebooked visit delivers once', async () => {
    await welcome.queueOneTimeWelcomeEmail(service);
    // Original booking cancelled BEFORE the delayed processor reaches its row.
    await mockDatabase('scheduled_services').where({ id: serviceId }).update({ status: 'cancelled' });
    const [rebooked] = await mockDatabase('scheduled_services').insert({ id: randomUUID(), customer_id: customerId, is_recurring: false, status: 'confirmed', scheduled_date: '2030-01-09' }).returning('*');
    expect(await welcome.queueOneTimeWelcomeEmail(rebooked)).toMatchObject({ queued: true });
    const rows = await mockDatabase('sms_sequences').orderBy('created_at');
    expect(rows.map(r => r.status)).toEqual(['cancelled', 'active']);
    expect(rows[0].metadata).toMatchObject({ scheduled_service_id: serviceId, skip_reason: 'superseded_by_rebooking', superseded_by_service_id: rebooked.id });
    expect(rows[1].metadata).toMatchObject({ scheduled_service_id: rebooked.id });
    await mockDatabase('sms_sequences').update({ next_send_at: new Date(Date.now() - 1000) });
    await Promise.all([welcome.processDueWelcomes(), welcome.processDueWelcomes()]);
    expect(mockSendEmail).toHaveBeenCalledTimes(1);
    expect(mockSendSms).not.toHaveBeenCalled();
    expect((await mockDatabase('sms_sequences').orderBy('created_at')).map(r => r.status)).toEqual(['cancelled', 'completed']);
  });

  test('a second open booking does not retire the queued row: the guard still holds once per customer', async () => {
    await welcome.queueOneTimeWelcomeEmail(service);
    const [second] = await mockDatabase('scheduled_services').insert({ id: randomUUID(), customer_id: customerId, is_recurring: false, status: 'confirmed', scheduled_date: '2030-01-09' }).returning('*');
    expect(await welcome.queueOneTimeWelcomeEmail(second)).toMatchObject({ reason: 'already_sent' });
    const rows = await mockDatabase('sms_sequences');
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe('active');
    expect(rows[0].metadata).toMatchObject({ scheduled_service_id: serviceId });
  });

  test('a rebook does not retire a row already claimed for dispatch', async () => {
    await welcome.queueOneTimeWelcomeEmail(service);
    await mockDatabase('sms_sequences').update({ status: 'sending' });
    await mockDatabase('scheduled_services').where({ id: serviceId }).update({ status: 'cancelled' });
    const [rebooked] = await mockDatabase('scheduled_services').insert({ id: randomUUID(), customer_id: customerId, is_recurring: false, status: 'confirmed', scheduled_date: '2030-01-09' }).returning('*');
    expect(await welcome.queueOneTimeWelcomeEmail(rebooked)).toMatchObject({ reason: 'already_sent' });
    expect((await mockDatabase('sms_sequences')).map(r => r.status)).toEqual(['sending']);
  });

  test.each(['en_route', 'on_site'])('a same-day visit already %s at the delayed recheck still receives the email', async status => {
    await welcome.queueOneTimeWelcomeEmail(service);
    await mockDatabase('sms_sequences').update({ next_send_at: new Date(Date.now() - 1000) });
    await mockDatabase('scheduled_services').where({ id: serviceId }).update({ status });
    await welcome.processDueWelcomes();
    expect(mockSendEmail).toHaveBeenCalledTimes(1);
    expect((await mockDatabase('sms_sequences').first()).status).toBe('completed');
  });

  test('stale email claims use email proof, even if a welcome SMS already exists', async () => {
    await welcome.queueOneTimeWelcomeEmail(service);
    await mockDatabase('sms_sequences').update({ status: 'sending', updated_at: new Date(Date.now() - 31 * 60 * 1000) });
    await mockDatabase('sms_log').insert({ customer_id: customerId, direction: 'outbound', message_type: welcome.TEMPLATE_KEY, status: 'delivered' });
    await welcome.processDueWelcomes();
    expect(mockSendEmail).toHaveBeenCalledTimes(1);
    expect(mockSendSms).not.toHaveBeenCalled();
    expect((await mockDatabase('sms_sequences').first()).status).toBe('completed');
  });

  test('a sent email ledger settles a stale claim without another dispatch', async () => {
    await welcome.queueOneTimeWelcomeEmail(service);
    await mockDatabase('sms_sequences').update({ status: 'sending', updated_at: new Date(Date.now() - 31 * 60 * 1000) });
    await mockDatabase('email_messages').insert({ idempotency_key: `welcome.new_recurring:${customerId}`, status: 'sent' });
    await welcome.processDueWelcomes();
    expect(mockSendEmail).not.toHaveBeenCalled();
    expect((await mockDatabase('sms_sequences').first()).status).toBe('completed');
  });
});
