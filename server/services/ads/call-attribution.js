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
// Shared with the web lead path so call + web leads bucket identically.
const { inferServiceLine, inferSpecificService, inferServiceBucket } = require('../../utils/service-line-infer');

// Map a lead_sources.source_type to the ad_service_attribution channel key +
// paid flag, so inbound CALLS bucket into the SAME channels as web-form leads
// (which write these keys directly). Without this, an organic call — e.g. someone
// calling the tracking number on a spoke site — creates a lead but never a funnel
// row, so whole organic channels (spoke domains, the hub city pages, GBP) are
// invisible to the LTV:CAC / "where to put ad dollars" surfaces even though they drive real
// business. Paid tracking numbers stay paid; organic marketing sources are unpaid
// but still real acquisition channels the card should show.
//
// IMPORTANT — main_site is the website city-page numbers (migration 20260628000001).
// It's mapped here (waves_website), BUT one of those numbers is the Google Ads
// call-bridge target and is SHARED with paid Google call-extension traffic. The
// CALLER must skip that one number (google-call-bridge.isBridgeTargetNumber) —
// pre-attributing it organic would lock the funnel row (recordCallPpcAttribution
// won't change an existing row's lead_source) so the bridge could never mark the
// call paid. The other (non-bridge) city-page numbers attribute organic normally.
//
// Word-of-mouth / offline sources (referral, walk_in, vehicle, tollfree, direct
// field-observation) and marketplaces (Yelp/Nextdoor share source_type=marketplace
// with different channels) are intentionally NOT mapped — they aren't ad-dollar
// channels and their canonical keys need an owner decision. null ⇒ no funnel row.
const SOURCE_TYPE_ATTRIBUTION = {
  google_ads:      { leadSource: 'google_ads',      isPaid: true },
  facebook:        { leadSource: 'facebook',        isPaid: true },
  spoke_site:      { leadSource: 'domain_website',  isPaid: false },
  main_site:       { leadSource: 'waves_website',   isPaid: false },
  gbp:             { leadSource: 'google_business', isPaid: false },
  website_organic: { leadSource: 'google_business', isPaid: false },
};

/**
 * attributionForSourceType(sourceType)
 * @returns {{leadSource:string, isPaid:boolean}|null} the funnel channel + paid
 *   flag for a lead_sources.source_type, or null when the source shouldn't get a
 *   PPC-funnel row (offline / word-of-mouth / undecided).
 */
function attributionForSourceType(sourceType) {
  return SOURCE_TYPE_ATTRIBUTION[sourceType] || null;
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
 * Record an inbound paid call lead in the PPC funnel (one row per lead).
 *   - leadId: REQUIRED — a funnel row represents an actual lead, so an
 *     existing-customer call that matched no lead is never counted. Dedupe is by
 *     lead_id, so two distinct leads for one customer on the same day (e.g. a web
 *     form AND a phone call) get distinct rows, while the bridge re-run /
 *     dedicated-number paths stay idempotent on the same call.
 *   - leadDate: the ACTUAL call date (Date or string). The bridge can apply
 *     matches for calls up to ~90 days old, so date the row by the call, not by
 *     the day the bridge/cron runs (keeps /admin/ads period filters correct).
 *   - serviceInterest: the extracted service, passed directly when the lead row
 *     doesn't carry service_interest yet (new call leads get it after a later
 *     enrichment write). service_line/specific_service/service_bucket are filled
 *     via the SHARED inferers so call leads bucket exactly like web leads.
 *   - An existing row is backfilled (campaign / detail / service fields) when a
 *     later path brings richer data, instead of being skipped.
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
  isPaid = true,
} = {}) {
  if (!customerId) return { recorded: false, reason: 'no_customer' };
  if (!leadId) return { recorded: false, reason: 'no_lead' };
  const day = leadDate
    ? etDateString(leadDate instanceof Date ? leadDate : new Date(leadDate))
    : etDateString();
  try {
    const campaignId = await resolveCampaignId(googleCampaignId);

    // Resolve the service text (explicit > the lead's stored value), then derive
    // line/specific/bucket with the shared inferers (always concrete — matches
    // the web path so service-line ROI groups call leads the same way).
    let interest = serviceInterest;
    if (!interest) {
      const lead = await db('leads').where({ id: leadId }).select('service_interest').first().catch(() => null);
      interest = lead?.service_interest || null;
    }
    const serviceLine = inferServiceLine(interest);
    const specificService = inferSpecificService(interest);
    const serviceBucket = inferServiceBucket(interest);

    // One funnel row per lead — dedupe by lead_id. Backfill richer data onto an
    // existing row (e.g. the bridge later supplies the campaign).
    const existing = await db('ad_service_attribution').where({ lead_id: leadId }).first();
    if (existing) {
      // The lead already has a funnel row. If it belongs to a DIFFERENT source
      // (e.g. it was first a WEB-form lead and the customer later called the paid
      // number), don't create a duplicate and don't override its source — the
      // lead keeps its original attribution and is counted once.
      if (existing.lead_source && existing.lead_source !== leadSource) {
        return { recorded: false, reason: 'other_source' };
      }
      // A web-attributed row owns this lead's first-touch PPC attribution — via a
      // click id (Google: gclid/wbraid/gbraid, Meta: fbclid/_fbc) OR, for
      // consent/ad-blocker cases with no click id, via UTM (utm_campaign/utm_term).
      // A later phone call to the same lead must NOT overwrite that. Call rows never
      // carry click ids/cookies or UTMs, so this only excludes genuine web rows.
      if (existing.gclid || existing.wbraid || existing.gbraid
        || existing.fbclid || existing.fbc
        || existing.utm_campaign || existing.utm_term) {
        return { recorded: false, reason: 'web_attributed' };
      }
      // Upgrade placeholders, not just nulls — the first path (dedicated number)
      // inserts a row with a generic detail ("inbound call") + default service
      // bucket, and a later bridge run brings the REAL campaign + a now-known
      // service. Only-fill-null guards would leave those placeholders forever.
      const hasInterest = !!(interest && String(interest).trim());
      const patch = {};
      if (campaignId && !existing.campaign_id) {
        // Bridge brought the real campaign — set it AND replace the generic
        // placeholder detail with the campaign name. (Don't overwrite an
        // already-set campaign: first-touch attribution wins.)
        patch.campaign_id = campaignId;
        if (leadSourceDetail) patch.lead_source_detail = leadSourceDetail;
      } else if (leadSourceDetail && !existing.lead_source_detail) {
        patch.lead_source_detail = leadSourceDetail;
      }
      // A service derived from a KNOWN interest replaces a default-placeholder
      // bucket; an unknown/default inference only fills genuinely-missing fields.
      const applyService = (col, val) => {
        if (!val) return;
        if (hasInterest ? val !== existing[col] : !existing[col]) patch[col] = val;
      };
      applyService('service_line', serviceLine);
      applyService('specific_service', specificService);
      applyService('service_bucket', serviceBucket);
      if (Object.keys(patch).length) {
        patch.updated_at = new Date();
        await db('ad_service_attribution').where({ id: existing.id }).update(patch);
        return { recorded: true, updated: true, campaignId: campaignId || existing.campaign_id || null };
      }
      return { recorded: false, reason: 'already_recorded' };
    }

    // ON CONFLICT (lead_id) DO NOTHING — two overlapping bridge-apply runs could
    // both miss the lookup above; the unique index + ignore prevents a duplicate
    // row (the loser is a no-op; a later run backfills any missing campaign).
    await db('ad_service_attribution').insert({
      campaign_id: campaignId,
      customer_id: customerId,
      lead_id: leadId,
      service_line: serviceLine,
      specific_service: specificService,
      service_bucket: serviceBucket,
      lead_date: day,
      lead_source: leadSource,
      lead_source_detail: leadSourceDetail,
      funnel_stage: 'lead',
      // Calls carry no click ids (gclid/fbclid), so this flag — not a cookie — is
      // how the paid filters count them: a paid-number call (google_ads/facebook)
      // is is_paid=true so a Facebook call isn't mis-bucketed as organic, while an
      // organic-marketing call (spoke domain / hub / GBP) is is_paid=false so it
      // stays out of the paid ratio. Defaults true for the paid callers.
      is_paid: isPaid,
    }).onConflict('lead_id').ignore();
    logger.info(`[call-attribution] recorded ${leadSource} call lead ${leadId}${campaignId ? ` (campaign ${campaignId})` : ''}`);
    return { recorded: true, campaignId };
  } catch (err) {
    logger.error(`[call-attribution] record failed: ${err.message}`);
    return { recorded: false, reason: 'error', error: err.message };
  }
}

module.exports = {
  recordCallPpcAttribution,
  attributionForSourceType,
  _private: { resolveCampaignId, SOURCE_TYPE_ATTRIBUTION },
};
