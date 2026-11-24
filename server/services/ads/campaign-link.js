/**
 * Links ad leads to their Google campaign. Owner 2026-11-23 ("lets fix these"): ad leads carried the Google click id
 * (gclid) but no campaign_id, so no report could say which campaign earned which customer.
 *
 * A step of the 6 AM Google Ads daily sync (ads/google-ads-daily-sync.js). For ad_service_attribution rows of
 * lead_source 'google_ads' (an organic lead can keep a stale gclid) with a well-formed gclid, a lead_date and no
 * campaign_id (up to BATCH a run, least recently tried first; the try times are kept in system_settings TRIED_KEY so
 * every lead gets a turn). The click can come days before the lead (lead_date is the form or call day):
 *   - lead day still inside Google's click window (CLICK_VIEW_DAYS): Google's click_view names the campaign of that
 *     exact click -> basis 'gclid_click_view'. Each run asks every day from the lead day back SPEND_DAYS that Google
 *     still keeps, newest first, in one query per day for all the run's leads (clickViewCampaigns). A campaign Google names that is not in ad_campaigns yet is kept with the try, and
 *     the next run links it without asking Google again. No answer = tried again on a later run.
 *   - lead day older than the window (Google no longer keeps the click): the click day is unknown (a customer can
 *     reopen an old tagged link), so only proof works: Google's own campaign metrics (never the local copy, which can
 *     miss a sync day) from the account's start (EVER) through the lead day. Exactly one campaign has ever had spend =
 *     no other campaign could have made the click -> basis 'only_campaign_with_spend'. Two or more, or none: left
 *     unlinked.
 * A Google failure saves the tries made so far, then fails the step, so the next run moves on to other leads.
 * A campaign Google names that is not in ad_campaigns is left unlinked (the campaigns step syncs it first).
 * Writes only campaign_id + campaign_link_basis, only where campaign_id is still NULL. Read-only toward Google.
 */
const db = require('../../models/db');
const logger = require('../logger');
const { etDateString, addETDays } = require('../../utils/datetime-et');

// Google answers click_view for the last 90 days.
const CLICK_VIEW_DAYS = 90;
// How far before the lead a click can be (Google's click attribution window is at most 90 days): the exact search
// stops there, and for an older click only one campaign may have spent from that day through the lead day.
const SPEND_DAYS = 90;
const BATCH = 10;
// Before any Waves ad account existed: the start of the one-spender proof.
const EVER = '2015-01-01';
const TRIED_KEY = 'ads.campaign_link.tried';

function dayString(v) {
  if (!v) return null;
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  return String(v).slice(0, 10);
}

function daysBack(day, n) {
  return new Date(Date.parse(`${day}T00:00:00Z`) - n * 86400000).toISOString().slice(0, 10);
}

// gclids are URL-safe base64; anything else never reaches the query.
const GCLID_RE = /^[A-Za-z0-9_-]{10,200}$/;

/**
 * Google campaign ids by gclid from click_view. `spans` maps each gclid to the days it may have been clicked; one
 * query per day asks every gclid still open on it (click_view takes one day a query), newest day first, so a run is at
 * most SPEND_DAYS + 1 queries whatever the number of leads. Fills and returns `found` (gclid -> Google campaign id),
 * so the matches of the days already asked survive a later failed query.
 */
async function clickViewCampaigns(customer, spans, found = new Map()) {
  const days = [...new Set([...spans.values()].flat())].sort().reverse();
  for (const day of days) {
    const open = [...spans].filter(([gclid, span]) => !found.has(gclid) && span.includes(day)).map(([gclid]) => gclid);
    if (!open.length) continue;
    const rows = await customer.query(
      `SELECT click_view.gclid, campaign.id FROM click_view WHERE segments.date = '${day}' AND click_view.gclid IN (${open.map((g) => `'${g}'`).join(', ')})`,
    );
    for (const r of rows) {
      const gclid = r?.click_view?.gclid;
      if (gclid && r?.campaign?.id != null && open.includes(gclid)) found.set(gclid, String(r.campaign.id));
    }
    if (found.size === spans.size) break;
  }
  return found;
}

/** The one Google campaign id with spend from `from` to `to`, read from Google's campaign metrics, or null. */
async function onlyCampaignWithSpend(customer, from, to) {
  const rows = await customer.query(
    `SELECT campaign.id, metrics.cost_micros FROM campaign WHERE segments.date BETWEEN '${from}' AND '${to}' AND metrics.cost_micros > 0`,
  );
  const ids = [...new Set(rows.map((r) => String(r?.campaign?.id)).filter((id) => id && id !== 'undefined'))];
  return ids.length === 1 ? ids[0] : null;
}

/** gclid -> the days its click may be on that Google still keeps, for the leads still needing an exact lookup. */
function clickSpans(rows, tried, windowStart) {
  const spans = new Map();
  for (const row of rows) {
    const day = dayString(row.lead_date);
    if (tried[row.id]?.google_campaign_id || day < windowStart) continue;
    spans.set(row.gclid, Array.from({ length: SPEND_DAYS + 1 }, (_, back) => daysBack(day, back)).filter((d) => d >= windowStart));
  }
  return spans;
}

/**
 * Marks every lead of the run tried (so a Google failure still moves the next run on), then asks click_view for the
 * leads that need it, batched by day. An exact match is kept with its try even when a later day's query failed.
 */
async function lookupClicks(customer, rows, tried, { at, windowStart }) {
  for (const row of rows) {
    const known = tried[row.id]?.google_campaign_id;
    tried[row.id] = { at, ...(known ? { google_campaign_id: known } : {}) };
  }
  const spans = clickSpans(rows, tried, windowStart);
  const clicks = new Map();
  try {
    if (spans.size) await clickViewCampaigns(customer, spans, clicks);
  } finally {
    for (const row of rows) if (clicks.has(row.gclid)) tried[row.id].google_campaign_id = clicks.get(row.gclid);
  }
  return clicks;
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
  // The whole waiting set (a handful of rows), so ordering by last try reaches every lead.
  const eligible = (await conn('ad_service_attribution')
    .where('lead_source', 'google_ads')
    .whereNotNull('gclid').whereNull('campaign_id').whereNotNull('lead_date')
    .orderBy('lead_date', 'desc')
    .select('id', 'gclid', 'lead_date'))
    .filter((r) => GCLID_RE.test(String(r.gclid)));
  const triedRow = await conn('system_settings').where({ key: TRIED_KEY }).first();
  const tried = parseTried(triedRow?.value);
  const triedAt = (id) => String(tried[id]?.at || '');
  const rows = [...eligible].sort((a, b) => triedAt(a.id).localeCompare(triedAt(b.id))).slice(0, BATCH);
  out.checked = rows.length;
  if (!rows.length) return out;
  const campaigns = await conn('ad_campaigns').where('platform', 'google_ads').select('id', 'platform_campaign_id');
  const localId = new Map(campaigns.map((c) => [String(c.platform_campaign_id), c.id]));
  const windowStart = etDateString(addETDays(now, -CLICK_VIEW_DAYS));
  const at = now.toISOString();

  try {
    const clicks = await lookupClicks(customer, rows, tried, { at, windowStart });
    for (const row of rows) {
      const day = dayString(row.lead_date);
      const known = tried[row.id].google_campaign_id || clicks.get(row.gclid) || null;
      if (known) tried[row.id].google_campaign_id = known;
      let googleId = known;
      let basis = 'gclid_click_view';
      if (!googleId && day < windowStart) {
        basis = 'only_campaign_with_spend';
        googleId = await onlyCampaignWithSpend(customer, EVER, day);
      }
      const campaignId = googleId ? localId.get(googleId) || null : null;
      if (!campaignId) { out.unlinked += 1; continue; }
      const n = await conn('ad_service_attribution').where({ id: row.id, lead_source: 'google_ads' }).whereNull('campaign_id')
        .update({ campaign_id: campaignId, campaign_link_basis: basis, updated_at: conn.fn.now() });
      if (n) out.linked[basis] += 1;
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
