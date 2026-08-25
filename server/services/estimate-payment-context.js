// ============================================================
// estimate-payment-context.js
//
// Exact, ledger-backed payment posture for an estimate-linked appointment.
// Answers "how is this customer paying, and what have they actually paid,
// down to the cent" without anyone re-opening the estimate:
//
//   - Annual prepay:  the annual_prepay_terms row (tax-inclusive amount the
//     customer was invoiced) + its prepay invoice's real paid state.
//   - Pay per application: the acceptance invoice the converter minted
//     ("WaveGuard Membership Setup [+ First Application]") with the exact
//     setup-fee / first-application line amounts and whether it was paid.
//
// Every figure comes from a persisted row (terms, invoices, line items) —
// never recomputed from pricing — so what the card shows is what was charged.
//
// Read-only and fail-soft throughout: a payment read must never block the
// scheduling surfaces, so every branch degrades to null rather than throwing.
// Consumed by the /admin/schedule/:id/estimate-source route and the customer
// estimates-for-scheduling payload (New Appointment modal).
// ============================================================

const db = require('../models/db');
const logger = require('./logger');
// Shared terminal-status set so "remaining" counts visits the same way the
// prepaid-series banner and Customer 360 rollup do.
const { TERMINAL_STATUSES } = require('./prepaid-series');

// Terms in these statuses are paid coverage (mirrors ACTIVE_STATUSES in
// annual-prepay-renewals.js). payment_pending resolves through the invoice.
const TERM_PAID_STATUSES = new Set(['active', 'renewal_pending']);
// 'prepaid' is the account-credit close-out; both leave AR (invoice.js).
const INVOICE_PAID_STATUSES = new Set(['paid', 'prepaid']);
// Never surface a dead acceptance invoice as the billing record.
const INVOICE_DEAD_STATUSES = ['void', 'cancelled', 'canceled', 'refunded'];

const SETUP_FEE_RE = /setup fee/i;
const FIRST_APPLICATION_RE = /first (service )?application/i;

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function lineItemsArray(invoice) {
  const raw = invoice?.line_items;
  if (Array.isArray(raw)) return raw;
  if (typeof raw === 'string') {
    try {
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }
  return [];
}

function lineAmount(li) {
  const unit = num(li?.unit_price ?? li?.unitPrice ?? li?.price ?? li?.amount) || 0;
  const qty = num(li?.quantity) || 1;
  return Math.round(unit * qty * 100) / 100;
}

// Exact dollars a matching line item actually billed. Null (not 0) when no
// line matches, so the card can distinguish "no setup fee on this plan" from
// "setup fee of $0".
function sumMatchingLines(invoice, re) {
  let found = false;
  let total = 0;
  for (const li of lineItemsArray(invoice)) {
    if (!re.test(String(li?.description || ''))) continue;
    found = true;
    total += lineAmount(li);
  }
  return found ? Math.round(total * 100) / 100 : null;
}

function invoiceIsPaid(invoice) {
  if (!invoice) return false;
  return INVOICE_PAID_STATUSES.has(String(invoice.status || '').toLowerCase()) || !!invoice.paid_at;
}

// The visit's own term link wins (a renewal customer can hold more than one
// term over time); fall back to the term minted at accept for this estimate
// (annual_prepay_terms.source_estimate_id is unique per estimate).
async function resolveAnnualPrepayTerm(estimate, scheduledServiceId) {
  if (scheduledServiceId) {
    try {
      const ss = await db('scheduled_services')
        .where({ id: scheduledServiceId })
        .first('annual_prepay_term_id');
      if (ss?.annual_prepay_term_id) {
        const term = await db('annual_prepay_terms').where({ id: ss.annual_prepay_term_id }).first();
        if (term) return term;
      }
    } catch (err) {
      logger.warn('[estimate-payment-context] visit term read failed', { error: err.message });
    }
  }
  if (!estimate?.id) return null;
  try {
    return await db('annual_prepay_terms')
      .where({ source_estimate_id: estimate.id })
      .orderBy('created_at', 'desc')
      .first() || null;
  } catch (err) {
    logger.warn('[estimate-payment-context] estimate term read failed', { error: err.message });
    return null;
  }
}

// Canonical "is this term's paid coverage still valid" — reuses the shared
// coveredTermsAsOf predicate (annual-prepay-renewals): covered status guard,
// prepay invoice not void/cancelled/refunded, AND no full refund on the
// payments row. The Stripe refund webhook flips the PAYMENT row, not
// invoices.status, so a bare invoice paid/paid_at check would render a
// refunded prepay as "paid — do not collect". coverageDate null: the question
// here is "was it paid and is that money still good", not "covered today".
// Returns null (unknown) on a read failure so the caller can fall back to the
// webhook-maintained term status instead of flipping a paid plan to pending.
async function termCoverageStillValid(term) {
  if (!term?.id) return false;
  try {
    const AnnualPrepayRenewals = require('./annual-prepay-renewals');
    const row = await AnnualPrepayRenewals.coveredTermsAsOf(db, null)
      .where('t.id', term.id)
      .first('t.id');
    return !!row;
  } catch (err) {
    logger.warn('[estimate-payment-context] coverage predicate failed — falling back to term status', { error: err.message });
    return null;
  }
}

// "Visit X of Y · N remaining" usage for a prepay term, from the visits the
// coverage machinery linked to it (scheduled_services.annual_prepay_term_id).
// totalVisits prefers the SOLD count (coverage_visit_count) so a partially
// seeded series still reads "of 4"; used = completed covered visits;
// remaining = sold minus used (never negative). visitNumber is this
// appointment's 1-based position among the live covered visits by date —
// null when the visit isn't linked to the term (e.g. a coverage gap), so the
// card falls back to the used/total phrasing instead of inventing a slot.
async function summarizeTermVisitUsage(term, scheduledServiceId) {
  if (!term?.id) return null;
  try {
    const rows = await db('scheduled_services')
      .where({ annual_prepay_term_id: term.id })
      .orderBy('scheduled_date', 'asc')
      .select('id', 'status', 'scheduled_date');
    if (!Array.isArray(rows) || !rows.length) return null;
    const live = rows.filter((r) => {
      const status = String(r.status || '').toLowerCase();
      return status === 'completed' || !TERMINAL_STATUSES.has(status);
    });
    if (!live.length) return null;
    const soldCount = term.coverage_visit_count != null ? Number(term.coverage_visit_count) : null;
    const totalVisits = Number.isInteger(soldCount) && soldCount > 0 ? soldCount : live.length;
    const visitsUsed = live.filter((r) => String(r.status || '').toLowerCase() === 'completed').length;
    const idx = scheduledServiceId
      ? live.findIndex((r) => String(r.id) === String(scheduledServiceId))
      : -1;
    return {
      totalVisits,
      visitsUsed,
      visitsRemaining: Math.max(0, totalVisits - visitsUsed),
      visitNumber: idx >= 0 ? idx + 1 : null,
    };
  } catch (err) {
    logger.warn('[estimate-payment-context] term visit usage read failed', { error: err.message });
    return null;
  }
}

// The pay-per-application invoice the converter minted at accept. Its id is
// not persisted on the estimate row, but the converter always writes
// "accepted estimate #<uuid>" into the invoice notes, and a uuid in that
// marker is unambiguous — so the notes match IS the link. Annual-prepay
// invoices carry the SAME estimate marker, so also require the converter's
// pay-per-application phrase ("Customer selected pay per application") —
// otherwise a legacy/manual prepay whose term row can't be read would render
// under "Billing: Per application". A standard invoice without the phrase
// simply isn't found (fail closed to no billing claim). Earliest live invoice
// wins (the acceptance invoice predates any later manual billing that might
// echo the phrase).
async function findAcceptanceInvoice(estimate) {
  if (!estimate?.id || !estimate?.customer_id) return null;
  try {
    return await db('invoices')
      .where({ customer_id: estimate.customer_id })
      .whereNotIn('status', INVOICE_DEAD_STATUSES)
      .where('notes', 'like', `%accepted estimate #${estimate.id}%`)
      .where('notes', 'like', '%selected pay per application%')
      .orderBy('created_at', 'asc')
      .first() || null;
  } catch (err) {
    logger.warn('[estimate-payment-context] acceptance invoice read failed', { error: err.message });
    return null;
  }
}

// The accept-time payment choice persisted on the committed scheduled service
// ('card_on_file' | 'deposit_now' | 'pay_at_visit' | 'prepay_annual').
async function readPaymentPreference(scheduledServiceId) {
  if (!scheduledServiceId) return null;
  try {
    const ss = await db('scheduled_services')
      .where({ id: scheduledServiceId })
      .first('payment_method_preference');
    return ss?.payment_method_preference || null;
  } catch (err) {
    logger.warn('[estimate-payment-context] payment preference read failed', { error: err.message });
    return null;
  }
}

/**
 * Build the payment context for an estimate (optionally scoped to the
 * scheduled service the caller is answering for). Never throws.
 *
 * @returns {Promise<{
 *   billingTerm: 'prepay_annual'|'standard'|null,
 *   paymentPreference: string|null,
 *   annualPrepay: object|null,
 *   acceptanceInvoice: object|null,
 * }|null>} null only when the estimate is missing.
 */
async function buildEstimatePaymentContext(estimate, { scheduledServiceId = null } = {}) {
  if (!estimate?.id) return null;

  const paymentPreference = await readPaymentPreference(scheduledServiceId);
  const term = await resolveAnnualPrepayTerm(estimate, scheduledServiceId);

  let annualPrepay = null;
  // Canonical coverage result, hoisted for the gating below (Codex PR r3
  // P2): a status-live term whose backing money is unpaid/clawed back
  // reads NOT covered — the completion detector then treats the fee as
  // owed, and the card must run the same detector instead of hiding the
  // warning behind prepay context. null = predicate unreadable (fall back
  // to status semantics).
  let termCanonicallyCovered = null;
  if (term) {
    let invoice = null;
    if (term.prepay_invoice_id) {
      try {
        invoice = await db('invoices')
          .where({ id: term.prepay_invoice_id })
          .first('id', 'status', 'paid_at', 'total') || null;
      } catch (err) {
        logger.warn('[estimate-payment-context] prepay invoice read failed', { error: err.message });
      }
    }
    const status = String(term.status || '').toLowerCase();
    const usage = await summarizeTermVisitUsage(term, scheduledServiceId);
    // Paid = the canonical coverage predicate: covers both the lagging-webhook
    // case (payment_pending term whose invoice has settled reads paid) and the
    // refund case (a paid-looking invoice whose payment was fully refunded
    // reads NOT paid). Fall back to the term's own status only when the
    // predicate can't be read.
    const covered = await termCoverageStillValid(term);
    termCanonicallyCovered = covered;
    const paid = covered != null ? covered : TERM_PAID_STATUSES.has(status);
    // Visit-level coverage: the term's money being valid ≠ THIS visit covered
    // (detached after a coverage-window change, service mismatch, date outside
    // the term, missing stamp). Mirror the completion-billing gate
    // (annualPrepayCoversVisit — fail-closed) so the card never says "do not
    // collect" for a visit completion billing would bill. null when there's no
    // visit to answer for (e.g. New Appointment modal before booking).
    let coversThisVisit = null;
    if (scheduledServiceId) {
      try {
        const AnnualPrepayRenewals = require('./annual-prepay-renewals');
        const svcRow = await db('scheduled_services').where({ id: scheduledServiceId }).first();
        coversThisVisit = svcRow
          ? !!(await AnnualPrepayRenewals.annualPrepayCoversVisit(svcRow, db))
          : false;
      } catch (err) {
        logger.warn('[estimate-payment-context] visit coverage check failed — failing closed', { error: err.message });
        coversThisVisit = false;
      }
    }
    annualPrepay = {
      termId: term.id,
      status: term.status,
      paid,
      coversThisVisit,
      // Money came in but coverage was killed (void/refund) — the card must
      // say "bill normally", not fall through to "payment not received yet".
      refunded: !paid && invoiceIsPaid(invoice),
      planLabel: term.plan_label || null,
      prepayAmount: num(term.prepay_amount),
      termStart: term.term_start || null,
      termEnd: term.term_end || null,
      coverageServiceType: term.coverage_service_type || null,
      coverageVisitCount: term.coverage_visit_count != null ? Number(term.coverage_visit_count) : null,
      // "Visit X of Y · N remaining" context (null when no visits are linked).
      totalVisits: usage?.totalVisits ?? null,
      visitsUsed: usage?.visitsUsed ?? null,
      visitsRemaining: usage?.visitsRemaining ?? null,
      visitNumber: usage?.visitNumber ?? null,
      invoiceId: invoice?.id || term.prepay_invoice_id || null,
      invoiceStatus: invoice?.status || null,
      invoicePaidAt: invoice?.paid_at || null,
      invoiceTotal: invoice ? num(invoice.total) : null,
    };
  }

  // A DEAD term (cancelled/refunded prepay) returned the customer to
  // per-application billing — it must not gate the acceptance-invoice /
  // setup-fee-missing section or claim billing-term authority, or the
  // card shows only prepay context while completion parks the visit for
  // the missing fee (Codex PR round 2 P1). The annualPrepay panel above
  // still renders the term's history either way.
  // A cancel-at-renewal term rides out its PAID window as covered
  // (coveredTermsAsOf's decided-lapse branch) — status alone must not
  // force standard billing while coverage stands, or the card renders
  // "do not collect" beside "Per application" (Codex PR r9 P2).
  const termIsDead = !!term
    && ['cancelled', 'canceled', 'refunded', 'void', 'voided'].includes(String(term.status || '').toLowerCase())
    && termCanonicallyCovered !== true;
  let acceptanceInvoice = null;
  let setupFeeMissing = null;
  // An UNCOVERED live-status term (unpaid payment_pending, clawed-back
  // money) also opens this section (Codex PR r3 P2): completion's
  // detector treats the fee as owed there, so the card must run the same
  // detector instead of hiding the warning behind prepay context.
  if (!term || termIsDead || termCanonicallyCovered === false) {
    const inv = await findAcceptanceInvoice(estimate);
    if (inv) {
      acceptanceInvoice = {
        id: inv.id,
        title: inv.title || null,
        status: inv.status || null,
        paid: invoiceIsPaid(inv),
        paidAt: inv.paid_at || null,
        total: num(inv.total),
        setupFeeAmount: sumMatchingLines(inv, SETUP_FEE_RE),
        firstApplicationAmount: sumMatchingLines(inv, FIRST_APPLICATION_RE),
      };
    }
    // The canonical detector ALWAYS decides (Codex PR r8 P1): a partial
    // fee line ($9.90 on a $99 obligation) or an application-only invoice
    // must not hide the warning — completion's cents-exact check would
    // still park, and the card must never contradict completion. A fully
    // billed fee simply reads not-owed inside the detector.
    {
      // Was the setup fee simply never minted (standard Mark Won accepts
      // skip it)? Surface it so the card can warn BEFORE the visit
      // completes and parks.
      // Fail-soft like every read here: unknown degrades to no warning.
      try {
        const { findUnmintedSetupFeeObligation } = require('./setup-fee-obligation');
        // No excludeScheduledServiceId here (unlike the completion caller):
        // for DISPLAY, a visit that already completed means the leak
        // already happened — the warning would be stale advice, so
        // firstVisitAlreadyCompleted should count this visit too.
        // Qualify against the DISPLAYED visit (Codex PR r2 P2): a
        // non-recurring add-on sharing the estimate never parks —
        // completion passes the row's recurrence identity, so the card
        // must judge the same row or it warns about a visit that will
        // invoice normally. No visit in scope (estimate-only surfaces)
        // → estimate-level warning stands.
        let visitPlanRow = null;
        if (scheduledServiceId) {
          visitPlanRow = await db('scheduled_services')
            .where({ id: scheduledServiceId })
            .first('is_recurring', 'recurring_parent_id', 'estimated_price') || null;
        }
        const obligation = await findUnmintedSetupFeeObligation({
          sourceEstimateId: estimate.id,
          customerId: estimate.customer_id,
          visitPlanRow,
        });
        if (obligation.owed && !obligation.firstVisitAlreadyCompleted) {
          setupFeeMissing = {
            // Display the REMAINDER when partial coverage stands.
            setupFee: Number.isFinite(Number(obligation.setupFeeRemainingCents))
              ? Number(obligation.setupFeeRemainingCents) / 100
              : obligation.setupFee,
            // The card's copy must match what completion will DO: with a
            // live application-only acceptance invoice standing, only the
            // FEE is parked — never "setup fee + first application"
            // (Codex PR r11 P2).
            // CENTS-EXACT against the visit's own price when one is in
            // scope (Codex PR r12 P1 — completion compares summed
            // coverage to the full expected application cents; a partial
            // line must not promise a fee-only park).
            applicationCovered: (() => {
              if (!acceptanceInvoice
                || INVOICE_DEAD_STATUSES.includes(String(acceptanceInvoice.status || '').toLowerCase())) return false;
              const appCents = Math.round((Number(acceptanceInvoice.firstApplicationAmount) || 0) * 100);
              const expectCents = Math.round((Number(visitPlanRow?.estimated_price) || 0) * 100);
              return expectCents > 0 ? appCents >= expectCents : appCents > 0;
            })(),
            // The card's copy must describe what completion will ACTUALLY
            // do (Codex PR r2 P2): parking only happens while the gate is
            // on; while off, completion mints the bare per-application
            // invoice and the fee must be billed by hand.
            parkingEnabled: process.env.GATE_UNMINTED_SETUP_FEE_PARK === 'true',
          };
        }
      } catch (err) {
        logger.warn('[estimate-payment-context] unminted setup-fee check failed', { error: err.message });
      }
    }
  }

  // Billing term: a prepay term is authoritative; otherwise the persisted
  // preference; otherwise an accepted estimate with an acceptance invoice is
  // the converter's standard (pay-per-application) path. Null when nothing is
  // known — the card renders nothing rather than guessing.
  let billingTerm = null;
  // An uncovered term keeps prepay billing-term authority ONLY while no
  // setup-fee obligation stands — an owed fee means completion will park
  // on the standard path, and the card must say so (the warning row
  // renders under the standard section).
  if (term && !termIsDead && !(termCanonicallyCovered === false && setupFeeMissing)) billingTerm = 'prepay_annual';
  else if (!termIsDead && paymentPreference === 'prepay_annual') billingTerm = 'prepay_annual';
  // An owed-but-unminted setup fee proves the accept converted onto the
  // standard per-application plan even when no explicit preference was ever
  // stored ("inferred" profiles) — without this the card would render no
  // billing rows at all and the warning below it would never show.
  else if (paymentPreference || acceptanceInvoice || setupFeeMissing) billingTerm = 'standard';

  return { billingTerm, paymentPreference, annualPrepay, acceptanceInvoice, setupFeeMissing };
}

module.exports = {
  buildEstimatePaymentContext,
  _private: {
    sumMatchingLines,
    invoiceIsPaid,
    findAcceptanceInvoice,
    resolveAnnualPrepayTerm,
    summarizeTermVisitUsage,
    termCoverageStillValid,
    SETUP_FEE_RE,
    FIRST_APPLICATION_RE,
  },
};
