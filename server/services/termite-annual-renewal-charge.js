'use strict';

// ============================================================
// termite-annual-renewal-charge.js — slice 6b: the automatic renewal charge
// for the Waves Subterranean Termite Protection annual plan (dark behind
// GATE_TERMITE_ANNUAL_PLAN). Owner ruling A-13: auto-charge the saved
// method at renewal under the consent captured in the v3 agreement;
// failure -> owner bell, at-most-once. This moves real money, so every
// path here is fail-closed: never charge twice, never guess a price.
//
// Runs as a daily sweep (registered alongside the other annual-prepay jobs
// in workflows/renewal-reminder.js) over THREE independent passes, each
// bounded and each tolerant of the others' failures:
//
//   1. bellNoWitnessTerms  — a termite term due for renewal that never got
//      its customer notice (notice_45_sent_at, or the older notice_30_sent_at
//      claim while the 45-day rung isn't live yet) is NEVER auto-charged —
//      the v3 agreement's authorization presumes the customer was actually
//      warned. Bells staff once per term (permanent dedupe) instead.
//   2. processRenewalCandidates — for every due, witnessed, undecided
//      termite term with no successor yet: mints the successor term +
//      its renewal invoice (§2), then decides whether to charge it (§3).
//   3. processGraceLapses — an unpaid successor more than 30 days past its
//      term_start voids its invoice (which cascades the term to
//      'cancelled' through the existing invoice-void -> annual-prepay sync
//      path), and raises the existing termite station-retrieval task.
//
// Design choices (see the lane's own commit message / PR description for
// the full rationale):
//   - The successor's renewal invoice charges EXACTLY parent.prepay_amount
//     — the same number slice 5's notice quoted. Never recomputed. taxRate
//     is pinned to an explicit 0, mirroring the ORIGINAL activation
//     invoice's frozen-zero convention (145a88c99d) — the renewal must not
//     silently pick up tax from a reclassification either.
//   - The parent is marked 'renewed' (renewal_decision='renew') the moment
//     the successor mints — NOT gated on the successor being paid. Read
//     coveredTermsAsOf (annual-prepay-renewals.js): a 'renewed' term's OWN
//     coverage window stays covered exactly as long as its OWN
//     prepay_invoice_id stays paid, which it already is (it was paid a year
//     ago) — marking 'renewed' immediately neither grants nor removes any
//     coverage. Waiting for the successor's payment would leave the parent
//     sitting 'active'/'renewal_pending' with a live successor already on
//     the books, which is a worse (more confusing) state for staff and for
//     every other renewal_decision-gated codepath (the 30/15/7-day notice
//     ladder, the online-nonrenewal endpoint) than simply calling the
//     decision made the instant the successor exists.
//   - The Stripe-attempt fence is a single stamped column
//     (annual_prepay_terms.renewal_charge_attempted_at), set with an atomic
//     `UPDATE ... WHERE renewal_charge_attempted_at IS NULL` BEFORE the
//     Stripe call, and NEVER re-checked afterward — "never re-attempt once
//     stamped" per the assignment, deliberately simpler than the
//     claim/outcome JSONB the signature-charge lane needed (that lane has
//     to coordinate the sign webhook AND a daily sweep hitting the SAME
//     target; this job is the only writer that ever touches a given
//     successor's charge decision, and it only ever runs once per
//     successor). The actual Stripe call goes through
//     StripeService.chargeInvoiceWithSavedCard — the SAME canonical
//     invoice-charge path termite-annual-signature-charge.js uses for the
//     initial charge — which owns its OWN durable claim/idempotency-key
//     fence for the Stripe attempt itself, records the payments-table row,
//     flips the invoice paid, and calls
//     AnnualPrepayRenewals.syncTermForInvoicePayment so the successor
//     becomes 'active' through the existing payment path. Reusing it
//     instead of the raw chargeSavedPaymentMethodOffSession primitive is a
//     deliberate trade: it costs the exact `termite-renewal-<id>`
//     idempotency-key string, but buys the whole existing invoice/payment
//     ledger instead of a second, parallel one (CLAUDE.md rule 15/16).
//   - maxAuthorizedChargeCents / maxAuthorizedTotalCents are both pinned to
//     the renewal invoice's own total (== prepay_amount, tax-free): a
//     credit-card surcharge that would push the collected total above the
//     quoted renewal fee is refused by chargeInvoiceWithSavedCard itself
//     (thrown, caught below as a decline) rather than silently collecting
//     more than prepay_amount.
//   - A crash between the attempt stamp committing and the Stripe call
//     actually firing is an accepted, narrow, fail-closed gap: the
//     successor is left stamped-but-never-attempted, open, with no bell.
//     There is no reconciliation sweep for this window in this slice — see
//     the lane's PR description for why, and the owner's options for a
//     follow-up if it ever matters in practice.
// ============================================================

const db = require('../models/db');
const logger = require('./logger');
const { etDateString, addETDays, parseETDateTime } = require('../utils/datetime-et');
const { addMonthsSameDay, dateOnlyString } = require('../utils/date-only');
const { gateEnvValue } = require('../config/feature-gates');

const RENEWABLE_STATUSES = ['active', 'renewal_pending'];
const PAYMENT_PENDING_STATUS = 'payment_pending';
const GRACE_DAYS = 30;
const RENEWAL_CHARGE_FAILED_SMS_KEY = 'termite_annual_renewal_charge_failed';

function termiteAnnualRenewalChargeLive() {
  return gateEnvValue('GATE_TERMITE_ANNUAL_PLAN');
}

function addDaysYmd(value, days) {
  const parsed = parseETDateTime(`${value}T12:00`);
  return etDateString(addETDays(parsed, Number(days) || 0));
}

// ---- shared queries ---------------------------------------------------

// A termite annual term due for its renewal transition: stamped with the
// annual-plan version (the marker every termite-annual codepath gates on —
// a non-termite annual-prepay term never carries it), still in a live
// (undecided) status, term_end already reached, and — the DB-level
// idempotency anchor — no successor minted for it yet.
function whereDueForRenewal(query, today) {
  return query
    .whereNotNull('t.annual_plan_version')
    .whereIn('t.status', RENEWABLE_STATUSES)
    .whereNull('t.renewal_decision')
    .where('t.term_end', '<=', today)
    .whereNotExists(function successorExists() {
      this.select(1).from('annual_prepay_terms as s').whereRaw('s.renewed_from_term_id = t.id');
    })
    .whereExists(function customerLive() {
      this.select(1).from('customers as c').whereRaw('c.id = t.customer_id').whereNull('c.deleted_at');
    });
}

// The renewal-notice witness: notice_45_sent_at is the termite-specific
// extended rung (slice A2); notice_30_sent_at is the generic annual-prepay
// ladder every term (termite or not) already carries. Either satisfies the
// "the customer was actually warned before we charge them" requirement —
// accepting the 30-day claim keeps this job usable even before the
// dedicated 45-day rung ships.
function whereNoticeWitnessed(query) {
  return query.where(function witnessed() {
    this.whereNotNull('t.notice_45_sent_at').orWhereNotNull('t.notice_30_sent_at');
  });
}

// ---- pass 1: no-witness exception bell ---------------------------------

async function bellNoWitnessTerms({ conn = db, limit = 200, today = etDateString(), counts }) {
  try {
    const rows = await whereDueForRenewal(
      conn('annual_prepay_terms as t'),
      today,
    )
      .whereNull('t.notice_45_sent_at')
      .whereNull('t.notice_30_sent_at')
      .orderBy('t.term_end', 'asc')
      .select('t.*')
      .limit(limit);
    counts.noWitnessScanned = rows.length;
    const NotificationService = require('./notification-service');
    for (const term of rows) {
      try {
        const result = await NotificationService.notifyAdmin(
          'billing',
          'Termite annual renewal due — no renewal notice on file',
          `The termite annual plan for customer ${term.customer_id} (term ${term.id}) reached its renewal date (${dateOnlyString(term.term_end)}) but was never sent a renewal notice (neither the 45-day nor the 30-day rung). The v3 agreement's auto-charge authorization presumes the customer was warned, so this term was NOT renewed or charged automatically. Send the notice, or renew/cancel it by hand from the customer's Annual Prepay panel.`,
          {
            icon: '⚠️',
            bell: true,
            link: `/admin/customers?customerId=${encodeURIComponent(term.customer_id)}`,
            // No dedupeWindowMs: this rings exactly once ever per term — a
            // fixed exception, not a recurring nag (the task's own words:
            // "bell staff once").
            dedupeKey: `termite-renewal-no-witness:${term.id}`,
            metadata: { termId: term.id, customerId: term.customer_id },
          },
        );
        if (result && !result.deduped && !result.suppressed) counts.noWitnessBelled += 1;
      } catch (err) {
        logger.error(`[termite-annual-renewal] no-witness bell failed for term ${term.id}: ${err.message}`);
      }
    }
  } catch (err) {
    logger.error(`[termite-annual-renewal] no-witness scan failed: ${err.message}`);
  }
}

// ---- pass 2: mint + charge ----------------------------------------------

// Mints the renewal successor (term + its renewal invoice) under a lock on
// the PARENT row, so two concurrent sweep ticks (or a retried tick) can
// only ever mint ONE successor per parent — the loser blocks on the lock,
// then finds the successor the winner already committed and no-ops.
// Returns { successor, minted: true } on a fresh mint, { successor,
// minted: false } when a successor already existed (this call did
// nothing), or null when the parent no longer qualifies under lock (a
// concurrent decision/cancel landed first).
async function mintRenewalSuccessor(parentTermId, conn = db) {
  const InvoiceService = require('./invoice');
  const AnnualPrepayRenewals = require('./annual-prepay-renewals');
  const { lockAndAssertNoAnnualPrepayOverlap } = require('../routes/admin-customers');

  return conn.transaction(async (trx) => {
    const parent = await trx('annual_prepay_terms').where({ id: parentTermId }).forUpdate().first();
    if (!parent) return null;
    const existingSuccessor = await trx('annual_prepay_terms').where({ renewed_from_term_id: parent.id }).first();
    if (existingSuccessor) return { successor: existingSuccessor, minted: false };
    if (!parent.annual_plan_version) return null;
    if (!RENEWABLE_STATUSES.includes(parent.status)) return null;
    if (parent.renewal_decision) return null;

    // term_end is INCLUSIVE (annual-prepay-renewals.js ~2640) — the
    // successor's coverage starts the very next day, or admin-customers.js's
    // overlap guard (start > previous end) would refuse it as overlapping
    // its own parent.
    const termStart = addDaysYmd(dateOnlyString(parent.term_end), 1);
    const termEnd = addMonthsSameDay(termStart, 12);

    // Same per-customer serialization every other annual-prepay writer
    // takes before minting a term — a concurrent admin action creating a
    // DIFFERENT annual prepay term for this customer while this job runs
    // must not overlap the successor's window. The successor's dates are
    // fully determined by the immutable parent, so this can never itself
    // conflict with the parent (termStart is strictly after parent's own
    // end) — it only guards against a THIRD party's term.
    await lockAndAssertNoAnnualPrepayOverlap(
      trx, parent.customer_id, termStart, false,
      'Customer already has an annual prepay term through',
    );

    const planLabel = parent.plan_label || 'Waves Subterranean Termite Protection';
    const prepayAmount = Number(parent.prepay_amount);
    if (!Number.isFinite(prepayAmount) || prepayAmount <= 0) {
      throw new Error(`parent term ${parent.id} has no valid prepay_amount to renew (${parent.prepay_amount})`);
    }

    const invoice = await InvoiceService.create({
      database: trx,
      customerId: parent.customer_id,
      title: `${planLabel} — Annual Renewal`,
      lineItems: [{
        description: `${planLabel} — annual renewal (${termStart} through ${termEnd})`,
        quantity: 1,
        unit_price: prepayAmount,
      }],
      notes: `Automatic annual renewal for the ${planLabel} plan. Covers ${termStart} through ${termEnd}. This is the exact renewal fee quoted in your renewal notice — no setup fee, no price change.`,
      dueDate: etDateString(),
      // Frozen zero, same convention as the original activation invoice
      // (145a88c99d) — a renewal must never pick up tax from a
      // reclassification that happened during the covered year.
      taxRate: 0,
      // Annual-prepay invoices settle inside this same flow (or the
      // customer's saved card, right after) — never accrued to a
      // third-party payer statement.
      skipAccrual: true,
    });
    if (!invoice?.id) throw new Error(`renewal invoice mint failed for parent term ${parent.id}`);

    // Frozen-price enforcement, mirroring the original activation's own
    // guard (estimate-converter.js): the minted invoice must equal the
    // quoted renewal fee to the cent, with no tax picked up.
    const mintedTotalCents = Math.round(Number(invoice.total) * 100);
    const expectedCents = Math.round(prepayAmount * 100);
    if (mintedTotalCents !== expectedCents || Math.round(Number(invoice.tax_amount || 0) * 100) !== 0) {
      throw new Error(`renewal invoice for term ${parent.id} does not match the quoted renewal fee (total ${invoice.total} vs ${prepayAmount}, tax ${invoice.tax_amount})`);
    }

    const successor = await AnnualPrepayRenewals.createTermForAnnualPrepay({
      customerId: parent.customer_id,
      prepayInvoiceId: invoice.id,
      planLabel,
      monthlyRate: parent.monthly_rate != null ? Number(parent.monthly_rate) : Math.round((prepayAmount / 12) * 100) / 100,
      prepayAmount,
      termStart,
      termEnd,
      coverageServiceType: parent.coverage_service_type || undefined,
      coverageVisitCount: parent.coverage_visit_count || undefined,
      coverageCadence: parent.coverage_cadence || undefined,
      annualPlanVersion: parent.annual_plan_version,
      renewedFromTermId: parent.id,
      conn: trx,
    });
    if (!successor?.id) throw new Error(`renewal successor mint returned no term for parent ${parent.id}`);

    // Mark the parent's renewal decision the moment the successor exists
    // (see the module header for why this is not gated on the successor's
    // payment). whereNull('renewal_decision') mirrors recordDecision's own
    // guard — belt-and-suspenders under the row lock we already hold.
    const decidedAt = new Date();
    await trx('annual_prepay_terms')
      .where({ id: parent.id })
      .whereNull('renewal_decision')
      .update({
        status: 'renewed',
        renewal_decision: 'renew',
        renewal_decision_at: decidedAt,
        updated_at: decidedAt,
      });

    return { successor, minted: true, parentId: parent.id };
  });
}

// Everything after the mint transaction commits: resolve consent + a
// chargeable saved method, and either attempt the ONE Stripe charge or
// hand the renewal off to the pay-link + bell fallback. Never throws.
async function decideAndCharge(successor, parentTerm, conn = db) {
  if (!parentTerm.renewal_charge_consent_at) {
    await deliverRenewalInvoice(successor);
    await ringRenewalBell(successor, 'no_consent', 'the prior term never recorded renewal-charge (Auto Pay) consent');
    return { status: 'no_consent' };
  }

  const RecurringCards = require('./recurring-card-on-file');
  let method = null;
  try {
    method = await RecurringCards.resolvePrepayChargeMethod({
      policy: { exemptReason: 'autopay_already_active' },
      customerId: successor.customer_id,
    });
  } catch (err) {
    logger.warn(`[termite-annual-renewal] saved-method resolution failed for term ${successor.id}: ${err.message}`);
    method = null;
  }
  if (!method?.paymentMethodRowId) {
    await deliverRenewalInvoice(successor);
    await ringRenewalBell(successor, 'no_method', 'no consented, chargeable saved payment method was found on file');
    return { status: 'no_method' };
  }

  // The ONE Stripe-attempt fence: stamped BEFORE the call, atomically, and
  // never re-checked afterward. A concurrent/retried tick that loses this
  // race sees 0 rows updated and does nothing further — no bell, no second
  // charge, no second delivery (whichever tick won already handles those).
  const claimed = await conn('annual_prepay_terms')
    .where({ id: successor.id })
    .whereNull('renewal_charge_attempted_at')
    .update({ renewal_charge_attempted_at: new Date() });
  if (!claimed) return { status: 'already_attempted' };

  const prepayAmountCents = Math.round(Number(successor.prepay_amount) * 100);
  try {
    const StripeService = require('./stripe');
    await StripeService.chargeInvoiceWithSavedCard(successor.prepay_invoice_id, method.paymentMethodRowId, {
      customerInitiated: false,
      maxAuthorizedChargeCents: prepayAmountCents,
      maxAuthorizedTotalCents: prepayAmountCents,
      requireAutopayForCustomerId: successor.customer_id,
      requireSelfPayCustomerId: successor.customer_id,
    });
  } catch (err) {
    await handleChargeFailure(successor, err);
    return { status: 'failed', reason: err.message };
  }

  logger.info(`[termite-annual-renewal] renewal charge succeeded for term ${successor.id} (invoice ${successor.prepay_invoice_id})`);
  return { status: 'charged' };
}

async function handleChargeFailure(successor, err) {
  const { classifyChargeError } = require('./termite-annual-signature-charge')._private;
  const classification = classifyChargeError(err);
  logger.error(`[termite-annual-renewal] renewal charge failed for term ${successor.id}: ${classification.status} (${classification.reason})`);
  await deliverRenewalInvoice(successor);
  await ringRenewalBell(successor, classification.status === 'ambiguous' ? 'ambiguous' : 'declined', classification.reason);
  // Best-effort customer notice — never blocks the bell/pay-link fallback
  // above, which are the load-bearing parts of this failure path.
  await sendRenewalChargeFailedNotice(successor).catch((noticeErr) => {
    logger.warn(`[termite-annual-renewal] charge-failed customer notice failed for term ${successor.id}: ${noticeErr.message}`);
  });
}

const RENEWAL_BELL_COPY = {
  no_consent: (successor) => ({
    title: 'Termite annual renewal — no auto-charge consent on file',
    body: `A renewal term for customer ${successor.customer_id} was minted (invoice for $${Number(successor.prepay_amount).toFixed(2)}), but the prior term never recorded renewal-charge consent — the card on file was NOT charged. The renewal invoice was sent with its pay link.`,
  }),
  no_method: (successor) => ({
    title: 'Termite annual renewal — no saved card to charge',
    body: `A renewal term for customer ${successor.customer_id} was minted (invoice for $${Number(successor.prepay_amount).toFixed(2)}), but no consented, chargeable saved payment method was found — the card on file was NOT charged. The renewal invoice was sent with its pay link.`,
  }),
  declined: (successor, reason) => ({
    title: 'Termite annual renewal — card on file declined',
    body: `The renewal charge of $${Number(successor.prepay_amount).toFixed(2)} for customer ${successor.customer_id}'s termite annual renewal failed: ${reason}. The renewal invoice was sent with its pay link instead. The card will NOT be retried automatically.`,
  }),
  ambiguous: (successor, reason) => ({
    title: 'Termite annual renewal — charge outcome unclear, needs reconciliation',
    body: `The renewal charge of $${Number(successor.prepay_amount).toFixed(2)} for customer ${successor.customer_id}'s termite annual renewal may or may not have gone through (${reason}). Check Stripe and the invoice before collecting any other way — the card will NOT be retried automatically.`,
  }),
};

async function ringRenewalBell(successor, kind, reason) {
  try {
    const NotificationService = require('./notification-service');
    const copy = (RENEWAL_BELL_COPY[kind] || RENEWAL_BELL_COPY.declined)(successor, reason);
    await NotificationService.notifyAdmin('billing', copy.title, copy.body, {
      icon: '⚠️',
      bell: true,
      link: `/admin/customers?customerId=${encodeURIComponent(successor.customer_id)}`,
      dedupeKey: `termite-renewal-charge:${successor.id}:${kind}`,
      metadata: { termId: successor.id, customerId: successor.customer_id, reason: reason || null },
    });
  } catch (err) {
    logger.error(`[termite-annual-renewal] bell failed for term ${successor.id}: ${err.message}`);
  }
}

// Delivers the renewal invoice (with its pay link) exactly once per call —
// best-effort; a delivery failure never blocks the bell above, which is
// what actually gets a human looking at the account.
async function deliverRenewalInvoice(successor) {
  try {
    const InvoiceService = require('./invoice');
    const result = await InvoiceService.sendViaSMSAndEmail(successor.prepay_invoice_id, {
      payUrlParams: {
        source: 'termite_annual_renewal', saveCard: '1', saveRequired: '1', billingTerm: 'prepay_annual',
      },
    });
    if (!result?.ok) {
      logger.warn(`[termite-annual-renewal] renewal invoice delivery not ok for term ${successor.id}: ${result?.error || 'unknown'}`);
    }
    return result;
  } catch (err) {
    logger.error(`[termite-annual-renewal] renewal invoice delivery failed for term ${successor.id}: ${err.message}`);
    return { ok: false, error: err.message };
  }
}

// The templated "your renewal payment didn't go through" notice — only
// ever queued from handleChargeFailure (a genuine decline/ambiguous
// outcome), never from the no-consent/no-method skip (nothing was
// attempted against Stripe there). Best-effort, never throws to the
// caller (its own caller already wraps it in .catch as a second layer).
// Sends only through the ordinary gated customer-messaging pipeline —
// nothing here bypasses quiet hours, opt-outs, or template enable state.
async function sendRenewalChargeFailedNotice(successor) {
  const customer = await db('customers').where({ id: successor.customer_id }).first();
  if (!customer?.phone) return { sent: false, reason: 'no_phone' };
  const invoice = await db('invoices').where({ id: successor.prepay_invoice_id }).first('token');
  const { publicPortalUrl } = require('../utils/portal-url');
  const payUrl = invoice?.token ? `${publicPortalUrl()}/pay/${invoice.token}` : null;
  if (!payUrl) return { sent: false, reason: 'no_pay_url' };
  const { renderSmsTemplate } = require('./sms-template-renderer');
  const body = await renderSmsTemplate(RENEWAL_CHARGE_FAILED_SMS_KEY, {
    first_name: customer.first_name || 'there',
    amount: Number(successor.prepay_amount).toFixed(2),
    pay_url: payUrl,
  }, { workflow: 'termite_annual_renewal_charge_failed', entity_type: 'annual_prepay_term', entity_id: successor.id });
  if (!body) return { sent: false, reason: 'missing_template' };
  const { sendCustomerMessage } = require('./messaging/send-customer-message');
  return sendCustomerMessage({
    to: customer.phone,
    body,
    channel: 'sms',
    audience: 'customer',
    purpose: 'payment_failure',
    customerId: customer.id,
    identityTrustLevel: 'phone_matches_customer',
    entryPoint: 'termite_annual_renewal_charge_failed',
    consentBasis: {
      status: 'opted_in',
      source: 'customer_service_notifications',
      capturedAt: customer.updated_at || customer.created_at || new Date().toISOString(),
    },
    metadata: { original_message_type: RENEWAL_CHARGE_FAILED_SMS_KEY, annual_prepay_term_id: successor.id },
  });
}

async function processRenewalCandidates({ conn = db, limit = 200, today = etDateString(), counts }) {
  try {
    const candidates = await whereNoticeWitnessed(whereDueForRenewal(conn('annual_prepay_terms as t'), today))
      .orderBy('t.term_end', 'asc')
      .select('t.*')
      .limit(limit);
    counts.candidatesScanned = candidates.length;
    for (const parent of candidates) {
      try {
        const mint = await mintRenewalSuccessor(parent.id, conn);
        if (!mint) { counts.skipped += 1; continue; }
        if (!mint.minted) { counts.skipped += 1; continue; } // another run already minted + decided this one
        counts.minted += 1;
        const outcome = await decideAndCharge(mint.successor, parent, conn);
        if (outcome.status === 'charged') counts.charged += 1;
        else if (outcome.status === 'failed') counts.failed += 1;
        else counts.skipped += 1;
      } catch (err) {
        counts.failed += 1;
        logger.error(`[termite-annual-renewal] renewal processing failed for parent term ${parent.id}: ${err.message}`);
      }
    }
  } catch (err) {
    logger.error(`[termite-annual-renewal] candidate scan failed: ${err.message}`);
  }
}

// ---- pass 3: grace lapse ------------------------------------------------

// An unpaid renewal successor more than GRACE_DAYS past its own term_start
// (per the v3 agreement's own text: "if it is not paid within 30 days
// coverage lapses and stations are retrieved"). Voiding the invoice
// cascades the term to 'cancelled' through the EXISTING invoice-void ->
// AnnualPrepayRenewals.syncTermForInvoicePayment path (invoice.js
// voidInvoice already calls it) — no parallel status-flip is written here.
// At-most-once by construction: a cancelled term no longer matches this
// scan's `status = 'payment_pending'` filter, voidInvoice's own re-entry on
// an already-void invoice is an idempotent repair (no-op past the first
// success), and the station-retrieval task's own dedupeKey is a third,
// independent safety net.
async function processGraceLapses({ conn = db, limit = 200, today = etDateString(), counts }) {
  try {
    const cutoff = addDaysYmd(today, -GRACE_DAYS);
    const candidates = await conn('annual_prepay_terms as t')
      .whereNotNull('t.annual_plan_version')
      .whereNotNull('t.renewed_from_term_id')
      .where('t.status', PAYMENT_PENDING_STATUS)
      .where('t.term_start', '<', cutoff)
      .orderBy('t.term_start', 'asc')
      .select('t.*')
      .limit(limit);
    counts.graceScanned = candidates.length;
    for (const term of candidates) {
      try {
        await processGraceLapseForTerm(term, conn);
        counts.graceLapsed += 1;
      } catch (err) {
        logger.error(`[termite-annual-renewal] grace lapse failed for term ${term.id}: ${err.message}`);
      }
    }
  } catch (err) {
    logger.error(`[termite-annual-renewal] grace-lapse scan failed: ${err.message}`);
  }
}

async function processGraceLapseForTerm(term, conn = db) {
  const InvoiceService = require('./invoice');
  if (term.prepay_invoice_id) {
    // voidInvoice self-heals: re-entry on an already-void invoice re-runs
    // its idempotent annual-prepay sync rather than erroring, so a prior
    // partial run (invoice voided, sync lost) repairs on the next tick
    // instead of being skipped forever.
    await InvoiceService.voidInvoice(term.prepay_invoice_id);
  }
  const { raiseTermiteRetrievalTask } = require('./cancellation-processor');
  await raiseTermiteRetrievalTask(term.customer_id, null, {
    retrieveAfter: null,
    termId: term.id,
    // No real churn episode backs a non-payment lapse — a stable literal
    // keeps this raise's dedupe key scoped to THIS term (see the function's
    // own termKeyed contract), distinct from any cancellation-request-driven
    // retrieval task for the same customer.
    episodeKey: 'renewal_grace_lapse',
  });
}

// ---- entry point ----------------------------------------------------------

/**
 * Daily sweep entry point — registered alongside the other annual-prepay
 * jobs (server/services/workflows/renewal-reminder.js). No-op end to end
 * while GATE_TERMITE_ANNUAL_PLAN is off (read fresh on every call; no
 * restart needed to flip it).
 */
async function runTermiteAnnualRenewalSweep({ conn = db, limit = 200, today = etDateString() } = {}) {
  const counts = {
    noWitnessScanned: 0, noWitnessBelled: 0,
    candidatesScanned: 0, minted: 0, charged: 0, failed: 0, skipped: 0,
    graceScanned: 0, graceLapsed: 0,
  };
  if (!termiteAnnualRenewalChargeLive()) return { ...counts, gate: 'off' };
  if (!(await db.schema.hasTable('annual_prepay_terms'))) return { ...counts, gate: 'on', tableMissing: true };

  await bellNoWitnessTerms({ conn, limit, today, counts });
  await processRenewalCandidates({ conn, limit, today, counts });
  await processGraceLapses({ conn, limit, today, counts });
  return { ...counts, gate: 'on' };
}

module.exports = {
  runTermiteAnnualRenewalSweep,
  termiteAnnualRenewalChargeLive,
  _private: {
    mintRenewalSuccessor,
    decideAndCharge,
    processGraceLapseForTerm,
    whereDueForRenewal,
    whereNoticeWitnessed,
    addDaysYmd,
    GRACE_DAYS,
  },
};
