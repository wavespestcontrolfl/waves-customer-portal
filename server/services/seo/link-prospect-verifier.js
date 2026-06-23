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
const OUR_HOMEPAGE = `https://${OUR_DOMAIN}`;

// THE single source of truth for "what URL should this prospect's backlink point at":
// a row the SIGNUP RUNNER created (flagged quality_signals.cited_homepage — it submits the
// homepage as the listing website) → the homepage; everything else → its money-page
// target_page. Scoped by the flag, NOT link_type, so a MANUAL/strategy directory/citation
// row (same link_types) with a real money-page target still verifies against that page.
// Used by the DataForSEO reconcile, the crawl fallback, AND the Omega dofollow
// confirmation so every path agrees.
function expectedTargetUrl(prospect) {
  const q = parseQuality(prospect && prospect.quality_signals);
  return q.cited_homepage ? OUR_HOMEPAGE : (prospect && prospect.target_page);
}
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
  // Citations link to the homepage; reconcile signup-lane rows against the homepage so an
  // approved homepage listing matches (else it never matches target_page → stays pending).
  const expected = normalizeComparableUrl(expectedTargetUrl(prospect));
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

// seo_backlinks.first_seen is the calendar date (ET) a link was FIRST discovered.
// Normalize whatever pg hands back — a JS Date for a `date`/`timestamp` column, or a
// 'YYYY-MM-DD…' string for a text column — to a bare 'YYYY-MM-DD' for a lexical compare.
// (A `date` column arrives as a Date at UTC midnight, so toISOString().slice(0,10)
// returns the stored calendar date with no timezone shift — do NOT re-apply ET here.)
function comparableFirstSeen(row) {
  const v = row && row.first_seen;
  if (!v) return null;
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? null : v.toISOString().slice(0, 10);
  return String(v).slice(0, 10);
}

// Inclusive lower bound (ET calendar date) for a backlink that could only be OUR
// just-approved placement: the day AFTER submission. seo_backlinks.first_seen is DATE-only
// (no time component), and the weekly backlink scan and the citation runner are BOTH
// scheduled Sunday 03:30 ET — so a directory→homepage link that pre-existed our citation
// but was (re)discovered the SAME ET day we submit shares our submission date and can't be
// told apart by date alone. Treat same-day as ambiguous → require first_seen STRICTLY after
// the submission day. A slow-moderation citation is never discovered the same day anyway,
// so the day-after floor loses nothing real while closing the same-day false-promotion.
// (backlink-monitor writes first_seen as an ET date and we derive the floor via etDateString
// too, so both sides are ET calendar dates — no UTC/ET skew.)
function placementFloorEt(submittedAt) {
  const t = Date.parse(submittedAt || '');
  if (Number.isNaN(t)) return null;
  return etDateString(new Date(t + 24 * 60 * 60 * 1000));
}

// True if this backlink was first seen on/after the placement floor. No floor (no usable
// submitted_at) → don't tighten (preserve legacy behavior). Unknown first_seen → exclude:
// we can't prove the link post-dates our submission, so it must not promote a pending row.
function firstSeenOnOrAfter(row, floorDate) {
  if (!floorDate) return true;
  const fs = comparableFirstSeen(row);
  return fs ? fs >= floorDate : false;
}

// Find an ACTIVE inbound link in seo_backlinks that corresponds to this prospect's
// live_url. Active-only: a 'disavowed' or 'lost' row must not promote a prospect to
// live (loss is then detected by the crawl/wasLive fallback in verifyOne, which is
// more authoritative than a possibly-stale scan row).
async function reconcileFromProfile(prospect) {
  const liveStripped = normalizeComparableUrl(prospect.live_url);
  const rows = await db('seo_backlinks')
    .where({ status: 'active' })
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
  const q = parseQuality(prospect.quality_signals);
  // AMBIGUITY GUARD for homepage-cited rows: they all target the bare homepage, so a
  // single directory→homepage backlink can't be attributed to a specific per-location
  // listing. If MORE THAN ONE pending homepage-cited row exists for this directory
  // (multi-location placements — Venice, Parrish, …), the domain reconcile is ambiguous:
  // matching the one homepage backlink to all of them would mark every location row live
  // off one link and duplicate-Omega the same source_url. Bail → they await a known
  // live_url (profile reconcile / crawl) or manual reconciliation.
  if (q.cited_homepage) {
    // Count ALL active homepage-cited placements for this directory — pending AND
    // already live/indexed (NOT just pending): once one location row is live for the
    // directory, a later pending sibling must STILL be treated as ambiguous (else it'd
    // reconcile against the existing homepage backlink and mark a 2nd location live +
    // duplicate-Omega the same source_url). >1 (i.e. this row has a sibling) → bail.
    const siblings = await db('seo_link_prospects')
      .whereIn('status', ['placed', 'live', 'indexed'])
      .whereRaw("lower(regexp_replace(regexp_replace(target_domain, '^https?://', ''), '^www\\.', '')) = ?", [dom])
      .whereRaw("COALESCE(quality_signals->>'cited_homepage','') = 'true'")
      .count('* as c').first();
    if (Number(siblings && siblings.c) > 1) return null;
  }
  const rows = await db('seo_backlinks')
    // Active only — never promote/index from a 'disavowed' (or 'lost') link.
    .where({ status: 'active' })
    .whereRaw("lower(regexp_replace(source_domain, '^www\\.', '')) = ?", [dom])
    .orderBy('last_checked', 'desc')
    .limit(25);
  // TEMPORAL GUARD for homepage-cited placements: these target only the bare homepage,
  // so ANY pre-existing directory→homepage backlink (a prior free listing, an unrelated
  // link DataForSEO already indexed) satisfies backlinkTargetsProspect and would falsely
  // promote this still-pending, unapproved submission to live with that OLD source_url.
  // Only count links FIRST SEEN strictly AFTER our submission day (submitted_at, set on
  // pending placements) as evidence OUR listing went live — same-day is ambiguous given a
  // date-only first_seen. Scoped to homepage-cited rows WITH a submission timestamp, so
  // money-page rows and the moved-profile/fresh-URL reconciles are unchanged.
  if (q.cited_homepage && q.submitted_at) {
    const floor = placementFloorEt(q.submitted_at);
    return rows.find((row) => firstSeenOnOrAfter(row, floor) && backlinkTargetsProspect(row, prospect)) || null;
  }
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
async function pushForIndexing(prospect, liveUrl, isDofollow, now, { dofollowConfirmed = false, crawlFn = crawlForLink } = {}) {
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

  // Authoritatively confirm the link is present AND dofollow before spending an
  // Omega credit. DataForSEO's is_dofollow is unreliable (defaults true), so we
  // trust it only when a crawl already parsed the rel attribute (dofollowConfirmed).
  if (!dofollowConfirmed) {
    const c = await crawlFn(liveUrl, expectedTargetUrl(prospect));
    if (!c.found || c.isDofollow === false) {
      // Not dofollow (or not reachable right now): release the claim, don't spend.
      const release = { quality_signals: db.raw("quality_signals - 'omega_inflight'"), updated_at: new Date() };
      // If the crawl AUTHORITATIVELY found nofollow, persist that correction —
      // DataForSEO's default-true is_dofollow may have been written by markLive.
      if (c.found && c.isDofollow === false) release.is_dofollow = false;
      await db('seo_link_prospects').where({ id: prospect.id }).update(release);
      return false;
    }
  }

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
// `dofollowConfirmed` is true only when a crawl parsed the rel attribute — the
// DataForSEO reconcile paths leave it false so pushForIndexing crawl-confirms
// before spending an Omega credit.
async function markLive(prospect, { isDofollow, anchorText, backlinkId, discoveredUrl, dofollowConfirmed = false }, now) {
  const liveUrl = discoveredUrl || prospect.live_url;
  const urlChanged = !!discoveredUrl && discoveredUrl !== prospect.live_url;
  const patch = {
    is_dofollow: isDofollow,
    anchor_text: anchorText || prospect.anchor_text,
    last_live_check: now,
    updated_at: now,
  };
  if (backlinkId) patch.backlink_id = backlinkId;
  if (discoveredUrl) patch.live_url = discoveredUrl;
  // A moved/replacement URL has its OWN (unknown) index state. A row that was
  // 'indexed' at the OLD url must re-enter the index flow for the new page — never
  // inherit the old verdict (which also kept pushForIndexing's already-indexed
  // guard from submitting the new URL).
  if (urlChanged) {
    patch.status = 'live';
    patch.indexing_status = 'not_checked';
  } else if (!['live', 'indexed'].includes(prospect.status)) {
    patch.status = 'live';
  }
  if (!prospect.first_live_at) patch.first_live_at = now;
  if (!prospect.placement_date) patch.placement_date = etDateString();
  // Clear the pending marker IN PLACE (jsonb delete on the live column) — never a
  // snapshot write — so a concurrent run's omega_* dedupe keys aren't erased.
  if (parseQuality(prospect.quality_signals).pending) {
    patch.quality_signals = db.raw("quality_signals - 'pending'");
  }
  await db('seo_link_prospects').where({ id: prospect.id }).update(patch);
  // Hand pushForIndexing the POST-patch view so its already-indexed guard and URL
  // dedupe see the reset state, not the stale snapshot. (omega_* still read from
  // its own atomic claim against the live column.)
  const updated = {
    ...prospect,
    live_url: liveUrl,
    status: patch.status || prospect.status,
    indexing_status: patch.indexing_status !== undefined ? patch.indexing_status : prospect.indexing_status,
  };
  await pushForIndexing(updated, liveUrl, isDofollow, now, { dofollowConfirmed });
  return 'live';
}

async function verifyOne(prospect) {
  const now = new Date();
  const wasLive = ['live', 'indexed'].includes(prospect.status);

  // 1 & 2 need a known live_url. Pending placements (null live_url) skip straight
  // to the domain reconcile below.
  if (prospect.live_url) {
    // 1. Profile reconcile (free, ACTIVE backlinks only). DataForSEO dofollow is
    // advisory here — pushForIndexing crawl-confirms before any paid submit.
    const link = await reconcileFromProfile(prospect);
    if (link) {
      return markLive(prospect, {
        isDofollow: link.is_dofollow, anchorText: link.anchor_text, backlinkId: link.id,
      }, now);
    }

    // 2. Crawl fallback — fresh links, or a moved/false-lost page. The crawl parses
    // the real rel attribute, so its dofollow verdict is authoritative.
    const crawl = await crawlForLink(prospect.live_url, expectedTargetUrl(prospect));
    if (crawl.found) {
      return markLive(prospect, {
        isDofollow: crawl.isDofollow, anchorText: crawl.anchorText, dofollowConfirmed: true,
      }, now);
    }
  }

  // 3. Domain reconcile — covers pending placements with no known live_url, a
  // moved/renamed profile on the same domain, and fresh links DataForSEO has now
  // indexed under a URL we didn't predict (ACTIVE only).
  const byDom = await reconcileByDomain(prospect);
  if (byDom) {
    return markLive(prospect, {
      isDofollow: byDom.is_dofollow, anchorText: byDom.anchor_text,
      backlinkId: byDom.id, discoveredUrl: byDom.source_url,
    }, now);
  }

  // Not found active anywhere. Regression if it used to be live; otherwise touch.
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

module.exports = { run, verifyOne, crawlForLink, reconcileByDomain, pushForIndexing, markLive };
module.exports._test = {
  backlinkTargetsProspect, matchesTargetUrl, normalizeComparableUrl, SOURCE_URL_COMPARABLE_SQL,
  comparableDomain, parseQuality, expectedTargetUrl,
  comparableFirstSeen, placementFloorEt, firstSeenOnOrAfter,
};
