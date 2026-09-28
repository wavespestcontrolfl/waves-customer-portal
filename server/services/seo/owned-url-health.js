/**
 * Owned cited-URL health check (AEO) — owner finding 2026-09-27:
 * bradentonflpestcontrol.com/pest-control-costs/ was cited 39x/30d by
 * answer engines while it had gone 301 -> 404, and nobody knew.
 *
 * Collects the distinct owned URLs answer engines actually cited
 * (seo_llm_mentions.waves_cited_urls over the trailing 30 days) and checks
 * each one through the SAME URL-level checker + classifier the
 * content-registry live-status sweep uses — content-registry-live-status.js's
 * `checkUrlLiveStatus` (per AGENTS.md "extend the existing mechanism": one
 * fetcher, one classifier, not a parallel copy). This module's own job is
 * narrower: pick the candidate URLs (from mention data, not registry rows),
 * map the shared checker's registry-flavored verdict into this module's
 * richer vocabulary, persist to its own table (seo_owned_url_health —
 * cited URLs include dead legacy pages that must NEVER become
 * content_registry rows), and drive the dashboard block + ops digest.
 *
 * Runs as a step inside runContentRegistryMaintenance (server/services/
 * scheduler.js), after the registry's own live-status refresh — not a
 * separate cron — additionally gated on GATE_SEO_INTELLIGENCE since the
 * candidate list depends on mention data that gate controls.
 *
 * Safety (owned hosts only — the hub + the 16 fleet spoke domains, reusing
 * content-registry.js's isContentFleetUrl so this can never drift from the
 * canonical fleet list): https only (a redirect landing on http:// is never
 * a clean verdict), every redirect hop re-validated against
 * the allowlist before it is fetched (fetchText, shared), private/internal
 * IPs blocked on the real socket connection via contact-finder.js's
 * rejectingLookup (shared, via safeFetchImpl), ~8s per-hop timeout (shared
 * default), ~1.5MB response cap (shared default; a truncated body is
 * fetch_blocked, never risked as ok), bounded redirect chain, concurrency
 * bounded to the shared default, identifying User-Agent (shared).
 *
 * fetch_blocked (timeout/DNS/TLS/size/disallowed host) is NEVER reported as
 * not_found — a checker outage must never read as "the page is gone".
 */

'use strict';

const db = require('../../models/db');
const logger = require('../logger');
const registry = require('../content/content-registry');
const liveStatus = require('../content/content-registry-live-status');
const { etDateString, addETDays } = require('../../utils/datetime-et');
const { ownedCitations } = require('./aeo-measurement');
const { deliverOpsDigest } = require('../ops-digest');
const { retireIfClean } = require('../ops-digest-fall-off');
const sendgrid = require('../sendgrid-mail');
const { isInternalEmailRecipient } = require('../../utils/internal-email-recipients');

const CITATION_WINDOW_DAYS = 30;
// A health row older than this no longer counts as a current check (see
// getCitedUrlHealthDashboard). The sweep runs nightly (1:20 AM ET).
const HEALTH_FRESH_DAYS = 2;
// A 2xx with no visible text (or a 204) is never a confirmed-healthy owned
// page — a rule specific to this module's stricter bar for a page an answer
// engine is actively citing. The shared checker deliberately leaves this
// judgment to the caller (see content-registry-live-status.js's
// checkUrlLiveStatus doc comment) since a thin registry page is not by
// itself wrong.
const MIN_VISIBLE_TEXT_CHARS = 64;

const VERDICTS = Object.freeze([
  'ok', 'redirect_ok', 'soft_404', 'not_found', 'server_error',
  'challenge', 'noindex', 'canonical_elsewhere', 'fetch_blocked',
]);

// Every verdict except a clean live page. noindex and challenge are included
// deliberately: an engine-cited page that tells crawlers not to index it, or
// that we could not get past a bot wall to verify, is neither confirmed
// healthy nor something a clean run should ever retire a standing FIX alert
// over.
const BAD_VERDICTS = new Set(['soft_404', 'not_found', 'server_error', 'canonical_elsewhere', 'fetch_blocked', 'noindex', 'challenge']);

// Tracking params stripped before a URL is treated as an identity — an
// engine-attached ?utm_source=chatgpt must not create a duplicate row for a
// page already checked without it.
const TRACKING_PARAM_RE = /^(utm_[a-z_]+|mc_[a-z]+|fbclid|gclid|msclkid|igshid|ref|ref_src|_ga|_gl)$/i;

/**
 * Normalizes a cited URL to the identity this module both persists AND
 * probes: strips the fragment (never sent to a server), credentials and
 * tracking params, and upgrades to https (the shared checker is https-only;
 * every fleet host redirects http). The PATH and the rest of the query stay
 * exactly as cited — `/page` and `/page/` are different requests a host may
 * answer differently, so rewriting one into the other could report a cited
 * URL healthy that was never fetched (Codex r4 on #5123). Not the same job
 * as content-registry.js's normalizeContentUrl, which collapses the hub host
 * to a relative path and the slash forms into one — this module's table
 * keys on the full absolute URL as cited across every fleet host.
 */
function normalizeOwnedUrl(value) {
  let parsed;
  try { parsed = new URL(String(value || '').trim()); } catch { return ''; }
  if (!/^https?:$/.test(parsed.protocol)) return '';
  // A cited URL on a nonstandard port is a different destination: reject it
  // rather than silently rewriting it to the default-port page (which could
  // then report the cited URL healthy when it is unreachable).
  if (parsed.port && !(parsed.protocol === 'https:' && parsed.port === '443') && !(parsed.protocol === 'http:' && parsed.port === '80')) return '';
  parsed.hash = '';
  parsed.username = '';
  parsed.password = '';
  parsed.port = '';
  parsed.protocol = 'https:';
  parsed.hostname = parsed.hostname.toLowerCase();
  const params = new URLSearchParams(parsed.search);
  const tracking = [...params.keys()].filter((key) => TRACKING_PARAM_RE.test(key));
  if (tracking.length) {
    for (const key of tracking) params.delete(key);
    const qs = params.toString();
    parsed.search = qs ? `?${qs}` : '';
  }
  return parsed.toString();
}

function isOwnedFleetUrl(value) {
  return registry.isContentFleetUrl(value);
}

/**
 * Distinct normalized owned URLs cited in the trailing window, each with the
 * number of citation rows that named it (so a stale-but-uncited page never
 * shows up demanding attention, and a heavily-cited one is visibly urgent).
 * Only attributable V2 answers count — the same rule the dashboard's
 * citation rates use (aeo-measurement.js ownedCitations): legacy rows mixed
 * search results and prose URLs into waves_cited_urls and are not citation
 * evidence.
 */
async function collectCitedOwnedUrls({ database = db, windowDays = CITATION_WINDOW_DAYS, now = new Date() } = {}) {
  const since = etDateString(addETDays(now, -(windowDays - 1)));
  const rows = await database('seo_llm_mentions')
    .where('check_date', '>=', since)
    .whereNotNull('waves_cited_urls')
    .select('waves_cited_urls', 'measurement_version', 'answer_available', 'citations_complete');

  const counts = new Map();
  for (const row of rows) {
    const urls = ownedCitations(row);
    if (!urls.length) continue;
    const seenThisRow = new Set();
    for (const raw of urls) {
      const normalized = normalizeOwnedUrl(raw);
      if (!normalized || !isOwnedFleetUrl(normalized)) continue;
      if (seenThisRow.has(normalized)) continue; // one citation credit per row per URL
      seenThisRow.add(normalized);
      counts.set(normalized, (counts.get(normalized) || 0) + 1);
    }
  }
  return [...counts.entries()].map(([url, citationCount]) => ({ url, citationCount }))
    .sort((a, b) => b.citationCount - a.citationCount);
}

// ── Shared-checker result -> this module's verdict vocabulary ──────────────
// content-registry-live-status.js's checkUrlLiveStatus already does the
// fetch, the redirect walk, the SSRF/allowlist guards, and classification
// into its own (now body-aware) live_status vocabulary. This maps that
// result onto owned-url-health's richer, cited-URL-specific verdicts.
const CLEAN_LIVE_STATUSES = new Set(['live', 'redirected']);

function mapSharedResultToVerdict(shared) {
  const httpStatusNum = Number(shared.http_status);
  const detailBase = {
    requestedUrl: shared.target_url,
    finalUrl: shared.final_url,
    httpStatus: shared.http_status,
    finalHttpStatus: shared.final_http_status,
    redirectTargetUrl: shared.redirect_target_url,
    title: shared.page_title,
    contentType: shared.content_type || null,
  };

  switch (shared.live_status) {
    case 'error':
      // A 429 is a rate-limit/block signal, not a random failure — surfaced
      // as challenge rather than the generic fetch_blocked bucket.
      if (httpStatusNum === 429) {
        return { verdict: 'challenge', httpStatus: shared.http_status, finalUrl: shared.final_url, detail: { ...detailBase, reason: 'rate_limited' } };
      }
      return { verdict: 'fetch_blocked', httpStatus: shared.http_status === 'error' ? null : shared.http_status, finalUrl: shared.final_url, detail: { ...detailBase, reason: shared.error || 'checker_error' } };
    case 'unknown':
      // Off-fleet/disallowed host, or no URL at all — never fetched.
      return { verdict: 'fetch_blocked', httpStatus: null, finalUrl: null, detail: { ...detailBase, reason: shared.error || 'unresolved' } };
    case 'missing':
      return { verdict: 'not_found', httpStatus: shared.http_status, finalUrl: shared.final_url, detail: detailBase };
    case 'server_error':
      return { verdict: 'server_error', httpStatus: shared.http_status, finalUrl: shared.final_url, detail: detailBase };
    case 'blocked': // 401/403
      return { verdict: 'challenge', httpStatus: shared.http_status, finalUrl: shared.final_url, detail: { ...detailBase, reason: 'blocked_status' } };
    case 'challenge':
      return { verdict: 'challenge', httpStatus: shared.http_status, finalUrl: shared.final_url, detail: detailBase };
    case 'soft_404':
      return { verdict: 'soft_404', httpStatus: shared.http_status, finalUrl: shared.final_url, detail: detailBase };
    case 'noindex':
      return { verdict: 'noindex', httpStatus: shared.http_status, finalUrl: shared.final_url, detail: detailBase };
    case 'canonicalized':
      return { verdict: 'canonical_elsewhere', httpStatus: shared.http_status, finalUrl: shared.final_url, detail: { ...detailBase, canonicalUrl: shared.canonical_target_url } };
    default:
      break;
  }

  if (CLEAN_LIVE_STATUSES.has(shared.live_status)) {
    // A truncated body (the shared ~1.5MB cap tripped, or the socket closed
    // early) is never enough evidence to call a page healthy — the markers
    // above can all live past the cutoff point.
    if (shared.truncated) {
      return { verdict: 'fetch_blocked', httpStatus: shared.http_status, finalUrl: shared.final_url, detail: { ...detailBase, reason: 'response_truncated' } };
    }
    // Only an HTTPS landing is confirmed healthy. The shared walker follows a
    // fleet-host hop on either scheme, so a redirect downgrading to http:// is
    // an unauthenticated response, never a clean verdict (Codex r5 on #5123).
    if (shared.final_url && !/^https:\/\//i.test(shared.final_url)) {
      return { verdict: 'fetch_blocked', httpStatus: shared.http_status, finalUrl: shared.final_url, detail: { ...detailBase, reason: 'insecure_redirect' } };
    }
    // The shared classifier's redirect path (classifyRedirectLiveStatus)
    // deliberately does NOT reclassify on a canonical mismatch — that is
    // registry-specific behavior a content-registry row test pins (a
    // redirect landing on a page with an unrelated canonical stays
    // 'redirected' for the registry). This module's own bar is stricter: an
    // owned page an answer engine is actively citing that redirects clean
    // but then self-declares a DIFFERENT canonical is not a confirmed-good
    // landing — checked here, not in the shared classifier.
    // Compared the way the shared classifier compares a directly-served
    // page's canonical (content-registry.js normalizeContentUrl: host, path,
    // trailing slash ignored), so /page landing with a /page/ canonical is
    // one page on both paths, not "elsewhere".
    if (shared.canonical_target_url) {
      const normalizedCanonical = registry.normalizeContentUrl(shared.canonical_target_url);
      const normalizedFinal = registry.normalizeContentUrl(shared.final_url);
      if (normalizedCanonical && normalizedFinal && normalizedCanonical !== normalizedFinal) {
        return { verdict: 'canonical_elsewhere', httpStatus: shared.http_status, finalUrl: shared.final_url, detail: { ...detailBase, canonicalUrl: shared.canonical_target_url } };
      }
    }
    const visibleChars = shared.visible_text_length;
    const landedStatus = Number(shared.final_http_status || shared.http_status);
    if (landedStatus === 204 || (visibleChars != null && visibleChars < MIN_VISIBLE_TEXT_CHARS)) {
      return { verdict: 'soft_404', httpStatus: shared.http_status, finalUrl: shared.final_url, detail: { ...detailBase, reason: 'empty_body', visibleChars } };
    }
    // redirect_ok specifically means a 301/308 (permanent) chain landing
    // clean — a temporary redirect (302/307) landing clean is still just ok.
    const permanentRedirect = !!shared.redirect_target_url && (httpStatusNum === 301 || httpStatusNum === 308);
    return { verdict: permanentRedirect ? 'redirect_ok' : 'ok', httpStatus: shared.http_status, finalUrl: shared.final_url, detail: detailBase };
  }

  // Defensive fallback — an unrecognized shared live_status must never be
  // mistaken for a confirmed-healthy page.
  return { verdict: 'fetch_blocked', httpStatus: shared.http_status || null, finalUrl: shared.final_url || null, detail: { ...detailBase, reason: `unmapped_live_status_${shared.live_status}` } };
}

/** Fetches + classifies one owned URL via the shared checker. Never throws. */
async function checkOwnedUrlHealth(url, {
  fetchImpl = liveStatus.safeFetchImpl,
  timeoutMs = liveStatus.DEFAULT_TIMEOUT_MS,
} = {}) {
  const requestedUrl = normalizeOwnedUrl(url) || url;
  try {
    const shared = await liveStatus.checkUrlLiveStatus(requestedUrl, { fetchImpl, timeoutMs });
    return { url: requestedUrl, ...mapSharedResultToVerdict(shared) };
  } catch (err) {
    return { url: requestedUrl, verdict: 'fetch_blocked', httpStatus: null, finalUrl: null, detail: { reason: err.message || 'check_failed' } };
  }
}

const OPS_DIGEST_KEY = 'owned-url-health';
const digestEmail = () => process.env.OWNED_URL_HEALTH_DIGEST_EMAIL || 'contact@wavespestcontrol.com';
const fromEmail = () => process.env.SENDGRID_FROM_EMAIL || 'contact@wavespestcontrol.com';
const FROM_NAME = process.env.SENDGRID_FROM_NAME || 'Waves Pest Control';
const adminPortalUrl = () => (process.env.ADMIN_PORTAL_URL || 'https://portal.wavespestcontrol.com').replace(/\/+$/, '');

function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

/**
 * FIX: an owned page answer engines are actively citing has broken. Posts
 * through the shared ops-digest seam (in-app bell under GATE_OPS_DIGESTS_IN_APP,
 * email fallback otherwise — same pattern turf-variance-digest.js follows) and
 * retires the standing row on the next clean run, so a fixed link doesn't sit
 * unread forever.
 */
async function postOwnedUrlHealthDigest(bad) {
  if (!bad.length) {
    await retireIfClean(OPS_DIGEST_KEY);
    return { skipped: 'clean' };
  }

  const subject = `FIX: ${bad.length} owned page${bad.length === 1 ? '' : 's'} cited by AI answer engines ${bad.length === 1 ? 'is' : 'are'} broken`;
  const rows = bad.slice(0, 20);
  const text = [
    `${bad.length} owned URL(s) cited by AI answer engines in the last ${CITATION_WINDOW_DAYS} days failed their health check:`,
    '',
    ...rows.map((r) => `- ${r.url} -> ${r.verdict}${r.finalUrl && r.finalUrl !== r.url ? ` (final: ${r.finalUrl})` : ''} · cited ${r.citationCount}x · checked ${r.lastCheckedOn}`),
    '',
    `Dashboard: ${adminPortalUrl()}/admin/seo?workspace=authority&view=backlinks`,
  ].join('\n');
  const html = [
    `<p><strong>${bad.length}</strong> owned URL(s) cited by AI answer engines in the last ${CITATION_WINDOW_DAYS} days failed their health check:</p>`,
    `<ul style="margin:0 0 12px 18px;padding:0;">${rows.map((r) => `<li style="margin:0 0 6px 0;">${esc(r.url)} &rarr; <strong>${esc(r.verdict)}</strong>${r.finalUrl && r.finalUrl !== r.url ? ` (final: ${esc(r.finalUrl)})` : ''} &middot; cited ${r.citationCount}x &middot; checked ${esc(r.lastCheckedOn)}</li>`).join('')}</ul>`,
    `<p><a href="${esc(adminPortalUrl())}/admin/seo?workspace=authority&view=backlinks">Open the SEO dashboard</a></p>`,
  ].join('\n');

  if (typeof sendgrid.isConfigured === 'function' && !sendgrid.isConfigured()) {
    logger.warn('[owned-url-health] mailer not configured — skipping digest send');
    return { skipped: 'unconfigured' };
  }
  const to = digestEmail();
  if (!isInternalEmailRecipient(to)) {
    logger.warn('[owned-url-health] recipient is not an internal address — skipping digest send');
    return { skipped: 'recipient' };
  }

  try {
    return await deliverOpsDigest({
      fallOff: true,
      key: OPS_DIGEST_KEY,
      subject,
      html,
      text,
      link: '/admin/seo?workspace=authority&view=backlinks',
      metadata: { bad: bad.length },
      dedupeKey: OPS_DIGEST_KEY,
      refreshOnDedupe: true,
      sendEmail: () => sendgrid.sendOne({
        to,
        fromEmail: fromEmail(),
        fromName: FROM_NAME,
        subject,
        html,
        text,
        categories: ['ops', 'owned-url-health'],
        suppressErrorLog: true,
      }),
    });
  } catch (err) {
    logger.error(`[owned-url-health] digest send failed: ${err.message}`);
    return { sent: false, error: true };
  }
}

/**
 * Runs the full sweep: collect cited owned URLs, check each (bounded
 * concurrency, shared checker), persist one row per (url, checked_on), and
 * return a summary the ops-digest sender and the admin dashboard both
 * consume. Called as a step inside scheduler.js's runContentRegistryMaintenance
 * — not its own cron.
 */
async function runOwnedUrlHealthCheck({
  database = db,
  concurrency = liveStatus.DEFAULT_CONCURRENCY,
  now = new Date(),
} = {}) {
  const checkedOn = etDateString(now);
  const candidates = await collectCitedOwnedUrls({ database, now });

  const results = await liveStatus.runWithConcurrency(candidates, concurrency, async ({ url, citationCount }) => {
    const result = await checkOwnedUrlHealth(url);
    return { ...result, citationCount };
  });

  for (const result of results) {
    await database('seo_owned_url_health')
      .insert({
        url: result.url,
        checked_on: checkedOn,
        http_status: result.httpStatus == null ? null : String(result.httpStatus),
        final_url: result.finalUrl || null,
        verdict: result.verdict,
        detail: JSON.stringify(result.detail || {}),
      })
      .onConflict(['url', 'checked_on'])
      .merge({
        http_status: result.httpStatus == null ? null : String(result.httpStatus),
        final_url: result.finalUrl || null,
        verdict: result.verdict,
        detail: JSON.stringify(result.detail || {}),
      });
  }

  const bad = results.filter((r) => BAD_VERDICTS.has(r.verdict));
  logger.info(`[owned-url-health] checked ${results.length}, ${bad.length} bad (${checkedOn})`);
  const digest = await postOwnedUrlHealthDigest(bad.map((r) => ({ ...r, lastCheckedOn: checkedOn })));
  return { checkedOn, checked: results.length, bad: bad.length, results, digest };
}

/**
 * Dashboard block for the LLM Mentions panel: the most recent check per
 * owned URL cited in the trailing window, plus a list of the bad ones.
 */
async function getCitedUrlHealthDashboard({ database = db, windowDays = CITATION_WINDOW_DAYS, now = new Date() } = {}) {
  const candidates = await collectCitedOwnedUrls({ database, windowDays, now });
  if (!candidates.length) return { candidates: 0, checked: 0, unchecked: 0, bad: 0, badUrls: [], lastCheckedOn: null };

  const urls = candidates.map((c) => c.url);
  const citationByUrl = new Map(candidates.map((c) => [c.url, c.citationCount]));
  // Only a recent row counts as "checked" (the sweep runs nightly; one day of
  // slack covers its timing). An older row — a URL that dropped out of the
  // window and is cited again, or a sweep that stopped running — is stale:
  // the URL stays UNCHECKED rather than reading as verified-clean.
  const freshSince = etDateString(addETDays(now, -(HEALTH_FRESH_DAYS - 1)));
  const rows = await database('seo_owned_url_health')
    .whereIn('url', urls)
    .where('checked_on', '>=', freshSince)
    .orderBy('checked_on', 'desc');

  const latestByUrl = new Map();
  for (const row of rows) {
    if (!latestByUrl.has(row.url)) latestByUrl.set(row.url, row);
  }

  const checked = latestByUrl.size;
  const badUrls = [];
  let lastCheckedOn = null;
  for (const [url, row] of latestByUrl) {
    const checkedOn = row.checked_on instanceof Date ? row.checked_on.toISOString().slice(0, 10) : String(row.checked_on).slice(0, 10);
    if (!lastCheckedOn || checkedOn > lastCheckedOn) lastCheckedOn = checkedOn;
    if (BAD_VERDICTS.has(row.verdict)) {
      badUrls.push({
        url,
        verdict: row.verdict,
        finalUrl: row.final_url || null,
        httpStatus: row.http_status || null,
        citationCount: citationByUrl.get(url) || 0,
        lastCheckedOn: checkedOn,
      });
    }
  }
  badUrls.sort((a, b) => b.citationCount - a.citationCount);

  // A currently cited URL with no health row yet (before the first sweep, or
  // newly cited since the last one) is UNVERIFIED — the panel must not read
  // a partial check as a clean result.
  return { candidates: candidates.length, checked, unchecked: candidates.length - checked, bad: badUrls.length, badUrls, lastCheckedOn };
}

module.exports = {
  VERDICTS,
  BAD_VERDICTS,
  normalizeOwnedUrl,
  isOwnedFleetUrl,
  collectCitedOwnedUrls,
  mapSharedResultToVerdict,
  checkOwnedUrlHealth,
  runOwnedUrlHealthCheck,
  getCitedUrlHealthDashboard,
  postOwnedUrlHealthDigest,
};
