/**
 * Real PostgreSQL: chokepoint A of the termite renewal charge (Codex #4971
 * round-3, items 3, 6 and 7) — the ONE payment-evidence classifier, in its
 * JS form and its SQL twin, and the bounded scans that select on it:
 *
 *   - "settled" (paid evidence, not a cancelled/refunded status, no FULL
 *     refund on the payments ledger) reads the same in JS
 *     (invoiceSettledNotRevoked) and SQL (whereInvoiceSettledNotRevoked)
 *     across every shape, and reconcileParentRenewedStamps (item 3) never
 *     records a parent 'renewed' behind a successor whose renewal money was
 *     fully refunded;
 *   - "reached Stripe" needs durable SUBMISSION evidence (submitted_at, or
 *     a PaymentIntent id) — the grace-lapse "presented" scan (item 6) never
 *     lapses a draft renewal on a bare pre-submit attempt row, and leg 7b
 *     (item 7) recovers exactly those abandoned pre-submit claims.
 *
 * Scratch schema; notification/invoice/stripe side effects are mocked (their
 * own suites cover them) — the SQL under test is real.
 *
 * Self-skips without REPAIR_TEST_DATABASE_URL set to a local throwaway
 * database, e.g.:
 *   REPAIR_TEST_DATABASE_URL=postgresql://waves_user@localhost:5432/waves_test \
 *     npx jest --runInBand server/tests/termite-annual-renewal-charge-evidence-postgres.test.js
 */
const knexLib = require('knex');
const { randomUUID } = require('crypto');

// annualPrepayTableExists() reads the module-level db; every OTHER query
// under test runs on the scratch `db` passed in as `conn`. Codex #4971 r15
// P2: composeAndSendChargeFailedNotice's own customer lookup is one
// exception — it reads the module-level db directly, not `conn` — and now
// that the customer notice retries on every followThroughChargeOutcome
// call (not just the first), leg 7c's tests below reach it. A plain
// resolved-to-null customer lookup is enough: no phone on file settles the
// notice as permanently not-owed ('no_phone'), which is all these charge-
// outcome-sweep tests need from it.
jest.mock('../models/db', () => {
  const stub = jest.fn(() => ({ where: () => ({ first: async () => null }) }));
  stub.schema = { hasTable: jest.fn().mockResolvedValue(true) };
  return stub;
});
const mockNotifyAdmin = jest.fn(async () => ({ id: 'bell-1' }));
jest.mock('../services/notification-service', () => ({ notifyAdmin: (...args) => mockNotifyAdmin(...args) }));
const mockSendViaSMSAndEmail = jest.fn(async () => ({ ok: true }));
const mockVoidInvoice = jest.fn(async () => ({}));
jest.mock('../services/invoice', () => ({
  sendViaSMSAndEmail: (...args) => mockSendViaSMSAndEmail(...args),
  voidInvoice: (...args) => mockVoidInvoice(...args),
}));
// The grace lapse's station-retrieval raise (its own suites cover the task
// itself): "no rented stations" — nothing to verify, the lapse may complete.
const mockRaiseRetrieval = jest.fn(async () => ({ raised: false, reason: 'no_rented_stations' }));
jest.mock('../services/cancellation-processor', () => ({
  raiseTermiteRetrievalTask: (...args) => mockRaiseRetrieval(...args),
  termRetrievalDedupeKey: (termId, episodeKey) => `termite_station_retrieval:term:${termId}:${episodeKey}`,
}));
// The homeowner pay-link payer re-check (self-pay here).
jest.mock('../services/payer', () => ({ resolveForInvoice: jest.fn(async () => ({ payerId: null })) }));
// The grace lapse's own reconciliation re-check — refused here, so a
// selected row stops right after the scan (started_at stamped, deferred):
// these tests are about WHICH rows the scan selects.
jest.mock('../services/stripe', () => ({
  assertNoInvoiceChargeReconciliationPending: jest.fn(async () => { throw new Error('reconciliation pending (test)'); }),
}));

const SKIP = !process.env.REPAIR_TEST_DATABASE_URL;
const describeOrSkip = SKIP ? describe.skip : describe;

async function createScratchDb() {
  const url = new URL(process.env.REPAIR_TEST_DATABASE_URL);
  if (!['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) || !['/invoice_repair_test', '/waves_test'].includes(url.pathname)) {
    throw new Error('This test requires a local invoice_repair_test or waves_test database');
  }
  const schema = `termite_evidence_${randomUUID().replace(/-/g, '')}`;
  const db = knexLib({ client: 'pg', connection: url.toString(), searchPath: [schema], pool: { min: 0, max: 4 } });
  await db.raw('CREATE SCHEMA ??', [schema]);
  await db.raw(`CREATE TABLE annual_prepay_terms (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    customer_id uuid NOT NULL,
    source_estimate_id uuid,
    prepay_invoice_id uuid,
    prepay_amount numeric(10,2) DEFAULT 249,
    status text NOT NULL,
    renewal_decision text,
    renewal_decision_at timestamptz,
    renewal_decision_by uuid,
    renewal_notes text,
    renewed_from_term_id uuid,
    annual_plan_version text,
    installation_anchored_at timestamptz,
    term_start date NOT NULL,
    term_end date NOT NULL,
    renewal_charge_attempted_at timestamptz,
    renewal_charge_skipped_at timestamptz,
    renewal_charge_skip_reason text,
    renewal_charge_never_reached_stripe_belled_at timestamptz,
    renewal_lapse_started_at timestamptz,
    renewal_lapse_completed_at timestamptz,
    renewal_lapse_outcome text,
    renewal_sweep_deferred_at timestamptz,
    renewal_charge_failure_kind text,
    renewal_charge_failure_reason text,
    renewal_charge_failure_handled_at timestamptz,
    renewal_late_paid_belled_at timestamptz,
    renewal_charge_claim_retired_at timestamptz,
    renewal_lapse_parent_cancelled_at timestamptz,
    dispute_suspended_at timestamptz,
    -- Codex #4971 r15 P2: the charge-failed customer notice's own durable
    -- delivery stamp.
    renewal_charge_failed_notice_sent_at timestamptz,
    -- Codex #4971 r17 P2 (finding 5): the deleted-account conflict's own
    -- exclusion marker — reconcileParentRenewedStamps' scan excludes on it
    -- directly in SQL (20260928000100).
    renewal_parent_deleted_conflict_belled_at timestamptz,
    -- Codex #4971 r20 P1 (finding 2): a term-window move's own timestamp,
    -- one more arm of parentChangedAtSql (20260928020000).
    term_window_changed_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
  )`);
  await db.raw(`CREATE TABLE invoices (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    status text,
    paid_at timestamptz,
    sent_at timestamptz,
    sms_sent_at timestamptz,
    email_sent_at timestamptz,
    stripe_payment_intent_id text,
    stripe_charge_id text,
    payer_id uuid,
    -- Codex #4971 r15 P1: a NET-terms statement child invoice — never
    -- itself charged, so its durable revocation signal lives on the
    -- STATEMENT's own payments row (statement_id), not this invoice's own
    -- (absent) Stripe ids.
    payer_statement_id uuid
  )`);
  await db.raw(`CREATE TABLE payments (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    status text,
    refund_status text,
    stripe_payment_intent_id text,
    stripe_charge_id text,
    statement_id uuid,
    metadata jsonb,
    updated_at timestamptz
  )`);
  // The account-deletion read (successorRecoveryRefusal, Codex #4971 r10):
  // a term's customer with no row here reads as live.
  await db.raw('CREATE TABLE customers (id uuid PRIMARY KEY, deleted_at timestamptz)');
  // B10: the collections dispute hold the held-renewal bell scan keys on, and
  // the admin notifications table its dedupe (ringRenewalBell) writes to.
  await db.raw(`CREATE TABLE collections_flags (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    customer_id uuid NOT NULL,
    flag text NOT NULL,
    reason text,
    released_at timestamptz
  )`);
  await db.raw(`CREATE TABLE notifications (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    recipient_type text NOT NULL,
    metadata jsonb
  )`);
  await db.raw(`CREATE TABLE stripe_invoice_charge_attempts (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    invoice_id uuid NOT NULL,
    status text NOT NULL DEFAULT 'claimed',
    error_message text,
    -- Codex #4971 r16 P1 (finding 2, migration 20260927180000): the raw
    -- Stripe decline_code, so leg 7d's crash recovery can tell
    -- authentication_required (ambiguous) from a genuine terminal decline.
    decline_code text,
    submitted_at timestamptz,
    stripe_payment_intent_id text,
    resolved_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT now()
  )`);
  return { db, async destroy() { await db.raw('DROP SCHEMA ?? CASCADE', [schema]); await db.destroy(); } };
}

describeOrSkip('termite renewal charge — chokepoint A payment evidence, real Postgres', () => {
  let fixture;
  let db;
  let Charge;
  let Renewals;
  let etDateString;
  let addETDays;
  let parseETDateTime;
  const customerId = randomUUID();

  beforeAll(() => {
    Charge = require('../services/termite-annual-renewal-charge');
    Renewals = require('../services/annual-prepay-renewals');
    ({ etDateString, addETDays, parseETDateTime } = require('../utils/datetime-et'));
  });

  // The renewal gate's session lock borrows a pooled connection this suite's
  // db mock does not have — run it inline (the lock mechanics have their own
  // real-Postgres suite, annual-prepay-parent-decision-lock-postgres).
  let originalLock;
  beforeEach(async () => {
    jest.clearAllMocks();
    fixture = await createScratchDb();
    db = fixture.db;
    originalLock = Renewals.withParentDecisionLock;
    Renewals.withParentDecisionLock = (_termId, fn) => fn();
  });
  afterEach(async () => {
    Renewals.withParentDecisionLock = originalLock;
    if (fixture) await fixture.destroy();
  });

  const daysFromToday = (n) => etDateString(addETDays(parseETDateTime(`${etDateString()}T12:00`), n));

  async function insertInvoice(fields = {}) {
    const [row] = await db('invoices').insert({ status: 'draft', ...fields }).returning('*');
    return row;
  }

  async function insertParent(fields = {}) {
    const [row] = await db('annual_prepay_terms').insert({
      customer_id: customerId, status: 'active', annual_plan_version: 'v3',
      term_start: daysFromToday(-400), term_end: daysFromToday(-35), ...fields,
    }).returning('*');
    return row;
  }

  async function insertSuccessor(parent, invoice, fields = {}) {
    const [row] = await db('annual_prepay_terms').insert({
      customer_id: customerId,
      prepay_invoice_id: invoice.id,
      status: 'payment_pending',
      annual_plan_version: 'v3',
      renewed_from_term_id: parent.id,
      term_start: daysFromToday(-34),
      term_end: daysFromToday(330),
      created_at: new Date(`${daysFromToday(-34)}T12:00:00Z`),
      ...fields,
    }).returning('*');
    return row;
  }

  describe('"settled" — JS and SQL twins agree on every shape', () => {
    const SHAPES = [
      ['paid', { status: 'paid' }, null, true],
      ['paid_at only', { status: 'sent', paid_at: new Date() }, null, true],
      ['prepaid by account credit', { status: 'prepaid', paid_at: new Date() }, null, true],
      ['uppercase PAID', { status: 'PAID' }, null, true],
      ['open draft', { status: 'draft' }, null, false],
      ['still clearing', { status: 'processing' }, null, false],
      ['void', { status: 'void', paid_at: new Date() }, null, false],
      ['refunded status', { status: 'refunded', paid_at: new Date() }, null, false],
      ['paid, then FULLY refunded on the ledger (PI match)', { status: 'paid', paid_at: new Date(), stripe_payment_intent_id: 'pi_full' },
        { status: 'refunded', stripe_payment_intent_id: 'pi_full' }, false],
      ['paid, then refund_status=full on the ledger (charge match)', { status: 'paid', stripe_charge_id: 'ch_full' },
        { status: 'paid', refund_status: 'full', stripe_charge_id: 'ch_full' }, false],
      ['paid, only PARTIALLY refunded', { status: 'paid', stripe_payment_intent_id: 'pi_part' },
        { status: 'paid', refund_status: 'partial', stripe_payment_intent_id: 'pi_part' }, true],
      ['paid, a full refund of a DIFFERENT payment', { status: 'paid', stripe_payment_intent_id: 'pi_mine' },
        { status: 'refunded', stripe_payment_intent_id: 'pi_other' }, true],
      // Codex #4971 r11 P1: the dispute webhook's first phase flips the
      // payment to 'disputed' before the invoice reopens.
      ['paid, its payment IN DISPUTE on the ledger (PI match)', { status: 'paid', paid_at: new Date(), stripe_payment_intent_id: 'pi_disp' },
        { status: 'disputed', stripe_payment_intent_id: 'pi_disp' }, false],
      ['paid, its payment IN DISPUTE on the ledger (charge match)', { status: 'paid', stripe_charge_id: 'ch_disp' },
        { status: 'disputed', stripe_charge_id: 'ch_disp' }, false],
      ['paid, a dispute WON (the row restored to paid)', { status: 'paid', stripe_payment_intent_id: 'pi_won' },
        { status: 'paid', stripe_payment_intent_id: 'pi_won' }, true],
      ['paid, a DIFFERENT payment in dispute', { status: 'paid', stripe_payment_intent_id: 'pi_mine2' },
        { status: 'disputed', stripe_payment_intent_id: 'pi_other2' }, true],
    ];

    test.each(SHAPES)('%s', async (_label, invoiceFields, payment, expected) => {
      const { invoiceSettledNotRevoked, whereInvoiceSettledNotRevoked } = Charge._private;
      const invoice = await insertInvoice(invoiceFields);
      if (payment) await db('payments').insert(payment);

      const js = await invoiceSettledNotRevoked(db, invoice);
      const sql = Boolean(await whereInvoiceSettledNotRevoked(db('invoices as i').where('i.id', invoice.id), 'i').first('i.id'));
      expect(js).toBe(expected);
      expect(sql).toBe(expected);
    });

    test('"delivered": JS and SQL agree', async () => {
      const { classifyRenewalInvoice, whereInvoiceDelivered } = Charge._private;
      // Codex #4971 pre-push P1: only a persisted delivery stamp counts —
      // 'scheduled' was never sent, and 'sending' is a claim that may have
      // crashed before any provider call (processScheduledSends parks a
      // stale one back as 'scheduled' either way).
      const shapes = [
        [{ status: 'draft' }, false],
        [{ status: 'scheduled' }, false],
        [{ status: 'sending' }, false],
        [{ status: 'sent' }, false],
        [{ status: 'overdue' }, false],
        [{ status: 'scheduled', sms_sent_at: new Date() }, true],
        [{ status: 'sending', email_sent_at: new Date() }, true],
        [{ status: 'draft', sent_at: new Date() }, true],
        [{ status: 'sent', sent_at: new Date() }, true],
      ];
      for (const [fields, expected] of shapes) {
        const invoice = await insertInvoice(fields);
        const sql = Boolean(await whereInvoiceDelivered(db('invoices as i').where('i.id', invoice.id), 'i').first('i.id'));
        expect([fields, classifyRenewalInvoice(invoice).delivered]).toEqual([fields, expected]);
        expect([fields, sql]).toEqual([fields, expected]);
      }
    });
  });

  describe('item 3: reconcileParentRenewedStamps', () => {
    test('stamps the parent behind a genuinely paid successor, never behind a FULLY refunded one, and skips a parent already cancelled', async () => {
      const paidParent = await insertParent();
      const paidInvoice = await insertInvoice({ status: 'paid', paid_at: new Date(), stripe_payment_intent_id: 'pi_ok' });
      await insertSuccessor(paidParent, paidInvoice, { status: 'active' });

      // Refunded on the ledger, but the successor's own cancel sync never
      // ran: it still reads 'active' with paid_at set.
      const refundedParent = await insertParent();
      const refundedInvoice = await insertInvoice({ status: 'paid', paid_at: new Date(), stripe_payment_intent_id: 'pi_back' });
      await db('payments').insert({ status: 'refunded', stripe_payment_intent_id: 'pi_back' });
      await insertSuccessor(refundedParent, refundedInvoice, { status: 'active' });

      // An undecided parent that is already cancelled (a refund/void sync)
      // can never take recordDecision — it must not occupy the page.
      const cancelledParent = await insertParent({ status: 'cancelled' });
      const otherPaid = await insertInvoice({ status: 'paid', paid_at: new Date() });
      await insertSuccessor(cancelledParent, otherPaid, { status: 'active' });

      // Codex #4971 r23 P2: a parent whose window was MOVED after the mint
      // (successor no longer starts the day after the parent ends) is a
      // terminal parent_term_moved conflict for the renew stamp — the
      // late-paid bell owns it — and must not occupy this bounded page.
      const movedParent = await insertParent({ term_end: daysFromToday(-40) });
      const movedPaid = await insertInvoice({ status: 'paid', paid_at: new Date(), stripe_payment_intent_id: 'pi_moved' });
      await insertSuccessor(movedParent, movedPaid, { status: 'active' }); // term_start = today-34 ≠ parent end+1

      const summary = await Renewals.reconcileParentRenewedStamps({ conn: db, limit: 50 });

      expect(summary).toEqual({ scanned: 1, stamped: 1 });
      expect(await db('annual_prepay_terms').where({ id: movedParent.id }).first('status', 'renewal_decision'))
        .toEqual({ status: 'active', renewal_decision: null });
      expect(await db('annual_prepay_terms').where({ id: paidParent.id }).first('status', 'renewal_decision'))
        .toEqual({ status: 'renewed', renewal_decision: 'renew' });
      expect(await db('annual_prepay_terms').where({ id: refundedParent.id }).first('status', 'renewal_decision'))
        .toEqual({ status: 'active', renewal_decision: null });
    });
  });

  describe('items 6/7: "reached Stripe" needs submission evidence', () => {
    // Past its own grace deadline (term_start 34 days ago), charge fence
    // claimed, renewal invoice still an undelivered draft.
    async function claimedDraftSuccessor(attempt) {
      const parent = await insertParent();
      const invoice = await insertInvoice({ status: 'draft' });
      const successor = await insertSuccessor(parent, invoice, { renewal_charge_attempted_at: new Date(Date.now() - 86400000) });
      if (attempt) await db('stripe_invoice_charge_attempts').insert({ invoice_id: invoice.id, ...attempt });
      return successor;
    }

    function freshCounts() {
      return {
        graceScanned: 0, graceLapsed: 0, graceReconciliationDeferred: 0, graceRetiredSettled: 0,
        reconcileNeverAttemptedScanned: 0, reconcileSkipped: 0, charged: 0, failed: 0,
        reconcileNeverReachedStripeScanned: 0, reconcileNeverReachedStripeBelled: 0,
      };
    }

    test('item 6: the grace-lapse "presented" scan never lapses a draft renewal on a bare pre-submit attempt row', async () => {
      const Renewals2 = require('../services/annual-prepay-renewals');
      const originalLock = Renewals2.withParentDecisionLock;
      Renewals2.withParentDecisionLock = (_termId, fn) => fn();
      try {
        const bare = await claimedDraftSuccessor({ status: 'failed' }); // released pre-submit claim
        // Codex #4971 r21 P1: submitted_at alone is the pre-call crash
        // shape (the marker commits BEFORE the Stripe call) — no longer
        // presentation either. Only provider evidence (a PaymentIntent id)
        // or a delivered invoice lets the lapse run.
        const submitted = await claimedDraftSuccessor({ status: 'failed', submitted_at: new Date() });
        const withIntent = await claimedDraftSuccessor({ status: 'ambiguous', stripe_payment_intent_id: 'pi_sent' });

        const counts = freshCounts();
        await Charge._private.processGraceLapses({ conn: db, limit: 50, counts });

        const started = await db('annual_prepay_terms').whereNotNull('renewal_lapse_started_at').pluck('id');
        expect(started).toEqual([withIntent.id]);
        expect(started).not.toContain(bare.id);
        expect(started).not.toContain(submitted.id);
        expect(counts.graceScanned).toBe(1);
      } finally {
        Renewals2.withParentDecisionLock = originalLock;
      }
    });

    test('item 7: leg 7b recovers an abandoned pre-submit claim (bell + pay link) and leaves a genuinely submitted attempt alone', async () => {
      // Inside its grace window: a pay link is still the right recovery.
      // Each successor follows its parent (term_start = parent term_end + 1).
      const parent = await insertParent({ term_end: daysFromToday(-3) });
      const bareInvoice = await insertInvoice({ status: 'draft' });
      const bare = await insertSuccessor(parent, bareInvoice, {
        term_start: daysFromToday(-2), created_at: new Date(), renewal_charge_attempted_at: new Date(Date.now() - 2 * 3600000), // past the 1h recovery lease
        renewal_charge_failure_kind: 'outcome_pending', // the write-ahead marker the fence claim wrote
      });
      await db('stripe_invoice_charge_attempts').insert({ invoice_id: bareInvoice.id, status: 'failed' });

      const parent2 = await insertParent({ term_end: daysFromToday(-3) });
      const sentInvoice = await insertInvoice({ status: 'draft' });
      const submitted = await insertSuccessor(parent2, sentInvoice, {
        term_start: daysFromToday(-2), created_at: new Date(), renewal_charge_attempted_at: new Date(Date.now() - 2 * 3600000), // past the 1h recovery lease
      });
      await db('stripe_invoice_charge_attempts').insert({ invoice_id: sentInvoice.id, status: 'ambiguous', submitted_at: new Date() });

      const counts = freshCounts();
      // The pay link clears under the parent's gate (Codex #4971 r4 P1);
      // this suite's db mock has no pool — run the gate inline.
      const Renewals2 = require('../services/annual-prepay-renewals');
      const originalLock = Renewals2.withParentDecisionLock;
      Renewals2.withParentDecisionLock = (_termId, fn) => fn();
      try {
        await Charge._private.reconcileStuckSuccessors({ conn: db, limit: 50, counts });
      } finally {
        Renewals2.withParentDecisionLock = originalLock;
      }

      expect(counts.reconcileNeverReachedStripeScanned).toBe(1);
      expect(mockSendViaSMSAndEmail).toHaveBeenCalledTimes(1);
      expect(mockSendViaSMSAndEmail).toHaveBeenCalledWith(bareInvoice.id, expect.any(Object));
      const stamped = await db('annual_prepay_terms').whereNotNull('renewal_charge_never_reached_stripe_belled_at').pluck('id');
      expect(stamped).toEqual([bare.id]);
      expect(stamped).not.toContain(submitted.id);
      // Codex #4971 r5 P2: handled by 7b, the never-submitted claim carries
      // no outcome — the write-ahead marker is cleared.
      expect((await db('annual_prepay_terms').where({ id: bare.id }).first('renewal_charge_failure_kind')).renewal_charge_failure_kind).toBeNull();
    });

    // Codex #4971 r7 P1 — live claim vs abandoned claim. Leg 7b takes over
    // only a claim older than the recovery lease, and only after RETIRING it
    // under the gate; the charging worker's own in-gate re-check then
    // refuses the retired claim, so it can never submit afterwards.
    describe('r7: 7b retires an abandoned claim before recovering it', () => {
      async function claimed(ageMs, fields = {}) {
        const parent = await insertParent({ term_end: daysFromToday(-3) });
        const invoice = await insertInvoice({ status: 'draft' });
        const successor = await insertSuccessor(parent, invoice, {
          term_start: daysFromToday(-2), created_at: new Date(),
          renewal_charge_attempted_at: new Date(Date.now() - ageMs), renewal_charge_failure_kind: 'outcome_pending', ...fields,
        });
        return { successor, invoice };
      }
      const rowOf = (id) => db('annual_prepay_terms').where({ id }).first();

      test('a fresh claim is never selected; a stale one is retired, recovered once, and its worker\'s in-gate re-check refuses', async () => {
        const fresh = await claimed(5 * 60000);
        const stale = await claimed(2 * 3600000);

        const counts = { reconcileNeverAttemptedScanned: 0, reconcileSkipped: 0, charged: 0, failed: 0, reconcileNeverReachedStripeScanned: 0, reconcileNeverReachedStripeBelled: 0 };
        await Charge._private.reconcileStuckSuccessors({ conn: db, limit: 50, counts });

        expect(counts.reconcileNeverReachedStripeScanned).toBe(1);
        expect(mockSendViaSMSAndEmail).toHaveBeenCalledTimes(1);
        expect(mockSendViaSMSAndEmail).toHaveBeenCalledWith(stale.invoice.id, expect.any(Object));
        const staleRow = await rowOf(stale.successor.id);
        expect(staleRow.renewal_charge_claim_retired_at).toBeInstanceOf(Date);
        expect(staleRow.renewal_charge_never_reached_stripe_belled_at).toBeInstanceOf(Date);
        expect(staleRow.renewal_charge_failure_kind).toBeNull();
        const freshRow = await rowOf(fresh.successor.id);
        expect(freshRow).toMatchObject({ renewal_charge_claim_retired_at: null, renewal_charge_never_reached_stripe_belled_at: null, renewal_charge_failure_kind: 'outcome_pending' });

        // The original worker reaches the gate afterwards: refused.
        await expect(Charge._private.chargeRefusalUnderGate(stale.successor, db)).resolves.toMatchObject({ reason: 'charge_claim_retired', superseded: true });
        // The live claim's worker is unaffected.
        await expect(Charge._private.chargeRefusalUnderGate(fresh.successor, db)).resolves.toBeNull();

        // A second sweep never recovers it again (no second pay link).
        await Charge._private.reconcileStuckSuccessors({ conn: db, limit: 50, counts: { ...counts } });
        expect(mockSendViaSMSAndEmail).toHaveBeenCalledTimes(1);
      });

      test('a claim that reached Stripe while 7b waited for the gate is never retired or recovered', async () => {
        const stale = await claimed(2 * 3600000);
        Renewals.withParentDecisionLock = async (_termId, fn) => {
          await db('stripe_invoice_charge_attempts').insert({ invoice_id: stale.invoice.id, status: 'claimed', submitted_at: new Date() });
          return fn();
        };
        await Charge._private.reconcileStuckSuccessors({ conn: db, limit: 50, counts: { reconcileNeverAttemptedScanned: 0, reconcileSkipped: 0, charged: 0, failed: 0, reconcileNeverReachedStripeScanned: 0, reconcileNeverReachedStripeBelled: 0 } });
        expect(mockSendViaSMSAndEmail).not.toHaveBeenCalled();
        expect(mockNotifyAdmin).not.toHaveBeenCalled();
        expect(await rowOf(stale.successor.id)).toMatchObject({ renewal_charge_claim_retired_at: null, renewal_charge_failure_kind: 'outcome_pending' });
      });
    });

    // Codex #4971 pre-push P1: a parent demoted to payment_pending by a
    // dispute on its own invoice is transient — the grace lapse rotates it
    // (never manual_review), and the recovery leg keeps selecting it until
    // the dispute resolves; a durable decision elsewhere is manual_review.
    test('a dispute-suspended parent keeps the lapse retryable; a durable decision elsewhere is manual review', async () => {
      const make = async (parentFields) => {
        const parent = await insertParent(parentFields);
        const invoice = await insertInvoice({ status: 'sent', sms_sent_at: new Date() });
        return insertSuccessor(parent, invoice);
      };
      const suspended = await make({ status: 'payment_pending' });
      const decided = await make({ status: 'renewed', renewal_decision: 'switch_plan' });

      await Charge._private.processGraceLapses({ conn: db, limit: 50, counts: { graceScanned: 0, graceLapsed: 0, graceReconciliationDeferred: 0, graceRetiredSettled: 0 } });

      const suspendedRow = await db('annual_prepay_terms').where({ id: suspended.id }).first();
      expect(suspendedRow.renewal_lapse_started_at).toBeInstanceOf(Date);
      expect(suspendedRow.renewal_lapse_outcome).toBeNull();
      expect(suspendedRow.renewal_sweep_deferred_at).toBeInstanceOf(Date);
      expect((await db('annual_prepay_terms').where({ id: decided.id }).first()).renewal_lapse_outcome).toBe('manual_review');
      expect(mockNotifyAdmin.mock.calls.map(([, , , opts]) => opts.dedupeKey)).toEqual([
        `termite-renewal-charge:${decided.id}:lapse_parent_decided_elsewhere`,
      ]);

      // The recovery leg keeps retrying the suspended one (never the held one).
      const counts = { lapseEffectsScanned: 0, lapseEffectsReconciled: 0 };
      await Charge._private.reconcileMissedLapseEffects({ conn: db, limit: 50, counts });
      expect(counts.lapseEffectsScanned).toBe(1);
      expect((await db('annual_prepay_terms').where({ id: suspended.id }).first()).renewal_lapse_outcome).toBeNull();
    });

    test('pre-push P1: a scheduled or stale-sending renewal invoice with no delivery stamp is never "presented" — no lapse, no retrieval', async () => {
      const Renewals2 = require('../services/annual-prepay-renewals');
      const originalLock = Renewals2.withParentDecisionLock;
      Renewals2.withParentDecisionLock = (_termId, fn) => fn();
      try {
        const make = async (invoiceFields) => {
          const parent = await insertParent();
          const invoice = await insertInvoice(invoiceFields);
          return insertSuccessor(parent, invoice);
        };
        const scheduled = await make({ status: 'scheduled' });
        const sending = await make({ status: 'sending' });
        const stamped = await make({ status: 'sent', sms_sent_at: new Date() });

        const counts = freshCounts();
        await Charge._private.processGraceLapses({ conn: db, limit: 50, counts });

        const started = await db('annual_prepay_terms').whereNotNull('renewal_lapse_started_at').pluck('id');
        expect(started).toEqual([stamped.id]);
        expect(started).not.toContain(scheduled.id);
        expect(started).not.toContain(sending.id);
      } finally {
        Renewals2.withParentDecisionLock = originalLock;
      }
    });

    test('renewalWasPresented (the retire guard) reads the SAME presentation evidence as the lapse scan', async () => {
      const bare = await claimedDraftSuccessor({ status: 'failed' });
      // Codex #4971 r21 P1: submitted_at alone (committed before the Stripe
      // call) is not presentation — only a PaymentIntent id proves Stripe
      // processed the request.
      const submitted = await claimedDraftSuccessor({ status: 'failed', submitted_at: new Date() });
      const withIntent = await claimedDraftSuccessor({ status: 'failed', submitted_at: new Date(), stripe_payment_intent_id: 'pi_seen' });
      expect(await Charge._private.renewalWasPresented(db, bare)).toBe(false);
      expect(await Charge._private.renewalWasPresented(db, submitted)).toBe(false);
      expect(await Charge._private.renewalWasPresented(db, withIntent)).toBe(true);
    });
  });

  // Codex #4971 r4 P1 (write-ahead outcome): the fence claim persists
  // renewal_charge_failure_kind = 'outcome_pending' before Stripe. A process
  // that dies (or an outcome write that fails) after the submission leaves
  // it there; leg 7d resolves it from DURABLE evidence only — never by
  // charging again — and the grace lapse never counts a submitted attempt
  // whose follow-through is still owed as "presented".
  describe('r4 item 3: write-ahead charge outcome', () => {
    const HOUR = 3600000;
    // Inside its grace window (term_start 2 days ago): a pay link is still
    // the right recovery for a decline.
    async function pendingOutcome({ invoice = { status: 'draft' }, attempt, attemptedAgoMs = 2 * HOUR, fields = {} } = {}) {
      const parent = await insertParent({ term_end: daysFromToday(-3) });
      const inv = await insertInvoice(invoice);
      const successor = await insertSuccessor(parent, inv, {
        term_start: daysFromToday(-2), created_at: new Date(),
        renewal_charge_attempted_at: new Date(Date.now() - attemptedAgoMs),
        renewal_charge_failure_kind: 'outcome_pending',
        ...fields,
      });
      if (attempt) await db('stripe_invoice_charge_attempts').insert({ invoice_id: inv.id, ...attempt });
      return { successor, invoice: inv };
    }
    const kindOf = async (id) => (await db('annual_prepay_terms').where({ id }).first('renewal_charge_failure_kind', 'renewal_charge_failure_reason', 'renewal_charge_failure_handled_at', 'renewal_sweep_deferred_at'));
    const sweepCounts = () => ({ reconcilePendingOutcomeScanned: 0, reconcilePendingOutcomeResolved: 0, reconcileFollowThroughScanned: 0 });

    test('leg 7d resolves each stale pending outcome from durable evidence only — and never charges', async () => {
      const settled = await pendingOutcome({ invoice: { status: 'paid', paid_at: new Date() }, attempt: { status: 'succeeded', submitted_at: new Date() } });
      // r23 P1: stripe.js persists decline_code ONLY for a customer decline
      // — that column, not the message text, is what recovery classifies by.
      const declined = await pendingOutcome({ attempt: { status: 'failed', submitted_at: new Date(), resolved_at: new Date(), error_message: 'Your card was declined.', decline_code: 'card_declined' } });
      const refused = await pendingOutcome({ attempt: { status: 'failed', submitted_at: new Date(), resolved_at: new Date(), error_message: 'No such payment_method (resource_missing)' } });
      const unknown = await pendingOutcome({ attempt: { status: 'claimed', stripe_payment_intent_id: 'pi_lost' } });
      const clearing = await pendingOutcome({ invoice: { status: 'processing' }, attempt: { status: 'succeeded', submitted_at: new Date() } });
      const fresh = await pendingOutcome({ attempt: { status: 'claimed', submitted_at: new Date() }, attemptedAgoMs: 5 * 60000 });
      const neverReached = await pendingOutcome({ attempt: { status: 'failed' } }); // leg 7b's crash gap
      const activated = await pendingOutcome({ attempt: { status: 'succeeded', submitted_at: new Date() }, fields: { status: 'active' } });

      const counts = sweepCounts();
      await Charge._private.resolvePendingChargeOutcomes({ conn: db, limit: 50, counts });

      expect(counts.reconcilePendingOutcomeScanned).toBe(6); // not the fresh one, not 7b's
      expect((await kindOf(settled.successor.id)).renewal_charge_failure_kind).toBeNull();
      expect(await kindOf(declined.successor.id)).toMatchObject({
        renewal_charge_failure_kind: 'declined', renewal_charge_failure_reason: expect.stringContaining('Your card was declined.'), renewal_charge_failure_handled_at: null,
      });
      // A non-decline error (no decline_code) recovers as 'refused' — the
      // live path's own outcome for that shape — never a false decline.
      expect(await kindOf(refused.successor.id)).toMatchObject({
        renewal_charge_failure_kind: 'refused', renewal_charge_failure_reason: expect.stringContaining('resource_missing'), renewal_charge_failure_handled_at: null,
      });
      expect(await kindOf(unknown.successor.id)).toMatchObject({ renewal_charge_failure_kind: 'ambiguous', renewal_charge_failure_handled_at: null });
      expect(await kindOf(clearing.successor.id)).toMatchObject({ renewal_charge_failure_kind: 'outcome_pending', renewal_sweep_deferred_at: expect.any(Date) });
      expect((await kindOf(fresh.successor.id)).renewal_charge_failure_kind).toBe('outcome_pending');
      expect((await kindOf(neverReached.successor.id)).renewal_charge_failure_kind).toBe('outcome_pending');
      expect((await kindOf(activated.successor.id)).renewal_charge_failure_kind).toBeNull();
      expect(counts.reconcilePendingOutcomeResolved).toBe(5);

      // Leg 7c then follows each resolved outcome through in the same sweep:
      // the decline gets its pay link + bell; the unknown outcome a bell only.
      const Renewals2 = require('../services/annual-prepay-renewals');
      const originalLock = Renewals2.withParentDecisionLock;
      Renewals2.withParentDecisionLock = (_termId, fn) => fn();
      try {
        await Charge._private.reconcileChargeFollowThrough({ conn: db, limit: 50, counts });
      } finally {
        Renewals2.withParentDecisionLock = originalLock;
      }
      expect(counts.reconcileFollowThroughScanned).toBe(3);
      // The decline AND the refusal each get their pay link; the unknown
      // outcome gets a bell only.
      expect(mockSendViaSMSAndEmail).toHaveBeenCalledTimes(2);
      expect(mockSendViaSMSAndEmail).toHaveBeenCalledWith(declined.invoice.id, expect.objectContaining({ firstDeliveryOnly: true }));
      expect(mockSendViaSMSAndEmail).toHaveBeenCalledWith(refused.invoice.id, expect.objectContaining({ firstDeliveryOnly: true }));
      expect(mockNotifyAdmin).toHaveBeenCalledWith('billing', expect.any(String), expect.any(String), expect.objectContaining({
        dedupeKey: `termite-renewal-charge:${unknown.successor.id}:ambiguous`,
      }));
      expect((await kindOf(declined.successor.id)).renewal_charge_failure_handled_at).toBeInstanceOf(Date);
      expect((await kindOf(unknown.successor.id)).renewal_charge_failure_handled_at).toBeInstanceOf(Date);
    });

    // Codex #4971 r16 P1 (finding 2): a crash before decideAndCharge's own
    // in-memory classifyChargeError ever ran leaves ONLY the persisted
    // attempt row for leg 7d to read. A submitted 'failed' attempt whose
    // decline_code is authentication_required must recover as AMBIGUOUS
    // (the off-session PaymentIntent may still be completed and succeed
    // later) — never a durable decline, which used to send a second pay
    // link and a false "your payment didn't go through" notice beside a
    // charge that might still go through. An attempt with no decline_code
    // at all (a genuine, already-final Stripe decline, or an attempt row
    // predating this column) stays a genuine decline, unaffected.
    test('leg 7d recovers a crashed authentication_required attempt as ambiguous, never a genuine decline', async () => {
      const authRequired = await pendingOutcome({
        attempt: { status: 'failed', submitted_at: new Date(), resolved_at: new Date(), error_message: 'Your card was declined.', decline_code: 'authentication_required' },
      });
      const genuineDecline = await pendingOutcome({
        attempt: { status: 'failed', submitted_at: new Date(), resolved_at: new Date(), error_message: 'Your card was declined.', decline_code: 'card_declined' },
      });

      const counts = sweepCounts();
      await Charge._private.resolvePendingChargeOutcomes({ conn: db, limit: 50, counts });

      expect(await kindOf(authRequired.successor.id)).toMatchObject({
        renewal_charge_failure_kind: 'ambiguous', renewal_charge_failure_handled_at: null,
      });
      expect(await kindOf(genuineDecline.successor.id)).toMatchObject({
        renewal_charge_failure_kind: 'declined', renewal_charge_failure_handled_at: null,
      });
    });

    test('the grace lapse never counts a submitted attempt whose follow-through is still owed as "presented" (SQL and JS twins agree)', async () => {
      const Renewals2 = require('../services/annual-prepay-renewals');
      const originalLock = Renewals2.withParentDecisionLock;
      Renewals2.withParentDecisionLock = (_termId, fn) => fn();
      try {
        // Past the grace deadline (term_start 34 days ago), undelivered draft,
        // attempt genuinely processed by Stripe (r21: a PaymentIntent id, not
        // the pre-call submission marker alone, is what presentation reads).
        const make = async (fields) => {
          const parent = await insertParent();
          const invoice = await insertInvoice({ status: 'draft' });
          const successor = await insertSuccessor(parent, invoice, { renewal_charge_attempted_at: new Date(Date.now() - 86400000), ...fields });
          await db('stripe_invoice_charge_attempts').insert({ invoice_id: invoice.id, status: 'failed', submitted_at: new Date(), stripe_payment_intent_id: `pi_${invoice.id}` });
          return successor;
        };
        const pending = await make({ renewal_charge_failure_kind: 'outcome_pending' });
        const owedDecline = await make({ renewal_charge_failure_kind: 'declined' });
        const handled = await make({ renewal_charge_failure_kind: 'ambiguous', renewal_charge_failure_handled_at: new Date() });
        const cleared = await make({});

        for (const [row, presented] of [[pending, false], [owedDecline, false], [handled, true], [cleared, true]]) {
          expect(await Charge._private.renewalWasPresented(db, row)).toBe(presented);
        }
        await Charge._private.processGraceLapses({ conn: db, limit: 50, counts: { graceScanned: 0, graceLapsed: 0, graceReconciliationDeferred: 0, graceRetiredSettled: 0 } });
        const started = await db('annual_prepay_terms').whereNotNull('renewal_lapse_started_at').pluck('id');
        expect(started.sort()).toEqual([handled.id, cleared.id].sort());
      } finally {
        Renewals2.withParentDecisionLock = originalLock;
      }
    });
  });

  // Codex #4971 r4 P1 (item 4b backstop, leg 7e): an ACTIVE, settled
  // renewal behind a parent that no longer authorizes it gets its one
  // late-paid alert even when the paid sync's own alert was lost — then is
  // excluded; a parent that still authorizes it is left alone.
  describe('r4 item 4b: leg 7e late-paid renewal alert', () => {
    test('rings once for a renewal paid behind a cancelled or refunded parent, never for a renewed one, and excludes it once the alert persisted', async () => {
      // The parent changed a minute before the renewal was paid.
      const paidRenewal = async (parentFields) => {
        const parent = await insertParent({ updated_at: new Date(Date.now() - 60000), ...parentFields });
        const invoice = await insertInvoice({ status: 'paid', paid_at: new Date() });
        return insertSuccessor(parent, invoice, { status: 'active', term_start: daysFromToday(-34) });
      };
      const behindCancelled = await paidRenewal({ status: 'cancelled', renewal_decision: 'cancel' });
      const refundedInvoice = await insertInvoice({ status: 'paid', paid_at: new Date(), stripe_payment_intent_id: 'pi_parent_refunded' });
      // The refund writer stamps the ledger row's updated_at (the refund time).
      await db('payments').insert({ status: 'refunded', refund_status: 'full', stripe_payment_intent_id: 'pi_parent_refunded', updated_at: new Date(Date.now() - 60000) });
      const behindRefunded = await paidRenewal({ status: 'active', prepay_invoice_id: refundedInvoice.id });
      const behindRenewed = await paidRenewal({ status: 'renewed', renewal_decision: 'renew' });

      const counts = { latePaidScanned: 0, latePaidBelled: 0 };
      await Charge._private.bellLatePaidRenewals({ conn: db, limit: 50, counts });

      expect(counts.latePaidScanned).toBe(2); // the renewed parent never qualifies
      expect(counts.latePaidBelled).toBe(2);
      const keys = mockNotifyAdmin.mock.calls.map(([, , , opts]) => opts.dedupeKey).sort();
      expect(keys).toEqual([
        `termite-renewal-charge:${behindCancelled.id}:paid_after_parent_ended`,
        `termite-renewal-charge:${behindRefunded.id}:paid_after_parent_ended`,
      ].sort());
      const stamped = await db('annual_prepay_terms').whereNotNull('renewal_late_paid_belled_at').pluck('id');
      expect(stamped.sort()).toEqual([behindCancelled.id, behindRefunded.id].sort());
      expect(stamped).not.toContain(behindRenewed.id);
      expect(await db('annual_prepay_terms').whereIn('id', [behindCancelled.id, behindRefunded.id]).pluck('status')).toEqual(['active', 'active']);

      const again = { latePaidScanned: 0, latePaidBelled: 0 };
      await Charge._private.bellLatePaidRenewals({ conn: db, limit: 50, counts: again });
      expect(again.latePaidScanned).toBe(0);
      expect(mockNotifyAdmin).toHaveBeenCalledTimes(2);
    });

    // Codex #4971 r5 P2: a renewal paid in October whose prior year is later
    // refunded (durable) or disputed (move 10 demotion, transient) the next
    // March was a LEGITIMATE payment — never a "paid after the prior plan
    // ended" alert, and never selected (so it cannot pin the page), while a
    // renewal genuinely paid after the parent was cancelled still rings.
    test('an October-paid renewal whose parent is refunded or disputed in March never rings; one paid after the cancel does', async () => {
      const DAY = 86400000;
      const renewalPaid = async (parentFields, paidDaysAgo, changedDaysAgo) => {
        const parent = await insertParent({ ...parentFields, updated_at: new Date(Date.now() - changedDaysAgo * DAY) });
        const invoice = await insertInvoice({ status: 'paid', paid_at: new Date(Date.now() - paidDaysAgo * DAY) });
        return insertSuccessor(parent, invoice, { status: 'active' });
      };
      const refundedInMarch = await renewalPaid({ status: 'cancelled' }, 150, 10);
      const disputedInMarch = await renewalPaid({ status: 'payment_pending' }, 150, 10);
      const decidedBeforePaying = await renewalPaid({ status: 'cancelled', renewal_decision: 'cancel', renewal_decision_at: new Date(Date.now() - 20 * DAY) }, 5, 1);

      const counts = { latePaidScanned: 0, latePaidBelled: 0 };
      await Charge._private.bellLatePaidRenewals({ conn: db, limit: 50, counts });

      expect(counts.latePaidScanned).toBe(1);
      expect(mockNotifyAdmin.mock.calls.map(([, , , opts]) => opts.dedupeKey)).toEqual([
        `termite-renewal-charge:${decidedBeforePaying.id}:paid_after_parent_ended`,
      ]);
      // The per-row check agrees even when handed the old rows directly.
      for (const row of [refundedInMarch, disputedInMarch]) {
        const fresh = await db('annual_prepay_terms').where({ id: row.id }).first();
        expect(await Charge._private.bellLatePaidRenewal(fresh, db)).toBe('not_owed');
      }
      expect(mockNotifyAdmin).toHaveBeenCalledTimes(1);
      expect(await db('annual_prepay_terms').whereNotNull('renewal_late_paid_belled_at').pluck('id')).toEqual([decidedBeforePaying.id]);
    });
  });

  // Codex #4971 r6 P1 — a parent refund commits its ledger stamp before its
  // separate term-cancel sync. A successor whose ACH settles in that gap must
  // NOT stamp the still-active parent 'renewed' (the automatic renew stamp
  // re-checks the parent's own invoice on the ledger, under the gate), and
  // the late-paid alert dates the parent's change by the EARLIEST evidence —
  // here the ledger's refund stamp — so it still rings once.
  describe('r6: a successor that settles between the parent refund and its cancel sync', () => {
    const MIN = 60000;
    async function refundRace() {
      const parentInvoice = await insertInvoice({ status: 'paid', paid_at: new Date(Date.now() - 400 * 86400000), stripe_payment_intent_id: `pi_parent_${randomUUID().slice(0, 8)}` });
      const parent = await insertParent({ prepay_invoice_id: parentInvoice.id, updated_at: new Date(Date.now() - 30 * 86400000) });
      // t1: the refund's ledger stamp (the webhook / admin refund writer).
      await db('payments').insert({ status: 'refunded', refund_status: 'full', stripe_payment_intent_id: parentInvoice.stripe_payment_intent_id, updated_at: new Date(Date.now() - 10 * MIN) });
      // t2: the successor's ACH settles.
      const renewalInvoice = await insertInvoice({ status: 'paid', paid_at: new Date(Date.now() - 5 * MIN) });
      const successor = await insertSuccessor(parent, renewalInvoice, { status: 'active' });
      return { parent, parentInvoice, successor };
    }
    const parentRow = (id) => db('annual_prepay_terms').where({ id }).first('status', 'renewal_decision');

    test('the paid sync never stamps the refunded parent renewed; the backstop skips it too', async () => {
      const { parent, successor } = await refundRace();
      await Renewals._private.stampParentRenewedForSuccessor(successor, 'test', db);
      expect(await parentRow(parent.id)).toEqual({ status: 'active', renewal_decision: null });
      await expect(Renewals.reconcileParentRenewedStamps({ conn: db })).resolves.toEqual({ scanned: 0, stamped: 0 });
      expect(await parentRow(parent.id)).toEqual({ status: 'active', renewal_decision: null });
    });

    test('leg 7e rings the refund-or-honor alert once, even after the cancel sync moved the parent AFTER the payment', async () => {
      const { parent, successor } = await refundRace();
      // t3: the parent's cancel sync runs after the successor paid.
      await db('annual_prepay_terms').where({ id: parent.id }).update({ status: 'cancelled', updated_at: new Date() });

      const counts = { latePaidScanned: 0, latePaidBelled: 0 };
      await Charge._private.bellLatePaidRenewals({ conn: db, limit: 50, counts });
      await Charge._private.bellLatePaidRenewals({ conn: db, limit: 50, counts: { latePaidScanned: 0, latePaidBelled: 0 } });

      expect(counts).toEqual({ latePaidScanned: 1, latePaidBelled: 1 });
      expect(mockNotifyAdmin).toHaveBeenCalledTimes(1);
      expect(mockNotifyAdmin).toHaveBeenCalledWith('billing', expect.any(String), expect.stringContaining('refund it or honor it'), expect.objectContaining({
        dedupeKey: `termite-renewal-charge:${successor.id}:paid_after_parent_ended`,
      }));
    });

    test('the late-paid alert is decided under the gate: a parent restored while it waited is never belled', async () => {
      const { parent, parentInvoice, successor } = await refundRace();
      await db('annual_prepay_terms').where({ id: parent.id }).update({ status: 'cancelled', updated_at: new Date() });
      Renewals.withParentDecisionLock = async (_termId, fn) => {
        // The refund bounced and the prior year was reinstated before the gate.
        await db('payments').where({ stripe_payment_intent_id: parentInvoice.stripe_payment_intent_id }).update({ status: 'paid', refund_status: null });
        await db('annual_prepay_terms').where({ id: parent.id }).update({ status: 'active' });
        return fn();
      };
      const fresh = await db('annual_prepay_terms').where({ id: successor.id }).first();
      await expect(Charge._private.bellLatePaidRenewal(fresh, db)).resolves.toBe('not_owed');
      expect(mockNotifyAdmin).not.toHaveBeenCalled();
      expect((await db('annual_prepay_terms').where({ id: successor.id }).first()).renewal_late_paid_belled_at).toBeNull();
    });

    // Codex #4971 r6 P2: a still-active parent's old updated_at (an unrelated
    // edit) is not evidence of the change. The renewal was paid, THEN the
    // parent's invoice was refunded on the ledger (its term sync never ran) —
    // the payment preceded the refund, so no late-paid alert.
    test('an active parent with an old updated_at, refunded on the ledger AFTER the renewal was paid: no alert', async () => {
      const DAY = 86400000;
      const parentInvoice = await insertInvoice({ status: 'paid', paid_at: new Date(Date.now() - 400 * DAY), stripe_payment_intent_id: `pi_parent_${randomUUID().slice(0, 8)}` });
      const parent = await insertParent({ prepay_invoice_id: parentInvoice.id, updated_at: new Date(Date.now() - 300 * DAY) });
      const successor = await insertSuccessor(parent, await insertInvoice({ status: 'paid', paid_at: new Date(Date.now() - 60 * DAY) }), { status: 'active' });
      await db('payments').insert({ status: 'refunded', refund_status: 'full', stripe_payment_intent_id: parentInvoice.stripe_payment_intent_id, updated_at: new Date(Date.now() - 10 * DAY) });

      const counts = { latePaidScanned: 0, latePaidBelled: 0 };
      await Charge._private.bellLatePaidRenewals({ conn: db, limit: 50, counts });
      expect(counts.latePaidScanned).toBe(0);
      expect(await Charge._private.bellLatePaidRenewal(await db('annual_prepay_terms').where({ id: successor.id }).first(), db)).toBe('not_owed');
      expect(mockNotifyAdmin).not.toHaveBeenCalled();
    });

    // Codex #4971 r8 P1: a parent already stamped renewed/renew is not
    // authority on its own — its invoice must still be settled. Revoked
    // (fully refunded) BEFORE the successor paid → the backstop rings; the
    // inline hook (onRenewalSuccessorPaid) is simply never run here, the
    // shape it leaves when it fails.
    const DAY = 86400000;
    async function renewedParent({ decidedDaysAgo, refundedAt }) {
      const parentInvoice = await insertInvoice({ status: 'paid', paid_at: new Date(Date.now() - 400 * DAY), stripe_payment_intent_id: `pi_parent_${randomUUID().slice(0, 8)}` });
      const parent = await insertParent({
        prepay_invoice_id: parentInvoice.id, status: 'renewed', renewal_decision: 'renew',
        renewal_decision_at: new Date(Date.now() - decidedDaysAgo * DAY), updated_at: new Date(Date.now() - decidedDaysAgo * DAY),
      });
      await db('payments').insert({ status: 'refunded', refund_status: 'full', stripe_payment_intent_id: parentInvoice.stripe_payment_intent_id, updated_at: refundedAt });
      return parent;
    }

    test('a RENEWED parent whose invoice was fully refunded, then the successor paid: leg 7e rings once', async () => {
      const parent = await renewedParent({ decidedDaysAgo: 30, refundedAt: new Date(Date.now() - 10 * MIN) });
      const successor = await insertSuccessor(parent, await insertInvoice({ status: 'paid', paid_at: new Date(Date.now() - 5 * MIN) }), { status: 'active' });

      const counts = { latePaidScanned: 0, latePaidBelled: 0 };
      await Charge._private.bellLatePaidRenewals({ conn: db, limit: 50, counts });
      await Charge._private.bellLatePaidRenewals({ conn: db, limit: 50, counts: { latePaidScanned: 0, latePaidBelled: 0 } });

      expect(counts).toEqual({ latePaidScanned: 1, latePaidBelled: 1 });
      expect(mockNotifyAdmin).toHaveBeenCalledTimes(1);
      expect(mockNotifyAdmin).toHaveBeenCalledWith('billing', expect.any(String), expect.stringContaining('refund it or honor it'), expect.objectContaining({
        dedupeKey: `termite-renewal-charge:${successor.id}:paid_after_parent_ended`,
      }));
      expect(await parentRow(parent.id)).toEqual({ status: 'renewed', renewal_decision: 'renew' });
    });

    test.each([
      // Stamped renewed by the October payment, refunded in March.
      ['stamped by the payment', 149, 150],
      // A staff renew recorded BEFORE the October payment: the renew
      // decision dates no change, so it never makes that payment "late".
      ['a staff renew recorded before the payment', 160, 150],
    ])('a RENEWED parent (%s) refunded months AFTER the renewal was paid stays silent', async (_label, decidedDaysAgo, paidDaysAgo) => {
      const parent = await renewedParent({ decidedDaysAgo, refundedAt: new Date(Date.now() - 10 * DAY) });
      const successor = await insertSuccessor(parent, await insertInvoice({ status: 'paid', paid_at: new Date(Date.now() - paidDaysAgo * DAY) }), { status: 'active' });

      const counts = { latePaidScanned: 0, latePaidBelled: 0 };
      await Charge._private.bellLatePaidRenewals({ conn: db, limit: 50, counts });
      expect(counts.latePaidScanned).toBe(0);
      expect(await Charge._private.bellLatePaidRenewal(await db('annual_prepay_terms').where({ id: successor.id }).first(), db)).toBe('not_owed');
      expect(mockNotifyAdmin).not.toHaveBeenCalled();
    });

    test('a RENEWED parent whose invoice is still settled is never a candidate', async () => {
      const parentInvoice = await insertInvoice({ status: 'paid', paid_at: new Date(Date.now() - 400 * DAY) });
      const parent = await insertParent({ prepay_invoice_id: parentInvoice.id, status: 'renewed', renewal_decision: 'renew', renewal_decision_at: new Date(Date.now() - 30 * DAY) });
      await insertSuccessor(parent, await insertInvoice({ status: 'paid', paid_at: new Date(Date.now() - 5 * MIN) }), { status: 'active' });
      const counts = { latePaidScanned: 0, latePaidBelled: 0 };
      await Charge._private.bellLatePaidRenewals({ conn: db, limit: 50, counts });
      expect(counts.latePaidScanned).toBe(0);
      expect(mockNotifyAdmin).not.toHaveBeenCalled();
    });

    test('a normal renewal (no refund) still stamps the parent renewed', async () => {
      const parentInvoice = await insertInvoice({ status: 'paid', paid_at: new Date(Date.now() - 400 * 86400000) });
      const parent = await insertParent({ prepay_invoice_id: parentInvoice.id });
      const successor = await insertSuccessor(parent, await insertInvoice({ status: 'paid', paid_at: new Date() }), { status: 'active' });
      await Renewals._private.stampParentRenewedForSuccessor(successor, 'test', db);
      expect(await parentRow(parent.id)).toEqual({ status: 'renewed', renewal_decision: 'renew' });
    });

    test('a refund stamped AFTER the renewal was paid (October paid, March refunded) stays silent', async () => {
      const parentInvoice = await insertInvoice({ status: 'refunded', paid_at: new Date(Date.now() - 500 * 86400000), stripe_payment_intent_id: `pi_parent_${randomUUID().slice(0, 8)}` });
      const parent = await insertParent({ status: 'cancelled', prepay_invoice_id: parentInvoice.id, updated_at: new Date(Date.now() - 10 * 86400000) });
      await db('payments').insert({ status: 'refunded', refund_status: 'full', stripe_payment_intent_id: parentInvoice.stripe_payment_intent_id, updated_at: new Date(Date.now() - 10 * 86400000) });
      const successor = await insertSuccessor(parent, await insertInvoice({ status: 'paid', paid_at: new Date(Date.now() - 150 * 86400000) }), { status: 'active' });

      const counts = { latePaidScanned: 0, latePaidBelled: 0 };
      await Charge._private.bellLatePaidRenewals({ conn: db, limit: 50, counts });
      expect(counts.latePaidScanned).toBe(0);
      const fresh = await db('annual_prepay_terms').where({ id: successor.id }).first();
      expect(await Charge._private.bellLatePaidRenewal(fresh, db)).toBe('not_owed');
      expect(mockNotifyAdmin).not.toHaveBeenCalled();
    });
  });

  // Codex #4971 pre-push P1: the automatic renew stamp re-reads the SUCCESSOR
  // under the gate (both keys), not only the parent. The race is real here:
  // another transaction holds the successor's gate key while the stamp —
  // having already scanned / been handed the successor as active and paid —
  // blocks on it; that transaction then revokes the successor's payment and
  // commits, and the stamp must see the revocation.
  describe('pre-push P1: the successor\'s payment is re-read under the renewal gate', () => {
    async function paidRenewal() {
      const parentInvoice = await insertInvoice({ status: 'paid', paid_at: new Date(Date.now() - 400 * 86400000) });
      const parent = await insertParent({ prepay_invoice_id: parentInvoice.id });
      const renewalInvoice = await insertInvoice({ status: 'paid', paid_at: new Date(), stripe_payment_intent_id: `pi_succ_${randomUUID().slice(0, 8)}` });
      const successor = await insertSuccessor(parent, renewalInvoice, { status: 'active' });
      return { parent, successor, renewalInvoice };
    }
    const parentRow = (id) => db('annual_prepay_terms').where({ id }).first('status', 'renewal_decision');

    // A waiter on THIS successor's gate key only (the two-key advisory lock
    // acquireParentDecisionXactLock takes: hashtext(namespace),
    // hashtext(term id)) — another session's unrelated advisory waiter on
    // the shared test database must never read as the stamp waiting.
    async function waitForAdvisoryWaiter(termId) {
      const oid = (text) => `((hashtext(${text})::bigint + 4294967296) % 4294967296)`;
      for (let i = 0; i < 200; i += 1) {
        const { rows } = await db.raw(
          `SELECT count(*)::int AS n FROM pg_locks WHERE locktype = 'advisory' AND NOT granted AND objsubid = 2
             AND classid::bigint = ${oid('?')} AND objid::bigint = ${oid('?::text')}`,
          ['annual-prepay-parent-decision', String(termId)],
        );
        if (rows[0].n > 0) return;
        await new Promise((r) => setTimeout(r, 25));
      }
      throw new Error('the stamp never waited on the successor gate key');
    }

    // Holds the successor's gate key, lets `action` run up to the gate, then
    // applies `mutate` and commits — the between-scan-and-gate window.
    async function raceAtTheGate(successorId, mutate, action) {
      let held;
      let release;
      const heldP = new Promise((r) => { held = r; });
      const releaseP = new Promise((r) => { release = r; });
      const holder = db.transaction(async (trx) => {
        await Renewals.acquireTermiteGateAtEntry(trx, { termIds: [successorId] });
        held();
        await releaseP;
        await mutate(trx);
      });
      await heldP;
      const run = action();
      await waitForAdvisoryWaiter(successorId);
      release();
      await holder;
      return run;
    }

    const refundOnLedger = (renewalInvoice) => (trx) => trx('payments').insert({
      status: 'refunded', refund_status: 'full', stripe_payment_intent_id: renewalInvoice.stripe_payment_intent_id, updated_at: new Date(),
    });
    // The dispute webhook's demotion shape (suspendActiveTermsForDisputedInvoice).
    const disputeSuspend = (successor) => (trx) => trx('annual_prepay_terms').where({ id: successor.id })
      .update({ status: 'payment_pending', dispute_suspended_at: new Date(), updated_at: new Date() });

    test('backstop: a successor refunded in full on the ledger between the scan and the gate → no renew stamp', async () => {
      const { parent, successor, renewalInvoice } = await paidRenewal();
      const summary = await raceAtTheGate(successor.id, refundOnLedger(renewalInvoice), () => Renewals.reconcileParentRenewedStamps({ conn: db }));
      expect(summary).toEqual({ scanned: 1, stamped: 0 }); // the scan saw it paid; the gate re-read refused
      expect(await parentRow(parent.id)).toEqual({ status: 'active', renewal_decision: null });
    });

    test('backstop: a successor dispute-suspended between the scan and the gate → no renew stamp', async () => {
      const { parent, successor } = await paidRenewal();
      const summary = await raceAtTheGate(successor.id, disputeSuspend(successor), () => Renewals.reconcileParentRenewedStamps({ conn: db }));
      expect(summary).toEqual({ scanned: 1, stamped: 0 });
      expect(await parentRow(parent.id)).toEqual({ status: 'active', renewal_decision: null });
    });

    test('paid sync: the successor row the caller read is refunded / dispute-suspended before the gate → no renew stamp', async () => {
      const refunded = await paidRenewal();
      await raceAtTheGate(refunded.successor.id, refundOnLedger(refunded.renewalInvoice),
        () => Renewals._private.stampParentRenewedForSuccessor(refunded.successor, 'test', db));
      expect(await parentRow(refunded.parent.id)).toEqual({ status: 'active', renewal_decision: null });

      const disputed = await paidRenewal();
      await raceAtTheGate(disputed.successor.id, disputeSuspend(disputed.successor),
        () => Renewals._private.stampParentRenewedForSuccessor(disputed.successor, 'test', db));
      expect(await parentRow(disputed.parent.id)).toEqual({ status: 'active', renewal_decision: null });
    });

    test('a normal paid successor still stamps the parent renewed, on both paths', async () => {
      const viaSync = await paidRenewal();
      await raceAtTheGate(viaSync.successor.id, async () => {}, () => Renewals._private.stampParentRenewedForSuccessor(viaSync.successor, 'test', db));
      expect(await parentRow(viaSync.parent.id)).toEqual({ status: 'renewed', renewal_decision: 'renew' });

      const viaBackstop = await paidRenewal();
      const summary = await raceAtTheGate(viaBackstop.successor.id, async () => {}, () => Renewals.reconcileParentRenewedStamps({ conn: db }));
      expect(summary).toEqual({ scanned: 1, stamped: 1 });
      expect(await parentRow(viaBackstop.parent.id)).toEqual({ status: 'renewed', renewal_decision: 'renew' });
    });

    test('a re-paid successor still carrying the dispute marker (recovery not yet finished) stamps as before', async () => {
      const { parent, successor } = await paidRenewal();
      await db('annual_prepay_terms').where({ id: successor.id }).update({ dispute_suspended_at: new Date(Date.now() - 86400000) });
      await Renewals._private.stampParentRenewedForSuccessor(successor, 'test', db);
      expect(await parentRow(parent.id)).toEqual({ status: 'renewed', renewal_decision: 'renew' });
    });
  });

  // Codex #4971 pre-push P1: a renewal successor paid and then disputed back
  // to payment_pending (the marker set, its invoice reopened overdue) reads
  // like an overdue, presented renewal. The grace lapse must never void that
  // disputed invoice or order station retrieval: the locked re-check defers
  // it (rotated, no bell, no manual review), the recovery scan skips it, and
  // once the dispute resolves the lapse proceeds as before.
  describe('pre-push P1: a dispute-suspended successor is never lapsed', () => {
    let Renewals4;
    let originalLock;
    beforeEach(() => {
      Renewals4 = require('../services/annual-prepay-renewals');
      originalLock = Renewals4.withParentDecisionLock;
      Renewals4.withParentDecisionLock = (_termId, fn) => fn();
      jest.spyOn(Renewals4, 'otherLiveTermiteCoverage').mockResolvedValue(null);
      require('../services/stripe').assertNoInvoiceChargeReconciliationPending.mockImplementation(async () => undefined);
      mockVoidInvoice.mockImplementation(async (invoiceId) => {
        await db('invoices').where({ id: invoiceId }).update({ status: 'void' });
        await db('annual_prepay_terms').where({ prepay_invoice_id: invoiceId }).update({ status: 'cancelled' });
        return {};
      });
    });
    afterEach(() => {
      Renewals4.withParentDecisionLock = originalLock;
      jest.restoreAllMocks(); // the spies (otherLiveTermiteCoverage, recordDecision)
      require('../services/stripe').assertNoInvoiceChargeReconciliationPending.mockImplementation(async () => { throw new Error('reconciliation pending (test)'); });
      mockVoidInvoice.mockReset();
    });

    // An overdue, presented renewal past its grace window.
    async function overdueRenewal() {
      const parent = await insertParent();
      const invoice = await insertInvoice({ status: 'overdue', sms_sent_at: new Date(Date.now() - 20 * 86400000) });
      const successor = await insertSuccessor(parent, invoice);
      return { parent, invoice, successor };
    }
    const graceCounts = () => ({ graceScanned: 0, graceLapsed: 0, graceReconciliationDeferred: 0, graceRetiredSettled: 0 });
    const lapseCounts = () => ({ lapseEffectsScanned: 0, lapseEffectsReconciled: 0, graceReconciliationDeferred: 0, graceRetiredSettled: 0 });
    const row = (id) => db('annual_prepay_terms').where({ id }).first();
    const expectUntouched = async ({ parent, invoice, successor }) => {
      expect(mockVoidInvoice).not.toHaveBeenCalled();
      expect(mockRaiseRetrieval).not.toHaveBeenCalled();
      expect(mockNotifyAdmin).not.toHaveBeenCalled();
      expect((await db('invoices').where({ id: invoice.id }).first()).status).toBe('overdue');
      const s = await row(successor.id);
      expect(s).toMatchObject({ status: 'payment_pending', renewal_lapse_outcome: null, renewal_lapse_completed_at: null });
      expect(await row(parent.id)).toMatchObject({ status: 'active', renewal_decision: null });
      return s;
    };

    test('disputed between the lapse scan and the gate: no void, no retrieval, no bell — rotated', async () => {
      const fx = await overdueRenewal();
      Renewals4.withParentDecisionLock = async (_termId, fn) => {
        // The payment landed and was disputed while the lapse waited for the gate.
        await db('annual_prepay_terms').where({ id: fx.successor.id }).update({ dispute_suspended_at: new Date() });
        return fn();
      };

      const counts = graceCounts();
      await Charge._private.processGraceLapses({ conn: db, limit: 50, counts });

      expect(counts.graceScanned).toBe(1);
      expect(counts.graceLapsed).toBe(0);
      const s = await expectUntouched(fx);
      expect(s.renewal_sweep_deferred_at).toBeInstanceOf(Date);
    });

    test('a resumed lapse whose successor was disputed: the recovery scan skips it, the locked re-check defers it; once the dispute resolves it lapses', async () => {
      const fx = await overdueRenewal();
      // A lapse started on an earlier tick (deferred), then the renewal was
      // paid and disputed back to payment_pending.
      await db('annual_prepay_terms').where({ id: fx.successor.id })
        .update({ renewal_lapse_started_at: new Date(Date.now() - 86400000), dispute_suspended_at: new Date() });

      const counts = lapseCounts();
      await Charge._private.reconcileMissedLapseEffects({ conn: db, limit: 50, counts });
      expect(counts.lapseEffectsScanned).toBe(0);
      // Called directly (a row selected before the dispute landed): deferred.
      await expect(Charge._private.processGraceLapseForTerm(await row(fx.successor.id), db)).resolves.toBe('deferred');
      await expectUntouched(fx);

      // The dispute resolves: the marker clears, the invoice is as it was
      // (still unpaid, overdue) — the lapse now proceeds.
      await db('annual_prepay_terms').where({ id: fx.successor.id }).update({ dispute_suspended_at: null });
      // recordDecision's full writer reads the module-level db this suite
      // mocks; its own suites cover it — the parent's 'cancel' is recorded
      // with the same guarded write here.
      const decide = jest.spyOn(Renewals4, 'recordDecision').mockImplementation(async ({ termId, action }) => {
        const [decided] = await db('annual_prepay_terms').where({ id: termId }).whereNull('renewal_decision')
          .update({ renewal_decision: action, renewal_decision_at: new Date() }).returning('*');
        return decided || null;
      });
      const after = lapseCounts();
      await Charge._private.reconcileMissedLapseEffects({ conn: db, limit: 50, counts: after });

      expect(after.lapseEffectsScanned).toBe(1);
      expect(after.lapseEffectsReconciled).toBe(1);
      expect(mockVoidInvoice).toHaveBeenCalledWith(fx.invoice.id, { requireUnsettled: true });
      expect(mockRaiseRetrieval).toHaveBeenCalledTimes(1);
      expect(await row(fx.successor.id)).toMatchObject({ status: 'cancelled', renewal_lapse_outcome: 'lapsed' });
      expect(await row(fx.parent.id)).toMatchObject({ renewal_decision: 'cancel' });
      expect(decide).toHaveBeenCalledWith(expect.objectContaining({ termId: fx.parent.id, action: 'cancel' }));
    });

    // Codex #4971 r13 P1: a cancelled parent is this lapse's own earlier
    // write only with its provenance (renewal_lapse_parent_cancelled_at on
    // the successor, stamped with that cancel). An admin cancel between the
    // scan and the gate is outside the lapse: withdrawn, never lapsed.
    test('an admin cancel between the lapse scan and the gate: the renewal is withdrawn (voided, cancelled, one bell) — no retrieval, no parent decision', async () => {
      const fx = await overdueRenewal();
      Renewals4.withParentDecisionLock = async (_termId, fn) => {
        await db('annual_prepay_terms').where({ id: fx.parent.id })
          .update({ status: 'cancelled', renewal_decision: 'cancel', renewal_decision_at: new Date() });
        return fn();
      };
      const decide = jest.spyOn(Renewals4, 'recordDecision');

      const counts = graceCounts();
      await Charge._private.processGraceLapses({ conn: db, limit: 50, counts });

      expect(counts.graceLapsed).toBe(0);
      expect(mockVoidInvoice).toHaveBeenCalledWith(fx.invoice.id, { requireUnsettled: true });
      expect(mockRaiseRetrieval).not.toHaveBeenCalled();
      expect(decide).not.toHaveBeenCalled();
      expect(mockNotifyAdmin).toHaveBeenCalledWith('billing', expect.stringMatching(/withdrawn/i), expect.any(String), expect.objectContaining({
        dedupeKey: `termite-renewal-charge:${fx.successor.id}:renewal_withdrawn`,
      }));
      expect(await row(fx.successor.id)).toMatchObject({ status: 'cancelled', renewal_lapse_outcome: 'withdrawn', renewal_lapse_parent_cancelled_at: null });
      expect((await row(fx.successor.id)).renewal_lapse_completed_at).toBeInstanceOf(Date);
    });

    test('a genuine resume after a crash right after the lapse\'s own parent cancel completes idempotently — retrieval, no second decision', async () => {
      const fx = await overdueRenewal();
      // The earlier run: voided, then cancelled the parent WITH provenance,
      // then crashed before its completion stamp.
      await db('invoices').where({ id: fx.invoice.id }).update({ status: 'void' });
      await db('annual_prepay_terms').where({ id: fx.successor.id })
        .update({ status: 'cancelled', renewal_lapse_started_at: new Date(Date.now() - 3600000), renewal_lapse_parent_cancelled_at: new Date(Date.now() - 1800000) });
      await db('annual_prepay_terms').where({ id: fx.parent.id }).update({ status: 'cancelled', renewal_decision: 'cancel', renewal_decision_at: new Date(Date.now() - 1800000) });
      const decide = jest.spyOn(Renewals4, 'recordDecision').mockResolvedValue(null); // guard-miss: already decided

      const counts = lapseCounts();
      await Charge._private.reconcileMissedLapseEffects({ conn: db, limit: 50, counts });

      expect(counts.lapseEffectsReconciled).toBe(1);
      expect(mockRaiseRetrieval).toHaveBeenCalledTimes(1);
      expect(await row(fx.successor.id)).toMatchObject({ renewal_lapse_outcome: 'lapsed' });
      expect(await row(fx.parent.id)).toMatchObject({ status: 'cancelled', renewal_decision: 'cancel' });
      expect(decide).toHaveBeenCalledTimes(1); // the idempotent retry only
    });

    test('the lapse\'s own parent cancel stamps its provenance on the successor', async () => {
      const fx = await overdueRenewal();
      await db('annual_prepay_terms').where({ id: fx.successor.id }).update({ renewal_lapse_started_at: new Date(Date.now() - 86400000) });
      jest.spyOn(Renewals4, 'recordDecision').mockImplementation(async ({ termId, action, conn }) => {
        const [decided] = await conn('annual_prepay_terms').where({ id: termId }).whereNull('renewal_decision')
          .update({ status: 'cancelled', renewal_decision: action, renewal_decision_at: new Date() }).returning('*');
        return decided || null;
      });

      await Charge._private.reconcileMissedLapseEffects({ conn: db, limit: 50, counts: lapseCounts() });

      const s = await row(fx.successor.id);
      expect(s).toMatchObject({ renewal_lapse_outcome: 'lapsed' });
      expect(s.renewal_lapse_parent_cancelled_at).toBeInstanceOf(Date);
    });

    // The same rule on every other successor action that can void, send a
    // pay link or record a charge outcome — each re-reads the successor and
    // defers on a dispute suspension (successorDisputeSuspended).
    test('every other successor action defers on a dispute-suspended successor: withdrawal, pay link, charge in-gate, 7b, 7d', async () => {
      // A refunded parent (so the withdrawal WOULD fire) and a sent renewal,
      // then paid-and-disputed: payment_pending + marker, invoice reopened.
      const parentInvoice = await insertInvoice({ status: 'paid', paid_at: new Date(), stripe_payment_intent_id: `pi_${randomUUID()}` });
      const parent = await insertParent({ prepay_invoice_id: parentInvoice.id });
      await db('payments').insert({ status: 'refunded', refund_status: 'full', stripe_payment_intent_id: parentInvoice.stripe_payment_intent_id });
      const invoice = await insertInvoice({ status: 'overdue', sent_at: new Date() });
      const successor = await insertSuccessor(parent, invoice, {
        term_start: daysFromToday(-5), created_at: new Date(), dispute_suspended_at: new Date(),
        renewal_charge_attempted_at: new Date(Date.now() - 3 * 3600000), renewal_charge_failure_kind: 'outcome_pending',
      });
      await db('stripe_invoice_charge_attempts').insert({ invoice_id: invoice.id, status: 'succeeded', submitted_at: new Date(Date.now() - 3 * 3600000) });
      const fresh = () => row(successor.id);

      // Withdrawal (4b, and the charge's durable-refusal route): no void.
      await expect(Charge._private.withdrawRenewalSuccessor(await fresh(), 'test', db)).resolves.toBe('deferred');
      // Pay link (7b / 7c delivery, and the first send): withheld, nothing sent.
      await expect(Charge._private.deliverRenewalInvoice(await fresh(), db)).resolves.toMatchObject({ ok: false, withheld: true, outcome: 'deferred' });
      // The charge's in-gate re-check: refused as dispute-owned — never the
      // durable refusal that would route to a withdrawal; nothing belled.
      const refusal = await Charge._private.chargeRefusalUnderGate(await fresh(), db);
      expect(refusal).toMatchObject({ eligible: false, reason: 'successor_dispute_suspended', disputeOwned: true });
      await expect(Charge._private.handleRefusalAtSubmission(await fresh(), refusal, db)).resolves.toEqual({ status: 'deferred', reason: 'successor_dispute_suspended' });
      // 7b: an abandoned claim on a disputed renewal is never retired / recovered.
      await expect(Charge._private.retireAbandonedChargeClaim(await fresh(), db)).resolves.toBe(false);
      // 7d: the reopened invoice is not a declined / ambiguous charge.
      await expect(Charge._private.resolvePendingChargeOutcome(await fresh(), db)).resolves.toBe(false);

      expect(mockVoidInvoice).not.toHaveBeenCalled();
      expect(mockSendViaSMSAndEmail).not.toHaveBeenCalled();
      expect(mockNotifyAdmin).not.toHaveBeenCalled();
      expect(await fresh()).toMatchObject({
        status: 'payment_pending', renewal_charge_failure_kind: 'outcome_pending', renewal_charge_claim_retired_at: null,
      });
      expect((await db('invoices').where({ id: invoice.id }).first()).status).toBe('overdue');
    });
  });

  // Codex #4971 r11 P1 (chokepoint A): a parent whose payment was put in
  // dispute on the ledger — the webhook's phase one committed, the invoice
  // not reopened yet — no longer authorizes the renewal: the charge's
  // in-gate re-check refuses. Transient (a dispute can be won): nothing is
  // withdrawn. The change is dated by the dispute stamp, so a successor paid
  // after it is a late-paid renewal.
  describe('r11: a parent payment in dispute is revocation evidence', () => {
    async function disputedParentRenewal() {
      const parentInvoice = await insertInvoice({ status: 'paid', paid_at: new Date(Date.now() - 400 * 86400000), stripe_payment_intent_id: `pi_parent_${randomUUID().slice(0, 8)}` });
      const parent = await insertParent({ prepay_invoice_id: parentInvoice.id });
      const invoice = await insertInvoice({ status: 'draft' });
      const successor = await insertSuccessor(parent, invoice, { created_at: new Date() });
      await db('payments').insert({ status: 'disputed', stripe_payment_intent_id: parentInvoice.stripe_payment_intent_id, updated_at: new Date(Date.now() - 10 * 60000) });
      return { parent, parentInvoice, successor };
    }

    test('the charge\'s in-gate re-check refuses while the invoice still reads paid — transient, never a withdrawal', async () => {
      const { successor } = await disputedParentRenewal();
      await expect(Charge._private.chargeRefusalUnderGate(successor, db)).resolves.toEqual({
        eligible: false, reason: 'parent_payment_disputed', durable: false,
      });
    });

    test('the dispute WON (the row restored to paid): the charge proceeds', async () => {
      const { parentInvoice, successor } = await disputedParentRenewal();
      await db('payments').where({ stripe_payment_intent_id: parentInvoice.stripe_payment_intent_id }).update({ status: 'paid' });
      await expect(Charge._private.chargeRefusalUnderGate(successor, db)).resolves.toBeNull();
    });

    test('a renewal paid after the dispute stamp is dated late by it', async () => {
      const { parent, successor } = await disputedParentRenewal();
      await db('invoices').where({ id: successor.prepay_invoice_id }).update({ status: 'paid', paid_at: new Date() });
      await expect(Charge._private.paidAfterParentChanged(db, await db('annual_prepay_terms').where({ id: successor.id }).first(), parent)).resolves.toBe(true);
    });
  });

  // Codex #4971 r15 P1: a NET-terms statement's chargeback/refund cascade
  // (routes/stripe-webhook.js reverseStatementCascadeForDispute) reopens the
  // parent's own prepay invoice DIRECTLY as draft/paid_at-null — no ledger
  // row keyed to the invoice's own (absent, for a statement child) Stripe
  // ids exists, so the durable signal must be read off the STATEMENT's own
  // payments row (statement_id) instead of inferred from draft alone.
  describe('r15: a statement cascade reversal on the parent\'s own invoice', () => {
    const statementId = randomUUID();

    async function statementParentRenewal() {
      // The shape reverseStatementCascadeForDispute leaves BEHIND: the
      // invoice reopened to draft/paid_at-null (it never carried its own
      // Stripe ids — the STATEMENT was charged, not the invoice).
      const parentInvoice = await insertInvoice({ status: 'draft', paid_at: null, payer_statement_id: statementId });
      const parent = await insertParent({ prepay_invoice_id: parentInvoice.id });
      const invoice = await insertInvoice({ status: 'draft' });
      const successor = await insertSuccessor(parent, invoice, { created_at: new Date() });
      return { parent, parentInvoice, successor };
    }

    test('a FINAL full statement refund is a DURABLE revocation — the successor is withdrawn, not left owed', async () => {
      const { successor } = await statementParentRenewal();
      await db('payments').insert({ status: 'refunded', refund_status: 'full', statement_id: statementId, updated_at: new Date() });
      await expect(Charge._private.chargeRefusalUnderGate(successor, db)).resolves.toEqual({
        eligible: false, reason: 'parent_invoice_unpaid_or_refunded', durable: true,
      });
    });

    test('a CLOSED-LOST statement dispute is a DURABLE revocation — money is gone for good', async () => {
      const { successor } = await statementParentRenewal();
      await db('payments').insert({
        status: 'disputed', statement_id: statementId, updated_at: new Date(),
        metadata: JSON.stringify({ statement_id: statementId, dispute_id: 'dp_1', dispute_final: 'lost' }),
      });
      await expect(Charge._private.chargeRefusalUnderGate(successor, db)).resolves.toEqual({
        eligible: false, reason: 'parent_invoice_unpaid_or_refunded', durable: true,
      });
    });

    test('an OPEN (unresolved) statement dispute stays TRANSIENT — never withdraws the successor', async () => {
      const { successor } = await statementParentRenewal();
      await db('payments').insert({
        status: 'disputed', statement_id: statementId, updated_at: new Date(),
        metadata: JSON.stringify({ statement_id: statementId, dispute_id: 'dp_2' }),
      });
      await expect(Charge._private.chargeRefusalUnderGate(successor, db)).resolves.toEqual({
        eligible: false, reason: 'parent_payment_disputed', durable: false,
      });
    });

    test('a WON statement dispute (row restored to paid, no lingering revoked row): the charge proceeds', async () => {
      const { parentInvoice, successor } = await statementParentRenewal();
      await db('invoices').where({ id: parentInvoice.id }).update({ status: 'paid', paid_at: new Date() });
      await db('payments').insert({
        status: 'paid', statement_id: statementId, updated_at: new Date(),
        metadata: JSON.stringify({ statement_id: statementId, dispute_id: 'dp_3', dispute_final: 'won' }),
      });
      await expect(Charge._private.chargeRefusalUnderGate(successor, db)).resolves.toBeNull();
    });

    // Codex #4971 r29 P1: dispute.closed(lost) commits the statement row
    // 'disputed' before it reopens the children — a crash between the two
    // leaves this child PAID-looking over lost money, and it has no Stripe
    // ids of its own for the ledger arm. The statement's latest row rules.
    test('a paid-looking statement child over a LOST statement dispute is refused durably; a newer paid statement row restores it', async () => {
      const { parentInvoice, successor } = await statementParentRenewal();
      await db('invoices').where({ id: parentInvoice.id }).update({ status: 'paid', paid_at: new Date() });
      await db('payments').insert({
        status: 'disputed', statement_id: statementId, updated_at: new Date(Date.now() - 60000),
        metadata: JSON.stringify({ statement_id: statementId, dispute_id: 'dp_9', dispute_final: 'lost' }),
      });
      await expect(Charge._private.chargeRefusalUnderGate(successor, db)).resolves.toEqual({
        eligible: false, reason: 'parent_invoice_unpaid_or_refunded', durable: true,
      });
      // A replacement payment on the statement, newer than the lost row.
      await db('payments').insert({ status: 'paid', statement_id: statementId, updated_at: new Date() });
      await expect(Charge._private.chargeRefusalUnderGate(successor, db)).resolves.toBeNull();
    });

    test('no statement-level payments row at all: an ordinary reopened/unpaid parent stays transient, exactly as before', async () => {
      const { successor } = await statementParentRenewal();
      await expect(Charge._private.chargeRefusalUnderGate(successor, db)).resolves.toEqual({
        eligible: false, reason: 'parent_invoice_unpaid_or_refunded', durable: false,
      });
    });

    // Codex #4971 r16 P1 (finding 6): the shared revocation-dating
    // expression (parentChangedAtSql / paidAfterParentChanged) had no
    // timestamp arm for this exact shape — the child invoice carries no
    // Stripe ids of its own, so the PI/charge-id arm can never match a
    // statement-keyed refund row. Without the new statement arm, this ACH
    // successor's payment read as landing strictly BEFORE any change at
    // all (LEAST simply ignored the missing NULL) and lost its
    // refund-or-honor alert (bellLatePaidRenewal never fires for it).
    test('a renewal paid after a FINAL full statement refund is dated late by it', async () => {
      const { parent, successor } = await statementParentRenewal();
      const refundedAt = new Date(Date.now() - 10 * 60000);
      await db('payments').insert({ status: 'refunded', refund_status: 'full', statement_id: statementId, updated_at: refundedAt });
      await db('invoices').where({ id: successor.prepay_invoice_id }).update({ status: 'paid', paid_at: new Date() });
      await expect(Charge._private.paidAfterParentChanged(
        db, await db('annual_prepay_terms').where({ id: successor.id }).first(), parent,
      )).resolves.toBe(true);
    });

    test('a renewal paid BEFORE a statement refund is not dated late by a LATER refund', async () => {
      const { parent, successor } = await statementParentRenewal();
      await db('invoices').where({ id: successor.prepay_invoice_id }).update({ status: 'paid', paid_at: new Date(Date.now() - 3600000) });
      await db('payments').insert({ status: 'refunded', refund_status: 'full', statement_id: statementId, updated_at: new Date() });
      await expect(Charge._private.paidAfterParentChanged(
        db, await db('annual_prepay_terms').where({ id: successor.id }).first(), parent,
      )).resolves.toBe(false);
    });
  });

  // Codex #4971 r20 P1 (finding 2): a staff term-window move on a parent
  // that otherwise still authorizes its renewal (still active — no other
  // arm of parentChangedAtSql fires) is dated by the parent's own
  // term_window_changed_at stamp (20260928020000) — but ONLY a move made
  // AFTER this successor was minted. The mint validated the successor's
  // window against the parent's window as it stood, so an earlier move
  // (the installation anchor's year-1 move, a correction before the
  // renewal existed) changed nothing this renewal relies on; unscoped, that
  // year-old stamp would date EVERY later renewal of an anchored plan as
  // paid late.
  describe('r20: a parent term-window move after the successor was minted', () => {
    const hoursAgo = (h) => new Date(Date.now() - h * 3600000);

    async function movedParentRenewal({ mintedAt, movedAt, paidAt }) {
      const parent = await insertParent({ term_window_changed_at: movedAt });
      const invoice = await insertInvoice({ status: 'paid', paid_at: paidAt });
      const successor = await insertSuccessor(parent, invoice, { created_at: mintedAt });
      return { parent, successor: await db('annual_prepay_terms').where({ id: successor.id }).first() };
    }

    test('moved AFTER the mint, paid after the move: dated late (the refund-or-honor bell can ring)', async () => {
      const { parent, successor } = await movedParentRenewal({ mintedAt: hoursAgo(3), movedAt: hoursAgo(2), paidAt: hoursAgo(1) });
      await expect(Charge._private.paidAfterParentChanged(db, successor, parent)).resolves.toBe(true);
    });

    test('moved AFTER the mint but paid BEFORE the move: not dated late by it', async () => {
      const { parent, successor } = await movedParentRenewal({ mintedAt: hoursAgo(3), movedAt: hoursAgo(1), paidAt: hoursAgo(2) });
      await expect(Charge._private.paidAfterParentChanged(db, successor, parent)).resolves.toBe(false);
    });

    test('moved BEFORE the mint (an installation anchor, an old correction): never dates this renewal late', async () => {
      const { parent, successor } = await movedParentRenewal({ mintedAt: hoursAgo(2), movedAt: hoursAgo(3), paidAt: hoursAgo(1) });
      await expect(Charge._private.paidAfterParentChanged(db, successor, parent)).resolves.toBe(false);
    });

    test('never moved (NULL stamp): a still-authorizing parent dates no change at all, exactly as before', async () => {
      const { parent, successor } = await movedParentRenewal({ mintedAt: hoursAgo(2), movedAt: null, paidAt: hoursAgo(1) });
      await expect(Charge._private.paidAfterParentChanged(db, successor, parent)).resolves.toBe(false);
    });
  });

  // Codex #4971 r21 P1: presentation needs PROVIDER evidence. submitted_at is
  // committed immediately before the Stripe call, so a crash in that gap
  // leaves it set with no request ever made — recovery bells staff only and
  // the customer has seen nothing. Such a row must never read as "presented"
  // (which is what lets the grace lapse void coverage and request retrieval).
  describe('r21: a submitted-only attempt (no PaymentIntent id) is not presentation', () => {
    async function undeliveredRenewal(attempt) {
      const parent = await insertParent();
      const invoice = await insertInvoice({ status: 'sent', sent_at: null, sms_sent_at: null, email_sent_at: null });
      const successor = await insertSuccessor(parent, invoice, { renewal_charge_attempted_at: new Date(Date.now() - 3600000) });
      if (attempt) await db('stripe_invoice_charge_attempts').insert({ invoice_id: invoice.id, ...attempt });
      return { successor: await db('annual_prepay_terms').where({ id: successor.id }).first(), invoice };
    }

    test('submitted_at alone (the pre-call crash shape, promoted to ambiguous): NOT presented', async () => {
      const { successor } = await undeliveredRenewal({ status: 'ambiguous', submitted_at: new Date() });
      await expect(Charge._private.renewalWasPresented(db, successor)).resolves.toBe(false);
    });

    test('a PaymentIntent id on the attempt (Stripe processed it): presented', async () => {
      const { successor } = await undeliveredRenewal({ status: 'failed', submitted_at: new Date(), stripe_payment_intent_id: 'pi_r21_seen', resolved_at: new Date() });
      await expect(Charge._private.renewalWasPresented(db, successor)).resolves.toBe(true);
    });

    test('a delivered invoice is presentation regardless of any attempt', async () => {
      const { successor, invoice } = await undeliveredRenewal({ status: 'ambiguous', submitted_at: new Date() });
      await db('invoices').where({ id: invoice.id }).update({ sent_at: new Date() });
      await expect(Charge._private.renewalWasPresented(db, successor)).resolves.toBe(true);
    });

    test('the grace-lapse scan selects the PI-backed renewal past its deadline and never the submitted-only one', async () => {
      const seen = await undeliveredRenewal({ status: 'failed', submitted_at: new Date(), stripe_payment_intent_id: 'pi_r21_lapse', resolved_at: new Date() });
      const blind = await undeliveredRenewal({ status: 'ambiguous', submitted_at: new Date() });
      const counts = { graceScanned: 0, graceLapsed: 0, graceReconciliationDeferred: 0, graceRetiredSettled: 0 };
      await Charge._private.processGraceLapses({ conn: db, limit: 50, counts });
      expect(counts.graceScanned).toBe(1);
      const started = await db('annual_prepay_terms').whereNotNull('renewal_lapse_started_at').pluck('id');
      expect(started).toEqual([seen.successor.id]);
      expect(started).not.toContain(blind.successor.id);
    });
  });

  // Codex #4971 r24 P1: the pay-link clearance judges the successor AS
  // RE-READ UNDER THE GATE, never the caller's pre-gate object — an
  // annual-prepay edit that won the gate first (a moved successor
  // term_start) is visible only in the fresh row.
  describe('r24: payLinkVerdict reads the fresh successor row', () => {
    test('a successor whose term_start moved after the caller fetched it is refused as parent_term_moved from the fresh row', async () => {
      const parent = await insertParent({ term_end: daysFromToday(-35) });
      const invoice = await insertInvoice({ status: 'draft' });
      const inserted = await insertSuccessor(parent, invoice, { term_start: daysFromToday(-34), created_at: new Date() });
      const stale = await db('annual_prepay_terms').where({ id: inserted.id }).first();
      // The edit lands between the caller's read and the gate.
      await db('annual_prepay_terms').where({ id: inserted.id }).update({ term_start: daysFromToday(-30) });
      const verdict = await Charge._private.payLinkVerdict(stale, db);
      expect(verdict).toMatchObject({ kind: 'refused', durable: true, reason: expect.stringContaining('parent_term_moved') });
      expect(verdict.fresh.term_start instanceof Date ? verdict.fresh.term_start.toISOString().slice(0, 10) : String(verdict.fresh.term_start)).toBe(daysFromToday(-30));
    });

    test('an unmoved successor clears exactly as before', async () => {
      const parent = await insertParent({ term_end: daysFromToday(-35) });
      const invoice = await insertInvoice({ status: 'draft' });
      const inserted = await insertSuccessor(parent, invoice, { term_start: daysFromToday(-34), created_at: new Date() });
      const row = await db('annual_prepay_terms').where({ id: inserted.id }).first();
      await expect(Charge._private.payLinkVerdict(row, db)).resolves.toBeNull();
    });
  });

  // Codex #4971 r24 P2: "paid after the parent changed" compares the
  // payment's real SETTLEMENT time (payments.metadata.settled_event_at, the
  // provider's own timestamp), not invoices.paid_at — which is when the
  // webhook handler ran, later than the settlement for a delayed delivery.
  describe('r24 P2: the settlement time, not webhook processing time', () => {
    const hoursAgo = (h) => new Date(Date.now() - h * 3600000);

    // The parent is refunded (its change) `changedAgo` hours ago; the
    // successor's invoice reads paid_at `paidAtAgo` hours ago.
    async function refundedParentRenewal({ changedAgo, paidAtAgo, settledAgo = null, pi = `pi_${randomUUID()}` }) {
      const parentInvoice = await insertInvoice({ status: 'refunded', paid_at: hoursAgo(100), stripe_payment_intent_id: `pi_parent_${randomUUID()}` });
      await db('payments').insert({ status: 'refunded', refund_status: 'full', stripe_payment_intent_id: parentInvoice.stripe_payment_intent_id, updated_at: hoursAgo(changedAgo) });
      const parent = await insertParent({ prepay_invoice_id: parentInvoice.id });
      const invoice = await insertInvoice({ status: 'paid', paid_at: hoursAgo(paidAtAgo), stripe_payment_intent_id: pi });
      if (settledAgo != null) {
        await db('payments').insert({ status: 'paid', stripe_payment_intent_id: pi, updated_at: hoursAgo(paidAtAgo), metadata: JSON.stringify({ settled_event_at: hoursAgo(settledAgo).toISOString() }) });
      }
      const inserted = await insertSuccessor(parent, invoice, { status: 'active', created_at: hoursAgo(200) });
      return { parent, successor: await db('annual_prepay_terms').where({ id: inserted.id }).first() };
    }

    test('a debit that SETTLED before the parent changed is not "paid after" just because its webhook arrived later', async () => {
      // Settled 5h ago, parent refunded 3h ago, webhook processed 1h ago.
      const { parent, successor } = await refundedParentRenewal({ settledAgo: 5, changedAgo: 3, paidAtAgo: 1 });
      await expect(Charge._private.paidAfterParentChanged(db, successor, parent)).resolves.toBe(false);
    });

    test('a debit that settled AFTER the parent changed is still dated late', async () => {
      const { parent, successor } = await refundedParentRenewal({ settledAgo: 2, changedAgo: 3, paidAtAgo: 1 });
      await expect(Charge._private.paidAfterParentChanged(db, successor, parent)).resolves.toBe(true);
    });

    test('no ledger settlement stamp: paid_at is the fallback, exactly as before', async () => {
      const late = await refundedParentRenewal({ changedAgo: 3, paidAtAgo: 1 });
      await expect(Charge._private.paidAfterParentChanged(db, late.successor, late.parent)).resolves.toBe(true);
      const early = await refundedParentRenewal({ changedAgo: 3, paidAtAgo: 5 });
      await expect(Charge._private.paidAfterParentChanged(db, early.successor, early.parent)).resolves.toBe(false);
    });
  });

  // Codex #4971 r26 P1: the pay link's USE. A delivered renewal pay link
  // whose parent has since been cancelled / moved must not start or finalize
  // a payment at the public pay page.
  describe('r26: the public payment boundary re-checks the renewal', () => {
    async function deliveredRenewal(parentFields = {}) {
      const parent = await insertParent({ term_end: daysFromToday(-5), ...parentFields });
      const invoice = await insertInvoice({ status: 'sent', sent_at: new Date() });
      const inserted = await insertSuccessor(parent, invoice, { term_start: daysFromToday(-4), created_at: new Date() });
      return { parent, successor: inserted, invoice: { id: invoice.id, annual_prepay_term_id: inserted.id } };
    }

    test('an eligible renewal is payable; an ordinary invoice is never even looked up', async () => {
      const { invoice } = await deliveredRenewal();
      await expect(Charge.renewalPaymentRefusal(invoice, db)).resolves.toBeNull();
      const plain = jest.fn(() => { throw new Error('an ordinary invoice must not query'); });
      await expect(Charge.renewalPaymentRefusal({ id: randomUUID(), annual_prepay_term_id: null }, plain)).resolves.toBeNull();
      expect(plain).not.toHaveBeenCalled();
    });

    test('a parent cancelled after delivery refuses the payment, with a customer-safe message', async () => {
      const { parent, invoice } = await deliveredRenewal();
      await db('annual_prepay_terms').where({ id: parent.id }).update({ status: 'cancelled', renewal_decision: 'cancel', renewal_decision_at: new Date() });
      const refusal = await Charge.renewalPaymentRefusal(invoice, db);
      expect(refusal).toMatchObject({ message: expect.stringMatching(/no longer be paid online/i) });
      expect(refusal.reason).toMatch(/parent/);
    });

    test('withRenewalPaymentClearance: a refused renewal never reaches pay(); an eligible one does, under the gate', async () => {
      const blocked = await deliveredRenewal();
      await db('annual_prepay_terms').where({ id: blocked.parent.id }).update({ status: 'cancelled', renewal_decision: 'cancel', renewal_decision_at: new Date() });
      const pay = jest.fn(async () => 'paid');
      await expect(Charge.withRenewalPaymentClearance(blocked.invoice, pay, db)).rejects.toMatchObject({ code: 'RENEWAL_NOT_PAYABLE' });
      expect(pay).not.toHaveBeenCalled();

      const ok = await deliveredRenewal();
      const gate = jest.fn((_termId, fn) => fn());
      const previous = Renewals.withParentDecisionLock;
      Renewals.withParentDecisionLock = gate;
      try {
        await expect(Charge.withRenewalPaymentClearance(ok.invoice, pay, db)).resolves.toBe('paid');
      } finally {
        Renewals.withParentDecisionLock = previous;
      }
      expect(pay).toHaveBeenCalledTimes(1);
      expect(gate).toHaveBeenCalledWith(ok.parent.id, expect.any(Function), { alsoTermIds: [ok.successor.id] });
    });
  });

  // Codex #4971 r27 P1: the AUTOMATIC charge is capped at the parent's own
  // renewal window (term_end + grace days) even though the successor's own
  // payment grace runs from the later of its term_start / created_at.
  describe('r27: automatic charges are capped at the parent renewal window', () => {
    async function mintedLate(parentEndDaysAgo) {
      const parent = await insertParent({ term_end: daysFromToday(-parentEndDaysAgo) });
      const invoice = await insertInvoice({ status: 'draft' });
      const inserted = await insertSuccessor(parent, invoice, { term_start: daysFromToday(-parentEndDaysAgo + 1), created_at: new Date() });
      return inserted;
    }

    test('31 days past the parent term_end: no automatic charge, even inside the successor\'s own grace', async () => {
      const successor = await mintedLate(31);
      await expect(Charge._private.resolveChargeEligibility(successor.id, db)).resolves.toMatchObject({ eligible: false, reason: 'past_renewal_charge_window' });
      expect((await db('annual_prepay_terms').where({ id: successor.id }).first('renewal_charge_attempted_at')).renewal_charge_attempted_at).toBeNull();
    });

    test('inside the parent window the charge fence is claimed as before', async () => {
      const successor = await mintedLate(29);
      await expect(Charge._private.resolveChargeEligibility(successor.id, db)).resolves.toEqual({ eligible: true });
    });
  });

  // Codex #4971 r10 P1s — the charge's provider boundary (stripe.js, under
  // the invoice / customer locks; its own suite) refuses a payer-stamped
  // invoice (PAYER_BILLED_GUARD) and a deleted account (CUSTOMER_DELETED).
  // Here, what the renewal does with each refusal, and its pay-link
  // clearance for the same two shapes — on real rows.
  describe('r10: payer-stamped renewal invoices and deleted accounts', () => {
    let Renewals5;
    let originalLock;
    beforeEach(() => {
      Renewals5 = require('../services/annual-prepay-renewals');
      originalLock = Renewals5.withParentDecisionLock;
      Renewals5.withParentDecisionLock = (_termId, fn) => fn();
      require('../services/stripe').assertNoInvoiceChargeReconciliationPending.mockImplementation(async () => undefined);
      mockVoidInvoice.mockImplementation(async (invoiceId) => {
        await db('invoices').where({ id: invoiceId }).update({ status: 'void' });
        await db('annual_prepay_terms').where({ prepay_invoice_id: invoiceId }).update({ status: 'cancelled' });
        return {};
      });
    });
    afterEach(() => {
      Renewals5.withParentDecisionLock = originalLock;
      require('../services/stripe').assertNoInvoiceChargeReconciliationPending.mockImplementation(async () => { throw new Error('reconciliation pending (test)'); });
      mockVoidInvoice.mockReset();
    });

    // A minted, unpresented renewal whose charge fence was claimed (the
    // charge was about to run), behind a live paid parent.
    async function claimedRenewal(invoiceFields = {}) {
      const parentInvoice = await insertInvoice({ status: 'paid', paid_at: new Date(Date.now() - 400 * 86400000) });
      const parent = await insertParent({ prepay_invoice_id: parentInvoice.id });
      const invoice = await insertInvoice({ status: 'draft', ...invoiceFields });
      // The window starts the day after the parent's term_end (the default)
      // and a fresh mint keeps its whole grace window.
      const successor = await insertSuccessor(parent, invoice, {
        created_at: new Date(),
        renewal_charge_attempted_at: new Date(), renewal_charge_failure_kind: 'outcome_pending',
      });
      return { parent, invoice, successor };
    }
    const guardError = (code, message) => Object.assign(new Error(message), { code });

    test('an invoice stamped to a payer (the payer since cleared from the customer): the refusal is the payer follow-through — no homeowner pay link, one payer bell', async () => {
      const { invoice, successor } = await claimedRenewal({ payer_id: randomUUID() });

      const handled = await Charge._private.handleChargeFailure(successor, guardError('PAYER_BILLED_GUARD', 'Invoice is billed to a third-party payer'), db);

      expect(handled).toBe(true);
      expect(mockSendViaSMSAndEmail).not.toHaveBeenCalled();
      expect(mockNotifyAdmin).toHaveBeenCalledTimes(1);
      expect(mockNotifyAdmin).toHaveBeenCalledWith('billing', expect.stringMatching(/third-party payer/i), expect.any(String), expect.objectContaining({
        dedupeKey: `termite-renewal-charge:${successor.id}:payer_billed`,
      }));
      expect(await db('annual_prepay_terms').where({ id: successor.id }).first()).toMatchObject({ status: 'payment_pending', renewal_charge_failure_kind: 'payer_refused' });
      expect(mockVoidInvoice).not.toHaveBeenCalled();
      // The pay-link clearance reads the invoice's own Bill-To, whatever the
      // customer default says (the payer resolver reads self-pay here).
      await expect(Charge._private.deliverRenewalInvoice(successor, db)).resolves.toMatchObject({ ok: false, code: 'payer_billed' });
      expect(mockSendViaSMSAndEmail).not.toHaveBeenCalled();
      expect((await db('invoices').where({ id: invoice.id }).first()).status).toBe('draft');
    });

    test('a customer who deleted their account after the mint: the refusal withdraws the renewal — voided, cancelled, one staff bell, no pay link', async () => {
      const { invoice, successor } = await claimedRenewal();
      await db('customers').insert({ id: customerId, deleted_at: new Date() });

      const handled = await Charge._private.handleChargeFailure(successor, guardError('CUSTOMER_DELETED', 'This customer account was deleted'), db);

      expect(handled).toBe(true);
      expect(mockVoidInvoice).toHaveBeenCalledWith(invoice.id, { requireUnsettled: true });
      expect((await db('annual_prepay_terms').where({ id: successor.id }).first()).status).toBe('cancelled');
      expect(mockSendViaSMSAndEmail).not.toHaveBeenCalled();
      expect(mockNotifyAdmin).toHaveBeenCalledTimes(1);
      expect(mockNotifyAdmin).toHaveBeenCalledWith('billing', expect.stringMatching(/withdrawn/i), expect.stringContaining('deleted their account'), expect.objectContaining({
        dedupeKey: `termite-renewal-charge:${successor.id}:renewal_withdrawn`,
      }));
    });

    test('a deleted account never gets a pay link: the clearance withdraws the renewal instead of sending', async () => {
      const { invoice, successor } = await claimedRenewal();
      await db('customers').insert({ id: customerId, deleted_at: new Date() });

      await expect(Charge._private.deliverRenewalInvoice(successor, db)).resolves.toMatchObject({ ok: false, withheld: true });

      expect(mockSendViaSMSAndEmail).not.toHaveBeenCalled();
      expect(mockVoidInvoice).toHaveBeenCalledWith(invoice.id, { requireUnsettled: true });
      expect((await db('annual_prepay_terms').where({ id: successor.id }).first()).status).toBe('cancelled');
    });

    test('a live self-pay customer: the pay link still goes out as before', async () => {
      const { invoice, successor } = await claimedRenewal();
      await db('customers').insert({ id: customerId, deleted_at: null });

      await Charge._private.deliverRenewalInvoice(successor, db);

      expect(mockSendViaSMSAndEmail).toHaveBeenCalledWith(invoice.id, expect.objectContaining({ firstDeliveryOnly: true }));
      expect(mockVoidInvoice).not.toHaveBeenCalled();
    });
  });

  // OWNER RULING (pre-push item 6): a renewal whose invoice was already SENT
  // is withdrawn right away once the prior year becomes durably ineligible
  // — here a full refund of the parent's own invoice, recorded on the
  // payments ledger before any status sync. Pass 4b's SQL pre-filter finds
  // it, the per-row check confirms the refusal is durable, and the
  // withdrawal voids (voidInvoice, requireUnsettled) + cancels, with one
  // staff alert and no customer message.
  describe('owner ruling: withdraw a sent renewal when the prior year is refunded (pass 4b)', () => {
    let Renewals3;
    let originalLock;
    beforeEach(() => {
      Renewals3 = require('../services/annual-prepay-renewals');
      originalLock = Renewals3.withParentDecisionLock;
      Renewals3.withParentDecisionLock = (_termId, fn) => fn();
      require('../services/stripe').assertNoInvoiceChargeReconciliationPending.mockImplementation(async () => undefined);
      mockVoidInvoice.mockImplementation(async (invoiceId) => {
        // voidInvoice's own effects: the invoice voids, its sync cancels the term.
        await db('invoices').where({ id: invoiceId }).update({ status: 'void' });
        await db('annual_prepay_terms').where({ prepay_invoice_id: invoiceId }).update({ status: 'cancelled' });
        return {};
      });
    });
    afterEach(() => {
      Renewals3.withParentDecisionLock = originalLock;
      require('../services/stripe').assertNoInvoiceChargeReconciliationPending.mockImplementation(async () => { throw new Error('reconciliation pending (test)'); });
      mockVoidInvoice.mockReset();
    });

    async function sentRenewalOfRefundableParent() {
      const parentInvoice = await insertInvoice({ status: 'paid', paid_at: new Date(), stripe_payment_intent_id: `pi_${randomUUID()}` });
      const parent = await insertParent({ prepay_invoice_id: parentInvoice.id });
      const renewalInvoice = await insertInvoice({ status: 'sent', sent_at: new Date() });
      const successor = await insertSuccessor(parent, renewalInvoice, {
        term_start: daysFromToday(-34), created_at: new Date(),
      });
      return { parent, parentInvoice, renewalInvoice, successor };
    }
    const counts = () => ({ withdrawScanned: 0, withdrawn: 0 });

    test('a delivery-stamped unpaid renewal is voided and cancelled right after the parent is refunded — one staff alert', async () => {
      const { parentInvoice, renewalInvoice, successor } = await sentRenewalOfRefundableParent();
      const untouched = await sentRenewalOfRefundableParent(); // parent still paid: never selected
      await db('payments').insert({ status: 'refunded', stripe_payment_intent_id: parentInvoice.stripe_payment_intent_id });

      const c = counts();
      await Charge._private.withdrawSuccessorsOfIneligibleParents({ conn: db, limit: 50, counts: c });

      expect(c).toEqual({ withdrawScanned: 1, withdrawn: 1 });
      expect(mockVoidInvoice).toHaveBeenCalledWith(renewalInvoice.id, { requireUnsettled: true });
      expect((await db('annual_prepay_terms').where({ id: successor.id }).first()).status).toBe('cancelled');
      expect((await db('annual_prepay_terms').where({ id: untouched.successor.id }).first()).status).toBe('payment_pending');
      expect(mockNotifyAdmin).toHaveBeenCalledTimes(1);
      expect(mockNotifyAdmin).toHaveBeenCalledWith('billing', expect.stringMatching(/withdrawn/i), expect.any(String), expect.objectContaining({
        dedupeKey: `termite-renewal-charge:${successor.id}:renewal_withdrawn`,
      }));
      expect(mockSendViaSMSAndEmail).not.toHaveBeenCalled();
    });

    // Codex #4971 r13 P1: a renewal whose fallback pay link already went
    // out (its skip / follow-through markers handled — legs 7a-7c are done
    // with it), behind a parent that is still fine, then the customer
    // deleted their account: pass 4b withdraws it.
    test('a delivered, handled renewal whose customer then deleted their account: 4b withdraws it (void + cancel + one bell), no retrieval', async () => {
      const { renewalInvoice, successor } = await sentRenewalOfRefundableParent(); // parent still paid
      await db('annual_prepay_terms').where({ id: successor.id }).update({
        renewal_charge_skipped_at: new Date(), renewal_charge_skip_reason: 'no_method',
        renewal_charge_failure_handled_at: new Date(),
      });
      const untouched = await sentRenewalOfRefundableParent(); // a live account: never selected
      await db('customers').insert({ id: customerId, deleted_at: new Date() });
      // The untouched renewal belongs to a different, live customer.
      const liveCustomer = randomUUID();
      await db('customers').insert({ id: liveCustomer, deleted_at: null });
      await db('annual_prepay_terms').where({ id: untouched.successor.id }).update({ customer_id: liveCustomer });

      const c = counts();
      await Charge._private.withdrawSuccessorsOfIneligibleParents({ conn: db, limit: 50, counts: c });

      expect(c).toEqual({ withdrawScanned: 1, withdrawn: 1 });
      expect(mockVoidInvoice).toHaveBeenCalledWith(renewalInvoice.id, { requireUnsettled: true });
      expect(mockVoidInvoice).toHaveBeenCalledTimes(1);
      expect((await db('annual_prepay_terms').where({ id: successor.id }).first()).status).toBe('cancelled');
      expect((await db('annual_prepay_terms').where({ id: untouched.successor.id }).first()).status).toBe('payment_pending');
      expect(mockNotifyAdmin).toHaveBeenCalledTimes(1);
      expect(mockNotifyAdmin).toHaveBeenCalledWith('billing', expect.stringMatching(/withdrawn/i), expect.stringContaining('deleted their account'), expect.objectContaining({
        dedupeKey: `termite-renewal-charge:${successor.id}:renewal_withdrawn`,
      }));
      expect(mockRaiseRetrieval).not.toHaveBeenCalled();
      expect(mockSendViaSMSAndEmail).not.toHaveBeenCalled();
    });

    test('a submitted, unresolved charge on the renewal wins: nothing voided, no alert, rotated', async () => {
      const { parentInvoice, renewalInvoice, successor } = await sentRenewalOfRefundableParent();
      await db('payments').insert({ status: 'refunded', stripe_payment_intent_id: parentInvoice.stripe_payment_intent_id });
      await db('stripe_invoice_charge_attempts').insert({ invoice_id: renewalInvoice.id, status: 'ambiguous', submitted_at: new Date() });

      await Charge._private.withdrawSuccessorsOfIneligibleParents({ conn: db, limit: 50, counts: counts() });

      expect(mockVoidInvoice).not.toHaveBeenCalled();
      expect(mockNotifyAdmin).not.toHaveBeenCalled();
      const row = await db('annual_prepay_terms').where({ id: successor.id }).first();
      expect(row.status).toBe('payment_pending');
      expect(row.renewal_sweep_deferred_at).not.toBeNull();
    });

    // Codex #4971 r6 P1 (structural): the withdrawal's pre-gate verdict is
    // never its authority. The parent's refund is reversed (a bounced refund
    // restores the payment) while the withdrawal waits for the gate: under
    // the gate the refusal is recomputed, no longer holds — nothing is
    // voided, no alert, the row is rotated.
    test('the parent\'s payment restored between the outside check and the gate: no void, no alert, rotated', async () => {
      const { parentInvoice, successor } = await sentRenewalOfRefundableParent();
      const [refund] = await db('payments').insert({ status: 'refunded', stripe_payment_intent_id: parentInvoice.stripe_payment_intent_id }).returning('id');
      Renewals3.withParentDecisionLock = async (_termId, fn) => {
        await db('payments').where({ id: refund.id }).update({ status: 'paid' }); // the refund bounced
        return fn();
      };

      const c = counts();
      await Charge._private.withdrawSuccessorsOfIneligibleParents({ conn: db, limit: 50, counts: c });

      expect(c).toEqual({ withdrawScanned: 1, withdrawn: 0 });
      expect(mockVoidInvoice).not.toHaveBeenCalled();
      expect(mockNotifyAdmin).not.toHaveBeenCalled();
      const row = await db('annual_prepay_terms').where({ id: successor.id }).first();
      expect(row.status).toBe('payment_pending');
      expect(row.renewal_sweep_deferred_at).not.toBeNull();
    });

    test('a refusal that still holds under the gate withdraws exactly as before', async () => {
      const { parentInvoice, renewalInvoice, successor } = await sentRenewalOfRefundableParent();
      await db('payments').insert({ status: 'refunded', stripe_payment_intent_id: parentInvoice.stripe_payment_intent_id });
      let gateTaken = false;
      Renewals3.withParentDecisionLock = async (_termId, fn) => { gateTaken = true; return fn(); };

      const c = counts();
      await Charge._private.withdrawSuccessorsOfIneligibleParents({ conn: db, limit: 50, counts: c });

      expect(gateTaken).toBe(true);
      expect(c).toEqual({ withdrawScanned: 1, withdrawn: 1 });
      expect(mockVoidInvoice).toHaveBeenCalledWith(renewalInvoice.id, { requireUnsettled: true });
      expect((await db('annual_prepay_terms').where({ id: successor.id }).first()).status).toBe('cancelled');
    });

    test('a lost staff bell voids nothing — rotated to ring again', async () => {
      const { parentInvoice, successor } = await sentRenewalOfRefundableParent();
      await db('payments').insert({ status: 'refunded', stripe_payment_intent_id: parentInvoice.stripe_payment_intent_id });
      mockNotifyAdmin.mockResolvedValueOnce(null);

      await Charge._private.withdrawSuccessorsOfIneligibleParents({ conn: db, limit: 50, counts: counts() });

      expect(mockVoidInvoice).not.toHaveBeenCalled();
      const row = await db('annual_prepay_terms').where({ id: successor.id }).first();
      expect(row.status).toBe('payment_pending');
      expect(row.renewal_sweep_deferred_at).not.toBeNull();
    });
  });
  describe('B10: the held-renewal bell scan covers a backlog past its page', () => {
    test('with more than 50 held overdue renewals, each pass belles the next unnotified rows until all are told', async () => {
      const { bellHeldOverdueRenewals, HELD_RENEWAL_BELL_SCAN_LIMIT } = Charge._private;
      const total = HELD_RENEWAL_BELL_SCAN_LIMIT + 12;
      // Mirrors notifyAdmin's dedupe: a bell for a key that already has a
      // notification row is a no-op, a new one writes the row.
      mockNotifyAdmin.mockImplementation(async (_cat, _title, _body, opts) => {
        const exists = await db('notifications').where({ recipient_type: 'admin' }).whereRaw("metadata->>'dedupeKey' = ?", [opts.dedupeKey]).first('id');
        if (exists) return { deduped: true };
        await db('notifications').insert({ recipient_type: 'admin', metadata: JSON.stringify({ dedupeKey: opts.dedupeKey }) });
        return { deduped: false };
      });
      const terms = [];
      for (let n = 0; n < total; n += 1) {
        const holdCustomer = randomUUID();
        await db('collections_flags').insert({ customer_id: holdCustomer, flag: 'collection_hold', reason: 'dispute: says the visit never happened' });
        const parent = await insertParent({ customer_id: holdCustomer });
        const invoice = await insertInvoice({ status: 'draft' });
        terms.push(await insertSuccessor(parent, invoice, { customer_id: holdCustomer }));
      }
      // A held customer whose lapse is NOT overdue yet, and an overdue one
      // with no hold: neither is belled.
      const freshParent = await insertParent({ customer_id: randomUUID() });
      await insertSuccessor(freshParent, await insertInvoice({ status: 'draft' }), { customer_id: freshParent.customer_id, term_start: daysFromToday(0), term_end: daysFromToday(365) });
      await db('collections_flags').insert({ customer_id: freshParent.customer_id, flag: 'collection_hold', reason: 'dispute: x' });
      const noHoldParent = await insertParent({ customer_id: randomUUID() });
      await insertSuccessor(noHoldParent, await insertInvoice({ status: 'draft' }), { customer_id: noHoldParent.customer_id });

      const belledIds = () => new Set(mockNotifyAdmin.mock.calls.map(([, , , opts]) => opts.metadata.termId));

      const first = { };
      await bellHeldOverdueRenewals({ conn: db, counts: first });
      expect(first.graceHeldByCollectionsHold).toBe(HELD_RENEWAL_BELL_SCAN_LIMIT);
      expect(belledIds().size).toBe(HELD_RENEWAL_BELL_SCAN_LIMIT);

      // Day two: the first page is already notified, so the scan moves on to
      // the remaining rows instead of returning the same 50.
      const second = {};
      await bellHeldOverdueRenewals({ conn: db, counts: second });
      expect(second.graceHeldByCollectionsHold).toBe(total - HELD_RENEWAL_BELL_SCAN_LIMIT);
      expect(belledIds()).toEqual(new Set(terms.map((t) => t.id)));

      // Day three: everything is told; nothing left to scan.
      const third = {};
      await bellHeldOverdueRenewals({ conn: db, counts: third });
      expect(third.graceHeldByCollectionsHold).toBe(0);
      expect(await db('notifications').count('* as n').first()).toEqual({ n: String(total) });
    });
  });
});
