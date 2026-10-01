const http = require('http');
const { decodeHTML } = require('entities');
const https = require('https');
const db = require('../../models/db');
const registry = require('./content-registry');
const { classifyPageBody } = require('../seo/page-body-classifier');
const { _internals: contactFinderInternals } = require('../seo/contact-finder');

const { rejectingLookup } = contactFinderInternals;

const DEFAULT_BASE_URL = 'https://www.wavespestcontrol.com';
const DEFAULT_LIMIT = 200;
const DEFAULT_CONCURRENCY = 4;
const DEFAULT_TIMEOUT_MS = 8000;
const DEFAULT_STATUSES = ['db_published_missing_astro', 'conflict'];
// Safety cap for the private-IP-pinned fetcher only (safeFetchImpl below) —
// the registry sweep's own default fetchImpl (global.fetch) is unaffected.
const DEFAULT_MAX_RESPONSE_BYTES = 1_500_000; // ~1.5MB

const CHECK_FIELDS = [
  'id',
  'canonical_url',
  'canonical_url_normalized',
  'live_url',
  'title',
  'live_status_checked_at',
  'http_status',
  'live_status',
  'redirect_target_url',
  'canonical_target_url',
  'noindex_detected',
  'sitemap_present',
  'sitemap_status',
  'registry_hash',
];

function normalizeStatuses(value) {
  if (typeof value === 'undefined') return DEFAULT_STATUSES;
  if (value === null) return null;
  if (value === false) return [];
  const list = Array.isArray(value)
    ? value
    : String(value).split(',');
  const out = list.map((item) => String(item || '').trim()).filter(Boolean);
  if (out.some((item) => item === 'all' || item === '*')) return null;
  return out;
}

function parsePositiveInt(value, fallback, max = 1000) {
  const n = Number(value);
  if (!Number.isInteger(n) || n <= 0) return fallback;
  return Math.min(n, max);
}

function buildAbsoluteUrl(value, baseUrl = DEFAULT_BASE_URL) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  if (/^https?:\/\//i.test(raw)) return raw;
  const base = String(baseUrl || DEFAULT_BASE_URL).replace(/\/+$/, '');
  if (raw.startsWith('/')) return `${base}${raw}`;
  return `${base}/${raw}`;
}

function targetUrlForRow(row, baseUrl = DEFAULT_BASE_URL) {
  return registry.registryLiveTargetUrl(row, baseUrl);
}

function fleetOrigin(value) {
  if (!registry.isContentFleetUrl(value)) return '';
  try { return new URL(String(value)).origin; } catch { return ''; }
}

function absoluteFromLocation(location, requestedUrl) {
  if (!location) return '';
  try {
    return new URL(location, requestedUrl).toString();
  } catch {
    return '';
  }
}

function normalizeInternalTarget(value) {
  return registry.normalizeContentUrl(value);
}

function parseTagAttributes(tag) {
  const attrs = {};
  const re = /([^\s"'<>/=]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+))/g;
  let m;
  while ((m = re.exec(String(tag || ''))) !== null) {
    attrs[m[1].toLowerCase()] = m[2] ?? m[3] ?? m[4] ?? '';
  }
  return attrs;
}

function extractCanonical(html, requestedUrl) {
  const text = String(html || '');
  for (const match of text.matchAll(/<link\b[^>]*>/gi)) {
    const attrs = parseTagAttributes(match[0]);
    const relTokens = String(attrs.rel || '').toLowerCase().split(/\s+/);
    if (!relTokens.includes('canonical')) continue;
    return attrs.href ? absoluteFromLocation(attrs.href, requestedUrl) : '';
  }
  return '';
}

function extractRobots(html) {
  const text = String(html || '');
  for (const match of text.matchAll(/<meta\b[^>]*>/gi)) {
    const attrs = parseTagAttributes(match[0]);
    if (String(attrs.name || '').toLowerCase() !== 'robots') continue;
    return attrs.content || '';
  }
  return '';
}

function isNoindex(html) {
  return /\bnoindex\b/i.test(extractRobots(html));
}

// A response can noindex via the X-Robots-Tag header instead of (or as well
// as) a meta tag — the documented health contract covers both. `headers`
// is the fetch-Response-shaped object fetchText hands back (`.get(name)`).
function isNoindexHeader(headers) {
  if (!headers || typeof headers.get !== 'function') return false;
  return /\bnoindex\b/i.test(String(headers.get('x-robots-tag') || ''));
}

// Body-aware signals a bare HTTP status can never see: a page that renders
// the site's OWN "Page Not Found" template, or a bot-challenge interstitial,
// under a 2xx status. Shared by the registry sweep and the owned cited-URL
// health check (server/services/seo/owned-url-health.js) — ONE detector, not
// two drifting copies. Challenge detection is interstitial-SPECIFIC evidence
// only (local audit finding 2026-09-27 on the pre-extraction copy): a
// healthy page with a `<div id="captcha">` widget, or "access denied" in its
// own copy, must never read as blocked.
function extractTitle(html) {
  const m = String(html || '').match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  return m ? m[1].replace(/\s+/g, ' ').trim() : '';
}

const SOFT_404_RE = /\b(page not found|404[\s:—-]|we can.?t find that page|this page (doesn.?t|does not) exist)\b/i;

function visibleText(html) {
  return String(html || '')
    .replace(/<script\b[\s\S]*?<\/script>|<style\b[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// THE soft-404 heading detector, shared by owned-page health and the citation auditor: a
// branded "Page not found" served as 200 says so in its <title> or <h1>. Headings only, so
// "404 reviews" or a 404-area-code phone in body copy is not a not-found page. Scripts,
// styles, templates and comments never render, so an unused error template inside one is not
// the page's heading. Entities are decoded before whitespace is collapsed (&nbsp;). "Not found"
// counts only as the heading's opening words ("404 Not Found") or within a few words after a
// page-like noun ("The page you requested was not found"),
// so an article titled "Why Termites Were Not Found" is not an error page.
const NOT_FOUND_HEADING_RE = /^(?:(?:oops|sorry|error|http|404)\W+)*not found\b|\b(?:page|file|url|resource|document|listing|profile|business|content)\b(?:\s+\S+){0,4}?\s+not found\b|\berror\s*404\b|\b404\s*error\b|^404\s*(?:[|:\u2013\u2014]|-\s|$)|\bpage (?:doesn.?t|does not|no longer) exists?\b|\b(?:can.?t|cannot|couldn.?t|could not) find (?:that|this|the) page\b/i;
const HEADING_TAGS = new Set(['title', 'h1']);
const INERT_TAGS = new Set(['!--', 'script', 'style', 'template']);
const TAG_RE = /<(\/?)(!--|[a-z][a-z0-9-]*)/y;
const headingText = (inner) => decodeHTML(visibleText(inner)).replace(/[\u00a0\u2007\u202f]/g, ' ').replace(/\s+/g, ' ').trim();

// indexOf that never searches the same stretch twice: each needle's last hit (Infinity once it
// is exhausted) is reused until the caller moves past it, so a whole scan stays linear.
function forwardFinder(lower) {
  const last = new Map();
  return (needle, from) => {
    const hit = last.get(needle);
    if (hit !== undefined && (hit === Infinity || hit >= from)) return hit;
    const at = lower.indexOf(needle, from);
    last.set(needle, at === -1 ? Infinity : at);
    return at === -1 ? Infinity : at;
  };
}

// Where an inert region opened at `lt` ends (Infinity = runs to end of document): a comment at
// "-->", script/style at their raw-text close, a template at its matching close (they nest).
function inertEnd(find, name, lt, gt) {
  if (name === '!--') return find('-->', lt + 4) + 3;
  if (name !== 'template') return find(`</${name}`, gt + 1);
  let depth = 1;
  let at = gt + 1;
  while (depth > 0 && at !== Infinity) {
    const close = find('</template', at);
    const nested = find('<template', at);
    if (nested < close) { depth += 1; at = nested + 9; } else { depth -= 1; at = close + 10; }
  }
  return at;
}

// Text of every <title>/<h1> in one forward pass, so malformed or unclosed tags in a 600 KB
// fetched page cannot make it quadratic. Inert regions are skipped both between and inside
// headings; a heading left open runs to the end of the document, as it renders.
function headingTexts(html) {
  const src = String(html || '');
  const lower = src.toLowerCase();
  const find = forwardFinder(lower);
  const out = [];
  let open = null; // { name, parts, from } of the heading being read
  let i = 0;
  while (i < lower.length) {
    const lt = find('<', i);
    TAG_RE.lastIndex = lt;
    const tag = lt === Infinity ? null : TAG_RE.exec(lower);
    if (!tag) { i = lt + 1; continue; }
    const [, closing, name] = tag;
    const gt = name === '!--' ? lt + 3 : find('>', lt);
    if (!closing && INERT_TAGS.has(name)) {
      const end = inertEnd(find, name, lt, gt);
      if (open) { open.parts.push(src.slice(open.from, lt)); open.from = end; }
      i = end;
    } else if (!closing && !open && HEADING_TAGS.has(name)) {
      open = { name, parts: [], from: gt + 1 };
      i = gt + 1;
    } else if (closing && open && name === open.name) {
      out.push([...open.parts, src.slice(open.from, lt)].join(' '));
      open = null;
      i = gt + 1;
    } else {
      i = gt + 1;
    }
  }
  if (open) out.push([...open.parts, src.slice(open.from)].join(' '));
  return out.map(headingText);
}
function notFoundHeading(html) {
  return headingTexts(html).some((t) => NOT_FOUND_HEADING_RE.test(t));
}

/**
 * Computed once per fetched body; harmless (and unused) for a non-2xx page.
 * Challenge and non-document detection are the shared page-body classifier's
 * strict mode (server/services/seo/page-body-classifier.js — also used by the
 * link prospect verifier), not a second copy, fed the response's REAL
 * Content-Type: a 200 JSON error, image or other non-HTML payload at a page
 * URL is not the page (Codex r5 on #5123).
 */
function computeBodySignals(html, contentType) {
  const title = extractTitle(html);
  const kind = classifyPageBody(html, contentType, { strictChallenge: true });
  return {
    title,
    challenge: kind === 'challenge',
    nonHtml: kind === 'non_html',
    softNotFound: notFoundHeading(html) || SOFT_404_RE.test(title) || SOFT_404_RE.test(String(html || '').slice(0, 4000)),
    visibleTextLength: visibleText(html).length,
  };
}

function classifyLiveStatus({ status, redirectTargetUrl, canonicalTargetUrl, requestedUrl, noindex, challenge, softNotFound, nonHtml }) {
  if (!status) return 'unknown';
  const code = Number(status);
  if (code === 404 || code === 410) return 'missing';
  if (code >= 500) return 'server_error';
  if (code >= 300 && code < 400) return redirectTargetUrl ? 'redirected' : 'error';
  if (code === 401 || code === 403) return 'blocked';
  if (code >= 400) return 'error';
  // Body-aware verdicts, checked before noindex/canonicalized — a page that
  // renders as a challenge, a not-found template or no document at all is
  // neither of those.
  if (challenge) return 'challenge';
  if (softNotFound || nonHtml) return 'soft_404';
  if (noindex) return 'noindex';
  const requested = normalizeInternalTarget(requestedUrl);
  const canonical = normalizeInternalTarget(canonicalTargetUrl);
  if (canonical && requested && canonical !== requested) return 'canonicalized';
  if (code >= 200 && code < 300) return 'live';
  return 'unknown';
}

function classifyRedirectLiveStatus({ finalStatus, redirectTargetUrl, noindex, challenge, softNotFound, nonHtml }) {
  const code = Number(finalStatus);
  if (!code) return redirectTargetUrl ? 'redirected' : 'unknown';
  // The followed chain ended on another 3xx (e.g. no Location on a later
  // hop) — it never reached a page, so it is not a healthy "redirected".
  if (code >= 300 && code < 400) return 'error';
  if (code === 404 || code === 410) return 'missing';
  if (code >= 500) return 'server_error';
  if (code === 401 || code === 403) return 'blocked';
  if (code >= 400) return 'error';
  // A redirect landing on a challenge or a soft-404 template is NOT the
  // reassuring "redirected" verdict — this is what would have hidden the
  // motivating case (a 301 chain landing on a "Page Not Found" 2xx page)
  // from a bare status check.
  if (challenge) return 'challenge';
  if (softNotFound || nonHtml) return 'soft_404';
  if (noindex) return 'noindex';
  if (code >= 200 && code < 300 && redirectTargetUrl) return 'redirected';
  return classifyLiveStatus({ status: finalStatus, redirectTargetUrl, noindex, challenge, softNotFound, nonHtml });
}

async function fetchText(fetchImpl, url, { redirect = 'manual', timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
  const timeout = controller ? setTimeout(() => controller.abort(), timeoutMs) : null;
  try {
    let currentUrl = String(url || '');
    for (let hop = 0; hop <= 5; hop++) {
      if (!registry.isContentFleetUrl(currentUrl)) throw new Error('Live-check URL is outside the content fleet');
      const res = await fetchImpl(currentUrl, {
        // Native follow mode can cross onto an untrusted redirect host before
        // application code sees it. Walk redirects manually so every hop is
        // checked against the fleet allowlist first.
        redirect: 'manual',
        signal: controller?.signal,
        headers: {
          'User-Agent': 'WavesContentRegistry/1.0 (+https://www.wavespestcontrol.com)',
          Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        },
      });
      const location = res.status >= 300 && res.status < 400
        ? absoluteFromLocation(res.headers.get('location'), currentUrl)
        : '';
      if (redirect === 'follow' && location) {
        currentUrl = location;
        continue;
      }
      const text = res.status >= 200 && res.status < 300 ? await res.text() : '';
      return { res, text, finalUrl: currentUrl };
    }
    throw new Error('Live-check redirect limit exceeded');
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

/**
 * SSRF-hardened fetchImpl: Node http/https with the private-IP DNS pin
 * (contact-finder.js's rejectingLookup, reused rather than reimplemented)
 * and a response-size cap. Matches the fetch(url, opts) -> Response-like
 * contract fetchText expects (status, headers.get(name), text()); honors
 * `signal` so fetchText's own per-call AbortController timeout still bounds
 * the whole request (including a response trickling data — an absolute
 * deadline, not just socket inactivity).
 *
 * The registry sweep's own default (global.fetch) is unaffected — this is
 * opt-in for a caller that needs the harder guarantee (owned-url-health.js,
 * whose target URLs are untrusted answer-engine citations rather than the
 * registry's own known fleet inventory).
 */
function safeFetchImpl(url, { signal, headers = {}, maxBytes = DEFAULT_MAX_RESPONSE_BYTES } = {}) {
  return new Promise((resolve, reject) => {
    let parsed;
    try { parsed = new URL(url); } catch (err) { return reject(err); }
    const mod = parsed.protocol === 'http:' ? http : https;
    let req;
    try {
      req = mod.request(parsed, { method: 'GET', lookup: rejectingLookup, headers }, (res) => {
        const status = res.statusCode || 0;
        const resHeaders = res.headers || {};
        const headerGet = (name) => resHeaders[String(name || '').toLowerCase()] ?? null;
        if (status >= 300 && status < 400) {
          res.destroy();
          return resolve({ status, headers: { get: headerGet }, text: async () => '', truncated: false });
        }
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
          }
        });
        res.on('end', () => resolve({ status, headers: { get: headerGet }, text: async () => data, truncated }));
        res.on('close', () => resolve({ status, headers: { get: headerGet }, text: async () => data, truncated }));
        res.on('error', (err) => reject(err));
      });
    } catch (err) {
      return reject(err);
    }
    req.on('error', reject);
    if (signal) {
      if (signal.aborted) { req.destroy(new Error('aborted')); return; }
      signal.addEventListener('abort', () => req.destroy(new Error('aborted')), { once: true });
    }
    req.end();
  });
}

/**
 * URL-level live-status checker — SHARED between the content-registry sweep
 * (checkRegistryRowLiveStatus below) and the owned cited-URL health check
 * (server/services/seo/owned-url-health.js), which maps this result into
 * its own richer verdict vocabulary. One fetcher, one classifier — not two
 * drifting copies (AGENTS.md "extend the existing mechanism").
 *
 * Returns the registry's existing live_status vocabulary (now including two
 * body-aware members, 'challenge' and 'soft_404') PLUS the raw body signals
 * (title, visibleTextLength) a caller with different empty-body rules can
 * apply on top — a thin/near-empty body is not by itself wrong for a
 * registry row (many legitimate pages are short), so that judgment call is
 * deliberately left to the caller rather than baked into the shared verdict.
 */
async function checkUrlLiveStatus(requestedUrl, {
  fetchImpl = global.fetch,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  sitemapPaths = null,
  fallbackNoindex = false,
} = {}) {
  if (!fetchImpl) throw new Error('fetch implementation is required');
  try {
    const first = await fetchText(fetchImpl, requestedUrl, { redirect: 'manual', timeoutMs });
    const status = String(first.res.status);
    const redirectTargetUrl = absoluteFromLocation(first.res.headers.get('location'), requestedUrl);
    let canonicalTargetUrl = extractCanonical(first.text, requestedUrl);
    let noindex = isNoindex(first.text) || isNoindexHeader(first.res.headers);
    let finalStatus = null;
    let followError = null;
    let finalUrl = requestedUrl;
    let finalBody = first.text;
    let finalContentType = first.res.headers.get('content-type');
    let finalTruncated = Boolean(first.res.truncated);

    if (redirectTargetUrl && first.res.status >= 300 && first.res.status < 400) {
      try {
        const follow = await fetchText(fetchImpl, redirectTargetUrl, { redirect: 'follow', timeoutMs });
        finalStatus = String(follow.res.status);
        canonicalTargetUrl = extractCanonical(follow.text, follow.finalUrl || redirectTargetUrl) || canonicalTargetUrl;
        noindex = noindex || isNoindex(follow.text) || isNoindexHeader(follow.res.headers);
        finalUrl = follow.finalUrl || redirectTargetUrl;
        finalBody = follow.text;
        finalContentType = follow.res.headers.get('content-type');
        finalTruncated = Boolean(follow.res.truncated);
      } catch (err) {
        followError = `Redirect target check failed: ${err.message}`;
      }
    }

    const bodySignals = followError ? null : computeBodySignals(finalBody, finalContentType);
    const sitemap = sitemapSignal({ sitemapPaths, requestedUrl, redirectTargetUrl, canonicalTargetUrl });
    const liveStatus = followError ? 'error' : redirectTargetUrl
      ? classifyRedirectLiveStatus({
        finalStatus, redirectTargetUrl, noindex,
        challenge: bodySignals?.challenge, softNotFound: bodySignals?.softNotFound, nonHtml: bodySignals?.nonHtml,
      })
      : classifyLiveStatus({
        status, redirectTargetUrl, canonicalTargetUrl, requestedUrl, noindex,
        challenge: bodySignals?.challenge, softNotFound: bodySignals?.softNotFound, nonHtml: bodySignals?.nonHtml,
      });

    return {
      target_url: requestedUrl,
      final_url: redirectTargetUrl ? finalUrl : requestedUrl,
      http_status: status,
      final_http_status: finalStatus,
      live_status: liveStatus,
      redirect_target_url: redirectTargetUrl || null,
      canonical_target_url: canonicalTargetUrl || null,
      noindex_detected: noindex,
      sitemap_present: sitemap.present,
      sitemap_status: sitemap.status,
      page_title: bodySignals?.title ?? null,
      visible_text_length: bodySignals?.visibleTextLength ?? null,
      content_type: finalContentType || null,
      truncated: finalTruncated,
      error: followError,
    };
  } catch (err) {
    const sitemap = sitemapSignal({ sitemapPaths, requestedUrl, redirectTargetUrl: null, canonicalTargetUrl: null });
    return {
      target_url: requestedUrl,
      final_url: null,
      http_status: 'error',
      final_http_status: null,
      live_status: 'error',
      redirect_target_url: null,
      canonical_target_url: null,
      noindex_detected: Boolean(fallbackNoindex),
      sitemap_present: sitemap.present,
      sitemap_status: sitemap.status,
      page_title: null,
      visible_text_length: null,
      truncated: false,
      error: err.message,
    };
  }
}

async function checkRegistryRowLiveStatus(row, {
  baseUrl = DEFAULT_BASE_URL,
  fetchImpl = global.fetch,
  sitemapPaths = null,
  timeoutMs = DEFAULT_TIMEOUT_MS,
} = {}) {
  if (!fetchImpl) throw new Error('fetch implementation is required');
  const requestedUrl = targetUrlForRow(row, baseUrl);
  if (!requestedUrl) {
    return {
      id: row?.id || null,
      target_url: '',
      http_status: 'unknown',
      live_status: 'unknown',
      redirect_target_url: null,
      canonical_target_url: null,
      noindex_detected: Boolean(row?.noindex_detected),
      sitemap_present: null,
      sitemap_status: 'unknown',
      error: 'No URL available for registry row',
    };
  }

  const result = await checkUrlLiveStatus(requestedUrl, {
    fetchImpl, timeoutMs, sitemapPaths, fallbackNoindex: row.noindex_detected,
  });

  return {
    id: row.id,
    title: row.title || null,
    target_url: result.target_url,
    http_status: result.http_status,
    live_status: result.live_status,
    redirect_target_url: result.redirect_target_url,
    canonical_target_url: result.canonical_target_url,
    noindex_detected: result.noindex_detected,
    sitemap_present: result.sitemap_present,
    sitemap_status: result.sitemap_status,
    error: result.error,
  };
}

function sitemapSignal({ sitemapPaths, requestedUrl, redirectTargetUrl, canonicalTargetUrl }) {
  if (!sitemapPaths) return { present: null, status: 'unknown' };
  const candidates = [requestedUrl, redirectTargetUrl, canonicalTargetUrl]
    .map(normalizeInternalTarget)
    .filter(Boolean);
  const present = candidates.some((candidate) => sitemapPaths.has(candidate));
  return { present, status: present ? 'present' : 'missing' };
}

async function fetchSitemapPaths({
  baseUrl = DEFAULT_BASE_URL,
  sitemapUrl = null,
  fetchImpl = global.fetch,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  maxSitemapFiles = 50,
} = {}) {
  const url = sitemapUrl || `${String(baseUrl || DEFAULT_BASE_URL).replace(/\/+$/, '')}/sitemap.xml`;
  return fetchSitemapPathsFromUrl(url, {
    fetchImpl,
    timeoutMs,
    visited: new Set(),
    maxSitemapFiles,
  });
}

async function fetchSitemapPathsFromUrl(url, {
  fetchImpl = global.fetch,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  visited = new Set(),
  maxSitemapFiles = 50,
} = {}) {
  if (!url || visited.has(url)) return null;
  if (visited.size >= maxSitemapFiles) return null;
  visited.add(url);
  const { res, text } = await fetchText(fetchImpl, url, { redirect: 'follow', timeoutMs });
  if (res.status < 200 || res.status >= 300) return null;
  if (/<sitemapindex\b/i.test(text)) {
    const childUrls = extractSitemapLocs(text)
      .map((loc) => absoluteFromLocation(loc, url))
      .filter(Boolean);
    if (!childUrls.length || childUrls.length + visited.size > maxSitemapFiles) return null;
    const paths = new Set();
    for (const childUrl of childUrls) {
      const childPaths = await fetchSitemapPathsFromUrl(childUrl, {
        fetchImpl,
        timeoutMs,
        visited,
        maxSitemapFiles,
      });
      if (!childPaths) return null;
      for (const item of childPaths) paths.add(item);
    }
    return paths;
  }
  if (!/<urlset\b/i.test(text)) return null;
  const paths = new Set();
  for (const loc of extractSitemapLocs(text)) {
    const normalized = normalizeInternalTarget(loc);
    if (normalized) paths.add(normalized);
  }
  return paths;
}

function extractSitemapLocs(xml) {
  return Array.from(String(xml || '').matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/gi), (match) => match[1]);
}

async function loadRegistryRows(database, { statuses, limit }) {
  if (Array.isArray(statuses) && statuses.length === 0) return [];
  let query = database('content_registry').select(CHECK_FIELDS);
  if (statuses && statuses.length) query = query.whereIn('reconciliation_status', statuses);
  return query
    .orderByRaw('live_status_checked_at ASC NULLS FIRST')
    .orderByRaw(`CASE reconciliation_status
      WHEN 'db_published_missing_astro' THEN 1
      WHEN 'conflict' THEN 2
      WHEN 'source_missing_since_sync' THEN 3
      WHEN 'db_changed_since_sync' THEN 4
      WHEN 'astro_changed_since_sync' THEN 5
      ELSE 9 END ASC`)
    .orderBy('title', 'asc')
    .limit(limit);
}

function liveUpdatePayload(row, result, now = new Date()) {
  const nextSitemapPresent = result.sitemap_status === 'unknown' && result.sitemap_present == null
    ? row.sitemap_present ?? null
    : result.sitemap_present;
  const nextSitemapStatus = result.sitemap_status === 'unknown' && result.sitemap_present == null
    ? row.sitemap_status || 'unknown'
    : result.sitemap_status || 'unknown';
  const updates = {
    http_status: result.http_status || 'unknown',
    live_status: result.live_status || 'unknown',
    redirect_target_url: result.redirect_target_url || null,
    canonical_target_url: result.canonical_target_url || null,
    noindex_detected: Boolean(result.noindex_detected),
    sitemap_present: nextSitemapPresent,
    sitemap_status: nextSitemapStatus,
    live_status_checked_at: now,
    updated_at: now,
  };
  return updates;
}

function liveFieldsChanged(row, updates) {
  return [
    'http_status',
    'live_status',
    'redirect_target_url',
    'canonical_target_url',
    'noindex_detected',
    'sitemap_present',
    'sitemap_status',
  ].some((field) => normalizeCompare(row[field]) !== normalizeCompare(updates[field]));
}

function normalizeCompare(value) {
  if (value instanceof Date) return value.toISOString();
  if (value == null) return null;
  return value;
}

async function runWithConcurrency(items, limit, worker) {
  const out = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length || 1)) }, async () => {
    while (next < items.length) {
      const idx = next;
      next += 1;
      out[idx] = await worker(items[idx], idx);
    }
  });
  await Promise.all(workers);
  return out;
}

function summarizeResults(results, updatedCount = 0) {
  const byLiveStatus = {};
  let errorCount = 0;
  for (const result of results) {
    byLiveStatus[result.live_status || 'unknown'] = (byLiveStatus[result.live_status || 'unknown'] || 0) + 1;
    if (result.error) errorCount += 1;
  }
  return {
    checked_count: results.length,
    updated_count: updatedCount,
    error_count: errorCount,
    by_live_status: byLiveStatus,
  };
}

async function runContentRegistryLiveStatusCheck({
  database = db,
  commit = false,
  statuses = DEFAULT_STATUSES,
  limit = DEFAULT_LIMIT,
  concurrency = DEFAULT_CONCURRENCY,
  baseUrl = DEFAULT_BASE_URL,
  sitemapUrl = null,
  useSitemap = true,
  fetchImpl = global.fetch,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  now = new Date(),
} = {}) {
  const normalizedStatuses = normalizeStatuses(statuses);
  const boundedLimit = parsePositiveInt(limit, DEFAULT_LIMIT);
  const boundedConcurrency = parsePositiveInt(concurrency, DEFAULT_CONCURRENCY, 16);
  const rows = await loadRegistryRows(database, {
    statuses: normalizedStatuses,
    limit: boundedLimit,
  });

  const sitemapPathsByOrigin = new Map();
  const sitemapErrors = [];
  if (useSitemap) {
    const baseOrigin = fleetOrigin(baseUrl);
    const origins = new Set(rows.map((row) => fleetOrigin(targetUrlForRow(row, baseUrl))).filter(Boolean));
    for (const origin of origins) {
      try {
        const paths = await fetchSitemapPaths({
          baseUrl: origin,
          sitemapUrl: sitemapUrl && origin === baseOrigin ? sitemapUrl : null,
          fetchImpl,
          timeoutMs,
        });
        sitemapPathsByOrigin.set(origin, paths);
      } catch (err) {
        sitemapPathsByOrigin.set(origin, null);
        sitemapErrors.push(`${origin}: ${err.message}`);
      }
    }
  }

  const results = await runWithConcurrency(rows, boundedConcurrency, (row) => checkRegistryRowLiveStatus(row, {
    baseUrl,
    fetchImpl,
    sitemapPaths: sitemapPathsByOrigin.get(fleetOrigin(targetUrlForRow(row, baseUrl))) || null,
    timeoutMs,
  }));

  let updatedCount = 0;
  if (commit) {
    for (let i = 0; i < rows.length; i++) {
      const updates = liveUpdatePayload(rows[i], results[i], now);
      const changed = liveFieldsChanged(rows[i], updates);
      // Always advance the durable check watermark, even when live fields are
      // unchanged, so the bounded sweep rotates through the full corpus.
      await database('content_registry').where('id', rows[i].id).update(updates);
      if (changed) updatedCount += 1;
    }
  }

  return {
    ok: true,
    mode: commit ? 'commit' : 'dry_run',
    statuses: normalizedStatuses,
    limit: boundedLimit,
    base_url: baseUrl,
    sitemap_error: sitemapErrors.length ? sitemapErrors.join('; ') : null,
    summary: summarizeResults(results, updatedCount),
    rows: results,
  };
}

module.exports = {
  DEFAULT_BASE_URL,
  DEFAULT_LIMIT,
  DEFAULT_CONCURRENCY,
  DEFAULT_TIMEOUT_MS,
  DEFAULT_MAX_RESPONSE_BYTES,
  DEFAULT_STATUSES,
  normalizeStatuses,
  parsePositiveInt,
  buildAbsoluteUrl,
  targetUrlForRow,
  absoluteFromLocation,
  parseTagAttributes,
  extractCanonical,
  extractRobots,
  isNoindex,
  isNoindexHeader,
  extractTitle,
  visibleText,
  computeBodySignals,
  SOFT_404_RE,
  notFoundHeading,
  classifyLiveStatus,
  classifyRedirectLiveStatus,
  safeFetchImpl,
  checkUrlLiveStatus,
  checkRegistryRowLiveStatus,
  runWithConcurrency,
  fetchSitemapPaths,
  fetchSitemapPathsFromUrl,
  extractSitemapLocs,
  loadRegistryRows,
  liveUpdatePayload,
  liveFieldsChanged,
  summarizeResults,
  runContentRegistryLiveStatusCheck,
};
