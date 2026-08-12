/**
 * gsc-opportunity-miner.js — emits ranked content opportunities from
 * Google Search Console signals.
 *
 * Eight buckets, each surfaces a different actionable pattern. One run
 * mines all buckets, scores each candidate against scoring-config
 * thresholds, then persists the survivors to opportunity_queue. The
 * autonomous runner pulls top-scoring rows daily.
 *
 * Buckets:
 *   striking_distance   query at pos 4–15 with ≥minImpressions
 *   ctr_rewrite         pos 1–8, high impressions, ctr < 2%. NOTE: its
 *                       rewrite_title_meta rows persist at the env-tunable
 *                       AUTONOMOUS_REWRITE_MIN_SCORE floor (default = the
 *                       global 75, which the bucket's scores structurally
 *                       cannot reach — the lane is dark until the operator
 *                       sets the env; see scoring-config.minScoreToActFor).
 *   decay_refresh       page clicks down ≥25% vs prior period
 *   local_gap           {city, service} has impressions but no own page
 *   seasonal_rising     query impressions up 50%+ vs prior 14d window
 *   no_content_yet      query has impressions but NO owned page usefully
 *                       ranking for it — served-ness judged on TRUE
 *                       query→page rows (gsc_query_page_map). Emits ONLY
 *                       on mapped-and-weak evidence: a materially-mapped
 *                       page at ≤ answerGapPositionMax is refresh/answer-
 *                       gap territory and excludes the query, while a
 *                       materially-mapped page ranking beyond it is the
 *                       gap this bucket mints content for. An UNMAPPED
 *                       query (or one mapped only immaterially) is
 *                       skipped, not emitted — absence of a mapping is
 *                       missing evidence, not proof no page ranks.
 *
 * RETIRED buckets (removed 2026-08-12 — never emitted a row; each
 * duplicated a live first-class mechanism, and the "find the existing
 * mechanism" rule wins over resurrecting the copy):
 *   cannibalization     → seo/cannibalization.js (CannibalizationDetector,
 *                       true query→page evidence into
 *                       seo_cannibalization_flags + seo-action-generator's
 *                       differentiate_spoke approval flow). The miner copy
 *                       was also structurally unpersistable: do_not_publish
 *                       floor 75 vs a max score of ~18 after the −35
 *                       cannibalizationRisk penalty.
 *   page_type_mismatch  → seo/url-intelligence.js intent routing
 *                       (seo_intent_routes: expected_page_type vs
 *                       actual_winner_page_type with misroute severity).
 *                       Miner copy: floor 75 vs max ~16 after −40
 *                       serpMismatch, plus a NULL-vs-'' predicate that
 *                       matched nothing.
 *   aeo_gap             city×service absent from LLM answers across N+ days
 *                       AND has GSC demand (gated behind GATE_AEO_GAP_MINING)
 *   answer_gap          queries a page ranks 9–30 for (true query→page rows
 *                       from gsc_query_page_map) that the page body never
 *                       directly answers — no heading covers the query's
 *                       content terms. Emits refresh_existing_page whose
 *                       draft adds self-contained answer blocks (gated
 *                       behind GATE_ANSWER_GAP_MINING).
 *   link_boost          derived (not mined): every ctr_rewrite/decay_refresh
 *                       page also gets an add_internal_links companion so
 *                       underperformers receive inbound links, not just a
 *                       title/meta rewrite. LINK_BOOST_MAX_PER_RUN=0 disables.
 *
 * Defensive about Step-0 data quality findings:
 *   - city_target == 'local_intent' is normalized to null (overload from
 *     GSC sync classifier)
 *   - CTR is recomputed from clicks/impressions, not trusted from row
 *   - page_type fallback uses URL pattern when gsc_pages.page_type is null
 *
 * Read-only against gsc_*; writes only to opportunity_queue.
 */

const crypto = require('crypto');
const db = require('../../models/db');
const logger = require('../logger');
const { etDateString, addETDays } = require('../../utils/datetime-et');
const { isEnabled } = require('../../config/feature-gates');
const { WEIGHTS, THRESHOLDS, REVENUE_PRIORITY, CITIES, minScoreToActFor, isTransactionalQuery } =
  require('../content/scoring-config');
// The SAME list-shape grammar the brief-builder's listicle overlay uses —
// guarantees a listicle_family opportunity actually receives the overlay.
const { isListicleQuery } = require('../content/listicle-query');

// ── normalization helpers (pure, test-friendly) ─────────────────────

const CITY_NORM_MAP = (() => {
  const m = new Map();
  for (const c of CITIES) {
    m.set(c.toLowerCase(), c);
    m.set(c.toLowerCase().replace(/\s+/g, '_'), c);
    m.set(c.toLowerCase().replace(/\s+/g, '-'), c);
  }
  return m;
})();

function normalizeCity(raw) {
  if (!raw) return null;
  const key = String(raw).trim().toLowerCase();
  if (!key || key === 'local_intent' || key === 'unknown' || key === 'none') return null;
  return CITY_NORM_MAP.get(key) || null;
}

const SERVICE_KEYWORDS = [
  { service: 'termite', re: /\btermite|wdo|wood\s*destroying\b/i },
  { service: 'rodent', re: /\b(rodent|rats?|mice|mouse|exterminator for rodents)\b/i },
  { service: 'mosquito', re: /\b(mosquito|mosquitoes)\b/i },
  { service: 'lawn', re: /\b(lawn|grass|fertiliz|weed control|aeration)\b/i },
  // "plants" only in horticultural context — a bare noun match would let
  // "types of house plants" / "power plants" resolve to a Waves service.
  { service: 'tree-shrub', re: /\b(tree|shrub|palm|ornamental)\b|\b(?:drought|heat|salt|cold|shade|sun)[\s-]*(?:tolerant|resistant)\b[^,.;]{0,30}\bplants?\b|\bplants?\s+that\s+(?:repel|grow|thrive|attract|survive)\b/i },
  // Plurals matter with word boundaries: \bant\b matches neither 'ants'
  // nor (correctly) 'important' — the optional s keeps the boundary and
  // the coverage.
  { service: 'pest', re: /\b(pests?|exterminators?|bugs?|roach(?:es)?|ants?|spiders?|cockroach(?:es)?)\b/i },
];

function inferServiceFromQuery(query) {
  if (!query) return null;
  for (const { service, re } of SERVICE_KEYWORDS) {
    if (re.test(query)) return service;
  }
  return null;
}

// Family admission must not trust the stored GSC classifier blindly: its
// patterns are unbounded substring tests ('ant' inside "important"), so
// "types of important documents florida" arrives classified 'pest'. A
// classifier value counts only when the query contains boundary-aware
// evidence for the RAW category — derived from the sync's OWN
// SERVICE_PATTERNS so the validator accepts exactly what the classifier
// can legitimately tag ('insect'→pest, 'turf'/'weed'→lawn,
// 'bee'→specialty); a second hand-maintained term list drifts (Codex r17).
// Transform: each alternative gains a LEADING word boundary (kills the
// 'important'→ant overreach — no boundary mid-word) and keeps the
// original prefix semantics via a [a-z]* tail ('termit'→termite,
// 'bee'→bees). Safe because SERVICE_PATTERNS alternations are flat
// (no groups); revisit if that ever changes. Fail closed: patterns
// unavailable → classifier values rejected, resolution falls to the
// contextual inference.
let CLASSIFIER_VALIDATION_RES = null;
function classifierValidationRes() {
  if (CLASSIFIER_VALIDATION_RES) return CLASSIFIER_VALIDATION_RES;
  CLASSIFIER_VALIDATION_RES = new Map();
  try {
    const { SERVICE_PATTERNS } = require('./search-console-v2')._internals;
    for (const [cat, re] of Object.entries(SERVICE_PATTERNS)) {
      // PER-TOKEN inflections — one generic suffix set validated 'rates'
      // (rat+es) and 'tickers' (tick+ers). Default is bare + plural 's';
      // tokens ending in ch/sh/s/x/z pluralize with 'es' (roaches,
      // grasses); the sync's stems and irregulars carry explicit forms.
      // 'ing'/'ed'/'er' stay excluded by default (rating/rated/rater must
      // not read as rodent evidence).
      const overrides = new Map([
        ['fertiliz', '(?:e|es|er|ers|ation|ations)'],
        ['termit', '(?:e|es)'],
        ['mosquito', '(?:s|es)?'],
      ]);
      const tail = (alt) => {
        if (overrides.has(alt)) return overrides.get(alt);
        if (/(?:ch|sh|s|x|z)$/.test(alt)) return '(?:es)?';
        return 's?';
      };
      const alts = re.source
        .split('|')
        .map((alt) => `\\b(?:${alt})${tail(alt)}\\b`)
        .join('|');
      CLASSIFIER_VALIDATION_RES.set(cat, new RegExp(alts, 'i'));
    }
  } catch (err) {
    logger.warn(`[gsc-opp-miner] classifier vocabulary unavailable (${err.message}) — classifier values rejected, inference only`);
  }
  return CLASSIFIER_VALIDATION_RES;
}
// The specific FAQ-blocked topic hiding behind coarse service resolution:
// 'wasp' (specialty→pest), 'aeration'/'lawn-pest' (→lawn) etc. are
// individually blocked in content-guardrails while the broad service is
// not, so the topic must ride the opportunity's metadata into the FAQ
// policy inputs instead of vanishing at canonicalization (Codex r24/r33).
// Patterns derive from the guardrail's OWN FAQ_BLOCKED_SERVICES vocabulary
// — a hand-kept partial list drifts. Each id becomes a boundary-safe,
// plural-tolerant phrase regex ('bed-bug' → bed bugs, 'cockroach' →
// cockroaches); longer ids match first so 'termite-control' beats
// 'termite'. Fail closed to no-topic on unavailability.
let FAQ_TOPIC_PATTERNS = null;
function faqTopicPatterns() {
  if (FAQ_TOPIC_PATTERNS) return FAQ_TOPIC_PATTERNS;
  FAQ_TOPIC_PATTERNS = [];
  try {
    const { FAQ_BLOCKED_SERVICES } = require('../content/content-guardrails');
    const ids = Array.from(FAQ_BLOCKED_SERVICES).sort((a, b) => b.length - a.length);
    for (const id of ids) {
      const toks = String(id).split('-').filter(Boolean);
      // Tokens join on whitespace OR hyphens — GSC queries carry both
      // 'bed bug' and 'bed-bug' phrasings, and a hyphenated miss would
      // canonicalize to the broad service with no specialty_topic, letting
      // a blocked FAQ through.
      const body = toks.map((t) => `${t}(?:s|es)?`).join('[\\s-]*');
      FAQ_TOPIC_PATTERNS.push([id, new RegExp(`\\b${body}\\b`, 'i')]);
    }
  } catch (err) {
    logger.warn(`[gsc-opp-miner] FAQ topic vocabulary unavailable (${err.message}) — specialty topics disabled`);
  }
  return FAQ_TOPIC_PATTERNS;
}
function extractSpecialtyTopic(queries = []) {
  for (const q of queries) {
    for (const [topic, re] of faqTopicPatterns()) {
      if (re.test(String(q || ''))) return topic;
    }
  }
  return null;
}

function classifierQuerySupported(rawCategory, canonicalService, query) {
  if (!canonicalService) return false;
  const raw = String(rawCategory || '').toLowerCase().trim();
  const re = classifierValidationRes().get(raw);
  return !!(re && re.test(String(query || '')));
}

// The GSC sync's classifier (search-console-v2 SERVICE_PATTERNS) stores
// snake_case categories — notably 'tree_shrub' — while everything downstream
// (facts-sufficiency's SERVICE_CATEGORY_TO_FACTS_ID, category slugs) keys on
// the hyphenated coarse ids. An un-canonicalized 'tree_shrub' opportunity
// reaches the runner as facts_unmappable and parks instead of drafting.
const SERVICE_CATEGORY_CANON = new Set(['pest', 'termite', 'rodent', 'mosquito', 'lawn', 'tree-shrub']);
function canonicalizeServiceCategory(raw) {
  if (!raw) return null;
  const s = String(raw).toLowerCase().trim().replace(/_/g, '-');
  // The sync's 'specialty' bucket (bed bug / flea / tick / wasp / hornet /
  // fire ant) has no facts-bank identity of its own — those are general-pest
  // topics for Waves (the pest-ID posts publish under pest-control), and
  // facts-sufficiency maps 'pest' → 'pest-control'. Persisting 'specialty'
  // verbatim parked every such family as facts_unmappable.
  if (s === 'specialty') return 'pest';
  return SERVICE_CATEGORY_CANON.has(s) ? s : null;
}

function inferServiceFromUrl(url) {
  if (!url) return null;
  const u = String(url).toLowerCase();
  if (/\btermite|wdo\b/.test(u)) return 'termite';
  if (/\brodent|rats?|mice\b/.test(u)) return 'rodent';
  if (/\bmosquito\b/.test(u)) return 'mosquito';
  if (/\blawn|fertiliz|aeration\b/.test(u)) return 'lawn';
  if (/\btree|shrub\b/.test(u)) return 'tree-shrub';
  if (/\bpest|exterminator\b/.test(u)) return 'pest';
  return null;
}

function inferCityFromUrl(url) {
  if (!url) return null;
  const u = String(url).toLowerCase();
  for (const c of CITIES) {
    const slug = c.toLowerCase().replace(/\s+/g, '-');
    if (u.includes(`-${slug}-fl`) || u.includes(`/${slug}-fl/`) || u.includes(`/${slug}/`)) return c;
  }
  return null;
}

// Collapse tracking/variant query strings (and fragments) so a page and its
// GBP/UTM tracking-link variant key as the SAME canonical URL. GSC reports the
// GBP "Website" link (e.g. /pest-control-sarasota-fl/?utm_source=gbp&utm_medium=
// organic) as a DISTINCT page from the clean path — which splits a page's
// metrics across "two" URLs and spawns phantom decay/refresh/ctr opportunities
// on the tracking link. Astro spoke pages are path-based and carry no
// meaningful query state, so dropping the query (and any fragment) is safe.
// NOTE: the SQL groupings below mirror this via CANON_URL_SQL (split_part on
// the '?' character); keep the two in sync.
function canonicalizePageUrl(url) {
  if (!url) return url;
  return String(url).split('#')[0].split('?')[0];
}

// SQL mirror of canonicalizePageUrl for GROUP BY / SELECT on gsc_pages so
// tracking-link variants aggregate into their canonical page at the DB.
// NOTE: chr(63) is the '?' character — written this way ON PURPOSE. A literal
// '?' in a knex raw fragment collides with knex's positional bind-placeholder
// syntax and gets replaced by a query binding, silently breaking the split.
const CANON_URL_SQL = 'split_part(page_url, chr(63), 1)';

function inferCityFromQuery(query) {
  if (!query) return null;
  const q = String(query).toLowerCase();
  for (const c of CITIES) {
    const slug = c.toLowerCase();
    if (q.includes(slug)) return c;
  }
  return null;
}

function inferPageType(url, declared) {
  if (declared && declared !== '') return declared;
  if (!url) return null;
  const u = String(url).toLowerCase();
  if (/\/blog\//.test(u)) return 'blog';
  if (/\/pest-control-[a-z-]+-fl\/?(\?|$)/.test(u)) return 'city';
  if (/-[a-z-]+-fl\/?(\?|$)/.test(u)) return 'city';
  if (/\/(services?|lawn-care|mosquito|termite|rodent)\//.test(u)) return 'service';
  if (/\/(careers|about|contact|reviews|sitemap)/.test(u)) return 'static';
  return null;
}

function recomputeCtr(clicks, impressions) {
  const c = parseInt(clicks || 0, 10);
  const i = parseInt(impressions || 0, 10);
  return i > 0 ? c / i : 0;
}

// ── scoring (pure, test-friendly) ────────────────────────────────────

function gscOpportunityScore(bucket, position, impressionsBoost) {
  const W = WEIGHTS.gscOpportunity;
  if (bucket === 'striking_distance') {
    const distance = Math.max(0, position - 3);
    return Math.round(W * (1 - distance / 15) * impressionsBoost);
  }
  if (bucket === 'ctr_rewrite') return Math.round(W * 0.85 * impressionsBoost);
  if (bucket === 'decay_refresh') return Math.round(W * 0.75 * impressionsBoost);
  if (bucket === 'local_gap') return Math.round(W * 0.8 * impressionsBoost);
  if (bucket === 'seasonal_rising') return Math.round(W * 0.7 * impressionsBoost);
  if (bucket === 'no_content_yet') return Math.round(W * 0.65 * impressionsBoost);
  if (bucket === 'aeo_gap') return Math.round(W * 0.8 * impressionsBoost);
  if (bucket === 'answer_gap') return Math.round(W * 0.8 * impressionsBoost);
  if (bucket === 'listicle_family') return Math.round(W * 0.7 * impressionsBoost);
  return 0;
}

function localRevenueScore(service) {
  const priority = REVENUE_PRIORITY[(service || '').toLowerCase()] ?? 0.5;
  return Math.round(WEIGHTS.localRevenue * priority);
}

function conversionIntentScore(query) {
  if (!query) return Math.round(WEIGHTS.conversionIntent * 0.4);
  const q = query.toLowerCase();
  const emergency = /\b(emergency|same.?day|today|right now|asap|24.?hour)\b/.test(q);
  const transactional = /\b(near me|cost|price|quote|estimate|hire|company|service|free inspection)\b/.test(q);
  const informational = /\b(how|what|why|when|signs?|identify|prevent|safe for|diy)\b/.test(q);
  if (emergency) return WEIGHTS.conversionIntent;
  if (transactional) return Math.round(WEIGHTS.conversionIntent * 0.85);
  if (informational) return Math.round(WEIGHTS.conversionIntent * 0.3);
  return Math.round(WEIGHTS.conversionIntent * 0.6);
}

function impressionsBoost(impressions) {
  const i = parseInt(impressions || 0, 10);
  if (i >= 500) return 1.0;
  if (i >= 200) return 0.85;
  if (i >= 100) return 0.7;
  if (i >= THRESHOLDS.minImpressionsToScore) return 0.55;
  return 0;
}

/**
 * Near-me / transactional queries are service-page intent, never blog
 * material (operator directive 2026-06-11): someone typing "exterminator
 * near me" wants a provider, not an article. The quality gate flags
 * near-me titles as spam and the brief-builder reroutes these to the
 * (shadow-gated) city-service lane anyway — so emitting a blog action here
 * only burns agent time before dead-ending. Demoting to do_not_publish
 * keeps the demand visible in mineAll's calibration output while the
 * non-blog floor (75) keeps low-scoring transactional rows out of the
 * queue entirely. Near-me on PAGE actions (refresh/rewrite/city-service)
 * is untouched — proximity terms are intentional on pages.
 */
function actionForOpportunity(opp) {
  const action = baseActionForOpportunity(opp);
  if (action === 'new_supporting_blog' && isTransactionalQuery(opp.query)) {
    // City+service transactional demand is legitimate PAGE demand — route it
    // to the city-service lane instead of dropping it (mirrors the other
    // buckets' city/service branches). Only anchorless near-me queries are
    // demoted outright.
    return (opp.city && opp.service) ? 'create_or_refresh_city_service_page' : 'do_not_publish';
  }
  return action;
}

function baseActionForOpportunity({ bucket, query, page_url, city, service }) {
  if (bucket === 'ctr_rewrite' && page_url) return 'rewrite_title_meta';
  if (bucket === 'decay_refresh' && page_url) return 'refresh_existing_page';
  if (bucket === 'link_boost' && page_url) return 'add_internal_links';
  if (bucket === 'local_gap') return 'create_or_refresh_city_service_page';
  if (bucket === 'no_content_yet') {
    if (city && service) return 'create_or_refresh_city_service_page';
    return 'new_supporting_blog';
  }
  if (bucket === 'striking_distance') {
    if (page_url) return 'refresh_existing_page';
    if (city && service) return 'create_or_refresh_city_service_page';
    return 'new_supporting_blog';
  }
  if (bucket === 'seasonal_rising') {
    return page_url ? 'refresh_existing_page' : 'new_supporting_blog';
  }
  if (bucket === 'aeo_gap') {
    if (page_url) return 'refresh_existing_page';
    if (city && service) return 'create_or_refresh_city_service_page';
    return 'new_supporting_blog';
  }
  // answer_gap is page-anchored by construction (mined from query→page rows);
  // without a target page there is nothing to add answer blocks to.
  if (bucket === 'answer_gap') {
    return page_url ? 'refresh_existing_page' : 'do_not_publish';
  }
  // listicle_family demand is enumerable-informational by construction
  // (isListicleQuery excludes vendor/roundup intent). An unserved family
  // mints a new blog post; a SERVED family (owned page already in striking
  // distance for a variant) rides as a page-anchored refresh of that page —
  // same page_url convention as answer_gap, same router anchoring (action
  // preserved, page_type 'refresh' with the improvement_over_prior guard).
  // The actionForOpportunity wrapper still demotes a transactional
  // representative query like any other bucket.
  if (bucket === 'listicle_family') return page_url ? 'refresh_existing_page' : 'new_supporting_blog';
  return 'do_not_publish';
}

// ── listicle-family clustering (pure, test-friendly) ─────────────────
//
// List-shaped demand arrives FRAGMENTED: "drought tolerant plants florida",
// "florida drought tolerant plants", "drought tolerant plants for florida"…
// each variant sits below minImpressionsToScore (impressionsBoost 0 → score
// 0), so per-query buckets can never surface the topic even when the family
// as a whole has hundreds of impressions. Cluster variants by
// order-insensitive token identity (glue words dropped), sum impressions
// across the family, and let the SUM clear the floor. The representative
// query (highest-impression variant) stays a REAL GSC query — the brief's
// target_keyword is never an invented string.
const LISTICLE_FAMILY_GLUE_WORDS = new Set([
  'for', 'in', 'the', 'a', 'an', 'of', 'to', 'and', 'with', 'on', 'at',
  'my', 'your',
]);

function listicleFamilyKey(query) {
  const tokens = String(query || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((w) => w && !LISTICLE_FAMILY_GLUE_WORDS.has(w));
  if (!tokens.length) return null;
  return Array.from(new Set(tokens)).sort().join('+');
}

function clusterListicleFamilies(rows) {
  const families = new Map();
  for (const r of rows || []) {
    if (!isListicleQuery(r.query)) continue;
    const key = listicleFamilyKey(r.query);
    if (!key) continue;
    const imp = parseInt(r.impressions, 10) || 0;
    const pos = Number(r.avg_position) || 0;
    let fam = families.get(key);
    if (!fam) {
      fam = { key, variants: [], byQuery: new Map(), impressions: 0, posWeightedSum: 0 };
      families.set(key, fam);
    }
    // One variant per DISTINCT query string. The source rows group by
    // (query, service, city), so a query whose classification changed
    // mid-window arrives as multiple rows — counting those as separate
    // variants would let ONE real query satisfy the ≥2-variant rule.
    const tuple = {
      impressions: imp,
      plainPosition: Number(r.plain_avg_position) || 0,
      service_category: r.service_category || null,
      city_target: r.city_target || null,
    };
    const existing = fam.byQuery.get(r.query);
    if (existing) {
      const merged = existing.impressions + imp;
      existing.position = merged
        ? (existing.position * existing.impressions + pos * imp) / merged
        : 0;
      // Highest-INDIVIDUAL-impression classification wins the merged
      // variant — compared against the winner's own row impressions, not
      // the cumulative sum (30+25 then 40 must let the 40-row win).
      if (imp > existing.classificationImp) {
        existing.service_category = r.service_category || null;
        existing.city_target = r.city_target || null;
        existing.classificationImp = imp;
      }
      existing.impressions = merged;
      // Every constituent (service, city) tuple kept — the query miners
      // admit PER TUPLE, so reachability must see them individually.
      existing.tuples.push(tuple);
    } else {
      const variant = {
        query: r.query,
        impressions: imp,
        // Per-variant position kept so admission can judge the REPRESENTATIVE
        // on its own ranking — the family-wide weighted average can be dragged
        // past the top-3 cutoff by one low-volume deep variant.
        position: pos,
        service_category: r.service_category || null,
        city_target: r.city_target || null,
        // Row impressions backing the current classification (merge tiebreak).
        classificationImp: imp,
        tuples: [tuple],
      };
      fam.variants.push(variant);
      fam.byQuery.set(r.query, variant);
    }
    fam.impressions += imp;
    fam.posWeightedSum += pos * imp;
  }
  return Array.from(families.values()).map((f) => {
    f.variants.sort((a, b) => b.impressions - a.impressions);
    return {
      key: f.key,
      variants: f.variants,
      impressions: f.impressions,
      position: f.impressions ? f.posWeightedSum / f.impressions : 0,
    };
  });
}

// Family admission (pure). A family mines only when:
//  - ≥2 variants — fragmentation is the bucket's reason to exist;
//  - the REPRESENTATIVE alone is under minImpressionsToScore — a rep that
//    clears the floor by itself is already reachable through the query-level
//    buckets (no_content_yet / striking_distance / seasonal_rising), and
//    emitting it here too would queue two independently-claimable rows for
//    one intent (their dedupe keys differ by construction);
//  - the family SUM clears the floor — the whole point;
//  - weighted position is outside the top-3 — that intent is already won by
//    an own page (same "-3" anchor as striking_distance).
function listicleFamilyEligible(fam, thresholds = THRESHOLDS, { repQualifiesQueryBucket = false } = {}) {
  if (!fam || fam.variants.length < 2) return false;
  // A representative some query-level bucket will ACTUALLY emit excludes
  // the family — two independently claimable rows for one intent
  // otherwise. Reachability is proven by the caller via
  // listicleFamilyRepReachable (window + per-tuple floor + persistence
  // floor + the miners' CROSS-DOMAIN aggregation — the old hub-only
  // rep-impressions precondition undercounted a 30-hub/30-spoke rep the
  // miners see as 60); the default assumes none, which only ever errs
  // toward keeping the demand.
  if (repQualifiesQueryBucket) return false;
  if (fam.impressions < thresholds.minImpressionsToScore) return false;
  if (fam.position > 0 && fam.position < 4) return false;
  // The emitted target_keyword IS the representative — if IT already ranks
  // top-3, a new post competes with a won query even when deep low-volume
  // variants drag the family average past the cutoff.
  const repPos = fam.variants[0]?.position || 0;
  if (repPos > 0 && repPos < 4) return false;
  return true;
}

// Service/city resolution across the WHOLE family, impression order. The
// representative alone is not enough: variants share one token set, but
// service inference is order-sensitive (the horticultural-context regex
// needs the qualifier NEAR 'plants'), so 'plants florida drought tolerant'
// resolves nothing while its same-family variant 'drought tolerant plants
// florida' resolves tree-shrub — and whichever has one more impression is
// the representative. Any variant's supported classification keeps the
// family; a family where NO variant resolves stays off-topic-rejected.
// Known service-homonym contexts: FULL-WORD service evidence that is
// semantically about something else entirely ('software bugs', 'computer
// mouse', 'palm reading'). Word-sense disambiguation can't be perfect in
// regex — this list rejects the recurring GSC classes and errs narrow:
// 'mouse trap' and 'palm tree' stay service evidence (Codex r21).
const SERVICE_HOMONYM_RE = new RegExp([
  String.raw`\b(?:software|computer|hardware|coding|programming|apps?|web(?:site)?|video\s*game|gaming|wireless|bluetooth|usb)\s+(?:bugs?|mice|mouse)\b`,
  String.raw`\b(?:bugs?)\s+(?:in|on)\s+(?:software|code|computers?|apps?|websites?)\b`,
  String.raw`\bmouse\s+(?:pads?|cursors?|dpi|sensitivity)\b`,
  String.raw`\bpalm\s+(?:reading|readers?|springs?|sunday|oil|of\s+your\s+hand)\b`,
  String.raw`\bstock\s+tickers?\b`,
].join('|'), 'i');

// Order-insensitive companion to SERVICE_HOMONYM_RE: family variants share
// ONE token set, so 'software types of bugs' must void evidence exactly
// like 'types of software bugs' — the guard runs at FAMILY scope on token
// co-occurrence (an ambiguous service token + a homonym-context token
// anywhere in the family), not per ordered variant (Codex r22 audit).
const HOMONYM_AMBIGUOUS_TOKENS = new Set(['bug', 'bugs', 'mouse', 'mice', 'palm', 'palms', 'tick', 'ticks', 'rat', 'rats', 'bee', 'bees']);
const HOMONYM_CONTEXT_TOKENS = new Set([
  'software', 'computer', 'computers', 'hardware', 'coding', 'programming',
  'app', 'apps', 'web', 'website', 'websites', 'code', 'game', 'games',
  'gaming', 'wireless', 'bluetooth', 'usb', 'cursor', 'cursors', 'dpi',
  'pad', 'pads', 'sensitivity', 'reading', 'reader', 'readers', 'sunday',
  'oil', 'springs', 'stock', 'stocks', 'ticker', 'tickers', 'beef',
]);
function familyHomonymContext(fam) {
  let ambiguous = false;
  let context = false;
  for (const v of fam.variants || []) {
    for (const t of String(v.query || '').toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/)) {
      if (HOMONYM_AMBIGUOUS_TOKENS.has(t)) ambiguous = true;
      if (HOMONYM_CONTEXT_TOKENS.has(t)) context = true;
      if (ambiguous && context) return true;
    }
  }
  return false;
}

function resolveListicleFamilyServiceCity(fam, { canonicalize, inferService, normCity, inferCity, classifierSupported = classifierQuerySupported }) {
  let service = null;
  let city = null;
  // Family-scope homonym context voids ambiguous-token service evidence
  // for EVERY variant — reordering must not restore what the ordered
  // regex rejected.
  const homonymFamily = familyHomonymContext(fam);
  for (const v of fam.variants) {
    if (!service && !homonymFamily && !SERVICE_HOMONYM_RE.test(v.query)) {
      const canon = canonicalize(v.service_category);
      // Classifier value only counts with boundary-aware query evidence —
      // see classifierQuerySupported (unbounded classifier patterns tag
      // off-topic queries); inference is already contextual. A homonym
      // context (above) voids the variant's service evidence entirely.
      service = (canon && classifierSupported(v.service_category, canon, v.query) ? canon : null)
        || inferService(v.query);
    }
    if (!city) city = normCity(v.city_target) || inferCity(v.query);
    if (service && city) break;
  }
  return { service, city };
}

// A served family (owned page in striking distance for a variant) becomes a
// family-aggregated refresh of that page — kept in the listicle_family
// bucket, NOT striking_distance: PAGE_ANCHORED_BUCKETS in decision-router
// contains only answer_gap and listicle_family, so this labeling is what
// stops the SERP profiler from swapping the refresh back into a competing
// blog and keeps page_type 'refresh' (with its hard improvement_over_prior
// guard). It also keeps the family's contentGap/0.7× scoring. The overlay
// is action-guarded (applyListicleTreatment requires new_supporting_blog),
// so a refresh never receives listicle restructure mandates. dedupeKey is
// standard page-keyed: two families served by the same page merge into one
// refresh row. The family variants ride in signal_metadata so the refresh
// brief sees the full fragmented demand it is satisfying.
// entries: [{ fam, served }] — EVERY family this page serves for one
// service/city, merged into a single refresh row. The page-keyed dedupe
// means a second row could never queue anyway; without the merge,
// persistAll's per-key winner pick would carry only one family's variants
// and the other family's demand would be silently lost — unrecoverable
// once the row froze (Codex r11). family_keys carries every merged key so
// the mirror retirement can match any member family.
function buildListicleFamilyRefreshOpp(entries) {
  const sorted = entries.slice().sort((a, b) => b.fam.impressions - a.fam.impressions);
  // The PRIMARY (highest-impression) family anchors query, classification,
  // AND position TOGETHER — mixing the best-ranked family's query with
  // another family's service/city produced internally inconsistent refresh
  // briefs (a lawn keyword loading pest facts; Codex r13).
  const primary = sorted[0];
  const totalImpressions = sorted.reduce((sum, e) => sum + e.fam.impressions, 0);
  const allVariants = sorted
    .flatMap((e) => e.fam.variants)
    .sort((a, b) => b.impressions - a.impressions);
  const pagePosition = primary.served.hit.position;
  // Impressions-weighted across the merged families — the summed
  // impressions must sit beside an aggregate position, not the single
  // best-ranked variant's (Codex r13 P2); the anchor page's own rank rides
  // separately as page_position.
  const familyAvgPosition = totalImpressions
    ? sorted.reduce((sum, e) => sum + (e.fam.position || 0) * e.fam.impressions, 0) / totalImpressions
    : 0;
  const opp = {
    bucket: 'listicle_family',
    query: primary.served.variant.query,
    page_url: primary.served.hit.page_url,
    service: primary.service,
    city: primary.city,
    signal_metadata: {
      impressions: totalImpressions,
      avg_position: Math.round(familyAvgPosition * 10) / 10,
      family_avg_position: Math.round(familyAvgPosition * 10) / 10,
      page_position: Math.round(pagePosition * 10) / 10,
      family_size: allVariants.length,
      family_count: sorted.length,
      family_key: primary.fam.key,
      family_keys: sorted.map((e) => e.fam.key),
      // COMPLETE normalized query set — arbitration must see every
      // variant; family_variants below stays capped for brief metadata
      // (pre-push audit r21).
      family_queries: allVariants.map((v) => String(v.query || '').toLowerCase()),
      specialty_topic: extractSpecialtyTopic(allVariants.map((v) => v.query)),
      // At least one variant from EVERY merged family, then fill by
      // impressions — a five-big-variant family A must not erase family B
      // from the only row that can carry it (Codex r12).
      family_variants: (() => {
        const reps = sorted.map((e) => e.fam.variants[0]);
        const chosen = new Set(reps);
        for (const v of allVariants) {
          if (chosen.size >= Math.max(5, reps.length)) break;
          chosen.add(v);
        }
        return Array.from(chosen)
          .sort((a, b) => b.impressions - a.impressions)
          .map(({ query, impressions }) => ({ query, impressions }));
      })(),
      source: 'listicle_family',
    },
  };
  const { total, breakdown } = scoreOpportunity(opp, {
    position: pagePosition,
    impressions: totalImpressions,
  });
  opp.score = total;
  opp.score_breakdown = breakdown;
  opp.action_type = actionForOpportunity(opp);
  opp.dedupe_key = listicleFamilyRefreshDedupeKey(opp.page_url, opp.service, opp.city, sorted.map((e) => e.fam.key));
  return opp;
}

// Can a query-level bucket ACTUALLY emit this representative? Service
// resolution alone is not enough (Codex r12): striking_distance takes any
// ≥50-imp query ranking 4-15 regardless of the own-page map, while
// no_content_yet takes >15 ONLY when no owned page usefully ranks for the
// query (noContentYetMapEmittable over gsc_query_page_map) — a rep at
// position 20 that a mapped page serves at ≤ answerGapPositionMax is
// emitted by NEITHER, so excluding its family would lose the demand to
// no bucket at all. Top-3 reps are irrelevant here: family admission drops
// them as won intent regardless.
function listicleFamilyRepReachable(rep, ownPagesByServiceCity = new Map(), thresholds = THRESHOLDS, { seasonalEmittable = false, mappedPositions = null, mapCoveredDomains = null } = {}) {
  if (!rep) return false;
  // mineSeasonalRising emits the rep independently of position and the
  // own-page map — a seasonal-emittable rep must count as reachable or the
  // two buckets queue competing posts for one intent (Codex r13).
  if (seasonalEmittable) return true;
  // Judged per (query, service, city) TUPLE with the query miners' OWN
  // aggregation — plain avg(position) and a PER-TUPLE ≥50 floor (Codex
  // r14): the family mine's impressions-weighted position can sit in the
  // striking window while the miners' plain average sits far outside it
  // (100 imps at 8 + 1 at 100 → weighted ~8.9, plain 54), and a split
  // classification can leave every tuple under the floor those miners
  // apply per group.
  const tuples = rep.tuples && rep.tuples.length ? rep.tuples : [{
    impressions: rep.impressions || 0,
    plainPosition: rep.position || 0,
    service_category: rep.service_category || null,
    city_target: rep.city_target || null,
    domains: Array.isArray(rep.domains) ? rep.domains : [],
  }];
  for (const t of tuples) {
    if ((t.impressions || 0) < thresholds.minImpressionsToScore) continue;
    const pos = t.plainPosition || 0;
    // Both branches build the candidate the way its miner would and then
    // check it against persistAll's action-aware floor: SQL admission
    // alone is not reachability — a striking_distance row scoring ~22
    // never persists, so excluding the family on its account would leave
    // the demand claimable NOWHERE (Codex r16).
    const service = t.service_category || inferServiceFromQuery(rep.query);
    const city = normalizeCity(t.city_target) || inferCityFromQuery(rep.query);
    if (pos >= thresholds.strikingDistancePositionMin && pos <= thresholds.strikingDistancePositionMax) {
      // striking_distance mirror (no service guard; page attach optional).
      const cand = {
        bucket: 'striking_distance',
        query: rep.query,
        page_url: ownPagesByServiceCity.get(ownPageKey(service, city)) || null,
        service,
        city,
      };
      cand.action_type = actionForOpportunity(cand);
      const { total } = scoreOpportunity(cand, { position: pos, impressions: t.impressions });
      if (total >= minScoreToActFor(cand.action_type)) return true;
      continue;
    }
    if (pos <= thresholds.strikingDistancePositionMax) continue;
    // no_content_yet mirror — MUST match mineNoContentYet's admission
    // exactly (the reachability contract). Its served-ness test is
    // noContentYetMapEmittable over true query→page rows, gated on map
    // coverage judged PER TUPLE from that tuple's own contributing
    // domains — the miner checks each (query, service, city, intent)
    // candidate's domains individually, so a union across tuples would
    // read a mixed-coverage query as wholly uncheckable while the miner
    // emits its covered tuple: both sides would enqueue for one intent.
    // Uncovered tuples (and tuples without domain provenance — fallback
    // reps, older callers) fail closed exactly like the miner's uncovered
    // candidates: unreachable here, demand stays with the family.
    if (!service) continue;
    if (!queryDomainsCovered(t.domains, mapCoveredDomains || new Set())) continue;
    const tupleDomainPositions = (Array.isArray(t.domains) ? t.domains : [])
      .map((d) => (mappedPositions instanceof Map
        ? mappedPositions.get(mappedPositionKey(rep.query, d)) ?? null
        : null));
    if (!noContentYetEmittable(tupleDomainPositions, thresholds)) continue;
    const cand = {
      bucket: 'no_content_yet',
      query: rep.query,
      page_url: null,
      service,
      city,
    };
    cand.action_type = actionForOpportunity(cand);
    const { total } = scoreOpportunity(cand, { position: pos, impressions: t.impressions });
    if (total >= minScoreToActFor(cand.action_type)) return true;
  }
  return false;
}

// Canonical ROUTE IDENTITY of a page URL — registrable domain (www
// stripped) + query/hash-free path with the trailing slash trimmed,
// mirroring refresh-audit's hostRegistrableSql/canonPathSql: GSC reports
// the same route under www/apex hosts and slash variants, and identity
// (not the raw string) must key every group, fence, and dedupe derivation
// or one Astro file collects concurrent conflicting edits (Codex r34).
function routeIdentity(url) {
  if (!url) return null;
  const str = String(url);
  const host = str.replace(/^[a-z]+:\/\//i, '').split('/')[0].split(':')[0].replace(/^www\./i, '').toLowerCase();
  const path = str.split('#')[0].split('?')[0].replace(/^[a-z]+:\/\/[^/]+/i, '').replace(/\/+$/, '');
  return `${host}::${path}`;
}

// seo_actions stores URLs scheme-less ("wavespestcontrol.com/path"), so
// they need a scheme before routeIdentity can split host from path.
function seoActionRouteIdentity(url) {
  const raw = String(url || '').trim();
  if (!raw) return null;
  return routeIdentity(/^[a-z]+:\/\//i.test(raw) ? raw : `https://${raw}`);
}

// SQL twin of routeIdentity() for matching STORED page_url values by route
// identity (the sweep's page exemption) — keep the two in lockstep. chr(63)
// is '?' for the same knex bind-placeholder reason as CANON_URL_SQL; the
// root path trims to '' in both forms.
const ROUTE_IDENTITY_SQL = "(regexp_replace(regexp_replace(split_part(split_part(lower(page_url), '//', 2), '/', 1), '^www[.]', ''), ':.*$', '')"
  + " || '::' || regexp_replace(regexp_replace(split_part(split_part(page_url, '#', 1), chr(63), 1), '^[a-z]+://[^/]+', ''), '/+$', ''))";

// Subgroup-stable refresh key: (page, service, city, covered family set).
// Within a subgroup a primary-family flip never changes the key — the
// family-key set is SORTED, so order is irrelevant (the r16 duplicate-row
// bug stays fixed). A done/skipped row freezes exactly the work it
// covered: a NEWLY EMERGING family changes the set, hence the key, and
// reopens the subgroup instead of being starved behind completed work
// (Codex r23) — while the one-subgroup-per-page sequencing still ensures
// two claimable rows never coexist for one URL (an in-flight
// old-generation row makes the new key WAIT; the sweep expires orphaned
// pending generations).
function listicleFamilyRefreshDedupeKey(pageUrl, service, city, familyKeys = []) {
  // Keyed on ROUTE IDENTITY, not the raw URL — host/slash variants of one
  // route must share a key (Codex r34).
  const identity = routeIdentity(pageUrl) || '';
  const dims = [
    identity,
    service || '_',
    String(city || '_').toLowerCase(),
    familyKeys.slice().sort().join('|'),
  ].join('::');
  const digest = crypto.createHash('sha256').update(dims).digest('hex').slice(0, 16);
  return ['listicle_family', 'page', identity.slice(0, 100), digest].join('::');
}

// Family-stable dedupe key. Deliberately NOT dedupeKey(opp): that keys on
// the representative query + service/city, all of which can flip between
// mining runs as close variants trade places — minting fresh rows for one
// search intent. The token-identity family key is invariant under those
// fluctuations, and city tokens live inside it, so local intents key apart.
// Shape: a readable prefix for operators eyeballing the queue, plus a
// digest of the COMPLETE key — a bare `.slice(120)` collided two long-tail
// families sharing their first 120 chars (persistAll would drop one as a
// same-run duplicate or ping-pong the pending row between identities).
function listicleFamilyDedupeKey(familyKey) {
  const key = String(familyKey || '');
  const digest = crypto.createHash('sha256').update(key).digest('hex').slice(0, 16);
  return ['listicle_family', 'fam', key.slice(0, 120), digest].join('::');
}

// Used to look up the best-impression own page sharing a query's
// service+city classification — same keying as the gsc_queries → gsc_pages
// join. Treat null/empty as a distinct group rather than collapsing them.
function ownPageKey(service, city) {
  return `${service || ''}::${city || ''}`;
}

// no_content_yet admission, judged on TRUE query→page evidence: emit only
// when the query IS mapped and its best owned page ranks beyond
// answerGapPositionMax. Both failure directions close:
//  - mapped at ≤ answerGapPositionMax → refresh/answer-gap territory
//    (mineAnswerGap's own window); new content beside it would compete.
//    Mere map-row existence is deliberately NOT the served test (same
//    doctrine as the listicle_family served check) — existence alone kept
//    the bucket inert, like the retired service+city coverage check did
//    (zero rows ever persisted, verified against prod 2026-08-11).
//  - UNMAPPED → missing evidence, not proof of absence (audit P1 #4):
//    every gsc_queries impression originated from SOME owned URL, and the
//    query+page breakdown omits low-volume rows — emitting on absence
//    could mint content beside an unseen ranking page. At current prod
//    data this costs nothing: every real candidate carries a mapping.
//
// SHARED by mineNoContentYet admission and listicleFamilyRepReachable's
// no_content_yet mirror — the two must stay in lockstep or family demand
// double-emits / strands (the reachability contract).
function noContentYetMapEmittable(bestMappedPosition, thresholds = THRESHOLDS) {
  return bestMappedPosition != null
    && Number.isFinite(bestMappedPosition)
    && bestMappedPosition > thresholds.answerGapPositionMax;
}

// A candidate aggregates impressions across domains, so the evidence must
// hold for EVERY contributing domain: positions are resolved per
// (query, domain) and each one must be mapped AND weak. A query-wide
// lookup would let one domain's weak mapping vouch for another domain
// where the query is unmapped (missing evidence) or strongly served —
// both directions mint competing content (audit P1 #5). Empty list =
// no provenance = fail closed.
function noContentYetEmittable(domainPositions, thresholds = THRESHOLDS) {
  const list = Array.isArray(domainPositions) ? domainPositions : [];
  if (!list.length) return false;
  return list.every((p) => noContentYetMapEmittable(p, thresholds));
}

// The page a low-CTR query ACTUALLY ranks with, from true query→page rows:
// the most-impressed page is the one Google showed and users didn't click,
// which is what a title/meta rewrite must target. The service+city
// own-page heuristic picks the segment's biggest page instead, which on a
// multi-page segment aims the rewrite PR at an unrelated URL (audit P1
// #6). Ties break on the better (lower) position. No rows → null →
// actionForOpportunity falls through to do_not_publish (fail closed).
// Positions arrive as pg numerics (strings), nulls, or absent. Number()
// maps null AND '' to 0 — a perfect position-0 ranking — so every
// position read goes through this guard: missing data must never read as
// "ranks first" (that fails OPEN in both consumers: it would suppress a
// no_content_yet gap and make a deep page look in-window).
function finitePosition(value) {
  if (value == null || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function pickCtrRewriteTargetPage(rows = []) {
  let best = null;
  for (const r of rows) {
    const impressions = parseInt(r.impressions, 10) || 0;
    const position = finitePosition(r.page_position);
    if (!r.page_url) continue;
    if (!best
      || impressions > best.impressions
      || (impressions === best.impressions && position != null
        && (best.position == null || position < best.position))) {
      best = { page_url: r.page_url, impressions, position };
    }
  }
  return best ? best.page_url : null;
}

// The selected page must ITSELF be underperforming. The bucket's gate is a
// query-level CTR aggregate across every page and domain, so a weak
// secondary page can drag the aggregate under the threshold while the
// most-impressed page is perfectly healthy — rewriting that page's title
// would damage a working snippet (audit P1 #9). Fail closed: no rows, no
// pick, or a healthy pick → null → do_not_publish.
// Minimum share of a query's mapped demand the rewrite target must carry.
// The bucket's impression floor and position gate are both QUERY-level, so
// demand sitting on deep ineligible URLs can qualify the query while a
// bystander page that happens to rank shallow gets selected — and with a
// handful of impressions its CTR is noise, not evidence (audit P2). A page
// carrying under a quarter of the query's mapped demand is not what the
// query is really landing on.
const CTR_REWRITE_TARGET_MIN_SHARE = 0.25;

// Restrict mapped pages to the ones a candidate's OWN domains produced.
// rankingPages is keyed by query alone while candidates are grouped by
// (query, service, city), so under mixed-domain or drifted classification
// one tuple could otherwise be handed a URL that belongs to another
// tuple's domain (audit P1). Pages without domain provenance are dropped:
// unattributable evidence must not pick a rewrite target.
function pagesForCandidateDomains(pageRows = [], domains = []) {
  const own = new Set((Array.isArray(domains) ? domains : [])
    .filter(Boolean).map((d) => String(d).toLowerCase()));
  if (!own.size) return [];
  return pageRows.filter((r) => (Array.isArray(r.domains) ? r.domains : [])
    .some((d) => d && own.has(String(d).toLowerCase())));
}

function ctrRewriteTargetFor(pageRows = [], thresholds = THRESHOLDS) {
  // Only pages inside the bucket's own ranking window are eligible. The
  // gate is a query-level avg_position, which a deep secondary URL can
  // ride: a page sitting at 30 or 50 naturally shows a terrible CTR and
  // would collect an automated metadata rewrite it never qualified for
  // (audit P2). A title/meta rewrite is the right lever only when the
  // page already ranks well and still isn't earning the click.
  const inWindow = pageRows.filter((r) => {
    const pos = finitePosition(r.page_position);
    return pos != null && pos <= thresholds.ctrRewritePositionMax;
  });
  const url = pickCtrRewriteTargetPage(inWindow);
  if (!url) return null;
  const row = inWindow.find((r) => r.page_url === url);
  if (!row) return null;
  // Materiality, both absolute and relative to the query's own demand.
  // The absolute floor is the same answerGapMinQueryImpressions that
  // materialServingPosition uses — one notion of "enough impressions for
  // this page+query pair to be actionable" across the module.
  const targetImpressions = parseInt(row.impressions, 10) || 0;
  if (targetImpressions < thresholds.answerGapMinQueryImpressions) return null;
  const mappedTotal = pageRows.reduce((sum, r) => sum + (parseInt(r.impressions, 10) || 0), 0);
  if (!mappedTotal) return null;
  if (targetImpressions / mappedTotal < CTR_REWRITE_TARGET_MIN_SHARE) return null;
  return recomputeCtr(row.clicks, row.impressions) < thresholds.ctrRewriteMaxCtr ? url : null;
}

// How well an owned page serves a query, counting only MATERIAL mappings.
// An unweighted min across URLs lets a single stray impression at
// position 2 declare the query served and suppress no_content_yet, while
// the real demand sits on another URL at position 50. A page below
// answerGapMinQueryImpressions is not actionable by the refresh side
// either — mineAnswerGap ignores it — so calling it "serving" suppresses
// a real gap on evidence no mechanism would act on (audit P2). All
// mappings immaterial → null → fails closed, same as unmapped.
function materialServingPosition(pages = [], thresholds = THRESHOLDS) {
  let best = null;
  for (const p of pages) {
    const impressions = parseInt(p.impressions, 10) || 0;
    if (impressions < thresholds.answerGapMinQueryImpressions) continue;
    const pos = finitePosition(p.page_position);
    if (pos == null) continue;
    if (best == null || pos < best) best = pos;
  }
  return best;
}

// Is a candidate's absent/weak query→page mapping trustworthy EVIDENCE, or
// possibly a sync hole? Map syncs run and fail independently per domain
// (and stale rows linger), while candidates aggregate gsc_queries across
// every domain — so a global "the map has rows" sentinel would read one
// domain's failed sync as a genuine content gap whenever any other domain
// synced. A candidate is checkable only when EVERY domain contributing its
// impressions has in-window map rows; unknown/empty domain lists fail
// closed (pre-push audit P1, 2026-08-12).
// Key for per-(query, domain) mapped positions — domains compare
// case-insensitively, matching queryDomainsCovered.
function mappedPositionKey(query, domain) {
  return `${String(query || '')}\x00${String(domain || '').toLowerCase()}`;
}

function queryDomainsCovered(domains, coveredDomains) {
  const list = Array.isArray(domains) ? domains : [];
  if (!list.length) return false;
  return list.every((d) => d && coveredDomains.has(String(d).toLowerCase()));
}


function dedupeKey({ bucket, service, city, query, page_url }) {
  const parts = [
    bucket,
    service || '_',
    (city || '_').toLowerCase().replace(/\s+/g, '-'),
    (page_url || query || '_').slice(0, 120),
  ];
  return parts.join('::');
}

function scoreOpportunity(opportunity, extraSignals = {}) {
  const breakdown = {
    gscOpportunity: gscOpportunityScore(
      opportunity.bucket,
      extraSignals.position || 10,
      impressionsBoost(extraSignals.impressions || 0)
    ),
    localRevenue: localRevenueScore(opportunity.service),
    conversionIntent: conversionIntentScore(opportunity.query || opportunity.page_url),
    // answer_gap earns BOTH: it is literally a content gap (the answer is
    // missing) on an existing page whose rankings the new blocks lift. The
    // double credit is what lets a strong gap (impressionsBoost 1.0) clear
    // the 75 floor at all — weaker signals still fall short by design.
    // listicle_family earns contentGap too: the bucket admits a family only
    // when no own page already dominates it (top-3 families are excluded at
    // mine time), so what remains is enumerable demand with no satisfying
    // asset — and without this weight the motivating ~450-impression family
    // scores ~40, under the 45 blog admission floor, making the bucket
    // silently inert.
    contentGap: opportunity.bucket === 'local_gap' || opportunity.bucket === 'no_content_yet'
        || opportunity.bucket === 'answer_gap' || opportunity.bucket === 'listicle_family'
      ? WEIGHTS.contentGap
      : 0,
    refreshLift: opportunity.bucket === 'decay_refresh' || opportunity.bucket === 'ctr_rewrite'
        || opportunity.bucket === 'answer_gap'
      ? WEIGHTS.refreshLift
      : 0,
    aeoGap: opportunity.bucket === 'aeo_gap'
      ? Math.round(WEIGHTS.aeoGap * (extraSignals.gapStrength ?? 1))
      : 0,
  };
  // Penalties surface in later steps (the decision router applies
  // serpMismatch against live SERP profiles); no bucket pre-applies one
  // here since the review-only buckets retired. _penalty stays in the
  // breakdown for shape stability with historical rows.
  const penalty = 0;

  const total = Object.values(breakdown).reduce((a, b) => a + b, 0) - penalty;
  return { total, breakdown: { ...breakdown, _penalty: penalty } };
}

// ── link-boost derivation (pure) ─────────────────────────────────────
//
// A page flagged for ctr_rewrite or decay_refresh needs more than a
// title/meta rewrite or a body refresh — it usually also needs inbound
// internal links. Those parents only edit the page itself; nothing
// pointed sibling-page equity at it. Each parent with a known page_url
// therefore spawns a companion add_internal_links opportunity that the
// runner executes through the existing internal-link planner → dry-run
// → review-queue path (shadow by SHADOW_MODE_ADD_INTERNAL_LINKS).
//
// The companion INHERITS the parent's score instead of re-deriving it:
// the demand signal is identical, and re-scoring under a new bucket
// multiplier would let a parent clear persistAll's floor while its
// companion silently missed it. For the same reason mineAll derives
// AFTER _applyFactsReadinessBoost — a facts-ready decay refresh lifted
// over the floor must lift its companion too. gscOpportunityScore is
// never consulted for this bucket.
//
// excludeKeys rotates the per-run cap: dedupe keys whose queue rows are
// claimed / done / pending_review are skipped BEFORE capping — persistAll's
// upsert refuses to re-open those statuses, so emitting them again would
// burn cap slots on rows that can't change while lower-scoring qualifying
// pages starve behind them.

const LINK_BOOST_SOURCE_ACTIONS = new Set(['rewrite_title_meta', 'refresh_existing_page']);
const DEFAULT_LINK_BOOST_MAX_PER_RUN = 10;

function linkBoostCap() {
  const raw = Number.parseInt(process.env.LINK_BOOST_MAX_PER_RUN, 10);
  return Number.isFinite(raw) && raw >= 0 ? raw : DEFAULT_LINK_BOOST_MAX_PER_RUN;
}

// THE persistence floor for an opportunity — single source of truth for
// persistAll's admission gate and for every "is this candidate live?"
// question asked elsewhere (parent-row protection, companion protection).
// Two exceptions ride a lower floor than their action_type implies:
// listicle_family blog/refresh rows keep the BLOG floor (aggregated
// sub-50-impression demand admitted as a blog must not be discarded for
// taking the safer refresh route), and a link_boost companion DERIVED from
// a ctr_rewrite inherits the rewrite floor because it inherits that
// parent's score by construction.
// Log-safe identifier for a GSC query. Search terms are arbitrary
// external text — names, addresses, phone numbers all show up in real GSC
// exports — so they must never reach the logs (AGENTS.md non-card PII
// rule). The digest is stable across runs, so repeat failures still
// correlate.
function queryDigest(query) {
  return crypto.createHash('sha256').update(String(query || '')).digest('hex').slice(0, 12);
}

function persistFloorFor(o) {
  const familyFloorActions = ['new_supporting_blog', 'refresh_existing_page'];
  if (o.bucket === 'listicle_family' && familyFloorActions.includes(o.action_type)) {
    return minScoreToActFor('new_supporting_blog');
  }
  if (o.bucket === 'link_boost' && o.signal_metadata?.source_bucket === 'ctr_rewrite') {
    return minScoreToActFor('rewrite_title_meta');
  }
  return minScoreToActFor(o.action_type);
}

function isPersistable(o) {
  return (o?.score ?? 0) >= persistFloorFor(o || {});
}

// Companion dedupe keys the CURRENT batch still stands behind. A link_boost
// key is (bucket, service, city, page) with NO query in it, so companions
// are shared across queries and across source buckets — retiring one on a
// stale ctr_rewrite row's account would delete work another live parent
// still needs. Protection is synthesized from EVERY live link-boost-eligible
// parent (rewrite_title_meta AND refresh_existing_page), not just the
// emitted link_boost rows: LINK_BOOST_MAX_PER_RUN can drop a companion whose
// page is still actively targeted, and a decay_refresh parent sharing a page
// with a stale rewrite row must not lose its companion (audit P1 ×2).
function companionProtectionKeys(opportunities = []) {
  const keys = new Set();
  for (const o of opportunities) {
    // Only candidates that will ACTUALLY PERSIST defend anything. A
    // below-floor parent is dropped by persistAll, so protecting the
    // companion it can no longer justify would leave that companion
    // claimable at its stale higher score while the parent row itself is
    // being retired (audit P1) — the same rule the reconciliation applies
    // to parent rows, via the same shared floor.
    if (!isPersistable(o)) continue;
    if (o.bucket === 'link_boost' && o.dedupe_key) keys.add(o.dedupe_key);
    if (o.page_url && LINK_BOOST_SOURCE_ACTIONS.has(o.action_type)) {
      keys.add(dedupeKey({
        bucket: 'link_boost', service: o.service, city: o.city, page_url: o.page_url,
      }));
    }
  }
  return keys;
}

function deriveLinkBoost(parents = [], { cap = linkBoostCap(), excludeKeys = new Set() } = {}) {
  if (!cap) return [];
  const byKey = new Map();
  for (const parent of parents) {
    if (!parent?.page_url) continue;
    // Only derive from parents that themselves survived as in-place page
    // edits — a do_not_publish parent (e.g. ctr_rewrite with no resolvable
    // own page) has nothing to boost.
    if (!LINK_BOOST_SOURCE_ACTIONS.has(parent.action_type)) continue;
    const opp = {
      bucket: 'link_boost',
      query: parent.query || null,
      page_url: parent.page_url,
      service: parent.service || null,
      city: parent.city || null,
      score: parent.score,
      score_breakdown: { ...(parent.score_breakdown || {}), derivedFrom: parent.bucket },
      signal_metadata: { ...(parent.signal_metadata || {}), source_bucket: parent.bucket },
    };
    opp.action_type = actionForOpportunity(opp);
    opp.dedupe_key = dedupeKey(opp);
    if (excludeKeys.has(opp.dedupe_key)) continue;
    // Multiple parents (several low-CTR queries, or ctr_rewrite + decay on
    // the same page) collapse to one companion per dedupe key; keep the
    // strongest signal.
    const existing = byKey.get(opp.dedupe_key);
    const winner = (!existing || opp.score > existing.score) ? opp : existing;
    // …but the FLOOR follows the most permissive JUSTIFIED parent, not the
    // score winner. Collapsing by raw score alone could tag a companion
    // 'decay_refresh' (global floor 75) when a persistable ctr_rewrite
    // parent on the same page justified it at the lower rewrite floor —
    // dropping work that parent should admit (audit P1). Provenance is
    // additive: any qualifying rewrite parent grants the rewrite floor.
    const contributors = new Set([
      ...(existing?.signal_metadata?.source_buckets || [existing?.signal_metadata?.source_bucket]),
      ...(opp.signal_metadata?.source_buckets || [opp.signal_metadata?.source_bucket]),
    ].filter(Boolean));
    // Only override when the rewrite floor is genuinely LOWER than the
    // one the winner would otherwise ride — with the env unset the two are
    // equal and the recorded provenance stays the score winner's.
    const rewriteJustified = minScoreToActFor('rewrite_title_meta') < persistFloorFor(winner)
      && ((existing?.signal_metadata?.source_bucket === 'ctr_rewrite' && isPersistable(existing))
        || (opp.signal_metadata?.source_bucket === 'ctr_rewrite' && isPersistable(opp)));
    winner.signal_metadata = {
      ...winner.signal_metadata,
      source_buckets: Array.from(contributors),
      source_bucket: rewriteJustified ? 'ctr_rewrite' : winner.signal_metadata.source_bucket,
    };
    byKey.set(opp.dedupe_key, winner);
  }
  // Drop companions that cannot clear their own persistence floor BEFORE
  // the cap: persistAll checks floors afterwards, so ten 60–74-point decay
  // companions would consume every slot, be discarded at the global floor,
  // and starve lower-scoring but valid rewrite companions riding the lower
  // rewrite floor (audit P2). Same floor the persist gate uses.
  return Array.from(byKey.values())
    .filter(isPersistable)
    .sort((a, b) => b.score - a.score)
    .slice(0, cap);
}

// ── answer-gap analysis (pure, test-friendly) ────────────────────────
//
// A query counts as ANSWERED when some H2–H4 heading in the page body
// covers ≥ ANSWER_GAP_HEADING_COVERAGE of the query's content terms —
// i.e. the page has a section that directly addresses it. Everything
// else the page ranks 9–30 for is a retrieval gap: Google already
// associates the page with the query, but no self-contained passage
// answers it, so neither classic snippets nor answer-engine chunking can
// extract one. The heuristic is deliberately coarse (stemmed token
// overlap, no embeddings): it only ranks candidates — the refresh agent
// sees the full page + query list and makes the final answered/off-intent
// call per query.

const ANSWER_GAP_HEADING_COVERAGE = 0.6;
const ANSWER_GAP_MAX_QUERIES_PER_PAGE = 12;

const ANSWER_GAP_STOPWORDS = new Set([
  'a', 'an', 'the', 'and', 'or', 'but', 'of', 'in', 'on', 'for', 'to', 'with',
  'at', 'by', 'from', 'near', 'me', 'nearby', 'is', 'are', 'was', 'were', 'be',
  'been', 'do', 'does', 'did', 'can', 'could', 'should', 'will', 'would',
  'how', 'what', 'why', 'when', 'where', 'which', 'who', 'my', 'your', 'our',
  'their', 'its', 'it', 'i', 'we', 'you', 'get', 'got', 'best', 'top', 'vs',
  'versus', 'fl', 'florida',
]);

// City tokens never count as content terms — a city page's headings won't
// (and shouldn't) repeat the city in every section.
const ANSWER_GAP_CITY_TOKENS = new Set(
  CITIES.flatMap((c) => c.toLowerCase().split(/\s+/))
);

// Light stemming so query and heading tokens compare on their stems
// ("ants" ↔ "ant", "flies" ↔ "fly"). Naive on purpose — see block comment.
function answerGapStem(token) {
  let t = token;
  if (t.length > 4 && t.endsWith('ies')) return `${t.slice(0, -3)}y`;
  if (t.length > 3 && t.endsWith('s') && !t.endsWith('ss')) return t.slice(0, -1);
  return t;
}

function stemmedTokenSet(text) {
  const out = new Set();
  const tokens = String(text || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, ' ')
    .split(/[\s-]+/)
    .filter(Boolean);
  for (const tok of tokens) out.add(answerGapStem(tok));
  return out;
}

function queryContentTerms(query) {
  const terms = new Set();
  const tokens = String(query || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, ' ')
    .split(/[\s-]+/)
    .filter(Boolean);
  for (const tok of tokens) {
    if (ANSWER_GAP_STOPWORDS.has(tok)) continue;
    if (ANSWER_GAP_CITY_TOKENS.has(tok)) continue;
    if (tok === 'waves') continue; // brand residue the is_branded filter can miss
    terms.add(answerGapStem(tok));
  }
  return terms;
}

function extractHeadings(body) {
  const out = [];
  const re = /^#{2,4}\s+(.+)$/gm;
  let m;
  while ((m = re.exec(String(body || ''))) !== null) out.push(m[1].trim());
  return out;
}

function termCoverage(queryTerms, textTermSet) {
  if (!queryTerms.size) return 0;
  let hit = 0;
  for (const t of queryTerms) if (textTermSet.has(t)) hit += 1;
  return hit / queryTerms.size;
}

/**
 * classifyAnswerGapQueries(queries, body) → { unanswered, answered_count }
 *
 * `queries` must be sorted impressions-desc: near-duplicate phrasings
 * (identical content-term sets, e.g. "bermuda grass removal" vs "how to
 * remove bermuda grass") collapse to the FIRST one seen, so sorting first
 * keeps the highest-impression phrasing. Each kept entry carries its
 * heading/body coverage so the refresh agent can see how close the page
 * already comes.
 */
function classifyAnswerGapQueries(queries = [], body = '') {
  const headingSets = extractHeadings(body).map((h) => stemmedTokenSet(h));
  const bodyTerms = stemmedTokenSet(body);
  const seenTermKeys = new Set();
  const unanswered = [];
  let answeredCount = 0;

  for (const q of queries) {
    const terms = queryContentTerms(q.query);
    if (!terms.size) continue; // pure stopword/city/brand query — nothing to answer
    const headingCov = headingSets.reduce(
      (best, h) => Math.max(best, termCoverage(terms, h)), 0
    );
    if (headingCov >= ANSWER_GAP_HEADING_COVERAGE) {
      answeredCount += 1;
      continue;
    }
    const termKey = Array.from(terms).sort().join('|');
    if (seenTermKeys.has(termKey)) continue;
    seenTermKeys.add(termKey);
    unanswered.push({
      query: q.query,
      impressions: q.impressions,
      clicks: q.clicks,
      position: q.position,
      heading_coverage: Number(headingCov.toFixed(2)),
      body_term_coverage: Number(termCoverage(terms, bodyTerms).toFixed(2)),
    });
  }
  return { unanswered, answered_count: answeredCount };
}

// ── miner class ──────────────────────────────────────────────────────

class GscOpportunityMiner {
  // The scheduled mine's authoritative lookback. Manual/CLI mines may use
  // other windows — those persist normally but never run the destructive
  // family sweep (a 7-day dataset would expire valid 28-day rows).
  static CANONICAL_MINE_PERIOD_DAYS = 28;

  // Cross-run memory of CONFIRMED non-Astro refresh targets (Codex r31) —
  // process-local, TTL'd; a deploy restart just re-probes once.
  static NON_EDITABLE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

  static _nonEditablePages = new Map();

  async mineAll({ periodDays = GscOpportunityMiner.CANONICAL_MINE_PERIOD_DAYS, persist = true } = {}) {
    // Invocation-LOCAL run state: the exported miner is a singleton, and an
    // overlapping run-now + scheduled mine sharing an instance field let
    // one run reset the other's failure flag mid-flight (Codex r26).
    const runState = { familyRefreshStateFailed: false };
    // Unresolved served pages/families collected by the family mine —
    // their pending rows are exempt from this run's destructive sweep.
    const familyExemptions = { pages: new Set(), blogKeys: new Set(), familyKeys: new Set() };
    // One facts-readiness verdict per city::service per run — shared by
    // family subgroup selection AND the boost (Codex r32).
    const factsReadyCache = new Map();
    const since = sinceDate(periodDays);
    const priorSince = sinceDate(periodDays * 2);

    // Build a service+city → best-impression own page map once, reused
    // by the query-level buckets to attach a `page_url` when an own
    // page is plausibly already ranking. Without this, striking_distance
    // and ctr_rewrite emit page_url=null and the decision-router can
    // produce duplicate-content actions (new city page when an existing
    // one already ranks, or fall through to do_not_publish for a CTR
    // rewrite that genuinely has a target URL).
    //
    // GSC's standard export doesn't expose query→page mapping, so this
    // is a heuristic: pick the highest-impression own page sharing the
    // same service_category + city_target classification.
    const ownPagesByServiceCity = await this._loadOwnPagesByServiceCity(since)
      .catch((err) => {
        logger.warn(`[gsc-opp-miner] own-pages map failed: ${err.message}`);
        return new Map();
      });

    const buckets = {};
    const errors = {};

    const runs = [
      ['striking_distance', () => this.mineStrikingDistance(since, ownPagesByServiceCity)],
      ['ctr_rewrite', () => this.mineCtrRewrite(since)],
      ['decay_refresh', () => this.mineDecayRefresh(since, priorSince)],
      // cannibalization + page_type_mismatch retired 2026-08-12 — see the
      // header's RETIRED note for the canonical mechanisms.
      ['local_gap', () => this.mineLocalGap(since, ownPagesByServiceCity)],
      ['seasonal_rising', () => this.mineSeasonalRising(periodDays)],
      ['no_content_yet', () => this.mineNoContentYet(since)],
      ['aeo_gap', () => this.mineAeoGaps(since, ownPagesByServiceCity)],
      ['answer_gap', () => this.mineAnswerGap(since)],
      // Runs AFTER answer_gap by list order: its persistable refresh pages
      // fence the family refreshes — two buckets must not queue
      // independently claimable edits of one page (their dedupe keys
      // differ by construction). The fence ALSO covers IN-FLIGHT refresh
      // rows from EVERY other bucket (pending/claimed/pending_review): a
      // pending-review decay_refresh whose signal recovered is absent
      // from this run's batch, but its still-open edit must not race a
      // family refresh (Codex r19/r20). Fail-soft: a lookup error just
      // weakens the fence for one run.
      ['listicle_family', async () => {
        // ONLY live in-flight rows fence at mine time — same-batch
        // answer_gap candidates are arbitrated frozen-aware in persistAll
        // (_arbitratedRefreshPages); a batch fence here would re-suppress
        // families against candidates whose frozen rows land nothing
        // (pre-push audit r21).
        const answerGapPages = new Set();
        // Their QUERIES too: an unserved family must not mint a blog while
        // a non-family refresh for one of its exact variants is still open
        // but absent from this batch (miner failure / signal change) —
        // same-batch arbitration cannot see it (pre-push audit r22).
        const inflightRefreshQueries = new Set();
        try {
          const inflight = await db('opportunity_queue')
            .whereIn('action_type', GscOpportunityMiner.PAGE_EDITING_ACTIONS)
            .whereNot('bucket', 'listicle_family')
            .whereIn('status', ['pending', 'claimed', 'pending_review'])
            .whereNotNull('page_url')
            .select('page_url', 'query', db.raw("signal_metadata->'unanswered_queries' as unanswered_queries"));
          for (const r of inflight) {
            answerGapPages.add(routeIdentity(r.page_url));
            if (r.query) inflightRefreshQueries.add(String(r.query).toLowerCase());
            for (const u of (Array.isArray(r.unanswered_queries) ? r.unanswered_queries : [])) {
              if (u && u.query) inflightRefreshQueries.add(String(u.query).toLowerCase());
            }
          }
        } catch (err) {
          logger.warn(`[gsc-opp-miner] in-flight refresh fence lookup failed: ${err.message}`);
        }
        // In-flight FAMILY work blocks blog↔refresh transitions: a family
        // crossing the served threshold while its blog is claimed/in
        // review (or the reverse) must not emit the opposite action under
        // a different key beside the un-sweepable in-flight row — the
        // transition defers to the next mine after the work completes
        // (Codex r20). Fail-soft like the fence.
        const inflightFamily = { blogKeys: new Set(), refreshFamilyKeys: new Set() };
        // A NONCANONICAL mine never sweeps, so a pending predecessor would
        // survive beside its replacement — treat pending rows as
        // transition blockers too in that case (Codex r33); the canonical
        // mine keeps the narrower claimed/review set because its sweep
        // retires pending predecessors atomically with the persist.
        const blockerStatuses = periodDays === GscOpportunityMiner.CANONICAL_MINE_PERIOD_DAYS
          ? ['claimed', 'pending_review']
          : ['claimed', 'pending_review', 'pending'];
        try {
          const rows = await db('opportunity_queue')
            .where({ bucket: 'listicle_family' })
            .whereIn('status', blockerStatuses)
            .select('dedupe_key', 'action_type', db.raw("signal_metadata->'family_keys' as family_keys"));
          for (const r of rows) {
            if (r.action_type === 'new_supporting_blog') inflightFamily.blogKeys.add(r.dedupe_key);
            for (const k of (Array.isArray(r.family_keys) ? r.family_keys : [])) {
              inflightFamily.refreshFamilyKeys.add(k);
            }
          }
        } catch (err) {
          logger.warn(`[gsc-opp-miner] in-flight family transition lookup failed: ${err.message}`);
        }
        // Every family refresh row by page, ANY status — drives the
        // sequenced one-subgroup-per-page emission (frozen keys rotate,
        // in-flight keys make later subgroups wait). Small by construction
        // (this lane's own rows only). Fail-soft: empty state emits the
        // dominant subgroup exactly as before.
        let familyRefreshState = new Map();
        try {
          const rows = await db('opportunity_queue')
            .where({ bucket: 'listicle_family', action_type: 'refresh_existing_page' })
            .whereNotNull('page_url')
            .select('page_url', 'dedupe_key', 'status', 'service', 'city', db.raw("signal_metadata->'family_keys' as family_keys"));
          for (const r of rows) {
            const id = routeIdentity(r.page_url);
            if (!familyRefreshState.has(id)) familyRefreshState.set(id, []);
            familyRefreshState.get(id).push({ dedupe_key: r.dedupe_key, status: r.status, service: r.service, city: r.city, family_keys: r.family_keys, page_url: r.page_url });
          }
        } catch (err) {
          // FAIL CLOSED (Codex r25 audit): an empty map would disable the
          // one-edit-per-page sequencing entirely — null tells the mine to
          // emit NO refreshes this run (blogs are unaffected; served
          // families just wait a cycle). The instance flag ALSO suppresses
          // the destructive sweep: with emission suppressed, pending
          // refreshes are absent from the batch by construction and the
          // sweep would retire valid queued work.
          logger.warn(`[gsc-opp-miner] family refresh-state lookup failed (${err.message}) — refresh emission and sweep suppressed this run`);
          familyRefreshState = null;
          runState.familyRefreshStateFailed = true;
        }
        return this.mineListicleFamily(since, { ownPagesByServiceCity, periodDays, answerGapPages, inflightRefreshQueries, inflightFamily, familyRefreshState, reconcileExemptions: familyExemptions, factsReadyCache });
      }],
    ];

    for (const [name, fn] of runs) {
      try {
        buckets[name] = await fn();
      } catch (err) {
        logger.warn(`[gsc-opp-miner] ${name} failed: ${err.message}`);
        errors[name] = err.message;
        buckets[name] = [];
      }
    }

    // Facts-readiness boost — applied before persistAll so well-supported
    // rewrite opportunities can clear the global minScoreToAct floor.
    const minedOpportunities = Object.values(buckets).flat();
    await this._applyFactsReadinessBoost(minedOpportunities, factsReadyCache);

    // Derived bucket — no GSC query of its own. Underperforming pages get an
    // inbound internal-link companion alongside their rewrite/refresh.
    // Runs AFTER the facts boost so companions inherit the boosted parent
    // score, and with already-occupied queue rows excluded so the per-run
    // cap rotates to lower-scoring pages (see deriveLinkBoost docs).
    try {
      const occupied = await this._loadOccupiedKeys('link_boost').catch((err) => {
        // Fail-open to pre-rotation behavior: re-emitting occupied rows is
        // harmless (persistAll freezes their status); dropping the lane on a
        // transient query error is not.
        logger.warn(`[gsc-opp-miner] occupied link_boost keys load failed: ${err.message}`);
        return new Set();
      });
      buckets.link_boost = deriveLinkBoost(
        [...(buckets.ctr_rewrite || []), ...(buckets.decay_refresh || [])],
        { excludeKeys: occupied }
      );
    } catch (err) {
      logger.warn(`[gsc-opp-miner] link_boost failed: ${err.message}`);
      errors.link_boost = err.message;
      buckets.link_boost = [];
    }

    const allOpportunities = [...minedOpportunities, ...buckets.link_boost];

    const counts = Object.fromEntries(
      Object.entries(buckets).map(([k, v]) => [k, v.length])
    );

    let persisted = 0;
    if (persist) {
      // Upserts + family sweep in ONE transaction: a concurrent runner's
      // claimNext (FOR UPDATE SKIP LOCKED) must never observe a
      // blog↔refresh transition halfway — replacement landed, old row
      // still claimable (Codex r22 audit). Sweep ordering inside the
      // transaction preserves the r15 contract: it runs only after every
      // upsert succeeded, and a failure rolls back both.
      await db.transaction(async (trx) => {
        const sweepWillRun = !errors.listicle_family
          && !runState.familyRefreshStateFailed
          && periodDays === GscOpportunityMiner.CANONICAL_MINE_PERIOD_DAYS
          && isEnabled('listicleFamilyMining') && isEnabled('listicleBriefs');
        // Lock + revalidate family predecessors FIRST — see
        // _revalidateFamilyBatch (a claim between the mine's reads and
        // this transaction defers the transition instead of racing it).
        // The lock is taken even for an empty family batch when the sweep
        // will run.
        const revalidated = await this._revalidateFamilyBatch(trx, allOpportunities, { lockEvenIfEmpty: sweepWillRun });
        persisted = await this.persistAll(revalidated, trx);
        // Family-lane sweep ONLY after the upserts land, only when the
        // lane actually ran (gates on, no miner error — an empty bucket
        // then means "didn't run", not "no signal").
        if (sweepWillRun) {
          await this._sweepStaleFamilyRows(
            revalidated.filter((o) => o.bucket === 'listicle_family'),
            revalidated,
            trx,
            familyExemptions
          );
        }
        // ctr_rewrite lane sweep, same doctrine as the family one: a query
        // that RECOVERS (CTR back above threshold, impressions or position
        // out of range) simply vanishes from the bucket, so per-query
        // reconciliation inside persistAll never sees it and its pending
        // rewrite would stay claimable for the full 14 days — optimizing a
        // page that is now performing fine. Guarded on a successful bucket
        // run: with an error, an empty/short bucket means "didn't run", not
        // "no signal", and sweeping would retire valid queued work.
        // periodDays gate mirrors the family sweep: a manual 7-day mine
        // sees far fewer qualifying queries, and treating everything
        // absent from that shorter window as "recovered" would expire
        // valid rows produced by the authoritative 28-day run.
        // Both newly-revived buckets share one disappearing-signal
        // lifecycle, so they share ONE sweep (AGENTS.md: extend the
        // existing mechanism, never add a sibling). no_content_yet needs
        // it most: its stale rows CREATE pages, so acting on a query an
        // owned page has since started serving publishes duplicate
        // content — a worse outcome than a stale rewrite.
        if (periodDays === GscOpportunityMiner.CANONICAL_MINE_PERIOD_DAYS) {
          for (const bucket of ['ctr_rewrite', 'no_content_yet']) {
            if (errors[bucket]) continue;
            await this._sweepRecoveredQueries(
              bucket,
              revalidated.filter((o) => o.bucket === bucket),
              trx,
              revalidated
            );
          }
        }
      });
    }

    return { counts, errors, persisted, opportunities: allOpportunities };
  }

  /**
   * Facts-readiness boost. For refresh opportunities whose city×service is
   * verified-sufficient in the facts bank, add WEIGHTS.factsReady to the score
   * so a well-supported rewrite can clear the global minScoreToAct floor —
   * WITHOUT lowering that floor (a weak page stays out even with facts). The
   * boost is scoped to refresh_existing_page this pass. Results are cached per
   * city::service to avoid repeated facts-bank loads. Best-effort: a facts
   * lookup failure simply yields no boost — the publish-time facts-sufficiency
   * gate still blocks unverified content, so under-boosting is the safe
   * direction.
   */
  // Actual facts readiness for one city×service — the SAME verdict
  // _applyFactsReadinessBoost uses (verdict.sufficient), cached per key by
  // the caller. False on error/unavailable (no boost will apply).
  async _factsReadyFor(service, city, cache = new Map()) {
    if (!service || !city) return false;
    const key = `${String(city).toLowerCase()}::${String(service).toLowerCase()}`;
    if (cache.has(key)) return cache.get(key);
    let ready = false;
    try {
      const factsSufficiency = require('../content/facts-sufficiency');
      const verdict = await factsSufficiency.check({
        action_type: 'refresh_existing_page',
        city,
        service,
      });
      ready = !!(verdict && verdict.applicable !== false && verdict.sufficient);
    } catch (err) {
      logger.warn(`[gsc-opp-miner] facts readiness probe failed for ${key}: ${err.message}`);
    }
    cache.set(key, ready);
    return ready;
  }

  async _applyFactsReadinessBoost(opportunities = [], factsReadyCache = new Map()) {
    // ONE readiness verdict per city::service per run (Codex r32): the
    // family subgroup selection shares this cache, so a below-floor
    // subgroup marked persistable by _factsReadyFor is guaranteed the
    // matching boost here — two independent remote-backed lookups could
    // split verdicts on a transient failure, strand the selected row under
    // the floor, and let the sweep expire its pending predecessor.
    for (const opp of opportunities) {
      if (opp.action_type !== 'refresh_existing_page') continue;
      if (!opp.city || !opp.service) continue;
      const ready = await this._factsReadyFor(opp.service, opp.city, factsReadyCache);
      if (!ready) continue;
      opp.score += WEIGHTS.factsReady;
      if (opp.score_breakdown && typeof opp.score_breakdown === 'object') {
        opp.score_breakdown.factsReady = WEIGHTS.factsReady;
      }
    }
  }

  // dedupe keys of a bucket's rows persistAll's upsert would refuse to
  // re-open (claimed / done / pending_review) — emitting those again only
  // burns per-run cap slots on rows whose status can't change. Shared by
  // the capped buckets (link_boost, answer_gap).
  async _loadOccupiedKeys(bucket) {
    const rows = await db('opportunity_queue')
      .where('bucket', bucket)
      // 'skipped' counts as occupied too: the upsert keeps an operator
      // skip sticky, so re-deriving a skipped key just burns one of the
      // LINK_BOOST_MAX_PER_RUN slots on a row persistAll re-freezes as
      // skipped — enough skipped top pages would starve the cap and no
      // new link-boost work would ever derive.
      .whereIn('status', ['claimed', 'done', 'pending_review', 'skipped'])
      .select('dedupe_key');
    return new Set(rows.map((r) => r.dedupe_key));
  }

  // ── own-page resolution helper ─────────────────────────────────────

  async _loadOwnPagesByServiceCity(since) {
    // Build the map under the same normalization that opportunity rows
    // use later, so lookups by (normalized service, normalized city)
    // match the keys here. Earlier iteration keyed on raw classifier
    // fields (r.service_category / r.city_target) — but opportunities
    // normalize 'local_intent' → null + infer city from query, so raw
    // keys mismatch normalized lookups and the map silently misses or
    // returns a wrong-segment page.
    const rows = await db('gsc_pages')
      .where('date', '>=', since)
      .select(db.raw(`${CANON_URL_SQL} as page_url`))
      .max('service_category as service_category')
      .max('city_target as city_target')
      .sum('impressions as impressions')
      .groupByRaw(CANON_URL_SQL)
      .orderBy('impressions', 'desc');
    const map = new Map();
    for (const r of rows) {
      const service = r.service_category || inferServiceFromUrl(r.page_url);
      const city = normalizeCity(r.city_target) || inferCityFromUrl(r.page_url);
      if (!service && !city) continue; // can't classify — skip rather than pollute generic bucket
      const key = ownPageKey(service, city);
      if (!map.has(key)) map.set(key, r.page_url); // first wins (orderBy impressions desc)
    }
    return map;
  }

  // A failed map leg can hide behind a healthy queries leg for WEEKS:
  // syncQueryPageMap swallows its own errors (catch → warn, no rethrow),
  // so syncDailyData reports success while gsc_query_page_map goes stale —
  // and any historical row inside the window would still "prove" coverage.
  // The domain's own gsc_queries freshness is the authoritative yardstick:
  // both legs sync the same window in the same call, so when queries have
  // advanced but the map hasn't, the gap is a sync hole. The grace absorbs
  // benign skew (GSC omits low-volume rows from the query+page breakdown,
  // so a thin domain's map can legitimately trail by a day or two).
  static QUERY_PAGE_MAP_FRESHNESS_GRACE_DAYS = 4;

  // Domains whose query→page map is present AND fresh for the window — the
  // coverage evidence behind queryDomainsCovered (no_content_yet and its
  // reachability mirror). An empty set means the map sync isn't keeping up
  // anywhere; a partial set means the missing domains' absent mappings are
  // sync holes, not content gaps (pre-push audit P1 ×2, 2026-08-12).
  async _queryPageMapCoveredDomains(since) {
    const result = await db.raw(
      `SELECT m.domain
         FROM (SELECT domain, max(date_from) AS map_max
                 FROM gsc_query_page_map
                WHERE date_from >= ?
                GROUP BY domain) m
         JOIN (SELECT domain, max(date) AS queries_max
                 FROM gsc_queries
                WHERE date >= ?
                GROUP BY domain) q
           ON q.domain = m.domain
        WHERE m.map_max >= q.queries_max - make_interval(days => ?)`,
      [since, since, GscOpportunityMiner.QUERY_PAGE_MAP_FRESHNESS_GRACE_DAYS]
    );
    const covered = new Set();
    for (const r of (result.rows || [])) {
      if (r.domain) covered.add(String(r.domain).toLowerCase());
    }
    return covered;
  }

  // Best (lowest) owned-page position per (query, DOMAIN) from TRUE
  // query→page rows. Keyed per domain, not per query: a candidate's
  // evidence must hold for every domain contributing its impressions
  // (noContentYetEmittable), and a query-wide best would let one domain
  // vouch for another. Per-page position is impression-weighted like
  // mineAnswerGap's aggregation (each stored position is already an
  // impression-level average, so a plain avg() lets a one-impression day
  // at position 1 mask a 100-impression day at 50).
  async _bestMappedPositionByQueryDomain(queries, since) {
    if (!queries.length) return new Map();
    const rows = await db('gsc_query_page_map')
      .where('date_from', '>=', since)
      .whereIn('query', queries)
      .select('query', 'domain')
      .select(db.raw(`${CANON_URL_SQL} as page_url`))
      // Per-page impressions ride along so immaterial mappings can be
      // discarded before judging served-ness (materialServingPosition).
      .sum('impressions as impressions')
      .select(db.raw('sum(position * impressions) / NULLIF(sum(impressions), 0) as page_position'))
      .groupBy('query', 'domain')
      .groupByRaw(CANON_URL_SQL);
    const pagesByKey = new Map();
    for (const r of rows) {
      if (!r.domain) continue;
      const key = mappedPositionKey(r.query, r.domain);
      if (!pagesByKey.has(key)) pagesByKey.set(key, []);
      pagesByKey.get(key).push(r);
    }
    const map = new Map();
    for (const [key, pages] of pagesByKey) {
      const pos = materialServingPosition(pages);
      if (pos != null) map.set(key, pos);
    }
    return map;
  }

  // Route identities of pages with an OPEN rewrite_title_meta action in
  // seo_actions — the older mechanism's claim on a page. null on failure
  // so the caller can fail CLOSED: without this evidence we cannot rule
  // out duplicate rewrite work.
  async _pagesOwnedByOpenSeoActions() {
    try {
      // status stays 'open' after execution — completion is recorded in
      // execution_status ('done' / 'failed' / 'manual_required'), so
      // filtering on status alone would exclude a page FOREVER once it had
      // ever been rewritten, even after its CTR regressed (audit P1). Only
      // UNFINISHED work owns a page. 'failed' and 'manual_required' are
      // finished for this purpose too: nothing is in flight, and the page
      // needs someone to act, which is exactly what this bucket does.
      const rows = await db('seo_actions')
        .where({ action_type: 'rewrite_title_meta', status: 'open' })
        .whereNotIn('execution_status', ['done', 'failed', 'manual_required'])
        .select('url');
      const out = new Set();
      for (const r of rows) {
        const id = seoActionRouteIdentity(r.url);
        if (id) out.add(id);
      }
      return out;
    } catch (err) {
      logger.warn(`[gsc-opp-miner] seo_actions ownership lookup failed: ${err.message}`);
      return null;
    }
  }

  // The mapped page a low-CTR query actually ranks with, per query — see
  // pickCtrRewriteTargetPage for the selection rule. Rows from domains
  // without FRESH map coverage are excluded: syncQueryPageMap swallows
  // per-domain failures, so a stale row could otherwise nominate an
  // obsolete page and aim an automated rewrite at the wrong URL (audit
  // P1 #7). No covered domains → empty map → every candidate fails closed
  // to do_not_publish.
  async _rankingPageByQuery(queries, since, coveredDomains = new Set()) {
    if (!queries.length || !coveredDomains.size) return new Map();
    const rows = await db('gsc_query_page_map')
      .where('date_from', '>=', since)
      .whereIn('query', queries)
      .whereRaw('lower(domain) = ANY(?)', [Array.from(coveredDomains)])
      .select('query')
      .select(db.raw(`${CANON_URL_SQL} as page_url`))
      // Per-page clicks ride along so the selected target can be held to
      // the CTR threshold on its OWN performance (ctrRewriteTargetFor),
      // and the mapped-domain set so the caller can require evidence from
      // every contributing domain.
      .select(db.raw('array_agg(DISTINCT lower(domain)) as domains'))
      .sum('clicks as clicks')
      .sum('impressions as impressions')
      .select(db.raw('sum(position * impressions) / NULLIF(sum(impressions), 0) as page_position'))
      .groupBy('query')
      .groupByRaw(CANON_URL_SQL);
    const out = new Map();
    for (const r of rows) {
      if (!out.has(r.query)) out.set(r.query, { pages: [], domains: new Set() });
      const entry = out.get(r.query);
      entry.pages.push(r);
      for (const d of (Array.isArray(r.domains) ? r.domains : [])) {
        if (d) entry.domains.add(String(d).toLowerCase());
      }
    }
    return out;
  }

  // Cross-domain tuple aggregation for representative reachability. The
  // family rows are deliberately HUB-ONLY (blog publishes are hub-only),
  // but mineStrikingDistance / mineNoContentYet / mineSeasonalRising
  // aggregate gsc_queries across every hub/spoke domain — reachability
  // must see what THEY see or a 30-hub/30-spoke rep reads as below-floor
  // here while the miner emits it, minting parallel rows for one intent.
  async _crossDomainRepTuples(queries, since) {
    const rows = await db('gsc_queries')
      .where('date', '>=', since)
      .where('is_branded', false)
      .whereIn('query', queries)
      .select('query', 'service_category', 'city_target', 'intent_type')
      // Contributing domains per tuple — the no_content_yet mirror needs
      // them to judge map coverage the way mineNoContentYet does
      // (queryDomainsCovered).
      .select(db.raw('array_agg(DISTINCT domain) as domains'))
      .sum('impressions as impressions')
      .avg('position as plain_avg_position')
      .groupBy('query', 'service_category', 'city_target', 'intent_type');
    const map = new Map();
    for (const r of rows) {
      const list = map.get(r.query) || [];
      list.push({
        impressions: parseInt(r.impressions, 10) || 0,
        plainPosition: Number(r.plain_avg_position) || 0,
        service_category: r.service_category || null,
        city_target: r.city_target || null,
        domains: Array.isArray(r.domains) ? r.domains : [],
      });
      map.set(r.query, list);
    }
    return map;
  }

  // Which of these queries would mineSeasonalRising emit right now?
  // Mirrors its admission exactly: half/full windows, (query, service,
  // city) tuple grouping, prior-window floor of minImpressionsToScore,
  // ≥50% growth. Used only for representative reachability in the family
  // bucket — the seasonal and family dedupe keys differ by construction,
  // so without this check both buckets queue posts for one intent.
  async _seasonalEmittableQueries(queries, periodDays) {
    const recentDays = Math.max(1, Math.round(periodDays / 2));
    const recentSince = sinceDate(recentDays);
    const priorSince = sinceDate(periodDays);
    const tupleKey = (q, svc, c) => `${q}\x00${svc || ''}\x00${c || ''}`;
    const [recent, prior] = await Promise.all([
      db('gsc_queries')
        .where('date', '>=', recentSince)
        .where('is_branded', false)
        .whereIn('query', queries)
        .select('query', 'service_category', 'city_target')
        .sum('impressions as impressions')
        .groupBy('query', 'service_category', 'city_target'),
      db('gsc_queries')
        .where('date', '>=', priorSince)
        .where('date', '<', recentSince)
        .where('is_branded', false)
        .whereIn('query', queries)
        .select('query', 'service_category', 'city_target')
        .sum('impressions as impressions')
        .groupBy('query', 'service_category', 'city_target'),
    ]);
    const priorMap = new Map();
    for (const p of prior) {
      priorMap.set(tupleKey(p.query, p.service_category, p.city_target), parseInt(p.impressions, 10));
    }
    const out = new Set();
    for (const r of recent) {
      const priorImp = priorMap.get(tupleKey(r.query, r.service_category, r.city_target)) || 0;
      if (priorImp < THRESHOLDS.minImpressionsToScore) continue;
      const recentImp = parseInt(r.impressions, 10);
      if ((recentImp - priorImp) / priorImp < 0.5) continue;
      // Emittable also means PERSISTABLE — mirror mineSeasonalRising's
      // scoring (position 8 anchor) against the action-aware floor, same
      // rule as the other reachability branches.
      const cand = {
        bucket: 'seasonal_rising',
        query: r.query,
        page_url: null,
        service: r.service_category || inferServiceFromQuery(r.query),
        city: normalizeCity(r.city_target) || inferCityFromQuery(r.query),
      };
      cand.action_type = actionForOpportunity(cand);
      const { total } = scoreOpportunity(cand, { position: 8, impressions: recentImp });
      if (total >= minScoreToActFor(cand.action_type)) out.add(r.query);
    }
    return out;
  }

  // ── bucket miners ──────────────────────────────────────────────────

  async mineStrikingDistance(since, ownPagesByServiceCity = new Map()) {
    const rows = await db('gsc_queries')
      .where('date', '>=', since)
      .where('is_branded', false)
      .select('query', 'service_category', 'city_target', 'intent_type')
      .sum('clicks as clicks')
      .sum('impressions as impressions')
      .avg('position as avg_position')
      .groupBy('query', 'service_category', 'city_target', 'intent_type')
      .havingRaw('avg(position) BETWEEN ? AND ?', [
        THRESHOLDS.strikingDistancePositionMin,
        THRESHOLDS.strikingDistancePositionMax,
      ])
      .havingRaw('sum(impressions) >= ?', [THRESHOLDS.minImpressionsToScore]);

    return rows.map((r) => {
      const city = normalizeCity(r.city_target) || inferCityFromQuery(r.query);
      const service = r.service_category || inferServiceFromQuery(r.query);
      // Look up with the SAME normalized service+city the map was built
      // with, so cityless/unclassified-but-inferred queries find their
      // real ranking page when one exists.
      const pageUrl = ownPagesByServiceCity.get(ownPageKey(service, city)) || null;
      const opp = {
        bucket: 'striking_distance',
        query: r.query,
        page_url: pageUrl,
        service,
        city,
        signal_metadata: {
          clicks: parseInt(r.clicks, 10),
          impressions: parseInt(r.impressions, 10),
          avg_position: parseFloat(r.avg_position),
          ctr: recomputeCtr(r.clicks, r.impressions),
          intent_type: r.intent_type,
        },
      };
      const { total, breakdown } = scoreOpportunity(opp, {
        position: opp.signal_metadata.avg_position,
        impressions: opp.signal_metadata.impressions,
      });
      opp.score = total;
      opp.score_breakdown = breakdown;
      opp.action_type = actionForOpportunity(opp);
      opp.dedupe_key = dedupeKey(opp);
      return opp;
    });
  }

  async mineCtrRewrite(since) {
    const rows = await db('gsc_queries')
      .where('date', '>=', since)
      .where('is_branded', false)
      .select('query', 'service_category', 'city_target')
      // Contributing domains — the rewrite target is trustworthy only if
      // EVERY one of them has fresh map coverage (same rule as
      // no_content_yet).
      .select(db.raw('array_agg(DISTINCT domain) as domains'))
      .sum('clicks as clicks')
      .sum('impressions as impressions')
      .avg('position as avg_position')
      .groupBy('query', 'service_category', 'city_target')
      .havingRaw('avg(position) <= ?', [THRESHOLDS.ctrRewritePositionMax])
      .havingRaw('sum(impressions) >= ?', [THRESHOLDS.ctrRewriteMinImpressions]);

    const filtered = rows.filter(
      (r) => recomputeCtr(r.clicks, r.impressions) < THRESHOLDS.ctrRewriteMaxCtr
    );
    if (!filtered.length) return [];

    // Target the page the query ACTUALLY ranks with (true query→page
    // rows), not the service+city segment's biggest page: a rewrite PR
    // must edit the URL whose snippet is losing the clicks. Three
    // independent fail-closed conditions, any of which yields no page →
    // do_not_publish: a contributing domain without FRESH map coverage
    // (stale rows could nominate an obsolete page); a contributing domain
    // that never mapped this query (partial evidence — another domain's
    // page must not stand in for it); or a selected page whose own CTR is
    // healthy (the query-level aggregate can be dragged under the
    // threshold by a weak sibling page).
    const covered = await this._queryPageMapCoveredDomains(since);
    const rankingPages = await this._rankingPageByQuery(
      filtered.map((r) => r.query), since, covered
    );
    // CROSS-QUEUE FENCE. url-intelligence diagnoses ctr_problem and
    // seo-action-generator queues rewrite_title_meta into seo_actions —
    // a second, older mechanism for this exact job. Activating this
    // bucket without arbitration would let one page collect concurrent
    // duplicate rewrite work (AGENTS.md: extend the existing mechanism,
    // never run a parallel one). The existing queue is the AUTHORITY: any
    // page with an open action there is off-limits here. Verified live,
    // not theoretical — that pipeline is dormant (last run 2026-05-24)
    // but still holds 42 open unapproved rewrites, one of which matches a
    // current target.
    const ownedBySeoActions = await this._pagesOwnedByOpenSeoActions();
    if (ownedBySeoActions === null) {
      logger.warn('[gsc-opp-miner] ctr_rewrite: seo_actions fence unavailable — bucket skipped this run');
      return [];
    }

    return filtered.map((r) => {
      const city = normalizeCity(r.city_target) || inferCityFromQuery(r.query);
      const service = r.service_category || inferServiceFromQuery(r.query);
      const mapped = rankingPages.get(r.query);
      const resolved = (queryDomainsCovered(r.domains, covered)
        && mapped
        && queryDomainsCovered(r.domains, mapped.domains))
        ? ctrRewriteTargetFor(pagesForCandidateDomains(mapped.pages, r.domains))
        : null;
      // The older seo_actions queue owns this page — yield to it.
      const pageUrl = (resolved && ownedBySeoActions.has(routeIdentity(resolved)))
        ? null
        : resolved;
      const opp = {
        bucket: 'ctr_rewrite',
        query: r.query,
        page_url: pageUrl,
        service,
        city,
        signal_metadata: {
          clicks: parseInt(r.clicks, 10),
          impressions: parseInt(r.impressions, 10),
          avg_position: parseFloat(r.avg_position),
          ctr: recomputeCtr(r.clicks, r.impressions),
        },
      };
      const { total, breakdown } = scoreOpportunity(opp, {
        position: opp.signal_metadata.avg_position,
        impressions: opp.signal_metadata.impressions,
      });
      opp.score = total;
      opp.score_breakdown = breakdown;
      opp.action_type = actionForOpportunity(opp);
      opp.dedupe_key = dedupeKey(opp);
      return opp;
    });
  }

  async mineDecayRefresh(since, priorSince) {
    const recent = await db('gsc_pages')
      .where('date', '>=', since)
      .select(db.raw(`${CANON_URL_SQL} as page_url`))
      .max('page_type as page_type')
      .max('service_category as service_category')
      .max('city_target as city_target')
      .sum('clicks as clicks')
      .sum('impressions as impressions')
      .avg('position as avg_position')
      .groupByRaw(CANON_URL_SQL);

    const priorMap = new Map();
    const prior = await db('gsc_pages')
      .where('date', '>=', priorSince)
      .where('date', '<', since)
      .select(db.raw(`${CANON_URL_SQL} as page_url`))
      .sum('clicks as clicks')
      .groupByRaw(CANON_URL_SQL);
    for (const p of prior) priorMap.set(p.page_url, parseInt(p.clicks, 10));

    const out = [];
    for (const r of recent) {
      const recentClicks = parseInt(r.clicks, 10);
      const priorClicks = priorMap.get(r.page_url) || 0;
      if (priorClicks < 5) continue; // no comparable prior
      const drop = (priorClicks - recentClicks) / priorClicks;
      if (drop < THRESHOLDS.decayMinDropPct) continue;

      const city = normalizeCity(r.city_target) || inferCityFromUrl(r.page_url);
      const service = r.service_category || inferServiceFromUrl(r.page_url);
      const opp = {
        bucket: 'decay_refresh',
        query: null,
        page_url: r.page_url,
        service,
        city,
        signal_metadata: {
          page_type: inferPageType(r.page_url, r.page_type),
          clicks_recent: recentClicks,
          clicks_prior: priorClicks,
          decay_pct: drop,
          impressions: parseInt(r.impressions, 10),
          avg_position: parseFloat(r.avg_position),
        },
      };
      const { total, breakdown } = scoreOpportunity(opp, {
        position: opp.signal_metadata.avg_position,
        impressions: opp.signal_metadata.impressions,
      });
      opp.score = total;
      opp.score_breakdown = breakdown;
      opp.action_type = actionForOpportunity(opp);
      opp.dedupe_key = dedupeKey(opp);
      out.push(opp);
    }
    return out;
  }

  async mineLocalGap(since, ownPagesByServiceCity = new Map()) {
    // {city, service} pairs with impression demand but no own page in
    // gsc_pages matching that pair.
    const queries = await db('gsc_queries')
      .where('date', '>=', since)
      .where('is_branded', false)
      .whereNotNull('city_target')
      .whereNot('city_target', 'local_intent')
      .whereNotNull('service_category')
      .select('city_target', 'service_category')
      .sum('impressions as impressions')
      .groupBy('city_target', 'service_category')
      .havingRaw('sum(impressions) >= ?', [THRESHOLDS.minImpressionsToScore]);

    const out = [];
    for (const q of queries) {
      const city = normalizeCity(q.city_target);
      const service = q.service_category;
      if (!city || !service) continue;

      // Use the normalized own-page map. Earlier iteration queried
      // gsc_pages with raw classifier values, missing pages where the
      // classification was empty in gsc_pages but resolvable via
      // inferServiceFromUrl/inferCityFromUrl. Segment-level coverage is
      // the RIGHT granularity here (unlike per-query no_content_yet): the
      // bucket asks "does a page exist for this city+service pair", so
      // any page classified to the pair genuinely answers it.
      if (ownPagesByServiceCity.get(ownPageKey(service, city))) continue;

      const opp = {
        bucket: 'local_gap',
        query: null,
        page_url: null,
        service,
        city,
        signal_metadata: {
          impressions: parseInt(q.impressions, 10),
        },
      };
      const { total, breakdown } = scoreOpportunity(opp, {
        position: 25, // assumed deep since no own page
        impressions: opp.signal_metadata.impressions,
      });
      opp.score = total;
      opp.score_breakdown = breakdown;
      opp.action_type = actionForOpportunity(opp);
      opp.dedupe_key = dedupeKey(opp);
      out.push(opp);
    }
    return out;
  }

  /**
   * aeo_gap — city×service that is persistently ABSENT from answer-engine
   * (LLM) responses and ALSO has Google search demand. Sources the new
   * seo_llm_mentions tracker. Dormant behind GATE_AEO_GAP_MINING so it can't
   * feed the autonomous publisher until enabled after the tracker matures.
   *
   * A gap qualifies only when:
   *   - the city×service was observed on ≥ AEO_GAP_MIN_DAYS distinct days and
   *     Waves was NEVER mentioned (persistent, not a one-off probe miss), and
   *   - that city×service has ≥ minImpressionsToScore GSC impressions
   *     (demand-gated — we don't chase queries nobody searches).
   * Competitor citations strengthen the gap (they're winning the answer).
   */
  async mineAeoGaps(since, ownPagesByServiceCity = new Map()) {
    if (!isEnabled('aeoGapMining')) return []; // dormant until explicitly enabled
    const minDays = Math.max(1, parseInt(process.env.AEO_GAP_MIN_DAYS || '3', 10));

    // Recent answer-engine observations joined to their managed query (city/service).
    let rows;
    try {
      rows = await db('seo_llm_mentions as m')
        .leftJoin('seo_llm_mention_queries as q', 'm.query_id', 'q.id')
        .where('m.check_date', '>=', since)
        // Honor the admin toggle: ignore history from managed queries that have
        // been deactivated (don't enqueue work the disable was meant to stop).
        // Unmanaged/legacy rows (no query_id) have no toggle, so keep them.
        .where((b) => b.whereNull('m.query_id').orWhere('q.active', true))
        .select(
          'm.query', 'm.waves_mentioned', 'm.check_date', 'm.competitors_mentioned',
          'q.city as q_city', 'q.service as q_service'
        );
    } catch (err) {
      logger.warn(`[gsc-opp-miner] aeo_gap: mentions read failed: ${err.message}`);
      return [];
    }

    const asArray = (v) => Array.isArray(v) ? v
      : (typeof v === 'string' ? (() => { try { const p = JSON.parse(v); return Array.isArray(p) ? p : []; } catch { return []; } })() : []);

    // Map a probe's managed service label onto the miner's service vocabulary.
    const SERVICE_ALIAS = { 'pest control': 'pest', 'lawn care': 'lawn', termite: 'termite', mosquito: 'mosquito', rodent: 'rodent' };
    const resolveService = (qService, query) =>
      (qService && (SERVICE_ALIAS[qService.toLowerCase()] || qService.toLowerCase())) || inferServiceFromQuery(query);

    // Group by city×service.
    const groups = new Map();
    for (const r of rows) {
      const city = normalizeCity(r.q_city) || inferCityFromQuery(r.query);
      const service = resolveService(r.q_service, r.query);
      if (!city || !service) continue;
      const key = ownPageKey(service, city);
      let g = groups.get(key);
      if (!g) { g = { city, service, days: new Set(), wavesHits: 0, competitors: new Set() }; groups.set(key, g); }
      g.days.add(String(r.check_date).slice(0, 10));
      if (r.waves_mentioned) g.wavesHits++;
      for (const c of asArray(r.competitors_mentioned)) if (c && c.name) g.competitors.add(c.name);
    }

    // GSC demand per city×service (same aggregation shape as local_gap).
    const demand = await this._gscDemandByServiceCity(since)
      .catch((err) => { logger.warn(`[gsc-opp-miner] aeo_gap: demand map failed: ${err.message}`); return new Map(); });

    const out = [];
    for (const g of groups.values()) {
      // Persistent absence: enough distinct observation days, never mentioned.
      if (g.days.size < minDays || g.wavesHits > 0) continue;
      const impressions = demand.get(ownPageKey(g.service, g.city)) || 0;
      if (impressions < THRESHOLDS.minImpressionsToScore) continue; // demand gate
      const page_url = ownPagesByServiceCity.get(ownPageKey(g.service, g.city)) || null;

      // Gap strength: more competitors winning → stronger (0.5 floor, 1.0 cap).
      const gapStrength = 0.5 + 0.5 * Math.min(1, g.competitors.size / 3);

      const opp = {
        bucket: 'aeo_gap',
        query: null,
        page_url,
        service: g.service,
        city: g.city,
        signal_metadata: {
          impressions,
          absence_days: g.days.size,
          competitors_cited: Array.from(g.competitors),
          gap_strength: Number(gapStrength.toFixed(2)),
        },
      };
      const { total, breakdown } = scoreOpportunity(opp, {
        position: 20, // assumed deep — absent from answers
        impressions,
        gapStrength,
      });
      opp.score = total;
      opp.score_breakdown = breakdown;
      opp.action_type = actionForOpportunity(opp);
      opp.dedupe_key = dedupeKey(opp);
      out.push(opp);
    }
    return out;
  }

  /**
   * answer_gap — queries a page already ranks 9–30 for (true query→page rows
   * from gsc_query_page_map, daily granularity) that the page body never
   * directly answers. One opportunity per page, action refresh_existing_page;
   * signal_metadata.unanswered_queries carries the ranked gap list into the
   * brief's gsc_signal so the refresh agent can write self-contained answer
   * blocks (see refresh-agent-config ANSWER-GAP MODE).
   *
   * Dormant behind GATE_ANSWER_GAP_MINING. Page bodies load through
   * astro-publisher (GitHub reads), so examination is capped per run
   * (ANSWER_GAP_MAX_PAGES_PER_RUN, default 10, highest gap demand first) —
   * pages beyond the cap surface on later runs as stronger gaps get
   * refreshed. Scoped to one property (ANSWER_GAP_DOMAIN, default the hub):
   * spoke URLs resolve to SHARED spoke content where a per-page answer block
   * would leak across brands — keep them out until that lane is designed.
   * A page that can't resolve to an Astro content file is skipped:
   * publishRefresh couldn't edit it anyway.
   */
  async mineAnswerGap(since) {
    if (!isEnabled('answerGapMining')) return []; // dormant until explicitly enabled
    const rawCap = Number.parseInt(process.env.ANSWER_GAP_MAX_PAGES_PER_RUN, 10);
    const maxPages = Number.isFinite(rawCap) && rawCap > 0 ? rawCap : 10;
    const domain = (process.env.ANSWER_GAP_DOMAIN || 'wavespestcontrol.com').trim().toLowerCase();

    // Lazy require (mirrors _applyFactsReadinessBoost): the miner must keep
    // mining its other buckets even if the astro-publisher module can't load.
    let astroPublisher;
    try {
      astroPublisher = require('../content-astro/astro-publisher');
    } catch (err) {
      logger.warn(`[gsc-opp-miner] answer_gap: astro-publisher unavailable: ${err.message}`);
      return [];
    }

    const rows = await db('gsc_query_page_map')
      .where('domain', domain)
      .where('date_from', '>=', since)
      .whereNotIn('query', db('gsc_queries').distinct('query').where('is_branded', true))
      .select('query')
      .select(db.raw(`${CANON_URL_SQL} as page_url`))
      .sum('clicks as clicks')
      .sum('impressions as impressions')
      .select(db.raw('sum(position * impressions) / NULLIF(sum(impressions), 0) as avg_position'))
      .groupBy('query')
      .groupByRaw(CANON_URL_SQL)
      .havingRaw('sum(impressions) >= ?', [THRESHOLDS.answerGapMinQueryImpressions])
      .havingRaw(
        'sum(position * impressions) / NULLIF(sum(impressions), 0) BETWEEN ? AND ?',
        [THRESHOLDS.answerGapPositionMin, THRESHOLDS.answerGapPositionMax]
      );

    // Group by page. Near-me/nearby queries are navigation demand, not
    // answerable questions — a "near me" heading is doorway copy, so they
    // never become answer-block candidates.
    const pages = new Map();
    for (const r of rows) {
      if (isTransactionalQuery(r.query)) continue;
      let p = pages.get(r.page_url);
      if (!p) {
        p = { page_url: r.page_url, queries: [], total_impressions: 0 };
        pages.set(r.page_url, p);
      }
      const q = {
        query: r.query,
        clicks: parseInt(r.clicks, 10),
        impressions: parseInt(r.impressions, 10),
        position: parseFloat(r.avg_position),
      };
      p.queries.push(q);
      p.total_impressions += q.impressions;
    }

    // Rotation + starvation guards (mirrors link_boost's excludeKeys):
    //   - pages whose queue row is frozen (claimed/done/pending_review/
    //     skipped) are excluded BEFORE the cap — persistAll can't re-open
    //     them, so they'd only burn cap slots run after run;
    //   - unloadable pages (not resolvable to an Astro file) don't consume
    //     the cap either — walk on down the sorted list, bounded at
    //     maxPages*3 load attempts so a pathological list can't turn into
    //     an unbounded GitHub read loop.
    // Service/city (and therefore the dedupe key) are derived from URL +
    // the page's TOP query — deterministic before the body loads, so the
    // pre-cap occupied check and the emitted row always agree on the key.
    const occupied = await this._loadOccupiedKeys('answer_gap').catch((err) => {
      logger.warn(`[gsc-opp-miner] answer_gap: occupied keys load failed: ${err.message}`);
      return new Set();
    });

    const candidates = [];
    for (const page of Array.from(pages.values())
      .sort((a, b) => b.total_impressions - a.total_impressions)) {
      page.queries.sort((a, b) => b.impressions - a.impressions);
      page.service = inferServiceFromUrl(page.page_url)
        // Blog URLs often carry no service token even when the demand
        // clearly maps to one — a null service under-scores the row
        // (localRevenueScore floor, no factsReady boost) and starves the
        // lane. City stays URL-only ON PURPOSE: a query-inferred city on a
        // non-city page would attach wrong-city facts to the refresh.
        || inferServiceFromQuery(page.queries[0].query);
      page.city = inferCityFromUrl(page.page_url);
      page.dedupe_key = dedupeKey({
        bucket: 'answer_gap', service: page.service, city: page.city, page_url: page.page_url,
      });
      if (occupied.has(page.dedupe_key)) continue;
      candidates.push(page);
    }

    const maxAttempts = maxPages * 3;
    let attempts = 0;
    let examined = 0;
    const out = [];
    for (const page of candidates) {
      if (examined >= maxPages || attempts >= maxAttempts) break;
      attempts += 1;
      let loaded = null;
      try {
        loaded = await astroPublisher.loadExistingPageBody(page.page_url);
      } catch (err) {
        logger.warn(`[gsc-opp-miner] answer_gap: body load failed for ${page.page_url}: ${err.message}`);
      }
      if (!loaded || !loaded.body) continue; // not an editable Astro page
      examined += 1;

      const { unanswered, answered_count } = classifyAnswerGapQueries(page.queries, loaded.body);
      if (!unanswered.length) continue;

      const kept = unanswered.slice(0, ANSWER_GAP_MAX_QUERIES_PER_PAGE);
      const gapImpressions = kept.reduce((s, q) => s + q.impressions, 0);
      const gapPosition = gapImpressions
        ? kept.reduce((s, q) => s + q.position * q.impressions, 0) / gapImpressions
        : null;

      const opp = {
        bucket: 'answer_gap',
        // Strongest unanswered query anchors the brief's target_keyword.
        query: kept[0].query,
        page_url: page.page_url,
        service: page.service,
        city: page.city,
        signal_metadata: {
          // `impressions` (canonical key content-brief-builder reads) = the
          // GAP demand only — impressions on the kept unanswered queries,
          // not the page's whole 9–30 footprint.
          impressions: gapImpressions,
          avg_position: gapPosition == null ? null : Number(gapPosition.toFixed(1)),
          unanswered_queries: kept,
          answered_query_count: answered_count,
          page_total_impressions_9_30: page.total_impressions,
          coverage_method: 'heading-term-coverage-v1',
        },
      };
      const { total, breakdown } = scoreOpportunity(opp, {
        position: gapPosition || 20,
        impressions: gapImpressions,
      });
      opp.score = total;
      opp.score_breakdown = breakdown;
      opp.action_type = actionForOpportunity(opp);
      opp.dedupe_key = dedupeKey(opp);
      out.push(opp);
    }
    return out;
  }

  /**
   * Summed non-branded GSC impressions per normalized city×service, keyed by
   * ownPageKey(service, city). Mirrors the local_gap aggregation so aeo_gap
   * shares the same demand definition.
   */
  async _gscDemandByServiceCity(since) {
    const rows = await db('gsc_queries')
      .where('date', '>=', since)
      .where('is_branded', false)
      .whereNotNull('city_target')
      .whereNot('city_target', 'local_intent')
      .whereNotNull('service_category')
      .select('city_target', 'service_category')
      .sum('impressions as impressions')
      .groupBy('city_target', 'service_category');
    const map = new Map();
    for (const r of rows) {
      const city = normalizeCity(r.city_target);
      const service = r.service_category;
      if (!city || !service) continue;
      map.set(ownPageKey(service, city), parseInt(r.impressions, 10) || 0);
    }
    return map;
  }

  async mineSeasonalRising(periodDays) {
    // Honor the caller's lookback window. Earlier iteration hardcoded
    // 14 / 28 days; when run-opportunity-miner.js was called with
    // --period=7 the other buckets used 7d but seasonal-rising silently
    // used a different dataset, producing inconsistent counts.
    // Half the window = recent; full window = prior baseline.
    const recentDays = Math.max(1, Math.round(periodDays / 2));
    const recentSince = sinceDate(recentDays);
    const priorSince = sinceDate(periodDays);

    const recent = await db('gsc_queries')
      .where('date', '>=', recentSince)
      .where('is_branded', false)
      .select('query', 'service_category', 'city_target')
      .sum('impressions as impressions')
      .groupBy('query', 'service_category', 'city_target');

    // Group prior baseline by the same (query, service, city) tuple as
    // the recent window — grouping by `query` alone would mix demand
    // across cities/services and either suppress legitimate localized
    // rising trends or invent false ones when one city rises while
    // others fall.
    const priorKey = (q, s, c) => `${q}\x00${s || ''}\x00${c || ''}`;
    const priorMap = new Map();
    const prior = await db('gsc_queries')
      .where('date', '>=', priorSince)
      .where('date', '<', recentSince)
      .where('is_branded', false)
      .select('query', 'service_category', 'city_target')
      .sum('impressions as impressions')
      .groupBy('query', 'service_category', 'city_target');
    for (const p of prior) {
      priorMap.set(priorKey(p.query, p.service_category, p.city_target), parseInt(p.impressions, 10));
    }

    const out = [];
    for (const r of recent) {
      const recentImp = parseInt(r.impressions, 10);
      const priorImp = priorMap.get(priorKey(r.query, r.service_category, r.city_target)) || 0;
      if (priorImp < THRESHOLDS.minImpressionsToScore) continue;
      const growth = (recentImp - priorImp) / priorImp;
      if (growth < 0.5) continue;

      const city = normalizeCity(r.city_target) || inferCityFromQuery(r.query);
      const service = r.service_category || inferServiceFromQuery(r.query);
      const opp = {
        bucket: 'seasonal_rising',
        query: r.query,
        page_url: null,
        service,
        city,
        signal_metadata: {
          // `impressions` is the canonical key EVERY other bucket writes and
          // the one content-brief-builder reads into gsc_signal. Omitting it
          // here (recent/prior only) made every seasonal_rising draft fail
          // the quality gate's gsc_signal_attached hard check — the evidence
          // existed, the gate just couldn't see it. Keep the descriptive
          // keys too; the growth story needs both windows.
          impressions: recentImp,
          impressions_recent_14d: recentImp,
          impressions_prior_14d: priorImp,
          growth_pct: growth,
        },
      };
      const { total, breakdown } = scoreOpportunity(opp, {
        position: 8,
        impressions: recentImp,
      });
      opp.score = total;
      opp.score_breakdown = breakdown;
      opp.action_type = actionForOpportunity(opp);
      opp.dedupe_key = dedupeKey(opp);
      out.push(opp);
    }
    return out;
  }

  async mineListicleFamily(since, { ownPagesByServiceCity = new Map(), periodDays = 28, answerGapPages = new Set(), inflightRefreshQueries = new Set(), inflightFamily = { blogKeys: new Set(), refreshFamilyKeys: new Set() }, familyRefreshState = new Map(), reconcileExemptions = { pages: new Set(), blogKeys: new Set(), familyKeys: new Set() }, factsReadyCache = new Map() } = {}) {
    // null familyRefreshState = the state lookup FAILED — sequencing is
    // blind, so no refresh may be emitted this run (fail closed).
    const refreshStateAvailable = familyRefreshState instanceof Map;
    // BOTH gates required: mining with the brief overlay off would persist
    // listicle_family rows whose briefs come out as ORDINARY supporting
    // blogs — the lane would look enabled while producing none of the
    // count-in-title/numbered-H2 architecture it exists to test.
    if (!isEnabled('listicleFamilyMining') || !isEnabled('listicleBriefs')) return [];
    // Grouping by (query, service, city) mirrors the other query buckets;
    // clusterListicleFamilies re-merges split classifications by token
    // identity anyway, so a variant classified under two cities still
    // contributes all its impressions to one family.
    const rows = await db('gsc_queries')
      .where('date', '>=', since)
      .where('is_branded', false)
      // Blog publishes are HUB-ONLY (hubOnlyBlogDomains in the publisher);
      // gsc_queries also holds every spoke property, and spoke-observed
      // demand must never mint a hub post it doesn't have.
      .where('domain', 'wavespestcontrol.com')
      .select('query', 'service_category', 'city_target', 'intent_type')
      .sum('impressions as impressions')
      // Impressions-weighted, matching mineAnswerGap: each stored position is
      // already an impression-level average, so a plain avg() lets a
      // one-impression day at position 1 mask a 100-impression day at 50.
      .select(db.raw('sum(position * impressions) / NULLIF(sum(impressions), 0) as avg_position'))
      // Plain average too: reachability must judge the rep by the QUERY
      // MINERS' aggregation (they use avg(position)), not the family
      // weighting — volatile rankings make the two diverge wildly.
      .avg('position as plain_avg_position')
      // intent_type included so the preserved tuples match the query
      // miners' EXACT grouping — they split by intent_type too, and a
      // 30/25 intent split leaves every miner-side group under the floor
      // even when the merged tuple clears it (Codex r15).
      .groupBy('query', 'service_category', 'city_target', 'intent_type');

    // No early return on empty fams: the end-of-mine sweep must still run
    // so stale queue rows expire when every family went ineligible.
    const allFams = clusterListicleFamilies(rows);
    // Reachability data must match the QUERY MINERS' scope: cross-domain
    // tuples (they don't filter domain) and the seasonal admission —
    // checked for EVERY VARIANT, not just the representative: the miners
    // can emit ANY variant on cross-domain totals or seasonal growth, and
    // a 30-hub/30-spoke sibling emitted beside the family blog is the same
    // competing-rows bug from the representative's angle (Codex r17).
    const reachQueries = Array.from(new Set(allFams
      .flatMap((f) => f.variants.map((v) => v.query))));
    const [crossTuples, seasonalEmittable, reachCoveredDomains] = reachQueries.length
      ? await Promise.all([
        this._crossDomainRepTuples(reachQueries, since),
        this._seasonalEmittableQueries(reachQueries, periodDays),
        this._queryPageMapCoveredDomains(since),
      ])
      : [new Map(), new Set(), new Set()];
    // Served-ness inputs for the no_content_yet mirror inside reachability
    // — same map, same aggregation, same per-domain coverage rule
    // mineNoContentYet uses.
    const reachBestMapped = reachCoveredDomains.size && reachQueries.length
      ? await this._bestMappedPositionByQueryDomain(reachQueries, since)
      : new Map();
    const fams = allFams.filter((f) => {
      const anyVariantReachable = f.variants.some((v) => listicleFamilyRepReachable(
        { ...v, tuples: crossTuples.get(v.query) || v.tuples },
        ownPagesByServiceCity,
        THRESHOLDS,
        {
          seasonalEmittable: seasonalEmittable.has(v.query),
          mappedPositions: reachBestMapped,
          mapCoveredDomains: reachCoveredDomains,
        }
      ));
      return listicleFamilyEligible(f, THRESHOLDS, { repQualifiesQueryBucket: anyVariantReachable });
    });

    // A variant is SERVED when some owned page ranks within striking
    // distance for it (best page-level weighted position ≤
    // strikingDistancePositionMax). Mere map-row EXISTENCE is deliberately
    // NOT the test: every GSC impression maps to whatever owned page
    // happened to show, so existence alone would kill nearly every family
    // and leave the lane inert. Weak-ranking coverage (page beyond
    // striking distance) is exactly the gap this bucket mines.
    const variantQueries = Array.from(new Set(fams.flatMap((f) => f.variants.map((v) => v.query))));
    const mappedRows = await db('gsc_query_page_map')
      .where('domain', 'wavespestcontrol.com')
      .where('date_from', '>=', since)
      .whereIn('query', variantQueries)
      .select('query')
      .select(db.raw(`${CANON_URL_SQL} as page_url`))
      .select(db.raw('sum(position * impressions) / NULLIF(sum(impressions), 0) as page_position'))
      .groupBy('query')
      .groupByRaw(CANON_URL_SQL)
      .havingRaw(
        'sum(position * impressions) / NULLIF(sum(impressions), 0) <= ?',
        [THRESHOLDS.strikingDistancePositionMax]
      );
    // Best (lowest-position) IN-WINDOW owned page per variant query. The
    // window filter comes BEFORE the per-query reduction: a page at
    // position 2 must not shadow a refreshable page at position 8 — the
    // reduction would keep the top-3 hit, the served filter would discard
    // it, and the family would mint a competing blog beside the in-window
    // page (Codex r17). Top-3-only queries simply have no served entry;
    // won-intent stays with the eligibility checks.
    // ALL in-window mappings per query, position-ranked — a non-editable
    // best page must not discard a still-valid editable runner-up, or the
    // family mints a blog beside a refreshable page (Codex r29).
    const servedCandidates = new Map();
    for (const r of mappedRows) {
      const pos = parseFloat(r.page_position);
      if (pos < THRESHOLDS.strikingDistancePositionMin) continue;
      if (!servedCandidates.has(r.query)) servedCandidates.set(r.query, []);
      servedCandidates.get(r.query).push({ page_url: r.page_url, position: pos });
    }
    for (const list of servedCandidates.values()) list.sort((a, b) => a.position - b.position);
    const servedBy = new Map();
    const pageCityByUrl = new Map();

    // Only EDITABLE Astro pages count as serving (same
    // loadExistingPageBody check mineAnswerGap uses): an in-window mapping
    // to a legacy/redirected URL would emit a refresh the publisher cannot
    // resolve — the attempt budget burns, the skipped row freezes, and
    // coveredByFrozen would then block the blog fallback forever (Codex
    // r25). An unresolvable page is treated as UNSERVED, so the family
    // falls through to the blog path; publisher unavailability fails the
    // same conservative direction.
    if (servedCandidates.size) {
      let astroPublisher = null;
      try {
        astroPublisher = require('../content-astro/astro-publisher');
      } catch (err) {
        logger.warn(`[gsc-opp-miner] listicle_family: astro-publisher unavailable (${err.message}) — served families skipped this run`);
      }
      // Three-way page state (Codex r25 audit): 'editable' keeps the
      // served refresh; a CONFIRMED non-Astro target ('not_editable' —
      // clean load, no body) is genuinely unserved and may fall through to
      // a blog; an I/O failure ('error', incl. publisher unavailable) must
      // NOT — a transient GitHub read minting a blog beside a live page is
      // duplicate content, so those families skip entirely this run.
      const pageState = new Map();
      // Bounded like mineAnswerGap's probes (Codex r27): each resolution is
      // one-plus GitHub reads, so an unbounded walk over a large GSC window
      // would serially hammer the API until rate limits mark the tail
      // unresolved anyway. Probe the highest-demand pages first; pages past
      // the cap stay unprobed → 'error' → their families skip this run and
      // rotate in next mine.
      const probeBudget = 25;
      // Confirmed NON-EDITABLE targets are stable (a legacy URL rarely
      // becomes an Astro page) — remember them across runs so they stop
      // consuming the probe budget and the tail can enqueue its first
      // opportunity (Codex r31). Process-local with a TTL: a restart just
      // re-probes once.
      const nonEditableCache = GscOpportunityMiner._nonEditablePages;
      const now = Date.now();
      for (const [url, exp] of nonEditableCache) {
        if (exp <= now) nonEditableCache.delete(url);
      }
      const demandByPage = new Map();
      for (const list of servedCandidates.values()) {
        for (const cand of list) {
          demandByPage.set(cand.page_url, (demandByPage.get(cand.page_url) || 0) + 1);
        }
      }
      // Pages that already CARRY family refresh rows — in flight OR
      // completed — sort behind unseen demand (Codex r28/r29): an occupied
      // page's pending row survives unprobed via the sweep exemptions, and
      // a completed one only needs probing when budget remains (the r23
      // reopen path), so the top of the budget always goes to pages that
      // have never enqueued their first opportunity.
      // Occupied = family rows OR a non-family in-flight edit
      // (answerGapPages — those served families are fenced this run
      // anyway, so probing them first wastes the budget; Codex r33).
      const pageHasRows = (pageUrl) => ((((refreshStateAvailable && familyRefreshState.get(routeIdentity(pageUrl))) || []).length > 0
        || answerGapPages.has(routeIdentity(pageUrl))) ? 1 : 0);
      // Cached non-editable pages resolve WITHOUT a probe and never enter
      // the budget. Keyed by ROUTE IDENTITY (Codex r34) so a www/slash
      // variant of a confirmed non-Astro page doesn't re-burn the budget.
      for (const url of demandByPage.keys()) {
        if (nonEditableCache.has(routeIdentity(url))) pageState.set(url, 'not_editable');
      }
      const probeOrder = Array.from(demandByPage.keys())
        .filter((url) => !pageState.has(url))
        .sort((a, b) => (pageHasRows(a) - pageHasRows(b)) || (demandByPage.get(b) - demandByPage.get(a)))
        .slice(0, probeBudget);
      for (const pageUrl of probeOrder) {
        if (!astroPublisher?.loadExistingPageBody) {
          pageState.set(pageUrl, 'error');
          continue;
        }
        try {
          const loaded = await astroPublisher.loadExistingPageBody(pageUrl, { strictRegistryErrors: true });
          pageState.set(pageUrl, loaded && loaded.body ? 'editable' : 'not_editable');
          if (!(loaded && loaded.body)) {
            nonEditableCache.set(routeIdentity(pageUrl), now + GscOpportunityMiner.NON_EDITABLE_TTL_MS);
          }
          if (loaded && loaded.body) {
            // Refresh city from the page's OWN metadata (Codex r29): local
            // blog slugs embed cities without the -fl marker URL inference
            // needs, but frontmatter service_areas_tag carries it
            // authoritatively.
            // URL city first; frontmatter only when UNAMBIGUOUS (exactly
            // one tag) — multi-area pages (and unscoped pages defaulted to
            // every area) must not arbitrarily adopt one city's facts
            // (Codex r30).
            const tags = Array.isArray(loaded.frontmatter?.service_areas_tag) ? loaded.frontmatter.service_areas_tag : [];
            pageCityByUrl.set(pageUrl, inferCityFromUrl(pageUrl)
              || (tags.length === 1 ? normalizeCity(tags[0]) : null));
          }
        } catch (err) {
          logger.warn(`[gsc-opp-miner] listicle_family: body load failed for ${pageUrl}: ${err.message}`);
          pageState.set(pageUrl, 'error');
        }
      }
      // First EDITABLE candidate per query wins; an unprobed/error page
      // encountered before any editable one fails closed (unresolved); all
      // confirmed non-editable → genuinely unserved (blog path).
      for (const [q, list] of servedCandidates.entries()) {
        let resolved = null;
        for (const cand of list) {
          const state = pageState.get(cand.page_url) || 'error';
          if (state === 'editable') { resolved = { ...cand }; break; }
          if (state === 'error') { resolved = { ...cand, unresolved: true }; break; }
          // not_editable → try the next-ranked mapping
        }
        if (resolved) servedBy.set(q, resolved);
      }
    }

    // Hubless services (empty SERVICE_HUB_LINKS entry — lawn, tree-shrub)
    // cannot pass the hub_link_present hard gate without a city-service
    // route in the body, and _internalLinksFor supplies none for a cityless
    // brief — a cityless hubless family would mine, draft, and park every
    // time. Excluding the shape at mine time is the same fail-closed
    // posture the brief builder documents ("no hub page to point at is an
    // owner call"); a statewide link target unlocks these when ruled.
    let hublessServices = null;
    try {
      const { SERVICE_HUB_LINKS } = require('../content/content-brief-builder')._internals;
      hublessServices = new Set(
        Object.entries(SERVICE_HUB_LINKS).filter(([, links]) => !links.length).map(([svc]) => svc)
      );
    } catch (err) {
      logger.warn(`[gsc-opp-miner] listicle_family: hub-link map unavailable (${err.message}) — skipping cityless families outright`);
    }

    const out = [];
    const refreshGroups = new Map();
    for (const fam of fams) {
      const { service, city } = resolveListicleFamilyServiceCity(fam, {
        canonicalize: canonicalizeServiceCategory,
        inferService: inferServiceFromQuery,
        normCity: normalizeCity,
        inferCity: inferCityFromQuery,
      });
      // No resolvable Waves service on ANY variant (classifier AND
      // inference blank — e.g. an incidental "types of fish in florida"
      // family) → skip: default revenue weight + contentGap would otherwise
      // clear the blog floor and draft an off-topic hub post. Same rule as
      // mineNoContentYet.
      if (!service) continue;

      // Served family → route to a page REFRESH, never a competing blog and
      // never a silent drop: every eligible variant is under the 50-imp
      // floor by construction, so mineStrikingDistance (which needs ≥50 per
      // query) can NEVER pick these pages up — delegation would strand
      // them. ONLY in-window (4-15) hits count as served: a two-impression
      // variant whose page ranks top-3 must not suppress a family the
      // rep/aggregate admission checks deliberately treat as NOT won —
      // those checks are the single won-intent classifier (Codex r14).
      const served = fam.variants
        .map((v) => ({ variant: v, hit: servedBy.get(v.query) }))
        .filter((s) => s.hit && s.hit.position >= THRESHOLDS.strikingDistancePositionMin)
        .sort((a, b) => a.hit.position - b.hit.position)[0] || null;
      if (served) {
        // I/O-failed page read: neither refresh (target unverified) nor
        // blog (the page may be live — duplicate content); the family
        // skips this run and self-heals next mine (Codex r25 audit). Its
        // page and blog key are EXEMPT from this run's sweep — a transient
        // GitHub failure must not retire valid queued work (Codex r28).
        if (served.hit.unresolved) {
          reconcileExemptions.pages.add(served.hit.page_url);
          reconcileExemptions.blogKeys.add(listicleFamilyDedupeKey(fam.key));
          // The FAMILY key too (r34 follow-up): the family's pending
          // refresh may live on a DIFFERENT page than the one that failed
          // to probe (GSC newly prefers page B, the row targets page A) —
          // the sweep keeps any row whose family_keys carry an unresolved
          // family, or transient I/O would expire valid queued work.
          reconcileExemptions.familyKeys.add(fam.key);
          continue;
        }
        // An in-flight non-family edit of any VARIANT query defers the
        // refresh too — same intent even when the target pages differ
        // (Codex r27).
        if (fam.variants.some((v) => inflightRefreshQueries.has(String(v.query || '').toLowerCase()))) continue;
        // NOTE the mine loop performs NO queue mutations: every stale-row
        // transition (an earlier run's blog row once a page serves the
        // intent, a refresh row whose page changed or whose family went
        // back to blog) is covered by _sweepStaleFamilyRows — a retired
        // row's key is, by definition, absent from the keys this run
        // emits, so the post-persist sweep expires it. Retiring here,
        // BEFORE persistAll, was non-atomic: a failed upsert left the old
        // work retired while its replacement never queued (Codex r15).
        // Transition deferral: the family's prior BLOG is claimed or in
        // review — finishing that work wins; the refresh waits for a
        // later mine (Codex r20).
        if (inflightFamily.blogKeys.has(listicleFamilyDedupeKey(fam.key))) continue;
        // An answer_gap refresh already targeting this page this run makes
        // a family refresh a SECOND claimable edit of the same URL (their
        // keys differ by construction) — the answer-gap brief covers the
        // unanswered queries, which are exactly these variants; the family
        // re-mines next cycle if the page still serves it, and the sweep
        // expires any stale pending family refresh meanwhile (Codex r18).
        if (answerGapPages.has(routeIdentity(served.hit.page_url))) continue;
        // Accumulate — families sharing a serving page merge into ONE
        // refresh row (emitted after the loop) so no family's demand is
        // dropped. Grouped by PAGE alone: families classified under
        // different services/cities but served by the same URL must not
        // become independently claimable rows editing one page. The
        // refresh CITY derives from the TARGET URL, never the query — a
        // Sarasota page ranking for a Bradenton-phrased family must load
        // Sarasota facts, exactly like mineAnswerGap's URL-only refresh
        // cities (Codex r27); the query-resolved city still shapes BLOGS.
        const groupId = routeIdentity(served.hit.page_url);
        let group = refreshGroups.get(groupId);
        if (!group) {
          group = { entries: [], pageUrl: served.hit.page_url };
          refreshGroups.set(groupId, group);
        }
        group.entries.push({ fam, served, service, city: pageCityByUrl.get(served.hit.page_url) ?? inferCityFromUrl(served.hit.page_url) });
        continue;
      }

      // Mirror deferral: a refresh covering this family is claimed or in
      // review — the blog transition waits for it to complete (Codex r20).
      if (inflightFamily.refreshFamilyKeys.has(fam.key)) continue;

      // An open NON-family refresh for one of this family's exact variants
      // (absent from this batch) also blocks the blog — one claimable
      // action per intent (pre-push audit r22).
      if (fam.variants.some((v) => inflightRefreshQueries.has(String(v.query || '').toLowerCase()))) continue;

      // Cityless family on a hubless service can never publish (see above).
      if (!city && (!hublessServices || hublessServices.has(service))) continue;

      const rep = fam.variants[0];
      const opp = {
        bucket: 'listicle_family',
        query: rep.query,
        page_url: null,
        service,
        city,
        signal_metadata: {
          // `impressions` is the canonical key content-brief-builder reads
          // into gsc_signal (the quality gate's gsc_signal_attached hard
          // check needs it — same lesson as seasonal_rising's key mismatch).
          impressions: fam.impressions,
          family_size: fam.variants.length,
          family_key: fam.key,
          family_queries: fam.variants.map((v) => String(v.query || '').toLowerCase()),
          specialty_topic: extractSpecialtyTopic(fam.variants.map((v) => v.query)),
          family_avg_position: Math.round(fam.position * 10) / 10,
          family_variants: fam.variants.slice(0, 5).map(({ query, impressions }) => ({ query, impressions })),
        },
      };
      const { total, breakdown } = scoreOpportunity(opp, {
        position: fam.position,
        impressions: fam.impressions,
      });
      opp.score = total;
      opp.score_breakdown = breakdown;
      opp.action_type = actionForOpportunity(opp);
      // Dedupe on the STABLE family key, not the representative query: two
      // close variants trading first place between mining runs would mint a
      // fresh dedupe_key each time and queue competing posts for one intent.
      // Service/city are omitted for the same reason (the representative's
      // classification can flip run-to-run); city tokens are part of the
      // family key itself, so distinct local intents still key apart.
      opp.dedupe_key = listicleFamilyDedupeKey(fam.key);
      out.push(opp);
    }
    for (const [pageIdentity, group] of (refreshStateAvailable ? refreshGroups.entries() : [])) {
      const pageUrl = group.pageUrl;
      // One facts contract per brief → SUBGROUPS by (service, city), each
      // with its own stable key; one subgroup emitted per page at a time,
      // rotating when the prior completes. This threads three invariants
      // that a single page-wide key could not: never two claimable rows
      // for one URL (sequencing), never a coverage demand without its
      // facts pack (subgroup purity), and no permanent starvation of a
      // minority classification (rotation past frozen keys) — Codex r22.
      const subgroups = new Map();
      for (const e of group.entries) {
        const sk = `${e.service || '_'}::${String(e.city || '_').toLowerCase()}`;
        if (!subgroups.has(sk)) subgroups.set(sk, []);
        subgroups.get(sk).push(e);
      }
      const familyRefreshFloor = minScoreToActFor('new_supporting_blog');
      const ranked = Array.from(subgroups.values())
        .map((entries) => {
          const impressions = entries.reduce((sum, e) => sum + e.fam.impressions, 0);
          const sortedEntries = entries.slice().sort((a, b) => b.fam.impressions - a.fam.impressions);
          const primaryEntry = sortedEntries[0];
          // Pre-score the would-be refresh: a subgroup that cannot clear
          // the family floor even WITH the facts boost (city-scoped rows
          // only — facts are city×service) must not be picked, or it
          // starves a lower-ranked actionable subgroup forever by being
          // selected and dropped every run (Codex r30).
          const probe = {
            bucket: 'listicle_family',
            query: primaryEntry.served.variant.query,
            page_url: pageUrl,
            service: primaryEntry.service,
            city: primaryEntry.city,
          };
          const { total } = scoreOpportunity(probe, {
            position: primaryEntry.served.hit.position,
            impressions,
          });
          return {
            baseScore: total,
            entries,
            impressions,
            city: primaryEntry.city,
            key: listicleFamilyRefreshDedupeKey(pageUrl, entries[0].service, entries[0].city, entries.map((e) => e.fam.key)),
          };
        })
        .sort((a, b) => b.impressions - a.impressions);
      // Floor check uses ACTUAL facts readiness (Codex r31): the boost only
      // ever applies when verdict.sufficient — an insufficient/erroring
      // city×service must not make a below-floor subgroup 'persistable'
      // and starve floor-clearing siblings by being picked-and-dropped.
      for (const g of ranked) {
        if (g.baseScore >= familyRefreshFloor) { g.persistable = true; continue; }
        g.persistable = !!(g.city
          && (g.baseScore + WEIGHTS.factsReady) >= familyRefreshFloor
          && await this._factsReadyFor(g.entries[0].service, g.city, factsReadyCache));
      }
      const rowsForPage = familyRefreshState.get(pageIdentity) || [];
      const frozenRows = rowsForPage.filter((r) => r.status === 'done' || r.status === 'skipped');
      const frozen = new Set(frozenRows.map((r) => r.dedupe_key));
      // A completed row whose stored family_keys is a SUPERSET of the
      // subgroup's current set already covered this work — membership
      // fluctuation (a family dropping below eligibility) must not reopen
      // it; only genuinely NEW families mint a new generation (Codex r24).
      // Coverage requires MATCHING SUBGROUP DIMENSIONS (Codex r28): a
      // reclassified family (lawn→pest correction) forms a new subgroup
      // whose refresh uses a different facts pack — an old completed row
      // under the wrong classification must not block it.
      const dimEq = (a, b) => String(a || '_').toLowerCase() === String(b || '_').toLowerCase();
      const coveredByFrozen = (g) => frozenRows.some((r) => {
        if (!dimEq(r.service, g.entries[0].service) || !dimEq(r.city, g.entries[0].city)) return false;
        const covered = Array.isArray(r.family_keys) ? r.family_keys : [];
        const current = g.entries.map((e) => e.fam.key);
        return current.length && current.every((k) => covered.includes(k));
      });
      // Prefer the subgroup whose row is ALREADY in flight (Codex r28): a
      // newly out-ranking subgroup must WAIT without discarding the active
      // one — picking it would emit neither, and the sweep would expire
      // the pending row as family_signal_gone before the runner claims it.
      const inflightKeys = new Set(rowsForPage
        .filter((r) => ['pending', 'claimed', 'pending_review'].includes(r.status))
        .map((r) => r.dedupe_key));
      const eligible = (g) => g.persistable && !frozen.has(g.key) && !coveredByFrozen(g);
      const pick = ranked.find((g) => inflightKeys.has(g.key) && eligible(g))
        || ranked.find(eligible);
      if (!pick) continue; // every subgroup already completed/dismissed
      const otherInflight = rowsForPage.some((r) => ['pending', 'claimed', 'pending_review'].includes(r.status)
        && r.dedupe_key !== pick.key);
      if (otherInflight) continue; // superseded old generation — wait; sweep retires it (revivable)
      out.push(buildListicleFamilyRefreshOpp(pick.entries));
    }

    // Catch-all reconciliation of families that exited every branch above
    // lives in _sweepStaleFamilyRows — called by mineAll AFTER a successful
    // persistAll, never here (Codex r15): sweeping pre-persistence could
    // empty the lane if the upserts then failed (rows expired, replacements
    // never landed), and the facts-readiness boost mutates refresh scores
    // post-mine, so the post-floor allowlist is only final after persist.
    return out;
  }

  // Any pending family row NOT re-emitted (and persistable) by the current
  // mine is stale — the family went ineligible (rep reached top-3, sum fell
  // under the floor, single variant left), lost its resolvable service,
  // became hubless-cityless, flipped between blog and refresh, or moved to
  // a different serving page. This sweep is the SINGLE reconciliation
  // mechanism for every such exit (the mine loop itself never mutates the
  // queue — pre-persist retirement was non-atomic), so a dead family can't
  // stay claimable for 14 days (Codex r12/r15). Revivable 'expired' as
  // always — if the signal returns, the upsert revives it. The allowlist is
  // POST-floor AND post-facts-boost: a candidate that will not survive
  // persistAll must not protect a stale higher-score row (pre-push audit).
  // Gates-off or a thrown family mine must NOT sweep (an empty bucket then
  // means "didn't run", not "no signal") — mineAll enforces both.
  // The pages another bucket's refresh will ACTUALLY occupy this batch:
  // floor-cleared (evaluated post-facts-boost, which reachability runs too
  // early to see — Codex r19) AND not aimed at a frozen row. A candidate
  // whose dedupe row is already done/skipped lands nothing (the upsert's
  // WHERE guard refuses frozen rows), so letting it suppress the family
  // refresh would strand the distinct family demand indefinitely (Codex
  // r20). claimed/pending_review rows are NOT excluded — their edit is in
  // flight, and yielding to it is exactly right. Fail-soft: a lookup error
  // keeps every candidate (the pre-r20 behavior).
  // Every same-page EDITING action arbitrates — rewrite_title_meta
  // (ctr_rewrite) edits the same Astro file a family refresh would, so
  // overlapping PRs conflict just like two refreshes (Codex r26).
  static PAGE_EDITING_ACTIONS = ['refresh_existing_page', 'rewrite_title_meta'];

  async _arbitratedRefreshPages(batch = []) {
    const candidates = batch.filter((o) => o.bucket !== 'listicle_family'
      && GscOpportunityMiner.PAGE_EDITING_ACTIONS.includes(o.action_type)
      && o.page_url
      && o.score >= minScoreToActFor(o.action_type));
    let frozenKeys = new Set();
    try {
      if (candidates.length) {
        const rows = await db('opportunity_queue')
          .whereIn('dedupe_key', candidates.map((o) => o.dedupe_key))
          .whereIn('status', ['done', 'skipped'])
          .select('dedupe_key');
        frozenKeys = new Set(rows.map((r) => r.dedupe_key));
      }
    } catch (err) {
      logger.warn(`[gsc-opp-miner] refresh arbitration frozen-key lookup failed: ${err.message}`);
    }
    const live = candidates.filter((o) => !frozenKeys.has(o.dedupe_key));
    // EVERY query the refresh will edit — an answer_gap candidate anchors
    // its strongest unanswered query in o.query but edits all of
    // unanswered_queries; a secondary one can be a family's variant
    // (Codex r24).
    const liveQueries = new Set();
    for (const o of live) {
      if (o.query) liveQueries.add(String(o.query).toLowerCase());
      for (const u of (Array.isArray(o.signal_metadata?.unanswered_queries) ? o.signal_metadata.unanswered_queries : [])) {
        if (u && u.query) liveQueries.add(String(u.query).toLowerCase());
      }
    }
    return {
      pages: new Set(live.map((o) => routeIdentity(o.page_url))),
      // A family BLOG whose variant one of these refreshes targets is the
      // same intent under a different key — a boosted ordinary refresh and
      // a family blog must not both persist (Codex r21).
      queries: liveQueries,
    };
  }

  // Does this family opp lose page/query arbitration to another bucket?
  static familyOppYields(o, arbitrated) {
    if (o.bucket !== 'listicle_family') return false;
    if (o.action_type === 'refresh_existing_page') {
      if (arbitrated.pages.has(routeIdentity(o.page_url))) return true;
      // Query-level too (Codex r27): an ordinary same-query edit can
      // target a DIFFERENT page (own-page heuristic vs exact mapping) —
      // same intent, two claimable edits.
      const queries = Array.isArray(o.signal_metadata?.family_queries) ? o.signal_metadata.family_queries : [];
      return [o.query, ...queries].some((q) => q && arbitrated.queries.has(String(q).toLowerCase()));
    }
    if (o.action_type === 'new_supporting_blog') {
      // family_queries is the COMPLETE set; family_variants is capped at 5
      // for brief metadata and only serves as a legacy fallback.
      const queries = Array.isArray(o.signal_metadata?.family_queries)
        ? o.signal_metadata.family_queries
        : (Array.isArray(o.signal_metadata?.family_variants) ? o.signal_metadata.family_variants.map((v) => v.query) : []);
      return [o.query, ...queries]
        .some((q) => q && arbitrated.queries.has(String(q).toLowerCase()));
    }
    return false;
  }

  // TOCTOU guard for blog↔refresh transitions (pre-push audit r22): the
  // mine's in-flight reads happen OUTSIDE the persist transaction, so a
  // worker can claim a predecessor row in between. Inside the transaction,
  // lock every family row (claimNext's FOR UPDATE SKIP LOCKED then cannot
  // grab one mid-transition) and re-read statuses as the authority: any
  // family opp whose transition-predecessor turned claimed/pending_review
  // since the mine is DROPPED this run (same deferral semantics as r20).
  async _revalidateFamilyBatch(trx, opportunities = [], { lockEvenIfEmpty = false } = {}) {
    const hasFamily = opportunities.some((o) => o.bucket === 'listicle_family');
    // The lock must cover every case the SWEEP runs in — an empty family
    // batch still expires pending rows, and an unlocked expiry can race a
    // concurrent claim (Codex r25 audit). It must ALSO cover any batch
    // carrying page-editing actions (r34 follow-up): refresh-audit's
    // recheck-under-lock is only sound if a concurrent miner persist of
    // ordinary refresh/rewrite rows cannot commit between that recheck
    // and its insert — so every page-edit persist serializes here, gated
    // or not.
    const hasPageEdit = opportunities.some((o) => GscOpportunityMiner.PAGE_EDITING_ACTIONS.includes(o.action_type));
    if (!hasFamily && !hasPageEdit && !lockEvenIfEmpty) return opportunities;
    // Advisory transaction lock FIRST (Codex r27): FOR UPDATE only locks
    // rows that exist, so two overlapping mines could both see no row for
    // a fresh page and insert competing first refreshes. Every family
    // persist path serializes here; the second transaction's re-reads then
    // see the first's committed rows and defer.
    await trx.raw("SELECT pg_advisory_xact_lock(hashtext('opportunity_page_edit'))");
    const rows = await trx('opportunity_queue')
      .where({ bucket: 'listicle_family' })
      .forUpdate()
      .select('dedupe_key', 'action_type', 'status', 'page_url', trx.raw("signal_metadata->'family_keys' as family_keys"));
    if (!hasFamily) return opportunities; // lock taken (sweep / non-family page edits); nothing to filter
    // One-edit-per-page under the LOCK (Codex r25 audit): a concurrent
    // mine can insert a different-subgroup refresh for the same page after
    // the pre-mine state read — with the rows now locked and re-read, a
    // family refresh whose page carries any OTHER in-flight family refresh
    // key defers this run.
    const inflightPageKeys = new Map();
    for (const r of rows) {
      if (r.action_type !== 'refresh_existing_page' || !r.page_url) continue;
      if (!['pending', 'claimed', 'pending_review'].includes(r.status)) continue;
      const rid = routeIdentity(r.page_url);
      if (!inflightPageKeys.has(rid)) inflightPageKeys.set(rid, new Set());
      inflightPageKeys.get(rid).add(r.dedupe_key);
    }
    const inflight = rows.filter((r) => r.status === 'claimed' || r.status === 'pending_review');
    const inflightBlogKeys = new Set(inflight
      .filter((r) => r.action_type === 'new_supporting_blog')
      .map((r) => r.dedupe_key));
    const inflightRefreshFamilyKeys = new Set(inflight
      .flatMap((r) => (Array.isArray(r.family_keys) ? r.family_keys : [])));
    // Non-family conflicts are ALSO re-read inside the transaction: the
    // mine's fence query ran pre-transaction, and a concurrent producer
    // (refresh-audit, a manual mine) can enqueue/revive a non-family
    // refresh in between. READ COMMITTED sees everything committed by now,
    // narrowing the race to truly-simultaneous uncommitted writes — full
    // serialization would need a shared advisory lock adopted by EVERY
    // producer, which is beyond this lane (pre-push audit r24).
    const nonFamily = await trx('opportunity_queue')
      .whereIn('action_type', GscOpportunityMiner.PAGE_EDITING_ACTIONS)
      .whereNot('bucket', 'listicle_family')
      .whereIn('status', ['pending', 'claimed', 'pending_review'])
      .whereNotNull('page_url')
      .select('page_url', 'query', trx.raw("signal_metadata->'unanswered_queries' as unanswered_queries"));
    const conflictPages = new Set(nonFamily.map((r) => routeIdentity(r.page_url)));
    const conflictQueries = new Set();
    for (const r of nonFamily) {
      if (r.query) conflictQueries.add(String(r.query).toLowerCase());
      for (const u of (Array.isArray(r.unanswered_queries) ? r.unanswered_queries : [])) {
        if (u && u.query) conflictQueries.add(String(u.query).toLowerCase());
      }
    }
    return opportunities.filter((o) => {
      if (o.bucket !== 'listicle_family') return true;
      if (o.action_type === 'refresh_existing_page') {
        if (conflictPages.has(routeIdentity(o.page_url))) return false;
        // Same-query conflicts too (Codex r29): a non-family edit of a
        // family query on a DIFFERENT page that committed since the fence
        // read is the same intent — defer the family refresh.
        const fqs = Array.isArray(o.signal_metadata?.family_queries) ? o.signal_metadata.family_queries : [];
        if ([o.query, ...fqs].some((q) => q && conflictQueries.has(String(q).toLowerCase()))) return false;
        const pageKeys = inflightPageKeys.get(routeIdentity(o.page_url));
        if (pageKeys && Array.from(pageKeys).some((k) => k !== o.dedupe_key)) return false;
        const keys = Array.isArray(o.signal_metadata?.family_keys) ? o.signal_metadata.family_keys : [];
        return !keys.some((k) => inflightBlogKeys.has(listicleFamilyDedupeKey(k)));
      }
      if (o.action_type === 'new_supporting_blog') {
        const k = o.signal_metadata?.family_key;
        if (k && inflightRefreshFamilyKeys.has(k)) return false;
        const queries = Array.isArray(o.signal_metadata?.family_queries) ? o.signal_metadata.family_queries : [];
        return ![o.query, ...queries].some((q) => q && conflictQueries.has(String(q).toLowerCase()));
      }
      return true;
    });
  }

  async _sweepStaleFamilyRows(familyOpps = [], batch = [], trx = null, exemptions = { pages: new Set(), blogKeys: new Set(), familyKeys: new Set() }) {
    const runner = trx || db;
    try {
      // (Errors re-throw under a transaction — see catch below.)
      // Mirror persistAll's arbitration: a family opp that yielded never
      // persisted, so its key must not protect a stale pending row either.
      const arbitrated = await this._arbitratedRefreshPages(batch);
      const familyFloorActions = ['new_supporting_blog', 'refresh_existing_page'];
      const persistableKeys = familyOpps
        .filter((o) => !GscOpportunityMiner.familyOppYields(o, arbitrated))
        .filter((o) => o.score >= (familyFloorActions.includes(o.action_type)
          ? minScoreToActFor('new_supporting_blog')
          : minScoreToActFor(o.action_type)))
        .map((o) => o.dedupe_key);
      // Exemptions match by ROUTE IDENTITY, not the raw string (Codex r34):
      // a stored row minted from a www/slash variant of the probe-failed
      // page must keep its exemption too.
      const exemptIdentities = Array.from(new Set(Array.from(exemptions.pages || []).map(routeIdentity).filter(Boolean)));
      let sweep = runner('opportunity_queue')
        .where({ bucket: 'listicle_family', status: 'pending' })
        .whereNotIn('dedupe_key', [...persistableKeys, ...Array.from(exemptions.blogKeys || [])]);
      if (exemptIdentities.length) {
        // Probe-failed pages keep their pending rows this run.
        sweep = sweep.where(function pageExemption() {
          this.whereNull('page_url').orWhereRaw(
            `${ROUTE_IDENTITY_SQL} NOT IN (${exemptIdentities.map(() => '?').join(', ')})`,
            exemptIdentities
          );
        });
      }
      // A probe-failed FAMILY keeps its pending rows wherever they live
      // (r34 follow-up): the family's existing refresh may target a
      // DIFFERENT page than the one that failed to probe, so the page
      // exemption alone would expire it as family_signal_gone on
      // transient I/O. jsonb_exists (not the ?-operators) — a literal '?'
      // in knex raw collides with bind placeholders.
      const exemptFamilyKeys = Array.from(exemptions.familyKeys || []);
      if (exemptFamilyKeys.length) {
        sweep = sweep.whereNot(function familyKeyExemption() {
          for (const key of exemptFamilyKeys) {
            this.orWhereRaw("jsonb_exists(coalesce(signal_metadata->'family_keys', '[]'::jsonb), ?)", [key]);
          }
        });
      }
      await sweep.update({ status: 'expired', skip_reason: 'family_signal_gone', updated_at: new Date() });
    } catch (err) {
      // Inside mineAll's transaction the sweep is load-bearing: swallowing
      // a failure would leave old and replacement rows both claimable (and
      // a Postgres statement error aborts the transaction anyway) — roll
      // the whole persist back and surface the failed mine. Fail-soft only
      // for non-transactional callers (pre-push audit r22).
      if (trx) throw err;
      logger.warn(`[gsc-opp-miner] listicle_family: stale-family sweep failed: ${err.message}`);
    }
  }

  async mineNoContentYet(since) {
    // Queries with impressions but no owned page USEFULLY ranking for them
    // — served-ness on TRUE query→page rows, not classification overlap.
    // Two earlier iterations both broke in opposite directions: raw
    // service_category = '' predicates matched nothing (over-emitting for
    // covered topics), then the service+city own-page map check marked a
    // whole segment covered when ANY page shared the classification —
    // with 28d of cross-property data every segment has some page, so the
    // bucket emitted ZERO rows all-time (verified prod 2026-08-11).
    // noContentYetMapEmittable is the corrected test; the reachability mirror
    // in listicleFamilyRepReachable applies the same one.
    const queries = await db('gsc_queries')
      .where('date', '>=', since)
      .where('is_branded', false)
      .select('query', 'service_category', 'city_target', 'intent_type')
      // Contributing domains ride along so the served-check can require
      // map coverage from each of them (queryDomainsCovered).
      .select(db.raw('array_agg(DISTINCT domain) as domains'))
      .sum('impressions as impressions')
      .avg('position as avg_position')
      .groupBy('query', 'service_category', 'city_target', 'intent_type')
      .havingRaw('sum(impressions) >= ?', [THRESHOLDS.minImpressionsToScore])
      .havingRaw('avg(position) > ?', [THRESHOLDS.strikingDistancePositionMax]);

    const candidates = [];
    for (const q of queries) {
      const city = normalizeCity(q.city_target) || inferCityFromQuery(q.query);
      const service = q.service_category || inferServiceFromQuery(q.query);
      if (!service) continue;
      candidates.push({ q, service, city });
    }
    if (!candidates.length) return [];

    // Fail CLOSED on missing map coverage: "empty means the check didn't
    // run, not that nothing is served" — emitting unchecked candidates
    // would flood the queue with rows for already-served topics. Coverage
    // is judged PER CONTRIBUTING DOMAIN (queryDomainsCovered): map syncs
    // fail independently per domain, so one domain's rows must not vouch
    // for another domain's absences.
    const covered = await this._queryPageMapCoveredDomains(since);
    if (!covered.size) {
      logger.warn('[gsc-opp-miner] no_content_yet: gsc_query_page_map empty for window — bucket skipped this run');
      return [];
    }
    const bestMapped = await this._bestMappedPositionByQueryDomain(
      candidates.map((c) => c.q.query), since
    );

    let uncovered = 0;
    const out = [];
    for (const { q, service, city } of candidates) {
      if (!queryDomainsCovered(q.domains, covered)) { uncovered += 1; continue; }
      // Evidence per CONTRIBUTING DOMAIN — every one must map this query
      // to a weakly-ranking page (see noContentYetEmittable).
      const domainPositions = (Array.isArray(q.domains) ? q.domains : [])
        .map((d) => bestMapped.get(mappedPositionKey(q.query, d)) ?? null);
      if (!noContentYetEmittable(domainPositions)) continue;

      const opp = {
        bucket: 'no_content_yet',
        query: q.query,
        page_url: null,
        service,
        city,
        signal_metadata: {
          impressions: parseInt(q.impressions, 10),
          avg_position: parseFloat(q.avg_position),
          intent_type: q.intent_type,
        },
      };
      const { total, breakdown } = scoreOpportunity(opp, {
        position: opp.signal_metadata.avg_position,
        impressions: opp.signal_metadata.impressions,
      });
      opp.score = total;
      opp.score_breakdown = breakdown;
      opp.action_type = actionForOpportunity(opp);
      opp.dedupe_key = dedupeKey(opp);
      out.push(opp);
    }
    if (uncovered) {
      logger.warn(`[gsc-opp-miner] no_content_yet: ${uncovered} candidate(s) skipped — a contributing domain has no in-window query→page map rows`);
    }
    return out;
  }

  // ── persistence ────────────────────────────────────────────────────

  // persistAll is purely ADDITIVE. Every retirement lives in the
  // canonical-mine sweeps (_sweepRecoveredQueries / _sweepStaleFamilyRows)
  // so a manual short-window run can never destroy queued work.
  async persistAll(opportunities, trx = null) {
    const runner = trx || db;
    if (!opportunities.length) return 0;
    let count = 0;
    const now = new Date();
    const expiresAt = new Date(Date.now() + 14 * 86400_000);

    // One edit per page/intent per batch — see _arbitratedRefreshPages
    // and familyOppYields (family refreshes yield by PAGE, family blogs
    // by QUERY intent).
    const arbitrated = await this._arbitratedRefreshPages(opportunities);
    const admitted = opportunities.filter((o) => !GscOpportunityMiner.familyOppYields(o, arbitrated));

    // Group by dedupe_key, keep highest-score entry per key.
    const winners = new Map();
    for (const o of admitted) {
      const existing = winners.get(o.dedupe_key);
      if (!existing || o.score > existing.score) winners.set(o.dedupe_key, o);
    }

    for (const o of winners.values()) {
      // Gate at the scoring-config threshold so the queue only holds rows
      // worth acting on — action-aware: new_supporting_blog uses the lower
      // blog floor, everything else the global one. mineAll's return still
      // exposes every candidate (including the dropped ones) so calibration
      // can see why the cut landed where it did. One family exception:
      // listicle_family rows keep the BLOG floor even when routed as a page
      // refresh — the same aggregated sub-50-imp demand admitted as a blog
      // at 45 must not be discarded for taking the SAFER page-refresh
      // route; the global 75 floor calibrates ordinary refresh rows built
      // from single ≥50-imp queries, which family sums rarely reach.
      // Bounded to the lane's two intended actions: a demoted family row
      // (do_not_publish, or a rerouted city-service action) must NOT ride
      // the blog floor into the queue.
      const scoreFloor = persistFloorFor(o);
      if (o.score < scoreFloor) {
        // Rollout hygiene for the near-me demotion: a previously persisted
        // new_supporting_blog row shares this candidate's dedupe_key, but a
        // demoted candidate dropped here never reaches the ON CONFLICT
        // upsert — so the stale pending blog action would stay claimable
        // and burn the runner daily. Expire it explicitly. Fail-soft: a
        // cleanup error must never abort the mining pass.
        if (isTransactionalQuery(o.query)) {
          try {
            await runner('opportunity_queue')
              .where({ dedupe_key: o.dedupe_key, status: 'pending', action_type: 'new_supporting_blog' })
              .update({ status: 'skipped', skip_reason: 'transactional_query_not_blog_material', updated_at: new Date() });
          } catch (err) {
            logger.warn(`[gsc-opp-miner] stale near-me row cleanup failed (${o.dedupe_key}): ${err.message}`);
          }
        }
        continue;
      }
      const row = {
        bucket: o.bucket,
        action_type: o.action_type,
        query: o.query || null,
        page_url: o.page_url || null,
        service: o.service || null,
        city: o.city || null,
        score: o.score,
        score_breakdown: JSON.stringify(o.score_breakdown),
        signal_metadata: JSON.stringify(o.signal_metadata),
        status: 'pending',
        mined_at: now,
        expires_at: expiresAt,
        dedupe_key: o.dedupe_key,
      };

      // ON CONFLICT (dedupe_key) DO UPDATE — refreshes score + mined_at and
      // revives the row to pending, but ONLY for mutable rows: the WHERE
      // guard skips claimed, done, pending_review, and skipped rows
      // ENTIRELY, leaving score/metadata/identity exactly as processed. A
      // claimed row must not change beneath its worker, done/reviewed rows
      // are records of what WAS processed (a listicle_family representative
      // swap would otherwise pair old identity with new provenance), and
      // skipped is sticky by contract: it records a decision — an operator
      // dismissal (manual_dismiss:*), a human-closed PR
      // (astro_pr_closed_unmerged), an exhausted attempt budget — and the
      // daily mine re-emitting the same dedupe_key must not overturn it
      // (it did: every dismissal came back the next morning and burned a
      // fresh runner dispatch). Deliberate contrast: 'expired' DOES revive
      // — expiry just means the row aged out unclaimed, so a fresh mine of
      // the same signal is a fresh opportunity with a fresh expires_at.
      // Operator paths that legitimately resurrect a skipped row (review
      // requeue, intercept re-seed) write status='pending' directly and
      // are unaffected by this guard.
      const result = await runner.raw(
        `INSERT INTO opportunity_queue
           (bucket, action_type, query, page_url, service, city,
            score, score_breakdown, signal_metadata, status,
            mined_at, expires_at, dedupe_key, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?::jsonb, ?::jsonb, ?, ?, ?, ?, now(), now())
         ON CONFLICT (dedupe_key) DO UPDATE
           SET score = EXCLUDED.score,
               score_breakdown = EXCLUDED.score_breakdown,
               -- Preserve the runner's one-shot gate_retry marker across the
               -- wholesale metadata refresh: a first hard-gate failure defers
               -- the row with feedback recorded here, and the morning miner
               -- runs BEFORE the engine — dropping the marker would turn the
               -- intended single feedback-informed redraft into repeated
               -- blind first attempts. jsonb_exists(), not the question-mark
               -- operator — and this comment must never contain that literal
               -- character either: knex counts binding placeholders across
               -- the WHOLE raw string, SQL comments included, so a stray one
               -- here breaks every daily mine with a binding-count error
               -- (shipped 07-30, caught 07-31: "Expected 13 bindings, saw
               -- 15" — the two extras were in this very comment).
               signal_metadata = CASE
                 WHEN jsonb_exists(COALESCE(opportunity_queue.signal_metadata, '{}'::jsonb), 'gate_retry')
                 THEN EXCLUDED.signal_metadata
                      || jsonb_build_object('gate_retry', opportunity_queue.signal_metadata->'gate_retry')
                 ELSE EXCLUDED.signal_metadata
               END,
               mined_at = EXCLUDED.mined_at,
               expires_at = EXCLUDED.expires_at,
               action_type = EXCLUDED.action_type,
               -- Identity refresh: for every OTHER bucket these are no-ops
               -- (their dedupe keys EMBED service::city::query, so a conflict
               -- implies identical values) — but listicle_family keys on the
               -- stable family token-set precisely so close variants can
               -- trade the representative slot between runs. Without this,
               -- a pending family row kept the OLD target keyword and
               -- classification while its score/metadata came from the new
               -- representative (internally inconsistent; facts checks could
               -- run against a stale service/city).
               query = EXCLUDED.query,
               service = EXCLUDED.service,
               city = EXCLUDED.city,
               status = 'pending',
               -- A revived row is pending again — a lingering automatic
               -- retirement reason (family_signal_gone) would read as
               -- false provenance on operator/audit surfaces.
               skip_reason = NULL,
               updated_at = now()
           -- Frozen rows (claimed / done / pending_review / skipped) skip
           -- this update ENTIRELY — not just identity: score, breakdown,
           -- metadata, action, and timestamps all derive from the CURRENT
           -- representative, and pairing them with a frozen row's processed
           -- identity would corrupt the record (and mutate a claimed row
           -- beneath its worker).
           WHERE opportunity_queue.status NOT IN ('claimed', 'done', 'pending_review', 'skipped')
        `,
        [
          row.bucket, row.action_type, row.query, row.page_url, row.service, row.city,
          row.score, row.score_breakdown, row.signal_metadata, row.status,
          row.mined_at, row.expires_at, row.dedupe_key,
        ]
      );
      // ?? not || — a frozen-row conflict legitimately reports rowCount 0
      // (the WHERE guard skipped the update) and must not count as persisted.
      count += result.rowCount ?? 0;
    }
    return count;
  }

  /**
   * Companion keys that must survive a retirement pass: the ones the
   * current batch stands behind, UNION the ones live queue rows do.
   *
   * The batch alone is not enough. A link_boost key carries no query and
   * no source bucket, so it is shared across parents — and a parent can be
   * absent from this batch for reasons unrelated to its validity: its
   * bucket errored this run, or its signal dipped for a window. Reading
   * live page-editing rows straight from the queue covers both without
   * needing to know which bucket failed.
   *
   * retiringKeys are excluded: those rows are still 'pending' right now,
   * so each would otherwise contribute its OWN companion key and shield
   * it — retiring the parent while its companion stayed claimable, the
   * exact leak this protection exists to prevent.
   *
   * Fails CLOSED on a query error by returning null: callers skip
   * companion retirement entirely rather than expiring everything.
   */
  async _companionProtection(runner, opportunities = [], retiringKeys = new Set()) {
    const keys = companionProtectionKeys(opportunities);
    try {
      let liveQ = runner('opportunity_queue')
        .whereIn('status', ['pending', 'claimed', 'pending_review'])
        .whereIn('action_type', GscOpportunityMiner.PAGE_EDITING_ACTIONS)
        .whereNotNull('page_url');
      if (retiringKeys.size) liveQ = liveQ.whereNotIn('dedupe_key', Array.from(retiringKeys));
      const live = await liveQ.select('page_url', 'service', 'city');
      for (const r of live) {
        keys.add(dedupeKey({
          bucket: 'link_boost', service: r.service, city: r.city, page_url: r.page_url,
        }));
      }
      return keys;
    } catch (err) {
      logger.warn(`[gsc-opp-miner] companion protection lookup failed (${err.message}) — companion retirement suppressed this run`);
      return null;
    }
  }

  /**
   * THE retirement mechanism for the query buckets this PR revives — one
   * sweep, no siblings (AGENTS.md). Any pending row whose dedupe key the
   * current mine did not re-emit as persistable is stale evidence: the
   * signal recovered (CTR climbed back, impressions or position left the
   * gates), the query became served, the map evidence stopped being
   * trustworthy, or the target page MOVED (a ctr_rewrite key embeds
   * page_url, so a moved target retires the old key by construction).
   * Left alone, those rows stay claimable for the full 14 days and act on
   * evidence the mine has already withdrawn — optimizing a page that now
   * performs fine, or worse, publishing a page for a query an owned page
   * has since started serving.
   *
   * Mirrors the family sweep's contract: the CALLER guards on a successful
   * bucket run (an errored bucket's empty output means "didn't run", not
   * "no signal"), only PENDING rows are touched, and retirement is
   * 'expired' — revivable the moment the signal returns. Companions follow
   * their parent, minus anything the current batch still stands behind.
   */
  async _sweepRecoveredQueries(bucket, bucketOpportunities = [], trx = null, fullBatch = null) {
    const runner = trx || db;
    // Keyed on persistable DEDUPE KEYS, not query strings: one query can
    // produce several (query, service, city, intent) candidates, so a
    // surviving tuple would otherwise shelter a sibling tuple whose
    // evidence disappeared (audit P1). Below-floor candidates are not
    // live — persistAll drops them, so the stored row keeps a stale
    // higher score.
    const liveKeys = new Set(
      bucketOpportunities.filter(isPersistable).map((o) => o.dedupe_key).filter(Boolean)
    );
    try {
      // FOR UPDATE: claimNext can otherwise claim a row between the select
      // and the update — the guarded parent update then skips it while its
      // companion is still expired from the stale snapshot. Locking also
      // lets the update key on the LOCKED rows themselves rather than
      // re-running the predicate against a moved target (audit P1).
      let staleQ = runner('opportunity_queue')
        .where({ bucket, status: 'pending' });
      if (liveKeys.size) staleQ = staleQ.whereNotIn('dedupe_key', Array.from(liveKeys));
      const stale = await staleQ.select('dedupe_key', 'page_url', 'service', 'city').forUpdate();
      if (!stale.length) return;

      // Parents and companions are locked BEFORE either is expired.
      // Expiring parents first left a window where claimNext (FOR UPDATE
      // SKIP LOCKED) could claim a companion whose parent was already
      // gone: the status='pending' filter then skipped it and obsolete
      // link work proceeded against a retired parent (audit P1).
      //
      // Protection must see the COMPLETE batch — a live decay_refresh
      // parent targeting a stale rewrite's page shares its companion key,
      // and the single-bucket list cannot see it.
      const protectedKeys = await this._companionProtection(
        runner, fullBatch || bucketOpportunities, new Set(stale.map((r) => r.dedupe_key))
      );
      const companionKeys = protectedKeys === null ? [] : stale
        .filter((r) => r.page_url)
        .map((r) => dedupeKey({
          bucket: 'link_boost', service: r.service, city: r.city, page_url: r.page_url,
        }))
        .filter((k) => !protectedKeys.has(k));
      const lockedCompanions = companionKeys.length
        ? await runner('opportunity_queue')
          .where({ bucket: 'link_boost', status: 'pending' })
          .whereIn('dedupe_key', companionKeys)
          .select('dedupe_key')
          .forUpdate()
        : [];

      await runner('opportunity_queue')
        .whereIn('dedupe_key', stale.map((r) => r.dedupe_key))
        .update({
          status: 'expired', skip_reason: `${bucket}_signal_recovered`, updated_at: new Date(),
        });
      if (lockedCompanions.length) {
        await runner('opportunity_queue')
          .whereIn('dedupe_key', lockedCompanions.map((r) => r.dedupe_key))
          .update({
            status: 'expired', skip_reason: `${bucket}_signal_recovered`, updated_at: new Date(),
          });
      }
      logger.info(`[gsc-opp-miner] ${bucket} sweep: ${stale.length} recovered-query row(s) expired`);
    } catch (err) {
      // Inside the persist transaction the caller owns rollback semantics;
      // rethrow so a failed sweep cannot leave half-reconciled state.
      logger.warn(`[gsc-opp-miner] ${bucket} recovered-query sweep failed: ${err.message}`);
      throw err;
    }
  }

  async expireStale() {
    const result = await db('opportunity_queue')
      .where('status', 'pending')
      .where('expires_at', '<', new Date())
      .update({ status: 'expired', updated_at: new Date() });
    return result;
  }
}

function sinceDate(days) {
  // Railway runs UTC, but every other date filter in this portal lives
  // in America/New_York (AGENTS.md). Using toISOString().slice(0,10)
  // here would advance the GSC window one day early between 8pm ET and
  // midnight ET. Pin to ET-day boundaries.
  return etDateString(addETDays(new Date(), -days));
}

module.exports = new GscOpportunityMiner();
module.exports.GscOpportunityMiner = GscOpportunityMiner;
// Exposed for unit tests — pure functions, no DB.
module.exports._internals = {
  normalizeCity,
  inferServiceFromQuery,
  inferServiceFromUrl,
  inferCityFromUrl,
  inferCityFromQuery,
  canonicalizePageUrl,
  inferPageType,
  recomputeCtr,
  gscOpportunityScore,
  localRevenueScore,
  conversionIntentScore,
  impressionsBoost,
  actionForOpportunity,
  ownPageKey,
  dedupeKey,
  scoreOpportunity,
  deriveLinkBoost,
  linkBoostCap,
  listicleFamilyKey,
  clusterListicleFamilies,
  listicleFamilyDedupeKey,
  listicleFamilyEligible,
  resolveListicleFamilyServiceCity,
  classifierQuerySupported,
  extractSpecialtyTopic,
  listicleFamilyRefreshDedupeKey,
  listicleFamilyRepReachable,
  noContentYetMapEmittable,
  noContentYetEmittable,
  pickCtrRewriteTargetPage,
  ctrRewriteTargetFor,
  pagesForCandidateDomains,
  seoActionRouteIdentity,
  routeIdentity,
  materialServingPosition,
  queryDomainsCovered,
  buildListicleFamilyRefreshOpp,
  // The page-edit conflict action set — shared with refresh-audit so every
  // producer's in-flight check covers the same actions (r34 follow-up).
  PAGE_EDITING_ACTIONS: GscOpportunityMiner.PAGE_EDITING_ACTIONS,
  canonicalizeServiceCategory,
  answerGapStem,
  stemmedTokenSet,
  queryContentTerms,
  extractHeadings,
  termCoverage,
  classifyAnswerGapQueries,
};
