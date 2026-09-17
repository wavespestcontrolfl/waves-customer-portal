// Real staff authentication and mounted routers; persistence and all external
// services are synthetic. Denials must happen before customer reads or writes.
const express = require('express');
const jwt = require('jsonwebtoken');

jest.mock('../config', () => ({ jwt: { secret: 'synthetic-customer-access-test' } }));
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/customer-intelligence/signal-detector', () => ({ detectAllSignals: jest.fn() }));
jest.mock('../services/customer-intelligence/health-scorer', () => ({ enrichAllCustomers: jest.fn() }));
jest.mock('../services/customer-intelligence/retention-engine', () => ({
  getMetrics: jest.fn().mockResolvedValue({ retained: 0 }), generateRetentionOutreach: jest.fn(),
}));
jest.mock('../services/customer-health', () => ({ scoreAllCustomers: jest.fn() }));
jest.mock('../services/messaging/send-customer-message', () => ({ sendCustomerMessage: jest.fn() }));
jest.mock('../services/irrigation-schedule-confirmation', () => ({
  COUNTY_CONFIRMED_FIELD: 'county', GRASS_CONFIRMED_FIELD: 'grass', confirmIrrigationFields: jest.fn(),
}));
jest.mock('../services/customer-pricing-ai', () => ({
  withTurfProfileFence: jest.fn(async (db, _id, callback) => callback(db)),
}));
jest.mock('../models/db', () => {
  const db = jest.fn((table) => {
    const filters = []; let insert; let patch;
    const col = key => key.replace(/^scheduled_services\./, '');
    const rows = () => (db.rows[table] || []).filter(row => filters.every(f => f(row)));
    const query = {
      where(key, op, value) {
        if (typeof key === 'object') {
          Object.entries(key).forEach(([k, v]) => filters.push(row => row[col(k)] === v));
        } else if (value !== undefined) {
          if (op !== '>=') throw new Error(`Unexpected comparison ${op}`);
          filters.push(row => row[col(key)] >= value);
        } else filters.push(row => row[col(key)] === op);
        return this;
      },
      whereNotIn(key, values) { filters.push(row => !values.includes(row[col(key)])); return this; },
      orderBy() { return this; }, orderByRaw() { return this; }, limit() { return this; },
      first() { return Promise.resolve(rows()[0] && { ...rows()[0] }); },
      insert(value) { insert = value; return this; }, onConflict() { return this; },
      merge(value) { patch = value; return this; }, update(value) { patch = value; return this; },
      returning() { return this; },
      then(resolve, reject) {
        let selected = rows();
        if (insert) {
          let row = db.rows[table].find(r => r.customer_id === insert.customer_id);
          if (!row) { row = { ...insert }; db.rows[table].push(row); }
          selected = [row];
        }
        if (patch) selected.forEach(row => Object.assign(row, patch));
        return Promise.resolve(selected.map(row => ({ ...row }))).then(resolve, reject);
      },
    };
    return query;
  });
  db.rows = {};
  return db;
});

const db = require('../models/db');
const { etDateString, addETDays } = require('../utils/datetime-et');
const { withTurfProfileFence } = require('../services/customer-pricing-ai');
const { confirmIrrigationFields } = require('../services/irrigation-schedule-confirmation');
const { sendCustomerMessage } = require('../services/messaging/send-customer-message');
const { generateRetentionOutreach } = require('../services/customer-intelligence/retention-engine');
const { detectAllSignals } = require('../services/customer-intelligence/signal-detector');
const { scoreAllCustomers } = require('../services/customer-health');
const { enrichAllCustomers } = require('../services/customer-intelligence/health-scorer');
const app = express();
app.use(express.json());
app.use('/api/admin/customers/intelligence', require('../routes/admin-customer-intel'));
app.use('/api/admin/customers', require('../routes/admin-customer-turf-profile'));
app.use((err, _req, res, _next) => res.status(500).json({ error: err.message }));
let server; let origin;
beforeAll(async () => {
  server = await new Promise(resolve => {
    const listener = app.listen(0, '127.0.0.1', () => resolve(listener));
  });
  origin = `http://127.0.0.1:${server.address().port}`;
});
afterAll(async () => { await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }); });
beforeEach(() => {
  jest.clearAllMocks();
  db.rows = {
    technicians: ['admin', 'technician'].map(role => ({
      id: role, role, employment_status: 'active', auth_token_version: 1,
    })),
    customers: [{ id: 'customer' }], scheduled_services: [],
    customer_turf_profiles: [{ customer_id: 'customer', grass_type: 'bahia' }],
    property_preferences: [{ customer_id: 'customer', irrigation_home_changed_at: null }],
    customer_health_scores: [{ customer_id: 'customer', payment_score: 10 }],
    retention_outreach: [{ id: 'outreach', customer_id: 'customer', status: 'pending_approval', message_content: 'Synthetic private draft' }],
    upsell_opportunities: [{ id: 'upsell', customer_id: 'customer', status: 'identified' }],
  };
});
function assign(status = 'pending', days = 1, technicianId = 'technician') {
  db.rows.scheduled_services = [{
    id: 'visit', customer_id: 'customer', technician_id: technicianId,
    status, scheduled_date: etDateString(addETDays(new Date(), days)),
  }];
}
async function request(method, path, role = 'technician', body) {
  const token = role && jwt.sign({ technicianId: role, type: 'access', tokenVersion: 1 }, 'synthetic-customer-access-test');
  const response = await fetch(origin + '/api/admin/customers' + path, {
    method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: response.status, body: await response.json() };
}

describe.each(['GET', 'PUT'])('%s turf profile', method => {
  const call = role => request(method, '/customer/turf-profile', role, method === 'PUT' ? { grass_type: 'bermuda' } : undefined);
  test('requires authentication', async () => {
    expect((await call(null)).status).toBe(401);
    expect(db).not.toHaveBeenCalled();
  });
  test.each(['unassigned', 'other-tech', 'cancelled', 'rescheduled', 'skipped', 'stale-pending', 'stale-completed'])('hides %s customers without touching their data', async kind => {
    if (kind === 'other-tech') assign('pending', 1, 'another-tech');
    else if (kind.startsWith('stale-')) assign(kind.slice(6), -8);
    else if (kind !== 'unassigned') assign(kind);
    expect(await call('technician')).toEqual({ status: 404, body: { error: 'Customer not found' } });
    expect(db.mock.calls.map(([table]) => table)).toEqual(['technicians', 'scheduled_services']);
    expect(db.rows.customer_turf_profiles[0].grass_type).toBe('bahia');
    expect(withTurfProfileFence).not.toHaveBeenCalled();
    expect(confirmIrrigationFields).not.toHaveBeenCalled();
  });
  test.each([['pending', 1], ['completed', -7]])('preserves %s assigned access', async (status, days) => {
    assign(status, days);
    const result = await call('technician');
    expect(result.status).toBe(200);
    expect(result.body.profile.grass_type).toBe(method === 'PUT' ? 'bermuda' : 'bahia');
    if (method === 'PUT') expect(withTurfProfileFence).toHaveBeenCalledTimes(1);
  });
  test('preserves admin access without an assignment', async () => {
    expect((await call('admin')).status).toBe(200);
    expect(db.mock.calls.map(([table]) => table)).not.toContain('scheduled_services');
  });
  test('an assignment lookup failure cannot fall through to customer data', async () => {
    const original = db.getMockImplementation();
    db.mockImplementation(table => {
      if (table === 'scheduled_services') throw new Error('Synthetic assignment lookup failure');
      return original(table);
    });
    try {
      expect((await call('technician')).status).toBe(500);
      expect(db.mock.calls.map(([table]) => table)).toEqual(['technicians', 'scheduled_services']);
      expect(withTurfProfileFence).not.toHaveBeenCalled();
    } finally { db.mockImplementation(original); }
  });
});

const intelligenceRoutes = [
  ['GET', '/'], ['GET', '/customer/health'], ['POST', '/customer/retention-outreach'],
  ['PUT', '/retention/outreach/approve'], ['PUT', '/retention/outreach/skip'],
  ['PUT', '/retention/outreach/outcome'], ['PUT', '/upsells/upsell'],
  ['GET', '/metrics/summary'], ['POST', '/scan'],
];
test.each(intelligenceRoutes)('intelligence %s %s rejects even an assigned technician before any CRM work', async (method, path) => {
  assign();
  expect((await request(method, '/intelligence' + path, 'technician', method === 'GET' ? undefined : { outcome: 'retained', status: 'accepted' })).status).toBe(403);
  expect(db.mock.calls.map(([table]) => table)).toEqual(['technicians']);
  for (const service of [sendCustomerMessage, generateRetentionOutreach, detectAllSignals, scoreAllCustomers, enrichAllCustomers]) {
    expect(service).not.toHaveBeenCalled();
  }
});
test('intelligence rejects anonymous reads', async () => {
  expect((await request('GET', '/intelligence/customer/health', null)).status).toBe(401);
  expect(db).not.toHaveBeenCalled();
});
test('admin can still read health and record retention outcomes', async () => {
  const health = await request('GET', '/intelligence/customer/health', 'admin');
  expect(health.status).toBe(200);
  expect(health.body.outreach[0].message_content).toBe('Synthetic private draft');
  const result = await request('PUT', '/intelligence/retention/outreach/outcome', 'admin', { outcome: 'retained', revenueSaved: 500 });
  expect(result.status).toBe(200);
  expect(result.body.outreach).toMatchObject({ status: 'save_successful', revenue_saved: 500 });
});
