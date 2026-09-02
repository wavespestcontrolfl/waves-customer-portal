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

// The customer's ONE link renders every CUSTOMER-VIEWABLE sibling of a
// grouped estimate (estimate-public propertyGroup / isEstimateCustomerViewable:
// sending, sent or viewed, unarchived, unexpired — drafts, scheduled and
// send_failed rows are hidden; accepted/declined are terminal), so a row is
// deliverable under the gate only when IT passes and every sibling the link
// would actually show passes too (pre-push codex P1 r18: the send claims'
// broader publishable set — drafts included — is theirs alone; an unsent
// fallback draft must not block an anchor's follow-up, and a stuck fallback
// 'sending' sibling must not slip through). A sibling read that fails
// answers "not deliverable": fail closed, never a nudge on a guess.
const LINK_VISIBLE_SIBLING_STATUSES = ['sending', 'sent', 'viewed'];
async function groupPassesGatedSendAuthority(database, row = {}, now = new Date()) {
  if (!row?.estimate_group_id) return true;
  let siblings;
  try {
    siblings = await database('estimates')
      .where({ estimate_group_id: row.estimate_group_id })
      .whereNot({ id: row.id })
      .whereNull('archived_at')
      .whereIn('status', LINK_VISIBLE_SIBLING_STATUSES)
      .where((qb) => qb.whereNull('expires_at').orWhere('expires_at', '>', now))
      .select('id', 'pricing_authority', 'estimate_data');
  } catch {
    return false;
  }
  return (Array.isArray(siblings) ? siblings : []).every((sibling) => rowPassesGatedSendAuthority(sibling));
}

// The one question every customer-facing rail asks while the gate is on:
// may THIS row (and the group its link shows) be put in front of the
// customer? Gate off → always yes.
async function estimateDeliverableUnderGate(database, row = {}) {
  if (!gatedSendAuthorityPredicateApplies()) return true;
  if (!rowPassesGatedSendAuthority(row)) return false;
  return groupPassesGatedSendAuthority(database, row);
}

module.exports = {
  SERVER_PRICING_AUTHORITY_SQL,
  GATED_SEND_AUTHORITY_SQL,
  gatedSendAuthorityPredicateApplies,
  rowPassesGatedSendAuthority,
  groupPassesGatedSendAuthority,
  estimateDeliverableUnderGate,
  LINK_VISIBLE_SIBLING_STATUSES,
};
