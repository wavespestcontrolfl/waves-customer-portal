/**
 * Audit repro r1-authz-1: technician-role staff tokens must NOT be able to
 * rewrite / deactivate / create / delete customer-facing SMS templates or
 * their variants. The client marks the Message Templates tab adminOnly
 * (CommunicationsPageV2.jsx TABS) and the sibling admin-email-templates
 * router is router.use(requireAdmin); the SMS router is expected to enforce
 * the same boundary server-side.
 *
 * Asserts the CORRECT behaviour (403 + no write). Fails on current code if
 * the router lets technicians through.
 *
 * Pattern: real requireAdmin/requireTechOrAdmin, stubbed adminAuthenticate
 * injecting a technician role (server/tests/admin-tech-role-scoping.test.js).
 */
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret';

let mockCurrentRole = 'technician';

jest.mock('../middleware/admin-auth', () => {
  const actual = jest.requireActual('../middleware/admin-auth');
  return {
    ...actual,
    adminAuthenticate: (req, _res, next) => {
      req.technician = { id: 'tech-1', role: mockCurrentRole };
      req.technicianId = 'tech-1';
      req.techRole = mockCurrentRole;
      return next();
    },
  };
});

jest.mock('../services/audit-log', () => ({ auditNotificationTemplateIssue: jest.fn(async () => {}) }));

jest.mock('../models/db', () => {
  const state = { writes: [], category: 'lifecycle', templateKey: 'appointment_confirmation' };
  const template = {
    id: 'tpl-1',
    template_key: 'appointment_confirmation',
    name: 'Appointment confirmation',
    body: 'Hi {first_name}, you are booked for {date} at {time}.',
    variables: JSON.stringify(['first_name', 'date', 'time']),
    is_active: true,
  };
  const dbFn = (table) => {
    const q = {};
    ['where', 'orderBy', 'onConflict', 'ignore', 'limit'].forEach((m) => { q[m] = jest.fn(() => q); });
    q.first = jest.fn(async () => ({ ...template, category: state.category, template_key: state.templateKey }));
    q.insert = jest.fn((row) => { state.writes.push({ table, op: 'insert', row }); return q; });
    q.update = jest.fn((row) => { state.writes.push({ table, op: 'update', row }); return q; });
    q.merge = jest.fn((row) => { state.writes.push({ table, op: 'merge', row }); return q; });
    q.del = jest.fn(async () => { state.writes.push({ table, op: 'del' }); return 1; });
    q.returning = jest.fn(async () => [{ ...template, ...(state.writes.at(-1)?.row || {}) }]);
    q.then = (resolve, reject) => Promise.resolve([]).then(resolve, reject);
    return q;
  };
  dbFn.__state = state;
  return dbFn;
});

const express = require('express');
const db = require('../models/db');
const router = require('../routes/admin-sms-templates');

let server; let baseUrl;
beforeAll(() => {
  const app = express();
  app.use(express.json());
  app.use('/api/admin/sms-templates', router);
  app.use((err, _req, res, _next) => res.status(err.status || 500).json({ error: err.message }));
  server = app.listen(0);
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});
afterAll(async () => { await new Promise((r) => server.close(r)); });

async function call(method, path, body) {
  const res = await fetch(`${baseUrl}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer staff' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, body: await res.json().catch(() => null) };
}

describe('r1-authz-1: SMS template CONFIG writes are owner-only', () => {
  beforeEach(() => {
    mockCurrentRole = 'technician';
    db.__state.writes.length = 0;
    db.__state.category = 'lifecycle';
    db.__state.templateKey = 'appointment_confirmation';
  });

  test('technician PUT /:id (rewrite + deactivate lifecycle template) is 403 and writes nothing', async () => {
    const res = await call('PUT', '/api/admin/sms-templates/tpl-1', { body: 'Hi {first_name}, your {date} {time} visit is CANCELLED.', is_active: false });
    expect(db.__state.writes).toEqual([]);
    expect(res.status).toBe(403);
  });

  test('technician POST / (create template) is 403 and writes nothing', async () => {
    const res = await call('POST', '/api/admin/sms-templates', { template_key: 'tech_made', name: 'x', body: 'hello' });
    expect(res.status).toBe(403);
    expect(db.__state.writes).toEqual([]);
  });

  test('technician DELETE /:id (custom template) is 403 and writes nothing', async () => {
    db.__state.category = 'custom';
    db.__state.templateKey = 'custom_followup';
    const res = await call('DELETE', '/api/admin/sms-templates/tpl-1');
    expect(db.__state.writes).toEqual([]);
    expect(res.status).toBe(403);
  });

  test('technician POST /:templateKey/variants (upsert variant) is 403 and writes nothing', async () => {
    const res = await call('POST', '/api/admin/sms-templates/appointment_confirmation/variants', { variantKey: 'evil', body: 'Hi {first_name}, {date} {time} - call 555', weight: 100, status: 'active' });
    expect(res.status).toBe(403);
    expect(db.__state.writes).toEqual([]);
  });

  test('technician PUT /:templateKey/variants/:variantKey is 403 and writes nothing', async () => {
    const res = await call('PUT', '/api/admin/sms-templates/appointment_confirmation/variants/control', { status: 'paused', weight: 0 });
    expect(res.status).toBe(403);
    expect(db.__state.writes).toEqual([]);
  });

  test('technician DELETE /:templateKey/variants/:variantKey is 403 and writes nothing', async () => {
    const res = await call('DELETE', '/api/admin/sms-templates/appointment_confirmation/variants/control');
    expect(res.status).toBe(403);
    expect(db.__state.writes).toEqual([]);
  });

  test('control: admin PUT /:id succeeds (200) and writes', async () => {
    mockCurrentRole = 'admin';
    const res = await call('PUT', '/api/admin/sms-templates/tpl-1', { is_active: false });
    expect(res.status).toBe(200);
    expect(db.__state.writes.map((w) => w.op)).toEqual(['update']);
  });
});
