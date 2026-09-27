// termite-annual-renewal-charge.js — slice 6b, the automatic termite annual
// renewal charge (dark behind GATE_TERMITE_ANNUAL_PLAN). This suite mocks
// every sibling service the module calls into (InvoiceService,
// AnnualPrepayRenewals, the annual-prepay overlap lock, RecurringCards,
// StripeService, notification-service, cancellation-processor's
// station-retrieval task, and the customer messaging pipeline) — those
// modules' own behavior is covered by their own suites. This suite proves
// ONLY this module's own responsibilities: the exact-amount/date math on
// mint, the lock order + renewed_from_term_id idempotency re-check, the
// no-witness / unanchored / stale-overdue exception bells, the renewal
// window bound, the at-most-once Stripe-attempt fence (with its pre-quote
// surcharge check and post-charge classification), the
// no-consent/no-method/surcharge/decline/refused/ambiguous branches and
// their bells + SMS gating, the grace-lapse void + retrieval task + parent
// cancel stamp, the stuck-successor reconcile passes, and the gate.
describe('termite annual renewal charge', () => {
  afterEach(() => {
    jest.resetModules();
    jest.clearAllMocks();
    delete process.env.GATE_TERMITE_ANNUAL_PLAN;
  });

  function mockCommon() {
    jest.doMock('../models/db', () => {
      const dbFn = jest.fn();
      dbFn.schema = { hasTable: jest.fn().mockResolvedValue(true) };
      return dbFn;
    });
    jest.doMock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
    // Codex round-4 P1: pin "today" for this whole suite. Several
    // resolveChargeEligibility grace-deadline comparisons read the REAL
    // wall clock (etDateString() with no argument) against a deadline
    // derived from this file's fixed fixture dates (baseSuccessor's
    // term_start 2026-09-27 + GRACE_DAYS = deadline 2026-10-27). Left
    // unpinned, every test exercising that "still within grace" path
    // passes today and starts failing the moment the real calendar
    // crosses the fixture's deadline (2026-10-28) — AGENTS.md's
    // near-today-date-literal rule. Only the no-arg "what is today" call
    // is pinned to a fixed literal (matching the SAME date baseSuccessor/
    // baseParent already use, so it's inside grace by construction and
    // never expires); an explicit-arg call (addDaysYmd's own
    // etDateString(addETDays(...))) still runs for real, unaffected.
    jest.doMock('../utils/datetime-et', () => {
      const actual = jest.requireActual('../utils/datetime-et');
      return { ...actual, etDateString: (d) => (d === undefined ? '2026-09-27' : actual.etDateString(d)) };
    });
  }

  function mockGraceHelpers({ graceDays = 30, reconcileParentRenewedStampsImpl } = {}) {
    // P1-2/P2-4: the grace window and its date formula are owned by
    // annual-prepay-renewals.js — mocked here so this suite never depends
    // on that module's own (separately-tested) internals.
    jest.doMock('../services/annual-prepay-renewals', () => {
      const actual = {
        createTermForAnnualPrepay: jest.fn(),
        recordDecision: jest.fn().mockResolvedValue({ id: 'parent-1' }),
        TERMITE_RENEWAL_GRACE_DAYS: graceDays,
        termiteRenewalGraceDeadlineFor: jest.fn((term) => {
          const termStart = String(term?.term_start || '').slice(0, 10);
          const created = term?.created_at ? new Date(term.created_at).toISOString().slice(0, 10) : termStart;
          const later = created > termStart ? created : termStart;
          const d = new Date(`${later}T12:00:00Z`);
          d.setUTCDate(d.getUTCDate() + graceDays);
          return d.toISOString().slice(0, 10);
        }),
        // Codex round-7 P1 (2nd audit round): processGraceLapses now pushes
        // the deadline test into the query itself (WHERE + ORDER BY) via
        // this SQL twin — a plain string stand-in here (never executed
        // against a real DB in this mocked suite, so its exact contents
        // don't matter, only that it's callable).
        termiteRenewalGraceDeadlineSql: jest.fn((alias = 't') => `${alias}.term_start`),
        // Codex round-2 P1 backstop pass — a no-op stub by default so the
        // sweep's own try/catch never masks a real assertion below.
        reconcileParentRenewedStamps: jest.fn(reconcileParentRenewedStampsImpl || (async () => ({ scanned: 0, stamped: 0 }))),
        // Codex round-7 P1: a transparent pass-through — the REAL advisory
        // lock is annual-prepay-renewals.js's own concern (tested there);
        // this suite only needs the callback to actually run.
        withParentDecisionLock: jest.fn((termId, fn) => fn()),
      };
      return actual;
    });
  }

  // ---- date helpers -------------------------------------------------------

  describe('addDaysYmd', () => {
    test('month-end rollover in a non-leap year', () => {
      mockCommon();
      const { _private } = require('../services/termite-annual-renewal-charge');
      expect(_private.addDaysYmd('2027-02-28', 1)).toBe('2027-03-01');
    });

    test('leap-year Feb 29 exists and rolls over correctly', () => {
      mockCommon();
      const { _private } = require('../services/termite-annual-renewal-charge');
      expect(_private.addDaysYmd('2028-02-28', 1)).toBe('2028-02-29');
      expect(_private.addDaysYmd('2028-02-29', 1)).toBe('2028-03-01');
    });

    test('negative days for the renewal-window cutoff', () => {
      mockCommon();
      const { _private } = require('../services/termite-annual-renewal-charge');
      expect(_private.addDaysYmd('2026-10-31', -30)).toBe('2026-10-01');
    });
  });

  // ---- candidate query composition ---------------------------------------

  describe('whereDueForRenewal / whereNoticeWitnessed / whereAnchoredOrSuccessor / whereWithinRenewalWindow', () => {
    function recordingQuery() {
      const calls = [];
      const q = {};
      const methods = ['whereNotNull', 'whereIn', 'whereNull', 'where', 'whereNotExists', 'whereExists', 'orWhereNotNull'];
      for (const m of methods) {
        q[m] = jest.fn((...args) => { calls.push([m, args]); return q; });
      }
      return { q, calls };
    }

    test('requires annual_plan_version, a renewable status, no decision, term_end <= today, and no existing successor', () => {
      mockCommon();
      const { _private } = require('../services/termite-annual-renewal-charge');
      const { q, calls } = recordingQuery();
      _private.whereDueForRenewal(q, '2026-09-26');
      expect(calls.some(([m, args]) => m === 'whereNotNull' && args[0] === 't.annual_plan_version')).toBe(true);
      expect(calls.some(([m, args]) => m === 'whereIn' && args[0] === 't.status' && args[1].includes('active') && args[1].includes('renewal_pending'))).toBe(true);
      expect(calls.some(([m, args]) => m === 'whereNull' && args[0] === 't.renewal_decision')).toBe(true);
      expect(calls.some(([m, args]) => m === 'where' && args[0] === 't.term_end' && args[1] === '<=' && args[2] === '2026-09-26')).toBe(true);
      expect(calls.some(([m]) => m === 'whereNotExists')).toBe(true);
    });

    test('P1-4: the witness is ONLY notice_45_sent_at — the 30-day rung is never an alternative', () => {
      mockCommon();
      const { _private } = require('../services/termite-annual-renewal-charge');
      const { q, calls } = recordingQuery();
      _private.whereNoticeWitnessed(q);
      expect(calls).toEqual([['whereNotNull', ['t.notice_45_sent_at']]]);
    });

    test('P2-5: anchored-or-successor accepts a successor OR an anchored original, via one where(function) predicate', () => {
      mockCommon();
      const { _private } = require('../services/termite-annual-renewal-charge');
      const { q, calls } = recordingQuery();
      _private.whereAnchoredOrSuccessor(q);
      expect(calls.length).toBe(1);
      expect(calls[0][0]).toBe('where');
      expect(typeof calls[0][1][0]).toBe('function');
      // Exercise the predicate itself against a fresh recording sub-query.
      const { q: sub, calls: subCalls } = recordingQuery();
      calls[0][1][0].call(sub, sub);
      expect(subCalls[0]).toEqual(['whereNotNull', ['t.renewed_from_term_id']]);
    });

    test('P1-2: the renewal window subtracts GRACE_DAYS from today for the lower bound on term_end', () => {
      mockCommon();
      mockGraceHelpers({ graceDays: 30 });
      const { _private } = require('../services/termite-annual-renewal-charge');
      const { q, calls } = recordingQuery();
      _private.whereWithinRenewalWindow(q, '2026-09-26');
      expect(calls).toEqual([['where', ['t.term_end', '>=', '2026-08-27']]]);
    });
  });

  // ---- mint -----------------------------------------------------------------

  function makeMintTrx({ parent, existingSuccessor = undefined, peek } = {}) {
    const parentUpdate = jest.fn().mockResolvedValue(1);
    const trx = jest.fn((table) => {
      if (table === 'invoices') {
        // Codex round-7 P1: resolveParentEligibility's own paid-and-not-
        // refunded read, whenever the parent carries a linked invoice and
        // its status already passed the allow-list's status gate — 'paid'
        // by default so an ordinary 'active' parent (baseParent()'s own
        // shape) mints normally; a test exercising the refund race passes
        // its OWN parent without a prepay_invoice_id, or overrides this
        // via a fresh makeMintTrx if it ever needs the unpaid shape.
        return { where: jest.fn().mockReturnValue({ first: jest.fn().mockResolvedValue({ status: 'paid', paid_at: new Date('2025-09-01T00:00:00Z') }) }) };
      }
      if (table === 'payments') {
        return { whereRaw: jest.fn().mockReturnValue({ first: jest.fn().mockResolvedValue(undefined) }) };
      }
      if (table !== 'annual_prepay_terms') throw new Error(`unexpected table ${table}`);
      return {
        where: jest.fn((filter) => {
          if (filter && Object.hasOwn(filter, 'id') && Object.keys(filter).length === 1 && filter.id === parent.id) {
            return {
              // Unlocked peek (P2-2): .first('customer_id') with no forUpdate.
              first: jest.fn((...cols) => {
                if (cols[0] === 'customer_id') return Promise.resolve(peek || { customer_id: parent.customer_id });
                return Promise.resolve(parent);
              }),
              forUpdate: jest.fn().mockReturnValue({ first: jest.fn().mockResolvedValue(parent) }),
            };
          }
          if (filter && Object.hasOwn(filter, 'renewed_from_term_id')) {
            return { first: jest.fn().mockResolvedValue(existingSuccessor) };
          }
          throw new Error(`unexpected where(${JSON.stringify(filter)}) on annual_prepay_terms`);
        }),
      };
    });
    return { trx, parentUpdate };
  }

  function baseParent(overrides = {}) {
    return {
      id: 'parent-1',
      customer_id: 'cust-1',
      annual_plan_version: 'v3',
      status: 'active',
      renewal_decision: null,
      plan_label: 'Waves Subterranean Termite Protection',
      prepay_amount: '249.00',
      monthly_rate: '20.75',
      coverage_service_type: 'termite_annual',
      coverage_visit_count: 1,
      coverage_cadence: 'annual',
      term_end: '2026-09-26',
      renewal_charge_consent_at: new Date('2025-09-01T00:00:00Z'),
      prepay_invoice_id: 'parent-invoice-1',
      ...overrides,
    };
  }

  function mockMintDeps({ invoiceCreateImpl, createTermImpl, overlapImpl } = {}) {
    const invoiceCreate = jest.fn(invoiceCreateImpl || (async (args) => ({
      id: 'succ-invoice-1', total: Number(args.lineItems[0].unit_price), tax_amount: 0, token: 'tok-1',
    })));
    jest.doMock('../services/invoice', () => ({ create: invoiceCreate, sendViaSMSAndEmail: jest.fn(), voidInvoice: jest.fn() }));
    const createTermForAnnualPrepay = jest.fn(createTermImpl || (async (args) => ({
      id: 'succ-term-1',
      customer_id: args.customerId,
      prepay_invoice_id: args.prepayInvoiceId,
      prepay_amount: args.prepayAmount,
      term_start: args.termStart,
      term_end: args.termEnd,
      renewed_from_term_id: args.renewedFromTermId,
    })));
    const recordDecision = jest.fn().mockResolvedValue({ id: 'parent-1' });
    jest.doMock('../services/annual-prepay-renewals', () => ({
      createTermForAnnualPrepay,
      recordDecision,
      TERMITE_RENEWAL_GRACE_DAYS: 30,
      termiteRenewalGraceDeadlineFor: jest.fn(() => '2099-01-01'),
    }));
    const lockAndAssertNoAnnualPrepayOverlap = jest.fn(overlapImpl || (async () => undefined));
    // P1-1: lives on `_private`, not the router root.
    jest.doMock('../routes/admin-customers', () => ({ _private: { lockAndAssertNoAnnualPrepayOverlap } }));
    return { invoiceCreate, createTermForAnnualPrepay, recordDecision, lockAndAssertNoAnnualPrepayOverlap };
  }

  // Codex round-5 P1: the three exception-bell scans (bellNoWitnessTerms /
  // bellUnanchoredOriginalTerms / bellStaleOverdueTerms) each exclude
  // renewal_exception_belled_at in SQL directly, and stamp it once a
  // term's bell has actually been asked for — never relying on
  // notifyAdmin's own dedupe alone to keep a backlog from starving newer
  // terms out of LIMIT.
  // Codex round-6 P1: one column PER KIND (20260926050001) —
  // renewal_no_witness_belled_at / renewal_unanchored_belled_at /
  // renewal_stale_overdue_belled_at. Round-5's single shared
  // renewal_exception_belled_at column is left in the DB, unused (050000
  // is pushed/frozen) — no test here should reference it any more.
  describe('exception-bell scans — per-kind persisted exclusion (Codex round-6 P1)', () => {
    function tableQuery(rows) {
      const q = {};
      // Full chain every one of whereDueForRenewal / whereNoticeWitnessed /
      // whereAnchoredOrSuccessor actually calls (see the recordingQuery
      // helper above), plus the terminal ordering/limit/select.
      const chain = ['whereNotNull', 'whereIn', 'whereNull', 'where', 'whereNotExists', 'whereExists', 'orWhereNotNull', 'orderBy', 'limit', 'select'];
      for (const m of chain) q[m] = jest.fn(() => q);
      q.then = (resolve, reject) => Promise.resolve(rows).then(resolve, reject);
      return q;
    }

    // stampUpdates is keyed by the ACTUAL column name each whereNull() call
    // used — never a single fixed assertion baked into the mock — so a
    // test can inspect exactly which per-kind column got the write.
    function makeBellConn(rows) {
      const scanQ = tableQuery(rows);
      const stampUpdates = {};
      const conn = jest.fn((table) => {
        if (table === 'annual_prepay_terms as t') return scanQ;
        if (table === 'annual_prepay_terms') {
          return {
            where: jest.fn().mockReturnValue({
              whereNull: jest.fn((col) => {
                const update = jest.fn().mockResolvedValue(1);
                stampUpdates[col] = update;
                return { update };
              }),
            }),
          };
        }
        throw new Error(`unexpected table ${table}`);
      });
      return { conn, scanQ, stampUpdates };
    }

    test('bellNoWitnessTerms excludes/stamps renewal_no_witness_belled_at — its OWN kind-specific column', async () => {
      mockCommon();
      const term = { id: 'term-1', customer_id: 'cust-1', term_end: '2026-09-01' };
      const { conn, scanQ, stampUpdates } = makeBellConn([term]);
      const notifyAdmin = jest.fn(async () => ({ id: 'n1', deduped: false, suppressed: false }));
      jest.doMock('../services/notification-service', () => ({ notifyAdmin }));

      const { _private } = require('../services/termite-annual-renewal-charge');
      const counts = { noWitnessBelled: 0 };
      await _private.bellNoWitnessTerms({ conn, limit: 1, today: '2026-09-26', counts });

      expect(scanQ.whereNull).toHaveBeenCalledWith('t.renewal_no_witness_belled_at');
      expect(scanQ.whereNull).not.toHaveBeenCalledWith('t.renewal_exception_belled_at');
      expect(scanQ.limit).toHaveBeenCalledWith(1);
      expect(counts.noWitnessBelled).toBe(1);
      expect(stampUpdates.renewal_no_witness_belled_at).toHaveBeenCalledWith(expect.objectContaining({
        renewal_no_witness_belled_at: expect.any(Date),
      }));
    });

    // The exact scenario the round-5 finding named: with limit 1, an older
    // already-belled term must not be in the result set at all (the real
    // SQL exclusion already filtered it out before LIMIT), so the ONE slot
    // goes to whatever newer term still needs its bell.
    test('bellNoWitnessTerms: with limit 1, a newer term still gets its bell — an older already-belled one never occupies the slot', async () => {
      mockCommon();
      const newerTerm = { id: 'term-newer', customer_id: 'cust-2', term_end: '2026-09-20' };
      const { conn, stampUpdates } = makeBellConn([newerTerm]);
      const notifyAdmin = jest.fn(async () => ({ id: 'n2', deduped: false, suppressed: false }));
      jest.doMock('../services/notification-service', () => ({ notifyAdmin }));

      const { _private } = require('../services/termite-annual-renewal-charge');
      const counts = { noWitnessBelled: 0 };
      await _private.bellNoWitnessTerms({ conn, limit: 1, today: '2026-09-26', counts });

      expect(notifyAdmin).toHaveBeenCalledWith('billing', expect.any(String), expect.any(String), expect.objectContaining({
        dedupeKey: 'termite-renewal-no-witness:term-newer',
      }));
      expect(counts.noWitnessBelled).toBe(1);
      expect(stampUpdates.renewal_no_witness_belled_at).toHaveBeenCalledTimes(1);
    });

    test('bellUnanchoredOriginalTerms excludes/stamps renewal_unanchored_belled_at — its OWN kind-specific column', async () => {
      mockCommon();
      const term = { id: 'term-2', customer_id: 'cust-1', term_end: '2026-09-01' };
      const { conn, scanQ, stampUpdates } = makeBellConn([term]);
      jest.doMock('../services/notification-service', () => ({ notifyAdmin: jest.fn(async () => ({ id: 'n1', deduped: false, suppressed: false })) }));

      const { _private } = require('../services/termite-annual-renewal-charge');
      const counts = { unanchoredBelled: 0 };
      await _private.bellUnanchoredOriginalTerms({ conn, limit: 1, today: '2026-09-26', counts });

      expect(scanQ.whereNull).toHaveBeenCalledWith('t.renewal_unanchored_belled_at');
      expect(scanQ.whereNull).not.toHaveBeenCalledWith('t.renewal_exception_belled_at');
      expect(counts.unanchoredBelled).toBe(1);
      expect(stampUpdates.renewal_unanchored_belled_at).toHaveBeenCalledTimes(1);
    });

    test('bellStaleOverdueTerms excludes/stamps renewal_stale_overdue_belled_at — its OWN kind-specific column', async () => {
      mockCommon();
      mockGraceHelpers({ graceDays: 30 });
      const term = { id: 'term-3', customer_id: 'cust-1', term_end: '2026-06-01' };
      const { conn, scanQ, stampUpdates } = makeBellConn([term]);
      jest.doMock('../services/notification-service', () => ({ notifyAdmin: jest.fn(async () => ({ id: 'n1', deduped: false, suppressed: false })) }));

      const { _private } = require('../services/termite-annual-renewal-charge');
      const counts = { staleOverdueBelled: 0 };
      await _private.bellStaleOverdueTerms({ conn, limit: 1, today: '2026-09-26', counts });

      expect(scanQ.whereNull).toHaveBeenCalledWith('t.renewal_stale_overdue_belled_at');
      expect(scanQ.whereNull).not.toHaveBeenCalledWith('t.renewal_exception_belled_at');
      expect(counts.staleOverdueBelled).toBe(1);
      expect(stampUpdates.renewal_stale_overdue_belled_at).toHaveBeenCalledTimes(1);
    });

    // A bell that DEDUPES from a prior tick still means "staff was told" —
    // the row should stop competing for a scan slot regardless.
    test('a deduped bell (already rang on a prior tick) still stamps the exclusion, even though the count does not increment', async () => {
      mockCommon();
      const term = { id: 'term-4', customer_id: 'cust-1', term_end: '2026-09-01' };
      const { conn, stampUpdates } = makeBellConn([term]);
      jest.doMock('../services/notification-service', () => ({ notifyAdmin: jest.fn(async () => ({ id: 'n1', deduped: true })) }));

      const { _private } = require('../services/termite-annual-renewal-charge');
      const counts = { noWitnessBelled: 0 };
      await _private.bellNoWitnessTerms({ conn, limit: 1, today: '2026-09-26', counts });

      expect(counts.noWitnessBelled).toBe(0);
      expect(stampUpdates.renewal_no_witness_belled_at).toHaveBeenCalledTimes(1);
    });

    // Codex #4971 post-push audit round-2 P1: notifyAdmin returns null on a
    // persistence failure (its own dedupe transaction threw and was
    // swallowed) — NOT the same as a dedupe hit or a fresh success. Staff
    // were never actually told, so stamping the exclusion column would
    // permanently drop this term from every future scan on a mere
    // transient failure. All three passes share this fix; pinned once per
    // pass.
    test('bellNoWitnessTerms: notifyAdmin returning null (persistence failure) never stamps — stays retryable', async () => {
      mockCommon();
      const term = { id: 'term-5', customer_id: 'cust-1', term_end: '2026-09-01' };
      const { conn, stampUpdates } = makeBellConn([term]);
      jest.doMock('../services/notification-service', () => ({ notifyAdmin: jest.fn(async () => null) }));

      const { _private } = require('../services/termite-annual-renewal-charge');
      const counts = { noWitnessBelled: 0 };
      await _private.bellNoWitnessTerms({ conn, limit: 1, today: '2026-09-26', counts });

      expect(counts.noWitnessBelled).toBe(0);
      expect(stampUpdates.renewal_no_witness_belled_at).toBeUndefined();
    });

    test('bellUnanchoredOriginalTerms: notifyAdmin returning null (persistence failure) never stamps — stays retryable', async () => {
      mockCommon();
      const term = { id: 'term-6', customer_id: 'cust-1', term_end: '2026-09-01' };
      const { conn, stampUpdates } = makeBellConn([term]);
      jest.doMock('../services/notification-service', () => ({ notifyAdmin: jest.fn(async () => null) }));

      const { _private } = require('../services/termite-annual-renewal-charge');
      const counts = { unanchoredBelled: 0 };
      await _private.bellUnanchoredOriginalTerms({ conn, limit: 1, today: '2026-09-26', counts });

      expect(counts.unanchoredBelled).toBe(0);
      expect(stampUpdates.renewal_unanchored_belled_at).toBeUndefined();
    });

    test('bellStaleOverdueTerms: notifyAdmin returning null (persistence failure) never stamps — stays retryable', async () => {
      mockCommon();
      mockGraceHelpers({ graceDays: 30 });
      const term = { id: 'term-7', customer_id: 'cust-1', term_end: '2026-06-01' };
      const { conn, stampUpdates } = makeBellConn([term]);
      jest.doMock('../services/notification-service', () => ({ notifyAdmin: jest.fn(async () => null) }));

      const { _private } = require('../services/termite-annual-renewal-charge');
      const counts = { staleOverdueBelled: 0 };
      await _private.bellStaleOverdueTerms({ conn, limit: 1, today: '2026-09-26', counts });

      expect(counts.staleOverdueBelled).toBe(0);
      expect(stampUpdates.renewal_stale_overdue_belled_at).toBeUndefined();
    });

    // Codex round-6 P1 — the exact scenario the finding named: a term
    // already belled for kind A (no_witness — e.g. staff eventually sent
    // the notice, fixing that condition) later legitimately matches a
    // DIFFERENT kind (unanchored) and must still be scanned and belled for
    // it. A single shared exclusion column would have silently skipped it
    // forever the instant kind A belled it; the per-kind columns don't.
    test('a term already belled for no_witness (kind A) is still scanned and belled for unanchored (kind B) once it matches — limit 1', async () => {
      mockCommon();
      const term = {
        id: 'term-5', customer_id: 'cust-1', term_end: '2026-06-01',
        // Belled for no_witness on an earlier tick; renewal_unanchored_belled_at
        // is still null, so bellUnanchoredOriginalTerms' own column exclusion
        // still admits this row.
        renewal_no_witness_belled_at: new Date('2026-07-01T00:00:00Z'),
      };
      const { conn, scanQ, stampUpdates } = makeBellConn([term]);
      const notifyAdmin = jest.fn(async () => ({ id: 'n5', deduped: false, suppressed: false }));
      jest.doMock('../services/notification-service', () => ({ notifyAdmin }));

      const { _private } = require('../services/termite-annual-renewal-charge');
      const counts = { unanchoredBelled: 0 };
      await _private.bellUnanchoredOriginalTerms({ conn, limit: 1, today: '2026-09-26', counts });

      expect(scanQ.whereNull).toHaveBeenCalledWith('t.renewal_unanchored_belled_at');
      expect(notifyAdmin).toHaveBeenCalledWith('billing', expect.any(String), expect.any(String), expect.objectContaining({
        dedupeKey: 'termite-renewal-unanchored:term-5',
      }));
      expect(counts.unanchoredBelled).toBe(1);
      expect(stampUpdates.renewal_unanchored_belled_at).toHaveBeenCalledTimes(1);
    });

    // Same scenario, the other pairing: already belled for unanchored
    // (kind A — e.g. staff anchored the installation, fixing THAT
    // condition), then the term goes stale-overdue (kind B) and must still
    // be scanned and belled for it.
    test('a term already belled for unanchored (kind A) is still scanned and belled for stale_overdue (kind B) once it matches — limit 1', async () => {
      mockCommon();
      mockGraceHelpers({ graceDays: 30 });
      const term = {
        id: 'term-6', customer_id: 'cust-1', term_end: '2026-06-01',
        renewal_unanchored_belled_at: new Date('2026-07-01T00:00:00Z'),
      };
      const { conn, scanQ, stampUpdates } = makeBellConn([term]);
      const notifyAdmin = jest.fn(async () => ({ id: 'n6', deduped: false, suppressed: false }));
      jest.doMock('../services/notification-service', () => ({ notifyAdmin }));

      const { _private } = require('../services/termite-annual-renewal-charge');
      const counts = { staleOverdueBelled: 0 };
      await _private.bellStaleOverdueTerms({ conn, limit: 1, today: '2026-09-26', counts });

      expect(scanQ.whereNull).toHaveBeenCalledWith('t.renewal_stale_overdue_belled_at');
      expect(notifyAdmin).toHaveBeenCalledWith('billing', expect.any(String), expect.any(String), expect.objectContaining({
        dedupeKey: 'termite-renewal-stale-overdue:term-6',
      }));
      expect(counts.staleOverdueBelled).toBe(1);
      expect(stampUpdates.renewal_stale_overdue_belled_at).toHaveBeenCalledTimes(1);
    });
  });

  describe('mintRenewalSuccessor', () => {
    test('mints the successor for exactly parent.prepay_amount, term_end inclusive -> next-day start + 12mo end, and does NOT stamp the parent (P2-1)', async () => {
      mockCommon();
      const parent = baseParent();
      const { trx, parentUpdate } = makeMintTrx({ parent });
      const conn = { transaction: jest.fn(async (cb) => cb(trx)) };
      const { invoiceCreate, createTermForAnnualPrepay, lockAndAssertNoAnnualPrepayOverlap } = mockMintDeps();

      const { _private } = require('../services/termite-annual-renewal-charge');
      const result = await _private.mintRenewalSuccessor('parent-1', conn);

      expect(result.minted).toBe(true);
      expect(result.successor.id).toBe('succ-term-1');
      // P2-2: lock order — an unlocked peek's customer_id feeds a LOCK-ONLY
      // call (allowOverlap=true, termStart null) BEFORE the parent row is
      // ever read under FOR UPDATE, then the real overlap assert
      // (allowOverlap=false) once termStart is known.
      expect(lockAndAssertNoAnnualPrepayOverlap).toHaveBeenNthCalledWith(1, trx, 'cust-1', null, true, '');
      expect(lockAndAssertNoAnnualPrepayOverlap).toHaveBeenNthCalledWith(2, trx, 'cust-1', '2026-09-27', false, expect.any(String));
      expect(invoiceCreate).toHaveBeenCalledWith(expect.objectContaining({
        customerId: 'cust-1',
        taxRate: 0,
        skipAccrual: true,
        lineItems: [expect.objectContaining({ quantity: 1, unit_price: 249 })],
      }));
      expect(createTermForAnnualPrepay).toHaveBeenCalledWith(expect.objectContaining({
        customerId: 'cust-1',
        prepayInvoiceId: 'succ-invoice-1',
        prepayAmount: 249,
        termStart: '2026-09-27', // parent term_end (inclusive) + 1 day
        termEnd: '2027-09-27', // +12mo same day
        renewedFromTermId: 'parent-1',
        annualPlanVersion: 'v3',
        coverageServiceType: 'termite_annual',
        // Codex round-1 P1: the PARENT's own consent carries forward onto
        // the successor — a renewal never signs a fresh agreement.
        renewalChargeConsentAt: parent.renewal_charge_consent_at,
      }));
      // P2-1: mint never writes to the parent row at all.
      expect(parentUpdate).not.toHaveBeenCalled();
    });

    test('Codex round-1 P1: a year-2 successor (whose OWN consent was itself carried forward) carries it into its year-3 mint too — the chain, not just one hop', async () => {
      mockCommon();
      // The "parent" here IS a successor from an earlier renewal — it
      // received renewal_charge_consent_at from ITS OWN parent at mint,
      // exactly like any other termite term.
      const yearTwoSuccessorAsParent = baseParent({
        id: 'year2-term', renewed_from_term_id: 'year1-term', renewal_charge_consent_at: new Date('2025-09-01T00:00:00Z'),
      });
      const { trx } = makeMintTrx({ parent: yearTwoSuccessorAsParent });
      const conn = { transaction: jest.fn(async (cb) => cb(trx)) };
      const { createTermForAnnualPrepay } = mockMintDeps();

      const { _private } = require('../services/termite-annual-renewal-charge');
      await _private.mintRenewalSuccessor('year2-term', conn);

      expect(createTermForAnnualPrepay).toHaveBeenCalledWith(expect.objectContaining({
        renewedFromTermId: 'year2-term',
        renewalChargeConsentAt: yearTwoSuccessorAsParent.renewal_charge_consent_at,
      }));
    });

    test('a parent with no renewal_charge_consent_at (never had Auto Pay consent) mints a successor with none either — the no_consent skip still applies downstream', async () => {
      mockCommon();
      const parent = baseParent({ renewal_charge_consent_at: null });
      const { trx } = makeMintTrx({ parent });
      const conn = { transaction: jest.fn(async (cb) => cb(trx)) };
      const { createTermForAnnualPrepay } = mockMintDeps();

      const { _private } = require('../services/termite-annual-renewal-charge');
      await _private.mintRenewalSuccessor('parent-1', conn);

      expect(createTermForAnnualPrepay).toHaveBeenCalledWith(expect.objectContaining({
        renewalChargeConsentAt: undefined,
      }));
    });

    test('never recomputes the price — throws if the minted invoice total drifts from prepay_amount', async () => {
      mockCommon();
      const parent = baseParent();
      const { trx } = makeMintTrx({ parent });
      const conn = { transaction: jest.fn(async (cb) => cb(trx)) };
      mockMintDeps({ invoiceCreateImpl: async () => ({ id: 'bad-invoice', total: 260, tax_amount: 0, token: 'tok' }) });

      const { _private } = require('../services/termite-annual-renewal-charge');
      await expect(_private.mintRenewalSuccessor('parent-1', conn)).rejects.toThrow(/does not match the quoted renewal fee/);
    });

    test('idempotent — a successor that already exists is returned untouched, and nothing else mints again', async () => {
      mockCommon();
      const parent = baseParent();
      const existingSuccessor = { id: 'already-there', renewed_from_term_id: 'parent-1' };
      const { trx } = makeMintTrx({ parent, existingSuccessor });
      const conn = { transaction: jest.fn(async (cb) => cb(trx)) };
      const { invoiceCreate, createTermForAnnualPrepay } = mockMintDeps();

      const { _private } = require('../services/termite-annual-renewal-charge');
      const result = await _private.mintRenewalSuccessor('parent-1', conn);

      expect(result).toEqual({ successor: existingSuccessor, minted: false });
      expect(invoiceCreate).not.toHaveBeenCalled();
      expect(createTermForAnnualPrepay).not.toHaveBeenCalled();
    });

    test('a declined renewal (renewal_decision already set) is never minted or charged', async () => {
      mockCommon();
      const parent = baseParent({ renewal_decision: 'cancel', status: 'cancelled' });
      const { trx } = makeMintTrx({ parent });
      const conn = { transaction: jest.fn(async (cb) => cb(trx)) };
      const { invoiceCreate } = mockMintDeps();

      const { _private } = require('../services/termite-annual-renewal-charge');
      const result = await _private.mintRenewalSuccessor('parent-1', conn);

      expect(result).toBeNull();
      expect(invoiceCreate).not.toHaveBeenCalled();
    });

    test('a non-renewable status (already renewal-decided some other way) mints nothing', async () => {
      mockCommon();
      const parent = baseParent({ status: 'refunded' });
      const { trx } = makeMintTrx({ parent });
      const conn = { transaction: jest.fn(async (cb) => cb(trx)) };
      const { invoiceCreate } = mockMintDeps();

      const { _private } = require('../services/termite-annual-renewal-charge');
      const result = await _private.mintRenewalSuccessor('parent-1', conn);

      expect(result).toBeNull();
      expect(invoiceCreate).not.toHaveBeenCalled();
    });

    // Codex round-4 P0 (parentEligibleForRenewalAction — the ALLOW-list).
    test('P0: a parent voided/refunded BEFORE mint (status cancelled, renewal_decision IS NULL — the move-9 shape) mints nothing', async () => {
      mockCommon();
      // Exactly the shape the existing invoice-void/refund sync writes
      // (annual-prepay-renewals.js's syncTermForInvoicePayment, move 9) —
      // NOT a decided decline. The old deny-list (renewal_decision alone)
      // let this shape slip through; the allow-list rejects it on status.
      const parent = baseParent({ status: 'cancelled', renewal_decision: null });
      const { trx } = makeMintTrx({ parent });
      const conn = { transaction: jest.fn(async (cb) => cb(trx)) };
      const { invoiceCreate, createTermForAnnualPrepay } = mockMintDeps();

      const { _private } = require('../services/termite-annual-renewal-charge');
      const result = await _private.mintRenewalSuccessor('parent-1', conn);

      expect(result).toBeNull();
      expect(invoiceCreate).not.toHaveBeenCalled();
      expect(createTermForAnnualPrepay).not.toHaveBeenCalled();
    });

    test('no row found on the unlocked peek returns null before any lock is taken', async () => {
      mockCommon();
      const trx = jest.fn(() => ({ where: jest.fn(() => ({ first: jest.fn().mockResolvedValue(undefined) })) }));
      const conn = { transaction: jest.fn(async (cb) => cb(trx)) };
      const { lockAndAssertNoAnnualPrepayOverlap } = mockMintDeps();

      const { _private } = require('../services/termite-annual-renewal-charge');
      const result = await _private.mintRenewalSuccessor('missing-parent', conn);

      expect(result).toBeNull();
      expect(lockAndAssertNoAnnualPrepayOverlap).not.toHaveBeenCalled();
    });
  });

  // ---- charge decision --------------------------------------------------

  // Codex round-7 P1: decideAndCharge now opens with checkStillEligibleForRenewalAction
  // — a PLAIN (non-forUpdate) `.where({id}).first()` lookup of the successor
  // AND (when it has a parent) the parent, on the OUTER conn — before ANY
  // of the no_consent/no_method/surcharge_not_authorized fallback skips.
  // Defaults resolve to fresh, fully-eligible copies of baseSuccessor()/
  // baseParent() so every EXISTING skip-branch test keeps passing
  // unchanged; a test that needs the up-front check to itself fail passes
  // its own successor/parent override.
  function makeClaimConn({
    claimResult = 1,
    successor = baseSuccessor(),
    parent = baseParent(),
  } = {}) {
    const claimUpdate = jest.fn().mockResolvedValue(claimResult);
    const skipStampUpdate = jest.fn().mockResolvedValue(1);
    const conn = jest.fn((table) => {
      if (table === 'invoices') {
        // ID-aware: the PARENT's invoice (resolveParentEligibility's own
        // paid-and-not-refunded read) reads paid; the SUCCESSOR's OWN
        // invoice (checkStillEligibleForRenewalAction's "still open" read)
        // reads open — the two must never share one fixed answer.
        return {
          where: jest.fn((filter) => ({
            first: jest.fn().mockResolvedValue(
              parent && filter?.id === parent.prepay_invoice_id
                ? { status: 'paid', paid_at: new Date('2025-09-01T00:00:00Z') }
                : { status: 'sent' },
            ),
          })),
        };
      }
      if (table === 'payments') {
        // No refund on file — parentInvoicePaidAndNotFullyRefunded's own
        // ledger check, run only once the invoice above reads paid.
        return { whereRaw: jest.fn().mockReturnValue({ first: jest.fn().mockResolvedValue(undefined) }) };
      }
      if (table !== 'annual_prepay_terms') throw new Error(`unexpected table ${table}`);
      return {
        where: jest.fn((filter) => ({
          first: jest.fn().mockResolvedValue(
            filter?.id === successor.id ? successor : (parent && filter?.id === parent.id ? parent : undefined),
          ),
          whereNull: jest.fn((col) => {
            if (col === 'renewal_charge_attempted_at') return { update: claimUpdate };
            if (col === 'renewal_charge_skipped_at') return { update: skipStampUpdate };
            throw new Error(`unexpected whereNull(${col})`);
          }),
        })),
      };
    });
    return { conn, claimUpdate, skipStampUpdate };
  }

  function baseSuccessor(overrides = {}) {
    return {
      id: 'succ-term-1', customer_id: 'cust-1', prepay_invoice_id: 'succ-invoice-1', prepay_amount: 249,
      status: 'payment_pending', renewed_from_term_id: 'parent-1', annual_plan_version: 'v3',
      term_start: '2026-09-27', created_at: '2026-09-27T00:00:00Z',
      ...overrides,
    };
  }

  // decideAndCharge's fence claim is resolveChargeEligibility (Codex round-1
  // P0): ONE transaction that fresh-reads the successor + its parent (both
  // FOR UPDATE), checks the invoice is still open, checks today is still
  // inside the successor's own grace deadline, then claims the fence — all
  // before the Stripe call. `conn('invoices')` on the OUTER conn (not trx)
  // is decideAndCharge's own SEPARATE post-charge classification read.
  function makeDecideConn({
    successor,
    // Codex round-4 P0: resolveChargeEligibility's allow-list now checks
    // the FRESH parent's status, not just renewal_decision — 'active'
    // matches the real, still-undecided shape every one of this suite's
    // default-parent tests models.
    parent = { id: 'parent-1', status: 'active', renewal_decision: null },
    eligibilityInvoice = { status: 'sent' },
    claimResult = 1,
    freshInvoice = { status: 'paid', payment_method: 'card' },
    freshInvoiceError = null,
    // Successive OUTER-conn parent reads (the unlocked pre-check, then the
    // re-check under withParentDecisionLock right before Stripe) — lets a
    // test model a parent that changes between the two. Defaults to
    // `parent` for every read.
    outerParentReads = null,
  }) {
    const claimUpdate = jest.fn().mockResolvedValue(claimResult);
    const trx = jest.fn((table) => {
      if (table === 'annual_prepay_terms') {
        return {
          where: jest.fn((filter) => {
            if (filter.id === successor.id) {
              return {
                forUpdate: jest.fn().mockReturnValue({ first: jest.fn().mockResolvedValue(successor) }),
                whereNull: jest.fn((col) => {
                  expect(col).toBe('renewal_charge_attempted_at');
                  return { update: claimUpdate };
                }),
              };
            }
            if (parent && filter.id === parent.id) {
              return { forUpdate: jest.fn().mockReturnValue({ first: jest.fn().mockResolvedValue(parent) }) };
            }
            throw new Error(`unexpected annual_prepay_terms where(${JSON.stringify(filter)}) in eligibility trx`);
          }),
        };
      }
      if (table === 'invoices') {
        return { where: jest.fn().mockReturnValue({ first: jest.fn().mockResolvedValue(eligibilityInvoice) }) };
      }
      throw new Error(`unexpected table ${table} in eligibility trx`);
    });
    // Codex round-4 P1: decideAndCharge's own stampRenewalChargeSkip runs
    // on the OUTER conn (never trx) for an 'ineligible' outcome. Codex
    // round-7 P1: the OUTER conn is ALSO where checkStillEligibleForRenewalAction
    // (the up-front re-validation) and withParentDecisionLock's own
    // pre-Stripe parent re-check run their PLAIN (non-forUpdate)
    // successor/parent lookups — a `.first()` chain alongside the
    // existing `.whereNull().update()` skip-stamp chain, on the SAME
    // `where()` call.
    const skipStampUpdate = jest.fn().mockResolvedValue(1);
    // Codex #4971 round-3 (item 7 follow-through): a charge failure that
    // was fully handled (staff belled, and the pay link sent where allowed)
    // stamps leg 7b's handled marker, so 7b never re-handles the attempt as
    // a crash.
    const handledStampUpdate = jest.fn().mockResolvedValue(1);
    // The FIRST read of the successor's own invoice on the outer conn is
    // checkStillEligibleForRenewalAction's "is it still open" check
    // (before ANY customer-facing action) — it must see the SAME
    // still-open shape eligibilityInvoice already represents inside the
    // trx. Only the SECOND read (decideAndCharge's own post-charge
    // classification, reached only once a charge actually ran) sees
    // freshInvoice.
    const outerInvoiceFirst = jest.fn().mockResolvedValueOnce(eligibilityInvoice);
    outerInvoiceFirst.mockImplementation(() => (freshInvoiceError ? Promise.reject(freshInvoiceError) : Promise.resolve(freshInvoice)));
    const deferredUpdate = jest.fn().mockResolvedValue(1);
    const parentReads = outerParentReads ? [...outerParentReads] : null;
    const outerParent = () => (parentReads && parentReads.length > 1 ? parentReads.shift() : (parentReads ? parentReads[0] : parent));
    const conn = jest.fn((table) => {
      if (table === 'invoices') {
        return { where: jest.fn().mockReturnValue({ first: outerInvoiceFirst }) };
      }
      if (table === 'stripe_invoice_charge_attempts as a') {
        // No attempt with submission evidence (retireUnpresentedSuccessor's
        // "was it presented" read).
        const q = { where: jest.fn(() => q), first: jest.fn().mockResolvedValue(undefined) };
        return q;
      }
      if (table === 'annual_prepay_terms') {
        return {
          where: jest.fn((filter) => ({
            first: jest.fn((col) => {
              if (col === 'status') return Promise.resolve({ status: 'cancelled' }); // after a retire's void + sync
              if (filter?.id === successor.id) return Promise.resolve(successor);
              return Promise.resolve(parent && filter?.id === parent.id ? outerParent() : undefined);
            }),
            update: deferredUpdate,
            whereNull: jest.fn((col) => {
              if (col === 'renewal_charge_never_reached_stripe_belled_at') return { update: handledStampUpdate };
              expect(col).toBe('renewal_charge_skipped_at');
              return { update: skipStampUpdate };
            }),
          })),
        };
      }
      throw new Error(`unexpected table ${table} on outer conn`);
    });
    conn.transaction = jest.fn(async (cb) => cb(trx));
    return { conn, trx, claimUpdate, skipStampUpdate, handledStampUpdate, deferredUpdate };
  }

  function mockSignatureChargePrivate({ classifyChargeErrorImpl, classifyVerifiedChargeImpl } = {}) {
    jest.doMock('../services/termite-annual-signature-charge', () => ({
      _private: {
        classifyChargeError: classifyChargeErrorImpl || jest.fn((err) => ({ status: 'declined', reason: err?.message || 'charge failed' })),
        classifyVerifiedCharge: classifyVerifiedChargeImpl || jest.fn((freshInvoice) => {
          const status = String(freshInvoice?.status || '').toLowerCase();
          if (['paid', 'prepaid'].includes(status)) return { status: 'paid' };
          if (status === 'processing' && freshInvoice?.payment_method === 'us_bank_account') return { status: 'processing' };
          if (status === 'processing') return { status: 'ambiguous', reason: 'card_intent_incomplete' };
          return { status: 'declined', reason: `post-charge status ${freshInvoice?.status || 'unknown'}` };
        }),
      },
    }));
  }

  describe('decideAndCharge', () => {
    test('no consent on the parent -> the pay-link invoice goes out and staff are belled; no method resolution, no Stripe call', async () => {
      mockCommon();
      const sendViaSMSAndEmail = jest.fn(async () => ({ ok: true }));
      jest.doMock('../services/invoice', () => ({ sendViaSMSAndEmail }));
      const notifyAdmin = jest.fn(async () => ({ id: 'n1' }));
      jest.doMock('../services/notification-service', () => ({ notifyAdmin }));
      const resolvePrepayChargeMethod = jest.fn();
      jest.doMock('../services/recurring-card-on-file', () => ({ resolvePrepayChargeMethod }));
      const chargeInvoiceWithSavedCard = jest.fn();
      const quoteInvoiceSavedCardCharge = jest.fn();
      jest.doMock('../services/stripe', () => ({ chargeInvoiceWithSavedCard, quoteInvoiceSavedCardCharge }));

      const { _private } = require('../services/termite-annual-renewal-charge');
      const { conn, skipStampUpdate } = makeClaimConn();
      const successor = baseSuccessor();
      const parent = baseParent({ renewal_charge_consent_at: null });

      const outcome = await _private.decideAndCharge(successor, parent, conn);

      expect(outcome.status).toBe('no_consent');
      expect(sendViaSMSAndEmail).toHaveBeenCalledWith('succ-invoice-1', expect.any(Object));
      expect(notifyAdmin).toHaveBeenCalledWith('billing', expect.stringMatching(/no auto-charge consent/i), expect.any(String), expect.objectContaining({
        dedupeKey: 'termite-renewal-charge:succ-term-1:no_consent',
      }));
      expect(resolvePrepayChargeMethod).not.toHaveBeenCalled();
      expect(chargeInvoiceWithSavedCard).not.toHaveBeenCalled();
      expect(quoteInvoiceSavedCardCharge).not.toHaveBeenCalled();
      // Codex round-4 P1: persisted provenance for reconcileStuckSuccessors'
      // leg 7a — this row's SQL exclusion, not a notifications-table LIKE
      // inference checked after the fact.
      expect(skipStampUpdate).toHaveBeenCalledWith(expect.objectContaining({
        renewal_charge_skipped_at: expect.any(Date), renewal_charge_skip_reason: 'no_consent',
      }));
    });

    test('consent present but no chargeable saved method -> invoice + bell, no Stripe call', async () => {
      mockCommon();
      const sendViaSMSAndEmail = jest.fn(async () => ({ ok: true }));
      jest.doMock('../services/invoice', () => ({ sendViaSMSAndEmail }));
      const notifyAdmin = jest.fn(async () => ({ id: 'n1' }));
      jest.doMock('../services/notification-service', () => ({ notifyAdmin }));
      jest.doMock('../services/recurring-card-on-file', () => ({ resolvePrepayChargeMethod: jest.fn(async () => null) }));
      const chargeInvoiceWithSavedCard = jest.fn();
      jest.doMock('../services/stripe', () => ({ chargeInvoiceWithSavedCard, quoteInvoiceSavedCardCharge: jest.fn() }));

      const { _private } = require('../services/termite-annual-renewal-charge');
      const { conn, skipStampUpdate } = makeClaimConn();
      const outcome = await _private.decideAndCharge(baseSuccessor(), baseParent(), conn);

      expect(outcome.status).toBe('no_method');
      expect(notifyAdmin).toHaveBeenCalledWith('billing', expect.stringMatching(/no saved card/i), expect.any(String), expect.any(Object));
      expect(chargeInvoiceWithSavedCard).not.toHaveBeenCalled();
      expect(skipStampUpdate).toHaveBeenCalledWith(expect.objectContaining({ renewal_charge_skip_reason: 'no_method' }));
    });

    test('P1-5: a surcharge that would exceed the flat renewal fee skips the charge, delivers the pay link, and rings a dedicated bell — no fence stamp, no SMS', async () => {
      mockCommon();
      const sendViaSMSAndEmail = jest.fn(async () => ({ ok: true }));
      jest.doMock('../services/invoice', () => ({ sendViaSMSAndEmail }));
      const notifyAdmin = jest.fn(async () => ({ id: 'n1' }));
      jest.doMock('../services/notification-service', () => ({ notifyAdmin }));
      jest.doMock('../services/recurring-card-on-file', () => ({
        resolvePrepayChargeMethod: jest.fn(async () => ({ paymentMethodRowId: 'pm-1' })),
      }));
      const chargeInvoiceWithSavedCard = jest.fn();
      const quoteInvoiceSavedCardCharge = jest.fn(async () => ({ total: 256.5 })); // > 249 prepay amount
      jest.doMock('../services/stripe', () => ({ chargeInvoiceWithSavedCard, quoteInvoiceSavedCardCharge }));

      const { _private } = require('../services/termite-annual-renewal-charge');
      const { conn, claimUpdate, skipStampUpdate } = makeClaimConn();
      const outcome = await _private.decideAndCharge(baseSuccessor(), baseParent(), conn);

      expect(outcome.status).toBe('surcharge_not_authorized');
      expect(quoteInvoiceSavedCardCharge).toHaveBeenCalledWith('succ-invoice-1', 'pm-1');
      expect(sendViaSMSAndEmail).toHaveBeenCalledTimes(1);
      expect(notifyAdmin).toHaveBeenCalledWith('billing', expect.stringMatching(/surcharge/i), expect.any(String), expect.objectContaining({
        dedupeKey: 'termite-renewal-charge:succ-term-1:surcharge_not_authorized',
      }));
      // Never even reaches the attempt fence — no Stripe call was authorized.
      expect(claimUpdate).not.toHaveBeenCalled();
      expect(chargeInvoiceWithSavedCard).not.toHaveBeenCalled();
      expect(skipStampUpdate).toHaveBeenCalledWith(expect.objectContaining({ renewal_charge_skip_reason: 'surcharge_not_authorized' }));
    });

    test('a quote failure is non-fatal — falls through to the charge attempt, relying on the ceiling', async () => {
      mockCommon();
      mockGraceHelpers({ graceDays: 30 });
      jest.doMock('../services/invoice', () => ({ sendViaSMSAndEmail: jest.fn() }));
      jest.doMock('../services/notification-service', () => ({ notifyAdmin: jest.fn() }));
      jest.doMock('../services/recurring-card-on-file', () => ({
        resolvePrepayChargeMethod: jest.fn(async () => ({ paymentMethodRowId: 'pm-1' })),
      }));
      mockSignatureChargePrivate({ classifyVerifiedChargeImpl: jest.fn(() => ({ status: 'paid' })) });
      const chargeInvoiceWithSavedCard = jest.fn(async () => ({ status: 'paid' }));
      const quoteInvoiceSavedCardCharge = jest.fn(async () => { throw new Error('quote unavailable'); });
      jest.doMock('../services/stripe', () => ({ chargeInvoiceWithSavedCard, quoteInvoiceSavedCardCharge }));

      const { _private } = require('../services/termite-annual-renewal-charge');
      const successor = baseSuccessor();
      const { conn } = makeDecideConn({ successor });
      const outcome = await _private.decideAndCharge(successor, baseParent(), conn);

      expect(outcome.status).toBe('charged');
      expect(chargeInvoiceWithSavedCard).toHaveBeenCalledTimes(1);
    });

    test('a genuine Stripe decline (wavesCardDecline): one attempt, one "declined" bell, pay-link delivered, and the customer SMS fires', async () => {
      mockCommon();
      mockGraceHelpers({ graceDays: 30 });
      const sendViaSMSAndEmail = jest.fn(async () => ({ ok: true }));
      jest.doMock('../services/invoice', () => ({ sendViaSMSAndEmail }));
      const notifyAdmin = jest.fn(async () => ({ id: 'n1' }));
      jest.doMock('../services/notification-service', () => ({ notifyAdmin }));
      jest.doMock('../services/recurring-card-on-file', () => ({
        resolvePrepayChargeMethod: jest.fn(async () => ({ paymentMethodRowId: 'pm-1' })),
      }));
      const declineErr = new Error('Your card was declined.');
      declineErr.wavesCardDecline = { declineCode: 'card_declined' };
      mockSignatureChargePrivate({ classifyChargeErrorImpl: jest.fn(() => ({ status: 'declined', reason: declineErr.message })) });
      const chargeInvoiceWithSavedCard = jest.fn(async () => { throw declineErr; });
      const quoteInvoiceSavedCardCharge = jest.fn(async () => ({ total: 249 }));
      jest.doMock('../services/stripe', () => ({ chargeInvoiceWithSavedCard, quoteInvoiceSavedCardCharge }));
      jest.doMock('../utils/portal-url', () => ({ publicPortalUrl: () => 'https://portal.example.com' }));
      const renderSmsTemplate = jest.fn(async () => 'rendered body');
      jest.doMock('../services/sms-template-renderer', () => ({ renderSmsTemplate }));
      const sendCustomerMessage = jest.fn(async () => ({ sent: true }));
      jest.doMock('../services/messaging/send-customer-message', () => ({ sendCustomerMessage }));
      const dbMock = jest.fn((table) => {
        if (table === 'customers') return { where: jest.fn().mockReturnValue({ first: jest.fn().mockResolvedValue({ id: 'cust-1', phone: '+19415551212', first_name: 'Pat' }) }) };
        if (table === 'invoices') return { where: jest.fn().mockReturnValue({ first: jest.fn().mockResolvedValue({ token: 'tok-1' }) }) };
        throw new Error(`unexpected table ${table}`);
      });
      jest.doMock('../models/db', () => dbMock);

      const { _private } = require('../services/termite-annual-renewal-charge');
      const successor = baseSuccessor();
      const { conn, claimUpdate, handledStampUpdate } = makeDecideConn({ successor }); // first call claims (1 row)

      const outcome = await _private.decideAndCharge(successor, baseParent(), conn);
      expect(outcome.status).toBe('failed');
      expect(claimUpdate).toHaveBeenCalledTimes(1);
      // Belled + pay link delivered: leg 7b's handled marker is stamped.
      expect(handledStampUpdate).toHaveBeenCalledWith({ renewal_charge_never_reached_stripe_belled_at: expect.any(Date) });
      expect(chargeInvoiceWithSavedCard).toHaveBeenCalledTimes(1);
      expect(chargeInvoiceWithSavedCard).toHaveBeenCalledWith('succ-invoice-1', 'pm-1', expect.objectContaining({
        maxAuthorizedChargeCents: 24900, maxAuthorizedTotalCents: 24900,
      }));
      expect(notifyAdmin).toHaveBeenCalledWith('billing', expect.stringMatching(/declined/i), expect.any(String), expect.objectContaining({
        dedupeKey: 'termite-renewal-charge:succ-term-1:declined',
      }));
      expect(sendViaSMSAndEmail).toHaveBeenCalledTimes(1);
      // Genuine decline -> the customer SMS actually fires.
      await Promise.resolve();
      expect(sendCustomerMessage).toHaveBeenCalledWith(expect.objectContaining({ purpose: 'payment_failure' }));

      // A later call against the SAME successor, once already attempted,
      // never re-attempts — the fresh re-read inside resolveChargeEligibility
      // now sees renewal_charge_attempted_at already set (matching what a
      // real UPDATE ... WHERE renewal_charge_attempted_at IS NULL would find
      // the second time) and refuses before the claim UPDATE even runs.
      const alreadyAttemptedSuccessor = { ...successor, renewal_charge_attempted_at: new Date('2026-09-27T12:00:00Z') };
      const { conn: secondConn, claimUpdate: secondClaim } = makeDecideConn({ successor: alreadyAttemptedSuccessor });
      const secondOutcome = await _private.decideAndCharge(successor, baseParent(), secondConn);
      expect(secondOutcome.status).toBe('already_attempted');
      expect(secondClaim).not.toHaveBeenCalled();
      expect(chargeInvoiceWithSavedCard).toHaveBeenCalledTimes(1); // still just the one attempt total
    });

    test('P1-5: a non-decline refusal (Auto Pay inactive / guard error, no wavesCardDecline) bells "refused" and delivers the pay link — NEVER sends the customer SMS', async () => {
      mockCommon();
      mockGraceHelpers({ graceDays: 30 });
      const sendViaSMSAndEmail = jest.fn(async () => ({ ok: true }));
      jest.doMock('../services/invoice', () => ({ sendViaSMSAndEmail }));
      const notifyAdmin = jest.fn(async () => ({ id: 'n1' }));
      jest.doMock('../services/notification-service', () => ({ notifyAdmin }));
      jest.doMock('../services/recurring-card-on-file', () => ({
        resolvePrepayChargeMethod: jest.fn(async () => ({ paymentMethodRowId: 'pm-1' })),
      }));
      const guardErr = new Error('Auto Pay is not active for this customer.');
      mockSignatureChargePrivate({ classifyChargeErrorImpl: jest.fn(() => ({ status: 'declined', reason: guardErr.message })) });
      const chargeInvoiceWithSavedCard = jest.fn(async () => { throw guardErr; });
      jest.doMock('../services/stripe', () => ({ chargeInvoiceWithSavedCard, quoteInvoiceSavedCardCharge: jest.fn(async () => ({ total: 249 })) }));
      const sendCustomerMessage = jest.fn();
      jest.doMock('../services/messaging/send-customer-message', () => ({ sendCustomerMessage }));

      const { _private } = require('../services/termite-annual-renewal-charge');
      const successor = baseSuccessor();
      const { conn, handledStampUpdate } = makeDecideConn({ successor });
      const outcome = await _private.decideAndCharge(successor, baseParent(), conn);

      expect(outcome.status).toBe('failed');
      expect(sendViaSMSAndEmail).toHaveBeenCalledTimes(1); // pay link still delivered
      // Codex #4971 round-3 (item 7 follow-through): a guard refusal inside
      // chargeInvoiceWithSavedCard leaves an UNSUBMITTED attempt row, which
      // leg 7b now selects — this handled path stamps 7b's marker so the
      // refusal is never re-handled as a crash.
      expect(handledStampUpdate).toHaveBeenCalledTimes(1);
      expect(notifyAdmin).toHaveBeenCalledWith('billing', expect.any(String), expect.any(String), expect.objectContaining({
        dedupeKey: 'termite-renewal-charge:succ-term-1:refused',
      }));
      await Promise.resolve();
      expect(sendCustomerMessage).not.toHaveBeenCalled();
    });

    test('an ambiguous outcome (isAmbiguousSavedMethodChargeError) bells "ambiguous" and NEVER delivers a pay link — money may be moving', async () => {
      mockCommon();
      mockGraceHelpers({ graceDays: 30 });
      const sendViaSMSAndEmail = jest.fn(async () => ({ ok: true }));
      jest.doMock('../services/invoice', () => ({ sendViaSMSAndEmail }));
      const notifyAdmin = jest.fn(async () => ({ id: 'n1' }));
      jest.doMock('../services/notification-service', () => ({ notifyAdmin }));
      jest.doMock('../services/recurring-card-on-file', () => ({
        resolvePrepayChargeMethod: jest.fn(async () => ({ paymentMethodRowId: 'pm-1' })),
      }));
      const ambiguousErr = new Error('Stripe charge in progress');
      mockSignatureChargePrivate({ classifyChargeErrorImpl: jest.fn(() => ({ status: 'ambiguous', reason: 'STRIPE_CHARGE_IN_PROGRESS' })) });
      const chargeInvoiceWithSavedCard = jest.fn(async () => { throw ambiguousErr; });
      jest.doMock('../services/stripe', () => ({ chargeInvoiceWithSavedCard, quoteInvoiceSavedCardCharge: jest.fn(async () => ({ total: 249 })) }));

      const { _private } = require('../services/termite-annual-renewal-charge');
      const successor = baseSuccessor();
      const { conn, handledStampUpdate } = makeDecideConn({ successor });
      const outcome = await _private.decideAndCharge(successor, baseParent(), conn);

      expect(outcome.status).toBe('failed');
      expect(sendViaSMSAndEmail).not.toHaveBeenCalled();
      expect(notifyAdmin).toHaveBeenCalledWith('billing', expect.any(String), expect.any(String), expect.objectContaining({
        dedupeKey: 'termite-renewal-charge:succ-term-1:ambiguous',
      }));
      // Staff were told; leg 7b must never later send a pay link beside it.
      expect(handledStampUpdate).toHaveBeenCalledTimes(1);
    });

    test('a payer-billed guard (deferred) bells "refused" and delivers NO pay link, matching the sibling', async () => {
      mockCommon();
      mockGraceHelpers({ graceDays: 30 });
      const sendViaSMSAndEmail = jest.fn(async () => ({ ok: true }));
      jest.doMock('../services/invoice', () => ({ sendViaSMSAndEmail }));
      const notifyAdmin = jest.fn(async () => ({ id: 'n1' }));
      jest.doMock('../services/notification-service', () => ({ notifyAdmin }));
      jest.doMock('../services/recurring-card-on-file', () => ({
        resolvePrepayChargeMethod: jest.fn(async () => ({ paymentMethodRowId: 'pm-1' })),
      }));
      const payerErr = new Error('payer billed');
      payerErr.code = 'PAYER_BILLED_GUARD';
      mockSignatureChargePrivate({ classifyChargeErrorImpl: jest.fn(() => ({ status: 'deferred', reason: 'payer_billed_guard' })) });
      const chargeInvoiceWithSavedCard = jest.fn(async () => { throw payerErr; });
      jest.doMock('../services/stripe', () => ({ chargeInvoiceWithSavedCard, quoteInvoiceSavedCardCharge: jest.fn(async () => ({ total: 249 })) }));

      const { _private } = require('../services/termite-annual-renewal-charge');
      const successor = baseSuccessor();
      const { conn, handledStampUpdate } = makeDecideConn({ successor });
      const outcome = await _private.decideAndCharge(successor, baseParent(), conn);

      expect(outcome.status).toBe('failed');
      expect(sendViaSMSAndEmail).not.toHaveBeenCalled();
      expect(notifyAdmin).toHaveBeenCalledWith('billing', expect.any(String), expect.any(String), expect.objectContaining({
        dedupeKey: 'termite-renewal-charge:succ-term-1:refused',
      }));
      // The payer guard throws before any attempt row exists — without the
      // handled marker, leg 7b would later send the HOMEOWNER a pay link for
      // the payer's AR.
      expect(handledStampUpdate).toHaveBeenCalledTimes(1);
    });

    test('a refusal whose pay-link delivery FAILED leaves leg 7b\'s marker unstamped, so 7b retries the delivery', async () => {
      mockCommon();
      mockGraceHelpers({ graceDays: 30 });
      const sendViaSMSAndEmail = jest.fn(async () => ({ ok: false, error: 'no contact on file' }));
      jest.doMock('../services/invoice', () => ({ sendViaSMSAndEmail }));
      jest.doMock('../services/notification-service', () => ({ notifyAdmin: jest.fn(async () => ({ id: 'n1' })) }));
      jest.doMock('../services/recurring-card-on-file', () => ({
        resolvePrepayChargeMethod: jest.fn(async () => ({ paymentMethodRowId: 'pm-1' })),
      }));
      const guardErr = new Error('Auto Pay is not active for this customer.');
      mockSignatureChargePrivate({ classifyChargeErrorImpl: jest.fn(() => ({ status: 'declined', reason: guardErr.message })) });
      jest.doMock('../services/stripe', () => ({
        chargeInvoiceWithSavedCard: jest.fn(async () => { throw guardErr; }),
        quoteInvoiceSavedCardCharge: jest.fn(async () => ({ total: 249 })),
      }));

      const { _private } = require('../services/termite-annual-renewal-charge');
      const successor = baseSuccessor();
      const { conn, handledStampUpdate } = makeDecideConn({ successor });
      const outcome = await _private.decideAndCharge(successor, baseParent(), conn);

      expect(outcome.status).toBe('failed');
      expect(sendViaSMSAndEmail).toHaveBeenCalledTimes(1);
      expect(handledStampUpdate).not.toHaveBeenCalled();
    });

    test('P2-3: a non-throwing charge that verifies paid -> "charged", no bell, no invoice', async () => {
      mockCommon();
      mockGraceHelpers({ graceDays: 30 });
      const sendViaSMSAndEmail = jest.fn(async () => ({ ok: true }));
      jest.doMock('../services/invoice', () => ({ sendViaSMSAndEmail }));
      const notifyAdmin = jest.fn();
      jest.doMock('../services/notification-service', () => ({ notifyAdmin }));
      jest.doMock('../services/recurring-card-on-file', () => ({
        resolvePrepayChargeMethod: jest.fn(async () => ({ paymentMethodRowId: 'pm-1' })),
      }));
      mockSignatureChargePrivate({ classifyVerifiedChargeImpl: jest.fn(() => ({ status: 'paid' })) });
      const chargeInvoiceWithSavedCard = jest.fn(async () => ({ status: 'paid' }));
      jest.doMock('../services/stripe', () => ({ chargeInvoiceWithSavedCard, quoteInvoiceSavedCardCharge: jest.fn(async () => ({ total: 249 })) }));

      const { _private } = require('../services/termite-annual-renewal-charge');
      const successor = baseSuccessor();
      const { conn } = makeDecideConn({ successor, freshInvoice: { status: 'paid', payment_method: 'card' } });
      const outcome = await _private.decideAndCharge(successor, baseParent(), conn);

      expect(outcome.status).toBe('charged');
      expect(notifyAdmin).not.toHaveBeenCalled();
      expect(sendViaSMSAndEmail).not.toHaveBeenCalled();
    });

    test('P2-3: a non-throwing charge that verifies bank ACH processing -> "pending", no bell (the webhook activates it)', async () => {
      mockCommon();
      mockGraceHelpers({ graceDays: 30 });
      jest.doMock('../services/invoice', () => ({ sendViaSMSAndEmail: jest.fn() }));
      const notifyAdmin = jest.fn();
      jest.doMock('../services/notification-service', () => ({ notifyAdmin }));
      jest.doMock('../services/recurring-card-on-file', () => ({
        resolvePrepayChargeMethod: jest.fn(async () => ({ paymentMethodRowId: 'pm-1' })),
      }));
      mockSignatureChargePrivate({ classifyVerifiedChargeImpl: jest.fn(() => ({ status: 'processing' })) });
      const chargeInvoiceWithSavedCard = jest.fn(async () => ({ status: 'processing' }));
      jest.doMock('../services/stripe', () => ({ chargeInvoiceWithSavedCard, quoteInvoiceSavedCardCharge: jest.fn(async () => ({ total: 249 })) }));

      const { _private } = require('../services/termite-annual-renewal-charge');
      const successor = baseSuccessor();
      const { conn } = makeDecideConn({ successor, freshInvoice: { status: 'processing', payment_method: 'us_bank_account' } });
      const outcome = await _private.decideAndCharge(successor, baseParent(), conn);

      expect(outcome.status).toBe('pending');
      expect(notifyAdmin).not.toHaveBeenCalled();
    });

    test('P2-3: a non-throwing charge that verifies card_incomplete/unexpected -> bells "ambiguous", never assumed successful', async () => {
      mockCommon();
      mockGraceHelpers({ graceDays: 30 });
      jest.doMock('../services/invoice', () => ({ sendViaSMSAndEmail: jest.fn() }));
      const notifyAdmin = jest.fn(async () => ({ id: 'n1' }));
      jest.doMock('../services/notification-service', () => ({ notifyAdmin }));
      jest.doMock('../services/recurring-card-on-file', () => ({
        resolvePrepayChargeMethod: jest.fn(async () => ({ paymentMethodRowId: 'pm-1' })),
      }));
      mockSignatureChargePrivate({ classifyVerifiedChargeImpl: jest.fn(() => ({ status: 'ambiguous', reason: 'card_intent_incomplete' })) });
      const chargeInvoiceWithSavedCard = jest.fn(async () => ({ status: 'processing' }));
      jest.doMock('../services/stripe', () => ({ chargeInvoiceWithSavedCard, quoteInvoiceSavedCardCharge: jest.fn(async () => ({ total: 249 })) }));

      const { _private } = require('../services/termite-annual-renewal-charge');
      const successor = baseSuccessor();
      const { conn } = makeDecideConn({ successor, freshInvoice: { status: 'processing', payment_method: 'card' } });
      const outcome = await _private.decideAndCharge(successor, baseParent(), conn);

      expect(outcome.status).toBe('ambiguous');
      expect(notifyAdmin).toHaveBeenCalledWith('billing', expect.any(String), expect.any(String), expect.objectContaining({
        dedupeKey: 'termite-renewal-charge:succ-term-1:ambiguous',
      }));
    });

    test('P2-3: a failed post-charge invoice re-read bells "ambiguous" rather than assuming either outcome', async () => {
      mockCommon();
      mockGraceHelpers({ graceDays: 30 });
      jest.doMock('../services/invoice', () => ({ sendViaSMSAndEmail: jest.fn() }));
      const notifyAdmin = jest.fn(async () => ({ id: 'n1' }));
      jest.doMock('../services/notification-service', () => ({ notifyAdmin }));
      jest.doMock('../services/recurring-card-on-file', () => ({
        resolvePrepayChargeMethod: jest.fn(async () => ({ paymentMethodRowId: 'pm-1' })),
      }));
      jest.doMock('../services/termite-annual-signature-charge', () => ({ _private: { classifyVerifiedCharge: jest.fn() } }));
      const chargeInvoiceWithSavedCard = jest.fn(async () => ({ status: 'paid' }));
      jest.doMock('../services/stripe', () => ({ chargeInvoiceWithSavedCard, quoteInvoiceSavedCardCharge: jest.fn(async () => ({ total: 249 })) }));

      const { _private } = require('../services/termite-annual-renewal-charge');
      const successor = baseSuccessor();
      const { conn } = makeDecideConn({ successor, freshInvoiceError: new Error('connection lost') });
      const outcome = await _private.decideAndCharge(successor, baseParent(), conn);

      expect(outcome.status).toBe('ambiguous');
      expect(outcome.reason).toBe('post_charge_status_unverified');
    });
  });

  // ---- P0 eligibility recheck (Codex round-1) -----------------------------

  describe('resolveChargeEligibility (Codex round-1 P0) — re-validated under lock, atomically with the fence claim', () => {
    test('a customer decline (parent renewal_decision=cancel) racing in between the mint and the charge wins — no charge, staff belled', async () => {
      mockCommon();
      const sendViaSMSAndEmail = jest.fn();
      jest.doMock('../services/invoice', () => ({ sendViaSMSAndEmail }));
      const notifyAdmin = jest.fn(async () => ({ id: 'n1' }));
      jest.doMock('../services/notification-service', () => ({ notifyAdmin }));
      jest.doMock('../services/recurring-card-on-file', () => ({
        resolvePrepayChargeMethod: jest.fn(async () => ({ paymentMethodRowId: 'pm-1' })),
      }));
      const chargeInvoiceWithSavedCard = jest.fn();
      jest.doMock('../services/stripe', () => ({ chargeInvoiceWithSavedCard, quoteInvoiceSavedCardCharge: jest.fn(async () => ({ total: 249 })) }));

      const { _private } = require('../services/termite-annual-renewal-charge');
      const successor = baseSuccessor();
      // The CALLER's own parentTerm (from the mint-candidates query, or a
      // stale recovery-leg read) still shows undecided — the fresh re-read
      // under lock is what actually catches the decline.
      const staleParent = baseParent({ renewal_decision: null });
      const declinedParent = { id: 'parent-1', renewal_decision: 'cancel' };
      const { conn } = makeDecideConn({ successor, parent: declinedParent });

      const outcome = await _private.decideAndCharge(successor, staleParent, conn);

      expect(outcome.status).toBe('ineligible');
      expect(outcome.reason).toBe('parent_decided_cancel');
      expect(chargeInvoiceWithSavedCard).not.toHaveBeenCalled();
      expect(sendViaSMSAndEmail).not.toHaveBeenCalled(); // a decline doesn't want a pay link
      expect(notifyAdmin).toHaveBeenCalledWith('billing', expect.any(String), expect.any(String), expect.objectContaining({
        dedupeKey: 'termite-renewal-charge:succ-term-1:ineligible',
      }));
    });

    // Codex round-4 P0 (parentEligibleForRenewalAction — the ALLOW-list).
    test('P0: a parent refunded/voided AFTER mint (status cancelled, renewal_decision IS NULL — the move-9 shape) racing in before the charge -> no charge, staff belled "ineligible"', async () => {
      mockCommon();
      const sendViaSMSAndEmail = jest.fn();
      jest.doMock('../services/invoice', () => ({ sendViaSMSAndEmail }));
      const notifyAdmin = jest.fn(async () => ({ id: 'n1' }));
      jest.doMock('../services/notification-service', () => ({ notifyAdmin }));
      jest.doMock('../services/recurring-card-on-file', () => ({
        resolvePrepayChargeMethod: jest.fn(async () => ({ paymentMethodRowId: 'pm-1' })),
      }));
      const chargeInvoiceWithSavedCard = jest.fn();
      jest.doMock('../services/stripe', () => ({ chargeInvoiceWithSavedCard, quoteInvoiceSavedCardCharge: jest.fn(async () => ({ total: 249 })) }));

      const { _private } = require('../services/termite-annual-renewal-charge');
      const successor = baseSuccessor();
      // The CALLER's own parentTerm still shows undecided/active (the same
      // stale-read shape a real mint-then-charge tick or a stale recovery
      // read would carry) — the fresh re-read under lock is what catches
      // the refund/void sync (NOT a decline: renewal_decision stays NULL).
      const staleParent = baseParent({ renewal_decision: null });
      const refundedParent = { id: 'parent-1', status: 'cancelled', renewal_decision: null };
      const { conn, skipStampUpdate } = makeDecideConn({ successor, parent: refundedParent });

      const outcome = await _private.decideAndCharge(successor, staleParent, conn);

      expect(outcome.status).toBe('ineligible');
      expect(outcome.reason).toBe('parent_status_cancelled');
      expect(chargeInvoiceWithSavedCard).not.toHaveBeenCalled();
      expect(sendViaSMSAndEmail).not.toHaveBeenCalled();
      expect(notifyAdmin).toHaveBeenCalledWith('billing', expect.any(String), expect.any(String), expect.objectContaining({
        dedupeKey: 'termite-renewal-charge:succ-term-1:ineligible',
      }));
      expect(skipStampUpdate).toHaveBeenCalledWith(expect.objectContaining({
        renewal_charge_skip_reason: 'ineligible:parent_status_cancelled',
      }));
    });

    // Codex #4971 round-3 P1 (item 1, chokepoint C): the parent turned
    // durably ineligible after the mint and the renewal was NEVER presented
    // (its invoice still a draft). Stamping it "skipped" used to leave a
    // payment_pending successor + open draft that no pass would ever touch
    // again (7a: skipped, 7b: never attempted, lapse: never presented) while
    // it held grace coverage and blocked new annual prepays. It is now
    // terminalized: voided through voidInvoice's requireUnsettled chokepoint
    // (whose own sync cancels the successor), no pay link, no retrieval.
    describe('item 1: a durable parent refusal on an UNPRESENTED successor retires it', () => {
      function mockRetireDeps({ voidInvoiceImpl } = {}) {
        mockGraceHelpers({ graceDays: 30 });
        const sendViaSMSAndEmail = jest.fn();
        const voidInvoice = jest.fn(voidInvoiceImpl || (async () => ({})));
        jest.doMock('../services/invoice', () => ({ sendViaSMSAndEmail, voidInvoice }));
        const notifyAdmin = jest.fn(async () => ({ id: 'n1' }));
        jest.doMock('../services/notification-service', () => ({ notifyAdmin }));
        jest.doMock('../services/recurring-card-on-file', () => ({
          resolvePrepayChargeMethod: jest.fn(async () => ({ paymentMethodRowId: 'pm-1' })),
        }));
        const chargeInvoiceWithSavedCard = jest.fn();
        jest.doMock('../services/stripe', () => ({ chargeInvoiceWithSavedCard, quoteInvoiceSavedCardCharge: jest.fn(async () => ({ total: 249 })) }));
        return { sendViaSMSAndEmail, voidInvoice, notifyAdmin, chargeInvoiceWithSavedCard };
      }

      test.each([
        ['a customer decline', { id: 'parent-1', status: 'cancelled', renewal_decision: 'cancel' }, 'parent_decided_cancel'],
        ['a refund/void cancel (move 9, no decision)', { id: 'parent-1', status: 'cancelled', renewal_decision: null }, 'parent_status_cancelled'],
        ['a switch_plan decision', { id: 'parent-1', status: 'switch_plan', renewal_decision: 'switch_plan' }, 'parent_decided_switch_plan'],
      ])('%s: voided + cancelled, never charged, never billed, never marked merely "skipped"', async (_label, decidedParent, reason) => {
        mockCommon();
        const { sendViaSMSAndEmail, voidInvoice, notifyAdmin, chargeInvoiceWithSavedCard } = mockRetireDeps();
        const { _private } = require('../services/termite-annual-renewal-charge');
        const successor = baseSuccessor();
        const { conn, skipStampUpdate } = makeDecideConn({ successor, parent: decidedParent, eligibilityInvoice: { status: 'draft' } });

        const outcome = await _private.decideAndCharge(successor, baseParent(), conn);

        expect(outcome).toEqual({ status: 'ineligible', reason, retired: 'retired' });
        expect(voidInvoice).toHaveBeenCalledWith('succ-invoice-1', { requireUnsettled: true });
        expect(chargeInvoiceWithSavedCard).not.toHaveBeenCalled();
        expect(sendViaSMSAndEmail).not.toHaveBeenCalled();
        expect(skipStampUpdate).not.toHaveBeenCalled();
        expect(notifyAdmin).toHaveBeenCalledWith('billing', expect.stringMatching(/withdrawn/i), expect.stringContaining(reason), expect.objectContaining({
          dedupeKey: 'termite-renewal-charge:succ-term-1:retired_unpresented',
        }));
      });

      test('a parent whose own invoice is in DISPUTE (payment_pending, no decision) is transient: nothing voided or skipped — deferred for leg 7a, rotated to the back', async () => {
        mockCommon();
        const { voidInvoice, chargeInvoiceWithSavedCard } = mockRetireDeps();
        const { _private } = require('../services/termite-annual-renewal-charge');
        const successor = baseSuccessor();
        const disputedParent = { id: 'parent-1', status: 'payment_pending', renewal_decision: null };
        const { conn, skipStampUpdate, deferredUpdate } = makeDecideConn({ successor, parent: disputedParent, eligibilityInvoice: { status: 'draft' } });

        const outcome = await _private.decideAndCharge(successor, baseParent(), conn);

        expect(outcome).toEqual({ status: 'deferred', reason: 'parent_status_payment_pending' });
        expect(voidInvoice).not.toHaveBeenCalled();
        expect(chargeInvoiceWithSavedCard).not.toHaveBeenCalled();
        expect(skipStampUpdate).not.toHaveBeenCalled();
        expect(deferredUpdate).toHaveBeenCalledWith({ renewal_sweep_deferred_at: expect.any(Date) });
      });

      test('the void refuses because money already settled the invoice: NOT voided, staff belled, the row marked decided', async () => {
        mockCommon();
        const settledErr = Object.assign(new Error('Invoice already reads prepaid'), { code: 'INVOICE_SETTLED_REFUSE_VOID' });
        const { notifyAdmin } = mockRetireDeps({ voidInvoiceImpl: async () => { throw settledErr; } });
        const { _private } = require('../services/termite-annual-renewal-charge');
        const successor = baseSuccessor();
        const { conn, skipStampUpdate } = makeDecideConn({
          successor, parent: { id: 'parent-1', status: 'cancelled', renewal_decision: 'cancel' }, eligibilityInvoice: { status: 'draft' },
        });

        const outcome = await _private.decideAndCharge(successor, baseParent(), conn);

        expect(outcome.retired).toBe('settled');
        expect(notifyAdmin).toHaveBeenCalledWith('billing', expect.stringMatching(/could not be withdrawn/i), expect.any(String), expect.objectContaining({
          dedupeKey: 'termite-renewal-charge:succ-term-1:retire_refused',
        }));
        expect(skipStampUpdate).toHaveBeenCalledWith(expect.objectContaining({ renewal_charge_skip_reason: 'ineligible:parent_decided_cancel' }));
      });

      test('a still-clearing void refusal is transient: not voided, not skipped, rotated for leg 7a to retry', async () => {
        mockCommon();
        const inFlight = Object.assign(new Error('processing'), { code: 'INVOICE_PROCESSING_REFUSE_VOID' });
        mockRetireDeps({ voidInvoiceImpl: async () => { throw inFlight; } });
        const { _private } = require('../services/termite-annual-renewal-charge');
        const successor = baseSuccessor();
        const { conn, skipStampUpdate, deferredUpdate } = makeDecideConn({
          successor, parent: { id: 'parent-1', status: 'cancelled', renewal_decision: 'cancel' }, eligibilityInvoice: { status: 'draft' },
        });

        const outcome = await _private.decideAndCharge(successor, baseParent(), conn);

        expect(outcome.retired).toBe('deferred');
        expect(skipStampUpdate).not.toHaveBeenCalled();
        expect(deferredUpdate).toHaveBeenCalledTimes(1);
      });

      test('the parent turns ineligible under withParentDecisionLock AFTER the fence is claimed: no Stripe call, the successor is retired', async () => {
        mockCommon();
        const { voidInvoice, chargeInvoiceWithSavedCard } = mockRetireDeps();
        const { _private } = require('../services/termite-annual-renewal-charge');
        const successor = baseSuccessor();
        const eligible = baseParent({ prepay_invoice_id: null });
        const refunded = { ...eligible, status: 'cancelled', renewal_decision: null };
        const { conn, claimUpdate } = makeDecideConn({
          successor, parent: eligible, eligibilityInvoice: { status: 'draft' }, freshInvoice: { status: 'draft' }, outerParentReads: [eligible, refunded],
        });

        const outcome = await _private.decideAndCharge(successor, baseParent(), conn);

        expect(claimUpdate).toHaveBeenCalledTimes(1);
        expect(chargeInvoiceWithSavedCard).not.toHaveBeenCalled();
        expect(outcome).toEqual({ status: 'ineligible', reason: 'parent_status_cancelled', retired: 'retired' });
        expect(voidInvoice).toHaveBeenCalledWith('succ-invoice-1', { requireUnsettled: true });
      });
    });

    test('a parent already decided "renew" (the theoretical race after this successor pays) is accepted, not refused', async () => {
      mockCommon();
      mockGraceHelpers({ graceDays: 30 });
      jest.doMock('../services/invoice', () => ({ sendViaSMSAndEmail: jest.fn() }));
      jest.doMock('../services/notification-service', () => ({ notifyAdmin: jest.fn() }));
      jest.doMock('../services/recurring-card-on-file', () => ({
        resolvePrepayChargeMethod: jest.fn(async () => ({ paymentMethodRowId: 'pm-1' })),
      }));
      mockSignatureChargePrivate({ classifyVerifiedChargeImpl: jest.fn(() => ({ status: 'paid' })) });
      const chargeInvoiceWithSavedCard = jest.fn(async () => ({ status: 'paid' }));
      jest.doMock('../services/stripe', () => ({ chargeInvoiceWithSavedCard, quoteInvoiceSavedCardCharge: jest.fn(async () => ({ total: 249 })) }));

      const { _private } = require('../services/termite-annual-renewal-charge');
      const successor = baseSuccessor();
      // Codex round-4 P0: the allow-list's 'renewed'+'renew' branch checks
      // BOTH fields (a real recordDecision('renew') writes them together
      // atomically) — no prepay_invoice_id here, so the paid-invoice gate
      // short-circuits true without an extra query.
      const renewedParent = { id: 'parent-1', status: 'renewed', renewal_decision: 'renew' };
      const { conn } = makeDecideConn({ successor, parent: renewedParent });

      const outcome = await _private.decideAndCharge(successor, baseParent(), conn);

      expect(outcome.status).toBe('charged');
    });

    test('a successor a concurrent grace-lapse tick already voided (no longer payment_pending) is ineligible', async () => {
      mockCommon();
      mockGraceHelpers({ graceDays: 30 });
      const sendViaSMSAndEmail = jest.fn();
      jest.doMock('../services/invoice', () => ({ sendViaSMSAndEmail }));
      const notifyAdmin = jest.fn(async () => ({ id: 'n1' }));
      jest.doMock('../services/notification-service', () => ({ notifyAdmin }));
      jest.doMock('../services/recurring-card-on-file', () => ({
        resolvePrepayChargeMethod: jest.fn(async () => ({ paymentMethodRowId: 'pm-1' })),
      }));
      const chargeInvoiceWithSavedCard = jest.fn();
      jest.doMock('../services/stripe', () => ({ chargeInvoiceWithSavedCard, quoteInvoiceSavedCardCharge: jest.fn(async () => ({ total: 249 })) }));

      const { _private } = require('../services/termite-annual-renewal-charge');
      const successor = baseSuccessor();
      const lapsedSuccessor = { ...successor, status: 'cancelled' };
      const { conn } = makeDecideConn({ successor: lapsedSuccessor });

      const outcome = await _private.decideAndCharge(successor, baseParent(), conn);

      expect(outcome.status).toBe('ineligible');
      expect(outcome.reason).toBe('successor_status_cancelled');
      expect(chargeInvoiceWithSavedCard).not.toHaveBeenCalled();
    });

    test('a successor past its OWN grace deadline (a long outage running the recovery leg weeks late) is ineligible — never a months-overdue charge', async () => {
      mockCommon();
      jest.doMock('../services/invoice', () => ({ sendViaSMSAndEmail: jest.fn() }));
      const notifyAdmin = jest.fn(async () => ({ id: 'n1' }));
      jest.doMock('../services/notification-service', () => ({ notifyAdmin }));
      jest.doMock('../services/recurring-card-on-file', () => ({
        resolvePrepayChargeMethod: jest.fn(async () => ({ paymentMethodRowId: 'pm-1' })),
      }));
      const chargeInvoiceWithSavedCard = jest.fn();
      jest.doMock('../services/stripe', () => ({ chargeInvoiceWithSavedCard, quoteInvoiceSavedCardCharge: jest.fn(async () => ({ total: 249 })) }));
      // A real graceDeadlineFor (not the mocked always-far-future one) so
      // "months overdue" actually computes past today.
      jest.doMock('../services/annual-prepay-renewals', () => ({
        createTermForAnnualPrepay: jest.fn(),
        recordDecision: jest.fn(),
        TERMITE_RENEWAL_GRACE_DAYS: 30,
        termiteRenewalGraceDeadlineFor: jest.fn(() => '2026-01-30'), // long past
      }));

      const { _private } = require('../services/termite-annual-renewal-charge');
      const successor = baseSuccessor({ term_start: '2026-01-01', created_at: '2026-01-01T00:00:00Z' });
      const { conn } = makeDecideConn({ successor });

      const outcome = await _private.decideAndCharge(successor, baseParent(), conn);

      expect(outcome.status).toBe('ineligible');
      expect(outcome.reason).toBe('past_grace_deadline');
      expect(chargeInvoiceWithSavedCard).not.toHaveBeenCalled();
    });

    test('a successor whose invoice was already voided/paid (but the status sync lagged) is ineligible', async () => {
      mockCommon();
      mockGraceHelpers({ graceDays: 30 });
      jest.doMock('../services/invoice', () => ({ sendViaSMSAndEmail: jest.fn() }));
      jest.doMock('../services/notification-service', () => ({ notifyAdmin: jest.fn() }));
      jest.doMock('../services/recurring-card-on-file', () => ({
        resolvePrepayChargeMethod: jest.fn(async () => ({ paymentMethodRowId: 'pm-1' })),
      }));
      const chargeInvoiceWithSavedCard = jest.fn();
      jest.doMock('../services/stripe', () => ({ chargeInvoiceWithSavedCard, quoteInvoiceSavedCardCharge: jest.fn(async () => ({ total: 249 })) }));

      const { _private } = require('../services/termite-annual-renewal-charge');
      const successor = baseSuccessor();
      const { conn } = makeDecideConn({ successor, eligibilityInvoice: { status: 'void' } });

      const outcome = await _private.decideAndCharge(successor, baseParent(), conn);

      expect(outcome.status).toBe('ineligible');
      expect(outcome.reason).toBe('invoice_void');
      expect(chargeInvoiceWithSavedCard).not.toHaveBeenCalled();
    });

    test('a lost claim race (renewal_charge_attempted_at set by a concurrent tick) returns already_attempted, not ineligible', async () => {
      mockCommon();
      mockGraceHelpers({ graceDays: 30 });
      jest.doMock('../services/invoice', () => ({ sendViaSMSAndEmail: jest.fn() }));
      const notifyAdmin = jest.fn();
      jest.doMock('../services/notification-service', () => ({ notifyAdmin }));
      jest.doMock('../services/recurring-card-on-file', () => ({
        resolvePrepayChargeMethod: jest.fn(async () => ({ paymentMethodRowId: 'pm-1' })),
      }));
      jest.doMock('../services/stripe', () => ({ chargeInvoiceWithSavedCard: jest.fn(), quoteInvoiceSavedCardCharge: jest.fn(async () => ({ total: 249 })) }));

      const { _private } = require('../services/termite-annual-renewal-charge');
      const successor = baseSuccessor();
      const raced = { ...successor, renewal_charge_attempted_at: new Date() };
      const { conn } = makeDecideConn({ successor: raced });

      const outcome = await _private.decideAndCharge(successor, baseParent(), conn);

      expect(outcome.status).toBe('already_attempted');
      expect(notifyAdmin).not.toHaveBeenCalled(); // no bell for the ordinary race — just the existing at-most-once contract
    });
  });

  // ---- grace lapse --------------------------------------------------------

  // conn('annual_prepay_terms') is called twice inside processGraceLapseForTerm
  // now: once to stamp renewal_lapse_started_at (`.where().whereNull().update()`),
  // once to stamp renewal_lapse_completed_at (`.where().update()`). Both are
  // supported on the SAME mocked `where()` return so either chain works.
  function makeLapseConn({
    startedAlreadySet = false,
    // Codex round-5 P0: resolveLapseVoidEligibility's own settlement
    // re-check transaction — a SEPARATE lock/read path from the started_at/
    // completed_at stamps below. Defaults model the happy path (successor
    // still payment_pending, no invoice row to settle) so every EXISTING
    // test in this file proceeds to void unchanged; pass overrides to
    // exercise the retirement branch.
    freshSuccessor = { status: 'payment_pending', prepay_invoice_id: null },
    freshInvoice = null,
    // Codex round-7 P1: resolveLapseVoidEligibility now ALSO re-checks the
    // PARENT (under this SAME lock, before ever voiding) when
    // freshSuccessor.renewed_from_term_id is set. Default: undecided/live
    // (the normal case) so it never blocks the happy path unless a test
    // explicitly passes a decided freshParent.
    freshParent = { status: 'active', renewal_decision: null },
    // Codex round-3 audit P1: after a recordDecision('cancel') guard-miss
    // (returns null), processGraceLapseSequence re-reads the PARENT via
    // the OUTER `conn` (not `trx` — that transaction already committed)
    // to tell "already decided 'cancel' by a prior partial run of THIS
    // SAME lapse — treat as success" apart from "decided something ELSE
    // — a genuine conflict". Default: undefined (no test exercises the
    // guard-miss re-read unless it passes this).
    parentAfterGuardMiss = undefined,
    // Codex #4971 post-push audit round-5 (item 2): processGraceLapseSequence
    // now re-verifies its own retrieval task's row exists (mirroring #4940's
    // actOnDueDeclineRetrieval) before letting the lapse complete. Default:
    // a row DOES exist, so every EXISTING test's happy path is unaffected
    // unless it explicitly passes `notificationsTaskRow: null`.
    notificationsTaskRow = { id: 'notif-1' },
    // Codex #4971 post-push audit round-6 P1 (item 1): the whereNull()
    // stamp now RETURNS the persisted renewal_lapse_started_at (knex
    // `.returning()`, rows are objects) rather than the caller fabricating
    // its own `new Date()` — this array is what `.returning()` resolves
    // to. Default: this tick's own whereNull() guard won the race, so
    // every EXISTING test's happy path is unaffected. Pass `[]` to model a
    // concurrent tick winning that race instead, alongside
    // `raceLostLapseStartedAt` for the plain re-read that follows.
    startedAtReturning = [{ renewal_lapse_started_at: new Date('2026-01-01T12:00:00Z') }],
    // The value the plain re-read (`.first('renewal_lapse_started_at')`)
    // resolves to when the whereNull() race was LOST (startedAtReturning
    // is `[]`) — the concurrent tick's own persisted stamp.
    raceLostLapseStartedAt = null,
  } = {}) {
    const startedAtReturningFn = jest.fn().mockResolvedValue(startedAtReturning);
    const startedUpdate = jest.fn(() => ({ returning: startedAtReturningFn }));
    const completedUpdate = jest.fn().mockResolvedValue(1);
    // Codex #4971 round-3 (item 4 / chokepoint D): a lapse that cannot
    // finish is either held for MANUAL REVIEW (renewal_lapse_outcome, guarded
    // on completed_at still null — excluded from the recovery scan) or
    // rotated behind newer rows (renewal_sweep_deferred_at). Neither is a
    // completion, so each has its own spy.
    const manualReviewUpdate = jest.fn().mockResolvedValue(1);
    const deferredUpdate = jest.fn().mockResolvedValue(1);
    const conn = jest.fn((table) => {
      if (table === 'notifications') {
        return { where: jest.fn(() => ({ whereRaw: jest.fn(() => ({ first: jest.fn().mockResolvedValue(notificationsTaskRow) })) })) };
      }
      if (table !== 'annual_prepay_terms') throw new Error(`unexpected table ${table}`);
      return {
        where: jest.fn(() => ({
          whereNull: jest.fn((col) => {
            if (col === 'renewal_lapse_completed_at') return { update: manualReviewUpdate };
            expect(col).toBe('renewal_lapse_started_at');
            return { update: startedUpdate };
          }),
          update: jest.fn((payload) => (payload && 'renewal_sweep_deferred_at' in payload ? deferredUpdate(payload) : completedUpdate(payload))),
          // Two DISTINCT `.where(...).first(...)` call sites share this
          // outer `conn`, told apart by the column they ask for: the
          // whereNull()-race-lost re-read asks for 'renewal_lapse_started_at'
          // on the successor; processGraceLapseSequence's own parent-
          // guard-miss re-read asks for 'renewal_decision' on the parent.
          first: jest.fn((col) => Promise.resolve(
            col === 'renewal_lapse_started_at'
              ? (raceLostLapseStartedAt == null ? null : { renewal_lapse_started_at: raceLostLapseStartedAt })
              : parentAfterGuardMiss,
          )),
        })),
      };
    });
    // Codex round-5 P0: assertNoInvoiceChargeReconciliationPending is now
    // folded INTO this same transaction (run against `trx`, not the outer
    // `conn`) — a single stable `trx` (not re-created per call) so tests
    // can assert against it directly. Codex round-7 P1: the trx's
    // `annual_prepay_terms` lookup is filter-aware — the successor's own
    // id resolves to freshSuccessor, the successor's renewed_from_term_id
    // resolves to freshParent.
    const trx = jest.fn((table) => {
      if (table === 'annual_prepay_terms') {
        return {
          where: jest.fn((filter) => ({
            forUpdate: jest.fn().mockReturnValue({
              first: jest.fn().mockResolvedValue(
                filter && freshSuccessor.renewed_from_term_id && filter.id === freshSuccessor.renewed_from_term_id
                  ? freshParent
                  : freshSuccessor,
              ),
            }),
          })),
        };
      }
      if (table === 'invoices') {
        return { where: jest.fn().mockReturnValue({ first: jest.fn().mockResolvedValue(freshInvoice) }) };
      }
      throw new Error(`unexpected table ${table} in lapse-eligibility trx`);
    });
    conn.transaction = jest.fn(async (cb) => cb(trx));
    return { conn, trx, startedUpdate, completedUpdate, manualReviewUpdate, deferredUpdate, startedAlreadySet };
  }

  function mockLapseDeps({
    voidInvoiceImpl, raiseTermiteRetrievalTaskImpl, recordDecisionImpl, assertNoInvoiceChargeReconciliationPendingImpl,
    otherLiveTermiteCoverageImpl,
  } = {}) {
    const voidInvoice = jest.fn(voidInvoiceImpl || (async () => ({})));
    jest.doMock('../services/invoice', () => ({ voidInvoice }));
    const raiseTermiteRetrievalTask = jest.fn(raiseTermiteRetrievalTaskImpl || (async () => ({ raised: true })));
    // The REAL termRetrievalDedupeKey format (a pure string formatter, no
    // DB access) — inlined rather than required, since jest.doMock below
    // replaces this exact module and a require here could race against
    // module-registry resets between tests.
    const termRetrievalDedupeKey = (termId, episodeKey, retrieveAfter) => (
      `termite_station_retrieval:term:${termId}:${episodeKey}:${retrieveAfter ? `dated:${retrieveAfter}` : 'immediate'}`
    );
    jest.doMock('../services/cancellation-processor', () => ({ raiseTermiteRetrievalTask, termRetrievalDedupeKey }));
    const recordDecision = jest.fn(recordDecisionImpl || (async () => ({ id: 'parent-1' })));
    // Codex round-7 P1 (2nd audit round): processGraceLapseForTerm now
    // wraps its whole sequence (eligibility re-check through the final
    // recordDecision('cancel')) in withParentDecisionLock — a transparent
    // pass-through here, same as mockGraceHelpers' own mock.
    const withParentDecisionLock = jest.fn((termId, fn) => fn());
    // Codex #4971 post-push audit round-6 P1 (item 2): default = no other
    // live termite coverage, so every EXISTING test's happy path reaches
    // the ordinary raise unchanged unless it explicitly passes its own
    // otherLiveTermiteCoverageImpl.
    const otherLiveTermiteCoverage = jest.fn(otherLiveTermiteCoverageImpl || (async () => null));
    jest.doMock('../services/annual-prepay-renewals', () => ({ recordDecision, withParentDecisionLock, otherLiveTermiteCoverage }));
    const assertNoInvoiceChargeReconciliationPending = jest.fn(
      assertNoInvoiceChargeReconciliationPendingImpl || (async () => undefined),
    );
    jest.doMock('../services/stripe', () => ({ assertNoInvoiceChargeReconciliationPending }));
    return {
      voidInvoice, raiseTermiteRetrievalTask, recordDecision, assertNoInvoiceChargeReconciliationPending, withParentDecisionLock, otherLiveTermiteCoverage,
    };
  }

  describe('processGraceLapseForTerm — the re-entrant lapse state machine', () => {
    test('a fresh lapse: stamps started_at, checks reconciliation, voids, raises retrieval, decides the parent, then stamps completed_at', async () => {
      mockCommon();
      const { voidInvoice, raiseTermiteRetrievalTask, recordDecision, assertNoInvoiceChargeReconciliationPending } = mockLapseDeps();
      const { conn, trx, startedUpdate, completedUpdate } = makeLapseConn({
        freshSuccessor: { status: 'payment_pending', prepay_invoice_id: 'succ-invoice-1' },
        freshInvoice: { status: 'sent', paid_at: null },
      });

      const { _private } = require('../services/termite-annual-renewal-charge');
      const term = {
        id: 'succ-term-1', customer_id: 'cust-1', prepay_invoice_id: 'succ-invoice-1', renewed_from_term_id: 'parent-1',
      };
      const outcome = await _private.processGraceLapseForTerm(term, conn);

      expect(outcome).not.toBe('deferred');
      expect(startedUpdate).toHaveBeenCalledWith(expect.objectContaining({ renewal_lapse_started_at: expect.any(Date) }));
      // Codex round-5 P0: the reconciliation check now runs INSIDE
      // resolveLapseVoidEligibility's own transaction (against `trx`, not
      // the outer `conn`) — folded into the SAME atomic re-check as the
      // settlement/status check, all under one lock.
      expect(assertNoInvoiceChargeReconciliationPending).toHaveBeenCalledWith('succ-invoice-1', trx);
      expect(voidInvoice).toHaveBeenCalledWith('succ-invoice-1', { requireUnsettled: true });
      expect(raiseTermiteRetrievalTask).toHaveBeenCalledWith('cust-1', null, expect.objectContaining({
        termId: 'succ-term-1', episodeKey: 'renewal_grace_lapse',
      }));
      expect(recordDecision).toHaveBeenCalledWith({ termId: 'parent-1', action: 'cancel', conn });
      expect(completedUpdate).toHaveBeenCalledWith(expect.objectContaining({ renewal_lapse_completed_at: expect.any(Date) }));
    });

    // Codex round-7 P1 (2nd audit round): the eligibility re-check used to
    // commit on its OWN short-lived transaction, releasing its row lock
    // BEFORE the void and retrieval ran — a renew/switch_plan decision
    // landing in that exact gap was ignored (the void/retrieval still
    // fired against a plan just decided otherwise). The WHOLE sequence
    // (eligibility re-check through the final recordDecision) must now run
    // inside withParentDecisionLock, keyed on the PARENT term — the SAME
    // dedicated-connection session lock the charge path holds across its
    // own Stripe submission, so a concurrent decision on this exact parent
    // genuinely waits behind (or is already seen by) this whole sequence.
    // The underlying lock mechanics (session lock vs a decision's xact
    // lock genuinely serializing, no self-wait on the nested
    // recordDecision('cancel') for the SAME parent) are proven against real
    // Postgres in annual-prepay-parent-decision-lock-postgres.test.js;
    // this pins the STRUCTURAL wiring: the lock wraps the eligibility
    // check + void + retrieval + decision as ONE unit, not just the
    // final write.
    test('P1: the eligibility check, void, retrieval task, and parent decision ALL run inside withParentDecisionLock, keyed on the parent', async () => {
      mockCommon();
      const {
        voidInvoice, raiseTermiteRetrievalTask, recordDecision, withParentDecisionLock,
      } = mockLapseDeps();
      const { conn } = makeLapseConn({
        freshSuccessor: { status: 'payment_pending', prepay_invoice_id: 'succ-invoice-1' },
        freshInvoice: { status: 'sent', paid_at: null },
      });

      const { _private } = require('../services/termite-annual-renewal-charge');
      const term = {
        id: 'succ-term-1', customer_id: 'cust-1', prepay_invoice_id: 'succ-invoice-1', renewed_from_term_id: 'parent-1',
      };
      const outcome = await _private.processGraceLapseForTerm(term, conn);

      expect(outcome).toBe('lapsed');
      expect(withParentDecisionLock).toHaveBeenCalledTimes(1);
      expect(withParentDecisionLock.mock.calls[0][0]).toBe('parent-1'); // the PARENT, not the successor
      // Everything the lock is supposed to cover ran — and it ran through
      // the SAME call withParentDecisionLock's mock invoked, proving they
      // are nested inside it rather than sequenced after it returns (the
      // mock is a transparent `(termId, fn) => fn()` pass-through, so this
      // also confirms the fn passed to it is the one that actually did the
      // work, not a no-op).
      expect(voidInvoice).toHaveBeenCalledWith('succ-invoice-1', { requireUnsettled: true });
      expect(raiseTermiteRetrievalTask).toHaveBeenCalledTimes(1);
      expect(recordDecision).toHaveBeenCalledWith({ termId: 'parent-1', action: 'cancel', conn });
    });

    // Codex round-5 P0: voidInvoice's own assertInvoiceVoidable deliberately
    // ALLOWS voiding a credit-settled 'prepaid' invoice (it returns the
    // applied credit) — so a renewal settled by ACCOUNT CREDIT reads to
    // voidInvoice exactly like a still-open one. resolveLapseVoidEligibility
    // must catch it on the invoice's own persisted status before the void
    // ever runs.
    test('P0: the invoice settled by account credit (status prepaid, paid_at set) BETWEEN the lapse starting and the void running — retired, never voided', async () => {
      mockCommon();
      const { voidInvoice, raiseTermiteRetrievalTask, recordDecision } = mockLapseDeps();
      const notifyAdmin = jest.fn(async () => ({ id: 'n1' }));
      jest.doMock('../services/notification-service', () => ({ notifyAdmin }));
      const { conn, startedUpdate, completedUpdate } = makeLapseConn({
        freshSuccessor: { status: 'payment_pending', prepay_invoice_id: 'succ-invoice-1' },
        freshInvoice: { status: 'prepaid', paid_at: new Date('2026-10-05T00:00:00Z') },
      });

      const { _private } = require('../services/termite-annual-renewal-charge');
      const term = {
        id: 'succ-term-1', customer_id: 'cust-1', prepay_invoice_id: 'succ-invoice-1', renewed_from_term_id: 'parent-1', prepay_amount: 249,
      };
      const outcome = await _private.processGraceLapseForTerm(term, conn);

      expect(outcome).toBe('retired');
      expect(startedUpdate).toHaveBeenCalledTimes(1); // provenance still stamped
      expect(voidInvoice).not.toHaveBeenCalled(); // NEVER voided — the credit is real money
      expect(raiseTermiteRetrievalTask).not.toHaveBeenCalled(); // no station retrieval on a paid plan
      expect(recordDecision).not.toHaveBeenCalled(); // the settlement's own sync already decided the parent
      expect(completedUpdate).toHaveBeenCalledWith(expect.objectContaining({
        renewal_lapse_completed_at: expect.any(Date), renewal_lapse_outcome: 'retired_settled',
      }));
      expect(notifyAdmin).toHaveBeenCalledWith('billing', expect.stringMatching(/retired/i), expect.stringMatching(/prepaid/), expect.objectContaining({
        dedupeKey: 'termite-renewal-charge:succ-term-1:lapse_retired_settled',
      }));
    });

    // Codex round-7 P1 (2nd audit round): an ACH renewal payment still
    // 'processing' at the grace deadline is ITSELF in
    // isInvoiceCollectibleStatus's uncollectible list (you can't attempt to
    // collect a debit that's already mid-clearing) — but that is NOT the
    // same as durably settled. Must DEFER (retry next tick), never RETIRE
    // (which would permanently drop coverage if the ACH later bounces).
    test('P1: a renewal ACH payment still "processing" at the grace deadline DEFERS — never retired, never voided', async () => {
      mockCommon();
      const { voidInvoice, raiseTermiteRetrievalTask, recordDecision } = mockLapseDeps();
      const notifyAdmin = jest.fn(async () => ({ id: 'n1' }));
      jest.doMock('../services/notification-service', () => ({ notifyAdmin }));
      const { conn, startedUpdate, completedUpdate } = makeLapseConn({
        freshSuccessor: { status: 'payment_pending', prepay_invoice_id: 'succ-invoice-1' },
        freshInvoice: { status: 'processing', paid_at: null },
      });

      const { _private } = require('../services/termite-annual-renewal-charge');
      const term = {
        id: 'succ-term-1', customer_id: 'cust-1', prepay_invoice_id: 'succ-invoice-1', renewed_from_term_id: 'parent-1', prepay_amount: 249,
      };
      const outcome = await _private.processGraceLapseForTerm(term, conn);

      expect(outcome).toBe('deferred');
      expect(startedUpdate).toHaveBeenCalledTimes(1); // provenance still stamped
      expect(voidInvoice).not.toHaveBeenCalled(); // ACH could still bounce — never void a possibly-owed plan
      expect(raiseTermiteRetrievalTask).not.toHaveBeenCalled();
      expect(recordDecision).not.toHaveBeenCalled();
      expect(completedUpdate).not.toHaveBeenCalled(); // stays started-but-not-completed, retried next tick
      expect(notifyAdmin).toHaveBeenCalledWith('billing', expect.any(String), expect.stringMatching(/processing/), expect.objectContaining({
        dedupeKey: 'termite-renewal-charge:succ-term-1:lapse_reconciliation_pending',
      }));
    });

    // Codex round-5 P0: a card payment landing in the gap between the lapse
    // starting and the void actually running — decideAndCharge succeeded
    // concurrently, flipping the successor itself to 'active' via the real
    // payment sync. Caught on the successor's OWN fresh status, distinct
    // from the credit-settlement case above (which the successor's status
    // alone would NOT catch, since credit settlement doesn't necessarily
    // sync the term).
    test('P0: a card payment landed between the lapse starting and the void running (successor already active) — retired, never voided', async () => {
      mockCommon();
      const { voidInvoice, raiseTermiteRetrievalTask, recordDecision } = mockLapseDeps();
      jest.doMock('../services/notification-service', () => ({ notifyAdmin: jest.fn(async () => ({ id: 'n1' })) }));
      const { conn, completedUpdate } = makeLapseConn({
        freshSuccessor: { status: 'active', prepay_invoice_id: 'succ-invoice-1' },
      });

      const { _private } = require('../services/termite-annual-renewal-charge');
      const term = { id: 'succ-term-1', customer_id: 'cust-1', prepay_invoice_id: 'succ-invoice-1', renewed_from_term_id: 'parent-1', prepay_amount: 249 };
      const outcome = await _private.processGraceLapseForTerm(term, conn);

      expect(outcome).toBe('retired');
      expect(voidInvoice).not.toHaveBeenCalled();
      expect(raiseTermiteRetrievalTask).not.toHaveBeenCalled();
      expect(recordDecision).not.toHaveBeenCalled();
      expect(completedUpdate).toHaveBeenCalledWith(expect.objectContaining({ renewal_lapse_outcome: 'retired_settled' }));
    });

    // Codex round-7 P1 (item 5): a crash right AFTER voidInvoice's own sync
    // flips the successor to 'cancelled' (move 9, renewal_decision IS
    // NULL) — but BEFORE retrieval/the parent decision ran — must CONTINUE
    // the sequence (voidInvoice self-heals as a no-op, then retrieval +
    // parent decision + complete), never be misread as "settled by
    // something else" and retired with the retrieval/decision skipped.
    test('P1: a crash after voidInvoice committed (successor cancelled, invoice void, renewal_decision NULL) resumes and completes — never retired', async () => {
      mockCommon();
      const { voidInvoice, raiseTermiteRetrievalTask, recordDecision } = mockLapseDeps();
      jest.doMock('../services/notification-service', () => ({ notifyAdmin: jest.fn(async () => ({ id: 'n1' })) }));
      const { conn, completedUpdate } = makeLapseConn({
        // The void already ran (a prior tick, or this same one before the
        // crash): successor is 'cancelled' with NO decision recorded yet
        // (move 9's shape), and its invoice already reads 'void'.
        freshSuccessor: { status: 'cancelled', renewal_decision: null, prepay_invoice_id: 'succ-invoice-1' },
        freshInvoice: { status: 'void', paid_at: null },
      });

      const { _private } = require('../services/termite-annual-renewal-charge');
      const term = {
        id: 'succ-term-1', customer_id: 'cust-1', prepay_invoice_id: 'succ-invoice-1', renewed_from_term_id: 'parent-1', prepay_amount: 249,
        renewal_lapse_started_at: new Date('2026-10-01T00:00:00Z'), // this pass already started it
      };
      const outcome = await _private.processGraceLapseForTerm(term, conn);

      expect(outcome).toBe('lapsed');
      // voidInvoice's own re-entry self-heals as a no-op — still called.
      expect(voidInvoice).toHaveBeenCalledWith('succ-invoice-1', { requireUnsettled: true });
      expect(raiseTermiteRetrievalTask).toHaveBeenCalledTimes(1);
      expect(recordDecision).toHaveBeenCalledWith({ termId: 'parent-1', action: 'cancel', conn });
      expect(completedUpdate).toHaveBeenCalledWith(expect.objectContaining({
        renewal_lapse_completed_at: expect.any(Date), renewal_lapse_outcome: 'lapsed',
      }));
    });

    // Codex round-7 P1 (item 3): recordDecision('cancel') returns null
    // (never throws) when an operator already recorded 'renew' or
    // 'switch_plan' on the parent — the OLD code only watched for a
    // THROWN error, so the lapse would still complete (voidInvoice +
    // retrieval already ran) against a plan the operator just renewed.
    // resolveLapseVoidEligibility's own parent re-check (under the SAME
    // lock, BEFORE the void) must catch this and defer instead.
    test('P1: the parent was already decided \'renew\' by an operator — deferred, NO void, NO retrieval', async () => {
      mockCommon();
      const { voidInvoice, raiseTermiteRetrievalTask, recordDecision } = mockLapseDeps();
      const notifyAdmin = jest.fn(async () => ({ id: 'n1' }));
      jest.doMock('../services/notification-service', () => ({ notifyAdmin }));
      const { conn, startedUpdate, completedUpdate, manualReviewUpdate, deferredUpdate } = makeLapseConn({
        freshSuccessor: { status: 'payment_pending', prepay_invoice_id: 'succ-invoice-1', renewed_from_term_id: 'parent-1' },
        freshInvoice: { status: 'sent', paid_at: null },
        freshParent: { status: 'renewed', renewal_decision: 'renew' },
      });

      const { _private } = require('../services/termite-annual-renewal-charge');
      const term = {
        id: 'succ-term-1', customer_id: 'cust-1', prepay_invoice_id: 'succ-invoice-1', renewed_from_term_id: 'parent-1', prepay_amount: 249,
      };
      const outcome = await _private.processGraceLapseForTerm(term, conn);

      expect(outcome).toBe('deferred');
      expect(startedUpdate).toHaveBeenCalledTimes(1); // provenance stamped regardless
      expect(voidInvoice).not.toHaveBeenCalled(); // NEVER voided against an already-decided parent
      expect(raiseTermiteRetrievalTask).not.toHaveBeenCalled();
      expect(recordDecision).not.toHaveBeenCalled();
      expect(completedUpdate).not.toHaveBeenCalled(); // stays started-but-not-completed, for a human to resolve
      expect(notifyAdmin).toHaveBeenCalledWith('billing', expect.stringMatching(/already decided/i), expect.stringMatching(/renew/), expect.objectContaining({
        dedupeKey: 'termite-renewal-charge:succ-term-1:lapse_parent_decided_elsewhere',
      }));
      // Codex #4971 round-3 P2 (item 4): a human decision is needed — held
      // as MANUAL REVIEW, which the recovery scan excludes, so a backlog of
      // these can never pin its bounded page. Not a rotation deferral.
      expect(manualReviewUpdate).toHaveBeenCalledWith({ renewal_lapse_outcome: 'manual_review' });
      expect(deferredUpdate).not.toHaveBeenCalled();
    });

    // Codex round-2 P0.
    test('P0: a pending charge reconciliation FAILS CLOSED — no void, a bell, started_at stamped but NOT completed_at, retried later', async () => {
      mockCommon();
      const reconErr = new Error('Invoice already has a saved-card charge in progress or awaiting reconciliation');
      const { voidInvoice, raiseTermiteRetrievalTask, recordDecision } = mockLapseDeps({
        assertNoInvoiceChargeReconciliationPendingImpl: async () => { throw reconErr; },
      });
      const notifyAdmin = jest.fn(async () => ({ id: 'n1' }));
      jest.doMock('../services/notification-service', () => ({ notifyAdmin }));
      const { conn, startedUpdate, completedUpdate, manualReviewUpdate, deferredUpdate } = makeLapseConn({
        freshSuccessor: { status: 'payment_pending', prepay_invoice_id: 'succ-invoice-1' },
        freshInvoice: { status: 'sent', paid_at: null },
      });

      const { _private } = require('../services/termite-annual-renewal-charge');
      const term = {
        id: 'succ-term-1', customer_id: 'cust-1', prepay_invoice_id: 'succ-invoice-1', renewed_from_term_id: 'parent-1', prepay_amount: 249,
      };
      const outcome = await _private.processGraceLapseForTerm(term, conn);

      expect(outcome).toBe('deferred');
      // Self-clearing: rotated behind rows the recovery scan has not
      // retried yet (item 4), never parked as manual review.
      expect(deferredUpdate).toHaveBeenCalledWith({ renewal_sweep_deferred_at: expect.any(Date) });
      expect(manualReviewUpdate).not.toHaveBeenCalled();
      expect(startedUpdate).toHaveBeenCalledTimes(1); // provenance stamped regardless
      expect(voidInvoice).not.toHaveBeenCalled(); // NEVER voided while reconciliation is pending
      expect(raiseTermiteRetrievalTask).not.toHaveBeenCalled();
      expect(recordDecision).not.toHaveBeenCalled();
      expect(completedUpdate).not.toHaveBeenCalled(); // stays started-but-not-completed
      expect(notifyAdmin).toHaveBeenCalledWith('billing', expect.stringMatching(/reconciliation/i), expect.any(String), expect.objectContaining({
        dedupeKey: 'termite-renewal-charge:succ-term-1:lapse_reconciliation_pending',
      }));
    });

    // Codex #4971 round-4 (post-merge audit) P1: a PARTIAL account credit
    // landing on the invoice between the eligibility re-check and the void
    // itself (invoice.js's assertInvoiceGenuinelyUnsettledLocked, at the
    // actual chokepoint) is neither full settlement (retire) nor a clean
    // void (some money is already committed) — must DEFER, same shape as
    // the reconciliation-pending case above, never silently retire a lapse
    // whose renewal the customer only partly paid.
    test('P1: partial account credit lands on the invoice at the void chokepoint — DEFERRED, never retired, never voided a second way', async () => {
      mockCommon();
      const partialCreditErr = new Error('Invoice carries partial account credit ($10.00 of $249.00)');
      partialCreditErr.code = 'INVOICE_PARTIAL_CREDIT_REFUSE_VOID';
      const { voidInvoice, raiseTermiteRetrievalTask, recordDecision } = mockLapseDeps({
        voidInvoiceImpl: async () => { throw partialCreditErr; },
      });
      const notifyAdmin = jest.fn(async () => ({ id: 'n1' }));
      jest.doMock('../services/notification-service', () => ({ notifyAdmin }));
      const { conn, startedUpdate, completedUpdate, manualReviewUpdate } = makeLapseConn({
        freshSuccessor: { status: 'payment_pending', prepay_invoice_id: 'succ-invoice-1' },
        freshInvoice: { status: 'sent', paid_at: null },
      });

      const { _private } = require('../services/termite-annual-renewal-charge');
      const term = {
        id: 'succ-term-1', customer_id: 'cust-1', prepay_invoice_id: 'succ-invoice-1', renewed_from_term_id: 'parent-1', prepay_amount: 249,
      };
      const outcome = await _private.processGraceLapseForTerm(term, conn);

      expect(outcome).toBe('deferred');
      // A partial credit never clears on its own — MANUAL REVIEW (item 4),
      // excluded from the recovery scan instead of re-run every tick.
      expect(manualReviewUpdate).toHaveBeenCalledWith({ renewal_lapse_outcome: 'manual_review' });
      expect(startedUpdate).toHaveBeenCalledTimes(1); // provenance stamped regardless
      expect(voidInvoice).toHaveBeenCalledWith('succ-invoice-1', { requireUnsettled: true });
      expect(raiseTermiteRetrievalTask).not.toHaveBeenCalled(); // never treated as a genuine non-payment lapse
      expect(recordDecision).not.toHaveBeenCalled(); // parent never cancelled — the partial payment is real money
      expect(completedUpdate).not.toHaveBeenCalled(); // stays started-but-not-completed, for staff to resolve
      expect(notifyAdmin).toHaveBeenCalledWith('billing', expect.any(String), expect.stringMatching(/partial account credit/), expect.objectContaining({
        dedupeKey: 'termite-renewal-charge:succ-term-1:lapse_reconciliation_pending',
      }));
    });

    test('a resumed lapse (started_at already set) does NOT re-stamp started_at, but still runs the rest', async () => {
      mockCommon();
      const { voidInvoice, raiseTermiteRetrievalTask, recordDecision } = mockLapseDeps();
      const { conn, startedUpdate, completedUpdate } = makeLapseConn();

      const { _private } = require('../services/termite-annual-renewal-charge');
      const term = {
        id: 'succ-term-1', customer_id: 'cust-1', prepay_invoice_id: 'succ-invoice-1', renewed_from_term_id: 'parent-1',
        renewal_lapse_started_at: new Date('2026-10-01T00:00:00Z'), // crash after start, before void — resuming
      };
      await _private.processGraceLapseForTerm(term, conn);

      expect(startedUpdate).not.toHaveBeenCalled();
      // voidInvoice self-heals on re-entry — still called even resuming after
      // a crash between the void and the retrieval task.
      expect(voidInvoice).toHaveBeenCalledWith('succ-invoice-1', { requireUnsettled: true });
      expect(raiseTermiteRetrievalTask).toHaveBeenCalledTimes(1);
      expect(recordDecision).toHaveBeenCalledTimes(1);
      expect(completedUpdate).toHaveBeenCalledTimes(1);
    });

    // Codex #4971 post-push audit round-5 (item 2): a request-less raise
    // (the portal has no service request behind it) needs eventAt to place
    // itself correctly in the account's retrieval chronology — #4940's own
    // raiseTermiteRetrievalTask ranks a request-less raise as the OLDEST
    // event without it, yielding to any earlier request-keyed row even one
    // staff already acted on.
    test('P1 (item 2): the retrieval raise passes eventAt = this lapse\'s own renewal_lapse_started_at', async () => {
      mockCommon();
      const { raiseTermiteRetrievalTask } = mockLapseDeps();
      const { conn } = makeLapseConn();

      const { _private } = require('../services/termite-annual-renewal-charge');
      const startedAt = new Date('2026-10-01T00:00:00Z');
      const term = {
        id: 'succ-term-1', customer_id: 'cust-1', prepay_invoice_id: 'succ-invoice-1', renewed_from_term_id: 'parent-1',
        renewal_lapse_started_at: startedAt,
      };
      await _private.processGraceLapseForTerm(term, conn);

      expect(raiseTermiteRetrievalTask).toHaveBeenCalledWith('cust-1', null, expect.objectContaining({
        termId: 'succ-term-1', episodeKey: 'renewal_grace_lapse', eventAt: startedAt,
      }));
    });

    // Codex #4971 post-push audit round-6 P1 (item 1): a FRESH lapse (no
    // renewal_lapse_started_at yet) used to pass eventAt=null down to the
    // retrieval raise — the in-memory `term` never picked up the value the
    // whereNull() stamp just persisted. eventAt must equal that persisted
    // stamp, never null and never a second, independently-fabricated Date.
    test('P1 (item 1): a FRESH lapse\'s retrieval raise gets eventAt = the just-persisted stamp, never null', async () => {
      mockCommon();
      const { raiseTermiteRetrievalTask } = mockLapseDeps();
      const stampedAt = new Date('2026-09-01T08:00:00Z');
      const { conn } = makeLapseConn({ startedAtReturning: [{ renewal_lapse_started_at: stampedAt }] });

      const { _private } = require('../services/termite-annual-renewal-charge');
      const term = {
        id: 'succ-term-1', customer_id: 'cust-1', prepay_invoice_id: 'succ-invoice-1', renewed_from_term_id: 'parent-1',
      };
      await _private.processGraceLapseForTerm(term, conn);

      const call = raiseTermiteRetrievalTask.mock.calls[0];
      expect(call[2].eventAt).not.toBeNull();
      expect(call[2].eventAt).toEqual(stampedAt);
    });

    // Codex #4971 post-push audit round-6 P1 (item 1): when a CONCURRENT
    // tick's own whereNull() guard already won the race (this tick's
    // update affects 0 rows, .returning() comes back empty), the code
    // falls back to a plain re-read of the persisted value rather than
    // treating it as unset — the retrieval raise still gets the REAL
    // first-detected time, never null.
    test('P1 (item 1): the whereNull() race lost to a concurrent tick — re-reads the persisted stamp', async () => {
      mockCommon();
      const { raiseTermiteRetrievalTask } = mockLapseDeps();
      const concurrentStampedAt = new Date('2026-09-02T09:30:00Z');
      const { conn } = makeLapseConn({
        startedAtReturning: [],
        raceLostLapseStartedAt: concurrentStampedAt,
      });

      const { _private } = require('../services/termite-annual-renewal-charge');
      const term = {
        id: 'succ-term-1', customer_id: 'cust-1', prepay_invoice_id: 'succ-invoice-1', renewed_from_term_id: 'parent-1',
      };
      const outcome = await _private.processGraceLapseForTerm(term, conn);

      expect(outcome).not.toBe('deferred');
      const call = raiseTermiteRetrievalTask.mock.calls[0];
      expect(call[2].eventAt).toEqual(concurrentStampedAt);
    });

    // Codex #4971 post-push audit round-6 P1 (item 2): raiseTermiteRetrievalTask
    // counts EVERY Waves-owned termite station on the ACCOUNT — an
    // account-wide task is only safe when this lapsed plan is the
    // account's ONLY live termite coverage. With other coverage on file,
    // no automatic task may be raised; staff are belled to confirm which
    // stations belong to THIS lapsed plan instead.
    test('P1 (item 2): other live termite coverage on file — no automatic retrieval task, staff belled instead', async () => {
      mockCommon();
      const notifyAdmin = jest.fn(async () => ({ id: 'n1', deduped: false, suppressed: false }));
      jest.doMock('../services/notification-service', () => ({ notifyAdmin }));
      const { raiseTermiteRetrievalTask, recordDecision } = mockLapseDeps({
        otherLiveTermiteCoverageImpl: async () => 'other_termite_plan',
      });
      const { conn, completedUpdate } = makeLapseConn();

      const { _private } = require('../services/termite-annual-renewal-charge');
      const term = {
        id: 'succ-term-1', customer_id: 'cust-1', prepay_invoice_id: 'succ-invoice-1', renewed_from_term_id: 'parent-1',
        renewal_lapse_started_at: new Date('2026-10-01T00:00:00Z'),
      };
      const outcome = await _private.processGraceLapseForTerm(term, conn);

      expect(outcome).toBe('lapsed');
      expect(raiseTermiteRetrievalTask).not.toHaveBeenCalled();
      expect(notifyAdmin).toHaveBeenCalledWith('billing', expect.any(String), expect.stringMatching(/other_termite_plan/), expect.objectContaining({
        dedupeKey: 'termite-renewal-charge:succ-term-1:lapse_retrieval_other_coverage',
      }));
      expect(recordDecision).toHaveBeenCalledTimes(1); // still decides the parent — the bell persisted
      expect(completedUpdate).toHaveBeenCalledWith(expect.objectContaining({ renewal_lapse_completed_at: expect.any(Date) }));
    });

    // The SAME other-coverage guard, but the confirmation bell itself
    // fails to persist (notifyAdmin returns null) — staff were never
    // actually told, so this lapse must stay retryable, never marked
    // complete, and the parent must never be decided on an unconfirmed
    // outcome.
    test('P1 (item 2): other coverage on file, but the confirmation bell fails to persist — stays deferred, never completes', async () => {
      mockCommon();
      jest.doMock('../services/notification-service', () => ({ notifyAdmin: jest.fn(async () => null) }));
      const { raiseTermiteRetrievalTask, recordDecision } = mockLapseDeps({
        otherLiveTermiteCoverageImpl: async () => 'termite_bond',
      });
      const { conn, completedUpdate } = makeLapseConn();

      const { _private } = require('../services/termite-annual-renewal-charge');
      const term = {
        id: 'succ-term-1', customer_id: 'cust-1', prepay_invoice_id: 'succ-invoice-1', renewed_from_term_id: 'parent-1',
        renewal_lapse_started_at: new Date('2026-10-01T00:00:00Z'),
      };
      const outcome = await _private.processGraceLapseForTerm(term, conn);

      expect(outcome).toBe('deferred');
      expect(raiseTermiteRetrievalTask).not.toHaveBeenCalled();
      expect(recordDecision).not.toHaveBeenCalled();
      expect(completedUpdate).not.toHaveBeenCalled();
    });

    // A newer retrieval instruction already stands on the account —
    // nothing was raised or reopened for THIS lapse. Confirming the bell
    // itself persists lets the lapse proceed to complete anyway (staff
    // have now been told to check the newer instruction).
    test('P1 (item 2): supersededByNewer, confirmation bell persists — the lapse still completes', async () => {
      mockCommon();
      const notifyAdmin = jest.fn(async () => ({ id: 'n1', deduped: false, suppressed: false }));
      jest.doMock('../services/notification-service', () => ({ notifyAdmin }));
      const { recordDecision } = mockLapseDeps({
        raiseTermiteRetrievalTaskImpl: async () => ({ raised: true, supersededByNewer: 'req-42' }),
      });
      const { conn, completedUpdate } = makeLapseConn();

      const { _private } = require('../services/termite-annual-renewal-charge');
      const term = {
        id: 'succ-term-1', customer_id: 'cust-1', prepay_invoice_id: 'succ-invoice-1', renewed_from_term_id: 'parent-1',
        renewal_lapse_started_at: new Date('2026-10-01T00:00:00Z'),
      };
      const outcome = await _private.processGraceLapseForTerm(term, conn);

      expect(outcome).toBe('lapsed');
      expect(notifyAdmin).toHaveBeenCalledWith('billing', expect.any(String), expect.stringMatching(/req-42/), expect.objectContaining({
        dedupeKey: 'termite-renewal-charge:succ-term-1:lapse_retrieval_superseded',
      }));
      expect(recordDecision).toHaveBeenCalledTimes(1); // still decides the parent
      expect(completedUpdate).toHaveBeenCalledWith(expect.objectContaining({ renewal_lapse_completed_at: expect.any(Date) }));
    });

    // The SAME supersession, but the confirmation bell itself fails to
    // persist (notifyAdmin returns null) — staff were never actually told,
    // so this lapse must stay retryable, never marked complete.
    test('P1 (item 2): supersededByNewer, confirmation bell fails to persist — stays deferred, never completes', async () => {
      mockCommon();
      jest.doMock('../services/notification-service', () => ({ notifyAdmin: jest.fn(async () => null) }));
      const { recordDecision } = mockLapseDeps({
        raiseTermiteRetrievalTaskImpl: async () => ({ raised: true, supersededByNewer: 'req-42' }),
      });
      const { conn, completedUpdate } = makeLapseConn();

      const { _private } = require('../services/termite-annual-renewal-charge');
      const term = {
        id: 'succ-term-1', customer_id: 'cust-1', prepay_invoice_id: 'succ-invoice-1', renewed_from_term_id: 'parent-1',
        renewal_lapse_started_at: new Date('2026-10-01T00:00:00Z'),
      };
      const outcome = await _private.processGraceLapseForTerm(term, conn);

      expect(outcome).toBe('deferred');
      expect(recordDecision).not.toHaveBeenCalled(); // never decides the parent on an unconfirmed supersession
      expect(completedUpdate).not.toHaveBeenCalled();
    });

    // Mirrors #4940's own actOnDueDeclineRetrieval verification: an
    // ordinary "raised: true" is not itself proof — this lapse's own task
    // row must actually exist in `notifications` before the lapse may
    // complete. A missing row (a replication lag, or a genuinely lost
    // insert the caller's own try/catch swallowed) must not silently pass.
    test('P1 (item 2): raised true but this lapse\'s own task row is missing — stays deferred, never completes', async () => {
      mockCommon();
      const { recordDecision } = mockLapseDeps({
        raiseTermiteRetrievalTaskImpl: async () => ({ raised: true }),
      });
      const { conn, completedUpdate } = makeLapseConn({ notificationsTaskRow: null });

      const { _private } = require('../services/termite-annual-renewal-charge');
      const term = {
        id: 'succ-term-1', customer_id: 'cust-1', prepay_invoice_id: 'succ-invoice-1', renewed_from_term_id: 'parent-1',
        renewal_lapse_started_at: new Date('2026-10-01T00:00:00Z'),
      };
      const outcome = await _private.processGraceLapseForTerm(term, conn);

      expect(outcome).toBe('deferred');
      expect(recordDecision).not.toHaveBeenCalled();
      expect(completedUpdate).not.toHaveBeenCalled();
    });

    // A term with no rented stations at all (raised: false, reason:
    // 'no_rented_stations') needs no task-row verification — there is
    // nothing to verify, and this must complete exactly as before.
    test('P1 (item 2): no rented stations at all — needs no task-row check, still completes normally', async () => {
      mockCommon();
      const { recordDecision } = mockLapseDeps({
        raiseTermiteRetrievalTaskImpl: async () => ({ raised: false, reason: 'no_rented_stations' }),
      });
      const { conn, completedUpdate } = makeLapseConn({ notificationsTaskRow: null });

      const { _private } = require('../services/termite-annual-renewal-charge');
      const term = {
        id: 'succ-term-1', customer_id: 'cust-1', prepay_invoice_id: 'succ-invoice-1', renewed_from_term_id: 'parent-1',
        renewal_lapse_started_at: new Date('2026-10-01T00:00:00Z'),
      };
      const outcome = await _private.processGraceLapseForTerm(term, conn);

      expect(outcome).toBe('lapsed');
      expect(recordDecision).toHaveBeenCalledTimes(1);
      expect(completedUpdate).toHaveBeenCalledWith(expect.objectContaining({ renewal_lapse_completed_at: expect.any(Date) }));
    });

    test('a term with no prepay_invoice_id skips the reconciliation check and the void, but still raises retrieval + decides the parent', async () => {
      mockCommon();
      const { voidInvoice, raiseTermiteRetrievalTask, recordDecision, assertNoInvoiceChargeReconciliationPending } = mockLapseDeps();
      const { conn, completedUpdate } = makeLapseConn();

      const { _private } = require('../services/termite-annual-renewal-charge');
      const term = { id: 'succ-term-1', customer_id: 'cust-1', prepay_invoice_id: null, renewed_from_term_id: 'parent-1' };
      await _private.processGraceLapseForTerm(term, conn);

      expect(assertNoInvoiceChargeReconciliationPending).not.toHaveBeenCalled();
      expect(voidInvoice).not.toHaveBeenCalled();
      expect(raiseTermiteRetrievalTask).toHaveBeenCalledTimes(1);
      expect(recordDecision).toHaveBeenCalledTimes(1);
      expect(completedUpdate).toHaveBeenCalledTimes(1);
    });

    test('a lapse-stamp failure on the parent is best-effort, never throws, but leaves completed_at unstamped so it retries', async () => {
      mockCommon();
      const { completedUpdate, conn } = makeLapseConn();
      mockLapseDeps({ recordDecisionImpl: async () => { throw new Error('db down'); } });

      const { _private } = require('../services/termite-annual-renewal-charge');
      const term = { id: 'succ-term-1', customer_id: 'cust-1', prepay_invoice_id: 'succ-invoice-1', renewed_from_term_id: 'parent-1' };
      await expect(_private.processGraceLapseForTerm(term, conn)).resolves.not.toThrow();
      expect(completedUpdate).not.toHaveBeenCalled();
    });

    // Codex round-3 audit P1: a crash right after recordDecision('cancel')
    // COMMITS but BEFORE renewal_lapse_completed_at is stamped leaves this
    // successor started-but-never-completed. On retry, recordDecision's
    // OWN guard (`renewal_decision IS NULL`) correctly returns null again
    // — the decision is already there — but the OLD code treated ANY
    // guard-miss as "decided elsewhere, never complete", permanently
    // stuck. Verifying the parent ALREADY reads 'cancel' distinguishes
    // this resume from a genuine conflict (renew/switch_plan elsewhere)
    // and completes the lapse.
    test('P1: resume after a crash between recordDecision(\'cancel\') committing and completed_at — the parent already reads \'cancel\', so this completes instead of getting stuck forever', async () => {
      mockCommon();
      const { voidInvoice, raiseTermiteRetrievalTask, recordDecision } = mockLapseDeps({
        recordDecisionImpl: async () => null, // guard-miss: renewal_decision is already non-null
      });
      jest.doMock('../services/notification-service', () => ({ notifyAdmin: jest.fn(async () => ({ id: 'n1' })) }));
      const { conn, completedUpdate } = makeLapseConn({
        freshSuccessor: { status: 'payment_pending', prepay_invoice_id: 'succ-invoice-1' },
        freshInvoice: { status: 'sent', paid_at: null },
        parentAfterGuardMiss: { renewal_decision: 'cancel' }, // THIS same lapse's own prior partial run
      });

      const { _private } = require('../services/termite-annual-renewal-charge');
      const term = {
        id: 'succ-term-1', customer_id: 'cust-1', prepay_invoice_id: 'succ-invoice-1', renewed_from_term_id: 'parent-1',
      };
      const outcome = await _private.processGraceLapseForTerm(term, conn);

      expect(outcome).toBe('lapsed'); // completes, not stuck
      expect(voidInvoice).toHaveBeenCalledTimes(1);
      expect(raiseTermiteRetrievalTask).toHaveBeenCalledTimes(1);
      expect(recordDecision).toHaveBeenCalledWith({ termId: 'parent-1', action: 'cancel', conn });
      expect(completedUpdate).toHaveBeenCalledWith(expect.objectContaining({
        renewal_lapse_completed_at: expect.any(Date), renewal_lapse_outcome: 'lapsed',
      }));
    });

    // The genuine conflict this must still catch: the parent was decided
    // something ELSE (never 'cancel') in the gap — never complete.
    test('P1: a guard-miss where the parent was decided \'renew\' elsewhere (never \'cancel\') stays incomplete, never stuck-but-silently-succeeding', async () => {
      mockCommon();
      const { voidInvoice, raiseTermiteRetrievalTask, recordDecision } = mockLapseDeps({
        recordDecisionImpl: async () => null,
      });
      jest.doMock('../services/notification-service', () => ({ notifyAdmin: jest.fn(async () => ({ id: 'n1' })) }));
      const { conn, completedUpdate, deferredUpdate } = makeLapseConn({
        freshSuccessor: { status: 'payment_pending', prepay_invoice_id: 'succ-invoice-1' },
        freshInvoice: { status: 'sent', paid_at: null },
        parentAfterGuardMiss: { renewal_decision: 'renew' }, // a genuine conflict
      });

      const { _private } = require('../services/termite-annual-renewal-charge');
      const term = {
        id: 'succ-term-1', customer_id: 'cust-1', prepay_invoice_id: 'succ-invoice-1', renewed_from_term_id: 'parent-1',
      };
      const outcome = await _private.processGraceLapseForTerm(term, conn);

      // Codex #4971 round-3 (item 4): reported as deferred (it used to read
      // 'lapsed' while never completing) and rotated behind newer rows.
      expect(outcome).toBe('deferred');
      expect(voidInvoice).toHaveBeenCalledTimes(1);
      expect(raiseTermiteRetrievalTask).toHaveBeenCalledTimes(1);
      expect(recordDecision).toHaveBeenCalledWith({ termId: 'parent-1', action: 'cancel', conn });
      // completed_at is NEVER stamped — the row stays retryable rather than
      // being marked "done" against a parent decided renew.
      expect(completedUpdate).not.toHaveBeenCalled();
      expect(deferredUpdate).toHaveBeenCalledWith({ renewal_sweep_deferred_at: expect.any(Date) });
    });
  });

  describe('reconcileMissedLapseEffects (Codex round-1/2 P1) — recoverable post-void lapse effects', () => {
    function tableQuery(rows) {
      const q = {};
      const chain = ['whereNotNull', 'whereNull', 'where', 'whereRaw', 'orderBy', 'orderByRaw', 'limit', 'select'];
      for (const m of chain) q[m] = jest.fn(() => q);
      q.then = (resolve, reject) => Promise.resolve(rows).then(resolve, reject);
      return q;
    }

    // Codex round-2 P1: the query is keyed EXCLUSIVELY on the persisted
    // provenance columns — never inferred from status.
    test('the scan filters on renewal_lapse_started_at IS NOT NULL AND renewal_lapse_completed_at IS NULL — never on status', async () => {
      mockCommon();
      const scanQ = tableQuery([]);
      const conn = jest.fn((table) => {
        if (table === 'annual_prepay_terms as t') return scanQ;
        throw new Error(`unexpected table ${table}`);
      });

      const { _private } = require('../services/termite-annual-renewal-charge');
      await _private.reconcileMissedLapseEffects({ conn, limit: 200, counts: { lapseEffectsScanned: 0, lapseEffectsReconciled: 0, graceReconciliationDeferred: 0 } });

      expect(scanQ.whereNotNull).toHaveBeenCalledWith('t.renewal_lapse_started_at');
      expect(scanQ.whereNull).toHaveBeenCalledWith('t.renewal_lapse_completed_at');
      // Never filters on status at all — a staff-voided (or dispute-lost, or
      // flag-removed) successor with NO renewal_lapse_started_at is excluded
      // by the whereNotNull above, regardless of its status.
      expect(scanQ.where).not.toHaveBeenCalled();
      // Codex #4971 round-3 P2 (item 4): a manual-review hold is excluded,
      // and self-clearing deferrals rotate behind rows not yet retried —
      // neither can pin this bounded page.
      expect(scanQ.whereRaw).toHaveBeenCalledWith("coalesce(t.renewal_lapse_outcome, '') <> 'manual_review'");
      expect(scanQ.orderByRaw).toHaveBeenCalledWith('t.renewal_sweep_deferred_at asc nulls first');
      expect(scanQ.orderByRaw.mock.invocationCallOrder[0]).toBeLessThan(scanQ.orderBy.mock.invocationCallOrder[0]);
    });

    test('re-runs processGraceLapseForTerm (void + retrieval task + parent decision) for every started-but-not-completed lapse found', async () => {
      mockCommon();
      const { voidInvoice, raiseTermiteRetrievalTask, recordDecision, assertNoInvoiceChargeReconciliationPending } = mockLapseDeps();

      const term = {
        id: 'succ-term-1', customer_id: 'cust-1', prepay_invoice_id: 'succ-invoice-1', renewed_from_term_id: 'parent-1',
        renewal_lapse_started_at: new Date('2026-10-01T00:00:00Z'), renewal_lapse_completed_at: null,
      };
      const { conn: lapseConn, trx, completedUpdate } = makeLapseConn({
        freshSuccessor: { status: 'payment_pending', prepay_invoice_id: 'succ-invoice-1' },
        freshInvoice: { status: 'sent', paid_at: null },
      });
      const conn = jest.fn((table) => {
        if (table === 'annual_prepay_terms as t') return tableQuery([term]);
        return lapseConn(table);
      });
      conn.transaction = lapseConn.transaction;

      const { _private } = require('../services/termite-annual-renewal-charge');
      const counts = { lapseEffectsScanned: 0, lapseEffectsReconciled: 0, graceReconciliationDeferred: 0 };
      await _private.reconcileMissedLapseEffects({ conn, limit: 200, counts });

      expect(counts.lapseEffectsScanned).toBe(1);
      expect(counts.lapseEffectsReconciled).toBe(1);
      expect(assertNoInvoiceChargeReconciliationPending).toHaveBeenCalledWith('succ-invoice-1', trx);
      expect(voidInvoice).toHaveBeenCalledWith('succ-invoice-1', { requireUnsettled: true });
      expect(raiseTermiteRetrievalTask).toHaveBeenCalledWith('cust-1', null, expect.objectContaining({
        termId: 'succ-term-1', episodeKey: 'renewal_grace_lapse',
      }));
      expect(recordDecision).toHaveBeenCalledWith({ termId: 'parent-1', action: 'cancel', conn });
      expect(completedUpdate).toHaveBeenCalledTimes(1);
    });

    // Codex round-5 P0: the RECOVERY pass hits the SAME re-check — a card
    // payment or credit settlement landed WHILE this row sat
    // started-but-not-completed (a crash, or a prior deferral), and the
    // recovery pass resuming it must retire rather than void.
    test('a started-but-not-completed row whose invoice settled in the meantime is retired, never voided', async () => {
      mockCommon();
      const { voidInvoice, raiseTermiteRetrievalTask, recordDecision } = mockLapseDeps();
      jest.doMock('../services/notification-service', () => ({ notifyAdmin: jest.fn(async () => ({ id: 'n1' })) }));

      const term = {
        id: 'succ-term-1', customer_id: 'cust-1', prepay_invoice_id: 'succ-invoice-1', renewed_from_term_id: 'parent-1',
        renewal_lapse_started_at: new Date('2026-10-01T00:00:00Z'), renewal_lapse_completed_at: null,
      };
      const { conn: lapseConn, completedUpdate } = makeLapseConn({
        freshSuccessor: { status: 'payment_pending', prepay_invoice_id: 'succ-invoice-1' },
        freshInvoice: { status: 'prepaid', paid_at: new Date('2026-10-05T00:00:00Z') },
      });
      const conn = jest.fn((table) => {
        if (table === 'annual_prepay_terms as t') return tableQuery([term]);
        return lapseConn(table);
      });
      conn.transaction = lapseConn.transaction;

      const { _private } = require('../services/termite-annual-renewal-charge');
      const counts = { lapseEffectsScanned: 0, lapseEffectsReconciled: 0, graceReconciliationDeferred: 0, graceRetiredSettled: 0 };
      await _private.reconcileMissedLapseEffects({ conn, limit: 200, counts });

      expect(counts.lapseEffectsScanned).toBe(1);
      expect(counts.lapseEffectsReconciled).toBe(0);
      expect(counts.graceRetiredSettled).toBe(1);
      expect(voidInvoice).not.toHaveBeenCalled();
      expect(raiseTermiteRetrievalTask).not.toHaveBeenCalled();
      expect(recordDecision).not.toHaveBeenCalled();
      expect(completedUpdate).toHaveBeenCalledWith(expect.objectContaining({ renewal_lapse_outcome: 'retired_settled' }));
    });

    test('a row still blocked by a pending reconciliation counts as deferred, not reconciled — never re-voided blindly', async () => {
      mockCommon();
      mockLapseDeps({ assertNoInvoiceChargeReconciliationPendingImpl: async () => { throw new Error('still ambiguous'); } });
      jest.doMock('../services/notification-service', () => ({ notifyAdmin: jest.fn(async () => ({ id: 'n1' })) }));

      const term = {
        id: 'succ-term-1', customer_id: 'cust-1', prepay_invoice_id: 'succ-invoice-1', renewed_from_term_id: 'parent-1',
        renewal_lapse_started_at: new Date('2026-10-01T00:00:00Z'), renewal_lapse_completed_at: null,
      };
      const { conn: lapseConn } = makeLapseConn({
        freshSuccessor: { status: 'payment_pending', prepay_invoice_id: 'succ-invoice-1' },
        freshInvoice: { status: 'sent', paid_at: null },
      });
      const conn = jest.fn((table) => {
        if (table === 'annual_prepay_terms as t') return tableQuery([term]);
        return lapseConn(table);
      });
      conn.transaction = lapseConn.transaction;

      const { _private } = require('../services/termite-annual-renewal-charge');
      const counts = { lapseEffectsScanned: 0, lapseEffectsReconciled: 0, graceReconciliationDeferred: 0 };
      await _private.reconcileMissedLapseEffects({ conn, limit: 200, counts });

      expect(counts.lapseEffectsScanned).toBe(1);
      expect(counts.lapseEffectsReconciled).toBe(0);
      expect(counts.graceReconciliationDeferred).toBe(1);
    });

    test('a failure reconciling one successor never blocks the rest', async () => {
      mockCommon();
      const voidInvoice = jest.fn()
        .mockRejectedValueOnce(new Error('boom'))
        .mockResolvedValueOnce({});
      mockLapseDeps({ voidInvoiceImpl: voidInvoice });

      const badTerm = {
        id: 'bad-term', customer_id: 'cust-1', prepay_invoice_id: 'bad-invoice', renewed_from_term_id: 'parent-1',
        renewal_lapse_started_at: new Date('2026-10-01T00:00:00Z'),
      };
      const goodTerm = {
        id: 'good-term', customer_id: 'cust-2', prepay_invoice_id: 'good-invoice', renewed_from_term_id: 'parent-2',
        renewal_lapse_started_at: new Date('2026-10-01T00:00:00Z'),
      };
      const { conn: lapseConn } = makeLapseConn();
      const conn = jest.fn((table) => {
        if (table === 'annual_prepay_terms as t') return tableQuery([badTerm, goodTerm]);
        return lapseConn(table);
      });
      conn.transaction = lapseConn.transaction;

      const { _private } = require('../services/termite-annual-renewal-charge');
      const counts = { lapseEffectsScanned: 0, lapseEffectsReconciled: 0, graceReconciliationDeferred: 0 };
      await _private.reconcileMissedLapseEffects({ conn, limit: 200, counts });

      expect(counts.lapseEffectsScanned).toBe(2);
      expect(counts.lapseEffectsReconciled).toBe(1); // only the good one
      expect(voidInvoice).toHaveBeenCalledTimes(2);
    });

    test('a query failure degrades to a no-op, never throws', async () => {
      mockCommon();
      const conn = jest.fn(() => { throw new Error('db down'); });
      const { _private } = require('../services/termite-annual-renewal-charge');
      const counts = { lapseEffectsScanned: 0, lapseEffectsReconciled: 0, graceReconciliationDeferred: 0 };
      await expect(_private.reconcileMissedLapseEffects({ conn, limit: 200, counts })).resolves.toBeUndefined();
    });
  });

  describe('graceDeadlineFor / graceDays', () => {
    test('reads GRACE_DAYS and the date formula from annual-prepay-renewals.js — the SAME cutoff coveredTermsAsOf (P2-4) reads', () => {
      mockCommon();
      mockGraceHelpers({ graceDays: 30 });
      const { _private } = require('../services/termite-annual-renewal-charge');
      expect(_private.graceDays()).toBe(30);
      expect(_private.graceDeadlineFor({ term_start: '2026-09-27', created_at: '2026-09-27T00:00:00Z' })).toBe('2026-10-27');
    });

    test('anchors on the LATER of term_start / created_at — a delayed mint never shortens the window', () => {
      mockCommon();
      mockGraceHelpers({ graceDays: 30 });
      const { _private } = require('../services/termite-annual-renewal-charge');
      // Minted 5 days after its nominal term_start.
      expect(_private.graceDeadlineFor({ term_start: '2026-09-27', created_at: '2026-10-02T00:00:00Z' })).toBe('2026-11-01');
    });
  });

  // ---- gate ---------------------------------------------------------------

  describe('runTermiteAnnualRenewalSweep', () => {
    test('gate off -> no-op end to end, no queries at all', async () => {
      mockCommon();
      // No other mocks: if the gate check didn't short-circuit before any
      // DB access, requiring the real annual-prepay-renewals / invoice /
      // stripe modules here would blow up on missing config.
      const { runTermiteAnnualRenewalSweep, termiteAnnualRenewalChargeLive } = require('../services/termite-annual-renewal-charge');
      expect(termiteAnnualRenewalChargeLive()).toBe(false);
      const result = await runTermiteAnnualRenewalSweep();
      expect(result.gate).toBe('off');
      expect(result.minted).toBe(0);
      expect(result.charged).toBe(0);
    });

    test('gate on reads the env var fresh on every call (no restart needed)', async () => {
      mockCommon();
      const { termiteAnnualRenewalChargeLive } = require('../services/termite-annual-renewal-charge');
      expect(termiteAnnualRenewalChargeLive()).toBe(false);
      process.env.GATE_TERMITE_ANNUAL_PLAN = 'true';
      expect(termiteAnnualRenewalChargeLive()).toBe(true);
    });
  });

  // ---- reconcile stuck successors (P1-3) ----------------------------------

  describe('runTermiteAnnualRenewalSweep — reconcileStuckSuccessors passes', () => {
    // Several tests below doMock annual-prepay-renewals with a pinned grace
    // deadline; a doMock outlives resetModules, so drop it after each test.
    afterEach(() => { jest.dontMock('../services/annual-prepay-renewals'); });
    // A real knex builder chain doesn't execute at .select() — it stays
    // chainable (.select().limit() is the ACTUAL production call order in
    // every pass below) and only resolves once the whole chain is awaited
    // (its own thenable .then()).
    function tableQuery(rows) {
      const q = {};
      const chain = ['whereNotNull', 'whereNull', 'where', 'whereRaw', 'whereNotExists', 'orderBy', 'orderByRaw', 'limit', 'leftJoin', 'select'];
      for (const m of chain) q[m] = jest.fn(() => q);
      q.then = (resolve, reject) => Promise.resolve(rows).then(resolve, reject);
      q.catch = jest.fn(() => Promise.resolve());
      return q;
    }

    test('runs reconcileParentRenewedStamps (Codex round-2 P1 backstop) and wires its summary into the sweep counts', async () => {
      mockCommon();
      process.env.GATE_TERMITE_ANNUAL_PLAN = 'true';
      const reconcileParentRenewedStamps = jest.fn(async () => ({ scanned: 3, stamped: 2 }));
      mockGraceHelpers({ graceDays: 30, reconcileParentRenewedStampsImpl: reconcileParentRenewedStamps });
      jest.doMock('../services/notification-service', () => ({ notifyAdmin: jest.fn() }));
      jest.doMock('../services/invoice', () => ({ sendViaSMSAndEmail: jest.fn() }));
      jest.doMock('../services/recurring-card-on-file', () => ({ resolvePrepayChargeMethod: jest.fn() }));
      jest.doMock('../services/stripe', () => ({ chargeInvoiceWithSavedCard: jest.fn(), quoteInvoiceSavedCardCharge: jest.fn(), assertNoInvoiceChargeReconciliationPending: jest.fn() }));

      const empty = tableQuery([]);
      const conn = jest.fn((table) => {
        if (table === 'annual_prepay_terms as t') return empty;
        throw new Error(`unexpected table ${table}`);
      });
      conn.schema = { hasTable: jest.fn().mockResolvedValue(true) };

      const { runTermiteAnnualRenewalSweep } = require('../services/termite-annual-renewal-charge');
      const result = await runTermiteAnnualRenewalSweep({ conn, limit: 150 });

      expect(reconcileParentRenewedStamps).toHaveBeenCalledWith({ conn, limit: 150 });
      expect(result.parentRenewedScanned).toBe(3);
      expect(result.parentRenewedStamped).toBe(2);
    });

    test('6a: a never-attempted, hour-old successor with NO existing bell runs decideAndCharge for real', async () => {
      mockCommon();
      process.env.GATE_TERMITE_ANNUAL_PLAN = 'true';
      mockGraceHelpers({ graceDays: 30 });
      jest.doMock('../services/notification-service', () => ({ notifyAdmin: jest.fn(async () => ({ id: 'n1' })) }));
      jest.doMock('../services/invoice', () => ({ sendViaSMSAndEmail: jest.fn(async () => ({ ok: true })) }));
      jest.doMock('../services/recurring-card-on-file', () => ({ resolvePrepayChargeMethod: jest.fn(async () => null) }));
      jest.doMock('../services/stripe', () => ({ chargeInvoiceWithSavedCard: jest.fn(), quoteInvoiceSavedCardCharge: jest.fn() }));

      const successor = baseSuccessor({ renewed_from_term_id: 'parent-1', annual_plan_version: 'v3' });
      const parent = baseParent();
      const noWitness = tableQuery([]);
      const unanchored = tableQuery([]);
      const staleOverdue = tableQuery([]);
      const candidates = tableQuery([]);
      const graceLapses = tableQuery([]);
      const lapseEffects = tableQuery([]);
      const neverAttempted = tableQuery([successor]);
      const neverReachedStripe = tableQuery([]);

      let asTCall = 0;
      const conn = jest.fn((table) => {
        if (table === 'annual_prepay_terms as t') {
          asTCall += 1;
          // Passes run in order: no-witness, unanchored, stale, candidates,
          // grace-lapses, lapse-effects, never-attempted, never-reached-stripe.
          const order = [noWitness, unanchored, staleOverdue, candidates, graceLapses, lapseEffects, neverAttempted, neverReachedStripe];
          return order[Math.min(asTCall - 1, order.length - 1)];
        }
        if (table === 'annual_prepay_terms') {
          // parent lookup inside the reconcile loop.
          return { where: jest.fn().mockReturnValue({ first: jest.fn().mockResolvedValue(parent) }) };
        }
        throw new Error(`unexpected table ${table}`);
      });
      conn.schema = { hasTable: jest.fn().mockResolvedValue(true) };

      const { runTermiteAnnualRenewalSweep } = require('../services/termite-annual-renewal-charge');
      const result = await runTermiteAnnualRenewalSweep({ conn, limit: 200 });

      expect(result.reconcileNeverAttemptedScanned).toBe(1);
      // decideAndCharge ran (no_method skip, since resolvePrepayChargeMethod
      // returned null) rather than being silently skipped.
      expect(result.reconcileSkipped).toBeGreaterThanOrEqual(1);
      // Codex round-4 P1: the scan excludes on the PERSISTED skip column,
      // never on a notifications-table inference — no such table is
      // touched by this leg at all any more.
      expect(conn).not.toHaveBeenCalledWith('notifications');
      expect(neverAttempted.whereNull).toHaveBeenCalledWith('t.renewal_charge_attempted_at');
      expect(neverAttempted.whereNull).toHaveBeenCalledWith('t.renewal_charge_skipped_at');
    });

    // Codex round-4 P1: leg 7a's scan excludes renewal_charge_skipped_at
    // rows directly in SQL, so an older already-skipped row (a real DB row
    // this pass genuinely already handled — no_consent/no_method/surcharge/
    // ineligible) can never consume LIMIT's one slot away from a newer,
    // genuine crash-gap successor. The pre-fix shape filtered the SAME
    // "already handled" rows AFTER the LIMIT (a notifications-table LIKE
    // scan on each already-selected row), so a backlog of 200 old skips
    // could starve every newer row out of ever being reached.
    test('P1: with limit 1, an older already-skipped row never consumes the slot a newer crash-gap row needs', async () => {
      mockCommon();
      process.env.GATE_TERMITE_ANNUAL_PLAN = 'true';
      mockGraceHelpers({ graceDays: 30 });
      jest.doMock('../services/notification-service', () => ({ notifyAdmin: jest.fn(async () => ({ id: 'n1' })) }));
      jest.doMock('../services/invoice', () => ({ sendViaSMSAndEmail: jest.fn(async () => ({ ok: true })) }));
      jest.doMock('../services/recurring-card-on-file', () => ({ resolvePrepayChargeMethod: jest.fn(async () => null) }));
      jest.doMock('../services/stripe', () => ({ chargeInvoiceWithSavedCard: jest.fn(), quoteInvoiceSavedCardCharge: jest.fn() }));

      const parent = baseParent();
      // The older, already-skipped row is NOT in this result set at all —
      // it is exactly what the real `whereNull('t.renewal_charge_skipped_at')`
      // excludes before LIMIT 1 ever sees it. Only the newer, genuine
      // crash-gap successor is returned under limit:1.
      const newerCrashGapSuccessor = baseSuccessor({ id: 'succ-newer', renewed_from_term_id: 'parent-1', annual_plan_version: 'v3' });
      const empty = tableQuery([]);
      const neverAttempted = tableQuery([newerCrashGapSuccessor]);

      let asTCall = 0;
      const conn = jest.fn((table) => {
        if (table === 'annual_prepay_terms as t') {
          asTCall += 1;
          const order = [empty, empty, empty, empty, empty, empty, neverAttempted, empty];
          return order[Math.min(asTCall - 1, order.length - 1)];
        }
        if (table === 'annual_prepay_terms') {
          return { where: jest.fn().mockReturnValue({ first: jest.fn().mockResolvedValue(parent) }) };
        }
        throw new Error(`unexpected table ${table}`);
      });
      conn.schema = { hasTable: jest.fn().mockResolvedValue(true) };

      const { runTermiteAnnualRenewalSweep } = require('../services/termite-annual-renewal-charge');
      const result = await runTermiteAnnualRenewalSweep({ conn, limit: 1 });

      expect(neverAttempted.limit).toHaveBeenCalledWith(1);
      expect(neverAttempted.whereNull).toHaveBeenCalledWith('t.renewal_charge_skipped_at');
      // Codex #4971 round-3: a started grace lapse owns its row (never
      // re-decided or retired from here), and rows decideAndCharge deferred
      // rotate behind rows it has not tried yet (item 4 / chokepoint D).
      expect(neverAttempted.whereNull).toHaveBeenCalledWith('t.renewal_lapse_started_at');
      expect(neverAttempted.orderByRaw).toHaveBeenCalledWith('t.renewal_sweep_deferred_at asc nulls first');
      expect(result.reconcileNeverAttemptedScanned).toBe(1);
      // decideAndCharge actually ran for the ONE row the query returned —
      // it was never starved out.
      expect(result.reconcileSkipped).toBeGreaterThanOrEqual(1);
      expect(conn).not.toHaveBeenCalledWith('notifications');
    });

    test('6b: a claimed-but-never-reached-Stripe successor bells "ambiguous" once and delivers the pay link (safe — no money ever moved)', async () => {
      mockCommon();
      process.env.GATE_TERMITE_ANNUAL_PLAN = 'true';
      mockGraceHelpers({ graceDays: 30 });
      const notifyAdmin = jest.fn(async () => ({ id: 'n1', deduped: false, suppressed: false }));
      jest.doMock('../services/notification-service', () => ({ notifyAdmin }));
      const sendViaSMSAndEmail = jest.fn(async () => ({ ok: true }));
      jest.doMock('../services/invoice', () => ({ sendViaSMSAndEmail }));
      jest.doMock('../services/recurring-card-on-file', () => ({ resolvePrepayChargeMethod: jest.fn() }));
      jest.doMock('../services/stripe', () => ({ chargeInvoiceWithSavedCard: jest.fn(), quoteInvoiceSavedCardCharge: jest.fn() }));

      const successor = baseSuccessor({ renewed_from_term_id: 'parent-1', annual_plan_version: 'v3' });
      const empty = tableQuery([]);
      const neverReachedStripe = tableQuery([successor]);

      const undeliveredInvoice = { where: jest.fn(() => ({ first: jest.fn().mockResolvedValue({ status: 'draft', sent_at: null, sms_sent_at: null, email_sent_at: null }) })) };
      // Codex #4971 round-4 (post-merge audit) P1: leg 7b now revalidates
      // the parent's eligibility before delivering — an eligible parent
      // (still 'active', undecided, no linked invoice) matches this test's
      // intent (a safe, still-eligible recovery) and lets it exercise the
      // SAME delivery path as before the fix.
      const eligibleParentQuery = { where: jest.fn(() => ({ first: jest.fn().mockResolvedValue({ status: 'active', renewal_decision: null, prepay_invoice_id: null }) })) };
      let asTCall = 0;
      const conn = jest.fn((table) => {
        if (table === 'annual_prepay_terms as t') {
          asTCall += 1;
          const order = [empty, empty, empty, empty, empty, empty, empty, neverReachedStripe];
          return order[Math.min(asTCall - 1, order.length - 1)];
        }
        if (table === 'annual_prepay_terms') return eligibleParentQuery;
        if (table === 'invoices') return undeliveredInvoice;
        throw new Error(`unexpected table ${table}`);
      });
      conn.schema = { hasTable: jest.fn().mockResolvedValue(true) };

      const { runTermiteAnnualRenewalSweep } = require('../services/termite-annual-renewal-charge');
      const result = await runTermiteAnnualRenewalSweep({ conn, limit: 200 });

      expect(result.reconcileNeverReachedStripeBelled).toBe(1);
      expect(notifyAdmin).toHaveBeenCalledWith('billing', expect.any(String), expect.any(String), expect.objectContaining({
        dedupeKey: 'termite-renewal-charge:succ-term-1:ambiguous',
      }));
      expect(sendViaSMSAndEmail).toHaveBeenCalledWith('succ-invoice-1', expect.any(Object));
    });

    // Codex round-3 audit P1: a deduped bell with PERSISTED delivery
    // evidence already on the invoice never re-delivers — dedup alone is
    // NOT what skips redelivery (see the dedicated reconcileStuckSuccessors
    // tests below for the "deduped but NEVER delivered" case, which now
    // correctly retries).
    test('6b: a bell already deduped, WITH persisted delivery evidence, does NOT re-deliver the pay-link invoice', async () => {
      mockCommon();
      process.env.GATE_TERMITE_ANNUAL_PLAN = 'true';
      mockGraceHelpers({ graceDays: 30 });
      const notifyAdmin = jest.fn(async () => ({ id: 'n1', deduped: true }));
      jest.doMock('../services/notification-service', () => ({ notifyAdmin }));
      const sendViaSMSAndEmail = jest.fn();
      jest.doMock('../services/invoice', () => ({ sendViaSMSAndEmail }));
      jest.doMock('../services/recurring-card-on-file', () => ({ resolvePrepayChargeMethod: jest.fn() }));
      jest.doMock('../services/stripe', () => ({ chargeInvoiceWithSavedCard: jest.fn(), quoteInvoiceSavedCardCharge: jest.fn() }));

      const successor = baseSuccessor({ renewed_from_term_id: 'parent-1', annual_plan_version: 'v3' });
      const empty = tableQuery([]);
      const neverReachedStripe = tableQuery([successor]);
      const deliveredInvoice = { where: jest.fn(() => ({ first: jest.fn().mockResolvedValue({ status: 'sent', sent_at: new Date('2026-10-01T00:00:00Z'), sms_sent_at: null, email_sent_at: null }) })) };
      const eligibleParentQuery = { where: jest.fn(() => ({ first: jest.fn().mockResolvedValue({ status: 'active', renewal_decision: null, prepay_invoice_id: null }) })) };

      let asTCall = 0;
      const conn = jest.fn((table) => {
        if (table === 'annual_prepay_terms as t') {
          asTCall += 1;
          const order = [empty, empty, empty, empty, empty, empty, empty, neverReachedStripe];
          return order[Math.min(asTCall - 1, order.length - 1)];
        }
        if (table === 'annual_prepay_terms') return eligibleParentQuery;
        if (table === 'invoices') return deliveredInvoice;
        throw new Error(`unexpected table ${table}`);
      });
      conn.schema = { hasTable: jest.fn().mockResolvedValue(true) };

      const { runTermiteAnnualRenewalSweep } = require('../services/termite-annual-renewal-charge');
      const result = await runTermiteAnnualRenewalSweep({ conn, limit: 200 });

      expect(result.reconcileNeverReachedStripeBelled).toBe(0);
      expect(sendViaSMSAndEmail).not.toHaveBeenCalled();
    });

    // Codex round-7 P1 (2nd audit round): stamping renewal_charge_never_
    // reached_stripe_belled_at unconditionally — even when the bell itself
    // failed, or a fresh bell's delivery failed — permanently excluded a
    // row nobody was ever actually told about. Exercised directly against
    // reconcileStuckSuccessors (not the whole sweep) so the stamp UPDATE
    // itself (a distinct `annual_prepay_terms` call, no alias) is precisely
    // observable.
    // `invoice` models the PERSISTED delivery-evidence read
    // bellAndVerifyDeliveryForNeverReachedStripe now does (Codex round-3
    // audit P1) — default is "never delivered" (a draft with no sent
    // stamps), so a test must pass one showing evidence to exercise the
    // "already delivered, no fresh attempt needed" path.
    // `parent` defaults to still-eligible (Codex #4971 round-4 post-merge
    // audit P1: leg 7b now revalidates parent eligibility before any
    // delivery) — every pre-existing 6b test below is exercising the
    // delivery/dedupe/stamp logic, not the eligibility revalidation, so
    // the default keeps them on the SAME "safe to deliver" path as before
    // that fix. The dedicated eligibility tests pass their own ineligible
    // parent.
    function makeLeg7bConn(
      successor,
      invoice = { status: 'draft', sent_at: null, sms_sent_at: null, email_sent_at: null },
      parent = { status: 'active', renewal_decision: null, prepay_invoice_id: null },
      { successorAfterVoid = { status: 'cancelled' }, submittedAttempt = undefined } = {},
    ) {
      const empty = tableQuery([]);
      const neverReachedStripe = tableQuery([successor]);
      const stampUpdate = jest.fn().mockResolvedValue(1);
      const deferredUpdate = jest.fn().mockResolvedValue(1);
      let asTCall = 0;
      const conn = jest.fn((table) => {
        if (table === 'annual_prepay_terms as t') {
          asTCall += 1;
          // Leg 7a's own scan runs first — empty, so only leg 7b's
          // successor is exercised.
          return asTCall === 1 ? empty : neverReachedStripe;
        }
        if (table === 'annual_prepay_terms') {
          return {
            where: jest.fn(() => ({
              whereNull: jest.fn(() => ({ update: stampUpdate })),
              update: deferredUpdate,
              // The successor's own status re-read after a retire's void
              // asks for 'status'; every other read here is the parent.
              first: jest.fn((col) => Promise.resolve(col === 'status' ? successorAfterVoid : parent)),
            })),
          };
        }
        if (table === 'invoices') {
          return { where: jest.fn(() => ({ first: jest.fn().mockResolvedValue(invoice) })) };
        }
        if (table === 'stripe_invoice_charge_attempts as a') {
          const q = { where: jest.fn(() => q), first: jest.fn().mockResolvedValue(submittedAttempt) };
          return q;
        }
        throw new Error(`unexpected table ${table}`);
      });
      conn.schema = { hasTable: jest.fn().mockResolvedValue(true) };
      return { conn, stampUpdate, deferredUpdate };
    }

    test('6b P1: ringRenewalBell failing outright (null) never stamps — the row stays retryable', async () => {
      mockCommon();
      const notifyAdmin = jest.fn(async () => null); // ringRenewalBell's own catch swallows and returns null
      jest.doMock('../services/notification-service', () => ({ notifyAdmin }));
      const sendViaSMSAndEmail = jest.fn();
      jest.doMock('../services/invoice', () => ({ sendViaSMSAndEmail }));

      const successor = baseSuccessor({ renewed_from_term_id: 'parent-1', annual_plan_version: 'v3' });
      const { conn, stampUpdate } = makeLeg7bConn(successor);

      const { _private } = require('../services/termite-annual-renewal-charge');
      const counts = { reconcileNeverReachedStripeBelled: 0 };
      await _private.reconcileStuckSuccessors({ conn, limit: 200, counts });

      expect(notifyAdmin).toHaveBeenCalledTimes(1);
      expect(sendViaSMSAndEmail).not.toHaveBeenCalled();
      expect(stampUpdate).not.toHaveBeenCalled();
      expect(counts.reconcileNeverReachedStripeBelled).toBe(0);
    });

    test('6b P1: a FRESH bell whose delivery fails never stamps — retryable, not silently "handled"', async () => {
      mockCommon();
      const notifyAdmin = jest.fn(async () => ({ id: 'n1', deduped: false, suppressed: false }));
      jest.doMock('../services/notification-service', () => ({ notifyAdmin }));
      const sendViaSMSAndEmail = jest.fn(async () => ({ ok: false, error: 'sms provider down' }));
      jest.doMock('../services/invoice', () => ({ sendViaSMSAndEmail }));

      const successor = baseSuccessor({ renewed_from_term_id: 'parent-1', annual_plan_version: 'v3' });
      const { conn, stampUpdate } = makeLeg7bConn(successor);

      const { _private } = require('../services/termite-annual-renewal-charge');
      const counts = { reconcileNeverReachedStripeBelled: 0 };
      await _private.reconcileStuckSuccessors({ conn, limit: 200, counts });

      expect(notifyAdmin).toHaveBeenCalledTimes(1);
      expect(sendViaSMSAndEmail).toHaveBeenCalledWith('succ-invoice-1', expect.any(Object));
      expect(stampUpdate).not.toHaveBeenCalled();
      expect(counts.reconcileNeverReachedStripeBelled).toBe(0);
    });

    test('6b P1: a FRESH bell with a VERIFIED delivery stamps exactly once', async () => {
      mockCommon();
      const notifyAdmin = jest.fn(async () => ({ id: 'n1', deduped: false, suppressed: false }));
      jest.doMock('../services/notification-service', () => ({ notifyAdmin }));
      const sendViaSMSAndEmail = jest.fn(async () => ({ ok: true }));
      jest.doMock('../services/invoice', () => ({ sendViaSMSAndEmail }));

      const successor = baseSuccessor({ renewed_from_term_id: 'parent-1', annual_plan_version: 'v3' });
      const { conn, stampUpdate } = makeLeg7bConn(successor);

      const { _private } = require('../services/termite-annual-renewal-charge');
      const counts = { reconcileNeverReachedStripeBelled: 0 };
      await _private.reconcileStuckSuccessors({ conn, limit: 200, counts });

      expect(stampUpdate).toHaveBeenCalledWith({ renewal_charge_never_reached_stripe_belled_at: expect.any(Date) });
      expect(counts.reconcileNeverReachedStripeBelled).toBe(1);
    });

    // Codex round-3 audit P1: `deduped` means ONLY "staff already know" —
    // it says nothing about whether the invoice was ever actually
    // delivered, so it must not exempt a row from the delivery check.
    // This test's invoice carries PERSISTED delivery evidence (sent_at
    // set) — the ONLY reason a deduped bell may skip a fresh attempt.
    test('6b P1: a deduped bell WITH persisted delivery evidence stamps WITHOUT a fresh delivery', async () => {
      mockCommon();
      const notifyAdmin = jest.fn(async () => ({ id: 'n1', deduped: true }));
      jest.doMock('../services/notification-service', () => ({ notifyAdmin }));
      const sendViaSMSAndEmail = jest.fn();
      jest.doMock('../services/invoice', () => ({ sendViaSMSAndEmail }));

      const successor = baseSuccessor({ renewed_from_term_id: 'parent-1', annual_plan_version: 'v3' });
      const { conn, stampUpdate } = makeLeg7bConn(successor, {
        status: 'sent', sent_at: new Date('2026-10-01T00:00:00Z'), sms_sent_at: null, email_sent_at: null,
      });

      const { _private } = require('../services/termite-annual-renewal-charge');
      const counts = { reconcileNeverReachedStripeBelled: 0 };
      await _private.reconcileStuckSuccessors({ conn, limit: 200, counts });

      expect(sendViaSMSAndEmail).not.toHaveBeenCalled();
      expect(stampUpdate).toHaveBeenCalledTimes(1);
      expect(counts.reconcileNeverReachedStripeBelled).toBe(0);
    });

    // The exact bug the audit caught: a FRESH bell's delivery genuinely
    // failed on tick 1 (correctly not stamped, per the "delivery fails
    // never stamps" test above). Tick 2 dedupes the SAME bell — the old
    // code treated deduped as "handled" and stamped WITHOUT ever
    // retrying delivery, permanently excluding a row the customer was
    // never actually sent an invoice for. With no persisted evidence, a
    // deduped bell must still attempt delivery.
    // The exact race the audit caught: a cancellation won against an
    // already-claimed attempt fence — decideAndCharge's own final parent
    // check (withParentDecisionLock, right before the Stripe call)
    // correctly blocked Stripe, but that leaves EXACTLY leg 7b's own
    // selection shape (attempted_at set, no stripe_invoice_charge_attempts
    // row). Leg 7b must revalidate the parent itself before delivering —
    // never send a payment demand for a renewal that's already cancelled.
    // Codex #4971 round-3 P1 (item 1): a DURABLE parent refusal no longer
    // just bells and marks the row handled (that left a payment_pending
    // successor with an open draft no pass would ever touch again) — it
    // terminalizes the successor through voidInvoice's requireUnsettled
    // chokepoint, with no pay link, no retrieval and no parent decision.
    test('6b P1: the parent was cancelled after the attempt fence was stamped — the unpresented successor is RETIRED (void, never a pay link), staff belled once', async () => {
      mockCommon();
      const notifyAdmin = jest.fn(async () => ({ id: 'n1', deduped: false, suppressed: false }));
      jest.doMock('../services/notification-service', () => ({ notifyAdmin }));
      const sendViaSMSAndEmail = jest.fn();
      const voidInvoice = jest.fn(async () => ({}));
      jest.doMock('../services/invoice', () => ({ sendViaSMSAndEmail, voidInvoice }));
      const recordDecision = jest.fn();
      const cancelTermWithRestorations = jest.fn();
      jest.doMock('../services/annual-prepay-renewals', () => ({
        recordDecision, cancelTermWithRestorations, termiteRenewalGraceDeadlineFor: jest.fn(() => '2099-01-01'),
      }));

      const successor = baseSuccessor({ renewed_from_term_id: 'parent-1', annual_plan_version: 'v3' });
      const cancelledParent = { status: 'cancelled', renewal_decision: 'cancel', prepay_invoice_id: null };
      const { conn, stampUpdate } = makeLeg7bConn(successor, undefined, cancelledParent);

      const { _private } = require('../services/termite-annual-renewal-charge');
      const counts = { reconcileNeverReachedStripeBelled: 0 };
      await _private.reconcileStuckSuccessors({ conn, limit: 200, counts });

      expect(sendViaSMSAndEmail).not.toHaveBeenCalled(); // never a payment demand for a cancelled renewal
      expect(voidInvoice).toHaveBeenCalledWith('succ-invoice-1', { requireUnsettled: true });
      // voidInvoice's own sync already cancelled the successor — no second cancel.
      expect(cancelTermWithRestorations).not.toHaveBeenCalled();
      expect(recordDecision).not.toHaveBeenCalled();
      expect(notifyAdmin).toHaveBeenCalledWith('billing', expect.stringMatching(/withdrawn/i), expect.stringMatching(/parent_decided_cancel/), expect.objectContaining({
        dedupeKey: 'termite-renewal-charge:succ-term-1:retired_unpresented',
      }));
      expect(stampUpdate).toHaveBeenCalledTimes(1);
      expect(counts.reconcileNeverReachedStripeBelled).toBe(0); // 'delivered' only counts an actual send
    });

    test('6b P1: a void that committed but whose sync failed — the retire completes the successor cancel itself', async () => {
      mockCommon();
      jest.doMock('../services/notification-service', () => ({ notifyAdmin: jest.fn(async () => ({ id: 'n1' })) }));
      const voidInvoice = jest.fn(async () => ({}));
      jest.doMock('../services/invoice', () => ({ sendViaSMSAndEmail: jest.fn(), voidInvoice }));
      const cancelTermWithRestorations = jest.fn(async () => ({ id: 'succ-term-1', status: 'cancelled' }));
      jest.doMock('../services/annual-prepay-renewals', () => ({
        cancelTermWithRestorations, termiteRenewalGraceDeadlineFor: jest.fn(() => '2099-01-01'),
      }));

      const successor = baseSuccessor({ renewed_from_term_id: 'parent-1', annual_plan_version: 'v3' });
      const refundedParent = { status: 'cancelled', renewal_decision: null, prepay_invoice_id: null };
      const { conn } = makeLeg7bConn(successor, undefined, refundedParent, { successorAfterVoid: { status: 'payment_pending' } });

      const { _private } = require('../services/termite-annual-renewal-charge');
      await _private.reconcileStuckSuccessors({ conn, limit: 200, counts: { reconcileNeverReachedStripeBelled: 0 } });

      expect(voidInvoice).toHaveBeenCalledTimes(1);
      expect(cancelTermWithRestorations).toHaveBeenCalledWith('succ-term-1', conn);
    });

    test('6b P1: a PRESENTED renewal (its invoice already delivered) is never retired here — the grace-lapse pass owns it', async () => {
      mockCommon();
      const notifyAdmin = jest.fn(async () => ({ id: 'n1' }));
      jest.doMock('../services/notification-service', () => ({ notifyAdmin }));
      const voidInvoice = jest.fn();
      jest.doMock('../services/invoice', () => ({ sendViaSMSAndEmail: jest.fn(), voidInvoice }));
      jest.doMock('../services/annual-prepay-renewals', () => ({ termiteRenewalGraceDeadlineFor: jest.fn(() => '2099-01-01') }));

      const successor = baseSuccessor({ renewed_from_term_id: 'parent-1', annual_plan_version: 'v3' });
      const cancelledParent = { status: 'cancelled', renewal_decision: 'cancel', prepay_invoice_id: null };
      const { conn, stampUpdate } = makeLeg7bConn(successor, { status: 'sent', sent_at: new Date() }, cancelledParent);

      const { _private } = require('../services/termite-annual-renewal-charge');
      await _private.reconcileStuckSuccessors({ conn, limit: 200, counts: { reconcileNeverReachedStripeBelled: 0 } });

      expect(voidInvoice).not.toHaveBeenCalled();
      expect(notifyAdmin).toHaveBeenCalledWith('billing', expect.any(String), expect.stringMatching(/grace-lapse pass/), expect.objectContaining({
        dedupeKey: 'termite-renewal-charge:succ-term-1:ineligible',
      }));
      expect(stampUpdate).toHaveBeenCalledTimes(1);
    });

    test('6b P1: a TRANSIENT parent refusal (its own invoice in dispute) sends nothing, retires nothing, and stays retryable — rotated to the back', async () => {
      mockCommon();
      jest.doMock('../services/notification-service', () => ({ notifyAdmin: jest.fn(async () => ({ id: 'n1' })) }));
      const sendViaSMSAndEmail = jest.fn();
      const voidInvoice = jest.fn();
      jest.doMock('../services/invoice', () => ({ sendViaSMSAndEmail, voidInvoice }));
      jest.doMock('../services/annual-prepay-renewals', () => ({ termiteRenewalGraceDeadlineFor: jest.fn(() => '2099-01-01') }));

      const successor = baseSuccessor({ renewed_from_term_id: 'parent-1', annual_plan_version: 'v3' });
      const disputedParent = { status: 'payment_pending', renewal_decision: null, prepay_invoice_id: null };
      const { conn, stampUpdate, deferredUpdate } = makeLeg7bConn(successor, undefined, disputedParent);

      const { _private } = require('../services/termite-annual-renewal-charge');
      await _private.reconcileStuckSuccessors({ conn, limit: 200, counts: { reconcileNeverReachedStripeBelled: 0 } });

      expect(sendViaSMSAndEmail).not.toHaveBeenCalled();
      expect(voidInvoice).not.toHaveBeenCalled();
      expect(stampUpdate).not.toHaveBeenCalled();
      expect(deferredUpdate).toHaveBeenCalledWith({ renewal_sweep_deferred_at: expect.any(Date) });
    });

    test('6b P1: past the successor\'s own grace deadline, an unpresented renewal is retired instead of handed a pay link the next lapse tick would act on', async () => {
      mockCommon();
      jest.doMock('../services/notification-service', () => ({ notifyAdmin: jest.fn(async () => ({ id: 'n1' })) }));
      const sendViaSMSAndEmail = jest.fn();
      const voidInvoice = jest.fn(async () => ({}));
      jest.doMock('../services/invoice', () => ({ sendViaSMSAndEmail, voidInvoice }));
      jest.doMock('../services/annual-prepay-renewals', () => ({ termiteRenewalGraceDeadlineFor: jest.fn(() => '2026-09-01') }));

      const successor = baseSuccessor({ renewed_from_term_id: 'parent-1', annual_plan_version: 'v3' });
      const { conn, stampUpdate } = makeLeg7bConn(successor);

      const { _private } = require('../services/termite-annual-renewal-charge');
      await _private.reconcileStuckSuccessors({ conn, limit: 200, counts: { reconcileNeverReachedStripeBelled: 0 } });

      expect(sendViaSMSAndEmail).not.toHaveBeenCalled();
      expect(voidInvoice).toHaveBeenCalledWith('succ-invoice-1', { requireUnsettled: true });
      expect(stampUpdate).toHaveBeenCalledTimes(1);
    });

    test('6b P1: a deduped bell with NO persisted delivery evidence still retries delivery — the bug the audit caught', async () => {
      mockCommon();
      const notifyAdmin = jest.fn(async () => ({ id: 'n1', deduped: true }));
      jest.doMock('../services/notification-service', () => ({ notifyAdmin }));
      const sendViaSMSAndEmail = jest.fn(async () => ({ ok: true }));
      jest.doMock('../services/invoice', () => ({ sendViaSMSAndEmail }));

      const successor = baseSuccessor({ renewed_from_term_id: 'parent-1', annual_plan_version: 'v3' });
      const { conn, stampUpdate } = makeLeg7bConn(successor); // default: draft, no sent stamps

      const { _private } = require('../services/termite-annual-renewal-charge');
      const counts = { reconcileNeverReachedStripeBelled: 0 };
      await _private.reconcileStuckSuccessors({ conn, limit: 200, counts });

      expect(sendViaSMSAndEmail).toHaveBeenCalledWith('succ-invoice-1', expect.any(Object));
      expect(stampUpdate).toHaveBeenCalledTimes(1);
      expect(counts.reconcileNeverReachedStripeBelled).toBe(1);
    });
  });
});
