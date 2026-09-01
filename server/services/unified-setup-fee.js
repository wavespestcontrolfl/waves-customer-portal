/**
 * Unified accept-time setup fee (owner ruling 2026-09-01, live only under
 * GATE_UNIFIED_SETUP_FEE).
 *
 * ONE setup fee (pricing_config.unified_setup_fee, default $99) for every
 * NEW customer starting recurring service — regardless of service mix:
 * pest+rodent, lawn+pest, rodent alone all carry it. Waived ONLY for an
 * EXISTING customer: at least one active recurring service on the account.
 * The decision is made ONCE at accept/quote time and frozen (the estimate's
 * setupFeeQuote, or the series parent's pending_setup_fee stamp) — nothing
 * downstream re-derives eligibility.
 *
 * Supersedes, on gated quotes: the solo-pest/mosquito membership-fee mix
 * rule (MEMBERSHIP_FEE_SOLO_KEYS) and the rodent cross-family setup waiver.
 * Gate off: this module is inert and both legacy rules run unchanged.
 */
const { isEnabled } = require('../config/feature-gates');
const { WAVEGUARD } = require('./pricing-engine/constants');

function unifiedSetupFeeEnabled() {
  return isEnabled('unifiedSetupFee');
}

// DB-authoritative via db-bridge (pricing_config.unified_setup_fee → the
// constants mirror). Zero disables the fee entirely, same convention as
// rodent_setup_fee.
function unifiedSetupFeeAmount() {
  const raw = Number(WAVEGUARD.unifiedSetupFee);
  return Number.isFinite(raw) && raw > 0 ? Math.round(raw * 100) / 100 : 0;
}

// Live-series statuses — the same set every consumable-claim probe uses. A
// NULL status is an OPEN legacy row (waves-db schema note) and counts as
// live: mis-reading a genuinely active legacy customer as "new" would
// charge a fee the ruling waives.
const LIVE_STATUSES = ['pending', 'confirmed', 'rescheduled', 'en_route', 'on_site'];
// The EXISTING-customer predicate excludes 'rescheduled' (audit r16 P0):
// a rescheduled row is a REPLACED visit — its replacement carries the live
// status, and if that replacement is later cancelled the stale
// 'rescheduled' shell would otherwise mark a former customer existing
// forever. The claim probe above keeps 'rescheduled' deliberately (a
// replaced visit's stamp can still be consumed by its replacement).
const ACTIVE_SERVICE_STATUSES = ['pending', 'confirmed', 'en_route', 'on_site'];

/**
 * The "existing customer" predicate (owner ruling 2026-09-01): at least one
 * scheduled_services row belonging to a RECURRING series (an is_recurring
 * anchor or any child) that can still run. Deliberately:
 *  - status-based, not date-based — a quarterly customer between visits
 *    still counts as existing;
 *  - family-agnostic — an active rodent-only program counts (unlike
 *    loadExistingQualifyingServiceKeys, which is family-filtered and
 *    tier-gated for the WaveGuard tier system and stays for its own
 *    consumers);
 *  - tier-agnostic — a lapsed member with a tier stamp but no live
 *    recurring row is NEW and pays again.
 * Callbacks never count (free re-services are not a recurring program).
 */
async function hasActiveRecurringService(db, customerId) {
  if (!customerId) return false;
  const row = await db('scheduled_services')
    .where({ customer_id: customerId })
    .where(function recurringRow() {
      // recurring_pattern is recurring LINEAGE too (legacy rows can carry a
      // pattern without the flag — the repo's other classifiers honor it),
      // so a live pattern-only series still marks the customer existing.
      this.where('is_recurring', true)
        .orWhereNotNull('recurring_parent_id')
        .orWhereNotNull('recurring_pattern');
    })
    .where(function liveRow() {
      this.whereNull('status').orWhereIn('status', ACTIVE_SERVICE_STATUSES);
    })
    .where(function notCallback() {
      this.whereNull('is_callback').orWhere('is_callback', false);
    })
    .first('id');
  return !!row;
}

/**
 * An in-flight old-world setup claim anywhere on the account (drain
 * protection — one account setup at a time): ANY nonzero pending_setup_fee
 * that can still be CONSUMED, the same liveness rules as the wizard's
 * consumable-claim probe (public-quote decideSetupFeeQuote) — a negative
 * stamp is completion's in-progress marker and always counts; a positive
 * one counts while its row can still complete, a pending completion attempt
 * can resume it, or a live child exists.
 */
async function hasConsumableSetupClaim(db, customerId) {
  if (!customerId) return false;
  const row = await db('scheduled_services as claim')
    .where('claim.customer_id', customerId)
    .whereNotNull('claim.pending_setup_fee')
    .whereNot('claim.pending_setup_fee', 0)
    .where(function consumable() {
      this.where('claim.pending_setup_fee', '<', 0)
        .orWhereIn('claim.status', LIVE_STATUSES)
        .orWhereExists(function pendingCompletion() {
          this.select(db.raw('1'))
            .from('service_completion_attempts as sca')
            .whereIn('sca.status', ['pending', 'side_effects_pending', 'side_effects_running'])
            .whereRaw('(sca.service_id = claim.id OR sca.service_id IN (SELECT id FROM scheduled_services WHERE recurring_parent_id = claim.id))');
        })
        .orWhereExists(function liveChild() {
          this.select(db.raw('1'))
            .from('scheduled_services as child')
            .whereRaw('child.recurring_parent_id = claim.id')
            .whereIn('child.status', LIVE_STATUSES);
        });
    })
    .first('claim.id');
  return !!row;
}

/**
 * The decide-once verdict for a customer starting recurring service.
 * Returns `{ amount, kind: 'unified' }` (owed) or
 * `{ amount: 0, kind: 'unified', waived: <reason> }`.
 *
 * The caller persists this verdict (setupFeeQuote / pending_setup_fee) at
 * the accept/booking moment; it is never recomputed afterwards.
 *
 * Failure posture is the caller's lane convention: this function lets DB
 * errors propagate. The public wizard catches and keeps the fee disclosed
 * (fail toward the priced line, codex #3591 r43); staff lanes let the
 * throw reach their fail-closed handling.
 */
async function decideUnifiedSetupFee(db, { customerId } = {}) {
  const amount = unifiedSetupFeeAmount();
  if (!(amount > 0)) return { amount: 0, kind: 'unified', waived: 'fee_disabled' };
  if (customerId && (await hasActiveRecurringService(db, customerId))) {
    return { amount: 0, kind: 'unified', waived: 'existing_customer' };
  }
  if (customerId && (await hasConsumableSetupClaim(db, customerId))) {
    return { amount: 0, kind: 'unified', waived: 'fee_already_queued' };
  }
  // A live claims-ledger row is the same evidence when nothing stamped —
  // an invoice-mode accept seeds no series and writes no stamp, so a
  // second/concurrent accept can only see its fee here (audit r14 P0).
  const { customerHasLiveSetupFeeClaim } = require('./secure-appointment-plans');
  if (customerId && (await customerHasLiveSetupFeeClaim(db, customerId))) {
    return { amount: 0, kind: 'unified', waived: 'fee_already_queued' };
  }
  return { amount, kind: 'unified' };
}

module.exports = {
  unifiedSetupFeeEnabled,
  unifiedSetupFeeAmount,
  hasActiveRecurringService,
  hasConsumableSetupClaim,
  decideUnifiedSetupFee,
};
