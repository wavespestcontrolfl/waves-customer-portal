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
 *
 * On every placed → live transition we push the linking page to Omega Indexer
 * (force-index third-party pages) — but ONLY when the link is dofollow, since a
 * nofollow page passes ~no equity and isn't worth the indexing credit. Deduped
 * via quality_signals.omega_submitted so each URL is submitted at most once.
 *
 * Pending placements (slow-moderation directories submitted with pending=true and
 * no known live_url yet) are tracked by a domain-level reconcile: once DataForSEO
 * sees ANY active link from the directory domain to our target page, we discover
 * the real URL, flip to live, and index it.
 */
const db = require('../../models/db');
const logger = require('../logger');
const { etDateString } = require('../../utils/datetime-et');
const { isEnabled } = require('../../config/feature-gates');
const omega = require('./omega-indexer');

const OUR_DOMAIN = 'wavespestcontrol.com';
const SOURCE_URL_COMPARABLE_SQL = "regexp_replace(regexp_replace(regexp_replace(regexp_replace(lower(source_url), '^https://', ''), '^http://', ''), '^www\\.', ''), '/+$', '')";

function stripUrl(u) {
  return String(u || '').trim().replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/\/+$/, '');
}

function normalizeComparableUrl(u) {
  return stripUrl(u).toLowerCase();
}

// Bare registrable host for domain-level matching: drop scheme/www/path/port.
function comparableDomain(d) {
  return stripUrl(d).toLowerCase().replace(/[/:].*$/, '');
}

// quality_signals can arrive as an object (pg jsonb) or a JSON string. Always
// hand back a plain object we can safely mutate.
function parseQuality(q) {
  if (!q) return {};
  if (typeof q === 'object') return { ...q };
  try { return JSON.parse(q) || {}; } catch { return {}; }
}

function matchesTargetUrl(candidate, expected) {
  if (!candidate || !expected) return false;
  if (candidate === expected) return true;
  if (!candidate.startsWith(expected)) return false;
  const rest = candidate.slice(expected.length);
  // Root/domain-only target (no path, e.g. "wavespestcontrol.com"): accept only
  // the homepage itself — an optional trailing slash followed by an optional
  // query/fragment — never a child path. (stripUrl only trims trailing slashes,
  // so a homepage hit can arrive as ".com/?utm=" or ".com/#form".)
  if (!expected.includes('/')) return /^\/?(?:[?#].*)?$/.test(rest);
  // Path target: the next char must be a real URL boundary.
  const next = rest.charAt(0);
  return next === '/' || next === '?' || next === '#';
}

function backlinkTargetsProspect(link, prospect) {
  const expected = normalizeComparableUrl(prospect.target_page);
  if (!expected) return false;
  const candidates = [
    link.target_url,
    link.url_to,
    link.destination_url,
    link.link_url,
    link.target_page,
    link.url,
  ].map(normalizeComparableUrl).filter(Boolean);
  return candidates.some((candidate) => matchesTargetUrl(candidate, expected));
}

// Find an active inbound link in seo_backlinks that corresponds to this prospect's live_url.
async function reconcileFromProfile(prospect) {
  const liveStripped = normalizeComparableUrl(prospect.live_url);
  const rows = await db('seo_backlinks')
    .whereRaw(`${SOURCE_URL_COMPARABLE_SQL} = ?`, [liveStripped.toLowerCase()])
    .orderBy('last_checked', 'desc')
    .limit(10);
  return rows.find((row) => backlinkTargetsProspect(row, prospect)) || null;
}

// Domain-level reconcile: for a placement where we don't (yet) know the exact
// live_url — a pending slow-moderation submission — find ANY active backlink from
// the directory's domain that targets our page. Discovers the real source_url on
// approval so the row can flip to live.
async function reconcileByDomain(prospect) {
  const dom = comparableDomain(prospect.target_domain);
  if (!dom) return null;
  const rows = await db('seo_backlinks')
    // Active only — never promote/index from a 'disavowed' (or 'lost') link.
    .where({ status: 'active' })
    .whereRaw("lower(regexp_replace(source_domain, '^www\\.', '')) = ?", [dom])
    .orderBy('last_checked', 'desc')
    .limit(25);
  return rows.find((row) => backlinkTargetsProspect(row, prospect)) || null;
}

// After how many failed Omega attempts we stop retrying a single URL.
const OMEGA_MAX_ATTEMPTS = 5;
// A stale in-flight claim (run crashed mid-submit) frees up after this long.
const OMEGA_INFLIGHT_TTL_MS = 10 * 60 * 1000;

// Force-index a confirmed-live page via Omega Indexer. No-ops for nofollow (no
// equity to index) and for already-indexed pages (nothing to gain). Dedups via
// quality_signals.omega_submitted — set ONLY on a confirmed-accepted submission,
// so a transient failure (429/5xx/network) is retried next run rather than
// dropped; failures bump omega_attempts and stop after OMEGA_MAX_ATTEMPTS.
//
// Concurrency: before the paid call we atomically claim the row with a
// conditional jsonb update (sets omega_inflight only if not submitted and not
// already in-flight). Overlapping verifier runs can't both submit the same URL —
// the loser's update affects 0 rows and bails.
async function pushForIndexing(prospect, liveUrl, isDofollow, now) {
  // Paid call — gated with the other SEO API spend so disabling SEO Intelligence
  // (GATE_SEO_INTELLIGENCE) halts Omega submissions, same as DataForSEO.
  if (!isEnabled('seoIntelligence')) return false;
  if (!liveUrl || isDofollow === false) return false;
  if (prospect.status === 'indexed' || prospect.indexing_status === 'indexed') return false;
  const quality = parseQuality(prospect.quality_signals);
  // Dedupe is URL-scoped, not row-scoped: if the backlink moved to a new URL
  // (discovered by the domain reconcile), the new URL must still be indexed even
  // though the OLD one already was.
  if (quality.omega_submitted_url === liveUrl) return false; // this exact URL already accepted
  // Failed-attempt budget is likewise per-URL — a moved URL starts fresh.
  const priorAttempts = quality.omega_attempt_url === liveUrl ? (quality.omega_attempts || 0) : 0;
  if (priorAttempts >= OMEGA_MAX_ATTEMPTS) return false;

  // Atomic claim: win only if THIS url isn't already submitted and not currently
  // (freshly) in-flight.
  const inflightCutoff = new Date(now.getTime() - OMEGA_INFLIGHT_TTL_MS).toISOString();
  const claimed = await db('seo_link_prospects')
    .where({ id: prospect.id })
    .whereRaw("(quality_signals->>'omega_submitted_url') IS DISTINCT FROM ?", [liveUrl])
    .whereRaw("COALESCE((quality_signals->>'omega_inflight')::timestamptz, to_timestamp(0)) < ?", [inflightCutoff])
    .update({
      quality_signals: db.raw(
        "jsonb_set(COALESCE(quality_signals, '{}'::jsonb), '{omega_inflight}', to_jsonb(?::text), true)",
        [now.toISOString()],
      ),
      updated_at: new Date(),
    });
  if (!claimed) return false; // another run owns it, or this URL was just submitted

  const res = await omega.submit(prospect.target_domain, [liveUrl]);

  // All result writes touch ONLY the omega_* keys on the CURRENT column value
  // (never a pre-call snapshot), so a concurrent writer — e.g. the indexer
  // setting quality_signals.target_indexed during the 12s Omega call — isn't
  // clobbered.

  // skipped = no key / no url (non-prod): release the claim, burn no attempt.
  if (res && res.skipped) {
    await db('seo_link_prospects').where({ id: prospect.id })
      .update({ quality_signals: db.raw("quality_signals - 'omega_inflight'"), updated_at: new Date() });
    return false;
  }

  if (res && res.ok === true) {
    // Record the exact URL we indexed; clear the per-URL attempt/error/in-flight keys.
    await db('seo_link_prospects').where({ id: prospect.id }).update({
      quality_signals: db.raw(
        "jsonb_set(COALESCE(quality_signals, '{}'::jsonb), '{omega_submitted_url}', to_jsonb(?::text), true) - 'omega_attempts' - 'omega_attempt_url' - 'omega_error' - 'omega_inflight'",
        [liveUrl],
      ),
      updated_at: new Date(),
    });
    return true;
  }

  const attempts = priorAttempts + 1; // safe: we hold the claim
  const errStr = (res && res.error) || `status ${res && res.status}`;
  await db('seo_link_prospects').where({ id: prospect.id }).update({
    quality_signals: db.raw(
      "jsonb_set(jsonb_set(jsonb_set(COALESCE(quality_signals, '{}'::jsonb), '{omega_attempts}', to_jsonb(?::int), true), '{omega_attempt_url}', to_jsonb(?::text), true), '{omega_error}', to_jsonb(?::text), true) - 'omega_inflight'",
      [attempts, liveUrl, errStr],
    ),
    updated_at: new Date(),
  });
  return false;
}

// Best-effort crawl: does live_url contain an <a> to wavespestcontrol.com, and is it dofollow?
async function crawlForLink(liveUrl, targetPage) {
  let to = null;
  try {
    const expectedTarget = normalizeComparableUrl(targetPage);
    if (!expectedTarget) return { found: false };
    const controller = new AbortController();
    to = setTimeout(() => controller.abort(), 12000);
    const res = await fetch(liveUrl, {
      signal: controller.signal,
      redirect: 'follow',
      headers: { 'User-Agent': 'WavesBacklinkVerifier/1.0 (+https://wavespestcontrol.com)' },
    });
    if (!res.ok) return { found: false };
    const html = await res.text();

    // Find anchor tags whose href points at the intended Waves target page.
    const anchorRe = /<a\b([^>]*?)href=["']([^"']*wavespestcontrol\.com[^"']*)["']([^>]*)>([\s\S]*?)<\/a>/gi;
    let m;
    while ((m = anchorRe.exec(html)) !== null) {
      const href = normalizeComparableUrl(m[2]);
      if (!matchesTargetUrl(href, expectedTarget)) continue;
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
  } finally {
    if (to) clearTimeout(to);
  }
}

// Apply a live transition + fire indexing for a confirmed link. `discoveredUrl`
// is set only by the domain reconcile, which learns the real URL on approval.
async function markLive(prospect, { isDofollow, anchorText, backlinkId, discoveredUrl }, now) {
  const liveUrl = discoveredUrl || prospect.live_url;
  const patch = {
    is_dofollow: isDofollow,
    anchor_text: anchorText || prospect.anchor_text,
    last_live_check: now,
    updated_at: now,
  };
  if (backlinkId) patch.backlink_id = backlinkId;
  if (discoveredUrl) patch.live_url = discoveredUrl;
  if (!['live', 'indexed'].includes(prospect.status)) patch.status = 'live';
  if (!prospect.first_live_at) patch.first_live_at = now;
  if (!prospect.placement_date) patch.placement_date = etDateString();
  // Clear the pending marker IN PLACE (jsonb delete on the live column) — never a
  // snapshot write — so a concurrent run's omega_* dedupe keys aren't erased.
  if (parseQuality(prospect.quality_signals).pending) {
    patch.quality_signals = db.raw("quality_signals - 'pending'");
  }
  await db('seo_link_prospects').where({ id: prospect.id }).update(patch);
  // pushForIndexing reads omega_* from its own atomic claim against the live
  // column, so passing the original snapshot is safe (and the pending key it may
  // still carry is irrelevant to indexing).
  await pushForIndexing(prospect, liveUrl, isDofollow, now);
  return 'live';
}

async function verifyOne(prospect) {
  const now = new Date();
  const wasLive = ['live', 'indexed'].includes(prospect.status);

  // 1 & 2 need a known live_url. Pending placements (null live_url) skip straight
  // to the domain reconcile below.
  let lostBacklinkId = null;
  if (prospect.live_url) {
    // 1. Profile reconcile (free)
    const link = await reconcileFromProfile(prospect);
    if (link && link.status !== 'lost') {
      return markLive(prospect, {
        isDofollow: link.is_dofollow, anchorText: link.anchor_text, backlinkId: link.id,
      }, now);
    }
    // A 'lost' exact-URL row does NOT short-circuit to lost: the page may still
    // carry our link (stale DataForSEO) or have moved to a new URL on the same
    // domain. Fall through to the crawl + domain reconcile before concluding lost.
    if (link) lostBacklinkId = link.id;

    // 2. Crawl fallback (fresh links not yet in DataForSEO, or a false 'lost')
    const crawl = await crawlForLink(prospect.live_url, prospect.target_page);
    if (crawl.found) {
      return markLive(prospect, { isDofollow: crawl.isDofollow, anchorText: crawl.anchorText }, now);
    }
  }

  // 3. Domain reconcile — covers pending placements with no known live_url, a
  // moved/renamed profile on the same domain, and fresh links DataForSEO has now
  // indexed under a URL we didn't predict.
  const byDom = await reconcileByDomain(prospect);
  if (byDom) {
    return markLive(prospect, {
      isDofollow: byDom.is_dofollow, anchorText: byDom.anchor_text,
      backlinkId: byDom.id, discoveredUrl: byDom.source_url,
    }, now);
  }

  // Not found anywhere. Regression if it used to be live OR the exact-URL row is
  // gone; otherwise just touch the check.
  if (wasLive || lostBacklinkId) {
    const patch = { status: 'lost', last_live_check: now, updated_at: now };
    if (lostBacklinkId) patch.backlink_id = lostBacklinkId;
    await db('seo_link_prospects').where({ id: prospect.id }).update(patch);
    return 'lost';
  }
  await db('seo_link_prospects').where({ id: prospect.id }).update({ last_live_check: now, updated_at: now });
  return 'pending';
}

async function run({ limit = 200 } = {}) {
  // Scan anything with a known live_url (to confirm/recheck/detect loss) PLUS any
  // 'placed' row even without one — those are pending submissions awaiting the
  // domain reconcile. Unworked 'prospect' rows and 'rejected' are excluded.
  const prospects = await db('seo_link_prospects')
    .where((b) => b.whereNotNull('live_url').orWhere('status', 'placed'))
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

module.exports = { run, verifyOne, crawlForLink, reconcileByDomain, pushForIndexing };
module.exports._test = {
  backlinkTargetsProspect, matchesTargetUrl, normalizeComparableUrl, SOURCE_URL_COMPARABLE_SQL,
  comparableDomain, parseQuality,
};
