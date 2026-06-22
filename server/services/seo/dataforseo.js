/**
 * DataForSEO REST API Client
 * Auth: Basic auth with login:password
 * Base URL: https://api.dataforseo.com/v3
 * Rate limiting: 2000 tasks/minute
 * Gated behind GATE_SEO_INTELLIGENCE
 */

const logger = require('../logger');

const BASE_URL = 'https://api.dataforseo.com/v3';

function normalizeIndexedUrl(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, '')
    .replace(/^www\./, '')
    .replace(/\/$/, '');
}

function hasUrlBoundary(candidate, clean) {
  if (!candidate.startsWith(clean)) return false;
  const next = candidate.charAt(clean.length);
  return next === '/' || next === '?' || next === '#';
}

class DataForSEO {
  constructor() {
    this.login = process.env.DATAFORSEO_LOGIN;
    this.password = process.env.DATAFORSEO_PASSWORD;
  }

  get configured() {
    return !!(this.login && this.password);
  }

  get authHeader() {
    return 'Basic ' + Buffer.from(`${this.login}:${this.password}`).toString('base64');
  }

  async request(endpoint, body, retries = 3) {
    const { isEnabled } = require('../../config/feature-gates');
    if (!isEnabled('seoIntelligence')) {
      logger.info(`[GATE BLOCKED] DataForSEO: ${endpoint}`);
      return null;
    }

    if (!this.configured) {
      logger.warn('[dataforseo] DATAFORSEO_LOGIN/PASSWORD not set');
      return null;
    }

    for (let attempt = 1; attempt <= retries; attempt++) {
      try {
        const res = await fetch(`${BASE_URL}${endpoint}`, {
          method: 'POST',
          headers: {
            'Authorization': this.authHeader,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(body),
        });

        if (res.status === 429) {
          const wait = Math.min(1000 * Math.pow(2, attempt), 10000);
          logger.warn(`[dataforseo] Rate limited, retrying in ${wait}ms`);
          await new Promise(r => setTimeout(r, wait));
          continue;
        }

        if (!res.ok) {
          logger.error(`[dataforseo] ${res.status}: ${res.statusText}`);
          return null;
        }

        const data = await res.json();

        if (data.tasks?.[0]?.result) {
          const cost = data.tasks[0].cost || 0;
          if (cost > 0) logger.info(`[dataforseo] ${endpoint} cost: $${cost}`);
        }

        return data;
      } catch (err) {
        if (attempt === retries) {
          logger.error(`[dataforseo] Failed after ${retries} attempts: ${err.message}`);
          return null;
        }
        await new Promise(r => setTimeout(r, 1000 * attempt));
      }
    }
    return null;
  }

  // SERP — organic results. Caller-overridable device so the serp-profiler
  // can cache distinct mobile vs desktop snapshots; defaults to mobile to
  // preserve the prior call shape (serp-analyzer.js etc. pass 2 args).
  async serpOrganic(keyword, location = 'Bradenton,Florida,United States', device = 'mobile') {
    return this.request('/serp/google/organic/live/advanced', [{
      keyword,
      location_name: location,
      language_name: 'English',
      device,
      os: device === 'desktop' ? 'macos' : 'iOS',
    }]);
  }

  // SERP — Map Pack
  async serpMaps(keyword, location = 'Bradenton,Florida,United States') {
    return this.request('/serp/google/maps/live/advanced', [{
      keyword,
      location_name: location,
      language_name: 'English',
    }]);
  }

  // Backlinks for domain. dofollowOnly defaults true to preserve every existing
  // caller (verifier, scanCompetitorGaps); the deep-harvest passes false so the
  // scorer can also see nofollow opportunities (plan §4.1 — the prior hard
  // filter made nofollow links invisible).
  async getBacklinks(target, limit = 1000, { dofollowOnly = true } = {}) {
    // order_by uses the COMMA format ('rank,desc'); the prior 'rank.desc' (dot)
    // is rejected by DataForSEO with 40501 Invalid Field and silently returned
    // null — which is why scanCompetitorGaps never populated seo_competitor_backlinks.
    // rank_scale: one_hundred so domain_from_rank is 0–100 (DR semantics) — the
    // default one_thousand would store inflated DR in seo_backlinks /
    // seo_competitor_backlinks once this (newly un-broken) call returns data.
    const task = { target, limit, order_by: ['rank,desc'], rank_scale: 'one_hundred' };
    if (dofollowOnly) task.filters = ['dofollow', '=', true];
    return this.request('/backlinks/backlinks/live', [task]);
  }

  // Every referring domain pointing at a target — one row per domain
  // (domain, rank, backlinks count, first/last seen). The cheap, correct
  // primitive for "every site that links to competitor X" (deep harvest).
  async getReferringDomains(target, { limit = 1000, offset = 0 } = {}) {
    // No order_by — the referring_domains endpoint rejects it (40501 Invalid
    // Field). Callers sort client-side; DataForSEO returns highest-rank first.
    // offset enables paging past the 1000/call cap (result carries total_count).
    // rank_scale: one_hundred so `rank` comes back 0–100 (DR semantics) — the
    // default one_thousand would saturate scoreProspect's 0–100 DR clamp and
    // store 1000-scale values as DR.
    return this.request('/backlinks/referring_domains/live', [{ target, limit, offset, rank_scale: 'one_hundred' }]);
  }

  // Bulk domain rank for up to 1000 targets in ONE call (credit discipline).
  async bulkRanks(targets) {
    if (!Array.isArray(targets) || targets.length === 0) return null;
    return this.request('/backlinks/bulk_ranks/live', [{ targets }]);
  }

  // Bulk backlink spam score for up to 1000 targets in ONE call — feeds the
  // spam/PBN drop-filter before we spend LLM/contact budget on a domain.
  async bulkSpamScore(targets) {
    if (!Array.isArray(targets) || targets.length === 0) return null;
    return this.request('/backlinks/bulk_spam_score/live', [{ targets }]);
  }

  // Keyword search volume
  async searchVolume(keywords) {
    return this.request('/keywords_data/google_ads/search_volume/live', [{
      keywords,
      location_code: 1015116, // Sarasota-Bradenton-North Port DMA
      language_code: 'en',
    }]);
  }

  // On-page audit
  async onPageAudit(url) {
    return this.request('/on_page/instant_pages', [{
      url,
      enable_javascript: true,
    }]);
  }

  // DataForSEO Labs — every keyword a domain ranks for (top ~100) in
  // Google's US database, ordered by search volume. Labs data is
  // national-level: a domain "not ranking" here means outside the top
  // ~100, NOT that no page exists — callers must join against the live
  // sitemap before treating a keyword as a page gap. ~$0.01 base +
  // $0.0001/row per call. `filters` passes through to the Labs filter
  // grammar (e.g. [['keyword_data.keyword','like','%sarasota%']]).
  async rankedKeywords(target, { limit = 1000, filters = null } = {}) {
    const task = {
      target,
      location_code: 2840, // United States — Labs national database
      language_code: 'en',
      limit,
      // Organic only — the Labs default is ['organic','paid'], and a paid
      // row would read as fake organic evidence downstream (Codex P2,
      // PR #1645).
      item_types: ['organic'],
      order_by: ['keyword_data.keyword_info.search_volume,desc'],
    };
    if (filters) task.filters = filters;
    return this.request('/dataforseo_labs/google/ranked_keywords/live', [task]);
  }

  // DataForSEO Labs — domains whose organic keyword set overlaps the
  // target's the most (ordered by intersections). exclude_top_domains
  // drops Wikipedia-class giants; the count filter drops one-keyword
  // accidental overlaps.
  async competitorsDomain(target, { limit = 40, minSharedKeywords = 30 } = {}) {
    return this.request('/dataforseo_labs/google/competitors_domain/live', [{
      target,
      location_code: 2840,
      language_code: 'en',
      limit,
      exclude_top_domains: true,
      filters: [['metrics.organic.count', '>', minSharedKeywords]],
    }]);
  }

  // Is an (external) URL in Google's index? Uses a `site:` SERP lookup.
  // Returns 'indexed' | 'not_indexed' | 'unknown' (call failed / not configured).
  async checkIndexed(url) {
    try {
      const clean = normalizeIndexedUrl(url);
      const data = await this.request('/serp/google/organic/live/advanced', [{
        keyword: `site:${clean}`,
        location_name: 'Bradenton,Florida,United States',
        language_name: 'English',
        device: 'desktop',
        os: 'macos',
      }]);
      const result = data?.tasks?.[0]?.result?.[0];
      if (!result || !Array.isArray(result.items)) return 'unknown';
      const items = result.items;
      const found = items.some((i) => {
        const u = normalizeIndexedUrl(i.url || '');
        return u === clean || hasUrlBoundary(u, clean);
      });
      return found ? 'indexed' : 'not_indexed';
    } catch {
      return 'unknown';
    }
  }
}

module.exports = new DataForSEO();
module.exports.DataForSEO = DataForSEO;
module.exports._test = { hasUrlBoundary, normalizeIndexedUrl };
