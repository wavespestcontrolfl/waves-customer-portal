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

// …and 'expired': a previously published quote that expired before the
// flagged lookup is still revivable through the public seven-day extension
// (isEstimateExtensionRequestEligible admits published expired rows), so
// it is quarantined too — the archive and price-lock guards still apply
// (codex #4667 r36 P1).
const WITHDRAWABLE_PUBLICATION_STATES = ['sent', 'viewed', 'scheduled', 'sending', 'send_failed', 'expired'];

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
    .select('id', 'address', trx.raw("estimate_data->>'lead_id' as lead_id"), trx.raw("(estimate_data->'websiteSelfService' IS NOT NULL) as website"));
  // Premise-matched in BOTH arms: this lead's own rows match on
  // identity plus the (loose) premise — a lead's publication for a
  // different property must not be archived by a flag on this one;
  // cross-lead rows need the complete locality.
  const matched = candidates
    .filter((row) => (String(row.lead_id || '') === String(leadId) && samePremiseDisplay(row.address, fullAddress))
      || samePremiseDisplay(row.address, fullAddress, { requireLocality: true }));
  const toWithdraw = matched.filter((row) => row.website === true);
  const toBlock = matched.filter((row) => row.website !== true);
  // Every write re-asserts the EXACT address the row was matched on (codex
  // r33 P1): a Customer 360 correction fanning a new premise onto the row
  // between the SELECT and this row lock must win, or the block would be
  // stamped onto the corrected premise and its valid link would 404.
  for (const row of toBlock) {
    await trx('estimates')
      .where({ id: row.id, source: 'quote_wizard', address: row.address })
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

module.exports = { withdrawFlaggedPublications, WITHDRAWABLE_PUBLICATION_STATES };
