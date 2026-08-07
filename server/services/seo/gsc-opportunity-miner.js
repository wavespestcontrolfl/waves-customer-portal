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
 *   ctr_rewrite         pos 1–8, high impressions, ctr < 2%
 *   decay_refresh       page clicks down ≥25% vs prior period
 *   cannibalization     2+ own URLs ranking for same query (low-confidence)
 *   page_type_mismatch  URL type doesn't match query intent (heuristic only
 *                       until SERP profiler ships in Step 2)
 *   local_gap           {city, service} has impressions but no own page
 *   seasonal_rising     query impressions up 50%+ vs prior 14d window
 *   no_content_yet      query has impressions but no own page anywhere
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
      // Inflections only — a bare [a-z]* tail accepted 'antique' (ant),
      // 'rating' (rat), 'beef' (bee). The set covers plurals plus the
      // stems the sync uses as prefixes ('termit'→termite/termites,
      // 'fertiliz'→fertilizer/fertilization); 'ing'/'ed' stay excluded
      // (rating/rated must not read as rodent evidence).
      const alts = re.source
        .split('|')
        .map((alt) => `\\b(?:${alt})(?:e|es|s|er|ers|ation|ations)?\\b`)
        .join('|');
      CLASSIFIER_VALIDATION_RES.set(cat, new RegExp(alts, 'i'));
    }
  } catch (err) {
    logger.warn(`[gsc-opp-miner] classifier vocabulary unavailable (${err.message}) — classifier values rejected, inference only`);
  }
  return CLASSIFIER_VALIDATION_RES;
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
  if (bucket === 'cannibalization') return Math.round(W * 0.5 * impressionsBoost);
  if (bucket === 'page_type_mismatch') return Math.round(W * 0.6 * impressionsBoost);
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
  if (bucket === 'cannibalization' || bucket === 'page_type_mismatch') {
    return 'do_not_publish'; // always human review for these
  }
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
function resolveListicleFamilyServiceCity(fam, { canonicalize, inferService, normCity, inferCity, classifierSupported = classifierQuerySupported }) {
  let service = null;
  let city = null;
  for (const v of fam.variants) {
    if (!service) {
      const canon = canonicalize(v.service_category);
      // Classifier value only counts with boundary-aware query evidence —
      // see classifierQuerySupported (unbounded classifier patterns tag
      // off-topic queries); inference is already contextual.
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
  opp.dedupe_key = listicleFamilyRefreshDedupeKey(opp.page_url);
  return opp;
}

// Can a query-level bucket ACTUALLY emit this representative? Service
// resolution alone is not enough (Codex r12): striking_distance takes any
// ≥50-imp query ranking 4-15 regardless of the own-page map, while
// no_content_yet takes >15 ONLY when no own page exists for the
// service+city — a rep at position 20 whose service+city has any own page
// is emitted by NEITHER, so excluding its family would lose the demand to
// no bucket at all. Top-3 reps are irrelevant here: family admission drops
// them as won intent regardless.
function listicleFamilyRepReachable(rep, ownPagesByServiceCity = new Map(), thresholds = THRESHOLDS, { seasonalEmittable = false } = {}) {
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
    // no_content_yet mirror, including its RAW-classifier-first service
    // lookup: the own-page map keys raw classifier values (tree_shrub), so
    // canonicalizing here made the lookup miss and BOTH buckets dropped
    // the demand (Codex r13).
    if (!service) continue;
    if (ownPagesByServiceCity.get(ownPageKey(service, city))) continue;
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

// Page-stable refresh key: dedupeKey(opp) embeds service/city, which come
// from the PRIMARY family and can flip between runs while the target URL
// is unchanged — with the old row frozen (claimed/done/review), the new
// key would mint a second claimable edit of the same page (Codex r16).
function listicleFamilyRefreshDedupeKey(pageUrl) {
  const page = String(pageUrl || '');
  const digest = crypto.createHash('sha256').update(page).digest('hex').slice(0, 16);
  return ['listicle_family', 'page', page.slice(0, 120), digest].join('::');
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
  // Penalties surface in later steps (cannibalizationRisk needs SERP, etc.).
  // Cannibalization bucket pre-applies its own risk inline:
  let penalty = 0;
  if (opportunity.bucket === 'cannibalization') penalty += WEIGHTS.cannibalizationRisk;
  if (opportunity.bucket === 'page_type_mismatch') penalty += WEIGHTS.serpMismatch;

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
    if (!existing || opp.score > existing.score) byKey.set(opp.dedupe_key, opp);
  }
  return Array.from(byKey.values())
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
  async mineAll({ periodDays = 28, persist = true } = {}) {
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
      ['ctr_rewrite', () => this.mineCtrRewrite(since, ownPagesByServiceCity)],
      ['decay_refresh', () => this.mineDecayRefresh(since, priorSince)],
      ['cannibalization', () => this.mineCannibalization(since)],
      ['page_type_mismatch', () => this.minePageTypeMismatch(since)],
      ['local_gap', () => this.mineLocalGap(since, ownPagesByServiceCity)],
      ['seasonal_rising', () => this.mineSeasonalRising(periodDays)],
      ['no_content_yet', () => this.mineNoContentYet(since, ownPagesByServiceCity)],
      ['aeo_gap', () => this.mineAeoGaps(since, ownPagesByServiceCity)],
      ['answer_gap', () => this.mineAnswerGap(since)],
      // Runs AFTER answer_gap by list order: its persistable refresh pages
      // fence the family refreshes — two buckets must not queue
      // independently claimable edits of one page (their dedupe keys
      // differ by construction).
      ['listicle_family', () => this.mineListicleFamily(since, {
        ownPagesByServiceCity,
        periodDays,
        answerGapPages: new Set((buckets.answer_gap || [])
          .filter((o) => o.score >= minScoreToActFor(o.action_type))
          .map((o) => o.page_url)
          .filter(Boolean)),
      })],
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
    await this._applyFactsReadinessBoost(minedOpportunities);

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
      persisted = await this.persistAll(allOpportunities);
      // Family-lane sweep ONLY after the upserts land (a pre-persistence
      // sweep + failed persist would empty the lane until the next run),
      // only when the lane actually ran (gates on, no miner error — an
      // empty bucket then means "didn't run", not "no signal").
      if (!errors.listicle_family && isEnabled('listicleFamilyMining') && isEnabled('listicleBriefs')) {
        await this._sweepStaleFamilyRows(buckets.listicle_family || []);
      }
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
  async _applyFactsReadinessBoost(opportunities = []) {
    let factsSufficiency;
    try {
      factsSufficiency = require('../content/facts-sufficiency');
    } catch (err) {
      logger.warn(`[gsc-opp-miner] facts-sufficiency unavailable; skipping readiness boost: ${err.message}`);
      return;
    }
    const cache = new Map();
    for (const opp of opportunities) {
      if (opp.action_type !== 'refresh_existing_page') continue;
      if (!opp.city || !opp.service) continue;
      const key = `${String(opp.city).toLowerCase()}::${String(opp.service).toLowerCase()}`;
      let ready = cache.get(key);
      if (ready === undefined) {
        try {
          // Mirror the runner: call check() with no opts so the facts-bank
          // loader resolves ASTRO_REPO_DIR or falls back to GitHub.
          const verdict = await factsSufficiency.check({
            action_type: 'refresh_existing_page',
            city: opp.city,
            service: opp.service,
          });
          ready = !!(verdict && verdict.applicable !== false && verdict.sufficient);
        } catch (err) {
          logger.warn(`[gsc-opp-miner] facts readiness check failed for ${key}: ${err.message}`);
          ready = false;
        }
        cache.set(key, ready);
      }
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

  async mineCtrRewrite(since, ownPagesByServiceCity = new Map()) {
    const rows = await db('gsc_queries')
      .where('date', '>=', since)
      .where('is_branded', false)
      .select('query', 'service_category', 'city_target')
      .sum('clicks as clicks')
      .sum('impressions as impressions')
      .avg('position as avg_position')
      .groupBy('query', 'service_category', 'city_target')
      .havingRaw('avg(position) <= ?', [THRESHOLDS.ctrRewritePositionMax])
      .havingRaw('sum(impressions) >= ?', [THRESHOLDS.ctrRewriteMinImpressions]);

    const filtered = rows.filter(
      (r) => recomputeCtr(r.clicks, r.impressions) < THRESHOLDS.ctrRewriteMaxCtr
    );

    return filtered.map((r) => {
      const city = normalizeCity(r.city_target) || inferCityFromQuery(r.query);
      const service = r.service_category || inferServiceFromQuery(r.query);
      // ctr_rewrite REQUIRES a target page (we're rewriting its title/meta).
      // If no matching own page exists, actionForOpportunity falls through
      // to do_not_publish for that opportunity — which is the right outcome
      // when there's nothing to rewrite. Use normalized values to match
      // the map keys built in _loadOwnPagesByServiceCity.
      const pageUrl = ownPagesByServiceCity.get(ownPageKey(service, city)) || null;
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

  async mineCannibalization(since) {
    // Heuristic: queries with significant impressions where the site
    // owns 2+ URLs both ranking in the same period at similar service+city.
    // True query→page mapping isn't in GSC's BigQuery export schema we
    // have locally; this is an upper-bound flag for human review.
    const queries = await db('gsc_queries')
      .where('date', '>=', since)
      .where('is_branded', false)
      .select('query', 'service_category', 'city_target')
      .sum('impressions as impressions')
      .groupBy('query', 'service_category', 'city_target')
      .havingRaw('sum(impressions) >= ?', [THRESHOLDS.minImpressionsToScore * 4]);

    const out = [];
    for (const q of queries) {
      // Find own URLs that match service+city and carry material
      // impressions. The per-page HAVING filters out URLs that only
      // surface for the query incidentally; the JS-side length check
      // then enforces the ≥ cannibalizationMinUrls floor.
      //
      // Earlier iteration had `havingRaw('count(distinct page_url) >= 2')`
      // here after `groupBy('page_url')` — but that always evaluates to 1
      // per group, so the bucket silently produced zero results. The
      // correct per-page filter is on impressions; URL count is a
      // post-query JS check.
      const ownPages = await db('gsc_pages')
        .where('date', '>=', since)
        .where('service_category', q.service_category || '')
        .where('city_target', q.city_target || '')
        .select(db.raw(`${CANON_URL_SQL} as page_url`))
        .sum('impressions as impressions')
        .groupByRaw(CANON_URL_SQL)
        .havingRaw('sum(impressions) > ?', [10]);
      if (ownPages.length < THRESHOLDS.cannibalizationMinUrls) continue;

      const city = normalizeCity(q.city_target);
      const service = q.service_category;
      const opp = {
        bucket: 'cannibalization',
        query: q.query,
        page_url: null,
        service,
        city,
        signal_metadata: {
          competing_urls: ownPages.slice(0, 8).map((p) => ({
            page_url: p.page_url,
            impressions: parseInt(p.impressions, 10),
          })),
          impressions: parseInt(q.impressions, 10),
        },
      };
      const { total, breakdown } = scoreOpportunity(opp, {
        position: 5,
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

  async minePageTypeMismatch(since) {
    // Heuristic until SERP profiler ships:
    //   a blog URL is ranking for a query that has explicit city + service
    //   intent (transactional-local SERP wants a city-service page).
    const pages = await db('gsc_pages')
      .where('date', '>=', since)
      .select(db.raw(`${CANON_URL_SQL} as page_url`))
      .max('page_type as page_type')
      .max('service_category as service_category')
      .max('city_target as city_target')
      .sum('impressions as impressions')
      .avg('position as avg_position')
      .groupByRaw(CANON_URL_SQL)
      .havingRaw('sum(impressions) >= ?', [THRESHOLDS.minImpressionsToScore]);

    const out = [];
    for (const p of pages) {
      const pageType = inferPageType(p.page_url, p.page_type);
      if (pageType !== 'blog') continue;
      const city = normalizeCity(p.city_target) || inferCityFromUrl(p.page_url);
      const service = p.service_category || inferServiceFromUrl(p.page_url);
      if (!city || !service) continue;

      // Has it surfaced in queries with transactional-local intent?
      const localQueries = await db('gsc_queries')
        .where('date', '>=', since)
        .where('city_target', p.city_target || '')
        .where('service_category', p.service_category || '')
        .where('intent_type', 'service')
        .sum('impressions as impressions')
        .first();

      if (!localQueries || parseInt(localQueries.impressions || 0, 10) < THRESHOLDS.minImpressionsToScore) continue;

      const opp = {
        bucket: 'page_type_mismatch',
        query: null,
        page_url: p.page_url,
        service,
        city,
        signal_metadata: {
          page_type: pageType,
          impressions: parseInt(p.impressions, 10),
          avg_position: parseFloat(p.avg_position),
          local_query_impressions: parseInt(localQueries.impressions, 10),
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

      // Use the normalized own-page map (same fix as mineNoContentYet).
      // Earlier iteration queried gsc_pages with raw classifier values,
      // missing pages where the classification was empty in gsc_pages
      // but resolvable via inferServiceFromUrl/inferCityFromUrl.
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

  async mineListicleFamily(since, { ownPagesByServiceCity = new Map(), periodDays = 28, answerGapPages = new Set() } = {}) {
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
    const [crossTuples, seasonalEmittable] = reachQueries.length
      ? await Promise.all([
        this._crossDomainRepTuples(reachQueries, since),
        this._seasonalEmittableQueries(reachQueries, periodDays),
      ])
      : [new Map(), new Set()];
    const fams = allFams.filter((f) => {
      const anyVariantReachable = f.variants.some((v) => listicleFamilyRepReachable(
        { ...v, tuples: crossTuples.get(v.query) || v.tuples },
        ownPagesByServiceCity,
        THRESHOLDS,
        { seasonalEmittable: seasonalEmittable.has(v.query) }
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
    const servedBy = new Map();
    for (const r of mappedRows) {
      const pos = parseFloat(r.page_position);
      if (pos < THRESHOLDS.strikingDistancePositionMin) continue;
      const cur = servedBy.get(r.query);
      if (!cur || pos < cur.position) servedBy.set(r.query, { page_url: r.page_url, position: pos });
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
        // NOTE the mine loop performs NO queue mutations: every stale-row
        // transition (an earlier run's blog row once a page serves the
        // intent, a refresh row whose page changed or whose family went
        // back to blog) is covered by _sweepStaleFamilyRows — a retired
        // row's key is, by definition, absent from the keys this run
        // emits, so the post-persist sweep expires it. Retiring here,
        // BEFORE persistAll, was non-atomic: a failed upsert left the old
        // work retired while its replacement never queued (Codex r15).
        // An answer_gap refresh already targeting this page this run makes
        // a family refresh a SECOND claimable edit of the same URL (their
        // keys differ by construction) — the answer-gap brief covers the
        // unanswered queries, which are exactly these variants; the family
        // re-mines next cycle if the page still serves it, and the sweep
        // expires any stale pending family refresh meanwhile (Codex r18).
        if (answerGapPages.has(served.hit.page_url)) continue;
        // Accumulate — families sharing a serving page merge into ONE
        // refresh row (emitted after the loop) so no family's demand is
        // dropped. Grouped by PAGE alone: families classified under
        // different services/cities but served by the same URL must not
        // become independently claimable rows editing one page.
        let group = refreshGroups.get(served.hit.page_url);
        if (!group) {
          group = { entries: [] };
          refreshGroups.set(served.hit.page_url, group);
        }
        group.entries.push({ fam, served, service, city });
        continue;
      }

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
    for (const group of refreshGroups.values()) {
      // Mixed classification resolves INSIDE the builder: the
      // highest-impression family anchors query + service/city + position
      // as one consistent unit. A winner flip between runs mints a new
      // dedupe key, and the post-floor sweep expires the orphaned old row.
      out.push(buildListicleFamilyRefreshOpp(group.entries));
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
  async _sweepStaleFamilyRows(familyOpps = []) {
    try {
      const familyFloorActions = ['new_supporting_blog', 'refresh_existing_page'];
      const persistableKeys = familyOpps
        .filter((o) => o.score >= (familyFloorActions.includes(o.action_type)
          ? minScoreToActFor('new_supporting_blog')
          : minScoreToActFor(o.action_type)))
        .map((o) => o.dedupe_key);
      await db('opportunity_queue')
        .where({ bucket: 'listicle_family', status: 'pending' })
        .whereNotIn('dedupe_key', persistableKeys)
        .update({ status: 'expired', skip_reason: 'family_signal_gone', updated_at: new Date() });
    } catch (err) {
      logger.warn(`[gsc-opp-miner] listicle_family: stale-family sweep failed: ${err.message}`);
    }
  }

  async mineNoContentYet(since, ownPagesByServiceCity = new Map()) {
    // Queries with impressions on the property but no own page even
    // appearing in gsc_pages for the matching service+city.
    const queries = await db('gsc_queries')
      .where('date', '>=', since)
      .where('is_branded', false)
      .select('query', 'service_category', 'city_target', 'intent_type')
      .sum('impressions as impressions')
      .avg('position as avg_position')
      .groupBy('query', 'service_category', 'city_target', 'intent_type')
      .havingRaw('sum(impressions) >= ?', [THRESHOLDS.minImpressionsToScore])
      .havingRaw('avg(position) > ?', [THRESHOLDS.strikingDistancePositionMax]);

    const out = [];
    for (const q of queries) {
      const city = normalizeCity(q.city_target) || inferCityFromQuery(q.query);
      const service = q.service_category || inferServiceFromQuery(q.query);
      if (!service) continue;

      // Use the normalized own-page map (built once in mineAll) so the
      // ownership check matches our normalized service+city values.
      // Earlier iteration queried gsc_pages with raw service_category =
      // '' when only inferServiceFromQuery resolved a service, missing
      // every page that needed URL inference — incorrectly enqueued
      // no_content_yet rows for topics we already cover.
      if (ownPagesByServiceCity.get(ownPageKey(service, city))) continue;

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
    return out;
  }

  // ── persistence ────────────────────────────────────────────────────

  async persistAll(opportunities) {
    if (!opportunities.length) return 0;
    let count = 0;
    const now = new Date();
    const expiresAt = new Date(Date.now() + 14 * 86400_000);

    // Group by dedupe_key, keep highest-score entry per key.
    const winners = new Map();
    for (const o of opportunities) {
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
      const familyFloorActions = ['new_supporting_blog', 'refresh_existing_page'];
      const scoreFloor = o.bucket === 'listicle_family' && familyFloorActions.includes(o.action_type)
        ? minScoreToActFor('new_supporting_blog')
        : minScoreToActFor(o.action_type);
      if (o.score < scoreFloor) {
        // Rollout hygiene for the near-me demotion: a previously persisted
        // new_supporting_blog row shares this candidate's dedupe_key, but a
        // demoted candidate dropped here never reaches the ON CONFLICT
        // upsert — so the stale pending blog action would stay claimable
        // and burn the runner daily. Expire it explicitly. Fail-soft: a
        // cleanup error must never abort the mining pass.
        if (isTransactionalQuery(o.query)) {
          try {
            await db('opportunity_queue')
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
      const result = await db.raw(
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
  listicleFamilyRefreshDedupeKey,
  listicleFamilyRepReachable,
  buildListicleFamilyRefreshOpp,
  canonicalizeServiceCategory,
  answerGapStem,
  stemmedTokenSet,
  queryContentTerms,
  extractHeadings,
  termCoverage,
  classifyAnswerGapQueries,
};
