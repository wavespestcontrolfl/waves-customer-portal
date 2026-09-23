// AUDIT REPRO r1-platform-3 (unit variant) — the router guard used to be
// adminAuthenticate + requireTechOrAdmin only (no requireAdmin), so a
// technician-role token could reach legacy iCal appointment rows (PII +
// per-job price) and aggregate revenue via /api/admin/ical-history and
// /timeline. Fixed behaviour asserted here: technician tokens now get 403
// with no body; admin is unaffected (ADMIN-BUG-R08).
process.env.JWT_SECRET = process.env.JWT_SECRET || 'ical-history-authz-test-secret';

jest.mock('../models/db', () => jest.fn());

const express = require('express');
const jwt = require('jsonwebtoken');
const config = require('../config');
const db = require('../models/db');
const router = require('../routes/admin-ical-history');

const staff = Object.fromEntries(['admin', 'technician'].map(role => [role, {
  id: role, role, employment_status: 'active', auth_token_version: 1,
}]));

const legacyRow = {
  id: 1, customer_name: 'Legacy Customer', phone: '9415550100',
  email: 'legacy@example.com', address: '1 Legacy Way, Sarasota FL',
  service_type: 'Quarterly Pest', price: '149.00', status: 'completed',
  matched_customer_id: null, scheduled_date: '2025-07-05T16:00:00Z',
};
const statsRow = { total: '2554', completed: '2000', total_revenue: '381046.00' };
const timelineRows = [{ month: '2025-07', total: '40', completed: '38', cancelled: '2', revenue: '5960.00' }];

let lastTable;
function query(table) {
  lastTable = table;
  let where;
  const q = {};
  for (const method of ['select', 'orderBy', 'limit', 'offset', 'groupBy', 'groupByRaw',
    'whereILike', 'orWhereILike']) {
    q[method] = jest.fn(() => q);
  }
  q.where = jest.fn(function (value) {
    if (typeof value === 'function') { value.call(q); return q; }
    where = value; return q;
  });
  q.count = jest.fn(() => q);
  q.first = jest.fn(async () => (table === 'technicians' ? staff[where?.id] : statsRow));
  q.then = (resolve, reject) => {
    let rows = [legacyRow];
    if (q.groupByRaw.mock.calls.length) rows = timelineRows;
    else if (q.groupBy.mock.calls.length) rows = [{ service_type: 'Quarterly Pest', count: '2554' }];
    else if (q.count.mock.calls.length) rows = [{ count: '2554' }];
    return Promise.resolve(rows).then(resolve, reject);
  };
  return q;
}

let server, baseUrl;
beforeAll(async () => {
  const app = express();
  app.set('db', db);
  app.use('/api/admin/ical-history', router);
  server = app.listen(0, '127.0.0.1');
  if (!server.listening) await new Promise(resolve => server.once('listening', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}/api/admin/ical-history`;
});
afterAll(async () => new Promise(resolve => server.close(resolve)));
beforeEach(() => {
  jest.clearAllMocks();
  db.mockImplementation(query);
  db.raw = jest.fn((sql) => sql);
  db.schema = { hasTable: jest.fn(async () => true) };
});

function request(route, role) {
  const headers = {};
  if (role) headers.Authorization = `Bearer ${jwt.sign({
    technicianId: role, type: 'access', tokenVersion: 1,
  }, config.jwt.secret, { expiresIn: '5m' })}`;
  return fetch(baseUrl + route, { headers });
}

describe('r1-platform-3: /api/admin/ical-history technician authorization', () => {
  test('anonymous is rejected (401)', async () => {
    const res = await request('/?limit=1000');
    expect(res.status).toBe(401);
  });

  test('technician token is refused (403) on the legacy rows + revenue list', async () => {
    const res = await request('/?limit=1000', 'technician');
    expect(res.status).toBe(403);
    const body = await res.json().catch(() => ({}));
    expect(body.appointments).toBeUndefined();
    expect(body.stats).toBeUndefined();
  });

  test('technician token is refused (403) on /timeline monthly revenue history', async () => {
    const res = await request('/timeline', 'technician');
    expect(res.status).toBe(403);
    const body = await res.json().catch(() => ({}));
    expect(body.timeline).toBeUndefined();
  });

  test('admin token succeeds (control)', async () => {
    const res = await request('/', 'admin');
    expect(res.status).toBe(200);
  });
});
