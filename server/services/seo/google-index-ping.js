/**
 * google-index-ping.js — tells Google about hub (main site) changes.
 * Owner 2026-11-23, "build". A free write to our own Search Console; no gate,
 * no customer message, no admin bell.
 *
 *  1. Sitemap: when the live hub sitemap changed since the last good submit,
 *     resubmit sitemap-index.xml (SearchConsoleV2.submitSitemap, the same
 *     property + feed resolution the Intelligence Bar's submit_gsc_sitemap uses).
 *  2. Job pages: Google's Indexing API (urlNotifications.publish) is allowed ONLY
 *     for JobPosting / BroadcastEvent pages. This module sends it hub URLs under
 *     /careers/ whose HTML carries JobPosting JSON-LD, and nothing else:
 *       - URL_UPDATED  when a job page is new, its sitemap lastmod moved, or (no
 *                      lastmod) its JobPosting content changed since the last ping;
 *       - URL_DELETED  for a job URL we pinged before that left the sitemap or
 *                      lost its JobPosting, but ONLY with Google's evidence: the
 *                      URL now answers 404 or 410, or carries robots noindex.
 *                      Anything else (still live, a redirect) just drops it from state.
 *     assertJobUrl() refuses any other URL before a request is built.
 *
 * Every fetch is https on the canonical hub host only, redirects are refused
 * (SSRF guard: a sitemap loc or a redirect must never steer a request elsewhere).
 * An incomplete sitemap read (too many children, a child that is not sitemap XML
 * or has no URLs) aborts the run with state untouched.
 *
 * Idempotent, so a dropped node-cron tick is caught up by the next one: state
 * moves only after Google accepts a call. Any Google or fetch error logs a
 * warning, leaves that part of the state alone, and the next tick retries.
 * Indexing API default quota is 200 a day: at most MAX_PUBLISHES_PER_RUN per run.
 *
 * State: one system_settings row (STATE_KEY), JSON.
 */

const crypto = require('crypto');
const db = require('../../models/db');
const logger = require('../logger');
const { isAllowedSitemapChild } = require('./sitemap-manager')._internals;

const HUB_DOMAIN = 'wavespestcontrol.com';
// The canonical hub origin, independent of which Search Console property
// (URL-prefix or sc-domain:) is used to submit the sitemap.
const HUB_ORIGIN = `https://www.${HUB_DOMAIN}`;
const HUB_HOST = `www.${HUB_DOMAIN}`;
const SITEMAP_URL = `${HUB_ORIGIN}/sitemap-index.xml`;
const JOB_PATH_PREFIX = '/careers/';
const INDEXING_SCOPE = 'https://www.googleapis.com/auth/indexing';
const STATE_KEY = 'google_index_ping.state';
const MAX_PUBLISHES_PER_RUN = 20;
const FETCH_TIMEOUT_MS = 20000;
const MAX_CHILD_SITEMAPS = 50;
const UNDATED_RECHECK_MS = 24 * 60 * 60 * 1000;

// googleapis is heavy (~71MB) — lazy load, as search-console-v2.js does.
let google;
function getGoogle() {
  if (google === undefined) {
    try { google = require('googleapis').google; } catch { google = null; }
  }
  return google;
}

let indexingClient;
function getIndexingClient() {
  if (indexingClient) return indexingClient;
  const g = getGoogle();
  const saEnv = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
  if (!g || !saEnv) return null;
  // Same credential parsing as every other Search Console call.
  const { gscAuthOptions } = require('./search-console-v2')._internals;
  indexingClient = g.indexing({ version: 'v3', auth: new g.auth.GoogleAuth(gscAuthOptions(saEnv, INDEXING_SCOPE)) });
  return indexingClient;
}

// ── state ────────────────────────────────────────────────────────────
//   jobs:    { url: { lastmod, fp, checkedAt } }  pages we sent URL_UPDATED for
//   nonJobs: { url: { lastmod, checkedAt } }      /careers/ pages with no JobPosting

function emptyState() {
  return { sitemapFingerprint: null, jobs: {}, nonJobs: {} };
}

async function readState() {
  const row = await db('system_settings').where({ key: STATE_KEY }).first('value');
  if (!row?.value) return emptyState();
  const parsed = JSON.parse(row.value);
  return {
    sitemapFingerprint: parsed.sitemapFingerprint || null,
    jobs: parsed.jobs && typeof parsed.jobs === 'object' ? parsed.jobs : {},
    nonJobs: parsed.nonJobs && typeof parsed.nonJobs === 'object' ? parsed.nonJobs : {},
  };
}

async function writeState(state) {
  const value = JSON.stringify(state);
  await db('system_settings').insert({ key: STATE_KEY, value, category: 'seo' })
    .onConflict('key').merge({ value, updated_at: db.fn.now() });
}

// ── guarded fetch ────────────────────────────────────────────────────

// https on the canonical hub host only (sitemap-manager's host check, tightened:
// https only, and exactly the www host, not the apex or a spoke).
function isHubUrl(url) {
  try {
    const u = new URL(url);
    return u.protocol === 'https:' && u.host === HUB_HOST && isAllowedSitemapChild(url, HUB_ORIGIN);
  } catch { return false; }
}

// One request, no redirect followed. Returns { status, headers, text }. Throws
// for a URL outside the hub, a redirect (3xx is returned, never followed), or a
// network failure; callers decide what a 3xx or 4xx means.
async function fetchHub(fetchFn, url) {
  if (!isHubUrl(url)) throw new Error(`refusing to fetch a URL outside the hub: ${url}`);
  const res = await fetchFn(url, {
    redirect: 'manual',
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    headers: { 'user-agent': 'WavesIndexPing/1.0' },
  });
  const ok = res.status >= 200 && res.status < 300;
  return { status: res.status, headers: res.headers, text: ok ? await res.text() : '' };
}

async function fetchHubOk(fetchFn, url) {
  const res = await fetchHub(fetchFn, url);
  if (res.status < 200 || res.status >= 300) throw new Error(`HTTP ${res.status} for ${url}`);
  return res.text;
}

// ── sitemap ──────────────────────────────────────────────────────────

const decodeXml = (s) => s.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'");

function xmlBlocks(xml, tag) {
  const out = [];
  const re = new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`, 'g');
  let m;
  while ((m = re.exec(xml))) {
    const loc = /<loc>\s*([^<]*?)\s*<\/loc>/.exec(m[1]);
    if (!loc) continue;
    const lastmod = /<lastmod>\s*([^<]*?)\s*<\/lastmod>/.exec(m[1]);
    out.push({ loc: decodeXml(loc[1]), lastmod: lastmod ? lastmod[1] : null });
  }
  return out;
}

// The <url> entries of one urlset document. Anything else (an HTML 200 page, an
// empty set) throws: a partial read would look like "left the sitemap".
function readUrlset(xml, where) {
  if (!/<urlset\b/.test(xml)) throw new Error(`${where} is not sitemap XML`);
  const entries = xmlBlocks(xml, 'url');
  if (!entries.length) throw new Error(`${where} has no URLs`);
  return entries;
}

// Every URL of the live hub sitemap with its lastmod, or a throw.
async function readSitemap(fetchFn) {
  const index = await fetchHubOk(fetchFn, SITEMAP_URL);
  const entries = [];
  if (/<sitemapindex\b/.test(index)) {
    const children = xmlBlocks(index, 'sitemap').map((s) => s.loc);
    if (!children.length) throw new Error('sitemap index lists no child sitemaps');
    if (children.length > MAX_CHILD_SITEMAPS) throw new Error(`sitemap index lists ${children.length} children, over the ${MAX_CHILD_SITEMAPS} cap`);
    const docs = await Promise.all(children.map((c) => fetchHubOk(fetchFn, c)));
    docs.forEach((xml, i) => entries.push(...readUrlset(xml, children[i])));
  } else {
    entries.push(...readUrlset(index, SITEMAP_URL));
  }
  const urls = new Map(entries.map((e) => [e.loc, e.lastmod]));
  const fingerprint = crypto.createHash('sha256')
    .update([...urls].sort(([a], [b]) => (a < b ? -1 : 1)).map(([loc, mod]) => `${loc}|${mod || ''}`).join('\n'))
    .digest('hex');
  return { urls, fingerprint };
}

// ── job pages ────────────────────────────────────────────────────────

function collectJobPostings(node, out) {
  if (!node || typeof node !== 'object') return out;
  if (Array.isArray(node)) { node.forEach((n) => collectJobPostings(n, out)); return out; }
  const type = node['@type'];
  if (type === 'JobPosting' || (Array.isArray(type) && type.includes('JobPosting'))) out.push(node);
  return collectJobPostings(node['@graph'], out);
}

// Every JobPosting node in the page's JSON-LD.
function extractJobPostings(html) {
  const out = [];
  const re = /<script\b[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let m;
  while ((m = re.exec(html))) {
    try { collectJobPostings(JSON.parse(m[1]), out); } catch { /* bad JSON-LD block: not a job */ }
  }
  return out;
}

// True when the page carries JobPosting JSON-LD. The ONLY test that lets a page
// reach the Indexing API as URL_UPDATED.
const htmlHasJobPosting = (html) => extractJobPostings(html).length > 0;

const jobFingerprint = (postings) => crypto.createHash('sha256').update(JSON.stringify(postings)).digest('hex');

// robots noindex: X-Robots-Tag header or <meta name="robots|googlebot">.
function isNoindex(headers, html) {
  const header = headers?.get?.('x-robots-tag') || '';
  if (/noindex|none/i.test(header)) return true;
  const re = /<meta\b[^>]*name=["'](?:robots|googlebot)["'][^>]*>/gi;
  let m;
  while ((m = re.exec(html))) if (/content=["'][^"']*\b(?:noindex|none)\b/i.test(m[0])) return true;
  return false;
}

// A URL may reach urlNotifications.publish only when it is a hub page under
// /careers/. Policy: the Indexing API is for JobPosting / BroadcastEvent pages
// only. Whether it really is a job page is the caller's JSON-LD check (UPDATED)
// or "we pinged it before" (DELETED).
function assertJobUrl(url) {
  let parsed;
  try { parsed = new URL(url); } catch { throw new Error(`not a URL: ${url}`); }
  if (!isHubUrl(url) || !parsed.pathname.startsWith(JOB_PATH_PREFIX)) {
    throw new Error(`refusing to send a non-job URL to the Indexing API: ${url}`);
  }
}

const inCareers = (loc) => isHubUrl(loc) && new URL(loc).pathname.startsWith(JOB_PATH_PREFIX);

// ── the run ──────────────────────────────────────────────────────────

// fetchFn, the Indexing client and the clock are injectable for tests.
async function runGoogleIndexPing({ fetchFn = fetch, indexing = null, now = Date.now() } = {}) {
  if (!process.env.GOOGLE_SERVICE_ACCOUNT_JSON) {
    logger.info('[google-index-ping] GOOGLE_SERVICE_ACCOUNT_JSON not set — skipping');
    return { skipped: 'not_configured' };
  }
  const SearchConsole = require('./search-console-v2');
  const result = { sitemapSubmitted: false, updated: 0, deleted: 0, errors: 0 };
  const warn = (msg) => { result.errors += 1; logger.warn(`[google-index-ping] ${msg}`); };

  let state;
  try {
    state = await readState();
  } catch (err) {
    // Without the last state every job page would be re-pinged; wait for the next tick.
    warn(`state not read, run skipped: ${err.message}`);
    return result;
  }

  // Same property resolution as the Intelligence Bar's submit_gsc_sitemap. The
  // property only says WHERE to submit; the hub origin above is what we read and guard.
  const property = await SearchConsole.resolveAccessibleProperty(HUB_DOMAIN);
  if (property.error) {
    warn(`Search Console property not resolved: ${property.error}`);
    return result;
  }

  let sitemap;
  try {
    sitemap = await readSitemap(fetchFn);
  } catch (err) {
    warn(`hub sitemap not read, run stopped with state untouched: ${err.message}`);
    return result;
  }

  let dirty = false;

  // 1. Sitemap resubmit when it changed.
  if (sitemap.fingerprint !== state.sitemapFingerprint) {
    const submitted = await SearchConsole.submitSitemap(property.siteUrl, SITEMAP_URL);
    if (submitted?.ok) {
      state.sitemapFingerprint = sitemap.fingerprint;
      result.sitemapSubmitted = true;
      dirty = true;
    } else {
      warn(`sitemap submit failed: ${submitted?.error || 'unknown error'}`);
    }
  }

  // 2. Job pages.
  const jobsDirty = await pingJobPages({ state, sitemap, fetchFn, indexing, result, warn, now });
  dirty = dirty || jobsDirty;

  if (dirty) {
    try { await writeState(state); } catch (err) { warn(`state not saved, the next run repeats this work: ${err.message}`); }
  }
  logger.info(`[google-index-ping] ${JSON.stringify(result)}`);
  return result;
}

// Does this careers URL need a fresh look? New: yes. Dated: when its lastmod moved.
// Undated: at most once per 24 h (its content fingerprint decides URL_UPDATED).
function isDue(known, lastmod, now) {
  if (!known) return true;
  if (lastmod) return lastmod !== known.lastmod;
  return now - Date.parse(known.checkedAt || 0) >= UNDATED_RECHECK_MS;
}

// Job pages: at most MAX_PUBLISHES_PER_RUN sends. Mutates state and result;
// returns true when state changed.
async function pingJobPages({ state, sitemap, fetchFn, indexing, result, warn, now }) {
  let dirty = false;
  let sends = 0;
  let stop = false;
  const stamp = new Date(now).toISOString();
  const canSend = () => !stop && sends < MAX_PUBLISHES_PER_RUN;

  // True when Google accepted the notification.
  const send = async (url, type) => {
    try {
      assertJobUrl(url);
      const client = indexing || getIndexingClient();
      if (!client) throw new Error('googleapis is not available');
      sends += 1;
      await client.urlNotifications.publish({ requestBody: { url, type } });
      return true;
    } catch (err) {
      const status = Number(err?.code || err?.response?.status || err?.status) || null;
      warn(`${type} not sent for ${url}${status ? ` (HTTP ${status})` : ''}: ${err.message}`);
      // Auth, permission or quota trouble hits every URL alike: stop, retry next tick.
      if ([401, 403, 429].includes(status)) stop = true;
      return false;
    }
  };

  // A pinged job URL that is gone from the sitemap, or lost its JobPosting. Google's
  // removal rule needs 404 / 410 / noindex, so look at the URL first. Returns false
  // when the state could not be decided (network or 5xx): keep it, retry next run.
  const retire = async (loc, res) => {
    let page = res;
    if (!page) {
      try { page = await fetchHub(fetchFn, loc); } catch (err) { warn(`job URL not checked, retry next run: ${err.message}`); return false; }
    }
    if (page.status >= 500) { warn(`job URL answered HTTP ${page.status}, retry next run: ${loc}`); return false; }
    const evidence = page.status === 404 || page.status === 410 || (page.status === 200 && isNoindex(page.headers, page.text));
    if (evidence && !(await send(loc, 'URL_DELETED'))) return false;
    if (evidence) result.deleted += 1;
    delete state.jobs[loc]; // no evidence (still live, or a redirect): dropped quietly, nothing published
    return true;
  };

  for (const loc of Object.keys(state.jobs).filter((l) => !sitemap.urls.has(l))) {
    if (!canSend()) break;
    if (await retire(loc)) dirty = true;
  }
  // A page that left the sitemap is not a non-job any more either.
  for (const loc of Object.keys(state.nonJobs)) {
    if (!sitemap.urls.has(loc)) { delete state.nonJobs[loc]; dirty = true; }
  }

  // One /careers/ page that is due a look. Returns true when state changed.
  const check = async (loc, lastmod) => {
    let page;
    try {
      page = await fetchHub(fetchFn, loc);
    } catch (err) {
      warn(`job page not read, retry next run: ${err.message}`);
      return false;
    }
    const postings = page.status === 200 && !isNoindex(page.headers, page.text) ? extractJobPostings(page.text) : [];
    const prev = state.jobs[loc];
    const entry = { lastmod: lastmod || '', checkedAt: stamp };
    if (postings.length) {
      const fp = jobFingerprint(postings);
      const changed = !prev || (lastmod ? lastmod !== prev.lastmod : fp !== prev.fp);
      if (changed && !(await send(loc, 'URL_UPDATED'))) return false;
      if (changed) result.updated += 1;
      state.jobs[loc] = { ...entry, fp };
      delete state.nonJobs[loc];
      return true;
    }
    if (prev ? !(await retire(loc, page)) : page.status !== 200) {
      if (!prev) warn(`job page answered HTTP ${page.status}, retry next run: ${loc}`);
      return false;
    }
    state.nonJobs[loc] = entry;
    return true;
  };

  const candidates = [...sitemap.urls].filter(([loc, lastmod]) => inCareers(loc) && isDue(state.jobs[loc] || state.nonJobs[loc], lastmod, now));
  for (const [loc, lastmod] of candidates) {
    if (!canSend()) break;
    if (await check(loc, lastmod)) dirty = true;
  }
  return dirty;
}

module.exports = { runGoogleIndexPing, htmlHasJobPosting, assertJobUrl, isHubUrl, STATE_KEY, MAX_PUBLISHES_PER_RUN, HUB_ORIGIN, UNDATED_RECHECK_MS };
