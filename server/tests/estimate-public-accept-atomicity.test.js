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
 *
 * Pre-push audit round 2 (P0 + P1s on the retry rebuild / deferred comms):
 * 4. Archived accepted retry is REJECTED (409) before any payload rebuild —
 *    no invoice amounts, no bearer /pay or /book links.
 * 5. The deferred membership-started email is suppressed when the converter
 *    reported recurringConversionSkipped.
 * 6. A voided annual-prepay invoice is never surfaced on retry — the rebuild
 *    falls back to the live accept-mint invoice.
 * 7. The retry booking link derives its service canonically (skipping
 *    discount/setup rows), not from oneTimeList[0].name.
 *
 * Pre-push audit round 3 (P1s on the retry rebuild / deferred notification):
 * 8. Settled invoices (paid/processing/refunded/prepaid — canonical
 *    isInvoiceCollectibleStatus) are never surfaced as payable on retry: the
 *    outcome is confirmed, with no /pay link and invoiceMode false.
 * 9. Booking URLs (fresh accept + retry) carry estimate_id so the /book
 *    confirm flow can stamp scheduled_services.source_estimate_id — the field
 *    retry booking detection keys on.
 * 10. Retries are idempotent on short links: an existing code for the same
 *    target is reused, a mint happens at most once, and never channel 'sms'
 *    (the on-screen retry link rides no text; the click-followup queue scans
 *    channel='sms').
 * 11. The commercial-schedule admin notification is deferred: dispatched
 *    exactly once after commit, never when the accept transaction rolls back.
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
      notes: 'Auto-generated from accepted estimate #est-already-1. Customer selected pay per application — $99.00 setup fee plus first application.',
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
    // The retry link carries the estimate correlation the /book confirm flow
    // stamps into scheduled_services.source_estimate_id.
    expect(res.data.bookingUrl).toContain('estimate_id=est-already-2');
    expect(EstimateConverter.convertEstimate).not.toHaveBeenCalled();
    expect(InvoiceService.create).not.toHaveBeenCalled();
  });
});

describe('AUDIT P0 — archived accepted retry is rejected before the payload rebuild', () => {
  test('archived accepted estimate gets 409 with no invoice amounts, no pay URL, no booking URL', async () => {
    const archived = recurringPestEstimate({
      id: 'est-archived-1',
      token: 'tok-archived-1',
      status: 'accepted',
      customer_id: 'cust-9',
      accepted_service_mode: 'recurring',
      price_locked_at: new Date(),
      archived_at: new Date(),
    });
    resetStore(archived);
    // A real linked invoice exists — the guard must reject BEFORE the rebuild
    // would find it, so none of these fields may leak.
    db.__state.tables.invoices = [{
      id: 'inv-arch',
      token: 'archtok',
      total: '159.00',
      status: 'sent',
      sent_at: new Date(),
      payer_id: null,
      created_at: new Date(),
      title: 'WaveGuard Membership Setup + First Application',
      notes: 'Auto-generated from accepted estimate #est-archived-1. Setup + first application.',
    }];

    const res = await putAccept('tok-archived-1');
    expect(res.status).toBe(409);
    expect(res.data.error).toMatch(/no longer active/i);
    // No secondary credentials or amounts anywhere in the response.
    const raw = JSON.stringify(res.data);
    expect(raw).not.toContain('archtok');
    expect(raw).not.toContain('/pay/');
    expect(raw).not.toContain('/book');
    expect(raw).not.toContain('159');
    expect(res.data.success).toBeUndefined();
    expect(res.data.invoicePayUrl).toBeUndefined();
    expect(res.data.invoiceAmount).toBeUndefined();
    expect(res.data.bookingUrl).toBeUndefined();
    // Read-only rejection: no side effects, estimate untouched.
    expect(EstimateConverter.convertEstimate).not.toHaveBeenCalled();
    expect(InvoiceService.create).not.toHaveBeenCalled();
    expect(storedEstimate().status).toBe('accepted');
  });
});

describe('AUDIT P1 — membership-started email suppressed for skipped conversions', () => {
  test('membershipEmail is NOT sent when recurringConversionSkipped is true', async () => {
    resetStore(recurringPestEstimate({ id: 'est-skip-1', token: 'tok-skip-1' }));
    EstimateConverter.convertEstimate.mockResolvedValueOnce({
      customerId: 'cust-1',
      firstScheduledServiceId: null,
      recurringConversionSkipped: true,
      welcomeSms: null,
      membershipEmail: { customerId: 'cust-1', tier: 'Bronze' },
      deferredFollowUpReminderRows: [],
    });

    const res = await putAccept('tok-skip-1');
    expect(res.status).toBe(200);
    expect(res.data.success).toBe(true);
    const AccountMembershipEmail = require('../services/account-membership-email');
    expect(AccountMembershipEmail.sendMembershipStarted).not.toHaveBeenCalled();
  });

  test('control: membershipEmail IS sent when the conversion actually ran', async () => {
    resetStore(recurringPestEstimate({ id: 'est-noskip-1', token: 'tok-noskip-1' }));
    EstimateConverter.convertEstimate.mockResolvedValueOnce({
      customerId: 'cust-1',
      firstScheduledServiceId: null,
      recurringConversionSkipped: false,
      welcomeSms: null,
      membershipEmail: { customerId: 'cust-1', tier: 'Bronze' },
      deferredFollowUpReminderRows: [],
    });

    const res = await putAccept('tok-noskip-1');
    expect(res.status).toBe(200);
    const AccountMembershipEmail = require('../services/account-membership-email');
    expect(AccountMembershipEmail.sendMembershipStarted)
      .toHaveBeenCalledWith({ customerId: 'cust-1', tier: 'Bronze' });
  });
});

describe('AUDIT P1 — voided annual-prepay invoice is not surfaced on retry', () => {
  test('retry skips the voided prepay-term invoice and falls back to the live accept-mint invoice', async () => {
    const accepted = recurringPestEstimate({
      id: 'est-prepay-1',
      token: 'tok-prepay-1',
      status: 'accepted',
      customer_id: 'cust-9',
      accepted_service_mode: 'recurring',
      price_locked_at: new Date(),
    });
    resetStore(accepted);
    db.__state.tables.annual_prepay_terms = [{
      id: 'apt-1',
      source_estimate_id: 'est-prepay-1',
      prepay_invoice_id: 'inv-void',
      created_at: new Date(),
    }];
    db.__state.tables.invoices = [
      {
        id: 'inv-void',
        token: 'voidtok',
        total: '684.00',
        status: 'void',
        sent_at: new Date(),
        payer_id: null,
        created_at: new Date(),
        title: 'Annual prepay',
        notes: 'Auto-generated from accepted estimate #est-prepay-1. Annual prepay.',
      },
      {
        id: 'inv-live',
        token: 'livetok',
        total: '700.00',
        status: 'sent',
        sent_at: new Date(),
        payer_id: null,
        created_at: new Date(),
        title: 'Annual prepay (rebilled)',
        notes: 'Auto-generated from accepted estimate #est-prepay-1. Annual prepay rebilled.',
      },
    ];

    const res = await putAccept('tok-prepay-1');
    expect(res.status).toBe(200);
    expect(res.data.alreadyAccepted).toBe(true);
    // The dead /pay token never appears; the live invoice does.
    expect(JSON.stringify(res.data)).not.toContain('voidtok');
    expect(res.data.invoiceId).toBe('inv-live');
    expect(res.data.invoicePayUrl).toContain('/pay/livetok');
    expect(res.data.billingTerm).toBe('prepay_annual');
  });
});

describe('AUDIT P1 — retry booking link uses canonical service selection', () => {
  test('a lawn one-time estimate whose FIRST row is a discount line still routes to the lawn funnel', async () => {
    const accepted = recurringPestEstimate({
      id: 'est-lawnretry-1',
      token: 'tok-lawnretry-1',
      status: 'accepted',
      accepted_service_mode: 'one_time',
      price_locked_at: new Date(),
      monthly_total: 0,
      annual_total: 0,
      onetime_total: 275,
      estimate_data: JSON.stringify({
        result: {
          recurring: { services: [] },
          oneTime: {
            items: [
              // Non-billable discount row first — the old oneTimeList[0].name
              // derivation fed this to bookingServiceFor and defaulted the
              // customer into the pest-control funnel.
              { name: 'Bundle Discount', service: 'one_time_adjustment', price: -25 },
              { name: 'Lawn Aeration & Overseed', service: 'lawn_care', price: 300 },
            ],
            membershipFee: 0,
          },
        },
      }),
    });
    resetStore(accepted);

    const res = await putAccept('tok-lawnretry-1');
    expect(res.status).toBe(200);
    expect(res.data.alreadyAccepted).toBe(true);
    expect(res.data.nextStep).toBe('book_one_time');
    expect(res.data.bookingUrl).toContain('service=lawn_care');
    expect(res.data.bookingUrl).not.toContain('service=pest_control');
  });
});

describe('AUDIT R3 P1 — settled invoices never surface as payable on retry', () => {
  test.each(['paid', 'processing', 'refunded'])(
    'a %s stamped invoice yields the confirmed outcome — no pay_invoice, no /pay link, invoiceMode false',
    async (settledStatus) => {
      const accepted = recurringPestEstimate({
        id: 'est-settled-1',
        token: 'tok-settled-1',
        status: 'accepted',
        customer_id: 'cust-9',
        accepted_service_mode: 'recurring',
        price_locked_at: new Date(),
      });
      resetStore(accepted);
      db.__state.tables.invoices = [{
        id: 'inv-settled',
        token: 'settledtok',
        total: '159.00',
        status: settledStatus,
        sent_at: new Date(),
        sms_sent_at: null,
        payer_id: null,
        created_at: new Date(),
        title: 'WaveGuard Membership Setup + First Application',
        notes: 'Auto-generated from accepted estimate #est-settled-1. Customer selected pay per application — $99.00 setup fee plus first application.',
      }];
      db.__state.tables.scheduled_services = [{
        id: 'ss-settled',
        source_estimate_id: 'est-settled-1',
        customer_id: 'cust-9',
        reservation_expires_at: null,
        scheduled_date: '2026-07-20',
      }];

      const res = await putAccept('tok-settled-1');
      expect(res.status).toBe(200);
      expect(res.data.alreadyAccepted).toBe(true);
      expect(res.data.nextStep).toBe('confirmed');
      expect(res.data.invoiceMode).toBe(false);
      expect(res.data.invoicePayUrl == null).toBe(true);
      // The settled invoice's bearer /pay token must not appear anywhere.
      expect(JSON.stringify(res.data)).not.toContain('settledtok');
      expect(JSON.stringify(res.data)).not.toContain('/pay/');
    },
  );

  test('a prepaid annual-prepay term invoice yields confirmed, not prepay_invoice/pay_invoice', async () => {
    const accepted = recurringPestEstimate({
      id: 'est-prepaid-1',
      token: 'tok-prepaid-1',
      status: 'accepted',
      customer_id: 'cust-9',
      accepted_service_mode: 'recurring',
      price_locked_at: new Date(),
    });
    resetStore(accepted);
    db.__state.tables.annual_prepay_terms = [{
      id: 'apt-paid',
      source_estimate_id: 'est-prepaid-1',
      prepay_invoice_id: 'inv-prepaid',
      created_at: new Date(),
    }];
    db.__state.tables.invoices = [{
      id: 'inv-prepaid',
      token: 'prepaidtok',
      total: '684.00',
      status: 'prepaid',
      sent_at: new Date(),
      payer_id: null,
      created_at: new Date(),
      title: 'Annual prepay',
      notes: 'Auto-generated from accepted estimate #est-prepaid-1. Annual prepay.',
    }];

    const res = await putAccept('tok-prepaid-1');
    expect(res.status).toBe(200);
    expect(res.data.alreadyAccepted).toBe(true);
    // Without the settled override, billingTerm='prepay_annual' would fall
    // through to 'prepay_invoice' (and pre-fix, invoiceMode drove pay_invoice).
    expect(res.data.nextStep).toBe('confirmed');
    expect(res.data.invoiceMode).toBe(false);
    expect(res.data.billingTerm).toBe('prepay_annual');
    expect(JSON.stringify(res.data)).not.toContain('prepaidtok');
    expect(JSON.stringify(res.data)).not.toContain('/pay/');
  });

  test('a re-billed estimate (settled + collectible stamped invoices) surfaces the collectible one', async () => {
    const accepted = recurringPestEstimate({
      id: 'est-rebill-1',
      token: 'tok-rebill-1',
      status: 'accepted',
      customer_id: 'cust-9',
      accepted_service_mode: 'recurring',
      price_locked_at: new Date(),
    });
    resetStore(accepted);
    db.__state.tables.invoices = [
      {
        id: 'inv-refunded',
        token: 'refundedtok',
        total: '159.00',
        status: 'refunded',
        sent_at: new Date(),
        payer_id: null,
        created_at: new Date(),
        title: 'WaveGuard Membership Setup',
        notes: 'Auto-generated from accepted estimate #est-rebill-1. Setup.',
      },
      {
        id: 'inv-rebilled',
        token: 'rebilledtok',
        total: '159.00',
        status: 'sent',
        sent_at: new Date(),
        payer_id: null,
        created_at: new Date(),
        title: 'WaveGuard Membership Setup (re-billed)',
        notes: 'Auto-generated from accepted estimate #est-rebill-1. Setup re-billed.',
      },
    ];

    const res = await putAccept('tok-rebill-1');
    expect(res.status).toBe(200);
    expect(res.data.nextStep).toBe('pay_invoice');
    expect(res.data.invoiceId).toBe('inv-rebilled');
    expect(res.data.invoicePayUrl).toContain('/pay/rebilledtok');
    expect(JSON.stringify(res.data)).not.toContain('refundedtok');
  });
});

describe('AUDIT R3 P1 — retry short links are idempotent and never SMS-attributed', () => {
  function unbookedOneTime(overrides = {}) {
    return recurringPestEstimate({
      id: 'est-shortlink-1',
      token: 'tok-shortlink-1',
      status: 'accepted',
      accepted_service_mode: 'one_time',
      price_locked_at: new Date(),
      monthly_total: 0,
      annual_total: 0,
      onetime_total: 300,
      estimate_data: JSON.stringify({
        result: {
          recurring: { services: [] },
          oneTime: {
            items: [{ name: 'Lawn Aeration & Overseed', service: 'lawn_care', price: 300 }],
            membershipFee: 0,
          },
        },
      }),
      ...overrides,
    });
  }

  test('repeated retries mint at most ONE short_codes row, channel never sms, and reuse the same link', async () => {
    resetStore(unbookedOneTime());
    const shortUrlSvc = require('../services/short-url');
    // Mirror the real service for ONE call: minting persists a permanent
    // short_codes row (the fake-db table the retry reuse lookup reads).
    shortUrlSvc.shortenOrPassthrough.mockImplementationOnce(async (url, opts = {}) => {
      db.__state.tables.short_codes = db.__state.tables.short_codes || [];
      db.__state.tables.short_codes.push({
        id: 'sc-retry-1',
        code: 'ret42',
        target_url: url,
        entity_type: opts.entityType,
        entity_id: opts.entityId,
        purpose: opts.purpose,
        channel: opts.channel,
        kind: opts.kind,
        created_at: new Date(),
        expires_at: null,
      });
      return 'https://portal.wavespestcontrol.com/l/ret42';
    });

    const first = await putAccept('tok-shortlink-1');
    expect(first.status).toBe(200);
    expect(first.data.nextStep).toBe('book_one_time');
    expect(first.data.bookingUrl).toBe('https://portal.wavespestcontrol.com/l/ret42');
    expect(shortUrlSvc.shortenOrPassthrough).toHaveBeenCalledTimes(1);
    expect(shortUrlSvc.shortenOrPassthrough.mock.calls[0][1].channel).toBe('web');
    expect(shortUrlSvc.shortenOrPassthrough.mock.calls[0][0]).toContain('estimate_id=est-shortlink-1');

    const second = await putAccept('tok-shortlink-1');
    expect(second.status).toBe(200);
    expect(second.data.bookingUrl).toBe('https://portal.wavespestcontrol.com/l/ret42');
    // No second mint: the row count is unchanged and the shortener never ran again.
    expect(shortUrlSvc.shortenOrPassthrough).toHaveBeenCalledTimes(1);
    expect(db.__state.tables.short_codes).toHaveLength(1);
    for (const call of shortUrlSvc.shortenOrPassthrough.mock.calls) {
      expect(call[1].channel).not.toBe('sms');
    }
  });

  test('an accept-time short code for the same target is reused — the retry mints nothing', async () => {
    resetStore(unbookedOneTime({ id: 'est-shortlink-2', token: 'tok-shortlink-2' }));
    db.__state.tables.short_codes = [{
      id: 'sc-accept-1',
      code: 'acc99',
      // Exactly the URL the retry rebuilds (service derived canonically +
      // estimate correlation) — as the fresh accept now mints it.
      target_url: 'https://portal.wavespestcontrol.com/book?service=lawn_care&source=estimate-accept&estimate_id=est-shortlink-2',
      entity_type: 'estimates',
      entity_id: 'est-shortlink-2',
      purpose: 'estimate_accept_booking',
      channel: 'sms',
      kind: 'booking',
      created_at: new Date(),
      expires_at: null,
    }];
    const shortUrlSvc = require('../services/short-url');

    const res = await putAccept('tok-shortlink-2');
    expect(res.status).toBe(200);
    expect(res.data.nextStep).toBe('book_one_time');
    expect(res.data.bookingUrl).toBe('https://portal.wavespestcontrol.com/l/acc99');
    expect(shortUrlSvc.shortenOrPassthrough).not.toHaveBeenCalled();
    expect(db.__state.tables.short_codes).toHaveLength(1);
  });
});

describe('AUDIT R3 P1 — commercial-schedule admin notification is post-commit only', () => {
  const commercialNotification = (estimateId) => ({
    type: 'estimate_converted',
    title: 'Commercial schedule needed: Pat Tester',
    body: `Accepted commercial recurring estimate #${estimateId} — set up the schedule manually.`,
    options: { icon: '\u{1F4C5}', link: '/admin/dispatch', metadata: { estimateId, customerId: 'cust-1' } },
  });

  test('dispatched exactly once after the accept transaction commits', async () => {
    resetStore(recurringPestEstimate({ id: 'est-notify-1', token: 'tok-notify-1' }));
    EstimateConverter.convertEstimate.mockResolvedValueOnce({
      customerId: 'cust-1',
      firstScheduledServiceId: null,
      recurringConversionSkipped: false,
      welcomeSms: null,
      membershipEmail: null,
      deferredFollowUpReminderRows: [],
      commercialScheduleNotification: commercialNotification('est-notify-1'),
    });

    const res = await putAccept('tok-notify-1');
    expect(res.status).toBe(200);
    // The route asked the converter to DEFER (no in-transaction global-DB notify)…
    const opts = EstimateConverter.convertEstimate.mock.calls.at(-1)[1];
    expect(opts.deferCommercialScheduleNotification).toBe(true);
    // …and dispatched the returned payload exactly once, post-commit.
    const NotificationService = require('../services/notification-service');
    const converted = NotificationService.notifyAdmin.mock.calls
      .filter((call) => call[0] === 'estimate_converted');
    expect(converted).toHaveLength(1);
    expect(converted[0][1]).toBe('Commercial schedule needed: Pat Tester');
    expect(converted[0][3]).toMatchObject({ link: '/admin/dispatch' });
  });

  test('NOT dispatched when the accept transaction rolls back after the conversion returned it', async () => {
    resetStore(recurringPestEstimate({ id: 'est-notify-2', token: 'tok-notify-2' }));
    EstimateConverter.convertEstimate.mockResolvedValueOnce({
      customerId: 'cust-1',
      firstScheduledServiceId: null,
      recurringConversionSkipped: false,
      welcomeSms: null,
      membershipEmail: null,
      deferredFollowUpReminderRows: [],
      commercialScheduleNotification: commercialNotification('est-notify-2'),
    });
    // The in-transaction invoice mint fails AFTER the conversion succeeded —
    // the whole acceptance rolls back.
    InvoiceService.create.mockRejectedValueOnce(new Error('invoice boom'));

    const failed = await putAccept('tok-notify-2');
    expect(failed.status).toBeGreaterThanOrEqual(500);
    expect(storedEstimate().status).toBe('sent');
    const NotificationService = require('../services/notification-service');
    const converted = NotificationService.notifyAdmin.mock.calls
      .filter((call) => call[0] === 'estimate_converted');
    expect(converted).toHaveLength(0);
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
    // The FRESH accept's booking link also carries the estimate correlation —
    // a booking completed through the SMS'd link must be visible to a later
    // already-accepted retry (source_estimate_id probe).
    expect(res.data.bookingUrl).toContain('estimate_id=est-onetime-1');
    expect(storedEstimate().status).toBe('accepted');
    expect(EstimateConverter.convertEstimate).not.toHaveBeenCalled();
  });
});
