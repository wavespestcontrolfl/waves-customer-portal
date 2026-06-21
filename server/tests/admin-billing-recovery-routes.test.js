process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret';

jest.mock('../models/db', () => {
  const fn = jest.fn();
  fn.raw = jest.fn((sql) => sql);
  return fn;
});
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/invoice', () => ({ createFromService: jest.fn() }));
jest.mock('../services/autopay-eligibility', () => ({
  customerOnAutopay: jest.fn(),
  // SQL is ignored by the chain mock; just needs the { sql, binding } shape.
  autopayActivePredicate: jest.fn(() => ({ sql: '(true)', binding: '2026-01-01' })),
}));
jest.mock('../services/short-url', () => ({
  shortenOrPassthrough: jest.fn(async () => 'https://short/pay'),
  invoiceShortCodePrefix: jest.fn(() => 'INV'),
}));
jest.mock('../utils/portal-url', () => ({ publicPortalUrl: jest.fn(() => 'https://portal') }));
jest.mock('../services/intelligence-bar/dashboard-tools', () => ({
  executeDashboardTool: jest.fn(),
  INTERNAL_TEST_CUSTOMERS: [],
}));
jest.mock('../middleware/admin-auth', () => ({
  adminAuthenticate: (req, res, next) => {
    const token = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
    const users = { admin: { id: 'admin-1', role: 'admin' }, tech: { id: 'tech-1', role: 'technician' } };
    const user = users[token];
    if (!user) return res.status(401).json({ error: 'Admin authentication required' });
    req.technician = user;
    req.technicianId = user.id;
    req.techRole = user.role;
    return next();
  },
  requireAdmin: (req, res, next) => (req.techRole === 'admin' ? next() : res.status(403).json({ error: 'Admin access required' })),
  requireTechOrAdmin: (req, res, next) => (['admin', 'technician'].includes(req.techRole) ? next() : res.status(403).json({ error: 'Access denied' })),
}));

const express = require('express');
const db = require('../models/db');
const InvoiceService = require('../services/invoice');
const { customerOnAutopay } = require('../services/autopay-eligibility');
const { executeDashboardTool } = require('../services/intelligence-bar/dashboard-tools');
const router = require('../routes/admin-billing-recovery');

// Chainable knex query-builder mock. Builder methods return `this`; terminal
// `.first()`/`.insert()` resolve to configured values and `await qb` resolves
// to `rows` (the `.orderBy(...)` terminal in GET /leaks).
function makeQB({ rows = [], first = null, insert = undefined } = {}) {
  const qb = {};
  ['join', 'leftJoin', 'where', 'whereRaw', 'whereNull', 'whereNot', 'whereNotIn', 'orWhere', 'select', 'orderBy']
    .forEach((m) => { qb[m] = jest.fn(() => qb); });
  qb.first = jest.fn(() => Promise.resolve(first));
  qb.insert = jest.fn(() => Promise.resolve(insert));
  qb.then = (resolve, reject) => Promise.resolve(rows).then(resolve, reject);
  return qb;
}

// Install a db.transaction(cb) that routes trx(table) like db and supports trx.raw.
function installTransaction(routeTable) {
  db.transaction = jest.fn(async (cb) => {
    const trx = (arg) => routeTable(arg);
    trx.raw = jest.fn(() => Promise.resolve());
    return cb(trx);
  });
}

function appServer() {
  const app = express();
  app.use(express.json());
  app.use('/admin/billing-recovery', router);
  app.use((err, _req, res, _next) => res.status(err.status || 500).json({ error: err.message }));
  const server = app.listen(0);
  return { server, baseUrl: `http://127.0.0.1:${server.address().port}` };
}
async function withServer(fn) {
  const { server, baseUrl } = appServer();
  try { return await fn(baseUrl); } finally { await new Promise((r) => server.close(r)); }
}

const BILLABLE_VISIT = {
  scheduled_service_id: 'ss-1', service_record_id: 'sr-1', service_type: 'Quarterly Pest Control Service',
  estimated_price: '129.00', prepaid_amount: null, ss_callback: false, sr_callback: false,
  sr_status: 'completed', service_date: '2026-04-14', completed_at: '2026-04-14T15:00:00Z',
  customer_id: 'cust-1', monthly_rate: '0', property_type: 'residential', payer_id: null,
  autopay_enabled: true, autopay_paused_until: null, ach_status: null,
};

describe('admin billing-recovery routes', () => {
  beforeEach(() => { jest.clearAllMocks(); });

  test('technician cannot bill a visit (write requires admin)', async () => {
    await withServer(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/admin/billing-recovery/ss-1/bill`, {
        method: 'POST', headers: { Authorization: 'Bearer tech', 'Content-Type': 'application/json' }, body: '{}',
      });
      expect(res.status).toBe(403);
      expect(InvoiceService.createFromService).not.toHaveBeenCalled();
    });
  });

  test('billing an autopay-covered visit is blocked (canonical double-bill guard)', async () => {
    db.mockImplementation((arg) => {
      if (typeof arg === 'object' && arg.ss) return makeQB({ first: BILLABLE_VISIT });
      throw new Error(`unexpected table ${JSON.stringify(arg)}`);
    });
    customerOnAutopay.mockResolvedValue(true); // canonical helper says on autopay
    await withServer(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/admin/billing-recovery/ss-1/bill`, {
        method: 'POST', headers: { Authorization: 'Bearer admin', 'Content-Type': 'application/json' }, body: '{}',
      });
      const body = await res.json();
      expect(res.status).toBe(409);
      expect(body.error).toMatch(/autopay/i);
      expect(customerOnAutopay).toHaveBeenCalledWith(expect.objectContaining({ id: 'cust-1' }));
      expect(InvoiceService.createFromService).not.toHaveBeenCalled();
    });
  });

  test('billing a true-leak visit creates a draft invoice and records the actor', async () => {
    db.mockImplementation((arg) => {
      if (typeof arg === 'object' && arg.ss) return makeQB({ first: BILLABLE_VISIT });
      throw new Error(`unexpected direct table ${JSON.stringify(arg)}`);
    });
    customerOnAutopay.mockResolvedValue(false);
    const dispositionQB = makeQB({ first: null });
    installTransaction((arg) => {
      if (arg === 'invoices') return makeQB({ first: null });
      if (arg === 'visit_billing_dispositions') return dispositionQB;
      throw new Error(`unexpected trx table ${arg}`);
    });
    InvoiceService.createFromService.mockResolvedValue({ id: 'inv-1', total: '129.00', status: 'draft', token: 'tok', customer_id: 'cust-1' });

    await withServer(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/admin/billing-recovery/ss-1/bill`, {
        method: 'POST', headers: { Authorization: 'Bearer admin', 'Content-Type': 'application/json' }, body: '{}',
      });
      const body = await res.json();
      expect(res.status).toBe(200);
      expect(InvoiceService.createFromService).toHaveBeenCalledWith('sr-1', expect.objectContaining({ useScheduledReplay: true, dueDate: '2026-04-14' }));
      expect(dispositionQB.insert).toHaveBeenCalledWith(expect.objectContaining({
        scheduled_service_id: 'ss-1', disposition: 'billed', invoice_id: 'inv-1', actor_user_id: 'admin-1',
      }));
      expect(body.invoice.id).toBe('inv-1');
    });
  });

  test('billing a payer-billed visit is blocked (self-pay only v1)', async () => {
    db.mockImplementation((arg) => {
      if (typeof arg === 'object' && arg.ss) return makeQB({ first: { ...BILLABLE_VISIT, payer_id: 'payer-1' } });
      throw new Error(`unexpected direct table ${JSON.stringify(arg)}`);
    });
    customerOnAutopay.mockResolvedValue(false);
    await withServer(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/admin/billing-recovery/ss-1/bill`, {
        method: 'POST', headers: { Authorization: 'Bearer admin', 'Content-Type': 'application/json' }, body: '{}',
      });
      const body = await res.json();
      expect(res.status).toBe(409);
      expect(body.error).toMatch(/payer/i);
      expect(InvoiceService.createFromService).not.toHaveBeenCalled();
    });
  });

  test('billing a partially-prepaid visit is blocked (credit must be applied)', async () => {
    db.mockImplementation((arg) => {
      if (typeof arg === 'object' && arg.ss) return makeQB({ first: { ...BILLABLE_VISIT, estimated_price: '150.00', prepaid_amount: '50.00' } });
      throw new Error(`unexpected direct table ${JSON.stringify(arg)}`);
    });
    customerOnAutopay.mockResolvedValue(false);
    await withServer(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/admin/billing-recovery/ss-1/bill`, {
        method: 'POST', headers: { Authorization: 'Bearer admin', 'Content-Type': 'application/json' }, body: '{}',
      });
      const body = await res.json();
      expect(res.status).toBe(409);
      expect(body.error).toMatch(/partial prepayment/i);
      expect(InvoiceService.createFromService).not.toHaveBeenCalled();
    });
  });

  test('billing an incomplete (office-handoff) visit is blocked', async () => {
    db.mockImplementation((arg) => {
      if (typeof arg === 'object' && arg.ss) return makeQB({ first: { ...BILLABLE_VISIT, sr_status: 'incomplete' } });
      throw new Error(`unexpected direct table ${JSON.stringify(arg)}`);
    });
    customerOnAutopay.mockResolvedValue(false);
    await withServer(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/admin/billing-recovery/ss-1/bill`, {
        method: 'POST', headers: { Authorization: 'Bearer admin', 'Content-Type': 'application/json' }, body: '{}',
      });
      expect(res.status).toBe(422);
      expect(InvoiceService.createFromService).not.toHaveBeenCalled();
    });
  });

  test('billing an always-free-type visit is blocked (write path enforces the allowlist)', async () => {
    db.mockImplementation((arg) => {
      if (typeof arg === 'object' && arg.ss) return makeQB({ first: { ...BILLABLE_VISIT, service_type: 'Estimate service' } });
      throw new Error(`unexpected direct table ${JSON.stringify(arg)}`);
    });
    customerOnAutopay.mockResolvedValue(false);
    await withServer(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/admin/billing-recovery/ss-1/bill`, {
        method: 'POST', headers: { Authorization: 'Bearer admin', 'Content-Type': 'application/json' }, body: '{}',
      });
      const body = await res.json();
      expect(res.status).toBe(409);
      expect(body.error).toMatch(/no-cost/i);
      expect(InvoiceService.createFromService).not.toHaveBeenCalled();
    });
  });

  test('billing a visit that already has an invoice is blocked', async () => {
    db.mockImplementation((arg) => {
      if (typeof arg === 'object' && arg.ss) return makeQB({ first: BILLABLE_VISIT });
      throw new Error(`unexpected direct table ${JSON.stringify(arg)}`);
    });
    customerOnAutopay.mockResolvedValue(false);
    installTransaction((arg) => {
      if (arg === 'invoices') return makeQB({ first: { id: 'existing-inv' } });
      throw new Error(`unexpected trx table ${arg}`);
    });
    await withServer(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/admin/billing-recovery/ss-1/bill`, {
        method: 'POST', headers: { Authorization: 'Bearer admin', 'Content-Type': 'application/json' }, body: '{}',
      });
      expect(res.status).toBe(409);
      expect(InvoiceService.createFromService).not.toHaveBeenCalled();
    });
  });

  test('dismiss records an intentionally-free disposition with reason and actor', async () => {
    const dispositionQB = makeQB({ first: null });
    installTransaction((arg) => {
      if (typeof arg === 'object' && arg.ss) return makeQB({ first: { scheduled_service_id: 'ss-1', completed_at: '2026-06-18', service_record_id: 'sr-1' } });
      if (arg === 'invoices') return makeQB({ first: null });
      if (arg === 'visit_billing_dispositions') return dispositionQB;
      throw new Error(`unexpected trx table ${JSON.stringify(arg)}`);
    });
    await withServer(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/admin/billing-recovery/ss-1/dismiss`, {
        method: 'POST', headers: { Authorization: 'Bearer admin', 'Content-Type': 'application/json' },
        body: JSON.stringify({ reason: 'in-window rodent trap check' }),
      });
      expect(res.status).toBe(200);
      expect(dispositionQB.insert).toHaveBeenCalledWith(expect.objectContaining({
        scheduled_service_id: 'ss-1', disposition: 'intentionally_free', reason: 'in-window rodent trap check', actor_user_id: 'admin-1',
      }));
    });
  });

  test('dismiss is blocked when the visit is already invoiced (eligibility rechecked in-lock)', async () => {
    installTransaction((arg) => {
      if (typeof arg === 'object' && arg.ss) return makeQB({ first: { scheduled_service_id: 'ss-1', completed_at: '2026-06-18', service_record_id: 'sr-1' } });
      if (arg === 'invoices') return makeQB({ first: { id: 'inv-x' } });
      throw new Error(`unexpected trx table ${JSON.stringify(arg)}`);
    });
    await withServer(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/admin/billing-recovery/ss-1/dismiss`, {
        method: 'POST', headers: { Authorization: 'Bearer admin', 'Content-Type': 'application/json' },
        body: JSON.stringify({ reason: 'x' }),
      });
      expect(res.status).toBe(409);
    });
  });

  test('GET /leaks splits true leaks from needs-review by monthly_rate', async () => {
    const rows = [
      { scheduled_service_id: 'ss-1', service_record_id: 'sr-1', service_type: 'Quarterly Pest Control Service', estimated_price: '129.00', prepaid_amount: '0', completed_at: '2026-06-18', customer_id: 'cust-1', first_name: 'Tyler', last_name: 'Levin', monthly_rate: '0', waveguard_tier: null },
      { scheduled_service_id: 'ss-2', service_record_id: 'sr-2', service_type: 'Pest Control', estimated_price: '200.00', prepaid_amount: '0', completed_at: '2026-06-10', customer_id: 'cust-2', first_name: 'Jane', last_name: 'Doe', monthly_rate: '49.00', waveguard_tier: 'Gold' },
      { scheduled_service_id: 'ss-3', service_record_id: 'sr-3', service_type: 'Pest Control', estimated_price: '150.00', prepaid_amount: '50.00', completed_at: '2026-06-05', customer_id: 'cust-3', first_name: 'Sam', last_name: 'Park', monthly_rate: '0', waveguard_tier: null },
      { scheduled_service_id: 'ss-4', service_record_id: 'sr-4', service_type: 'WDO Inspection Service', estimated_price: '125.00', prepaid_amount: '0', completed_at: '2026-06-04', customer_id: 'cust-4', first_name: 'Wendy', last_name: 'Ono', monthly_rate: '0', waveguard_tier: null },
    ];
    db.mockImplementation((arg) => {
      if (typeof arg === 'object' && arg.ss) return makeQB({ rows });
      throw new Error(`unexpected table ${JSON.stringify(arg)}`);
    });
    await withServer(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/admin/billing-recovery/leaks?days=90`, { headers: { Authorization: 'Bearer admin' } });
      const body = await res.json();
      expect(res.status).toBe(200);
      expect(body.summary.leak_visits).toBe(1);
      expect(body.summary.leak_dollars).toBe(129);
      expect(body.summary.review_visits).toBe(3); // monthly-rate + partial-prepay + inspection(ambiguous)
      expect(body.leaks[0].customer).toBe('Tyler Levin');
      expect(body.needs_review.map((r) => r.customer)).toEqual(expect.arrayContaining(['Jane Doe', 'Sam Park', 'Wendy Ono']));
    });
  });

  test('GET /aging proxies the dashboard outstanding-balances tool', async () => {
    executeDashboardTool.mockResolvedValue({ total_outstanding: 500, aging: { current: 100, days_30: 400, days_60: 0, days_90_plus: 0 } });
    await withServer(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/admin/billing-recovery/aging`, { headers: { Authorization: 'Bearer admin' } });
      const body = await res.json();
      expect(res.status).toBe(200);
      expect(executeDashboardTool).toHaveBeenCalledWith('get_outstanding_balances', { min_amount: 0 });
      expect(body.total_outstanding).toBe(500);
    });
  });

  test('GET /aging surfaces tool failures as non-2xx (not a silent $0)', async () => {
    executeDashboardTool.mockResolvedValue({ error: 'db unavailable' });
    await withServer(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/admin/billing-recovery/aging`, { headers: { Authorization: 'Bearer admin' } });
      expect(res.status).toBe(502);
    });
  });
});
