/**
 * Lead-funnel stage bridge — advance a lead's ad_service_attribution row when
 * the lead's pipeline status advances.
 *
 * funnel_stage previously only ever received 'lead' at row creation and
 * 'completed' from ad-attribution-sync — the intermediate rungs (contacted /
 * estimate_sent / estimate_viewed / booked) were schema-only (see
 * lead-funnel.js "DATA REALITY"). The leads table DOES move through those
 * statuses, so every status-transition code path now calls this bridge, which
 * mirrors the transition onto the funnel row joined by the UNIQUE lead_id.
 *
 * Monotonic by construction — the stage rank is enforced IN SQL against the
 * row's CURRENT stage, so a stale/out-of-order event can never downgrade:
 *   lead < contacted < estimate_sent < estimate_viewed < booked < completed
 * Terminal semantics match ad-attribution-sync exactly:
 *   • 'completed' is written only by the revenue sync and is sticky — the
 *     bridge never overwrites it (not even with 'lost').
 *   • 'lost' is terminal for the bridge — a lost row is never advanced
 *     (ADVANCEABLE_STAGES in ad-attribution-sync excludes 'lost' for the same
 *     reason: no silent resurrection). Re-marking lost is a no-op.
 *
 * Best-effort: never throws into a caller (a funnel write must not break a
 * lead transition). Accepts a database handle so trx callers stay atomic.
 * Idempotent — re-firing any event converges.
 */
const logger = require('./logger');

// Rank order mirrors lead-funnel.js REACHED / ad-attribution-sync ADVANCEABLE_STAGES.
const FUNNEL_STAGE_RANK = {
  lead: 0,
  contacted: 1,
  estimate_sent: 2,
  estimate_viewed: 3,
  booked: 4,
  completed: 5,
};

// leads.status → funnel_stage. 'won' = the deal closed/booked ('completed'
// stays the revenue sync's to write, once visits realize revenue). Statuses
// with no funnel meaning (new / unresponsive / duplicate / disqualified) map
// to nothing and no-op.
const LEAD_STATUS_TO_FUNNEL_STAGE = {
  contacted: 'contacted',
  estimate_sent: 'estimate_sent',
  estimate_viewed: 'estimate_viewed',
  won: 'booked',
  lost: 'lost',
};

/**
 * bridgeLeadFunnelStage(leadId, leadStatus, database?)
 * Advance the funnel row linked to `leadId` to the stage `leadStatus` maps to.
 * Returns { updated, stage } or { updated: 0, reason }.
 */
async function bridgeLeadFunnelStage(leadId, leadStatus, database = null) {
  const db = database || require('../models/db');
  try {
    const target = LEAD_STATUS_TO_FUNNEL_STAGE[leadStatus];
    if (!leadId || !target) return { updated: 0, reason: 'no_mapping' };

    const query = db('ad_service_attribution').where({ lead_id: leadId });
    if (target === 'lost') {
      // Terminal collapse: lost overwrites any intermediate stage but never
      // 'completed' (sticky) and never re-writes 'lost' (idempotent no-op).
      query.whereNotIn('funnel_stage', ['completed', 'lost']);
    } else {
      // Advance only from a STRICTLY lower rank. 'lost' and 'completed' are
      // absent from the lower-rank list, so terminal rows are never advanced
      // and nothing is ever downgraded. NULL counts as rank 0 ('lead' is the
      // column default, but a defensively-inserted NULL should still advance).
      const lowerStages = Object.keys(FUNNEL_STAGE_RANK)
        .filter((s) => FUNNEL_STAGE_RANK[s] < FUNNEL_STAGE_RANK[target]);
      query.where((q) => q.whereIn('funnel_stage', lowerStages).orWhereNull('funnel_stage'));
    }

    const updated = await query.update({ funnel_stage: target, updated_at: new Date() });
    return { updated, stage: target };
  } catch (err) {
    logger.warn(`[lead-funnel-bridge] stage bridge failed for lead ${leadId} (${leadStatus}): ${err.message}`);
    return { updated: 0, reason: 'error' };
  }
}

module.exports = {
  bridgeLeadFunnelStage,
  // exported for unit tests
  FUNNEL_STAGE_RANK,
  LEAD_STATUS_TO_FUNNEL_STAGE,
};
