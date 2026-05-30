/**
 * Link Prospect Verifier (Backlink Manager M1)
 *
 * Keeps the seo_link_prospects board honest: confirms whether each prospect's link
 * is actually live, and whether it's dofollow — NEVER trusting a worker self-report.
 *
 * Two sources, cheapest first:
 *   1. Reconcile against seo_backlinks (DataForSEO-derived, refreshed by the weekly
 *      BacklinkMonitor scan) — free, already has is_dofollow + anchor_text.
 *   2. Crawl fallback — fetch the live_url and parse the <a> tag for FRESH links not
 *      yet in DataForSEO's index.
 *
 * Transitions: placed → live (found), live/indexed → lost (vanished).
 */
const db = require('../../models/db');
const logger = require('../logger');
const { etDateString } = require('../../utils/datetime-et');

const OUR_DOMAIN = 'wavespestcontrol.com';

function stripUrl(u) {
  return String(u || '').trim().replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/\/+$/, '');
}

// Find an active inbound link in seo_backlinks that corresponds to this prospect's live_url.
async function reconcileFromProfile(prospect) {
  const liveStripped = stripUrl(prospect.live_url);
  const rows = await db('seo_backlinks')
    .whereRaw("regexp_replace(regexp_replace(lower(source_url), '^https?://(www\\.)?', ''), '/+$', '') = ?", [liveStripped.toLowerCase()])
    .orderBy('last_checked', 'desc')
    .limit(1);
  return rows[0] || null;
}

// Best-effort crawl: does live_url contain an <a> to wavespestcontrol.com, and is it dofollow?
async function crawlForLink(liveUrl) {
  try {
    const controller = new AbortController();
    const to = setTimeout(() => controller.abort(), 12000);
    const res = await fetch(liveUrl, {
      signal: controller.signal,
      redirect: 'follow',
      headers: { 'User-Agent': 'WavesBacklinkVerifier/1.0 (+https://wavespestcontrol.com)' },
    });
    clearTimeout(to);
    if (!res.ok) return { found: false };
    const html = await res.text();

    // Find anchor tags whose href points at our domain.
    const anchorRe = /<a\b([^>]*?)href=["']([^"']*wavespestcontrol\.com[^"']*)["']([^>]*)>([\s\S]*?)<\/a>/gi;
    let m;
    while ((m = anchorRe.exec(html)) !== null) {
      const attrs = `${m[1]} ${m[3]}`;
      const relMatch = /rel=["']([^"']*)["']/i.exec(attrs);
      const rel = relMatch ? relMatch[1].toLowerCase() : '';
      const isDofollow = !/\bnofollow\b|\bugc\b|\bsponsored\b/.test(rel);
      const anchorText = m[4].replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim().slice(0, 300);
      return { found: true, isDofollow, anchorText: anchorText || null };
    }
    return { found: false };
  } catch (err) {
    return { found: false, error: err.message };
  }
}

async function verifyOne(prospect) {
  const now = new Date();
  const wasLive = ['live', 'indexed'].includes(prospect.status);

  // 1. Profile reconcile (free)
  const link = await reconcileFromProfile(prospect);
  if (link) {
    if (link.status === 'lost') {
      await db('seo_link_prospects').where({ id: prospect.id }).update({
        status: 'lost', last_live_check: now, backlink_id: link.id, updated_at: now,
      });
      return 'lost';
    }
    const patch = {
      is_dofollow: link.is_dofollow,
      anchor_text: link.anchor_text || prospect.anchor_text,
      backlink_id: link.id,
      last_live_check: now,
      updated_at: now,
    };
    if (!['live', 'indexed'].includes(prospect.status)) patch.status = 'live';
    if (!prospect.first_live_at) patch.first_live_at = now;
    if (!prospect.placement_date) patch.placement_date = etDateString();
    await db('seo_link_prospects').where({ id: prospect.id }).update(patch);
    return 'live';
  }

  // 2. Crawl fallback (fresh links not yet in DataForSEO)
  const crawl = await crawlForLink(prospect.live_url);
  if (crawl.found) {
    const patch = {
      is_dofollow: crawl.isDofollow,
      anchor_text: crawl.anchorText || prospect.anchor_text,
      last_live_check: now,
      updated_at: now,
    };
    if (!['live', 'indexed'].includes(prospect.status)) patch.status = 'live';
    if (!prospect.first_live_at) patch.first_live_at = now;
    if (!prospect.placement_date) patch.placement_date = etDateString();
    await db('seo_link_prospects').where({ id: prospect.id }).update(patch);
    return 'live';
  }

  // Not found anywhere. Regression if it used to be live; otherwise just touch the check.
  if (wasLive) {
    await db('seo_link_prospects').where({ id: prospect.id }).update({
      status: 'lost', last_live_check: now, updated_at: now,
    });
    return 'lost';
  }
  await db('seo_link_prospects').where({ id: prospect.id }).update({ last_live_check: now, updated_at: now });
  return 'pending';
}

async function run({ limit = 200 } = {}) {
  const prospects = await db('seo_link_prospects')
    .whereNotNull('live_url')
    .whereNotIn('status', ['rejected'])
    .orderByRaw('last_live_check NULLS FIRST')
    .limit(limit);

  let live = 0, lost = 0, pending = 0;
  for (const p of prospects) {
    try {
      const r = await verifyOne(p);
      if (r === 'live') live++;
      else if (r === 'lost') lost++;
      else pending++;
    } catch (err) {
      logger.error(`[link-verifier] ${p.id} (${p.target_domain}) failed: ${err.message}`);
    }
  }
  logger.info(`[link-verifier] checked ${prospects.length}: ${live} live, ${lost} lost, ${pending} pending`);
  return { checked: prospects.length, live, lost, pending };
}

module.exports = { run, verifyOne, crawlForLink };
