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
const { etDateString } = require('../utils/datetime-et');
const { inferServiceLine, inferSpecificService, inferServiceBucket } = require('../utils/service-line-infer');

// The click ids a lead row stores (routes/lead-webhook.js, public-quote.js).
// The ambient _fbp cookie is never paid evidence — Meta sets it on every
// pixel visit, organic included — so it rides along as a match key only.
const CLICK_ID_COLUMNS = ['gclid', 'wbraid', 'gbraid', 'fbclid', 'fbc', 'fbp'];
const PAID_CLICK_ID_COLUMNS = CLICK_ID_COLUMNS.filter((col) => col !== 'fbp');

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
    .update({
      funnel_stage: target,
      updated_at: new Date(),
      // Lead-only funnels (e.g. the photo-assessment claims) create their
      // attribution row BEFORE a customer exists, and revenue sync loads rows
      // by customer_id only (ad-attribution-sync) — so stamp the lead's
      // customer onto the row at every stage advance. COALESCE keeps an
      // already-stamped customer_id untouched, and rows whose lead has no
      // customer yet simply stay NULL until a later transition.
      customer_id: handle.raw(
        'COALESCE(ad_service_attribution.customer_id, (SELECT l.customer_id FROM leads l WHERE l.id = ad_service_attribution.lead_id))',
      ),
    });
  if (db && db.isTransaction && typeof db.transaction === 'function') {
    return db.transaction((sp) => run(sp));
  }
  return run(db);
}

/**
 * bridgeLeadFunnelStage(leadId, leadStatus, database?, { onlyIfLead }?)
 * Advance the funnel row linked to `leadId` to the stage `leadStatus` maps to.
 * `onlyIfLead` (column → value on `leads`): the advance is conditioned IN
 * THE SAME STATEMENT on the lead row still matching it — a caller that
 * validated a lead as its opportunity pins the identity / status / estimate
 * link it validated, so a staff edit landing between that read and this
 * write makes the advance lose instead of booking a row that is no longer
 * that opportunity's (codex #3834 r29 P1).
 * Returns { updated, stage } or { updated: 0, reason }.
 */
async function bridgeLeadFunnelStage(leadId, leadStatus, database = null, { onlyIfLead = null } = {}) {
  const db = database || require('../models/db');
  try {
    const target = LEAD_STATUS_TO_FUNNEL_STAGE[leadStatus];
    if (!leadId || !target) return { updated: 0, reason: 'no_mapping' };

    const updated = await runStageUpdate(db, target, (q) => {
      q.where({ lead_id: leadId });
      if (onlyIfLead) {
        q.whereExists(function leadStillMatches() {
          this.select(1).from('leads').whereRaw('leads.id = ad_service_attribution.lead_id').where(onlyIfLead).whereNull('deleted_at');
        });
      }
      return q;
    });
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

// The attribution snapshot intake stored on a wizard row (public-quote.js
// extracted_data: utm / referrer / landing_url; the click ids are first-class
// columns), shaped as the request attribution intake fed the resolver. Null
// for a row that never stored one.
function storedTouch(lead) {
  let data = lead.extracted_data;
  if (typeof data === 'string') { try { data = JSON.parse(data); } catch { data = null; } }
  if (!data || !('utm' in data || 'referrer' in data || 'landing_url' in data)) return null;
  return {
    utm: data.utm || null,
    referrer: data.referrer || null,
    landing_url: data.landing_url || null,
    ...Object.fromEntries(CLICK_ID_COLUMNS.map((col) => [col, lead[col] || null])),
  };
}

// The channel the row's own intake stamped — through the SAME resolver
// intake used (lead-source-resolver), fed the stored snapshot, so source
// detail, campaign / term and paid evidence (a cpc UTM counts even without a
// click id) come back exactly as the row's own run computed them (pre-push
// P1 on #3834 r15). A row with no snapshot (older rows) falls back to its
// lead source's channel with its click ids as the paid evidence (r11 P2).
// Null when the row should get no funnel row at all (no channel — offline /
// word-of-mouth / undecided), exactly as its own intake would have decided.
async function resolveStoredTouch(db, lead) {
  // Lazy: both modules load the db module at require time.
  const { attributionForSourceType } = require('./ads/call-attribution');
  const touch = storedTouch(lead);
  if (touch) {
    const { resolveLeadSource } = require('./lead-source-resolver');
    const meta = await resolveLeadSource(touch);
    const channel = attributionForSourceType(meta.sourceType);
    return channel && {
      channel,
      detail: meta.leadSourceDetail || null,
      utmCampaign: touch.utm?.campaign || null,
      utmTerm: touch.utm?.term || null,
      isPaid: !!channel.isPaid && meta.isPaidClick === true,
    };
  }
  const source = lead.lead_source_id ? await db('lead_sources').where({ id: lead.lead_source_id }).first('source_type') : null;
  const channel = attributionForSourceType(source?.source_type);
  return channel && {
    channel,
    detail: null,
    utmCampaign: null,
    utmTerm: null,
    isPaid: !!channel.isPaid && PAID_CLICK_ID_COLUMNS.some((col) => !!lead[col]),
  };
}

/**
 * stampLeadFunnelRow(database, lead, { customerId?, serviceInterest?, funnelStage? })
 * Create the ONE ad_service_attribution row a lead row's own intake would
 * have stamped, rebuilt from what the row stored — its attribution snapshot
 * through the intake resolver (resolveStoredTouch), its click ids, its
 * service, its first-contact date — never from the current request's touch,
 * which would credit acquisition to the wrong visit and corrupt first-touch
 * ROI (codex #3834 r11 P2). Two callers:
 *   • the quote wizard's repeat-run root repair (routes/public-quote.js): a
 *     repeat skips its own row because the chain root carries the prospect,
 *     and rebuilds the root's row when the root's own best-effort insert
 *     never landed (codex #3834 r10 P2) — at the stage the root's CURRENT
 *     status maps to, since the transitions it already made bridged
 *     nothing while no row existed and a later same-stage event is a
 *     monotonic no-op (codex #3834 r15 P2);
 *   • a duplicate row taking a win whose root is not ours to book
 *     (lead-estimate-link.js): the win would otherwise reach no funnel row at
 *     all (codex #3834 r14 P2) — stamped straight at 'booked', the stage the
 *     bridge would have set.
 * `customerId` / `serviceInterest` fill in only what the row lacks — the row
 * belongs to ITS customer (codex #3834 r13 P2). A stored touch with no
 * channel gets no row, exactly as the row's own intake would have.
 * `funnelStage` overrides the status-derived stage (the winner is stamped
 * at 'booked' while its row still reads 'duplicate'). Idempotent on the
 * UNIQUE lead_id; returns the id of the row THIS call inserted, or null when
 * one already existed / nothing applied / the write failed (best-effort,
 * like the bridge).
 */
async function stampLeadFunnelRow(database, lead, { customerId = null, serviceInterest = null, funnelStage = null } = {}) {
  const db = database || require('../models/db');
  try {
    if (!lead) return null;
    const stage = funnelStage || LEAD_STATUS_TO_FUNNEL_STAGE[lead.status] || 'lead';
    const touch = await resolveStoredTouch(db, lead);
    if (!touch) return null;
    const interest = lead.service_interest || serviceInterest;
    const [inserted] = await db('ad_service_attribution').insert({
      customer_id: lead.customer_id || customerId,
      lead_id: lead.id,
      service_line: inferServiceLine(interest),
      specific_service: inferSpecificService(interest),
      service_bucket: inferServiceBucket(interest),
      // The ORIGINAL touch's date is the first contact (an imported or
      // backfilled lead's created_at is the import, not the inquiry).
      lead_date: etDateString(new Date(lead.first_contact_at || lead.created_at || Date.now())),
      lead_source: touch.channel.leadSource,
      lead_source_detail: touch.detail,
      ...Object.fromEntries(CLICK_ID_COLUMNS.map((col) => [col, lead[col] || null])),
      utm_campaign: touch.utmCampaign,
      utm_term: touch.utmTerm,
      funnel_stage: stage,
      is_paid: touch.isPaid,
    }).onConflict('lead_id').ignore().returning('id');
    return inserted ? inserted.id : null;
  } catch (err) {
    logger.warn(`[lead-funnel-bridge] funnel row stamp failed for lead ${lead?.id}: ${err.message}`);
    return null;
  }
}

module.exports = {
  bridgeLeadFunnelStage,
  bridgeLeadsFunnelStage,
  stampLeadFunnelRow,
  // exported for unit tests
  FUNNEL_STAGE_RANK,
  LEAD_STATUS_TO_FUNNEL_STAGE,
};
