/**
 * WaveGuard tier sync from live services.
 *
 * The estimate-accept flow stamps customers.waveguard_tier; admin-created
 * recurring series never did, leaving real members NULL-tiered (2026-08-05
 * full-book audit: 4 single-service members with no tier — the estimate
 * engine then treats them as strangers, skewing upgrade math and the
 * membership card on any future quote).
 *
 * Recomputes the tier from the SAME predicates the membership snapshot uses
 * (waveguard-existing-services.loadExistingRecurringQualifyingRows +
 * qualifyingKeysFromRows, tier ladder from discount-engine
 * determineWaveGuardTier) and stamps UPGRADES ONLY — never downgrades. A
 * tier drop changes the customer's future estimate discounts; that is an
 * owner decision, not a booking side-effect. Invalid legacy stamps (e.g.
 * 'One-Time') rank as no-tier and are corrected upward. Never throws.
 */
const logger = require('./logger');

const TIER_RANK = { bronze: 1, silver: 2, gold: 3, platinum: 4 };
const TIER_LABEL = { bronze: 'Bronze', silver: 'Silver', gold: 'Gold', platinum: 'Platinum' };

async function syncCustomerTierFromServices(db, customerId, { source = 'admin_booking_sync' } = {}) {
  if (!db || !customerId) return { updated: false, reason: 'no_customer' };
  try {
    const { loadExistingRecurringQualifyingRows, qualifyingKeysFromRows } = require('./waveguard-existing-services');
    const { determineWaveGuardTier } = require('./pricing-engine/discount-engine');
    const rows = await loadExistingRecurringQualifyingRows(db, customerId);
    const keys = qualifyingKeysFromRows(rows);
    // No qualifying services = no membership to stamp. "No tier" is NOT
    // Bronze (billing invariant 9) — leave whatever is there alone.
    if (!keys.length) return { updated: false, reason: 'no_qualifying_services' };
    const computed = determineWaveGuardTier(keys).tier;
    const customer = await db('customers').where({ id: customerId }).first('waveguard_tier');
    if (!customer) return { updated: false, reason: 'customer_missing' };
    const currentRank = TIER_RANK[String(customer.waveguard_tier || '').toLowerCase()] || 0;
    const computedRank = TIER_RANK[computed] || 0;
    if (computedRank <= currentRank) {
      return { updated: false, reason: 'no_upgrade', current: customer.waveguard_tier || null };
    }
    await db('customers')
      .where({ id: customerId })
      .update({ waveguard_tier: TIER_LABEL[computed], waveguard_tier_source: source });
    return { updated: true, from: customer.waveguard_tier || null, to: TIER_LABEL[computed] };
  } catch (e) {
    // Best-effort by contract — a tier stamp must never fail a booking.
    logger.warn(`[tier-sync] tier sync failed for customer ${customerId}: ${e.message}`);
    return { updated: false, reason: 'error' };
  }
}

module.exports = { syncCustomerTierFromServices, TIER_RANK, TIER_LABEL };
