process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret';

jest.mock('../models/db', () => {
  const fn = jest.fn();
  fn.raw = jest.fn((sql) => sql);
  return fn;
});
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/invoice', () => ({ createFromService: jest.fn() }));
// Payer ownership comes from the canonical resolver (active payers only).
jest.mock('../services/payer', () => ({ resolveForInvoice: jest.fn(async () => ({ payerId: null })) }));
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
const PayerService = require('../services/payer');
const { customerOnAutopay } = require('../services/autopay-eligibility');
const { executeDashboardTool } = require('../services/intelligence-bar/dashboard-tools');
const router = require('../routes/admin-billing-recovery');

// Chainable knex query-builder mock. Builder methods return `this`; terminal
// `.first()`/`.insert()` resolve to configured values and `await qb` resolves
// to `rows` (the `.orderBy(...)` terminal in GET /leaks).
function makeQB({ rows = [], first = null, insert = undefined } = {}) {
  const qb = {};
  ['join', 'leftJoin', 'where', 'whereIn', 'whereRaw', 'whereNull', 'whereNot', 'whereNotIn', 'orWhere', 'select', 'orderBy', 'forUpdate']
    .forEach((m) => { qb[m] = jest.fn(() => qb); });
  qb.first = jest.fn(() => Promise.resolve(first));
  qb.insert = jest.fn(() => Promise.resolve(insert));
  qb.then = (resolve, reject) => Promise.resolve(rows).then(resolve, reject);
  return qb;
}

// Install a db.transaction(cb) whose trx(table) serves the in-lock tables
// from routeTable and every other read (the billability assessment, which
// runs inside the lock) from the db mock, and supports trx.raw / schema.
function installTransaction(routeTable = () => { throw new Error('no trx tables'); }) {
  db.transaction = jest.fn(async (cb) => {
    const trx = (arg) => {
      try { return routeTable(arg); } catch { /* fall through to the db mock */ }
      try { return db(arg); } catch { /* strict db mocks: serve the lock reads below */ }
      // billVisit's owner lookup + customer row lock (taken before the assessment).
      if (arg === 'scheduled_services') return makeQB({ first: { customer_id: 'cust-1' } });
      if (arg === 'customers') return makeQB({ first: { id: 'cust-1' } });
      throw new Error(`unexpected trx table ${JSON.stringify(arg)}`);
    };
    trx.raw = jest.fn((sql) => (typeof sql === 'string' ? sql : Promise.resolve()));
    trx.schema = db.schema;
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
  beforeEach(() => {
    jest.clearAllMocks();
    // Refusals now surface from inside the mint transaction.
    installTransaction();
    // Current schema: the billing-mode columns are probed before they are read.
    db.schema = { hasColumn: jest.fn().mockResolvedValue(true), hasTable: jest.fn().mockResolvedValue(false) };
  });

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
      // Fail closed on an unreadable payment method (GH Codex P1).
      expect(customerOnAutopay).toHaveBeenCalledWith(expect.objectContaining({ id: 'cust-1' }), expect.objectContaining({ failClosed: true }));
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
      // The route holds the schedule.invoice.mint advisory lock, so its
      // transaction MUST be threaded through (codex #3344 r6 P1) — an
      // un-threaded replay mint requests the same lock on a second
      // connection and self-deadlocks until timeout.
      expect(InvoiceService.createFromService).toHaveBeenCalledWith('sr-1', expect.objectContaining({ useScheduledReplay: true, dueDate: '2026-04-14', database: expect.anything() }));
      // Tax is the calculator's call (exemptions / service taxability /
      // county rates), not a flat per-property_type override: the key must
      // be ABSENT (an explicit 0 would pre-empt TaxCalculator in create()).
      const mintOpts = InvoiceService.createFromService.mock.calls[0][1];
      expect(Object.prototype.hasOwnProperty.call(mintOpts, 'taxRate')).toBe(false);
      expect(dispositionQB.insert).toHaveBeenCalledWith(expect.objectContaining({
        scheduled_service_id: 'ss-1', disposition: 'billed', invoice_id: 'inv-1', actor_user_id: 'admin-1',
      }));
      expect(body.invoice.id).toBe('inv-1');
    });
  });

  // Per-application customers are on autopay BY DESIGN (the saved card is HOW
  // per-visit charges collect), so the autopay guard exempts them (Codex
  // round-7) — and their follow-up rows seed estimated_price NULL by design,
  // so pricing falls back to customers.per_application_fee, mirroring
  // completion billing's precedence (Codex round-11; never monthly_rate).
  test('a per-application autopay visit with no row price bills the customer-level fee', async () => {
    db.mockImplementation((arg) => {
      if (typeof arg === 'object' && arg.ss) return makeQB({ first: { ...BILLABLE_VISIT, estimated_price: null, monthly_rate: '55.30' } });
      if (arg === 'customers') return makeQB({ first: { billing_mode: 'per_application', per_application_fee: '55.30' } });
      throw new Error(`unexpected direct table ${JSON.stringify(arg)}`);
    });
    customerOnAutopay.mockResolvedValue(true); // per-app = on autopay by design
    const dispositionQB = makeQB({ first: null });
    installTransaction((arg) => {
      if (arg === 'invoices') return makeQB({ first: null });
      if (arg === 'visit_billing_dispositions') return dispositionQB;
      throw new Error(`unexpected trx table ${arg}`);
    });
    InvoiceService.createFromService.mockResolvedValue({ id: 'inv-2', total: '55.30', status: 'draft', token: 'tok', customer_id: 'cust-1' });

    await withServer(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/admin/billing-recovery/ss-1/bill`, {
        method: 'POST', headers: { Authorization: 'Bearer admin', 'Content-Type': 'application/json' }, body: '{}',
      });
      expect(res.status).toBe(200);
      expect(InvoiceService.createFromService).toHaveBeenCalledWith('sr-1', expect.objectContaining({ amount: 55.3 }));
      expect(dispositionQB.insert).toHaveBeenCalledWith(expect.objectContaining({ disposition: 'billed', invoice_id: 'inv-2' }));
    });
  });

  // GATE_STAMPED_ZERO_FREE (owner ruling 2026-09-28): a STAMPED 0 — as
  // opposed to the genuinely-blank row the test above covers — must never
  // reach the per-application fee either, once the gate is on. Off is
  // byte-identical to today (the fee still bills, same as a blank row).
  describe('a stamped $0 row (not a blank one) — GATE_STAMPED_ZERO_FREE', () => {
    afterEach(() => { delete process.env.GATE_STAMPED_ZERO_FREE; });

    test('off: bills the per_application_fee, same as today', async () => {
      db.mockImplementation((arg) => {
        if (typeof arg === 'object' && arg.ss) return makeQB({ first: { ...BILLABLE_VISIT, estimated_price: 0, monthly_rate: '55.30' } });
        if (arg === 'customers') return makeQB({ first: { billing_mode: 'per_application', per_application_fee: '55.30' } });
        throw new Error(`unexpected direct table ${JSON.stringify(arg)}`);
      });
      customerOnAutopay.mockResolvedValue(true);
      const dispositionQB = makeQB({ first: null });
      installTransaction((arg) => {
        if (arg === 'invoices') return makeQB({ first: null });
        if (arg === 'visit_billing_dispositions') return dispositionQB;
        throw new Error(`unexpected trx table ${arg}`);
      });
      InvoiceService.createFromService.mockResolvedValue({ id: 'inv-3', total: '55.30', status: 'draft', token: 'tok', customer_id: 'cust-1' });
      await withServer(async (baseUrl) => {
        const res = await fetch(`${baseUrl}/admin/billing-recovery/ss-1/bill`, {
          method: 'POST', headers: { Authorization: 'Bearer admin', 'Content-Type': 'application/json' }, body: '{}',
        });
        expect(res.status).toBe(200);
        expect(InvoiceService.createFromService).toHaveBeenCalledWith('sr-1', expect.objectContaining({ amount: 55.3 }));
      });
    });

    test('on: refuses with "no price to invoice" — never the fee', async () => {
      process.env.GATE_STAMPED_ZERO_FREE = 'true';
      db.mockImplementation((arg) => {
        if (typeof arg === 'object' && arg.ss) return makeQB({ first: { ...BILLABLE_VISIT, estimated_price: 0, monthly_rate: '55.30' } });
        if (arg === 'customers') return makeQB({ first: { billing_mode: 'per_application', per_application_fee: '55.30' } });
        throw new Error(`unexpected direct table ${JSON.stringify(arg)}`);
      });
      customerOnAutopay.mockResolvedValue(true);
      await withServer(async (baseUrl) => {
        const res = await fetch(`${baseUrl}/admin/billing-recovery/ss-1/bill`, {
          method: 'POST', headers: { Authorization: 'Bearer admin', 'Content-Type': 'application/json' }, body: '{}',
        });
        const body = await res.json();
        expect(res.status).toBe(422);
        expect(body.error).toMatch(/no price/i);
        expect(InvoiceService.createFromService).not.toHaveBeenCalled();
      });
    });
  });

  test('a per-application visit with neither row price nor fee still 422s (no invented amount)', async () => {
    db.mockImplementation((arg) => {
      if (typeof arg === 'object' && arg.ss) return makeQB({ first: { ...BILLABLE_VISIT, estimated_price: null, monthly_rate: '55.30' } });
      if (arg === 'customers') return makeQB({ first: { billing_mode: 'per_application', per_application_fee: null } });
      throw new Error(`unexpected direct table ${JSON.stringify(arg)}`);
    });
    customerOnAutopay.mockResolvedValue(true);
    await withServer(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/admin/billing-recovery/ss-1/bill`, {
        method: 'POST', headers: { Authorization: 'Bearer admin', 'Content-Type': 'application/json' }, body: '{}',
      });
      const body = await res.json();
      expect(res.status).toBe(422);
      expect(body.error).toMatch(/no price/i);
      expect(InvoiceService.createFromService).not.toHaveBeenCalled();
    });
  });

  test('a LEGACY (no billing_mode) customer with no row price still 422s — the fee fallback is per-app only', async () => {
    db.mockImplementation((arg) => {
      if (typeof arg === 'object' && arg.ss) return makeQB({ first: { ...BILLABLE_VISIT, estimated_price: null } });
      if (arg === 'customers') return makeQB({ first: { billing_mode: null, per_application_fee: null } });
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

  test('billing a payer-billed visit is blocked (self-pay only v1)', async () => {
    db.mockImplementation((arg) => {
      if (typeof arg === 'object' && arg.ss) return makeQB({ first: BILLABLE_VISIT });
      throw new Error(`unexpected direct table ${JSON.stringify(arg)}`);
    });
    customerOnAutopay.mockResolvedValue(false);
    // The canonical resolver says an ACTIVE payer owns this visit.
    PayerService.resolveForInvoice.mockResolvedValueOnce({ payerId: 'payer-1' });
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

  test('GET /leaks surfaces per-application fee-only visits under needs_review with the fee as price', async () => {
    // Per-app follow-up rows seed estimated_price NULL by design — the
    // effective price is customers.per_application_fee, and per-app
    // customers surface (they're autopay-active BY DESIGN) but always in
    // needs_review, never as one-click leaks (Codex round-12).
    const rows = [
      { scheduled_service_id: 'ss-1', service_record_id: 'sr-1', service_type: 'Quarterly Pest Control Service', estimated_price: '129.00', prepaid_amount: '0', completed_at: '2026-06-18', customer_id: 'cust-1', first_name: 'Tyler', last_name: 'Levin', monthly_rate: '0', waveguard_tier: null },
      { scheduled_service_id: 'ss-5', service_record_id: 'sr-5', service_type: 'Pest Control', estimated_price: null, prepaid_amount: null, completed_at: '2026-06-12', customer_id: 'cust-5', first_name: 'Taras', last_name: 'Malyshev', monthly_rate: '55.30', waveguard_tier: null, billing_mode: 'per_application', per_application_fee: '55.30' },
    ];
    db.schema = { hasColumn: jest.fn().mockResolvedValue(true), hasTable: jest.fn().mockResolvedValue(false) };
    db.mockImplementation((arg) => {
      if (typeof arg === 'object' && arg.ss) return makeQB({ rows });
      throw new Error(`unexpected table ${JSON.stringify(arg)}`);
    });
    await withServer(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/admin/billing-recovery/leaks?days=90`, { headers: { Authorization: 'Bearer admin' } });
      const body = await res.json();
      expect(res.status).toBe(200);
      expect(body.leaks.map((r) => r.customer)).toEqual(['Tyler Levin']);
      const perApp = body.needs_review.find((r) => r.customer === 'Taras Malyshev');
      expect(perApp).toBeDefined();
      expect(perApp.price).toBe(55.3);
      expect(perApp.billing_mode).toBe('per_application');
    });
    delete db.schema;
  });

  test('GET /leaks includes a status-only completion (no service_records row) as completed_no_service_record, not billable', async () => {
    const rows = [
      { scheduled_service_id: 'ss-1', service_record_id: 'sr-1', service_type: 'Quarterly Pest Control Service', estimated_price: '129.00', prepaid_amount: '0', completed_at: '2026-06-18', customer_id: 'cust-1', first_name: 'Tyler', last_name: 'Levin', monthly_rate: '0', waveguard_tier: null },
      { scheduled_service_id: 'ss-9', service_record_id: null, service_type: 'Pest Control', estimated_price: '99.00', prepaid_amount: '0', completed_at: '2026-06-17', scheduled_date: '2026-06-17', customer_id: 'cust-9', first_name: 'Nora', last_name: 'Quill', monthly_rate: '0', waveguard_tier: null },
    ];
    let qb;
    db.mockImplementation((arg) => {
      if (typeof arg === 'object' && arg.ss) { qb = makeQB({ rows }); return qb; }
      throw new Error(`unexpected table ${JSON.stringify(arg)}`);
    });
    await withServer(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/admin/billing-recovery/leaks?days=90`, { headers: { Authorization: 'Bearer admin' } });
      const body = await res.json();
      expect(res.status).toBe(200);
      // The SQL predicate admits sr-less rows whose scheduled_services row is completed.
      const predicates = qb.whereRaw.mock.calls.map((c) => c[0]);
      expect(predicates).toEqual(expect.arrayContaining([
        expect.stringContaining("sr.id IS NULL AND ss.status = 'completed'"),
      ]));
      expect(predicates).not.toEqual(expect.arrayContaining(["sr.status = 'completed'"]));
      const statusOnly = body.leaks.find((r) => r.scheduled_service_id === 'ss-9');
      expect(statusOnly).toBeDefined();
      expect(statusOnly.leak_kind).toBe('completed_no_service_record');
      expect(statusOnly.billable).toBe(false);
      expect(statusOnly.scheduled_date).toBe('2026-06-17');
      expect(body.leaks.find((r) => r.scheduled_service_id === 'ss-1').leak_kind).toBe('uninvoiced');
      expect(body.summary.leak_visits).toBe(2);
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

describe('billing-recovery-bill billVisit (shared with the IB closeout repair)', () => {
  beforeEach(() => { jest.clearAllMocks(); });

  test('an approved amount that no longer matches the in-lock price refuses and mints nothing', async () => {
    const { billVisit } = require('../services/billing-recovery-bill');
    db.mockImplementation((arg) => {
      if (typeof arg === 'object' && arg.ss) return makeQB({ first: { ...BILLABLE_VISIT, estimated_price: '149.00' } });
      return makeQB({ first: null });
    });
    customerOnAutopay.mockResolvedValue(false);
    installTransaction((arg) => {
      if (arg === 'invoices' || arg === 'visit_billing_dispositions') return makeQB({ first: null });
      throw new Error('fall through');
    });
    const result = await billVisit('ss-1', { actorId: 'admin-1', expectedPrice: 129 });
    expect(result).toEqual(expect.objectContaining({ ok: false, status: 409, error: expect.stringMatching(/\$129\.00 → \$149\.00/) }));
    expect(db.transaction).toHaveBeenCalled();
    expect(InvoiceService.createFromService).not.toHaveBeenCalled();
  });
});

describe('billVisit refuseDepositCredit', () => {
  beforeEach(() => { jest.clearAllMocks(); });

  test('passes the refusal to the locked mint and maps its 409 to a refusal', async () => {
    const { billVisit } = require('../services/billing-recovery-bill');
    db.mockImplementation((arg) => {
      if (typeof arg === 'object' && arg.ss) return makeQB({ first: BILLABLE_VISIT });
      return makeQB({ first: null });
    });
    customerOnAutopay.mockResolvedValue(false);
    installTransaction((arg) => {
      if (arg === 'invoices' || arg === 'visit_billing_dispositions') return makeQB({ first: null });
      throw new Error('fall through');
    });
    const refusal = Object.assign(new Error('An estimate deposit credit would apply to this invoice — bill it from Billing Recovery.'), { status: 409 });
    InvoiceService.createFromService.mockRejectedValue(refusal);
    const result = await billVisit('ss-1', { expectedPrice: 129, refuseDepositCredit: true });
    expect(InvoiceService.createFromService).toHaveBeenCalledWith('sr-1', expect.objectContaining({ refuseDepositCredit: true }));
    expect(result).toEqual(expect.objectContaining({ ok: false, status: 409, error: expect.stringMatching(/deposit credit/) }));
  });
});

describe('billVisit fails closed on unverifiable coverage (GH Codex P1)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    db.schema = { hasColumn: jest.fn().mockResolvedValue(true), hasTable: jest.fn().mockResolvedValue(false) };
  });

  test('an autopay lookup error refuses instead of reading as "not on autopay"', async () => {
    const { billVisit } = require('../services/billing-recovery-bill');
    db.mockImplementation((arg) => {
      if (typeof arg === 'object' && arg.ss) return makeQB({ first: BILLABLE_VISIT });
      return makeQB({ first: null });
    });
    customerOnAutopay.mockRejectedValue(new Error('payment_methods read failed'));
    installTransaction((arg) => {
      if (arg === 'invoices' || arg === 'visit_billing_dispositions') return makeQB({ first: null });
      throw new Error('fall through');
    });
    const result = await billVisit('ss-1', { expectedPrice: 129 });
    expect(result).toEqual(expect.objectContaining({ ok: false, status: 503, error: expect.stringMatching(/Autopay status could not be verified/) }));
    expect(InvoiceService.createFromService).not.toHaveBeenCalled();
  });

  test('a pre-migration schema skips the billing-mode read instead of erroring inside the transaction', async () => {
    const { assessVisitBillable } = require('../services/billing-recovery-bill');
    db.schema = { hasColumn: jest.fn(async (table, col) => !(table === 'customers' && col === 'billing_mode')), hasTable: jest.fn().mockResolvedValue(false) };
    const customersRead = jest.fn();
    db.mockImplementation((arg) => {
      if (typeof arg === 'object' && arg.ss) return makeQB({ first: BILLABLE_VISIT });
      if (arg === 'customers') { customersRead(); return makeQB({ first: null }); }
      return makeQB({ first: null });
    });
    customerOnAutopay.mockResolvedValue(false);
    const assessed = await assessVisitBillable('ss-1');
    expect(customersRead).not.toHaveBeenCalled();
    expect(assessed).toEqual(expect.objectContaining({ ok: true, price: 129, dueDate: '2026-04-14' }));
  });

  test('a caller-pinned service record narrows the visit read to that record', async () => {
    const { assessVisitBillable } = require('../services/billing-recovery-bill');
    const qb = makeQB({ first: BILLABLE_VISIT });
    db.mockImplementation((arg) => (typeof arg === 'object' && arg.ss ? qb : makeQB({ first: null })));
    customerOnAutopay.mockResolvedValue(false);
    await assessVisitBillable('ss-1', { serviceRecordId: 'sr-1' });
    expect(qb.where).toHaveBeenCalledWith('sr.id', 'sr-1');
  });
});

describe('billVisit — canonical payer, visit status, card hold (GH Codex r2)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    db.schema = { hasColumn: jest.fn().mockResolvedValue(true), hasTable: jest.fn().mockResolvedValue(false) };
    customerOnAutopay.mockResolvedValue(false);
  });

  test('payer ownership is the canonical resolver (a deactivated payer resolves self-pay and bills); an unreadable payer refuses', async () => {
    const { assessVisitBillable } = require('../services/billing-recovery-bill');
    db.mockImplementation((arg) => (typeof arg === 'object' && arg.ss ? makeQB({ first: BILLABLE_VISIT }) : makeQB({ first: null })));
    PayerService.resolveForInvoice.mockResolvedValueOnce({ payerId: null });
    await expect(assessVisitBillable('ss-1')).resolves.toEqual(expect.objectContaining({ ok: true }));
    expect(PayerService.resolveForInvoice).toHaveBeenCalledWith(expect.objectContaining({ customerId: 'cust-1', scheduledServiceId: 'ss-1', throwOnError: true }));
    PayerService.resolveForInvoice.mockRejectedValueOnce(new Error('payers read failed'));
    await expect(assessVisitBillable('ss-1')).resolves.toEqual(expect.objectContaining({ ok: false, status: 503 }));
  });

  test('requireCompletedVisit refuses a completed record on a visit that is no longer completed', async () => {
    const { assessVisitBillable } = require('../services/billing-recovery-bill');
    db.mockImplementation((arg) => (typeof arg === 'object' && arg.ss ? makeQB({ first: { ...BILLABLE_VISIT, ss_status: 'cancelled' } }) : makeQB({ first: null })));
    await expect(assessVisitBillable('ss-1', { requireCompletedVisit: true }))
      .resolves.toEqual(expect.objectContaining({ ok: false, status: 409, error: expect.stringMatching(/cancelled/) }));
    // The Bill button (no flag) keeps its existing behavior.
    await expect(assessVisitBillable('ss-1')).resolves.toEqual(expect.objectContaining({ ok: true }));
  });

  test('refuseLiveCardHold refuses under the lock and mints nothing', async () => {
    const { billVisit } = require('../services/billing-recovery-bill');
    db.mockImplementation((arg) => {
      if (typeof arg === 'object' && arg.ss) return makeQB({ first: { ...BILLABLE_VISIT, ss_status: 'completed' } });
      if (arg === 'estimate_card_holds') return makeQB({ first: { id: 'hold-1', status: 'held' } });
      return makeQB({ first: null });
    });
    installTransaction((arg) => {
      if (arg === 'invoices' || arg === 'visit_billing_dispositions') return makeQB({ first: null });
      throw new Error('fall through');
    });
    const result = await billVisit('ss-1', { expectedPrice: 129, requireCompletedVisit: true, refuseLiveCardHold: true });
    expect(result).toEqual(expect.objectContaining({ ok: false, status: 409, error: expect.stringMatching(/card hold/) }));
    expect(InvoiceService.createFromService).not.toHaveBeenCalled();
  });
});

describe('previewBillVisit / expectedTotal (exact total on the IB card)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    db.schema = { hasColumn: jest.fn().mockResolvedValue(true), hasTable: jest.fn().mockResolvedValue(false) };
    customerOnAutopay.mockResolvedValue(false);
  });

  function installNested(dispositionQB) {
    // Outer preview transaction → billVisit's own (nested) transaction.
    db.transaction = jest.fn(async (cb) => {
      const trx = (arg) => {
        if (arg === 'invoices') return makeQB({ first: null });
        if (arg === 'visit_billing_dispositions') return dispositionQB;
        return db(arg);
      };
      trx.raw = jest.fn((sql) => (typeof sql === 'string' ? sql : Promise.resolve()));
      trx.schema = db.schema;
      trx.transaction = (inner) => inner(trx);
      return cb(trx);
    });
  }

  test('previewBillVisit runs the real mint and always rolls it back, reporting the exact total', async () => {
    const { previewBillVisit } = require('../services/billing-recovery-bill');
    db.mockImplementation((arg) => (typeof arg === 'object' && arg.ss ? makeQB({ first: { ...BILLABLE_VISIT, ss_status: 'completed' } }) : makeQB({ first: null })));
    const dispositionQB = makeQB({ first: null });
    installNested(dispositionQB);
    InvoiceService.createFromService.mockResolvedValue({ customer_id: 'cust-1', id: 'inv-p', total: '138.03', subtotal: '129.00', discount_amount: '0', tax_amount: '9.03' });
    let rolledBack = false;
    const outer = db.transaction;
    db.transaction = jest.fn(async (cb) => {
      try { return await outer(cb); } catch (err) { rolledBack = true; throw err; }
    });
    const preview = await previewBillVisit('ss-1', { expectedPrice: 129 });
    expect(preview).toEqual({ ok: true, total: 138.03, subtotal: 129, discountAmount: 0, taxAmount: 9.03, dueDate: '2026-04-14' });
    expect(rolledBack).toBe(true); // the outer transaction threw its rollback sentinel
    expect(InvoiceService.createFromService).toHaveBeenCalledWith('sr-1', expect.objectContaining({ database: expect.anything() }));
  });

  test('billVisit refuses (and rolls back) when the minted total differs from the approved total', async () => {
    const { billVisit } = require('../services/billing-recovery-bill');
    db.mockImplementation((arg) => (typeof arg === 'object' && arg.ss ? makeQB({ first: BILLABLE_VISIT }) : makeQB({ first: null })));
    const dispositionQB = makeQB({ first: null });
    installTransaction((arg) => {
      if (arg === 'invoices') return makeQB({ first: null });
      if (arg === 'visit_billing_dispositions') return dispositionQB;
      throw new Error('fall through');
    });
    InvoiceService.createFromService.mockResolvedValue({ customer_id: 'cust-1', id: 'inv-x', total: '140.00' });
    const result = await billVisit('ss-1', { expectedPrice: 129, expectedTotal: 138.03 });
    expect(result).toEqual(expect.objectContaining({ ok: false, status: 409, error: expect.stringMatching(/\$138\.03 → \$140\.00/) }));
    expect(dispositionQB.insert).not.toHaveBeenCalled();
  });
});

describe('billVisit pins self-pay through the mint (GH Codex r3)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    db.schema = { hasColumn: jest.fn().mockResolvedValue(true), hasTable: jest.fn().mockResolvedValue(false) };
    customerOnAutopay.mockResolvedValue(false);
  });

  test('an invoice that comes out payer-billed (Bill-To assigned mid-mint) refuses and records no disposition', async () => {
    const { billVisit } = require('../services/billing-recovery-bill');
    db.mockImplementation((arg) => (typeof arg === 'object' && arg.ss ? makeQB({ first: BILLABLE_VISIT }) : makeQB({ first: null })));
    const dispositionQB = makeQB({ first: null });
    installTransaction((arg) => {
      if (arg === 'invoices') return makeQB({ first: null });
      if (arg === 'visit_billing_dispositions') return dispositionQB;
      throw new Error('fall through');
    });
    InvoiceService.createFromService.mockResolvedValue({ customer_id: 'cust-1', id: 'inv-p', total: '129.00', payer_id: 'payer-1' });
    const result = await billVisit('ss-1', { expectedPrice: 129 });
    expect(result).toEqual(expect.objectContaining({ ok: false, status: 409, error: expect.stringMatching(/third-party billed/) }));
    expect(dispositionQB.insert).not.toHaveBeenCalled();
  });

  test('the completion record join requires the visit\'s own customer', async () => {
    const { assessVisitBillable } = require('../services/billing-recovery-bill');
    const qb = makeQB({ first: BILLABLE_VISIT });
    db.mockImplementation((arg) => (typeof arg === 'object' && arg.ss ? qb : makeQB({ first: null })));
    await assessVisitBillable('ss-1');
    const [, joinFn] = qb.leftJoin.mock.calls[0];
    const on = jest.fn(() => ({ andOn: andOnSpy }));
    const andOnSpy = jest.fn();
    joinFn.call({ on });
    expect(on).toHaveBeenCalledWith('sr.scheduled_service_id', '=', 'ss.id');
    expect(andOnSpy).toHaveBeenCalledWith('sr.customer_id', '=', 'ss.customer_id');
  });
});

describe('billVisit — customer pinned through the mint; Auto Pay serialized (GH Codex r4)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    db.schema = { hasColumn: jest.fn().mockResolvedValue(true), hasTable: jest.fn().mockResolvedValue(false) };
    customerOnAutopay.mockResolvedValue(false);
  });

  test('an invoice minted for a different customer (merge mid-mint) refuses and records no disposition', async () => {
    const { billVisit } = require('../services/billing-recovery-bill');
    db.mockImplementation((arg) => (typeof arg === 'object' && arg.ss ? makeQB({ first: BILLABLE_VISIT }) : makeQB({ first: null })));
    const dispositionQB = makeQB({ first: null });
    installTransaction((arg) => {
      if (arg === 'invoices') return makeQB({ first: null });
      if (arg === 'visit_billing_dispositions') return dispositionQB;
      throw new Error('fall through');
    });
    InvoiceService.createFromService.mockResolvedValue({ id: 'inv-m', total: '129.00', customer_id: 'cust-OTHER' });
    const result = await billVisit('ss-1', { expectedPrice: 129 });
    expect(result).toEqual(expect.objectContaining({ ok: false, status: 409, error: expect.stringMatching(/changed customers/) }));
    expect(dispositionQB.insert).not.toHaveBeenCalled();
  });

  test('the customer row is locked (FOR UPDATE) after the mint lock and before the coverage assessment', async () => {
    const { billVisit } = require('../services/billing-recovery-bill');
    const order = [];
    const customerLockQB = makeQB({ first: { id: 'cust-1' } });
    customerLockQB.forUpdate = jest.fn(() => { order.push('customer_lock'); return customerLockQB; });
    db.mockImplementation((arg) => (typeof arg === 'object' && arg.ss ? makeQB({ first: BILLABLE_VISIT }) : makeQB({ first: null })));
    customerOnAutopay.mockImplementation(async () => { order.push('autopay_check'); return false; });
    installTransaction((arg) => {
      if (arg === 'scheduled_services') return makeQB({ first: { customer_id: 'cust-1' } });
      if (arg === 'customers') return customerLockQB;
      if (arg === 'invoices') return makeQB({ first: null });
      if (arg === 'visit_billing_dispositions') return makeQB({ first: null });
      throw new Error('fall through');
    });
    InvoiceService.createFromService.mockResolvedValue({ id: 'inv-1', total: '129.00', customer_id: 'cust-1' });
    await billVisit('ss-1', { expectedPrice: 129 });
    expect(order.indexOf('customer_lock')).toBeGreaterThanOrEqual(0);
    expect(order.indexOf('customer_lock')).toBeLessThan(order.indexOf('autopay_check'));
  });
});

describe('billVisit — owner re-checked after the lock; breakdown pinned (GH Codex r5)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    db.schema = { hasColumn: jest.fn().mockResolvedValue(true), hasTable: jest.fn().mockResolvedValue(false) };
    customerOnAutopay.mockResolvedValue(false);
  });

  test('a merge between the owner read and the lock refuses (the locked row is not the current owner)', async () => {
    const { billVisit } = require('../services/billing-recovery-bill');
    db.mockImplementation((arg) => (typeof arg === 'object' && arg.ss ? makeQB({ first: BILLABLE_VISIT }) : makeQB({ first: null })));
    installTransaction((arg) => {
      if (arg === 'scheduled_services') return makeQB({ first: { customer_id: 'cust-OLD' } });
      if (arg === 'customers') return makeQB({ first: { id: 'cust-OLD' } });
      throw new Error('fall through');
    });
    const result = await billVisit('ss-1', { expectedPrice: 129 });
    expect(result).toEqual(expect.objectContaining({ ok: false, status: 409, error: expect.stringMatching(/changed customers/) }));
    expect(InvoiceService.createFromService).not.toHaveBeenCalled();
  });

  test('a different subtotal/discount/tax split at the same total refuses and records no disposition', async () => {
    const { billVisit } = require('../services/billing-recovery-bill');
    db.mockImplementation((arg) => (typeof arg === 'object' && arg.ss ? makeQB({ first: BILLABLE_VISIT }) : makeQB({ first: null })));
    const dispositionQB = makeQB({ first: null });
    installTransaction((arg) => {
      if (arg === 'invoices') return makeQB({ first: null });
      if (arg === 'visit_billing_dispositions') return dispositionQB;
      throw new Error('fall through');
    });
    InvoiceService.createFromService.mockResolvedValue({ id: 'inv-b', customer_id: 'cust-1', total: '138.03', subtotal: '140.00', discount_amount: '11.00', tax_amount: '9.03' });
    const result = await billVisit('ss-1', { expectedPrice: 129, expectedTotal: 138.03, expectedBreakdown: { subtotal: 129, discount: 0, tax: 9.03 } });
    expect(result).toEqual(expect.objectContaining({ ok: false, status: 409, error: expect.stringMatching(/line items, discounts or tax changed/) }));
    expect(dispositionQB.insert).not.toHaveBeenCalled();
  });
});
