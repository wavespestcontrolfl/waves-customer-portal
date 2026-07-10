process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret';

/**
 * Booking-audit P1 regressions on PUT /api/estimates/:token/accept:
 *
 * 1. Acceptance atomicity — the STANDARD recurring conversion runs INSIDE the
 *    accept transaction: a conversion (or in-txn invoice mint) failure rolls
 *    the acceptance back (customer gets a retryable 5xx; the estimate is NOT
 *    left accepted-but-unconverted), and a retry then succeeds.
 * 2. Already-accepted retry — a retry of an accepted estimate returns the
 *    FULL success payload rebuilt from persisted state (nextStep, invoice
 *    fields, pay URL, alreadyAccepted: true), not the bare legacy shape, and
 *    re-runs NO side effects.
 * 3. Email-only estimates fail closed — a phoneless, customer-less standard
 *    accept 400s BEFORE the transaction (nothing commits) instead of
 *    committing an acceptance whose reservation binding + conversion were
 *    silently skipped.
 */

// ── In-memory fake knex ────────────────────────────────────────────────────
// Just enough of the query-builder surface for the accept path: eq filters,
// null / not-null / not-in / not-eq / LIKE, first/update/insert/select, and
// db.transaction with REAL rollback semantics (snapshot + restore) so the
// atomicity assertions observe genuine transactional behavior.
jest.mock('../models/db', () => {
  const state = { tables: {} };

  const rowMatches = (row, ctx) => {
    for (const eq of ctx.eqFilters) {
      for (const [col, val] of Object.entries(eq)) {
        if (String(row[col]) !== String(val)) return false;
      }
    }
    for (const col of ctx.nullCols) if (row[col] != null) return false;
    for (const col of ctx.notNullCols) if (row[col] == null) return false;
    for (const [col, arr] of ctx.notIn) if (arr.includes(row[col])) return false;
    for (const [col, val] of ctx.notEq) if (row[col] === val) return false;
    for (const [col, op, pattern] of ctx.likes) {
      if (String(op).toLowerCase() !== 'like') return false;
      const prefix = String(pattern).endsWith('%') ? String(pattern).slice(0, -1) : String(pattern);
      if (!String(row[col] || '').startsWith(prefix)) return false;
    }
    return true;
  };

  const makeBuilder = (table) => {
    const ctx = { eqFilters: [], nullCols: [], notNullCols: [], notIn: [], notEq: [], likes: [] };
    const rows = () => (state.tables[table] = state.tables[table] || []);
    const matched = () => rows().filter((r) => rowMatches(r, ctx));
    const b = {};
    b.where = (arg, ...rest) => {
      if (typeof arg === 'function') { arg.call(b, b); return b; } // OR-groups: treated as match-all (fixtures keep these tables empty/simple)
      if (rest.length === 2) { ctx.likes.push([arg, rest[0], rest[1]]); return b; }
      if (typeof arg === 'object' && arg !== null) { ctx.eqFilters.push(arg); return b; }
      ctx.eqFilters.push({ [arg]: rest[rest.length - 1] });
      return b;
    };
    b.andWhere = b.where;
    b.orWhere = () => b;
    b.orWhereRaw = () => b;
    b.whereRaw = () => b;
    b.whereNull = (col) => { ctx.nullCols.push(col); return b; };
    b.whereNotNull = (col) => { ctx.notNullCols.push(col); return b; };
    b.whereNotIn = (col, arr) => { ctx.notIn.push([col, arr]); return b; };
    b.whereNot = (col, val) => { ctx.notEq.push([col, val]); return b; };
    b.whereIn = (col, arr) => { ctx.eqFilters.push(...[]); ctx.whereIn = [col, arr]; return b; };
    b.orderBy = () => b;
    b.orderByRaw = () => b;
    b.modify = (fn) => { fn(b); return b; };
    b.select = () => b;
    b.first = async () => {
      const row = matched()[0];
      return row ? { ...row } : undefined;
    };
    b.update = async (obj) => {
      const hits = matched();
      hits.forEach((row) => Object.assign(row, obj));
      return hits.length;
    };
    b.insert = (row) => {
      const stored = { id: row.id || `${table}-${rows().length + 1}`, ...row };
      rows().push(stored);
      return {
        returning: async () => [{ ...stored }],
        then: (res, rej) => Promise.resolve([{ ...stored }]).then(res, rej),
        catch: () => Promise.resolve([{ ...stored }]),
      };
    };
    b.del = async () => 0;
    b.pluck = async () => [];
    b.count = () => ({ first: async () => ({ count: matched().length }) });
    b.then = (res, rej) => Promise.resolve(matched().map((r) => ({ ...r }))).then(res, rej);
    b.catch = (fn) => Promise.resolve(matched().map((r) => ({ ...r }))).catch(fn);
    return b;
  };

  const dbFn = (table) => makeBuilder(table);
  dbFn.fn = { now: () => new Date() };
  dbFn.raw = (sql, bindings) => ({ __raw: sql, bindings });
  dbFn.schema = { hasColumn: async () => false };
  dbFn.transaction = async (cb) => {
    const snapshot = structuredClone(state.tables);
    try {
      return await cb(dbFn);
    } catch (err) {
      state.tables = snapshot; // rollback
      throw err;
    }
  };
  dbFn.__state = state;
  return dbFn;
});

// Module mocks: everything with real side effects (comms, Stripe-adjacent,
// notifications) is stubbed; converter HELPERS stay real (the in-txn invoice
// mint derives its gates from them) with only convertEstimate replaced.
jest.mock('../services/estimate-converter', () => {
  const actual = jest.requireActual('../services/estimate-converter');
  return { ...actual, convertEstimate: jest.fn() };
});
jest.mock('../services/invoice', () => ({
  create: jest.fn(),
  sendViaSMSAndEmail: jest.fn(async () => ({ ok: true, payUrl: null, sms: { ok: true }, email: { ok: true } })),
}));
jest.mock('../services/estimate-deposits', () => ({
  ensureDepositSatisfied: jest.fn(async () => ({ satisfied: true })),
  resolveDepositPolicyForEstimate: jest.fn(async () => ({
    enforced: false, required: false, slotRequired: false, amount: 0, exemptReason: null,
  })),
  linkedScheduledServiceId: jest.fn(async () => null),
  computeDepositAmount: jest.fn(() => 49),
  pendingDepositCredit: jest.fn(async () => null),
  consumeDepositCredit: jest.fn(async () => 0),
  refundUnconsumedDeposits: jest.fn(async () => ({})),
}));
jest.mock('../services/estimate-membership-context', () => ({
  buildEstimateMembershipContext: jest.fn(async () => ({})),
}));
jest.mock('../services/estimate-card-holds', () => ({
  resolveCardHoldPolicy: jest.fn(() => ({ required: false, enforced: false })),
  verifyCardHoldIntent: jest.fn(async () => ({ ok: false })),
  recordCardHoldHeld: jest.fn(async () => ({})),
  attachCardHoldPaymentMethod: jest.fn(async () => ({})),
  cardHoldNoShowFee: jest.fn(() => 49),
  cardHoldCancelWindowHours: jest.fn(() => 24),
}));
jest.mock('../services/lead-estimate-link', () => ({
  markLinkedLeadEstimateAccepted: jest.fn(async () => ({})),
  markLinkedLeadEstimateViewed: jest.fn(async () => ({})),
}));
jest.mock('../services/estimate-accepted-email', () => ({
  sendEstimateAcceptedOnboarding: jest.fn(async () => ({})),
}));
jest.mock('../services/notification-service', () => ({
  notifyAdmin: jest.fn(async () => ({})),
  notifyCustomer: jest.fn(async () => ({})),
}));
jest.mock('../services/admin-followup-call', () => ({
  triggerAdminFollowupCall: jest.fn(async () => ({})),
}));
jest.mock('../services/payer', () => ({
  resolveForInvoice: jest.fn(async () => null),
}));
jest.mock('../services/new-recurring-welcome-sms', () => ({
  sendNewRecurringWelcome: jest.fn(async () => ({})),
}));
jest.mock('../services/account-membership-email', () => ({
  sendMembershipStarted: jest.fn(async () => ({})),
}));
jest.mock('../services/appointment-tagger', () => ({
  onServiceScheduled: jest.fn(async () => ({})),
}));
jest.mock('../services/short-url', () => ({
  shortenOrPassthrough: jest.fn(async (url) => url),
  createShortCode: jest.fn(async (url) => ({ code: 'abc12', shortUrl: url })),
  createTrackedShortLink: jest.fn(async (url) => ({ code: 'abc12', shortUrl: url })),
  resolveShortCode: jest.fn(async () => null),
  invoiceShortCodePrefix: jest.fn(() => 'inv'),
}));
jest.mock('../services/messaging/send-customer-message', () => ({
  sendCustomerMessage: jest.fn(async () => ({ sent: true })),
}));

const express = require('express');
const db = require('../models/db');
const EstimateConverter = require('../services/estimate-converter');
const InvoiceService = require('../services/invoice');

// No supertest in this repo — run the real router on an ephemeral port and
// hit it with the built-in fetch (same pattern as public-ui-flags.test.js).
let server;
let base;

beforeAll((done) => {
  const app = express();
  app.use(express.json());
  app.use('/api/estimates', require('../routes/estimate-public'));
  // Mirror the real error middleware's contract for next(err): 5xx JSON.
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    res.status(err.status || err.statusCode || 500).json({ error: err.message });
  });
  server = app.listen(0, () => {
    base = `http://127.0.0.1:${server.address().port}`;
    done();
  });
});

afterAll((done) => {
  server.close(done);
});

function recurringPestEstimate(overrides = {}) {
  return {
    id: overrides.id || 'est-atomic-1',
    token: overrides.token || 'tok-atomic-1',
    status: 'sent',
    customer_id: null,
    customer_name: 'Pat Tester',
    customer_phone: '(941) 555-0123',
    customer_email: 'pat@example.com',
    address: '123 Palm Ave, Bradenton, FL',
    monthly_total: 60,
    annual_total: 720,
    onetime_total: 0,
    waveguard_tier: 'Bronze',
    show_one_time_option: false,
    bill_by_invoice: false,
    expires_at: null,
    price_locked_at: null,
    archived_at: null,
    accepted_service_mode: null,
    accepted_frequency_key: null,
    estimate_data: JSON.stringify({
      result: {
        recurring: {
          discount: 0,
          services: [{ name: 'Pest Control', service: 'pest_control', mo: 60 }],
        },
        oneTime: { items: [], membershipFee: 99 },
      },
    }),
    ...overrides,
  };
}

function resetStore(estimateRow) {
  db.__state.tables = {
    estimates: estimateRow ? [estimateRow] : [],
    customers: [],
    invoices: [],
    scheduled_services: [],
    annual_prepay_terms: [],
    property_preferences: [],
    notification_prefs: [],
  };
}

function storedEstimate() {
  return db.__state.tables.estimates[0];
}

async function putAccept(token, body = {}) {
  const res = await fetch(`${base}/api/estimates/${token}/accept`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: res.status, data: await res.json() };
}

beforeEach(() => {
  jest.clearAllMocks();
  InvoiceService.create.mockImplementation(async () => ({
    id: 'inv-1', token: 'invtok1', total: 159, applied_deposit_credit: 0,
  }));
  InvoiceService.sendViaSMSAndEmail.mockImplementation(async () => ({
    ok: true, payUrl: null, sms: { ok: true }, email: { ok: true },
  }));
});

describe('FIX 1 — standard recurring conversion is atomic with acceptance', () => {
  test('conversion failure rolls the acceptance back (5xx, estimate stays retryable) and a retry succeeds', async () => {
    resetStore(recurringPestEstimate());
    EstimateConverter.convertEstimate.mockRejectedValueOnce(new Error('conversion boom'));

    const failed = await putAccept('tok-atomic-1');
    expect(failed.status).toBeGreaterThanOrEqual(500);
    // Rolled back: NOT accepted, price NOT locked, no orphan customer, no invoice.
    expect(storedEstimate().status).toBe('sent');
    expect(storedEstimate().price_locked_at == null).toBe(true);
    expect(storedEstimate().customer_id == null).toBe(true);
    expect(db.__state.tables.customers).toHaveLength(0);
    // No comms fired for the failed accept.
    expect(InvoiceService.sendViaSMSAndEmail).not.toHaveBeenCalled();

    // Retry: conversion succeeds → acceptance commits with the invoice.
    EstimateConverter.convertEstimate.mockResolvedValueOnce({
      customerId: 'cust-1',
      tier: 'Bronze',
      monthlyRate: 60,
      firstScheduledServiceId: null,
      recurringConversionSkipped: false,
      welcomeSms: null,
      membershipEmail: null,
      deferredFollowUpReminderRows: [],
    });
    const retried = await putAccept('tok-atomic-1');
    expect(retried.status).toBe(200);
    expect(retried.data.success).toBe(true);
    expect(retried.data.nextStep).toBe('pay_invoice');
    expect(retried.data.invoiceId).toBe('inv-1');
    expect(retried.data.invoicePayUrl).toContain('/pay/invtok1');
    expect(storedEstimate().status).toBe('accepted');
    expect(storedEstimate().price_locked_at != null).toBe(true);

    // The conversion ran INSIDE the transaction with comms deferred.
    const opts = EstimateConverter.convertEstimate.mock.calls.at(-1)[1];
    expect(opts.database).toBeDefined();
    expect(opts.autoSendInvoice).toBe(false);
    expect(opts.skipSetupInvoice).toBe(true);
    expect(opts.skipMembershipEmail).toBe(true);
    expect(opts.deferFollowUpReminderRegistration).toBe(true);
    // The setup/first-application invoice was minted on the SAME transaction
    // (deposit-credit ready) and delivered post-commit.
    const createArgs = InvoiceService.create.mock.calls.at(-1)[0];
    expect(createArgs.database).toBeDefined();
    expect(createArgs.title).toContain('WaveGuard Membership Setup');
    expect(InvoiceService.sendViaSMSAndEmail).toHaveBeenCalledWith('inv-1', expect.anything());
  });

  test('in-transaction invoice mint failure also rolls the acceptance back', async () => {
    resetStore(recurringPestEstimate({ id: 'est-atomic-2', token: 'tok-atomic-2' }));
    EstimateConverter.convertEstimate.mockResolvedValueOnce({
      customerId: 'cust-1',
      firstScheduledServiceId: null,
      recurringConversionSkipped: false,
      welcomeSms: null,
      membershipEmail: null,
      deferredFollowUpReminderRows: [],
    });
    InvoiceService.create.mockRejectedValueOnce(new Error('invoice boom'));

    const failed = await putAccept('tok-atomic-2');
    expect(failed.status).toBeGreaterThanOrEqual(500);
    expect(storedEstimate().status).toBe('sent');
    expect(storedEstimate().price_locked_at == null).toBe(true);
    expect(InvoiceService.sendViaSMSAndEmail).not.toHaveBeenCalled();
  });
});

describe('FIX 2 — already-accepted retry returns the full success payload', () => {
  test('recurring accept retry rebuilds nextStep/invoice fields from persisted state with no side effects', async () => {
    const accepted = recurringPestEstimate({
      id: 'est-already-1',
      token: 'tok-already-1',
      status: 'accepted',
      customer_id: 'cust-9',
      accepted_service_mode: 'recurring',
      price_locked_at: new Date(),
    });
    resetStore(accepted);
    db.__state.tables.invoices = [{
      id: 'inv-9',
      token: 'invtok9',
      total: '159.00',
      status: 'sent',
      sent_at: new Date(),
      sms_sent_at: null,
      payer_id: null,
      created_at: new Date(),
      title: 'WaveGuard Membership Setup + First Application',
      notes: 'Auto-generated from accepted estimate #est-already-1. Customer selected pay per application — $99 setup fee plus first application.',
    }];
    db.__state.tables.scheduled_services = [{
      id: 'ss-9',
      source_estimate_id: 'est-already-1',
      customer_id: 'cust-9',
      reservation_expires_at: null,
      scheduled_date: '2026-07-20',
    }];

    const res = await putAccept('tok-already-1');
    expect(res.status).toBe(200);
    expect(res.data.success).toBe(true);
    expect(res.data.alreadyAccepted).toBe(true);
    // The full first-time payload shape, not the bare legacy one.
    expect(res.data.nextStep).toBe('pay_invoice');
    expect(res.data.serviceMode).toBe('recurring');
    expect(res.data.invoiceMode).toBe(true);
    expect(res.data.invoiceId).toBe('inv-9');
    expect(res.data.invoiceAmount).toBe(159);
    expect(res.data.invoiceLinkDelivered).toBe(true);
    expect(res.data.billingTerm).toBe('standard');
    expect(res.data.reservationCommitted).toBe(true);
    expect(res.data.invoicePayUrl).toContain('/pay/invtok9');
    expect(res.data.invoicePayUrl).toContain('billingTerm=standard');

    // NO side effects re-ran: no conversion, no invoice mint, no re-send,
    // and the estimate row is untouched.
    expect(EstimateConverter.convertEstimate).not.toHaveBeenCalled();
    expect(InvoiceService.create).not.toHaveBeenCalled();
    expect(InvoiceService.sendViaSMSAndEmail).not.toHaveBeenCalled();
    expect(storedEstimate().status).toBe('accepted');
  });

  test('unbooked one-time accept retry returns book_one_time with a booking link', async () => {
    const accepted = recurringPestEstimate({
      id: 'est-already-2',
      token: 'tok-already-2',
      status: 'accepted',
      accepted_service_mode: 'one_time',
      price_locked_at: new Date(),
      onetime_total: 250,
      estimate_data: JSON.stringify({
        result: {
          recurring: { services: [] },
          oneTime: { items: [{ name: 'German Roach Cleanout', price: 250 }], membershipFee: 0 },
        },
      }),
    });
    resetStore(accepted);

    const res = await putAccept('tok-already-2');
    expect(res.status).toBe(200);
    expect(res.data.alreadyAccepted).toBe(true);
    expect(res.data.serviceMode).toBe('one_time');
    expect(res.data.nextStep).toBe('book_one_time');
    expect(res.data.reservationCommitted).toBe(false);
    expect(res.data.bookingUrl).toContain('/book?service=');
    expect(EstimateConverter.convertEstimate).not.toHaveBeenCalled();
    expect(InvoiceService.create).not.toHaveBeenCalled();
  });
});

describe('FIX 3 — email-only (phoneless) standard accepts fail closed pre-commit', () => {
  test('phoneless recurring accept 400s before the transaction and commits nothing', async () => {
    resetStore(recurringPestEstimate({
      id: 'est-phoneless-1',
      token: 'tok-phoneless-1',
      customer_phone: null,
      customer_email: 'emailonly@example.com',
    }));

    const res = await putAccept('tok-phoneless-1');
    expect(res.status).toBe(400);
    expect(res.data.code).toBe('CUSTOMER_CONTACT_REQUIRED');
    expect(res.data.error).toMatch(/call the Waves office/i);
    // Pre-commit: nothing changed, nothing ran.
    expect(storedEstimate().status).toBe('sent');
    expect(storedEstimate().price_locked_at == null).toBe(true);
    expect(db.__state.tables.customers).toHaveLength(0);
    expect(db.__state.tables.invoices).toHaveLength(0);
    expect(EstimateConverter.convertEstimate).not.toHaveBeenCalled();
    expect(InvoiceService.create).not.toHaveBeenCalled();
  });

  test('a linked customer (no phone) still accepts — the guard keys on missing customer AND phone', async () => {
    resetStore(recurringPestEstimate({
      id: 'est-linked-1',
      token: 'tok-linked-1',
      customer_phone: null,
      customer_id: 'cust-77',
    }));
    db.__state.tables.customers = [{ id: 'cust-77', first_name: 'Pat', last_name: 'Tester', phone: null }];
    EstimateConverter.convertEstimate.mockResolvedValueOnce({
      customerId: 'cust-77',
      firstScheduledServiceId: null,
      recurringConversionSkipped: false,
      welcomeSms: null,
      membershipEmail: null,
      deferredFollowUpReminderRows: [],
    });

    const res = await putAccept('tok-linked-1');
    expect(res.status).toBe(200);
    expect(res.data.success).toBe(true);
    expect(storedEstimate().status).toBe('accepted');
  });

  test('a phoneless ONE-TIME accept with no appointment to bind still succeeds (needs no customer record)', async () => {
    resetStore(recurringPestEstimate({
      id: 'est-onetime-1',
      token: 'tok-onetime-1',
      customer_phone: null,
      customer_email: 'emailonly@example.com',
      monthly_total: 0,
      annual_total: 0,
      onetime_total: 250,
      estimate_data: JSON.stringify({
        result: {
          recurring: { services: [] },
          oneTime: { items: [{ name: 'German Roach Cleanout', price: 250 }], membershipFee: 0 },
        },
      }),
    }));

    const res = await putAccept('tok-onetime-1');
    expect(res.status).toBe(200);
    expect(res.data.success).toBe(true);
    expect(res.data.nextStep).toBe('book_one_time');
    expect(storedEstimate().status).toBe('accepted');
    expect(EstimateConverter.convertEstimate).not.toHaveBeenCalled();
  });
});
