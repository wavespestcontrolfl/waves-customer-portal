'use strict';

// The canonical pricing-regime marker a visit row carries in its
// `pricing_provenance` column once GATE_DISCOUNT_STACKING's engine has priced
// it (server: services/booking/visit-financial-stamps.js stamps it; the Edit
// appointment modal reads it back as `pricingProvenance`).
//
// Shared, CommonJS, dependency-free — the SAME reader on both sides, so a
// marked row means the same thing in the modal as it does in the planner
// (GitHub Codex round 26 on #4657, SchedulePage.jsx:3942): on a marked row a
// null primary_line_price is a KNOWN $0 primary (an add-on-only visit the
// canonical engine priced itself), never the unknown legacy gross that
// locks discount edits. Before this module the client had no reader at all
// and treated every null primary as legacy.

const PRICING_REGIME_VALUE = 'discount_stack_v1';

// pg hands jsonb back parsed, but a text/json column, a fixture, or a
// serialized API payload can carry the same object as a JSON string.
function parsePricingProvenanceValue(value) {
  let prov = value;
  if (typeof prov === 'string') {
    try { prov = JSON.parse(prov); } catch { return null; }
  }
  return prov && typeof prov === 'object' && !Array.isArray(prov) ? prov : null;
}

function isCanonicallyMarkedProvenance(value) {
  const prov = parsePricingProvenanceValue(value);
  return !!prov && prov.pricing_regime === PRICING_REGIME_VALUE;
}

module.exports = { PRICING_REGIME_VALUE, parsePricingProvenanceValue, isCanonicallyMarkedProvenance };
