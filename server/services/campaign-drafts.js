/**
 * Existing-customer campaign drafts V1 — the upsell draft generator plus the
 * shared guards the reactivation campaign (workflows/seasonal-reactivation.js)
 * reuses.
 *
 * HARD CONTRACT: this lane NEVER sends a customer message. Every path ends in
 * a message_drafts row with status='pending' (campaign_type + purpose set) for
 * owner approval in the drafts queue. The only send path is the operator's
 * explicit approve/revise click on /api/admin/drafts, which runs the full
 * messaging policy chain (marketing consent, seasonal_tips/sms_enabled prefs,
 * quiet hours, suppression).
 *
 * Gate: GATE_CAMPAIGN_DRAFTS (config/feature-gates.js `campaignDrafts`),
 * default OFF everywhere. Gate off = shadow mode: the generator computes the
 * guarded candidate list and logs the COUNT only — zero drafts written.
 *
 * Cross-lane dedupe: four existing senders can already hit the same customer
 * (retention agent weekly, seasonal-reactivation Monday, renewal-reminder
 * daily, upsell-trigger post-service). The unified 30-day cooldown checks BOTH
 * message_drafts campaign rows AND sms_log rows carrying those senders'
 * message_type values, so a customer is never stacked with a campaign draft on
 * top of a recent campaign-grade SMS from any lane.
 */

const db = require('../models/db');
const logger = require('./logger');
const { isEnabled } = require('../config/feature-gates');
const { CUSTOMER_STAGES } = require('./customer-stages');

const CAMPAIGN_GATE = 'campaignDrafts';
const COOLDOWN_DAYS = 30;
const COOLDOWN_INTERVAL = `NOW() - INTERVAL '${COOLDOWN_DAYS} days'`;

// message_type values written by the four existing campaign-grade senders:
// upsell-trigger ('upsell'), renewal-reminder ('renewal'), the legacy
// seasonal-reactivation sends ('reactivation'), retention agent
// ('retention_outreach').
const CAMPAIGN_SMS_TYPES = ['upsell', 'renewal', 'reactivation', 'retention_outreach'];

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
 * sms_enabled / seasonal_tips must not be explicitly false. A missing
 * notification_prefs row passes here (both columns default true, and the
 * default-row backfill covers existing customers) — the consent validator
 * re-checks at approve time and fails closed regardless.
 */
async function prefsAllowMarketingSms(customerId) {
  const prefs = await db('notification_prefs')
    .where({ customer_id: customerId })
    .first('sms_enabled', 'seasonal_tips');
  if (!prefs) return true;
  return prefs.sms_enabled !== false && prefs.seasonal_tips !== false;
}

/**
 * Unified 30-day campaign cooldown. Returns a skip-reason string when the
 * customer was already touched by any campaign lane, else null:
 *   - a campaign draft (any campaign_type, any status) written in the window
 *   - a campaign-grade SMS (CAMPAIGN_SMS_TYPES) logged in the window
 *   - an annual-prepay renewal notice (notice_30/15/7_sent_at) fired in the
 *     window — those customers are mid-renewal-conversation, leave them be.
 */
async function campaignCooldownReason(customerId) {
  const recentDraft = await db('message_drafts')
    .where({ customer_id: customerId })
    .whereNotNull('campaign_type')
    .where('created_at', '>', db.raw(COOLDOWN_INTERVAL))
    .first('id');
  if (recentDraft) return 'recent_campaign_draft';

  const recentCampaignSms = await db('sms_log')
    .where({ customer_id: customerId })
    .whereIn('message_type', CAMPAIGN_SMS_TYPES)
    .where('created_at', '>', db.raw(COOLDOWN_INTERVAL))
    .first('id');
  if (recentCampaignSms) return 'recent_campaign_sms';

  const recentPrepayNotice = await db('annual_prepay_terms')
    .where({ customer_id: customerId })
    .where(function () {
      this.where('notice_30_sent_at', '>', db.raw(COOLDOWN_INTERVAL))
        .orWhere('notice_15_sent_at', '>', db.raw(COOLDOWN_INTERVAL))
        .orWhere('notice_7_sent_at', '>', db.raw(COOLDOWN_INTERVAL));
    })
    .first('id');
  if (recentPrepayNotice) return 'recent_prepay_notice';

  return null;
}

/**
 * Approval-time eligibility recheck for a campaign draft. A draft can sit
 * pending for days; the customer can be soft-deleted, deactivated/churned, or
 * flip their prefs between generation and the owner's approve click — and the
 * messaging validators do not reject customers.deleted_at or non-live upsell
 * targets. Re-runs the generator's guards against the CURRENT customer row:
 *   - customer exists and is not soft-deleted (both campaign types)
 *   - upsell only: still live (active + pipeline_stage in CUSTOMER_STAGES) —
 *     reactivation targets are lapsed by design, so no live-stage check
 *   - sms_enabled / seasonal_tips prefs not explicitly false
 * Returns { blockReason, customer } — customer carries nearest_location_id so
 * the approve route can originate the SMS from the customer's local office
 * number, the way the legacy workflows did.
 */
async function campaignApprovalState(draft) {
  if (!draft.customer_id) return { blockReason: 'customer_not_found', customer: null };
  const customer = await db('customers')
    .where({ id: draft.customer_id })
    .first('id', 'deleted_at', 'active', 'pipeline_stage', 'nearest_location_id');
  if (!customer) return { blockReason: 'customer_not_found', customer: null };
  if (customer.deleted_at) return { blockReason: 'customer_deleted', customer };
  if (
    draft.campaign_type === 'upsell' &&
    (customer.active !== true || !CUSTOMER_STAGES.includes(customer.pipeline_stage))
  ) {
    return { blockReason: 'customer_not_live', customer };
  }
  if (!(await prefsAllowMarketingSms(draft.customer_id))) {
    return { blockReason: 'prefs_opted_out', customer };
  }
  return { blockReason: null, customer };
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
      'c.first_name'
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

    if (!(await prefsAllowMarketingSms(opp.customer_id))) { skip('prefs_opted_out'); continue; }

    const cooldown = await campaignCooldownReason(opp.customer_id);
    if (cooldown) { skip(cooldown); continue; }

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
  CAMPAIGN_SMS_TYPES,
  COOLDOWN_DAYS,
  MAX_DRAFTS_PER_RUN,
  toGsm7Safe,
  prefsAllowMarketingSms,
  campaignCooldownReason,
  campaignApprovalState,
  generateUpsellDrafts,
  _internals: {
    UPSELL_COPY,
    buildUpsellBody,
    serviceCountFromReason,
  },
};
