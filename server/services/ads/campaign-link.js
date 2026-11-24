/**
 * Links ad leads to their Google campaign. Owner 2026-11-23 ("lets fix these"): ad leads carried the Google click id
 * (gclid) but no campaign_id, so no report could say which campaign earned which customer.
 *
 * A step of the 6 AM Google Ads daily sync (ads/google-ads-daily-sync.js). For ad_service_attribution rows with a
 * gclid, a lead_date and no campaign_id (up to BATCH a run, newest first):
 *   - inside Google's click window (CLICK_VIEW_DAYS): Google's click_view for the lead day and the day before names
 *     the campaign of that exact click -> basis 'gclid_click_view'. No answer yet = tried again on the next run.
 *   - older than the window (Google no longer keeps the click): when exactly one Google campaign had spend on the
 *     lead day or the day before (ad_performance_daily), that campaign -> basis 'only_campaign_with_spend'. Two or
 *     more, or none: left unlinked.
 * A campaign Google names that is not in ad_campaigns is left unlinked (the campaigns step syncs it first).
 * Writes only campaign_id + campaign_link_basis, only where campaign_id is still NULL. Read-only toward Google.
 */
const db = require('../../models/db');
const logger = require('../logger');
const { etDateString, addETDays } = require('../../utils/datetime-et');

const CLICK_VIEW_DAYS = 89;
const BATCH = 50;

function dayString(v) {
  if (!v) return null;
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  return String(v).slice(0, 10);
}

function dayBefore(day) {
  return new Date(Date.parse(`${day}T00:00:00Z`) - 86400000).toISOString().slice(0, 10);
}

// gclids are URL-safe base64; anything else never reaches the query.
const GCLID_RE = /^[A-Za-z0-9_-]{10,200}$/;

/** The Google campaign id of `gclid` from click_view on `days`, or null. */
async function clickViewCampaign(customer, gclid, days) {
  for (const day of days) {
    const rows = await customer.query(
      `SELECT campaign.id FROM click_view WHERE segments.date = '${day}' AND click_view.gclid = '${gclid}'`,
    );
    if (rows.length && rows[0]?.campaign?.id != null) return String(rows[0].campaign.id);
  }
  return null;
}

/** The one local Google campaign with spend on `days`, or null when none or more than one. */
async function onlyCampaignWithSpend(conn, days) {
  const rows = await conn('ad_performance_daily as p')
    .join('ad_campaigns as c', 'c.id', 'p.campaign_id')
    .where('c.platform', 'google_ads')
    .whereIn('p.date', days)
    .where('p.cost', '>', 0)
    .distinct('c.id');
  return rows.length === 1 ? rows[0].id : null;
}

/**
 * One run. Returns { checked, linked: { gclid_click_view, only_campaign_with_spend }, unlinked }.
 * Throws when Google refuses a query, so the sync step fails with Google's reason.
 */
async function linkCampaigns({ now = new Date(), conn = db, googleAds = require('./google-ads') } = {}) {
  const rows = await conn('ad_service_attribution')
    .whereNotNull('gclid').whereNull('campaign_id').whereNotNull('lead_date')
    .orderBy('lead_date', 'desc').limit(BATCH)
    .select('id', 'gclid', 'lead_date');
  const out = { checked: rows.length, linked: { gclid_click_view: 0, only_campaign_with_spend: 0 }, unlinked: 0 };
  if (!rows.length) return out;
  const campaigns = await conn('ad_campaigns').where('platform', 'google_ads').select('id', 'platform_campaign_id');
  const localId = new Map(campaigns.map((c) => [String(c.platform_campaign_id), c.id]));
  const windowStart = etDateString(addETDays(now, -CLICK_VIEW_DAYS));
  const customer = googleAds.getCustomer();

  for (const row of rows) {
    const day = dayString(row.lead_date);
    const days = [day, dayBefore(day)];
    let campaignId = null;
    let basis = null;
    if (day >= windowStart) {
      if (customer && GCLID_RE.test(row.gclid)) {
        campaignId = localId.get(await clickViewCampaign(customer, row.gclid, days)) || null;
        basis = 'gclid_click_view';
      }
    } else {
      campaignId = await onlyCampaignWithSpend(conn, days);
      basis = 'only_campaign_with_spend';
    }
    if (!campaignId) { out.unlinked += 1; continue; }
    const n = await conn('ad_service_attribution').where({ id: row.id }).whereNull('campaign_id')
      .update({ campaign_id: campaignId, campaign_link_basis: basis, updated_at: conn.fn.now() });
    if (n) out.linked[basis] += 1;
  }
  logger.info(`[ads-campaign-link] checked ${out.checked}, linked ${JSON.stringify(out.linked)}, unlinked ${out.unlinked}`);
  return out;
}

module.exports = { linkCampaigns, CLICK_VIEW_DAYS, _internals: { dayBefore, GCLID_RE } };
