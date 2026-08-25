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
  dbFn.raw = jest.fn((sql, bindings) => ({ sql, bindings }));
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
const mockVoidInvoice = jest.fn(async () => ({ status: 'void' }));
const mockCreateInvoice = jest.fn(async () => ({ id: 'inv-new', invoice_number: 'WPC-2026-0401' }));
const mockSendInvoice = jest.fn(async () => ({ ok: true }));
jest.mock('../services/invoice', () => ({
  // Real shared base-application identity (PR #3476) — the undo path
  // classifies live-invoice lines with it.
  lineIsBaseApplication: (li) => /_primary$/.test(String(li?.client_id || ''))
    || /^first (service )?application$/i.test(String(li?.description || '').trim()),
  voidInvoice: (...args) => mockVoidInvoice(...args),
  create: (...args) => mockCreateInvoice(...args),
  sendViaSMSAndEmail: (...args) => mockSendInvoice(...args),
  prepaySwitchRestoreMarker: (id) => '[prepay-switch-restore:' + id + ']',
  prepaySwitchSupersededByMarker: (id) => '[prepay-switch-superseded-by:' + id + ']',
  stripPrepaySwitchSupersededMarkers: (notes) => String(notes || '').replace(/\n?\[prepay-switch-superseded-by:[^\]]+\]/g, ''),
  // The undo asserts overlap on the date this returns; the real derivation
  // (visit date → accept-series fallback) is unit-tested in
  // invoice-prepay-switch-restore.test.js.
  prepaySwitchRestoreAssertDate: (...args) => mockRestoreAssertDate(...args),
}));
// The atomic switch borrows the Customer 360 advisory-lock + overlap assert;
// the real admin-customers module is far too heavy for this harness.
const mockLockOverlap = jest.fn(async () => {});
const mockRestoreAssertDate = jest.fn();
const mockReconAssert = jest.fn(async () => undefined);
jest.mock('../services/stripe', () => ({
  assertNoInvoiceChargeReconciliationPending: (...args) => mockReconAssert(...args),
}));
jest.mock('../routes/admin-customers', () => ({
  _private: { lockAndAssertNoAnnualPrepayOverlap: (...args) => mockLockOverlap(...args) },
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
mockRestoreAssertDate.mockResolvedValue(FUTURE_DATE);

// The shape the estimate converter leaves behind for a per-application
// accept: a quarterly series at $128/visit, all rows carrying the estimate.
const ACCEPTED_SERIES_VISIT = {
  id: 'svc-1',
  status: 'on_site',
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
  notes: 'Auto-generated from accepted estimate #est-1. Customer selected pay per application — $99.00 setup fee plus first application.',
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
  // Rows reachable only by a direct id lookup (e.g. a prior prepay invoice
  // on the customer) — NOT attached to this visit, so the resolver's
  // series-scoped select must never see them.
  invoicesById = {},
  liveOnVisit = undefined,
  replacementRow = undefined,
  term = undefined,
  addonCount = 0,
  seriesCount = 4,
  rootsCount = 1,
  casResult = 1,
  recordedPayment = undefined,
  childRows = [],
} = {}) {
  stubTables.casCalls = [];
  stubTables.updates = [];
  stubTables.whereIns = [];
  db.transaction = jest.fn(async (cb) => cb(db));
  db.mockImplementation((table) => {
    const q = {};
    let isCount = false;
    // The invoices table serves four distinct reads; the stub tells them
    // apart by their WHERE shapes: the restore-marker lookup filters on
    // notes LIKE, the idempotent-retry sweep filters status='void'.
    let notesLike = false;
    let voidOnly = false;
    let whereId = null;
    let byVisit = false;
    // knex-style grouped wheres: invoke callbacks against a NEUTRAL recorder
    // that only captures whereIn nets — never the live chain, whose flags
    // (notesLike/whereId/…) must not be perturbed by group internals.
    const groupRecorder = new Proxy({}, {
      get: (_t, prop) => {
        if (prop === 'whereIn') return (col, vals) => { stubTables.whereIns.push({ table, col, vals }); return groupRecorder; };
        // Any builder method: recurse into function args, self-chain.
        return (...a) => { if (typeof a[0] === 'function') a[0].call(groupRecorder); return groupRecorder; };
      },
    });
    q.where = jest.fn((...args) => {
      if (typeof args[0] === 'function') { args[0].call(groupRecorder); return q; }
      if (args[0] === 'notes') notesLike = true;
      if (args[0] && typeof args[0] === 'object') {
        if (args[0].status === 'void') voidOnly = true;
        if (args[0].id !== undefined) whereId = args[0].id;
        if (args[0].scheduled_service_id !== undefined) byVisit = true;
      }
      return q;
    });
    q.whereNot = jest.fn((arg) => {
      // Own-term exclusion (Codex P0 r30): stub `term` serves the containment
      // probe; when it IS the excluded prepay's own term, answer nothing.
      if (arg && arg.prepay_invoice_id !== undefined) q._excludedPrepayId = arg.prepay_invoice_id;
      return q;
    });
    q.modify = jest.fn((cb) => { cb(q); return q; });
    let rootsProbe = false;
    q.whereRaw = jest.fn(() => q);
    q.whereNull = jest.fn((col) => {
      if (col === 'recurring_parent_id') rootsProbe = true;
      return q;
    });
    q.whereNotIn = jest.fn(() => q);
    q.whereIn = jest.fn((col, vals) => {
      stubTables.whereIns.push({ table, col, vals });
      return q;
    });
    q.orderBy = jest.fn(() => q);
    q.forUpdate = jest.fn(() => q);
    q.update = jest.fn(async (patch) => {
      stubTables.updates.push({ table, patch });
      // Only the CAS void counts as a retirement; the superseded-by marker
      // stamp also updates invoices but must not read as a second void.
      if (table === 'invoices' && patch && patch.status === 'void') {
        stubTables.casCalls.push(true);
        return casResult;
      }
      return 1;
    });
    q.insert = jest.fn(async () => [{}]);
    q.count = jest.fn(() => { isCount = true; return q; });
    q.select = jest.fn(async () => {
      if (table === 'scheduled_services') return childRows;
      if (table === 'invoices') {
        if (invoices === 'throw') throw new Error('invoice read failed');
        // The undo's live-AR probe selects by scheduled_service_id and
        // classifies line_items (Codex P0 r19).
        if (byVisit) return liveOnVisit ? [liveOnVisit] : [];
        const rows = Array.isArray(invoices) ? invoices : [];
        return voidOnly ? rows.filter((r) => String(r.status || '').toLowerCase() === 'void') : rows;
      }
      return [];
    });
    q.first = jest.fn(async () => {
      // The undo endpoint reads ONE invoice row by id; the preview/supersede
      // path reads the set via .select() above; the marker lookup answers
      // with the stubbed replacement row.
      if (table === 'invoices') {
        if (notesLike) return replacementRow;
        if (byVisit) return liveOnVisit;
        const rows = Array.isArray(invoices) ? invoices : [];
        if (whereId != null) {
          return rows.find((r) => String(r.id) === String(whereId)) || invoicesById[String(whereId)];
        }
        return rows[0];
      }
      if (table === 'payments') return recordedPayment;
      if (table === 'customers') return customer;
      if (table === 'estimates') {
        if (estimate === 'throw') throw new Error('estimate read failed');
        return estimate || undefined;
      }
      if (table === 'scheduled_service_addons') return { n: addonCount };
      if (table === 'scheduled_services') {
        if (isCount) return { n: rootsProbe ? rootsCount : seriesCount };
        return visit;
      }
      if (table === 'annual_prepay_terms' && term && q._excludedPrepayId != null
        && String(term.prepay_invoice_id || '') === String(q._excludedPrepayId)) return undefined;
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

  test('an unrelated draft on the same visit refuses — it is not the accept invoice', async () => {
    stubTables({
      invoices: [{
        ...ACCEPT_INVOICE,
        id: 'inv-manual',
        invoice_number: 'WPC-2026-0399',
        notes: 'Manual draft for an extra bait station',
      }],
    });
    const { body } = await preview();
    expect(body.eligible).toBe(false);
    expect(body.blockReason).toMatch(/does not replace/i);
  });

  test('a second manual draft alongside the accept invoice refuses the whole switch', async () => {
    stubTables({
      invoices: [
        ACCEPT_INVOICE,
        { ...ACCEPT_INVOICE, id: 'inv-manual', invoice_number: 'WPC-2026-0399', notes: 'Manual draft' },
      ],
    });
    const { body } = await preview();
    expect(body.eligible).toBe(false);
    expect(body.blockReason).toMatch(/does not replace/i);
  });

  test('an accept invoice from a DIFFERENT estimate is not superseded', async () => {
    stubTables({
      invoices: [{ ...ACCEPT_INVOICE, notes: 'Auto-generated from accepted estimate #est-OTHER. Customer selected pay per application.' }],
    });
    const { body } = await preview();
    expect(body.eligible).toBe(false);
    expect(body.blockReason).toMatch(/does not replace/i);
  });

  test('a ledger-backed estimate deposit credit refuses — it would strand paid money', async () => {
    stubTables({
      invoices: [{
        ...ACCEPT_INVOICE,
        line_items: [
          { description: 'WaveGuard Membership — one-time setup fee', amount: 99 },
          { description: 'First service application', amount: 128 },
          { description: 'Estimate deposit', category: 'deposit_credit', amount: -49 },
        ],
      }],
    });
    const { body } = await preview();
    expect(body.eligible).toBe(false);
    expect(body.blockReason).toMatch(/estimate deposit credit/i);
  });

  test('an accept invoice with UNRECOGNIZED lines refuses — combined charges must not be voided', async () => {
    // Root-count can read 1 even when the converter combined services; the
    // invoice's own lines are the decisive proof (Codex P0 r18).
    stubTables({
      invoices: [{
        ...ACCEPT_INVOICE,
        total: '415.00',
        line_items: [
          { description: 'WaveGuard Membership — one-time setup fee', amount: 99 },
          { description: 'First service application', amount: 128 },
          { description: 'Monthly Lawn Care — first application', amount: 188 },
        ],
      }],
    });
    const { body } = await preview();
    expect(body.eligible).toBe(false);
    expect(body.blockReason).toMatch(/beyond this plan/i);
  });

  test('a MULTI-SERVICE estimate refuses — its combined accept invoice covers siblings', async () => {
    stubTables({ rootsCount: 2 });
    const { body } = await preview();
    expect(body.eligible).toBe(false);
    expect(body.blockReason).toMatch(/multi-service plan/i);
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

  test('TWO live accept-provenance invoices refuse — single-row supersede is the atomicity', async () => {
    stubTables({
      invoices: [ACCEPT_INVOICE, { ...ACCEPT_INVOICE, id: 'inv-dup', invoice_number: 'WPC-2026-0346' }],
    });
    const { body } = await preview();
    expect(body.eligible).toBe(false);
    expect(body.blockReason).toMatch(/more than one live invoice/i);
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

// ── The write endpoints ───────────────────────────────────────────────────
// POST /:id/prepay-switch is the WHOLE switch in one transaction: CAS-void
// the accept-minted draft + mint the prepay invoice and term together. The
// preview only displays; these enforce.
async function post(path, body = {}) {
  const app = express();
  app.use(express.json());
  app.use('/admin/schedule', router);
  app.use((err, _req, res, _next) => res.status(err.status || 500).json({ error: err.message }));
  const server = app.listen(0);
  try {
    const res = await fetch(`http://127.0.0.1:${server.address().port}/admin/schedule${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    return { status: res.status, body: await res.json() };
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

const AnnualPrepayRenewals = require('../services/annual-prepay-renewals');

describe('on-site prepay switch — the NON-ESTIMATE lane (prepay-on-book twin)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockResolveForInvoice.mockResolvedValue({ payerId: null });
    mockLockOverlap.mockResolvedValue(undefined);
    mockCreateInvoice.mockResolvedValue({ id: 'inv-prepay', invoice_number: 'WPC-2026-0400', token: 'tok', total: 512 });
  });

  test('a live attached invoice REFUSES the switch — nothing is safely voidable here', async () => {
    // Codex PR #3381 r1 P1: estimateId null used to skip the invoice query
    // entirely, minting the year while a checkout pre-mint stayed payable.
    const termSpy = jest.spyOn(AnnualPrepayRenewals, 'createTermForAnnualPrepay').mockResolvedValue({ id: 'term-1' });
    stubTables({
      visit: { ...ACCEPTED_SERIES_VISIT, source_estimate_id: null },
      invoices: [{ id: 'inv-premint', invoice_number: 'WPC-2026-0430', status: 'draft', notes: 'Checkout pre-mint' }],
    });
    const { status, body } = await post('/svc-1/prepay-switch');
    expect(status).toBe(409);
    expect(body.error).toMatch(/already carries WPC-2026-0430/i);
    expect(mockCreateInvoice).not.toHaveBeenCalled();
    termSpy.mockRestore();
  });

  test('the PREVIEW refuses the same live-invoice case — never an offer the POST 409s', async () => {
    stubTables({
      visit: { ...ACCEPTED_SERIES_VISIT, source_estimate_id: null },
      invoices: [{ id: 'inv-premint', invoice_number: 'WPC-2026-0430', status: 'draft', notes: 'Checkout pre-mint' }],
    });
    const { body } = await preview();
    expect(body.eligible).toBe(false);
    expect(body.blockReason).toMatch(/already carries WPC-2026-0430/i);
  });

  test('with NO attached invoices the non-estimate switch mints with supersedes: []', async () => {
    const termSpy = jest.spyOn(AnnualPrepayRenewals, 'createTermForAnnualPrepay').mockResolvedValue({ id: 'term-1' });
    stubTables({
      visit: { ...ACCEPTED_SERIES_VISIT, source_estimate_id: null },
      invoices: [],
    });
    const { status, body } = await post('/svc-1/prepay-switch');
    expect(status).toBe(201);
    expect(body.voided).toEqual([]);
    expect(body.invoice.id).toBe('inv-prepay');
    termSpy.mockRestore();
  });
});

describe('on-site prepay switch — series-wide nets and live statuses (PR r2)', () => {
  let termSpy;
  beforeEach(() => {
    jest.clearAllMocks();
    mockResolveForInvoice.mockResolvedValue({ payerId: null });
    mockLockOverlap.mockResolvedValue(undefined);
    mockCreateInvoice.mockResolvedValue({ id: 'inv-prepay', invoice_number: 'WPC-2026-0400', token: 'tok', total: 512 });
    termSpy = jest.spyOn(AnnualPrepayRenewals, 'createTermForAnnualPrepay').mockResolvedValue({ id: 'term-1' });
  });
  afterEach(() => termSpy.mockRestore());

  test('the supersede/lock net spans EVERY series child, not just the tapped visit (Codex P0)', async () => {
    stubTables({ childRows: [{ id: 'svc-child-1' }, { id: 'svc-child-2' }] });
    const { status } = await post('/svc-1/prepay-switch');
    expect(status).toBe(201);
    const invoiceNets = stubTables.whereIns.filter((w) => w.table === 'invoices' && w.col === 'scheduled_service_id');
    expect(invoiceNets.length).toBeGreaterThan(0);
    for (const net of invoiceNets) {
      expect(net.vals).toEqual(expect.arrayContaining(['svc-1', 'svc-child-1', 'svc-child-2']));
    }
  });

  test('a COMPLETED visit refuses — coverage can never stamp it (Codex P1)', async () => {
    stubTables({ visit: { ...ACCEPTED_SERIES_VISIT, status: 'completed' } });
    const { status, body } = await post('/svc-1/prepay-switch');
    expect(status).toBe(409);
    expect(body.error).toMatch(/already closed out/i);
    expect(mockCreateInvoice).not.toHaveBeenCalled();
  });
});

describe('on-site prepay switch — the atomic switch endpoint', () => {
  let termSpy;
  beforeEach(() => {
    jest.clearAllMocks();
    mockResolveForInvoice.mockResolvedValue({ payerId: null });
    mockLockOverlap.mockResolvedValue(undefined);
    // The mint's total must equal the server-quoted amount to the cent.
    mockCreateInvoice.mockResolvedValue({ id: 'inv-prepay', invoice_number: 'WPC-2026-0400', token: 'tok', total: 512 });
    termSpy = jest.spyOn(AnnualPrepayRenewals, 'createTermForAnnualPrepay')
      .mockResolvedValue({ id: 'term-1' });
    stubTables();
  });
  afterEach(() => termSpy.mockRestore());

  test('voids the draft and mints invoice + term in one transaction, all server-derived', async () => {
    const { status, body } = await post('/svc-1/prepay-switch', { amount: 1, chargeInPerson: false /* both ignored — collect-only, server-priced */ });
    expect(status).toBe(201);
    expect(body.invoice).toMatchObject({ id: 'inv-prepay', invoice_number: 'WPC-2026-0400' });
    expect(body.voided).toEqual([{ id: 'inv-1', invoiceNumber: 'WPC-2026-0345', total: 227 }]);
    // CAS void inside the trx — never the standalone voidInvoice.
    expect(stubTables.casCalls.length).toBe(1);
    expect(mockVoidInvoice).not.toHaveBeenCalled();
    // Server-derived money: $512, never the client's number.
    expect(mockCreateInvoice.mock.calls[0][0].lineItems[0].unit_price).toBe(512);
    // Term carries the estimate provenance so a refund restores per_application.
    expect(termSpy.mock.calls[0][0]).toMatchObject({
      sourceEstimateId: 'est-1',
      prepayInvoiceId: 'inv-prepay',
      coverageVisitCount: 4,
      coverageCadence: 'quarterly',
    });
    // COLLECT-ONLY: no delivery leg exists on this endpoint at all.
    expect(mockSendInvoice).not.toHaveBeenCalled();
    expect(body.delivery).toBeUndefined();
    // Overlap asserted twice: once entering the lock, once with the
    // AUTHORITATIVE recomputed term start (Codex P0 r9).
    expect(mockLockOverlap.mock.calls.length).toBeGreaterThanOrEqual(2);
    // Durable pointer from the retired row to its replacing prepay, so the
    // term-cancel sync can restore it long after this sheet is gone.
    const stamp = stubTables.updates.find((u) => u.table === 'invoices' && u.patch.notes);
    expect(String(stamp.patch.notes.bindings[1])).toContain('[prepay-switch-superseded-by:inv-prepay]');
  });

  test('a recorded payment on the draft refuses the switch — canonical money guard mirrored (Codex P0 r20)', async () => {
    stubTables({ recordedPayment: { id: 'pay-1' } });
    const { status, body } = await post('/svc-1/prepay-switch');
    expect(status).toBe(409);
    expect(body.error).toMatch(/recorded payment/i);
    expect(mockCreateInvoice).not.toHaveBeenCalled();
  });

  test('a CAS conflict (invoice changed under the lock) aborts before anything is minted', async () => {
    stubTables({ casResult: 0 });
    const { status, body } = await post('/svc-1/prepay-switch');
    expect(status).toBe(409);
    expect(body.error).toMatch(/changed while switching/i);
    expect(mockCreateInvoice).not.toHaveBeenCalled();
    expect(termSpy).not.toHaveBeenCalled();
  });

  test('a minted total that differs from the quoted total aborts the whole switch', async () => {
    mockCreateInvoice.mockResolvedValue({ id: 'inv-prepay', invoice_number: 'WPC-2026-0400', total: 561 });
    const { status, body } = await post('/svc-1/prepay-switch');
    expect(status).toBe(409);
    expect(body.error).toMatch(/did not match the quoted total/i);
    expect(termSpy).not.toHaveBeenCalled();
  });

  test('the overlap assert makes a RETRY of a committed switch a 409, never a second year', async () => {
    const overlapErr = new Error('Customer already has an annual prepay term through 2027-08-11.');
    overlapErr.annualPrepayOverlap = { error: overlapErr.message, activeTermId: 'term-1', activeTermEnd: '2027-08-11' };
    mockLockOverlap.mockRejectedValue(overlapErr);
    const { status, body } = await post('/svc-1/prepay-switch');
    expect(status).toBe(409);
    expect(body.error).toMatch(/already has an annual prepay term/i);
    expect(mockCreateInvoice).not.toHaveBeenCalled();
  });

  test('an ineligible visit refuses with the preview blockReason and mints nothing', async () => {
    stubTables({ estimate: { id: 'est-1', status: 'sent', accepted_at: null } });
    const { status, body } = await post('/svc-1/prepay-switch');
    expect(status).toBe(409);
    expect(body.error).toMatch(/handled by the linked quote/i);
    expect(mockCreateInvoice).not.toHaveBeenCalled();
  });
});

describe('on-site prepay switch — undo (put the invoice back)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockCreateInvoice.mockResolvedValue({ id: 'inv-new', invoice_number: 'WPC-2026-0401' });
    mockResolveForInvoice.mockResolvedValue({ payerId: null });
    mockLockOverlap.mockResolvedValue(undefined);
    mockReconAssert.mockReset();
    mockReconAssert.mockResolvedValue(undefined);
  });

  const VOIDED_ROW = {
    ...ACCEPT_INVOICE,
    status: 'void',
    customer_id: 'cust-1',
    scheduled_service_id: 'svc-1',
    title: 'WaveGuard Membership Setup + First Application',
    notes: `${ACCEPT_INVOICE.notes}\n[prepay-switch-superseded-by:inv-prepay]`,
  };

  const DEAD_PREPAY = { 'inv-prepay': { id: 'inv-prepay', status: 'void' } };

  test("re-mints from the VOIDED ROW's own amounts, never the request body", async () => {
    stubTables({ invoices: [VOIDED_ROW], invoicesById: DEAD_PREPAY });
    const { status, body } = await post('/svc-1/prepay-switch/undo', {
      voidedInvoiceIds: ['inv-1'],
      // A hostile/stale client amount must have no effect.
      lineItems: [{ description: 'free', unit_price: 0 }],
    });
    expect(status).toBe(200);
    expect(body.restored).toEqual([{ replacedInvoiceId: 'inv-1', invoiceId: 'inv-new', invoiceNumber: 'WPC-2026-0401' }]);
    const created = mockCreateInvoice.mock.calls[0][0];
    expect(created.lineItems).toEqual([
      { description: 'WaveGuard Membership — one-time setup fee', quantity: 1, unit_price: 99 },
      { description: 'First service application', quantity: 1, unit_price: 128 },
    ]);
    expect(created.scheduledServiceId).toBe('svc-1');
    // The idempotency anchor: a marker keyed by the voided row rides the
    // replacement's notes so a duplicated undo can never mint a second bill.
    expect(created.notes).toContain('[prepay-switch-restore:inv-1]');
    // …and it must NOT inherit the superseded-by marker (Codex P0 r11).
    expect(created.notes).not.toContain('[prepay-switch-superseded-by:');
    // Overlap asserted against the VISIT's date, not today — an aborted
    // FUTURE-start renewal restores while the current year still runs.
    expect(mockLockOverlap).toHaveBeenCalledWith(
      expect.anything(), 'cust-1', FUTURE_DATE, true,
    );
  });

  test('a duplicated undo reports the EXISTING replacement instead of minting a second bill', async () => {
    stubTables({
      invoices: [VOIDED_ROW],
      invoicesById: DEAD_PREPAY,
      replacementRow: { id: 'inv-new', invoice_number: 'WPC-2026-0401' },
    });
    const { body } = await post('/svc-1/prepay-switch/undo', { voidedInvoiceIds: ['inv-1'] });
    expect(body.restored).toEqual([{ replacedInvoiceId: 'inv-1', invoiceId: 'inv-new', invoiceNumber: 'WPC-2026-0401' }]);
    expect(mockCreateInvoice).not.toHaveBeenCalled();
  });

  test('REFUSES while a term COVERS the visit date — surfaced as a failure, under the shared lock', async () => {
    stubTables({ invoices: [VOIDED_ROW], invoicesById: DEAD_PREPAY, term: { id: 'term-live' } });
    const { body } = await post('/svc-1/prepay-switch/undo', { voidedInvoiceIds: ['inv-1'] });
    expect(body.restored).toEqual([]);
    expect(body.failed[0].error).toMatch(/would bill them twice/i);
    expect(mockCreateInvoice).not.toHaveBeenCalled();
    // Lock-only acquisition (allowOverlap=true) — containment is checked
    // against the visit date, so a FUTURE term can't park the restore
    // (Codex P0 r23).
    expect(mockLockOverlap).toHaveBeenCalledWith(expect.anything(), 'cust-1', FUTURE_DATE, true);
  });

  test("the superseding prepay's OWN decided term never blocks its restore (Codex P0 r30)", async () => {
    stubTables({
      invoices: [VOIDED_ROW],
      invoicesById: DEAD_PREPAY,
      term: { id: 'term-own', prepay_invoice_id: 'inv-prepay' },
    });
    const { body } = await post('/svc-1/prepay-switch/undo', { voidedInvoiceIds: ['inv-1'] });
    expect(body.restored).toHaveLength(1);
  });

  test('a FUTURE term that does not cover the visit date does NOT block the restore', async () => {
    // stub `term` = undefined → the containment first() finds nothing.
    stubTables({ invoices: [VOIDED_ROW], invoicesById: DEAD_PREPAY });
    const { body } = await post('/svc-1/prepay-switch/undo', { voidedInvoiceIds: ['inv-1'] });
    expect(body.restored).toHaveLength(1);
  });

  test('an UNRESOLVED Stripe outcome on the superseding prepay surfaces as a failure (Codex P0 r29)', async () => {
    const orphanErr = new Error('Invoice has an unresolved Stripe charge pi_orphan');
    orphanErr.code = 'STRIPE_CHARGED_DB_FAILED';
    mockReconAssert.mockRejectedValueOnce(orphanErr);
    stubTables({ invoices: [VOIDED_ROW], invoicesById: DEAD_PREPAY });
    const { body } = await post('/svc-1/prepay-switch/undo', { voidedInvoiceIds: ['inv-1'] });
    expect(body.restored).toEqual([]);
    expect(body.failed[0].error).toMatch(/unresolved Stripe charge outcome/i);
    expect(mockCreateInvoice).not.toHaveBeenCalled();
  });

  test("a void row WITHOUT this estimate's accept stamp restores nothing (crafted ids are inert)", async () => {
    stubTables({ invoices: [{ ...VOIDED_ROW, notes: 'Some unrelated historical invoice' }], invoicesById: DEAD_PREPAY });
    const { body } = await post('/svc-1/prepay-switch/undo', { voidedInvoiceIds: ['inv-1'] });
    expect(body.restored).toEqual([]);
    expect(mockCreateInvoice).not.toHaveBeenCalled();
  });

  test('a live completion invoice on the visit ⇒ restore the SETUP FEE ONLY (Codex P0 r17)', async () => {
    stubTables({ invoices: [VOIDED_ROW], invoicesById: DEAD_PREPAY, liveOnVisit: {
      id: 'inv-completion', invoice_number: 'WPC-2026-0410',
      line_items: [{ client_id: 'svc-1_primary', description: 'Quarterly Pest Control', amount: 128 }],
    } });
    const { body } = await post('/svc-1/prepay-switch/undo', { voidedInvoiceIds: ['inv-1'] });
    expect(body.restored).toHaveLength(1);
    const created = mockCreateInvoice.mock.calls[0][0];
    // The application is already billed by the completion invoice — only the
    // fee that lived solely on the superseded row comes back.
    expect(created.lineItems).toEqual([
      { description: 'WaveGuard Membership — one-time setup fee', quantity: 1, unit_price: 99 },
    ]);
  });

  test('an APPLICATION-ONLY row beside a live completion invoice skips benignly', async () => {
    stubTables({
      invoices: [{ ...VOIDED_ROW, line_items: [{ description: 'First service application', amount: 128 }] }],
      invoicesById: DEAD_PREPAY,
      liveOnVisit: {
        id: 'inv-completion', invoice_number: 'WPC-2026-0410',
        line_items: [{ client_id: 'svc-1_primary', description: 'Quarterly Pest Control', amount: 128 }],
      },
    });
    const { body } = await post('/svc-1/prepay-switch/undo', { voidedInvoiceIds: ['inv-1'] });
    expect(body.restored).toEqual([]);
    expect(body.failed).toEqual([]);
    expect(mockCreateInvoice).not.toHaveBeenCalled();
  });

  test('skips a row that is not void — no duplicate bill on a repeated undo', async () => {
    stubTables({ invoices: [{ ...VOIDED_ROW, status: 'draft' }], invoicesById: DEAD_PREPAY });
    const { body } = await post('/svc-1/prepay-switch/undo', { voidedInvoiceIds: ['inv-1'] });
    expect(body.restored).toEqual([]);
    expect(mockCreateInvoice).not.toHaveBeenCalled();
  });

  test('reports a failed re-mint instead of claiming the invoice is back', async () => {
    stubTables({ invoices: [VOIDED_ROW], invoicesById: DEAD_PREPAY });
    mockCreateInvoice.mockRejectedValueOnce(new Error('insert failed'));
    const { body } = await post('/svc-1/prepay-switch/undo', { voidedInvoiceIds: ['inv-1'] });
    expect(body.restored).toEqual([]);
    expect(body.failed[0]).toMatchObject({ id: 'inv-1', invoiceNumber: 'WPC-2026-0345' });
  });

  test('a void row WITHOUT the superseded-by marker restores nothing — voided outside the switch', async () => {
    stubTables({
      invoices: [{ ...VOIDED_ROW, notes: ACCEPT_INVOICE.notes }],
      invoicesById: DEAD_PREPAY,
    });
    const { body } = await post('/svc-1/prepay-switch/undo', { voidedInvoiceIds: ['inv-1'] });
    expect(body.restored).toEqual([]);
    expect(mockCreateInvoice).not.toHaveBeenCalled();
  });

  test('a superseding prepay that is still LIVE surfaces as a FAILURE, never silent success', async () => {
    stubTables({
      invoices: [VOIDED_ROW],
      invoicesById: { 'inv-prepay': { id: 'inv-prepay', status: 'paid' } },
    });
    const { body } = await post('/svc-1/prepay-switch/undo', { voidedInvoiceIds: ['inv-1'] });
    expect(body.restored).toEqual([]);
    expect(body.failed[0].error).toMatch(/still live/i);
    expect(mockCreateInvoice).not.toHaveBeenCalled();
  });

  test('a SETUP-ONLY (unattached) accept draft is superseded by provenance, not attachment', async () => {
    // The converter leaves setup-only drafts with NO scheduled_service_id —
    // the resolver must still find them through the customer+provenance net.
    stubTables({
      invoices: [{ ...ACCEPT_INVOICE, scheduled_service_id: null, total: '99.00',
        line_items: [{ description: 'WaveGuard Membership — one-time setup fee', amount: 99 }] }],
    });
    const { body } = await preview();
    expect(body.eligible).toBe(true);
    expect(body.supersedes).toHaveLength(1);
    expect(body.supersedes[0].total).toBe(99);
    expect(body.setupFee).toEqual({ amount: 99, waivedWithPrepay: true });
  });

  test('no ids ⇒ nothing restored', async () => {
    stubTables({ invoices: [VOIDED_ROW], invoicesById: DEAD_PREPAY });
    const { body } = await post('/svc-1/prepay-switch/undo', {});
    expect(body.restored).toEqual([]);
    expect(mockCreateInvoice).not.toHaveBeenCalled();
  });
});

describe('on-site prepay switch — activation status (paid ≠ activated)', () => {
  let syncSpy;
  let coversSpy;
  beforeEach(() => {
    jest.clearAllMocks();
    mockResolveForInvoice.mockResolvedValue({ payerId: null });
    syncSpy = jest.spyOn(AnnualPrepayRenewals, 'syncTermForInvoicePayment').mockResolvedValue(undefined);
    // Coverage is judged by the completion path's own authority (Codex P0
    // r27) — its full validation is unit-tested in the renewals suite.
    coversSpy = jest.spyOn(AnnualPrepayRenewals, 'annualPrepayCoversVisit').mockResolvedValue(true);
  });
  afterEach(() => { syncSpy.mockRestore(); coversSpy.mockRestore(); });

  async function getStatus() {
    const app = express();
    app.use('/admin/schedule', router);
    app.use((err, _req, res, _next) => res.status(err.status || 500).json({ error: err.message }));
    const server = app.listen(0);
    try {
      const res = await fetch(`http://127.0.0.1:${server.address().port}/admin/schedule/svc-1/prepay-switch/status?invoiceId=inv-prepay`);
      return { status: res.status, body: await res.json() };
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  }

  test('activated only when paid AND the term is active AND the visit carries the coverage stamp', async () => {
    stubTables({
      visit: { ...ACCEPTED_SERIES_VISIT, prepaid_method: 'annual_prepay_invoice', annual_prepay_term_id: 'term-1' },
      invoicesById: { 'inv-prepay': { id: 'inv-prepay', status: 'paid', paid_at: '2026-08-13T00:00:00Z', annual_prepay_term_id: 'term-1' } },
      term: { id: 'term-1', status: 'active' },
    });
    const { status, body } = await getStatus();
    expect(status).toBe(200);
    expect(body.activated).toBe(true);
    // Already active — no repair needed; coverage judged by the completion
    // path's own validator, on the refreshed visit row.
    expect(syncSpy).not.toHaveBeenCalled();
    expect(coversSpy).toHaveBeenCalled();
  });

  test('a stamp pointing at a DIFFERENT term never activates (Codex P0 r27)', async () => {
    stubTables({
      visit: { ...ACCEPTED_SERIES_VISIT, prepaid_method: 'annual_prepay_invoice', annual_prepay_term_id: 'term-OTHER' },
      invoicesById: { 'inv-prepay': { id: 'inv-prepay', status: 'paid', paid_at: '2026-08-13T00:00:00Z', annual_prepay_term_id: 'term-1' } },
      term: { id: 'term-1', status: 'active' },
    });
    const { body } = await getStatus();
    expect(body.activated).toBe(false);
    expect(body.visitCovered).toBe(false);
  });

  test('the completion validator refusing the stamp refuses activation too', async () => {
    coversSpy.mockResolvedValue(false);
    stubTables({
      visit: { ...ACCEPTED_SERIES_VISIT, prepaid_method: 'annual_prepay_invoice', annual_prepay_term_id: 'term-1' },
      invoicesById: { 'inv-prepay': { id: 'inv-prepay', status: 'paid', paid_at: '2026-08-13T00:00:00Z', annual_prepay_term_id: 'term-1' } },
      term: { id: 'term-1', status: 'active' },
    });
    const { body } = await getStatus();
    expect(body.activated).toBe(false);
  });

  test('paid but PENDING repairs synchronously and answers honestly if still not active', async () => {
    stubTables({
      invoicesById: { 'inv-prepay': { id: 'inv-prepay', status: 'paid', paid_at: '2026-08-13T00:00:00Z', annual_prepay_term_id: 'term-1' } },
      term: { id: 'term-1', status: 'payment_pending' },
    });
    const { body } = await getStatus();
    // The swallowed-sync gap: the endpoint re-runs the idempotent sync…
    expect(syncSpy).toHaveBeenCalledWith('inv-prepay');
    // …and with the term still pending (stub static), never claims success.
    expect(body.activated).toBe(false);
    expect(body.termStatus).toBe('payment_pending');
  });
});
