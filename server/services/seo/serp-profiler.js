/**
 * serp-profiler.js — full SERP profile for one (query, city, device).
 *
 * Wraps DataForSEO `serp/google/organic/live/advanced` to extract the
 * fields the decision-router needs: dominant intent, dominant page
 * type, local-pack presence, AI Overview presence, competitor CTA /
 * review / proof patterns, PAA questions, recommended asset type,
 * and a confidence score.
 *
 * Output is cached in serp_snapshots keyed by (query, city, device,
 * fetched_at_day). Re-fetched at most once per 14 days unless `force`
 * is passed — every fetch costs DataForSEO credits.
 *
 * Compliance: SERP data only via DataForSEO. Zero direct Google
 * scraping (would violate Google's automated-queries policy).
 */

const db = require('../../models/db');
const logger = require('../logger');
const dataforseo = require('./dataforseo');
const { CITIES, SERP_SAMPLE_CITIES } = require('../content/scoring-config');

const DEFAULT_REFETCH_DAYS = 14;
const DEFAULT_DEVICE = 'mobile';

// serp_snapshots.city is NOT NULL with this sentinel for cityless rows —
// Postgres treats NULL as distinct in unique constraints, which would
// silently break the (query, city, device, fetched_at_day) dedupe. The
// sentinel is a storage detail; the public profile API still surfaces
// `city: null` for cityless queries.
const CITY_SENTINEL = '_global';
const toStoredCity = (city) => city || CITY_SENTINEL;
const fromStoredCity = (city) => (city === CITY_SENTINEL ? null : city);

// ── classification helpers (pure, test-friendly) ─────────────────────

const DIRECTORY_DOMAINS = new Set([
  'yelp.com', 'angi.com', 'angieslist.com', 'homeadvisor.com', 'thumbtack.com',
  'yellowpages.com', 'bbb.org', 'nextdoor.com', 'facebook.com',
  'manta.com', 'mapquest.com', 'bing.com',
]);

const PUBLIC_RESOURCE_PATTERNS = [
  /\.gov(\/|$)/i,
  /\.edu(\/|$)/i,
  /ifas\.ufl\.edu/i,
  /sfyl\.ifas\.ufl\.edu/i,
  /cdc\.gov/i,
  /epa\.gov/i,
  /\.k12\.fl\.us/i,
  /\.us(\/|$)/i,
];

function classifyResultPageType(result) {
  if (!result || !result.url) return 'unknown';
  const u = String(result.url).toLowerCase();
  const d = String(result.domain || '').toLowerCase().replace(/^www\./, '');

  if (PUBLIC_RESOURCE_PATTERNS.some((re) => re.test(u))) return 'public-health';
  if (DIRECTORY_DOMAINS.has(d)) return 'directory';
  if (/\/blog\/|\/post\/|\/articles?\//.test(u)) return 'blog';
  if (/\/(faq|frequently-asked|questions)\b/.test(u)) return 'faq';

  // city + service slug — most local landing pages
  for (const c of CITIES) {
    const slug = c.toLowerCase().replace(/\s+/g, '-');
    const localPatterns = [
      new RegExp(`-${slug}-fl/?$`),
      new RegExp(`/${slug}-fl/`),
      new RegExp(`/${slug}/`),
    ];
    if (localPatterns.some((re) => re.test(u))) return 'city-service';
  }

  if (/\/(services?|pest-control|lawn-care|mosquito|termite|rodent|exterminat)/.test(u)) return 'service';

  // bare home page
  try {
    const url = new URL(result.url);
    if (url.pathname === '/' || url.pathname === '') return 'home';
  } catch { /* ignore */ }

  return 'page';
}

function getDominantPageType(types) {
  if (!types.length) return { type: 'unknown', share: 0 };
  const counts = {};
  for (const t of types) counts[t] = (counts[t] || 0) + 1;
  const ranked = Object.entries(counts).sort((a, b) => b[1] - a[1]);
  const [type, n] = ranked[0];
  return { type, share: n / types.length };
}

function classifyIntent({
  query, localPackPresent, topPageTypes, aiOverviewPresent, hasBrandedMatch,
}) {
  const q = String(query || '').toLowerCase();

  if (/\b(emergency|same.?day|today|right now|asap|24.?hour)\b/.test(q)) return 'emergency';
  if (/\b(vs|versus|best|top \d|compare|comparison|which is better)\b/.test(q)) return 'comparison';
  if (hasBrandedMatch) return 'navigational';

  const pubShare = topPageTypes.filter((t) => t === 'public-health').length / Math.max(topPageTypes.length, 1);
  if (pubShare >= 0.5) return 'public-health';

  const localPages = topPageTypes.filter((t) => t === 'city-service').length;
  if (localPackPresent || localPages >= 3) return 'transactional-local';

  const blogShare = topPageTypes.filter((t) => t === 'blog' || t === 'faq').length / Math.max(topPageTypes.length, 1);
  if (blogShare >= 0.5) return 'informational';

  return 'mixed';
}

function recommendAssetType({ intent, dominantPageType, localPackPresent }) {
  if (intent === 'public-health') return 'do_not_publish';
  if (intent === 'navigational') return 'do_not_publish';
  if (intent === 'emergency') return 'create_or_refresh_city_service_page';
  if (intent === 'comparison') return 'new_supporting_blog';

  if (intent === 'transactional-local') {
    if (dominantPageType === 'city-service' || localPackPresent) return 'create_or_refresh_city_service_page';
    return 'create_or_refresh_city_service_page';
  }

  if (intent === 'informational') {
    if (dominantPageType === 'faq') return 'create_customer_question_page';
    return 'new_supporting_blog';
  }

  // mixed
  if (localPackPresent) return 'create_or_refresh_city_service_page';
  return 'new_supporting_blog';
}

// ── pattern extraction (heuristics from SERP description text) ───────

const CTA_PATTERNS = [
  { label: 'free inspection', re: /\bfree\s+(inspection|estimate|quote|consultation)\b/i },
  { label: 'same-day', re: /\b(same.?day|today|24.?hour|emergency service)\b/i },
  { label: 'call now', re: /\b(call now|call today|call us|call \(\d{3}\))\b/i },
  { label: 'satisfaction guarantee', re: /\b(satisfaction guarantee|guarantee|100% guarantee|money.?back)\b/i },
  { label: 'pet/family safe', re: /\b(pet.?(safe|friendly)|family.?safe|child.?safe|eco.?friendly)\b/i },
  { label: 'licensed/insured', re: /\b(licensed.?(and|&).?insured|licensed.?bonded)\b/i },
];

function extractCtaPatterns(topResults) {
  const found = new Set();
  for (const r of topResults) {
    const text = `${r.title || ''} ${r.description || ''}`;
    for (const { label, re } of CTA_PATTERNS) {
      if (re.test(text)) found.add(label);
    }
  }
  return Array.from(found);
}

function extractReviewPatterns(topResults) {
  let withRating = 0;
  let withCount = 0;
  const counts = [];
  for (const r of topResults) {
    const text = `${r.title || ''} ${r.description || ''}`;
    if (/★|\b\d\.\d\s*(stars?|out of 5)\b/.test(text)) withRating++;
    const m = text.match(/(\d{2,5})\+?\s+reviews?/i);
    if (m) { withCount++; counts.push(parseInt(m[1], 10)); }
  }
  return {
    results_with_rating: withRating,
    results_with_review_count: withCount,
    review_count_samples: counts.slice(0, 5),
  };
}

function extractProofPatterns(topResults) {
  const found = new Set();
  for (const r of topResults) {
    const text = `${r.title || ''} ${r.description || ''}`;
    if (/\bsince\s+(19|20)\d{2}\b/i.test(text)) found.add('established date');
    if (/\bfamily.?(owned|operated)\b/i.test(text)) found.add('family-owned');
    if (/\bBBB\b|\baccredited\b/i.test(text)) found.add('BBB accreditation');
    if (/\b(licensed|insured|bonded)\b/i.test(text)) found.add('credentials');
    if (/\bservice (areas?|locations?)\b/i.test(text)) found.add('service-area mention');
    if (/\b\d+\+?\s*(years?|customers?|clients?|reviews?)\b/i.test(text)) found.add('quantified claim');
    if (/\bfree\b/i.test(text)) found.add('free offer');
  }
  return Array.from(found);
}

function computeDirectorySaturation(topPageTypes) {
  if (!topPageTypes.length) return 0;
  const directories = topPageTypes.filter((t) => t === 'directory').length;
  return directories / topPageTypes.length;
}

function detectSerpGap({ topResults, dominantPageType, intent }) {
  // v1 heuristic. Real gap detection is hard without page fetches.
  // Look for high-impression intent where every top result is a directory
  // or where no result actually mentions the local city.
  if (topResults.length === 0) return 'no top-10 data returned';
  const directoryShare = topResults.filter((r) => classifyResultPageType(r) === 'directory').length / topResults.length;
  if (directoryShare >= 0.5) return 'top 10 dominated by aggregator directories — opportunity for branded local landing page';
  if (intent === 'transactional-local' && dominantPageType !== 'city-service') return 'transactional-local intent but top 10 lacks a clear city-service winner';
  if (intent === 'informational' && dominantPageType === 'public-health') return 'public-health resources dominate — Waves cannot displace .gov; consider supporting/sidebar content only';
  return null;
}

function confidenceScore({ topPageTypes, shareOfDominant, totalItems }) {
  // Higher confidence when:
  //   - we got a full 10 organic results
  //   - one page type clearly dominates (≥0.5 share)
  if (!totalItems) return 0;
  let conf = 0.4;
  if (totalItems >= 10) conf += 0.2;
  if (shareOfDominant >= 0.6) conf += 0.25;
  else if (shareOfDominant >= 0.4) conf += 0.15;
  if (topPageTypes.length >= 8) conf += 0.1;
  return Math.min(1, Math.round(conf * 1000) / 1000);
}

// ── DataForSEO response parsing ──────────────────────────────────────

function extractTopOrganic(dataforseoResult, limit = 10) {
  const items = dataforseoResult?.items || [];
  return items
    .filter((i) => i.type === 'organic')
    .slice(0, limit)
    .map((i) => ({
      url: i.url,
      domain: (i.domain || '').replace(/^www\./, ''),
      title: i.title,
      description: i.description,
      rank_absolute: i.rank_absolute,
      rank_group: i.rank_group,
    }));
}

function extractLocalPack(dataforseoResult) {
  const items = dataforseoResult?.items || [];
  const lp = items.find((i) => i.type === 'local_pack');
  if (!lp) return [];
  return (lp.items || []).slice(0, 10).map((b) => ({
    name: b.title,
    rating: b.rating?.value || null,
    review_count: b.rating?.votes_count || null,
    domain: b.domain,
    phone: b.phone,
    address: b.address,
  }));
}

function extractPaaQuestions(dataforseoResult) {
  const items = dataforseoResult?.items || [];
  const out = [];
  for (const item of items) {
    if (item.type === 'people_also_ask') {
      for (const q of item.items || []) {
        if (q.type === 'people_also_ask_element' && q.title) out.push(q.title);
      }
    }
  }
  return out;
}

function extractAiOverview(dataforseoResult) {
  const items = dataforseoResult?.items || [];
  const ai = items.find((i) => i.type === 'ai_overview');
  if (!ai) return { present: false, sources: [] };
  const sources = (ai.items || [])
    .filter((s) => s.url)
    .map((s) => ({ url: s.url, domain: (s.domain || '').replace(/^www\./, ''), title: s.title }));
  return { present: true, sources };
}

function hasLocalPack(dataforseoResult) {
  return (dataforseoResult?.items || []).some((i) => i.type === 'local_pack');
}

function brandedMatch(query, topResults) {
  if (!query) return false;
  const q = query.toLowerCase();
  if (!/(waves|waveguard|wave guard)/.test(q)) return false;
  return topResults.some((r) => /wavespestcontrol|wavespest/.test((r.domain || '').toLowerCase()));
}

function resolveLocation(city) {
  const canonical = CITIES.find((c) => c.toLowerCase() === String(city || '').toLowerCase());
  if (canonical) return `${canonical},Florida,United States`;
  return 'Bradenton,Florida,United States';
}

// ── main class ───────────────────────────────────────────────────────

class SerpProfiler {
  async profile({ query, city = null, device = DEFAULT_DEVICE, force = false, persist = true } = {}) {
    if (!query) throw new Error('serp-profiler: query required');

    if (!force) {
      const cached = await this.getCached({ query, city, device });
      if (cached) return cached;
    }

    if (!dataforseo.configured) {
      throw new Error('serp-profiler: DataForSEO not configured');
    }

    const locationUsed = resolveLocation(city);
    const raw = await dataforseo.serpOrganic(query, locationUsed, device);
    const result = raw?.tasks?.[0]?.result?.[0];
    if (!result) {
      logger.warn(`[serp-profiler] no SERP data for "${query}" in ${locationUsed}`);
      return null;
    }

    const profile = this._buildProfile({ query, city, device, locationUsed, result });
    if (persist) await this._persist(profile);
    return profile;
  }

  _buildProfile({ query, city, device, locationUsed, result }) {
    const topOrganic = extractTopOrganic(result, 10);
    const topPageTypes = topOrganic.map(classifyResultPageType);
    const localPackBusinesses = extractLocalPack(result);
    const paa = extractPaaQuestions(result);
    const ai = extractAiOverview(result);

    const { type: dominantPageType, share: shareOfDominant } = getDominantPageType(topPageTypes);
    const localPackPresent = hasLocalPack(result);
    const hasBrandMatch = brandedMatch(query, topOrganic);
    const intent = classifyIntent({
      query,
      localPackPresent,
      topPageTypes,
      aiOverviewPresent: ai.present,
      hasBrandedMatch: hasBrandMatch,
    });

    const directorySaturation = computeDirectorySaturation(topPageTypes);
    const publicResourcePresent = topPageTypes.includes('public-health');

    const recommendedAssetType = recommendAssetType({
      intent, dominantPageType, localPackPresent,
    });

    const confidence = confidenceScore({
      topPageTypes,
      shareOfDominant,
      totalItems: topOrganic.length,
    });

    const ctaPatterns = extractCtaPatterns(topOrganic);
    const reviewPatterns = extractReviewPatterns(topOrganic);
    const proofPatterns = extractProofPatterns(topOrganic);
    const serpGap = detectSerpGap({ topResults: topOrganic, dominantPageType, intent });

    return {
      query,
      city,
      device,
      location_used: locationUsed,
      fetched_at: new Date(),

      dominant_intent: intent,
      dominant_page_type: dominantPageType,
      recommended_asset_type: recommendedAssetType,
      confidence,

      local_pack_present: localPackPresent,
      ai_overview_present: ai.present,
      public_resource_present: publicResourcePresent,
      directory_saturation: directorySaturation,

      payload: {
        top_organic: topOrganic.map((r, i) => ({ ...r, page_type: topPageTypes[i] })),
        local_pack_businesses: localPackBusinesses,
        paa_questions: paa,
        ai_overview_sources: ai.sources,
        competitor_cta_patterns: ctaPatterns,
        competitor_review_patterns: reviewPatterns,
        competitor_proof_patterns: proofPatterns,
        serp_gap: serpGap,
      },
    };
  }

  // ── cache ──────────────────────────────────────────────────────────

  async getCached({ query, city, device, refetchDays = DEFAULT_REFETCH_DAYS }) {
    const cutoff = new Date(Date.now() - refetchDays * 86400_000);
    const row = await db('serp_snapshots')
      .where('query', query)
      .where('city', toStoredCity(city))
      .where('device', device)
      .where('fetched_at', '>=', cutoff)
      .orderBy('fetched_at', 'desc')
      .first()
      .catch(() => null);
    if (!row) return null;

    return {
      query: row.query,
      city: fromStoredCity(row.city),
      device: row.device,
      location_used: row.location_used,
      fetched_at: row.fetched_at,
      dominant_intent: row.dominant_intent,
      dominant_page_type: row.dominant_page_type,
      recommended_asset_type: row.recommended_asset_type,
      confidence: parseFloat(row.confidence),
      local_pack_present: row.local_pack_present,
      ai_overview_present: row.ai_overview_present,
      public_resource_present: row.public_resource_present,
      directory_saturation: parseFloat(row.directory_saturation),
      payload: typeof row.payload === 'string' ? JSON.parse(row.payload) : row.payload,
      _cache_hit: true,
    };
  }

  async _persist(profile) {
    try {
      await db.raw(
        `INSERT INTO serp_snapshots
          (query, city, device, location_used, dominant_intent,
           dominant_page_type, recommended_asset_type, confidence,
           local_pack_present, ai_overview_present, public_resource_present,
           directory_saturation, payload, fetched_at, fetched_at_day,
           created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?::jsonb, ?, CURRENT_DATE, now(), now())
         ON CONFLICT (query, city, device, fetched_at_day) DO UPDATE
           SET dominant_intent = EXCLUDED.dominant_intent,
               dominant_page_type = EXCLUDED.dominant_page_type,
               recommended_asset_type = EXCLUDED.recommended_asset_type,
               confidence = EXCLUDED.confidence,
               local_pack_present = EXCLUDED.local_pack_present,
               ai_overview_present = EXCLUDED.ai_overview_present,
               public_resource_present = EXCLUDED.public_resource_present,
               directory_saturation = EXCLUDED.directory_saturation,
               payload = EXCLUDED.payload,
               fetched_at = EXCLUDED.fetched_at,
               updated_at = now()
        `,
        [
          profile.query, toStoredCity(profile.city), profile.device, profile.location_used,
          profile.dominant_intent, profile.dominant_page_type,
          profile.recommended_asset_type, profile.confidence,
          profile.local_pack_present, profile.ai_overview_present,
          profile.public_resource_present, profile.directory_saturation,
          JSON.stringify(profile.payload), profile.fetched_at,
        ]
      );
    } catch (err) {
      logger.warn(`[serp-profiler] persist failed: ${err.message}`);
    }
  }

  // ── batch helper for the CLI ───────────────────────────────────────

  async profileBatch(items, { device = DEFAULT_DEVICE, force = false, persist = true } = {}) {
    const out = [];
    for (const it of items) {
      try {
        const p = await this.profile({ query: it.query, city: it.city || null, device, force, persist });
        out.push({ ...it, profile: p });
      } catch (e) {
        out.push({ ...it, error: e.message });
      }
    }
    return out;
  }
}

module.exports = new SerpProfiler();
module.exports.SerpProfiler = SerpProfiler;

// Pure helpers for unit tests.
module.exports._internals = {
  classifyResultPageType,
  getDominantPageType,
  classifyIntent,
  recommendAssetType,
  extractCtaPatterns,
  extractReviewPatterns,
  extractProofPatterns,
  computeDirectorySaturation,
  detectSerpGap,
  confidenceScore,
  extractTopOrganic,
  extractLocalPack,
  extractPaaQuestions,
  extractAiOverview,
  hasLocalPack,
  brandedMatch,
  resolveLocation,
};
