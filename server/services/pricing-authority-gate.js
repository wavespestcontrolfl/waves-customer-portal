'use strict';

// Engine-authoritative pricing gate (#3750): the ONE verdict every path that
// puts a price in front of a customer applies while
// GATE_SEND_REQUIRES_SERVER_PRICING is on — manual/scheduled/grouped sends,
// lead auto-send, the automated follow-up lanes. A row passes when the
// engine verified its price (explicit SERVER stamp; NULL, unknown and
// CLIENT_FALLBACK all fail closed) or when it is an authored commercial
// proposal by provenance — the server-owned marker PUT /:id/proposal stamps
// (its line items ARE the quote). The SQL and JS forms mirror each other
// exactly; the SQL compares JSONB, never casts (a malformed legacy value must
// not throw, and textual booleans must not pass).
const { isEnabled } = require('../config/feature-gates');
const { isProposalAuthoredByEditor } = require('./estimate-proposal');

const SERVER_PRICING_AUTHORITY_SQL = "UPPER(pricing_authority) = 'SERVER'";
const GATED_SEND_AUTHORITY_SQL = "(UPPER(pricing_authority) = 'SERVER' OR (estimate_data->'proposal'->'enabled' = 'true'::jsonb AND estimate_data->'proposal'->'provenance'->>'source' = 'proposal-editor'))";

function gatedSendAuthorityPredicateApplies() {
  return isEnabled('sendRequiresServerPricing');
}

function parseEstimateDataLoose(value) {
  if (!value) return null;
  if (typeof value === 'string') {
    try { return JSON.parse(value); } catch { return null; }
  }
  return typeof value === 'object' ? value : null;
}

function rowPassesGatedSendAuthority(row = {}) {
  if (String(row.pricing_authority || row.pricingAuthority || '').toUpperCase() === 'SERVER') return true;
  const data = parseEstimateDataLoose(row.estimate_data ?? row.estimateData);
  return isProposalAuthoredByEditor(data?.proposal);
}

module.exports = {
  SERVER_PRICING_AUTHORITY_SQL,
  GATED_SEND_AUTHORITY_SQL,
  gatedSendAuthorityPredicateApplies,
  rowPassesGatedSendAuthority,
};
