/**
 * AUDIT REPRO (merged r1-authz-5 + r1-authz-5-tech-invoice-get) —
 * GET /api/admin/invoices/:id had no technician ownership predicate: the
 * router's single-invoice GET exemption (admin-invoices.js, just above the
 * requireAdmin fallback) exists ONLY so a technician's tap-to-pay checkout
 * (PrepaySwitchSheet / AnnualPrepayLauncher) can re-read its OWN invoice
 * after tender — but the handler never checked that the invoice's customer
 * is actually one the requesting technician services.
 *
 * Pattern copied from admin-invoices-charge-card-route.test.js (mock db,
 * mocked admin-auth, real router). The auth mock issues a TECHNICIAN token;
 * requireAdmin keeps its real semantics (403 for non-admin) so the router's
 * single-invoice GET exemption is exercised for real.
 *
 * Fixed behaviour asserted here: a technician NOT servicing the invoice's
 * customer gets 404 with no billing detail; a technician who DOES service
 * that customer (the tap-to-pay case) still gets 200 with the full payload,
 * so the legitimate checkout flow keeps working; admin is unscoped.
 */
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret';

// Chainable knex-ish stub: every builder resolves to [] / undefined.
function mockMakeBuilder() {
  const b = {};
  const chain = () => b;
  ['where', 'whereNot', 'whereIn', 'whereNotIn', 'whereNotNull', 'whereNull', 'orderBy',
    'limit', 'select', 'leftJoin', 'join', 'andWhere', 'orWhere', 'groupBy', 'forUpdate']
    .forEach((m) => { b[m] = jest.fn(chain); });
  b.first = jest.fn(() => Promise.resolve(undefined));
  b.then = (resolve, reject) => Promise.resolve([]).then(resolve, reject);
  b.catch = (fn) => Promise.resolve([]).catch(fn);
  return b;
}
jest.mock('../models/db', () => {
  const fn = jest.fn(() => mockMakeBuilder());
  fn.raw = jest.fn((s) => s);
  fn.transaction = jest.fn(async (cb) => cb(fn));
  return fn;
});
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
jest.mock('../middleware/admin-auth', () => ({
  adminAuthenticate: (req, _res, next) => {
    req.technicianId = 'tech-OTHER';
    req.techRole = 'technician';
    return next();
  },
  // Real semantics (server/middleware/admin-auth.js requireAdmin).
  requireAdmin: (req, res, next) => (req.techRole !== 'admin'
    ? res.status(403).json({ error: 'Admin access required' })
    : next()),
  requireTechOrAdmin: (req, res, next) => (['admin', 'technician'].includes(req.techRole)
    ? next()
    : res.status(403).json({ error: 'Staff access required' })),
}));
jest.mock('../services/technician-visit-scope', () => {
  const actual = jest.requireActual('../services/technician-visit-scope');
  return {
    ...actual,
    technicianServicesCustomer: jest.fn(async () => false),
    technicianCurrentVisitFilter: jest.fn((_req, q) => q),
  };
});
jest.mock('../services/stripe', () => ({
  chargeInvoiceWithSavedCard: jest.fn(),
  quoteInvoiceSavedCardCharge: jest.fn(),
}));
jest.mock('../services/invoice', () => ({
  getById: jest.fn(),
}));

const express = require('express');
const InvoiceService = require('../services/invoice');
const { technicianServicesCustomer } = require('../services/technician-visit-scope');
const router = require('../routes/admin-invoices');

const FOREIGN_INVOICE = {
  id: 'inv-foreign-1',
  customer_id: 'cust-foreign-1',
  invoice_number: 'WPC-2026-9999',
  token: 'tok-secret-foreign',
  status: 'sent',
  line_items: [{ description: 'Quarterly pest', amount: 189 }],
  subtotal: 189, tax: 12.29, total: 201.29,
  notes: 'gate code 4321',
  customer: {
    first_name: 'Other', last_name: 'Customer', phone: '+19415550100',
    email: 'other@example.test', address_line1: '1 Elsewhere Ln', city: 'Venice', state: 'FL', zip: '34285',
    card_on_file: { brand: 'visa', last_four: '4242' },
  },
  active_payment_plan: { id: 'pp-1', status: 'active' },
  annual_prepay: null,
  annual_prepay_term: { id: 'apt-1' },
  review_hold: false,
};

async function withServer(fn) {
  const app = express();
  app.use(express.json());
  app.use('/api/admin/invoices', router);
  app.use((err, _req, res, _next) => res.status(err.status || 500).json({ error: err.message }));
  const server = app.listen(0);
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  try { return await fn(baseUrl); } finally { await new Promise((r) => server.close(r)); }
}

describe('admin-invoices GET /:id — technician ownership scoping (ADMIN-BUG-R05)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    InvoiceService.getById.mockResolvedValue({ ...FOREIGN_INVOICE });
    technicianServicesCustomer.mockResolvedValue(false);
  });

  test('sanity: named sibling GET /stats is still admin-only for a technician (403)', async () => {
    await withServer(async (baseUrl) => {
      const r = await fetch(`${baseUrl}/api/admin/invoices/stats`);
      expect(r.status).toBe(403);
    });
  });

  test('technician NOT servicing the customer gets 404 and no billing detail (card, total, token, address, email)', async () => {
    await withServer(async (baseUrl) => {
      const r = await fetch(`${baseUrl}/api/admin/invoices/${FOREIGN_INVOICE.id}`);
      const body = await r.json().catch(() => ({}));
      expect(r.status).toBe(404);
      expect(body.customer).toBeUndefined();
      expect(body.line_items).toBeUndefined();
      expect(body.total).toBeUndefined();
      expect(body.token).toBeUndefined();
      expect(body.active_payment_plan).toBeUndefined();
      expect(body.annual_prepay_term).toBeUndefined();
    });
  });

  test('technician who DOES service the invoice\'s customer (own tap-to-pay checkout) still gets 200 with the full payload', async () => {
    technicianServicesCustomer.mockResolvedValue(true);
    await withServer(async (baseUrl) => {
      const r = await fetch(`${baseUrl}/api/admin/invoices/${FOREIGN_INVOICE.id}`);
      const body = await r.json();
      expect(r.status).toBe(200);
      expect(body.customer.card_on_file).toEqual({ brand: 'visa', last_four: '4242' });
      expect(body.total).toBe(201.29);
      expect(body.token).toBe('tok-secret-foreign');
      expect(technicianServicesCustomer).toHaveBeenCalledWith(expect.anything(), FOREIGN_INVOICE.customer_id);
    });
  });
});
