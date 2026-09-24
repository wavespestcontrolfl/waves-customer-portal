/**
 * AUDIT REPRO r1-platform-1 — GET /api/admin/health/scores/:customerId (and
 * /quiet) with a role='technician' staff token must NOT return office-only
 * customer fields (monthly_rate, lifetime_revenue, crm_notes, follow_up_notes,
 * gate_code, lockbox_code, stripe_customer_id, payer_id, payment_details ...).
 *
 * Baseline contract: routes/admin-customers.js TECH_360_STRIPPED_CUSTOMER_FIELDS
 * + TECH_360_STRIPPED_KEYS ('healthScore') applied for req.techRole==='technician'.
 * The client hides /admin/health from technicians (adminNavigation.js
 * TECH_ALLOWED_PATH_PREFIXES), so the expected server behaviour is either a 403
 * (requireAdmin) or a redacted payload.
 *
 * Written to assert the EXPECTED behaviour, so it FAILS on current code if the
 * router really hands a technician the raw customers.* row.
 *
 * Auth: REAL middleware/admin-auth (real JWT signed with JWT_SECRET) — only the
 * db is mocked (pattern: tests/admin-health-dashboard.test.js +
 * tests/admin-ads-route-guards.test.js real-listen round-trips).
 */
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret';

jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
jest.mock('../services/customer-health', () => ({ scoreCustomer: jest.fn(), scoreAllCustomers: jest.fn(async () => ({ scored: 0, failed: 0 })) }));
jest.mock('../services/health-alerts', () => ({}));
jest.mock('../services/customer-intelligence/quiet-customers', () => ({
  LAST_TOUCH_SQL: 'now()',
  resolveQuietDays: () => 45,
  mapQuietRow: (r) => r,
}));

const TECH_ID = '11111111-1111-4111-8111-111111111111';
const CUSTOMER_ID = '22222222-2222-4222-8222-222222222222';

const mockTechRow = {
  id: TECH_ID, role: 'technician', employment_status: 'active', auth_token_version: 1,
  must_change_password: false,
};

// The joined row the detail query returns: customers.* + health columns.
const mockScoreRow = {
  id: CUSTOMER_ID, first_name: 'Pat', last_name: 'Customer',
  monthly_rate: 129.0, lifetime_revenue: 4820.5,
  crm_notes: 'OWNER-ONLY: negotiating a discount, do not mention',
  follow_up_notes: 'call about past-due balance',
  gate_code: '#4471', lockbox_code: '9090',
  stripe_customer_id: 'cus_TESTSECRET', payer_id: '33333333-3333-4333-8333-333333333333',
  lead_score: 88, service_pause_reason: 'autopay failed 3x',
  overall_score: 72, score_grade: 'B', payment_score: 40,
  payment_details: JSON.stringify({ failedCount: 3, lateCount: 2, onTimeRate: 0.4 }),
  churn_risk: 'moderate', churn_signals: JSON.stringify(['late_payments']),
};
const mockQuietRow = {
  id: CUSTOMER_ID, first_name: 'Pat', last_name: 'Customer', waveguard_tier: 'gold',
  phone: '555', city: 'Sarasota', monthly_rate: 129.0,
  overall_score: 72, score_grade: 'B', churn_risk: 'low',
  last_service_at: null, last_inbound_at: null, last_touch_at: null,
};

jest.mock('../models/db', () => {
  const db = jest.fn((table) => {
    const tbl = String(table).split(' ')[0];
    const q = {};
    for (const m of ['join', 'leftJoin', 'where', 'whereIn', 'whereNull', 'whereNotNull', 'whereRaw',
      'whereNotExists', 'select', 'orderBy', 'orderByRaw', 'limit', 'count', 'sum', 'groupBy', 'avg']) {
      q[m] = () => q;
    }
    q.first = async () => {
      if (tbl === 'technicians') return { ...mockTechRow };
      if (tbl === 'customer_health_scores') return { ...mockScoreRow };
      return null;
    };
    q.then = (resolve, reject) => {
      const rows = tbl === 'customer_health_scores' ? [{ ...mockQuietRow }] : [];
      return Promise.resolve(rows).then(resolve, reject);
    };
    return q;
  });
  db.raw = jest.fn((sql) => sql);
  db.schema = {
    hasTable: jest.fn(async () => true),
    hasColumn: jest.fn(async () => true),
    createTable: jest.fn(async () => {}),
    alterTable: jest.fn(async () => {}),
  };
  return db;
});

const express = require('express');
const jwt = require('jsonwebtoken');
const router = require('../routes/admin-health');

let server; let baseUrl;
beforeAll((done) => {
  const app = express();
  app.use(express.json());
  app.use('/api/admin/health', router);
  server = app.listen(0, () => { baseUrl = `http://127.0.0.1:${server.address().port}`; done(); });
});
afterAll((done) => { server.close(done); });

function techToken() {
  return jwt.sign({ type: 'access', tokenVersion: 1, technicianId: TECH_ID, role: 'technician' }, process.env.JWT_SECRET, { expiresIn: '1h' });
}

async function get(path) {
  const res = await fetch(`${baseUrl}${path}`, { headers: { authorization: `Bearer ${techToken()}` } });
  let body = null; try { body = await res.json(); } catch { /* none */ }
  return { status: res.status, body: body || {} };
}

const OFFICE_ONLY = ['monthly_rate', 'lifetime_revenue', 'crm_notes', 'follow_up_notes', 'gate_code',
  'lockbox_code', 'stripe_customer_id', 'payer_id', 'lead_score', 'service_pause_reason', 'payment_details'];

test('technician token: GET /scores/:customerId is 403 or redacts office-only customer fields', async () => {
  const { status, body } = await get(`/api/admin/health/scores/${CUSTOMER_ID}`);
  if (status === 403) return; // requireAdmin — acceptable expected behaviour
  expect(status).toBe(200);
  const leaked = OFFICE_ONLY.filter((k) => body.score && body.score[k] !== undefined);
  expect(leaked).toEqual([]);
});

test('technician token: GET /quiet is 403 or omits monthly_rate', async () => {
  const { status, body } = await get('/api/admin/health/quiet');
  if (status === 403) return;
  expect(status).toBe(200);
  const rows = Array.isArray(body) ? body : (body.customers || body.rows || body.quiet || []);
  const leaked = rows.filter((r) => r.monthly_rate !== undefined).map((r) => r.id);
  expect(leaked).toEqual([]);
});

test('technician token: POST /rescore-all is refused (403)', async () => {
  const res = await fetch(`${baseUrl}/api/admin/health/rescore-all`, { method: 'POST', headers: { authorization: `Bearer ${techToken()}` } });
  expect(res.status).toBe(403);
});

// Merged from the sibling leak-documentation repro (r1-platform-1-health-tech-leak):
// the pre-fix guard was adminAuthenticate alone, so this control distinguishes
// "no token / wrong token type rejected" from "any staff role admitted".
test('control: a non-staff (refresh-type) token is rejected 401, independent of the requireAdmin fix', async () => {
  const badToken = jwt.sign({ type: 'refresh', tokenVersion: 1, technicianId: TECH_ID }, process.env.JWT_SECRET);
  const res = await fetch(`${baseUrl}/api/admin/health/scores/${CUSTOMER_ID}`, { headers: { authorization: `Bearer ${badToken}` } });
  expect(res.status).toBe(401);
});
