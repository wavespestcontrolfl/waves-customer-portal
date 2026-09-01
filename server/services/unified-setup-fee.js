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
      this.where('is_recurring', true).orWhereNotNull('recurring_parent_id');
    })
    .where(function liveRow() {
      this.whereNull('status').orWhereIn('status', LIVE_STATUSES);
    })
    .where(function notCallback() {
      this.whereNull('is_callback').orWhere('is_callback', false);
    })
    .first('id');
  return !!row;
}

/**
 * The decide-once verdict for a customer starting recurring service.
 * Returns `{ amount, kind: 'unified' }` (owed) or
 * `{ amount: 0, kind: 'unified', waived: <reason> }`.
 *
 * The caller persists this verdict (setupFeeQuote / pending_setup_fee) at
 * the accept/booking moment; it is never recomputed afterwards. In-flight
 * old-world claims are the CALLER's concern (the quote layer already runs
 * its consumable-claim probe before this decision) — this function decides
 * eligibility only.
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
  return { amount, kind: 'unified' };
}

module.exports = {
  unifiedSetupFeeEnabled,
  unifiedSetupFeeAmount,
  hasActiveRecurringService,
  decideUnifiedSetupFee,
};
