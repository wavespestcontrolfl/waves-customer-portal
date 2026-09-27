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

// annualPrepayTableExists() reads the module-level db; nothing else here
// touches it (every query under test runs on the scratch `db` passed in).
jest.mock('../models/db', () => ({ schema: { hasTable: jest.fn().mockResolvedValue(true) } }));
const mockNotifyAdmin = jest.fn(async () => ({ id: 'bell-1' }));
jest.mock('../services/notification-service', () => ({ notifyAdmin: (...args) => mockNotifyAdmin(...args) }));
const mockSendViaSMSAndEmail = jest.fn(async () => ({ ok: true }));
const mockVoidInvoice = jest.fn(async () => ({}));
jest.mock('../services/invoice', () => ({
  sendViaSMSAndEmail: (...args) => mockSendViaSMSAndEmail(...args),
  voidInvoice: (...args) => mockVoidInvoice(...args),
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
    dispute_suspended_at timestamptz,
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
    stripe_charge_id text
  )`);
  await db.raw(`CREATE TABLE payments (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    status text,
    refund_status text,
    stripe_payment_intent_id text,
    stripe_charge_id text,
    updated_at timestamptz
  )`);
  await db.raw(`CREATE TABLE stripe_invoice_charge_attempts (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    invoice_id uuid NOT NULL,
    status text NOT NULL DEFAULT 'claimed',
    error_message text,
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

      const summary = await Renewals.reconcileParentRenewedStamps({ conn: db, limit: 50 });

      expect(summary).toEqual({ scanned: 1, stamped: 1 });
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
        const submitted = await claimedDraftSuccessor({ status: 'failed', submitted_at: new Date() });
        const withIntent = await claimedDraftSuccessor({ status: 'ambiguous', stripe_payment_intent_id: 'pi_sent' });

        const counts = freshCounts();
        await Charge._private.processGraceLapses({ conn: db, limit: 50, counts });

        const started = await db('annual_prepay_terms').whereNotNull('renewal_lapse_started_at').pluck('id');
        expect(started.sort()).toEqual([submitted.id, withIntent.id].sort());
        expect(started).not.toContain(bare.id);
        expect(counts.graceScanned).toBe(2);
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

    test('renewalWasPresented (the retire guard) reads the SAME submission evidence', async () => {
      const bare = await claimedDraftSuccessor({ status: 'failed' });
      const submitted = await claimedDraftSuccessor({ status: 'failed', submitted_at: new Date() });
      expect(await Charge._private.renewalWasPresented(db, bare)).toBe(false);
      expect(await Charge._private.renewalWasPresented(db, submitted)).toBe(true);
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
      const declined = await pendingOutcome({ attempt: { status: 'failed', submitted_at: new Date(), resolved_at: new Date(), error_message: 'Your card was declined.' } });
      const unknown = await pendingOutcome({ attempt: { status: 'claimed', stripe_payment_intent_id: 'pi_lost' } });
      const clearing = await pendingOutcome({ invoice: { status: 'processing' }, attempt: { status: 'succeeded', submitted_at: new Date() } });
      const fresh = await pendingOutcome({ attempt: { status: 'claimed', submitted_at: new Date() }, attemptedAgoMs: 5 * 60000 });
      const neverReached = await pendingOutcome({ attempt: { status: 'failed' } }); // leg 7b's crash gap
      const activated = await pendingOutcome({ attempt: { status: 'succeeded', submitted_at: new Date() }, fields: { status: 'active' } });

      const counts = sweepCounts();
      await Charge._private.resolvePendingChargeOutcomes({ conn: db, limit: 50, counts });

      expect(counts.reconcilePendingOutcomeScanned).toBe(5); // not the fresh one, not 7b's
      expect((await kindOf(settled.successor.id)).renewal_charge_failure_kind).toBeNull();
      expect(await kindOf(declined.successor.id)).toMatchObject({
        renewal_charge_failure_kind: 'declined', renewal_charge_failure_reason: expect.stringContaining('Your card was declined.'), renewal_charge_failure_handled_at: null,
      });
      expect(await kindOf(unknown.successor.id)).toMatchObject({ renewal_charge_failure_kind: 'ambiguous', renewal_charge_failure_handled_at: null });
      expect(await kindOf(clearing.successor.id)).toMatchObject({ renewal_charge_failure_kind: 'outcome_pending', renewal_sweep_deferred_at: expect.any(Date) });
      expect((await kindOf(fresh.successor.id)).renewal_charge_failure_kind).toBe('outcome_pending');
      expect((await kindOf(neverReached.successor.id)).renewal_charge_failure_kind).toBe('outcome_pending');
      expect((await kindOf(activated.successor.id)).renewal_charge_failure_kind).toBeNull();
      expect(counts.reconcilePendingOutcomeResolved).toBe(4);

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
      expect(counts.reconcileFollowThroughScanned).toBe(2);
      expect(mockSendViaSMSAndEmail).toHaveBeenCalledTimes(1);
      expect(mockSendViaSMSAndEmail).toHaveBeenCalledWith(declined.invoice.id, expect.objectContaining({ firstDeliveryOnly: true }));
      expect(mockNotifyAdmin).toHaveBeenCalledWith('billing', expect.any(String), expect.any(String), expect.objectContaining({
        dedupeKey: `termite-renewal-charge:${unknown.successor.id}:ambiguous`,
      }));
      expect((await kindOf(declined.successor.id)).renewal_charge_failure_handled_at).toBeInstanceOf(Date);
      expect((await kindOf(unknown.successor.id)).renewal_charge_failure_handled_at).toBeInstanceOf(Date);
    });

    test('the grace lapse never counts a submitted attempt whose follow-through is still owed as "presented" (SQL and JS twins agree)', async () => {
      const Renewals2 = require('../services/annual-prepay-renewals');
      const originalLock = Renewals2.withParentDecisionLock;
      Renewals2.withParentDecisionLock = (_termId, fn) => fn();
      try {
        // Past the grace deadline (term_start 34 days ago), undelivered draft,
        // attempt genuinely submitted.
        const make = async (fields) => {
          const parent = await insertParent();
          const invoice = await insertInvoice({ status: 'draft' });
          const successor = await insertSuccessor(parent, invoice, { renewal_charge_attempted_at: new Date(Date.now() - 86400000), ...fields });
          await db('stripe_invoice_charge_attempts').insert({ invoice_id: invoice.id, status: 'failed', submitted_at: new Date() });
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
});
