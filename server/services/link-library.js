/**
 * Link Library — the searchable set of links the admin SMS composer can
 * insert (owner ask 2026-08-30: replace the composer's link buttons with a
 * searchable library covering the whole website, review profiles, app
 * stores, and socials).
 *
 * Three sources, one list:
 *   manual  — hand-managed rows (Settings ▸ Link Library CRUD). Editable.
 *   sitemap — every page of www.wavespestcontrol.com, upserted by
 *             syncSitemapLinks() (daily scheduler job + Settings "Sync now").
 *             Not editable: the sitemap is the source of truth.
 *   office  — the per-office Google write-a-review links, computed live
 *             from config/locations.js WAVES_LOCATIONS so they can never
 *             drift from the canonical office set. Never stored.
 *
 * Sitemap fetching/parsing is delegated to services/seo/sitemap-manager —
 * the one sitemap mechanism in this repo (SSRF-guarded, index-recursing,
 * 5-min cached). This module only owns what the composer needs on top:
 * naming, categorization, and the library rows.
 *
 * Rows carry an optional `clause` — the SMS sentence prefix the composer
 * renders as "{clause}: {url}". Rows without one fall back to their name.
 */

const db = require('../models/db');
const logger = require('./logger');
const sitemapManager = require('./seo/sitemap-manager');
const { WAVES_LOCATIONS } = require('../config/locations');

const SITE_HOST = 'wavespestcontrol.com';
// A sitemap fetch that comes back with almost nothing is a broken fetch or a
// half-deployed site, not a site that shrank to nothing — refuse to let it
// hollow out the library.
const MIN_SANE_SITEMAP_URLS = 10;

// Schema limit on link_library.name (migration 20260831000001).
const MAX_NAME_LENGTH = 120;

const CATEGORIES = ['reviews', 'booking', 'app', 'website', 'social'];
// The composer also renders a 'customer' group (the minted per-customer
// links) but those are endpoint config, never library rows.
const BOOKING_PATHS = new Set(['/quote/', '/book/', '/pest-control-calculator/']);

// ── Pure helpers (unit tested) ───────────────────────────────────────────

/**
 * Human name for a site URL, derived from its slug. "/" is the homepage;
 * otherwise the last path segment is title-cased with the state suffix
 * uppercased: /cockroach-control-sarasota-fl/ → "Cockroach Control Sarasota FL".
 */
function nameForSiteUrl(url) {
  let path;
  try {
    path = new URL(url).pathname;
  } catch {
    return null;
  }
  const trimmed = path.replace(/\/+$/, '');
  if (!trimmed) return 'Homepage';
  const slug = decodeURIComponent(trimmed.split('/').pop());
  const words = slug.split('-').filter(Boolean).map((w) => {
    if (w === 'fl') return 'FL';
    if (w === 'faqs') return 'FAQs';
    return w.charAt(0).toUpperCase() + w.slice(1);
  });
  // link_library.name is varchar(120); an over-long derived name would abort
  // the sync at this page on every run, freezing later pages and removals.
  const name = words.join(' ').slice(0, MAX_NAME_LENGTH).trimEnd();
  return name || null;
}

/** Library category for a site URL: the booking-funnel pages, else website. */
function categoryForSiteUrl(url) {
  try {
    const path = new URL(url).pathname.replace(/\/*$/, '/');
    return BOOKING_PATHS.has(path) ? 'booking' : 'website';
  } catch {
    return 'website';
  }
}

/** True for a page URL on the marketing site (www or bare host, http(s)). */
function isSiteUrl(url) {
  try {
    const u = new URL(url);
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return false;
    return u.hostname.replace(/^www\./i, '').toLowerCase() === SITE_HOST;
  } catch {
    return false;
  }
}

// ── Sitemap sync ─────────────────────────────────────────────────────────

/**
 * Pull every page URL out of the marketing site's sitemap and upsert them
 * as source='sitemap' rows: new pages appear, renamed slugs update, removed
 * pages are deleted. Manual rows are never touched.
 * Returns { fetched, added, updated, removed }.
 */
async function syncSitemapLinks({ fetchFn } = {}) {
  // The manager caches per-host for 5 minutes; a sync is an explicit ask for
  // the live sitemap (the Settings button especially), so bust it first.
  sitemapManager.invalidate();
  const rawUrls = await sitemapManager.listUrls(fetchFn ? { fetchFn } : {});

  const seen = new Set();
  const pages = [];
  for (const raw of rawUrls) {
    if (!isSiteUrl(raw)) continue;
    if (seen.has(raw)) continue;
    seen.add(raw);
    pages.push(raw);
  }

  if (pages.length < MIN_SANE_SITEMAP_URLS) {
    throw new Error(`sitemap sync aborted — only ${pages.length} URLs fetched, refusing to overwrite the library`);
  }

  // ALL rows, not just sitemap ones: a hand-added row for a page that later
  // lands in the sitemap must be skipped, not re-inserted — the url is
  // globally unique, so a blind insert would fail this and every later
  // sync. The manual row wins (it carries the owner's name/clause).
  const existing = await db('link_library').select('id', 'url', 'name', 'category', 'source');
  const sitemapByUrl = new Map();
  const manualUrls = new Set();
  for (const r of existing) {
    if (r.source === 'sitemap') sitemapByUrl.set(r.url, r);
    else manualUrls.add(r.url);
  }
  const now = new Date();

  let added = 0;
  let updated = 0;
  for (const url of pages) {
    if (manualUrls.has(url)) continue;
    const name = nameForSiteUrl(url);
    if (!name) continue;
    const category = categoryForSiteUrl(url);
    const row = sitemapByUrl.get(url);
    if (!row) {
      await db('link_library').insert({
        name,
        url,
        category,
        source: 'sitemap',
        created_at: now,
        updated_at: now,
      });
      added += 1;
    } else if (row.name !== name || row.category !== category) {
      await db('link_library').where({ id: row.id }).update({ name, category, updated_at: now });
      updated += 1;
    }
  }

  const currentUrls = new Set(pages);
  const staleIds = [...sitemapByUrl.values()].filter((r) => !currentUrls.has(r.url)).map((r) => r.id);
  if (staleIds.length) await db('link_library').whereIn('id', staleIds).del();

  const result = { fetched: pages.length, added, updated, removed: staleIds.length };
  await recordSyncOutcome(now, result);
  logger.info(`[link-library] sitemap sync: ${pages.length} pages, +${added} ~${updated} -${staleIds.length}`);
  return result;
}

// Persist the successful-sync timestamp explicitly (system_config, same
// key/value store as ai_sms_auto_reply): a stable sitemap makes every row's
// updated_at stand still, so "last synced" can't be inferred from content
// changes — and the migration's preseeded rows must not read as a sync that
// never ran. Best-effort: a bookkeeping failure never fails the sync.
const LAST_SYNC_CONFIG_KEY = 'link_library_last_sync';

async function recordSyncOutcome(at, result) {
  try {
    const value = JSON.stringify({ at: at.toISOString(), ...result });
    const existing = await db('system_config').where({ key: LAST_SYNC_CONFIG_KEY }).first();
    if (existing) {
      await db('system_config').where({ key: LAST_SYNC_CONFIG_KEY }).update({ value, updated_at: new Date() });
    } else {
      await db('system_config').insert({ key: LAST_SYNC_CONFIG_KEY, value });
    }
  } catch (err) {
    logger.warn(`[link-library] last-sync bookkeeping failed: ${err.message}`);
  }
}

// ── The searchable list ──────────────────────────────────────────────────

/** The per-office Google write-a-review rows, straight from WAVES_LOCATIONS. */
function officeReviewLinks() {
  return WAVES_LOCATIONS.filter((loc) => loc.googleReviewUrl).map((loc) => ({
    id: null,
    key: `office-review:${loc.id}`,
    name: `Google review — ${loc.name}`,
    url: loc.googleReviewUrl,
    clause: 'Leave us a Google review here',
    category: 'reviews',
    keywords: `google review stars write ${loc.area || ''}`.trim(),
    source: 'office',
  }));
}

/**
 * Every insertable library link: office review rows first, then the stored
 * rows (manual + sitemap). The composer's per-customer minted links are NOT
 * part of this list — they come from the customer-link endpoint.
 */
async function listLinks() {
  const rows = await db('link_library')
    .select('id', 'name', 'url', 'clause', 'category', 'keywords', 'source')
    .orderBy([{ column: 'category' }, { column: 'name' }]);
  const stored = rows.map((r) => ({ ...r, key: `row:${r.id}` }));
  return [...officeReviewLinks(), ...stored];
}

/**
 * The Settings screen's "last synced" — the explicitly recorded timestamp of
 * the last SUCCESSFUL sync (recordSyncOutcome), never inferred from row
 * updated_at. null until a real sync has run.
 */
async function sitemapLastSyncedAt() {
  const row = await db('system_config').where({ key: LAST_SYNC_CONFIG_KEY }).first();
  if (!row?.value) return null;
  try {
    return JSON.parse(row.value)?.at || null;
  } catch {
    return null;
  }
}

// ── Manual CRUD (Settings ▸ Link Library) ────────────────────────────────

function validateManualLink({ name, url, category, clause, keywords }) {
  const cleanName = String(name || '').trim();
  const cleanUrl = String(url || '').trim();
  if (!cleanName || cleanName.length > MAX_NAME_LENGTH) return { error: `name is required (max ${MAX_NAME_LENGTH} chars)` };
  let parsed;
  try {
    parsed = new URL(cleanUrl);
  } catch {
    return { error: 'url must be a valid absolute URL (https://…)' };
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    return { error: 'url must be http(s)' };
  }
  const cleanCategory = String(category || 'website').trim();
  if (!CATEGORIES.includes(cleanCategory)) {
    return { error: `category must be one of ${CATEGORIES.join(', ')}` };
  }
  return {
    value: {
      name: cleanName,
      url: parsed.href,
      category: cleanCategory,
      clause: String(clause || '').trim().slice(0, 200) || null,
      keywords: String(keywords || '').trim().slice(0, 300) || null,
    },
  };
}

async function createManualLink(input) {
  const { value, error } = validateManualLink(input);
  if (error) return { error };
  const dup = await db('link_library').where({ url: value.url }).first('id');
  if (dup) return { error: 'That URL is already in the library' };
  const now = new Date();
  const [row] = await db('link_library')
    .insert({ ...value, source: 'manual', created_at: now, updated_at: now })
    .returning('id');
  return { id: typeof row === 'object' ? row.id : row };
}

async function deleteManualLink(id) {
  const row = await db('link_library').where({ id }).first('id', 'source');
  if (!row) return { error: 'not found', status: 404 };
  if (row.source !== 'manual') {
    return { error: 'only manually added links can be removed — synced rows follow their source', status: 409 };
  }
  await db('link_library').where({ id }).del();
  return { ok: true };
}

module.exports = {
  CATEGORIES,
  nameForSiteUrl,
  categoryForSiteUrl,
  isSiteUrl,
  syncSitemapLinks,
  officeReviewLinks,
  listLinks,
  sitemapLastSyncedAt,
  validateManualLink,
  createManualLink,
  deleteManualLink,
};
