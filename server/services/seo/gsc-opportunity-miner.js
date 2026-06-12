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

const db = require('../../models/db');
const logger = require('../logger');
const { etDateString, addETDays } = require('../../utils/datetime-et');
const { isEnabled } = require('../../config/feature-gates');
const { WEIGHTS, THRESHOLDS, REVENUE_PRIORITY, CITIES, minScoreToActFor, isTransactionalQuery } =
  require('../content/scoring-config');

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
  { service: 'tree-shrub', re: /\b(tree|shrub|palm|ornamental)\b/i },
  { service: 'pest', re: /\b(pest|exterminator|bug|roach|ant|spider|cockroach)\b/i },
];

function inferServiceFromQuery(query) {
  if (!query) return null;
  for (const { service, re } of SERVICE_KEYWORDS) {
    if (re.test(query)) return service;
  }
  return null;
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
  return 'do_not_publish';
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
    contentGap: opportunity.bucket === 'local_gap' || opportunity.bucket === 'no_content_yet'
      ? WEIGHTS.contentGap
      : 0,
    refreshLift: opportunity.bucket === 'decay_refresh' || opportunity.bucket === 'ctr_rewrite'
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
      const occupied = await this._loadOccupiedLinkBoostKeys().catch((err) => {
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
    if (persist) persisted = await this.persistAll(allOpportunities);

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

  // dedupe keys of link_boost rows persistAll's upsert would refuse to
  // re-open (claimed / done / pending_review) — emitting those again only
  // burns per-run cap slots on rows whose status can't change.
  async _loadOccupiedLinkBoostKeys() {
    const rows = await db('opportunity_queue')
      .where('bucket', 'link_boost')
      .whereIn('status', ['claimed', 'done', 'pending_review'])
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
      // can see why the cut landed where it did.
      if (o.score < minScoreToActFor(o.action_type)) {
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

      // ON CONFLICT (dedupe_key) DO UPDATE — keeps latest score + mined_at,
      // resets status back to pending unless the row is already claimed,
      // done, or waiting on autonomous review.
      const result = await db.raw(
        `INSERT INTO opportunity_queue
           (bucket, action_type, query, page_url, service, city,
            score, score_breakdown, signal_metadata, status,
            mined_at, expires_at, dedupe_key, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?::jsonb, ?::jsonb, ?, ?, ?, ?, now(), now())
         ON CONFLICT (dedupe_key) DO UPDATE
           SET score = EXCLUDED.score,
               score_breakdown = EXCLUDED.score_breakdown,
               signal_metadata = EXCLUDED.signal_metadata,
               mined_at = EXCLUDED.mined_at,
               expires_at = EXCLUDED.expires_at,
               action_type = EXCLUDED.action_type,
               status = CASE WHEN opportunity_queue.status IN ('claimed', 'done', 'pending_review')
                             THEN opportunity_queue.status
                             ELSE 'pending'
                        END,
               updated_at = now()
        `,
        [
          row.bucket, row.action_type, row.query, row.page_url, row.service, row.city,
          row.score, row.score_breakdown, row.signal_metadata, row.status,
          row.mined_at, row.expires_at, row.dedupe_key,
        ]
      );
      count += result.rowCount || 1;
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
};
