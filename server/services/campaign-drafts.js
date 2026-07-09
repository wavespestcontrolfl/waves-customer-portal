/**
 * Existing-customer campaign drafts V1 — the upsell draft generator.
 *
 * HARD CONTRACT: this lane NEVER sends a customer message. Every path ends in
 * a message_drafts row with status='pending' (campaign_type + purpose set) for
 * owner approval in the drafts queue. The only send path is the operator's
 * explicit approve/revise click on /api/admin/drafts, which runs the full
 * messaging policy chain (marketing consent, seasonal_tips/sms_enabled prefs,
 * suppression).
 *
 * Gate: GATE_CAMPAIGN_DRAFTS (config/feature-gates.js `campaignDrafts`),
 * default OFF everywhere. Gate off = shadow mode: the generator computes the
 * guarded candidate list and logs the COUNT only — zero drafts written.
 *
 * Guard stack: the eligibility/cooldown/prefs guards live in the SHARED
 * pre-send gate (services/campaign-drafts-gate.js) — the same module the
 * approve/revise route re-runs at send time, so a draft that sits pending
 * while the world changes (customer rebooks, another lane sends, the
 * opportunity gets pitched elsewhere) is re-checked with the exact same
 * predicates. This file only owns draft-time-only concerns: candidate
 * sourcing, never-re-pitch dedupe, copy, and the run cap.
 */

const db = require('../models/db');
const logger = require('./logger');
const { isEnabled } = require('../config/feature-gates');
const { CUSTOMER_STAGES } = require('./customer-stages');
const {
  evaluateCampaignSendGate,
  prefsAllowMarketingSms,
  campaignCooldownReason,
  CAMPAIGN_SMS_TYPES,
  COOLDOWN_DAYS,
} = require('./campaign-drafts-gate');

const CAMPAIGN_GATE = 'campaignDrafts';

// Keep any single run from flooding the owner's approval queue — the daily
// cadence picks up the remainder on subsequent runs.
const MAX_DRAFTS_PER_RUN = 25;

/**
 * Normalize the common non-GSM-7 punctuation (smart quotes, em/en dashes,
 * ellipsis, non-breaking space) to plain ASCII so campaign SMS bodies stay
 * single-encoding. Deterministic templates below are already clean; this also
 * covers DB-rendered template text flowing into reactivation drafts.
 */
function toGsm7Safe(text) {
  return String(text || '')
    .replace(/[‘’ʼ]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[‒–—―]/g, '-')
    .replace(/…/g, '...')
    .replace(/ /g, ' ');
}

/**
 * Deterministic copy per health-scorer recommended_service. No LLM in V1 —
 * short, warm, GSM-7-safe, truthful about what the customer already has (the
 * health-scorer only writes each recommended_service when the matching
 * current-service pattern in its `reason` holds), soft reply CTA.
 */
const UPSELL_COPY = {
  lawn_care: ({ firstName }) =>
    `Hi ${firstName}, thanks for trusting Waves with your pest control. We also do lawn care, and bundling both with WaveGuard Gold saves 15%. Reply here if you'd like a quote.`,
  pest_control: ({ firstName }) =>
    `Hi ${firstName}, glad we get to care for your lawn. Adding pest control with WaveGuard Silver saves 10% on the bundle. Reply here if you'd like a quote.`,
  mosquito_control: ({ firstName }) =>
    `Hi ${firstName}, mosquito season is in full swing here in SWFL. Since you already have services with us, mosquito control is an easy add at Gold-tier savings. Reply here if you'd like details.`,
  termite_monitoring: ({ firstName }) =>
    `Hi ${firstName}, since we already handle your pest control, a quick note that termite monitoring is worth having on any SWFL home. Reply here if you'd like details.`,
  tier_upgrade_silver: ({ firstName, serviceCount }) =>
    `Hi ${firstName}, you have ${serviceCount ? `${serviceCount} services` : 'multiple services'} with us on the Bronze plan. Moving up to Silver saves 10% on what you already get. Reply here and we'll walk you through it.`,
  tier_upgrade_gold: ({ firstName, serviceCount }) =>
    `Hi ${firstName}, with ${serviceCount ? `${serviceCount} services` : 'the services'} you already have on Silver, upgrading to Gold saves 15%. Reply here and we'll walk you through it.`,
};

// health-scorer tier-upgrade reasons carry the true service count
// ("Has N services on Bronze — ..."); surface it when present.
function serviceCountFromReason(reason) {
  const m = /Has (\d+) services/.exec(String(reason || ''));
  return m ? parseInt(m[1], 10) : null;
}

function buildUpsellBody(opp) {
  const template = UPSELL_COPY[opp.recommended_service];
  if (!template) return null;
  return toGsm7Safe(template({
    firstName: opp.first_name || 'there',
    serviceCount: serviceCountFromReason(opp.reason),
  }));
}

/**
 * Daily generator: read upsell_opportunities status='identified' for live
 * customers, apply guards, and write pending campaign drafts
 * (campaign_type='upsell', purpose='marketing').
 *
 * Never-re-pitch reconciliation:
 *   - source_ref dedupe: an opportunity that ever produced a draft (any
 *     status, including rejected/sent) is never drafted again
 *   - a non-'identified' row (pitched/accepted/declined/deferred) for the
 *     same customer + recommended_service blocks re-pitching it
 *   - the unified 30d cooldown covers prior sends from every existing lane
 */
async function generateUpsellDrafts() {
  const gateOn = isEnabled(CAMPAIGN_GATE);

  const opportunities = await db('upsell_opportunities as uo')
    .join('customers as c', 'uo.customer_id', 'c.id')
    .where('uo.status', 'identified')
    .where('c.active', true)
    .whereNull('c.deleted_at')
    .whereIn('c.pipeline_stage', CUSTOMER_STAGES)
    .whereNotNull('c.phone')
    .orderBy('uo.created_at', 'asc')
    .select(
      'uo.id as opportunity_id',
      'uo.customer_id',
      'uo.recommended_service',
      'uo.reason',
      'c.first_name',
      // Injected into the shared gate below so it revalidates THIS row
      // instead of re-reading what the join just returned.
      'c.active as customer_active',
      'c.pipeline_stage as customer_pipeline_stage',
      'c.deleted_at as customer_deleted_at',
      'c.churned_at as customer_churned_at'
    );

  const candidates = [];
  const skipped = {};
  const skip = (reason) => { skipped[reason] = (skipped[reason] || 0) + 1; };
  const draftedCustomers = new Set(); // one campaign draft per customer per run

  for (const opp of opportunities) {
    if (!UPSELL_COPY[opp.recommended_service]) { skip('no_template'); continue; }
    if (draftedCustomers.has(opp.customer_id)) { skip('customer_already_in_run'); continue; }

    const priorDraft = await db('message_drafts')
      .where({ source_ref: `upsell_opportunities:${opp.opportunity_id}` })
      .first('id');
    if (priorDraft) { skip('already_drafted'); continue; }

    const alreadyPitched = await db('upsell_opportunities')
      .where({ customer_id: opp.customer_id, recommended_service: opp.recommended_service })
      .whereNot('status', 'identified')
      .first('id');
    if (alreadyPitched) { skip('already_pitched'); continue; }

    // Shared pre-send gate — the SAME stack the approve/revise route re-runs
    // at send time (campaign-drafts-gate.js), so draft-time and send-time
    // guards cannot drift. Customer + opportunity rows are injected from the
    // source query (the joins above already enforce live + identified);
    // the gate adds the prefs and unified-cooldown checks on top.
    const verdict = await evaluateCampaignSendGate({
      campaignType: 'upsell',
      customerId: opp.customer_id,
      sourceRef: `upsell_opportunities:${opp.opportunity_id}`,
      customer: {
        id: opp.customer_id,
        active: opp.customer_active,
        pipeline_stage: opp.customer_pipeline_stage,
        deleted_at: opp.customer_deleted_at,
        churned_at: opp.customer_churned_at,
      },
      opportunity: { id: opp.opportunity_id, status: 'identified' },
    });
    if (!verdict.ok) {
      // Keep the historical shadow-log keys: cooldown verdicts carry the
      // specific trigger in `reason` (recent_campaign_draft / _sms / prepay).
      skip(verdict.code === 'cooldown_active' ? verdict.reason : verdict.code);
      continue;
    }

    candidates.push(opp);
    draftedCustomers.add(opp.customer_id);
  }

  if (!gateOn) {
    logger.info(
      `[campaign-drafts] shadow: ${candidates.length} upsell draft candidate(s) ` +
      `(gate off - no drafts written, no sends) skipped=${JSON.stringify(skipped)}`
    );
    return { gate: 'off', candidates: candidates.length, drafted: 0, skipped };
  }

  let drafted = 0;
  for (const opp of candidates) {
    if (drafted >= MAX_DRAFTS_PER_RUN) { skip('run_cap_deferred'); continue; }
    try {
      await db('message_drafts').insert({
        customer_id: opp.customer_id,
        draft_response: buildUpsellBody(opp),
        status: 'pending',
        campaign_type: 'upsell',
        purpose: 'marketing',
        source_ref: `upsell_opportunities:${opp.opportunity_id}`,
        context_summary: `Upsell campaign draft (${opp.recommended_service}): ${opp.reason || 'no reason recorded'}`,
      });
      drafted++;
    } catch (err) {
      logger.error(`[campaign-drafts] draft insert failed for customer ${opp.customer_id}: ${err.message}`);
    }
  }

  logger.info(
    `[campaign-drafts] ${drafted} pending upsell draft(s) written for owner approval ` +
    `(${candidates.length} candidate(s)) skipped=${JSON.stringify(skipped)}`
  );
  return { gate: 'on', candidates: candidates.length, drafted, skipped };
}

module.exports = {
  CAMPAIGN_GATE,
  // Re-exported from campaign-drafts-gate.js for existing importers — the
  // gate module is the single source of truth for the shared guards.
  CAMPAIGN_SMS_TYPES,
  COOLDOWN_DAYS,
  prefsAllowMarketingSms,
  campaignCooldownReason,
  MAX_DRAFTS_PER_RUN,
  toGsm7Safe,
  generateUpsellDrafts,
  _internals: {
    UPSELL_COPY,
    buildUpsellBody,
    serviceCountFromReason,
  },
};
