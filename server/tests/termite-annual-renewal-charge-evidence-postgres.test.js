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
    stripe_charge_id text
  )`);
  await db.raw(`CREATE TABLE stripe_invoice_charge_attempts (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    invoice_id uuid NOT NULL,
    status text NOT NULL DEFAULT 'claimed',
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

  beforeEach(async () => {
    jest.clearAllMocks();
    fixture = await createScratchDb();
    db = fixture.db;
  });
  afterEach(async () => { if (fixture) await fixture.destroy(); });

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
        term_start: daysFromToday(-2), created_at: new Date(), renewal_charge_attempted_at: new Date(Date.now() - 3600000),
      });
      await db('stripe_invoice_charge_attempts').insert({ invoice_id: bareInvoice.id, status: 'failed' });

      const parent2 = await insertParent({ term_end: daysFromToday(-3) });
      const sentInvoice = await insertInvoice({ status: 'draft' });
      const submitted = await insertSuccessor(parent2, sentInvoice, {
        term_start: daysFromToday(-2), created_at: new Date(), renewal_charge_attempted_at: new Date(Date.now() - 3600000),
      });
      await db('stripe_invoice_charge_attempts').insert({ invoice_id: sentInvoice.id, status: 'ambiguous', submitted_at: new Date() });

      const counts = freshCounts();
      await Charge._private.reconcileStuckSuccessors({ conn: db, limit: 50, counts });

      expect(counts.reconcileNeverReachedStripeScanned).toBe(1);
      expect(mockSendViaSMSAndEmail).toHaveBeenCalledTimes(1);
      expect(mockSendViaSMSAndEmail).toHaveBeenCalledWith(bareInvoice.id, expect.any(Object));
      const stamped = await db('annual_prepay_terms').whereNotNull('renewal_charge_never_reached_stripe_belled_at').pluck('id');
      expect(stamped).toEqual([bare.id]);
      expect(stamped).not.toContain(submitted.id);
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
