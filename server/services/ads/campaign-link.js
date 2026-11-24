/**
 * Links ad leads to their Google campaign. Owner 2026-11-23 ("lets fix these"): ad leads carried the Google click id
 * (gclid) but no campaign_id, so no report could say which campaign earned which customer.
 *
 * A step of the 6 AM Google Ads daily sync (ads/google-ads-daily-sync.js). For ad_service_attribution rows of
 * lead_source 'google_ads' (an organic lead can keep a stale gclid) with a well-formed gclid, a lead_date and no
 * campaign_id (up to BATCH a run, least recently tried first; the try times are kept in system_settings TRIED_KEY so
 * every lead gets a turn). The click can come days before the lead (lead_date is the form or call day):
 *   - lead day still inside Google's click window (CLICK_VIEW_DAYS): Google's click_view names the campaign of that
 *     exact click -> basis 'gclid_click_view'. Each run asks every day from the lead day back CLICK_BACK_DAYS that
 *     Google still keeps, newest first, in one query per day for all the run's leads (clickViewCampaigns). A campaign
 *     Google names that is not in ad_campaigns yet is kept with the try, and a later run links it without asking
 *     Google again. No answer = tried again on a later run.
 *   - lead day older than the window: Google no longer keeps the click, so there is no click-level proof and the lead
 *     stays unlinked (never inferred from spend: a click can be refunded as invalid, and the click day is unknown).
 * A Google failure saves the tries made so far, then fails the step, so the next run moves on to other leads.
 * Writes only campaign_id + campaign_link_basis, only where campaign_id is still NULL. Read-only toward Google.
 */
const db = require('../../models/db');
const logger = require('../logger');
const { etDateString, addETDays, parseETDateTime } = require('../../utils/datetime-et');
const { dateOnlyString } = require('../../utils/date-only');
const { errorText } = require('./google-ads-config');

// Google answers click_view for the last 90 days.
const CLICK_VIEW_DAYS = 90;
// How far before the lead a click can be (Google's click attribution window is at most 90 days): the search stops there.
const CLICK_BACK_DAYS = 90;
const BATCH = 10;
const TRIED_KEY = 'ads.campaign_link.tried';

// A pg DATE value as YYYY-MM-DD (the shared reader, never a local slice).
const dayString = dateOnlyString;

// The ET calendar day `n` days before `day` (YYYY-MM-DD), through the shared ET helpers.
function daysBack(day, n) {
  return etDateString(addETDays(parseETDateTime(`${day}T12:00`), -n));
}

// gclids are URL-safe base64; anything else never reaches the query.
const GCLID_RE = /^[A-Za-z0-9_-]{10,200}$/;

/**
 * Google campaign ids by lead from click_view. `spans` maps each lead id to { gclid, days } (the days its click may be
 * on). One query per day asks every gclid of a lead still open on it (click_view takes one day a query), newest day
 * first, so a run is at most CLICK_BACK_DAYS + 1 queries whatever the number of leads. A match on a day goes only to
 * the leads whose own span holds that day (two leads can share a gclid). Fills `found` (lead id -> Google campaign
 * id), so the matches of the days already asked survive a later failed query.
 */
async function clickViewCampaigns(customer, spans, found) {
  const days = [...new Set([...spans.values()].flatMap((s) => s.days))].sort().reverse();
  for (const day of days) {
    const open = [...spans].filter(([id, s]) => !found.has(id) && s.days.includes(day));
    if (!open.length) continue;
    const gclids = [...new Set(open.map(([, s]) => s.gclid))];
    const rows = await customer.query(
      `SELECT click_view.gclid, campaign.id FROM click_view WHERE segments.date = '${day}' AND click_view.gclid IN (${gclids.map((g) => `'${g}'`).join(', ')})`,
    );
    for (const r of rows) {
      const gclid = r?.click_view?.gclid;
      if (!gclid || r?.campaign?.id == null) continue;
      for (const [id, s] of open) if (s.gclid === gclid) found.set(id, String(r.campaign.id));
    }
    if (found.size === spans.size) break;
  }
}

/** Lead id -> { gclid, days Google still keeps that its click may be on }, for the leads still needing a lookup. */
function clickSpans(rows, tried, windowStart) {
  const spans = new Map();
  for (const row of rows) {
    const day = dayString(row.lead_date);
    if (tried[row.id]?.google_campaign_id || day < windowStart) continue;
    const days = Array.from({ length: CLICK_BACK_DAYS + 1 }, (_, back) => daysBack(day, back)).filter((d) => d >= windowStart);
    spans.set(row.id, { gclid: row.gclid, days });
  }
  return spans;
}

/**
 * Marks every lead of the run tried (so a Google failure still moves the next run on), then asks click_view for the
 * leads that need it, batched by day. Every match found is kept with its try. Returns the Google error, if any, so
 * the caller links the matches it has before failing the step.
 */
async function lookupClicks(customer, rows, tried, { at, windowStart }) {
  for (const row of rows) {
    const known = tried[row.id]?.google_campaign_id;
    tried[row.id] = { at, ...(known ? { google_campaign_id: known } : {}) };
  }
  const spans = clickSpans(rows, tried, windowStart);
  const found = new Map();
  let error = null;
  try {
    if (spans.size) await clickViewCampaigns(customer, spans, found);
  } catch (err) {
    error = err;
  }
  for (const [id, googleId] of found) tried[id].google_campaign_id = googleId;
  return error;
}

function parseTried(v) {
  try {
    const o = typeof v === 'string' ? JSON.parse(v) : v;
    return o && typeof o === 'object' && !Array.isArray(o) ? o : {};
  } catch { return {}; }
}

/**
 * One run. Returns { checked, linked: { gclid_click_view }, unlinked }.
 * Throws when Google refuses a query, so the sync step fails with Google's reason.
 */
async function linkCampaigns({ now = new Date(), conn = db, googleAds = require('./google-ads') } = {}) {
  const customer = googleAds.getCustomer();
  const out = { checked: 0, linked: { gclid_click_view: 0 }, unlinked: 0 };
  if (!customer) return out;
  const windowStart = etDateString(addETDays(now, -CLICK_VIEW_DAYS));
  const triedRow = await conn('system_settings').where({ key: TRIED_KEY }).first();
  const tried = parseTried(triedRow?.value);
  // The whole waiting set (a handful of rows), so ordering by last try reaches every lead.
  const eligible = (await conn('ad_service_attribution')
    .where('lead_source', 'google_ads')
    .whereNotNull('gclid').whereNull('campaign_id').whereNotNull('lead_date')
    // Expired leads never load, unless Google already named their campaign.
    .where((q) => {
      q.where('lead_date', '>=', windowStart);
      const named = Object.keys(tried).filter((id) => tried[id]?.google_campaign_id);
      if (named.length) q.orWhereIn('id', named);
    })
    .select('id', 'gclid', 'lead_date'))
    // A lead past the click window stays only when Google already named its campaign (it waits for the local row).
    .filter((r) => GCLID_RE.test(String(r.gclid)) && (dayString(r.lead_date) >= windowStart || tried[r.id]?.google_campaign_id));
  const triedAt = (id) => String(tried[id]?.at || '');
  // Least recently tried first; among equals (never tried), the oldest lead first: its click expires soonest.
  const rows = [...eligible]
    .sort((a, b) => triedAt(a.id).localeCompare(triedAt(b.id)) || dayString(a.lead_date).localeCompare(dayString(b.lead_date)))
    .slice(0, BATCH);
  out.checked = rows.length;
  if (!rows.length) return out;
  const campaigns = await conn('ad_campaigns').where('platform', 'google_ads').select('id', 'platform_campaign_id');
  const localId = new Map(campaigns.map((c) => [String(c.platform_campaign_id), c.id]));
  const at = now.toISOString();

  try {
    const lookupError = await lookupClicks(customer, rows, tried, { at, windowStart });
    for (const row of rows) {
      const googleId = tried[row.id].google_campaign_id || null;
      const basis = 'gclid_click_view';
      const campaignId = googleId ? localId.get(googleId) || null : null;
      if (!campaignId) { out.unlinked += 1; continue; }
      const n = await conn('ad_service_attribution').where({ id: row.id, lead_source: 'google_ads' }).whereNull('campaign_id')
        .update({ campaign_id: campaignId, campaign_link_basis: basis, updated_at: conn.fn.now() });
      if (n) out.linked[basis] += 1;
    }
    // Matches are linked first; then the step fails with Google's reason.
    if (lookupError) {
      logger.warn(`[ads-campaign-link] Google failed after linking ${out.linked.gclid_click_view}: ${errorText(lookupError)}`);
      throw lookupError;
    }
  } finally {
    // Keep tries only for leads still waiting, also when Google failed mid-run.
    const waiting = new Set(eligible.map((r) => r.id));
    const keep = Object.fromEntries(Object.entries(tried).filter(([id]) => waiting.has(id)));
    const value = JSON.stringify(keep);
    await conn('system_settings').insert({ key: TRIED_KEY, value, category: 'ads', description: 'Ad lead campaign link: last try per waiting lead (and a campaign Google named)' })
      .onConflict('key').merge({ value, updated_at: conn.fn.now() });
  }
  logger.info(`[ads-campaign-link] checked ${out.checked}, linked ${JSON.stringify(out.linked)}, unlinked ${out.unlinked}`);
  return out;
}

module.exports = { linkCampaigns, CLICK_VIEW_DAYS, _internals: { daysBack, GCLID_RE } };
