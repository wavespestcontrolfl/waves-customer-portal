// Opt-in against a verified private QA database. Clone the migrated table
// shapes into a disposable schema; all recipients and providers are fictional.
jest.mock('../models/db', () => {
  const db = (...args) => mockPg(...args);
  db.raw = (...args) => mockPg.raw(...args);
  db.transaction = (...args) => mockPg.transaction(...args);
  Object.defineProperty(db, 'fn', { get: () => mockPg.fn });
  return db;
});
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/account-membership-email', () => ({ sendAccountUpdated: jest.fn(async () => ({})) }));
jest.mock('../services/apns', () => ({ send: jest.fn(), status: () => ({ configured: true }) }));
jest.mock('../services/fcm', () => ({ send: jest.fn(), status: () => ({ configured: true }) }));

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
let server;
let baseUrl;
jest.setTimeout(30000);

postgres('customer app preferences and push ledger (PostgreSQL)', () => {
  beforeAll(async () => {
    if (!/^\/waves_qa_[a-f0-9]{32}$/.test(new URL(connection).pathname)) throw new Error('Use a verified private QA database');
    admin = require('knex')({ client: 'pg', connection, pool: { min: 0, max: 1 } });
    await admin.schema.createSchema(schema);
    mockPg = require('knex')({ client: 'pg', connection, searchPath: [schema], pool: { min: 0, max: 4 } });
    for (const table of ['customers', 'notification_prefs', 'notifications', 'push_subscriptions']) {
      await mockPg.raw('CREATE TABLE ?? (LIKE ?? INCLUDING ALL)', [table, `public.${table}`]);
    }
    expect(await mockPg.schema.hasColumn('notification_prefs', 'push_enabled')).toBe(true);
    await mockPg('customers').insert([
      { id: owner, account_id: owner, is_primary_profile: true },
      { id: property, account_id: owner, is_primary_profile: false },
      { id: outsider, account_id: outsider, is_primary_profile: true },
    ].map((row, i) => ({ ...row, first_name: 'QA', last_name: 'Fixture', active: true,
      phone: `+1941555010${i}`, email: `qa-app-${i}@example.invalid` })));
    app = express();
    app.use(express.json());
    app.use('/api/notifications', require('../routes/notifications'));
    app.use('/api/push', require('../routes/push'));
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
    await mockPg('notification_prefs').insert([owner, property, outsider].map((id) => ({ customer_id: id })));
    apns.send.mockResolvedValue({ ok: true });
    fcm.send.mockResolvedValue({ ok: true });
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

  test('readiness authenticates and returns no device identifiers', async () => {
    expect((await http('GET', '/api/push/status', null, false)).status).toBe(401);
    await device(outsider);
    expect((await get('/api/push/status')).body).toEqual({ available: true, enabled: true, registered: false, fresh: false });
    await device(owner);
    const status = await get('/api/push/status');
    expect(status.headers['cache-control']).toBe('no-store');
    expect(status.body).toEqual({ available: true, enabled: true, registered: true, fresh: true });
  });

  test('new choices require readiness and store account channels separately from charged-profile receipts', async () => {
    expect((await put({ enRouteChannel: 'push' })).status).toBe(409);
    await device();
    const response = await put({ enRouteChannel: 'push', paymentConfirmationChannel: 'push', smsEnabled: false, emailEnabled: false });
    expect(response.status).toBe(200);
    expect(response.body.preferences).toMatchObject({ enRouteChannel: 'push', paymentConfirmationChannel: 'push', smsEnabled: false, emailEnabled: false });
    expect(await mockPg('notification_prefs').where({ customer_id: owner }).first()).toMatchObject({ en_route_channel: 'push', payment_receipt_channel: 'sms', sms_enabled: true });
    expect(await mockPg('notification_prefs').where({ customer_id: property }).first()).toMatchObject({ payment_receipt_channel: 'push', sms_enabled: false, email_enabled: false });
    expect((await put({ serviceReminder24hChannel: 'push' })).status).toBe(400);
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

  test('global push off persists the bell and remains effective during rollback', async () => {
    await device();
    expect((await put({ pushEnabled: false })).status).toBe(200);
    process.env.GATE_CUSTOMER_APP_NOTIFICATIONS = 'false';
    const notification = await Notifications.notifyCustomer(property, 'service', 'QA update', 'Fixture', { dedupeKey: 'qa-off', awaitPush: true });
    expect(notification.id).toBeTruthy();
    expect(notification.push).toMatchObject({ accepted: false, reason: 'push_disabled' });
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
    expect(first.push.accepted).toBe(false);
    expect((await mockPg('push_subscriptions').where({ id: sub.id }).first()).active).toBe(false);
    await device();
    const second = await Notifications.notifyCustomer(property, 'service', 'QA update', 'Fixture', { dedupeKey: 'qa-retry', awaitPush: true });
    expect(second.id).toBe(first.id);
    expect(second.push.accepted).toBe(true);
    const third = await Notifications.notifyCustomer(property, 'service', 'QA update', 'Fixture', { dedupeKey: 'qa-retry', awaitPush: true });
    expect(third.push).toMatchObject({ accepted: true, deduped: true });
    await mockPg('notification_prefs').where({ customer_id: owner }).update({ push_enabled: false });
    const afterOptOut = await Notifications.notifyCustomer(property, 'service', 'QA update', 'Fixture', { dedupeKey: 'qa-retry', awaitPush: true });
    expect(afterOptOut.push).toMatchObject({ accepted: true, deduped: true });
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
    expect(second.push).toMatchObject({ accepted: false, deduped: true, reason: 'push_in_flight' });
    release({ ok: true });
    expect((await first).push.accepted).toBe(true);
    expect(apns.send).toHaveBeenCalledTimes(1);
    expect((await mockPg('notifications').count('* as count').first()).count).toBe('1');
  });
});
