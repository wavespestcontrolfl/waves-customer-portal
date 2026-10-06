// GET/PUT /api/admin/invoices/:id/receipt-address — staff correction of the
// address one invoice and its receipt display. Pins: admin-only (the
// single-invoice staff GET exemption does not reach these sub-paths), the
// correction and its before/after audit row commit in ONE transaction, and
// a bad address / unknown invoice are 400 / 404 with nothing written.
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret';

jest.mock('../models/db', () => {
  const fn = jest.fn();
  fn.raw = jest.fn((sql) => sql);
  fn.fn = { now: jest.fn(() => 'NOW()') };
  fn.transaction = jest.fn(async (work) => work(fn.mockTrx));
  return fn;
});
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../middleware/admin-auth', () => ({
  adminAuthenticate: (req, _res, next) => { req.technicianId = 'admin-1'; req.techRole = req.headers['x-role'] || 'admin'; return next(); },
  requireAdmin: jest.fn((req, res, next) => (req.techRole === 'admin' ? next() : res.status(403).json({ error: 'Admin only' }))),
  requireTechOrAdmin: (_req, _res, next) => next(),
}));
const mockAudit = jest.fn(async () => 'audit-1');
jest.mock('../services/audit-log', () => ({ recordAuditEvent: (...a) => mockAudit(...a) }));

const express = require('express');
const db = require('../models/db');
// Loaded once at module scope: the router is large, and requiring it inside
// the first test spent most of that test's 5s budget under parallel load.
const router = require('../routes/admin-invoices');

let rows;
let updates;
function table(name) {
  const q = {
    where: (criteria) => { q.criteria = criteria; return q; },
    forUpdate: () => q,
    first: async () => (rows[name] || []).find((r) => Object.entries(q.criteria).every(([k, v]) => r[k] === v)) || null,
    update: async (patch) => { updates.push({ table: name, patch }); return 1; },
  };
  return q;
}

async function withServer(callback) {
  const app = express();
  app.use(express.json());
  app.use('/invoices', router);
  app.use((err, _req, res, _next) => res.status(500).json({ error: err.message }));
  const server = app.listen(0, '127.0.0.1');
  try {
    if (!server.listening) await new Promise((resolve) => server.once('listening', resolve));
    return await callback(`http://127.0.0.1:${server.address().port}`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

const put = (base, id, body, role) => fetch(`${base}/invoices/${id}/receipt-address`, {
  method: 'PUT',
  headers: { 'content-type': 'application/json', ...(role ? { 'x-role': role } : {}) },
  body: JSON.stringify(body),
});
const CORRECT = { address_line1: '12 Corrected Way', city: 'Bradenton', state: 'FL', zip: '34203' };

beforeEach(() => {
  rows = {
    invoices: [{ id: 'inv-1', customer_id: 'cust-1', status: 'paid', customer_address_snapshot: { address_line1: '100 Wrong St', address_line2: null, city: 'Sarasota', state: 'FL', zip: '34201' } }],
    customers: [{ id: 'cust-1', address_line1: '55 Live Ave', address_line2: null, city: 'Venice', state: 'FL', zip: '34285' }],
  };
  updates = [];
  db.mockImplementation(table);
  const trx = (name) => table(name);
  trx.fn = db.fn;
  db.mockTrx = trx;
  mockAudit.mockClear();
});

test('GET returns the address the documents display (snapshot over live customer)', () => withServer(async (base) => {
  const res = await fetch(`${base}/invoices/inv-1/receipt-address`);
  expect(res.status).toBe(200);
  expect((await res.json()).address).toMatchObject({ address_line1: '100 Wrong St', city: 'Sarasota' });
}));

test('PUT on a paid invoice rewrites only its snapshot and audits before/after inside the transaction', () => withServer(async (base) => {
  const res = await put(base, 'inv-1', CORRECT);
  expect(res.status).toBe(200);
  expect((await res.json()).address).toMatchObject(CORRECT);
  expect(updates).toEqual([{ table: 'invoices', patch: { customer_address_snapshot: expect.objectContaining(CORRECT), updated_at: 'NOW()' } }]);
  expect(mockAudit).toHaveBeenCalledWith(expect.objectContaining({
    action: 'invoice.address.correct',
    actor_id: 'admin-1',
    resource_id: 'inv-1',
    critical: true,
    trx: db.mockTrx,
    metadata: expect.objectContaining({
      customerId: 'cust-1',
      before: expect.objectContaining({ address_line1: '100 Wrong St' }),
      after: expect.objectContaining(CORRECT),
    }),
  }));
}));

test('PUT on a void invoice is refused server-side (409) and writes nothing', () => withServer(async (base) => {
  rows.invoices[0].status = 'void';
  const res = await put(base, 'inv-1', CORRECT);
  expect(res.status).toBe(409);
  expect((await res.json()).code).toBe('invoice_void');
  expect(updates).toEqual([]);
  expect(mockAudit).not.toHaveBeenCalled();
}));

test('a failed audit write fails the correction (same transaction)', () => withServer(async (base) => {
  mockAudit.mockRejectedValueOnce(new Error('audit down'));
  const res = await put(base, 'inv-1', CORRECT);
  expect(res.status).toBe(500);
}));

test('invalid address → 400, unknown invoice → 404, non-admin → 403; none write', () => withServer(async (base) => {
  expect((await put(base, 'inv-1', { ...CORRECT, zip: 'abc' })).status).toBe(400);
  expect((await put(base, 'missing', CORRECT)).status).toBe(404);
  expect((await put(base, 'inv-1', CORRECT, 'technician')).status).toBe(403);
  expect((await fetch(`${base}/invoices/inv-1/receipt-address`, { headers: { 'x-role': 'technician' } })).status).toBe(403);
  expect(updates).toEqual([]);
  expect(mockAudit).not.toHaveBeenCalled();
}));
