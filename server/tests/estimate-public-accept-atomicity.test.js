process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret';

jest.mock('../routes/admin-customers', () => {
  const actual = jest.requireActual('../routes/admin-customers');
  return { ...actual, _private: { ...actual._private, lockAndAssertNoAnnualPrepayOverlap: jest.fn().mockResolvedValue() } };
});

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
 *
 * Acceptance terms (GATE_ESTIMATE_ACCEPTANCE_TERMS, owner ruling 2026-08-28):
 * 12. Gate on + the client attests the served version → ONE estimate_acceptances
 *    row (verbatim snapshot, ip, ua, accepted_at) written in the accept
 *    transaction, estimates.terms_version + customers.accepted_terms_version
 *    stamped; a rolled-back accept leaves no record. A stale version 409s
 *    TERMS_VERSION_STALE before any mutation; an absent one (a pre-gate tab)
 *    accepts unrecorded. A gate-off server ignores the field and records
 *    nothing. The recorded IP is the proxy-validated req.ip.
 */

// ── In-memory fake knex ────────────────────────────────────────────────────
// Just enough of the query-builder surface for the accept path: eq filters,
// null / not-null / not-in / not-eq / LIKE, first/update/insert/select, and
// db.transaction with REAL rollback semantics (snapshot + restore) so the
// atomicity assertions observe genuine transactional behavior.
jest.mock('../models/db', () => {
  // state.ops is an append-only statement log (raw calls + table updates, in
  // issue order) so tests can assert cross-statement ORDER — e.g. the accept
  // txn's rung-1 occupancy lock landing before its estimates UPDATE.
  const state = { tables: {}, ops: [], tryDepositLedgerBusy: false };

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
    // Join/limit surface for the plan-restart residual read (C4): the fake
    // has no second table to join, so both are inert pass-throughs (the
    // `s.`-prefixed filters simply match nothing against unprefixed rows).
    b.leftJoin = () => b;
    b.limit = () => b;
    // Row-lock + overlap-predicate surface the slot-commit path chains
    // (commitReservation's FOR UPDATE read, applyWindowOverlapFilter,
    // findConflictingVisits' hold filter). Lock/OR semantics are inert here —
    // fixtures keep the tables small enough that the eq/null filters decide.
    b.forUpdate = () => b;
    b.andWhereRaw = () => b;
    b.orWhereNull = () => b;
    b.orWhereNot = () => b;
    b.first = async () => {
      // Simulated read failure for fail-closed assertions (state.failTables).
      if (state.failTables && state.failTables.has(table)) throw new Error(`simulated db failure: ${table}`);
      const row = matched()[0];
      return row ? { ...row } : undefined;
    };
    b.update = (obj) => {
      // Applies eagerly (same timing as the old async impl — mutation landed
      // at call time), logs the statement for order assertions, and supports
      // BOTH `await ...update(obj)` → count and `...update(obj).returning()`
      // → rows (commitReservation's graduation UPDATE uses the latter).
      state.ops.push({ type: 'update', table, data: obj });
      const hits = matched();
      // Atomic JSON-path stamps (`jsonb_set(estimate_data, '{key}', value)`)
      // reach this fake as the raw marker object; apply the keys to the
      // stored JSON instead of replacing the column with the marker, so a
      // later read of estimate_data (proposal, delivery marker) still parses.
      const applyJsonbSet = (row, column, raw) => {
        const sql = String(raw.__raw);
        const bindings = Array.isArray(raw.bindings) ? [...raw.bindings] : [];
        const wasString = typeof row[column] === 'string';
        let data = row[column];
        if (wasString) { try { data = JSON.parse(data); } catch { data = {}; } }
        data = data && typeof data === 'object' ? data : {};
        const re = /'\{([A-Za-z0-9_]+)\}',\s*(to_jsonb\(\?::text\)|'true'::jsonb|'false'::jsonb|\?::jsonb)/g;
        let m;
        while ((m = re.exec(sql))) {
          const [, key, valueSrc] = m;
          if (valueSrc === "'true'::jsonb") data[key] = true;
          else if (valueSrc === "'false'::jsonb") data[key] = false;
          else {
            const b = bindings.shift();
            data[key] = valueSrc === '?::jsonb' ? JSON.parse(b) : b;
          }
        }
        row[column] = wasString ? JSON.stringify(data) : data;
      };
      hits.forEach((row) => {
        for (const [col, val] of Object.entries(obj)) {
          if (val && typeof val === 'object' && val.__raw && String(val.__raw).includes('jsonb_set(')) applyJsonbSet(row, col, val);
          else if (val && typeof val === 'object' && val.__raw && String(val.__raw).startsWith("?::jsonb || jsonb_strip_nulls(jsonb_build_object('rateReviewTermsServed'")) {
            // The accept's wholesale estimate_data write merges the ROW's
            // current served marker over the snapshot it was built from.
            const wasString = typeof row[col] === 'string';
            let existing = row[col];
            if (wasString) { try { existing = JSON.parse(existing); } catch { existing = {}; } }
            const next = JSON.parse(val.bindings[0]);
            if (existing && typeof existing === 'object' && existing.rateReviewTermsServed != null) next.rateReviewTermsServed = existing.rateReviewTermsServed;
            row[col] = wasString ? JSON.stringify(next) : next;
          }
          else row[col] = val;
        }
      });
      return {
        returning: async () => hits.map((r) => ({ ...r })),
        then: (res, rej) => Promise.resolve(hits.length).then(res, rej),
        catch: (fn) => Promise.resolve(hits.length).catch(fn),
      };
    };
    b.insert = (row) => {
      const stored = { id: row.id || `${table}-${rows().length + 1}`, ...row };
      rows().push(stored);
      const result = {
        returning: async () => [{ ...stored }],
        then: (res, rej) => Promise.resolve([{ ...stored }]).then(res, rej),
        catch: () => Promise.resolve([{ ...stored }]),
      };
      // onConflict().ignore() — the default-rows helper chains it; the fake
      // has no unique indexes, so ignore just resolves the insert.
      result.onConflict = () => ({ ...result, ignore: () => result });
      return result;
    };
    b.del = async () => 0;
    b.pluck = async () => [];
    b.count = () => ({ first: async () => ({ count: matched().length }) });
    b.then = (res, rej) => Promise.resolve(matched().map((r) => ({ ...r }))).then(res, rej);
    b.catch = (fn) => Promise.resolve(matched().map((r) => ({ ...r }))).catch(fn);
    return b;
  };

  // state.onTable: a per-test hook fired on EVERY table access (root and
  // transaction alike) so a test can interleave a concurrent write at a
  // chosen point inside the accept transaction.
  const dbFn = (table) => { if (typeof state.onTable === 'function') state.onTable(table); return makeBuilder(table); };
  dbFn.fn = { now: () => new Date() };
  dbFn.raw = (sql, bindings) => {
    // Advisory-lock statements (`pg_advisory_xact_lock`) flow through here —
    // logged so tests can assert rung-1 ordering against table mutations.
    state.ops.push({ type: 'raw', sql, bindings });
    if (sql.includes('pg_try_advisory_xact_lock')) {
      return { rows: [{ acquired: !(bindings?.[0] === 'estimate.deposit.ledger' && state.tryDepositLedgerBusy) }] };
    }
    return { __raw: sql, bindings };
  };
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
// stampCombinedFirstApplicationInvoiceCoverage is a bare spy (never the real
// impl — it needs a real DB, and this suite's knex is a fake) so tests can
// assert it was invoked (or not) with the right args, same style as
// convertEstimate above. shouldAttachScheduledServiceToStandardDraftInvoice
// wraps the REAL implementation by default (existing tests all exercise its
// real gate) but can be overridden per-test to force the attach path without
// reconstructing the full pricing pipeline in this fake-knex harness.
jest.mock('../services/estimate-converter', () => {
  const actual = jest.requireActual('../services/estimate-converter');
  return {
    ...actual,
    convertEstimate: jest.fn(),
    stampCombinedFirstApplicationInvoiceCoverage: jest.fn().mockResolvedValue(),
    shouldAttachScheduledServiceToStandardDraftInvoice: jest.fn(actual.shouldAttachScheduledServiceToStandardDraftInvoice),
  };
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
// The public /pdf download, pdfkit path: the real generator streams a PDF
// through pdfkit; here it only needs to end the response so the served
// marker written beside it can be asserted.
// The browser document renderer: never reachable in tests (no headless
// browser); the mock lets the /pdf route tests pin WHEN it is attempted.
jest.mock('../services/pdf/estimate-doc-pdf', () => {
  const actual = jest.requireActual('../services/pdf/estimate-doc-pdf');
  return { ...actual, renderEstimateDocumentPdf: jest.fn(async () => { throw new Error('no browser in tests'); }) };
});
jest.mock('../services/pdf/estimate-pdf', () => ({
  generateEstimateProposalPDF: jest.fn((estimate, res) => {
    res.set('Content-Type', 'application/pdf');
    res.end('%PDF-1.4 test');
  }),
}));
jest.mock('../services/lead-estimate-link', () => ({
  markLinkedLeadEstimateAccepted: jest.fn(async () => ({})),
  markLinkedLeadEstimateViewed: jest.fn(async () => ({})),
}));
// Gate values are fixed at module load; this passthrough lets the acceptance
// -terms cases flip GATE_ESTIMATE_ACCEPTANCE_TERMS per test.
const mockGateState = { acceptanceTerms: false, acceptanceTermsRequired: false };
jest.mock('../config/feature-gates', () => {
  const actual = jest.requireActual('../config/feature-gates');
  return {
    ...actual,
    isEnabled: (gate) => {
      if (gate === 'estimateAcceptanceTerms') return mockGateState.acceptanceTerms;
      if (gate === 'estimateAcceptanceTermsRequired') return mockGateState.acceptanceTermsRequired;
      return actual.isEnabled(gate);
    },
  };
});
jest.mock('../services/estimate-accepted-email', () => ({
  sendEstimateAcceptedOnboarding: jest.fn(async () => ({})),
}));
jest.mock('../services/notification-service', () => ({
  notifyAdmin: jest.fn(async () => ({})),
  notifyCustomer: jest.fn(async () => ({})),
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
    token: overrides.token || 'tok-atomic-1-x0123456789',
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
  db.__state.ops = [];
  db.__state.tryDepositLedgerBusy = false;
  db.__state.onTable = null;
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
  // clearAllMocks keeps queued *Once values: a test whose accept is refused
  // before conversion would otherwise hand its queued conversion to the next
  // test. convertEstimate has no default implementation, so a reset only
  // drops that leftover queue.
  EstimateConverter.convertEstimate.mockReset();
  InvoiceService.create.mockImplementation(async () => ({
    id: 'inv-1', token: 'invtok1', total: 159, applied_deposit_credit: 0,
  }));
  InvoiceService.sendViaSMSAndEmail.mockImplementation(async () => ({
    ok: true, payUrl: null, sms: { ok: true }, email: { ok: true },
  }));
});

describe('FIX 1 — standard recurring conversion is atomic with acceptance', () => {
  test('busy deposit ledger rolls back standard acceptance before its invoice mint', async () => {
    resetStore(recurringPestEstimate());
    db.__state.tryDepositLedgerBusy = true;
    EstimateConverter.convertEstimate.mockResolvedValueOnce({
      customerId: 'cust-1', firstScheduledServiceId: null,
      recurringConversionSkipped: false, deferredFollowUpReminderRows: [],
    });

    const response = await putAccept('tok-atomic-1-x0123456789');
    expect(response.status).toBe(409);
    expect(response.data.code).toBe('DEPOSIT_LEDGER_BUSY_RETRY');
    expect(storedEstimate().status).toBe('sent');
    expect(storedEstimate().price_locked_at == null).toBe(true);
    expect(db.__state.tables.invoices).toHaveLength(0);
    expect(InvoiceService.create).not.toHaveBeenCalled();
    expect(InvoiceService.sendViaSMSAndEmail).not.toHaveBeenCalled();
  });

  test('busy deposit ledger rolls back invoice-mode acceptance before its invoice mint', async () => {
    resetStore(recurringPestEstimate({ bill_by_invoice: true }));
    db.__state.tryDepositLedgerBusy = true;

    const response = await putAccept('tok-atomic-1-x0123456789');
    expect(response.status).toBe(409);
    expect(response.data.code).toBe('DEPOSIT_LEDGER_BUSY_RETRY');
    expect(storedEstimate().status).toBe('sent');
    expect(storedEstimate().price_locked_at == null).toBe(true);
    expect(db.__state.tables.invoices).toHaveLength(0);
    expect(InvoiceService.create).not.toHaveBeenCalled();
  });

  test('annual coverage overlap returns a billing code and rolls back acceptance', async () => {
    resetStore(recurringPestEstimate());
    const scheduledDate = require('../utils/datetime-et').etDateString(new Date(Date.now() + 7 * 86400000));
    db.__state.tables.scheduled_services = [{
      id: 'ss-prepay-hold', source_estimate_id: 'est-atomic-1',
      customer_id: null, technician_id: null, status: 'pending',
      scheduled_date: scheduledDate, window_start: '09:00:00', window_end: '10:00:00',
      estimated_duration_minutes: 60,
      reservation_expires_at: new Date(Date.now() + 15 * 60000),
    }];
    const { lockAndAssertNoAnnualPrepayOverlap } = require('../routes/admin-customers')._private;
    const overlap = new Error('Annual coverage already exists');
    overlap.annualPrepayOverlap = true;
    lockAndAssertNoAnnualPrepayOverlap.mockRejectedValueOnce(overlap);

    const response = await putAccept('tok-atomic-1-x0123456789', {
      paymentMethodPreference: 'prepay_annual',
      slotId: `${scheduledDate}_09-00_unassigned`,
    });

    expect(response.status).toBe(409);
    expect(response.data).toEqual({
      code: 'ANNUAL_PREPAY_OVERLAP',
      error: expect.stringContaining('already has an active annual prepay plan'),
    });
    expect(storedEstimate().status).toBe('sent');
    expect(storedEstimate().price_locked_at == null).toBe(true);
    expect(db.__state.tables.scheduled_services[0].customer_id).toBeNull();
    expect(db.__state.tables.scheduled_services[0].reservation_expires_at).toBeTruthy();
    expect(EstimateConverter.convertEstimate).not.toHaveBeenCalled();
    expect(InvoiceService.create).not.toHaveBeenCalled();
    expect(InvoiceService.sendViaSMSAndEmail).not.toHaveBeenCalled();
  });

  test('codex #4819 r6 P2: a deferred (sign-before-pay) accept quotes the park\'s FROZEN total — Station Setup included — never the setup-less display figure', async () => {
    resetStore(recurringPestEstimate());
    // Prepay requires a picked appointment; a sign-before-pay accept keeps it
    // only as a preference (nothing is committed).
    const scheduledDate = require('../utils/datetime-et').etDateString(new Date(Date.now() + 7 * 86400000));
    db.__state.tables.scheduled_services = [{
      id: 'ss-prepay-hold', source_estimate_id: 'est-atomic-1',
      customer_id: null, technician_id: null, status: 'pending',
      scheduled_date: scheduledDate, window_start: '09:00:00', window_end: '10:00:00',
      estimated_duration_minutes: 60,
      reservation_expires_at: new Date(Date.now() + 15 * 60000),
    }];
    EstimateConverter.convertEstimate.mockResolvedValueOnce({
      annualPlanActivationStatus: 'awaiting_signature',
      annualPlanDeferredTotal: 448,
    });

    const response = await putAccept('tok-atomic-1-x0123456789', {
      paymentMethodPreference: 'prepay_annual',
      slotId: `${scheduledDate}_09-00_unassigned`,
    });

    expect(response.status).toBe(200);
    expect(response.data.nextStep).toBe('sign_agreement');
    expect(response.data.invoiceAmount).toBe(448);
    expect(response.data.prepayInvoiceAmount).toBe(448);
    expect(response.data.invoicePayUrl == null).toBe(true);
    const NotificationService = require('../services/notification-service');
    const estimateNotice = NotificationService.notifyAdmin.mock.calls.find((call) => call[0] === 'estimate');
    expect(estimateNotice[2]).toContain('($448.00)');
    expect(InvoiceService.create).not.toHaveBeenCalled();
  });

  test('conversion failure rolls the acceptance back (5xx, estimate stays retryable) and a retry succeeds', async () => {
    resetStore(recurringPestEstimate());
    EstimateConverter.convertEstimate.mockRejectedValueOnce(new Error('conversion boom'));

    const failed = await putAccept('tok-atomic-1-x0123456789');
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
    const retried = await putAccept('tok-atomic-1-x0123456789');
    expect(retried.status).toBe(200);
    expect(retried.data.success).toBe(true);
    expect(retried.data.nextStep).toBe('pay_invoice');
    expect(retried.data.invoiceId).toBe('inv-1');
    expect(retried.data.invoicePayUrl).toContain('/pay/invtok1');
    expect(storedEstimate().status).toBe('accepted');
    expect(storedEstimate().price_locked_at != null).toBe(true);

    // The admin bell for the accepted-estimate notice deep-links to this
    // estimate (the same ?estimateId= shape estimate_hot_view already uses),
    // not the bare Estimates list.
    const NotificationService = require('../services/notification-service');
    const estimateNotice = NotificationService.notifyAdmin.mock.calls
      .find((call) => call[0] === 'estimate');
    expect(estimateNotice[3]).toMatchObject({ link: '/admin/estimates?estimateId=est-atomic-1' });

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

  test('a first-application invoice fully offset by deposit credit (settled_zero_due) is reported settled — never a pay link "sent", never nextStep pay_invoice (Codex round-8 audit P1 #4131)', async () => {
    resetStore(recurringPestEstimate({ id: 'est-atomic-1z', token: 'tok-atomic-1z-x0123456789' }));
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
    // The real settled_zero_due shape sendViaSMSAndEmail resolves for a
    // visit-linked invoice fully offset by deposit/account credit: ok:
    // true, but NOTHING was texted or emailed — payUrl is always null.
    InvoiceService.sendViaSMSAndEmail.mockImplementationOnce(async () => ({
      ok: true, settled_zero_due: true,
      sms: { ok: false, code: 'settled_zero_due' }, email: { ok: false, code: 'settled_zero_due' },
      payUrl: null,
    }));

    const response = await putAccept('tok-atomic-1z-x0123456789');

    expect(response.status).toBe(200);
    expect(response.data.success).toBe(true);
    // NOT pay_invoice — there is nothing left to pay.
    expect(response.data.nextStep).toBe('confirmed');
    expect(response.data.invoiceSettled).toBe(true);
    expect(response.data.invoiceLinkDelivered).toBe(false);
    expect(response.data.invoicePayUrl).toBeFalsy();
  });

  test('in-transaction invoice mint failure also rolls the acceptance back', async () => {
    resetStore(recurringPestEstimate({ id: 'est-atomic-2', token: 'tok-atomic-2-x0123456789' }));
    EstimateConverter.convertEstimate.mockResolvedValueOnce({
      customerId: 'cust-1',
      firstScheduledServiceId: null,
      recurringConversionSkipped: false,
      welcomeSms: null,
      membershipEmail: null,
      deferredFollowUpReminderRows: [],
    });
    InvoiceService.create.mockRejectedValueOnce(new Error('invoice boom'));

    const failed = await putAccept('tok-atomic-2-x0123456789');
    expect(failed.status).toBeGreaterThanOrEqual(500);
    expect(storedEstimate().status).toBe('sent');
    expect(storedEstimate().price_locked_at == null).toBe(true);
    expect(InvoiceService.sendViaSMSAndEmail).not.toHaveBeenCalled();
  });

  // Codex round-9 P1 (#5021): this public accept path mints the standard
  // setup/first-application invoice itself (skipSetupInvoice above) and,
  // unlike estimate-converter.js's own standard branch, never called
  // stampCombinedFirstApplicationInvoiceCoverage — so a multi-program public
  // acceptance was invisible to first-application-sibling-split.js's sweep.
  // shouldAttachScheduledServiceToStandardDraftInvoice is force-returned true
  // for this one test (a jest spy on the real implementation everywhere
  // else) rather than reconstructing the full multi-service pricing ladder
  // in this fake-knex harness — the real gate itself is unit-tested directly
  // in estimate-converter's own suite; this test's job is only to prove the
  // ROUTE calls the stamper with the right ids once that gate says yes.
  test('Codex round-9 P1: a reserved-anchor accept stamps the standard invoice with the anchor row', async () => {
    resetStore(recurringPestEstimate({ id: 'est-multi-1', token: 'tok-multi-1-x0123456789' }));
    EstimateConverter.shouldAttachScheduledServiceToStandardDraftInvoice.mockReturnValueOnce(true);
    EstimateConverter.convertEstimate.mockResolvedValueOnce({
      customerId: 'cust-1',
      tier: 'Bronze',
      monthlyRate: 60,
      firstScheduledServiceId: 'ss-multi-1',
      // Codex round-12 P2: convertEstimate's own additive field — the
      // promoted same-trip sibling ids it actually inserted for this
      // accept, threaded straight through to the stamper's memberIds
      // rather than reconstructed here or by the stamper itself.
      combinedInvoiceMemberIds: ['ss-multi-2'],
      recurringConversionSkipped: false,
      welcomeSms: null,
      membershipEmail: null,
      deferredFollowUpReminderRows: [],
    });

    const response = await putAccept('tok-multi-1-x0123456789');

    expect(response.status).toBe(200);
    expect(EstimateConverter.stampCombinedFirstApplicationInvoiceCoverage).toHaveBeenCalledTimes(1);
    expect(EstimateConverter.stampCombinedFirstApplicationInvoiceCoverage).toHaveBeenCalledWith(
      expect.anything(), // the accept's own trx — same transaction the invoice itself commits in
      { invoiceId: 'inv-1', anchorId: 'ss-multi-1', memberIds: ['ss-multi-2'] },
    );
  });

  // Codex round-15 P1: an INVOICE-MODE accept with no pre-existing visit
  // (acceptLinkedSsId null) mints its combined invoice BEFORE convertEstimate
  // creates the anchor, so it was neither attached to that anchor nor
  // stamped. After conversion the route must attach the invoice to the
  // converter's firstScheduledServiceId and stamp the converter's members.
  test('Codex round-15 P1: an invoice-mode, no-slot, multi-program accept attaches the invoice to the converter anchor and stamps', async () => {
    resetStore(recurringPestEstimate({ id: 'est-im-1', token: 'tok-im-1-x0123456789', bill_by_invoice: true }));
    EstimateConverter.convertEstimate.mockResolvedValueOnce({
      customerId: 'cust-1',
      tier: 'Bronze',
      monthlyRate: 60,
      firstScheduledServiceId: 'ss-im-1',
      combinedInvoiceMemberIds: ['ss-im-2'],
      recurringConversionSkipped: false,
      welcomeSms: null,
      membershipEmail: null,
      deferredFollowUpReminderRows: [],
    });

    const response = await putAccept('tok-im-1-x0123456789');

    expect(response.status).toBe(200);
    expect(response.data.invoiceMode).toBe(true);
    expect(InvoiceService.create).toHaveBeenCalledTimes(1);
    const attach = db.__state.ops.find((op) => op.type === 'update' && op.table === 'invoices'
      && op.data && op.data.scheduled_service_id === 'ss-im-1');
    expect(attach).toBeTruthy();
    expect(EstimateConverter.stampCombinedFirstApplicationInvoiceCoverage).toHaveBeenCalledTimes(1);
    expect(EstimateConverter.stampCombinedFirstApplicationInvoiceCoverage).toHaveBeenCalledWith(
      expect.anything(),
      { invoiceId: 'inv-1', anchorId: 'ss-im-1', memberIds: ['ss-im-2'] },
    );
  });

  test('control: a single-program accept (no reserved multi-program anchor) never calls the stamper', async () => {
    resetStore(recurringPestEstimate({ id: 'est-single-1', token: 'tok-single-1-x0123456789' }));
    EstimateConverter.convertEstimate.mockResolvedValueOnce({
      customerId: 'cust-1',
      firstScheduledServiceId: null,
      recurringConversionSkipped: false,
      welcomeSms: null,
      membershipEmail: null,
      deferredFollowUpReminderRows: [],
    });

    const response = await putAccept('tok-single-1-x0123456789');

    expect(response.status).toBe(200);
    expect(EstimateConverter.stampCombinedFirstApplicationInvoiceCoverage).not.toHaveBeenCalled();
  });
});

describe('FIX 2 — already-accepted retry returns the full success payload', () => {
  test('recurring accept retry rebuilds nextStep/invoice fields from persisted state with no side effects', async () => {
    const accepted = recurringPestEstimate({
      id: 'est-already-1',
      token: 'tok-already-1-x0123456789',
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

    const res = await putAccept('tok-already-1-x0123456789');
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
      token: 'tok-already-2-x0123456789',
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

    const res = await putAccept('tok-already-2-x0123456789');
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
      token: 'tok-archived-1-x0123456789',
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

    const res = await putAccept('tok-archived-1-x0123456789');
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
    resetStore(recurringPestEstimate({ id: 'est-skip-1', token: 'tok-skip-1-x0123456789' }));
    EstimateConverter.convertEstimate.mockResolvedValueOnce({
      customerId: 'cust-1',
      firstScheduledServiceId: null,
      recurringConversionSkipped: true,
      welcomeSms: null,
      membershipEmail: { customerId: 'cust-1', tier: 'Bronze' },
      deferredFollowUpReminderRows: [],
    });

    const res = await putAccept('tok-skip-1-x0123456789');
    expect(res.status).toBe(200);
    expect(res.data.success).toBe(true);
    const AccountMembershipEmail = require('../services/account-membership-email');
    expect(AccountMembershipEmail.sendMembershipStarted).not.toHaveBeenCalled();
  });

  test('control: membershipEmail IS sent when the conversion actually ran', async () => {
    resetStore(recurringPestEstimate({ id: 'est-noskip-1', token: 'tok-noskip-1-x0123456789' }));
    EstimateConverter.convertEstimate.mockResolvedValueOnce({
      customerId: 'cust-1',
      firstScheduledServiceId: null,
      recurringConversionSkipped: false,
      welcomeSms: null,
      membershipEmail: { customerId: 'cust-1', tier: 'Bronze' },
      deferredFollowUpReminderRows: [],
    });

    const res = await putAccept('tok-noskip-1-x0123456789');
    expect(res.status).toBe(200);
    const AccountMembershipEmail = require('../services/account-membership-email');
    expect(AccountMembershipEmail.sendMembershipStarted)
      .toHaveBeenCalledWith({ customerId: 'cust-1', tier: 'Bronze' });
  });
});

describe('ONE SIGNUP EMAIL (GATE_SIGNUP_SINGLE_EMAIL) — membership.started is decided at send time', () => {
  const MEMBERSHIP = { customerId: 'cust-1', tier: 'Bronze' };
  const flush = () => new Promise((resolve) => setImmediate(resolve));
  const { sendEstimateAcceptedOnboarding } = require('../services/estimate-accepted-email');
  const AccountMembershipEmail = require('../services/account-membership-email');

  async function acceptWith(token, onboardingImpl) {
    resetStore(recurringPestEstimate({ id: `est-${token}`, token }));
    EstimateConverter.convertEstimate.mockResolvedValueOnce({
      customerId: 'cust-1',
      firstScheduledServiceId: null,
      recurringConversionSkipped: false,
      welcomeSms: null,
      membershipEmail: MEMBERSHIP,
      deferredFollowUpReminderRows: [],
    });
    sendEstimateAcceptedOnboarding.mockReset();
    sendEstimateAcceptedOnboarding.mockImplementation(onboardingImpl);
    AccountMembershipEmail.sendMembershipStarted.mockClear();
    const res = await putAccept(token);
    await flush();
    await flush();
    return res;
  }

  beforeEach(() => { process.env.GATE_SIGNUP_SINGLE_EMAIL = 'true'; });
  afterEach(() => { delete process.env.GATE_SIGNUP_SINGLE_EMAIL; });

  test('the combined send covered the plan: membership.started is NOT sent, and the sender was handed the plan args', async () => {
    const res = await acceptWith('tok-fold-cover-x0123456789', async () => ({ sent: true, coversMembership: true }));
    expect(res.status).toBe(200);
    expect(sendEstimateAcceptedOnboarding).toHaveBeenCalledWith(expect.objectContaining({ signup: { membershipEmail: MEMBERSHIP } }));
    expect(AccountMembershipEmail.sendMembershipStarted).not.toHaveBeenCalled();
  });

  test.each([
    ['the send was accepted but did not carry the whole plan', async () => ({ sent: true })],
    ['a suppression / preference block', async () => ({ sent: false, blocked: true })],
    ['no address', async () => ({ sent: false, outcome: 'no_address' })],
    ['a failed send', async () => ({ sent: false, outcome: 'failed' })],
    ['the sender throwing', async () => { throw new Error('boom'); }],
    ['no result at all', async () => undefined],
  ])('%s: membership.started is sent inline, exactly once, with the same args as today', async (_label, impl) => {
    const res = await acceptWith('tok-fold-miss-x0123456789', impl);
    expect(res.status).toBe(200);
    expect(AccountMembershipEmail.sendMembershipStarted).toHaveBeenCalledTimes(1);
    expect(AccountMembershipEmail.sendMembershipStarted).toHaveBeenCalledWith(MEMBERSHIP);
  });

  test('gate off: membership.started is sent right away and the sender is not asked to fold anything in', async () => {
    delete process.env.GATE_SIGNUP_SINGLE_EMAIL;
    await acceptWith('tok-fold-off-x0123456789', async () => ({ sent: true, coversMembership: true }));
    expect(AccountMembershipEmail.sendMembershipStarted).toHaveBeenCalledWith(MEMBERSHIP);
    expect(sendEstimateAcceptedOnboarding.mock.calls[0][0]).not.toHaveProperty('signup');
  });
});

describe('AUDIT P1 — voided annual-prepay invoice is not surfaced on retry', () => {
  test('retry skips the voided prepay-term invoice and falls back to the live accept-mint invoice', async () => {
    const accepted = recurringPestEstimate({
      id: 'est-prepay-1',
      token: 'tok-prepay-1-x0123456789',
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

    const res = await putAccept('tok-prepay-1-x0123456789');
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
      token: 'tok-lawnretry-1-x0123456789',
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

    const res = await putAccept('tok-lawnretry-1-x0123456789');
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
        token: 'tok-settled-1-x0123456789',
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

      const res = await putAccept('tok-settled-1-x0123456789');
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
      token: 'tok-prepaid-1-x0123456789',
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

    const res = await putAccept('tok-prepaid-1-x0123456789');
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
      token: 'tok-rebill-1-x0123456789',
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

    const res = await putAccept('tok-rebill-1-x0123456789');
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
      token: 'tok-shortlink-1-x0123456789',
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

    const first = await putAccept('tok-shortlink-1-x0123456789');
    expect(first.status).toBe(200);
    expect(first.data.nextStep).toBe('book_one_time');
    expect(first.data.bookingUrl).toBe('https://portal.wavespestcontrol.com/l/ret42');
    expect(shortUrlSvc.shortenOrPassthrough).toHaveBeenCalledTimes(1);
    expect(shortUrlSvc.shortenOrPassthrough.mock.calls[0][1].channel).toBe('web');
    expect(shortUrlSvc.shortenOrPassthrough.mock.calls[0][0]).toContain('estimate_id=est-shortlink-1');

    const second = await putAccept('tok-shortlink-1-x0123456789');
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
    resetStore(unbookedOneTime({ id: 'est-shortlink-2', token: 'tok-shortlink-2-x0123456789' }));
    // Exactly the URL the retry rebuilds (service derived canonically +
    // estimate correlation + the customers-only-gate accept token). The token
    // mint is quantized to the acceptance day — this fixture carries no
    // accepted_at, so route and test both derive it from today — which is
    // precisely what keeps fresh-accept and retry URLs identical for dedupe.
    const { mintEstimateAcceptToken } = require('../utils/estimate-handoff-token');
    const acceptToken = mintEstimateAcceptToken('est-shortlink-2');
    db.__state.tables.short_codes = [{
      id: 'sc-accept-1',
      code: 'acc99',
      target_url: `https://portal.wavespestcontrol.com/book?service=lawn_care&source=estimate-accept&estimate_id=est-shortlink-2&accept_token=${encodeURIComponent(acceptToken)}`,
      entity_type: 'estimates',
      entity_id: 'est-shortlink-2',
      purpose: 'estimate_accept_booking',
      channel: 'sms',
      kind: 'booking',
      created_at: new Date(),
      expires_at: null,
    }];
    const shortUrlSvc = require('../services/short-url');

    const res = await putAccept('tok-shortlink-2-x0123456789');
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
    resetStore(recurringPestEstimate({ id: 'est-notify-1', token: 'tok-notify-1-x0123456789' }));
    EstimateConverter.convertEstimate.mockResolvedValueOnce({
      customerId: 'cust-1',
      firstScheduledServiceId: null,
      recurringConversionSkipped: false,
      welcomeSms: null,
      membershipEmail: null,
      deferredFollowUpReminderRows: [],
      commercialScheduleNotification: commercialNotification('est-notify-1'),
    });

    const res = await putAccept('tok-notify-1-x0123456789');
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
    resetStore(recurringPestEstimate({ id: 'est-notify-2', token: 'tok-notify-2-x0123456789' }));
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

    const failed = await putAccept('tok-notify-2-x0123456789');
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
      token: 'tok-phoneless-1-x0123456789',
      customer_phone: null,
      customer_email: 'emailonly@example.com',
    }));

    const res = await putAccept('tok-phoneless-1-x0123456789');
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
      token: 'tok-linked-1-x0123456789',
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

    const res = await putAccept('tok-linked-1-x0123456789');
    expect(res.status).toBe(200);
    expect(res.data.success).toBe(true);
    expect(storedEstimate().status).toBe('accepted');
  });

  test('a phoneless ONE-TIME accept with no appointment to bind still succeeds (needs no customer record)', async () => {
    resetStore(recurringPestEstimate({
      id: 'est-onetime-1',
      token: 'tok-onetime-1-x0123456789',
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

    const res = await putAccept('tok-onetime-1-x0123456789');
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

describe('P1 — accept txn lock order: rung 1 before every estimate row mutation', () => {
  function holdFixture(overrides = {}) {
    return {
      id: 'ss-hold-1',
      source_estimate_id: 'est-lock-1',
      customer_id: null,
      technician_id: null,
      scheduled_date: '2027-05-20',
      window_start: '09:00:00',
      window_end: '10:00:00',
      status: 'pending',
      estimated_duration_minutes: 60,
      notes: null,
      reservation_expires_at: new Date(Date.now() + 15 * 60 * 1000),
      ...overrides,
    };
  }

  test('slot-commit accept takes the hold\'s date-occupancy lock FIRST, then mutates; the hold graduates', async () => {
    // The deadlock shape this pins: the accept txn used to row-lock the
    // estimate (the status UPDATE) and only reach rung 1 later, inside
    // commitReservation — while a concurrent reserveSlot holds rung 1 and
    // waits on that same estimate row (rung 1 → estimate FOR UPDATE).
    // The fix pre-acquires the hold's date key as the txn's first
    // statements, so rung 1 precedes the estimates UPDATE here.
    resetStore(recurringPestEstimate({ id: 'est-lock-1', token: 'tok-lock-1-x0123456789' }));
    db.__state.tables.scheduled_services = [holdFixture()];
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

    const res = await putAccept('tok-lock-1-x0123456789', {
      slotId: '2027-05-20_09-00_unassigned',
      paymentMethodPreference: 'pay_at_visit',
    });
    expect(res.status).toBe(200);
    expect(res.data.success).toBe(true);
    expect(res.data.reservationCommitted).toBe(true);

    // The hold graduated inside the accept: customer bound, expiry cleared,
    // still on the pre-locked date.
    const hold = db.__state.tables.scheduled_services.find((r) => r.id === 'ss-hold-1');
    expect(hold.customer_id != null).toBe(true);
    expect(hold.reservation_expires_at == null).toBe(true);
    expect(String(hold.scheduled_date)).toBe('2027-05-20');

    // ORDER: the rung-1 occupancy advisory lock precedes the estimates
    // UPDATE (the txn's first row lock). Two acquisitions of the SAME key —
    // the route's pre-lock and commitReservation's reentrant re-take.
    const ops = db.__state.ops;
    const lockIdxs = ops
      .map((op, i) => (
        op.type === 'raw'
        && String(op.sql).includes('pg_advisory_xact_lock')
        && Array.isArray(op.bindings)
        && String(op.bindings[1] || '').startsWith('occupancy:') ? i : -1
      ))
      .filter((i) => i >= 0);
    const acceptUpdateIdx = ops.findIndex((op) => (
      op.type === 'update' && op.table === 'estimates' && op.data && op.data.status === 'accepted'
    ));
    expect(acceptUpdateIdx).toBeGreaterThanOrEqual(0);
    expect(lockIdxs.length).toBe(2);
    for (const i of lockIdxs) {
      expect(ops[i].bindings).toEqual(['slot-reserve', 'occupancy:2027-05-20']);
    }
    expect(lockIdxs[0]).toBeLessThan(acceptUpdateIdx);   // pre-lock BEFORE the estimate row mutation
    expect(lockIdxs[1]).toBeGreaterThan(acceptUpdateIdx); // commitReservation's re-take, later in the txn
  });

  test('a deadlock-aborted accept txn (PG 40P01) maps to the retryable 409 conflict shape, fully rolled back', async () => {
    resetStore(recurringPestEstimate({ id: 'est-dl-1', token: 'tok-dl-1-x0123456789' }));
    // Simulate Postgres aborting the txn to break a lock cycle mid-accept
    // (the conversion runs inside the transaction — FIX 1 above).
    EstimateConverter.convertEstimate.mockRejectedValueOnce(
      Object.assign(new Error('deadlock detected'), { code: '40P01' }),
    );

    const res = await putAccept('tok-dl-1-x0123456789');
    // Same retryable-conflict shape as the RESERVATION_EXPIRED path (409 +
    // { error }), never an unmapped 500.
    expect(res.status).toBe(409);
    expect(res.data.error).toMatch(/try again/i);
    // Rolled back and retryable: not accepted, price not locked, no orphans.
    expect(storedEstimate().status).toBe('sent');
    expect(storedEstimate().price_locked_at == null).toBe(true);
    expect(db.__state.tables.customers).toHaveLength(0);
    expect(InvoiceService.sendViaSMSAndEmail).not.toHaveBeenCalled();
  });
});

describe('Acceptance terms — GATE_ESTIMATE_ACCEPTANCE_TERMS record', () => {
  const acceptanceTerms = require('../services/acceptance-terms-text');
  const CURRENT = acceptanceTerms.ACCEPTANCE_TERMS_VERSION;

  function conversionOk() {
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
  }

  function seed(overrides) {
    resetStore(recurringPestEstimate(overrides));
    db.__state.tables.estimate_acceptances = [];
  }

  afterEach(() => { mockGateState.acceptanceTerms = false; mockGateState.acceptanceTermsRequired = false; });

  test('gate on + attested version: one verbatim record in the accept txn, estimate + customer stamped', async () => {
    mockGateState.acceptanceTerms = true;
    seed({ id: 'est-terms-1', token: 'tok-terms-1-x0123456789' });
    conversionOk();

    const res = await fetch(`${base}/api/estimates/tok-terms-1-x0123456789/accept`, {
      method: 'PUT',
      // A requester-supplied X-Forwarded-For must never become the recorded
      // IP: the record takes req.ip (proxy-validated under index.js's
      // trust-proxy setting; the loopback here, where nothing is trusted).
      headers: { 'Content-Type': 'application/json', 'User-Agent': 'Mozilla/5.0 (iPhone) Safari/604.1', 'X-Forwarded-For': '198.51.100.77' },
      // A recurring pest plan: the tab rendered the 'plan' scope (the
      // Services line with the annual rate review sentence) and attests it.
      body: JSON.stringify({ termsVersion: CURRENT, termsScope: 'plan' }),
    });
    expect(res.status).toBe(200);

    const records = db.__state.tables.estimate_acceptances;
    expect(records).toHaveLength(1);
    // The accept path minted the customer row itself — the record follows
    // that id, not the converter's.
    const customerId = storedEstimate().customer_id;
    expect(customerId).toBeTruthy();
    expect(records[0]).toMatchObject({
      estimate_id: 'est-terms-1',
      customer_id: customerId,
      method: 'public_estimate',
      terms_version: CURRENT,
      terms_text: acceptanceTerms.acceptanceTermsSnapshot('plan'),
      user_agent: 'Mozilla/5.0 (iPhone) Safari/604.1',
    });
    expect(records[0].terms_text).toContain(acceptanceTerms.RATE_REVIEW_SENTENCE);
    expect(records[0].ip).toMatch(/127\.0\.0\.1|::1/);
    expect(records[0].ip).not.toContain('198.51.100.77');
    expect(records[0].accepted_at).toBeTruthy();
    expect(storedEstimate().terms_version).toBe(CURRENT);
    expect(db.__state.tables.customers.find((c) => c.id === customerId).accepted_terms_version).toBe(CURRENT);
    // The post-commit copy email is keyed on THIS acceptance record.
    const { sendEstimateAcceptedOnboarding } = require('../services/estimate-accepted-email');
    expect(sendEstimateAcceptedOnboarding).toHaveBeenCalledWith(expect.objectContaining({ estimateId: 'est-terms-1', acceptanceId: records[0].id }));
  });

  test('a rolled-back accept leaves no record and no stamps', async () => {
    mockGateState.acceptanceTerms = true;
    seed({ id: 'est-terms-2', token: 'tok-terms-2-x0123456789' });
    EstimateConverter.convertEstimate.mockRejectedValueOnce(new Error('conversion boom'));

    const failed = await putAccept('tok-terms-2-x0123456789', { termsVersion: CURRENT, termsScope: 'plan' });
    expect(failed.status).toBeGreaterThanOrEqual(500);
    expect(storedEstimate().status).toBe('sent');
    expect(db.__state.tables.estimate_acceptances).toHaveLength(0);
    expect(storedEstimate().terms_version == null).toBe(true);
    expect(db.__state.tables.customers.some((c) => c.accepted_terms_version)).toBe(false);
  });

  test('stale version → 409 TERMS_VERSION_STALE before any mutation', async () => {
    mockGateState.acceptanceTerms = true;
    seed({ id: 'est-terms-3', token: 'tok-terms-3-x0123456789' });

    const stale = await putAccept('tok-terms-3-x0123456789', { termsVersion: 'v2000-01', termsScope: 'plan' });
    expect(stale.status).toBe(409);
    expect(stale.data.code).toBe('TERMS_VERSION_STALE');
    expect(storedEstimate().status).toBe('sent');
    expect(EstimateConverter.convertEstimate).not.toHaveBeenCalled();
    expect(db.__state.tables.estimate_acceptances).toHaveLength(0);
  });

  // Scope attestation (codex #5434 r1 P0): the record carries the Services
  // line the tab rendered — the server re-derives the estimate's scope and
  // refuses the other one (or none) with the same reloadable 409.
  test.each([
    ['the other scope', { termsVersion: null, termsScope: 'base' }],
    ['no scope beside a current version (a bundle that predates scopes)', { termsVersion: null }],
    ['an unknown scope', { termsVersion: null, termsScope: 'all' }],
  ])('a recurring plan accept attesting %s → 409 TERMS_VERSION_STALE before any mutation', async (_name, body) => {
    mockGateState.acceptanceTerms = true;
    seed({ id: 'est-terms-s', token: 'tok-terms-s-x0123456789' });
    const res = await putAccept('tok-terms-s-x0123456789', { ...body, termsVersion: CURRENT });
    expect(res.status).toBe(409);
    expect(res.data.code).toBe('TERMS_VERSION_STALE');
    expect(storedEstimate().status).toBe('sent');
    expect(EstimateConverter.convertEstimate).not.toHaveBeenCalled();
    expect(db.__state.tables.estimate_acceptances).toHaveLength(0);
  });

  test("a rodent-only estimate serves and records the 'base' scope — no rate review sentence — and refuses 'plan'", async () => {
    mockGateState.acceptanceTerms = true;
    const rodent = {
      id: 'est-terms-r',
      token: 'tok-terms-r-x0123456789',
      monthly_total: 40,
      annual_total: 480,
      estimate_data: JSON.stringify({
        result: {
          recurring: { discount: 0, services: [{ name: 'Rodent Bait Stations', service: 'rodent_bait', mo: 40 }] },
          oneTime: { items: [], membershipFee: 0 },
        },
      }),
    };
    seed(rodent);
    const { acceptanceTermsScopeFor } = require('../routes/estimate-public');
    expect(acceptanceTermsScopeFor(storedEstimate(), JSON.parse(rodent.estimate_data), {})).toBe('base');

    const wrong = await putAccept('tok-terms-r-x0123456789', { termsVersion: CURRENT, termsScope: 'plan' });
    expect(wrong.status).toBe(409);
    expect(wrong.data.code).toBe('TERMS_VERSION_STALE');
    expect(db.__state.tables.estimate_acceptances).toHaveLength(0);

    conversionOk();
    const res = await putAccept('tok-terms-r-x0123456789', { termsVersion: CURRENT, termsScope: 'base' });
    expect(res.status).toBe(200);
    const records = db.__state.tables.estimate_acceptances;
    expect(records).toHaveLength(1);
    expect(records[0].terms_version).toBe(CURRENT);
    expect(records[0].terms_text).toBe(acceptanceTerms.acceptanceTermsSnapshot('base'));
    expect(records[0].terms_text).not.toContain(acceptanceTerms.RATE_REVIEW_SENTENCE);
  });

  test("the customer's one-time toggle on a plan estimate is a 'base' accept: 'plan' is refused", async () => {
    mockGateState.acceptanceTerms = true;
    // A pest plan the customer may take as a single visit (show_one_time_option + a resolvable one-time price).
    seed({ id: 'est-terms-o', token: 'tok-terms-o-x0123456789', show_one_time_option: true, onetime_total: 150 });
    const { acceptanceTermsScopeFor } = require('../routes/estimate-public');
    const estData = JSON.parse(storedEstimate().estimate_data);
    expect(acceptanceTermsScopeFor(storedEstimate(), estData, {})).toBe('plan');
    expect(acceptanceTermsScopeFor(storedEstimate(), estData, {}, { oneTime: true })).toBe('base');

    const res = await putAccept('tok-terms-o-x0123456789', { termsVersion: CURRENT, termsScope: 'plan', serviceMode: 'one_time' });
    expect(res.status).toBe(409);
    expect(res.data.code).toBe('TERMS_VERSION_STALE');
    expect(storedEstimate().status).toBe('sent');
    expect(db.__state.tables.estimate_acceptances).toHaveLength(0);
  });

  // codex #5434 r3 P1 + the merge-head pre-push P1: the accept stamps the
  // frozen-document fact only on persisted evidence the customer was SERVED
  // the disclosure — the served marker (/pdf download, legacy page card) or
  // the recorded 'plan' drawer snapshot — never on plan eligibility alone.
  test('gate off: a plan accept stamps rateReviewDisclosedAtAccept only when the served marker is current; rodent never', async () => {
    mockGateState.acceptanceTerms = false;
    const { RATE_REVIEW_TERMS_VERSION } = require('../../shared/estimate-copy-claims.cjs');
    const stampOps = () => db.__state.ops.filter((op) => op.type === 'raw' && String(op.sql).includes('rateReviewDisclosedAtAccept'));
    const planData = (extra = {}) => JSON.stringify({
      result: { recurring: { discount: 0, services: [{ name: 'Pest Control', service: 'pest_control', mo: 60 }] }, oneTime: { items: [], membershipFee: 99 } },
      ...extra,
    });

    // No evidence at all (an older tab, nothing downloaded): unstamped.
    seed({ id: 'est-stamp-0', token: 'tok-stamp-0-x0123456789' });
    conversionOk();
    expect((await putAccept('tok-stamp-0-x0123456789', {})).status).toBe(200);
    expect(stampOps()).toHaveLength(0);
    expect(db.__state.tables.estimate_acceptances).toHaveLength(0);

    // The document or page served the current line: stamped, still no drawer row.
    seed({ id: 'est-stamp-1', token: 'tok-stamp-1-x0123456789', estimate_data: planData({ rateReviewTermsServed: RATE_REVIEW_TERMS_VERSION }) });
    conversionOk();
    expect((await putAccept('tok-stamp-1-x0123456789', {})).status).toBe(200);
    expect(stampOps()).toHaveLength(1);
    expect(db.__state.tables.estimate_acceptances).toHaveLength(0);

    // A marker from an older copy version is no evidence for this line.
    seed({ id: 'est-stamp-2', token: 'tok-stamp-2-x0123456789', estimate_data: planData({ rateReviewTermsServed: 'v2025-01' }) });
    conversionOk();
    expect((await putAccept('tok-stamp-2-x0123456789', {})).status).toBe(200);
    expect(stampOps()).toHaveLength(0);

    // Rodent: no rate to review, marker or not.
    seed({
      id: 'est-stamp-r',
      token: 'tok-stamp-r-x0123456789',
      monthly_total: 40,
      annual_total: 480,
      estimate_data: JSON.stringify({
        result: { recurring: { discount: 0, services: [{ name: 'Rodent Bait Stations', service: 'rodent_bait', mo: 40 }] }, oneTime: { items: [], membershipFee: 0 } },
        rateReviewTermsServed: RATE_REVIEW_TERMS_VERSION,
      }),
    });
    conversionOk();
    expect((await putAccept('tok-stamp-r-x0123456789', {})).status).toBe(200);
    expect(stampOps()).toHaveLength(0);
  });

  test('served evidence persisted AFTER the accept read the row is still honored: merged through the wholesale write and read under the lock', async () => {
    // GH Codex r5 P1: a /pdf download (or legacy page view) lands between
    // the accept's unlocked read and its guarded UPDATE. The marker write
    // does not move updated_at, so the accept's guard does not 409 — the
    // accept must merge the row's marker through its own estimate_data write
    // and decide the stamp from the row under its lock, not the snapshot.
    mockGateState.acceptanceTerms = false;
    const { RATE_REVIEW_TERMS_VERSION } = require('../../shared/estimate-copy-claims.cjs');
    seed({ id: 'est-stamp-race', token: 'tok-stamp-race-x0123456789' });
    conversionOk();
    let injected = false;
    db.__state.onTable = (table) => {
      // First transaction touch of the customers table = matchAcceptCustomerByPhone,
      // which runs before the guarded estimates UPDATE.
      if (table === 'customers' && !injected) {
        injected = true;
        const row = storedEstimate();
        row.estimate_data = JSON.stringify({ ...JSON.parse(row.estimate_data), rateReviewTermsServed: RATE_REVIEW_TERMS_VERSION });
      }
    };
    const res = await putAccept('tok-stamp-race-x0123456789', {});
    db.__state.onTable = null;
    expect(res.status).toBe(200);
    expect(injected).toBe(true);
    const stored = JSON.parse(storedEstimate().estimate_data);
    expect(stored.rateReviewTermsServed).toBe(RATE_REVIEW_TERMS_VERSION);
    expect(stored.rateReviewDisclosedAtAccept).toBe(true);
    expect(db.__state.ops.filter((op) => op.type === 'raw' && String(op.sql).includes('rateReviewDisclosedAtAccept'))).toHaveLength(1);
  });

  test('a whole-blob preference write preserves served evidence recorded since its read (codex local review on #5434)', async () => {
    // PUT /preferences rewrites estimate_data from the row it read; the marker
    // never moves updated_at, so the route's guard cannot catch a download
    // that recorded the disclosure in between — the SQL merge must keep it.
    const { RATE_REVIEW_TERMS_VERSION } = require('../../shared/estimate-copy-claims.cjs');
    seed({ id: 'est-pref-1', token: 'tok-pref-1-x0123456789' });
    let touches = 0;
    db.__state.onTable = (table) => {
      if (table !== 'estimates') return;
      touches += 1;
      // A download lands right after the route's read: the stored row gains
      // the marker before the route's whole-blob UPDATE.
      if (touches === 2) {
        const row = storedEstimate();
        row.estimate_data = JSON.stringify({ ...JSON.parse(row.estimate_data), rateReviewTermsServed: RATE_REVIEW_TERMS_VERSION });
      }
    };
    const res = await fetch(`${base}/api/estimates/tok-pref-1-x0123456789/preferences`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ interior_spray: false }),
    });
    db.__state.onTable = null;
    expect(res.status).toBe(200);
    const stored = JSON.parse(storedEstimate().estimate_data);
    expect(stored.rateReviewTermsServed).toBe(RATE_REVIEW_TERMS_VERSION);
    expect(stored.preferences.interior_spray).toBe(false);
    // The route's own snapshot (built from its pre-download read) lacked the
    // marker; the SQL-side merge is what carried it through.
    const mergeOps = db.__state.ops.filter((op) => op.type === 'raw' && String(op.sql).startsWith("?::jsonb || jsonb_strip_nulls(jsonb_build_object('rateReviewTermsServed'"));
    expect(mergeOps).toHaveLength(1);
    expect(JSON.parse(mergeOps[0].bindings[0]).rateReviewTermsServed).toBeUndefined();
  });

  test("gate on: the recorded 'plan' drawer snapshot is evidence on its own (no served marker)", async () => {
    mockGateState.acceptanceTerms = true;
    seed({ id: 'est-stamp-d', token: 'tok-stamp-d-x0123456789' });
    conversionOk();
    const res = await putAccept('tok-stamp-d-x0123456789', { termsVersion: CURRENT, termsScope: 'plan' });
    expect(res.status).toBe(200);
    expect(db.__state.tables.estimate_acceptances).toHaveLength(1);
    expect(db.__state.ops.filter((op) => op.type === 'raw' && String(op.sql).includes('rateReviewDisclosedAtAccept'))).toHaveLength(1);
  });

  test('GET /:token/pdf marks the served disclosure for an open recurring plan (pdfkit path) and never for a frozen estimate', async () => {
    const { RATE_REVIEW_TERMS_VERSION } = require('../../shared/estimate-copy-claims.cjs');
    const servedOps = () => db.__state.ops.filter((op) => op.type === 'raw' && String(op.sql).includes('rateReviewTermsServed'));
    // The synthesized document prints the engine lines (estimate_data.lineItems),
    // the same shape the /data projection tests use for an eligible plan.
    const documentData = JSON.stringify({
      lineItems: [{ displayName: 'Pest Control', monthlyPrice: 60 }],
      result: { recurring: { discount: 0, services: [{ name: 'Pest Control', service: 'pest_control', mo: 60 }] }, oneTime: { items: [], membershipFee: 99 } },
    });
    seed({ id: 'est-pdf-1', token: 'tok-pdf-1-x0123456789', sent_at: '2026-09-20T12:00:00.000Z', estimate_data: documentData });
    const renderDoc = require('../services/pdf/estimate-doc-pdf').renderEstimateDocumentPdf;
    renderDoc.mockClear();
    const open = await fetch(`${base}/api/estimates/tok-pdf-1-x0123456789/pdf`);
    expect(open.status).toBe(200);
    expect(servedOps()).toHaveLength(1);
    // Evidence proven → the browser renderer was attempted (and fell back).
    expect(renderDoc).toHaveBeenCalledTimes(1);
    expect(JSON.parse(storedEstimate().estimate_data).rateReviewTermsServed).toBe(RATE_REVIEW_TERMS_VERSION);
    // Frozen: still downloadable, but the marker is never written.
    seed({ id: 'est-pdf-2', token: 'tok-pdf-2-x0123456789', sent_at: '2026-09-20T12:00:00.000Z', status: 'accepted', price_locked_at: '2026-09-01T00:00:00.000Z', estimate_data: documentData });
    expect((await fetch(`${base}/api/estimates/tok-pdf-2-x0123456789/pdf`)).status).toBe(200);
    expect(servedOps()).toHaveLength(0);
    // A stored (disabled) proposal with operator terms: both renderers
    // suppress the canned line beside authored terms, so no evidence either
    // (pre-push Codex on #5434).
    seed({
      id: 'est-pdf-3',
      token: 'tok-pdf-3-x0123456789',
sent_at: '2026-09-20T12:00:00.000Z',
      estimate_data: JSON.stringify({
        ...JSON.parse(documentData),
        proposal: {
          enabled: false,
          terms: 'Operator terms govern this proposal.',
          buildings: [{ name: 'Home', lineItems: [{ description: 'Quarterly Pest Control', unitPrice: 60, frequency: 'quarterly', taxable: false }] }],
        },
      }),
    });
    expect((await fetch(`${base}/api/estimates/tok-pdf-3-x0123456789/pdf`)).status).toBe(200);
    expect(servedOps()).toHaveLength(0);
  });

  test('GET /:token/pdf: a non-customer download (bot / unfurler UA) records no served evidence (local max-effort review on #5434)', async () => {
    const servedOps = () => db.__state.ops.filter((op) => op.type === 'raw' && String(op.sql).includes('rateReviewTermsServed'));
    seed({
      id: 'est-pdf-bot',
      token: 'tok-pdf-bot-x0123456789',
      sent_at: '2026-09-20T12:00:00.000Z',
      estimate_data: JSON.stringify({
        lineItems: [{ displayName: 'Pest Control', monthlyPrice: 60 }],
        result: { recurring: { discount: 0, services: [{ name: 'Pest Control', service: 'pest_control', mo: 60 }] }, oneTime: { items: [], membershipFee: 99 } },
      }),
    });
    const res = await fetch(`${base}/api/estimates/tok-pdf-bot-x0123456789/pdf`, { headers: { 'User-Agent': 'Slackbot-LinkExpanding 1.0 (+https://api.slack.com/robots)' } });
    expect(res.status).toBe(200);
    expect(servedOps()).toHaveLength(0);
    expect(JSON.parse(storedEstimate().estimate_data).rateReviewTermsServed).toBeUndefined();
  });

  test('the legacy page records served evidence only on a counted customer view (source pattern; local max-effort review on #5434)', () => {
    const src = require('fs').readFileSync(require.resolve('../routes/estimate-public'), 'utf8');
    expect(src).toMatch(/if \(rateReviewTermsRendered && countThisView\) \{/);
    expect(src).toMatch(/const countThisView = shouldCountView\(req, requestIp, estimate\);/);
  });

  test('GET /:token/pdf: when the row freezes between the read and the evidence write, the document is rendered from the frozen row (no line, no marker)', async () => {
    // GH Codex r7 P1: the marker must be durable BEFORE a document carrying
    // the line exists. An accept that lands first turns the write into a
    // zero-row no-op; the route must then render the CURRENT (frozen) row
    // rather than the stale open snapshot it read.
    const generate = require('../services/pdf/estimate-pdf').generateEstimateProposalPDF;
    generate.mockClear();
    const documentData = JSON.stringify({
      lineItems: [{ displayName: 'Pest Control', monthlyPrice: 60 }],
      result: { recurring: { discount: 0, services: [{ name: 'Pest Control', service: 'pest_control', mo: 60 }] }, oneTime: { items: [], membershipFee: 99 } },
    });
    seed({ id: 'est-pdf-race', token: 'tok-pdf-race-x0123456789', sent_at: '2026-09-20T12:00:00.000Z', estimate_data: documentData });
    let estimateTouches = 0;
    db.__state.onTable = (table) => {
      if (table !== 'estimates') return;
      estimateTouches += 1;
      // Second touch = the evidence UPDATE; the accept from another tab
      // committed just before it.
      if (estimateTouches === 2) {
        const row = storedEstimate();
        row.status = 'accepted';
        row.price_locked_at = '2026-10-01T06:00:00.000Z';
      }
    };
    const res = await fetch(`${base}/api/estimates/tok-pdf-race-x0123456789/pdf`);
    db.__state.onTable = null;
    expect(res.status).toBe(200);
    expect(estimateTouches).toBeGreaterThanOrEqual(3);
    // The guarded evidence UPDATE was attempted (one raw stamp issued) but
    // matched zero rows (frozen-status guards): the stored row carries no marker.
    expect(db.__state.ops.filter((op) => op.type === 'raw' && String(op.sql).includes('rateReviewTermsServed'))).toHaveLength(1);
    expect(JSON.parse(storedEstimate().estimate_data).rateReviewTermsServed).toBeUndefined();
    // The renderer received the frozen row, not the open snapshot.
    const [renderedEstimate, , renderedBilling] = generate.mock.calls.at(-1);
    expect(renderedEstimate.status).toBe('accepted');
    expect(renderedEstimate.price_locked_at).toBe('2026-10-01T06:00:00.000Z');
    expect(renderedBilling.withholdRateReviewTerms).toBeUndefined();
  });

  test('GET /:token/pdf: when the evidence write FAILS, the document is served with the line withheld (GH Codex r8 P0)', async () => {
    const generate = require('../services/pdf/estimate-pdf').generateEstimateProposalPDF;
    generate.mockClear();
    seed({
      id: 'est-pdf-fail',
      token: 'tok-pdf-fail-x0123456789',
sent_at: '2026-09-20T12:00:00.000Z',
      estimate_data: JSON.stringify({
        lineItems: [{ displayName: 'Pest Control', monthlyPrice: 60 }],
        result: { recurring: { discount: 0, services: [{ name: 'Pest Control', service: 'pest_control', mo: 60 }] }, oneTime: { items: [], membershipFee: 99 } },
      }),
    });
    let estimateTouches = 0;
    db.__state.onTable = (table) => {
      if (table !== 'estimates') return;
      estimateTouches += 1;
      if (estimateTouches === 2) throw new Error('db down'); // the evidence UPDATE
    };
    const renderDoc = require('../services/pdf/estimate-doc-pdf').renderEstimateDocumentPdf;
    renderDoc.mockClear();
    const res = await fetch(`${base}/api/estimates/tok-pdf-fail-x0123456789/pdf`);
    db.__state.onTable = null;
    expect(res.status).toBe(200);
    expect(JSON.parse(storedEstimate().estimate_data).rateReviewTermsServed).toBeUndefined();
    // Withholding: the browser renderer (which cannot be told) is skipped.
    expect(renderDoc).not.toHaveBeenCalled();
    const [renderedEstimate, , renderedBilling] = generate.mock.calls.at(-1);
    expect(renderedEstimate.status).toBe('sent');
    expect(renderedBilling.withholdRateReviewTerms).toBe(true);
  });

  test("acceptanceTermsScopeFor: 'plan' only for a recurring residential plan; one-time-only, rodent, termite/unclassifiable and malformed data are 'base'", () => {
    const { acceptanceTermsScopeFor } = require('../routes/estimate-public');
    const est = (extra = {}) => ({ id: 'e', monthly_total: 60, annual_total: 720, onetime_total: 0, ...extra });
    const data = (services, oneTime = []) => ({ result: { recurring: { services }, oneTime: { items: oneTime, membershipFee: 0 } } });
    expect(acceptanceTermsScopeFor(est(), data([{ name: 'Pest Control', service: 'pest_control', mo: 60 }]), {})).toBe('plan');
    expect(acceptanceTermsScopeFor(est(), data([{ name: 'Lawn Care', service: 'lawn_care', mo: 85 }]), {})).toBe('plan');
    expect(acceptanceTermsScopeFor(est(), data([{ name: 'Pest Control', service: 'pest_control', mo: 60 }, { name: 'Lawn Care', service: 'lawn_care', mo: 85 }]), {})).toBe('plan');
    // Rodent anywhere: no estimate-wide plan terms.
    expect(acceptanceTermsScopeFor(est(), data([{ name: 'Rodent Bait Stations', service: 'rodent_bait', mo: 40 }]), {})).toBe('base');
    expect(acceptanceTermsScopeFor(est(), data([{ name: 'Pest Control', service: 'pest_control', mo: 60 }, { name: 'Rodent Bait Stations', service: 'rodent_bait', mo: 40 }]), {})).toBe('base');
    // One-time-only: no rate to review.
    expect(acceptanceTermsScopeFor(est({ monthly_total: 0, annual_total: 0, onetime_total: 150 }), data([], [{ name: 'One-Time Pest Control', service: 'pest_one_time', price: 150 }]), {})).toBe('base');
    // Termite / unclassifiable rows, commercial marks, malformed data: fail closed.
    expect(acceptanceTermsScopeFor(est(), data([{ name: 'Pest Control', service: 'pest_control', mo: 60 }], [{ name: 'WDO Inspection', service: 'wdo_inspection', price: 125 }]), {})).toBe('base');
    expect(acceptanceTermsScopeFor(est(), data([{ name: 'Pest Control', service: 'pest_control', mo: 60, isCommercial: true }]), {})).toBe('base');
    expect(acceptanceTermsScopeFor(est(), null, {})).toBe('base');
    expect(acceptanceTermsScopeFor(est(), 'not an object', {})).toBe('base');
  });

  test('a termite/WDO estimate (own signed agreement) never gets a record, even when a version is sent', async () => {
    mockGateState.acceptanceTerms = true;
    seed({
      id: 'est-terms-t',
      token: 'tok-terms-t-x0123456789',
      estimate_data: JSON.stringify({
        result: {
          recurring: { discount: 0, services: [{ name: 'Termite Bait', service: 'termite_bait', mo: 35 }] },
          oneTime: { items: [], membershipFee: 0 },
        },
      }),
    });
    conversionOk();
    const res = await putAccept('tok-terms-t-x0123456789', { termsVersion: CURRENT, termsScope: 'plan' });
    expect(res.status).toBe(200);
    expect(db.__state.tables.estimate_acceptances).toHaveLength(0);
    expect(storedEstimate().terms_version == null).toBe(true);
  });

  test('acceptanceRecordForEstimate: strict document reads fail on a missing row or a read error; the page is fail-soft', async () => {
    const { acceptanceRecordForEstimate } = require('../services/estimate-acceptance-record');
    seed({ id: 'est-rec-1', token: 'tok-rec-1-x01234567890', status: 'accepted', terms_version: CURRENT });
    const accepted = { id: 'est-rec-1', status: 'accepted', terms_version: CURRENT };
    // Nothing recorded: not applicable.
    expect(await acceptanceRecordForEstimate({ id: 'x', status: 'accepted', terms_version: null })).toBeNull();
    // terms_version says a row exists but none does.
    expect(await acceptanceRecordForEstimate(accepted)).toBeNull();
    await expect(acceptanceRecordForEstimate(accepted, { strict: true })).rejects.toThrow(/acceptance record missing/);
    // A row: customer-facing shape.
    db.__state.tables.estimate_acceptances.push({
      id: 'abcdef1234567890', estimate_id: 'est-rec-1', terms_version: CURRENT, terms_text: 'Line.', accepted_at: '2026-08-28T10:35:00Z', ip: '203.0.113.9', user_agent: 'Mozilla/5.0 (iPhone) Safari/604.1',
    });
    expect(await acceptanceRecordForEstimate(accepted, { strict: true })).toMatchObject({ recordId: 'ACC-ABCDEF12', termsText: 'Line.', ipMasked: '203.0.x.x', device: 'iPhone · Safari' });
    // Read failure: page → null, document → throws.
    db.__state.failTables = new Set(['estimate_acceptances']);
    try {
      expect(await acceptanceRecordForEstimate(accepted)).toBeNull();
      await expect(acceptanceRecordForEstimate(accepted, { strict: true })).rejects.toThrow(/simulated db failure/);
    } finally {
      db.__state.failTables = null;
    }
  });

  test('acceptanceTermsApplyTo: cancel-anytime lanes only, fail closed', () => {
    const { acceptanceTermsApplyTo } = require('../routes/estimate-public');
    const pest = { recurring: { services: [{ name: 'Pest Control', service: 'pest_control', mo: 60 }] }, oneTime: { items: [] } };
    const withData = (extra, result = pest) => ({ estimate_data: JSON.stringify({ result, ...extra }) });
    expect(acceptanceTermsApplyTo(withData({}))).toBe(true);
    expect(acceptanceTermsApplyTo({ estimate_data: { result: pest } })).toBe(true);
    // Mapped termite rows.
    expect(acceptanceTermsApplyTo(withData({}, { recurring: { services: [{ name: 'Termite Bait', service: 'termite_bait' }] }, oneTime: { items: [] } }))).toBe(false);
    expect(acceptanceTermsApplyTo(withData({}, { ...pest, oneTime: { items: [{ name: 'WDO Inspection' }] } }))).toBe(false);
    // Raw pricing-engine WDO line: canonical underscored key, no display name.
    expect(acceptanceTermsApplyTo(withData({}, { ...pest, oneTime: { items: [{ service: 'wdo_inspection', price: 125 }] } }))).toBe(false);
    // Canonical pre-slab identities carry no literal "termite".
    expect(acceptanceTermsApplyTo(withData({}, { ...pest, oneTime: { items: [{ service: 'pre_slab_termiticide', name: 'Pre-Slab Termiticide Treatment' }] } }))).toBe(false);
    expect(acceptanceTermsApplyTo(withData({}, { ...pest, oneTime: { items: [{ service: 'pre_slab_termidor', name: 'Pre-Slab Termidor' }] } }))).toBe(false);
    // Other supported containers: root one_time.items, nested result.results.
    expect(acceptanceTermsApplyTo(withData({ one_time: { items: [{ name: 'WDO Inspection' }] } }))).toBe(false);
    expect(acceptanceTermsApplyTo(withData({}, { ...pest, results: { oneTime: { items: [{ name: 'Termite foam treatment' }] } } }))).toBe(false);
    // Engine-shaped rows (result.lineItems / raw engineResult.lineItems).
    expect(acceptanceTermsApplyTo(withData({}, { ...pest, lineItems: [{ service: 'termite_bond', bondTerm: 'annual' }] }))).toBe(false);
    expect(acceptanceTermsApplyTo(withData({ engineResult: { lineItems: [{ service: 'termite_trenching', description: 'Termidor trench' }] } }))).toBe(false);
    // Terms-neutral lanes: any commercial proposal, commercial category, invoice-mode billing.
    expect(acceptanceTermsApplyTo(withData({ proposal: { enabled: true, buildings: [{ lineItems: [{ description: 'Pest service', frequency: 'quarterly' }] }] } }))).toBe(false);
    expect(acceptanceTermsApplyTo(withData({ proposal: { enabled: true, commercialTerms: { initialTermMonths: 12, paymentTerms: 'net30' } } }))).toBe(false);
    expect(acceptanceTermsApplyTo({ ...withData({}), category: 'COMMERCIAL' })).toBe(false);
    expect(acceptanceTermsApplyTo({ ...withData({}), bill_by_invoice: true })).toBe(false);
    // Fail closed: malformed / empty / non-object rows.
    expect(acceptanceTermsApplyTo({ estimate_data: '{not json' })).toBe(false);
    expect(acceptanceTermsApplyTo({ estimate_data: null })).toBe(false);
    expect(acceptanceTermsApplyTo(withData({}, { recurring: { services: [] }, oneTime: { items: [] } }))).toBe(false);
    expect(acceptanceTermsApplyTo(withData({}, { recurring: { services: ['pest'] }, oneTime: { items: [] } }))).toBe(false);
  });

  test('an annual-prepay accept is terms-neutral: no record, no 409, even with a version sent', async () => {
    mockGateState.acceptanceTerms = true;
    mockGateState.acceptanceTermsRequired = true;
    seed({ id: 'est-terms-p', token: 'tok-terms-p-x0123456789' });
    conversionOk();
    const res = await putAccept('tok-terms-p-x0123456789', { paymentMethodPreference: 'prepay_annual' });
    expect(res.status).not.toBe(409);
    expect(db.__state.tables.estimate_acceptances).toHaveLength(0);
  });

  test('absent version: accepts unrecorded under `true` (pre-gate tab), refused under `required`; gate OFF records nothing (kill switch)', async () => {
    mockGateState.acceptanceTerms = true;
    seed({ id: 'est-terms-4', token: 'tok-terms-4-x0123456789' });
    conversionOk();
    const preGate = await putAccept('tok-terms-4-x0123456789', {});
    expect(preGate.status).toBe(200);
    expect(db.__state.tables.estimate_acceptances).toHaveLength(0);
    expect(storedEstimate().terms_version == null).toBe(true);

    mockGateState.acceptanceTermsRequired = true;
    seed({ id: 'est-terms-4r', token: 'tok-terms-4r-x012345678' });
    EstimateConverter.convertEstimate.mockClear();
    const required = await putAccept('tok-terms-4r-x012345678', {});
    expect(required.status).toBe(409);
    expect(required.data.code).toBe('TERMS_VERSION_STALE');
    expect(storedEstimate().status).toBe('sent');
    expect(EstimateConverter.convertEstimate).not.toHaveBeenCalled();
    mockGateState.acceptanceTermsRequired = false;

    // Kill switch is absolute: gate OFF ⇒ nothing recorded, even when the
    // tab attests the current version (it loaded before the switch was pulled).
    mockGateState.acceptanceTerms = false;
    seed({ id: 'est-terms-5', token: 'tok-terms-5-x0123456789' });
    conversionOk();
    const gateOff = await putAccept('tok-terms-5-x0123456789', { termsVersion: CURRENT, termsScope: 'plan' });
    expect(gateOff.status).toBe(200);
    expect(db.__state.tables.estimate_acceptances).toHaveLength(0);
    expect(storedEstimate().terms_version == null).toBe(true);
    // Gate off ⇒ a stale version is not inspected (nothing recorded, no 409).
    seed({ id: 'est-terms-6', token: 'tok-terms-6-x0123456789' });
    conversionOk();
    const gateOffStale = await putAccept('tok-terms-6-x0123456789', { termsVersion: 'v2000-01' });
    expect(gateOffStale.status).toBe(200);
  });
});

describe('Payment consent attestation on consent-bearing accepts (codex #5434 r1 P1)', () => {
  // The inline Auto Pay capture / capture modal render the bundle's own copy
  // of the saved-payment-method consent text; the accept that records that
  // consent (post-commit) must attest the version the tab rendered.
  const RecurringCards = require('../services/recurring-card-on-file');
  const { CONSENT_VERSION } = require('../services/payment-method-consent-text');
  const spies = [];

  function conversionOk() {
    EstimateConverter.convertEstimate.mockResolvedValueOnce({
      customerId: 'cust-1', tier: 'Bronze', monthlyRate: 60, firstScheduledServiceId: null,
      recurringConversionSkipped: false, welcomeSms: null, membershipEmail: null, deferredFollowUpReminderRows: [],
    });
  }

  beforeEach(() => {
    resetStore(recurringPestEstimate({ id: 'est-consent-1', token: 'tok-consent-1-x012345678' }));
    // A recurring plan whose Auto Pay card capture is REQUIRED and verified.
    spies.push(
      jest.spyOn(RecurringCards, 'resolveRecurringCardPolicyForEstimate').mockResolvedValue({ enforced: true, required: true, exemptReason: null }),
      jest.spyOn(RecurringCards, 'verifyRecurringCardIntent').mockResolvedValue({ ok: true, setupIntentId: 'si_cof_1', paymentMethodId: 'pm_cof_1', methodType: 'card' }),
      jest.spyOn(RecurringCards, 'bankTenderAllowedUnderLock').mockResolvedValue(true),
      jest.spyOn(RecurringCards, 'verifyRecurringCardIntentUnderLock').mockResolvedValue(true),
      jest.spyOn(RecurringCards, 'completeRecurringCardEnrollment').mockResolvedValue({ enrolled: true, paymentMethodRowId: 'pm-row-1' }),
    );
  });
  afterEach(() => { while (spies.length) spies.pop().mockRestore(); });

  test('the current version passes the attestation (the accept proceeds past the capture gate)', async () => {
    conversionOk();
    const res = await putAccept('tok-consent-1-x012345678', { recurringCardSetupIntentId: 'si_cof_1', consentTextVersion: CONSENT_VERSION });
    expect(res.data.code).not.toBe('CONSENT_VERSION_STALE');
    expect(RecurringCards.verifyRecurringCardIntent).toHaveBeenCalledWith(expect.objectContaining({ setupIntentId: 'si_cof_1' }));
    expect(res.status).toBe(200);
    expect(storedEstimate().status).toBe('accepted');
  });

  test.each([
    ['a stale version', 'v11_2026-08-25'],
    ['no version (a bundle that predates the attestation)', undefined],
  ])('a verified Auto Pay capture attesting %s → 409 CONSENT_VERSION_STALE before any mutation', async (_name, consentTextVersion) => {
    const res = await putAccept('tok-consent-1-x012345678', { recurringCardSetupIntentId: 'si_cof_1', consentTextVersion });
    expect(res.status).toBe(409);
    expect(res.data.code).toBe('CONSENT_VERSION_STALE');
    expect(res.data.error).toMatch(/refresh the page/i);
    expect(storedEstimate().status).toBe('sent');
    expect(EstimateConverter.convertEstimate).not.toHaveBeenCalled();
    expect(RecurringCards.completeRecurringCardEnrollment).not.toHaveBeenCalled();
  });

  test('an accept that captures no consent (no card owed) ignores the attestation entirely', async () => {
    RecurringCards.resolveRecurringCardPolicyForEstimate.mockResolvedValue({ enforced: true, required: false, exemptReason: 'not_required' });
    conversionOk();
    const res = await putAccept('tok-consent-1-x012345678', {});
    expect(res.status).toBe(200);
    expect(RecurringCards.verifyRecurringCardIntent).not.toHaveBeenCalled();
  });
});

describe('C4 codex GH r4 P1 — plan-restart accept revalidation runs inside the accept txn', () => {
  // A plan_restart estimate accepts through the SAME public path — the
  // revalidation re-checks the churn stamp + residual ownership under the
  // estimate row lock, so a mint-then-staff-restore window can no longer be
  // accepted by the old token (AGENTS.md: live recurring rates are never
  // re-priced). Residual-ownership refusals are pinned in plan-restart.test.js;
  // this suite pins the WIRING and the fail-closed rollback.
  const restartEstimate = (overrides = {}) => recurringPestEstimate({
    id: 'est-restart-1',
    token: 'tok-restart-1-x0123456789',
    source: 'plan_restart',
    customer_id: 'cust-9',
    estimate_data: JSON.stringify({
      // Attempt identity (codex GH r14 P1): the accept also proves the
      // quote belongs to the attempt the account is in — the ids match the
      // cancellation_cases fixture the passing test installs.
      planRestart: { families: ['pest_control'], cancellationCaseId: 'case-9', cancellationRequestId: null, mintedAt: '2026-08-30T00:00:00Z' },
      result: {
        recurring: { discount: 0, services: [{ name: 'Pest Control', service: 'pest_control', mo: 60 }] },
        oneTime: { items: [], membershipFee: 99 },
      },
    }),
    ...overrides,
  });
  const churnedCustomer = (overrides = {}) => ({
    id: 'cust-9', active: false, pipeline_stage: 'churned', deleted_at: null,
    first_name: 'Pat', last_name: 'Tester', phone: '(941) 555-0123', email: 'pat@example.com',
    ...overrides,
  });

  test('a customer reactivated after the mint refuses the accept (409) and rolls back', async () => {
    resetStore(restartEstimate());
    db.__state.tables.customers = [churnedCustomer({ active: true, pipeline_stage: 'active_customer' })];
    const res = await putAccept('tok-restart-1-x0123456789');
    expect(res.status).toBe(409);
    expect(res.data.error).toMatch(/changed since this restart quote/);
    // Fail closed: nothing accepted, price not locked, no invoice sent.
    expect(storedEstimate().status).toBe('sent');
    expect(storedEstimate().price_locked_at == null).toBe(true);
    expect(InvoiceService.sendViaSMSAndEmail).not.toHaveBeenCalled();
  });

  test('active drifted to NULL refuses too — only the exact churn stamp accepts', async () => {
    resetStore(restartEstimate({ id: 'est-restart-2', token: 'tok-restart-2-x0123456789' }));
    db.__state.tables.customers = [churnedCustomer({ active: null })];
    const res = await putAccept('tok-restart-2-x0123456789');
    expect(res.status).toBe(409);
    expect(storedEstimate().status).toBe('sent');
  });

  test('a still-churned customer passes the revalidation and the accept commits', async () => {
    resetStore(restartEstimate({ id: 'est-restart-3', token: 'tok-restart-3-x0123456789' }));
    db.__state.tables.customers = [churnedCustomer()];
    // The revalidation now also re-derives the LATEST attempt's families
    // (codex GH r8 P1) — the committed case is that evidence.
    db.__state.tables.cancellation_cases = [{
      id: 'case-9', customer_id: 'cust-9', status: 'committed', scope: JSON.stringify(['pest_control']), created_at: '2026-08-29T00:00:00Z',
    }];
    EstimateConverter.convertEstimate.mockResolvedValueOnce({
      customerId: 'cust-9',
      tier: 'Bronze',
      monthlyRate: 60,
      firstScheduledServiceId: null,
      recurringConversionSkipped: false,
      welcomeSms: null,
      membershipEmail: null,
      deferredFollowUpReminderRows: [],
    });
    const res = await putAccept('tok-restart-3-x0123456789');
    expect(res.status).toBe(200);
    expect(storedEstimate().status).toBe('accepted');
  });

  test('a restart accept carrying option selections is refused — the stored offer is the only acceptable one (pre-push P0 after GH r21; r22 keeps the always-sent default payloads open)', async () => {
    // One-time mode is a composition change the mint never offered.
    resetStore(restartEstimate({ id: 'est-restart-frozen', token: 'tok-restart-f-x0123456789' }));
    db.__state.tables.customers = [churnedCustomer()];
    const oneTime = await putAccept('tok-restart-f-x0123456789', { serviceMode: 'one_time' });
    expect(oneTime.status).toBe(409);
    expect(oneTime.data.code).toBe('restart_quote_frozen');
    expect(storedEstimate().status).toBe('sent');

    // selectedFrequency is compared against the offer's DEFAULT key (the
    // page always serializes it): a key that is not the stored default is
    // refused — 400 unknown-key here (this fixture carries no frequency
    // ladder), 409 frozen on a ladder-bearing offer — and never accepted.
    // serviceCadences with no combos is INERT by the route's no-combos
    // rule (books the stored default); with combos, the matched combo's
    // totals must equal the minted row's stored totals — not
    // representable in this ladderless fixture.
    resetStore(restartEstimate({ id: 'est-restart-frozen', token: 'tok-restart-f-x0123456789' }));
    db.__state.tables.customers = [churnedCustomer()];
    const res = await putAccept('tok-restart-f-x0123456789', { selectedFrequency: 'monthly' });
    expect([400, 409]).toContain(res.status);
    expect(storedEstimate().status).toBe('sent');
  });
});

describe('Missing-contact capture (contactLastName/contactEmail) — owner ruling 2026-09-27', () => {
  // clearAllMocks keeps queued *Once values; a test whose accept never
  // reaches conversion would otherwise leak its queued result into the next.
  beforeEach(() => EstimateConverter.convertEstimate.mockReset());
  // The name fan-out has its own suites and uses SQL this fake knex does
  // not model; here we only assert the accept invokes it.
  let nameFanoutSpy;
  beforeEach(() => {
    nameFanoutSpy = jest.spyOn(require('../services/customer-contact-fanout'), 'propagateCustomerNameChange').mockResolvedValue({});
  });
  afterEach(() => nameFanoutSpy.mockRestore());

  function conversionOk(customerId = 'cust-1') {
    EstimateConverter.convertEstimate.mockResolvedValueOnce({
      customerId,
      tier: 'Bronze',
      monthlyRate: 60,
      firstScheduledServiceId: null,
      recurringConversionSkipped: false,
      welcomeSms: null,
      membershipEmail: null,
      deferredFollowUpReminderRows: [],
    });
  }

  test('a fresh accept with a single-token name: supplied last name replaces the "Customer" placeholder on the new profile', async () => {
    resetStore(recurringPestEstimate({
      id: 'est-contact-1',
      token: 'tok-contact-1-x0123456789',
      customer_id: null,
      customer_name: 'Testy',
      customer_email: null,
    }));
    conversionOk();

    const res = await putAccept('tok-contact-1-x0123456789', {
      contactLastName: 'Sample',
      contactEmail: 'testy@example.com',
    });
    expect(res.status).toBe(200);

    const customerId = storedEstimate().customer_id;
    expect(customerId).toBeTruthy();
    const cust = db.__state.tables.customers.find((c) => c.id === customerId);
    expect(cust.first_name).toBe('Testy');
    expect(cust.last_name).toBe('Sample');
    expect(cust.email).toBe('testy@example.com');
    // The estimate row itself is patched too — downstream reads (retry
    // rebuild, notifications) see the real name/email, not the placeholder.
    expect(storedEstimate().customer_name).toBe('Testy Sample');
    expect(storedEstimate().customer_email).toBe('testy@example.com');
  });

  test('regression baseline: with no contactLastName/contactEmail supplied, the new profile still gets the "Customer" placeholder', async () => {
    resetStore(recurringPestEstimate({
      id: 'est-contact-2',
      token: 'tok-contact-2-x0123456789',
      customer_id: null,
      customer_name: 'Testy',
      customer_email: null,
    }));
    conversionOk();

    const res = await putAccept('tok-contact-2-x0123456789');
    expect(res.status).toBe(200);

    const customerId = storedEstimate().customer_id;
    const cust = db.__state.tables.customers.find((c) => c.id === customerId);
    expect(cust.first_name).toBe('Testy');
    expect(cust.last_name).toBe('Customer');
    expect(cust.email).toBeNull();
  });

  test('an existing linked customer with a blank last name/email gets them filled', async () => {
    resetStore(recurringPestEstimate({
      id: 'est-contact-3',
      token: 'tok-contact-3-x0123456789',
      customer_id: 'cust-blank',
      customer_phone: null,
      // The page only offers (and the server only fills) real gaps.
      customer_name: 'Pat',
      customer_email: null,
    }));
    db.__state.tables.customers = [{ id: 'cust-blank', first_name: 'Pat', last_name: null, email: null, phone: null }];
    conversionOk('cust-blank');

    const res = await putAccept('tok-contact-3-x0123456789', {
      contactLastName: 'Sample',
      contactEmail: 'pat@example.com',
    });
    expect(res.status).toBe(200);

    const cust = db.__state.tables.customers.find((c) => c.id === 'cust-blank');
    expect(cust.last_name).toBe('Sample');
    expect(cust.email).toBe('pat@example.com');
  });

  test('a lowercase "customer" placeholder and a whitespace-only email count as gaps and get filled', async () => {
    resetStore(recurringPestEstimate({
      id: 'est-contact-9',
      token: 'tok-contact-9-x0123456789',
      customer_id: 'cust-placeholder',
      customer_phone: null,
      customer_name: 'Pat',
      customer_email: '   ',
    }));
    db.__state.tables.customers = [{ id: 'cust-placeholder', first_name: 'Pat', last_name: 'customer', email: '  ', phone: null }];
    conversionOk('cust-placeholder');

    const res = await putAccept('tok-contact-9-x0123456789', {
      contactLastName: 'Sample',
      contactEmail: 'pat@example.com',
    });
    expect(res.status).toBe(200);

    const cust = db.__state.tables.customers.find((c) => c.id === 'cust-placeholder');
    expect(cust.last_name).toBe('Sample');
    expect(cust.email).toBe('pat@example.com');
    expect(storedEstimate().customer_email).toBe('pat@example.com');
  });

  test('an existing linked customer with a real last name/email on file is NEVER overwritten', async () => {
    resetStore(recurringPestEstimate({
      id: 'est-contact-4',
      token: 'tok-contact-4-x0123456789',
      customer_id: 'cust-real',
      customer_phone: null,
    }));
    db.__state.tables.customers = [{
      id: 'cust-real', first_name: 'Pat', last_name: 'Original', email: 'original@example.com', phone: null,
    }];
    conversionOk('cust-real');

    const res = await putAccept('tok-contact-4-x0123456789', {
      contactLastName: 'Different',
      contactEmail: 'different@example.com',
    });
    expect(res.status).toBe(200);

    const cust = db.__state.tables.customers.find((c) => c.id === 'cust-real');
    expect(cust.last_name).toBe('Original');
    expect(cust.email).toBe('original@example.com');
  });

  test('a rejected accept (rolled-back transaction) leaves the stored contact details untouched', async () => {
    resetStore(recurringPestEstimate({
      id: 'est-contact-7',
      token: 'tok-contact-7-x0123456789',
      customer_id: null,
      customer_name: 'Testy',
      customer_email: null,
    }));
    EstimateConverter.convertEstimate.mockRejectedValueOnce(new Error('conversion boom'));

    const res = await putAccept('tok-contact-7-x0123456789', {
      contactLastName: 'Sample',
      contactEmail: 'testy@example.com',
    });
    expect(res.status).toBeGreaterThanOrEqual(500);
    expect(storedEstimate().status).toBe('sent');
    expect(storedEstimate().customer_name).toBe('Testy');
    expect(storedEstimate().customer_email == null).toBe(true);
  });

  test('the persisted email fill never overwrites an email that landed after the accept read the gap', async () => {
    resetStore(recurringPestEstimate({
      id: 'est-contact-8',
      token: 'tok-contact-8-x0123456789',
      customer_id: null,
      customer_name: 'Testy',
      customer_email: null,
    }));
    // A concurrent writer stamps an email after the handler read the gap
    // but before the accept transaction opens — the in-transaction
    // compare-and-set must leave that value alone.
    const stored = storedEstimate();
    conversionOk();
    const origTransaction = db.transaction;
    db.transaction = async (fn) => {
      stored.customer_email = 'office@example.com';
      db.transaction = origTransaction;
      return origTransaction.call(db, fn);
    };

    const res = await putAccept('tok-contact-8-x0123456789', { contactEmail: 'testy@example.com' });
    expect(res.status).toBe(200);
    expect(storedEstimate().customer_email).toBe('office@example.com');
    // The new profile uses the stored (winning) email, not the stale patch.
    const cust = db.__state.tables.customers.find((c) => c.id === storedEstimate().customer_id);
    expect(cust.email).toBe('office@example.com');
  });

  test('an existing customer never gets an email that lost the estimate compare-and-set', async () => {
    resetStore(recurringPestEstimate({
      id: 'est-contact-12',
      token: 'tok-contact-12-x0123456789',
      customer_id: 'cust-race',
      customer_phone: null,
      customer_name: 'Pat Original',
      customer_email: null,
    }));
    db.__state.tables.customers = [{ id: 'cust-race', first_name: 'Pat', last_name: 'Original', email: null, phone: null }];
    const stored = storedEstimate();
    conversionOk('cust-race');
    const origTransaction = db.transaction;
    db.transaction = async (fn) => {
      stored.customer_email = 'office@example.com';
      db.transaction = origTransaction;
      return origTransaction.call(db, fn);
    };

    const res = await putAccept('tok-contact-12-x0123456789', { contactEmail: 'testy@example.com' });
    expect(res.status).toBe(200);
    expect(storedEstimate().customer_email).toBe('office@example.com');
    const cust = db.__state.tables.customers.find((c) => c.id === 'cust-race');
    expect(cust.email).toBeNull();
  });

  test('a refused email claim (merge-undo holder) is cleared from the estimate too', async () => {
    resetStore(recurringPestEstimate({
      id: 'est-contact-13',
      token: 'tok-contact-13-x0123456789',
      customer_id: 'cust-undo',
      customer_phone: null,
      customer_name: 'Pat Original',
      customer_email: null,
    }));
    db.__state.tables.customers = [{ id: 'cust-undo', first_name: 'Pat', last_name: 'Original', email: null, phone: null }];
    conversionOk('cust-undo');
    const fanout = require('../services/customer-email-fanout');
    const spy = jest.spyOn(fanout, 'backfillCustomerEmailInTrx').mockResolvedValueOnce({
      emailApplied: false,
      emailDroppedReason: 'address was restored to a merged-away customer by an undo',
    });
    try {
      const res = await putAccept('tok-contact-13-x0123456789', { contactEmail: 'restored@example.com' });
      expect(res.status).toBe(200);
      expect(spy).toHaveBeenCalled();
      expect(storedEstimate().customer_email == null).toBe(true);
      const cust = db.__state.tables.customers.find((c) => c.id === 'cust-undo');
      expect(cust.email).toBeNull();
    } finally {
      spy.mockRestore();
    }
  });

  test('an authored proposal preparedFor that matched the old name moves with it and drops the PDF-delivery marker', async () => {
    const base = recurringPestEstimate({
      id: 'est-contact-14',
      token: 'tok-contact-14-x0123456789',
      customer_id: null,
      customer_name: 'Testy',
      customer_email: 'testy@example.com',
    });
    const data = typeof base.estimate_data === 'string' ? JSON.parse(base.estimate_data) : { ...(base.estimate_data || {}) };
    data.proposal = { ...(data.proposal || {}), preparedFor: 'Testy' };
    data.proposalDelivery = { status: 'emailed' };
    resetStore({ ...base, estimate_data: JSON.stringify(data) });
    conversionOk();

    const res = await putAccept('tok-contact-14-x0123456789', { contactLastName: 'Sample' });
    expect(res.status).toBe(200);
    const stored = storedEstimate();
    const storedData = typeof stored.estimate_data === 'string' ? JSON.parse(stored.estimate_data) : stored.estimate_data;
    expect(stored.customer_name).toBe('Testy Sample');
    expect(storedData.proposal.preparedFor).toBe('Testy Sample');
    expect(storedData.proposalDelivery).toBeUndefined();
  });

  test('a custom preparedFor (someone else) is left alone with its delivery marker', async () => {
    const base = recurringPestEstimate({
      id: 'est-contact-15',
      token: 'tok-contact-15-x0123456789',
      customer_id: null,
      customer_name: 'Testy',
      customer_email: 'testy@example.com',
    });
    const data = typeof base.estimate_data === 'string' ? JSON.parse(base.estimate_data) : { ...(base.estimate_data || {}) };
    data.proposal = { ...(data.proposal || {}), preparedFor: 'Sample Property Manager' };
    data.proposalDelivery = { status: 'emailed' };
    resetStore({ ...base, estimate_data: JSON.stringify(data) });
    conversionOk();

    const res = await putAccept('tok-contact-15-x0123456789', { contactLastName: 'Sample' });
    expect(res.status).toBe(200);
    const stored = storedEstimate();
    const storedData = typeof stored.estimate_data === 'string' ? JSON.parse(stored.estimate_data) : stored.estimate_data;
    expect(storedData.proposal.preparedFor).toBe('Sample Property Manager');
    expect(storedData.proposalDelivery).toEqual({ status: 'emailed' });
  });

  test('a new profile keeps the full supplied surname even when the combined name snapshot is capped', async () => {
    const longFirst = 'F'.repeat(60);
    const longLast = 'L'.repeat(50);
    resetStore(recurringPestEstimate({
      id: 'est-contact-16',
      token: 'tok-contact-16-x0123456789',
      customer_id: null,
      customer_name: longFirst,
      customer_email: 'testy@example.com',
    }));
    conversionOk();

    const res = await putAccept('tok-contact-16-x0123456789', { contactLastName: longLast });
    expect(res.status).toBe(200);
    expect(storedEstimate().customer_name).toHaveLength(100);
    const cust = db.__state.tables.customers.find((c) => c.id === storedEstimate().customer_id);
    // Full 50 characters survive (contact normalization title-cases it).
    expect(cust.last_name).toHaveLength(50);
    expect(cust.last_name.toUpperCase()).toBe(longLast);
  });

  test('a submitted email never steers the phone match away from the unique address match', async () => {
    const est = recurringPestEstimate({
      id: 'est-contact-17',
      token: 'tok-contact-17-x0123456789',
      customer_id: null,
      customer_name: 'Testy Sample',
      customer_email: null,
    });
    resetStore(est);
    const line1 = String(est.address || '').split(',')[0];
    db.__state.tables.customers = [
      { id: 'cust-addr', first_name: 'Testy', last_name: 'Sample', email: null, phone: est.customer_phone, address_line1: line1, deleted_at: null, updated_at: new Date('2026-01-01') },
      { id: 'cust-mail', first_name: 'Other', last_name: 'Person', email: 'someone@example.com', phone: est.customer_phone, address_line1: '1 Elsewhere Rd', deleted_at: null, updated_at: new Date('2026-02-01') },
    ];
    conversionOk('cust-addr');

    const res = await putAccept('tok-contact-17-x0123456789', { contactEmail: 'someone@example.com' });
    expect(res.status).toBe(200);
    expect(storedEstimate().customer_id).toBe('cust-addr');
  });

  test('an estimate addressed to someone else under the account (tenant under landlord) never fills the account holder', async () => {
    resetStore(recurringPestEstimate({
      id: 'est-contact-18',
      token: 'tok-contact-18-x0123456789',
      customer_id: 'cust-landlord',
      customer_phone: null,
      customer_name: 'Testy',
      customer_email: null,
    }));
    db.__state.tables.customers = [{ id: 'cust-landlord', first_name: 'Pat', last_name: null, email: null, phone: null }];
    conversionOk('cust-landlord');

    const res = await putAccept('tok-contact-18-x0123456789', { contactLastName: 'Sample', contactEmail: 'testy@example.com' });
    expect(res.status).toBe(200);
    const cust = db.__state.tables.customers.find((c) => c.id === 'cust-landlord');
    expect(cust.last_name).toBeNull();
    expect(cust.email).toBeNull();
    // The values stay with the estimate they were typed on.
    expect(storedEstimate().customer_name).toBe('Testy Sample');
    expect(storedEstimate().customer_email).toBe('testy@example.com');
  });

  test('an existing-profile fill stamps updated_at and runs the name fan-out', async () => {
    resetStore(recurringPestEstimate({
      id: 'est-contact-19',
      token: 'tok-contact-19-x0123456789',
      customer_id: 'cust-stamp',
      customer_phone: null,
      customer_name: 'Pat',
      customer_email: null,
    }));
    const oldStamp = new Date('2026-01-01T00:00:00Z');
    db.__state.tables.customers = [{ id: 'cust-stamp', first_name: 'Pat', last_name: 'Customer', email: null, phone: null, updated_at: oldStamp }];
    conversionOk('cust-stamp');
    const spy = nameFanoutSpy;
    {
      const res = await putAccept('tok-contact-19-x0123456789', { contactLastName: 'Sample', contactEmail: 'pat@example.com' });
      expect(res.status).toBe(200);
      const cust = db.__state.tables.customers.find((c) => c.id === 'cust-stamp');
      expect(cust.last_name).toBe('Sample');
      expect(cust.email).toBe('pat@example.com');
      expect(new Date(cust.updated_at).getTime()).toBeGreaterThan(oldStamp.getTime());
      expect(spy).toHaveBeenCalledWith(
        expect.objectContaining({
          before: expect.objectContaining({ id: 'cust-stamp', last_name: 'Customer' }),
          after: expect.objectContaining({ id: 'cust-stamp', last_name: 'Sample' }),
        }),
        expect.anything(),
      );
    }
  });

  test('a nameless estimate collects a first name too, and the new profile never gets a placeholder first name', async () => {
    resetStore(recurringPestEstimate({
      id: 'est-contact-20',
      token: 'tok-contact-20-x0123456789',
      customer_id: null,
      customer_name: '',
      customer_email: 'testy@example.com',
    }));
    conversionOk();

    const res = await putAccept('tok-contact-20-x0123456789', { contactFirstName: 'mary ann', contactLastName: 'sample' });
    expect(res.status).toBe(200);
    expect(storedEstimate().customer_name).toBe('Mary Ann Sample');
    const cust = db.__state.tables.customers.find((c) => c.id === storedEstimate().customer_id);
    expect(cust.first_name).toBe('Mary Ann');
    expect(cust.last_name).toBe('Sample');
  });

  test('a first name collected on its own (linked profile has a real surname) still lands on the estimate', async () => {
    resetStore(recurringPestEstimate({
      id: 'est-contact-22',
      token: 'tok-contact-22-x0123456789',
      customer_id: 'cust-noname',
      customer_phone: null,
      customer_name: 'Sample',
      customer_email: 'testy@example.com',
    }));
    db.__state.tables.customers = [{ id: 'cust-noname', first_name: '', last_name: 'Sample', email: 'testy@example.com', phone: null }];
    conversionOk('cust-noname');

    const res = await putAccept('tok-contact-22-x0123456789', { contactFirstName: 'testy' });
    expect(res.status).toBe(200);
    expect(storedEstimate().customer_name).toBe('Testy Sample');
  });

  test('a stale tab that sends only a surname for a nameless estimate applies nothing to the name', async () => {
    resetStore(recurringPestEstimate({
      id: 'est-contact-21',
      token: 'tok-contact-21-x0123456789',
      customer_id: null,
      customer_name: '',
      customer_email: 'testy@example.com',
    }));
    conversionOk();

    const res = await putAccept('tok-contact-21-x0123456789', { contactLastName: 'Sample' });
    expect(res.status).toBe(200);
    expect(storedEstimate().customer_name).toBe('');
    const cust = db.__state.tables.customers.find((c) => c.id === storedEstimate().customer_id);
    expect(cust.first_name).not.toBe('Customer');
  });

  test('a multi-word profile first name ("Mary Ann") still proves identity and gets filled', async () => {
    resetStore(recurringPestEstimate({
      id: 'est-contact-23',
      token: 'tok-contact-23-x0123456789',
      customer_id: 'cust-maryann',
      customer_phone: null,
      customer_name: 'Mary Ann Sample',
      customer_email: null,
    }));
    db.__state.tables.customers = [{ id: 'cust-maryann', first_name: 'Mary Ann', last_name: 'Sample', email: null, phone: null }];
    conversionOk('cust-maryann');
    const fanout = require('../services/customer-email-fanout');
    const resolveSpy = jest.spyOn(fanout, 'resolveOpenEmailReviewCards').mockResolvedValue(0);
    try {
      const res = await putAccept('tok-contact-23-x0123456789', { contactEmail: 'maryann@example.com' });
      expect(res.status).toBe(200);
      const cust = db.__state.tables.customers.find((c) => c.id === 'cust-maryann');
      expect(cust.email).toBe('maryann@example.com');
      // Post-commit, open customer_email_missing cards settle.
      expect(resolveSpy).toHaveBeenCalledWith(expect.objectContaining({
        customerId: 'cust-maryann', email: 'maryann@example.com', reasonCodes: ['customer_email_missing'],
      }));
    } finally {
      resolveSpy.mockRestore();
    }
  });

  test('a multi-word given name with no surname gets the surname appended to the whole given name', async () => {
    resetStore(recurringPestEstimate({
      id: 'est-contact-24',
      token: 'tok-contact-24-x0123456789',
      customer_id: 'cust-maryann-2',
      customer_phone: null,
      customer_name: 'Mary Ann',
      customer_email: 'maryann@example.com',
    }));
    db.__state.tables.customers = [{ id: 'cust-maryann-2', first_name: 'Mary Ann', last_name: null, email: 'maryann@example.com', phone: null }];
    conversionOk('cust-maryann-2');

    const res = await putAccept('tok-contact-24-x0123456789', { contactLastName: 'Sample' });
    expect(res.status).toBe(200);
    expect(storedEstimate().customer_name).toBe('Mary Ann Sample');
    const cust = db.__state.tables.customers.find((c) => c.id === 'cust-maryann-2');
    expect(cust.last_name).toBe('Sample');
  });

  test('the explicitly linked profile with a blank first name takes the collected first name and surname', async () => {
    resetStore(recurringPestEstimate({
      id: 'est-contact-25',
      token: 'tok-contact-25-x0123456789',
      customer_id: 'cust-unknown',
      customer_phone: null,
      customer_name: '',
      customer_email: 'testy@example.com',
    }));
    db.__state.tables.customers = [{ id: 'cust-unknown', first_name: '', last_name: null, email: 'testy@example.com', phone: null }];
    conversionOk('cust-unknown');

    const res = await putAccept('tok-contact-25-x0123456789', { contactFirstName: 'testy', contactLastName: 'sample' });
    expect(res.status).toBe(200);
    const cust = db.__state.tables.customers.find((c) => c.id === 'cust-unknown');
    expect(cust.first_name).toBe('Testy');
    expect(cust.last_name).toBe('Sample');
    expect(storedEstimate().customer_name).toBe('Testy Sample');
    expect(nameFanoutSpy).toHaveBeenCalled();
  });

  test('a multi-word collected first name stays whole on a new profile', async () => {
    resetStore(recurringPestEstimate({
      id: 'est-contact-28',
      token: 'tok-contact-28-x0123456789',
      customer_id: null,
      customer_name: '',
      customer_email: 'testy@example.com',
    }));
    conversionOk();

    const res = await putAccept('tok-contact-28-x0123456789', { contactFirstName: 'mary ann', contactLastName: 'sample' });
    expect(res.status).toBe(200);
    expect(storedEstimate().customer_name).toBe('Mary Ann Sample');
    const cust = db.__state.tables.customers.find((c) => c.id === storedEstimate().customer_id);
    expect(cust.first_name).toBe('Mary Ann');
    expect(cust.last_name).toBe('Sample');
  });

  test('a crafted request for a field the page never offered writes nothing (estimate already has full name + email)', async () => {
    resetStore(recurringPestEstimate({
      id: 'est-contact-10',
      token: 'tok-contact-10-x0123456789',
      customer_id: 'cust-blank-2',
      customer_phone: null,
      customer_name: 'Pat Original',
      customer_email: 'original@example.com',
    }));
    db.__state.tables.customers = [{ id: 'cust-blank-2', first_name: 'Pat', last_name: null, email: null, phone: null }];
    conversionOk('cust-blank-2');

    const res = await putAccept('tok-contact-10-x0123456789', {
      contactLastName: 'Injected',
      contactEmail: 'attacker@example.com',
    });
    expect(res.status).toBe(200);

    const cust = db.__state.tables.customers.find((c) => c.id === 'cust-blank-2');
    expect(cust.last_name).toBeNull();
    expect(cust.email).toBeNull();
    expect(storedEstimate().customer_name).toBe('Pat Original');
    expect(storedEstimate().customer_email).toBe('original@example.com');
  });

  test('a legacy "undefined"-prefixed name keeps no "undefined" token when the last name is filled', async () => {
    resetStore(recurringPestEstimate({
      id: 'est-contact-11',
      token: 'tok-contact-11-x0123456789',
      customer_id: null,
      customer_name: 'undefined Testy',
      customer_email: 'testy@example.com',
    }));
    conversionOk();

    const res = await putAccept('tok-contact-11-x0123456789', { contactLastName: 'Sample' });
    expect(res.status).toBe(200);
    expect(storedEstimate().customer_name).toBe('Testy Sample');
  });

  test('an invalid contactEmail 400s before any mutation — nothing commits', async () => {
    resetStore(recurringPestEstimate({
      id: 'est-contact-5',
      token: 'tok-contact-5-x0123456789',
      customer_id: null,
    }));

    const res = await putAccept('tok-contact-5-x0123456789', { contactEmail: 'not-an-email' });
    expect(res.status).toBe(400);
    expect(res.data.code).toBe('CONTACT_EMAIL_INVALID');
    expect(storedEstimate().status).toBe('sent');
    expect(db.__state.tables.customers).toHaveLength(0);
    expect(EstimateConverter.convertEstimate).not.toHaveBeenCalled();
  });

  test('a control character in contactLastName 400s before any mutation — nothing commits', async () => {
    resetStore(recurringPestEstimate({
      id: 'est-contact-6',
      token: 'tok-contact-6-x0123456789',
      customer_id: null,
    }));

    const res = await putAccept('tok-contact-6-x0123456789', { contactLastName: 'Sample\u0001Name' });
    expect(res.status).toBe(400);
    expect(res.data.code).toBe('CONTACT_LAST_NAME_INVALID');
    expect(storedEstimate().status).toBe('sent');
    expect(db.__state.tables.customers).toHaveLength(0);
    expect(EstimateConverter.convertEstimate).not.toHaveBeenCalled();
  });
});

// GitHub Codex #5481 r2 — the accept must bind to exactly what /data showed.
describe('PAF-B r2 — captured intent / attestation vs the LIVE card policy', () => {
  const RecurringCards = require('../services/recurring-card-on-file');
  const { AFTER_VISIT_CONSENT_VERSION } = require('../services/payment-method-consent-text');
  // The accept route rate-limits per token — a fresh token per seed keeps
  // each case independent of how many accepts the earlier ones sent.
  let TOKEN = 'tok-pafb-r2-x0123456789';
  let tokenSeq = 0;
  let resolverSpy;
  let retireSpy;

  function seed() {
    retireSpy = jest.spyOn(RecurringCards, 'retireOrphanedCaptureIntent').mockResolvedValue({ ok: true, retired: true });
    tokenSeq += 1;
    TOKEN = `tok-pafb-r2-${tokenSeq}-x0123456789`;
    resetStore(recurringPestEstimate({ id: 'est-pafb-r2', token: TOKEN }));
  }
  function livePolicy(policy) {
    resolverSpy = jest.spyOn(RecurringCards, 'resolveRecurringCardPolicyForEstimate').mockResolvedValue(policy);
  }
  function conversionOk() {
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
  }
  const CAPTURED = {
    recurringCardSetupIntentId: 'seti_captured_1',
    recurringCardConsentVariant: 'after_visit_card',
    recurringCardConsentVersion: AFTER_VISIT_CONSENT_VERSION,
  };

  afterEach(() => {
    if (resolverSpy) resolverSpy.mockRestore();
    resolverSpy = null;
    if (retireSpy) retireSpy.mockRestore();
    retireSpy = null;
  });

  test('P0: rollout gate turned off mid-flight (policy no longer enforced) — captured intent + attestation 409, nothing committed', async () => {
    seed();
    livePolicy({ enforced: false, required: false, exemptReason: 'feature_disabled' });
    const res = await putAccept(TOKEN, CAPTURED);
    expect(res.status).toBe(409);
    expect(res.data.code).toBe('CONSENT_VARIANT_STALE');
    // r3 P0: the orphaned capture is retired in Stripe so it can never be recovered later.
    expect(retireSpy).toHaveBeenCalledWith(expect.objectContaining({ setupIntentId: 'seti_captured_1' }));
    expect(storedEstimate().status).toBe('sent');
    expect(storedEstimate().estimate_data).not.toContain('acceptedRecurringCard');
    expect(EstimateConverter.convertEstimate).not.toHaveBeenCalled();
  });

  test('P0: a captured intent alone (no attestation) is refused the same way', async () => {
    seed();
    livePolicy({ enforced: false, required: false, exemptReason: 'feature_disabled' });
    const res = await putAccept(TOKEN, { recurringCardSetupIntentId: 'seti_captured_1' });
    expect(res.status).toBe(409);
    expect(res.data.code).toBe('CONSENT_VARIANT_STALE');
    expect(EstimateConverter.convertEstimate).not.toHaveBeenCalled();
  });

  test('P0: another tab saved a consented method (saved_method_consented) after this tab captured — 409, intent stays unbound', async () => {
    seed();
    livePolicy({
      enforced: true, required: false, exemptReason: 'saved_method_consented', savedMethodRowId: 'pm-row-1', customerId: 'cust-1', afterVisitCard: true,
    });
    const res = await putAccept(TOKEN, CAPTURED);
    expect(res.status).toBe(409);
    expect(res.data.code).toBe('CONSENT_VARIANT_STALE');
    expect(storedEstimate().status).toBe('sent');
    expect(storedEstimate().estimate_data).not.toContain('acceptedRecurringCardSetupIntentId');
    expect(EstimateConverter.convertEstimate).not.toHaveBeenCalled();
  });

  test('r3 P0: a retire that cannot be confirmed fails closed (503), nothing committed, no 409 that would drop the intent', async () => {
    seed();
    livePolicy({ enforced: false, required: false, exemptReason: 'feature_disabled' });
    retireSpy.mockResolvedValue({ ok: false, reason: 'retire_failed' });
    const res = await putAccept(TOKEN, CAPTURED);
    expect(res.status).toBe(503);
    expect(res.data.code).toBe('RECURRING_CARD_RETIRE_FAILED');
    expect(storedEstimate().status).toBe('sent');
    expect(EstimateConverter.convertEstimate).not.toHaveBeenCalled();
  });

  test('r3 P0: an after-visit variant mismatch on a still-required policy also retires the dropped intent', async () => {
    seed();
    livePolicy({
      enforced: true, required: true, exemptReason: null, customerId: 'cust-1', afterVisitCard: true, autopayDisabled: true,
    });
    const res = await putAccept(TOKEN, CAPTURED);
    expect(res.status).toBe(409);
    expect(res.data.code).toBe('CONSENT_VARIANT_STALE');
    expect(retireSpy).toHaveBeenCalledWith(expect.objectContaining({ setupIntentId: 'seti_captured_1' }));
  });

  test('r3 P0: an attestation alone (no intent) retires nothing', async () => {
    seed();
    livePolicy({ enforced: false, required: false, exemptReason: 'feature_disabled' });
    const res = await putAccept(TOKEN, { recurringCardConsentVariant: 'after_visit_card' });
    expect(res.status).toBe(409);
    expect(retireSpy).not.toHaveBeenCalled();
  });

  test('control: a not-required policy with NO intent / attestation still accepts', async () => {
    seed();
    livePolicy({ enforced: false, required: false, exemptReason: 'feature_disabled' });
    conversionOk();
    const res = await putAccept(TOKEN, {});
    expect(res.status).toBe(200);
    expect(storedEstimate().status).toBe('accepted');
  });

  function acceptedData() {
    const raw = storedEstimate().estimate_data;
    return typeof raw === 'string' ? JSON.parse(raw) : raw;
  }

  test('pre-push P0: PAF 409 stale -> reload -> accept on a no-capture path durably marks the accept so the webhook can never enroll the discarded intent', async () => {
    seed();
    // Tab 1 captured under the after-visit flow; another tab then saved a
    // consented method, so the live policy is the PAF saved-method cohort.
    livePolicy({
      enforced: true, required: false, exemptReason: 'saved_method_consented', savedMethodRowId: 'pm-row-1', customerId: 'cust-1', afterVisitCard: true,
    });
    const stale = await putAccept(TOKEN, CAPTURED);
    expect(stale.status).toBe(409);
    expect(storedEstimate().estimate_data).not.toContain('acceptedRecurringCardSetupIntentId');
    // The reloaded tab accepts without the (dropped) intent; the locked-row
    // eligibility recheck is a DB read this in-memory store does not model.
    const driftSpy = jest.spyOn(RecurringCards, 'pafExistingDriftUnderLock').mockResolvedValue(false);
    conversionOk();
    const res = await putAccept(TOKEN, {});
    expect(res.status).toBe(200);
    driftSpy.mockRestore();
    expect(acceptedData().acceptedRecurringCardSetupIntentId).toBe(RecurringCards.ACCEPTED_NO_CAPTURE_MARKER);
  });

  test('r3 P1: a gate-off no-capture accept writes NO marker (byte-identical to pre-PR-B)', async () => {
    seed();
    livePolicy({ enforced: false, required: false, exemptReason: 'feature_disabled' });
    conversionOk();
    const res = await putAccept(TOKEN, {});
    expect(res.status).toBe(200);
    expect(storedEstimate().estimate_data).not.toContain('acceptedRecurringCard');
  });

  test.each([
    ['payer_billed', { enforced: true, required: false, exemptReason: 'payer_billed' }],
    ['autopay_already_active', { enforced: true, required: false, exemptReason: 'autopay_already_active' }],
    ['commercial_manual_billing', { enforced: true, required: false, exemptReason: 'commercial_manual_billing' }],
    ['payer_check_uncertain', { enforced: true, required: false, exemptReason: 'payer_check_uncertain' }],
    ['existing_plan_customer', { enforced: true, required: false, exemptReason: 'existing_plan_customer' }],
    ['saved_method_consented (non-PAF)', {
      enforced: true, required: false, exemptReason: 'saved_method_consented', savedMethodRowId: 'pm-row-1', customerId: 'cust-1',
    }],
  ])('r3 P1: exempt cohort %s writes NO marker — a legacy recovery stays exactly as before', async (_name, policy) => {
    seed();
    livePolicy(policy);
    conversionOk();
    const res = await putAccept(TOKEN, {});
    expect(res.status).toBe(200);
    expect(storedEstimate().estimate_data).not.toContain('acceptedRecurringCard');
  });

  describe('r3 P0: ACCEPT_BILLING_CHANGED drift under the customer lock orphans the verified capture', () => {
    let verifySpy;
    let bankSpy;
    let driftSpy;
    beforeEach(() => {
      seed();
      livePolicy({
        enforced: true, required: true, exemptReason: null, customerId: 'cust-1', afterVisitCard: true,
      });
      verifySpy = jest.spyOn(RecurringCards, 'verifyRecurringCardIntent').mockResolvedValue({
        ok: true, paymentMethodId: 'pm_1', setupIntentId: 'seti_captured_1', methodType: 'card',
      });
      bankSpy = jest.spyOn(RecurringCards, 'bankTenderAllowedUnderLock').mockResolvedValue(true);
      driftSpy = jest.spyOn(RecurringCards, 'pafExistingDriftUnderLock').mockResolvedValue(true);
    });
    afterEach(() => {
      verifySpy.mockRestore();
      bankSpy.mockRestore();
      driftSpy.mockRestore();
    });

    test('drift -> the captured intent is retired before the reloadable 409', async () => {
      const res = await putAccept(TOKEN, CAPTURED);
      expect(res.status).toBe(409);
      expect(res.data.code).toBe('ACCEPT_BILLING_CHANGED');
      expect(retireSpy).toHaveBeenCalledWith(expect.objectContaining({ setupIntentId: 'seti_captured_1' }));
      expect(storedEstimate().status).toBe('sent');
      expect(EstimateConverter.convertEstimate).not.toHaveBeenCalled();
    });

    test('a retire Stripe cannot confirm fails closed (503), nothing committed', async () => {
      retireSpy.mockResolvedValue({ ok: false, reason: 'retire_failed' });
      const res = await putAccept(TOKEN, CAPTURED);
      expect(res.status).toBe(503);
      expect(res.data.code).toBe('RECURRING_CARD_RETIRE_FAILED');
      expect(storedEstimate().status).toBe('sent');
      expect(EstimateConverter.convertEstimate).not.toHaveBeenCalled();
    });
  });

  // GitHub Codex #5481 r3 (structural): ONE collection promise decided in the
  // accept transaction from the verified tender + the real invoice outcome.
  describe('r3: the collection promise the accept records equals what the capture UI attested', () => {
    let verifySpy;
    let bankSpy;
    let driftSpy;
    let underLockSpy;
    let enrollSpy;
    const BASE_VERSION = require('../services/payment-method-consent-text').CONSENT_VERSION;
    // The in-memory DB keeps a ?::jsonb binding as its string (Postgres stores the object).
    const asJson = (v) => (typeof v === 'string' ? JSON.parse(v) : v);
    const AFTER_VISIT = {
      recurringCardSetupIntentId: 'seti_captured_1',
      recurringCardConsentVariant: 'after_visit_card',
      recurringCardConsentVersion: AFTER_VISIT_CONSENT_VERSION,
      recurringCardConsentTender: 'card',
      // A current tab attests the "billed after your first visit" timing it shows.
      afterVisitTimingShown: true,
    };
    function verification(methodType) {
      verifySpy.mockResolvedValue({
        ok: true, paymentMethodId: 'pm_1', setupIntentId: 'seti_captured_1', methodType,
      });
    }
    function conversion(firstScheduledServiceId) {
      EstimateConverter.convertEstimate.mockResolvedValueOnce({
        customerId: 'cust-1',
        tier: 'Bronze',
        monthlyRate: 60,
        firstScheduledServiceId,
        recurringConversionSkipped: false,
        welcomeSms: null,
        membershipEmail: null,
        deferredFollowUpReminderRows: [],
      });
    }
    beforeEach(() => {
      seed();
      livePolicy({
        enforced: true, required: true, exemptReason: null, customerId: 'cust-1', afterVisitCard: true,
      });
      verifySpy = jest.spyOn(RecurringCards, 'verifyRecurringCardIntent');
      verification('card');
      bankSpy = jest.spyOn(RecurringCards, 'bankTenderAllowedUnderLock').mockResolvedValue(true);
      driftSpy = jest.spyOn(RecurringCards, 'pafExistingDriftUnderLock').mockResolvedValue(false);
      underLockSpy = jest.spyOn(RecurringCards, 'verifyRecurringCardIntentUnderLock').mockResolvedValue(true);
      enrollSpy = jest.spyOn(RecurringCards, 'completeRecurringCardEnrollment').mockResolvedValue({ enrolled: true });
    });
    afterEach(() => {
      [verifySpy, bankSpy, driftSpy, underLockSpy, enrollSpy].forEach((spy) => spy.mockRestore());
    });

    test('attached first-application invoice + card tender + after-visit attestation: accepted, variant stamped, enrollment records it', async () => {
      conversion('ss-first');
      const res = await putAccept(TOKEN, AFTER_VISIT);
      expect(res.status).toBe(200);
      expect(acceptedData().acceptedRecurringCardConsentVariant).toBe('after_visit_card');
      expect(enrollSpy).toHaveBeenCalledWith(expect.objectContaining({ consentVariant: 'after_visit_card' }));
      expect(retireSpy).not.toHaveBeenCalled();
    });

    test('an UNATTACHED standard invoice (setup-only shape / no first visit: pay link at accept) is not the after-visit promise — 409, nothing recorded, dropped intent retired', async () => {
      conversion(null);
      // A setup-only page shows no first-visit timing, so it attests none.
      const { afterVisitTimingShown: _shown, ...noTiming } = AFTER_VISIT;
      const res = await putAccept(TOKEN, noTiming);
      expect(res.status).toBe(409);
      expect(res.data.code).toBe('CONSENT_VARIANT_STALE');
      expect(storedEstimate().status).toBe('sent');
      expect(retireSpy).toHaveBeenCalledWith(expect.objectContaining({ setupIntentId: 'seti_captured_1' }));
      // The promise the server would record rides the 409 so the reloaded tab
      // renders the base text for this selection instead of looping.
      // deferred:false — the unattached first invoice goes out at accept.
      expect(res.data.collectionPromise).toEqual({ variant: null, tender: 'card', version: require('../services/payment-method-consent-text').CONSENT_VERSION, deferred: false });
    });

    test('the same unattached shape accepts when the tab rendered (and attests) the base text — recorded variant is base', async () => {
      conversion(null);
      const res = await putAccept(TOKEN, { recurringCardSetupIntentId: 'seti_captured_1', recurringCardConsentTender: 'card', recurringCardConsentVersion: BASE_VERSION });
      expect(res.status).toBe(200);
      expect(acceptedData().acceptedRecurringCardConsentVariant).toBeUndefined();
      expect(enrollSpy.mock.calls[0][0].consentVariant).toBeNull();
    });

    test('ACH tender captured but the tab attests the after-visit CARD text (rendered ACH) — 409, nothing recorded', async () => {
      verification('us_bank_account');
      conversion('ss-first');
      const res = await putAccept(TOKEN, AFTER_VISIT);
      expect(res.status).toBe(409);
      expect(res.data.code).toBe('CONSENT_VARIANT_STALE');
      expect(storedEstimate().status).toBe('sent');
    });

    test('ACH tender, tab attests the tender-specific base text: accepted, no after-visit variant stamped or recorded', async () => {
      verification('us_bank_account');
      conversion('ss-first');
      const res = await putAccept(TOKEN, { recurringCardSetupIntentId: 'seti_captured_1', recurringCardConsentTender: 'us_bank_account', recurringCardConsentVersion: BASE_VERSION, afterVisitTimingShown: true });
      expect(res.status).toBe(200);
      expect(acceptedData().acceptedRecurringCardConsentVariant).toBeUndefined();
      expect(enrollSpy.mock.calls[0][0].consentVariant).toBeNull();
      // r5 P1: the exact text + version shown is persisted for the webhook
      // recovery and handed to the inline enrollment verbatim.
      const ConsentText = require('../services/payment-method-consent-text');
      expect(asJson(acceptedData().acceptedRecurringCardConsent)).toEqual({
        variant: null, version: BASE_VERSION, tender: 'us_bank_account', text: ConsentText.getConsentText('us_bank_account'),
      });
      expect(enrollSpy.mock.calls[0][0].renderedConsent).toEqual({ text: ConsentText.getConsentText('us_bank_account'), version: BASE_VERSION });
    });

    test('r5 audit: a tab that showed "billed after your first visit" timing is refused when the first invoice goes out payable at accept (unattached)', async () => {
      conversion(null);
      const res = await putAccept(TOKEN, { recurringCardSetupIntentId: 'seti_captured_1', recurringCardConsentTender: 'card', recurringCardConsentVersion: BASE_VERSION, afterVisitTimingShown: true });
      expect(res.status).toBe(409);
      expect(res.data.code).toBe('PAYMENT_TIMING_REFRESH');
      expect(res.data.afterVisitDeferred).toBe(false);
      expect(storedEstimate().status).toBe('sent');
      expect(retireSpy).toHaveBeenCalledWith(expect.objectContaining({ setupIntentId: 'seti_captured_1' }));
    });

    test('r6 audit: the timing attestation is judged even after the cohort marker is gone (sub-gate turned off): a payable invoice is refused', async () => {
      resolverSpy.mockResolvedValue({ enforced: true, required: false, exemptReason: 'existing_plan_customer' });
      conversion('ss-first');
      const res = await putAccept(TOKEN, { afterVisitTimingShown: true });
      expect(res.status).toBe(409);
      expect(res.data.code).toBe('PAYMENT_TIMING_REFRESH');
      expect(storedEstimate().status).toBe('sent');
    });

    test('r5 audit: the same timing attestation is honored when the invoice really is deferred (attached)', async () => {
      conversion('ss-first');
      const res = await putAccept(TOKEN, { ...AFTER_VISIT, afterVisitTimingShown: true });
      expect(res.status).toBe(200);
    });

    test('r5: a bank capture whose tab attests an OLDER base ACH version is refused (the newer wording is never recorded)', async () => {
      verification('us_bank_account');
      conversion('ss-first');
      const res = await putAccept(TOKEN, { recurringCardSetupIntentId: 'seti_captured_1', recurringCardConsentTender: 'us_bank_account', recurringCardConsentVersion: 'v10_2026-01-01', afterVisitTimingShown: true });
      expect(res.status).toBe(409);
      expect(res.data.code).toBe('CONSENT_VARIANT_STALE');
      // The attached first invoice is still deferred: a version refresh is not a timing change.
      expect(res.data.collectionPromise).toEqual({ variant: null, tender: 'us_bank_account', version: BASE_VERSION, deferred: true });
      expect(storedEstimate().status).toBe('sent');
    });

    test('r5: an after-visit card accept persists the exact v12 text + version for recovery', async () => {
      conversion('ss-first');
      const res = await putAccept(TOKEN, AFTER_VISIT);
      expect(res.status).toBe(200);
      const ConsentText = require('../services/payment-method-consent-text');
      expect(asJson(acceptedData().acceptedRecurringCardConsent)).toEqual({
        variant: 'after_visit_card', version: ConsentText.AFTER_VISIT_CONSENT_VERSION, tender: 'card',
        text: ConsentText.getConsentText('card', { variant: 'after_visit_card' }),
      });
    });

    test('a tab that attests a tender different from the verified one is refused even with no variant', async () => {
      verification('us_bank_account');
      conversion('ss-first');
      const res = await putAccept(TOKEN, { recurringCardSetupIntentId: 'seti_captured_1', recurringCardConsentTender: 'card', afterVisitTimingShown: true });
      expect(res.status).toBe(409);
      expect(res.data.code).toBe('CONSENT_VARIANT_STALE');
    });

    test('a lone STALE recurringCardConsentVersion (no variant, no tender) is refused — it must not bypass the bundle-version fence (pre-push Codex on the merge)', async () => {
      conversion('ss-first');
      const res = await putAccept(TOKEN, { recurringCardSetupIntentId: 'seti_captured_1', recurringCardConsentVersion: 'v11_2026-08-25' });
      expect(res.status).toBe(409);
      expect(res.data.code).toBe('CONSENT_VARIANT_STALE');
      expect(storedEstimate().status).not.toBe('accepted');
    });

    test('a tender attested WITHOUT a version is an incomplete attestation and is refused', async () => {
      conversion('ss-first');
      const res = await putAccept(TOKEN, { recurringCardSetupIntentId: 'seti_captured_1', recurringCardConsentTender: 'card' });
      expect(res.status).toBe(409);
      expect(res.data.code).toBe('CONSENT_VARIANT_STALE');
    });

    test('an old tab with no tender attestation keeps working for a CARD capture (tender defaults to card)', async () => {
      conversion('ss-first');
      const { recurringCardConsentTender: _tender, ...legacy } = AFTER_VISIT;
      const res = await putAccept(TOKEN, legacy);
      expect(res.status).toBe(200);
    });

    test('r7: an after-visit accept that WILL defer its attached invoice but carries no timing attestation (a tab from before the gate) is refused for a refresh', async () => {
      conversion('ss-first');
      const { afterVisitTimingShown: _shown, ...unattested } = AFTER_VISIT;
      const res = await putAccept(TOKEN, unattested);
      expect(res.status).toBe(409);
      expect(res.data.code).toBe('PAYMENT_TIMING_REFRESH');
      expect(res.data.afterVisitDeferred).toBe(true);
      expect(storedEstimate().status).toBe('sent');
      expect(retireSpy).toHaveBeenCalledWith(expect.objectContaining({ setupIntentId: 'seti_captured_1' }));
    });
  });

  test('P1: the accept transaction lands on a different customer than the resolver judged — 409 ACCEPT_BILLING_CHANGED before conversion', async () => {
    seed();
    livePolicy({
      enforced: true, required: false, exemptReason: 'saved_method_consented', savedMethodRowId: 'pm-row-1', customerId: 'resolver-customer-not-the-trx-one', afterVisitCard: true,
    });
    const res = await putAccept(TOKEN, {});
    expect(res.status).toBe(409);
    expect(res.data.code).toBe('ACCEPT_BILLING_CHANGED');
    expect(storedEstimate().status).toBe('sent');
    expect(EstimateConverter.convertEstimate).not.toHaveBeenCalled();
  });
});

// ── Pay after the first visit — monthly-tier (setup-only) setup fee ─────────
// GATE_PAF_SETUP_FEE (pay-after-first-visit PR-C): on the card rail, the
// setup-only shape's WaveGuard setup fee is STAMPED on the first visit's
// series parent (scheduled_services.pending_setup_fee) instead of minted as a
// payable unattached invoice. The shape is forced at the route's own decision
// point (resolveFirstApplicationAmount → 0) rather than rebuilt through the
// tier-pricing ladder in this fake-knex harness; the tier derivation
// (selectedServiceTierBillsMonthly → firstApplicationInvoiceAmount null) is
// unchanged by this lane.
describe('PAF setup fee — setup-only accept stamps the series instead of minting an invoice', () => {
  const RecurringCards = require('../services/recurring-card-on-file');
  const NotificationService = require('../services/notification-service');
  const SAVED_RAIL_POLICY = { enforced: true, required: false, exemptReason: 'saved_method_consented', savedMethodRowId: 'pm-row-1' };
  const FRESH_CAPTURE_POLICY = { enforced: true, required: true, exemptReason: null };
  const savedEnv = {};
  let policySpy;
  let retireCapture;
  // The setup-fee promise rides only a FRESH capture (the one surface that
  // renders the after_visit_card authorization), so the default customer here
  // captures a card; a saved/enrolled-method customer keeps today's invoice.
  // A capture-required policy sends the captured SetupIntent with the accept.
  const accept = async (token, body = {}) => {
    const policy = await policySpy.getMockImplementation()?.();
    // A capture tab attests the consent text version it rendered (#5434's
    // bundle-level fence); a per-capture attestation in `body` supersedes it.
    return putAccept(token, policy?.required === true ? {
      recurringCardSetupIntentId: 'seti_paf_default',
      consentTextVersion: require('../services/payment-method-consent-text').CONSENT_VERSION,
      ...body,
    } : body);
  };
  // A tab showing the promise attests it, and its capture rendered the
  // after_visit_card authorization for a card (the accept's one collection
  // promise records exactly that, or refuses CONSENT_VARIANT_STALE).
  const acceptShown = async (token, body = {}) => {
    const policy = await policySpy.getMockImplementation()?.();
    return accept(token, {
      ...(policy?.required === true ? {
        recurringCardConsentVariant: 'after_visit_card',
        recurringCardConsentVersion: require('../services/payment-method-consent-text').AFTER_VISIT_CONSENT_VERSION,
        recurringCardConsentTender: 'card',
      } : {}),
      ...body,
      setupFeeAfterFirstVisitShown: true,
    });
  };

  function setupOnlyFixture(id, { withAnchor = true, parentId = null, price = 50, billingMode = 'per_application', visitsKnown = true } = {}) {
    resetStore(recurringPestEstimate({
      id,
      token: `tok-${id}-x0123456789`,
      // A solo MOSQUITO plan: the setup fee applies to it, and the engine's
      // mosquito ladder (monthly12 / seasonal9) is monthly-billed tier rows with
      // known visit counts — the REAL setup-only shape, no spy needed.
      monthly_total: 79,
      annual_total: 948,
      estimate_data: JSON.stringify({
        result: {
          recurring: {
            discount: 0,
            services: [{ name: 'Mosquito Control', service: 'mosquito', mo: 79, ann: 948, perTreatment: 79, ...(visitsKnown ? { visitsPerYear: 12 } : {}) }],
          },
          oneTime: { items: [], membershipFee: 99 },
          results: {
            // visitsKnown=false: a plan whose tier ladder cannot be resolved
            // to monthly tier rows with a visit count (no frequency rows at
            // all) — the preview keeps the BASE copy for it.
            mq: visitsKnown ? [
              { n: 'Monthly', key: 'monthly12', v: 12, mo: 79, ann: 948, pv: 79 },
              { n: 'Seasonal', key: 'seasonal9', v: 9, mo: 65, ann: 780, pv: 86.67 },
            ] : [],
          },
        },
      }),
    }));
    db.__state.tables.scheduled_services = withAnchor ? [
      ...(parentId ? [{ id: parentId, customer_id: 'customers-1', recurring_parent_id: null, pending_setup_fee: null }] : []),
      { id: `ss-${id}`, customer_id: 'customers-1', recurring_parent_id: parentId, pending_setup_fee: null, estimated_price: price },
    ] : [];
    // The real converter stamps the converted customer's billing lane
    // (per_application unless it preserves an existing membership); the fake
    // trx's customers table is where the accept's in-trx lane read looks.
    EstimateConverter.convertEstimate.mockImplementationOnce(async () => {
      for (const row of db.__state.tables.customers) row.billing_mode = billingMode;
      return {
        customerId: 'cust-1',
        tier: 'Bronze',
        monthlyRate: 60,
        firstScheduledServiceId: withAnchor ? `ss-${id}` : null,
        recurringConversionSkipped: false,
        welcomeSms: null,
        membershipEmail: null,
        deferredFollowUpReminderRows: [],
      };
    });
    return `tok-${id}-x0123456789`;
  }

  beforeEach(() => {
    for (const k of ['RECURRING_CARD_ON_FILE', 'GATE_PAY_AFTER_FIRST_VISIT', 'GATE_PAF_SETUP_FEE']) savedEnv[k] = process.env[k];
    process.env.RECURRING_CARD_ON_FILE = 'true';
    jest.spyOn(EstimateConverter, 'resolveFirstApplicationAmount').mockReturnValue(0);
    policySpy = jest.spyOn(RecurringCards, 'resolveRecurringCardPolicyForEstimate').mockResolvedValue({ ...FRESH_CAPTURE_POLICY });
    jest.spyOn(RecurringCards, 'verifyRecurringCardIntent').mockResolvedValue({
      ok: true, setupIntentId: 'seti_paf_default', paymentMethodId: 'pm_paf_default', methodType: 'card',
    });
    jest.spyOn(RecurringCards, 'bankTenderAllowedUnderLock').mockResolvedValue(true);
    jest.spyOn(RecurringCards, 'verifyRecurringCardIntentUnderLock').mockResolvedValue(true);
    jest.spyOn(RecurringCards, 'completeRecurringCardEnrollment').mockResolvedValue({ enrolled: true });
    retireCapture = jest.spyOn(RecurringCards, 'retireOrphanedCaptureIntent').mockResolvedValue({ ok: true, retired: true });
  });
  afterEach(() => {
    for (const [k, v] of Object.entries(savedEnv)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    jest.restoreAllMocks();
  });

  function gateOn() {
    process.env.GATE_PAY_AFTER_FIRST_VISIT = 'true';
    process.env.GATE_PAF_SETUP_FEE = 'true';
  }

  test('gate OFF: exactly today — the unattached payable setup invoice is minted and its pay link delivered', async () => {
    const token = setupOnlyFixture('paf-off');
    const response = await accept(token);

    expect(response.status).toBe(200);
    expect(InvoiceService.create).toHaveBeenCalledTimes(1);
    expect(InvoiceService.create.mock.calls[0][0].scheduledServiceId).toBeUndefined();
    expect(response.data.invoiceMode).toBe(true);
    expect(response.data.nextStep).toBe('pay_invoice');
    expect(response.data.setupFeeAfterFirstVisit).toBeUndefined();
    const stamp = db.__state.ops.find((op) => op.type === 'update' && op.table === 'scheduled_services' && op.data && 'pending_setup_fee' in op.data);
    expect(stamp).toBeUndefined();
  });

  test('master gate on but the setup-fee sub-gate off: still today\'s payable invoice', async () => {
    process.env.GATE_PAY_AFTER_FIRST_VISIT = 'true';
    delete process.env.GATE_PAF_SETUP_FEE;
    const token = setupOnlyFixture('paf-subgate-off');
    const response = await accept(token);

    expect(response.status).toBe(200);
    expect(InvoiceService.create).toHaveBeenCalledTimes(1);
    expect(response.data.nextStep).toBe('pay_invoice');
  });

  test('gate ON: no invoice minted, nothing delivered, the fee is stamped on the series parent, the customer is told it bills with the first visit', async () => {
    gateOn();
    const token = setupOnlyFixture('paf-on');
    const response = await acceptShown(token);

    expect(response.status).toBe(200);
    expect(InvoiceService.create).not.toHaveBeenCalled();
    expect(InvoiceService.sendViaSMSAndEmail).not.toHaveBeenCalled();
    expect(response.data.invoiceMode).toBe(false);
    expect(response.data.invoiceId).toBeNull();
    expect(response.data.invoicePayUrl).toBeFalsy();
    expect(response.data.nextStep).toBe('confirmed');
    expect(response.data.setupFeeAfterFirstVisit).toBe(true);
    // The durable claim the first PERFORMED completion consumes.
    expect(db.__state.tables.scheduled_services[0].pending_setup_fee).toBe(99);
    // Persisted so an already-accepted retry describes the same accept.
    const stored = JSON.parse(storedEstimate().estimate_data);
    expect(stored.recurringCardLaneAccepted).toBe(true);
    expect(stored.setupFeeDeferredToFirstVisit).toBe(true);
    const customerNote = NotificationService.notifyCustomer.mock.calls.map((c) => c[3]).join(' ');
    expect(customerNote).toMatch(/Nothing is charged today/);
    expect(customerNote).toMatch(/setup fee is billed with your first visit/);
    expect(customerNote).not.toMatch(/pay link/i);
  });

  test('gate ON: the stamp lands on the SERIES PARENT when the first visit is a follow-up child', async () => {
    gateOn();
    const token = setupOnlyFixture('paf-child', { parentId: 'ss-parent-1' });
    const response = await acceptShown(token);

    expect(response.status).toBe(200);
    const rows = db.__state.tables.scheduled_services;
    expect(rows.find((r) => r.id === 'ss-parent-1').pending_setup_fee).toBe(99);
    expect(rows.find((r) => r.id === 'ss-paf-child').pending_setup_fee).toBeNull();
    expect(InvoiceService.create).not.toHaveBeenCalled();
  });

  test('gate ON: a capture-required accept records the after_visit_card consent variant', async () => {
    gateOn();
    policySpy.mockResolvedValue({ ...FRESH_CAPTURE_POLICY });
    jest.spyOn(RecurringCards, 'verifyRecurringCardIntent').mockResolvedValue({
      ok: true, setupIntentId: 'seti_paf_1', paymentMethodId: 'pm_paf_1', methodType: 'card',
    });
    jest.spyOn(RecurringCards, 'bankTenderAllowedUnderLock').mockResolvedValue(true);
    jest.spyOn(RecurringCards, 'verifyRecurringCardIntentUnderLock').mockResolvedValue(true);
    const enroll = jest.spyOn(RecurringCards, 'completeRecurringCardEnrollment').mockResolvedValue({ enrolled: true });
    const token = setupOnlyFixture('paf-consent');
    const response = await acceptShown(token, { recurringCardSetupIntentId: 'seti_paf_1' });

    expect(response.status).toBe(200);
    expect(enroll).toHaveBeenCalledTimes(1);
    expect(enroll.mock.calls[0][0].consentVariant).toBe('after_visit_card');
    expect(InvoiceService.create).not.toHaveBeenCalled();
  });

  // Reviewer P2-A (supersedes Codex pre-push r2 P1's "record after_visit_card
  // even on fallback"): the capture UI showed the after-first-visit promise, so
  // when the stamp cannot land the accept is REFUSED retryably (409, the whole
  // accept — conversion, invoice, consent — rolls back). It never falls back to
  // a payable setup invoice with the after-visit consent on record.
  test('gate ON, capture-required, stamp CANNOT land (no first visit / occupied claim): the accept fails 409 (refresh) — no payable invoice, no after_visit_card consent, nothing committed', async () => {
    gateOn();
    policySpy.mockResolvedValue({ ...FRESH_CAPTURE_POLICY });
    jest.spyOn(RecurringCards, 'verifyRecurringCardIntent').mockResolvedValue({
      ok: true, setupIntentId: 'seti_paf_fb', paymentMethodId: 'pm_paf_fb', methodType: 'card',
    });
    jest.spyOn(RecurringCards, 'bankTenderAllowedUnderLock').mockResolvedValue(true);
    jest.spyOn(RecurringCards, 'verifyRecurringCardIntentUnderLock').mockResolvedValue(true);
    const enroll = jest.spyOn(RecurringCards, 'completeRecurringCardEnrollment').mockResolvedValue({ enrolled: true });

    const noAnchor = setupOnlyFixture('paf-consent-noanchor', { withAnchor: false });
    const first = await acceptShown(noAnchor, { recurringCardSetupIntentId: 'seti_paf_fb' });
    expect(first.status).toBe(409);
    expect(first.data.code).toBe('SETUP_FEE_TERMS_REFRESH');
    expect(first.data.error).toMatch(/reload the page/i);
    expect(InvoiceService.create).not.toHaveBeenCalled();
    expect(enroll).not.toHaveBeenCalled();
    expect(storedEstimate().status).not.toBe('accepted');

    const occupied = setupOnlyFixture('paf-consent-occupied');
    db.__state.tables.scheduled_services[0].pending_setup_fee = 49;
    const second = await acceptShown(occupied, { recurringCardSetupIntentId: 'seti_paf_fb' });
    expect(second.status).toBe(409);
    expect(second.data.code).toBe('SETUP_FEE_TERMS_REFRESH');
    expect(InvoiceService.create).not.toHaveBeenCalled();
    expect(enroll).not.toHaveBeenCalled();
    expect(db.__state.tables.scheduled_services[0].pending_setup_fee).toBe(49);
  });

  // Reviewer P3: the accept attempts the stamp only where the preview applied
  // the same eligibility — a tier whose visit count is unknown shows the BASE
  // text, so it keeps today's payable invoice and records the BASE consent.
  test('gate ON, a monthly tier with an UNKNOWN visit count: never attempted — the payable invoice is minted, nothing stamped, BASE consent recorded', async () => {
    gateOn();
    policySpy.mockResolvedValue({ ...FRESH_CAPTURE_POLICY });
    jest.spyOn(RecurringCards, 'verifyRecurringCardIntent').mockResolvedValue({
      ok: true, setupIntentId: 'seti_paf_uk', paymentMethodId: 'pm_paf_uk', methodType: 'card',
    });
    jest.spyOn(RecurringCards, 'bankTenderAllowedUnderLock').mockResolvedValue(true);
    jest.spyOn(RecurringCards, 'verifyRecurringCardIntentUnderLock').mockResolvedValue(true);
    const enroll = jest.spyOn(RecurringCards, 'completeRecurringCardEnrollment').mockResolvedValue({ enrolled: true });
    const token = setupOnlyFixture('paf-unknown-visits', { visitsKnown: false, price: null });
    const response = await accept(token, { recurringCardSetupIntentId: 'seti_paf_uk' });
    expect(response.status).toBe(200);
    expect(InvoiceService.create).toHaveBeenCalledTimes(1);
    expect(response.data.setupFeeAfterFirstVisit).toBeUndefined();
    expect(db.__state.tables.scheduled_services[0].pending_setup_fee).toBeNull();
    expect(enroll.mock.calls[0][0].consentVariant).toBeNull();
  });

  // Reviewer P2-B: a monthly-membership / prepay lane covers its first visit
  // with dues, the completion mint never runs the claim there, so the stamp
  // would strand. The lane is read INSIDE the trx after the converter set it.
  test.each(['monthly_membership', 'annual_prepay', null])('gate ON, converted customer billing lane %s (not per_application): never stamped — today\'s payable invoice, BASE consent', async (lane) => {
    gateOn();
    policySpy.mockResolvedValue({ ...FRESH_CAPTURE_POLICY });
    jest.spyOn(RecurringCards, 'verifyRecurringCardIntent').mockResolvedValue({
      ok: true, setupIntentId: 'seti_paf_ln', paymentMethodId: 'pm_paf_ln', methodType: 'card',
    });
    jest.spyOn(RecurringCards, 'bankTenderAllowedUnderLock').mockResolvedValue(true);
    jest.spyOn(RecurringCards, 'verifyRecurringCardIntentUnderLock').mockResolvedValue(true);
    const enroll = jest.spyOn(RecurringCards, 'completeRecurringCardEnrollment').mockResolvedValue({ enrolled: true });
    const token = setupOnlyFixture(`paf-lane-${lane}`, { billingMode: lane });
    const response = await accept(token, { recurringCardSetupIntentId: 'seti_paf_ln' });
    expect(response.status).toBe(200);
    expect(InvoiceService.create).toHaveBeenCalledTimes(1);
    expect(response.data.setupFeeAfterFirstVisit).toBeUndefined();
    expect(db.__state.tables.scheduled_services[0].pending_setup_fee).toBeNull();
    expect(enroll.mock.calls[0][0].consentVariant).toBeNull();
  });

  test('gate ON but not on the setup-only shape (first-application line present): base consent, no after_visit_card', async () => {
    gateOn();
    policySpy.mockResolvedValue({ ...FRESH_CAPTURE_POLICY });
    EstimateConverter.resolveFirstApplicationAmount.mockReturnValue(40);
    jest.spyOn(RecurringCards, 'verifyRecurringCardIntent').mockResolvedValue({
      ok: true, setupIntentId: 'seti_paf_fa', paymentMethodId: 'pm_paf_fa', methodType: 'card',
    });
    jest.spyOn(RecurringCards, 'bankTenderAllowedUnderLock').mockResolvedValue(true);
    jest.spyOn(RecurringCards, 'verifyRecurringCardIntentUnderLock').mockResolvedValue(true);
    const enroll = jest.spyOn(RecurringCards, 'completeRecurringCardEnrollment').mockResolvedValue({ enrolled: true });
    const token = setupOnlyFixture('paf-consent-firstapp');
    const response = await accept(token, { recurringCardSetupIntentId: 'seti_paf_fa' });
    expect(response.status).toBe(200);
    expect(enroll.mock.calls[0][0].consentVariant).toBeNull();
  });

  test('gate ON but no first visit exists to carry the stamp: the accept is refused retryably — a fee is never dropped and no payable invoice contradicts the page', async () => {
    gateOn();
    const token = setupOnlyFixture('paf-noanchor', { withAnchor: false });
    const response = await acceptShown(token);

    expect(response.status).toBe(409);
    expect(response.data.code).toBe('SETUP_FEE_TERMS_REFRESH');
    expect(InvoiceService.create).not.toHaveBeenCalled();
  });

  // Codex pre-push r3 P1: a monthly-tier quote with an unknown visit count
  // converts to an UNPRICED visit; the completion mint gate refuses it, so a
  // stamp there would queue the fee indefinitely. The preview already keeps
  // the BASE text for such a tier (monthlyTierVisitCountsResolvable), so the
  // accept never attempts the stamp: today's payable invoice, nothing stamped.
  test('gate ON, tier visit count unknown (the converter leaves the visit unpriced): never deferred — the payable invoice is minted and nothing is stamped', async () => {
    gateOn();
    for (const price of [null, 0]) {
      InvoiceService.create.mockClear();
      const token = setupOnlyFixture(`paf-unpriced-${price}`, { price, visitsKnown: false });
      const response = await accept(token);

      expect(response.status).toBe(200);
      expect(InvoiceService.create).toHaveBeenCalledTimes(1);
      expect(response.data.nextStep).toBe('pay_invoice');
      expect(response.data.setupFeeAfterFirstVisit).toBeUndefined();
      expect(db.__state.tables.scheduled_services[0].pending_setup_fee).toBeNull();
    }
  });

  // Defense in depth: the preview said "billed with your first visit" (visit
  // counts known) yet the converted first visit carries no billable price — a
  // stamp there would never be consumed, a payable invoice would contradict
  // the page: refuse retryably.
  test('gate ON, counts known but the first visit has no billable price (unpriced / $0): the accept is refused 409, nothing stamped, nothing minted', async () => {
    gateOn();
    for (const price of [null, 0]) {
      InvoiceService.create.mockClear();
      const token = setupOnlyFixture(`paf-unpriced-known-${price}`, { price });
      const response = await acceptShown(token);

      expect(response.status).toBe(409);
      expect(response.data.code).toBe('SETUP_FEE_TERMS_REFRESH');
      expect(InvoiceService.create).not.toHaveBeenCalled();
      expect(db.__state.tables.scheduled_services[0].pending_setup_fee).toBeNull();
    }
  });

  // The visit price on a converted tier row comes from the converter's own
  // derivation (billing-cadence perApplicationChargeAmount, the figure it
  // stamps as estimated_price). Feed the REAL derivation through the accept:
  // a monthly-tier plan whose visit count is unknown resolves no price (the
  // converter leaves the row unpriced and completion parks it) and the page
  // shows the base text → never deferred; a known count resolves one → deferred.
  test('real converter derivation: unknown-visit-count monthly tier resolves no price and is never deferred; a known count is deferred at that price', async () => {
    gateOn();
    const BillingCadence = require('../services/billing-cadence');
    const cadence = { frequencyKey: 'monthly', amount: 96 };
    const derive = (visitsPerYear) => BillingCadence.perApplicationChargeAmount({
      billingCadence: cadence, annualRate: 1152, monthlyRate: 96, visitsPerYear, serviceKey: 'mosquito',
    });
    expect(derive(null)).toBeNull();
    expect(derive(9)).toBe(128);

    const unresolved = setupOnlyFixture('paf-real-unknown', { price: derive(null), visitsKnown: false });
    const first = await accept(unresolved);
    expect(first.status).toBe(200);
    expect(first.data.nextStep).toBe('pay_invoice');
    expect(db.__state.tables.scheduled_services[0].pending_setup_fee).toBeNull();

    InvoiceService.create.mockClear();
    const resolved = setupOnlyFixture('paf-real-known', { price: derive(9) });
    const second = await acceptShown(resolved);
    expect(second.status).toBe(200);
    expect(second.data.setupFeeAfterFirstVisit).toBe(true);
    expect(InvoiceService.create).not.toHaveBeenCalled();
    expect(db.__state.tables.scheduled_services[0].pending_setup_fee).toBe(99);
  });

  test('gate ON but the series already carries a DIFFERENT setup claim: never overwritten — the accept is refused 409 (no payable invoice contradicting the page)', async () => {
    gateOn();
    const token = setupOnlyFixture('paf-occupied');
    db.__state.tables.scheduled_services[0].pending_setup_fee = 49;
    const response = await acceptShown(token);

    expect(response.status).toBe(409);
    // The real answer rides the refusal (Codex P1): the retry keeps the payable
    // setup invoice instead of re-attesting a promise that can never land.
    expect(response.data).toMatchObject({ code: 'SETUP_FEE_TERMS_REFRESH', setupFeePromise: false });
    expect(db.__state.tables.scheduled_services[0].pending_setup_fee).toBe(49);
    expect(InvoiceService.create).not.toHaveBeenCalled();
  });

  // Codex PR r(d22e49b0c3) P1: a customer satisfied by a saved / enrolled
  // method sees no capture, so never the after-visit authorization — the fee
  // is not deferred onto that method (today's payable invoice, base consent).
  test.each(['saved_method_consented', 'autopay_already_active'])('gate ON, %s (no capture shown): today\'s payable setup invoice; an attested promise is refused with the real answer', async (exemptReason) => {
    gateOn();
    policySpy.mockResolvedValue({ ...SAVED_RAIL_POLICY, exemptReason });
    const attested = await acceptShown(setupOnlyFixture(`paf-saved-attested-${exemptReason}`));
    expect(attested.status).toBe(409);
    expect(attested.data.code).toBe('SETUP_FEE_TERMS_REFRESH');
    expect(attested.data.setupFeePromise).toBe(false);

    InvoiceService.create.mockClear();
    const response = await accept(setupOnlyFixture(`paf-saved-${exemptReason}`));
    expect(response.status).toBe(200);
    expect(InvoiceService.create).toHaveBeenCalledTimes(1);
    expect(response.data.nextStep).toBe('pay_invoice');
    expect(response.data.setupFeeAfterFirstVisit).toBeUndefined();
    expect(db.__state.tables.scheduled_services[0].pending_setup_fee).toBeNull();
    expect(JSON.parse(storedEstimate().estimate_data).acceptedRecurringCardConsentVariant).not.toBe('after_visit_card');
  });

  test('gate ON but not on the card rail (exempt customer): today\'s payable invoice', async () => {
    gateOn();
    policySpy.mockResolvedValue({ enforced: true, required: false, exemptReason: 'existing_plan_customer' });
    const token = setupOnlyFixture('paf-exempt');
    const response = await accept(token);

    expect(response.status).toBe(200);
    expect(InvoiceService.create).toHaveBeenCalledTimes(1);
    expect(response.data.nextStep).toBe('pay_invoice');
    expect(db.__state.tables.scheduled_services[0].pending_setup_fee).toBeNull();
  });

  // Codex round 2 P0: the page promised first-visit billing to a customer the
  // accept then converts onto a non-per_application lane (a current monthly
  // member the preview could not see). The tab's attestation and the accept's
  // recomputation differ, so the accept is REFUSED for a refresh — never a
  // payable setup invoice after the promise.
  test.each(['monthly_membership', 'annual_prepay'])('gate ON, the tab attested the first-visit promise but the converted lane is %s: the accept is refused 409 SETUP_FEE_TERMS_REFRESH, nothing committed', async (lane) => {
    gateOn();
    const token = setupOnlyFixture(`paf-attested-lane-${lane}`, { billingMode: lane });
    const response = await acceptShown(token);
    expect(response.status).toBe(409);
    expect(response.data.code).toBe('SETUP_FEE_TERMS_REFRESH');
    // The answer the accept would apply rides the 409 so the tab stops promising it.
    expect(response.data.setupFeePromise).toBe(false);
    expect(InvoiceService.create).not.toHaveBeenCalled();
    expect(db.__state.tables.scheduled_services[0].pending_setup_fee).toBeNull();
    expect(storedEstimate().status).not.toBe('accepted');
  });

  test('gate ON, the transaction resolves a PAYER-billed customer: the fee is never deferred onto a card (409 with the real answer, nothing stamped)', async () => {
    gateOn();
    const token = setupOnlyFixture('paf-payer-billed');
    const Payer = require('../services/payer');
    Payer.resolveForInvoice.mockResolvedValueOnce({ payerId: 'payer-1' });
    const response = await acceptShown(token);
    expect(response.status).toBe(409);
    expect(response.data.code).toBe('SETUP_FEE_TERMS_REFRESH');
    expect(response.data.setupFeePromise).toBe(false);
    // The ONLY payer lookup is the in-transaction one (the policy saw self-pay).
    expect(Payer.resolveForInvoice).toHaveBeenCalledTimes(1);
    expect(Payer.resolveForInvoice.mock.calls[0][0]).toMatchObject({ throwOnError: true });
    expect(db.__state.tables.scheduled_services[0].pending_setup_fee).toBeNull();
    expect(storedEstimate().status).not.toBe('accepted');
  });

  test('gate ON, payer-billed: the retry WITHOUT the attestation accepts with the payable setup invoice, no stamp and base consent', async () => {
    gateOn();
    const token = setupOnlyFixture('paf-payer-retry');
    const Payer = require('../services/payer');
    Payer.resolveForInvoice.mockResolvedValue({ payerId: 'payer-1' });
    try {
      const response = await accept(token);
      expect(response.status).toBe(200);
      expect(db.__state.tables.scheduled_services[0].pending_setup_fee).toBeNull();
      expect(InvoiceService.create).toHaveBeenCalled();
      expect(response.data.setupFeeAfterFirstVisit).toBeUndefined();
    } finally {
      Payer.resolveForInvoice.mockResolvedValue(null);
    }
  });

  // Pre-push audit P1: the client drops its captured intent on every
  // SETUP_FEE_TERMS_REFRESH, so the accept retires it after the rollback.
  test('gate ON, a SETUP_FEE_TERMS_REFRESH refusal retires the captured SetupIntent the tab will drop', async () => {
    gateOn();
    const token = setupOnlyFixture('paf-refresh-retire', { billingMode: 'monthly_membership' });
    const response = await acceptShown(token);
    expect(response.status).toBe(409);
    expect(response.data.code).toBe('SETUP_FEE_TERMS_REFRESH');
    expect(retireCapture).toHaveBeenCalledTimes(1);
  });

  test('gate ON, the accept WOULD defer but the tab did not attest the promise (stale tab / older client): refused 409 for a refresh, nothing stamped or minted', async () => {
    gateOn();
    const token = setupOnlyFixture('paf-unattested');
    const response = await accept(token);
    expect(response.status).toBe(409);
    expect(response.data.code).toBe('SETUP_FEE_TERMS_REFRESH');
    expect(response.data.setupFeePromise).toBe(true);
    expect(InvoiceService.create).not.toHaveBeenCalled();
    expect(db.__state.tables.scheduled_services[0].pending_setup_fee).toBeNull();
  });

  test('gate ON, an accept that records the after-visit consent persists acceptedRecurringCardConsentVariant for the setup_intent recovery', async () => {
    gateOn();
    const token = setupOnlyFixture('paf-variant-persist');
    const response = await acceptShown(token);
    expect(response.status).toBe(200);
    const stored = JSON.parse(storedEstimate().estimate_data);
    expect(stored.acceptedRecurringCardConsentVariant).toBe('after_visit_card');
    // The one collection promise records the after-visit TEXT too (the
    // setup_intent recovery records it verbatim).
    const recorded = typeof stored.acceptedRecurringCardConsent === 'string'
      ? JSON.parse(stored.acceptedRecurringCardConsent) : stored.acceptedRecurringCardConsent;
    expect(recorded).toMatchObject({ variant: 'after_visit_card', tender: 'card' });
    expect(recorded.text).toBe(require('../services/payment-method-consent-text').getConsentText('card', { variant: 'after_visit_card' }));
  });

  test('gate ON, a capture tab that showed the setup-fee promise but attests the BASE consent (older bundle): refused CONSENT_VARIANT_STALE, nothing committed', async () => {
    gateOn();
    const token = setupOnlyFixture('paf-variant-unattested');
    const retire = jest.spyOn(RecurringCards, 'retireOrphanedCaptureIntent').mockResolvedValue({ ok: true, retired: true });
    const response = await accept(token, { setupFeeAfterFirstVisitShown: true });
    expect(retire).toHaveBeenCalled();
    expect(response.status).toBe(409);
    expect(response.data.code).toBe('CONSENT_VARIANT_STALE');
    expect(response.data.collectionPromise).toMatchObject({ variant: 'after_visit_card', deferred: true });
    expect(db.__state.tables.scheduled_services[0].pending_setup_fee).toBeNull();
    expect(storedEstimate().status).not.toBe('accepted');
  });

  test('retry of the deferred accept says the same thing and never produces a pay link', async () => {
    gateOn();
    const token = setupOnlyFixture('paf-retry');
    const first = await acceptShown(token);
    expect(first.status).toBe(200);
    const retry = await accept(token);

    expect(retry.status).toBe(200);
    expect(retry.data.alreadyAccepted).toBe(true);
    expect(retry.data.setupFeeAfterFirstVisit).toBe(true);
    expect(retry.data.invoicePayUrl).toBeFalsy();
    expect(retry.data.nextStep).toBe('confirmed');
    expect(InvoiceService.create).not.toHaveBeenCalled();
  });

  // Codex P1 on #5485: a MULTI-PROGRAM accept never defers the fee — the claim
  // would live on one program's series and could not follow whichever program
  // is performed first. A tab that promised it is refused with the real answer
  // (setupFeePromise: false, nothing stamped); the retry takes today's payable
  // setup invoice (no stamp anywhere).
  test('R9 (route): a multi-program accept never defers the setup fee — the promise is refused with the real answer, and the retry keeps the payable setup invoice', async () => {
    gateOn();
    const multiConverter = () => {
      EstimateConverter.convertEstimate.mockReset();
      EstimateConverter.convertEstimate.mockImplementation(async () => {
        for (const row of db.__state.tables.customers) row.billing_mode = 'per_application';
        return {
          customerId: 'cust-1',
          tier: 'Bronze',
          monthlyRate: 60,
          firstScheduledServiceId: 'ss-paf-multi',
          combinedInvoiceMemberIds: ['ss-member-2'],
          recurringConversionSkipped: false,
          welcomeSms: null,
          membershipEmail: null,
          deferredFollowUpReminderRows: [],
        };
      });
    };
    const token = setupOnlyFixture('paf-multi');
    db.__state.tables.scheduled_services.push({ id: 'ss-member-2', customer_id: 'customers-1', recurring_parent_id: null, pending_setup_fee: null, estimated_price: 40 });
    multiConverter();
    const promised = await acceptShown(token);
    expect(promised.status).toBe(409);
    expect(promised.data).toMatchObject({ code: 'SETUP_FEE_TERMS_REFRESH', setupFeePromise: false });
    const rows = db.__state.tables.scheduled_services;
    expect(rows.find((r) => r.id === 'ss-paf-multi').pending_setup_fee).toBeNull();
    expect(rows.find((r) => r.id === 'ss-member-2').pending_setup_fee).toBeNull();

    const retried = await accept(token);
    expect(retried.status).toBe(200);
    expect(retried.data.setupFeeAfterFirstVisit).toBeUndefined();
    expect(rows.find((r) => r.id === 'ss-paf-multi').pending_setup_fee).toBeNull();
    expect(rows.find((r) => r.id === 'ss-member-2').pending_setup_fee).toBeNull();
  });

  // R9 (plan §7): a multi-program first visit shares a combined invoice. The
  // stamp rides the anchor's series PARENT; the combined-invoice stamper only
  // writes first_application_invoice_id, so it never reads, clears or
  // overwrites the claim. (The stamper itself is the real implementation here.)
  test('R9: stampCombinedFirstApplicationInvoiceCoverage on an anchor carrying the claim leaves pending_setup_fee untouched', async () => {
    const actual = jest.requireActual('../services/estimate-converter');
    const rows = [
      { id: 'anchor-1', customer_id: 'c1', source_estimate_id: 'e1', is_recurring: true, recurring_parent_id: null, estimated_price: 40, pending_setup_fee: 99, first_application_invoice_id: null },
      { id: 'member-2', customer_id: 'c1', source_estimate_id: 'e1', is_recurring: true, recurring_parent_id: null, estimated_price: null, pending_setup_fee: null, first_application_invoice_id: null },
    ];
    const updates = [];
    const trx = (table) => {
      const q = { table, ids: null };
      const chain = {
        where: () => chain,
        whereNull: () => chain,
        whereIn: (col, ids) => { q.ids = ids; return chain; },
        first: async () => (q.table === 'scheduled_services' ? { customer_id: 'c1', source_estimate_id: 'e1' } : undefined),
        select: async () => (q.ids ? rows.filter((r) => q.ids.includes(r.id) && r.estimated_price == null).map((r) => ({ id: r.id })) : []),
        update: async (patch) => { updates.push({ ids: q.ids, patch }); return (q.ids || []).length; },
      };
      return chain;
    };
    await actual.stampCombinedFirstApplicationInvoiceCoverage(trx, { invoiceId: 'inv-9', anchorId: 'anchor-1', memberIds: ['member-2'] });

    expect(updates).toHaveLength(1);
    expect(updates[0].ids).toEqual(['anchor-1', 'member-2']);
    expect(updates[0].patch).toEqual({ first_application_invoice_id: 'inv-9' });
    expect(rows[0].pending_setup_fee).toBe(99);
  });
});
