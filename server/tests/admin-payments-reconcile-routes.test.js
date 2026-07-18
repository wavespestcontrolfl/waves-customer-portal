/**
 * admin-payments-reconcile route guards + ledger consistency (07-17 payments
 * audit). Pins three behaviors this router previously had no tests for:
 *
 *  - requireAdmin on POST /reconcile (and on the sibling admin-invoices
 *    POST /:id/charge-card): a technician-role token gets 403 and no
 *    handler side effects run — matching the other money-mutating admin
 *    invoice routes.
 *  - Atomicity: the invoice status flip and the payments-ledger insert
 *    commit together or not at all — a failed insert must roll back the
 *    flip instead of leaving a paid invoice with no ledger row.
 *  - Double-record guard: a Stripe charge that already has a payments
 *    ledger row is rejected with 409, and a charge carrying a different
 *    customer identity than the invoice is rejected. A charge whose Stripe
 *    customer maps to NO portal customer fails closed (400) — undefined
 *    owner must not grant access to any same-value invoice.
 *  - Race serialization: the dedupe re-check (invoices.stripe_charge_id +
 *    payments ledger) runs INSIDE the transaction under a charge-scoped
 *    pg_advisory_xact_lock, so a "loser" admin re-reads AFTER the winner
 *    commits and gets 409 with zero writes — never a second booking of the
 *    same charge. Simulated via the fake's onLock hook, which injects the
 *    winner's committed rows at lock-acquisition time.
 *  - GET /recent-charges excludes charges already booked in the payments
 *    ledger, not just invoice-linked ones.
 *
 * The real requireAdmin/requireTechOrAdmin run; only adminAuthenticate is
 * stubbed to inject a controllable role. db is an in-memory fake whose
 * transaction() stages writes and only commits them if the callback
 * resolves, so rollback semantics are actually exercised.
 */

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret';
process.env.STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY || 'sk_test_reconcile_route';
jest.setTimeout(30000);

let mockCurrentRole = 'admin';

jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../middleware/admin-auth', () => {
  const actual = jest.requireActual('../middleware/admin-auth');
  return {
    ...actual,
    adminAuthenticate: (req, _res, next) => {
      req.technician = { id: 'staff-1', role: mockCurrentRole };
      req.technicianId = 'staff-1';
      req.techRole = mockCurrentRole;
      return next();
    },
  };
});
jest.mock('../services/audit-log', () => ({
  auditPaymentReconcile: jest.fn().mockResolvedValue(undefined),
  ipFromReq: () => '127.0.0.1',
  uaFromReq: () => 'jest',
}));
jest.mock('../services/annual-prepay-renewals', () => ({
  syncTermForInvoicePayment: jest.fn().mockResolvedValue(undefined),
}));
jest.mock('../services/stripe', () => ({
  chargeInvoiceWithSavedCard: jest.fn(),
}));

const mockChargesRetrieve = jest.fn();
const mockChargesList = jest.fn();
jest.mock('stripe', () => jest.fn(() => ({
  charges: {
    retrieve: (...args) => mockChargesRetrieve(...args),
    list: (...args) => mockChargesList(...args),
  },
})));

// In-memory db fake. Reads/writes are where-aware for the columns the routes
// under test actually filter on; transaction() runs the callback against a
// STAGED copy and only commits it back if the callback resolves, so the
// insert-failure test observes a genuine rollback. `otherInvoices` holds
// invoices that are readable (first/whereIn) but not the update target;
// `onLock` fires when the route takes the charge-scoped advisory lock,
// letting race tests inject rows "committed by the winner" while this
// request was blocked on the lock. `rawCalls` records trx.raw() for
// asserting the lock itself.
jest.mock('../models/db', () => {
  const state = {
    invoice: null,
    otherInvoices: [],
    payments: [],
    customers: [],
    failPaymentsInsert: false,
    onLock: null,
    rawCalls: [],
  };
  const matches = (row, where) => Object.entries(where).every(([k, v]) => row[k] === v);
  const makeBuilder = (data, table) => {
    const rowsFor = () => {
      if (table === 'invoices') return [data.invoice, ...(data.otherInvoices || [])].filter(Boolean);
      if (table === 'payments') return data.payments;
      if (table === 'customers') return data.customers;
      return [];
    };
    const builder = {
      _where: {},
      _whereIn: null,
      _notIn: null,
      where(w) { Object.assign(builder._where, w); return builder; },
      whereIn(col, vals) { builder._whereIn = { col, vals }; return builder; },
      whereNotIn(col, vals) { builder._notIn = { col, vals }; return builder; },
      async first() {
        const found = rowsFor().find((r) => matches(r, builder._where));
        return found ? { ...found } : undefined;
      },
      async select() {
        let rows = rowsFor().filter((r) => matches(r, builder._where));
        if (builder._whereIn) rows = rows.filter((r) => builder._whereIn.vals.includes(r[builder._whereIn.col]));
        return rows.map((r) => ({ ...r }));
      },
      async update(updates) {
        if (table !== 'invoices') throw new Error(`unexpected update on ${table}`);
        if (!data.invoice || !matches(data.invoice, builder._where)) return 0;
        if (builder._notIn && builder._notIn.vals.includes(data.invoice[builder._notIn.col])) return 0;
        Object.assign(data.invoice, updates);
        return 1;
      },
      async insert(row) {
        if (table !== 'payments') throw new Error(`unexpected insert on ${table}`);
        if (data.failPaymentsInsert) throw new Error('simulated payments insert failure');
        data.payments.push(row);
        return [1];
      },
    };
    return builder;
  };
  const dbFn = (table) => makeBuilder(state, table);
  dbFn.transaction = async (cb) => {
    const staged = {
      invoice: state.invoice ? { ...state.invoice } : null,
      otherInvoices: (state.otherInvoices || []).map((r) => ({ ...r })),
      payments: [...state.payments],
      customers: state.customers,
      failPaymentsInsert: state.failPaymentsInsert,
    };
    const trx = (table) => makeBuilder(staged, table);
    trx.raw = async (sql, bindings) => {
      state.rawCalls.push({ sql, bindings });
      if (state.onLock) state.onLock(staged);
      return {};
    };
    const result = await cb(trx);
    state.invoice = staged.invoice;
    state.otherInvoices = staged.otherInvoices;
    state.payments = staged.payments;
    return result;
  };
  dbFn.fn = { now: () => new Date() };
  dbFn.__state = state;
  return dbFn;
});

const express = require('express');
const db = require('../models/db');
const StripeService = require('../services/stripe');
const reconcileRouter = require('../routes/admin-payments-reconcile');
const invoicesRouter = require('../routes/admin-invoices');

let server;
let baseUrl;
beforeAll((done) => {
  const app = express();
  app.use(express.json());
  app.use('/api/admin/payments-reconcile', reconcileRouter);
  app.use('/api/admin/invoices', invoicesRouter);
  app.use((err, _req, res, _next) => res.status(err.status || 500).json({ error: err.message }));
  server = app.listen(0, () => {
    baseUrl = `http://127.0.0.1:${server.address().port}`;
    done();
  });
});
afterAll((done) => { server.close(done); });

async function post(path, body) {
  const res = await fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body || {}),
  });
  let json = null;
  try { json = await res.json(); } catch { /* no body */ }
  return { status: res.status, body: json || {} };
}

async function get(path) {
  const res = await fetch(`${baseUrl}${path}`);
  let json = null;
  try { json = await res.json(); } catch { /* no body */ }
  return { status: res.status, body: json || {} };
}

function freshInvoice(overrides = {}) {
  return {
    id: 'inv-1',
    invoice_number: 'WPC-2026-9001',
    customer_id: 'cust-1',
    status: 'sent',
    total: 100,
    credit_applied: 0,
    payer_id: null,
    payer_statement_id: null,
    notes: null,
    ...overrides,
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  mockCurrentRole = 'admin';
  db.__state.invoice = freshInvoice();
  db.__state.otherInvoices = [];
  db.__state.payments = [];
  db.__state.customers = [];
  db.__state.failPaymentsInsert = false;
  db.__state.onLock = null;
  db.__state.rawCalls = [];
});

describe('role gating (requireAdmin)', () => {
  test('technician gets 403 on POST /reconcile and nothing is written', async () => {
    mockCurrentRole = 'technician';
    const { status, body } = await post('/api/admin/payments-reconcile/reconcile', {
      invoiceId: 'inv-1', collectedVia: 'cash', amount: 100,
    });
    expect(status).toBe(403);
    expect(body.error).toMatch(/admin access required/i);
    expect(db.__state.invoice.status).toBe('sent');
    expect(db.__state.payments).toHaveLength(0);
  });

  test('technician gets 403 on POST /:id/charge-card and Stripe is never called', async () => {
    mockCurrentRole = 'technician';
    const { status, body } = await post('/api/admin/invoices/inv-1/charge-card', {
      paymentMethodId: 'pm-1',
    });
    expect(status).toBe(403);
    expect(body.error).toMatch(/admin access required/i);
    expect(StripeService.chargeInvoiceWithSavedCard).not.toHaveBeenCalled();
  });

  test('admin passes the /reconcile gate', async () => {
    const { status } = await post('/api/admin/payments-reconcile/reconcile', {
      invoiceId: 'inv-1', collectedVia: 'cash', amount: 100,
    });
    expect(status).toBe(200);
  });
});

describe('manual reconcile atomicity', () => {
  test('flips the invoice AND inserts the payments ledger row', async () => {
    const { status, body } = await post('/api/admin/payments-reconcile/reconcile', {
      invoiceId: 'inv-1', collectedVia: 'cash', amount: 100, note: 'paid at door',
    });
    expect(status).toBe(200);
    expect(body.success).toBe(true);
    expect(db.__state.invoice.status).toBe('paid');
    expect(db.__state.invoice.collected_via).toBe('cash');
    expect(db.__state.payments).toHaveLength(1);
    expect(db.__state.payments[0]).toEqual(expect.objectContaining({
      customer_id: 'cust-1',
      amount: 100,
      status: 'paid',
      stripe_charge_id: null,
      processor: null,
    }));
  });

  test('a failed payments insert rolls back the status flip (both-or-neither)', async () => {
    db.__state.failPaymentsInsert = true;
    const { status } = await post('/api/admin/payments-reconcile/reconcile', {
      invoiceId: 'inv-1', collectedVia: 'cash', amount: 100,
    });
    expect(status).toBe(500);
    expect(db.__state.invoice.status).toBe('sent'); // NOT flipped
    expect(db.__state.invoice.collected_via).toBeUndefined();
    expect(db.__state.payments).toHaveLength(0);
  });

  test('an uncollectible invoice is rejected without writes', async () => {
    db.__state.invoice = freshInvoice({ status: 'paid' });
    const { status } = await post('/api/admin/payments-reconcile/reconcile', {
      invoiceId: 'inv-1', collectedVia: 'cash', amount: 100,
    });
    expect(status).toBe(409);
    expect(db.__state.payments).toHaveLength(0);
  });
});

describe('Stripe-charge double-record guard', () => {
  const succeededCharge = (overrides = {}) => ({
    id: 'ch_1',
    status: 'succeeded',
    amount: 10000,
    currency: 'usd',
    refunded: false,
    amount_refunded: 0,
    disputed: false,
    customer: null,
    metadata: {},
    payment_method_details: { type: 'card_present', card_present: { brand: 'visa', last4: '4242' } },
    receipt_url: 'https://stripe.example/receipt',
    ...overrides,
  });

  test('rejects with 409 when a payments row already exists for the charge', async () => {
    mockChargesRetrieve.mockResolvedValue(succeededCharge({ id: 'ch_dup' }));
    db.__state.payments = [{ id: 'pay-1', stripe_charge_id: 'ch_dup', amount: 100, status: 'paid' }];

    const { status, body } = await post('/api/admin/payments-reconcile/reconcile', {
      invoiceId: 'inv-1', collectedVia: 'tap_to_pay', stripeChargeId: 'ch_dup',
    });
    expect(status).toBe(409);
    expect(body.error).toMatch(/already recorded/i);
    expect(db.__state.invoice.status).toBe('sent');
    expect(db.__state.payments).toHaveLength(1); // untouched
  });

  test('rejects a charge whose metadata pins a different customer', async () => {
    mockChargesRetrieve.mockResolvedValue(succeededCharge({
      metadata: { waves_customer_id: 'cust-OTHER' },
    }));
    const { status, body } = await post('/api/admin/payments-reconcile/reconcile', {
      invoiceId: 'inv-1', collectedVia: 'tap_to_pay', stripeChargeId: 'ch_1',
    });
    expect(status).toBe(400);
    expect(body.error).toMatch(/different customer/i);
    expect(db.__state.invoice.status).toBe('sent');
  });

  test('rejects a charge whose Stripe customer maps to a different portal customer', async () => {
    mockChargesRetrieve.mockResolvedValue(succeededCharge({ customer: 'cus_stripe_other' }));
    db.__state.customers = [{ id: 'cust-OTHER', stripe_customer_id: 'cus_stripe_other' }];
    const { status, body } = await post('/api/admin/payments-reconcile/reconcile', {
      invoiceId: 'inv-1', collectedVia: 'tap_to_pay', stripeChargeId: 'ch_1',
    });
    expect(status).toBe(400);
    expect(body.error).toMatch(/different customer/i);
    expect(db.__state.invoice.status).toBe('sent');
  });

  test('fails CLOSED when the charge names a Stripe customer that maps to no portal customer', async () => {
    // Legacy/deleted/foreign Stripe customer: identified but unmappable.
    // Previously `owner` was undefined and the check fell open, letting the
    // charge attach to ANY same-value invoice.
    mockChargesRetrieve.mockResolvedValue(succeededCharge({ customer: 'cus_unmapped_legacy' }));
    db.__state.customers = [{ id: 'cust-1', stripe_customer_id: 'cus_something_else' }];
    const { status, body } = await post('/api/admin/payments-reconcile/reconcile', {
      invoiceId: 'inv-1', collectedVia: 'tap_to_pay', stripeChargeId: 'ch_1',
    });
    expect(status).toBe(400);
    expect(body.error).toMatch(/not linked to any portal customer/i);
    expect(db.__state.invoice.status).toBe('sent');
    expect(db.__state.payments).toHaveLength(0);
  });

  test('an identity-less Tap-to-Pay charge still reconciles (flip + ledger row together)', async () => {
    mockChargesRetrieve.mockResolvedValue(succeededCharge());
    const { status, body } = await post('/api/admin/payments-reconcile/reconcile', {
      invoiceId: 'inv-1', collectedVia: 'tap_to_pay', stripeChargeId: 'ch_1',
    });
    expect(status).toBe(200);
    expect(body.success).toBe(true);
    expect(db.__state.invoice.status).toBe('paid');
    expect(db.__state.invoice.stripe_charge_id).toBe('ch_1');
    expect(db.__state.payments).toHaveLength(1);
    expect(db.__state.payments[0]).toEqual(expect.objectContaining({
      stripe_charge_id: 'ch_1',
      processor: 'stripe',
      amount: 100,
    }));
  });
});

describe('concurrent reconcile race — advisory-lock serialized dedupe', () => {
  const succeededCharge = (overrides = {}) => ({
    id: 'ch_race',
    status: 'succeeded',
    amount: 10000,
    currency: 'usd',
    refunded: false,
    amount_refunded: 0,
    disputed: false,
    customer: null,
    metadata: {},
    payment_method_details: { type: 'card_present', card_present: { brand: 'visa', last4: '4242' } },
    receipt_url: 'https://stripe.example/receipt',
    ...overrides,
  });

  test('takes a charge-scoped pg_advisory_xact_lock inside the transaction, before the dedupe re-checks', async () => {
    mockChargesRetrieve.mockResolvedValue(succeededCharge());
    const { status } = await post('/api/admin/payments-reconcile/reconcile', {
      invoiceId: 'inv-1', collectedVia: 'tap_to_pay', stripeChargeId: 'ch_race',
    });
    expect(status).toBe(200);
    const lock = db.__state.rawCalls.find((c) => /pg_advisory_xact_lock/.test(c.sql));
    expect(lock).toBeDefined();
    expect(lock.bindings).toEqual(['reconcile.stripe_charge', 'ch_race']);
  });

  test('manual (non-Stripe) reconcile takes no advisory lock', async () => {
    const { status } = await post('/api/admin/payments-reconcile/reconcile', {
      invoiceId: 'inv-1', collectedVia: 'cash', amount: 100,
    });
    expect(status).toBe(200);
    expect(db.__state.rawCalls).toHaveLength(0);
  });

  test('loser sees the winner\'s ledger row after the lock and gets 409 with zero writes', async () => {
    mockChargesRetrieve.mockResolvedValue(succeededCharge());
    // Simulate the OTHER admin winning the race: our transaction blocks on
    // the advisory lock while the winner books the same charge and commits;
    // the hook fires at OUR lock acquisition, i.e. after the winner's
    // commit released the lock — exactly what the in-transaction re-check
    // must now observe.
    db.__state.onLock = (staged) => {
      staged.payments.push({ id: 'pay-winner', stripe_charge_id: 'ch_race', amount: 100, status: 'paid' });
    };
    const { status, body } = await post('/api/admin/payments-reconcile/reconcile', {
      invoiceId: 'inv-1', collectedVia: 'tap_to_pay', stripeChargeId: 'ch_race',
    });
    expect(status).toBe(409);
    expect(body.error).toMatch(/already recorded/i);
    expect(db.__state.invoice.status).toBe('sent'); // loser flipped nothing
    // Only the winner's row exists — the charge was never booked twice.
    expect(db.__state.payments.filter((p) => p.stripe_charge_id === 'ch_race')).toHaveLength(1);
  });

  test('loser sees the winner\'s invoice link after the lock and gets 409 naming that invoice', async () => {
    mockChargesRetrieve.mockResolvedValue(succeededCharge());
    db.__state.onLock = (staged) => {
      staged.otherInvoices.push({
        id: 'inv-2', invoice_number: 'WPC-2026-9002', customer_id: 'cust-2',
        status: 'paid', stripe_charge_id: 'ch_race',
      });
    };
    const { status, body } = await post('/api/admin/payments-reconcile/reconcile', {
      invoiceId: 'inv-1', collectedVia: 'tap_to_pay', stripeChargeId: 'ch_race',
    });
    expect(status).toBe(409);
    expect(body.error).toMatch(/already linked to invoice WPC-2026-9002/);
    expect(db.__state.invoice.status).toBe('sent');
    expect(db.__state.payments).toHaveLength(0);
  });
});

describe('GET /recent-charges — reconcilable entries only', () => {
  const listedCharge = (id, overrides = {}) => ({
    id,
    status: 'succeeded',
    amount: 10000,
    currency: 'usd',
    created: 1752700000,
    payment_method_details: { type: 'card_present', card_present: { brand: 'visa', last4: '4242' } },
    receipt_url: `https://stripe.example/receipt/${id}`,
    description: null,
    ...overrides,
  });

  test('excludes refunded, disputed, and non-USD charges — the /reconcile guard would 400 them', async () => {
    mockChargesList.mockResolvedValue({ data: [
      listedCharge('ch_refunded', { refunded: true, amount_refunded: 10000 }),
      listedCharge('ch_partial', { amount_refunded: 500 }),
      listedCharge('ch_disputed', { disputed: true }),
      listedCharge('ch_eur', { currency: 'eur' }),
      listedCharge('ch_free'),
    ] });
    const { status, body } = await get('/api/admin/payments-reconcile/recent-charges');
    expect(status).toBe(200);
    expect(body.charges.map((c) => c.id)).toEqual(['ch_free']);
  });

  test('excludes ledger-booked charges as well as invoice-linked ones', async () => {
    mockChargesList.mockResolvedValue({ data: [
      listedCharge('ch_booked_ledger'),   // payments row, NO invoice stamp — the 409-guaranteed case
      listedCharge('ch_linked_invoice'),  // stamped on an invoice
      listedCharge('ch_free'),            // genuinely reconcilable
    ] });
    db.__state.payments = [{ id: 'pay-1', stripe_charge_id: 'ch_booked_ledger', amount: 100, status: 'paid' }];
    db.__state.invoice = freshInvoice({ stripe_charge_id: 'ch_linked_invoice' });

    const { status, body } = await get('/api/admin/payments-reconcile/recent-charges');
    expect(status).toBe(200);
    expect(body.charges.map((c) => c.id)).toEqual(['ch_free']);
  });
});

describe('charge validity guards (07-18 admin audit)', () => {
  const { auditPaymentReconcile } = require('../services/audit-log');
  const succeededCharge = (overrides = {}) => ({
    id: 'ch_v1',
    status: 'succeeded',
    amount: 10000,
    currency: 'usd',
    refunded: false,
    amount_refunded: 0,
    disputed: false,
    customer: null,
    metadata: {},
    payment_method_details: { type: 'card_present', card_present: { brand: 'visa', last4: '4242' } },
    receipt_url: 'https://stripe.example/receipt',
    ...overrides,
  });

  test('rejects a non-USD charge — the amount check is unit-blind', async () => {
    mockChargesRetrieve.mockResolvedValue(succeededCharge({ currency: 'eur' }));
    const { status, body } = await post('/api/admin/payments-reconcile/reconcile', {
      invoiceId: 'inv-1', collectedVia: 'tap_to_pay', stripeChargeId: 'ch_v1',
    });
    expect(status).toBe(400);
    expect(body.error).toMatch(/currency is EUR/i);
    expect(db.__state.invoice.status).toBe('sent');
    expect(db.__state.payments).toHaveLength(0);
  });

  test('rejects a refunded charge even though Stripe keeps status succeeded', async () => {
    mockChargesRetrieve.mockResolvedValue(succeededCharge({ refunded: true, amount_refunded: 10000 }));
    const { status, body } = await post('/api/admin/payments-reconcile/reconcile', {
      invoiceId: 'inv-1', collectedVia: 'tap_to_pay', stripeChargeId: 'ch_v1',
    });
    expect(status).toBe(400);
    expect(body.error).toMatch(/refunded or disputed/i);
    expect(db.__state.invoice.status).toBe('sent');
  });

  test('rejects a partially refunded charge — the flat booking would overstate what was kept', async () => {
    mockChargesRetrieve.mockResolvedValue(succeededCharge({ amount_refunded: 2500 }));
    const { status, body } = await post('/api/admin/payments-reconcile/reconcile', {
      invoiceId: 'inv-1', collectedVia: 'tap_to_pay', stripeChargeId: 'ch_v1',
    });
    expect(status).toBe(400);
    expect(body.error).toMatch(/refunded or disputed/i);
  });

  test('rejects a disputed charge', async () => {
    mockChargesRetrieve.mockResolvedValue(succeededCharge({ disputed: true }));
    const { status, body } = await post('/api/admin/payments-reconcile/reconcile', {
      invoiceId: 'inv-1', collectedVia: 'tap_to_pay', stripeChargeId: 'ch_v1',
    });
    expect(status).toBe(400);
    expect(body.error).toMatch(/refunded or disputed/i);
  });

  test('audit row rides the reconcile transaction', async () => {
    const { status } = await post('/api/admin/payments-reconcile/reconcile', {
      invoiceId: 'inv-1', collectedVia: 'cash', amount: 100,
    });
    expect(status).toBe(200);
    expect(auditPaymentReconcile).toHaveBeenCalledTimes(1);
    expect(auditPaymentReconcile).toHaveBeenCalledWith(expect.objectContaining({
      invoice_id: 'inv-1',
      collected_via: 'cash',
      trx: expect.anything(),
    }));
  });

  test('an audit-row failure rolls back the whole reconcile — no paid invoice behind a 500', async () => {
    auditPaymentReconcile.mockRejectedValueOnce(new Error('audit_log unavailable'));
    const { status } = await post('/api/admin/payments-reconcile/reconcile', {
      invoiceId: 'inv-1', collectedVia: 'cash', amount: 100,
    });
    expect(status).toBe(500);
    expect(db.__state.invoice.status).toBe('sent'); // NOT flipped
    expect(db.__state.payments).toHaveLength(0);    // ledger rolled back too
  });
});
