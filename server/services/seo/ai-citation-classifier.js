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
// competitor-gap-miner.js's `competitorDomains` getter is the portal's OTHER
// tracked competitor list — local SWFL independents (turnerpest.com,
// westfallspestcontrol.com, farrowpestservices.com, hughes-exterminators.com,
// kellerspestcontrol.com, nativepestmanagement.com, …), overridable via
// COMPETITOR_GAP_DOMAINS — imported live (the getter, not a snapshot) so an
// operator's override is picked up here too (owner review 2026-09-28: Turner
// is the #1 competitor AI engines name, 48x, and was falling through to
// `other` before this).
const competitorGapMiner = require('./competitor-gap-miner');

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
  // Local directory / "best of" marketplaces cited on provider questions
  // (owner review 2026-09-28) — a marketplace listing still routes through
  // the owner queue + separate-spend rule; discovery grants nothing either way.
  'cityvetted.com', 'exterminatorguild.com', 'homversa.com', 'lawnstarter.com', 'lawnlove.com',
]);

const EDITORIAL_DOMAINS = Object.freeze([
  // SWFL local news
  'heraldtribune.com', 'bradenton.com', 'yourobserver.com', 'patch.com', 'mysuncoast.com',
  'wfla.com', 'fox13news.com', 'winknews.com', 'abcactionnews.com', 'wtsp.com', 'baynews9.com', 'wgcu.org',
  // home-services editorial / listicles
  'todayshomeowner.com', 'bobvila.com', 'thespruce.com',
  'forbes.com', // /home-improvement only — path-filtered in SPECIAL_HOSTS below
  // owner review 2026-09-28: cited local-recommendation editorial sites
  'floridist.com', 'smarfle.com',
]);

const REFERENCE_SUFFIXES = Object.freeze(['.edu', '.gov']);
const REFERENCE_DOMAINS = Object.freeze(['wikipedia.org']);

// Brands the brief named that neither existing competitor list carries yet,
// plus the owner's 2026-09-27 correction: flapest.com (Florida Pest Control,
// Gainesville, since 1949) is a COMPANY, never the trade association above.
const EXTRA_COMPETITOR_DOMAINS = Object.freeze(['flapest.com', 'hometeampestdefense.com']);
// The live union of BOTH tracked competitor lists this portal already
// maintains (competitor-discovery.js's national/regional franchises +
// competitor-gap-miner.js's local SWFL independents, itself overridable via
// COMPETITOR_GAP_DOMAINS) plus the brief's extras — a FUNCTION, not a frozen
// constant, so an env override to either list is picked up on the next call
// rather than baked in at module load.
function competitorDomains() {
  return [...competitorDiscovery.NATIONAL_CHAINS, ...competitorGapMiner.competitorDomains, ...EXTRA_COMPETITOR_DOMAINS];
}

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
// Codex P2 2026-09-28: Facebook CONTENT is human-only, never a listing — the
// list must exclude every content route, not just the ones a first pass
// happened to name. Added: reels (the plural was missing — "reel" alone
// never matched "/reels/…"), /share/…, and /story.php (a segment named
// "story" alone also excludes the plain "/story/…" path and, via the
// existing `\.php` boundary alternative, "/story.php" itself).
const FACEBOOK_NON_PAGE_PATH_RE = /\/(posts|photos?|videos?|watch|reels?|permalink\.php|groups|events|stories|story|share)(\/|$|\?|\.php)/i;
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

// ---------------------------------------------------------------------------
// Provider-intent listicle heuristic (owner review 2026-09-28): a "best
// pest control in <city>" question surfaces local directory/listicle pages
// no static domain list will ever fully enumerate (cityvetted.com,
// floridist.com, smarfle.com and their peers today; a new one next month).
// A host that matches NOTHING above (owned/reference/competitor/listing/
// editorial/community_video all already ran) and carries a local or
// best/top/rated token, cited under a PROVIDER-intent question, is almost
// certainly one of those pages — classified `editorial` with an explicit
// `subtype: 'listicle_candidate'` marker so the owner can tell it came from
// this heuristic rather than the static rules table. It NEVER runs before —
// and so can never override — owned/reference/competitor/community_video,
// and it never promotes a page that already matched listing/editorial by
// domain (those return before this is reached).
// ---------------------------------------------------------------------------
// Codex P2 2026-09-28: a marker must match a COMPLETE token, never a
// substring — plain `.includes('top')` matched inside "desktop-support" and
// `.includes('rated')` matched inside "integrated-services". Host/path/query
// are split on every run of non-alphanumeric characters (the URL's own
// separators: '.', '/', '-', '_', '?', '=', '&', a decoded '%20', …) into
// whole tokens, and every marker is checked against that token list, never
// against the raw joined string.
const BEST_TOKENS = Object.freeze(['best', 'top', 'rated', 'nearme']);
function tokenize(s) {
  return String(s || '').toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
}
function hasBestToken(urlString) {
  let u;
  try { u = new URL(urlString); } catch { return false; }
  const tokens = tokenize(`${u.hostname} ${decodeURIComponentSafe(u.pathname)} ${u.search}`);
  if (tokens.some((t) => BEST_TOKENS.includes(t))) return true;
  // "near-me" / "near me" split into the adjacent token pair ["near", "me"]
  // (bare "nearme" — no separator — is already a single token above).
  for (let i = 0; i < tokens.length - 1; i++) {
    if (tokens[i] === 'near' && tokens[i + 1] === 'me') return true;
  }
  return false;
}
// A benchmark question's own `intent: 'provider'` (aeo-benchmark-v1.json),
// or — for a managed/legacy query the benchmark doesn't cover — the raw
// query text asking who/best/top/company. `question` is the same
// { id, query, city, service, intent } shape link-registry-ai-citation-
// ingest.js's aggregateCitations already builds per row.
const PROVIDER_INTENT_WORDS_RE = /\b(who|best|top|company)\b/i;
function isProviderIntentQuestion(question) {
  if (!question) return false;
  if (question.intent === 'provider') return true;
  return PROVIDER_INTENT_WORDS_RE.test(question.query || '');
}

/**
 * classifyUrl(urlString, { providerIntent }) → { category, host, rule, subtype? } | null (unparseable URL)
 * category ∈ 'owned' | 'listing' | 'editorial' | 'reference' | 'competitor' | 'community_video' | 'other'
 * `providerIntent` (default false) — the CALLER'S determination of
 * isProviderIntentQuestion() for the question this citation came from; only
 * used by the listicle heuristic above, and only once every other rule has
 * already found no match. A host that qualifies gets `subtype:
 * 'listicle_candidate'` alongside `category: 'editorial'`; every other
 * result never carries `subtype`.
 */
function classifyUrl(urlString, { providerIntent = false } = {}) {
  let u;
  try { u = new URL(urlString); } catch { return null; }
  const host = canonicalProspectDomain(u.hostname) || u.hostname.toLowerCase().replace(/^www\./, '');
  // The ONE path to 'other' — every fallthrough in this function funnels
  // through here, so the heuristic is applied (or not) in exactly one place.
  const other = (rule) => {
    if (providerIntent && (isLocallyRelevant(urlString) || hasBestToken(urlString))) {
      return { category: 'editorial', host, rule: `heuristic:listicle_candidate:${rule}`, subtype: 'listicle_candidate' };
    }
    return { category: 'other', host, rule };
  };

  if (isOwnedUrl(urlString)) return { category: 'owned', host, rule: 'owned_fleet_domain' };

  for (const suffix of REFERENCE_SUFFIXES) {
    if (host.endsWith(suffix)) return { category: 'reference', host, rule: `suffix:${suffix}` };
  }
  if (matchesAny(host, REFERENCE_DOMAINS)) return { category: 'reference', host, rule: 'reference_domain' };

  const specialHost = Object.keys(SPECIAL_HOSTS).find((d) => matchesSuffix(host, d));
  if (specialHost) {
    const category = SPECIAL_HOSTS[specialHost](u);
    if (category) return { category, host, rule: `special:${specialHost}` };
    // Facebook CONTENT (reels, posts, shares, stories …) is a human-only
    // community track — never 'other', where the provider-intent listicle
    // heuristic below could promote it to an enqueued 'editorial' candidate.
    if (specialHost === 'facebook.com') return { category: 'community_video', host, rule: 'special:facebook.com:content_route' };
    return other(`special:${specialHost}:excluded_path`);
  }

  if (matchesAny(host, competitorDomains())) return { category: 'competitor', host, rule: 'competitor_domain' };
  if (matchesAny(host, LISTING_DOMAINS)) return { category: 'listing', host, rule: 'listing_domain' };
  if (matchesAny(host, EDITORIAL_DOMAINS)) return { category: 'editorial', host, rule: 'editorial_domain' };
  if (matchesAny(host, COMMUNITY_VIDEO_DOMAINS)) return { category: 'community_video', host, rule: 'community_video_domain' };

  return other('unmatched');
}

// The two categories the feeder ever enqueues to registry intake (§3 of the
// brief) — a single named constant so the feeder and its tests never have to
// spell the set out separately.
const ENQUEUABLE_CATEGORIES = Object.freeze(['listing', 'editorial']);

module.exports = {
  classifyUrl, isLocallyRelevant, isProviderIntentQuestion, ENQUEUABLE_CATEGORIES,
  _internals: {
    LISTING_DOMAINS, EDITORIAL_DOMAINS, REFERENCE_SUFFIXES, REFERENCE_DOMAINS, competitorDomains,
    EXTRA_COMPETITOR_DOMAINS, COMMUNITY_VIDEO_DOMAINS, SWFL_LOCAL_DOMAINS, GEO_TERMS, BEST_TOKENS,
    matchesSuffix, matchesAny, facebookCategory, forbesCategory, hasBestToken, PROVIDER_INTENT_WORDS_RE,
  },
};
