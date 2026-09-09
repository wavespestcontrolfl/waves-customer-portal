// Real HTTP/auth/SQL against an isolated schema of a verified test database.
// CI's existing DB-test sweep selects this suite via the SKIP convention below.
const SKIP = !process.env.DATABASE_URL;
jest.mock('../models/db', () => {
  const db = (...args) => mockPg(...args);
  db.transaction = (...args) => mockPg.transaction(...args);
  db.raw = (...args) => mockPg.raw(...args);
  return db;
});
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/push-notifications', () => ({ sendToCustomer: jest.fn(), sendToAdminUser: jest.fn() }));
jest.mock('../services/dashboard-alerts', () => ({ computeDashboardAlerts: jest.fn() }));
jest.mock('../services/admin-unread', () => ({}));
const { randomUUID } = require('node:crypto');
const express = require('express');
const jwt = require('jsonwebtoken');
const config = require('../config');
const { generateToken } = require('../middleware/auth');
const Push = require('../services/push-notifications');
const Notifications = require('../services/notification-service');
const schema = `inbox_test_${randomUUID().replaceAll('-', '')}`;
const adminId = randomUUID();
const techId = randomUUID();
const action = 'customer.notification_inbox_test.created';
let mockPg;
let database;
let server;
let base;
let customerId;
let customerToken;
let adminToken;
let techToken;
let fixtureIndex = 0;
const originalEnv = Object.fromEntries(['GATE_CUSTOMER_INBOX_TEST', 'CUSTOMER_INBOX_TEST_CUSTOMER_ID', 'GATE_CUSTOMER_NATIVE_BADGES'].map(key => [key, process.env[key]]));
jest.setTimeout(30000);

(SKIP ? describe.skip : describe)('owner-only inbox test (PostgreSQL)', () => {
  beforeAll(async () => {
    const connection = process.env.DATABASE_URL;
    const url = new URL(connection);
    const ci = ['localhost', '127.0.0.1'].includes(url.hostname) && url.pathname === '/waves_test';
    if (!ci && !/^\/waves_qa_[a-f0-9]{32}$/.test(url.pathname)) throw new Error('Use a verified private dev/QA database');
    database = require('knex')({ client: 'pg', connection, pool: { min: 0, max: 1 } });
    await database.schema.createSchema(schema);
    mockPg = require('knex')({ client: 'pg', connection, searchPath: [schema], pool: { min: 0, max: 6 } });
    for (const table of ['customers', 'technicians', 'notifications', 'audit_log']) {
      await mockPg.raw('CREATE TABLE ?? (LIKE ?? INCLUDING ALL)', [table, `public.${table}`]);
    }
    await mockPg('technicians').insert([
      { id: adminId, name: 'QA Admin', role: 'admin', email: 'qa-inbox-admin@example.invalid' },
      { id: techId, name: 'QA Tech', role: 'technician', email: 'qa-inbox-tech@example.invalid' },
    ].map(row => ({ ...row, active: true, employment_status: 'active', auth_token_version: 1, must_change_password: false })));
    const token = id => jwt.sign({ technicianId: id, type: 'access', tokenVersion: 1 }, config.jwt.secret, { expiresIn: '1h' });
    adminToken = token(adminId); techToken = token(techId);
    const app = express();
    app.use(express.json());
    app.use('/api/admin/notifications', require('../routes/admin-notifications'));
    app.use('/api/customer-notifications', require('../routes/customer-notifications'));
    app.use((err, req, res, next) => res.status(500).json({ error: 'Unavailable' }));
    server = await new Promise(resolve => { const listener = app.listen(0, '127.0.0.1', () => resolve(listener)); });
    base = `http://127.0.0.1:${server.address().port}/api`;
  }, 60000);
  afterAll(async () => {
    for (const [key, value] of Object.entries(originalEnv)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    if (server) await new Promise(resolve => server.close(resolve));
    await mockPg?.destroy();
    if (database) { await database.schema.dropSchemaIfExists(schema, true); await database.destroy(); }
  });
  beforeEach(async () => {
    jest.clearAllMocks();
    customerId = randomUUID();
    await mockPg('customers').insert({ id: customerId, account_id: customerId, is_primary_profile: true,
      first_name: 'QA', last_name: 'Inbox', address_line1: 'QA fixture only', city: 'QA', zip: '00000',
      phone: `+19415550${String(++fixtureIndex).padStart(3, '0')}`, email: `${customerId}@example.invalid`, active: true, pipeline_stage: 'active_customer' });
    customerToken = generateToken(customerId);
    process.env.CUSTOMER_INBOX_TEST_CUSTOMER_ID = customerId;
    process.env.GATE_CUSTOMER_INBOX_TEST = 'true';
    process.env.GATE_CUSTOMER_NATIVE_BADGES = 'true';
  });
  afterEach(() => {
    expect(Push.sendToCustomer).not.toHaveBeenCalled();
    expect(Push.sendToAdminUser).not.toHaveBeenCalled();
  });
  async function http(method, path, body, token = adminToken) {
    const response = await fetch(base + path, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
    return { status: response.status, body: await response.json() };
  }
  const post = (execute, token = adminToken) => http('POST', '/admin/notifications/customer-inbox-test', { customerId, ...(execute === undefined ? {} : { execute }) }, token);
  const count = async () => (await http('GET', '/customer-notifications/unread-count', null, customerToken)).body.count;
  const rows = () => mockPg('notifications').where({ recipient_type: 'customer', recipient_id: customerId });
  const audits = () => mockPg('audit_log').where({ action, resource_id: customerId });

  test('real auth rejects customer/technician tokens and revoked staff sessions', async () => {
    expect((await post(true, '')).status).toBe(401);
    expect((await post(true, customerToken)).status).toBe(401);
    expect((await post(true, techToken)).status).toBe(403);
    const stale = jwt.sign({ technicianId: adminId, type: 'access', tokenVersion: 2 }, config.jwt.secret);
    expect((await post(true, stale)).status).toBe(401);
    expect(await rows()).toHaveLength(0);
  });
  test('dry-run does not write or consume the pair; API read flow proves 2 -> 1 -> 0', async () => {
    expect((await post()).body).toMatchObject({ dryRun: true, wouldCreate: 2, createdCount: 0 });
    expect(await rows()).toHaveLength(0); expect(await audits()).toHaveLength(0);
    const created = await post(true);
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({ createdCount: 2, delivery: { push: false, sms: false, email: false } });
    expect(await count()).toBe(2);
    const read = await http('PUT', `/customer-notifications/${created.body.notificationIds[0]}/read`, {}, customerToken);
    expect(read.status).toBe(200); expect(await count()).toBe(1);
    expect((await http('PUT', '/customer-notifications/read-all', {}, customerToken)).status).toBe(200);
    expect(await count()).toBe(0);
    const retry = await post(true);
    expect(retry.body).toMatchObject({ alreadyCreated: true, createdCount: 0, notificationIds: created.body.notificationIds });
    expect(await count()).toBe(0);
    expect(await audits()).toEqual([expect.objectContaining({ actor_type: 'technician', actor_id: adminId,
      metadata: { notificationIds: created.body.notificationIds, delivery: { push: false, sms: false, email: false } } })]);
  });
  test('concurrent requests create only one pair and one audit', async () => {
    const results = await Promise.all([post(true), post(true)]);
    expect(results.map(result => result.status).sort()).toEqual([200, 201]);
    expect(await rows()).toHaveLength(2); expect(await audits()).toHaveLength(1);
    expect(results[0].body.notificationIds).toEqual(results[1].body.notificationIds);
  });
  test('existing items keep their original read state and content', async () => {
    const old = await Notifications.create({ recipientType: 'customer', recipientId: customerId, category: 'account', title: 'Existing fixture' });
    await Notifications.markRead(old.id, customerId);
    const before = await rows().where('id', old.id).first();
    await post(true);
    expect(await rows().where('id', old.id).first()).toEqual(before);
    expect(await count()).toBe(2);
  });
  test('a second-insert SQL failure rolls back the first notification and audit', async () => {
    await mockPg.raw("ALTER TABLE notifications ADD CONSTRAINT reject_second CHECK (title <> 'Badge test 2 of 2')");
    try {
      expect((await post(true)).status).toBe(500);
      expect(await rows()).toHaveLength(0); expect(await audits()).toHaveLength(0);
    } finally { await mockPg.raw('ALTER TABLE notifications DROP CONSTRAINT reject_second'); }
    expect((await post(true)).body.createdCount).toBe(2);
  });
  test('an audit SQL failure rolls back both notifications', async () => {
    await mockPg.raw(`ALTER TABLE audit_log ADD CONSTRAINT reject_inbox_audit CHECK (action <> '${action}') NOT VALID`);
    try {
      expect((await post(true)).status).toBe(500);
      expect(await rows()).toHaveLength(0); expect(await audits()).toHaveLength(0);
    } finally { await mockPg.raw('ALTER TABLE audit_log DROP CONSTRAINT reject_inbox_audit'); }
  });
  test('the durable audit prevents another pair after test inbox items are pruned', async () => {
    const created = await post(true);
    await rows().whereIn('id', created.body.notificationIds).delete();
    expect((await post(true)).body).toMatchObject({ alreadyCreated: true, createdCount: 0 });
    expect(await rows()).toHaveLength(0); expect(await audits()).toHaveLength(1);
  });
  test.each([{ active: false }, { pipeline_stage: 'churned' }, { deleted_at: new Date() }])('refuses an ineligible configured customer: %j', async change => {
    await mockPg('customers').where({ id: customerId }).update(change);
    expect((await post(true)).status).toBe(404);
    expect(await rows()).toHaveLength(0); expect(await audits()).toHaveLength(0);
  });
  test('kill switch closes an already used route', async () => {
    await post(true);
    delete process.env.GATE_CUSTOMER_INBOX_TEST;
    expect((await post(true)).status).toBe(404);
    expect(await rows()).toHaveLength(2); expect(await audits()).toHaveLength(1);
  });
});
