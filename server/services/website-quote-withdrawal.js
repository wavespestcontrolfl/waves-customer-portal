'use strict';
// A FLAGGED county-roll verdict quarantines every quote-wizard publication
// the same visitor holds for that premise: website publications (viewable
// and acceptable at /estimate/:token) are archived with the block stamped;
// legacy (websiteFlow:false) rows in any live delivery state only carry the
// block (the send claim refuses them). Shared by /calculate and the
// lookup stage, which persists the same authoritative verdict and must not
// leave an earlier clean run's publication acceptable when the visitor
// abandons before /calculate (codex #4667 r17 P1). Runs inside the
// caller's transaction, which also holds the contact-pair advisory lock;
// the critical audit row commits with the archival.
const { samePremiseDisplay } = require('./lead-address-unverified');
const { DELIVERY_CLAIM_NOT_LIVE_SQL } = require('../utils/estimate-claim-sql');

// …and 'expired': a previously published quote that expired before the
// flagged lookup is still revivable through the public seven-day extension
// (isEstimateExtensionRequestEligible admits published expired rows), so
// it is quarantined too — the archive and price-lock guards still apply
// (codex #4667 r36 P1).
const WITHDRAWABLE_PUBLICATION_STATES = ['sent', 'viewed', 'scheduled', 'sending', 'send_failed', 'expired'];

const customerFacingPremise = (row) => (String(row?.proposal_address || '').trim() ? row.proposal_address : row?.address);

async function withdrawFlaggedPublications(trx, { leadId, contactEmail, contactPhone, fullAddress, flag = null }) {
  if (!leadId || !contactEmail || !contactPhone || !String(fullAddress || '').trim()) return [];
  // Website publications AND legacy (websiteFlow:false) quote-wizard
  // rows: a legacy draft staff already scheduled cannot be
  // refreshed by the draft upsert, and without the marker its
  // scheduled send would deliver a live token for the rejected
  // address (codex r14 P1). Website rows are archived; legacy rows
  // only carry the block (the send claim refuses them).
  const candidates = await trx('estimates')
    .where({ source: 'quote_wizard' })
    .whereIn('status', [...WITHDRAWABLE_PUBLICATION_STATES, 'draft'])
    .whereNull('archived_at')
    .where((q) => q
      .whereRaw("estimate_data->>'lead_id' = ?", [String(leadId)])
      .orWhere((own) => own
        .whereRaw('LOWER(customer_email) = ?', [String(contactEmail).toLowerCase().trim()])
        .whereRaw("right(regexp_replace(COALESCE(customer_phone, ''), '[^0-9]', '', 'g'), 10) = ?", [String(contactPhone).replace(/\D/g, '').slice(-10)])))
    .select('id', 'address', 'status', 'sent_at', 'viewed_at', trx.raw("estimate_data->>'lead_id' as lead_id"), trx.raw("(estimate_data->'websiteSelfService' IS NOT NULL) as website"), trx.raw(`(${DELIVERY_CLAIM_NOT_LIVE_SQL}) as claim_not_live`), trx.raw("estimate_data->'proposal'->>'propertyAddress' as proposal_address"));
  // Premise-matched in BOTH arms: this lead's own rows match on
  // identity plus the (loose) premise — a lead's publication for a
  // different property must not be archived by a flag on this one;
  // cross-lead rows need the complete locality.
  // The premise judged is the CUSTOMER-FACING one: a commercial proposal's
  // editable propertyAddress (the base column stays immutable on that
  // path), else the base address — so a proposal staff corrected from A
  // to B is no longer quarantined by a repeated flag for A (codex r46 P1).
  const matched = candidates
    .filter((row) => (String(row.lead_id || '') === String(leadId) && samePremiseDisplay(customerFacingPremise(row), fullAddress))
      || samePremiseDisplay(customerFacingPremise(row), fullAddress, { requireLocality: true }));
  // A LIVE delivery claim on any matched row (the sender is between its
  // last-instant recheck and the provider call): quarantining now would
  // commit the marker under a link the provider still receives. Refuse the
  // whole withdrawal — the caller's transaction rolls back and answers a
  // retryable 503; the claim lapses within its TTL (codex #4667 r39 P1).
  const claimed = matched.find((row) => row.claim_not_live === false);
  if (claimed) {
    throw Object.assign(new Error('A quote is mid-delivery — retry in a moment.'), { code: 'DELIVERY_CLAIM_LIVE', statusCode: 503 });
  }
  const toWithdraw = matched.filter((row) => row.website === true);
  // Expired rows are blocked only when they were PUBLISHED (delivered or
  // viewed): those are the ones the public extension could revive for the
  // rejected address (codex r39 P1); a never-delivered expired legacy row
  // has no revival path and is left alone (codex r39 P0). The block on an
  // expired row is lifted by a later clean county answer (the /calculate
  // and lookup supersession), otherwise the office re-quotes — the
  // documented recovery path.
  const toBlock = matched.filter((row) => row.website !== true && (row.status !== 'expired' || row.sent_at || row.viewed_at));
  // Every write re-asserts the EXACT address the row was matched on (codex
  // r33 P1): a Customer 360 correction fanning a new premise onto the row
  // between the SELECT and this row lock must win, or the block would be
  // stamped onto the corrected premise and its valid link would 404.
  // A write that affects no row because a delivery claim went live between
  // the SELECT and the row lock refuses the withdrawal the same way the
  // pre-check does (atomic with the write — codex r39 P1).
  const refuseIfClaimLive = async (rowId) => {
    const fresh = await trx('estimates').where({ id: rowId }).first(trx.raw(`(${DELIVERY_CLAIM_NOT_LIVE_SQL}) as claim_not_live`));
    if (fresh && fresh.claim_not_live === false) {
      throw Object.assign(new Error('A quote is mid-delivery — retry in a moment.'), { code: 'DELIVERY_CLAIM_LIVE', statusCode: 503 });
    }
  };
  for (const row of toBlock) {
    const blockedCount = await trx('estimates')
      .where({ id: row.id, source: 'quote_wizard', address: row.address })
      .whereRaw(DELIVERY_CLAIM_NOT_LIVE_SQL)
      // …and the OWNERSHIP predicate the candidate query used (this lead's
      // row, or this contact pair's): a contact correction that moved the
      // row to another pair without changing its address must win (codex
      // r39 P1).
      .where((q) => q
        .whereRaw("estimate_data->>'lead_id' = ?", [String(leadId)])
        .orWhere((own) => own
          .whereRaw('LOWER(customer_email) = ?', [String(contactEmail).toLowerCase().trim()])
          .whereRaw("right(regexp_replace(COALESCE(customer_phone, ''), '[^0-9]', '', 'g'), 10) = ?", [String(contactPhone).replace(/\D/g, '').slice(-10)])))
      // The candidate query's live statuses re-asserted on the write: a
      // decline (or any terminal transition) that commits between the
      // SELECT and this row lock wins, so a successful decline token is
      // never turned into the generic 404 (codex #4667 r30 P0).
      .whereIn('status', [...WITHDRAWABLE_PUBLICATION_STATES, 'draft'])
      .whereNull('archived_at')
      .whereNull('price_locked_at')
      .update({
        updated_at: new Date(),
        estimate_data: trx.raw("COALESCE(estimate_data, '{}'::jsonb) || ?::jsonb", [JSON.stringify({ addressUnverified: true, addressUnverifiedFlag: flag || null, addressUnverifiedClearedBy: null })]),
      });
    if (!blockedCount) await refuseIfClaimLive(row.id);
  }
  if (!toWithdraw.length) return [];
  // The eligibility predicates are repeated on the UPDATE: an
  // acceptance that commits between the SELECT and here promotes
  // the row past sent/viewed and price-locks it, and an accepted,
  // invoiced estimate must never be archived from a quote run.
  // The verdict rides on the archived row (addressUnverified +
  // addressUnverifiedFlag) for later recovery and the off-surface
  // guard; a carried draft marker is persisted as the real flag.
  const rows = [];
  for (const row of toWithdraw) {
    const archived = await trx('estimates')
      .where({ id: row.id, source: 'quote_wizard', address: row.address })
      .whereRaw(DELIVERY_CLAIM_NOT_LIVE_SQL)
      // …and the OWNERSHIP predicate the candidate query used (this lead's
      // row, or this contact pair's): a contact correction that moved the
      // row to another pair without changing its address must win (codex
      // r39 P1).
      .where((q) => q
        .whereRaw("estimate_data->>'lead_id' = ?", [String(leadId)])
        .orWhere((own) => own
          .whereRaw('LOWER(customer_email) = ?', [String(contactEmail).toLowerCase().trim()])
          .whereRaw("right(regexp_replace(COALESCE(customer_phone, ''), '[^0-9]', '', 'g'), 10) = ?", [String(contactPhone).replace(/\D/g, '').slice(-10)])))
      .whereIn('status', WITHDRAWABLE_PUBLICATION_STATES)
      .whereNull('archived_at')
      .whereNull('price_locked_at')
      .whereRaw("estimate_data->'websiteSelfService' IS NOT NULL")
      .update({
        archived_at: new Date(),
        updated_at: new Date(),
        estimate_data: trx.raw("COALESCE(estimate_data, '{}'::jsonb) || ?::jsonb", [JSON.stringify({ addressUnverified: true, addressUnverifiedFlag: flag || null, addressUnverifiedClearedBy: null })]),
      })
      .returning('id');
    if (!archived.length) await refuseIfClaimLive(row.id);
    rows.push(...archived);
  }
  const { recordAuditEvent } = require('../services/audit-log');
  for (const row of rows) {
    const id = row?.id ?? row;
    await recordAuditEvent({
      actor_type: 'system', action: 'website_quote_withdrawn_address_unverified',
      resource_type: 'estimate', resource_id: id,
      metadata: { leadId: leadId }, critical: true, trx,
    });
  }
  return rows;
}

// The CLEAN counterpart of the withdrawal (codex #4667 r27 P1, moved here
// r45 P2): legacy quote-wizard rows an earlier flagged lookup blocked
// without archiving keep refusing every staff send with ADDRESS_UNVERIFIED
// unless a clean verdict lifts them — for this contact pair's rows at the
// same complete premise, each lift re-asserting the row's matched address
// AND the pair (a Customer 360 edit that moved the row elsewhere, and a
// lookup under that pair that stamped a fresh rejection, must win).
// Caller holds the contact-pair advisory lock. Returns the lifted count.
async function liftLegacyBlocksForCleanVerdict(trx, { contactEmail, contactPhone, fullAddress }) {
  const { samePremiseDisplay } = require('./lead-address-unverified');
  const emailLc = String(contactEmail || '').toLowerCase().trim();
  const phone10 = String(contactPhone || '').replace(/\D/g, '').slice(-10);
  if (!emailLc || !phone10) return 0;
  const blocked = await trx('estimates')
    .where({ source: 'quote_wizard' })
    .whereNull('archived_at')
    .whereRaw('LOWER(customer_email) = ?', [emailLc])
    .whereRaw("right(regexp_replace(COALESCE(customer_phone, ''), '[^0-9]', '', 'g'), 10) = ?", [phone10])
    .whereRaw("estimate_data->'addressUnverified' = 'true'::jsonb")
    .select('id', 'address', trx.raw("estimate_data->'proposal'->>'propertyAddress' as proposal_address"));
  // Judged on the customer-facing premise, as the withdrawal judges it.
  const unblocked = blocked.filter((row) => samePremiseDisplay(customerFacingPremise(row), fullAddress, { requireLocality: true }));
  for (const row of unblocked) {
    await trx('estimates')
      .where({ id: row.id, address: row.address })
      .whereRaw('LOWER(customer_email) = ?', [emailLc])
      .whereRaw("right(regexp_replace(COALESCE(customer_phone, ''), '[^0-9]', '', 'g'), 10) = ?", [phone10])
      .whereRaw("estimate_data->'addressUnverified' = 'true'::jsonb")
      .update({
        estimate_data: trx.raw("COALESCE(estimate_data, '{}'::jsonb) || ?::jsonb", [JSON.stringify({ addressUnverified: false, addressUnverifiedFlag: null, addressUnverifiedSupersededAt: new Date().toISOString() })]),
        updated_at: new Date(),
      });
  }
  return unblocked.length;
}

module.exports = { withdrawFlaggedPublications, WITHDRAWABLE_PUBLICATION_STATES };
module.exports.liftLegacyBlocksForCleanVerdict = liftLegacyBlocksForCleanVerdict;
