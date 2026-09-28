/**
 * Owned cited-URL health check (AEO) — owner finding 2026-09-27:
 * bradentonflpestcontrol.com/pest-control-costs/ was cited 39x/30d by
 * answer engines while it had gone 301 -> 404, and nobody knew.
 *
 * Daily job: collect the distinct owned URLs answer engines actually cited
 * (seo_llm_mentions.waves_cited_urls over the trailing 30 days), fetch each
 * one with a SAFE fetcher, and classify what a human would find there — not
 * just the HTTP status. A redirect chain that lands on a healthy owned page
 * is fine; a 2xx that renders the site's own "Page Not Found" template is a
 * silent break a bare status check would miss entirely.
 *
 * Safety (owned hosts only — the hub + the 16 fleet spoke domains, reusing
 * content-registry.js's isContentFleetUrl so this can never drift from the
 * canonical fleet list):
 *   - https only, every redirect hop re-validated against the allowlist
 *     before it is fetched (never Node's automatic follow mode)
 *   - private/internal IPs blocked on the real socket connection via
 *     contact-finder.js's rejectingLookup (reused, not reimplemented) —
 *     closes the DNS-rebinding gap a preflight-only check leaves open
 *   - ~10s per-hop timeout, ~1.5MB response cap, bounded redirect chain
 *   - concurrency <= 3, identifying User-Agent
 *
 * fetch_blocked (timeout/DNS/TLS/size/disallowed host) is NEVER reported as
 * not_found — a checker outage must never read as "the page is gone".
 */

'use strict';

const http = require('http');
const https = require('https');
const db = require('../../models/db');
const logger = require('../logger');
const registry = require('../content/content-registry');
const { _internals: contactFinderInternals } = require('./contact-finder');
const { etDateString, addETDays } = require('../../utils/datetime-et');
const { deliverOpsDigest } = require('../ops-digest');
const { retireIfClean } = require('../ops-digest-fall-off');
const sendgrid = require('../sendgrid-mail');
const { isInternalEmailRecipient } = require('../../utils/internal-email-recipients');

const { rejectingLookup } = contactFinderInternals;

const CITATION_WINDOW_DAYS = 30;
const FETCH_TIMEOUT_MS = 10000;
const MAX_RESPONSE_BYTES = 1_500_000; // ~1.5MB
const MAX_REDIRECT_HOPS = 5;
const CONCURRENCY = 3;
const USER_AGENT = 'WavesOwnedUrlHealthCheck/1.0 (+https://www.wavespestcontrol.com)';

const VERDICTS = Object.freeze([
  'ok', 'redirect_ok', 'soft_404', 'not_found', 'server_error',
  'challenge', 'noindex', 'canonical_elsewhere', 'fetch_blocked',
]);

// Tracking params stripped before a URL is treated as an identity — an
// engine-attached ?utm_source=chatgpt must not create a duplicate row for a
// page already checked without it.
const TRACKING_PARAM_RE = /^(utm_[a-z_]+|mc_[a-z]+|fbclid|gclid|msclkid|igshid|ref|ref_src|_ga|_gl)$/i;

/**
 * Normalizes a cited URL to a stable identity for dedupe/persistence:
 * strips the fragment and tracking params, lowercases the host, and keeps
 * one consistent trailing-slash form (a trailing slash on every extension-
 * less path, matching the fleet's own URL convention).
 */
function normalizeOwnedUrl(value) {
  let parsed;
  try { parsed = new URL(String(value || '').trim()); } catch { return ''; }
  if (!/^https?:$/.test(parsed.protocol)) return '';
  parsed.hash = '';
  parsed.username = '';
  parsed.password = '';
  parsed.port = '';
  parsed.protocol = 'https:';
  parsed.hostname = parsed.hostname.toLowerCase();
  const params = new URLSearchParams(parsed.search);
  for (const key of [...params.keys()]) {
    if (TRACKING_PARAM_RE.test(key)) params.delete(key);
  }
  params.sort();
  const qs = params.toString();
  parsed.search = qs ? `?${qs}` : '';
  let pathname = parsed.pathname || '/';
  if (!/\.[a-z0-9]{1,8}$/i.test(pathname) && !pathname.endsWith('/')) pathname += '/';
  parsed.pathname = pathname;
  return parsed.toString();
}

function isOwnedFleetUrl(value) {
  return registry.isContentFleetUrl(value);
}

/**
 * Distinct normalized owned URLs cited in the trailing window, each with the
 * number of citation rows that named it (so a stale-but-uncited page never
 * shows up demanding attention, and a heavily-cited one is visibly urgent).
 */
async function collectCitedOwnedUrls({ database = db, windowDays = CITATION_WINDOW_DAYS, now = new Date() } = {}) {
  const since = etDateString(addETDays(now, -(windowDays - 1)));
  const rows = await database('seo_llm_mentions')
    .where('check_date', '>=', since)
    .whereNotNull('waves_cited_urls')
    .select('waves_cited_urls');

  const counts = new Map();
  for (const row of rows) {
    let urls;
    if (Array.isArray(row.waves_cited_urls)) urls = row.waves_cited_urls;
    else {
      try { urls = JSON.parse(row.waves_cited_urls || '[]'); } catch { urls = []; }
    }
    if (!Array.isArray(urls)) continue;
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

// ── SSRF-safe fetcher ────────────────────────────────────────────────────
// Manual GET over Node http/https, private-IP pinned to the real connection
// via contact-finder's rejectingLookup (reused, not reimplemented). Redirect
// handling lives one level up (fetchOwnedUrlChain) so every hop is
// re-validated against the owned-fleet allowlist before it is requested —
// this function never follows a redirect itself.
function nodeGet(url, { timeoutMs = FETCH_TIMEOUT_MS, maxBytes = MAX_RESPONSE_BYTES } = {}) {
  return new Promise((resolve) => {
    let settled = false;
    // req.setTimeout only bounds socket INACTIVITY (a gap with no data at
    // all) — a response trickling one byte every few seconds would never
    // trip it and could hold this fetch, and with it the whole runExclusive
    // sweep and every alert waiting on it, open indefinitely (codex pre-push
    // audit finding). This is a hard ceiling on the TOTAL request instead,
    // cleared as soon as the request settles any other way.
    const deadline = setTimeout(() => { req?.destroy(new Error('timeout')); done({ error: 'timeout' }); }, timeoutMs);
    const done = (v) => { if (!settled) { settled = true; clearTimeout(deadline); resolve(v); } };
    let parsed;
    try { parsed = new URL(url); } catch { return done({ error: 'invalid_url' }); }
    const mod = parsed.protocol === 'http:' ? http : https;
    let req;
    try {
      req = mod.request(parsed, {
        method: 'GET',
        lookup: rejectingLookup,
        headers: { 'User-Agent': USER_AGENT, Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8' },
      }, (res) => {
        const status = res.statusCode || 0;
        const headers = res.headers || {};
        // Redirect: headers are all this hop needs. Drop the body.
        if (status >= 300 && status < 400) { res.destroy(); return done({ status, headers }); }
        let data = '';
        let truncated = false;
        res.setEncoding('utf8');
        res.on('data', (chunk) => {
          if (truncated) return;
          data += chunk;
          if (Buffer.byteLength(data, 'utf8') >= maxBytes) {
            truncated = true;
            data = data.slice(0, maxBytes);
            res.destroy();
            done({ status, headers, body: data, truncated: true });
          }
        });
        res.on('end', () => done({ status, headers, body: data, truncated: false }));
        res.on('close', () => done({ status, headers, body: data, truncated }));
        res.on('error', (err) => done({ error: err.message || 'stream_error' }));
      });
    } catch (err) {
      return done({ error: err.message || 'request_failed' });
    }
    req.setTimeout(timeoutMs, () => req.destroy(new Error('timeout'))); // socket-inactivity backstop
    req.on('error', (err) => done({ error: err.message || 'network_error' }));
    req.end();
  });
}

/**
 * Walks a redirect chain manually, one hop at a time, re-validating EVERY
 * hop's host against the owned-fleet allowlist before it is fetched — a
 * redirect off the fleet (even to another public, otherwise-safe host)
 * stops the chain rather than following it.
 *   → { finalUrl, status, headers, body, truncated, hops } on a resolved
 *     (non-redirect) response, or { blockedReason | fetchError, hops } on
 *     any failure — both map to verdict fetch_blocked, never not_found.
 */
async function fetchOwnedUrlChain(startUrl, { getImpl = nodeGet, ...opts } = {}) {
  let current = startUrl;
  const hops = [];
  for (let hop = 0; hop <= MAX_REDIRECT_HOPS; hop++) {
    let parsed;
    try { parsed = new URL(current); } catch { return { blockedReason: 'invalid_url', hops }; }
    if (parsed.protocol !== 'https:') return { blockedReason: 'disallowed_protocol', hops };
    if (!isOwnedFleetUrl(current)) return { blockedReason: 'disallowed_host', hops };

    const result = await getImpl(current, opts);
    if (!result || result.error) return { fetchError: (result && result.error) || 'no_response', hops };

    if (result.status >= 300 && result.status < 400) {
      hops.push({ url: current, status: result.status });
      const location = result.headers?.location;
      if (!location) return { blockedReason: 'redirect_without_location', hops };
      let next;
      try { next = new URL(location, current).toString(); } catch { return { blockedReason: 'invalid_redirect_target', hops }; }
      current = next;
      continue;
    }

    hops.push({ url: current, status: result.status });
    return {
      finalUrl: current,
      status: result.status,
      headers: result.headers || {},
      body: result.body || '',
      truncated: !!result.truncated,
      hops,
    };
  }
  return { blockedReason: 'redirect_budget_exceeded', hops };
}

// ── Classification ────────────────────────────────────────────────────────

function extractTitle(html) {
  const m = String(html || '').match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  return m ? m[1].replace(/\s+/g, ' ').trim() : '';
}

function extractMetaRobots(html) {
  const values = [];
  for (const match of String(html || '').matchAll(/<meta\b[^>]*>/gi)) {
    const tag = match[0];
    const nameMatch = tag.match(/\bname\s*=\s*["']?robots["']?/i);
    if (!nameMatch) continue;
    const contentMatch = tag.match(/\bcontent\s*=\s*"([^"]*)"|\bcontent\s*=\s*'([^']*)'/i);
    if (contentMatch) values.push(contentMatch[1] ?? contentMatch[2] ?? '');
  }
  return values.join(',');
}

function extractCanonicalHref(html, requestedUrl) {
  for (const match of String(html || '').matchAll(/<link\b[^>]*>/gi)) {
    const tag = match[0];
    if (!/\brel\s*=\s*["']?canonical["']?/i.test(tag)) continue;
    const hrefMatch = tag.match(/\bhref\s*=\s*"([^"]*)"|\bhref\s*=\s*'([^']*)'/i);
    const href = hrefMatch ? (hrefMatch[1] ?? hrefMatch[2] ?? '') : '';
    if (!href) continue;
    try { return new URL(href, requestedUrl).toString(); } catch { return ''; }
  }
  return '';
}

// The Astro fleet's own 404.astro renders "Page Not Found" in <title> (and
// h1) with robots noindex,nofollow — a stable marker across every spoke
// since every site shares the same BaseLayout template. Cast a slightly
// wider net for any other soft-404 wording a page might carry.
const SOFT_404_RE = /\b(page not found|404[\s:—-]|we can.?t find that page|this page (doesn.?t|does not) exist)\b/i;
const CHALLENGE_RE = /\b(just a moment|verify you are human|checking your browser|attention required|access denied|captcha|cf-browser-verification|please enable cookies)\b/i;

function isNoindexSignal(metaRobots, headers) {
  const xRobots = String(headers?.['x-robots-tag'] || '');
  return /\bnoindex\b/i.test(metaRobots) || /\bnoindex\b/i.test(xRobots);
}

/**
 * Classifies one chain result into a verdict + detail payload. Pure and
 * synchronous so it is exhaustively unit-testable without a network mock.
 */
function classifyOwnedUrlHealth(requestedUrl, chain) {
  if (chain.blockedReason || chain.fetchError) {
    return {
      verdict: 'fetch_blocked',
      httpStatus: null,
      finalUrl: null,
      detail: { reason: chain.blockedReason || chain.fetchError, hops: chain.hops || [] },
    };
  }

  const { finalUrl, status, headers = {}, body = '', truncated, hops } = chain;
  const detailBase = { hops, truncated: !!truncated };

  if (status >= 500) {
    return { verdict: 'server_error', httpStatus: status, finalUrl, detail: detailBase };
  }
  if (status === 401 || status === 403 || status === 429) {
    return { verdict: 'challenge', httpStatus: status, finalUrl, detail: { ...detailBase, reason: 'blocked_status' } };
  }
  if (status === 404 || status === 410) {
    return { verdict: 'not_found', httpStatus: status, finalUrl, detail: detailBase };
  }
  if (status >= 400) {
    // Any other unexpected 4xx is reported as blocked, not as "gone" — the
    // checker itself may be what's being refused (fetch_blocked must never
    // be conflated with not_found).
    return { verdict: 'fetch_blocked', httpStatus: status, finalUrl, detail: { ...detailBase, reason: `unexpected_status_${status}` } };
  }
  if (status < 200 || status >= 300) {
    return { verdict: 'fetch_blocked', httpStatus: status, finalUrl, detail: { ...detailBase, reason: `unexpected_status_${status}` } };
  }

  // 2xx from here down. A truncated body (the ~1.5MB cap tripped, or the
  // socket closed before 'end') is never enough evidence to call a page
  // healthy — soft_404/challenge/noindex/canonical markers can all live past
  // the cutoff point, so an incomplete read is reported as blocked rather
  // than risking a false "ok" (or worse, retiring an existing FIX alert).
  if (truncated) {
    return { verdict: 'fetch_blocked', httpStatus: status, finalUrl, detail: { ...detailBase, reason: 'response_truncated' } };
  }
  const title = extractTitle(body);
  if (CHALLENGE_RE.test(body) || CHALLENGE_RE.test(title)) {
    return { verdict: 'challenge', httpStatus: status, finalUrl, detail: { ...detailBase, title } };
  }
  if (SOFT_404_RE.test(title) || SOFT_404_RE.test(body.slice(0, 4000))) {
    return { verdict: 'soft_404', httpStatus: status, finalUrl, detail: { ...detailBase, title } };
  }
  const metaRobots = extractMetaRobots(body);
  if (isNoindexSignal(metaRobots, headers)) {
    return { verdict: 'noindex', httpStatus: status, finalUrl, detail: { ...detailBase, title, metaRobots } };
  }
  const canonicalUrl = extractCanonicalHref(body, finalUrl);
  if (canonicalUrl) {
    const normalizedCanonical = normalizeOwnedUrl(canonicalUrl);
    const normalizedFinal = normalizeOwnedUrl(finalUrl);
    if (normalizedCanonical && normalizedFinal && normalizedCanonical !== normalizedFinal) {
      return { verdict: 'canonical_elsewhere', httpStatus: status, finalUrl, detail: { ...detailBase, title, canonicalUrl } };
    }
  }

  const permanentRedirectChain = hops.length > 1 && hops.slice(0, -1).every((h) => h.status === 301 || h.status === 308);
  if (permanentRedirectChain) {
    return { verdict: 'redirect_ok', httpStatus: status, finalUrl, detail: { ...detailBase, title } };
  }
  return { verdict: 'ok', httpStatus: status, finalUrl, detail: { ...detailBase, title } };
}

/** Fetches + classifies one owned URL. Never throws. */
async function checkOwnedUrlHealth(url, opts = {}) {
  const requestedUrl = normalizeOwnedUrl(url) || url;
  if (!isOwnedFleetUrl(requestedUrl)) {
    return { url: requestedUrl, verdict: 'fetch_blocked', httpStatus: null, finalUrl: null, detail: { reason: 'disallowed_host' } };
  }
  try {
    const chain = await fetchOwnedUrlChain(requestedUrl, opts);
    const classified = classifyOwnedUrlHealth(requestedUrl, chain);
    return { url: requestedUrl, ...classified };
  } catch (err) {
    return { url: requestedUrl, verdict: 'fetch_blocked', httpStatus: null, finalUrl: null, detail: { reason: err.message || 'check_failed' } };
  }
}

async function runWithConcurrency(items, limit, worker) {
  const out = new Array(items.length);
  let next = 0;
  const bound = Math.max(1, Math.min(limit, items.length || 1));
  const workers = Array.from({ length: bound }, async () => {
    while (next < items.length) {
      const idx = next;
      next += 1;
      out[idx] = await worker(items[idx], idx);
    }
  });
  await Promise.all(workers);
  return out;
}

// Every verdict except a clean live page. noindex and challenge are included
// deliberately: an engine-cited page that tells crawlers not to index it, or
// that we could not get past a bot wall to verify, is neither confirmed
// healthy nor something a clean run should ever retire a standing FIX alert
// over (codex pre-push audit finding).
const BAD_VERDICTS = new Set(['soft_404', 'not_found', 'server_error', 'canonical_elsewhere', 'fetch_blocked', 'noindex', 'challenge']);

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
 * Runs the full daily sweep: collect cited owned URLs, check each (bounded
 * concurrency), persist one row per (url, checked_on), and return a summary
 * the ops-digest sender and the admin dashboard both consume.
 */
async function runOwnedUrlHealthCheck({
  database = db,
  concurrency = CONCURRENCY,
  now = new Date(),
} = {}) {
  const checkedOn = etDateString(now);
  const candidates = await collectCitedOwnedUrls({ database, now });

  const results = await runWithConcurrency(candidates, concurrency, async ({ url, citationCount }) => {
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
  if (!candidates.length) return { checked: 0, bad: 0, badUrls: [], lastCheckedOn: null };

  const urls = candidates.map((c) => c.url);
  const citationByUrl = new Map(candidates.map((c) => [c.url, c.citationCount]));
  const rows = await database('seo_owned_url_health')
    .whereIn('url', urls)
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

  return { checked, bad: badUrls.length, badUrls, lastCheckedOn };
}

module.exports = {
  VERDICTS,
  BAD_VERDICTS,
  normalizeOwnedUrl,
  isOwnedFleetUrl,
  collectCitedOwnedUrls,
  fetchOwnedUrlChain,
  classifyOwnedUrlHealth,
  checkOwnedUrlHealth,
  runOwnedUrlHealthCheck,
  getCitedUrlHealthDashboard,
  postOwnedUrlHealthDigest,
  extractTitle,
  extractCanonicalHref,
  extractMetaRobots,
};
