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
        // Codex round-2 P1 backstop pass — a no-op stub by default so the
        // sweep's own try/catch never masks a real assertion below.
        reconcileParentRenewedStamps: jest.fn(reconcileParentRenewedStampsImpl || (async () => ({ scanned: 0, stamped: 0 }))),
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

  function makeClaimConn(claimResult = 1) {
    const claimUpdate = jest.fn().mockResolvedValue(claimResult);
    // Codex round-4 P1: decideAndCharge's own pre-fence skips now ALSO
    // stamp renewal_charge_skipped_at (stampRenewalChargeSkip) — a
    // SEPARATE whereNull/update chain on the same table.
    const skipStampUpdate = jest.fn().mockResolvedValue(1);
    const conn = jest.fn((table) => {
      if (table !== 'annual_prepay_terms') throw new Error(`unexpected table ${table}`);
      return {
        where: jest.fn().mockReturnValue({
          whereNull: jest.fn((col) => {
            if (col === 'renewal_charge_attempted_at') return { update: claimUpdate };
            if (col === 'renewal_charge_skipped_at') return { update: skipStampUpdate };
            throw new Error(`unexpected whereNull(${col})`);
          }),
        }),
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
    // on the OUTER conn (never trx) for an 'ineligible' outcome.
    const skipStampUpdate = jest.fn().mockResolvedValue(1);
    const conn = jest.fn((table) => {
      if (table === 'invoices') {
        return {
          where: jest.fn().mockReturnValue({
            first: freshInvoiceError ? jest.fn().mockRejectedValue(freshInvoiceError) : jest.fn().mockResolvedValue(freshInvoice),
          }),
        };
      }
      if (table === 'annual_prepay_terms') {
        return {
          where: jest.fn().mockReturnValue({
            whereNull: jest.fn((col) => {
              expect(col).toBe('renewal_charge_skipped_at');
              return { update: skipStampUpdate };
            }),
          }),
        };
      }
      throw new Error(`unexpected table ${table} on outer conn`);
    });
    conn.transaction = jest.fn(async (cb) => cb(trx));
    return { conn, trx, claimUpdate, skipStampUpdate };
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
      const { conn, claimUpdate } = makeDecideConn({ successor }); // first call claims (1 row)

      const outcome = await _private.decideAndCharge(successor, baseParent(), conn);
      expect(outcome.status).toBe('failed');
      expect(claimUpdate).toHaveBeenCalledTimes(1);
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
      const { conn } = makeDecideConn({ successor });
      const outcome = await _private.decideAndCharge(successor, baseParent(), conn);

      expect(outcome.status).toBe('failed');
      expect(sendViaSMSAndEmail).toHaveBeenCalledTimes(1); // pay link still delivered
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
      const { conn } = makeDecideConn({ successor });
      const outcome = await _private.decideAndCharge(successor, baseParent(), conn);

      expect(outcome.status).toBe('failed');
      expect(sendViaSMSAndEmail).not.toHaveBeenCalled();
      expect(notifyAdmin).toHaveBeenCalledWith('billing', expect.any(String), expect.any(String), expect.objectContaining({
        dedupeKey: 'termite-renewal-charge:succ-term-1:ambiguous',
      }));
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
      const { conn } = makeDecideConn({ successor });
      const outcome = await _private.decideAndCharge(successor, baseParent(), conn);

      expect(outcome.status).toBe('failed');
      expect(sendViaSMSAndEmail).not.toHaveBeenCalled();
      expect(notifyAdmin).toHaveBeenCalledWith('billing', expect.any(String), expect.any(String), expect.objectContaining({
        dedupeKey: 'termite-renewal-charge:succ-term-1:refused',
      }));
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
  } = {}) {
    const startedUpdate = jest.fn().mockResolvedValue(1);
    const completedUpdate = jest.fn().mockResolvedValue(1);
    const conn = jest.fn((table) => {
      if (table !== 'annual_prepay_terms') throw new Error(`unexpected table ${table}`);
      return {
        where: jest.fn(() => ({
          whereNull: jest.fn((col) => {
            expect(col).toBe('renewal_lapse_started_at');
            return { update: startedUpdate };
          }),
          update: completedUpdate,
        })),
      };
    });
    // Codex round-5 P0: assertNoInvoiceChargeReconciliationPending is now
    // folded INTO this same transaction (run against `trx`, not the outer
    // `conn`) — a single stable `trx` (not re-created per call) so tests
    // can assert against it directly.
    const trx = jest.fn((table) => {
      if (table === 'annual_prepay_terms') {
        return { where: jest.fn().mockReturnValue({ forUpdate: jest.fn().mockReturnValue({ first: jest.fn().mockResolvedValue(freshSuccessor) }) }) };
      }
      if (table === 'invoices') {
        return { where: jest.fn().mockReturnValue({ first: jest.fn().mockResolvedValue(freshInvoice) }) };
      }
      throw new Error(`unexpected table ${table} in lapse-eligibility trx`);
    });
    conn.transaction = jest.fn(async (cb) => cb(trx));
    return { conn, trx, startedUpdate, completedUpdate, startedAlreadySet };
  }

  function mockLapseDeps({
    voidInvoiceImpl, raiseTermiteRetrievalTaskImpl, recordDecisionImpl, assertNoInvoiceChargeReconciliationPendingImpl,
  } = {}) {
    const voidInvoice = jest.fn(voidInvoiceImpl || (async () => ({})));
    jest.doMock('../services/invoice', () => ({ voidInvoice }));
    const raiseTermiteRetrievalTask = jest.fn(raiseTermiteRetrievalTaskImpl || (async () => ({ raised: true })));
    jest.doMock('../services/cancellation-processor', () => ({ raiseTermiteRetrievalTask }));
    const recordDecision = jest.fn(recordDecisionImpl || (async () => ({ id: 'parent-1' })));
    jest.doMock('../services/annual-prepay-renewals', () => ({ recordDecision }));
    const assertNoInvoiceChargeReconciliationPending = jest.fn(
      assertNoInvoiceChargeReconciliationPendingImpl || (async () => undefined),
    );
    jest.doMock('../services/stripe', () => ({ assertNoInvoiceChargeReconciliationPending }));
    return { voidInvoice, raiseTermiteRetrievalTask, recordDecision, assertNoInvoiceChargeReconciliationPending };
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
      expect(voidInvoice).toHaveBeenCalledWith('succ-invoice-1');
      expect(raiseTermiteRetrievalTask).toHaveBeenCalledWith('cust-1', null, expect.objectContaining({
        termId: 'succ-term-1', episodeKey: 'renewal_grace_lapse',
      }));
      expect(recordDecision).toHaveBeenCalledWith({ termId: 'parent-1', action: 'cancel', conn });
      expect(completedUpdate).toHaveBeenCalledWith(expect.objectContaining({ renewal_lapse_completed_at: expect.any(Date) }));
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

    // Codex round-2 P0.
    test('P0: a pending charge reconciliation FAILS CLOSED — no void, a bell, started_at stamped but NOT completed_at, retried later', async () => {
      mockCommon();
      const reconErr = new Error('Invoice already has a saved-card charge in progress or awaiting reconciliation');
      const { voidInvoice, raiseTermiteRetrievalTask, recordDecision } = mockLapseDeps({
        assertNoInvoiceChargeReconciliationPendingImpl: async () => { throw reconErr; },
      });
      const notifyAdmin = jest.fn(async () => ({ id: 'n1' }));
      jest.doMock('../services/notification-service', () => ({ notifyAdmin }));
      const { conn, startedUpdate, completedUpdate } = makeLapseConn({
        freshSuccessor: { status: 'payment_pending', prepay_invoice_id: 'succ-invoice-1' },
        freshInvoice: { status: 'sent', paid_at: null },
      });

      const { _private } = require('../services/termite-annual-renewal-charge');
      const term = {
        id: 'succ-term-1', customer_id: 'cust-1', prepay_invoice_id: 'succ-invoice-1', renewed_from_term_id: 'parent-1', prepay_amount: 249,
      };
      const outcome = await _private.processGraceLapseForTerm(term, conn);

      expect(outcome).toBe('deferred');
      expect(startedUpdate).toHaveBeenCalledTimes(1); // provenance stamped regardless
      expect(voidInvoice).not.toHaveBeenCalled(); // NEVER voided while reconciliation is pending
      expect(raiseTermiteRetrievalTask).not.toHaveBeenCalled();
      expect(recordDecision).not.toHaveBeenCalled();
      expect(completedUpdate).not.toHaveBeenCalled(); // stays started-but-not-completed
      expect(notifyAdmin).toHaveBeenCalledWith('billing', expect.stringMatching(/reconciliation/i), expect.any(String), expect.objectContaining({
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
      expect(voidInvoice).toHaveBeenCalledWith('succ-invoice-1');
      expect(raiseTermiteRetrievalTask).toHaveBeenCalledTimes(1);
      expect(recordDecision).toHaveBeenCalledTimes(1);
      expect(completedUpdate).toHaveBeenCalledTimes(1);
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
  });

  describe('reconcileMissedLapseEffects (Codex round-1/2 P1) — recoverable post-void lapse effects', () => {
    function tableQuery(rows) {
      const q = {};
      const chain = ['whereNotNull', 'whereNull', 'where', 'orderBy', 'limit', 'select'];
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
      expect(voidInvoice).toHaveBeenCalledWith('succ-invoice-1');
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
    // A real knex builder chain doesn't execute at .select() — it stays
    // chainable (.select().limit() is the ACTUAL production call order in
    // every pass below) and only resolves once the whole chain is awaited
    // (its own thenable .then()).
    function tableQuery(rows) {
      const q = {};
      const chain = ['whereNotNull', 'whereNull', 'where', 'whereNotExists', 'orderBy', 'limit', 'leftJoin', 'select'];
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

      let asTCall = 0;
      const conn = jest.fn((table) => {
        if (table === 'annual_prepay_terms as t') {
          asTCall += 1;
          const order = [empty, empty, empty, empty, empty, empty, empty, neverReachedStripe];
          return order[Math.min(asTCall - 1, order.length - 1)];
        }
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

    test('6b: a bell already deduped does NOT re-deliver the pay-link invoice', async () => {
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

      let asTCall = 0;
      const conn = jest.fn((table) => {
        if (table === 'annual_prepay_terms as t') {
          asTCall += 1;
          const order = [empty, empty, empty, empty, empty, empty, empty, neverReachedStripe];
          return order[Math.min(asTCall - 1, order.length - 1)];
        }
        throw new Error(`unexpected table ${table}`);
      });
      conn.schema = { hasTable: jest.fn().mockResolvedValue(true) };

      const { runTermiteAnnualRenewalSweep } = require('../services/termite-annual-renewal-charge');
      const result = await runTermiteAnnualRenewalSweep({ conn, limit: 200 });

      expect(result.reconcileNeverReachedStripeBelled).toBe(0);
      expect(sendViaSMSAndEmail).not.toHaveBeenCalled();
    });
  });
});
