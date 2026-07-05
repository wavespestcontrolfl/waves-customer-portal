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
 * Terminal semantics:
 *   • 'completed' is written only by the revenue sync and is sticky — the
 *     bridge never overwrites it (not even with 'lost').
 *   • 'lost' collapses any intermediate stage. Every CLOSED lead status that
 *     isn't won (lost / unresponsive / disqualified / duplicate — the
 *     CLOSED_LEAD_STATUSES set) maps here, matching how the funnel card
 *     buckets losses (lead-funnel.js counts a single terminal 'lost' rung).
 *   • lost is recoverable ONLY by a positive close: the admin convert /
 *     schedule / manual paths can legitimately move a lost lead back to won,
 *     so the 'booked' transition may advance FROM lost — which also puts the
 *     row back in ad-attribution-sync's ADVANCEABLE_STAGES, so a recovered
 *     deal can still reach 'completed' and receive revenue attribution.
 *     Intermediate stages (contacted/estimate_*) still can't leave lost.
 *
 * Best-effort: never throws into a caller (a funnel write must not break a
 * lead transition). Accepts a database handle so trx callers stay atomic —
 * and when that handle IS a transaction, the bridge UPDATE runs inside its
 * own SAVEPOINT (knex nested transaction): in Postgres, a failed statement
 * leaves the enclosing transaction aborted even when the exception is caught,
 * so without the savepoint a bridge SQL error would doom the caller's
 * conversion/sweep that this update is supposed to be best-effort FOR. A
 * savepoint failure rolls back only the bridge; the caller's transaction
 * stays usable. (Savepoints nest — a caller already inside its own savepoint,
 * like the phone-booking conversion, just gets one level deeper.)
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
// stays the revenue sync's to write, once visits realize revenue). All closed
// non-won statuses collapse to 'lost' — the staleness sweep parks stale leads
// at 'unresponsive', and leaving those rows at an open stage would overstate
// active/contacted leads while understating losses. Only 'new' (open, pre-
// funnel) maps to nothing.
const LEAD_STATUS_TO_FUNNEL_STAGE = {
  contacted: 'contacted',
  estimate_sent: 'estimate_sent',
  estimate_viewed: 'estimate_viewed',
  won: 'booked',
  lost: 'lost',
  unresponsive: 'lost',
  disqualified: 'lost',
  duplicate: 'lost',
};

// Applies the monotonic/terminal stage predicate for `target` to a query
// already scoped to the right lead rows. Shared by the single and bulk forms
// so their semantics can never drift.
function applyStagePredicate(query, target) {
  if (target === 'lost') {
    // Terminal collapse: lost overwrites any intermediate stage but never
    // 'completed' (sticky) and never re-writes 'lost' (idempotent no-op).
    // NULL must match explicitly — `NULL NOT IN (...)` is unknown in
    // Postgres, and this bridge treats NULL as a defensive rank-0 stage.
    return query.where((q) => q.whereNotIn('funnel_stage', ['completed', 'lost']).orWhereNull('funnel_stage'));
  }
  // Advance only from a STRICTLY lower rank. 'completed' is absent from the
  // list, so nothing is ever downgraded. NULL counts as rank 0 ('lead' is the
  // column default, but a defensively-inserted NULL should still advance).
  const fromStages = Object.keys(FUNNEL_STAGE_RANK)
    .filter((s) => FUNNEL_STAGE_RANK[s] < FUNNEL_STAGE_RANK[target]);
  // Positive close recovers a lost row (see header) — only 'booked' may
  // advance FROM lost.
  if (target === 'booked') fromStages.push('lost');
  return query.where((q) => q.whereIn('funnel_stage', fromStages).orWhereNull('funnel_stage'));
}

// Run the stage UPDATE for `target`, isolated in a SAVEPOINT when the handle
// is a knex transaction (see header). knex's trx.transaction() compiles to
// SAVEPOINT / ROLLBACK TO SAVEPOINT on an already-open transaction.
// `scopeRows` narrows the base query to the caller's lead row(s).
function runStageUpdate(db, target, scopeRows) {
  const run = (handle) => applyStagePredicate(scopeRows(handle('ad_service_attribution')), target)
    .update({ funnel_stage: target, updated_at: new Date() });
  if (db && db.isTransaction && typeof db.transaction === 'function') {
    return db.transaction((sp) => run(sp));
  }
  return run(db);
}

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

    const updated = await runStageUpdate(db, target, (q) => q.where({ lead_id: leadId }));
    return { updated, stage: target };
  } catch (err) {
    logger.warn(`[lead-funnel-bridge] stage bridge failed for lead ${leadId} (${leadStatus}): ${err.message}`);
    return { updated: 0, reason: 'error' };
  }
}

/**
 * bridgeLeadsFunnelStage(leadIds, leadStatus, database?)
 * Set-based form for bulk status writers (Intelligence Bar bulk update, the
 * lead-staleness sweep) — one UPDATE with the exact same stage predicate as
 * the single form. Returns { updated, stage } or { updated: 0, reason }.
 */
async function bridgeLeadsFunnelStage(leadIds, leadStatus, database = null) {
  const db = database || require('../models/db');
  try {
    const target = LEAD_STATUS_TO_FUNNEL_STAGE[leadStatus];
    const ids = (leadIds || []).filter(Boolean);
    if (!ids.length || !target) return { updated: 0, reason: 'no_mapping' };

    const updated = await runStageUpdate(db, target, (q) => q.whereIn('lead_id', ids));
    return { updated, stage: target };
  } catch (err) {
    logger.warn(`[lead-funnel-bridge] bulk stage bridge failed (${leadStatus}, ${(leadIds || []).length} leads): ${err.message}`);
    return { updated: 0, reason: 'error' };
  }
}

module.exports = {
  bridgeLeadFunnelStage,
  bridgeLeadsFunnelStage,
  // exported for unit tests
  FUNNEL_STAGE_RANK,
  LEAD_STATUS_TO_FUNNEL_STAGE,
};
