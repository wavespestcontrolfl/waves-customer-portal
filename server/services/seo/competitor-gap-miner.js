/**
 * competitor-gap-miner.js — keywords competitors rank for where Waves has
 * zero footprint, fed into opportunity_queue as 'competitor_gap' blog
 * opportunities.
 *
 * The blind spot this closes (audit 2026-06-11): GSC only shows queries
 * where Waves already gets impressions, and AEO probing only tests managed
 * queries — neither can surface a topic a competitor wins that we've never
 * touched (e.g. "palmetto bugs vs cockroaches", ~12k/mo, zero Waves pages).
 * This miner pulls each tracked competitor's ranked keywords from the
 * DataForSEO Labs database, diffs them against our own rankings AND the
 * live sitemap, and enqueues the survivors for the autonomous blog lane.
 *
 * Design decisions:
 *  - Rows are NOT operator-pinned: these are machine-mined, so the
 *    decision-router's live SERP profiling stays the backstop — a topic
 *    whose SERP turns out commercial/navigational gets demoted exactly
 *    like a mined GSC topic would. Quality-gate GSC-evidence check
 *    accepts competitor evidence for this bucket instead (see
 *    content-quality-gate.checkGscSignalAttached).
 *  - Blog lane only (action_type 'new_supporting_blog'): commercial
 *    city×service gaps surface in the run summary for operator review but
 *    are never auto-enqueued — new service pages are an operator call.
 *  - Labs "not ranking" means outside the top ~100, NOT "no page exists"
 *    (audit lesson). Candidates are joined against live sitemap slugs and
 *    dropped when an existing page already covers the topic; if the
 *    sitemap fetch fails the run aborts rather than enqueue blind.
 *  - Near-me/transactional terms are excluded via the single-sourced
 *    isTransactionalQuery (operator directive 2026-06-11: never blog
 *    material). Competitor-brand terms are excluded from the queue but
 *    reported — they're comparison-PAGE candidates for the operator, not
 *    autonomous blog topics.
 *  - Cost: 1 self + ~11 competitor ranked_keywords calls ≈ $1.30/run at
 *    1000 rows each; quarterly cadence. Logged per call by the client.
 */

const db = require('../../models/db');
const logger = require('../logger');
const dataforseo = require('./dataforseo');
const sitemapManager = require('./sitemap-manager');
const { isEnabled } = require('../../config/feature-gates');
const { minScoreToActFor, isTransactionalQuery, CITIES } = require('../content/scoring-config');

const BUCKET = 'competitor_gap';

// Audit-derived default set (2026-06-11): 8 Sarasota–Bradenton locals with
// Waves' service mix + 3 FL regionals + 1 FL content-publisher benchmark.
// Override with COMPETITOR_GAP_DOMAINS (comma-separated) as the market shifts.
const DEFAULT_COMPETITOR_DOMAINS = [
  'goodnewspestsolutions.com',
  'westfallspestcontrol.com',
  'farrowpestservices.com',
  'lawnandbugs.com',
  'kellerspestcontrol.com',
  'venicepestcontrol.com',
  'alluneedpest.com',
  'turnerpest.com',
  'masseyservices.com',
  'hughes-exterminators.com',
  'nativepestmanagement.com',
];

// Service-area geo terms (scoring-config CITIES + surrounding communities
// and counties). Lowercase; matched as substrings of the keyword.
const OUR_GEO_TERMS = [
  ...CITIES.map((c) => c.toLowerCase()),
  'englewood', 'punta gorda', 'nokomis', 'osprey', 'ellenton', 'myakka',
  'siesta key', 'longboat key', 'anna maria', 'holmes beach', 'rotonda',
  'manatee county', 'sarasota county', 'charlotte county',
];

// Other-metro noise — a competitor's Orlando/Jacksonville/Tampa keywords are
// not opportunities for us. Deliberately coarse; a false drop costs nothing
// (the topic resurfaces next quarter if it matters in our geography).
const OTHER_METRO_TERMS = [
  'jacksonville', 'orlando', 'tampa', 'st pete', 'petersburg', 'clearwater',
  'brandon', 'riverview', 'wesley chapel', 'fort myers', 'ft myers',
  'cape coral', 'naples', 'bonita', 'estero', 'lehigh', 'miami',
  'lauderdale', 'west palm', 'boca', 'boynton', 'gainesville', 'ocala',
  'tallahassee', 'pensacola', 'daytona', 'melbourne', 'kissimmee',
  'lakeland', 'winter haven', 'brooksville', 'spring hill', 'port richey',
  'largo', 'sanford', 'deltona', 'palm coast', 'vero', 'port st', 'stuart',
  'jupiter', 'delray', 'pompano', 'hollywood', 'hialeah', 'doral',
  'sebring', 'arcadia', 'valrico', 'plant city', 'apopka', 'oviedo',
  'georgia', 'atlanta', 'alabama', 'texas', 'carolina', 'tennessee',
  'virginia', 'ohio', 'colorado', 'jersey', 'new york', 'arizona',
  'nevada', 'california', 'knoxville', 'chattanooga', 'huntsville',
  'tucson', 'las vegas', 'san antonio', 'austin', 'houston', 'dallas',
];

// Brand tokens — competitor navigational queries are comparison-page
// material for the operator (Pestie/Taexx playbook), never autonomous blog
// topics. Derived from the tracked set + national brands we keep seeing.
const BRAND_TERMS = [
  'good news pest', 'westfall', 'farrow', 'blue frog', 'keller',
  'venice pest control', 'all u need', 'turner pest', 'massey', 'hughes',
  'native pest', 'home team', 'hometeam', 'pest defense', 'orkin',
  'terminix', 'aptive', 'trugreen', 'truly nolen', 'pestie', 'taexx',
  'home defense', 'arrow environmental', 'bug busters', 'ban a bug',
  'grim reaper', 'krizen', 'got bugs', 'mosquito joe', 'lawn doctor',
];

// Commercial-intent tokens → service-page territory, not the blog lane.
// The live SERP profiler is the backstop for anything this misses.
const COMMERCIAL_RE = /\b(control|exterminators?|removal|treatments?|compan(y|ies)|services?|cost|costs|price|prices|pricing|quotes?|inspections?|fumigation)\b/i;

// Crude singular form for slug-segment matching: flies→fly, roaches→roache
// is wrong, so handle -es and -ies before the bare -s strip.
function singular(word) {
  const w = String(word || '').toLowerCase();
  if (w.endsWith('ies') && w.length > 4) return `${w.slice(0, -3)}y`;
  if (w.endsWith('es') && w.length > 3) return w.slice(0, -2);
  if (w.endsWith('s') && w.length > 3) return w.slice(0, -1);
  return w;
}

const STOPWORDS = new Set([
  'a', 'an', 'the', 'in', 'on', 'of', 'for', 'to', 'and', 'or', 'vs',
  'versus', 'what', 'whats', 'how', 'why', 'do', 'does', 'are', 'is',
  'my', 'your', 'with', 'fl', 'florida',
]);

function keywordTokens(keyword) {
  return String(keyword || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, ' ')
    .split(/\s+/)
    .filter((t) => t && !STOPWORDS.has(t))
    .map(singular);
}

function geoBucket(keyword) {
  const kw = String(keyword || '').toLowerCase();
  // "palmetto bug/roach" is the pest, not Palmetto the city.
  if (/palmetto\s+(bug|roach|cockroach)/.test(kw)) return 'generic';
  if (OUR_GEO_TERMS.some((g) => kw.includes(g))) return 'our_geo';
  if (OTHER_METRO_TERMS.some((g) => kw.includes(g))) return 'other_metro';
  return 'generic';
}

function isBrandQuery(keyword) {
  const kw = String(keyword || '').toLowerCase();
  return BRAND_TERMS.some((b) => kw.includes(b));
}

function classifyService(keyword) {
  const kw = String(keyword || '').toLowerCase();
  if (/\btermites?\b|\bwdo\b/.test(kw)) return 'termite';
  if (/\bmosquito(es)?\b/.test(kw)) return 'mosquito';
  if (/\brats?\b|\bmice\b|\bmouse\b|\brodents?\b/.test(kw)) return 'rodent';
  if (/\blawn\b|\bgrass\b|\bchinch\b|\bgrubs?\b|\bsod\b|\bweeds?\b|\bturf\b|\baeration\b/.test(kw)) return 'lawn';
  return 'pest';
}

// A sitemap slug "covers" a keyword when every meaningful keyword token
// appears as a whole (singularized) slug segment — substring matching is
// not enough ('roach' would false-match 'cockroach-control-palmetto-fl').
// Single-token topics are NEVER marked covered: stopword removal can
// collapse a distinct intent onto one generic token ("rats in florida" →
// ['rat']), and any rat-slugged how-to page would then wrongly suppress
// the species-guide gap. One-token duplicates are rare and the runner's
// uniqueness/redundancy gates are the backstop there.
function coveredBySitemap(keyword, slugSegmentSets) {
  const tokens = keywordTokens(keyword).slice(0, 3);
  if (!tokens.length) return true; // nothing meaningful left — drop, can't dedupe
  if (tokens.length < 2) return false;
  return slugSegmentSets.some((segs) => tokens.every((t) => segs.has(t)));
}

// Live page inventory via sitemap-manager: honors SITEMAP_URL, expands
// sitemap indexes recursively, and caches — the hardcoded-child-sitemap
// version missed URLs the moment the site splits sitemaps (Codex P2).
async function fetchSitemapSlugSets() {
  const urls = await sitemapManager.listUrls();
  const slugs = (urls || [])
    .map((u) => String(u).replace(/^https?:\/\/[^/]+\//, '').replace(/\/$/, ''))
    .filter(Boolean);
  if (!slugs.length) throw new Error('sitemap parsed to zero URLs');
  return slugs.map((slug) => new Set(slug.split(/[/-]/).filter(Boolean).map(singular)));
}

function parseRankedKeywords(apiResponse) {
  const items = apiResponse?.tasks?.[0]?.result?.[0]?.items;
  if (!Array.isArray(items)) return [];
  return items
    // rankedKeywords() requests item_types ['organic'], but keep the
    // belt-and-suspenders filter: a paid row that slipped through would
    // read as fake organic competitor evidence.
    .filter((it) => {
      const type = it.ranked_serp_element?.serp_item?.type;
      return !type || type === 'organic';
    })
    .map((it) => ({
      keyword: it.keyword_data?.keyword || '',
      volume: it.keyword_data?.keyword_info?.search_volume || 0,
      position: it.ranked_serp_element?.serp_item?.rank_group || null,
      url: it.ranked_serp_element?.serp_item?.relative_url
        || it.ranked_serp_element?.serp_item?.url || '',
    }))
    .filter((r) => r.keyword && r.position);
}

// Score in the queue's vocabulary. Tuned so a real gap (≥1k volume,
// competitor top-10, FL-flavored) clears the 45 blog floor with room, while
// a thin one (low volume, page-2 competitor, no FL angle) stays under it.
function scoreGap({ volume, competitorPosition, geo }) {
  const breakdown = {};
  breakdown.searchDemand =
    volume >= 50000 ? 25 : volume >= 5000 ? 20 : volume >= 1000 ? 15 : volume >= 200 ? 10 : 6;
  breakdown.competitorEvidence = competitorPosition <= 10 ? 20 : 12;
  breakdown.contentGap = 15; // by construction: no Waves rank, no covering page
  breakdown.localRelevance = geo === 'our_geo' ? 10 : 0;
  const score = Object.values(breakdown).reduce((a, b) => a + b, 0);
  return { score, breakdown };
}

// Same shape as gsc-opportunity-miner's dedupeKey (bucket::service::city::query).
// classifyService is deterministic, so the key is stable across runs.
function dedupeKeyFor(query) {
  return `${BUCKET}::${classifyService(query)}::_::${String(query).slice(0, 120)}`;
}

class CompetitorGapMiner {
  get competitorDomains() {
    const env = String(process.env.COMPETITOR_GAP_DOMAINS || '').trim();
    if (!env) return DEFAULT_COMPETITOR_DOMAINS;
    return env.split(',').map((d) => d.trim()).filter(Boolean);
  }

  /**
   * mineAll({ persist }) — full quarterly pass. Returns a summary:
   * { enqueued, candidates, skipped: {reason: n}, brandCandidates: [...],
   *   serviceIntentCandidates: [...] } — the last two are operator-review
   * material (comparison pages / city-service gaps), never auto-enqueued.
   */
  async mineAll({ persist = true } = {}) {
    if (!isEnabled('seoIntelligence')) {
      logger.info('[competitor-gap-miner] GATE_SEO_INTELLIGENCE off — skipping');
      return null;
    }
    if (!dataforseo.configured) {
      logger.warn('[competitor-gap-miner] DataForSEO not configured — skipping');
      return null;
    }

    // Live sitemap is the page-existence ground truth; without it we'd
    // enqueue topics existing pages already cover. Abort, don't guess.
    const slugSegmentSets = await fetchSitemapSlugSets();

    const own = parseRankedKeywords(await dataforseo.rankedKeywords('wavespestcontrol.com'));
    if (!own.length) {
      logger.warn('[competitor-gap-miner] own ranked-keywords pull empty — aborting (diff would be meaningless)');
      return null;
    }
    const ownPos = new Map();
    for (const r of own) {
      const prev = ownPos.get(r.keyword);
      if (prev == null || r.position < prev) ownPos.set(r.keyword, r.position);
    }

    const skipped = { transactional: 0, other_metro: 0, brand: 0, commercial: 0, covered: 0, weak: 0, ranked_already: 0 };
    const brandCandidates = [];
    const serviceIntentCandidates = [];
    // One opportunity per competitor PAGE: keyword variants ranking via the
    // same URL are one topic; keep the highest-volume variant as the query.
    const clusters = new Map();

    for (const domain of this.competitorDomains) {
      const rows = parseRankedKeywords(await dataforseo.rankedKeywords(domain));
      for (const r of rows) {
        if (r.position > 20 || r.volume < this.minVolume) { skipped.weak++; continue; }
        const ours = ownPos.get(r.keyword);
        if (ours != null && ours <= 30) { skipped.ranked_already++; continue; }
        if (isTransactionalQuery(r.keyword)) { skipped.transactional++; continue; }
        const geo = geoBucket(r.keyword);
        if (geo === 'other_metro') { skipped.other_metro++; continue; }
        if (isBrandQuery(r.keyword)) {
          skipped.brand++;
          if (brandCandidates.length < 40) brandCandidates.push({ keyword: r.keyword, volume: r.volume, domain, position: r.position });
          continue;
        }
        if (COMMERCIAL_RE.test(r.keyword)) {
          skipped.commercial++;
          if (geo === 'our_geo' && serviceIntentCandidates.length < 40) {
            serviceIntentCandidates.push({ keyword: r.keyword, volume: r.volume, domain, position: r.position });
          }
          continue;
        }
        if (coveredBySitemap(r.keyword, slugSegmentSets)) { skipped.covered++; continue; }

        const clusterKey = `${domain}${r.url}`;
        const existing = clusters.get(clusterKey);
        if (!existing || r.volume > existing.volume) {
          clusters.set(clusterKey, {
            keyword: r.keyword, volume: r.volume, position: r.position,
            domain, url: r.url, geo,
            variants: (existing?.variants || 0) + 1,
          });
        } else {
          existing.variants += 1;
        }
      }
    }

    // Cross-competitor keyword dedupe: two competitors winning the same
    // keyword is one topic — keep the stronger evidence.
    const byKeyword = new Map();
    for (const c of clusters.values()) {
      const prev = byKeyword.get(c.keyword);
      if (!prev || c.position < prev.position) byKeyword.set(c.keyword, c);
    }

    const opportunities = [];
    for (const c of byKeyword.values()) {
      const { score, breakdown } = scoreGap({ volume: c.volume, competitorPosition: c.position, geo: c.geo });
      opportunities.push({
        bucket: BUCKET,
        action_type: 'new_supporting_blog',
        query: c.keyword,
        page_url: null,
        service: classifyService(c.keyword),
        city: null, // informational topics — no city anchor; facts gate reads "not applicable"
        score,
        score_breakdown: breakdown,
        signal_metadata: {
          source: 'competitor-gap-miner',
          search_volume: c.volume,
          competitor_domain: c.domain,
          competitor_position: c.position,
          competitor_url: c.url,
          keyword_variants: c.variants,
          geo_bucket: c.geo,
        },
        dedupe_key: dedupeKeyFor(c.keyword),
      });
    }

    let enqueued = 0;
    if (persist) enqueued = await this.persistAll(opportunities);

    const summary = {
      competitors: this.competitorDomains.length,
      candidates: opportunities.length,
      enqueued,
      skipped,
      brandCandidates: brandCandidates.sort((a, b) => b.volume - a.volume),
      serviceIntentCandidates: serviceIntentCandidates.sort((a, b) => b.volume - a.volume),
    };
    logger.info(`[competitor-gap-miner] ${enqueued} enqueued of ${opportunities.length} candidates (skips: ${JSON.stringify(skipped)}; ${brandCandidates.length} brand terms + ${serviceIntentCandidates.length} service-intent geo terms surfaced for operator review)`);
    return summary;
  }

  get minVolume() {
    const raw = Number.parseInt(process.env.COMPETITOR_GAP_MIN_VOLUME, 10);
    return Number.isFinite(raw) && raw > 0 ? raw : 50;
  }

  // Same upsert contract as gsc-opportunity-miner.persistAll: blog floor via
  // minScoreToActFor, highest score wins per dedupe_key, claimed/done/
  // pending_review rows never reset.
  async persistAll(opportunities) {
    if (!opportunities.length) return 0;
    let count = 0;
    const now = new Date();
    const expiresAt = new Date(Date.now() + 30 * 86400_000); // quarterly cadence → longer shelf life than GSC rows

    const winners = new Map();
    for (const o of opportunities) {
      const existing = winners.get(o.dedupe_key);
      if (!existing || o.score > existing.score) winners.set(o.dedupe_key, o);
    }

    for (const o of winners.values()) {
      if (o.score < minScoreToActFor(o.action_type)) continue;
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
               -- 'skipped' is STICKY here, same rule as gsc-opportunity-miner:
               -- this upsert runs from an unattended quarterly cron, so it
               -- must not overturn operator dismissals or attempts_exhausted
               -- sweeps ("won't be retried" contract). 'expired' still
               -- revives (a re-mined gap is a fresh opportunity). Operator
               -- paths that deliberately resurrect (review requeue, seeders)
               -- write status='pending' directly and reset attempt_count.
               status = CASE WHEN opportunity_queue.status IN ('claimed', 'done', 'pending_review', 'skipped')
                             THEN opportunity_queue.status
                             ELSE 'pending'
                        END,
               updated_at = now()
        `,
        [
          o.bucket, o.action_type, o.query, o.page_url, o.service, o.city,
          o.score, JSON.stringify(o.score_breakdown), JSON.stringify(o.signal_metadata), 'pending',
          now, expiresAt, o.dedupe_key,
        ]
      );
      count += result.rowCount || 1;
    }
    return count;
  }
}

module.exports = new CompetitorGapMiner();
module.exports._internals = {
  BUCKET,
  DEFAULT_COMPETITOR_DOMAINS,
  geoBucket,
  isBrandQuery,
  classifyService,
  coveredBySitemap,
  keywordTokens,
  singular,
  scoreGap,
  dedupeKeyFor,
  parseRankedKeywords,
  COMMERCIAL_RE,
};
