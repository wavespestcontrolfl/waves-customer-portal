/**
 * price-range.js — the deterministic `price_range` frontmatter for cost-guide
 * blog posts.
 *
 * Owner decision D1 (2026-09-27): cost guides show the "Typical Price Range"
 * card. Owner 2026-09-28: cost guides must carry it out of the autonomous
 * pipeline with no manual step. The Astro hub build renders the card from
 * `price_range` service keys against the portal's public pricing feed
 * (GET /api/public/pricing-ranges, pricing-engine/public-ranges.js), and the
 * Astro build FAILS on a key it does not know.
 *
 * PRECISION FIRST. A card that prices the wrong service is worse than no
 * card, and free-text keyword matching never converges on that (drywood vs
 * subterranean termites, a pest "in the lawn", inspection vs treatment…). So:
 *   - a post is a cost guide when its post_type is "cost" (the writer's
 *     binding post-type rubric: "cost" = pricing-focused);
 *   - its primary keyword (the title only when the keyword is empty) is
 *     normalized — cost-question scaffolding, a trailing city / area, "near
 *     me", "florida"/"fl" and a year are stripped — and the remaining service
 *     phrase must EXACTLY equal a canonical phrase below. Anything else, or
 *     any commercial wording, gets NO card;
 *   - the keys come from this table only — the writer model never chooses
 *     them, and a model-emitted price_range never reaches the published
 *     frontmatter (the autonomous normalizer whitelists fields);
 *   - every key is checked against the feed's own current key set, and a key
 *     the feed does not publish — or publishes only behind a purchase gate,
 *     which a frozen key would outlive — is dropped. No valid key → no
 *     price_range: fail closed to "no card", never to a broken hub build.
 * The post body stays free of dollar figures (HARDCODED_PRICE is unchanged);
 * the card's numbers come from the feed at Astro build time.
 */
const { computePublicPricingRanges, PURCHASE_GATED_ROWS } = require('../pricing-engine/public-ranges');
const { COMMERCIAL_RISK_TYPE_TERMS } = require('../pricing-engine/commercial-risk-type');
const { CITY_TO_LOCATION } = require('../../config/locations');
const logger = require('../logger');

const TERMITE_STABLE = ['termite_bait_install', 'termite_bait_monitoring', 'termite_trenching'];
const TERMITE_BAIT = ['termite_bait_install', 'termite_bait_monitoring'];
const RODENT_FAMILY = ['rodent_bait_program', 'rodent_trapping', 'rodent_exclusion'];
const GENERAL_PEST = ['general_pest_quarterly', 'one_time_pest'];
const MOSQUITO = ['mosquito_program', 'one_time_mosquito'];
const LAWN = ['lawn_care_program', 'one_time_lawn'];
const GERMAN_ROACH = ['german_roach_cleanout', 'german_roach_initial'];

// Canonical service phrase → the feed rows that price exactly that service.
// Phrases are in normalized form (lowercase, "&" → "and", punctuation and
// hyphens → spaces). One phrase per row set the feed publishes as a stable
// (never purchase-gated) row; no phrase for gated products (termite bond,
// station rental), drywood termites, or any inspection other than WDO.
const CANONICAL_PRICE_PHRASES = Object.freeze({
  'pest control': GENERAL_PEST,
  'general pest control': GENERAL_PEST,
  'exterminator': GENERAL_PEST,
  'quarterly pest control': ['general_pest_quarterly'],
  'one time pest control': ['one_time_pest'],
  'termite treatment': TERMITE_STABLE,
  'termite control': TERMITE_STABLE,
  'subterranean termite treatment': TERMITE_STABLE,
  'termite bait stations': TERMITE_BAIT,
  'termite bait station': TERMITE_BAIT,
  'termite bait system': TERMITE_BAIT,
  'termite trenching': ['termite_trenching'],
  'liquid termite treatment': ['termite_trenching'],
  'pre slab termite treatment': ['pre_slab_termiticide'],
  'bora care treatment': ['bora_care'],
  'wdo inspection': ['wdo_inspection'],
  'wood destroying organism inspection': ['wdo_inspection'],
  'rodent control': RODENT_FAMILY,
  'rat control': RODENT_FAMILY,
  'mouse control': RODENT_FAMILY,
  'rodent removal': RODENT_FAMILY,
  'rat removal': RODENT_FAMILY,
  'rodent exclusion': ['rodent_exclusion'],
  'rodent trapping': ['rodent_trapping'],
  'rat trapping': ['rodent_trapping'],
  'rodent bait stations': ['rodent_bait_program'],
  'rodent sanitation': ['rodent_sanitation'],
  'rodent inspection': ['rodent_inspection'],
  'mosquito control': MOSQUITO,
  'mosquito treatment': MOSQUITO,
  'one time mosquito treatment': ['one_time_mosquito'],
  'lawn care': LAWN,
  'lawn treatment': LAWN,
  'lawn care program': ['lawn_care_program'],
  'one time lawn treatment': ['one_time_lawn'],
  'lawn pest control': ['lawn_pest_knockdown'],
  'chinch bug treatment': ['lawn_pest_knockdown'],
  'dethatching': ['dethatching'],
  'lawn dethatching': ['dethatching'],
  'lawn plugging': ['lawn_plugging'],
  'top dressing': ['top_dressing'],
  'lawn top dressing': ['top_dressing'],
  'bed bug treatment': ['bed_bug_treatment'],
  'bed bug exterminator': ['bed_bug_treatment'],
  'flea treatment': ['flea_elimination'],
  'flea control': ['flea_elimination'],
  'wasp removal': ['wasp_hornet_removal'],
  'hornet removal': ['wasp_hornet_removal'],
  'wasp nest removal': ['wasp_hornet_removal'],
  'cockroach control': ['cockroach_treatment'],
  'roach control': ['cockroach_treatment'],
  'cockroach treatment': ['cockroach_treatment'],
  'german roach treatment': GERMAN_ROACH,
  'german cockroach treatment': GERMAN_ROACH,
  'palm injection': ['palm_injection'],
  'palm tree injection': ['palm_injection'],
});

// Commercial work is custom-quoted and the feed is residential list price,
// so a keyword (or title) with commercial wording gets no card. Terms = the
// canonical commercial risk-type buckets' property terms
// (pricing-engine/commercial-risk-type.js) plus the generic words.
// Terms go through the SAME normalizer as the keyword/title they are matched
// against, so "multi-family" (→ "multi family") still matches.
function normalizeWords(value) {
  return String(value || '').toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

const escapeRe = (term) => term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const COMMERCIAL = new RegExp(`\\b(?:${[...new Set([
  'commercial', 'business', 'businesses',
  ...Object.values(COMMERCIAL_RISK_TYPE_TERMS).flat(),
].map(normalizeWords).filter(Boolean))].map(escapeRe).join('|')})\\b`);

// Place words a keyword may end with: every served locality (config/locations
// CITY_TO_LOCATION) plus county / region names.
const PLACE = `(?:${[
  ...Object.keys(CITY_TO_LOCATION).map(normalizeWords),
  'manatee county', 'sarasota county', 'charlotte county', 'hillsborough county',
  'southwest florida', 'sw florida', 'swfl', 'gulf coast', 'suncoast',
].sort((a, b) => b.length - a.length).map(escapeRe).join('|')})`;

// Scaffolding stripped from the ends of a normalized keyword, repeatedly,
// until nothing changes. Leading: cost-question openers. Trailing: cost
// words, a place (optionally after in/near/for/around), "near me", the
// state, a year.
const LEADING_SCAFFOLD = [
  /^how much (?:does|do|is|are|will|would|should|can) (?:it )?(?:cost (?:to|for) )?(?:a |an |the )?/,
  /^what (?:does|do|is|are) (?:the )?(?:average |typical )?(?:cost|price|prices) (?:of|for) /,
  /^(?:average|typical) /,
  /^(?:cost|costs|price|prices|pricing) (?:of|for) /,
];
const TRAILING_SCAFFOLD = [
  /(?: in| near| for| around)? (?:near me|nearby)$/,
  new RegExp(`(?: in| near| for| around)? ${PLACE}$`),
  /(?: in| near| for| around)? (?:florida|fl)$/,
  / (?:19|20)\d{2}$/,
  / (?:cost|costs|price|prices|pricing|rates?|fees?)$/,
];

function servicePhrase(value) {
  let text = ` ${normalizeWords(value)}`;
  let prior;
  do {
    prior = text;
    text = ` ${LEADING_SCAFFOLD.reduce((t, re) => t.replace(re, ''), text.trim())}`;
    for (const re of TRAILING_SCAFFOLD) text = text.replace(re, '');
  } while (text !== prior);
  return text.trim();
}

function mappedKeys(frontmatter) {
  const keyword = String(frontmatter.primary_keyword || '').trim();
  const source = keyword || String(frontmatter.title || '');
  if ([frontmatter.primary_keyword, frontmatter.title].some((v) => COMMERCIAL.test(normalizeWords(v)))) return [];
  return CANONICAL_PRICE_PHRASES[servicePhrase(source)] || [];
}

// A row whose feed unit is a per-month / per-year plan total (tree & shrub
// care, the trap-only retainer) cannot go on the card: customer-facing
// prices are per application or per job, never a combined "$X/mo" or
// "$X/yr" plan total (AGENTS.md "Per application" price copy). Read from the
// row's own `unit`, so a row that changes unit is handled without a list.
const PLAN_TOTAL_UNIT = /\bper (?:month|year|mo|yr)\b/;

// The feed's current card-presentable keys, or null when the feed cannot be
// computed or is INCOMPLETE — a row whose sweep errored is missing from
// `services` though it still exists, and pruning a kept list against that
// gap would delete a valid owner key.
function publishedPriceKeys() {
  try {
    const feed = computePublicPricingRanges();
    if ((feed.errors || []).length) {
      logger.warn(`[price-range] public pricing feed incomplete (${feed.errors.map((e) => e.key).join(', ')}) — treated as unavailable`);
      return null;
    }
    return new Set((feed.services || [])
      .filter((row) => !PLAN_TOTAL_UNIT.test(String(row.unit || '').toLowerCase()))
      .map((row) => row.key));
  } catch (err) {
    logger.warn(`[price-range] public pricing feed unavailable: ${err.message}`);
    return null;
  }
}

// The keys that may ship: published by the feed now with a card-presentable
// unit, and not purchase-gated.
function usableKeys(keys, known) {
  const usable = (key) => known.has(key) && !PURCHASE_GATED_ROWS[key];
  const dropped = keys.filter((key) => !usable(key));
  if (dropped.length) {
    logger.warn(`[price-range] dropped price_range keys the public pricing feed does not publish, publishes only behind a purchase gate, or prices as a monthly/yearly plan total: ${dropped.join(', ')}`);
  }
  return keys.filter(usable);
}

// → the price_range list for a cost guide, or null (not a cost guide, no
// mapped service, or no mapped key the feed publishes).
function costGuidePriceRange(frontmatter = {}, { knownKeys } = {}) {
  if (String(frontmatter.post_type || '').trim() !== 'cost') return null;
  const keys = mappedKeys(frontmatter);
  if (!keys.length) return null;
  const known = knownKeys || publishedPriceKeys();
  if (!known) return null; // feed down or incomplete → no card
  const valid = usableKeys(keys, known);
  return valid.length ? valid : null;
}

// The ONE place a publish lane sets the card, called by every lane that
// writes a blog post (scheduled/admin publishAstro, autonomous
// publishOrUpdatePage, refresh, title/meta rewrite) once it has read the
// live post. A price_range the live post already carries (owner-set) is
// kept, minus any key the feed no longer publishes or now gates — a stale
// key would fail the hub build or advertise an unavailable product. Nothing
// is ever substituted: all keys stale → the field is omitted; an explicit []
// stays []. Otherwise a cost guide gets the mapped keys. Mutates and returns
// `frontmatter`. Throws (code BLOG_PRICE_FEED_UNAVAILABLE, retried like any
// transient publish error) when a retained list cannot be checked because
// the feed is down: neither shipping unchecked keys nor deleting the
// owner's list is acceptable.
function applyCostGuidePriceRange(frontmatter, liveFrontmatter = null, { knownKeys } = {}) {
  const live = liveFrontmatter?.price_range;
  if (live != null) {
    if (!Array.isArray(live) || live.length === 0) {
      frontmatter.price_range = live; // [] stays []; a malformed value fails schema validation
      return frontmatter;
    }
    const known = knownKeys || publishedPriceKeys();
    if (!known) {
      const err = new Error('public pricing feed unavailable — cannot verify the post\'s existing price_range keys');
      err.code = 'BLOG_PRICE_FEED_UNAVAILABLE';
      throw err;
    }
    const kept = usableKeys(live, known);
    if (kept.length) frontmatter.price_range = kept;
    else delete frontmatter.price_range;
    return frontmatter;
  }
  delete frontmatter.price_range;
  const mapped = costGuidePriceRange(frontmatter);
  if (mapped) frontmatter.price_range = mapped;
  return frontmatter;
}

module.exports = { costGuidePriceRange, applyCostGuidePriceRange, CANONICAL_PRICE_PHRASES, _internals: { servicePhrase } };
