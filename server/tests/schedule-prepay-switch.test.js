/**
 * GET /admin/schedule/annual-prepay-preview — the ON-SITE SWITCH lane
 * (GATE_ONSITE_PREPAY_SWITCH): a customer who accepted pay-per-application
 * inside the estimate changes their mind at the visit.
 *
 * The preview otherwise REFUSES an estimate-origin series (the accept flow
 * owns that choice). This lane is the narrow exception — only once the
 * estimate is actually accepted, because then the quote's own prepay door is
 * closed. Two money properties are load-bearing and tested here:
 *
 *  1. `supersedes` reports the per-application invoice the accept already
 *     minted, so the caller can void it after the prepay settles (owner
 *     ruling 2026-08-12: the $99 setup fee is waived on the switch). Anything
 *     that makes voiding the wrong move — money collected, credit applied, a
 *     third-party payer, another term's invoice — refuses the whole switch
 *     instead of quietly leaving AR behind.
 *  2. `setupFee` is derived from the superseded invoice's own line items,
 *     never assumed from the plan class. No superseded fee ⇒ no waiver claim.
 */
jest.mock('../models/db', () => {
  const dbFn = jest.fn();
  dbFn.transaction = jest.fn();
  dbFn.fn = { now: () => 'NOW' };
  return dbFn;
});
jest.mock('../services/logger', () => ({
  info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn(),
}));
jest.mock('../middleware/admin-auth', () => ({
  adminAuthenticate: (req, _res, next) => { req.techRole = 'admin'; return next(); },
  requireAdmin: (_req, _res, next) => next(),
  requireTechOrAdmin: (_req, _res, next) => next(),
}));
const mockResolveForInvoice = jest.fn(async () => ({ payerId: null }));
jest.mock('../services/payer', () => ({
  resolveForInvoice: (...args) => mockResolveForInvoice(...args),
}));

// feature-gates snapshots process.env at require time. This file exercises
// the switch lane ALONE — GATE_PREPAY_ON_BOOK stays off, which also proves
// the switch gate admits committed previews without opening the pre-save
// draft probe.
process.env.GATE_ONSITE_PREPAY_SWITCH = 'true';
delete process.env.GATE_PREPAY_ON_BOOK;

const express = require('express');
const db = require('../models/db');
const router = require('../routes/admin-schedule');

const { etDateString, addETDays } = require('../utils/datetime-et');
const FUTURE_DATE = etDateString(addETDays(new Date(), 90));

// The shape the estimate converter leaves behind for a per-application
// accept: a quarterly series at $128/visit, all rows carrying the estimate.
const ACCEPTED_SERIES_VISIT = {
  id: 'svc-1',
  customer_id: 'cust-1',
  service_type: 'Quarterly Pest Control',
  estimated_price: 128,
  scheduled_date: FUTURE_DATE,
  window_start: '15:00',
  recurring_pattern: 'quarterly',
  recurring_interval_days: 90,
  recurring_parent_id: null,
  skip_weekends: false,
  recurring_ongoing: false,
  booster_months: null,
  source_estimate_id: 'est-1',
};

// The accept-minted invoice: WaveGuard setup fee + first application.
const ACCEPT_INVOICE = {
  id: 'inv-1',
  invoice_number: 'WPC-2026-0345',
  status: 'draft',
  total: '227.00',
  credit_applied: '0.00',
  paid_at: null,
  sent_at: null,
  stripe_payment_intent_id: null,
  payer_id: null,
  annual_prepay_term_id: null,
  line_items: [
    { description: 'WaveGuard Membership — one-time setup fee', quantity: 1, unit_price: 99, amount: 99 },
    { description: 'First service application', quantity: 1, unit_price: 128, amount: 128 },
  ],
};

// admin-schedule is a large module — the first require inside a test can
// outrun jest's 5s default on a cold cache.
jest.setTimeout(30000);

// `null` (never undefined) is the "row not found" sentinel: an undefined
// value would re-trigger the destructuring default and hand the test the
// happy-path row it was trying to remove.
function stubTables({
  customer = { id: 'cust-1', property_type: 'residential' },
  estimate = { id: 'est-1', status: 'accepted', accepted_at: '2026-08-10T14:40:05.527Z' },
  visit = ACCEPTED_SERIES_VISIT,
  invoices = [ACCEPT_INVOICE],
  term = undefined,
  addonCount = 0,
  seriesCount = 4,
} = {}) {
  db.mockImplementation((table) => {
    const q = {};
    let isCount = false;
    q.where = jest.fn(() => q);
    q.whereNull = jest.fn(() => q);
    q.whereNotIn = jest.fn(() => q);
    q.whereIn = jest.fn(() => q);
    q.orderBy = jest.fn(() => q);
    q.count = jest.fn(() => { isCount = true; return q; });
    q.select = jest.fn(async () => {
      if (table === 'invoices') {
        if (invoices === 'throw') throw new Error('invoice read failed');
        return invoices;
      }
      return [];
    });
    q.first = jest.fn(async () => {
      if (table === 'customers') return customer;
      if (table === 'estimates') {
        if (estimate === 'throw') throw new Error('estimate read failed');
        return estimate || undefined;
      }
      if (table === 'scheduled_service_addons') return { n: addonCount };
      if (table === 'scheduled_services') return isCount ? { n: seriesCount } : visit;
      return term;
    });
    return q;
  });
}

async function preview(params = {}, useRouter = router) {
  const app = express();
  app.use(express.json());
  app.use('/admin/schedule', useRouter);
  app.use((err, _req, res, _next) => res.status(err.status || 500).json({ error: err.message }));
  const server = app.listen(0);
  try {
    const qs = new URLSearchParams({ scheduledServiceId: 'svc-1', ...params });
    const res = await fetch(`http://127.0.0.1:${server.address().port}/admin/schedule/annual-prepay-preview?${qs}`);
    return { status: res.status, body: await res.json() };
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

describe('on-site prepay switch — the accepted-estimate exception', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockResolveForInvoice.mockResolvedValue({ payerId: null });
    stubTables();
  });

  test('an ACCEPTED per-application series can be switched, priced at visits × per-visit', async () => {
    const { status, body } = await preview();
    expect(status).toBe(200);
    expect(body.eligible).toBe(true);
    expect(body.blockReason).toBeNull();
    expect(body.visitsPerYear).toBe(4);
    expect(body.perVisit).toBe(128);
    // 4 × $128 — the fee waiver is the pest incentive, so no percentage off.
    expect(body.prepayTotal).toBe(512);
    expect(body.discountAmount).toBe(0);
    expect(body.mintPayload.amount).toBe(512);
    expect(body.mintPayload.note).toMatch(/switched from per application/i);
  });

  test('reports the accept-minted invoice as superseded, with its real lines', async () => {
    const { body } = await preview();
    expect(body.supersedes).toHaveLength(1);
    expect(body.supersedes[0]).toMatchObject({
      id: 'inv-1',
      invoiceNumber: 'WPC-2026-0345',
      status: 'draft',
      total: 227,
    });
    expect(body.supersedes[0].lines.map((l) => l.description)).toEqual([
      'WaveGuard Membership — one-time setup fee',
      'First service application',
    ]);
  });

  test('the waived setup fee comes off the superseded invoice, not a constant', async () => {
    const { body } = await preview();
    expect(body.setupFee).toEqual({ amount: 99, waivedWithPrepay: true });
  });

  test('no setup-fee line on the superseded invoice ⇒ no waiver claim', async () => {
    stubTables({
      invoices: [{ ...ACCEPT_INVOICE, total: '128.00', line_items: [{ description: 'First service application', amount: 128 }] }],
    });
    const { body } = await preview();
    expect(body.eligible).toBe(true);
    expect(body.setupFee).toBeNull();
    expect(body.supersedes).toHaveLength(1);
  });

  test('a still-OPEN quote keeps the original refusal — accept it as prepay there', async () => {
    stubTables({ estimate: { id: 'est-1', status: 'sent', accepted_at: null } });
    const { body } = await preview();
    expect(body.eligible).toBe(false);
    expect(body.blockReason).toMatch(/handled by the linked quote/i);
  });

  test('an unreadable estimate refuses rather than assuming the accept happened', async () => {
    stubTables({ estimate: 'throw' });
    const { body } = await preview();
    expect(body.eligible).toBe(false);
    expect(body.blockReason).toMatch(/couldn’t confirm the linked quote/i);
  });

  test('a missing estimate row refuses (fail closed)', async () => {
    stubTables({ estimate: null });
    const { body } = await preview();
    expect(body.eligible).toBe(false);
    expect(body.blockReason).toMatch(/handled by the linked quote/i);
  });
});

describe('on-site prepay switch — invoices that must not be superseded', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockResolveForInvoice.mockResolvedValue({ payerId: null });
  });

  test('money already collected refuses the switch (that is a refund decision)', async () => {
    stubTables({ invoices: [{ ...ACCEPT_INVOICE, status: 'paid', paid_at: '2026-08-11T12:00:00Z' }] });
    const { body } = await preview();
    expect(body.eligible).toBe(false);
    expect(body.blockReason).toMatch(/already paid/i);
  });

  test('an account-credit-settled invoice refuses', async () => {
    stubTables({ invoices: [{ ...ACCEPT_INVOICE, status: 'prepaid' }] });
    const { body } = await preview();
    expect(body.eligible).toBe(false);
    expect(body.blockReason).toMatch(/settled by account credit/i);
  });

  test('applied account credit refuses — voiding would unwind the credit silently', async () => {
    stubTables({ invoices: [{ ...ACCEPT_INVOICE, credit_applied: '49.00' }] });
    const { body } = await preview();
    expect(body.eligible).toBe(false);
    expect(body.blockReason).toMatch(/account credit applied/i);
  });

  // Codex P0, this PR: the void happens after the tender, so a DELIVERED
  // invoice is payable by the customer for the whole collection window.
  test('an invoice already sent to the customer refuses — it could be paid mid-tender', async () => {
    stubTables({ invoices: [{ ...ACCEPT_INVOICE, status: 'sent', sent_at: '2026-08-11T12:00:00Z' }] });
    const { body } = await preview();
    expect(body.eligible).toBe(false);
    expect(body.blockReason).toMatch(/already gone out to the customer/i);
  });

  test('a draft that was somehow delivered (sent_at set) still refuses', async () => {
    stubTables({ invoices: [{ ...ACCEPT_INVOICE, sent_at: '2026-08-11T12:00:00Z' }] });
    const { body } = await preview();
    expect(body.eligible).toBe(false);
    expect(body.blockReason).toMatch(/already gone out to the customer/i);
  });

  test('an invoice carrying a PaymentIntent refuses — a payment is already in flight', async () => {
    stubTables({ invoices: [{ ...ACCEPT_INVOICE, stripe_payment_intent_id: 'pi_123' }] });
    const { body } = await preview();
    expect(body.eligible).toBe(false);
    expect(body.blockReason).toMatch(/already gone out to the customer/i);
  });

  test('a payer-billed invoice refuses', async () => {
    stubTables({ invoices: [{ ...ACCEPT_INVOICE, payer_id: 'payer-1' }] });
    const { body } = await preview();
    expect(body.eligible).toBe(false);
    expect(body.blockReason).toMatch(/third-party payer/i);
  });

  test("another term's prepay invoice refuses instead of being voided", async () => {
    stubTables({ invoices: [{ ...ACCEPT_INVOICE, annual_prepay_term_id: 'term-9' }] });
    const { body } = await preview();
    expect(body.eligible).toBe(false);
    expect(body.blockReason).toMatch(/already has an annual prepay invoice/i);
  });

  test('a void/cancelled invoice is ignored, not superseded', async () => {
    stubTables({ invoices: [{ ...ACCEPT_INVOICE, status: 'void' }] });
    const { body } = await preview();
    expect(body.eligible).toBe(true);
    expect(body.supersedes).toEqual([]);
    expect(body.setupFee).toBeNull();
  });

  test('an unreadable invoice read refuses rather than switching blind', async () => {
    stubTables({ invoices: 'throw' });
    const { body } = await preview();
    expect(body.eligible).toBe(false);
    expect(body.blockReason).toMatch(/couldn’t confirm what this visit is already invoiced for/i);
  });
});

describe('on-site prepay switch — gate surface', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockResolveForInvoice.mockResolvedValue({ payerId: null });
    stubTables();
  });

  test('the switch gate does NOT open the pre-save draft probe', async () => {
    const { status } = await preview({
      scheduledServiceId: '',
      customerId: 'cust-1',
      serviceType: 'Quarterly Pest Control',
      price: '128',
      cadence: 'quarterly',
    });
    expect(status).toBe(404);
  });

  test('availability reports the switch lane separately from prepay-on-book', async () => {
    const app = express();
    app.use('/admin/schedule', router);
    const server = app.listen(0);
    try {
      const res = await fetch(`http://127.0.0.1:${server.address().port}/admin/schedule/annual-prepay-availability`);
      expect(await res.json()).toEqual({ enabled: false, switchEnabled: true });
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });

  // The BOTH-GATES-OFF case lives in schedule-prepay-switch-dark.test.js:
  // feature-gates snapshots env at require time, so proving the dark surface
  // needs its own module registry, not a resetModules mid-suite (which drops
  // the db mock this file's router is holding).
});
