/**
 * Call -> PPC attribution. Records an inbound PAID phone-call lead in the PPC
 * funnel table (ad_service_attribution) so phone leads show up in the Google Ads
 * ROI views (revenue-attribution / funnel) alongside web leads — instead of
 * being invisible to PPC reporting.
 *
 * Calls carry no gclid, so campaign attribution comes from Google's own call
 * reporting (the call-reporting bridge passes the campaign id it matched). When
 * no campaign is known yet (e.g. a dedicated Google Ads tracking number before
 * per-campaign numbers exist) the row is still tagged lead_source='google_ads'
 * with a null campaign_id — the "single GA number now, per-campaign-ready" shape.
 *
 * Feeding the call lead BACK to Google Ads (Enhanced Conversions for Leads via
 * hashed phone) is handled separately by offline-conversions.js when the lead is
 * marked qualified — this module only makes the lead visible in OUR funnel.
 */
const db = require('../../models/db');
const logger = require('../logger');
const { etDateString } = require('../../utils/datetime-et');

function inferServiceLine(serviceInterest) {
  const s = String(serviceInterest || '').toLowerCase();
  if (!s) return null;
  if (s.includes('lawn')) return 'lawn';
  if (s.includes('mosquito')) return 'mosquito';
  if (s.includes('termite') || s.includes('wdo')) return 'termite';
  if (s.includes('rodent') || s.includes('rat') || s.includes('mice') || s.includes('mouse')) return 'rodent';
  if (s.includes('tree') || s.includes('shrub') || s.includes('palm')) return 'tree_shrub';
  if (s.includes('pest') || s.includes('bug') || s.includes('ant') || s.includes('roach')) return 'pest';
  return null;
}

async function resolveCampaignId(googleCampaignId) {
  if (!googleCampaignId) return null;
  try {
    const row = await db('ad_campaigns')
      .where({ platform: 'google_ads', platform_campaign_id: String(googleCampaignId) })
      .first();
    return row?.id || null;
  } catch (err) {
    logger.warn(`[call-attribution] campaign lookup failed: ${err.message}`);
    return null;
  }
}

/**
 * Record an inbound paid call lead in the PPC funnel.
 *   - leadDate: the ACTUAL call date (Date or string). The bridge can apply
 *     matches for calls up to 90 days old, so we must date the row by the call,
 *     not by the day the bridge/cron runs — otherwise /admin/ads period filters
 *     skew and the idempotency key drifts across replays.
 *   - serviceInterest: the extracted service, passed directly when the lead row
 *     doesn't carry service_interest yet (new call leads get it only after a
 *     later enrichment write).
 *   - If a row already exists for (customer, source, day) but is missing the
 *     campaign (e.g. the dedicated-number path recorded it first with a null
 *     campaign), backfill campaign_id / lead_source_detail / service_line from
 *     the bridge's richer data instead of skipping.
 * @returns {{recorded:boolean, reason?:string, updated?:boolean, campaignId?:string|null}}
 */
async function recordCallPpcAttribution({
  customerId,
  leadId = null,
  leadSource = 'google_ads',
  leadSourceDetail = null,
  googleCampaignId = null,
  leadDate,
  serviceInterest = null,
} = {}) {
  if (!customerId) return { recorded: false, reason: 'no_customer' };
  const day = leadDate
    ? etDateString(leadDate instanceof Date ? leadDate : new Date(leadDate))
    : etDateString();
  try {
    const campaignId = await resolveCampaignId(googleCampaignId);

    // Prefer the explicitly-passed service; fall back to the lead's stored value.
    let serviceLine = inferServiceLine(serviceInterest);
    if (!serviceLine && leadId) {
      const lead = await db('leads').where({ id: leadId }).select('service_interest').first().catch(() => null);
      serviceLine = inferServiceLine(lead?.service_interest);
    }

    // Idempotent per (customer, source, day) — but enrich an existing row when a
    // later path (the bridge) brings the campaign the first path didn't have.
    const existing = await db('ad_service_attribution')
      .where({ customer_id: customerId, lead_source: leadSource, lead_date: day })
      .first();
    if (existing) {
      const patch = {};
      if (campaignId && !existing.campaign_id) patch.campaign_id = campaignId;
      if (leadSourceDetail && !existing.lead_source_detail) patch.lead_source_detail = leadSourceDetail;
      if (serviceLine && !existing.service_line) patch.service_line = serviceLine;
      if (Object.keys(patch).length) {
        patch.updated_at = new Date();
        await db('ad_service_attribution').where({ id: existing.id }).update(patch);
        return { recorded: true, updated: true, campaignId: campaignId || existing.campaign_id || null };
      }
      return { recorded: false, reason: 'already_recorded' };
    }

    await db('ad_service_attribution').insert({
      campaign_id: campaignId,
      customer_id: customerId,
      service_line: serviceLine,
      lead_date: day,
      lead_source: leadSource,
      lead_source_detail: leadSourceDetail,
      funnel_stage: 'lead',
    });
    logger.info(`[call-attribution] recorded ${leadSource} call lead for customer ${customerId}${campaignId ? ` (campaign ${campaignId})` : ''}`);
    return { recorded: true, campaignId };
  } catch (err) {
    logger.error(`[call-attribution] record failed: ${err.message}`);
    return { recorded: false, reason: 'error', error: err.message };
  }
}

module.exports = {
  recordCallPpcAttribution,
  _private: { inferServiceLine, resolveCampaignId },
};
