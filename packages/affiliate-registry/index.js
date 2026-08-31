/**
 * @waves/affiliate-registry — vendored affiliate product registry.
 *
 * Source of truth lives in wavespestcontrol-astro
 * (packages/affiliate-registry/registry.json): the Astro renderer resolves
 * <AffiliateLink product="…"> to its approved URL at build time, so the
 * astro copy is authoritative and this one is vendored via
 * `npm run sync:affiliate-registry` (blog-schema pattern). Never hand-edit
 * registry.json here.
 *
 * The registry is the ONLY place an affiliate tracking URL may exist —
 * blog bodies reference product IDs through <AffiliateLink>, never raw
 * URLs, and adding/approving a product row is an astro PR the owner
 * merges (the merge IS the approval record; owner ruling 2026-08-31).
 *
 * Dependency-free on purpose: consumed by content-guardrails (publish
 * gate), newsletter/social channel stripping, and tests.
 *
 * Fail-closed philosophy: an unreadable file, an invalid row, a duplicate
 * id, or a missing approval field classifies the product as unusable —
 * classification never throws and never widens.
 */

'use strict';

const { readFileSync, statSync } = require('node:fs');
const { createHash } = require('node:crypto');
const { join } = require('node:path');

// ── frozen vocabulary (a change here is a policy change: new PR + tests) ──
const AFFILIATE_STATUSES = Object.freeze(['active', 'paused', 'prohibited']);
// green  = ordinary tools/prevention/exclusion/PPE/durable equipment.
// yellow = consumer pesticides (RTU, baits, larvicides, consumer bait
//          stations, biologicals, misusable-but-legal concentrates) —
//          owner-approved 2026-08-31 CONDITIONAL on per-product manual
//          review: current EPA label, EPA reg #, FL registration check,
//          owner approval, re-reviewed at most every 180 days.
// red    = never linked (restricted-use pesticides, fumigants, professional
//          termiticides, loose/professional rodenticides, anything not
//          FL-registered). A red row may exist ONLY as an explicit
//          status:"prohibited" denial record.
const AFFILIATE_RISK_CLASSES = Object.freeze(['green', 'yellow', 'red']);
// post_type values whose pages capture local service intent — no product
// row may ever declare them eligible (affiliate links are fallback
// monetization; these pages sell the service).
const PROTECTED_POST_TYPES = Object.freeze(['location', 'cost', 'decision', 'comparison', 'case-study']);
// Yellow-class label review currency (owner ruling 2026-08-31): the manual
// review Adam attached to approving consumer pesticides goes stale.
const YELLOW_LABEL_REVIEW_MAX_AGE_DAYS = 180;
const YELLOW_REVIEW_FIELDS = Object.freeze([
  'epa_reg_number', 'label_url', 'florida_registration_verified_at', 'label_reviewed_at',
]);

const DEFAULT_REGISTRY_PATH = join(__dirname, 'registry.json');
const EMPTY_REGISTRY = Object.freeze({ version: 1, products: [] });

let cache = null; // { path, mtimeMs, registry }

function registryPath() {
  return process.env.AFFILIATE_REGISTRY_PATH || DEFAULT_REGISTRY_PATH;
}

/**
 * Load (and cache by path + mtime) the vendored registry. Unreadable or
 * malformed JSON loads as the empty registry — every product then
 * classifies as unregistered, which is the dark posture, not an outage.
 */
function loadRegistry() {
  const path = registryPath();
  let mtimeMs = -1;
  try { mtimeMs = statSync(path).mtimeMs; } catch { /* missing file → empty */ }
  if (cache && cache.path === path && cache.mtimeMs === mtimeMs) return cache.registry;
  let registry = EMPTY_REGISTRY;
  if (mtimeMs >= 0) {
    try {
      const parsed = JSON.parse(readFileSync(path, 'utf8'));
      if (parsed && Array.isArray(parsed.products)) registry = parsed;
      else console.warn(`[affiliate-registry] ${path} has no products array — treating as empty (fail closed)`);
    } catch (err) {
      console.warn(`[affiliate-registry] failed to load ${path}: ${err.message} — treating as empty (fail closed)`);
    }
  }
  cache = { path, mtimeMs, registry };
  return registry;
}

// A review/approval date must be a REAL calendar date (round-trip
// validated — "2099-02-31" is ISO-shaped but JS would normalise it to
// March 3 and a yellow review would read as current forever) and must not
// be in the future (a forward-dated approval or review is not a review that
// happened).
//
// Business dates are AMERICA/NEW_YORK calendar days (AGENTS.md ET
// discipline): a date-only value is compared against today's ET calendar
// date, never UTC midnight — otherwise after ~8pm ET "tomorrow" would
// already validate, and 180-day review windows would expire hours early.
// Timestamped values (with an explicit offset) compare as instants.
// Dependency-free by design (this package sits outside server/), so the ET
// calendar date comes from Intl rather than server/utils/datetime-et.js.
const ET_DAY_FORMAT = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit',
});
function etCalendarDate(instant) {
  return ET_DAY_FORMAT.format(instant); // en-CA → YYYY-MM-DD
}
function calendarDayNumber(ymd) {
  const [y, mo, d] = ymd.split('-').map(Number);
  return Date.UTC(y, mo - 1, d) / 86400000;
}

// → { dateOnly: 'YYYY-MM-DD' } | { instant: Date } | null
function parseReviewDate(v) {
  if (typeof v !== 'string') return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2}))?$/.exec(v.trim());
  if (!m) return null;
  const [y, mo, d] = [m[1], m[2], m[3]].map(Number);
  const calendar = new Date(Date.UTC(y, mo - 1, d));
  if (calendar.getUTCFullYear() !== y || calendar.getUTCMonth() !== mo - 1 || calendar.getUTCDate() !== d) return null;
  if (m[4] === undefined) return { dateOnly: `${m[1]}-${m[2]}-${m[3]}` };
  if (Number(m[4]) > 23 || Number(m[5]) > 59 || Number(m[6] || 0) > 59) return null;
  const instant = new Date(v.trim());
  return Number.isNaN(instant.getTime()) ? null : { instant };
}

function isPastOrPresentDate(v, now) {
  const p = parseReviewDate(v);
  if (!p) return false;
  if (p.instant) return p.instant.getTime() <= now.getTime();
  return p.dateOnly <= etCalendarDate(now); // ISO strings order lexically
}

// Age in ET calendar days (date-only) or exact days (timestamps).
function daysOld(v, now) {
  const p = parseReviewDate(v);
  if (p.instant) return (now.getTime() - p.instant.getTime()) / 86400000;
  return calendarDayNumber(etCalendarDate(now)) - calendarDayNumber(p.dateOnly);
}

/** sha256("\0registry.json\0" + bytes) — the vendor-drift recipe shared with the astro repo's checksum.txt. */
function registryChecksum(bytes) {
  const hash = createHash('sha256');
  hash.update('\0registry.json\0');
  hash.update(bytes);
  return hash.digest('hex');
}

function isAmazonHost(hostname) {
  const host = String(hostname || '').toLowerCase();
  return host === 'amzn.to' || /(^|\.)amazon\.[a-z.]+$/.test(host);
}

function parseHttpsUrl(raw) {
  try {
    const u = new URL(String(raw || ''));
    return u.protocol === 'https:' ? u : null;
  } catch { return null; }
}

/**
 * Structural validation of one product row → array of error strings
 * (empty = valid). Enforces the merchant compliance rules that belong to
 * the DATA, not the draft: Amazon links must be direct amazon.com URLs
 * carrying the associate tag (Amazon prohibits redirect/cloak domains and
 * shortlinks like amzn.to that obscure the destination) — a violating row
 * is invalid, so referencing it surfaces as inactive at the publish gate
 * (the AMAZON_LINK_WITHOUT_ASSOCIATE_TAG rule lives here by design: raw
 * Amazon URLs in bodies are already DISALLOWED_EXTERNAL_LINK).
 */
function validateProduct(row, { now = new Date() } = {}) {
  const errors = [];
  if (!row || typeof row !== 'object' || Array.isArray(row)) return ['row is not an object'];
  if (typeof row.product_id !== 'string' || !/^[a-z0-9][a-z0-9-]*$/.test(row.product_id)) {
    errors.push('product_id must be a kebab-case slug');
  }
  if (!AFFILIATE_STATUSES.includes(row.status)) errors.push(`status must be one of ${AFFILIATE_STATUSES.join('|')}`);
  if (!AFFILIATE_RISK_CLASSES.includes(row.risk_class)) errors.push(`risk_class must be one of ${AFFILIATE_RISK_CLASSES.join('|')}`);
  if (typeof row.merchant !== 'string' || !row.merchant.trim()) errors.push('merchant is required');
  if (row.risk_class === 'red' && row.status !== 'prohibited') {
    errors.push('a red-class product may exist only as a status:"prohibited" denial record — red is never linkable');
  }
  // A prohibited/denial row is NEVER linkable — it must carry no URL at all
  // (a plain_url would render as a fallback link upstream); everything
  // below governs rows that could render.
  if (row.status === 'prohibited') {
    if (row.approved_affiliate_url) errors.push('a prohibited row must not carry approved_affiliate_url');
    if (row.plain_url) errors.push('a prohibited row must not carry plain_url');
    return errors;
  }
  const url = parseHttpsUrl(row.approved_affiliate_url);
  if (!url) errors.push('approved_affiliate_url must be an https URL');
  if (row.plain_url !== undefined && row.plain_url !== null) {
    const plain = parseHttpsUrl(row.plain_url);
    if (!plain) errors.push('plain_url, when present, must be an https URL');
    else if (isAmazonHost(plain.hostname) || /\bamazon\b/i.test(String(row.merchant || ''))) {
      // The UNTRACKED fallback: a direct amazon.com page with no associate
      // parameters (a tagged plain_url would monetize a paused product).
      const h = plain.hostname.toLowerCase();
      if (h !== 'amazon.com' && h !== 'www.amazon.com') errors.push('amazon plain_url must be a direct amazon.com URL — never amzn.to, redirects, or cloak domains');
      if (plain.searchParams.has('tag') || plain.searchParams.has('ascsubtag')) errors.push('amazon plain_url must carry no tag=/ascsubtag (it is the untracked fallback)');
    }
  }
  // Amazon policy keys off the URL and a normalized merchant, never the
  // free-form spelling alone ("Amazon US", "Amazon.com"): any amazon.* or
  // amzn.to destination is an Amazon link (parity with the astro schema).
  if (url && (/\bamazon\b/i.test(String(row.merchant || '')) || isAmazonHost(url.hostname))) {
    const host = url.hostname.toLowerCase();
    if (host !== 'amazon.com' && host !== 'www.amazon.com') {
      errors.push('amazon products must link amazon.com directly — never amzn.to, redirects, or cloak domains (Associates policy)');
    } else if (!url.searchParams.get('tag')) {
      errors.push('amazon approved_affiliate_url is missing the tag= associate parameter');
    }
  }
  if (!Array.isArray(row.allowed_post_types) || row.allowed_post_types.length === 0) {
    errors.push('allowed_post_types must be a non-empty array');
  } else {
    for (const pt of row.allowed_post_types) {
      if (PROTECTED_POST_TYPES.includes(pt)) {
        errors.push(`allowed_post_types may never include protected local-service post type "${pt}"`);
      }
    }
  }
  if (row.status === 'active' && !isPastOrPresentDate(row.owner_approved_at, now)) {
    errors.push('an active product requires owner_approved_at (a real, non-future ISO date — the owner-merge approval record)');
  }
  if (row.risk_class === 'yellow') {
    for (const f of YELLOW_REVIEW_FIELDS) {
      const v = row[f];
      const ok = f === 'epa_reg_number' ? (typeof v === 'string' && !!v.trim())
        : f === 'label_url' ? !!parseHttpsUrl(v)
          : isPastOrPresentDate(v, now);
      if (!ok) errors.push(`yellow-class product requires ${f} (per-product manual review, owner ruling 2026-08-31; dates must be real and not in the future)`);
    }
  }
  return errors;
}

/**
 * Registry-level validation: every row's own errors plus duplicate
 * product_ids (a duplicate poisons BOTH rows — fail closed, no
 * first-wins ambiguity). → [{ product_id, errors }]
 */
function validateRegistry(registry = loadRegistry(), { now = new Date() } = {}) {
  // Top-level shape is validated EXPLICITLY — a registry without a products
  // array must be a reported problem (so the sync script refuses to vendor
  // it), never silently coerced to "no products, no errors".
  if (!registry || typeof registry !== 'object' || Array.isArray(registry)) {
    return [{ product_id: null, errors: ['registry must be a JSON object'] }];
  }
  if (!Number.isInteger(registry.version) || registry.version < 1) {
    return [{ product_id: null, errors: ['registry.version must be a positive integer'] }];
  }
  if (!Array.isArray(registry.products)) {
    return [{ product_id: null, errors: ['registry.products must be an array'] }];
  }
  const rows = registry.products;
  const counts = new Map();
  for (const row of rows) {
    const id = row?.product_id;
    if (typeof id === 'string') counts.set(id, (counts.get(id) || 0) + 1);
  }
  const results = [];
  for (const row of rows) {
    const errors = validateProduct(row, { now });
    if (typeof row?.product_id === 'string' && counts.get(row.product_id) > 1) {
      errors.push(`duplicate product_id "${row.product_id}"`);
    }
    if (errors.length) results.push({ product_id: row?.product_id || null, errors });
  }
  return results;
}

/**
 * classifyProduct(row, { now }) → 'active' | 'prohibited' | 'inactive'
 *                                | 'stale_label_review'
 *
 * The publish gate maps these to finding codes:
 *   prohibited         → PROHIBITED_AFFILIATE_PRODUCT
 *   inactive           → INACTIVE_OR_EXPIRED_AFFILIATE_PRODUCT
 *   stale_label_review → PESTICIDE_LINK_WITHOUT_CURRENT_LABEL_REVIEW
 * (absence from the index is the caller's UNREGISTERED case.)
 *
 * Precedence: an explicit denial (red / prohibited) outranks everything;
 * structural invalidity or a paused/unapproved row is inactive; a
 * structurally-valid yellow row with missing or stale review fields is the
 * distinct label-review case so the redraft/review message names the real
 * remediation (re-verify the label, not "activate the row").
 */
function classifyProduct(row, { now = new Date() } = {}) {
  if (!row || typeof row !== 'object') return 'inactive';
  if (row.risk_class === 'red' || row.status === 'prohibited') return 'prohibited';
  const errors = validateProduct(row, { now });
  const yellowFieldErrors = errors.filter((e) => e.startsWith('yellow-class product requires'));
  if (errors.length > yellowFieldErrors.length) return 'inactive';
  if (row.status !== 'active') return 'inactive';
  if (row.risk_class === 'yellow') {
    if (yellowFieldErrors.length) return 'stale_label_review';
    const staleBasis = Math.max(daysOld(row.label_reviewed_at, now), daysOld(row.florida_registration_verified_at, now));
    if (staleBasis > YELLOW_LABEL_REVIEW_MAX_AGE_DAYS) return 'stale_label_review';
  } else if (yellowFieldErrors.length) {
    return 'inactive'; // unreachable today; keeps a future enum change fail-closed
  }
  return 'active';
}

/**
 * Every registry row keyed by product_id, with its classification —
 * Map<product_id, { row, state }>. Duplicate ids classify BOTH copies
 * inactive (unless explicitly prohibited). The GATE (feature-gates
 * affiliateLinks) is applied by CALLERS, not here: channel stripping must
 * see registry URLs even while the publish lane is dark.
 */
function productIndex({ now = new Date(), registry = loadRegistry() } = {}) {
  const rows = Array.isArray(registry?.products) ? registry.products : [];
  const counts = new Map();
  for (const row of rows) {
    const id = row?.product_id;
    if (typeof id === 'string') counts.set(id, (counts.get(id) || 0) + 1);
  }
  const index = new Map();
  for (const row of rows) {
    const id = row?.product_id;
    if (typeof id !== 'string' || !id) continue;
    let state = classifyProduct(row, { now });
    if (counts.get(id) > 1 && state !== 'prohibited') state = 'inactive';
    // Last row wins the map slot, but with duplicates both were forced
    // non-active above, so the winner can never be a usable product.
    index.set(id, { row, state });
  }
  return index;
}

/**
 * Every URL the registry knows (approved tracking URLs AND their plain
 * fallbacks) — the channel-stripping helpers match outbound copy against
 * these regardless of gate state.
 */
function registryUrls({ registry = loadRegistry() } = {}) {
  const urls = [];
  for (const row of (Array.isArray(registry?.products) ? registry.products : [])) {
    for (const field of ['approved_affiliate_url', 'plain_url']) {
      if (typeof row?.[field] === 'string' && row[field].trim()) urls.push(row[field].trim());
    }
  }
  return urls;
}

/** Test-only: drop the mtime cache so AFFILIATE_REGISTRY_PATH swaps take effect. */
function _resetCache() { cache = null; }

module.exports = {
  AFFILIATE_STATUSES,
  AFFILIATE_RISK_CLASSES,
  PROTECTED_POST_TYPES,
  YELLOW_LABEL_REVIEW_MAX_AGE_DAYS,
  YELLOW_REVIEW_FIELDS,
  loadRegistry,
  validateProduct,
  validateRegistry,
  classifyProduct,
  productIndex,
  registryUrls,
  registryChecksum,
  parseReviewDate,
  etCalendarDate,
  _resetCache,
};
