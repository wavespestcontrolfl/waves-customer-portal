// Codex #5568 r3: per-record scope on three more technician-reachable routes.
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret';
let mockRole = 'technician';
let mockServices = false;
let mockRow = null;
jest.mock('../models/db', () => {
  const fn = jest.fn(() => {
    const c = {};
    for (const m of ['where', 'whereNull', 'whereIn', 'leftJoin', 'select', 'orderBy', 'limit', 'modify']) c[m] = () => c;
    c.first = async () => mockRow;
    return c;
  });
  fn.raw = (x) => x;
  fn.transaction = async (cb) => cb(fn);
  return fn;
});
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
jest.mock('../middleware/admin-auth', () => {
  const actual = jest.requireActual('../middleware/admin-auth');
  return { ...actual, adminAuthenticate: (req, _res, next) => { req.technician = { id: 'tech-A', role: mockRole }; req.technicianId = 'tech-A'; req.techRole = mockRole; next(); } };
});
jest.mock('../services/technician-visit-scope', () => ({
  isTechnicianRequest: (req) => req.techRole === 'technician',
  technicianServicesCustomer: jest.fn(async (req) => (req.techRole !== 'technician' ? true : mockServices)),
  technicianCurrentVisitFilter: jest.fn((req, q) => q),
  technicianCustomerIdsSubquery: jest.fn(() => 'SCOPED'),
}));
const mockCreate = jest.fn(async () => ({ id: 'rr-1', sendOutcome: { sent: true } }));
jest.mock('../services/review-request', () => ({ create: (...a) => mockCreate(...a) }));

const express = require('express');
const CUSTOMER = '11111111-2222-4333-8444-555555555555';

function serve(mount, router) {
  const app = express();
  app.use(express.json());
  app.use(mount, router);
  app.use((err, _req, res, _next) => res.status(err.status || 500).json({ error: err.message }));
  const server = app.listen(0);
  const base = `http://127.0.0.1:${server.address().port}${mount}`;
  return { base, close: () => new Promise((r) => server.close(r)) };
}
const post = (url, body) => fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

beforeEach(() => { jest.clearAllMocks(); mockRole = 'technician'; mockServices = false; mockRow = null; });

describe('review-request triggers', () => {
  const router = require('../routes/admin-review-requests');
  test('/trigger refuses a customer off the route (404) and never creates', async () => {
    const { base, close } = serve('/api/admin/review-requests', router);
    try {
      expect((await post(`${base}/trigger`, { customerId: CUSTOMER })).status).toBe(404);
      expect(mockCreate).not.toHaveBeenCalled();
      mockServices = true;
      expect((await post(`${base}/trigger`, { customerId: CUSTOMER })).status).not.toBe(404);
    } finally { await close(); }
  });
  test('/tech-trigger refuses a service record whose customer is off the route', async () => {
    mockRow = { id: 'sr-1', customer_id: CUSTOMER };
    const { base, close } = serve('/api/admin/review-requests', router);
    try {
      expect((await post(`${base}/tech-trigger`, { serviceRecordId: 'sr-1' })).status).toBe(404);
      expect(mockCreate).not.toHaveBeenCalled();
    } finally { await close(); }
  });
});

describe('lawn diagnostics', () => {
  const router = require('../routes/tech-lawn-diagnostic');
  test("/:id/send and /:id/lead refuse another technician's diagnostic (404); an admin may act", async () => {
    mockRow = { id: 'ld-1', created_by_technician_id: 'tech-B', contact: {}, address: {} };
    const { base, close } = serve('/api/tech/lawn-diagnostic', router);
    try {
      expect((await post(`${base}/ld-1/send`, {})).status).toBe(404);
      expect((await post(`${base}/ld-1/lead`, {})).status).toBe(404);
      mockRole = 'admin';
      expect((await post(`${base}/ld-1/send`, {})).status).not.toBe(404);
    } finally { await close(); }
  });
});

describe('drafts', () => {
  const router = require('../routes/admin-drafts');
  test('GET /:id refuses a draft for a customer off the route (404) and a customerless draft (403)', async () => {
    mockRow = { id: 'd-1', customer_id: CUSTOMER, flags: null };
    const { base, close } = serve('/api/admin/drafts', router);
    try {
      expect((await fetch(`${base}/d-1`)).status).toBe(404);
      mockRow = { id: 'd-2', customer_id: null, flags: null };
      expect((await fetch(`${base}/d-2`)).status).toBe(403);
    } finally { await close(); }
  });
});
