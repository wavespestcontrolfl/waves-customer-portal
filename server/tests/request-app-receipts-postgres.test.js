// Real transaction boundaries with synthetic customers and mocked deliveries.
process.env.JWT_SECRET = process.env.JWT_SECRET || 'qa-request-app-receipts-only';
jest.mock('../models/db', () => {
  const db = (...args) => mockPg(...args);
  db.transaction = (...args) => mockPg.transaction(...args);
  db.raw = (...args) => mockPg.raw(...args);
  Object.defineProperty(db, 'fn', { get: () => mockPg.fn });
  return db;
});
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/notification-service', () => ({ notifyAdmin: jest.fn(async () => ({ id: 'qa-alert' })) }));
jest.mock('../services/twilio', () => ({ sendSMS: jest.fn(async () => ({ sent: true })) }));
jest.mock('../services/messaging/send-customer-message', () => ({ sendCustomerMessage: jest.fn() }));
jest.mock('../services/sms-template-renderer', () => ({ renderRequiredSmsTemplate: jest.fn(async () => 'QA confirmation') }));
jest.mock('../services/estimate-card-holds', () => ({ handleCardHoldCancellation: jest.fn(async () => ({})) }));
jest.mock('../services/visit-groups', () => ({ handleChildStopChanged: jest.fn(async () => ({})) }));
jest.mock('../config/twilio-numbers', () => ({ getOutboundNumber: () => '+19415550199' }));

const { randomUUID } = require('node:crypto');
const express = require('express');
const { sendCustomerMessage } = require('../services/messaging/send-customer-message');
const { generateToken } = require('../middleware/auth');
const { gates } = require('../config/feature-gates');
const { recheckDeferredReplay } = require('../services/messaging/deferred-replay-registry');
const connection = process.env.APP_TEST_DATABASE_URL;
const postgres = connection ? describe : describe.skip;
const schema = `request_receipts_${randomUUID().replaceAll('-', '')}`;
const customerId = randomUUID();
const outsiderId = randomUUID();
const serviceId = randomUUID();
const gateNames = ['GATE_CUSTOMER_APP_NOTIFICATIONS', 'GATE_RESERVICE_STREAMLINE', 'GATE_RESERVICE_SELF_SERVE'];
const originalGates = { reserviceStreamline: gates.reserviceStreamline, reserviceSelfServe: gates.reserviceSelfServe };
let mockPg;
let observer;
let admin;
let server;
let baseUrl;
let committed;
let appOutcome;
let appFailure;
jest.setTimeout(30000);

postgres('portal request App receipts (PostgreSQL)', () => {
  beforeAll(async () => {
    const target = new URL(connection);
    const privateQa = /^\/waves_qa_[a-f0-9]{32}$/.test(target.pathname);
    const ci = process.env.CI === 'true' && target.hostname === 'localhost' && target.pathname === '/waves_test';
    if (!privateQa && !ci) throw new Error('Use a verified private QA database or the isolated CI database');
    admin = require('knex')({ client: 'pg', connection, pool: { min: 0, max: 1 } });
    await admin.schema.createSchema(schema);
    mockPg = require('knex')({ client: 'pg', connection, searchPath: [schema], pool: { min: 0, max: 4 } });
    observer = require('knex')({ client: 'pg', connection, searchPath: [schema], pool: { min: 0, max: 1 } });
    for (const table of ['customers', 'notification_prefs', 'scheduled_services', 'service_requests', 'service_records', 'sms_log']) {
      await mockPg.raw('CREATE TABLE ?? (LIKE ?? INCLUDING ALL)', [table, `public.${table}`]);
    }
    await mockPg('customers').insert([customerId, outsiderId].map((id, i) => ({
      id, account_id: id, first_name: 'QA', last_name: 'Fixture', active: true,
      phone: `+1941555010${i}`, email: `qa-receipts-${i}@example.invalid`,
    })));
    const app = express();
    app.use(express.json());
    app.use('/api/schedule', require('../routes/schedule'));
    app.use('/api/promotions', require('../routes/promotions'));
    app.use((err, req, res, next) => res.status(err.isJoi ? 400 : 500).json({ error: err.message }));
    server = await new Promise((resolve) => { const listener = app.listen(0, '127.0.0.1', () => resolve(listener)); });
    baseUrl = `http://127.0.0.1:${server.address().port}`;
  }, 60000);
  afterAll(async () => {
    for (const gate of gateNames) delete process.env[gate];
    Object.assign(gates, originalGates);
    if (server) await new Promise((resolve) => server.close(resolve));
    await observer?.destroy();
    await mockPg?.destroy();
    if (admin) { await admin.schema.dropSchemaIfExists(schema, true); await admin.destroy(); }
  });
  beforeEach(async () => {
    jest.clearAllMocks();
    for (const gate of gateNames) process.env[gate] = 'true';
    gates.reserviceStreamline = true;
    gates.reserviceSelfServe = true;
    for (const table of ['sms_log', 'service_requests', 'scheduled_services', 'notification_prefs']) await mockPg(table).del();
    await mockPg('notification_prefs').insert({ customer_id: customerId, request_channel: 'push' });
    await mockPg('scheduled_services').insert({ id: serviceId, customer_id: customerId, status: 'confirmed',
      service_type: 'Pest Control', scheduled_date: new Date(Date.now() + 7 * 86400000).toISOString().slice(0, 10) });
    committed = [];
    appOutcome = { sent: true };
    appFailure = false;
    sendCustomerMessage.mockImplementation(async (input) => {
      if (!input.metadata?.appOnly) return { sent: true };
      // A separate connection cannot see a receipt's request until COMMIT.
      committed.push(!!(await observer('service_requests').where({ id: input.metadata.service_request_id }).first()));
      if (appFailure) throw new Error('Synthetic delivery failure');
      return appOutcome;
    });
  });

  const receipts = () => sendCustomerMessage.mock.calls.map(([input]) => input).filter((input) => input.metadata?.appOnly);
  async function submit(kind, body, owner = customerId) {
    const url = kind === 'reschedule' ? `/api/schedule/${serviceId}/reschedule` : '/api/promotions/qa-promotion/interest';
    const response = await fetch(baseUrl + url, { method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${generateToken(owner, owner)}` },
      body: JSON.stringify(body || (kind === 'reschedule' ? { notes: 'QA requested date change' } : { serviceType: 'mosquito' })),
    });
    return { status: response.status, body: await response.json() };
  }

  test.each(['reschedule', 'promotion'])('%s delivers the new request only after commit', async (kind) => {
    expect((await submit(kind)).status).toBe(200);
    const request = await mockPg('service_requests').first();
    expect(request).toMatchObject({ customer_id: customerId, status: 'new', status_version: 0 });
    expect(committed).toEqual([true]);
    expect(receipts()).toHaveLength(1);
    expect(receipts()[0]).toMatchObject({ customerId, customerInitiated: true, purpose: 'support_resolution',
      metadata: { appOnly: true, original_message_type: 'service_request_received', service_request_id: request.id,
        request_status_version: 0, notificationEventKey: `request:${request.id}:service_request_received:0` } });
    if (kind === 'promotion') expect(sendCustomerMessage.mock.calls.filter(([input]) => input.entryPoint === 'promotions_upsell_interest')).toHaveLength(1);
  });

  test('concurrent reschedule submissions share one receipt and retain the revised intent', async () => {
    const responses = await Promise.all([submit('reschedule', { notes: 'QA first preference' }), submit('reschedule', { notes: 'QA second preference' })]);
    expect(responses.map((response) => response.status)).toEqual([200, 200]);
    const requests = await mockPg('service_requests');
    expect(requests).toHaveLength(1);
    expect(requests[0].description).toContain('QA first preference');
    expect(requests[0].description).toContain('QA second preference');
    expect(receipts()).toHaveLength(1);
    expect(committed).toEqual([true]);
    expect(await mockPg('scheduled_services').where({ id: serviceId }).first()).toMatchObject({ status: 'confirmed' });
  });

  test('legacy rescheduling sends once and a repeat cannot create another request', async () => {
    gates.reserviceStreamline = false;
    expect((await submit('reschedule')).status).toBe(200);
    expect((await submit('reschedule')).status).toBe(404);
    expect(receipts()).toHaveLength(1);
    expect(await mockPg('scheduled_services').where({ id: serviceId }).first()).toMatchObject({ status: 'rescheduled' });
  });

  test('a rolled-back request emits no receipt and leaves the appointment intact', async () => {
    await mockPg.raw('ALTER TABLE ?? ADD CONSTRAINT qa_reject_request CHECK (false)', ['service_requests']);
    try {
      expect((await submit('reschedule')).status).toBe(500);
      expect(await mockPg('service_requests')).toHaveLength(0);
      expect(await mockPg('scheduled_services').where({ id: serviceId }).first()).toMatchObject({ status: 'confirmed', notes: null });
      expect(receipts()).toHaveLength(0);
    } finally { await mockPg.raw('ALTER TABLE ?? DROP CONSTRAINT qa_reject_request', ['service_requests']); }
  });

  test('another profile cannot request a reschedule or receive its receipt', async () => {
    expect((await submit('reschedule', undefined, outsiderId)).status).toBe(404);
    expect(await mockPg('service_requests')).toHaveLength(0);
    expect(receipts()).toHaveLength(0);
  });

  test.each(['reschedule', 'promotion'])('%s holds delivery on the existing App-only replay rail', async (kind) => {
    appOutcome = { sent: false, deferred: true, code: 'APP_DELIVERY_HOLD', nextAllowedAt: new Date(Date.now() + 60000) };
    expect((await submit(kind)).status).toBe(200);
    const queued = await mockPg('sms_log').where({ status: 'scheduled' });
    expect(queued).toHaveLength(1);
    expect(queued[0].metadata).toMatchObject({ appOnly: true, customer_initiated: true, customer_id: customerId,
      entry_point: 'request_app_deferred', notificationEventKey: receipts()[0].metadata.notificationEventKey });
    expect(await recheckDeferredReplay('request_app_deferred', queued[0].metadata)).toEqual({ eligible: true });
  });

  test.each(['reschedule', 'promotion'])('%s remains successful when App dispatch throws', async (kind) => {
    appFailure = true;
    expect((await submit(kind)).status).toBe(200);
    expect(await mockPg('service_requests')).toHaveLength(1);
    expect(committed).toEqual([true]);
  });

  test.each(['email', 'gate'])('respects the existing %s suppression', async (kind) => {
    if (kind === 'email') await mockPg('notification_prefs').where({ customer_id: customerId }).update({ request_channel: 'email' });
    else delete process.env.GATE_CUSTOMER_APP_NOTIFICATIONS;
    expect((await submit('reschedule')).status).toBe(200);
    expect((await submit('promotion')).status).toBe(200);
    expect(receipts()).toHaveLength(0);
  });
});
