// Opt-in against a verified private QA database. Clone the migrated table
// shapes into a disposable schema; all recipients and providers are fictional.
process.env.JWT_SECRET = process.env.JWT_SECRET || 'qa-customer-app-notifications-only';
jest.mock('../models/db', () => {
  const db = (...args) => mockPg(...args);
  db.raw = (...args) => mockPg.raw(...args);
  db.transaction = (...args) => mockPg.transaction(...args);
  Object.defineProperty(db, 'fn', { get: () => mockPg.fn });
  Object.defineProperty(db, 'schema', { get: () => mockPg.schema });
  return db;
});
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/account-membership-email', () => ({ sendAccountUpdated: jest.fn(async () => ({})), sendRequestUpdated: jest.fn(async () => ({})) }));
jest.mock('../services/apns', () => ({ send: jest.fn(), status: () => ({ configured: true }) }));
jest.mock('../services/fcm', () => ({ send: jest.fn(), status: () => ({ configured: true }) }));
jest.mock('../services/conversations', () => ({ recordTouchpoint: jest.fn(async () => ({})) }));
jest.mock('../utils/scheduled-cron', () => ({ schedule: jest.fn(), scheduleTimeout: jest.fn(), scheduleInterval: jest.fn() }));
jest.mock('../utils/cron-lock', () => ({ ...jest.requireActual('../utils/cron-lock'), settleDeadRunningJobs: jest.fn(async () => ({})) }));
jest.mock('../services/time-tracking-crons', () => ({ initTimeTrackingCrons: jest.fn() }));
jest.mock('../services/equipment-crons', () => ({ initEquipmentCrons: jest.fn() }));
jest.mock('../services/bouncie-mileage-crons', () => ({ initBouncieMileageCrons: jest.fn() }));
jest.mock('../services/analytics/ga4-crons', () => ({ initGA4Crons: jest.fn() }));

const { randomUUID } = require('node:crypto');
const express = require('express');
const { generateToken } = require('../middleware/auth');
const Push = require('../services/push-notifications');
const Notifications = require('../services/notification-service');
const apns = require('../services/apns');
const fcm = require('../services/fcm');
const connection = process.env.APP_TEST_DATABASE_URL;
const postgres = connection ? describe : describe.skip;
const schema = `app_notifications_${randomUUID().replaceAll('-', '')}`;
const owner = randomUUID();
const property = randomUUID();
const outsider = randomUUID();
let admin;
let mockPg;
let app;
let token;
let adminToken;
let server;
let baseUrl;
jest.setTimeout(30000);

postgres('customer app preferences and push ledger (PostgreSQL)', () => {
  beforeAll(async () => {
    const target = new URL(connection);
    const privateQa = /^\/waves_qa_[a-f0-9]{32}$/.test(target.pathname);
    const ci = process.env.CI === 'true' && target.hostname === 'localhost' && target.pathname === '/waves_test';
    if (!privateQa && !ci) throw new Error('Use a verified private QA database or the isolated CI database');
    admin = require('knex')({ client: 'pg', connection, pool: { min: 0, max: 1 } });
    await admin.schema.createSchema(schema);
    mockPg = require('knex')({ client: 'pg', connection, searchPath: [schema], pool: { min: 0, max: 4 } });
    for (const table of ['customers', 'notification_prefs', 'notifications', 'push_subscriptions', 'invoices', 'sms_log', 'scheduled_services', 'payers', 'service_requests', 'technicians', 'ops_email_send_state']) {
      await mockPg.raw('CREATE TABLE ?? (LIKE ?? INCLUDING ALL)', [table, `public.${table}`]);
    }
    expect(await mockPg.schema.hasColumn('notification_prefs', 'push_enabled')).toBe(true);
    const invoiceMigration = require('../models/migrations/20260909000060_invoice_app_channel');
    await mockPg.transaction(async (trx) => {
      await invoiceMigration.up(trx);
      await invoiceMigration.up(trx);
      await invoiceMigration.down(trx);
      await invoiceMigration.down(trx);
      await invoiceMigration.up(trx);
    });
    const paymentMigration = require('../models/migrations/20260909000061_payment_issue_app_channel');
    await mockPg.transaction(async (trx) => {
      await paymentMigration.up(trx);
      await paymentMigration.up(trx);
      await paymentMigration.down(trx);
      await paymentMigration.down(trx);
      await paymentMigration.up(trx);
    });
    const requestMigration = require('../models/migrations/20260909000062_request_app_channel');
    await mockPg.transaction(async (trx) => {
      await requestMigration.up(trx); await requestMigration.up(trx);
      await requestMigration.down(trx); await requestMigration.down(trx); await requestMigration.up(trx);
    });
    const versionMigration = require('../models/migrations/20260909000063_request_status_version');
    const hadVersion = await mockPg.schema.hasColumn('service_requests', 'status_version');
    const probe = await mockPg.transaction();
    try {
      await versionMigration.up(probe); await versionMigration.up(probe);
      await versionMigration.down(probe); await versionMigration.down(probe); await versionMigration.up(probe);
      expect(await probe.schema.hasColumn('service_requests', 'status_version')).toBe(true);
    } finally { await probe.rollback(); }
    expect(await mockPg.schema.hasColumn('service_requests', 'status_version')).toBe(hadVersion);
    await versionMigration.up(mockPg);
    await require('../models/migrations/20260909000064_request_channel_provenance').up(mockPg);
    await mockPg('customers').insert([
      { id: owner, account_id: owner, is_primary_profile: true },
      { id: property, account_id: owner, is_primary_profile: false },
      { id: outsider, account_id: outsider, is_primary_profile: true },
    ].map((row, i) => ({ ...row, first_name: 'QA', last_name: 'Fixture', active: true,
      phone: `+1941555010${i}`, email: `qa-app-${i}@example.invalid` })));
    const [staff] = await mockPg('technicians').insert({ name: 'QA Administrator', email: 'qa-admin@example.invalid',
      role: 'admin', employment_status: 'active', auth_token_version: 1, must_change_password: false }).returning('id');
    adminToken = require('jsonwebtoken').sign({ technicianId: staff.id, type: 'access', tokenVersion: 1 },
      require('../config').jwt.secret, { expiresIn: '1h' });
    app = express();
    app.use(express.json());
    app.use('/api/notifications', require('../routes/notifications'));
    app.use('/api/notification-prefs', require('../routes/notification-prefs'));
    app.use('/api/push', require('../routes/push'));
    app.use('/api/requests', require('../routes/requests'));
    app.use('/api/admin/requests', require('../routes/admin-requests'));
    app.use((err, req, res, next) => res.status(err.isJoi ? 400 : 500).json({ error: err.message }));
    server = await new Promise((resolve) => { const listener = app.listen(0, '127.0.0.1', () => resolve(listener)); });
    baseUrl = `http://127.0.0.1:${server.address().port}`;
    token = generateToken(property, owner);
  }, 60000);
  afterAll(async () => {
    delete process.env.GATE_CUSTOMER_APP_NOTIFICATIONS;
    if (server) await new Promise((resolve) => server.close(resolve));
    await mockPg?.destroy();
    if (admin) { await admin.schema.dropSchemaIfExists(schema, true); await admin.destroy(); }
  });
  beforeEach(async () => {
    jest.clearAllMocks();
    process.env.GATE_CUSTOMER_APP_NOTIFICATIONS = 'true';
    await mockPg('notifications').del();
    await mockPg('push_subscriptions').del();
    await mockPg('notification_prefs').del();
    await mockPg('invoices').del();
    await mockPg('sms_log').del();
    await mockPg('scheduled_services').del();
    await mockPg('payers').del();
    await mockPg('service_requests').del();
    await mockPg('customers').update({ payer_id: null });
    await mockPg('notification_prefs').insert([owner, property, outsider].map((id) => ({ customer_id: id })));
    apns.send.mockResolvedValue({ ok: true });
    fcm.send.mockResolvedValue({ ok: true });
  });

  test('profile preference merge retains App instead of resuming primary Text', async () => {
    await mockPg('notification_prefs').where({ customer_id: owner }).update({ payment_issue_channel: 'sms' });
    await mockPg('notification_prefs').where({ customer_id: outsider }).update({ payment_issue_channel: 'push' });
    const { mergeSingletonPrefRow } = require('../services/customer-dedupe')._test;
    await mockPg.transaction((trx) => mergeSingletonPrefRow(trx, 'notification_prefs', 'customer_id', owner, outsider));
    expect(await mockPg('notification_prefs').where({ customer_id: owner }).first()).toMatchObject({ payment_issue_channel: 'push' });
    expect(await mockPg('notification_prefs').where({ customer_id: outsider }).first()).toBeUndefined();
  });

  test.each([['email', 'push'], ['push', 'email']])('profile merge preserves a request Email choice: %s + %s', async (winner, loser) => {
    await mockPg('notification_prefs').where({ customer_id: owner }).update({ request_channel: winner, request_channel_explicit: true });
    await mockPg('notification_prefs').where({ customer_id: outsider }).update({ request_channel: loser, request_channel_explicit: true });
    const { mergeSingletonPrefRow } = require('../services/customer-dedupe')._test;
    await mockPg.transaction((trx) => mergeSingletonPrefRow(trx, 'notification_prefs', 'customer_id', owner, outsider));
    expect(await mockPg('notification_prefs').where({ customer_id: owner }).first()).toMatchObject({ request_channel: 'email' });
  });

  test('provenance migration preserves historical uncertainty and consent timestamps through repeatable up/down', async () => {
    const migration = require('../models/migrations/20260909000064_request_channel_provenance');
    const capturedAt = new Date('2025-01-02T12:00:00Z');
    const probe = await mockPg.transaction();
    try {
      await migration.down(probe);
      await probe('notification_prefs').update({ request_channel: 'email', updated_at: capturedAt });
      await probe('notification_prefs').where({ customer_id: property }).update({ request_channel: 'push' });
      await migration.up(probe); await migration.up(probe);
      for (const id of [owner, property, outsider]) {
        expect(await probe('notification_prefs').where({ customer_id: id }).first()).toMatchObject({
          request_channel_explicit: id === property ? true : null, updated_at: capturedAt,
        });
      }
      const [fresh] = await probe('notification_prefs').insert({ customer_id: randomUUID() }).returning('*');
      expect(fresh).toMatchObject({ request_channel: 'email', request_channel_explicit: false });
      await migration.down(probe); await migration.down(probe); await migration.up(probe);
      expect(await probe.schema.hasColumn('notification_prefs', 'request_channel_explicit')).toBe(true);
    } finally { await probe.rollback(); }
    expect(await mockPg.schema.hasColumn('notification_prefs', 'request_channel_explicit')).toBe(true);
  });

  test.each([
    ['email', false, 'push', true, 'push', true],
    ['push', true, 'email', false, 'push', true],
    ['email', null, 'push', true, 'email', null],
    ['push', true, 'email', null, 'email', null],
    ['email', false, 'email', true, 'email', true],
    ['email', true, 'email', false, 'email', true],
    ['email', false, 'email', null, 'email', null],
    ['email', null, 'email', false, 'email', null],
    ['push', false, 'push', true, 'push', true],
    ['push', true, 'push', false, 'push', true],
  ])('request merge keeps the selected channel and provenance: %s/%s + %s/%s', async (winner, winnerExplicit, loser, loserExplicit, channel, explicit) => {
    await mockPg('notification_prefs').where({ customer_id: owner }).update({
      request_channel: winner, request_channel_explicit: winnerExplicit, sms_enabled: true,
    });
    await mockPg('notification_prefs').where({ customer_id: outsider }).update({
      request_channel: loser, request_channel_explicit: loserExplicit, sms_enabled: false,
    });
    const { mergeSingletonPrefRow } = require('../services/customer-dedupe')._test;
    await mockPg.transaction((trx) => mergeSingletonPrefRow(trx, 'notification_prefs', 'customer_id', owner, outsider));
    expect(await mockPg('notification_prefs').where({ customer_id: owner }).first()).toMatchObject({
      request_channel: channel, request_channel_explicit: explicit, sms_enabled: false,
    });
    expect(await mockPg('notification_prefs').where({ customer_id: outsider }).first()).toBeUndefined();
  });

  test.each(['email', 'push'])('a request-only merge to %s retains the existing consent timestamp', async (channel) => {
    const capturedAt = new Date('2025-01-02T12:00:00Z');
    await mockPg('notification_prefs').where({ customer_id: owner }).update({ updated_at: capturedAt });
    await mockPg('notification_prefs').where({ customer_id: outsider }).update({ request_channel: channel, request_channel_explicit: true });
    const { mergeSingletonPrefRow } = require('../services/customer-dedupe')._test;
    await mockPg.transaction((trx) => mergeSingletonPrefRow(trx, 'notification_prefs', 'customer_id', owner, outsider));
    expect(await mockPg('notification_prefs').where({ customer_id: owner }).first()).toMatchObject({
      request_channel: channel, request_channel_explicit: true, updated_at: capturedAt,
    });
  });

  const prefsUrl = '/api/notifications/preferences?appPreferences=1';
  async function http(method, url, body, authenticated = true) {
    const response = await fetch(baseUrl + url, { method,
      headers: { 'Content-Type': 'application/json', ...(authenticated ? { Authorization: `Bearer ${token}` } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    return { status: response.status, headers: Object.fromEntries(response.headers), body: await response.json() };
  }
  const put = (body, url = prefsUrl) => http('PUT', url, body);
  const get = (url = prefsUrl) => http('GET', url);
  async function device(customerId = owner, platform = 'ios', extra = {}) {
    const [row] = await mockPg('push_subscriptions').insert({ customer_id: customerId, role: 'customer',
      platform, device_token: `qa-${randomUUID()}`, subscription_data: '{}', active: true, ...extra }).returning('*');
    return row;
  }

  test.each(['ios', 'android'])('%s transient delivery retries the same bell and settles after acceptance', async (platform) => {
    await device(owner, platform); await put({ requestChannel: 'push' });
    const [request] = await mockPg('service_requests').insert({ customer_id: property, category: 'general', subject: 'QA retry request', status: 'new' }).returning('*');
    const provider = platform === 'ios' ? apns : fcm;
    provider.send.mockResolvedValueOnce({ ok: false, retryable: true, retryAfterMs: 900000 }).mockResolvedValue({ ok: true });
    const notice = { customerId: property, to: '+19415550101', body: 'Request received', messageType: 'service_request_received',
      explicitPushOnly: true, notificationEventKey: `request:${request.id}:service_request_received:0`,
      requestNotification: { id: request.id, status: request.status, version: request.status_version } };
    const routing = require('../services/messaging/push-channel-routing');
    expect(await routing.attemptPushFirst(notice)).toMatchObject({ delivered: false, retryable: true, retryAfterMs: 900000 });
    expect(await mockPg('notifications').first()).toMatchObject({ metadata: { pushState: 'failed' } });
    expect(await mockPg('push_subscriptions').first()).toMatchObject({ active: true });
    expect(await routing.attemptPushFirst(notice)).toMatchObject({ delivered: true });
    expect(await routing.attemptPushFirst(notice)).toMatchObject({ delivered: true });
    expect(provider.send).toHaveBeenCalledTimes(2);
    expect(provider.send.mock.calls[0][1].tag).toBe(provider.send.mock.calls[1][1].tag);
    expect(await mockPg('notifications')).toHaveLength(1);
    expect(await mockPg('notifications').first()).toMatchObject({ metadata: { pushState: 'accepted' } });
  });

  test('the scheduled invoice rail respects native backoff and its existing five-attempt cap', async () => {
    const [invoice] = await mockPg('invoices').insert({ customer_id: property, token: randomUUID(),
      invoice_number: 'QA-NATIVE-RETRY', status: 'scheduled', scheduled_send_at: new Date(0), scheduled_send_attempts: 0 }).returning('*');
    const Invoice = require('../services/invoice');
    const gates = require('../config/feature-gates');
    const originalGate = gates.isEnabled;
    const gate = jest.spyOn(gates, 'isEnabled').mockImplementation((key) => key === 'smsSendWindow' ? false : originalGate(key));
    const jitter = jest.spyOn(Math, 'random').mockReturnValue(0);
    const send = jest.spyOn(Invoice, 'sendViaSMSAndEmail').mockResolvedValue({ ok: false, creditApplied: 0,
      sms: { code: 'APP_PROVIDER_RETRY', deferred: true, retryAfterMs: 900000, nextAllowedAt: new Date(Date.now() + 900000).toISOString() },
    });
    try {
      for (let attempt = 1; attempt <= 5; attempt += 1) {
        await mockPg('invoices').where({ id: invoice.id }).update({ scheduled_send_at: new Date(0) });
        const startedAt = Date.now();
        expect(await Invoice.processScheduledSends()).toEqual({ sent: 0, failed: 1, deferred: 0 });
        const row = await mockPg('invoices').where({ id: invoice.id }).first();
        expect(row).toMatchObject({ status: 'scheduled', scheduled_send_attempts: attempt });
        expect(row.scheduled_send_at.getTime()).toBeGreaterThanOrEqual(startedAt + 900000 * (2 ** (attempt - 1)));
      }
      await mockPg('invoices').where({ id: invoice.id }).update({ scheduled_send_at: new Date(0) });
      expect(await Invoice.processScheduledSends()).toEqual({ sent: 0, failed: 0, deferred: 0 });
      expect(send).toHaveBeenCalledTimes(5);
    } finally { send.mockRestore(); gate.mockRestore(); jitter.mockRestore(); }
  });

  test('native retries preserve the existing fallback outcome for other App families', async () => {
    await device(); await put({ serviceReminder24hChannel: 'push' });
    apns.send.mockResolvedValue({ ok: false, retryable: true, retryAfterMs: 900000 });
    const result = await require('../services/messaging/push-channel-routing').attemptPushFirst({
      customerId: property, to: '+19415550101', body: 'QA reminder', messageType: 'appointment_reminder',
      explicitPushOnly: true, notificationEventKey: 'qa-reminder-unchanged-policy',
    });
    expect(result.delivered).toBe(false);
    expect(result.retryable).toBeUndefined();
    expect(apns.send).toHaveBeenCalledTimes(1);
  });

  test('one accepting device settles the event despite another temporary failure', async () => {
    await device(owner, 'ios'); await device(owner, 'android');
    apns.send.mockResolvedValue({ ok: false, retryable: true, retryAfterMs: 900000 });
    const opts = { dedupeKey: 'qa:mixed-acceptance', awaitPush: true, pushOptions: { nativeOnly: true } };
    expect((await Notifications.notifyCustomer(property, 'service', 'QA update', 'QA body', opts)).push.accepted).toBe(1);
    expect((await Notifications.notifyCustomer(property, 'service', 'QA update', 'QA body', opts)).push.accepted).toBe(1);
    expect(apns.send).toHaveBeenCalledTimes(1);
    expect(fcm.send).toHaveBeenCalledTimes(1);
  });

  test.each([['ios', true], ['android', true], ['ios', false], ['android', false]])('%s expired=%s is not a temporary retry', async (platform, expired) => {
    await device(owner, platform); await put({ requestChannel: 'push' });
    (platform === 'ios' ? apns : fcm).send.mockResolvedValue({ ok: false, expired, reason: expired ? 'Unregistered' : 'invalid_payload' });
    const result = await Notifications.notifyCustomer(property, 'service', 'QA update', 'QA body', { awaitPush: true });
    expect(result.push.accepted).toBe(0);
    expect(result.push.retryable).toBeUndefined();
    expect((await mockPg('push_subscriptions').first()).active).toBe(!expired);
  });

  test('scheduled request delivery backs off, stops after three retries, and keeps App intent', async () => {
    await mockPg('notification_prefs').where({ customer_id: property }).update({ request_channel: 'push' });
    const [request] = await mockPg('service_requests').insert({ customer_id: property, category: 'general', subject: 'QA bounded retry', status: 'new' }).returning('*');
    const send = jest.spyOn(require('../services/messaging/send-customer-message'), 'sendCustomerMessage').mockResolvedValue({
      sent: false, code: 'APP_PROVIDER_RETRY', retryable: true, deferred: true, retryAfterMs: 900000,
      nextAllowedAt: new Date(Date.now() + 900000).toISOString(),
    });
    const gate = jest.spyOn(require('../config/feature-gates'), 'isEnabled').mockImplementation((name) => name === 'cronJobs');
    const logGates = jest.spyOn(require('../config/feature-gates'), 'logGateStatus').mockImplementation(() => {});
    const jitter = jest.spyOn(Math, 'random').mockReturnValue(0);
    try {
      require('../services/scheduler').initScheduledJobs();
      const registration = require('../utils/scheduled-cron').schedule.mock.calls.find(([, tick]) => String(tick).includes('claimDueScheduledSms'));
      expect(registration).toBeDefined();
      const tick = registration[1];
      await require('../services/request-app-notifications').send({ customerId: property, request, received: true });
      const queued = await mockPg('sms_log').where({ status: 'scheduled' }).first();
      expect(queued).toBeDefined();
      for (let attempt = 1; attempt <= 3; attempt++) {
        await mockPg('sms_log').where({ id: queued.id }).update({ scheduled_for: new Date(Date.now() - 60000) });
        const startedAt = Date.now();
        await tick();
        const row = await mockPg('sms_log').where({ id: queued.id }).first();
        expect(row.metadata.scheduled_sms_attempts).toBe(attempt);
        expect(row.status).toBe(attempt === 3 ? 'blocked' : 'scheduled');
        if (attempt < 3) {
          expect(row.metadata.provider_retry_code).toBe('APP_PROVIDER_RETRY');
          expect(new Date(row.scheduled_for).getTime()).toBeGreaterThanOrEqual(startedAt + 900000 * (2 ** attempt));
        }
      }
      await tick();
      expect(send).toHaveBeenCalledTimes(4); // initial attempt + the existing three-retry cap
      for (const [input] of send.mock.calls) {
        expect(input).toMatchObject({ customerInitiated: true, metadata: { appOnly: true, service_request_id: request.id,
          request_status_version: 0, notificationEventKey: `request:${request.id}:service_request_received:0` } });
      }
    } finally { send.mockRestore(); gate.mockRestore(); logGates.mockRestore(); jitter.mockRestore(); }
  });

  test('readiness authenticates and returns no device identifiers', async () => {
    expect((await http('GET', '/api/push/status', null, false)).status).toBe(401);
    await device(outsider);
    expect((await get('/api/push/status')).body).toEqual({ available: true, enabled: true, registered: false, fresh: false });
    await device(owner);
    const status = await get('/api/push/status');
    expect(status.headers['cache-control']).toBe('no-store');
    expect(status.body).toEqual({ available: true, enabled: true, registered: true, fresh: true });
  });


  test('request App choice belongs to the requesting profile and preserves old-client saves', async () => {
    expect((await put({ requestChannel: 'push' })).status).toBe(409);
    await device();
    expect((await put({ requestChannel: 'push' })).status).toBe(200);
    expect((await mockPg('notification_prefs').where({ customer_id: owner }).first()).request_channel).toBe('email');
    await http('PUT', '/api/notifications/preferences', { requestChannel: 'email' });
    expect((await mockPg('notification_prefs').where({ customer_id: property }).first()).request_channel).toBe('push');
    delete process.env.GATE_CUSTOMER_APP_NOTIFICATIONS;
    await put({ requestChannel: 'email' });
    expect((await mockPg('notification_prefs').where({ customer_id: property }).first()).request_channel).toBe('push');
  });


  test('a held request App notice persists its exact replay event in PostgreSQL', async () => {
    await device(); await put({ requestChannel: 'push' });
    const [request] = await mockPg('service_requests').insert({ customer_id: property,
      category: 'general', subject: 'QA request', status: 'new' }).returning('*');
    const sender = require('../services/messaging/send-customer-message');
    const mockSend = jest.spyOn(sender, 'sendCustomerMessage').mockResolvedValue({ sent: false,
      deferred: true, code: 'PUSH_IN_FLIGHT', nextAllowedAt: new Date(Date.now() + 60000).toISOString() });
    try {
      await require('../services/request-app-notifications').send({ customerId: property, request, received: true });
      const queued = await mockPg('sms_log').where({ customer_id: property, status: 'scheduled' }).first();
      expect(queued.metadata).toMatchObject({ ...mockSend.mock.calls[0][0].metadata,
        entry_point: 'request_app_deferred', refresh_customer_phone: true, customer_initiated: true });
    } finally { mockSend.mockRestore(); }
  });

  test('App links and authenticated reads select the exact old resolved request', async () => {
    await device(); await put({ requestChannel: 'push' });
    const id = randomUUID(); const updated_at = new Date('2026-09-09T12:00:00Z');
    await mockPg('service_requests').insert({ id, customer_id: property, category: 'general',
      subject: 'QA resolved request', status: 'resolved', created_at: new Date('2025-01-01'), updated_at });
    const input = { customerId: property, to: '+19415550101', body: 'Request update',
      messageType: 'service_request_updated', explicitPushOnly: true, notificationEventKey: `request:${id}`,
      requestNotification: { id, status: 'resolved', version: 0 } };
    const routing = require('../services/messaging/push-channel-routing');
    expect((await routing.attemptPushFirst(input)).delivered).toBe(true);
    expect((await routing.attemptPushFirst(input)).delivered).toBe(true);
    expect(apns.send).toHaveBeenCalledTimes(1);
    expect(require('../services/conversations').recordTouchpoint).not.toHaveBeenCalled();
    const notice = await mockPg('notifications').where({ recipient_id: property }).first();
    expect(notice.link).toContain(`requestId=${id}`);
    expect(new URL(notice.link, 'https://example.invalid').searchParams.get('requestEvent')).toBe(input.notificationEventKey);
    const result = await get(`/api/requests?requestId=${id}`);
    expect(result.status).toBe(200);
    expect(result.body.requests).toMatchObject([{ id, status: 'resolved' }]);
    await mockPg('service_requests').where({ id }).update({ customer_id: outsider });
    expect((await get(`/api/requests?requestId=${id}`)).body.requests).toEqual([]);
    expect((await routing.attemptPushFirst(input)).blocked).toBe(true);
    await mockPg('service_requests').where({ id }).update({ customer_id: property, source: 'admin' });
    expect((await get(`/api/requests?requestId=${id}`)).body.requests).toEqual([]);
    expect((await routing.attemptPushFirst(input)).blocked).toBe(true);
    expect((await get('/api/requests?requestId=invalid')).status).toBe(400);
  });

  test('request status replay survives note edits and rechecks status before final delivery', async () => {
    await device(); await put({ requestChannel: 'push' });
    const [request] = await mockPg('service_requests').insert({ customer_id: property,
      category: 'general', subject: 'QA status update', status: 'acknowledged' }).returning('*');
    const meta = { customer_id: property, service_request_id: request.id, request_status: request.status,
      request_status_version: request.status_version, request_updated_at: request.updated_at.toISOString() };
    const { recheckDeferredReplay } = require('../services/messaging/deferred-replay-registry');
    await mockPg('service_requests').where({ id: request.id }).update({ admin_notes: 'Assignment adjusted',
      updated_at: new Date(request.updated_at.getTime() + 60000) });
    expect(await recheckDeferredReplay('request_app_deferred', meta)).toEqual({ eligible: true });
    const routing = require('../services/messaging/push-channel-routing');
    const input = { customerId: property, to: '+19415550101', body: 'Request update',
      messageType: 'service_request_updated', explicitPushOnly: true, notificationEventKey: `request:${request.id}:status-1`,
      requestNotification: { id: request.id, status: request.status, version: request.status_version } };
    expect((await routing.attemptPushFirst(input)).delivered).toBe(true);
    const first = await mockPg('notifications').where({ recipient_id: property }).first();
    await mockPg('service_requests').where({ id: request.id }).update({ status: 'resolved', status_version: mockPg.raw('status_version + 1') });
    expect(await recheckDeferredReplay('request_app_deferred', meta)).toMatchObject({ eligible: false });
    expect((await routing.attemptPushFirst(input)).blocked).toBe(true);
    expect((await routing.attemptPushFirst({ ...input, notificationEventKey: `request:${request.id}:status-2`,
      requestNotification: { ...input.requestNotification, status: 'resolved', version: 1 } })).delivered).toBe(true);
    const notices = await mockPg('notifications').where({ recipient_id: property });
    expect(notices).toHaveLength(2);
    expect(notices.find((row) => row.id !== first.id).link).not.toBe(first.link);
  });

  test('admin status cycles supersede an earlier matching queued notice without invalidating note edits', async () => {
    await device(); await put({ requestChannel: 'push' });
    const [request] = await mockPg('service_requests').insert({ customer_id: property,
      category: 'general', subject: 'QA status cycle', status: 'new' }).returning('*');
    const patch = async (body) => {
      const response = await fetch(`${baseUrl}/api/admin/requests/${request.id}`, { method: 'PATCH',
        headers: { Authorization: `Bearer ${adminToken}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      expect(response.status).toBe(200);
      return (await response.json()).request;
    };
    const first = await patch({ status: 'acknowledged' });
    expect(first.status_version).toBe(1);
    const meta = { customer_id: property, service_request_id: request.id,
      request_status: first.status, request_status_version: first.status_version };
    const { recheckDeferredReplay } = require('../services/messaging/deferred-replay-registry');
    const notes = await patch({ status: 'acknowledged', adminNotes: 'Assignment confirmed' });
    expect(notes.status_version).toBe(1);
    expect(await recheckDeferredReplay('request_app_deferred', meta)).toEqual({ eligible: true });
    expect((await patch({ status: 'scheduled' })).status_version).toBe(2);
    const latest = await patch({ status: 'acknowledged' });
    expect(latest.status_version).toBe(3);
    expect(await recheckDeferredReplay('request_app_deferred', meta)).toMatchObject({ eligible: false });
    expect(await recheckDeferredReplay('request_app_deferred', { ...meta, request_status_version: 3 })).toEqual({ eligible: true });
    const stale = await require('../services/messaging/push-channel-routing').attemptPushFirst({ customerId: property,
      to: '+19415550101', body: 'Request update', messageType: 'service_request_updated', explicitPushOnly: true,
      notificationEventKey: `request:${request.id}:service_request_updated:1`,
      requestNotification: { id: request.id, status: 'acknowledged', version: 1 } });
    expect(stale.blocked).toBe(true);
    expect(apns.send).not.toHaveBeenCalled();
    const mockSend = jest.spyOn(require('../services/messaging/send-customer-message'), 'sendCustomerMessage').mockResolvedValue({ sent: true });
    try {
      await require('../services/request-app-notifications').send({ customerId: property, request: latest });
      expect(mockSend.mock.calls[0][0].metadata).toMatchObject({ request_status_version: 3,
        notificationEventKey: `request:${request.id}:service_request_updated:3` });
    } finally { mockSend.mockRestore(); }
  });

  test('new choices require readiness and store account channels separately from charged-profile receipts', async () => {
    expect((await put({ enRouteChannel: 'push' })).status).toBe(409);
    await device();
    const response = await put({ enRouteChannel: 'push', paymentConfirmationChannel: 'push', smsEnabled: false, emailEnabled: false });
    expect(response.status).toBe(200);
    expect(response.body.preferences).toMatchObject({ enRouteChannel: 'push', paymentConfirmationChannel: 'push', smsEnabled: false, emailEnabled: false });
    expect(await mockPg('notification_prefs').where({ customer_id: owner }).first()).toMatchObject({ en_route_channel: 'push', payment_receipt_channel: 'sms', sms_enabled: true });
    expect(await mockPg('notification_prefs').where({ customer_id: property }).first()).toMatchObject({ payment_receipt_channel: 'push', sms_enabled: false, email_enabled: false });
    expect((await put({ billingReminderChannel: 'push' })).status).toBe(400);
  });

  test('both reminder choices persist on the primary and survive legacy saves and rollback', async () => {
    const choices = { serviceReminder72hChannel: 'push', serviceReminder24hChannel: 'push' };
    expect((await put(choices)).status).toBe(409);
    await device();
    expect((await put({ ...choices, smsEnabled: false, emailEnabled: false })).body.preferences).toMatchObject(choices);
    expect(await mockPg('notification_prefs').where({ customer_id: owner }).first()).toMatchObject({
      service_reminder_72h_channel: 'push', service_reminder_24h_channel: 'push', service_reminder_72h_channel_explicit: true,
    });
    expect(await mockPg('notification_prefs').where({ customer_id: property }).first()).toMatchObject({
      service_reminder_72h_channel: 'sms', service_reminder_24h_channel: 'sms',
    });
    expect(await require('../services/appointment-reminders')._test.getReminderPrefs(property)).toMatchObject({
      reminder72hChannel: 'push', reminder24hChannel: 'push', smsEnabled: false, emailEnabled: false, unavailable: false,
    });
    expect((await get()).body).toMatchObject(choices);
    const legacyUrl = '/api/notifications/preferences';
    const legacy = await get(legacyUrl);
    expect(legacy.body).toMatchObject({ serviceReminder72hChannel: 'sms', serviceReminder24hChannel: 'sms' });
    expect((await put({ serviceReminder72hChannel: legacy.body.serviceReminder72hChannel,
      serviceReminder24hChannel: legacy.body.serviceReminder24hChannel, weatherAlerts: false }, legacyUrl)).status).toBe(200);
    expect((await get()).body).toMatchObject(choices);
    process.env.GATE_CUSTOMER_APP_NOTIFICATIONS = 'false';
    expect((await put(choices)).status).toBe(400);
    expect((await put({ serviceReminder72hChannel: 'sms', serviceReminder24hChannel: 'sms' })).status).toBe(200);
    expect(await mockPg('notification_prefs').where({ customer_id: owner }).first()).toMatchObject({
      service_reminder_72h_channel: 'push', service_reminder_24h_channel: 'push',
    });
    expect((await get()).body).toMatchObject({ serviceReminder72hChannel: 'sms', serviceReminder24hChannel: 'sms' });
    expect(await require('../services/appointment-reminders')._test.getReminderPrefs(property)).toMatchObject({
      reminder72hChannel: 'push', reminder24hChannel: 'push', smsEnabled: false, emailEnabled: false, unavailable: false,
    });
  });

  // Codex #4303 r6 P1: retrySummaryThroughHandoff and commitRecoveryOnDelivery
  // both lock a notification_prefs row before taking the shared address key.
  // A billing-email save that took the key first would deadlock against
  // either of them; it must take the row first, like they do.
  test('a billing-email save cannot deadlock against a row-then-key writer holding the same address', async () => {
    const billingEmail = `qa-billing-${randomUUID()}@example.com`;
    const { lockCustomerEmail } = require('../utils/customer-comms-lock');
    const writer = mockPg.transaction(async (trx) => {
      await trx('notification_prefs').where({ customer_id: property }).forUpdate().first('customer_id');
      await new Promise((resolve) => setTimeout(resolve, 300));
      await lockCustomerEmail(trx, billingEmail);
      await trx('notification_prefs').where({ customer_id: property }).update({ updated_at: trx.fn.now() });
      return 'committed';
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    const response = await put({ billingEmail });
    await expect(writer).resolves.toBe('committed');
    expect(response.status).toBe(200);
    expect(await mockPg('notification_prefs').where({ customer_id: property }).first()).toMatchObject({ billing_email: billingEmail });
  });

  test('invoice App choice belongs to the charged profile and survives old-client saves', async () => {
    expect((await put({ invoiceChannel: 'push' })).status).toBe(409);
    await device();
    expect((await put({ invoiceChannel: 'push', smsEnabled: false })).body.preferences).toMatchObject({ invoiceChannel: 'push' });
    expect(await mockPg('notification_prefs').where({ customer_id: property }).first()).toMatchObject({ invoice_channel: 'push', sms_enabled: false });
    expect(await mockPg('notification_prefs').where({ customer_id: owner }).first()).toMatchObject({ invoice_channel: 'sms' });
    expect((await put({ invoiceChannel: 'sms' }, '/api/notifications/preferences')).status).toBe(200);
    expect((await get()).body.invoiceChannel).toBe('push');
    process.env.GATE_CUSTOMER_APP_NOTIFICATIONS = 'false';
    expect((await get()).body.invoiceChannel).toBeUndefined();
    expect((await put({ invoiceChannel: 'push' })).status).toBe(400);
    expect((await put({ invoiceChannel: 'sms' })).status).toBe(200);
    expect((await mockPg('notification_prefs').where({ customer_id: property }).first()).invoice_channel).toBe('push');
  });

  test('invoice push opens its authorized invoice and deduplicates a retry but not the next follow-up', async () => {
    await device();
    await put({ invoiceChannel: 'push' });
    const invoiceId = randomUUID();
    const invoiceToken = randomUUID();
    await mockPg('invoices').insert({ id: invoiceId, customer_id: property, token: invoiceToken, invoice_number: 'QA-INVOICE', status: 'sent' });
    const routing = require('../services/messaging/push-channel-routing');
    const notice = { customerId: property, to: '+19415550101', body: 'Your invoice is ready.',
      messageType: 'invoice_followup', explicitPushOnly: true, invoiceId, notificationEventKey: `qa:${invoiceId}:day3` };
    expect(await routing.attemptPushFirst(notice)).toMatchObject({ delivered: true });
    expect(await routing.attemptPushFirst(notice)).toMatchObject({ delivered: true });
    expect(apns.send).toHaveBeenCalledTimes(1);
    expect(await mockPg('notifications').first()).toMatchObject({ link: `/pay/${invoiceToken}`, title: 'Invoice reminder' });
    expect(await routing.attemptPushFirst({ ...notice, notificationEventKey: `qa:${invoiceId}:day7` })).toMatchObject({ delivered: true });
    expect(apns.send).toHaveBeenCalledTimes(2);
    expect((await mockPg('sms_log').where({ from_phone: 'push', status: 'sent' })).length).toBe(2);
  });

  test('payment problems preserves charged-profile ownership and legacy companion vetoes', async () => {
    const routing = require('../services/messaging/push-channel-routing');
    await mockPg('notification_prefs').where({ customer_id: property }).update({ billing_channel: 'email' });
    expect(await routing._test.pushEligibleRuntime(property, '+19415550101', 'autopay_charge_failed')).toBe(false);
    expect((await put({ paymentIssueChannel: 'push' })).status).toBe(409);
    await device();
    expect((await put({ paymentIssueChannel: 'push', smsEnabled: false })).status).toBe(200);
    expect((await mockPg('notification_prefs').where({ customer_id: owner }).first()).payment_issue_channel).toBeNull();
    const notice = { customerId: property, to: '+19415550101', body: 'Please update your payment method.',
      messageType: 'autopay_charge_failed', explicitPushOnly: true, notificationEventKey: 'qa:payment:attempt1' };
    expect(await routing.attemptPushFirst(notice)).toMatchObject({ delivered: true });
    expect(await routing.attemptPushFirst(notice)).toMatchObject({ delivered: true });
    expect(apns.send).toHaveBeenCalledTimes(1);
    expect(await mockPg('notifications').first()).toMatchObject({ link: '/?tab=billing&focus=payment-methods' });
    expect(await routing.attemptPushFirst({ ...notice, notificationEventKey: 'qa:payment:attempt2' })).toMatchObject({ delivered: true });
    expect(apns.send).toHaveBeenCalledTimes(2);
    await put({ paymentIssueChannel: 'sms' }, '/api/notifications/preferences');
    expect((await get()).body.paymentIssueChannel).toBe('push');
    await put({ paymentIssueChannel: 'sms' });
    expect(await routing._test.pushEligibleRuntime(property, '+19415550101', 'autopay_charge_failed')).toBe(false);
    await put({ paymentIssueChannel: 'push' });
    process.env.GATE_CUSTOMER_APP_NOTIFICATIONS = 'false';
    expect((await put({ paymentIssueChannel: 'push' })).status).toBe(400);
    await put({ paymentIssueChannel: 'sms' });
    expect((await mockPg('notification_prefs').where({ customer_id: property }).first()).payment_issue_channel).toBe('push');
  });

  test.each(['payer', 'wrong_customer', 'paid', 'void', 'processing'])('invoice App delivery excludes %s invoices', async (kind) => {
    await device();
    await put({ invoiceChannel: 'push' });
    const invoiceId = randomUUID();
    await mockPg('invoices').insert({ id: invoiceId, customer_id: kind === 'wrong_customer' ? outsider : property,
      payer_id: kind === 'payer' ? 999997 : null, token: randomUUID(), invoice_number: 'QA-EXCLUDED',
      status: ['paid', 'void', 'processing'].includes(kind) ? kind : 'sent' });
    expect(await require('../services/messaging/push-channel-routing').attemptPushFirst({
      customerId: property, to: '+19415550101', body: 'Your invoice is ready.', messageType: 'invoice',
      explicitPushOnly: true, invoiceId, notificationEventKey: `qa:${invoiceId}`,
    })).toMatchObject({ delivered: false, reason: 'invoice_unavailable' });
    expect(apns.send).not.toHaveBeenCalled();
    expect(await mockPg('notifications')).toHaveLength(0);
  });

  test.each(['customer', 'visit', 'self_pay_override'])('invoice App guard resolves the live %s payer context', async (kind) => {
    await device();
    await put({ invoiceChannel: 'push' });
    await mockPg('payers').insert({ id: 999996, display_name: 'QA Payer', active: true });
    const visitId = randomUUID();
    const invoiceId = randomUUID();
    await mockPg('customers').where({ id: property }).update({ payer_id: kind === 'visit' ? null : 999996 });
    await mockPg('scheduled_services').insert({ id: visitId, customer_id: property,
      scheduled_date: '2026-09-09', service_type: 'Pest Control', payer_id: kind === 'visit' ? 999996 : null,
      self_pay_override: kind === 'self_pay_override' });
    await mockPg('invoices').insert({ id: invoiceId, customer_id: property, scheduled_service_id: visitId,
      token: randomUUID(), invoice_number: 'QA-LIVE-PAYER', status: 'sent' });
    const result = await require('../services/messaging/push-channel-routing').attemptPushFirst({
      customerId: property, to: '+19415550101', body: 'Your invoice is ready.', messageType: 'invoice',
      explicitPushOnly: true, invoiceId, notificationEventKey: `qa:${invoiceId}`,
    });
    expect(result.delivered).toBe(kind === 'self_pay_override');
    expect(apns.send).toHaveBeenCalledTimes(kind === 'self_pay_override' ? 1 : 0);
  });

  test.each([['invoices', 'token'], ['customers', 'payer_id']])('a failed %s guard lookup defers without any notification', async (table, column) => {
    await device();
    await put({ invoiceChannel: 'push' });
    const invoiceId = randomUUID();
    await mockPg('invoices').insert({ id: invoiceId, customer_id: property, token: randomUUID(), invoice_number: 'QA-LOOKUP', status: 'sent' });
    await mockPg.schema.alterTable(table, t => t.renameColumn(column, `qa_${column}`));
    try {
      expect(await require('../services/messaging/push-channel-routing').attemptPushFirst({
        customerId: property, to: '+19415550101', body: 'Your invoice is ready.', messageType: 'invoice',
        explicitPushOnly: true, invoiceId, notificationEventKey: `qa:${invoiceId}`,
      })).toMatchObject({ delivered: false, retryable: true, deliveryOutcome: 'not_sent', reason: 'invoice_lookup_failed' });
      expect(apns.send).not.toHaveBeenCalled();
      expect(await mockPg('notifications')).toHaveLength(0);
    } finally {
      await mockPg.schema.alterTable(table, t => t.renameColumn(`qa_${column}`, column));
    }
  });

  test('older clients and a gate rollback preserve saved App first values', async () => {
    await device();
    expect((await put({ enRouteChannel: 'push', paymentConfirmationChannel: 'push' })).status).toBe(200);
    const legacy = await get('/api/notifications/preferences');
    expect(legacy.body.enRouteChannel).toBe('sms');
    expect(legacy.body.appPreferencesAvailable).toBeUndefined();
    expect((await put({ enRouteChannel: 'sms', paymentConfirmationChannel: 'sms', weatherAlerts: false }, '/api/notifications/preferences')).status).toBe(200);
    expect((await get()).body).toMatchObject({ enRouteChannel: 'push', paymentConfirmationChannel: 'push', weatherAlerts: false });
    process.env.GATE_CUSTOMER_APP_NOTIFICATIONS = 'false';
    expect((await put({ pushEnabled: false })).status).toBe(400);
    expect((await put({ enRouteChannel: 'sms', seasonalTips: false })).status).toBe(200);
    expect((await mockPg('notification_prefs').where({ customer_id: owner }).first()).en_route_channel).toBe('push');
  });

  test('stale devices do not authorize a new choice, but keep existing choices editable', async () => {
    await device(owner, 'ios', { updated_at: new Date(Date.now() - 73 * 3600000) });
    expect((await get('/api/push/status')).body).toMatchObject({ registered: true, fresh: false });
    expect((await put({ enRouteChannel: 'push' })).status).toBe(409);
    await mockPg('notification_prefs').where({ customer_id: owner }).update({ en_route_channel: 'push' });
    expect((await put({ enRouteChannel: 'push', weatherAlerts: false })).status).toBe(200);
  });

  test('the deployed legacy endpoint hides App first and preserves it on a full preference round trip', async () => {
    await mockPg('notification_prefs').where({ customer_id: property }).update({
      en_route_channel: 'push', service_complete_channel: 'push', payment_receipt_channel: 'push',
    });
    const legacy = await get('/api/notification-prefs');
    expect(legacy.body).toMatchObject({ enRouteChannel: 'sms', serviceCompleteChannel: 'sms', paymentReceiptChannel: 'sms' });
    expect((await put({ ...legacy.body, weatherAlerts: false }, '/api/notification-prefs')).status).toBe(200);
    expect(await mockPg('notification_prefs').where({ customer_id: property }).first()).toMatchObject({
      en_route_channel: 'push', service_complete_channel: 'push', payment_receipt_channel: 'push', weather_alerts: false,
    });
  });

  test('global push off persists the bell and remains effective during rollback', async () => {
    await device();
    expect((await put({ pushEnabled: false })).status).toBe(200);
    process.env.GATE_CUSTOMER_APP_NOTIFICATIONS = 'false';
    const notification = await Notifications.notifyCustomer(property, 'service', 'QA update', 'Fixture', { dedupeKey: 'qa-off', awaitPush: true });
    expect(notification.id).toBeTruthy();
    expect(notification.push).toMatchObject({ accepted: 0, reason: 'push_disabled' });
    expect(apns.send).not.toHaveBeenCalled();
    expect(await mockPg('notifications').where({ recipient_id: property }).count('* as count').first()).toEqual({ count: '1' });
  });

  test('mixed device outcomes retain acceptance and bind the destination to the authorized property', async () => {
    await device(owner);
    await device(property, 'android');
    await device(outsider);
    fcm.send.mockRejectedValue(new Error('fixture network failure'));
    const result = await Push.sendToCustomer(property, { title: 'QA update', url: '/?tab=visits' });
    expect(result).toMatchObject({ subscriptions: 2, sent: 1, failed: 1 });
    expect(apns.send).toHaveBeenCalledTimes(1);
    expect(apns.send.mock.calls[0][1].url).toBe(`/?tab=visits&notificationProperty=${property}`);
  });

  test('an expired token is deactivated and a failed event can retry once', async () => {
    const sub = await device();
    apns.send.mockResolvedValueOnce({ ok: false, expired: true, reason: 'Unregistered' });
    const first = await Notifications.notifyCustomer(property, 'service', 'QA update', 'Fixture', { dedupeKey: 'qa-retry', awaitPush: true });
    expect(first.push.accepted).toBe(0);
    expect((await mockPg('push_subscriptions').where({ id: sub.id }).first()).active).toBe(false);
    await device();
    const second = await Notifications.notifyCustomer(property, 'service', 'QA update', 'Fixture', { dedupeKey: 'qa-retry', awaitPush: true });
    expect(second.id).toBe(first.id);
    expect(second.push.accepted).toBe(1);
    const third = await Notifications.notifyCustomer(property, 'service', 'QA update', 'Fixture', { dedupeKey: 'qa-retry', awaitPush: true });
    expect(third.push).toMatchObject({ accepted: 1, deduped: true });
    await mockPg('notification_prefs').where({ customer_id: owner }).update({ push_enabled: false });
    const afterOptOut = await Notifications.notifyCustomer(property, 'service', 'QA update', 'Fixture', { dedupeKey: 'qa-retry', awaitPush: true });
    expect(afterOptOut.push).toMatchObject({ accepted: 1, deduped: true });
    expect(apns.send).toHaveBeenCalledTimes(2);
  });

  test('two concurrent emitters persist one bell and hand the event to a provider once', async () => {
    await device();
    let release;
    let started;
    const entered = new Promise((resolve) => { started = resolve; });
    apns.send.mockImplementation(() => { started(); return new Promise((resolve) => { release = resolve; }); });
    const first = Notifications.notifyCustomer(property, 'service', 'QA update', 'Fixture', { dedupeKey: 'qa-race', awaitPush: true });
    await entered;
    const second = await Notifications.notifyCustomer(property, 'service', 'QA update', 'Fixture', { dedupeKey: 'qa-race', awaitPush: true });
    expect(second.push).toMatchObject({ accepted: 0, deduped: true, reason: 'push_in_flight' });
    release({ ok: true });
    expect((await first).push.accepted).toBe(1);
    expect(apns.send).toHaveBeenCalledTimes(1);
    expect((await mockPg('notifications').count('* as count').first()).count).toBe('1');
  });

  test.each([true, false])('an abandoned claim recovers with an explicit lease: %s', async (hasLease) => {
    await device();
    const bell = await Notifications.notifyCustomer(property, 'service', 'QA update', 'Fixture', { dedupeKey: 'qa-abandoned', push: false });
    await mockPg('notifications').where({ id: bell.id }).update({ metadata: {
      ...bell.metadata,
      pushState: 'sending', pushAttemptToken: 'abandoned',
      pushAttemptedAt: new Date(Date.now() - 11 * 60000).toISOString(),
      ...(hasLease ? { pushLeaseUntil: new Date(Date.now() - 60000).toISOString() } : {}),
    } });
    const retry = await Notifications.notifyCustomer(property, 'service', 'QA update', 'Fixture', { dedupeKey: 'qa-abandoned', awaitPush: true });
    expect(retry.id).toBe(bell.id);
    expect(retry.push.accepted).toBe(1);
    expect(apns.send).toHaveBeenCalledTimes(1);
    expect((await mockPg('notifications').where({ id: bell.id }).first()).metadata).toMatchObject({ pushState: 'accepted' });
  });

  test('a resumed old worker cannot hand off a device or overwrite a newer claim', async () => {
    await device();
    const bell = await Notifications.notifyCustomer(property, 'service', 'QA update', 'Fixture', { dedupeKey: 'qa-owner-change', push: false });
    const result = await Push.sendToCustomer(property, { title: 'QA update' }, {
      notificationId: bell.id,
      shouldContinue: async () => {
        await mockPg('notifications').where({ id: bell.id }).update({ metadata: {
          pushState: 'sending', pushAttemptToken: 'newer-worker',
          pushLeaseUntil: new Date(Date.now() + 120000).toISOString(),
        } });
        return true;
      },
    });
    expect(result).toMatchObject({ sent: 0, reason: 'push_in_flight' });
    expect(apns.send).not.toHaveBeenCalled();
    expect((await mockPg('notifications').where({ id: bell.id }).first()).metadata.pushAttemptToken).toBe('newer-worker');
  });

  test('provider acceptance is durable before the next device handoff', async () => {
    await device(owner);
    await device(property, 'android');
    const bell = await Notifications.notifyCustomer(property, 'service', 'QA update', 'Fixture', { dedupeKey: 'qa-fanout-acceptance', push: false });
    let checks = 0;
    const result = await Push.sendToCustomer(property, { title: 'QA update' }, {
      notificationId: bell.id,
      shouldContinue: async () => {
        if (++checks === 2) expect((await mockPg('notifications').where({ id: bell.id }).first()).metadata.pushState).toBe('accepted');
        return true;
      },
    });
    expect(checks).toBe(2);
    expect(result.sent).toBe(2);
  });

  test('request choices record provenance only on the selected profile, not a default round trip', async () => {
    await put({ requestChannel: 'email', weatherAlerts: false });
    expect(await mockPg('notification_prefs').where({ customer_id: property }).first())
      .toMatchObject({ request_channel: 'email', request_channel_explicit: false });
    await device();
    expect((await put({ requestChannel: 'push' })).status).toBe(200);
    expect(await mockPg('notification_prefs').where({ customer_id: property }).first())
      .toMatchObject({ request_channel: 'push', request_channel_explicit: true });
    expect(await mockPg('notification_prefs').where({ customer_id: owner }).first())
      .toMatchObject({ request_channel: 'email', request_channel_explicit: false });
    expect((await put({ requestChannel: 'email' })).status).toBe(200);
    expect(await mockPg('notification_prefs').where({ customer_id: property }).first())
      .toMatchObject({ request_channel: 'email', request_channel_explicit: true });
    await put({ weatherAlerts: true });
    expect((await mockPg('notification_prefs').where({ customer_id: property }).first()).request_channel_explicit).toBe(true);
  });

  test('legacy and gate-off saves preserve unknown request provenance with the App choice', async () => {
    await mockPg('notification_prefs').where({ customer_id: property })
      .update({ request_channel: 'push', request_channel_explicit: null });
    expect((await http('PUT', '/api/notifications/preferences', { requestChannel: 'email' })).status).toBe(200);
    delete process.env.GATE_CUSTOMER_APP_NOTIFICATIONS;
    expect((await put({ requestChannel: 'email' })).status).toBe(200);
    expect(await mockPg('notification_prefs').where({ customer_id: property }).first())
      .toMatchObject({ request_channel: 'push', request_channel_explicit: null });
  });
});
