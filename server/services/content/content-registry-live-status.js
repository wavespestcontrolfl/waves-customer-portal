const db = require('../../models/db');
const registry = require('./content-registry');

const DEFAULT_BASE_URL = 'https://www.wavespestcontrol.com';
const DEFAULT_LIMIT = 200;
const DEFAULT_CONCURRENCY = 4;
const DEFAULT_TIMEOUT_MS = 8000;
const DEFAULT_STATUSES = ['db_published_missing_astro', 'conflict'];

const CHECK_FIELDS = [
  'id',
  'canonical_url',
  'canonical_url_normalized',
  'live_url',
  'title',
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
  if (value == null) return DEFAULT_STATUSES;
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
  return buildAbsoluteUrl(row?.live_url || row?.canonical_url || row?.canonical_url_normalized, baseUrl);
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

function extractCanonical(html, requestedUrl) {
  const text = String(html || '');
  const m = text.match(/<link\b[^>]*\brel=["'][^"']*\bcanonical\b[^"']*["'][^>]*>/i);
  if (!m) return '';
  const href = m[0].match(/\bhref=["']([^"']+)["']/i);
  return href ? absoluteFromLocation(href[1], requestedUrl) : '';
}

function extractRobots(html) {
  const text = String(html || '');
  const m = text.match(/<meta\b[^>]*\bname=["']robots["'][^>]*>/i);
  if (!m) return '';
  const content = m[0].match(/\bcontent=["']([^"']+)["']/i);
  return content ? content[1] : '';
}

function isNoindex(html) {
  return /\bnoindex\b/i.test(extractRobots(html));
}

function classifyLiveStatus({ status, redirectTargetUrl, canonicalTargetUrl, requestedUrl, noindex }) {
  if (!status) return 'unknown';
  const code = Number(status);
  if (code === 404 || code === 410) return 'missing';
  if (code >= 500) return 'error';
  if (code >= 300 && code < 400) return redirectTargetUrl ? 'redirected' : 'error';
  if (code === 401 || code === 403) return 'blocked';
  if (code >= 400) return 'error';
  if (noindex) return 'noindex';
  const requested = normalizeInternalTarget(requestedUrl);
  const canonical = normalizeInternalTarget(canonicalTargetUrl);
  if (canonical && requested && canonical !== requested) return 'canonicalized';
  if (code >= 200 && code < 300) return 'live';
  return 'unknown';
}

async function fetchText(fetchImpl, url, { redirect = 'manual', timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
  const timeout = controller ? setTimeout(() => controller.abort(), timeoutMs) : null;
  try {
    const res = await fetchImpl(url, {
      redirect,
      signal: controller?.signal,
      headers: {
        'User-Agent': 'WavesContentRegistry/1.0 (+https://www.wavespestcontrol.com)',
        Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      },
    });
    const text = res.status >= 200 && res.status < 300 ? await res.text() : '';
    return { res, text };
  } finally {
    if (timeout) clearTimeout(timeout);
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

  try {
    const first = await fetchText(fetchImpl, requestedUrl, { redirect: 'manual', timeoutMs });
    const status = String(first.res.status);
    const redirectTargetUrl = absoluteFromLocation(first.res.headers.get('location'), requestedUrl);
    let canonicalTargetUrl = extractCanonical(first.text, requestedUrl);
    let noindex = isNoindex(first.text);

    if (redirectTargetUrl && first.res.status >= 300 && first.res.status < 400) {
      try {
        const follow = await fetchText(fetchImpl, redirectTargetUrl, { redirect: 'follow', timeoutMs });
        canonicalTargetUrl = extractCanonical(follow.text, follow.res.url || redirectTargetUrl) || canonicalTargetUrl;
        noindex = noindex || isNoindex(follow.text);
      } catch {
        // The redirect itself is still useful signal; keep the row check successful.
      }
    }

    const sitemap = sitemapSignal({
      sitemapPaths,
      requestedUrl,
      redirectTargetUrl,
      canonicalTargetUrl,
    });
    const liveStatus = classifyLiveStatus({
      status,
      redirectTargetUrl,
      canonicalTargetUrl,
      requestedUrl,
      noindex,
    });

    return {
      id: row.id,
      title: row.title || null,
      target_url: requestedUrl,
      http_status: status,
      live_status: liveStatus,
      redirect_target_url: redirectTargetUrl || null,
      canonical_target_url: canonicalTargetUrl || null,
      noindex_detected: noindex,
      sitemap_present: sitemap.present,
      sitemap_status: sitemap.status,
      error: null,
    };
  } catch (err) {
    return {
      id: row.id,
      title: row.title || null,
      target_url: requestedUrl,
      http_status: 'error',
      live_status: 'error',
      redirect_target_url: null,
      canonical_target_url: null,
      noindex_detected: Boolean(row.noindex_detected),
      sitemap_present: sitemapPaths ? false : null,
      sitemap_status: sitemapPaths ? 'missing' : 'unknown',
      error: err.message,
    };
  }
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
} = {}) {
  const url = sitemapUrl || `${String(baseUrl || DEFAULT_BASE_URL).replace(/\/+$/, '')}/sitemap.xml`;
  const { res, text } = await fetchText(fetchImpl, url, { redirect: 'follow', timeoutMs });
  if (res.status < 200 || res.status >= 300) return null;
  const paths = new Set();
  for (const match of text.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/gi)) {
    const normalized = normalizeInternalTarget(match[1]);
    if (normalized) paths.add(normalized);
  }
  return paths;
}

async function loadRegistryRows(database, { statuses, limit }) {
  let query = database('content_registry').select(CHECK_FIELDS);
  if (statuses && statuses.length) query = query.whereIn('reconciliation_status', statuses);
  return query
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
  const updates = {
    http_status: result.http_status || 'unknown',
    live_status: result.live_status || 'unknown',
    redirect_target_url: result.redirect_target_url || null,
    canonical_target_url: result.canonical_target_url || null,
    noindex_detected: Boolean(result.noindex_detected),
    sitemap_present: result.sitemap_present,
    sitemap_status: result.sitemap_status || 'unknown',
    updated_at: now,
  };
  updates.registry_hash = registry.stableHash({ ...row, ...updates, registry_hash: undefined });
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

  let sitemapPaths = null;
  let sitemapError = null;
  if (useSitemap) {
    try {
      sitemapPaths = await fetchSitemapPaths({ baseUrl, sitemapUrl, fetchImpl, timeoutMs });
    } catch (err) {
      sitemapError = err.message;
    }
  }

  const results = await runWithConcurrency(rows, boundedConcurrency, (row) => checkRegistryRowLiveStatus(row, {
    baseUrl,
    fetchImpl,
    sitemapPaths,
    timeoutMs,
  }));

  let updatedCount = 0;
  if (commit) {
    for (let i = 0; i < rows.length; i++) {
      const updates = liveUpdatePayload(rows[i], results[i], now);
      if (!liveFieldsChanged(rows[i], updates)) continue;
      await database('content_registry').where('id', rows[i].id).update(updates);
      updatedCount += 1;
    }
  }

  return {
    ok: true,
    mode: commit ? 'commit' : 'dry_run',
    statuses: normalizedStatuses,
    limit: boundedLimit,
    base_url: baseUrl,
    sitemap_error: sitemapError,
    summary: summarizeResults(results, updatedCount),
    rows: results,
  };
}

module.exports = {
  DEFAULT_BASE_URL,
  DEFAULT_LIMIT,
  DEFAULT_CONCURRENCY,
  DEFAULT_TIMEOUT_MS,
  DEFAULT_STATUSES,
  normalizeStatuses,
  parsePositiveInt,
  buildAbsoluteUrl,
  targetUrlForRow,
  absoluteFromLocation,
  extractCanonical,
  extractRobots,
  isNoindex,
  classifyLiveStatus,
  checkRegistryRowLiveStatus,
  fetchSitemapPaths,
  loadRegistryRows,
  liveUpdatePayload,
  liveFieldsChanged,
  summarizeResults,
  runContentRegistryLiveStatusCheck,
};
