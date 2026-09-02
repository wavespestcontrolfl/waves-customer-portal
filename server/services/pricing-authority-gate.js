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
// Acceptance rewrites pricing_authority to LOCKED — the price is frozen and
// the money is agreed. A GENUINELY locked accepted price (price_locked_at
// set, or status accepted — the migration backfilled historic accepts as
// LOCKED) is authoritative for every link/send verdict: it is no longer a
// quote anyone can accept, and refusing it would lock every still-open
// property in its group out of sends, follow-ups and extensions with no
// operator remedy (GH codex P0 r22 on #3750). Every accept path still
// stamps the authority the price carried AT LOCK into estimate_data
// (server-written, from the row being locked) as durable audit evidence and
// as the tie-breaker for a LOCKED row that carries neither lock timestamp
// nor accepted status.
const PRICING_AUTHORITY_AT_LOCK_KEY = 'pricingAuthorityAtLock';
const GATED_SEND_AUTHORITY_SQL = "(UPPER(pricing_authority) = 'SERVER' OR (UPPER(pricing_authority) = 'LOCKED' AND (price_locked_at IS NOT NULL OR status = 'accepted' OR estimate_data->>'pricingAuthorityAtLock' = 'SERVER')) OR (estimate_data->'proposal'->'enabled' = 'true'::jsonb AND estimate_data->'proposal'->'provenance'->>'source' = 'proposal-editor'))";

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
  const authority = String(row.pricing_authority || row.pricingAuthority || '').toUpperCase();
  if (authority === 'SERVER') return true;
  const data = parseEstimateDataLoose(row.estimate_data ?? row.estimateData);
  if (authority === 'LOCKED') {
    if (row.price_locked_at != null || String(row.status || '') === 'accepted') return true;
    if (String(data?.[PRICING_AUTHORITY_AT_LOCK_KEY] || '').toUpperCase() === 'SERVER') return true;
  }
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
// Mirrors estimate-public isEstimateCustomerViewable EXACTLY (uncapped codex
// P1 r19): live rows (sending / sent / viewed) only while unexpired, and the
// terminal accepted / declined rows ALWAYS — the link keeps rendering them,
// price included. Every sibling verdict in the repo scopes through this one
// helper so none can drift from what the customer actually sees.
const LINK_VISIBLE_LIVE_STATUSES = ['sending', 'sent', 'viewed'];
const LINK_VISIBLE_TERMINAL_STATUSES = ['accepted', 'declined'];
function applyLinkVisibleSiblingScope(qb, now = new Date()) {
  return qb
    .whereNull('archived_at')
    // A linkage-invalidated row never renders on the public link (the
    // reader rejects it before propertyGroup) — mirror that exclusion so a
    // marker-only terminal row cannot block its valid siblings (GH codex P2
    // r22). Same predicate the revise UPDATE refuses on.
    .whereRaw("COALESCE(estimate_data->'estimatorEngine'->>'linkage_invalidated_at', '') = ''")
    .whereRaw("COALESCE(estimate_data->'estimatorEngine'->>'invalidation_pending_at', '') = ''")
    .where((visible) => visible
      .where((live) => live
        .whereIn('status', LINK_VISIBLE_LIVE_STATUSES)
        .where((unexpired) => unexpired.whereNull('expires_at').orWhere('expires_at', '>', now)))
      .orWhereIn('status', LINK_VISIBLE_TERMINAL_STATUSES));
}

async function groupPassesGatedSendAuthority(database, row = {}, now = new Date()) {
  if (!row?.estimate_group_id) return true;
  let siblings;
  try {
    siblings = await applyLinkVisibleSiblingScope(
      database('estimates')
        .where({ estimate_group_id: row.estimate_group_id })
        .whereNot({ id: row.id }),
      now,
    ).select('id', 'status', 'price_locked_at', 'pricing_authority', 'estimate_data');
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
  PRICING_AUTHORITY_AT_LOCK_KEY,
  SERVER_PRICING_AUTHORITY_SQL,
  GATED_SEND_AUTHORITY_SQL,
  gatedSendAuthorityPredicateApplies,
  rowPassesGatedSendAuthority,
  groupPassesGatedSendAuthority,
  estimateDeliverableUnderGate,
  applyLinkVisibleSiblingScope,
  LINK_VISIBLE_LIVE_STATUSES,
  LINK_VISIBLE_TERMINAL_STATUSES,
};
