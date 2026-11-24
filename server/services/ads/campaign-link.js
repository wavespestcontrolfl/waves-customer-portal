/**
 * Links ad leads to their Google campaign. Owner 2026-11-23 ("lets fix these"): ad leads carried the Google click id
 * (gclid) but no campaign_id, so no report could say which campaign earned which customer.
 *
 * A step of the 6 AM Google Ads daily sync (ads/google-ads-daily-sync.js). For ad_service_attribution rows with a
 * well-formed gclid, a lead_date and no campaign_id (up to BATCH a run, least recently tried first; the try times are
 * kept in system_settings TRIED_KEY so every lead gets a turn):
 *   - when the lead day or the day before is still inside Google's click window (CLICK_VIEW_DAYS, checked per day):
 *     Google's click_view for those days names the campaign of that exact click -> basis 'gclid_click_view'. No
 *     answer yet = tried again on a later run, until no day is left in the window.
 *   - when neither day is in the window (Google no longer keeps the click): Google's own campaign metrics for the
 *     two days (kept long after click records; never the local copy, which can miss a sync day) -> when exactly one
 *     campaign had spend, that campaign -> basis 'only_campaign_with_spend'. Two or more, or none: left unlinked.
 * A campaign Google names that is not in ad_campaigns is left unlinked (the campaigns step syncs it first).
 * Writes only campaign_id + campaign_link_basis, only where campaign_id is still NULL. Read-only toward Google.
 */
const db = require('../../models/db');
const logger = require('../logger');
const { etDateString, addETDays } = require('../../utils/datetime-et');

// Google answers click_view for the last 90 days.
const CLICK_VIEW_DAYS = 90;
const BATCH = 50;
const ELIGIBLE_MAX = 1000;
const TRIED_KEY = 'ads.campaign_link.tried';

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

/** The one Google campaign id with spend on `days`, read from Google's campaign metrics, or null (none or several). */
async function onlyCampaignWithSpend(customer, days) {
  const rows = await customer.query(
    `SELECT campaign.id, metrics.cost_micros FROM campaign WHERE segments.date BETWEEN '${days[days.length - 1]}' AND '${days[0]}' AND metrics.cost_micros > 0`,
  );
  const ids = [...new Set(rows.map((r) => String(r?.campaign?.id)).filter((id) => id && id !== 'undefined'))];
  return ids.length === 1 ? ids[0] : null;
}

function parseTried(v) {
  try {
    const o = typeof v === 'string' ? JSON.parse(v) : v;
    return o && typeof o === 'object' && !Array.isArray(o) ? o : {};
  } catch { return {}; }
}

/**
 * One run. Returns { checked, linked: { gclid_click_view, only_campaign_with_spend }, unlinked }.
 * Throws when Google refuses a query, so the sync step fails with Google's reason.
 */
async function linkCampaigns({ now = new Date(), conn = db, googleAds = require('./google-ads') } = {}) {
  const customer = googleAds.getCustomer();
  const out = { checked: 0, linked: { gclid_click_view: 0, only_campaign_with_spend: 0 }, unlinked: 0 };
  if (!customer) return out;
  const eligible = (await conn('ad_service_attribution')
    .whereNotNull('gclid').whereNull('campaign_id').whereNotNull('lead_date')
    .orderBy('lead_date', 'desc').limit(ELIGIBLE_MAX)
    .select('id', 'gclid', 'lead_date'))
    .filter((r) => GCLID_RE.test(String(r.gclid)));
  const triedRow = await conn('system_settings').where({ key: TRIED_KEY }).first();
  const tried = parseTried(triedRow?.value);
  const rows = [...eligible].sort((a, b) => String(tried[a.id] || '').localeCompare(String(tried[b.id] || ''))).slice(0, BATCH);
  out.checked = rows.length;
  if (!rows.length) return out;
  const campaigns = await conn('ad_campaigns').where('platform', 'google_ads').select('id', 'platform_campaign_id');
  const localId = new Map(campaigns.map((c) => [String(c.platform_campaign_id), c.id]));
  const windowStart = etDateString(addETDays(now, -CLICK_VIEW_DAYS));
  const at = now.toISOString();

  for (const row of rows) {
    const day = dayString(row.lead_date);
    const days = [day, dayBefore(day)];
    const inWindow = days.filter((d) => d >= windowStart);
    tried[row.id] = at;
    const googleId = inWindow.length
      ? await clickViewCampaign(customer, row.gclid, inWindow)
      : await onlyCampaignWithSpend(customer, days);
    const basis = inWindow.length ? 'gclid_click_view' : 'only_campaign_with_spend';
    const campaignId = googleId ? localId.get(googleId) || null : null;
    if (!campaignId) { out.unlinked += 1; continue; }
    const n = await conn('ad_service_attribution').where({ id: row.id }).whereNull('campaign_id')
      .update({ campaign_id: campaignId, campaign_link_basis: basis, updated_at: conn.fn.now() });
    if (n) out.linked[basis] += 1;
  }
  // Keep try times only for leads still waiting.
  const waiting = new Set(eligible.map((r) => r.id));
  const keep = Object.fromEntries(Object.entries(tried).filter(([id]) => waiting.has(id)));
  const value = JSON.stringify(keep);
  await conn('system_settings').insert({ key: TRIED_KEY, value, category: 'ads', description: 'Ad lead campaign link: last try per waiting lead' })
    .onConflict('key').merge({ value, updated_at: conn.fn.now() });
  logger.info(`[ads-campaign-link] checked ${out.checked}, linked ${JSON.stringify(out.linked)}, unlinked ${out.unlinked}`);
  return out;
}

module.exports = { linkCampaigns, CLICK_VIEW_DAYS, _internals: { dayBefore, GCLID_RE } };
