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

// Codex #4971 r10 P1: successorRecoveryRefusal reads the customer's
// deletion (a deleted account's renewal is withdrawn). The conn fakes
// answer it with a live customer unless a test says otherwise.
function liveCustomerQuery(customer = { deleted_at: null }) {
  return { where: jest.fn(() => ({ first: jest.fn(async () => customer) })) };
}

describe('termite annual renewal charge', () => {
  afterEach(() => {
    jest.resetModules();
    jest.clearAllMocks();
    delete process.env.GATE_TERMITE_ANNUAL_PLAN;
  });

  function mockCommon() {
    // Codex #4971 pre-push P0: every homeowner pay link / charge-failed text
    // re-resolves the payer first. Default: self-pay (no payer assigned);
    // the payer tests override this.
    jest.doMock('../services/payer', () => ({ resolveForInvoice: jest.fn(async () => ({ payerId: null })) }));
    // B10: no collections dispute hold by default; the hold tests override.
    jest.doMock('../services/collections/collection-hold', () => ({ customerHasActiveCollectionHold: jest.fn(async () => false) }));
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
    // Codex #4971 r4 P1: every pay link now clears under the parent's
    // decision gate (withPayLinkClearance). The real gate borrows a pooled
    // connection this suite's db mock does not have — run it inline; tests
    // that model the gate itself override this mock.
    jest.doMock('../services/annual-prepay-renewals', () => ({
      ...jest.requireActual('../services/annual-prepay-renewals'),
      withParentDecisionLock: jest.fn((termId, fn) => fn()),
    }));
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
        // Codex #4971 r15 P1: the gate's own liveness assertion — a no-op
        // here (the mock above never tracks a real session), same as
        // withParentDecisionLock. The lost-session behavior itself is
        // covered by annual-prepay-renewals.js's and this file's own
        // dedicated tests below.
        assertParentDecisionLockAlive: jest.fn(),
      };
      return actual;
    });
  }

  // Codex #4971 r15 P1 — finding 1: account deletion is fenced through the
  // same renewal gate a live pay-link send holds, so deleted_at can never
  // commit between that send's own eligibility check and its provider
  // handoff. auth.js's DELETE /account and admin-customers.js's archive
  // route both wrap their write in this ONE shared helper (see their own
  // test suites — cancelled-portal-read-access.test.js and
  // admin-customers-archive-relink.test.js — for the wiring itself); this
  // proves the helper's own gating logic in isolation.
  // Codex #4971 r15 P1, restructured r21: the deletion fence is a
  // TRANSACTION-level advisory lock on every termite term of the customer(s),
  // taken on the deletion's own transaction (acquireTermiteGateAtEntry) before
  // fn(trx) writes deleted_at on that same connection — no raw lock session
  // (nothing to lose, count against a cap, or re-check at the write).
  describe('withCustomerDeletionGate', () => {
    function deletionDb() {
      const trx = Object.assign(jest.fn(), { isTrx: true });
      const db = Object.assign(jest.fn(), { transaction: jest.fn(async (cb) => cb(trx)) });
      return { db, trx };
    }

    test('no customer ids at all — fn(trx) runs in the transaction, no gate taken', async () => {
      mockCommon();
      const { db, trx } = deletionDb();
      jest.doMock('../models/db', () => db);
      const acquireTermiteGateAtEntry = jest.fn(async () => []);
      jest.doMock('../services/annual-prepay-renewals', () => ({
        ...jest.requireActual('../services/annual-prepay-renewals'),
        acquireTermiteGateAtEntry,
      }));
      const { withCustomerDeletionGate } = require('../services/termite-annual-renewal-charge');
      const fn = jest.fn(async (conn) => (conn === trx ? 'deleted' : 'wrong-connection'));
      await expect(withCustomerDeletionGate([], fn)).resolves.toBe('deleted');
      await expect(withCustomerDeletionGate(null, fn)).resolves.toBe('deleted');
      expect(db.transaction).toHaveBeenCalledTimes(2);
      expect(acquireTermiteGateAtEntry).not.toHaveBeenCalled();
    });

    test('takes every customer\'s termite keys on the deletion transaction BEFORE fn runs — and fn writes on that same transaction', async () => {
      mockCommon();
      const { db, trx } = deletionDb();
      jest.doMock('../models/db', () => db);
      const order = [];
      const acquireTermiteGateAtEntry = jest.fn(async (conn, inputs) => {
        expect(conn).toBe(trx);
        order.push(['gate', inputs]);
        return ['parent-1', 'succ-1'];
      });
      jest.doMock('../services/annual-prepay-renewals', () => ({
        ...jest.requireActual('../services/annual-prepay-renewals'),
        acquireTermiteGateAtEntry,
      }));
      const { withCustomerDeletionGate } = require('../services/termite-annual-renewal-charge');
      const result = await withCustomerDeletionGate('cust-1', async (conn) => {
        expect(conn).toBe(trx);
        order.push(['deletion-write']);
        return 'deleted';
      });
      expect(result).toBe('deleted');
      expect(order).toEqual([['gate', { customerIds: ['cust-1'] }], ['deletion-write']]);
      expect(db.transaction).toHaveBeenCalledTimes(1);
    });

    // Codex #4971 r20 P2 (finding 4): DELETE /account's nine profiles — ONE
    // transaction, one gate call keyed on every id, duplicates and blanks
    // collapsed. Nothing here can exhaust a session cap.
    test('nine customer ids (past the old 8-session cap) are ONE gate call on ONE transaction, deduped', async () => {
      mockCommon();
      const { db } = deletionDb();
      jest.doMock('../models/db', () => db);
      const acquireTermiteGateAtEntry = jest.fn(async () => []);
      jest.doMock('../services/annual-prepay-renewals', () => ({
        ...jest.requireActual('../services/annual-prepay-renewals'),
        acquireTermiteGateAtEntry,
      }));
      const ids = Array.from({ length: 9 }, (_, i) => `cust-${i}`);
      const { withCustomerDeletionGate } = require('../services/termite-annual-renewal-charge');
      await expect(withCustomerDeletionGate([...ids, 'cust-0', null, undefined], async () => 'deleted')).resolves.toBe('deleted');
      expect(db.transaction).toHaveBeenCalledTimes(1);
      expect(acquireTermiteGateAtEntry).toHaveBeenCalledTimes(1);
      expect(acquireTermiteGateAtEntry.mock.calls[0][1]).toEqual({ customerIds: ids });
    });

    // Codex #4971 r21 P1: a gate that cannot be taken (a renewal action
    // holding it past lock_timeout) aborts the deletion — fn never runs, the
    // typed error reaches the route (which answers 409).
    test('a gate that times out aborts before any deletion write, with the typed error', async () => {
      mockCommon();
      const { db } = deletionDb();
      jest.doMock('../models/db', () => db);
      jest.doMock('../services/annual-prepay-renewals', () => ({
        ...jest.requireActual('../services/annual-prepay-renewals'),
        acquireTermiteGateAtEntry: jest.fn(async () => {
          throw Object.assign(new Error('could not acquire the parent-decision lock'), { code: 'PARENT_DECISION_LOCK_TIMEOUT' });
        }),
      }));
      const { withCustomerDeletionGate } = require('../services/termite-annual-renewal-charge');
      const fn = jest.fn(async () => 'deleted');
      await expect(withCustomerDeletionGate('cust-1', fn)).rejects.toMatchObject({ code: 'PARENT_DECISION_LOCK_TIMEOUT' });
      expect(fn).not.toHaveBeenCalled();
    });
  });

  // Codex #4971 r17 P2 — finding 3: the staff decline bell must report the
  // ACTUAL amount Stripe was asked for (attemptedChargeAmount, the SAME
  // source the customer's own decline SMS uses — the durable
  // stripe_invoice_charge_attempts row), never the full prepay_amount,
  // which overstates it whenever account credit reduced the cash amount
  // actually tried (a $249 renewal with $100 credit tries $149).
  // Codex #4971 r23 P1: the lapse-void provenance. The move-15 shape (the
  // customer declined the NEXT renewal while this successor was unpaid)
  // keeps renewal_decision 'cancel' after its lapse void settles it, so
  // "undecided" cannot be the test — the persisted lapse start is.
  describe('lapseVoidAlreadyRanFor (recovery provenance)', () => {
    const voided = { status: 'void' };
    test('cancelled + voided invoice + no decision: the lapse void ran', () => {
      mockCommon();
      const { _private } = require('../services/termite-annual-renewal-charge');
      expect(_private.lapseVoidAlreadyRanFor({ status: 'cancelled', renewal_decision: null }, voided)).toBe(true);
    });
    test('cancelled + voided invoice + a declined NEXT renewal whose lapse had started: the lapse void ran (resumes retrieval + parent decision)', () => {
      mockCommon();
      const { _private } = require('../services/termite-annual-renewal-charge');
      expect(_private.lapseVoidAlreadyRanFor({ status: 'cancelled', renewal_decision: 'cancel', renewal_lapse_started_at: new Date() }, voided)).toBe(true);
    });
    test('a decided cancel with NO lapse ever started is an external cancel, not ours; other shapes never match', () => {
      mockCommon();
      const { _private } = require('../services/termite-annual-renewal-charge');
      expect(_private.lapseVoidAlreadyRanFor({ status: 'cancelled', renewal_decision: 'cancel', renewal_lapse_started_at: null }, voided)).toBe(false);
      expect(_private.lapseVoidAlreadyRanFor({ status: 'cancelled', renewal_decision: 'renew', renewal_lapse_started_at: new Date() }, voided)).toBe(false);
      expect(_private.lapseVoidAlreadyRanFor({ status: 'payment_pending', renewal_decision: null, renewal_lapse_started_at: new Date() }, voided)).toBe(false);
      expect(_private.lapseVoidAlreadyRanFor({ status: 'cancelled', renewal_decision: null }, { status: 'paid' })).toBe(false);
      expect(_private.lapseVoidAlreadyRanFor({ status: 'cancelled', renewal_decision: null }, null)).toBe(false);
    });
  });

  // Synchronous withdrawal (owner ruling 2026-09-28): afterParentChange runs
  // the withdrawal after the writer's OUTERMOST commit when handed a
  // transaction, now when handed the root handle, never on a rollback, and
  // not at all while the gate is off.
  describe('afterParentChange (synchronous withdrawal dispatch)', () => {
    function withdrawalDb() {
      const successorLookup = jest.fn(async () => null);
      const whereCalls = [];
      const chain = {};
      for (const m of ['where', 'whereIn', 'whereNotNull', 'whereNull', 'whereRaw']) {
        chain[m] = jest.fn((...args) => { if (m === 'where') whereCalls.push(args[0]); return chain; });
      }
      chain.first = successorLookup;
      chain.select = jest.fn(async () => []);
      const db = Object.assign(jest.fn(() => chain), { transaction: jest.fn() });
      return { db, successorLookup, whereCalls };
    }
    const flush = async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); };

    test('a transaction: nothing runs until the outermost commit, then the withdrawal looks the successor up', async () => {
      mockCommon();
      process.env.GATE_TERMITE_ANNUAL_PLAN = 'true';
      const { db, successorLookup } = withdrawalDb();
      jest.doMock('../models/db', () => db);
      const { afterParentChange } = require('../services/termite-annual-renewal-charge');
      let commit;
      const root = { executionPromise: new Promise((resolve) => { commit = resolve; }) };
      const savepoint = { parentTransaction: root, executionPromise: Promise.resolve() };
      await afterParentChange(savepoint, 'parent-1', 'test');
      await flush();
      expect(successorLookup).not.toHaveBeenCalled();
      commit();
      await flush();
      expect(successorLookup).toHaveBeenCalledTimes(1);
    });

    // Review of #5197: the deferred run must not inherit the writer's held-lock
    // context — it runs through runOutsideParentDecisionLocks.
    test('a deferred run executes outside the captured lock context', async () => {
      mockCommon();
      process.env.GATE_TERMITE_ANNUAL_PLAN = 'true';
      const { db, successorLookup } = withdrawalDb();
      jest.doMock('../models/db', () => db);
      const runOutsideParentDecisionLocks = jest.fn((fn) => fn());
      jest.doMock('../services/annual-prepay-renewals', () => ({
        ...jest.requireActual('../services/annual-prepay-renewals'),
        runOutsideParentDecisionLocks,
      }));
      const { afterParentChange } = require('../services/termite-annual-renewal-charge');
      await afterParentChange({ executionPromise: Promise.resolve() }, 'parent-1', 'test');
      await flush();
      expect(runOutsideParentDecisionLocks).toHaveBeenCalledTimes(1);
      expect(successorLookup).toHaveBeenCalledTimes(1);
    });

    test('a rolled-back transaction runs nothing', async () => {
      mockCommon();
      process.env.GATE_TERMITE_ANNUAL_PLAN = 'true';
      const { db, successorLookup } = withdrawalDb();
      jest.doMock('../models/db', () => db);
      const { afterParentChange } = require('../services/termite-annual-renewal-charge');
      const rolledBack = { executionPromise: Promise.reject(new Error('rolled back')) };
      rolledBack.executionPromise.catch(() => {});
      await afterParentChange(rolledBack, 'parent-1', 'test');
      await flush();
      expect(successorLookup).not.toHaveBeenCalled();
    });

    test('the root handle: the write already committed, so the withdrawal runs now and is awaited', async () => {
      mockCommon();
      process.env.GATE_TERMITE_ANNUAL_PLAN = 'true';
      const { db, successorLookup } = withdrawalDb();
      jest.doMock('../models/db', () => db);
      const { afterParentChange } = require('../services/termite-annual-renewal-charge');
      await afterParentChange(db, 'parent-1', 'test');
      expect(successorLookup).toHaveBeenCalledTimes(1);
    });

    test('successorItself: the edited term is the unpaid renewal — it is looked up by its own id', async () => {
      mockCommon();
      process.env.GATE_TERMITE_ANNUAL_PLAN = 'true';
      const { db, successorLookup, whereCalls } = withdrawalDb();
      jest.doMock('../models/db', () => db);
      const { afterParentChange } = require('../services/termite-annual-renewal-charge');
      await afterParentChange(db, 'succ-1', 'test', { successorItself: true });
      expect(whereCalls).toContainEqual({ id: 'succ-1', status: 'payment_pending' });
      expect(successorLookup).toHaveBeenCalledTimes(1);
    });

    test('a lookup that throws is contained — the caller (already committed) never sees it', async () => {
      mockCommon();
      process.env.GATE_TERMITE_ANNUAL_PLAN = 'true';
      const db = Object.assign(jest.fn(() => { throw new Error('connection reset'); }), { transaction: jest.fn() });
      jest.doMock('../models/db', () => db);
      const { afterParentChange, withdrawUnpaidSuccessorsOfCustomers } = require('../services/termite-annual-renewal-charge');
      await expect(afterParentChange(db, 'parent-1', 'test')).resolves.toBeNull();
      await expect(withdrawUnpaidSuccessorsOfCustomers(['cust-1'], 'test')).resolves.toEqual([]);
    });

    test('gate off: nothing is looked up (the feature is dark)', async () => {
      mockCommon();
      delete process.env.GATE_TERMITE_ANNUAL_PLAN;
      const { db, successorLookup } = withdrawalDb();
      jest.doMock('../models/db', () => db);
      const { afterParentChange } = require('../services/termite-annual-renewal-charge');
      await afterParentChange(db, 'parent-1', 'test');
      expect(successorLookup).not.toHaveBeenCalled();
    });
  });

  describe('ringRenewalBell — declined amount', () => {
    function attemptQuery(amount) {
      const q = {};
      ['where', 'whereNotNull', 'orWhereNotNull', 'orderBy'].forEach((m) => {
        q[m] = jest.fn((arg) => {
          if (typeof arg === 'function') arg.call(q, q);
          return q;
        });
      });
      q.first = jest.fn(async () => (amount == null ? undefined : { amount }));
      return q;
    }

    test('a declined charge bell reports the attempted amount, not the full prepay_amount', async () => {
      mockCommon();
      const notifyAdmin = jest.fn(async () => ({ id: 'n1' }));
      jest.doMock('../services/notification-service', () => ({ notifyAdmin }));
      jest.doMock('../models/db', () => jest.fn((table) => {
        if (table === 'stripe_invoice_charge_attempts as a') return attemptQuery(149);
        throw new Error(`unexpected table ${table}`);
      }));
      const { _private } = require('../services/termite-annual-renewal-charge');
      const successor = { id: 'succ-1', customer_id: 'cust-1', prepay_amount: 249, prepay_invoice_id: 'inv-1' };
      await _private.ringRenewalBell(successor, 'declined', 'card_declined');
      expect(notifyAdmin).toHaveBeenCalledWith('billing', expect.any(String), expect.stringContaining('$149.00'), expect.any(Object));
      expect(notifyAdmin).toHaveBeenCalledWith('billing', expect.any(String), expect.not.stringContaining('$249.00'), expect.any(Object));
    });

    test('every other bell kind is unaffected — still reports the full prepay_amount', async () => {
      mockCommon();
      const notifyAdmin = jest.fn(async () => ({ id: 'n1' }));
      jest.doMock('../services/notification-service', () => ({ notifyAdmin }));
      jest.doMock('../models/db', () => jest.fn((table) => {
        throw new Error(`unexpected table ${table} — a non-declined bell must never read stripe_invoice_charge_attempts`);
      }));
      const { _private } = require('../services/termite-annual-renewal-charge');
      const successor = { id: 'succ-1', customer_id: 'cust-1', prepay_amount: 249, prepay_invoice_id: 'inv-1' };
      await _private.ringRenewalBell(successor, 'refused', 'Auto Pay inactive');
      expect(notifyAdmin).toHaveBeenCalledWith('billing', expect.any(String), expect.stringContaining('$249.00'), expect.any(Object));
    });

    // Codex #4971 r18 P2: a failed pay-link delivery never claims "sent" —
    // it rings under its own ':undelivered' dedupe key, so the later
    // successful delivery's "sent" bell is not deduped behind it.
    test('a refused bell after a FAILED pay-link delivery says it was not sent, under its own dedupe key', async () => {
      mockCommon();
      const notifyAdmin = jest.fn(async () => ({ id: 'n1' }));
      jest.doMock('../services/notification-service', () => ({ notifyAdmin }));
      jest.doMock('../models/db', () => jest.fn((table) => { throw new Error(`unexpected table ${table}`); }));
      const { _private } = require('../services/termite-annual-renewal-charge');
      const successor = { id: 'succ-1', customer_id: 'cust-1', prepay_amount: 249, prepay_invoice_id: 'inv-1' };

      await _private.ringRenewalBell(successor, 'refused', 'Auto Pay inactive', { delivered: false });
      expect(notifyAdmin).toHaveBeenLastCalledWith('billing', expect.any(String), expect.stringMatching(/could NOT be sent yet/), expect.objectContaining({
        dedupeKey: 'termite-renewal-charge:succ-1:refused:undelivered',
      }));
      expect(notifyAdmin.mock.calls[0][2]).not.toMatch(/was sent with its pay link/);

      await _private.ringRenewalBell(successor, 'refused', 'Auto Pay inactive');
      expect(notifyAdmin).toHaveBeenLastCalledWith('billing', expect.any(String), expect.stringMatching(/was sent with its pay link/), expect.objectContaining({
        dedupeKey: 'termite-renewal-charge:succ-1:refused',
      }));
    });
  });

  // Codex #4971 r15 P2 — finding 4: the charge-failed customer notice's own
  // retry/settle classification (followThroughChargeOutcome's
  // recordChargeFailedNoticeOutcome reads this to decide whether `done` may
  // stamp renewal_charge_failure_handled_at). See the leg-7c Postgres-free
  // unit test above ("the customer notice is never re-sent") and the real-
  // Postgres evidence suite for the end-to-end retry-until-durably-sent
  // behavior; this pins the classification itself.
  describe('chargeFailedNoticeMustRetry', () => {
    test('an accepted send needs no retry', () => {
      mockCommon();
      const { _private } = require('../services/termite-annual-renewal-charge');
      expect(_private.chargeFailedNoticeMustRetry({ sent: true, deliveryOutcome: 'accepted' })).toBe(false);
    });

    test('a quiet-hours defer (sendCustomerMessage\'s own { deferred: true }) must retry', () => {
      mockCommon();
      const { _private } = require('../services/termite-annual-renewal-charge');
      expect(_private.chargeFailedNoticeMustRetry({ sent: false, blocked: true, deferred: true, code: 'QUIET_HOURS_HOLD' })).toBe(true);
    });

    test('withPayLinkClearance\'s own \'deferred\' withholding (a dispute-suspended pay link) must retry', () => {
      mockCommon();
      const { _private } = require('../services/termite-annual-renewal-charge');
      expect(_private.chargeFailedNoticeMustRetry({ sent: false, reason: 'deferred' })).toBe(true);
    });

    test('withPayLinkClearance\'s \'handled\' withholding (no longer owed) settles — never retried', () => {
      mockCommon();
      const { _private } = require('../services/termite-annual-renewal-charge');
      expect(_private.chargeFailedNoticeMustRetry({ sent: false, reason: 'handled' })).toBe(false);
    });

    test('a permanent local refusal (no phone / no pay url / missing template / payer-billed) settles — never retried', () => {
      mockCommon();
      const { _private } = require('../services/termite-annual-renewal-charge');
      for (const reason of ['no_phone', 'no_pay_url', 'missing_template', 'payer_billed']) {
        expect(_private.chargeFailedNoticeMustRetry({ sent: false, reason })).toBe(false);
      }
    });

    test('no outcome at all (the attempt threw) must retry — never silently counted as settled', () => {
      mockCommon();
      const { _private } = require('../services/termite-annual-renewal-charge');
      expect(_private.chargeFailedNoticeMustRetry(null)).toBe(true);
      expect(_private.chargeFailedNoticeMustRetry(undefined)).toBe(true);
    });

    // Codex #4971 r16 P2 — finding 8: renewalPayerRouting's own lookup
    // failure (withPayLinkClearance's { code: 'payer_unverifiable' }, whose
    // own doc says "fail closed, retry later") used to fall through the old
    // default-false and settle forever, dropping the customer notice for
    // good the first time the payer lookup merely errored. Now retryable,
    // like any other reason not on the terminal allowlist.
    test('payer_unverifiable (the payer lookup failed) must retry — never silently counted as settled', () => {
      mockCommon();
      const { _private } = require('../services/termite-annual-renewal-charge');
      expect(_private.chargeFailedNoticeMustRetry({ sent: false, reason: 'payer_unverifiable' })).toBe(true);
    });

    test('an unrecognized/future reason not on the terminal allowlist must retry by default', () => {
      mockCommon();
      const { _private } = require('../services/termite-annual-renewal-charge');
      expect(_private.chargeFailedNoticeMustRetry({ sent: false, reason: 'some_new_outcome_shape' })).toBe(true);
    });
  });

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

  function makeMintTrx({ parent, existingSuccessor = undefined, peek, stillDue } = {}) {
    const parentUpdate = jest.fn().mockResolvedValue(1);
    const invoiceLink = jest.fn().mockResolvedValue(1);
    // Codex #4971 pre-push P0: the mint re-runs the scan's own "renewal due"
    // predicate (whereRenewalCandidate) against the LOCKED parent row. This
    // stand-in answers it from the parent's own fields the way the SQL
    // would (live status, undecided, termite marker) unless a test pins it.
    const dueByFields = !!parent.annual_plan_version && !parent.renewal_decision
      && ['active', 'renewal_pending'].includes(parent.status);
    const duePredicate = {};
    for (const m of ['whereNotNull', 'whereIn', 'whereNull', 'where', 'whereNotExists', 'whereExists', 'orWhereNotNull']) {
      duePredicate[m] = jest.fn(() => duePredicate);
    }
    duePredicate.first = jest.fn(async () => ((stillDue ?? dueByFields) ? { id: parent.id } : undefined));
    const trx = jest.fn((table) => {
      if (table === 'annual_prepay_terms as t') return duePredicate;
      if (table === 'invoices') {
        // Codex round-7 P1: resolveParentEligibility's own paid-and-not-
        // refunded read, whenever the parent carries a linked invoice and
        // its status already passed the allow-list's status gate — 'paid'
        // by default so an ordinary 'active' parent (baseParent()'s own
        // shape) mints normally; a test exercising the refund race passes
        // its OWN parent without a prepay_invoice_id, or overrides this
        // via a fresh makeMintTrx if it ever needs the unpaid shape.
        // Codex #4971 r5 P1: the mint also writes the renewal invoice's link
        // to its successor term (invoiceLink) — the Bill-To fence keys on it.
        return { where: jest.fn().mockReturnValue({ first: jest.fn().mockResolvedValue({ status: 'paid', paid_at: new Date('2025-09-01T00:00:00Z') }), update: invoiceLink }) };
      }
      if (table === 'payments') {
        return { whereRaw: jest.fn().mockReturnValue({ first: jest.fn().mockResolvedValue(undefined) }) };
      }
      if (table === 'customers') return liveCustomerQuery();

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
    return { trx, parentUpdate, duePredicate, invoiceLink };
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
    jest.doMock('../services/annual-prepay-renewals', () => ({ withParentDecisionLock: (termId, fn) => fn(),
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
        if (table === 'customers') return liveCustomerQuery();
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
      const { trx, parentUpdate, invoiceLink } = makeMintTrx({ parent });
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
      // Codex #4971 r5 P1: the renewal invoice is linked to its term, strictly.
      expect(invoiceLink).toHaveBeenCalledWith({ annual_prepay_term_id: 'succ-term-1' });
      expect(parentUpdate).not.toHaveBeenCalled();
    });

    // Codex #4971 r16 P1 — finding 4: the WHOLE mint now runs inside
    // withParentDecisionLock, keyed on the PARENT term — the SAME key
    // withCustomerDeletionGate takes for every one of the customer's
    // renewable termite parent terms, so an account deletion racing in
    // during a mint either waits behind the whole mint or wins the gate
    // first and is seen by the mint's own re-check.
    // Codex #4971 r23 P1: the 45-day notice's quoted fee is frozen on the
    // parent (renewal_noticed_fee). A parent whose current prepay_amount no
    // longer matches it is never minted or charged automatically — one
    // staff bell (deduped on the parent) and null, so the sweep defers it.
    test('Codex #4971 r23 P1: a parent whose fee changed after the renewal notice is NOT minted — bell + null', async () => {
      mockCommon();
      const notifyAdmin = jest.fn(async () => ({ id: 'n1' }));
      jest.doMock('../services/notification-service', () => ({ notifyAdmin }));
      const parent = baseParent({ prepay_amount: '249.00', renewal_noticed_fee: '200.00' });
      const { trx } = makeMintTrx({ parent });
      const conn = { transaction: jest.fn(async (cb) => cb(trx)) };
      const { createTermForAnnualPrepay } = mockMintDeps();
      jest.doMock('../services/annual-prepay-renewals', () => ({
        withParentDecisionLock: jest.fn(async (_termId, fn) => fn()),
        createTermForAnnualPrepay,
        recordDecision: jest.fn(),
        TERMITE_RENEWAL_GRACE_DAYS: 30,
        termiteRenewalGraceDeadlineFor: jest.fn(() => '2099-01-01'),
      }));

      const { _private } = require('../services/termite-annual-renewal-charge');
      await expect(_private.mintRenewalSuccessor('parent-1', conn)).resolves.toBeNull();
      expect(createTermForAnnualPrepay).not.toHaveBeenCalled();
      expect(notifyAdmin).toHaveBeenCalledTimes(1);
      expect(notifyAdmin).toHaveBeenCalledWith('billing', expect.stringMatching(/fee changed after the renewal notice/i),
        expect.stringMatching(/\$249\.00.*\$200\.00/), expect.objectContaining({ dedupeKey: 'termite-renewal-charge:parent-1:fee_changed_after_notice' }));
    });

    // Codex #4971 r24 P1: a witnessed 45-day notice with NO frozen fee (a
    // row noticed before renewal_noticed_fee existed) fails CLOSED — the fee
    // the customer was told cannot be verified.
    test('Codex #4971 r24 P1: a witnessed notice with no frozen fee on record is NOT minted — bell + null', async () => {
      mockCommon();
      const notifyAdmin = jest.fn(async () => ({ id: 'n1' }));
      jest.doMock('../services/notification-service', () => ({ notifyAdmin }));
      const parent = baseParent({ prepay_amount: '249.00', notice_45_sent_at: new Date('2026-08-12T14:00:00Z'), renewal_noticed_fee: null });
      const { trx } = makeMintTrx({ parent });
      const conn = { transaction: jest.fn(async (cb) => cb(trx)) };
      const { createTermForAnnualPrepay } = mockMintDeps();
      jest.doMock('../services/annual-prepay-renewals', () => ({
        withParentDecisionLock: jest.fn(async (_termId, fn) => fn()),
        createTermForAnnualPrepay,
        recordDecision: jest.fn(),
        TERMITE_RENEWAL_GRACE_DAYS: 30,
        termiteRenewalGraceDeadlineFor: jest.fn(() => '2099-01-01'),
      }));
      const { _private } = require('../services/termite-annual-renewal-charge');
      await expect(_private.mintRenewalSuccessor('parent-1', conn)).resolves.toBeNull();
      expect(createTermForAnnualPrepay).not.toHaveBeenCalled();
      expect(notifyAdmin).toHaveBeenCalledWith('billing', expect.stringMatching(/noticed fee not on record/i),
        expect.stringContaining('2026-08-12'), expect.objectContaining({ dedupeKey: 'termite-renewal-charge:parent-1:notice_fee_unfrozen' }));
    });

    test('Codex #4971 r23 P1: a parent whose fee still matches the noticed fee (or was never noticed) mints normally', async () => {
      for (const noticed of ['249.00', null]) {
        jest.resetModules();
        mockCommon();
        const notifyAdmin = jest.fn(async () => ({ id: 'n1' }));
        jest.doMock('../services/notification-service', () => ({ notifyAdmin }));
        const parent = baseParent({ prepay_amount: '249.00', renewal_noticed_fee: noticed });
        const { trx } = makeMintTrx({ parent });
        const conn = { transaction: jest.fn(async (cb) => cb(trx)) };
        const { createTermForAnnualPrepay } = mockMintDeps();
        jest.doMock('../services/annual-prepay-renewals', () => ({
          withParentDecisionLock: jest.fn(async (_termId, fn) => fn()),
          createTermForAnnualPrepay,
          recordDecision: jest.fn(),
          TERMITE_RENEWAL_GRACE_DAYS: 30,
          termiteRenewalGraceDeadlineFor: jest.fn(() => '2099-01-01'),
        }));
        const { _private } = require('../services/termite-annual-renewal-charge');
        const result = await _private.mintRenewalSuccessor('parent-1', conn);
        expect(result.minted).toBe(true);
        expect(notifyAdmin).not.toHaveBeenCalledWith('billing', expect.stringMatching(/fee changed/i), expect.any(String), expect.any(Object));
      }
    });

    test('Codex #4971 r16 P1 (finding 4): the mint runs inside withParentDecisionLock, keyed on the parent id', async () => {
      mockCommon();
      const parent = baseParent();
      const { trx } = makeMintTrx({ parent });
      const conn = { transaction: jest.fn(async (cb) => cb(trx)) };
      const { createTermForAnnualPrepay } = mockMintDeps();
      const withParentDecisionLock = jest.fn(async (termId, fn) => {
        expect(termId).toBe('parent-1');
        return fn();
      });
      // Re-mock on top of mockMintDeps()'s own registration, reusing its
      // SAME createTermForAnnualPrepay spy so this test can still assert on
      // it, but with a spy-able withParentDecisionLock.
      jest.doMock('../services/annual-prepay-renewals', () => ({
        withParentDecisionLock,
        createTermForAnnualPrepay,
        recordDecision: jest.fn(),
        TERMITE_RENEWAL_GRACE_DAYS: 30,
        termiteRenewalGraceDeadlineFor: jest.fn(() => '2099-01-01'),
      }));

      const { _private } = require('../services/termite-annual-renewal-charge');
      const result = await _private.mintRenewalSuccessor('parent-1', conn);

      expect(result.minted).toBe(true);
      expect(withParentDecisionLock).toHaveBeenCalledTimes(1);
      // The transaction (the actual DB work) never even starts before the
      // gate is acquired.
      expect(conn.transaction).toHaveBeenCalledTimes(1);
    });

    test('Codex #4971 r16 P1 (finding 4): a gate that cannot be taken (a concurrent account deletion holding it) mints nothing at all', async () => {
      mockCommon();
      mockMintDeps();
      jest.doMock('../services/annual-prepay-renewals', () => ({
        withParentDecisionLock: jest.fn(async () => {
          throw Object.assign(new Error('could not acquire the parent-decision lock'), { code: 'PARENT_DECISION_LOCK_TIMEOUT' });
        }),
        createTermForAnnualPrepay: jest.fn(),
        recordDecision: jest.fn(),
        TERMITE_RENEWAL_GRACE_DAYS: 30,
        termiteRenewalGraceDeadlineFor: jest.fn(() => '2099-01-01'),
      }));
      const conn = { transaction: jest.fn() };

      const { _private } = require('../services/termite-annual-renewal-charge');
      await expect(_private.mintRenewalSuccessor('parent-1', conn)).rejects.toThrow('could not acquire the parent-decision lock');
      expect(conn.transaction).not.toHaveBeenCalled();
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

    // Codex #4971 pre-push P0: staff extended the parent's term_end (or the
    // on-time notice / anchor / window facts changed) after the candidate
    // scan but before the mint's row lock. Status and payment still pass;
    // the renewal is simply no longer due — the mint re-runs the scan's own
    // predicate against the LOCKED parent and mints nothing.
    test('P0: a parent no longer DUE under the mint lock (term_end extended after the scan) mints nothing — no invoice, no successor', async () => {
      mockCommon();
      const parent = baseParent({ term_end: '2027-09-26' });
      const { trx, duePredicate } = makeMintTrx({ parent, stillDue: false });
      const conn = { transaction: jest.fn(async (cb) => cb(trx)) };
      const { invoiceCreate, createTermForAnnualPrepay } = mockMintDeps();

      const { _private } = require('../services/termite-annual-renewal-charge');
      const result = await _private.mintRenewalSuccessor('parent-1', conn, '2026-09-27');

      expect(result).toBeNull();
      expect(duePredicate.where).toHaveBeenCalledWith('t.id', 'parent-1');
      expect(duePredicate.where).toHaveBeenCalledWith('t.term_end', '<=', '2026-09-27');
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
    successorInvoice = { status: 'sent' },
  } = {}) {
    const claimUpdate = jest.fn().mockResolvedValue(claimResult);
    const skipStampUpdate = jest.fn().mockResolvedValue(1);
    const deferredUpdate = jest.fn().mockResolvedValue(1);
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
                : successorInvoice,
            ),
          })),
        };
      }
      if (table === 'payments') {
        // No refund on file — parentInvoicePaidAndNotFullyRefunded's own
        // ledger check, run only once the invoice above reads paid.
        return { whereRaw: jest.fn().mockReturnValue({ first: jest.fn().mockResolvedValue(undefined) }) };
      }
      if (table === 'customers') return liveCustomerQuery();

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
          update: deferredUpdate,
        })),
      };
    });
    return { conn, claimUpdate, skipStampUpdate, deferredUpdate };
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
    // Delivered (chokepoint A: a persisted delivery stamp) — the pay link
    // already went out, so a durable refusal leaves it to the grace lapse.
    eligibilityInvoice = { status: 'sent', sent_at: new Date('2026-09-27T12:00:00Z') },
    claimResult = 1,
    freshInvoice = { status: 'paid', payment_method: 'card' },
    freshInvoiceError = null,
    // Successive OUTER-conn parent reads (the unlocked pre-check, then the
    // re-check under withParentDecisionLock right before Stripe) — lets a
    // test model a parent that changes between the two. Defaults to
    // `parent` for every read.
    outerParentReads = null,
    // An unresolved attempt WITH submission evidence on the successor's
    // invoice (the withdrawal's money-in-motion check). Default: none.
    pendingAttempt = undefined,
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
      if (table === 'customers') return liveCustomerQuery();
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
    // Codex #4971 r15 P2: the charge-failed customer notice's own durable
    // "sent" stamp (recordChargeFailedNoticeOutcome).
    const noticeStampUpdate = jest.fn().mockResolvedValue(1);
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
    const fenceReleaseUpdate = jest.fn().mockResolvedValue(1);
    const parentReads = outerParentReads ? [...outerParentReads] : null;
    const outerParent = () => (parentReads && parentReads.length > 1 ? parentReads.shift() : (parentReads ? parentReads[0] : parent));
    const conn = jest.fn((table) => {
      if (table === 'invoices') {
        return { where: jest.fn().mockReturnValue({ first: outerInvoiceFirst }) };
      }
      if (table === 'stripe_invoice_charge_attempts as a') {
        // No attempt with submission evidence (retireUnpresentedSuccessor's
        // "was it presented" read).
        const q = { where: jest.fn(() => q), first: jest.fn().mockResolvedValue(pendingAttempt) };
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
            // B10: the collection-hold refusal hands the claimed fence back.
            whereNotNull: jest.fn((col) => {
              expect(col).toBe('renewal_charge_attempted_at');
              return { whereNull: jest.fn((c2) => { expect(c2).toBe('renewal_charge_claim_retired_at'); return { update: fenceReleaseUpdate }; }) };
            }),
            whereNull: jest.fn((col) => {
              if (col === 'renewal_charge_never_reached_stripe_belled_at') return { update: handledStampUpdate };
              // Codex #4971 r15 P2: the charge-failed customer notice's own
              // durable delivery stamp (recordChargeFailedNoticeOutcome) —
              // untracked here; no test in this block asserts on it.
              if (col === 'renewal_charge_failed_notice_sent_at') return { update: noticeStampUpdate };
              expect(col).toBe('renewal_charge_skipped_at');
              return { update: skipStampUpdate };
            }),
          })),
        };
      }
      if (table === 'customers') return liveCustomerQuery();
      throw new Error(`unexpected table ${table} on outer conn`);
    });
    conn.transaction = jest.fn(async (cb) => cb(trx));
    return { conn, trx, claimUpdate, skipStampUpdate, handledStampUpdate, noticeStampUpdate, deferredUpdate, fenceReleaseUpdate };
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
      jest.doMock('../services/stripe', () => ({ assertNoInvoiceChargeReconciliationPending: jest.fn(async () => undefined), chargeInvoiceWithSavedCard, quoteInvoiceSavedCardCharge }));

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

    // Codex #4971 pre-push P1: the no_consent skip stamp excludes the row
    // from leg 7a, so it needs a CONFIRMED bell too — and the retry after a
    // lost bell must not text the customer the invoice a second time.
    test('no consent: the pay link went out but the bell did not persist — NOT skipped; the retry re-rings without re-sending', async () => {
      mockCommon();
      const sendViaSMSAndEmail = jest.fn(async () => ({ ok: true }));
      jest.doMock('../services/invoice', () => ({ sendViaSMSAndEmail }));
      const notifyAdmin = jest.fn().mockResolvedValueOnce(null).mockResolvedValue({ id: 'n2', deduped: false });
      jest.doMock('../services/notification-service', () => ({ notifyAdmin }));
      jest.doMock('../services/recurring-card-on-file', () => ({ resolvePrepayChargeMethod: jest.fn() }));
      jest.doMock('../services/stripe', () => ({ assertNoInvoiceChargeReconciliationPending: jest.fn(async () => undefined), chargeInvoiceWithSavedCard: jest.fn(), quoteInvoiceSavedCardCharge: jest.fn() }));

      const { _private } = require('../services/termite-annual-renewal-charge');
      const parent = baseParent({ renewal_charge_consent_at: null });
      const first = makeClaimConn();
      await _private.decideAndCharge(baseSuccessor(), parent, first.conn);
      expect(sendViaSMSAndEmail).toHaveBeenCalledTimes(1);
      expect(first.skipStampUpdate).not.toHaveBeenCalled();

      // Next tick: the invoice now carries its delivery stamp.
      const retry = makeClaimConn({ successorInvoice: { status: 'sent', sms_sent_at: new Date('2026-09-27T12:00:00Z') } });
      await _private.decideAndCharge(baseSuccessor(), parent, retry.conn);
      expect(sendViaSMSAndEmail).toHaveBeenCalledTimes(1); // never re-sent
      expect(retry.skipStampUpdate).toHaveBeenCalledWith(expect.objectContaining({ renewal_charge_skip_reason: 'no_consent' }));
    });

    test('no consent: a send that landed between the stamp read and the call is not repeated — marked skipped (handled)', async () => {
      mockCommon();
      jest.doMock('../models/db', () => {
        const dbFn = jest.fn(() => ({ where: jest.fn(() => ({ first: jest.fn(async () => ({ status: 'sent', sent_at: new Date() })) })) }));
        dbFn.schema = { hasTable: jest.fn().mockResolvedValue(true) };
        return dbFn;
      });
      const sendViaSMSAndEmail = jest.fn(async () => { throw Object.assign(new Error('already delivered'), { code: 'already_delivered' }); });
      jest.doMock('../services/invoice', () => ({ sendViaSMSAndEmail }));
      jest.doMock('../services/notification-service', () => ({ notifyAdmin: jest.fn(async () => ({ id: 'n1' })) }));
      jest.doMock('../services/recurring-card-on-file', () => ({ resolvePrepayChargeMethod: jest.fn() }));
      jest.doMock('../services/stripe', () => ({ assertNoInvoiceChargeReconciliationPending: jest.fn(async () => undefined), chargeInvoiceWithSavedCard: jest.fn(), quoteInvoiceSavedCardCharge: jest.fn() }));
      const { _private } = require('../services/termite-annual-renewal-charge');
      const { conn, skipStampUpdate } = makeClaimConn({ successorInvoice: { status: 'draft' } });

      await _private.decideAndCharge(baseSuccessor(), baseParent({ renewal_charge_consent_at: null }), conn);

      expect(sendViaSMSAndEmail).toHaveBeenCalledTimes(1);
      expect(skipStampUpdate).toHaveBeenCalledWith(expect.objectContaining({ renewal_charge_skip_reason: 'no_consent' }));
    });

    test('B10: an active collections dispute hold defers the renewal charge — no quote, no fence, no Stripe call, sweep-deferred stamp', async () => {
      mockCommon();
      const notifyAdmin = jest.fn(async () => ({ id: 'n1' }));
      jest.doMock('../services/notification-service', () => ({ notifyAdmin }));
      jest.doMock('../services/invoice', () => ({ sendViaSMSAndEmail: jest.fn(async () => ({ ok: true })) }));
      jest.doMock('../services/recurring-card-on-file', () => ({
        resolvePrepayChargeMethod: jest.fn(async () => ({ paymentMethodRowId: 'pm-row-1', methodType: 'card' })),
      }));
      const chargeInvoiceWithSavedCard = jest.fn();
      const quoteInvoiceSavedCardCharge = jest.fn();
      jest.doMock('../services/stripe', () => ({ assertNoInvoiceChargeReconciliationPending: jest.fn(async () => undefined), chargeInvoiceWithSavedCard, quoteInvoiceSavedCardCharge }));

      const { _private } = require('../services/termite-annual-renewal-charge');
      jest.doMock('../services/collections/collection-hold', () => ({ customerHasActiveCollectionHold: jest.fn(async () => true) }));
      const { conn, deferredUpdate } = makeClaimConn();
      const outcome = await _private.decideAndCharge(baseSuccessor(), baseParent(), conn);

      expect(outcome).toEqual({ status: 'deferred', reason: 'collection_hold' });
      expect(quoteInvoiceSavedCardCharge).not.toHaveBeenCalled();
      expect(chargeInvoiceWithSavedCard).not.toHaveBeenCalled();
      expect(deferredUpdate).toHaveBeenCalled();
    });

    test('B10: a collection-hold lookup failure fails closed — deferred, never charged', async () => {
      mockCommon();
      jest.doMock('../services/notification-service', () => ({ notifyAdmin: jest.fn(async () => ({ id: 'n1' })) }));
      jest.doMock('../services/invoice', () => ({ sendViaSMSAndEmail: jest.fn(async () => ({ ok: true })) }));
      jest.doMock('../services/recurring-card-on-file', () => ({
        resolvePrepayChargeMethod: jest.fn(async () => ({ paymentMethodRowId: 'pm-row-1', methodType: 'card' })),
      }));
      const chargeInvoiceWithSavedCard = jest.fn();
      jest.doMock('../services/stripe', () => ({ assertNoInvoiceChargeReconciliationPending: jest.fn(async () => undefined), chargeInvoiceWithSavedCard, quoteInvoiceSavedCardCharge: jest.fn() }));

      const { _private } = require('../services/termite-annual-renewal-charge');
      jest.doMock('../services/collections/collection-hold', () => ({ customerHasActiveCollectionHold: jest.fn(async () => { throw new Error('flags unreadable'); }) }));
      const { conn } = makeClaimConn();
      const outcome = await _private.decideAndCharge(baseSuccessor(), baseParent(), conn);

      expect(outcome).toEqual({ status: 'deferred', reason: 'collection_hold' });
      expect(chargeInvoiceWithSavedCard).not.toHaveBeenCalled();
    });

    test('consent present but no chargeable saved method -> invoice + bell, no Stripe call', async () => {
      mockCommon();
      const sendViaSMSAndEmail = jest.fn(async () => ({ ok: true }));
      jest.doMock('../services/invoice', () => ({ sendViaSMSAndEmail }));
      const notifyAdmin = jest.fn(async () => ({ id: 'n1' }));
      jest.doMock('../services/notification-service', () => ({ notifyAdmin }));
      jest.doMock('../services/recurring-card-on-file', () => ({ resolvePrepayChargeMethod: jest.fn(async () => null) }));
      const chargeInvoiceWithSavedCard = jest.fn();
      jest.doMock('../services/stripe', () => ({ assertNoInvoiceChargeReconciliationPending: jest.fn(async () => undefined), chargeInvoiceWithSavedCard, quoteInvoiceSavedCardCharge: jest.fn() }));

      const { _private } = require('../services/termite-annual-renewal-charge');
      const { conn, skipStampUpdate } = makeClaimConn();
      const outcome = await _private.decideAndCharge(baseSuccessor(), baseParent(), conn);

      expect(outcome.status).toBe('no_method');
      expect(notifyAdmin).toHaveBeenCalledWith('billing', expect.stringMatching(/no saved payment method/i), expect.any(String), expect.any(Object));
      expect(chargeInvoiceWithSavedCard).not.toHaveBeenCalled();
      expect(skipStampUpdate).toHaveBeenCalledWith(expect.objectContaining({ renewal_charge_skip_reason: 'no_method' }));
    });

    // Codex #4971 r29 P2: a lookup FAILURE defers (bell + sweep rotation,
    // retried by leg 7a) — never the terminal no_method skip.
    test('a transient saved-method lookup failure defers the charge — no no_method skip stamp, no pay link', async () => {
      mockCommon();
      const sendViaSMSAndEmail = jest.fn(async () => ({ ok: true }));
      jest.doMock('../services/invoice', () => ({ sendViaSMSAndEmail }));
      const notifyAdmin = jest.fn(async () => ({ id: 'n1' }));
      jest.doMock('../services/notification-service', () => ({ notifyAdmin }));
      jest.doMock('../services/recurring-card-on-file', () => ({ resolvePrepayChargeMethod: jest.fn(async () => { throw new Error('connection reset'); }) }));
      const chargeInvoiceWithSavedCard = jest.fn();
      jest.doMock('../services/stripe', () => ({ assertNoInvoiceChargeReconciliationPending: jest.fn(async () => undefined), chargeInvoiceWithSavedCard, quoteInvoiceSavedCardCharge: jest.fn() }));

      const { _private } = require('../services/termite-annual-renewal-charge');
      const { conn, skipStampUpdate } = makeClaimConn();
      const outcome = await _private.decideAndCharge(baseSuccessor(), baseParent(), conn);

      expect(outcome).toEqual({ status: 'deferred', reason: 'saved_method_unavailable' });
      expect(chargeInvoiceWithSavedCard).not.toHaveBeenCalled();
      expect(sendViaSMSAndEmail).not.toHaveBeenCalled();
      expect(skipStampUpdate).not.toHaveBeenCalledWith(expect.objectContaining({ renewal_charge_skip_reason: 'no_method' }));
      expect(notifyAdmin).toHaveBeenCalledWith('billing', expect.any(String), expect.stringContaining('connection reset'), expect.any(Object));
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
      jest.doMock('../services/stripe', () => ({ assertNoInvoiceChargeReconciliationPending: jest.fn(async () => undefined), chargeInvoiceWithSavedCard, quoteInvoiceSavedCardCharge }));

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

    // Codex #4971 r12 P1: with no quote there is nothing to verify the total
    // collected against (cash + applied credit) — the charge is deferred:
    // never attempted, the fence unclaimed, rotated for leg 7a.
    test('a quote failure defers the charge — no fence claim, no Stripe call, rotated for a retry', async () => {
      mockCommon();
      mockGraceHelpers({ graceDays: 30 });
      jest.doMock('../services/invoice', () => ({ sendViaSMSAndEmail: jest.fn() }));
      jest.doMock('../services/notification-service', () => ({ notifyAdmin: jest.fn() }));
      jest.doMock('../services/recurring-card-on-file', () => ({
        resolvePrepayChargeMethod: jest.fn(async () => ({ paymentMethodRowId: 'pm-1' })),
      }));
      const chargeInvoiceWithSavedCard = jest.fn(async () => ({ status: 'paid' }));
      const quoteInvoiceSavedCardCharge = jest.fn(async () => { throw new Error('quote unavailable'); });
      jest.doMock('../services/stripe', () => ({ assertNoInvoiceChargeReconciliationPending: jest.fn(async () => undefined), chargeInvoiceWithSavedCard, quoteInvoiceSavedCardCharge }));

      const { _private } = require('../services/termite-annual-renewal-charge');
      const successor = baseSuccessor();
      const { conn, claimUpdate, deferredUpdate } = makeDecideConn({ successor });
      const outcome = await _private.decideAndCharge(successor, baseParent(), conn);

      expect(outcome).toEqual({ status: 'deferred', reason: 'charge_quote_unavailable' });
      expect(claimUpdate).not.toHaveBeenCalled();
      expect(chargeInvoiceWithSavedCard).not.toHaveBeenCalled();
      expect(deferredUpdate).toHaveBeenCalledWith({ renewal_sweep_deferred_at: expect.any(Date) });
    });

    // Codex #4971 r16 P1 — finding 3: a payer assigned to this invoice since
    // the mint makes the quote throw the SAME typed PAYER_BILLED_GUARD
    // chargeInvoiceWithSavedCard itself throws (stripe.js) — this must route
    // into the payer_billed follow-through (deliverInvoiceAndStampSkip),
    // never the generic 'charge_quote_unavailable' deferral (which the
    // payer can never resolve either, so it retried forever before this
    // fix).
    test('a payer-billed quote (PAYER_BILLED_GUARD) routes to the payer follow-through — no Stripe call, no forever-retry', async () => {
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
      const payerGuardErr = Object.assign(new Error('Invoice is billed to a third-party payer'), { code: 'PAYER_BILLED_GUARD' });
      const quoteInvoiceSavedCardCharge = jest.fn(async () => { throw payerGuardErr; });
      jest.doMock('../services/stripe', () => ({ assertNoInvoiceChargeReconciliationPending: jest.fn(async () => undefined), chargeInvoiceWithSavedCard, quoteInvoiceSavedCardCharge }));
      jest.doMock('../services/payer', () => ({ resolveForInvoice: jest.fn(async () => ({ payerId: 'payer-9' })) }));

      const { _private } = require('../services/termite-annual-renewal-charge');
      const successor = baseSuccessor();
      const { conn, claimUpdate, skipStampUpdate, deferredUpdate } = makeClaimConn({ successor, successorInvoice: { status: 'draft' } });
      const outcome = await _private.decideAndCharge(successor, baseParent(), conn);

      expect(outcome).toEqual({ status: 'payer_billed' });
      expect(chargeInvoiceWithSavedCard).not.toHaveBeenCalled();
      expect(claimUpdate).not.toHaveBeenCalled();
      // Never the old, undifferentiated forever-retry deferral.
      expect(deferredUpdate).not.toHaveBeenCalled();
      expect(sendViaSMSAndEmail).not.toHaveBeenCalled();
      expect(notifyAdmin).toHaveBeenCalledWith('billing', expect.stringMatching(/third-party payer/i), expect.any(String), expect.objectContaining({
        dedupeKey: 'termite-renewal-charge:succ-term-1:payer_billed',
      }));
      expect(skipStampUpdate).toHaveBeenCalledWith(expect.objectContaining({ renewal_charge_skip_reason: 'payer_assigned:payer_billed' }));
    });

    // Codex #4971 r12 P1 — ONE ceiling: cash total (surcharge included) +
    // the credit the charge applies must not exceed the flat renewal fee;
    // the provider gets the matching cash ceiling and the pinned cash total.
    describe('the renewal charge ceiling counts applied account credit', () => {
      function load(quote) {
        mockCommon();
        mockGraceHelpers({ graceDays: 30 });
        const sendViaSMSAndEmail = jest.fn(async () => ({ ok: true }));
        jest.doMock('../services/invoice', () => ({ sendViaSMSAndEmail }));
        jest.doMock('../services/notification-service', () => ({ notifyAdmin: jest.fn(async () => ({ id: 'n1' })) }));
        jest.doMock('../services/recurring-card-on-file', () => ({
          resolvePrepayChargeMethod: jest.fn(async () => ({ paymentMethodRowId: 'pm-1' })),
        }));
        mockSignatureChargePrivate({ classifyVerifiedChargeImpl: jest.fn(() => ({ status: 'paid' })) });
        const chargeInvoiceWithSavedCard = jest.fn(async () => ({ status: 'paid' }));
        jest.doMock('../services/stripe', () => ({
          assertNoInvoiceChargeReconciliationPending: jest.fn(async () => undefined),
          chargeInvoiceWithSavedCard,
          quoteInvoiceSavedCardCharge: jest.fn(async () => quote),
        }));
        return { chargeInvoiceWithSavedCard, sendViaSMSAndEmail };
      }

      test('a $249 renewal with $100 of credit on a surcharged card ($153.32 cash, $253.32 in total) is never auto-charged — the pay link instead', async () => {
        const { chargeInvoiceWithSavedCard, sendViaSMSAndEmail } = load({ base: 149, surcharge: 4.32, total: 153.32, projectedCreditApplied: 100 });
        const { _private } = require('../services/termite-annual-renewal-charge');
        const { conn, claimUpdate, skipStampUpdate } = makeClaimConn();

        const outcome = await _private.decideAndCharge(baseSuccessor(), baseParent(), conn);

        expect(outcome.status).toBe('surcharge_not_authorized');
        expect(claimUpdate).not.toHaveBeenCalled();
        expect(chargeInvoiceWithSavedCard).not.toHaveBeenCalled();
        expect(sendViaSMSAndEmail).toHaveBeenCalledTimes(1);
        expect(skipStampUpdate).toHaveBeenCalledWith(expect.objectContaining({ renewal_charge_skip_reason: 'surcharge_not_authorized' }));
      });

      test('no credit, no surcharge: charged exactly as before — cash ceiling = the fee, the cash total pinned to the quote', async () => {
        const { chargeInvoiceWithSavedCard } = load({ base: 249, surcharge: 0, total: 249, projectedCreditApplied: 0 });
        const { _private } = require('../services/termite-annual-renewal-charge');
        const successor = baseSuccessor();
        const { conn } = makeDecideConn({ successor });

        await _private.decideAndCharge(successor, baseParent(), conn);

        expect(chargeInvoiceWithSavedCard).toHaveBeenCalledWith('succ-invoice-1', 'pm-1', expect.objectContaining({
          maxAuthorizedChargeCents: 24900, maxAuthorizedTotalCents: 24900, expectedTotal: 249,
        }));
      });

      test('ACH (no surcharge) with $100 of credit: charged with a cash ceiling of fee − credit, so cash + credit never exceeds the fee', async () => {
        const { chargeInvoiceWithSavedCard } = load({ base: 149, surcharge: 0, total: 149, projectedCreditApplied: 100 });
        const { _private } = require('../services/termite-annual-renewal-charge');
        const successor = baseSuccessor();
        const { conn } = makeDecideConn({ successor });

        await _private.decideAndCharge(successor, baseParent(), conn);

        expect(chargeInvoiceWithSavedCard).toHaveBeenCalledWith('succ-invoice-1', 'pm-1', expect.objectContaining({
          maxAuthorizedChargeCents: 24900, maxAuthorizedTotalCents: 14900, expectedTotal: 149,
        }));
      });
    });

    // Codex #4971 r13 P1: with $100 of account credit applied, Stripe was
    // tried for $149 — the customer notice says $149.00, read from the
    // durable attempt row, never the $249 plan fee.
    test('a declined charge reduced by account credit: the customer notice reports the $149.00 actually attempted', async () => {
      mockCommon();
      mockGraceHelpers({ graceDays: 30 });
      jest.doMock('../services/invoice', () => ({
        sendViaSMSAndEmail: jest.fn(async () => ({ ok: true })),
        withPayLinkSendClaim: jest.fn(async (_invoiceId, handoff) => handoff({ token: 'tok-1', total: 249, credit_applied: 100 })),
      }));
      jest.doMock('../services/notification-service', () => ({ notifyAdmin: jest.fn(async () => ({ id: 'n1' })) }));
      jest.doMock('../services/recurring-card-on-file', () => ({
        resolvePrepayChargeMethod: jest.fn(async () => ({ paymentMethodRowId: 'pm-1' })),
      }));
      const declineErr = Object.assign(new Error('Your card was declined.'), { wavesCardDecline: { declineCode: 'card_declined' } });
      mockSignatureChargePrivate({ classifyChargeErrorImpl: jest.fn(() => ({ status: 'declined', reason: declineErr.message })) });
      jest.doMock('../services/stripe', () => ({
        assertNoInvoiceChargeReconciliationPending: jest.fn(async () => undefined),
        chargeInvoiceWithSavedCard: jest.fn(async () => { throw declineErr; }),
        quoteInvoiceSavedCardCharge: jest.fn(async () => ({ total: 149, projectedCreditApplied: 100 })),
      }));
      jest.doMock('../utils/portal-url', () => ({ publicPortalUrl: () => 'https://portal.example.com' }));
      const renderSmsTemplate = jest.fn(async () => 'rendered body');
      jest.doMock('../services/sms-template-renderer', () => ({ renderSmsTemplate }));
      jest.doMock('../services/messaging/send-customer-message', () => ({ sendCustomerMessage: jest.fn(async () => ({ sent: true })) }));
      const attemptQuery = {};
      attemptQuery.where = jest.fn((arg) => { if (typeof arg === 'function') arg.call(attemptQuery); return attemptQuery; });
      attemptQuery.whereNotNull = jest.fn(() => attemptQuery);
      attemptQuery.orWhereNotNull = jest.fn(() => attemptQuery);
      attemptQuery.orderBy = jest.fn(() => attemptQuery);
      attemptQuery.first = jest.fn(async () => ({ amount: '149.00' }));
      jest.doMock('../models/db', () => jest.fn((table) => {
        if (table === 'customers') return { where: jest.fn().mockReturnValue({ first: jest.fn().mockResolvedValue({ id: 'cust-1', phone: '+19415551212', first_name: 'Pat', deleted_at: null }) }) };
        if (table === 'stripe_invoice_charge_attempts as a') return attemptQuery;
        throw new Error(`unexpected table ${table}`);
      }));

      const { _private } = require('../services/termite-annual-renewal-charge');
      const successor = baseSuccessor();
      const { conn } = makeDecideConn({ successor });
      await _private.decideAndCharge(successor, baseParent(), conn);
      await Promise.resolve();

      expect(renderSmsTemplate).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ amount: '149.00' }), expect.any(Object));
      expect(attemptQuery.where).toHaveBeenCalledWith('a.invoice_id', 'succ-invoice-1');
    });

    test('a genuine Stripe decline (wavesCardDecline): one attempt, one "declined" bell, pay-link delivered, and the customer SMS fires', async () => {
      mockCommon();
      mockGraceHelpers({ graceDays: 30 });
      const sendViaSMSAndEmail = jest.fn(async () => ({ ok: true }));
      // The charge-failed text hands off under the invoice's Bill-To send claim (Codex #4971 r5 P1).
      const withPayLinkSendClaim = jest.fn(async (_invoiceId, handoff) => handoff({ token: 'tok-1' }));
      jest.doMock('../services/invoice', () => ({ sendViaSMSAndEmail, withPayLinkSendClaim }));
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
      jest.doMock('../services/stripe', () => ({ assertNoInvoiceChargeReconciliationPending: jest.fn(async () => undefined), chargeInvoiceWithSavedCard, quoteInvoiceSavedCardCharge }));
      jest.doMock('../utils/portal-url', () => ({ publicPortalUrl: () => 'https://portal.example.com' }));
      const renderSmsTemplate = jest.fn(async () => 'rendered body');
      jest.doMock('../services/sms-template-renderer', () => ({ renderSmsTemplate }));
      const sendCustomerMessage = jest.fn(async () => ({ sent: true }));
      jest.doMock('../services/messaging/send-customer-message', () => ({ sendCustomerMessage }));
      const dbMock = jest.fn((table) => {
        if (table === 'customers') return { where: jest.fn().mockReturnValue({ first: jest.fn().mockResolvedValue({ id: 'cust-1', phone: '+19415551212', first_name: 'Pat' }) }) };
        if (table === 'invoices') return { where: jest.fn().mockReturnValue({ first: jest.fn().mockResolvedValue({ token: 'tok-1' }) }) };
        if (table === 'customers') return liveCustomerQuery();
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
      // Genuine decline -> the customer SMS actually fires, handed off under
      // the renewal invoice's own Bill-To send claim (Codex #4971 r5 P1).
      await Promise.resolve();
      expect(sendCustomerMessage).toHaveBeenCalledWith(expect.objectContaining({ purpose: 'payment_failure', body: 'rendered body' }));
      expect(withPayLinkSendClaim).toHaveBeenCalledWith('succ-invoice-1', expect.any(Function));

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
      jest.doMock('../services/stripe', () => ({ assertNoInvoiceChargeReconciliationPending: jest.fn(async () => undefined), chargeInvoiceWithSavedCard, quoteInvoiceSavedCardCharge: jest.fn(async () => ({ total: 249 })) }));
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

    test('B10: a collection hold that lands AFTER the preflight (binding refusal under the charge locks) is RETRYABLE — fence handed back, no decline, no payer refusal, no pay link, not stamped handled', async () => {
      mockCommon();
      mockGraceHelpers({ graceDays: 30 });
      const sendViaSMSAndEmail = jest.fn(async () => ({ ok: true }));
      jest.doMock('../services/invoice', () => ({ sendViaSMSAndEmail }));
      const notifyAdmin = jest.fn(async () => ({ id: 'n1' }));
      jest.doMock('../services/notification-service', () => ({ notifyAdmin }));
      jest.doMock('../services/recurring-card-on-file', () => ({
        resolvePrepayChargeMethod: jest.fn(async () => ({ paymentMethodRowId: 'pm-1' })),
      }));
      // The shared classifier would map a 'deferred' outcome to payer_refused — it must NOT be consulted.
      const classifyChargeErrorImpl = jest.fn(() => ({ status: 'deferred', reason: 'payer_billed_guard' }));
      mockSignatureChargePrivate({ classifyChargeErrorImpl });
      const holdErr = Object.assign(new Error('Collection is on hold for this customer (billing dispute). Review before charging.'), { code: 'INVOICE_COLLECTION_STOPPED' });
      const chargeInvoiceWithSavedCard = jest.fn(async () => { throw holdErr; });
      jest.doMock('../services/stripe', () => ({ assertNoInvoiceChargeReconciliationPending: jest.fn(async () => undefined), chargeInvoiceWithSavedCard, quoteInvoiceSavedCardCharge: jest.fn(async () => ({ total: 249 })) }));
      const sendCustomerMessage = jest.fn();
      jest.doMock('../services/messaging/send-customer-message', () => ({ sendCustomerMessage }));

      const { _private } = require('../services/termite-annual-renewal-charge');
      const successor = baseSuccessor();
      const { conn, handledStampUpdate, fenceReleaseUpdate, deferredUpdate } = makeDecideConn({ successor });
      const outcome = await _private.decideAndCharge(successor, baseParent(), conn);

      expect(outcome).toEqual({ status: 'deferred', reason: 'collection_hold' });
      expect(chargeInvoiceWithSavedCard).toHaveBeenCalledTimes(1);
      expect(chargeInvoiceWithSavedCard.mock.calls[0][2]).toMatchObject({ refuseWhenCollectionHold: true });
      // fence + write-ahead outcome handed back so leg 7a re-decides after release
      expect(fenceReleaseUpdate).toHaveBeenCalledWith(expect.objectContaining({
        renewal_charge_attempted_at: null, renewal_charge_failure_kind: null, renewal_charge_failure_handled_at: null,
      }));
      expect(deferredUpdate).toHaveBeenCalled(); // sweep-deferred rotation
      // never recorded as a decline / payer refusal / handled outcome
      expect(classifyChargeErrorImpl).not.toHaveBeenCalled();
      expect(handledStampUpdate).not.toHaveBeenCalled();
      expect(sendViaSMSAndEmail).not.toHaveBeenCalled();
      expect(sendCustomerMessage).not.toHaveBeenCalled();
      expect(notifyAdmin).not.toHaveBeenCalledWith('billing', expect.any(String), expect.any(String), expect.objectContaining({
        dedupeKey: expect.stringMatching(/:(payer_billed|declined|refused)$/),
      }));
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
      jest.doMock('../services/stripe', () => ({ assertNoInvoiceChargeReconciliationPending: jest.fn(async () => undefined), chargeInvoiceWithSavedCard, quoteInvoiceSavedCardCharge: jest.fn(async () => ({ total: 249 })) }));

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

    test('a payer-billed guard (deferred) bells "payer_billed" and delivers NO pay link, matching the sibling', async () => {
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
      jest.doMock('../services/stripe', () => ({ assertNoInvoiceChargeReconciliationPending: jest.fn(async () => undefined), chargeInvoiceWithSavedCard, quoteInvoiceSavedCardCharge: jest.fn(async () => ({ total: 249 })) }));

      const { _private } = require('../services/termite-annual-renewal-charge');
      const successor = baseSuccessor();
      const { conn, handledStampUpdate } = makeDecideConn({ successor });
      const outcome = await _private.decideAndCharge(successor, baseParent(), conn);

      expect(outcome.status).toBe('failed');
      expect(sendViaSMSAndEmail).not.toHaveBeenCalled();
      expect(notifyAdmin).toHaveBeenCalledWith('billing', expect.any(String), expect.any(String), expect.objectContaining({
        dedupeKey: 'termite-renewal-charge:succ-term-1:payer_billed',
      }));
      // The payer guard throws before any attempt row exists — without the
      // handled marker, leg 7b would later send the HOMEOWNER a pay link for
      // the payer's AR.
      expect(handledStampUpdate).toHaveBeenCalledTimes(1);
    });

    // Codex #4971 pre-push P1 (first run): the decline's follow-through runs
    // right after the charge released the parent's gate — exactly when a
    // cancel that queued behind the charge lands. The pay link is withheld
    // and the renewal withdrawn instead.
    test('a genuine decline whose parent was cancelled while the charge held the gate: no pay link, no customer text — withdrawn', async () => {
      mockCommon();
      mockGraceHelpers({ graceDays: 30 });
      const sendViaSMSAndEmail = jest.fn();
      const voidInvoice = jest.fn(async () => ({}));
      jest.doMock('../services/invoice', () => ({ sendViaSMSAndEmail, voidInvoice }));
      jest.doMock('../services/notification-service', () => ({ notifyAdmin: jest.fn(async () => ({ id: 'n1' })) }));
      jest.doMock('../services/recurring-card-on-file', () => ({
        resolvePrepayChargeMethod: jest.fn(async () => ({ paymentMethodRowId: 'pm-1' })),
      }));
      const sendCustomerMessage = jest.fn();
      jest.doMock('../services/messaging/send-customer-message', () => ({ sendCustomerMessage }));
      const declineErr = Object.assign(new Error('Your card was declined.'), { wavesCardDecline: { declineCode: 'card_declined' } });
      mockSignatureChargePrivate({ classifyChargeErrorImpl: jest.fn(() => ({ status: 'declined', reason: declineErr.message })) });
      jest.doMock('../services/stripe', () => ({
        assertNoInvoiceChargeReconciliationPending: jest.fn(async () => undefined),
        chargeInvoiceWithSavedCard: jest.fn(async () => { throw declineErr; }),
        quoteInvoiceSavedCardCharge: jest.fn(async () => ({ total: 249 })),
      }));

      const { _private } = require('../services/termite-annual-renewal-charge');
      const successor = baseSuccessor();
      const live = { id: 'parent-1', status: 'active', renewal_decision: null };
      const cancelled = { ...live, status: 'cancelled', renewal_decision: 'cancel' };
      const { conn } = makeDecideConn({
        successor, parent: live, eligibilityInvoice: { status: 'draft' }, freshInvoice: { status: 'draft' },
        outerParentReads: [live, live, cancelled], // pre-check, in-gate re-check, then the follow-through
      });

      const outcome = await _private.decideAndCharge(successor, baseParent(), conn);

      expect(outcome.status).toBe('failed');
      expect(sendViaSMSAndEmail).not.toHaveBeenCalled();
      expect(sendCustomerMessage).not.toHaveBeenCalled();
      expect(voidInvoice).toHaveBeenCalledWith('succ-invoice-1', { requireUnsettled: true });
    });

    // Codex #4971 r4 P1 — deliverRenewalInvoice is THE pay-link chokepoint:
    // eligibility is re-asked under the parent's gate immediately before the
    // send, so a cancel landing DURING the fallback's own work (the
    // saved-method lookup, the surcharge quote) withdraws the renewal
    // instead of mailing the bill.
    test.each([
      ['no_method', 'the saved-method lookup'],
      ['surcharge_not_authorized', 'the surcharge quote'],
    ])('%s: the parent is cancelled during %s — no pay link; withdrawn under the parent\'s gate', async (kind) => {
      mockCommon();
      mockGraceHelpers({ graceDays: 30 });
      const sendViaSMSAndEmail = jest.fn(async () => ({ ok: true }));
      let inGate = false;
      const voidInvoice = jest.fn(async () => { expect(inGate).toBe(true); return {}; });
      jest.doMock('../services/invoice', () => ({ sendViaSMSAndEmail, voidInvoice }));
      const notifyAdmin = jest.fn(async () => ({ id: 'n1' }));
      jest.doMock('../services/notification-service', () => ({ notifyAdmin }));
      const parent = { id: 'parent-1', status: 'active', renewal_decision: null };
      const cancelElsewhere = () => Object.assign(parent, { status: 'cancelled', renewal_decision: 'cancel' });
      jest.doMock('../services/recurring-card-on-file', () => ({
        resolvePrepayChargeMethod: jest.fn(async () => {
          if (kind === 'no_method') { cancelElsewhere(); return null; }
          return { paymentMethodRowId: 'pm-1' };
        }),
      }));
      const chargeInvoiceWithSavedCard = jest.fn();
      jest.doMock('../services/stripe', () => ({
        assertNoInvoiceChargeReconciliationPending: jest.fn(async () => undefined),
        chargeInvoiceWithSavedCard,
        quoteInvoiceSavedCardCharge: jest.fn(async () => { cancelElsewhere(); return { total: 260 }; }),
      }));
      const { _private } = require('../services/termite-annual-renewal-charge');
      const gate = require('../services/annual-prepay-renewals').withParentDecisionLock;
      gate.mockImplementation(async (termId, fn) => { inGate = true; try { return await fn(); } finally { inGate = false; } });
      const successor = baseSuccessor();
      const { conn, skipStampUpdate } = makeDecideConn({ successor, parent, eligibilityInvoice: { status: 'draft' }, freshInvoice: { status: 'draft' } });

      const outcome = await _private.decideAndCharge(successor, baseParent(), conn);

      expect(outcome.status).toBe(kind);
      expect(chargeInvoiceWithSavedCard).not.toHaveBeenCalled();
      expect(sendViaSMSAndEmail).not.toHaveBeenCalled();
      expect(gate).toHaveBeenCalledWith('parent-1', expect.any(Function), { alsoTermIds: ['succ-term-1'] });
      expect(voidInvoice).toHaveBeenCalledWith('succ-invoice-1', { requireUnsettled: true });
      expect(notifyAdmin).toHaveBeenCalledWith('billing', expect.stringMatching(/withdrawn/i), expect.stringContaining('parent_decided_cancel'), expect.objectContaining({
        dedupeKey: 'termite-renewal-charge:succ-term-1:renewal_withdrawn',
      }));
      // The fallback's own "sent with its pay link" bell never rings.
      expect(notifyAdmin).not.toHaveBeenCalledWith('billing', expect.any(String), expect.any(String), expect.objectContaining({
        dedupeKey: `termite-renewal-charge:succ-term-1:${kind}`,
      }));
      expect(skipStampUpdate).toHaveBeenCalledWith({ renewal_charge_skipped_at: expect.any(Date), renewal_charge_skip_reason: `${kind}:withheld` });
    });

    test('the chokepoint sends nothing once the successor left payment_pending (paid / withdrawn elsewhere) — the leg is done', async () => {
      mockCommon();
      const sendViaSMSAndEmail = jest.fn();
      jest.doMock('../services/invoice', () => ({ sendViaSMSAndEmail }));
      const { _private } = require('../services/termite-annual-renewal-charge');
      const conn = jest.fn((table) => {
        expect(table).toBe('annual_prepay_terms');
        return { where: jest.fn((filter) => ({ first: jest.fn(async () => (filter.status === 'payment_pending' ? undefined : { id: 'succ-term-1', status: 'active' })) })) };
      });
      await expect(_private.deliverRenewalInvoice(baseSuccessor(), conn)).resolves.toMatchObject({ ok: false, code: 'delivery_refused', outcome: 'handled' });
      await expect(_private.sendRenewalChargeFailedNotice(baseSuccessor(), conn)).resolves.toEqual({ sent: false, reason: 'delivery_refused' });
      expect(sendViaSMSAndEmail).not.toHaveBeenCalled();
    });

    // Codex #4971 r6 P1 (audit): the charge's authority is recomputed under
    // the held gate on BOTH terms — a successor withdrawn (or lapsed) while
    // the charge waited for the gate is never charged, even though its fence
    // was already claimed.
    test('a successor withdrawn while the charge waited for the gate is never charged', async () => {
      mockCommon();
      mockGraceHelpers({ graceDays: 30 });
      jest.doMock('../services/invoice', () => ({ sendViaSMSAndEmail: jest.fn(), voidInvoice: jest.fn() }));
      const notifyAdmin = jest.fn(async () => ({ id: 'n1' }));
      jest.doMock('../services/notification-service', () => ({ notifyAdmin }));
      jest.doMock('../services/recurring-card-on-file', () => ({ resolvePrepayChargeMethod: jest.fn(async () => ({ paymentMethodRowId: 'pm-1' })) }));
      const chargeInvoiceWithSavedCard = jest.fn();
      jest.doMock('../services/stripe', () => ({
        assertNoInvoiceChargeReconciliationPending: jest.fn(async () => undefined),
        chargeInvoiceWithSavedCard,
        quoteInvoiceSavedCardCharge: jest.fn(async () => ({ total: 249 })),
      }));
      const { _private } = require('../services/termite-annual-renewal-charge');
      const successor = baseSuccessor();
      const { conn } = makeDecideConn({ successor, eligibilityInvoice: { status: 'draft' }, freshInvoice: { status: 'draft' } });
      const gate = require('../services/annual-prepay-renewals').withParentDecisionLock;
      gate.mockImplementation(async (termId, fn) => { successor.status = 'cancelled'; return fn(); });

      const outcome = await _private.decideAndCharge(successor, baseParent(), conn);

      expect(chargeInvoiceWithSavedCard).not.toHaveBeenCalled();
      expect(outcome).toMatchObject({ status: 'ineligible', reason: 'successor_status_cancelled' });
    });

    // Codex #4971 r7 P1: leg 7b recovered (retired) this claim while its
    // worker waited for the gate — the worker's in-gate re-check refuses it:
    // no charge, no bell, no second pay link (the fallback owns it).
    test('a claim leg 7b retired while the worker waited for the gate is never charged', async () => {
      mockCommon();
      mockGraceHelpers({ graceDays: 30 });
      const sendViaSMSAndEmail = jest.fn();
      jest.doMock('../services/invoice', () => ({ sendViaSMSAndEmail, voidInvoice: jest.fn() }));
      const notifyAdmin = jest.fn(async () => ({ id: 'n1' }));
      jest.doMock('../services/notification-service', () => ({ notifyAdmin }));
      jest.doMock('../services/recurring-card-on-file', () => ({ resolvePrepayChargeMethod: jest.fn(async () => ({ paymentMethodRowId: 'pm-1' })) }));
      const chargeInvoiceWithSavedCard = jest.fn();
      jest.doMock('../services/stripe', () => ({
        assertNoInvoiceChargeReconciliationPending: jest.fn(async () => undefined),
        chargeInvoiceWithSavedCard,
        quoteInvoiceSavedCardCharge: jest.fn(async () => ({ total: 249 })),
      }));
      const { _private } = require('../services/termite-annual-renewal-charge');
      const successor = baseSuccessor();
      const { conn } = makeDecideConn({ successor, eligibilityInvoice: { status: 'draft' }, freshInvoice: { status: 'draft' } });
      const gate = require('../services/annual-prepay-renewals').withParentDecisionLock;
      gate.mockImplementation(async (termId, fn) => {
        Object.assign(successor, { renewal_charge_claim_retired_at: new Date(), renewal_charge_failure_kind: null });
        return fn();
      });

      const outcome = await _private.decideAndCharge(successor, baseParent(), conn);

      expect(outcome).toEqual({ status: 'claim_retired', reason: 'charge_claim_retired' });
      expect(chargeInvoiceWithSavedCard).not.toHaveBeenCalled();
      expect(sendViaSMSAndEmail).not.toHaveBeenCalled();
      expect(notifyAdmin).not.toHaveBeenCalled();
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
        assertNoInvoiceChargeReconciliationPending: jest.fn(async () => undefined),
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
      jest.doMock('../services/stripe', () => ({ assertNoInvoiceChargeReconciliationPending: jest.fn(async () => undefined), chargeInvoiceWithSavedCard, quoteInvoiceSavedCardCharge: jest.fn(async () => ({ total: 249 })) }));

      const { _private } = require('../services/termite-annual-renewal-charge');
      const successor = baseSuccessor();
      const { conn, claimUpdate, deferredUpdate } = makeDecideConn({ successor, freshInvoice: { status: 'paid', payment_method: 'card' } });
      const outcome = await _private.decideAndCharge(successor, baseParent(), conn);

      expect(outcome.status).toBe('charged');
      expect(notifyAdmin).not.toHaveBeenCalled();
      expect(sendViaSMSAndEmail).not.toHaveBeenCalled();
      // Codex #4971 r4 P1 (write-ahead): the follow-through obligation is
      // persisted WITH the fence, before Stripe — and the verified success
      // clears it in-line.
      expect(claimUpdate).toHaveBeenCalledWith({
        renewal_charge_attempted_at: expect.any(Date),
        renewal_charge_failure_kind: 'outcome_pending',
        renewal_charge_failure_reason: null,
        renewal_charge_failure_handled_at: null,
      });
      expect(claimUpdate.mock.invocationCallOrder[0]).toBeLessThan(chargeInvoiceWithSavedCard.mock.invocationCallOrder[0]);
      expect(deferredUpdate).toHaveBeenCalledWith({ renewal_charge_failure_kind: null, renewal_charge_failure_reason: null });
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
      jest.doMock('../services/stripe', () => ({ assertNoInvoiceChargeReconciliationPending: jest.fn(async () => undefined), chargeInvoiceWithSavedCard, quoteInvoiceSavedCardCharge: jest.fn(async () => ({ total: 249 })) }));

      const { _private } = require('../services/termite-annual-renewal-charge');
      const successor = baseSuccessor();
      const { conn, deferredUpdate } = makeDecideConn({ successor, freshInvoice: { status: 'processing', payment_method: 'us_bank_account' } });
      const outcome = await _private.decideAndCharge(successor, baseParent(), conn);

      expect(outcome.status).toBe('pending');
      expect(notifyAdmin).not.toHaveBeenCalled();
      // The ACH is still clearing: the write-ahead 'outcome_pending' stays
      // (the paid sync clears it; a failed debit is followed through by 7d).
      expect(deferredUpdate).not.toHaveBeenCalledWith(expect.objectContaining({ renewal_charge_failure_kind: null }));
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
      jest.doMock('../services/stripe', () => ({ assertNoInvoiceChargeReconciliationPending: jest.fn(async () => undefined), chargeInvoiceWithSavedCard, quoteInvoiceSavedCardCharge: jest.fn(async () => ({ total: 249 })) }));

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
      jest.doMock('../services/stripe', () => ({ assertNoInvoiceChargeReconciliationPending: jest.fn(async () => undefined), chargeInvoiceWithSavedCard, quoteInvoiceSavedCardCharge: jest.fn(async () => ({ total: 249 })) }));

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
    // OWNER RULING (pre-push item 6): the renewal invoice here was already
    // SENT (a delivery stamp) — it is still voided right away, not left
    // payable until the grace deadline.
    test('a customer decline (parent renewal_decision=cancel) racing in between the mint and the charge wins — no charge; the already-sent renewal invoice is voided, staff belled', async () => {
      mockCommon();
      const sendViaSMSAndEmail = jest.fn();
      const voidInvoice = jest.fn(async () => ({}));
      jest.doMock('../services/invoice', () => ({ sendViaSMSAndEmail, voidInvoice }));
      const notifyAdmin = jest.fn(async () => ({ id: 'n1' }));
      jest.doMock('../services/notification-service', () => ({ notifyAdmin }));
      jest.doMock('../services/recurring-card-on-file', () => ({
        resolvePrepayChargeMethod: jest.fn(async () => ({ paymentMethodRowId: 'pm-1' })),
      }));
      const chargeInvoiceWithSavedCard = jest.fn();
      jest.doMock('../services/stripe', () => ({ assertNoInvoiceChargeReconciliationPending: jest.fn(async () => undefined), chargeInvoiceWithSavedCard, quoteInvoiceSavedCardCharge: jest.fn(async () => ({ total: 249 })) }));

      const { _private } = require('../services/termite-annual-renewal-charge');
      const successor = baseSuccessor();
      // The CALLER's own parentTerm (from the mint-candidates query, or a
      // stale recovery-leg read) still shows undecided — the fresh re-read
      // under lock is what actually catches the decline.
      const staleParent = baseParent({ renewal_decision: null });
      const declinedParent = { id: 'parent-1', renewal_decision: 'cancel' };
      const { conn } = makeDecideConn({ successor, parent: declinedParent });

      const outcome = await _private.decideAndCharge(successor, staleParent, conn);

      expect(outcome).toEqual({ status: 'ineligible', reason: 'parent_decided_cancel', retired: 'retired' });
      expect(chargeInvoiceWithSavedCard).not.toHaveBeenCalled();
      expect(sendViaSMSAndEmail).not.toHaveBeenCalled(); // a decline doesn't want a pay link
      expect(voidInvoice).toHaveBeenCalledWith('succ-invoice-1', { requireUnsettled: true });
      expect(notifyAdmin).toHaveBeenCalledWith('billing', expect.any(String), expect.any(String), expect.objectContaining({
        dedupeKey: 'termite-renewal-charge:succ-term-1:renewal_withdrawn',
      }));
    });

    // Codex round-4 P0 (parentEligibleForRenewalAction — the ALLOW-list).
    test('P0 + owner ruling: a parent refunded/voided AFTER mint (status cancelled, no decision — move 9) -> no charge; the already-SENT renewal is voided and cancelled right away, one staff alert, no customer message', async () => {
      mockCommon();
      const sendViaSMSAndEmail = jest.fn();
      const voidInvoice = jest.fn(async () => ({}));
      jest.doMock('../services/invoice', () => ({ sendViaSMSAndEmail, voidInvoice }));
      const notifyAdmin = jest.fn(async () => ({ id: 'n1' }));
      jest.doMock('../services/notification-service', () => ({ notifyAdmin }));
      jest.doMock('../services/recurring-card-on-file', () => ({
        resolvePrepayChargeMethod: jest.fn(async () => ({ paymentMethodRowId: 'pm-1' })),
      }));
      const sendCustomerMessage = jest.fn();
      jest.doMock('../services/messaging/send-customer-message', () => ({ sendCustomerMessage }));
      const chargeInvoiceWithSavedCard = jest.fn();
      jest.doMock('../services/stripe', () => ({ assertNoInvoiceChargeReconciliationPending: jest.fn(async () => undefined), chargeInvoiceWithSavedCard, quoteInvoiceSavedCardCharge: jest.fn(async () => ({ total: 249 })) }));

      const { _private } = require('../services/termite-annual-renewal-charge');
      const successor = baseSuccessor();
      const staleParent = baseParent({ renewal_decision: null });
      const refundedParent = { id: 'parent-1', status: 'cancelled', renewal_decision: null };
      // The default eligibilityInvoice carries a sent_at stamp: already presented.
      const { conn, skipStampUpdate } = makeDecideConn({ successor, parent: refundedParent });

      const outcome = await _private.decideAndCharge(successor, staleParent, conn);

      expect(outcome).toEqual({ status: 'ineligible', reason: 'parent_status_cancelled', retired: 'retired' });
      expect(chargeInvoiceWithSavedCard).not.toHaveBeenCalled();
      expect(sendViaSMSAndEmail).not.toHaveBeenCalled();
      expect(sendCustomerMessage).not.toHaveBeenCalled();
      expect(voidInvoice).toHaveBeenCalledWith('succ-invoice-1', { requireUnsettled: true });
      expect(notifyAdmin).toHaveBeenCalledTimes(1);
      expect(notifyAdmin).toHaveBeenCalledWith('billing', expect.stringMatching(/withdrawn/i), expect.stringContaining('parent_status_cancelled'), expect.objectContaining({
        dedupeKey: 'termite-renewal-charge:succ-term-1:renewal_withdrawn',
      }));
      expect(skipStampUpdate).not.toHaveBeenCalled(); // terminal, not merely "skipped"
    });

    // Owner ruling (item 6): money already in motion wins — no void, the
    // row stays retryable (rotated), and no withdrawal alert is sent.
    test.each([
      ['a submitted charge that has not resolved', { attempt: { id: 'att-1' } }],
      ['an ACH payment still clearing', { invoiceStatus: 'processing' }],
      ['a charge reconciliation pending', { reconciliationPending: true }],
    ])('owner ruling: a sent renewal with %s is NOT voided when the parent is refunded — rotated', async (_label, { attempt, invoiceStatus, reconciliationPending }) => {
      mockCommon();
      const voidInvoice = jest.fn();
      jest.doMock('../services/invoice', () => ({ sendViaSMSAndEmail: jest.fn(), voidInvoice }));
      const notifyAdmin = jest.fn(async () => ({ id: 'n1' }));
      jest.doMock('../services/notification-service', () => ({ notifyAdmin }));
      jest.doMock('../services/recurring-card-on-file', () => ({ resolvePrepayChargeMethod: jest.fn() }));
      jest.doMock('../services/stripe', () => ({
        chargeInvoiceWithSavedCard: jest.fn(),
        quoteInvoiceSavedCardCharge: jest.fn(),
        assertNoInvoiceChargeReconciliationPending: jest.fn(async () => { if (reconciliationPending) throw new Error('saved-card charge awaiting reconciliation'); }),
      }));
      const { _private } = require('../services/termite-annual-renewal-charge');
      const successor = baseSuccessor();
      const sent = { status: invoiceStatus || 'sent', sent_at: new Date('2026-09-27T12:00:00Z') };
      const { conn, deferredUpdate } = makeDecideConn({
        successor,
        parent: { id: 'parent-1', status: 'cancelled', renewal_decision: null },
        eligibilityInvoice: sent,
        freshInvoice: sent,
        pendingAttempt: attempt,
      });

      const outcome = await _private.decideAndCharge(successor, baseParent(), conn);

      expect(outcome.retired).toBe('deferred');
      expect(voidInvoice).not.toHaveBeenCalled();
      expect(notifyAdmin).not.toHaveBeenCalled();
      expect(deferredUpdate).toHaveBeenCalledWith({ renewal_sweep_deferred_at: expect.any(Date) });
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
        jest.doMock('../services/stripe', () => ({ assertNoInvoiceChargeReconciliationPending: jest.fn(async () => undefined), chargeInvoiceWithSavedCard, quoteInvoiceSavedCardCharge: jest.fn(async () => ({ total: 249 })) }));
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
          dedupeKey: 'termite-renewal-charge:succ-term-1:renewal_withdrawn',
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

      test('the void refuses because money settled the invoice in the meantime: NOT voided — money wins, rotated, not marked decided', async () => {
        mockCommon();
        const settledErr = Object.assign(new Error('Invoice already reads prepaid'), { code: 'INVOICE_SETTLED_REFUSE_VOID' });
        mockRetireDeps({ voidInvoiceImpl: async () => { throw settledErr; } });
        const { _private } = require('../services/termite-annual-renewal-charge');
        const successor = baseSuccessor();
        const { conn, skipStampUpdate, deferredUpdate } = makeDecideConn({
          successor, parent: { id: 'parent-1', status: 'cancelled', renewal_decision: 'cancel' }, eligibilityInvoice: { status: 'draft' },
        });

        const outcome = await _private.decideAndCharge(successor, baseParent(), conn);

        expect(outcome.retired).toBe('deferred');
        expect(skipStampUpdate).not.toHaveBeenCalled();
        expect(deferredUpdate).toHaveBeenCalled();
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

      // Codex #4971 r11 P1: the fence is claimed on the LAST grace day, but
      // the worker reaches the renewal gate after midnight ET — the window
      // closed, so the in-gate re-check refuses: never charged.
      test('claimed on the last grace day, the gate reached the next ET day: no Stripe call — past the grace deadline', async () => {
        mockCommon();
        const { chargeInvoiceWithSavedCard } = mockRetireDeps();
        let today = '2026-10-27'; // baseSuccessor: term_start 2026-09-27 + 30 grace days
        jest.doMock('../utils/datetime-et', () => {
          const actual = jest.requireActual('../utils/datetime-et');
          return { ...actual, etDateString: (d) => (d === undefined ? today : actual.etDateString(d)) };
        });
        const { _private } = require('../services/termite-annual-renewal-charge');
        const gate = require('../services/annual-prepay-renewals').withParentDecisionLock;
        gate.mockImplementation(async (_termId, fn) => { today = '2026-10-28'; return fn(); });
        const successor = baseSuccessor();
        const { conn, claimUpdate } = makeDecideConn({ successor, eligibilityInvoice: { status: 'draft' }, freshInvoice: { status: 'draft' } });

        const outcome = await _private.decideAndCharge(successor, baseParent(), conn);

        expect(claimUpdate).toHaveBeenCalledTimes(1); // claimed inside the window
        expect(gate).toHaveBeenCalled();
        expect(chargeInvoiceWithSavedCard).not.toHaveBeenCalled();
        expect(outcome).toMatchObject({ status: 'ineligible', reason: 'past_grace_deadline' });
      });

      // Codex #4971 pre-push P1: no exclusion without a confirmed bell. A
      // withdrawn successor leaves every scan, so the staff bell rings FIRST;
      // if it does not persist, nothing is voided and the row is rotated to
      // ring again on a later tick.
      test('the withdrawal bell does not persist: nothing voided, nothing skipped — rotated for a retry', async () => {
        mockCommon();
        const { voidInvoice } = mockRetireDeps();
        jest.doMock('../services/notification-service', () => ({ notifyAdmin: jest.fn(async () => null) }));
        const { _private } = require('../services/termite-annual-renewal-charge');
        const successor = baseSuccessor();
        const { conn, skipStampUpdate, deferredUpdate } = makeDecideConn({
          successor, parent: { id: 'parent-1', status: 'cancelled', renewal_decision: 'cancel' }, eligibilityInvoice: { status: 'draft' },
        });

        const outcome = await _private.decideAndCharge(successor, baseParent(), conn);

        expect(outcome.retired).toBe('deferred');
        expect(voidInvoice).not.toHaveBeenCalled();
        expect(skipStampUpdate).not.toHaveBeenCalled();
        expect(deferredUpdate).toHaveBeenCalledWith({ renewal_sweep_deferred_at: expect.any(Date) });
      });

      test('an already-resolved refusal (invoice voided elsewhere) is marked skipped only once its bell persisted', async () => {
        mockCommon();
        mockRetireDeps();
        const notifyAdmin = jest.fn(async () => null);
        jest.doMock('../services/notification-service', () => ({ notifyAdmin }));
        const { _private } = require('../services/termite-annual-renewal-charge');
        const successor = baseSuccessor();
        const { conn, skipStampUpdate, deferredUpdate } = makeDecideConn({ successor, eligibilityInvoice: { status: 'void' } });

        const outcome = await _private.decideAndCharge(successor, baseParent(), conn);

        expect(outcome).toEqual({ status: 'ineligible', reason: 'invoice_void' });
        expect(notifyAdmin).toHaveBeenCalled();
        expect(skipStampUpdate).not.toHaveBeenCalled();
        expect(deferredUpdate).toHaveBeenCalledTimes(1);
      });
    });

    // Codex #4971 pre-push P0 (same shape as the mint's locked re-check):
    // the parent's term_end moved after the mint (staff extended the year),
    // so this successor no longer follows it — the renewal is not due as
    // minted. Durable: the unpresented successor is withdrawn, never charged.
    test('P0: the parent term_end moved since the mint — never charged; the unpresented successor is withdrawn', async () => {
      mockCommon();
      mockGraceHelpers({ graceDays: 30 });
      const voidInvoice = jest.fn(async () => ({}));
      jest.doMock('../services/invoice', () => ({ sendViaSMSAndEmail: jest.fn(), voidInvoice }));
      jest.doMock('../services/notification-service', () => ({ notifyAdmin: jest.fn(async () => ({ id: 'n1' })) }));
      jest.doMock('../services/recurring-card-on-file', () => ({
        resolvePrepayChargeMethod: jest.fn(async () => ({ paymentMethodRowId: 'pm-1' })),
      }));
      const chargeInvoiceWithSavedCard = jest.fn();
      jest.doMock('../services/stripe', () => ({ assertNoInvoiceChargeReconciliationPending: jest.fn(async () => undefined), chargeInvoiceWithSavedCard, quoteInvoiceSavedCardCharge: jest.fn(async () => ({ total: 249 })) }));

      const { _private } = require('../services/termite-annual-renewal-charge');
      const successor = baseSuccessor(); // term_start 2026-09-27 — minted after a 2026-09-26 term_end
      const extended = { id: 'parent-1', status: 'active', renewal_decision: null, term_end: '2027-09-26' };
      const { conn } = makeDecideConn({ successor, parent: extended, eligibilityInvoice: { status: 'draft' } });

      const outcome = await _private.decideAndCharge(successor, baseParent(), conn);

      expect(outcome).toEqual({ status: 'ineligible', reason: 'parent_term_moved', retired: 'retired' });
      expect(chargeInvoiceWithSavedCard).not.toHaveBeenCalled();
      expect(voidInvoice).toHaveBeenCalledWith('succ-invoice-1', { requireUnsettled: true });
    });

    test('a dispute-suspended successor (paid, then disputed back to payment_pending) is never charged or billed', async () => {
      mockCommon();
      mockGraceHelpers({ graceDays: 30 });
      const sendViaSMSAndEmail = jest.fn();
      jest.doMock('../services/invoice', () => ({ sendViaSMSAndEmail, voidInvoice: jest.fn() }));
      jest.doMock('../services/notification-service', () => ({ notifyAdmin: jest.fn(async () => ({ id: 'n1' })) }));
      jest.doMock('../services/recurring-card-on-file', () => ({ resolvePrepayChargeMethod: jest.fn() }));
      const chargeInvoiceWithSavedCard = jest.fn();
      jest.doMock('../services/stripe', () => ({ assertNoInvoiceChargeReconciliationPending: jest.fn(async () => undefined), chargeInvoiceWithSavedCard, quoteInvoiceSavedCardCharge: jest.fn() }));

      const { _private } = require('../services/termite-annual-renewal-charge');
      const successor = baseSuccessor({ dispute_suspended_at: new Date('2026-10-01T12:00:00Z') });
      const { conn } = makeDecideConn({ successor });
      const outcome = await _private.decideAndCharge(successor, baseParent(), conn);

      expect(outcome).toEqual({ status: 'ineligible', reason: 'successor_dispute_suspended' });
      expect(chargeInvoiceWithSavedCard).not.toHaveBeenCalled();
      expect(sendViaSMSAndEmail).not.toHaveBeenCalled();
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
      jest.doMock('../services/stripe', () => ({ assertNoInvoiceChargeReconciliationPending: jest.fn(async () => undefined), chargeInvoiceWithSavedCard, quoteInvoiceSavedCardCharge: jest.fn(async () => ({ total: 249 })) }));

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
      jest.doMock('../services/stripe', () => ({ assertNoInvoiceChargeReconciliationPending: jest.fn(async () => undefined), chargeInvoiceWithSavedCard, quoteInvoiceSavedCardCharge: jest.fn(async () => ({ total: 249 })) }));

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
      jest.doMock('../services/stripe', () => ({ assertNoInvoiceChargeReconciliationPending: jest.fn(async () => undefined), chargeInvoiceWithSavedCard, quoteInvoiceSavedCardCharge: jest.fn(async () => ({ total: 249 })) }));
      // A real graceDeadlineFor (not the mocked always-far-future one) so
      // "months overdue" actually computes past today.
      jest.doMock('../services/annual-prepay-renewals', () => ({ withParentDecisionLock: (termId, fn) => fn(),
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
      jest.doMock('../services/stripe', () => ({ assertNoInvoiceChargeReconciliationPending: jest.fn(async () => undefined), chargeInvoiceWithSavedCard, quoteInvoiceSavedCardCharge: jest.fn(async () => ({ total: 249 })) }));

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
      jest.doMock('../services/stripe', () => ({ assertNoInvoiceChargeReconciliationPending: jest.fn(async () => undefined), chargeInvoiceWithSavedCard: jest.fn(), quoteInvoiceSavedCardCharge: jest.fn(async () => ({ total: 249 })) }));

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
    // Codex #4971 r16 P1 (finding 7): a FRESH lapse (no renewal_lapse_
    // started_at on the in-memory term yet) now re-reads the successor's
    // status on the OUTER conn, under the gate, BEFORE ever stamping —
    // defaults model the happy path (still genuinely payment_pending, no
    // lapse started elsewhere) so every EXISTING test is unaffected. Pass
    // preStatus: 'cancelled' (or similar) to model an operator's void
    // racing in ahead of this stamp.
    preStatus = 'payment_pending',
    preAlreadyStartedAt = null,
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
      if (table === 'customers') return liveCustomerQuery();

      if (table !== 'annual_prepay_terms') throw new Error(`unexpected table ${table}`);
      return {
        where: jest.fn(() => ({
          whereNull: jest.fn((col) => {
            if (col === 'renewal_lapse_completed_at') return { update: manualReviewUpdate };
            expect(col).toBe('renewal_lapse_started_at');
            return { update: startedUpdate };
          }),
          update: jest.fn((payload) => (payload && 'renewal_sweep_deferred_at' in payload ? deferredUpdate(payload) : completedUpdate(payload))),
          // THREE DISTINCT `.where(...).first(...)` call sites share this
          // outer `conn`, told apart by the columns they ask for: (1) the
          // NEW pre-stamp status/lapse-started recheck (finding 7) asks for
          // BOTH 'status' and 'renewal_lapse_started_at' together; (2) the
          // whereNull()-race-lost re-read asks for 'renewal_lapse_started_at'
          // alone; (3) processGraceLapseSequence's own parent-guard-miss
          // re-read asks for 'renewal_decision' on the parent.
          first: jest.fn((...cols) => {
            if (cols.length === 2 && cols.includes('status') && cols.includes('renewal_lapse_started_at')) {
              return Promise.resolve({ status: preStatus, renewal_lapse_started_at: preAlreadyStartedAt });
            }
            if (cols[0] === 'renewal_lapse_started_at') {
              return Promise.resolve(raceLostLapseStartedAt == null ? null : { renewal_lapse_started_at: raceLostLapseStartedAt });
            }
            return Promise.resolve(parentAfterGuardMiss);
          }),
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
      if (table === 'customers') return liveCustomerQuery();
      throw new Error(`unexpected table ${table} in lapse-eligibility trx`);
    });
    conn.transaction = jest.fn(async (cb) => cb(trx));
    return { conn, trx, startedUpdate, completedUpdate, manualReviewUpdate, deferredUpdate, startedAlreadySet };
  }

  function mockLapseDeps({
    voidInvoiceImpl, raiseTermiteRetrievalTaskImpl, recordDecisionImpl, assertNoInvoiceChargeReconciliationPendingImpl,
    otherLiveTermiteCoverageImpl, assertParentDecisionLockAliveImpl,
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
    // Codex #4971 r24 P1: the gate-liveness assertion the lapse re-runs
    // immediately before raising the station-retrieval task (a durable side
    // effect the parent gate serializes). Default: alive.
    const assertParentDecisionLockAlive = jest.fn(assertParentDecisionLockAliveImpl || (() => undefined));
    jest.doMock('../services/annual-prepay-renewals', () => ({ recordDecision, withParentDecisionLock, otherLiveTermiteCoverage, assertParentDecisionLockAlive }));
    const assertNoInvoiceChargeReconciliationPending = jest.fn(
      assertNoInvoiceChargeReconciliationPendingImpl || (async () => undefined),
    );
    jest.doMock('../services/stripe', () => ({ assertNoInvoiceChargeReconciliationPending }));
    return {
      voidInvoice, raiseTermiteRetrievalTask, recordDecision, assertNoInvoiceChargeReconciliationPending, withParentDecisionLock, otherLiveTermiteCoverage,
      assertParentDecisionLockAlive,
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
      expect(recordDecision).toHaveBeenCalledWith(expect.objectContaining({ termId: 'parent-1', action: 'cancel' }));
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
      expect(recordDecision).toHaveBeenCalledWith(expect.objectContaining({ termId: 'parent-1', action: 'cancel' }));
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
    // Codex #4971 r24 P1: the station-retrieval task is a durable side effect
    // the parent gate serializes — the lapse re-asserts the gate session is
    // alive immediately before raising it, and a lost gate raises nothing.
    test('Codex #4971 r24 P1: the lapse asserts the gate is alive right before raising retrieval', async () => {
      mockCommon();
      const { raiseTermiteRetrievalTask, assertParentDecisionLockAlive } = mockLapseDeps();
      jest.doMock('../services/notification-service', () => ({ notifyAdmin: jest.fn(async () => ({ id: 'n1' })) }));
      const { conn } = makeLapseConn({
        freshSuccessor: { status: 'cancelled', renewal_decision: null, prepay_invoice_id: 'succ-invoice-1' },
        freshInvoice: { status: 'void', paid_at: null },
      });
      const { _private } = require('../services/termite-annual-renewal-charge');
      const term = {
        id: 'succ-term-1', customer_id: 'cust-1', prepay_invoice_id: 'succ-invoice-1', renewed_from_term_id: 'parent-1', prepay_amount: 249,
        renewal_lapse_started_at: new Date('2026-10-01T00:00:00Z'),
      };
      await expect(_private.processGraceLapseForTerm(term, conn)).resolves.toBe('lapsed');
      expect(assertParentDecisionLockAlive).toHaveBeenCalled();
      expect(raiseTermiteRetrievalTask).toHaveBeenCalledTimes(1);
      const lastAssert = Math.max(...assertParentDecisionLockAlive.mock.invocationCallOrder.filter((n) => n < raiseTermiteRetrievalTask.mock.invocationCallOrder[0]));
      expect(Number.isFinite(lastAssert)).toBe(true);
    });

    test('Codex #4971 r24/r26 P1: a gate session lost before the irreversible steps voids NOTHING and raises NOTHING — the lapse throws and resumes next tick', async () => {
      mockCommon();
      const { raiseTermiteRetrievalTask, recordDecision, voidInvoice } = mockLapseDeps({
        assertParentDecisionLockAliveImpl: () => { throw Object.assign(new Error('parent-decision lock session lost'), { code: 'PARENT_DECISION_LOCK_LOST' }); },
      });
      jest.doMock('../services/notification-service', () => ({ notifyAdmin: jest.fn(async () => ({ id: 'n1' })) }));
      const { conn, completedUpdate } = makeLapseConn({
        freshSuccessor: { status: 'cancelled', renewal_decision: null, prepay_invoice_id: 'succ-invoice-1' },
        freshInvoice: { status: 'void', paid_at: null },
      });
      const { _private } = require('../services/termite-annual-renewal-charge');
      const term = {
        id: 'succ-term-1', customer_id: 'cust-1', prepay_invoice_id: 'succ-invoice-1', renewed_from_term_id: 'parent-1', prepay_amount: 249,
        renewal_lapse_started_at: new Date('2026-10-01T00:00:00Z'),
      };
      await expect(_private.processGraceLapseForTerm(term, conn)).rejects.toThrow('lock session lost');
      // r26: the assertion precedes the void itself, the first irreversible step.
      expect(voidInvoice).not.toHaveBeenCalled();
      expect(raiseTermiteRetrievalTask).not.toHaveBeenCalled();
      expect(recordDecision).not.toHaveBeenCalled();
      expect(completedUpdate).not.toHaveBeenCalledWith(expect.objectContaining({ renewal_lapse_outcome: 'lapsed' }));
    });

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
      expect(recordDecision).toHaveBeenCalledWith(expect.objectContaining({ termId: 'parent-1', action: 'cancel' }));
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
    // Codex #4971 pre-push P1: a parent demoted to payment_pending by a
    // dispute on its own invoice (move 10, no decision) is TRANSIENT — the
    // lapse rotates for retry (no manual review, no bell); once the dispute
    // is won and the parent restored, the next run completes the lapse.
    test('a dispute-suspended parent at the grace deadline rotates (no manual review, no bell); after the dispute is won the lapse completes', async () => {
      mockCommon();
      const { voidInvoice, raiseTermiteRetrievalTask, recordDecision } = mockLapseDeps();
      const notifyAdmin = jest.fn(async () => ({ id: 'n1' }));
      jest.doMock('../services/notification-service', () => ({ notifyAdmin }));
      const term = {
        id: 'succ-term-1', customer_id: 'cust-1', prepay_invoice_id: 'succ-invoice-1', renewed_from_term_id: 'parent-1', prepay_amount: 249,
      };
      const successorRow = { status: 'payment_pending', prepay_invoice_id: 'succ-invoice-1', renewed_from_term_id: 'parent-1' };
      const { _private } = require('../services/termite-annual-renewal-charge');

      const suspended = makeLapseConn({
        freshSuccessor: successorRow,
        freshInvoice: { status: 'sent', paid_at: null },
        freshParent: { status: 'payment_pending', renewal_decision: null },
      });
      await expect(_private.processGraceLapseForTerm(term, suspended.conn)).resolves.toBe('deferred');
      expect(voidInvoice).not.toHaveBeenCalled();
      expect(suspended.manualReviewUpdate).not.toHaveBeenCalled();
      expect(suspended.deferredUpdate).toHaveBeenCalledWith({ renewal_sweep_deferred_at: expect.any(Date) });
      expect(notifyAdmin).not.toHaveBeenCalled();

      // The dispute is won: the parent is live again.
      const restored = makeLapseConn({
        startedAlreadySet: true,
        freshSuccessor: successorRow,
        freshInvoice: { status: 'sent', paid_at: null },
      });
      await expect(_private.processGraceLapseForTerm({ ...term, renewal_lapse_started_at: new Date() }, restored.conn)).resolves.toBe('lapsed');
      expect(voidInvoice).toHaveBeenCalledWith('succ-invoice-1', { requireUnsettled: true });
      expect(raiseTermiteRetrievalTask).toHaveBeenCalledTimes(1);
      expect(recordDecision).toHaveBeenCalledWith(expect.objectContaining({ termId: 'parent-1', action: 'cancel' }));
      expect(restored.manualReviewUpdate).not.toHaveBeenCalled();
    });

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

    // Codex #4971 pre-push P1: manual_review is persisted only after its
    // staff bell is confirmed — the recovery scan excludes it, so a hold
    // whose bell was lost would leave the renewal unprocessed and nobody
    // told. A lost bell keeps the row in rotation to ring again.
    test('manual review whose staff bell does NOT persist is never marked manual_review — rotated to ring again', async () => {
      mockCommon();
      mockLapseDeps();
      jest.doMock('../services/notification-service', () => ({ notifyAdmin: jest.fn(async () => null) }));
      const { conn, manualReviewUpdate, deferredUpdate, completedUpdate } = makeLapseConn({
        freshSuccessor: { status: 'payment_pending', prepay_invoice_id: 'succ-invoice-1', renewed_from_term_id: 'parent-1' },
        freshInvoice: { status: 'sent', paid_at: null },
        freshParent: { status: 'renewed', renewal_decision: 'renew' },
      });
      const { _private } = require('../services/termite-annual-renewal-charge');
      const outcome = await _private.processGraceLapseForTerm({
        id: 'succ-term-1', customer_id: 'cust-1', prepay_invoice_id: 'succ-invoice-1', renewed_from_term_id: 'parent-1', prepay_amount: 249,
      }, conn);

      expect(outcome).toBe('deferred');
      expect(manualReviewUpdate).not.toHaveBeenCalled();
      expect(completedUpdate).not.toHaveBeenCalled();
      expect(deferredUpdate).toHaveBeenCalledWith({ renewal_sweep_deferred_at: expect.any(Date) });
    });

    test('a settled lapse is completed (excluded from every scan) only once its bell persisted', async () => {
      mockCommon();
      const { voidInvoice } = mockLapseDeps();
      jest.doMock('../services/notification-service', () => ({ notifyAdmin: jest.fn(async () => null) }));
      const { conn, completedUpdate, deferredUpdate } = makeLapseConn({
        freshSuccessor: { status: 'payment_pending', prepay_invoice_id: 'succ-invoice-1' },
        freshInvoice: { status: 'paid', paid_at: new Date() },
      });
      const { _private } = require('../services/termite-annual-renewal-charge');
      const outcome = await _private.processGraceLapseForTerm({
        id: 'succ-term-1', customer_id: 'cust-1', prepay_invoice_id: 'succ-invoice-1', renewed_from_term_id: 'parent-1', prepay_amount: 249,
      }, conn);

      expect(outcome).toBe('deferred');
      expect(voidInvoice).not.toHaveBeenCalled();
      expect(completedUpdate).not.toHaveBeenCalled();
      expect(deferredUpdate).toHaveBeenCalledTimes(1);
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
      expect(recordDecision).toHaveBeenCalledWith(expect.objectContaining({ termId: 'parent-1', action: 'cancel' }));
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
      expect(recordDecision).toHaveBeenCalledWith(expect.objectContaining({ termId: 'parent-1', action: 'cancel' }));
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
        if (table === 'customers') return liveCustomerQuery();
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
      expect(recordDecision).toHaveBeenCalledWith(expect.objectContaining({ termId: 'parent-1', action: 'cancel' }));
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
      const chain = ['whereNotNull', 'whereNull', 'where', 'whereRaw', 'whereNotExists', 'orderBy', 'orderByRaw', 'limit', 'join', 'leftJoin', 'select'];
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
        if (table === 'customers') return liveCustomerQuery();
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
      jest.doMock('../services/stripe', () => ({ assertNoInvoiceChargeReconciliationPending: jest.fn(async () => undefined), chargeInvoiceWithSavedCard: jest.fn(), quoteInvoiceSavedCardCharge: jest.fn() }));

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
          // withdraw (4b), grace-lapses, lapse-effects, never-attempted,
          // never-reached-stripe, charge follow-through (7c).
          const order = [noWitness, unanchored, staleOverdue, candidates, tableQuery([]), graceLapses, lapseEffects, neverAttempted, neverReachedStripe, tableQuery([])];
          return order[Math.min(asTCall - 1, order.length - 1)];
        }
        if (table === 'annual_prepay_terms') {
          // parent lookup inside the reconcile loop.
          return { where: jest.fn().mockReturnValue({ first: jest.fn().mockResolvedValue(parent) }) };
        }
        if (table === 'customers') return liveCustomerQuery();
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
      jest.doMock('../services/stripe', () => ({ assertNoInvoiceChargeReconciliationPending: jest.fn(async () => undefined), chargeInvoiceWithSavedCard: jest.fn(), quoteInvoiceSavedCardCharge: jest.fn() }));

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
          const order = [empty, empty, empty, empty, empty, empty, empty, neverAttempted, empty, empty];
          return order[Math.min(asTCall - 1, order.length - 1)];
        }
        if (table === 'annual_prepay_terms') {
          return { where: jest.fn().mockReturnValue({ first: jest.fn().mockResolvedValue(parent) }) };
        }
        if (table === 'customers') return liveCustomerQuery();
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
      jest.doMock('../services/stripe', () => ({ assertNoInvoiceChargeReconciliationPending: jest.fn(async () => undefined), chargeInvoiceWithSavedCard: jest.fn(), quoteInvoiceSavedCardCharge: jest.fn() }));

      const successor = baseSuccessor({ renewed_from_term_id: 'parent-1', annual_plan_version: 'v3' });
      const empty = tableQuery([]);
      const neverReachedStripe = tableQuery([successor]);

      const undeliveredInvoice = { where: jest.fn(() => ({ first: jest.fn().mockResolvedValue({ status: 'draft', sent_at: null, sms_sent_at: null, email_sent_at: null }) })) };
      // Codex #4971 round-4 (post-merge audit) P1: leg 7b now revalidates
      // the parent's eligibility before delivering — an eligible parent
      // (still 'active', undecided, no linked invoice) matches this test's
      // intent (a safe, still-eligible recovery) and lets it exercise the
      // SAME delivery path as before the fix.
      // Codex #4971 r7 P1: the claim retire re-reads the successor (its
      // claimed fence set, no submitted attempt) and compare-and-sets
      // renewal_charge_claim_retired_at before anything is belled or sent.
      const retireUpdate = jest.fn().mockResolvedValue(1);
      const eligibleParentQuery = {
        where: jest.fn((filter) => ({
          first: jest.fn().mockResolvedValue(filter?.id === successor.id
            ? { ...successor, renewal_charge_attempted_at: new Date('2026-09-27T00:00:00Z') }
            : { status: 'active', renewal_decision: null, prepay_invoice_id: null }),
          whereNull: jest.fn(() => ({ update: retireUpdate })),
          update: jest.fn().mockResolvedValue(1),
        })),
      };
      const noAttempt = { where: jest.fn(() => noAttempt), first: jest.fn().mockResolvedValue(undefined) };
      let asTCall = 0;
      const conn = jest.fn((table) => {
        if (table === 'annual_prepay_terms as t') {
          asTCall += 1;
          const order = [empty, empty, empty, empty, empty, empty, empty, empty, neverReachedStripe, empty];
          return order[Math.min(asTCall - 1, order.length - 1)];
        }
        if (table === 'annual_prepay_terms') return eligibleParentQuery;
        if (table === 'invoices') return undeliveredInvoice;
        if (table === 'stripe_invoice_charge_attempts as a') return noAttempt;
        if (table === 'customers') return liveCustomerQuery();
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
      // The claim was retired (under the gate) BEFORE the bell and the send.
      expect(retireUpdate).toHaveBeenCalledWith({ renewal_charge_claim_retired_at: expect.any(Date) });
      expect(retireUpdate.mock.invocationCallOrder[0]).toBeLessThan(notifyAdmin.mock.invocationCallOrder[0]);
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
      jest.doMock('../services/stripe', () => ({ assertNoInvoiceChargeReconciliationPending: jest.fn(async () => undefined), chargeInvoiceWithSavedCard: jest.fn(), quoteInvoiceSavedCardCharge: jest.fn() }));

      const successor = baseSuccessor({ renewed_from_term_id: 'parent-1', annual_plan_version: 'v3' });
      const empty = tableQuery([]);
      const neverReachedStripe = tableQuery([successor]);
      const deliveredInvoice = { where: jest.fn(() => ({ first: jest.fn().mockResolvedValue({ status: 'sent', sent_at: new Date('2026-10-01T00:00:00Z'), sms_sent_at: null, email_sent_at: null }) })) };
      const eligibleParentQuery = { where: jest.fn(() => ({ first: jest.fn().mockResolvedValue({ status: 'active', renewal_decision: null, prepay_invoice_id: null }) })) };

      let asTCall = 0;
      const conn = jest.fn((table) => {
        if (table === 'annual_prepay_terms as t') {
          asTCall += 1;
          const order = [empty, empty, empty, empty, empty, empty, empty, empty, neverReachedStripe, empty];
          return order[Math.min(asTCall - 1, order.length - 1)];
        }
        if (table === 'annual_prepay_terms') return eligibleParentQuery;
        if (table === 'invoices') return deliveredInvoice;
        if (table === 'customers') return liveCustomerQuery();
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
      // No charge reconciliation pending (the withdrawal's money-in-motion check).
      jest.doMock('../services/stripe', () => ({ assertNoInvoiceChargeReconciliationPending: jest.fn(async () => undefined) }));
      const empty = tableQuery([]);
      const neverReachedStripe = tableQuery([successor]);
      const stampUpdate = jest.fn().mockResolvedValue(1);
      const deferredUpdate = jest.fn().mockResolvedValue(1);
      const retireUpdate = jest.fn().mockResolvedValue(1);
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
            where: jest.fn((filter) => ({
              // Codex #4971 r7 P1: leg 7b retires the claim under the gate
              // first (renewal_charge_claim_retired_at compare-and-set).
              whereNull: jest.fn((col) => ({ update: col === 'renewal_charge_claim_retired_at' ? retireUpdate : stampUpdate })),
              update: deferredUpdate,
              // The successor's own status re-read after a retire's void
              // asks for 'status'; the withdrawal's and the claim retire's
              // own re-reads under the gate read the successor row (a 7b
              // candidate always carries its claimed fence); every other
              // read here is the parent.
              first: jest.fn((col) => {
                if (col === 'status') return Promise.resolve(successorAfterVoid);
                return Promise.resolve(filter?.id === successor.id ? { renewal_charge_attempted_at: new Date('2026-09-27T00:00:00Z'), ...successor } : parent);
              }),
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
        if (table === 'customers') return liveCustomerQuery();
        throw new Error(`unexpected table ${table}`);
      });
      conn.schema = { hasTable: jest.fn().mockResolvedValue(true) };
      return { conn, stampUpdate, deferredUpdate, retireUpdate };
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
      jest.doMock('../services/annual-prepay-renewals', () => ({ withParentDecisionLock: (termId, fn) => fn(),
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
        dedupeKey: 'termite-renewal-charge:succ-term-1:renewal_withdrawn',
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
      jest.doMock('../services/annual-prepay-renewals', () => ({ withParentDecisionLock: (termId, fn) => fn(),
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

    // OWNER RULING (item 6): a durable parent refusal withdraws the renewal
    // even when its invoice was already sent — it is not left payable until
    // the grace-lapse pass.
    test('6b P1 + owner ruling: a PRESENTED renewal (invoice already sent) whose parent was cancelled is withdrawn right away — voided, one alert, no pay link', async () => {
      mockCommon();
      const notifyAdmin = jest.fn(async () => ({ id: 'n1' }));
      jest.doMock('../services/notification-service', () => ({ notifyAdmin }));
      const voidInvoice = jest.fn(async () => ({}));
      const sendViaSMSAndEmail = jest.fn();
      jest.doMock('../services/invoice', () => ({ sendViaSMSAndEmail, voidInvoice }));
      jest.doMock('../services/annual-prepay-renewals', () => ({ withParentDecisionLock: (termId, fn) => fn(), termiteRenewalGraceDeadlineFor: jest.fn(() => '2099-01-01') }));

      const successor = baseSuccessor({ renewed_from_term_id: 'parent-1', annual_plan_version: 'v3' });
      const cancelledParent = { status: 'cancelled', renewal_decision: 'cancel', prepay_invoice_id: null };
      const { conn, stampUpdate } = makeLeg7bConn(successor, { status: 'sent', sent_at: new Date() }, cancelledParent);

      const { _private } = require('../services/termite-annual-renewal-charge');
      await _private.reconcileStuckSuccessors({ conn, limit: 200, counts: { reconcileNeverReachedStripeBelled: 0 } });

      expect(voidInvoice).toHaveBeenCalledWith('succ-invoice-1', { requireUnsettled: true });
      expect(sendViaSMSAndEmail).not.toHaveBeenCalled();
      expect(notifyAdmin).toHaveBeenCalledTimes(1);
      expect(notifyAdmin).toHaveBeenCalledWith('billing', expect.stringMatching(/withdrawn/i), expect.any(String), expect.objectContaining({
        dedupeKey: 'termite-renewal-charge:succ-term-1:renewal_withdrawn',
      }));
      expect(stampUpdate).toHaveBeenCalledTimes(1);
    });

    test('6b P1: a PRESENTED renewal past its own grace deadline is still the grace-lapse pass\'s — never withdrawn here', async () => {
      mockCommon();
      const notifyAdmin = jest.fn(async () => ({ id: 'n1' }));
      jest.doMock('../services/notification-service', () => ({ notifyAdmin }));
      const voidInvoice = jest.fn();
      jest.doMock('../services/invoice', () => ({ sendViaSMSAndEmail: jest.fn(), voidInvoice }));
      jest.doMock('../services/annual-prepay-renewals', () => ({ withParentDecisionLock: (termId, fn) => fn(), termiteRenewalGraceDeadlineFor: jest.fn(() => '2026-09-01') }));

      const successor = baseSuccessor({ renewed_from_term_id: 'parent-1', annual_plan_version: 'v3' });
      const { conn, stampUpdate } = makeLeg7bConn(successor, { status: 'sent', sent_at: new Date() });

      const { _private } = require('../services/termite-annual-renewal-charge');
      await _private.reconcileStuckSuccessors({ conn, limit: 200, counts: { reconcileNeverReachedStripeBelled: 0 } });

      expect(voidInvoice).not.toHaveBeenCalled();
      expect(notifyAdmin).toHaveBeenCalledWith('billing', expect.any(String), expect.stringMatching(/grace-lapse pass/), expect.objectContaining({
        dedupeKey: 'termite-renewal-charge:succ-term-1:ineligible',
      }));
      expect(stampUpdate).toHaveBeenCalledTimes(1);
    });

    // Codex #4971 pre-push P0: a payer assigned since the mint — leg 7b's
    // recovery sends the homeowner nothing and tells staff to route it.
    test('leg 7b recovery with a payer now assigned: no pay link; handled once the payer bell persisted', async () => {
      mockCommon();
      const notifyAdmin = jest.fn(async () => ({ id: 'n1' }));
      jest.doMock('../services/notification-service', () => ({ notifyAdmin }));
      const sendViaSMSAndEmail = jest.fn();
      jest.doMock('../services/invoice', () => ({ sendViaSMSAndEmail }));
      jest.doMock('../services/payer', () => ({ resolveForInvoice: jest.fn(async () => ({ payerId: 'payer-9' })) }));
      const successor = baseSuccessor({ renewed_from_term_id: 'parent-1', annual_plan_version: 'v3' });
      const { conn, stampUpdate } = makeLeg7bConn(successor);

      const { _private } = require('../services/termite-annual-renewal-charge');
      await _private.reconcileStuckSuccessors({ conn, limit: 200, counts: { reconcileNeverReachedStripeBelled: 0 } });

      expect(sendViaSMSAndEmail).not.toHaveBeenCalled();
      expect(notifyAdmin).toHaveBeenCalledWith('billing', expect.stringMatching(/third-party payer/i), expect.any(String), expect.objectContaining({
        dedupeKey: 'termite-renewal-charge:succ-term-1:payer_billed',
      }));
      expect(stampUpdate).toHaveBeenCalledTimes(1);
    });

    test('6b P1: a send that lands between 7b\'s stamp read and its call is not repeated — the leg counts it delivered', async () => {
      mockCommon();
      jest.doMock('../models/db', () => {
        const dbFn = jest.fn(() => ({ where: jest.fn(() => ({ first: jest.fn(async () => ({ status: 'sent', email_sent_at: new Date() })) })) }));
        dbFn.schema = { hasTable: jest.fn().mockResolvedValue(true) };
        return dbFn;
      });
      jest.doMock('../services/notification-service', () => ({ notifyAdmin: jest.fn(async () => ({ id: 'n1' })) }));
      const sendViaSMSAndEmail = jest.fn(async () => { throw Object.assign(new Error('already delivered'), { code: 'already_delivered' }); });
      jest.doMock('../services/invoice', () => ({ sendViaSMSAndEmail }));
      const successor = baseSuccessor({ renewed_from_term_id: 'parent-1', annual_plan_version: 'v3' });
      const { conn, stampUpdate } = makeLeg7bConn(successor); // 7b's own read: an undelivered draft

      const { _private } = require('../services/termite-annual-renewal-charge');
      const counts = { reconcileNeverReachedStripeBelled: 0 };
      await _private.reconcileStuckSuccessors({ conn, limit: 200, counts });

      expect(sendViaSMSAndEmail).toHaveBeenCalledTimes(1);
      expect(sendViaSMSAndEmail).toHaveBeenCalledWith('succ-invoice-1', expect.objectContaining({ firstDeliveryOnly: true }));
      expect(stampUpdate).toHaveBeenCalledTimes(1);
      expect(counts.reconcileNeverReachedStripeBelled).toBe(0); // not a fresh delivery of ours
    });

    test('6b P1: a TRANSIENT parent refusal (its own invoice in dispute) sends nothing, retires nothing, and stays retryable — rotated to the back', async () => {
      mockCommon();
      jest.doMock('../services/notification-service', () => ({ notifyAdmin: jest.fn(async () => ({ id: 'n1' })) }));
      const sendViaSMSAndEmail = jest.fn();
      const voidInvoice = jest.fn();
      jest.doMock('../services/invoice', () => ({ sendViaSMSAndEmail, voidInvoice }));
      jest.doMock('../services/annual-prepay-renewals', () => ({ withParentDecisionLock: (termId, fn) => fn(), termiteRenewalGraceDeadlineFor: jest.fn(() => '2099-01-01') }));

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
      jest.doMock('../services/annual-prepay-renewals', () => ({ withParentDecisionLock: (termId, fn) => fn(), termiteRenewalGraceDeadlineFor: jest.fn(() => '2026-09-01') }));

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

  // Codex #4971 r4 P1 — the paid sync's hook (onRenewalSuccessorPaid): a
  // known success ends the write-ahead outcome, and a renewal paid behind a
  // parent that no longer authorizes it stays ACTIVE with ONE staff alert
  // (refund or honor it) — never a customer message.
  describe('onRenewalSuccessorPaid (paid sync hook)', () => {
    function hookConn({ parent, paidAfter = true, successor: hookSuccessor = paidSuccessor() }) {
      const updates = [];
      const conn = jest.fn((table) => {
        // paidAfterParentChanged: the ONE "paid after the parent changed"
        // SQL test (parentChangedAtSql) — answered here directly.
        if (table === 'annual_prepay_terms as p') {
          const q = { leftJoin: jest.fn(() => q), joinRaw: jest.fn(() => q), where: jest.fn(() => q), first: jest.fn(async () => ({ paid_after: paidAfter })) };
          return q;
        }
        if (table === 'annual_prepay_terms') {
          return {
            where: jest.fn((filter) => ({
              // The bell re-reads the successor under the gate (Codex #4971 r6 P1).
              first: jest.fn(async () => (filter.id === 'parent-1' ? parent : (filter.id === 'succ-term-1' ? hookSuccessor : undefined))),
              update: jest.fn(async (payload) => { updates.push({ filter, payload }); return 1; }),
              whereNull: jest.fn(() => ({ update: jest.fn(async (payload) => { updates.push({ filter, payload }); return 1; }) })),
            })),
          };
        }
        if (table === 'invoices') return { where: jest.fn(() => ({ first: jest.fn(async () => ({ status: 'paid', paid_at: new Date() })) })) };
        // The successor's own ledger (successorPaymentBacksRenewal): no refund.
        if (table === 'payments') return { whereRaw: jest.fn(() => ({ first: jest.fn(async () => undefined) })) };
        if (table === 'customers') return liveCustomerQuery();
        throw new Error(`unexpected table ${table}`);
      });
      conn.raw = jest.fn((sql) => sql);
      return { conn, updates };
    }
    const paidSuccessor = (over = {}) => baseSuccessor({ status: 'active', renewal_charge_failure_kind: 'outcome_pending', renewal_late_paid_belled_at: null, ...over });

    test('parent cancelled while the ACH cleared: one "paid after the prior plan ended" alert, marker stamped, successor left active, no customer message', async () => {
      mockCommon();
      const notifyAdmin = jest.fn(async () => ({ id: 'n1' }));
      jest.doMock('../services/notification-service', () => ({ notifyAdmin }));
      const sendCustomerMessage = jest.fn();
      jest.doMock('../services/messaging/send-customer-message', () => ({ sendCustomerMessage }));
      const sendViaSMSAndEmail = jest.fn();
      jest.doMock('../services/invoice', () => ({ sendViaSMSAndEmail, voidInvoice: jest.fn() }));
      const { onRenewalSuccessorPaid } = require('../services/termite-annual-renewal-charge');
      const { conn, updates } = hookConn({ parent: { id: 'parent-1', status: 'cancelled', renewal_decision: 'cancel', renewal_decision_at: '2026-09-01T12:00:00Z', term_end: '2026-09-26' } });

      await onRenewalSuccessorPaid(paidSuccessor(), conn);

      expect(updates).toContainEqual({ filter: { id: 'succ-term-1', renewal_charge_failure_kind: 'outcome_pending' }, payload: { renewal_charge_failure_kind: null, renewal_charge_failure_reason: null } });
      expect(notifyAdmin).toHaveBeenCalledTimes(1);
      expect(notifyAdmin).toHaveBeenCalledWith('billing', expect.stringMatching(/paid after the prior plan/i), expect.stringContaining('refund it or honor it'), expect.objectContaining({
        dedupeKey: 'termite-renewal-charge:succ-term-1:paid_after_parent_ended',
      }));
      expect(updates).toContainEqual({ filter: { id: 'succ-term-1' }, payload: { renewal_late_paid_belled_at: expect.any(Date) } });
      // Left active: nothing voided or cancelled, nothing sent to the customer.
      expect(updates.some(({ payload }) => 'status' in payload)).toBe(false);
      expect(sendCustomerMessage).not.toHaveBeenCalled();
      expect(sendViaSMSAndEmail).not.toHaveBeenCalled();
    });

    // Codex #4971 pre-push P1: the paid decided-lapse successor (declined
    // while unpaid, then paid) is a paid renewal too.
    test('a PAID decided-lapse successor behind a cancelled parent: one alert that says the next renewal was already declined', async () => {
      mockCommon();
      const notifyAdmin = jest.fn(async () => ({ id: 'n1' }));
      jest.doMock('../services/notification-service', () => ({ notifyAdmin }));
      const { onRenewalSuccessorPaid } = require('../services/termite-annual-renewal-charge');
      const lapse = paidSuccessor({ status: 'cancelled', renewal_decision: 'cancel' });
      const { conn, updates } = hookConn({ successor: lapse, parent: { id: 'parent-1', status: 'cancelled', renewal_decision: 'cancel', renewal_decision_at: '2026-09-01T12:00:00Z', term_end: '2026-09-26' } });

      await onRenewalSuccessorPaid(lapse, conn);

      expect(notifyAdmin).toHaveBeenCalledTimes(1);
      expect(notifyAdmin).toHaveBeenCalledWith('billing', expect.any(String), expect.stringContaining('already declined the NEXT renewal'), expect.objectContaining({
        dedupeKey: 'termite-renewal-charge:succ-term-1:paid_after_parent_ended',
      }));
      expect(updates).toContainEqual({ filter: { id: 'succ-term-1' }, payload: { renewal_late_paid_belled_at: expect.any(Date) } });
    });

    test.each([
      ['a refunded decided cancel', { status: 'cancelled', renewal_decision: 'cancel' }, { status: 'refunded', paid_at: new Date() }],
      ['a cancel without a decision', { status: 'cancelled', renewal_decision: null }, { status: 'paid', paid_at: new Date() }],
      ['a live successor on an unpaid invoice', {}, { status: 'open', paid_at: null }],
    ])('%s: the hook does nothing — no outcome clear, no alert', async (_label, over, invoice) => {
      mockCommon();
      const notifyAdmin = jest.fn(async () => ({ id: 'n1' }));
      jest.doMock('../services/notification-service', () => ({ notifyAdmin }));
      const { onRenewalSuccessorPaid } = require('../services/termite-annual-renewal-charge');
      const successor = paidSuccessor(over);
      const { conn, updates } = hookConn({ successor, parent: { id: 'parent-1', status: 'cancelled', renewal_decision: 'cancel', renewal_decision_at: '2026-09-01T12:00:00Z', term_end: '2026-09-26' } });
      const realConn = conn;
      const wrapped = jest.fn((table) => (table === 'invoices' ? { where: jest.fn(() => ({ first: jest.fn(async () => invoice) })) } : realConn(table)));
      wrapped.raw = realConn.raw;

      await onRenewalSuccessorPaid(successor, wrapped);

      expect(notifyAdmin).not.toHaveBeenCalled();
      expect(updates).toEqual([]);
    });

    test('a parent that still authorizes the renewal (renewed / renew): no alert; a lost alert is never marked', async () => {
      mockCommon();
      const notifyAdmin = jest.fn(async () => null); // would be lost
      jest.doMock('../services/notification-service', () => ({ notifyAdmin }));
      const { onRenewalSuccessorPaid } = require('../services/termite-annual-renewal-charge');
      const renewed = hookConn({ parent: { id: 'parent-1', status: 'renewed', renewal_decision: 'renew', term_end: '2026-09-26' } });
      await onRenewalSuccessorPaid(paidSuccessor({ renewal_charge_failure_kind: null }), renewed.conn);
      expect(notifyAdmin).not.toHaveBeenCalled();
      expect(renewed.updates).toEqual([]);

      const cancelled = hookConn({ parent: { id: 'parent-1', status: 'cancelled', renewal_decision: 'cancel', renewal_decision_at: '2026-09-01T12:00:00Z', term_end: '2026-09-26' } });
      await onRenewalSuccessorPaid(paidSuccessor({ renewal_charge_failure_kind: null }), cancelled.conn);
      expect(notifyAdmin).toHaveBeenCalledTimes(1);
      expect(cancelled.updates.some(({ payload }) => 'renewal_late_paid_belled_at' in payload)).toBe(false);
    });
  });

  // Codex #4971 pre-push P1: a charge that REACHED Stripe and did not pay
  // (decline, refusal, ambiguous) is outside every other recovery leg (7a:
  // the fence is claimed; 7b: it reached Stripe), so its follow-through is
  // persisted before it runs and re-run by leg 7c until it verifiably
  // happened — never the charge itself.
  describe('charge-outcome follow-through (leg 7c)', () => {
    // The pay-link-owing follow-through first asks leg 7b's own "may a
    // recovery leg still deliver?" question (refuseRecoveryDelivery), so the
    // conn also answers the parent read (default: live, undecided, and the
    // successor starts the day after its term_end) and the withdrawal's
    // own reads (the successor's status after a void, submitted attempts).
    const LIVE_PARENT = { id: 'parent-1', status: 'active', renewal_decision: null, prepay_invoice_id: null, term_end: '2026-09-26' };
    function followThroughConn({ invoice = { status: 'draft' }, rows = [], parent = LIVE_PARENT } = {}) {
      const updates = [];
      const conn = jest.fn((table) => {
        if (table === 'annual_prepay_terms as t') {
          const q = {};
          for (const m of ['whereNotNull', 'whereNull', 'where', 'whereNot', 'orderByRaw', 'orderBy', 'select']) q[m] = jest.fn(() => q);
          q.limit = jest.fn(async () => rows);
          return q;
        }
        if (table === 'annual_prepay_terms') {
          return {
            where: jest.fn((filter) => ({
              update: jest.fn(async (payload) => { updates.push(payload); return 1; }),
              // recordChargeFailedNoticeOutcome's own durable stamp (Codex
              // #4971 r15 P2).
              whereNull: jest.fn(() => ({
                update: jest.fn(async (payload) => { updates.push(payload); return 1; }),
              })),
              // The withdrawal re-reads the successor under the gate (Codex
              // #4971 r6 P1); the post-void status read and the parent read
              // answer as before.
              first: jest.fn(async (col) => {
                if (col === 'status') return { status: 'cancelled' };
                const owed = rows.find((row) => row.id === filter?.id);
                return owed && !col ? owed : parent;
              }),
            })),
          };
        }
        if (table === 'invoices') return { where: jest.fn(() => ({ first: jest.fn(async () => invoice) })) };
        if (table === 'stripe_invoice_charge_attempts as a') {
          const q = { where: jest.fn(() => q), first: jest.fn(async () => undefined) };
          return q;
        }
        if (table === 'customers') return liveCustomerQuery();
        throw new Error(`unexpected table ${table}`);
      });
      return { conn, updates };
    }

    test('a genuine decline whose pay link failed stays owed; 7c delivers it and marks it done — the customer notice is never re-sent', async () => {
      mockCommon();
      const sendViaSMSAndEmail = jest.fn().mockResolvedValueOnce({ ok: false, error: 'provider down' }).mockResolvedValue({ ok: true });
      // The charge-failed text hands off under the invoice's Bill-To send claim (Codex #4971 r5 P1).
      const withPayLinkSendClaim = jest.fn(async (_invoiceId, handoff) => handoff({ token: 'tok-1' }));
      jest.doMock('../services/invoice', () => ({ sendViaSMSAndEmail, withPayLinkSendClaim }));
      jest.doMock('../services/notification-service', () => ({ notifyAdmin: jest.fn(async () => ({ id: 'n1' })) }));
      const sendCustomerMessage = jest.fn(async () => ({ sent: true }));
      jest.doMock('../services/messaging/send-customer-message', () => ({ sendCustomerMessage }));
      jest.doMock('../services/sms-template-renderer', () => ({ renderSmsTemplate: jest.fn(async () => 'body') }));
      jest.doMock('../utils/portal-url', () => ({ publicPortalUrl: () => 'https://portal.example.com' }));
      jest.doMock('../models/db', () => jest.fn((table) => ({
        where: jest.fn(() => ({ first: jest.fn(async () => (table === 'customers' ? { id: 'cust-1', phone: '+19415550000' } : { token: 't' })) })),
      })));
      const declineErr = Object.assign(new Error('Your card was declined.'), { wavesCardDecline: { declineCode: 'card_declined' } });
      mockSignatureChargePrivate({ classifyChargeErrorImpl: jest.fn(() => ({ status: 'declined', reason: declineErr.message })) });

      const { _private } = require('../services/termite-annual-renewal-charge');
      const first = followThroughConn();
      const successor = baseSuccessor({ renewal_charge_attempted_at: new Date() });
      await expect(_private.followThroughChargeOutcome(successor, 'declined', declineErr.message, first.conn, { first: true })).resolves.toBe(false);
      expect(first.updates[0]).toEqual({ renewal_charge_failure_kind: 'declined', renewal_charge_failure_reason: declineErr.message, renewal_charge_failure_handled_at: null });
      expect(first.updates.some((u) => u.renewal_charge_failure_handled_at instanceof Date)).toBe(false);
      await Promise.resolve();
      expect(sendCustomerMessage).toHaveBeenCalledTimes(1);
      // Codex #4971 r15 P2: the notice's own durable "sent" stamp — set on
      // the FIRST run since it was accepted there, so a later retry (below)
      // must see it and skip re-sending.
      expect(first.updates.some((u) => u.renewal_charge_failed_notice_sent_at instanceof Date)).toBe(true);

      // Leg 7c, a later tick — a fresh DB read carries the notice's own
      // durable stamp forward (the first run's own conn/updates array is a
      // separate mock instance; this models what a real re-read returns).
      const owed = {
        ...successor,
        renewal_charge_failure_kind: 'declined',
        renewal_charge_failure_reason: declineErr.message,
        renewal_charge_failed_notice_sent_at: new Date(),
      };
      const retry = followThroughConn({ rows: [owed] });
      const counts = { reconcileFollowThroughScanned: 0 };
      await _private.reconcileChargeFollowThrough({ conn: retry.conn, limit: 50, counts });
      expect(counts.reconcileFollowThroughScanned).toBe(1);
      expect(sendViaSMSAndEmail).toHaveBeenCalledTimes(2);
      expect(retry.updates).toContainEqual({ renewal_charge_failure_handled_at: expect.any(Date) });
      expect(sendCustomerMessage).toHaveBeenCalledTimes(1); // never a second "payment didn't go through" text
    });

    // Codex #4971 pre-push P1: leg 7c asks leg 7b's own "may a recovery leg
    // still deliver?" question before any pay link — a durable refusal
    // withdraws the renewal, a transient one rotates it; neither sends.
    function mockFollowThroughWithdrawalDeps({ graceDeadline = '2099-01-01' } = {}) {
      const sendViaSMSAndEmail = jest.fn();
      const voidInvoice = jest.fn(async () => ({}));
      jest.doMock('../services/invoice', () => ({ sendViaSMSAndEmail, voidInvoice }));
      const notifyAdmin = jest.fn(async () => ({ id: 'n1' }));
      jest.doMock('../services/notification-service', () => ({ notifyAdmin }));
      jest.doMock('../services/stripe', () => ({ assertNoInvoiceChargeReconciliationPending: jest.fn(async () => undefined) }));
      jest.doMock('../services/annual-prepay-renewals', () => ({
        withParentDecisionLock: (termId, fn) => fn(),
        termiteRenewalGraceDeadlineFor: jest.fn(() => graceDeadline),
        cancelTermWithRestorations: jest.fn(),
      }));
      return { sendViaSMSAndEmail, voidInvoice, notifyAdmin };
    }
    afterEach(() => { jest.dontMock('../services/annual-prepay-renewals'); });

    test.each(['declined', 'refused'])('7c (%s owed): the parent turned durably ineligible — the renewal is withdrawn, no pay link', async (kind) => {
      mockCommon();
      const { sendViaSMSAndEmail, voidInvoice, notifyAdmin } = mockFollowThroughWithdrawalDeps();
      const { _private } = require('../services/termite-annual-renewal-charge');
      const owed = baseSuccessor({ renewal_charge_failure_kind: kind, renewal_charge_failure_reason: 'card declined' });
      const { conn, updates } = followThroughConn({ rows: [owed], parent: { ...LIVE_PARENT, status: 'cancelled', renewal_decision: 'cancel' } });

      await _private.reconcileChargeFollowThrough({ conn, limit: 50, counts: {} });

      expect(sendViaSMSAndEmail).not.toHaveBeenCalled();
      expect(voidInvoice).toHaveBeenCalledWith('succ-invoice-1', { requireUnsettled: true });
      expect(notifyAdmin).toHaveBeenCalledWith('billing', expect.stringMatching(/withdrawn/i), expect.stringContaining('parent_decided_cancel'), expect.objectContaining({
        dedupeKey: 'termite-renewal-charge:succ-term-1:renewal_withdrawn',
      }));
      expect(updates).toContainEqual({ renewal_charge_failure_handled_at: expect.any(Date) }); // 7c stops
    });

    test('7c: past its own grace deadline and never presented — withdrawn, never a late pay link the next lapse tick would act on', async () => {
      mockCommon();
      const { sendViaSMSAndEmail, voidInvoice } = mockFollowThroughWithdrawalDeps({ graceDeadline: '2026-09-01' });
      const { _private } = require('../services/termite-annual-renewal-charge');
      const owed = baseSuccessor({ renewal_charge_failure_kind: 'refused', renewal_charge_failure_reason: 'Auto Pay inactive' });
      const { conn } = followThroughConn({ rows: [owed] });

      await _private.reconcileChargeFollowThrough({ conn, limit: 50, counts: {} });

      expect(sendViaSMSAndEmail).not.toHaveBeenCalled();
      expect(voidInvoice).toHaveBeenCalledWith('succ-invoice-1', { requireUnsettled: true });
    });

    test('7c: the parent\'s own invoice is in dispute (transient) — nothing sent or voided, still owed, rotated', async () => {
      mockCommon();
      const { sendViaSMSAndEmail, voidInvoice, notifyAdmin } = mockFollowThroughWithdrawalDeps();
      const { _private } = require('../services/termite-annual-renewal-charge');
      const owed = baseSuccessor({ renewal_charge_failure_kind: 'declined', renewal_charge_failure_reason: 'card declined' });
      const { conn, updates } = followThroughConn({ rows: [owed], parent: { ...LIVE_PARENT, status: 'payment_pending' } });

      await _private.reconcileChargeFollowThrough({ conn, limit: 50, counts: {} });

      expect(sendViaSMSAndEmail).not.toHaveBeenCalled();
      expect(voidInvoice).not.toHaveBeenCalled();
      expect(notifyAdmin).toHaveBeenCalledWith('billing', expect.any(String), expect.any(String), expect.objectContaining({
        dedupeKey: 'termite-renewal-charge:succ-term-1:ineligible',
      }));
      expect(updates.some((u) => 'renewal_charge_failure_handled_at' in u)).toBe(false);
      expect(updates).toContainEqual({ renewal_sweep_deferred_at: expect.any(Date) });
    });

    // Codex #4971 pre-push P1: deliverRenewalInvoice uses invoice.js's
    // ATOMIC first-delivery guard (firstDeliveryOnly). A staff or scheduled
    // send that completes between the caller's own stamp read and the send
    // is refused by the claim itself ('already_delivered') — no second text
    // — and counts as delivered only on persisted delivery evidence.
    function alreadyDeliveredErr() {
      return Object.assign(new Error('Invoice INV-1 was already delivered (status: sent) — not sent again'), { code: 'already_delivered' });
    }
    function mockGlobalInvoiceRead(invoice) {
      jest.doMock('../models/db', () => {
        const dbFn = jest.fn(() => ({ where: jest.fn(() => ({ first: jest.fn(async () => invoice) })) }));
        dbFn.schema = { hasTable: jest.fn().mockResolvedValue(true) };
        return dbFn;
      });
    }

    test('a send that completes between the stamp read and the call: no second send; the follow-through counts it delivered', async () => {
      mockCommon();
      mockGlobalInvoiceRead({ status: 'sent', sms_sent_at: new Date('2026-09-27T15:00:00Z') });
      const sendViaSMSAndEmail = jest.fn(async () => { throw alreadyDeliveredErr(); });
      jest.doMock('../services/invoice', () => ({ sendViaSMSAndEmail }));
      jest.doMock('../services/notification-service', () => ({ notifyAdmin: jest.fn(async () => ({ id: 'n1' })) }));
      const { _private } = require('../services/termite-annual-renewal-charge');
      // The caller's own read still sees the undelivered draft.
      const owed = baseSuccessor({ renewal_charge_failure_kind: 'refused', renewal_charge_failure_reason: 'Auto Pay inactive' });
      const { conn, updates } = followThroughConn({ rows: [owed], invoice: { status: 'draft' } });

      await _private.reconcileChargeFollowThrough({ conn, limit: 50, counts: {} });

      expect(sendViaSMSAndEmail).toHaveBeenCalledTimes(1);
      expect(sendViaSMSAndEmail).toHaveBeenCalledWith('succ-invoice-1', expect.objectContaining({ firstDeliveryOnly: true }));
      expect(updates).toContainEqual({ renewal_charge_failure_handled_at: expect.any(Date) });
    });

    test('an already-delivered refusal WITHOUT a persisted delivery stamp is not trusted — still owed, rotated', async () => {
      mockCommon();
      mockGlobalInvoiceRead({ status: 'sent', sent_at: null, sms_sent_at: null, email_sent_at: null });
      const sendViaSMSAndEmail = jest.fn(async () => { throw alreadyDeliveredErr(); });
      jest.doMock('../services/invoice', () => ({ sendViaSMSAndEmail }));
      jest.doMock('../services/notification-service', () => ({ notifyAdmin: jest.fn(async () => ({ id: 'n1' })) }));
      const { _private } = require('../services/termite-annual-renewal-charge');
      const owed = baseSuccessor({ renewal_charge_failure_kind: 'refused', renewal_charge_failure_reason: 'Auto Pay inactive' });
      const { conn, updates } = followThroughConn({ rows: [owed], invoice: { status: 'draft' } });

      await _private.reconcileChargeFollowThrough({ conn, limit: 50, counts: {} });

      expect(sendViaSMSAndEmail).toHaveBeenCalledTimes(1);
      expect(updates.some((u) => 'renewal_charge_failure_handled_at' in u)).toBe(false);
      expect(updates).toContainEqual({ renewal_sweep_deferred_at: expect.any(Date) });
    });

    test('7c never re-sends a pay link the invoice already shows as delivered — only the lost bell is retried', async () => {
      mockCommon();
      const sendViaSMSAndEmail = jest.fn();
      jest.doMock('../services/invoice', () => ({ sendViaSMSAndEmail }));
      const notifyAdmin = jest.fn(async () => ({ id: 'n2' }));
      jest.doMock('../services/notification-service', () => ({ notifyAdmin }));
      const { _private } = require('../services/termite-annual-renewal-charge');
      const owed = baseSuccessor({ renewal_charge_failure_kind: 'refused', renewal_charge_failure_reason: 'Auto Pay inactive' });
      const { conn, updates } = followThroughConn({ rows: [owed], invoice: { status: 'sent', sms_sent_at: new Date() } });
      await _private.reconcileChargeFollowThrough({ conn, limit: 50, counts: {} });
      expect(sendViaSMSAndEmail).not.toHaveBeenCalled();
      expect(notifyAdmin).toHaveBeenCalledTimes(1);
      expect(updates).toContainEqual({ renewal_charge_failure_handled_at: expect.any(Date) });
    });

    test('an AMBIGUOUS outcome is only ever re-belled — never a pay link beside a possibly-successful charge; a lost bell stays owed', async () => {
      mockCommon();
      const sendViaSMSAndEmail = jest.fn();
      jest.doMock('../services/invoice', () => ({ sendViaSMSAndEmail }));
      jest.doMock('../services/notification-service', () => ({ notifyAdmin: jest.fn(async () => null) }));
      const { _private } = require('../services/termite-annual-renewal-charge');
      const owed = baseSuccessor({ renewal_charge_failure_kind: 'ambiguous', renewal_charge_failure_reason: 'card_intent_incomplete' });
      const { conn, updates } = followThroughConn({ rows: [owed] });
      await _private.reconcileChargeFollowThrough({ conn, limit: 50, counts: {} });
      expect(sendViaSMSAndEmail).not.toHaveBeenCalled();
      expect(updates.some((u) => 'renewal_charge_failure_handled_at' in u)).toBe(false);
      expect(updates).toContainEqual({ renewal_sweep_deferred_at: expect.any(Date) });
    });
  });

  // Codex #4971 pre-push P0 ("preserve payer refusals during recovery"): a
  // payer assigned AFTER the mint owns the renewal. deliverRenewalInvoice —
  // the one homeowner pay-link sender — re-resolves the payer right before
  // sending (the same resolver + shape as stripe.js's customer-default
  // PAYER_BILLED_GUARD) and sends nothing on a payer or an unverifiable
  // lookup. Every caller path is pinned; leg 7b also leaves recorded
  // outcomes to leg 7c.
  describe('payer assigned after mint — no homeowner pay link on any path', () => {
    function mockPayer({ payerId = 'payer-9', rejects = false } = {}) {
      const resolveForInvoice = jest.fn(async () => { if (rejects) throw new Error('payer lookup failed'); return { payerId }; });
      jest.doMock('../services/payer', () => ({ resolveForInvoice }));
      return resolveForInvoice;
    }
    function memConn({ invoice = { status: 'draft' }, rows = [] } = {}) {
      const updates = [];
      const conn = jest.fn((table) => {
        if (table === 'annual_prepay_terms as t') {
          const q = {};
          for (const m of ['whereNotNull', 'whereNull', 'where', 'whereNot', 'whereRaw', 'whereNotExists', 'orderByRaw', 'orderBy', 'select']) q[m] = jest.fn(() => q);
          q.limit = jest.fn(async () => rows);
          return q;
        }
        if (table === 'annual_prepay_terms') {
          return {
            where: jest.fn(() => ({
              update: jest.fn(async (payload) => { updates.push(payload); return 1; }),
              whereNull: jest.fn(() => ({ update: jest.fn(async (payload) => { updates.push(payload); return 1; }) })),
              first: jest.fn(async () => ({ status: 'active', renewal_decision: null, prepay_invoice_id: null, term_end: '2026-09-26' })),
            })),
          };
        }
        if (table === 'invoices') return { where: jest.fn(() => ({ first: jest.fn(async () => invoice) })) };
        if (table === 'customers') return liveCustomerQuery();
        throw new Error(`unexpected table ${table}`);
      });
      return { conn, updates };
    }

    test('deliverRenewalInvoice with a payer assigned sends nothing ({ok:false, code:payer_billed}); a lookup error sends nothing (payer_unverifiable)', async () => {
      mockCommon();
      const sendViaSMSAndEmail = jest.fn();
      jest.doMock('../services/invoice', () => ({ sendViaSMSAndEmail }));
      const resolveForInvoice = mockPayer();
      let { _private } = require('../services/termite-annual-renewal-charge');
      await expect(_private.deliverRenewalInvoice(baseSuccessor(), memConn().conn)).resolves.toMatchObject({ ok: false, code: 'payer_billed' });
      expect(resolveForInvoice).toHaveBeenCalledWith(expect.objectContaining({ customerId: 'cust-1', throwOnError: true }));

      jest.resetModules();
      mockCommon();
      jest.doMock('../services/invoice', () => ({ sendViaSMSAndEmail }));
      mockPayer({ rejects: true });
      ({ _private } = require('../services/termite-annual-renewal-charge'));
      await expect(_private.deliverRenewalInvoice(baseSuccessor(), memConn().conn)).resolves.toMatchObject({ ok: false, code: 'payer_unverifiable' });
      expect(sendViaSMSAndEmail).not.toHaveBeenCalled();
    });

    test('the charge-failed customer notice (it carries the pay URL) is never sent to a payer-billed or unverifiable account', async () => {
      mockCommon();
      const sendCustomerMessage = jest.fn();
      jest.doMock('../services/messaging/send-customer-message', () => ({ sendCustomerMessage }));
      mockPayer();
      const { _private } = require('../services/termite-annual-renewal-charge');
      await expect(_private.sendRenewalChargeFailedNotice(baseSuccessor(), memConn().conn)).resolves.toEqual({ sent: false, reason: 'payer_billed' });
      expect(sendCustomerMessage).not.toHaveBeenCalled();
    });

    test('no-consent skip delivery: nothing sent; the payer bell persists, then the row is marked handled (no nightly re-send)', async () => {
      mockCommon();
      const sendViaSMSAndEmail = jest.fn();
      jest.doMock('../services/invoice', () => ({ sendViaSMSAndEmail }));
      const notifyAdmin = jest.fn(async () => ({ id: 'n1' }));
      jest.doMock('../services/notification-service', () => ({ notifyAdmin }));
      jest.doMock('../services/recurring-card-on-file', () => ({ resolvePrepayChargeMethod: jest.fn() }));
      jest.doMock('../services/stripe', () => ({ assertNoInvoiceChargeReconciliationPending: jest.fn(async () => undefined), chargeInvoiceWithSavedCard: jest.fn(), quoteInvoiceSavedCardCharge: jest.fn() }));
      mockPayer();
      const { _private } = require('../services/termite-annual-renewal-charge');
      const { conn, skipStampUpdate } = makeClaimConn({ successorInvoice: { status: 'draft' } });

      await _private.decideAndCharge(baseSuccessor(), baseParent({ renewal_charge_consent_at: null }), conn);

      expect(sendViaSMSAndEmail).not.toHaveBeenCalled();
      expect(notifyAdmin).toHaveBeenCalledWith('billing', expect.stringMatching(/third-party payer/i), expect.any(String), expect.objectContaining({
        dedupeKey: 'termite-renewal-charge:succ-term-1:payer_billed',
      }));
      expect(skipStampUpdate).toHaveBeenCalledWith(expect.objectContaining({ renewal_charge_skip_reason: 'no_consent:payer_billed' }));
    });

    test('no-consent skip delivery with an unverifiable payer: nothing sent, not handled — rotated to retry', async () => {
      mockCommon();
      const sendViaSMSAndEmail = jest.fn();
      jest.doMock('../services/invoice', () => ({ sendViaSMSAndEmail }));
      jest.doMock('../services/notification-service', () => ({ notifyAdmin: jest.fn(async () => ({ id: 'n1' })) }));
      jest.doMock('../services/recurring-card-on-file', () => ({ resolvePrepayChargeMethod: jest.fn() }));
      jest.doMock('../services/stripe', () => ({ assertNoInvoiceChargeReconciliationPending: jest.fn(async () => undefined), chargeInvoiceWithSavedCard: jest.fn(), quoteInvoiceSavedCardCharge: jest.fn() }));
      mockPayer({ rejects: true });
      const { _private } = require('../services/termite-annual-renewal-charge');
      const { conn, skipStampUpdate, deferredUpdate } = makeClaimConn({ successorInvoice: { status: 'draft' } });

      await _private.decideAndCharge(baseSuccessor(), baseParent({ renewal_charge_consent_at: null }), conn);

      expect(sendViaSMSAndEmail).not.toHaveBeenCalled();
      expect(skipStampUpdate).not.toHaveBeenCalled();
      expect(deferredUpdate).toHaveBeenCalledWith({ renewal_sweep_deferred_at: expect.any(Date) });
    });

    test.each(['declined', 'refused'])('follow-through (%s): a payer now assigned — no pay link, no customer text; the payer bell marks it handled', async (kind) => {
      mockCommon();
      const sendViaSMSAndEmail = jest.fn();
      jest.doMock('../services/invoice', () => ({ sendViaSMSAndEmail }));
      const notifyAdmin = jest.fn(async () => ({ id: 'n1' }));
      jest.doMock('../services/notification-service', () => ({ notifyAdmin }));
      const sendCustomerMessage = jest.fn();
      jest.doMock('../services/messaging/send-customer-message', () => ({ sendCustomerMessage }));
      mockPayer();
      const { _private } = require('../services/termite-annual-renewal-charge');
      const { conn, updates } = memConn();

      await expect(_private.followThroughChargeOutcome(baseSuccessor(), kind, 'card declined', conn, { first: true })).resolves.toBe(true);

      expect(sendViaSMSAndEmail).not.toHaveBeenCalled();
      expect(sendCustomerMessage).not.toHaveBeenCalled();
      expect(notifyAdmin).toHaveBeenCalledWith('billing', expect.stringMatching(/third-party payer/i), expect.any(String), expect.objectContaining({
        dedupeKey: 'termite-renewal-charge:succ-term-1:payer_billed',
      }));
      expect(updates).toContainEqual({ renewal_charge_failure_handled_at: expect.any(Date) });
    });

    test('leg 7c on a recorded payer_refused outcome: never a pay link; a lost bell stays owed (rotated)', async () => {
      mockCommon();
      const sendViaSMSAndEmail = jest.fn();
      jest.doMock('../services/invoice', () => ({ sendViaSMSAndEmail }));
      jest.doMock('../services/notification-service', () => ({ notifyAdmin: jest.fn(async () => null) }));
      const resolveForInvoice = mockPayer();
      const { _private } = require('../services/termite-annual-renewal-charge');
      const owed = baseSuccessor({ renewal_charge_failure_kind: 'payer_refused', renewal_charge_failure_reason: 'payer_billed_guard' });
      const { conn, updates } = memConn({ rows: [owed] });

      await _private.reconcileChargeFollowThrough({ conn, limit: 50, counts: {} });

      expect(sendViaSMSAndEmail).not.toHaveBeenCalled();
      expect(resolveForInvoice).not.toHaveBeenCalled(); // payer_refused never even attempts a pay link
      expect(updates.some((u) => 'renewal_charge_failure_handled_at' in u)).toBe(false);
      expect(updates).toContainEqual({ renewal_sweep_deferred_at: expect.any(Date) });
    });

    test('leg 7b skips a row whose charge outcome is recorded (renewal_charge_failure_kind set) — 7c owns it', async () => {
      mockCommon();
      const { _private } = require('../services/termite-annual-renewal-charge');
      const scans = [];
      const conn = jest.fn((table) => {
        if (table === 'customers') return liveCustomerQuery();

        if (table !== 'annual_prepay_terms as t') throw new Error(`unexpected table ${table}`);
        const q = {};
        for (const m of ['whereNotNull', 'whereNull', 'where', 'whereRaw', 'whereNotExists', 'orderByRaw', 'orderBy', 'select']) q[m] = jest.fn(() => q);
        q.limit = jest.fn(async () => []);
        scans.push(q);
        return q;
      });
      await _private.reconcileStuckSuccessors({ conn, limit: 50, counts: {} });
      const leg7b = scans[1];
      expect(leg7b.whereNotNull).toHaveBeenCalledWith('t.renewal_charge_attempted_at');
      // Codex #4971 r4 P1: the only recorded kind 7b still takes is the
      // write-ahead 'outcome_pending' (with no submitted attempt, it IS the
      // crash gap) — every known outcome stays 7c's.
      const outcomeFilter = leg7b.where.mock.calls.map(([arg]) => arg).find((arg) => typeof arg === 'function' && arg.name === 'outcomeNotRecorded');
      const inner = { whereNull: jest.fn(() => inner), orWhere: jest.fn(() => inner) };
      outcomeFilter.call(inner);
      expect(inner.whereNull).toHaveBeenCalledWith('t.renewal_charge_failure_kind');
      expect(inner.orWhere).toHaveBeenCalledWith('t.renewal_charge_failure_kind', 'outcome_pending');
    });

  });
});
