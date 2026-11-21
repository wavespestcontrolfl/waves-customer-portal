/**
 * Route fill record. Owner 2026-11-21, plan page "Ads Follow the Route": a fill ad shows only in the ZIP codes where a
 * technician of its line works today or tomorrow and has room.
 *
 * This module RECORDS what that rule would do. It changes nothing: it writes nothing to Google and sets no budget.
 * (The rule that acts on the record is a later change, behind its own gate.)
 *
 * A Google campaign is in the record when its ad_campaigns.metadata.route_line names a line of the route-areas
 * record ('pest' or 'lawn'). The mark is the switch: with no marked campaign a run reads ad_campaigns once and stops.
 * For each marked campaign, active or paused, one run (recordRun):
 *   1. builds the route-areas record of this moment (the reads and rules of services/ads/route-areas.js),
 *   2. decides: the line has ZIPs -> base budget and that ZIP list; no ZIPs -> the 1% floor, the list left as it is,
 *   3. reads where the campaign shows in Google and counts the change that would make it the ZIP list: every other
 *      place, radius and location group the campaign shows in would be removed,
 *   4. writes the run to system_settings 'ads.route_fill.last' and 'ads.route_fill.history' (last 120).
 *
 * The record gives the answer a live rule must give, so its checks are the live rule's checks:
 *   - The list is never emptied. A campaign with no location shows everywhere, so "no ZIPs" changes the budget only.
 *   - The Google campaign must be a Search campaign, read from Google (the local campaign_type can be edited).
 *   - The campaign must show to people IN its locations only (Google's "Presence" option). With "Presence or
 *     interest" a right ZIP list still shows the ad elsewhere. The option is read on every run, also with no ZIPs.
 *   - A campaign that fails a check, or whose locations could not be read, gets no base budget (budget_mode null)
 *     and is named in `problems`. A stop stands: it lowers the budget and needs nothing from the list.
 */
const db = require('../../models/db');
const logger = require('../logger');
const routeAreas = require('./route-areas');

// Lazy, like budget-manager: requiring this module must not load the google-ads-api client.
let _googleAds;
function getGoogleAds() { return _googleAds || (_googleAds = require('./google-ads')); }

const LAST_KEY = 'ads.route_fill.last';
const HISTORY_KEY = 'ads.route_fill.history';
const HISTORY_MAX = 120;
// The lines of the route-areas record a campaign can follow ('pest', 'lawn').
const ROUTE_LINES = Object.keys(routeAreas.LINES);

function parseJsonObject(v) {
  if (v && typeof v === 'object' && !Array.isArray(v)) return v;
  if (typeof v === 'string') {
    try { const o = JSON.parse(v); return o && typeof o === 'object' && !Array.isArray(o) ? o : null; } catch { return null; }
  }
  return null;
}

function parseHistory(stored) {
  let history;
  try { history = JSON.parse(stored || '[]'); } catch { history = []; }
  return Array.isArray(history) ? history : [];
}

/** The route line a campaign row is marked with ('pest' | 'lawn'), else null. */
function routeLineOf(campaign) {
  const line = parseJsonObject(campaign?.metadata)?.route_line;
  return ROUTE_LINES.includes(line) ? line : null;
}

/**
 * Pure: what one line of a route-areas record means for its campaign.
 * ZIPs -> { budget_mode: 'base', zips }. None -> { budget_mode: 'stop', zips: [] } (the list is left as it is).
 */
function decideLine(record, line) {
  const rec = record?.lines?.[line];
  const dates = (record?.dates || []).join(' and ');
  if (!rec || !Array.isArray(rec.zips)) throw new Error(`the route record has no ${line} line`);
  if (!rec.zips.length) {
    return { line, budget_mode: 'stop', zips: [], areas: [], reason: `Route rule: no ${line} technician with room on ${dates}` };
  }
  const areas = rec.areas || [];
  return {
    line,
    budget_mode: 'base',
    zips: rec.zips,
    areas,
    reason: `Route rule: ${line} room on ${dates} in ${areas.join(', ') || 'no named area'} (${rec.zips.length} ZIPs)`,
  };
}

/**
 * Pure: the change that makes a campaign show in the wanted geo ids and nowhere else.
 * current = [{ resourceName, type, geoId }]: every place, radius and location group the campaign shows in (geoId is
 * set for a place only). A wanted place stays. Everything else is removed: another ZIP, a city, a radius, a group.
 */
function diffLocations(current, wantedGeoIds) {
  const wanted = new Set(wantedGeoIds.map(String));
  const keeps = (c) => c.geoId != null && wanted.has(String(c.geoId));
  const have = new Set(current.filter(keeps).map((c) => String(c.geoId)));
  return {
    add: [...wanted].filter((id) => !have.has(id)),
    remove: current.filter((c) => !keeps(c)).map((c) => c.resourceName),
  };
}

/**
 * ZIP -> geo id, asked from Google once per run. The ids are not stored: Google can retire a location id, and a stored
 * id that is retired would be wrong for every later run.
 */
async function geoTargets(zips) {
  const found = await getGoogleAds().findPostalGeoTargets(zips);
  if (!found) throw new Error('Google did not answer the ZIP lookup');
  const known = {};
  for (const zip of zips) {
    if (/^\d+$/.test(String(found[zip] ?? ''))) known[zip] = String(found[zip]);
  }
  return known;
}

/**
 * Reads where the campaign shows and counts the change to the ZIP list. Never throws.
 *
 * A ZIP Google has no location id for is left out and named (`unmapped`); the other ZIPs still count. Every ZIP of the
 * list is a place with room, so a shorter list is still a right list. The ZIPs come from the territory table, not from
 * customer addresses.
 */
async function countTargets(campaign, zips, geo) {
  const unmapped = zips.filter((z) => !geo[z]);
  const wanted = zips.filter((z) => geo[z]).map((z) => geo[z]);
  const base = { ok: false, add: 0, remove: 0, unmapped };
  // ZIPs, but none with a Google id: nothing to show in, so the list would not be touched.
  if (zips.length && !wanted.length) return { ...base, error: 'no ZIP of the list has a Google location id' };
  try {
    const geoRead = await getGoogleAds().readCampaignGeoTargets(campaign.platform_campaign_id);
    if (!geoRead) return { ...base, error: 'Google did not answer the location read' };
    if (!geoRead.search) return { ...base, error: 'the Google campaign is not a Search campaign' };
    // Checked on every run, also when the list is already right: with "Presence or interest" the ad shows outside it.
    if (!geoRead.presenceOnly) return { ...base, error: 'the campaign location option is not "Presence": set it in Google Ads' };
    // No ZIPs: only the campaign was checked. The list would be left as it is (an empty list shows everywhere).
    if (!wanted.length) return { ...base, ok: true, current: geoRead.targets.length };
    const { add, remove } = diffLocations(geoRead.targets, wanted);
    return { ...base, ok: true, add: add.length, remove: remove.length, current: geoRead.targets.length };
  } catch (err) {
    return { ...base, error: err.message };
  }
}

/** The Google step of one campaign: null for a campaign that is not in Google. With no ZIPs it checks the campaign only. */
async function campaignTargets(campaign, decision, { geo, geoError }) {
  if (!campaign.platform_campaign_id) return null;
  if (decision.zips.length && geoError) return { ok: false, add: 0, remove: 0, unmapped: [], error: geoError };
  return countTargets(campaign, decision.zips, geo);
}

/** Lays the Google step's result over the decision. Returns the run's problem line for this campaign, or null. */
function applyTargets(decision, targets, campaign) {
  if (!targets) return null;
  if (targets.unmapped.length) {
    decision.reason += `; no Google location for ${targets.unmapped.join(', ')}`;
    logger.warn(`[ads-route-fill] ${campaign.campaign_name}: no Google location id for ZIP ${targets.unmapped.join(', ')}`);
  }
  if (targets.ok) return null;
  // The list could not be made right, so the budget would not go to base. A stop stands: it lowers the budget and
  // needs nothing from the list.
  if (decision.budget_mode !== 'stop') decision.budget_mode = null;
  return `${campaign.campaign_name}: ${targets.error}`;
}

const targetsNote = (t) => {
  if (!t) return '';
  return `, list +${t.add} -${t.remove}${t.ok ? '' : ` FAILED (${t.error})`}`;
};

/** One campaign's entry in the history: the decision in numbers, no ZIP list. */
const compactCampaign = (c) => ({
  campaign_id: c.campaign_id,
  line: c.line,
  status: c.status,
  budget_mode: c.budget_mode,
  zips: c.zips.length,
  areas: c.areas,
  targets: c.targets ? { ok: c.targets.ok, add: c.targets.add, remove: c.targets.remove, unmapped: c.targets.unmapped.length } : null,
});

/** Both rows in one transaction; one history entry per tick (a second run of the same cron occurrence replaces it). */
async function saveRun(conn, run, now) {
  await conn.transaction(async (trx) => {
    const prior = await trx('system_settings').where({ key: HISTORY_KEY }).first();
    const kept = parseHistory(prior?.value).filter((entry) => !entry || entry.tick !== run.tick);
    const entry = { at: run.at, tick: run.tick, mode: run.mode, campaigns: run.campaigns.map(compactCampaign) };
    const history = [...kept, entry].slice(-HISTORY_MAX);
    const upsert = (key, value, description) => trx('system_settings')
      .insert({ key, value, category: 'ads', description })
      .onConflict('key')
      .merge({ value, updated_at: now });
    await upsert(LAST_KEY, JSON.stringify(run), 'Latest ads route-fill run');
    await upsert(HISTORY_KEY, JSON.stringify(history), `Recent ads route-fill runs (last ${HISTORY_MAX})`);
  });
}

/**
 * One run of the record. campaignOk(row) = the caller's own campaign filter (the budget job passes "Search campaigns
 * only", by the local campaign_type).
 *
 * Returns { tick, campaigns, problems }:
 *   campaigns: one entry per marked campaign: { campaign_id, platform_campaign_id, campaign_name, status, line,
 *              budget_mode: 'base' | 'stop' | null, reason, zips, areas, targets }.
 *   problems:  one line per campaign that failed a check or could not be read, plus a failed save. Empty = clean.
 * With no marked campaign it reads nothing more and returns tick null.
 * Throws when the route record cannot be built; nothing is recorded then.
 */
async function recordRun({ now = new Date(), campaignOk = () => true, conn = db } = {}) {
  const problems = [];
  // One plain read; the table holds a handful of rows.
  const rows = await conn('ad_campaigns').where('platform', 'google_ads');
  const campaigns = rows.filter((c) => ['active', 'paused'].includes(c.status) && routeLineOf(c) && campaignOk(c));
  if (!campaigns.length) return { tick: null, campaigns: [], problems };

  const record = routeAreas.buildRouteAreas(await routeAreas.loadRouteAreasInput(conn, now));
  const picked = campaigns.map((c) => ({ campaign: c, decision: decideLine(record, routeLineOf(c)) }));
  const allZips = [...new Set(picked.flatMap((p) => p.decision.zips))].sort();
  let geo = {};
  let geoError = null;
  if (allZips.length) {
    try { geo = await geoTargets(allZips); } catch (err) { geoError = err.message; }
  }

  // mode: this module only records ("shadow"). The field is in the record so later live runs can be told apart.
  const run = { at: now.toISOString(), tick: record.tick, mode: 'shadow', dates: record.dates, campaigns: [] };
  for (const { campaign, decision } of picked) {
    const targets = await campaignTargets(campaign, decision, { geo, geoError });
    const problem = applyTargets(decision, targets, campaign);
    if (problem) problems.push(problem);
    run.campaigns.push({
      campaign_id: campaign.id,
      platform_campaign_id: campaign.platform_campaign_id || null,
      campaign_name: campaign.campaign_name,
      status: campaign.status,
      ...decision,
      targets,
    });
    logger.info(`[ads-route-fill] ${campaign.campaign_name} (${decision.line}, ${campaign.status}): ${decision.budget_mode || 'no decision'}, `
      + `${decision.zips.length} ZIPs${targetsNote(targets)}`);
  }

  try {
    await saveRun(conn, run, now);
  } catch (err) {
    problems.push(`the run was not saved: ${err.message}`);
  }
  return { tick: record.tick, campaigns: run.campaigns, problems };
}

module.exports = {
  LAST_KEY,
  HISTORY_KEY,
  HISTORY_MAX,
  ROUTE_LINES,
  routeLineOf,
  decideLine,
  diffLocations,
  recordRun,
};
