'use strict';

/**
 * Authoritative membership-state predicate, extracted VERBATIM from
 * server/routes/admin-customers.js so services can consult the same rule the
 * membership lifecycle emails key off (codex #3341 r4/pre-push P1 chain:
 * email_messages rows are delivery artifacts — senders skip when the address
 * is missing/invalid — so email history can never be membership-state truth,
 * least of all for the no-email customers a gap check exists to find).
 *
 * The route imports these back from here; there is exactly one copy.
 */

const NON_MEMBERSHIP_TIER_KEYS = new Set(['none', 'onetime', 'na', 'no', 'notset', 'commercial']);

function membershipTierKey(value) {
  return String(value || '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '');
}

function hasMembership(customer = {}) {
  const rawTier = customer.waveguard_tier ?? customer.tier;
  const tierKey = membershipTierKey(rawTier);
  if (tierKey && NON_MEMBERSHIP_TIER_KEYS.has(tierKey)) return false;
  if (tierKey) return true;
  return Number(customer.monthly_rate ?? customer.monthlyRate ?? 0) > 0;
}

module.exports = { NON_MEMBERSHIP_TIER_KEYS, membershipTierKey, hasMembership };
