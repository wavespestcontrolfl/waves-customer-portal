/**
 * Retry-sweep collectibility verdict — the ONE implementation of "would the
 * failed-payment retry sweep charge this armed row?".
 *
 * Extracted from processPaymentRetries (billing-cron.js) so that the sweep,
 * the card-expiry exemption (annual-prepay-renewals.js), and any future
 * surface share a single, side-effect-free classifier. Everything here is
 * READ-ONLY: no payment writes, no autopay log, no alerts, no Stripe. The
 * sweep keeps every side effect and switches on `disposition`.
 *
 * Guard ORDER is load-bearing and mirrors the sweep exactly: RESOLUTION
 * guards (the obligation no longer exists — supersede the row) run before
 * STATE guards (autopay disabled/paused — exit without superseding). A state
 * guard firing first would strand an already-satisfied row unsuperseded, and
 * billing-v2 /balance sums unsuperseded failed rows into the customer
 * balance.
 */
const db = require('../models/db');
const logger = require('./logger');
const { etDateString } = require('../utils/datetime-et');
const { resolveBillingLane } = require('./billing-lane');

// Lazy: annual-prepay-renewals consumes this module for the card-expiry
// exemption, so a top-level require would be circular. Resolved through the
// module object (not destructured) so callers' jest spies keep applying.
function prepay() {
  return require('./annual-prepay-renewals');
}

const REASONS = Object.freeze({
  COLLECTIBLE: 'collectible',
  CUSTOMER_MISSING: 'customer_missing',
  CUSTOMER_DELETED: 'customer_deleted',
  ALREADY_COLLECTED: 'already_collected',
  ABSORBED_ANNUAL_PREPAY: 'absorbed_annual_prepay',
  LANE_NOT_MONTHLY: 'lane_not_monthly',
  AUTOPAY_DISABLED: 'autopay_disabled',
  AUTOPAY_PAUSED: 'autopay_paused',
  PENDING_PREPAY_HOLD: 'pending_prepay_hold',
  AMBIGUOUS_OUTCOME_PARKED: 'ambiguous_outcome_parked',
});

/**
 * Codex round-2 P0: does ANOTHER attempt for this SAME customer+month
 * (never the row being classified — callers exclude it themselves) have an
 * unresolved Stripe outcome? Two shapes:
 *   - an unresolved stripe_orphan_charges row (Stripe accepted a charge but
 *     the payments-ledger write failed — STRIPE_CHARGED_DB_FAILED) — money
 *     may already be moving for this customer at all, not just this month;
 *   - a 'failed' payments row for this exact obligation month stamped
 *     metadata.ambiguous_outcome (a no-PI connection failure that may or
 *     may not have reached Stripe).
 * A collector that charges again here — a fresh idempotency key, since this
 * is a distinct attempt — risks a genuine double collection while the
 * FIRST outcome is still unverified. Every monthly collector (charge-now,
 * the monthly cron, and this module's own classifier for the retry sweep)
 * must check this before charging, not just before superseding.
 */
/**
 * Codex round-1 P1: charge-now and the daily monthly cron both charge this
 * SAME obligation and must derive the SAME idempotency key from the SAME
 * canonical source, regardless of which one attempted (and possibly
 * declined) FIRST that day — otherwise whichever goes second reuses a key
 * whose recorded parameters (description/metadata) belong to the OTHER
 * caller and Stripe rejects it as a mismatch instead of attempting a fresh
 * charge. The bare `autopay_monthly_<cid>_<ET date>` key (chargeMonthly()'s
 * own default) is used for a customer's FIRST attempt today — a genuine
 * simultaneous race between the two callers still collapses under Stripe
 * idempotency in that case. Once a failed attempt exists for this
 * obligation month (from EITHER caller), every later attempt derives the
 * next `_r<n>` suffix from THAT row's own recorded key, so it is always a
 * key Stripe has never seen and a real charge is attempted.
 */
async function deriveMonthlyChargeIdempotencyKey(customerId, monthKey, conn = db) {
  const [obYear, obMonth] = monthKey.split('-').map(Number);
  const monthStart = `${monthKey}-01`;
  const monthEnd = `${monthKey}-${String(new Date(Date.UTC(obYear, obMonth, 0)).getUTCDate()).padStart(2, '0')}`;
  const latestFailedAttempt = await conn('payments')
    .where({ customer_id: customerId, status: 'failed' })
    .where(function () {
      this.whereRaw("metadata->>'billed_month' = ?", [monthKey])
        .orWhere(function () {
          this.whereRaw("(metadata IS NULL OR metadata->>'billed_month' IS NULL)")
            .andWhere('payment_date', '>=', monthStart)
            .andWhere('payment_date', '<=', monthEnd)
            .andWhere('description', 'like', `%${MONTHLY_MARKER}%`);
        });
    })
    .orderBy('created_at', 'desc')
    .first('metadata');
  let attemptNumber = 0;
  if (latestFailedAttempt) {
    let priorMeta = {};
    try {
      const raw = latestFailedAttempt.metadata;
      priorMeta = raw ? (typeof raw === 'string' ? JSON.parse(raw) : raw) : {};
    } catch (_) { /* unparseable legacy metadata — treat as attempt 0 */ }
    const match = /_r(\d+)$/.exec(String(priorMeta.idempotency_key || ''));
    attemptNumber = match ? parseInt(match[1], 10) + 1 : 1;
  }
  const base = `autopay_monthly_${customerId}_${etDateString()}`;
  return attemptNumber > 0 ? `${base}_r${attemptNumber}` : base;
}

async function hasUnresolvedSiblingStripeOutcome(customerId, monthKey, conn = db) {
  const orphan = await conn('stripe_orphan_charges')
    .where({ customer_id: customerId, resolved: false })
    .first('id', 'stripe_payment_intent_id');
  if (orphan) return { blocked: true, reason: 'unresolved_orphan_charge', detail: orphan };
  const ambiguous = await conn('payments')
    .where({ customer_id: customerId })
    .whereIn('status', ['failed'])
    .whereRaw("metadata->>'billed_month' = ?", [monthKey])
    .whereRaw("COALESCE((metadata->>'ambiguous_outcome')::boolean, false) = true")
    .first('id');
  if (ambiguous) return { blocked: true, reason: 'ambiguous_stripe_outcome', detail: ambiguous };
  return { blocked: false };
}

// What the sweep DOES with a row of each reason. `charge` is the only
// disposition that moves money; the others map 1:1 to the sweep's existing
// write/log blocks.
const DISPOSITIONS = Object.freeze({
  CHARGE: 'charge',
  SKIP_SILENT: 'skip_silent',            // no write, no event (customer missing/deleted)
  SUPERSEDE_BY_COLLECTOR: 'supersede_by_collector',
  SELF_SUPERSEDE: 'self_supersede',
  DISARM: 'disarm',                      // next_retry_at cleared, row stays visible
  SKIP_ARMED: 'skip_armed',              // event only, row stays armed
  PARK: 'park',                          // self-supersede + health alert
});

const MONTHLY_MARKER = 'WaveGuard Monthly';
const NON_MONTHLY_MODES = ['per_application', 'per_visit', 'one_time'];

// 'YYYY-MM' / 'YYYY-MM-DD' keys from a payments.payment_date value (DATE
// column — arrives as a Date at UTC midnight or as a 'YYYY-MM-DD' string
// depending on driver config; both slice safely via ISO).
function monthKeyOf(paymentDate) {
  if (!paymentDate) return null;
  if (paymentDate instanceof Date) {
    return Number.isNaN(paymentDate.getTime()) ? null : paymentDate.toISOString().slice(0, 7);
  }
  const s = String(paymentDate);
  return /^\d{4}-\d{2}/.test(s) ? s.slice(0, 7) : null;
}

function dateKeyOf(paymentDate) {
  if (!paymentDate) return null;
  if (paymentDate instanceof Date) {
    return Number.isNaN(paymentDate.getTime()) ? null : paymentDate.toISOString().slice(0, 10);
  }
  const s = String(paymentDate);
  return /^\d{4}-\d{2}-\d{2}/.test(s) ? s.slice(0, 10) : null;
}

function parseMeta(payment) {
  try {
    return payment.metadata
      ? (typeof payment.metadata === 'string' ? JSON.parse(payment.metadata) : payment.metadata)
      : {};
  } catch {
    return {}; // unparseable legacy metadata — treat as unstamped/unclassified
  }
}

function isMonthlyObligationRow(payment) {
  return String(payment?.description || '').includes(MONTHLY_MARKER);
}

// Date-INCLUSIVE pause (autopay-eligibility.isPaused semantics): paused while
// autopay_paused_until >= asOf, resumes the day after. Evaluated against an
// arbitrary ET day so a horizon caller can ask "paused through <horizon>?".
function pausedOn(customer, asOfYmd) {
  if (!customer?.autopay_paused_until) return false;
  const pausedUntil = String(
    customer.autopay_paused_until instanceof Date
      ? customer.autopay_paused_until.toISOString()
      : customer.autopay_paused_until,
  ).slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(pausedUntil) && pausedUntil >= asOfYmd;
}

/**
 * Per-run context shared by every row: memoized prepay coverage by
 * obligation date and the pending-prepay hold set, both as of `asOf`.
 *
 * - The sweep calls with no `asOf` (today) and the default connection — the
 *   prepay lookups are then invoked with their bare defaults, exactly as
 *   before.
 * - A horizon caller passes `asOf` (and optionally `conn`).
 *
 * Lookup failures FAIL OPEN (no suppression) so a transient blip cannot
 * stall legitimate collection; a covered customer double-billed in that
 * window is refundable and alarmed by the prepay lane. Each failure is
 * recorded in `lookupWarnings` for callers that need to fail the other way
 * (the card-expiry exemption exempts nobody on a lookup failure).
 */
function loadRetryContext({ asOf = null, conn = db } = {}) {
  const explicit = asOf != null || conn !== db;
  const asOfKey = asOf != null ? asOf : etDateString();
  const coveredByDate = new Map();
  const lookupWarnings = [];
  let pendingPromise = null;

  const coveredIdsOn = async (dateKey) => {
    if (!coveredByDate.has(dateKey)) {
      let ids = new Set();
      try {
        ids = explicit
          ? await prepay().getActivelyCoveredCustomerIds(dateKey, conn)
          : await prepay().getActivelyCoveredCustomerIds(dateKey);
      } catch (err) {
        lookupWarnings.push({ lookup: 'coverage', dateKey, message: err.message });
        logger.warn(`[retry-collectibility] prepay coverage lookup failed for ${dateKey} — proceeding unguarded: ${err.message}`);
      }
      coveredByDate.set(dateKey, ids);
    }
    return coveredByDate.get(dateKey);
  };

  const pendingPrepayIds = () => {
    if (!pendingPromise) {
      pendingPromise = (async () => {
        try {
          return explicit
            ? await prepay().getPaymentPendingCustomerIds(asOfKey, conn)
            : await prepay().getPaymentPendingCustomerIds();
        } catch (err) {
          lookupWarnings.push({ lookup: 'pending_prepay', message: err.message });
          logger.warn(`[retry-collectibility] pending-prepay lookup failed — proceeding unguarded: ${err.message}`);
          return new Set();
        }
      })();
    }
    return pendingPromise;
  };

  return { asOf: asOfKey, conn, coveredIdsOn, pendingPrepayIds, lookupWarnings };
}

/**
 * The sweep's armed-row selector. `dueBy` (inclusive, the sweep's `<= now`)
 * or `dueBefore` (exclusive — a horizon caller's next-midnight bound).
 * Returns the builder so the caller chooses its projection.
 */
function armedRetryQuery(conn = db, { dueBy = null, dueBefore = null, customerIds = null } = {}) {
  const q = conn('payments')
    .where({ status: 'failed' })
    .whereNull('superseded_by_payment_id')
    .where('retry_count', '<', 3)
    .whereNotNull('next_retry_at');
  if (dueBy != null) q.where('next_retry_at', '<=', dueBy);
  if (dueBefore != null) q.where('next_retry_at', '<', dueBefore);
  if (Array.isArray(customerIds)) q.whereIn('customer_id', customerIds);
  return q;
}

/**
 * Classify ONE armed row. Pure: reads `payments` (already-collected sibling,
 * paid-monthly history) and the context's prepay sets; writes nothing.
 *
 * @returns {{ collectible:boolean, reason:string, disposition:string,
 *   isMonthlyObligation:boolean, obligationMonth:string|null,
 *   obligationDateKey:string|null, collectedByPaymentId:*|null,
 *   resolvedLaneMode:string|null }}
 */
async function classifyFailedPaymentRetry({
  payment, customer, ctx, conn = ctx?.conn || db,
  // A surface that could not read the customer row and fails toward "the
  // sweep might charge" (the card-expiry exemption) passes true: the
  // customer-level STATE guards (lane, disabled, paused) are skipped and
  // only the row-level guards decide. The sweep itself never sets this —
  // a missing/deleted customer is a silent skip there.
  allowMissingCustomer = false,
}) {
  const isMonthlyObligation = isMonthlyObligationRow(payment);
  const meta = parseMeta(payment);
  const obligationMonth = meta.billed_month || monthKeyOf(payment.payment_date);
  const obligationDateKey = (obligationMonth && monthKeyOf(payment.payment_date) === obligationMonth)
    ? dateKeyOf(payment.payment_date)
    : (obligationMonth ? `${obligationMonth}-01` : null);
  const base = {
    collectible: false,
    isMonthlyObligation,
    obligationMonth,
    obligationDateKey,
    collectedByPaymentId: null,
    resolvedLaneMode: null,
  };
  const verdict = (reason, disposition, extra = {}) => ({ ...base, reason, disposition, ...extra });

  if (!customer && !allowMissingCustomer) return verdict(REASONS.CUSTOMER_MISSING, DISPOSITIONS.SKIP_SILENT);
  if (customer?.deleted_at) return verdict(REASONS.CUSTOMER_DELETED, DISPOSITIONS.SKIP_SILENT);
  const stateKnown = !!customer;

  // RESOLUTION GUARD: obligation month already collected through another
  // door (admin charge-now, self-pay, an overlapping collection path).
  // Metadata-first (billed_month stamp), payment_date window + description
  // marker as the legacy fallback — exactly the monthly dedupe.
  if (isMonthlyObligation && obligationMonth) {
    const [obYear, obMonth] = obligationMonth.split('-').map(Number);
    const obStart = `${obligationMonth}-01`;
    const obLastDay = new Date(Date.UTC(obYear, obMonth, 0)).getUTCDate();
    const obEnd = `${obligationMonth}-${String(obLastDay).padStart(2, '0')}`;
    const collected = await conn('payments')
      .where({ customer_id: payment.customer_id })
      .whereNot({ id: payment.id })
      .whereIn('status', ['paid', 'processing'])
      .where(function alreadyCollected() {
        this.whereRaw("metadata->>'billed_month' = ?", [obligationMonth])
          .orWhere(function legacyRow() {
            this.whereRaw("(metadata IS NULL OR metadata->>'billed_month' IS NULL)")
              .andWhere('payment_date', '>=', obStart)
              .andWhere('payment_date', '<=', obEnd)
              .andWhere('description', 'like', `%${MONTHLY_MARKER}%`);
          });
      })
      .first();
    if (collected) {
      return verdict(REASONS.ALREADY_COLLECTED, DISPOSITIONS.SUPERSEDE_BY_COLLECTOR, {
        collectedByPaymentId: collected.id,
      });
    }
    // RESOLUTION GUARD (Codex round-2 P0): a SIBLING attempt for this SAME
    // obligation — a different row than this one — left an unresolved
    // Stripe outcome. Checked here because an orphan/ambiguous row is
    // never 'paid' or 'processing', so the ALREADY_COLLECTED scan above
    // never sees it; parked exactly like this row's OWN ambiguous-outcome
    // guard below (same reason/disposition) so the sweep's existing
    // handling (self-supersede + health alert) applies unchanged.
    const siblingOutcome = await hasUnresolvedSiblingStripeOutcome(payment.customer_id, obligationMonth, conn);
    if (siblingOutcome.blocked) {
      return verdict(REASONS.AMBIGUOUS_OUTCOME_PARKED, DISPOSITIONS.PARK, {
        unresolvedSibling: siblingOutcome,
      });
    }
  }

  // RESOLUTION GUARD: an annual prepay covering the OBLIGATION date absorbs
  // it. Coverage-as-of-today would wrongly write off debt from before the
  // term started; no resolvable obligation date → no absorb (keep
  // collecting).
  if (isMonthlyObligation && obligationDateKey) {
    const coveredIds = await ctx.coveredIdsOn(obligationDateKey);
    if (coveredIds.has(String(payment.customer_id))) {
      return verdict(REASONS.ABSORBED_ANNUAL_PREPAY, DISPOSITIONS.SELF_SUPERSEDE);
    }
  }

  // STATE GUARD (monthly GUARD 3b/3c parity): a monthly obligation row for a
  // customer whose lane is not monthly — explicit non-monthly modes AND NULL
  // rows the resolver classifies non-monthly — with NO successfully paid
  // monthly charge on file is disarmed (likely mis-created; manual triage),
  // deliberately NOT superseded.
  if (isMonthlyObligation && stateKnown) {
    const laneNotMonthly = NON_MONTHLY_MODES.includes(customer.billing_mode)
      || (!customer.billing_mode && resolveBillingLane(customer).mode !== 'monthly_membership');
    if (laneNotMonthly) {
      const paidMonthly = await conn('payments')
        .where({ customer_id: payment.customer_id, status: 'paid' })
        .where('description', 'like', `%${MONTHLY_MARKER}%`)
        .whereNot({ id: payment.id })
        .first();
      if (!paidMonthly) {
        return verdict(REASONS.LANE_NOT_MONTHLY, DISPOSITIONS.DISARM, {
          resolvedLaneMode: resolveBillingLane(customer).mode,
        });
      }
    }
  }

  // STATE GUARD (monthly GUARD 1): autopay disabled — disarm, no supersede.
  if (stateKnown && customer.autopay_enabled === false) {
    return verdict(REASONS.AUTOPAY_DISABLED, DISPOSITIONS.DISARM);
  }

  // STATE GUARD (monthly GUARD 2): paused — skip without disarming.
  if (stateKnown && pausedOn(customer, ctx.asOf)) {
    return verdict(REASONS.AUTOPAY_PAUSED, DISPOSITIONS.SKIP_ARMED);
  }

  // STATE GUARD (monthly GUARD 5): a pending prepay commitment holds a
  // monthly ladder (skip, stay armed) until it activates or cancels.
  if (isMonthlyObligation) {
    const pendingIds = await ctx.pendingPrepayIds();
    if (pendingIds.has(String(payment.customer_id))) {
      return verdict(REASONS.PENDING_PREPAY_HOLD, DISPOSITIONS.SKIP_ARMED);
    }
  }

  // Ambiguous no-PI failure: Stripe may have accepted the charge even though
  // no PaymentIntent came back — re-charging could double-charge, so the
  // sweep parks the row for manual reconciliation. Deterministic no-PI
  // failures (classified at record time) moved no money and keep retrying.
  if (!payment.stripe_payment_intent_id && meta.ambiguous_outcome) {
    return verdict(REASONS.AMBIGUOUS_OUTCOME_PARKED, DISPOSITIONS.PARK);
  }

  return verdict(REASONS.COLLECTIBLE, DISPOSITIONS.CHARGE, { collectible: true });
}

module.exports = {
  REASONS,
  DISPOSITIONS,
  loadRetryContext,
  armedRetryQuery,
  classifyFailedPaymentRetry,
  hasUnresolvedSiblingStripeOutcome,
  deriveMonthlyChargeIdempotencyKey,
  _private: { monthKeyOf, dateKeyOf, pausedOn, isMonthlyObligationRow, parseMeta },
};
