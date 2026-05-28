/**
 * Surcharge jurisdiction check.
 *
 * Phase 1: FL-only (Waves operates exclusively in Florida).
 * Expandable to multi-state with customer billing state,
 * service location state, and transaction channel.
 */

const SURCHARGE_ALLOWED_STATES = new Set(['FL']);

function surchargeAllowed({ merchantState = 'FL', serviceState } = {}) {
  return SURCHARGE_ALLOWED_STATES.has(merchantState)
    && SURCHARGE_ALLOWED_STATES.has(serviceState || merchantState);
}

module.exports = { surchargeAllowed };
