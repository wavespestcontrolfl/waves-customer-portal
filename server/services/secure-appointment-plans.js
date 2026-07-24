/**
 * /secure plan-choice lane (owner workflow 2026-07-24) — the pricing and
 * plan-selection brain behind the appointment card-request page.
 *
 * Read side: buildSecurePlanContext derives the page's pricing context from
 * the BOOKED SERIES (never an estimate): per-visit price from
 * scheduled_services.estimated_price, application count from the recurring
 * cadence (shared prepay-cadence helpers — same numbers as the admin
 * prepay-on-book preflight), incentive class from the converter's service
 * key (solo pest/mosquito keep the $99 WaveGuard setup-fee waiver; the
 * discountable residential programs take ANNUAL_PREPAY_DISCOUNT_PCT).
 * Every unsound input returns null and the page falls back to today's
 * card-only experience — fail toward the safe surface, never toward a
 * wrong price. NULL estimated_price means "manual quote pending", never $0.
 *
 * Write side: selectSecurePlan records the customer's choice.
 *   per_application — stamps the selection (and, for fee-waiver mixes, the
 *     $99 pending_setup_fee on the series parent so the FIRST completion
 *     invoice carries it — owner decision 2026-07-24); the customer then
 *     continues through the existing SetupIntent capture unchanged.
 *   prepay_annual — mints the annual prepay draft invoice + payment_pending
 *     term inside one transaction, mirroring the Customer360 manual mint
 *     (admin-customers.js): per-customer advisory lock + overlap assert,
 *     InvoiceService.create single-line invoice, createTermForAnnualPrepay
 *     (no estimate — series-anchored coverage), request-row stamp as the
 *     idempotency anchor. Payment happens on the existing /pay/<token>
 *     page; the invoice-payment webhook activates the term and stamps
 *     coverage — zero new money machinery. An unpaid term never suppresses
 *     completion billing (payment_pending is not coverage), so the owner's
 *     "fall back to per-visit billing" ruling is the default physics.
 *
 * Whole lane is inert unless GATE_SECURE_PLAN_CHOICE is on.
 */

const db = require('../models/db');
const logger = require('./logger');
const { isEnabled } = require('../config/feature-gates');
const { visitsPerYearForCadence, prepayCoverageCadenceForPattern } = require('./prepay-cadence');
const { recurringServiceKey, WAVEGUARD_SETUP_FEE } = require('./estimate-converter');
const { ANNUAL_PREPAY_DISCOUNT_PCT } = require('./pricing-engine/constants');
const { resolveBillingLane } = require('./billing-lane');
const { portalUrl } = require('../utils/portal-url');
const { etDateString } = require('../utils/datetime-et');
const { callBookingDateOnly } = require('./call-booking-catalog');

// Converter key → incentive class. Whitelist ONLY — anything unlisted
// (commercial_* keys, foam_recurring, unclassifiable service names) gets no
// plan context and the page stays card-only. Commercial stays excluded so
// the displayed prepay total always equals the minted invoice total to the
// cent (InvoiceService adds county tax to commercial invoices).
const PLAN_CLASS_BY_SERVICE_KEY = {
  pest_control: 'fee_waiver',
  mosquito: 'fee_waiver',
  lawn_care: 'discount',
  tree_shrub: 'discount',
  termite_bait: 'discount',
  rodent_bait: 'discount',
  palm_injection: 'discount',
};

const LIVE_VISIT_STATUSES = ['pending', 'confirmed'];

// A prepay invoice in ANY of these states can never be paid — the selection
// it anchored is dead and the plan choice must reopen (Codex #2980: office
// cancel/refund lanes use cancelled/refunded, not just void; treating only
// 'void' as terminal left the picker stuck on an unusable pay link).
const TERMINAL_INVOICE_STATUSES = ['void', 'cancelled', 'canceled', 'refunded'];

// Mirror of admin-customers.js annualPrepayOverlapStatusClause (kept
// inline: that route exports the LOCKING assert via _private, which the
// write path uses; this read-side probe must not take locks). A cancelled
// term with renewal_decision='cancel' still covers through term_end.
function overlapStatusClause() {
  return function overlapStatus() {
    this.whereIn('status', ['payment_pending', 'active', 'renewal_pending', 'renewed', 'switch_plan'])
      .orWhere(function lapsedRenewalStillInTerm() {
        this.where('status', 'cancelled').andWhere('renewal_decision', 'cancel');
      });
  };
}

function cents(n) {
  return Math.round(Number(n) * 100) / 100;
}

// The booked cadence, normalized the way the admin prepay-on-book path
// normalizes it: the modal encodes every-6-weeks as pattern 'custom' with a
// 42-day interval (admin-schedule.js). Any other custom interval has no
// supported coverage mapping and returns null (fail closed).
function normalizedPattern(visit) {
  const raw = String(visit.recurring_pattern || '').trim().toLowerCase();
  if (!raw) return null;
  if (raw === 'custom') {
    return Number(visit.recurring_interval_days) === 42 ? 'every_6_weeks' : null;
  }
  return raw;
}

async function loadPlanVisit(scheduledServiceId, conn = db) {
  return conn('scheduled_services')
    .where({ id: scheduledServiceId })
    .first('id', 'customer_id', 'status', 'scheduled_date', 'service_type', 'estimated_price',
      'is_recurring', 'recurring_pattern', 'recurring_interval_days', 'recurring_parent_id',
      'pending_setup_fee', 'source_estimate_id');
}

// The series anchor row: card links can be sent from a recurring CHILD's
// editor row, but the setup-fee stamp and the coverage window always live
// on the parent — stamping the child would strand a disclosed fee the
// completion claim (which always reads the parent) never finds.
function seriesAnchorId(visit) {
  return visit.recurring_parent_id || visit.id;
}

/**
 * Derive the plan context for a pending secure-card request. Returns null
 * whenever the lane is dark or ANY input is unsound — the caller renders
 * today's card-only page. Never throws.
 */
async function buildSecurePlanContext({ request, visitId }) {
  try {
    if (!isEnabled('securePlanChoice')) return null;
    const visit = await loadPlanVisit(visitId || request.scheduled_service_id);
    if (!visit || !visit.customer_id) return null;

    // NULL/zero price = manual quote pending — never $0, never a plan page.
    const perVisit = visit.estimated_price != null ? Number(visit.estimated_price) : null;
    if (!(perVisit > 0)) return null;

    // An estimate-origin series already made its billing choice at accept —
    // the accept flow minted the setup+first-application invoice (incl. the
    // $99) and stamped the per_application lane. Re-offering the plan page
    // there would double-disclose (and double-bill) the setup fee.
    if (visit.source_estimate_id) return null;

    const customer = await db('customers')
      .where({ id: visit.customer_id })
      .first('id', 'billing_mode', 'waveguard_tier', 'monthly_rate', 'property_type');
    if (!customer) return null;
    // Commercial/business properties are excluded from v1 (InvoiceService
    // taxes both — tax would split the page total from the invoice total);
    // monthly members pay dues, annual-prepay customers are already
    // covered, and an established per_application customer already paid
    // their setup fee at estimate accept — all would falsify the plan copy
    // or double-bill the fee.
    if (['commercial', 'business'].includes(String(customer.property_type || '').toLowerCase())) return null;
    if (customer.billing_mode === 'per_application') return null;
    const lane = resolveBillingLane(customer);
    if (lane.mode === 'monthly_membership' || lane.mode === 'annual_prepay') return null;

    const isRecurring = !!visit.is_recurring || !!visit.recurring_pattern;
    if (!isRecurring) {
      return { mode: 'one_time', perVisit: cents(perVisit), selected: request?.selected_plan || null };
    }

    const pattern = normalizedPattern(visit);
    const visitsPerYear = visitsPerYearForCadence(pattern);
    const coverageCadence = prepayCoverageCadenceForPattern(pattern);
    if (!pattern || !visitsPerYear || !coverageCadence) return null;

    const serviceKey = recurringServiceKey({ name: visit.service_type });
    const planClass = PLAN_CLASS_BY_SERVICE_KEY[serviceKey] || null;
    if (!planClass) return null;

    // An existing overlapping term (any coverage-holding status) means
    // prepay is not sellable here — hide the whole choice rather than
    // render an option the mint would 409. The request's OWN pending term
    // (minted by an earlier prepay selection on this same link) is
    // excluded: it must not hide the plan context on the prepay_selected
    // page or block the customer switching back to per-application.
    const today = etDateString();
    let overlapQuery = db('annual_prepay_terms')
      .where({ customer_id: visit.customer_id })
      .where(overlapStatusClause());
    if (request?.annual_prepay_term_id) {
      overlapQuery = overlapQuery.whereNot('id', request.annual_prepay_term_id);
    }
    const overlapping = await overlapQuery
      .orderBy('term_end', 'desc')
      .first('id', 'term_end');
    const overlapEnd = overlapping ? callBookingDateOnly(overlapping.term_end) : null;
    if (overlapEnd && today <= overlapEnd) return null;

    const annualBase = cents(perVisit * visitsPerYear);
    const discountRate = planClass === 'discount' ? ANNUAL_PREPAY_DISCOUNT_PCT : 0;
    const prepayTotal = cents(annualBase * (1 - discountRate));

    return {
      mode: 'recurring',
      planClass,
      perVisit: cents(perVisit),
      visitsPerYear,
      annualBase,
      prepay: {
        total: prepayTotal,
        discount: cents(annualBase - prepayTotal),
        // Rendered label, server-derived so the client never holds a rate
        // constant. '' for the waiver class (the waiver line is the pitch).
        ratePctLabel: discountRate > 0 ? `${Math.round(discountRate * 1000) / 10}%` : '',
      },
      setupFee: planClass === 'fee_waiver'
        ? { amount: WAVEGUARD_SETUP_FEE, waivedWithPrepay: true }
        : null,
      selected: request?.selected_plan || null,
    };
  } catch (err) {
    logger.warn(`[secure-plans] plan context failed for request ${request?.id}: ${err.message} — rendering card-only`);
    return null;
  }
}

// The prepaySelected page state: a returning visitor who already chose
// prepay. Live unpaid invoice → hand back the pay link; settled invoice →
// the visit is covered, render secured. Returns null when the request has
// no prepay selection (caller proceeds normally).
async function prepaySelectionState(request) {
  try {
    if (!isEnabled('securePlanChoice')) return null;
    if (request?.selected_plan !== 'prepay_annual' || !request.prepay_invoice_id) return null;
    const invoice = await db('invoices')
      .where({ id: request.prepay_invoice_id })
      .first('id', 'token', 'status');
    // Office voided/cancelled/refunded it — the plan choice reopens.
    if (!invoice || TERMINAL_INVOICE_STATUSES.includes(invoice.status)) return null;
    if (['paid', 'prepaid'].includes(invoice.status)) return { state: 'secured' };
    return { state: 'prepay_selected', payUrl: portalUrl(`/pay/${invoice.token}`) };
  } catch (err) {
    logger.warn(`[secure-plans] prepay selection state failed for request ${request?.id}: ${err.message}`);
    return null;
  }
}

function fail(code) {
  const err = new Error(code);
  err.code = code;
  return err;
}

/**
 * Record the customer's plan selection. Returns:
 *   { ok:true, plan:'per_application' }                — proceed to card capture
 *   { ok:true, plan:'prepay_annual', payUrl }          — redirect to /pay
 * Throws err.code ∈ { gate_off, not_found, invalid_plan, already_secured,
 * no_longer_needed, plan_unavailable, prepay_overlap, selection_conflict }.
 * All amounts are re-derived server-side — the client sends only the plan.
 */
async function selectSecurePlan({ token, plan }) {
  if (!isEnabled('securePlanChoice')) throw fail('gate_off');
  if (!['per_application', 'prepay_annual'].includes(plan)) throw fail('invalid_plan');

  const request = await db('appointment_card_requests').where({ token }).first();
  if (!request) throw fail('not_found');
  if (request.status === 'completed' || request.status === 'satisfied') throw fail('already_secured');
  if (request.status !== 'pending') throw fail('selection_conflict');

  // Same liveness + payer re-checks the capture completion runs — the
  // office can cancel/reschedule or attach a third-party payer between
  // page load and selection. Payer lookup failure refuses (fail toward
  // not billing the wrong party).
  const visit = await loadPlanVisit(request.scheduled_service_id);
  const dateOnly = visit ? callBookingDateOnly(visit.scheduled_date) : null;
  if (!visit
    || !LIVE_VISIT_STATUSES.includes(visit.status)
    || (dateOnly && dateOnly < etDateString(new Date()))) {
    throw fail('no_longer_needed');
  }
  const PayerService = require('./payer');
  const resolved = await PayerService.resolveForInvoice({
    customerId: String(request.customer_id),
    scheduledServiceId: String(request.scheduled_service_id),
    throwOnError: true,
  });
  if (resolved?.payerId) throw fail('no_longer_needed');

  const context = await buildSecurePlanContext({ request, visitId: visit.id });
  if (!context) throw fail('plan_unavailable');

  if (plan === 'per_application') {
    if (context.mode !== 'recurring') throw fail('plan_unavailable');
    // Switching FROM an earlier prepay selection: retire that selection's
    // artifacts first. A settled prepay invoice means the year is already
    // covered (nothing to switch); an unpaid one is OUR OWN never-sent
    // draft — void it through the canonical money-guarded path
    // (InvoiceService.voidInvoice cancels any live PI and its own
    // annual-prepay sync cancels the payment_pending term), then release
    // the request's anchors so a later prepay re-selection can mint fresh.
    if (request.selected_plan === 'prepay_annual' && request.prepay_invoice_id) {
      const prior = await db('invoices')
        .where({ id: request.prepay_invoice_id })
        .first('id', 'status');
      if (prior && ['paid', 'prepaid'].includes(prior.status)) throw fail('already_secured');
      if (prior && !TERMINAL_INVOICE_STATUSES.includes(prior.status)) {
        try {
          await require('./invoice').voidInvoice(prior.id);
        } catch (err) {
          // Money guard refused (payment in flight / recorded) — the
          // customer is mid-payment in another tab; don't switch under it.
          logger.warn(`[secure-plans] prepay→per_application switch blocked for request ${request.id}: ${err.message}`);
          throw fail('selection_conflict');
        }
      }
      await db('appointment_card_requests')
        .where({ id: request.id, prepay_invoice_id: request.prepay_invoice_id })
        .update({ prepay_invoice_id: null, annual_prepay_term_id: null, updated_at: new Date() });
    }
    // Selection + setup-fee obligation land in ONE transaction (Codex
    // #2980 r4): a durable per_application selection without its fee stamp
    // would let the first completion auto-charge WITHOUT the disclosed $99
    // — either both persist or neither does, and a failed fee stamp rolls
    // the selection back to retryable.
    const stamp = new Date();
    let casLost = false;
    await db.transaction(async (trx) => {
      const stamped = await trx('appointment_card_requests')
        .where({ id: request.id, status: 'pending' })
        .update({ selected_plan: 'per_application', plan_selected_at: stamp, updated_at: stamp });
      if (stamped !== 1) {
        // The CAS lost (Codex #2980 r2): /complete raced this selection and
        // the request is no longer pending — stamping the fee anyway would
        // bill a $99 no durable selection authorizes.
        casLost = true;
        return;
      }
      // Owner decision 2026-07-24: the per-application choice on a solo
      // pest/mosquito series owes the $99 setup fee on the FIRST completion
      // invoice. Snapshot the amount now (billed fee === disclosed fee) on
      // the SERIES PARENT — the completion mint's atomic claim always reads
      // the parent, so a child-attached link must not stamp the child.
      // Guarded so a re-selection never re-stamps a consumed fee.
      if (context.setupFee) {
        await trx('scheduled_services')
          .where({ id: seriesAnchorId(visit) })
          .whereNull('pending_setup_fee')
          .update({ pending_setup_fee: context.setupFee.amount, updated_at: stamp });
      }
    });
    if (casLost) {
      const fresh = await db('appointment_card_requests')
        .where({ id: request.id })
        .first('status');
      if (fresh?.status === 'completed' || fresh?.status === 'satisfied') throw fail('already_secured');
      throw fail('selection_conflict');
    }
    return { ok: true, plan: 'per_application' };
  }

  // prepay_annual — idempotency anchor first: a double-submit (or a
  // returning visitor re-posting) gets the SAME pay link, never a second
  // invoice. An anchor pointing at a VOID invoice (office voided it, or a
  // per-application switch retired it) is stale — release it (guarded CAS
  // on the exact stale id) so prepay can be re-selected; otherwise the
  // stamp's whereNull guard below would refuse forever.
  if (request.prepay_invoice_id) {
    const existing = await db('invoices')
      .where({ id: request.prepay_invoice_id })
      .first('id', 'token', 'status');
    if (existing && !TERMINAL_INVOICE_STATUSES.includes(existing.status)) {
      return { ok: true, plan: 'prepay_annual', payUrl: portalUrl(`/pay/${existing.token}`) };
    }
    await db('appointment_card_requests')
      .where({ id: request.id, prepay_invoice_id: request.prepay_invoice_id })
      .update({ prepay_invoice_id: null, annual_prepay_term_id: null, updated_at: new Date() });
    request.prepay_invoice_id = null;
    request.annual_prepay_term_id = null;
  }
  if (context.mode !== 'recurring') throw fail('plan_unavailable');

  const today = etDateString();
  const anchorId = seriesAnchorId(visit);
  const InvoiceService = require('./invoice');
  const AnnualPrepayRenewals = require('./annual-prepay-renewals');
  const { lockAndAssertNoAnnualPrepayOverlap } = require('../routes/admin-customers')._private;

  const coverageServiceType = visit.service_type;
  const visitCount = context.visitsPerYear;
  const amount = context.prepay.total;

  let payToken = null;
  try {
    await db.transaction(async (trx) => {
      // Term starts at the first UPCOMING live visit of the series —
      // coverage must span the visits the customer is prepaying, not the
      // send date. Anchored on the series PARENT and derived INSIDE the
      // transaction (Codex #2980 r2): a snapshot taken outside could
      // mis-anchor the paid window when the office cancels/reschedules the
      // earliest child mid-selection.
      const seriesRows = await trx('scheduled_services')
        .where(function series() {
          this.where({ id: anchorId }).orWhere({ recurring_parent_id: anchorId });
        })
        .whereIn('status', LIVE_VISIT_STATUSES)
        .select('scheduled_date');
      const upcoming = seriesRows
        .map((r) => callBookingDateOnly(r.scheduled_date))
        .filter((d) => d && d >= today)
        .sort();
      const termStart = upcoming[0] || null;
      if (!termStart) throw fail('no_longer_needed');

      // Advisory lock + in-transaction overlap re-check — two tabs (or a
      // concurrent office mint) collapse to one term (mirrors the
      // Customer360 mint and the estimate accept).
      await lockAndAssertNoAnnualPrepayOverlap(
        trx, visit.customer_id, termStart, false,
        'Customer already has an annual prepay term through',
      );

      // Revalidate IMMEDIATELY before minting (Codex #2980): the liveness
      // and payer checks above ran outside this transaction — an office
      // cancel/reschedule or a payer attach in that window must abort the
      // mint, not produce a payable annual invoice for a dead or
      // third-party-billed visit. The visit row is read FOR UPDATE and the
      // payer resolve rides THIS transaction (database: trx — Codex #2980
      // r3: the global-db default would let a payer attach slip between
      // this refusal check and the mint), so a concurrent payer attach on
      // the locked row serializes behind the commit. Payer lookup failure
      // refuses (fail toward not billing the wrong party).
      const liveVisit = await trx('scheduled_services')
        .where({ id: visit.id })
        .forUpdate()
        .first('id', 'status', 'scheduled_date');
      // Also lock the CUSTOMER row (Codex #2980 r4): resolveForInvoice
      // falls back to customers.payer_id, which staff can change from
      // Customer360 — a default-payer attach must serialize behind this
      // mint, not slip between the refusal check and the invoice insert.
      await trx('customers')
        .where({ id: visit.customer_id })
        .forUpdate()
        .first('id');
      const liveDate = liveVisit ? callBookingDateOnly(liveVisit.scheduled_date) : null;
      if (!liveVisit
        || !LIVE_VISIT_STATUSES.includes(liveVisit.status)
        || (liveDate && liveDate < today)) {
        throw fail('no_longer_needed');
      }
      let payerNow = null;
      try {
        payerNow = await PayerService.resolveForInvoice({
          database: trx,
          customerId: String(request.customer_id),
          scheduledServiceId: String(request.scheduled_service_id),
          throwOnError: true,
        });
      } catch (payerErr) {
        logger.warn(`[secure-plans] in-transaction payer re-check failed — refusing mint for request ${request.id}: ${payerErr.message}`);
        throw fail('no_longer_needed');
      }
      if (payerNow?.payerId) throw fail('no_longer_needed');

      const invoice = await InvoiceService.create({
        database: trx,
        customerId: visit.customer_id,
        title: `${coverageServiceType} - Annual Prepay`,
        lineItems: [{
          description: `${coverageServiceType} - ${visitCount} prepaid application${visitCount === 1 ? '' : 's'}`,
          quantity: 1,
          unit_price: amount,
          category: 'Annual prepay',
        }],
        // Deliberately does NOT match the accept-minted marker regex — the
        // dispatch auto-charge allowance keys accept invoices on that text.
        notes: `Annual prepay selected by the customer from their secure appointment link (visit ${visit.id}).`,
        dueDate: today,
      });
      // The page showed a tax-free residential total; a total that came
      // back different (payer accrual, unexpected tax) must not reach the
      // customer as a surprise — abort, fail toward the card-only page.
      if (cents(invoice.total) !== cents(amount)) {
        throw fail('plan_unavailable');
      }

      const term = await AnnualPrepayRenewals.createTermForAnnualPrepay({
        customerId: visit.customer_id,
        prepayInvoiceId: invoice.id,
        planLabel: `${coverageServiceType} Annual Prepay`,
        monthlyRate: cents(amount / 12),
        prepayAmount: cents(Number(invoice.total)),
        termStart,
        coverageServiceType,
        coverageVisitCount: visitCount,
        coverageCadence: prepayCoverageCadenceForPattern(normalizedPattern(visit)),
        conn: trx,
      });
      if (!term) throw new Error('annual prepay term could not be created');

      // The request row is the idempotency anchor: only the FIRST selection
      // lands; a concurrent winner makes this update match 0 rows and the
      // whole mint rolls back (the loser re-reads the winner's link below).
      const stamped = await trx('appointment_card_requests')
        .where({ id: request.id, status: 'pending' })
        .whereNull('prepay_invoice_id')
        .update({
          selected_plan: 'prepay_annual',
          plan_selected_at: new Date(),
          prepay_invoice_id: invoice.id,
          annual_prepay_term_id: term.id,
          updated_at: new Date(),
        });
      if (stamped !== 1) throw fail('selection_conflict');

      // Clear a per-application setup-fee stamp from an earlier selection —
      // prepay waives it. Same series-parent anchor as the stamp itself.
      await trx('scheduled_services')
        .where({ id: anchorId })
        .whereNotNull('pending_setup_fee')
        .update({ pending_setup_fee: null, updated_at: new Date() });

      await trx('activity_log').insert({
        customer_id: visit.customer_id,
        action: 'annual_prepay_invoice_created',
        description: `Annual prepay invoice ${invoice.invoice_number} created from the customer's secure appointment link for ${coverageServiceType}: $${amount.toFixed(2)} covering ${visitCount} visit(s)`,
        metadata: JSON.stringify({
          invoice_id: invoice.id,
          invoice_number: invoice.invoice_number,
          annual_prepay_term_id: term.id,
          appointment_card_request_id: request.id,
          scheduled_service_id: visit.id,
          coverage_service_type: coverageServiceType,
          coverage_visit_count: visitCount,
          per_visit_amount: context.perVisit,
          term_start: termStart,
          source: 'secure_plan_choice',
        }),
        created_at: new Date(),
      });

      payToken = invoice.token;
    });
  } catch (err) {
    if (err.annualPrepayOverlap) throw fail('prepay_overlap');
    if (err.code === 'selection_conflict') {
      // Concurrent winner — return their link instead of an error.
      const fresh = await db('appointment_card_requests')
        .where({ id: request.id })
        .first('prepay_invoice_id');
      if (fresh?.prepay_invoice_id) {
        const winner = await db('invoices')
          .where({ id: fresh.prepay_invoice_id })
          .first('token', 'status');
        if (winner && winner.status !== 'void') {
          return { ok: true, plan: 'prepay_annual', payUrl: portalUrl(`/pay/${winner.token}`) };
        }
      }
    }
    throw err;
  }

  logger.info(`[secure-plans] prepay invoice minted for visit ${visit.id} (request ${request.id})`);
  return { ok: true, plan: 'prepay_annual', payUrl: portalUrl(`/pay/${payToken}`) };
}

/**
 * Post-enrollment lane stamp (called from finishVerifiedSecureCapture after
 * Auto Pay enrollment succeeds, only when the customer explicitly chose
 * per-application on the plan page): the dispatch per-application
 * auto-charge is gated on customers.billing_mode === 'per_application'
 * (estimate accepts stamp it; office bookings never did), so without this
 * the page's "charged automatically after each completed service" promise
 * would silently degrade to invoice-on-complete. Conservative by
 * construction: only NULL/per_visit/one_time lanes are moved (the context
 * builder already refuses membership/annual-prepay customers), and an
 * established per_application_fee is never overwritten.
 */
// Returns true when the lane is correct after the call (stamped now,
// already right, or deliberately untouched), false on a write failure —
// the caller decides whether that blocks (capture completion refuses and
// stays retryable rather than stranding the customer off the promised
// lane behind a completed row; Codex #2980 r3). Idempotent.
async function applyPerApplicationLaneStamp({ customerId, scheduledServiceId }) {
  try {
    if (!isEnabled('securePlanChoice')) return true;
    // The stamp is a value-guarded CAS on the billing_mode that was just
    // validated: if staff moves the customer onto a membership or
    // annual-prepay lane between the read and the write (a stale completion
    // retry is exactly that window), the guarded update loses, the loop
    // re-reads, and the lane check refuses instead of overwriting the newer
    // billing choice (Codex #2980 r5).
    for (let attempt = 0; attempt < 3; attempt++) {
      const customer = await db('customers')
        .where({ id: customerId })
        .first('id', 'billing_mode', 'waveguard_tier', 'monthly_rate', 'per_application_fee');
      if (!customer) return true;
      const lane = resolveBillingLane(customer);
      if (lane.mode === 'monthly_membership' || lane.mode === 'annual_prepay'
        || customer.billing_mode === 'per_application') return true;
      const visit = await db('scheduled_services')
        .where({ id: scheduledServiceId })
        .first('estimated_price');
      const perVisit = visit?.estimated_price != null ? Number(visit.estimated_price) : null;
      let stampQuery = db('customers').where({ id: customerId });
      stampQuery = customer.billing_mode == null
        ? stampQuery.whereNull('billing_mode')
        : stampQuery.where({ billing_mode: customer.billing_mode });
      const stamped = await stampQuery.update({
        billing_mode: 'per_application',
        ...(customer.per_application_fee == null && perVisit > 0
          ? { per_application_fee: perVisit }
          : {}),
        updated_at: new Date(),
      });
      if (stamped === 1) {
        logger.info(`[secure-plans] customer ${customerId} moved to per_application lane (secure plan choice)`);
        return true;
      }
      logger.info(`[secure-plans] per-application lane stamp lost the CAS for customer ${customerId} (billing_mode changed concurrently); re-reading`);
    }
    logger.warn(`[secure-plans] per-application lane stamp gave up after repeated CAS losses for customer ${customerId}`);
    return false;
  } catch (err) {
    logger.warn(`[secure-plans] per-application lane stamp failed for customer ${customerId}: ${err.message}`);
    return false;
  }
}

module.exports = {
  buildSecurePlanContext,
  prepaySelectionState,
  selectSecurePlan,
  applyPerApplicationLaneStamp,
  _test: { normalizedPattern, PLAN_CLASS_BY_SERVICE_KEY, overlapStatusClause },
};
