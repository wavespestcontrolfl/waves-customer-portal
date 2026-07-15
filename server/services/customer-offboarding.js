const db = require('../models/db');
const logger = require('./logger');

// Deposit-stage cancellation orchestration (owner-scoped 2026-07-15):
// a customer who accepted an estimate, paid a deposit, and cancelled before
// any money beyond the deposit was collected. One admin action replaces the
// manual sequence across three pages + the Stripe dashboard:
//
//   1. void the unpaid signup invoice(s)  — the existing void side effects
//      cancel the annual-prepay term, reset billing_mode, restore the
//      deposit credit (credited → received), and stop dunning
//   2. cancel every non-terminal scheduled visit (business-initiated:
//      card-hold late-cancel fees are waived)
//   3. clear the membership tier (customer stays ACTIVE — "No Plan")
//   4. refund the deposit remainder at FACE VALUE (surcharge stays earned —
//      owner ruling 2026-07-15), Stripe touched LAST so the DB never trails
//      the money
//   5. send the combined cancellation-confirmed + refund-issued email
//
// ORDER IS LOAD-BEARING: voiding before refunding is what turns a credited
// deposit back into an unapplied 'received' row, so the refund reconciles
// cleanly instead of tripping the manual-reconciliation alert.
//
// Paid/mid-term cancellations are deliberately OUT of scope — a term with
// collected money needs a proration decision, which is the owner's, not
// this service's. Every guard below fails toward "blocked and loud".

const TERMINAL_VISIT_STATUSES = ['completed', 'skipped', 'no_show', 'cancelled'];
// Mirrors cancellation-processor: only not-yet-started visits auto-cancel.
// Live in-progress work (en_route / on_site) blocks the flow — a tech
// rolling or on property is a dispatch decision, not a button's.
const CANCELLABLE_VISIT_STATUSES = ['pending', 'confirmed', 'rescheduled'];
// track_state values that mean a tech is actively working the visit right
// now (same list as cancellation-processor).
const LIVE_TRACK_STATES = ['en_route', 'on_property'];
// Statuses voidInvoice would refuse; preview mirrors them so the modal can
// explain the block instead of the void throwing mid-run. 'prepaid' is NOT
// listed: a credit-covered prepaid invoice (no payment_recorded_at, no
// payments row) is legitimately voidable and voidInvoice restores its
// credit; the cash-backed variant is caught by payment_recorded_at here
// and by voidInvoice's own money guards at execute time.
const NON_VOIDABLE_INVOICE_STATUSES = ['paid', 'processing', 'refunded'];
// Terms with collected money — presence of any of these blocks the flow.
// 'renewed'/'switch_plan' are DECIDED_COVERED_STATUSES in
// annual-prepay-renewals: still a paid coverage window, still a proration
// decision this service leaves to the owner.
const PAID_TERM_STATUSES = ['active', 'renewal_pending', 'renewed', 'switch_plan'];

function toCents(value) {
  return Math.round(Number(value || 0) * 100);
}

function parseLineItems(invoice) {
  try {
    const raw = invoice?.line_items;
    const arr = typeof raw === 'string' ? JSON.parse(raw) : raw;
    return Array.isArray(arr) ? arr : [];
  } catch {
    return [];
  }
}

// Resolve EVERY invoice carrying a deposit's credit. consumeDepositCredit
// stamps credited_invoice_id only on the invoice that fully consumed the
// row — when the credit split across invoices, the earlier partial ones
// are identifiable only by their deposit_credit line, and all of them must
// void for the full face value to become refundable.
async function invoicesCarryingDepositCredit(row) {
  const found = new Map();
  const candidates = await db('invoices')
    .where({ customer_id: row.customer_id })
    .whereNot({ status: 'void' })
    .select('*');
  for (const inv of candidates) {
    if (parseLineItems(inv).some(
      (item) => item?.category === 'deposit_credit' && item?.estimate_id === row.estimate_id,
    )) {
      found.set(inv.id, inv);
    }
  }
  if (row.credited_invoice_id && !found.has(row.credited_invoice_id)) {
    const stamped = await db('invoices').where({ id: row.credited_invoice_id }).first();
    if (stamped && String(stamped.status) !== 'void') found.set(stamped.id, stamped);
  }
  return [...found.values()];
}

// Everything the confirm modal shows, and every reason the run would be
// refused. Re-run by the POST handler immediately before executing so a
// stale modal can't authorize a run the current state forbids.
async function previewCancelSignup(customerId) {
  const customer = await db('customers')
    .where({ id: customerId })
    .first('id', 'first_name', 'last_name', 'waveguard_tier', 'billing_mode', 'active');
  if (!customer) {
    const err = new Error('Customer not found');
    err.status = 404;
    throw err;
  }

  const blockers = [];

  const deposits = await db('estimate_deposits')
    .where({ customer_id: customerId })
    .whereIn('status', ['received', 'credited', 'refunding'])
    .select('id', 'estimate_id', 'status', 'amount', 'credited_amount', 'refunded_amount', 'card_surcharge', 'credited_invoice_id', 'customer_id');

  if (deposits.some((d) => d.status === 'refunding')) {
    blockers.push('a deposit refund is already in flight — retry after it settles');
  }

  const refundableDeposits = deposits.filter((d) => ['received', 'credited'].includes(d.status));
  let refundTotalCents = 0;
  const invoicesToVoid = new Map();

  for (const row of refundableDeposits) {
    const remainderCents = toCents(row.amount) - toCents(row.refunded_amount);
    if (remainderCents <= 0) continue;
    refundTotalCents += remainderCents;
    if (toCents(row.credited_amount) > 0) {
      const carrying = await invoicesCarryingDepositCredit(row);
      if (carrying.length === 0) {
        blockers.push('a deposit credit could not be traced to its invoice — manual reconciliation required');
        continue;
      }
      for (const invoice of carrying) {
        if (NON_VOIDABLE_INVOICE_STATUSES.includes(String(invoice.status)) || invoice.payment_recorded_at) {
          blockers.push(`deposit credit sits on ${invoice.invoice_number || 'an invoice'} which is ${invoice.status} — refund that payment instead`);
          continue;
        }
        invoicesToVoid.set(invoice.id, invoice);
      }
    }
  }

  if (refundTotalCents <= 0) {
    blockers.push('no refundable deposit on file');
  }

  // Annual-prepay terms: a payment_pending term cancels via its invoice
  // void; a term with collected money blocks the whole flow.
  const terms = await db('annual_prepay_terms')
    .where({ customer_id: customerId })
    .whereNot({ status: 'cancelled' })
    .select('id', 'status', 'plan_label', 'prepay_invoice_id', 'prepay_amount', 'term_start', 'term_end');
  for (const term of terms) {
    if (PAID_TERM_STATUSES.includes(String(term.status))) {
      blockers.push(`annual prepay term is ${term.status} (money collected) — out of scope for signup cancellation`);
      continue;
    }
    if (term.prepay_invoice_id && !invoicesToVoid.has(term.prepay_invoice_id)) {
      const invoice = await db('invoices').where({ id: term.prepay_invoice_id }).first();
      if (invoice && String(invoice.status) !== 'void') {
        if (NON_VOIDABLE_INVOICE_STATUSES.includes(String(invoice.status)) || invoice.payment_recorded_at) {
          blockers.push(`prepay invoice ${invoice.invoice_number || ''} is ${invoice.status} — refund that payment instead`);
        } else {
          invoicesToVoid.set(invoice.id, invoice);
        }
      }
    }
  }

  // Live tracker states lead the legacy status column (track-transitions
  // flips track_state first, status sync is best-effort) — a visit with a
  // tech en route can still read status=confirmed. Same guard as
  // cancellation-processor's LIVE_TRACK_STATES.
  const candidateVisits = await db('scheduled_services')
    .where({ customer_id: customerId })
    .whereIn('status', CANCELLABLE_VISIT_STATUSES)
    .select('id', 'status', 'scheduled_date', 'service_type', 'track_state')
    .orderBy('scheduled_date', 'asc');
  const liveTracked = candidateVisits.filter((v) => LIVE_TRACK_STATES.includes(String(v.track_state)));
  const visits = candidateVisits.filter((v) => !LIVE_TRACK_STATES.includes(String(v.track_state)));

  const inProgress = await db('scheduled_services')
    .where({ customer_id: customerId })
    .whereNotIn('status', [...TERMINAL_VISIT_STATUSES, ...CANCELLABLE_VISIT_STATUSES])
    .select('id', 'status');
  const liveStates = [
    ...inProgress.map((v) => v.status),
    ...liveTracked.map((v) => v.track_state),
  ];
  if (liveStates.length > 0) {
    blockers.push(`a visit is in progress (${liveStates.join(', ')}) — resolve it on the dispatch board first`);
  }

  // Money collected on ANY visit (paid/processing invoice or recorded
  // payment) is beyond the deposit stage — including already-completed
  // visits this flow won't touch. The mid-term/proration decision is the
  // owner's, not this flow's.
  const paidVisitInvoices = await db('invoices')
    .where({ customer_id: customerId })
    .whereNotNull('scheduled_service_id')
    .where((qb) => {
      qb.whereIn('status', ['paid', 'processing']).orWhereNotNull('payment_recorded_at');
    })
    .select('id', 'invoice_number', 'status');
  if (paidVisitInvoices.length > 0) {
    blockers.push(`a visit invoice is ${paidVisitInvoices[0].status} (${paidVisitInvoices[0].invoice_number || paidVisitInvoices[0].id}) — money collected beyond the deposit; out of scope`);
  }

  return {
    eligible: blockers.length === 0,
    blockers,
    customer: {
      id: customer.id,
      tier: customer.waveguard_tier || null,
      billingMode: customer.billing_mode || null,
    },
    refundTotal: refundTotalCents / 100,
    deposits: refundableDeposits.map((d) => ({
      id: d.id,
      estimateId: d.estimate_id,
      status: d.status,
      amount: Number(d.amount || 0),
      refundedAmount: Number(d.refunded_amount || 0),
    })),
    invoices: [...invoicesToVoid.values()].map((inv) => ({
      id: inv.id,
      invoiceNumber: inv.invoice_number,
      status: inv.status,
      total: Number(inv.total || 0),
      annualPrepayTermId: inv.annual_prepay_term_id || null,
    })),
    terms: terms.map((t) => ({
      id: t.id,
      status: t.status,
      planLabel: t.plan_label || null,
      prepayAmount: t.prepay_amount != null ? Number(t.prepay_amount) : null,
    })),
    visits: visits.map((v) => ({
      id: v.id,
      status: v.status,
      serviceDate: v.scheduled_date,
      serviceType: v.service_type,
    })),
  };
}

// Cancel one visit with the exact side-effect set the schedule bulk-cancel
// runs (business-initiated: hold fees waived). Idempotent — an already-
// cancelled row reruns the handlers harmlessly. Returns the visit's open
// invoices the best-effort void sweep could NOT resolve (in-flight PI,
// frozen statement, money racing in) so the caller can refuse to refund
// past them.
async function cancelVisitForOffboarding(visit, { actorId }) {
  // Re-read at cancel time: the preview's live-tracker guard is a snapshot,
  // and a tech can flip en_route between the preview and this write (the
  // tracker also LEADS the legacy status, so the row can still read
  // confirmed). Same fresh-read discipline as cancellation-processor —
  // active work is dispatch's call, never this button's.
  const fresh = await db('scheduled_services')
    .where({ id: visit.id })
    .first('status', 'track_state');
  if (!fresh) throw new Error('visit no longer exists');
  if (LIVE_TRACK_STATES.includes(String(fresh.track_state))) {
    throw new Error(`visit is live (${fresh.track_state}) — left for dispatch`);
  }
  if (![...CANCELLABLE_VISIT_STATUSES, 'cancelled'].includes(String(fresh.status))) {
    throw new Error(`visit is ${fresh.status} — left for dispatch`);
  }
  const { transitionJobStatus } = require('./job-status');
  await db.transaction(async (trx) => {
    await transitionJobStatus({
      jobId: visit.id,
      fromStatus: fresh.status,
      toStatus: 'cancelled',
      transitionedBy: actorId || null,
      notes: 'Signup cancellation',
      trx,
    });
  });
  try {
    const AppointmentReminders = require('./appointment-reminders');
    await AppointmentReminders.handleCancellation(visit.id);
  } catch {}
  try {
    const { cancelCallFollowUpsForParentCancel } = require('./call-booking-catalog');
    await cancelCallFollowUpsForParentCancel({ conn: db, parentServiceId: visit.id });
  } catch (e) {
    logger.error(`[customer-offboarding] call follow-up cascade failed for ${visit.id}: ${e.message}`);
  }
  // Customer-visible track layer (mirrors cancellation-processor): the
  // public tracking payload derives cancelled state from track_state, so a
  // live track_view_token would keep showing the visit as scheduled after
  // the status flip. Normalize legacy NULL rows to 'scheduled' first so the
  // helper's guarded update matches and stamps cancelled_at.
  try {
    await db('scheduled_services')
      .where({ id: visit.id })
      .whereNull('track_state')
      .update({ track_state: 'scheduled' });
    const trackTransitions = require('./track-transitions');
    const trackResult = await trackTransitions.cancel(visit.id, { reason: 'Signup cancellation', actorId: actorId || null });
    if (!trackResult || trackResult.ok !== true) {
      logger.error(`[customer-offboarding] track-layer cancel not ok for ${visit.id}: ${(trackResult && trackResult.reason) || 'unknown'}`);
    }
  } catch (e) {
    logger.error(`[customer-offboarding] track-layer cancel failed for ${visit.id}: ${e.message}`);
  }
  const InvoiceService = require('./invoice');
  await InvoiceService.voidOpenInvoicesForCancelledService(visit.id);
  // The sweep is best-effort by design (unverifiable PI, frozen statement,
  // money racing in all log-and-skip) — re-query so a skipped invoice is a
  // reported fact, not a silent one.
  const unresolvedInvoices = await db('invoices')
    .where({ scheduled_service_id: visit.id })
    .whereIn('status', InvoiceService.CANCELLED_SERVICE_VOIDABLE_STATUSES)
    .select('id', 'invoice_number', 'status');
  try {
    const CardHolds = require('./estimate-card-holds');
    await CardHolds.handleCardHoldCancellation({ scheduledServiceId: visit.id, waiveFee: true });
  } catch (e) {
    logger.error(`[customer-offboarding] card-hold handling failed for ${visit.id}: ${e.message}`);
  }
  return { unresolvedInvoices };
}

async function cancelSignupAndRefundDeposit(customerId, { actorId = null } = {}) {
  const preview = await previewCancelSignup(customerId);
  if (!preview.eligible) {
    const err = new Error(`Signup cancellation blocked: ${preview.blockers.join('; ')}`);
    err.status = 409;
    err.blockers = preview.blockers;
    throw err;
  }

  const result = {
    invoicesVoided: [],
    visitsCancelled: 0,
    visitFailures: [],
    tierCleared: false,
    refunded: 0,
    email: null,
  };

  // 1. Void the unpaid signup invoice(s). voidInvoice re-runs its own hard
  // money guards under a row lock, cancels the linked annual-prepay term,
  // resets billing_mode, and restores the deposit credit. A failure here
  // aborts the run BEFORE any visit or money is touched.
  const InvoiceService = require('./invoice');
  for (const inv of preview.invoices) {
    const voided = await InvoiceService.voidInvoice(inv.id);
    result.invoicesVoided.push(voided.invoice_number || inv.id);
  }

  // 2. Stop any recurring series BEFORE sweeping visits (mirrors
  // cancellation-processor): a racing completion reads recurring_ongoing
  // and would otherwise mint a fresh pending visit behind the sweep.
  await db('scheduled_services')
    .where({ customer_id: customerId, recurring_ongoing: true })
    .update({ recurring_ongoing: false, updated_at: db.fn.now() });

  // Cancel every cancellable visit. Per-visit failure isolation (mirrors
  // schedule bulk-cancel); failures and invoices the void sweep could not
  // resolve are collected — either one gates the refund below.
  const unresolvedInvoices = [];
  const cancelOne = async (visit) => {
    try {
      const { unresolvedInvoices: leftover } = await cancelVisitForOffboarding(visit, { actorId });
      result.visitsCancelled += 1;
      unresolvedInvoices.push(...leftover);
    } catch (e) {
      result.visitFailures.push({ id: visit.id, reason: e.message });
    }
  };
  for (const visit of preview.visits) await cancelOne(visit);
  // Straggler re-sweep: an auto-extension already in flight past the flag
  // flip can land after the preview read — catch anything cancellable that
  // appeared since.
  const stragglers = await db('scheduled_services')
    .where({ customer_id: customerId })
    .whereIn('status', CANCELLABLE_VISIT_STATUSES)
    .whereNotIn('id', preview.visits.map((v) => v.id))
    .select('id', 'status');
  for (const visit of stragglers) await cancelOne(visit);
  result.unresolvedInvoices = unresolvedInvoices.map((inv) => inv.invoice_number || inv.id);

  // 3. No Plan: clear the tier AND the monthly rate, keep the record ACTIVE
  // (win-back visible; owner ruling 2026-07-15). monthly_rate must go too —
  // the monthly billing cron selects active customers by monthly_rate > 0,
  // so a lingering rate would keep a "No Plan" customer billable. NULL, not
  // 0 (repo rule: 0 means "charge nothing", NULL means "no rate").
  // billing_mode was already reset by the term cancellation riding the
  // invoice void.
  // Per-application signups stamp billing_mode='per_application' +
  // per_application_fee at acceptance, and no term sync resets them — a
  // stale fee would let a straggler completion still price per-visit.
  // Re-read AFTER the voids: an annual-prepay term cancel restores the
  // customer's PRIOR mode, which can itself be 'per_application' — the
  // preview snapshot predates that restore. (NULL mode + NULL rate = the
  // monthly cron has nothing to charge.)
  const freshCustomer = await db('customers')
    .where({ id: customerId })
    .first('billing_mode');
  const perApplication = freshCustomer?.billing_mode === 'per_application';
  const tierCleared = await db('customers')
    .where({ id: customerId })
    .where((qb) => {
      qb.whereNotNull('waveguard_tier').orWhere('monthly_rate', '>', 0);
      if (perApplication) qb.orWhere('billing_mode', 'per_application');
    })
    .update({
      waveguard_tier: null,
      monthly_rate: null,
      ...(perApplication ? { billing_mode: null, per_application_fee: null } : {}),
      updated_at: db.fn.now(),
    });
  result.tierCleared = tierCleared > 0;

  // 4. Refund the deposit remainder — but only past a CLEAN sweep. A visit
  // left uncancelled or an invoice the best-effort void skipped (in-flight
  // PI, frozen statement) means this account isn't cleanly at the deposit
  // stage: refunding past it could hand money back while a live pay
  // session or dunning still collects. Deposits stay 'received', so a
  // re-run after the human resolves the leftover picks the refund up.
  if (result.visitFailures.length > 0 || unresolvedInvoices.length > 0) {
    result.refundSkipped = 'unresolved visits/invoices — resolve them, then run this again to issue the refund';
    result.email = { ok: false, skipped: true, reason: 'refund_skipped' };
    logger.warn('[customer-offboarding] refund skipped — unresolved visits/invoices', {
      customerId,
      visitFailures: result.visitFailures,
      unresolvedInvoices: result.unresolvedInvoices,
    });
    return result;
  }

  // Face value only, Stripe last. The sweep owns the claim discipline; a
  // Stripe failure reverts the claim, raises the reconcile alert, and this
  // run still reports what happened.
  const { refundUnconsumedDeposits } = require('./estimate-deposits');
  const estimateIds = [...new Set(preview.deposits.map((d) => d.estimateId).filter(Boolean))];
  for (const estimateId of estimateIds) {
    const { refunded } = await refundUnconsumedDeposits({
      estimateId,
      reason: 'cancel_signup',
      includeSurchargeShare: false,
    });
    result.refunded += refunded;
  }

  // 5. Combined cancellation + refund email — only once money actually
  // moved. Re-runs retry a failed send for money refunded on a PRIOR run
  // (the idempotency key dedupes an already-delivered one); refundedTotal
  // re-reads the ledger so the email states what Stripe actually returned.
  const depositIds = preview.deposits.map((d) => d.id).sort();
  const ledgerRows = await db('estimate_deposits')
    .whereIn('id', depositIds)
    .select('refunded_amount');
  const refundedTotal = ledgerRows.reduce((sum, r) => sum + Number(r.refunded_amount || 0), 0);
  if (refundedTotal > 0) {
    const PaymentLifecycleEmail = require('./payment-lifecycle-email');
    // The key carries the CUMULATIVE refunded cents: a retry that refunds a
    // deposit the first run couldn't must send a corrected email with the
    // new total, while an identical re-run still dedupes.
    const refundedCents = Math.round(refundedTotal * 100);
    result.email = await PaymentLifecycleEmail.sendCancellationRefundIssued({
      customerId,
      refundAmount: refundedTotal,
      refundDate: new Date(),
      planLabel: preview.terms[0]?.planLabel || preview.customer.tier || '',
      idempotencyKey: `account.cancellation_refund:${customerId}:${depositIds.join(',')}:${refundedCents}`,
    });
  } else {
    result.email = { ok: false, skipped: true, reason: 'no_refund_recorded' };
  }

  // Admin bell only when money actually moved — a failed/no-op run must
  // not look like a successful $0.00 refund.
  if (refundedTotal > 0) {
    try {
      const { triggerNotification } = require('./notification-triggers');
      const customer = await db('customers').where({ id: customerId }).first('first_name', 'last_name');
      await triggerNotification('payment_refunded', {
        amount: refundedTotal,
        customerName: [customer?.first_name, customer?.last_name].filter(Boolean).join(' '),
        isFullRefund: true,
      });
    } catch (e) {
      logger.warn(`[customer-offboarding] admin refund notification failed: ${e.message}`);
    }
  }

  logger.info('[customer-offboarding] signup cancelled', {
    customerId,
    invoicesVoided: result.invoicesVoided,
    visitsCancelled: result.visitsCancelled,
    visitFailures: result.visitFailures.length,
    refunded: result.refunded,
  });
  return result;
}

module.exports = {
  previewCancelSignup,
  cancelSignupAndRefundDeposit,
  _private: {
    invoicesCarryingDepositCredit,
    cancelVisitForOffboarding,
  },
};
