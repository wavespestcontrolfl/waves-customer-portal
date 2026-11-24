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
 *       - URL_UPDATED  when a job page is new, or its sitemap lastmod moved since
 *                      the last ping;
 *       - URL_DELETED  for a job URL we pinged before that left the sitemap (or
 *                      lost its JobPosting).
 *     assertJobUrl() refuses any other URL before a request is built.
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

const HUB_DOMAIN = 'wavespestcontrol.com';
const SITEMAP_PATH = '/sitemap-index.xml';
const JOB_PATH_PREFIX = '/careers/';
const INDEXING_SCOPE = 'https://www.googleapis.com/auth/indexing';
const STATE_KEY = 'google_index_ping.state';
const MAX_PUBLISHES_PER_RUN = 20;
const FETCH_TIMEOUT_MS = 20000;
const MAX_CHILD_SITEMAPS = 50;

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

async function fetchText(fetchFn, url) {
  const res = await fetchFn(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS), headers: { 'user-agent': 'WavesIndexPing/1.0' } });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return res.text();
}

// Every URL of the live hub sitemap with its lastmod. A child that fails to load
// fails the whole read: a partial list would read as "left the sitemap".
async function readSitemap(fetchFn, sitemapUrl) {
  const index = await fetchText(fetchFn, sitemapUrl);
  const children = xmlBlocks(index, 'sitemap').map((s) => s.loc).slice(0, MAX_CHILD_SITEMAPS);
  const urlsets = children.length ? await Promise.all(children.map((c) => fetchText(fetchFn, c))) : [index];
  const urls = new Map();
  for (const xml of urlsets) for (const u of xmlBlocks(xml, 'url')) urls.set(u.loc, u.lastmod);
  if (!urls.size) throw new Error('hub sitemap listed no URLs');
  const fingerprint = crypto.createHash('sha256')
    .update([...urls].sort(([a], [b]) => (a < b ? -1 : 1)).map(([loc, mod]) => `${loc}|${mod || ''}`).join('\n'))
    .digest('hex');
  return { urls, fingerprint };
}

// ── job pages ────────────────────────────────────────────────────────

function hasJobPostingType(node) {
  if (!node || typeof node !== 'object') return false;
  if (Array.isArray(node)) return node.some(hasJobPostingType);
  const type = node['@type'];
  if (type === 'JobPosting' || (Array.isArray(type) && type.includes('JobPosting'))) return true;
  return hasJobPostingType(node['@graph']);
}

// True when the page carries JobPosting JSON-LD. The ONLY test that lets a page
// reach the Indexing API as URL_UPDATED.
function htmlHasJobPosting(html) {
  const re = /<script\b[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let m;
  while ((m = re.exec(html))) {
    try { if (hasJobPostingType(JSON.parse(m[1]))) return true; } catch { /* bad JSON-LD block: not a job */ }
  }
  return false;
}

// A URL may reach urlNotifications.publish only when it is a hub page under
// /careers/. Policy: the Indexing API is for JobPosting / BroadcastEvent pages
// only. Whether it really is a job page is the caller's JSON-LD check (UPDATED)
// or "we pinged it before" (DELETED).
function assertJobUrl(url, origin) {
  let parsed;
  try { parsed = new URL(url); } catch { throw new Error(`not a URL: ${url}`); }
  if (parsed.origin !== origin || !parsed.pathname.startsWith(JOB_PATH_PREFIX)) {
    throw new Error(`refusing to send a non-job URL to the Indexing API: ${url}`);
  }
}

// ── the run ──────────────────────────────────────────────────────────

// fetchFn and the Indexing client are injectable for tests.
async function runGoogleIndexPing({ fetchFn = fetch, indexing = null } = {}) {
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

  // Same property + sitemap URL resolution as the Intelligence Bar's submit_gsc_sitemap.
  const property = await SearchConsole.resolveAccessibleProperty(HUB_DOMAIN);
  if (property.error) {
    warn(`Search Console property not resolved: ${property.error}`);
    return result;
  }
  const origin = property.siteUrl.startsWith('sc-domain:') ? `https://${HUB_DOMAIN}` : new URL(property.siteUrl).origin;
  const sitemapUrl = `${origin}${SITEMAP_PATH}`;

  let sitemap;
  try {
    sitemap = await readSitemap(fetchFn, sitemapUrl);
  } catch (err) {
    warn(`hub sitemap not read: ${err.message}`);
    return result;
  }

  let dirty = false;

  // 1. Sitemap resubmit when it changed.
  if (sitemap.fingerprint !== state.sitemapFingerprint) {
    const submitted = await SearchConsole.submitSitemap(property.siteUrl, sitemapUrl);
    if (submitted?.ok) {
      state.sitemapFingerprint = sitemap.fingerprint;
      result.sitemapSubmitted = true;
      dirty = true;
    } else {
      warn(`sitemap submit failed: ${submitted?.error || 'unknown error'}`);
    }
  }

  // 2. Job pages.
  const jobsDirty = await pingJobPages({ state, sitemap, origin, fetchFn, indexing, result, warn });
  dirty = dirty || jobsDirty;

  if (dirty) {
    try { await writeState(state); } catch (err) { warn(`state not saved, the next run repeats this work: ${err.message}`); }
  }
  logger.info(`[google-index-ping] ${JSON.stringify(result)}`);
  return result;
}

// Job pages: work list first (cheap), then at most MAX_PUBLISHES_PER_RUN sends.
// Mutates state and result; returns true when state changed.
async function pingJobPages({ state, sitemap, origin, fetchFn, indexing, result, warn }) {
  let dirty = false;
  let sends = 0;
  let stop = false;
  const inCareers = (loc) => {
    try { const u = new URL(loc); return u.origin === origin && u.pathname.startsWith(JOB_PATH_PREFIX); } catch { return false; }
  };
  const moved = (known, loc, lastmod) => known[loc] === undefined || (lastmod || '') !== known[loc];
  const candidates = [...sitemap.urls].filter(([loc, lastmod]) => inCareers(loc) && moved(state.jobs, loc, lastmod) && moved(state.nonJobs, loc, lastmod));
  const gone = Object.keys(state.jobs).filter((loc) => !sitemap.urls.has(loc));
  const canSend = () => !stop && sends < MAX_PUBLISHES_PER_RUN;

  // True when Google accepted the notification.
  const send = async (url, type) => {
    try {
      assertJobUrl(url, origin);
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

  for (const loc of gone) {
    if (!canSend()) break;
    if (await send(loc, 'URL_DELETED')) {
      delete state.jobs[loc];
      result.deleted += 1;
      dirty = true;
    }
  }
  // A page that left the sitemap is not a non-job any more either.
  for (const loc of Object.keys(state.nonJobs)) {
    if (!sitemap.urls.has(loc)) { delete state.nonJobs[loc]; dirty = true; }
  }

  for (const [loc, lastmod] of candidates) {
    if (!canSend()) break;
    let html;
    try {
      html = await fetchText(fetchFn, loc);
    } catch (err) {
      warn(`job page not read, retry next run: ${err.message}`);
      continue;
    }
    if (htmlHasJobPosting(html)) {
      if (await send(loc, 'URL_UPDATED')) {
        state.jobs[loc] = lastmod || '';
        delete state.nonJobs[loc];
        result.updated += 1;
        dirty = true;
      }
    } else if (state.jobs[loc] === undefined) {
      state.nonJobs[loc] = lastmod || '';
      dirty = true;
    } else if (await send(loc, 'URL_DELETED')) {
      // A page we pinged before lost its JobPosting (closed role): tell Google it is gone.
      delete state.jobs[loc];
      state.nonJobs[loc] = lastmod || '';
      result.deleted += 1;
      dirty = true;
    }
  }
  return dirty;
}

module.exports = { runGoogleIndexPing, htmlHasJobPosting, assertJobUrl, STATE_KEY, MAX_PUBLISHES_PER_RUN };
