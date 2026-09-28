/**
 * ai-citation-classifier.js — deterministic, data-driven classification of a
 * cited URL from the AEO answer-engine probe (seo_llm_mentions.cited_urls)
 * into one of seven categories, for the weekly `ai_citation` registry feeder
 * (ai-citation-feeder.js / link-registry-ai-citation-ingest.js).
 *
 * Pure — no I/O, no network, no DB. A rules TABLE (the *_DOMAINS arrays
 * below), not a pile of if/else: widening coverage means adding a domain to
 * a category's array (or a path-conditional SPECIAL_HOSTS handler for a host
 * like facebook.com / forbes.com whose category depends on the page, not
 * just the domain), never touching classifyUrl's control flow.
 *
 * Categories (owner brief 2026-09-27 + the flapest.com/flpma.org correction
 * given the same day): `owned`, `listing`, `editorial`, `reference`,
 * `competitor`, `community_video`, `other`. Only `listing` and `editorial`
 * are ever sent to registry intake — the rest are counted in the feeder's
 * run summary and never enqueued (community/video are human-only tracks).
 *
 * Domain matching is host-suffix (host === domain OR host.endsWith('.' +
 * domain)), the same convention link-registry.js (isNeverTargetHost) and
 * competitor-discovery.js (inHostSet) already use — so 'birdeye.com' also
 * catches 'reviews.birdeye.com' and 'wikipedia.org' catches every language
 * subdomain, with no per-subdomain entry.
 */

const { isOwnedUrl } = require('./aeo-measurement');
const { canonicalProspectDomain } = require('./prospect-domain-lock');
// competitor-discovery.js's NATIONAL_CHAINS is the portal's existing tracked
// national/regional pest-and-lawn franchise list (orkin.com, terminix.com,
// trugreen.com, trulynolen.com, masseyservices.com, …) — reused verbatim
// rather than re-typed, so a change there is picked up here too.
const { _internals: competitorDiscovery } = require('./competitor-discovery');

// ---------------------------------------------------------------------------
// Rules table
// ---------------------------------------------------------------------------

const LISTING_DOMAINS = Object.freeze([
  'bbb.org', 'yelp.com', 'angi.com', 'homeadvisor.com', 'nextdoor.com',
  'birdeye.com', // incl. reviews.birdeye.com — suffix match
  'thumbtack.com', 'yellowpages.com', 'yp.com', 'superpages.com', 'mapquest.com', 'manta.com',
  'facebook.com', // business PAGES only — path-filtered in SPECIAL_HOSTS below, not a plain domain match
  // The real Florida Pest Management Association member directory (owner
  // correction 2026-09-27): flapest.com is Florida Pest Control, a COMPANY
  // — that is `competitor` below, never here.
  'flpma.org',
  'npmapestworld.org', 'pestworld.org', // National Pest Management Association
  'qualitypro.com', // NPMA's QualityPro certification directory
  'chamberofcommerce.com', 'uschamber.com', 'manateechamber.com', 'sarasotachamber.com', 'veniceareachamber.com',
  'floridarealtors.org', // realtor-association sites
  'expertise.com', 'threebestrated.com', 'bestprosintown.com',
]);

const EDITORIAL_DOMAINS = Object.freeze([
  // SWFL local news
  'heraldtribune.com', 'bradenton.com', 'yourobserver.com', 'patch.com', 'mysuncoast.com',
  'wfla.com', 'fox13news.com', 'winknews.com', 'abcactionnews.com', 'wtsp.com', 'baynews9.com', 'wgcu.org',
  // home-services editorial / listicles
  'todayshomeowner.com', 'bobvila.com', 'thespruce.com',
  'forbes.com', // /home-improvement only — path-filtered in SPECIAL_HOSTS below
]);

const REFERENCE_SUFFIXES = Object.freeze(['.edu', '.gov']);
const REFERENCE_DOMAINS = Object.freeze(['wikipedia.org']);

// Brands the brief named that neither existing competitor list carries yet,
// plus the owner's 2026-09-27 correction: flapest.com (Florida Pest Control,
// Gainesville, since 1949) is a COMPANY, never the trade association above.
const EXTRA_COMPETITOR_DOMAINS = Object.freeze(['flapest.com', 'hometeampestdefense.com']);
const COMPETITOR_DOMAINS = Object.freeze([...competitorDiscovery.NATIONAL_CHAINS, ...EXTRA_COMPETITOR_DOMAINS]);

const COMMUNITY_VIDEO_DOMAINS = Object.freeze(['reddit.com', 'youtube.com', 'quora.com']);

function matchesSuffix(host, domain) {
  return host === domain || host.endsWith(`.${domain}`);
}
function matchesAny(host, list) {
  return list.some((d) => matchesSuffix(host, d));
}

// SPECIAL_HOSTS: a host from one of the lists above whose category depends
// on the PAGE, not just the domain. Returning null falls through to `other`
// (a facebook post/photo/video, or a forbes.com article outside
// /home-improvement) — the domain is still a listing/editorial HOST, but
// this particular page is not the kind of page the brief wants enqueued.
const FACEBOOK_NON_PAGE_PATH_RE = /\/(posts|photos?|videos?|watch|reel|permalink\.php|groups|events|stories)(\/|$|\?|\.php)/i;
function facebookCategory(u) {
  return FACEBOOK_NON_PAGE_PATH_RE.test(u.pathname) ? null : 'listing';
}
const FORBES_HOME_IMPROVEMENT_RE = /^\/(?:[a-z]{2}\/)?home-improvement(\/|$)/i;
function forbesCategory(u) {
  return FORBES_HOME_IMPROVEMENT_RE.test(u.pathname) ? 'editorial' : null;
}
const SPECIAL_HOSTS = Object.freeze({ 'facebook.com': facebookCategory, 'forbes.com': forbesCategory });

// ---------------------------------------------------------------------------
// Local relevance — city/county/SWFL/Florida in host or path, or a known
// local domain (the SWFL local-news hosts above are inherently local
// regardless of path).
// ---------------------------------------------------------------------------
const SWFL_LOCAL_DOMAINS = Object.freeze([
  'heraldtribune.com', 'bradenton.com', 'yourobserver.com', 'mysuncoast.com', 'winknews.com', 'wgcu.org',
  'manateechamber.com', 'sarasotachamber.com', 'veniceareachamber.com',
]);
const GEO_TERMS = Object.freeze([
  'bradenton', 'sarasota', 'venice', 'parrish', 'lakewood ranch', 'palmetto', 'ellenton',
  'englewood', 'punta gorda', 'nokomis', 'osprey', 'north port', 'port charlotte', 'siesta key',
  'longboat key', 'anna maria', 'holmes beach', 'rotonda', 'myakka',
  'manatee county', 'sarasota county', 'charlotte county', 'southwest florida', 'swfl', 'florida',
]);

/** isLocallyRelevant(urlString) → boolean. Pure; an unparseable URL is not relevant. */
function isLocallyRelevant(urlString) {
  let u;
  try { u = new URL(urlString); } catch { return false; }
  const host = canonicalProspectDomain(u.hostname) || u.hostname.toLowerCase();
  if (matchesAny(host, SWFL_LOCAL_DOMAINS)) return true;
  const hay = `${host} ${decodeURIComponentSafe(u.pathname)} ${u.search}`.toLowerCase();
  return GEO_TERMS.some((t) => hay.includes(t));
}
function decodeURIComponentSafe(v) {
  try { return decodeURIComponent(v); } catch { return v; }
}

/**
 * classifyUrl(urlString) → { category, host, rule } | null (unparseable URL)
 * category ∈ 'owned' | 'listing' | 'editorial' | 'reference' | 'competitor' | 'community_video' | 'other'
 */
function classifyUrl(urlString) {
  let u;
  try { u = new URL(urlString); } catch { return null; }
  const host = canonicalProspectDomain(u.hostname) || u.hostname.toLowerCase().replace(/^www\./, '');
  if (isOwnedUrl(urlString)) return { category: 'owned', host, rule: 'owned_fleet_domain' };

  for (const suffix of REFERENCE_SUFFIXES) {
    if (host.endsWith(suffix)) return { category: 'reference', host, rule: `suffix:${suffix}` };
  }
  if (matchesAny(host, REFERENCE_DOMAINS)) return { category: 'reference', host, rule: 'reference_domain' };

  const specialHost = Object.keys(SPECIAL_HOSTS).find((d) => matchesSuffix(host, d));
  if (specialHost) {
    const category = SPECIAL_HOSTS[specialHost](u);
    if (category) return { category, host, rule: `special:${specialHost}` };
    return { category: 'other', host, rule: `special:${specialHost}:excluded_path` };
  }

  if (matchesAny(host, COMPETITOR_DOMAINS)) return { category: 'competitor', host, rule: 'competitor_domain' };
  if (matchesAny(host, LISTING_DOMAINS)) return { category: 'listing', host, rule: 'listing_domain' };
  if (matchesAny(host, EDITORIAL_DOMAINS)) return { category: 'editorial', host, rule: 'editorial_domain' };
  if (matchesAny(host, COMMUNITY_VIDEO_DOMAINS)) return { category: 'community_video', host, rule: 'community_video_domain' };

  return { category: 'other', host, rule: 'unmatched' };
}

// The two categories the feeder ever enqueues to registry intake (§3 of the
// brief) — a single named constant so the feeder and its tests never have to
// spell the set out separately.
const ENQUEUABLE_CATEGORIES = Object.freeze(['listing', 'editorial']);

module.exports = {
  classifyUrl, isLocallyRelevant, ENQUEUABLE_CATEGORIES,
  _internals: {
    LISTING_DOMAINS, EDITORIAL_DOMAINS, REFERENCE_SUFFIXES, REFERENCE_DOMAINS, COMPETITOR_DOMAINS,
    EXTRA_COMPETITOR_DOMAINS, COMMUNITY_VIDEO_DOMAINS, SWFL_LOCAL_DOMAINS, GEO_TERMS,
    matchesSuffix, matchesAny, facebookCategory, forbesCategory,
  },
};
