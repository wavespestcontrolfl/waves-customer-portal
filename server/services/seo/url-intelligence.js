const db = require('../../models/db');
const logger = require('../logger');
const { etDateString, addETDays } = require('../../utils/datetime-et');
const {
  normalizeUrl,
  extractDomain,
  classifyDomainRole,
  inferCityFromUrl,
  inferServiceFromUrl,
  classifyPageType,
  NETWORK_DOMAINS,
} = require('../../utils/normalize-url');
const { computeBodySimilarity } = require('../../utils/text-similarity');
const crypto = require('crypto');

// Geographic conversion weights from docs/seo/waves-seo-rubric.yaml
const GEO_WEIGHTS = {
  bradenton: 1.0,
  lakewood_ranch: 1.2,
  sarasota: 1.1,
  venice: 1.5,
  north_port: 0.9,
  parrish: 0.7,
  palmetto: 0.6,
  ellenton: 0.5,
};

// Revenue priority by service from server/services/content/scoring-config.js
const REVENUE_PRIORITY = {
  termite: 1.0,
  rodent: 0.9,
  mosquito: 0.8,
  pest: 0.75,
  lawn: 0.6,
  'tree-shrub': 0.5,
  tree_shrub: 0.5,
  specialty: 0.4,
};

// Diagnosis severity multipliers for priority scoring
const DIAGNOSIS_SEVERITY = {
  indexation_problem: 1.5,
  canonical_problem: 1.3,
  duplicate_content: 1.2,
  technical_performance: 1.2,
  cannibalization: 1.1,
  ranking_decay: 1.0,
  ctr_problem: 0.9,
  thin_local_proof: 0.8,
  structured_data: 0.7,
  internal_linking: 0.7,
  freshness: 0.6,
  low_value: 0.3,
  healthy: 0.0,
  unknown: 0.5,
};

const DIAGNOSIS_TO_STATUS = {
  healthy: 'healthy',
  indexation_problem: 'needs_indexation_fix',
  canonical_problem: 'needs_canonical_fix',
  duplicate_content: 'needs_canonical_fix',
  technical_performance: 'needs_technical_fix',
  ranking_decay: 'needs_content_refresh',
  ctr_problem: 'needs_content_refresh',
  thin_local_proof: 'needs_content_refresh',
  freshness: 'needs_content_refresh',
  cannibalization: 'review_required',
  structured_data: 'needs_technical_fix',
  internal_linking: 'needs_technical_fix',
  low_value: 'low_priority',
  unknown: 'unknown',
};

const DIAGNOSIS_TO_ACTION = {
  indexation_problem: {
    action: 'Improve uniqueness, local proof, content depth, internal links. Check robots/noindex directives.',
    alt: 'Submit via IndexNow after content improvements. Verify via URL Inspection API.',
    approval: 'review',
  },
  canonical_problem: {
    action: 'Verify canonical tag matches intended URL. Check for hub/spoke cross-domain confusion.',
    alt: 'If Google selected different canonical, differentiate content or consolidate.',
    approval: 'manual',
  },
  duplicate_content: {
    action: 'Differentiate page content from similar URL (body similarity > 85%). Add unique local proof.',
    alt: 'Merge/redirect if pages serve the same intent.',
    approval: 'manual',
  },
  technical_performance: {
    action: 'Fix HTTP errors, CWV failures, or rendering issues. Check status code and redirect chains.',
    alt: 'Group by template to fix at the template level if multiple pages affected.',
    approval: 'review',
  },
  cannibalization: {
    action: 'Choose one winner URL for the query cluster. Consolidate internal links to the winner.',
    alt: 'Differentiate intent between competing pages and update titles/content.',
    approval: 'manual',
  },
  ranking_decay: {
    action: 'Refresh content — update intro, add new sections, improve local proof, update dateModified.',
    alt: 'Check if decay is seasonal before rewriting.',
    approval: 'review',
  },
  ctr_problem: {
    action: 'Rewrite title tag and meta description to improve click-through rate.',
    alt: 'Check SERP features — snippet may be suppressed by featured snippet or AI overview.',
    approval: 'review',
  },
  thin_local_proof: {
    action: 'Add neighborhoods, subdivisions, local pest pressure, photos, technician notes.',
    alt: 'If page has low demand, consider merging into parent city page.',
    approval: 'review',
  },
  structured_data: {
    action: 'Add missing schema markup (LocalBusiness, Service, BreadcrumbList).',
    alt: 'Validate existing schema for errors via Rich Results Test.',
    approval: 'auto',
  },
  internal_linking: {
    action: 'Add internal links from related city, service, and hub pages.',
    alt: 'Check if page is orphaned — add to navigation or sitemap.',
    approval: 'auto',
  },
  freshness: {
    action: 'Review page for outdated information. Update if materially changed.',
    alt: 'If content is still accurate, no action needed.',
    approval: 'review',
  },
  low_value: {
    action: 'Evaluate whether page should exist. Consider noindex or redirect.',
    alt: 'If targeting valid query, improve content quality.',
    approval: 'manual',
  },
  healthy: { action: 'No action needed — monitor for changes.', alt: null, approval: null },
  unknown: { action: 'Run site audit and GSC sync to populate data.', alt: null, approval: 'review' },
};

// Concurrency-limited promise pool
async function promisePool(items, concurrency, fn) {
  const results = [];
  let i = 0;
  async function worker() {
    while (i < items.length) {
      const idx = i++;
      try {
        results[idx] = { status: 'fulfilled', value: await fn(items[idx]) };
      } catch (e) {
        results[idx] = { status: 'rejected', reason: e };
      }
    }
  }
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, () => worker());
  await Promise.all(workers);
  return results;
}

function urlLookupVariants(rawUrl) {
  const normalized = normalizeUrl(rawUrl);
  if (!normalized) return [];
  const withoutWww = normalized.replace(/^www\./, '');
  const withWww = withoutWww ? `www.${withoutWww}` : normalized;
  const bases = [...new Set([normalized, withoutWww, withWww].filter(Boolean))];
  return [...new Set(bases.flatMap((u) => [
    u,
    `${u}/`,
    `https://${u}`,
    `https://${u}/`,
    `http://${u}`,
    `http://${u}/`,
  ]))];
}

function applyDiagnosisFields(record, service) {
  const primaryDiagnosis = service.diagnoseUrl(record);
  const actionDef = DIAGNOSIS_TO_ACTION[primaryDiagnosis] || DIAGNOSIS_TO_ACTION.unknown;
  return {
    primary_diagnosis: primaryDiagnosis,
    primary_status: DIAGNOSIS_TO_STATUS[primaryDiagnosis] || 'unknown',
    priority_score: service.computePriorityScore({ ...record, primary_diagnosis: primaryDiagnosis }),
    recommended_action: actionDef.action,
    alternative_action: actionDef.alt,
    approval_level: actionDef.approval,
  };
}

class UrlIntelligence {
  // ── Pure functions ──────────────────────────────────────────────────

  diagnoseUrl(record) {
    // Priority-ordered waterfall — first match wins
    if (
      record.in_sitemap &&
      record.coverage_state &&
      record.coverage_state !== 'Submitted and indexed'
    ) {
      return 'indexation_problem';
    }

    if (record.canonical_match === false) {
      return 'canonical_problem';
    }

    if (record.body_similarity_max && parseFloat(record.body_similarity_max) > 85) {
      return 'duplicate_content';
    }

    if (
      (record.status_code && record.status_code >= 400) ||
      record.technical_qa_score !== null && record.technical_qa_score < 40
    ) {
      return 'technical_performance';
    }

    if (record._has_cannibalization) {
      return 'cannibalization';
    }

    if (record._has_decay_alerts) {
      return 'ranking_decay';
    }

    if (
      record.gsc_avg_position_28d &&
      parseFloat(record.gsc_avg_position_28d) <= 5 &&
      record.gsc_ctr_28d &&
      parseFloat(record.gsc_ctr_28d) < 0.02
    ) {
      return 'ctr_problem';
    }

    if (
      record.word_count !== null &&
      record.word_count < 300 &&
      ['city', 'service', 'city-service'].includes(record.page_type)
    ) {
      return 'thin_local_proof';
    }

    if (record.technical_qa_score !== null && record.technical_qa_score < 60 && !record.content_hash) {
      return 'structured_data';
    }

    if (record.internal_links_in !== null && record.internal_links_in < 2) {
      return 'internal_linking';
    }

    if (
      record.last_audit_at &&
      Date.now() - new Date(record.last_audit_at).getTime() > 90 * 24 * 60 * 60 * 1000
    ) {
      return 'freshness';
    }

    if (
      (!record.gsc_impressions_28d || record.gsc_impressions_28d < 10) &&
      !record.in_sitemap
    ) {
      return 'low_value';
    }

    return 'healthy';
  }

  computePriorityScore(record) {
    let score = 0;

    // Technical health component (0-20)
    if (record.technical_qa_score !== null && record.technical_qa_score !== undefined) {
      score += Math.round((record.technical_qa_score / 100) * 20);
    }

    // GSC traffic signal (0-25)
    const impressions = record.gsc_impressions_28d || 0;
    if (impressions > 1000) score += 25;
    else if (impressions > 500) score += 20;
    else if (impressions > 100) score += 15;
    else if (impressions > 10) score += 10;
    else if (impressions > 0) score += 5;

    // Position opportunity (0-20): positions 4-15 are highest opportunity
    const pos = record.gsc_avg_position_28d ? parseFloat(record.gsc_avg_position_28d) : null;
    if (pos !== null) {
      if (pos >= 4 && pos <= 5) score += 20;      // striking distance top-3
      else if (pos >= 6 && pos <= 10) score += 15; // page 1 bottom
      else if (pos >= 11 && pos <= 15) score += 12; // page 2 top
      else if (pos >= 1 && pos <= 3) score += 8;   // already strong, protect
      else if (pos >= 16 && pos <= 20) score += 5;
    }

    // Diagnosis severity multiplier
    const diagnosis = record.primary_diagnosis || 'unknown';
    const severity = DIAGNOSIS_SEVERITY[diagnosis] || 0.5;
    score = Math.round(score * (0.5 + severity));

    // Geographic weight
    const city = record.city || '';
    const geoWeight = GEO_WEIGHTS[city] || GEO_WEIGHTS[city.replace(/-/g, '_')] || 1.0;
    score = Math.round(score * geoWeight);

    // Service revenue weight
    const service = record.service || '';
    const revWeight = REVENUE_PRIORITY[service] || REVENUE_PRIORITY[service.replace(/_/g, '-')] || 0.5;
    score = Math.round(score * (0.5 + revWeight));

    return Math.min(100, Math.max(0, score));
  }

  // ── Data refresh ────────────────────────────────────────────────────

  async refreshUrl(rawUrl) {
    const url = normalizeUrl(rawUrl);
    if (!url) return null;

    const domain = extractDomain(url);
    const hubOrSpoke = classifyDomainRole(domain);
    const city = inferCityFromUrl(url);
    const service = inferServiceFromUrl(url);
    const pageType = classifyPageType(url);

    // Source tables may store URLs with scheme/www/trailing slash — try multiple forms
    const urlVariants = urlLookupVariants(url);

    // Fetch latest audit data
    const audit = await db('seo_page_audits')
      .whereIn('url', urlVariants)
      .orderBy('audit_date', 'desc')
      .first();

    // Fetch index status
    const indexStatus = await db('content_index_status')
      .whereIn('url', urlVariants)
      .first();

    // Fetch 28d GSC performance — try exact match, then with https:// prefix
    const now = etDateString();
    const d28ago = etDateString(addETDays(new Date(), -28));
    let gsc = await db('gsc_pages')
      .where('page_url', url)
      .where('date', '>=', d28ago)
      .select(
        db.raw('SUM(clicks) as clicks'),
        db.raw('SUM(impressions) as impressions'),
        db.raw('AVG(ctr) as ctr'),
        db.raw('AVG(position) as position'),
      )
      .first();

    // If no match on normalized URL, try with https://
    if (!gsc || !gsc.impressions) {
      gsc = await db('gsc_pages')
        .where('page_url', 'like', `%${url}%`)
        .where('date', '>=', d28ago)
        .select(
          db.raw('SUM(clicks) as clicks'),
          db.raw('SUM(impressions) as impressions'),
          db.raw('AVG(ctr) as ctr'),
          db.raw('AVG(position) as position'),
        )
        .first();
    }

    // Fetch content QA
    const contentQa = await db('seo_content_qa_scores')
      .where('url', url)
      .orderBy('created_at', 'desc')
      .first();

    // Fetch backlink count
    const backlinkRow = await db('seo_backlinks')
      .where('target_url', 'like', `%${url}%`)
      .where('status', 'active')
      .count('id as count')
      .first();

    // Check for active decay alerts
    const decayCount = await db('seo_content_decay_alerts')
      .where('url', url)
      .where('status', 'open')
      .count('id as count')
      .first();

    // Check for cannibalization flags — URL appears in the JSONB urls array
    const cannibalCount = await db('seo_cannibalization_flags')
      .whereRaw("urls::text LIKE ?", [`%${url}%`])
      .where('status', 'open')
      .count('id as count')
      .first();

    // Build record
    const record = {
      url,
      domain,
      hub_or_spoke: hubOrSpoke,
      page_type: pageType,
      city,
      service,
      template_type: pageType, // same for now — refine later per template registry

      // Canonical
      user_declared_canonical: audit ? normalizeUrl(audit.canonical_url) : null,
      google_selected_canonical: indexStatus ? normalizeUrl(indexStatus.canonical_url) : null,
      canonical_match: null,

      // Indexation
      index_status: indexStatus?.coverage_state || null,
      coverage_state: indexStatus?.coverage_state || null,
      indexing_state: indexStatus?.indexing_state || null,
      in_sitemap: indexStatus?.in_sitemap ?? null,

      // Technical
      status_code: audit?.status_code || null,
      robots_directive: audit?.robots_meta || null,
      redirect_target: audit?.redirect_target || null,

      // Content
      content_hash: audit?.content_hash || null,
      word_count: audit?.word_count || null,
      title: audit?.meta_title || null,
      meta_description: audit?.meta_description || null,
      h1: audit?.h1_text || null,

      // Links
      internal_links_in: null, // cross-URL inbound links — computed separately
      internal_links_out: audit?.internal_links_count || 0,
      backlinks_count: parseInt(backlinkRow?.count) || 0,

      // GSC
      gsc_clicks_28d: parseInt(gsc?.clicks) || 0,
      gsc_impressions_28d: parseInt(gsc?.impressions) || 0,
      gsc_ctr_28d: gsc?.ctr ? parseFloat(gsc.ctr) : null,
      gsc_avg_position_28d: gsc?.position ? parseFloat(gsc.position) : null,

      // Scores
      technical_qa_score: audit?.technical_health_score ?? null,
      content_qa_score: contentQa?.total_score ?? null,
      local_qa_score: contentQa?.local_score ?? null,

      // Timestamps
      last_audit_at: audit?.audit_date || null,
      last_gsc_sync_at: gsc?.impressions ? now : null,
      last_inspection_at: indexStatus?.inspection_checked_at || null,

      // Transient flags for diagnosis
      _has_decay_alerts: parseInt(decayCount?.count) > 0,
      _has_cannibalization: parseInt(cannibalCount?.count) > 0,
    };

    // Compute canonical match
    if (record.user_declared_canonical && record.google_selected_canonical) {
      record.canonical_match =
        normalizeUrl(record.user_declared_canonical) === normalizeUrl(record.google_selected_canonical);
    } else if (indexStatus?.canonical_matches !== null && indexStatus?.canonical_matches !== undefined) {
      record.canonical_match = indexStatus.canonical_matches;
    }

    Object.assign(record, applyDiagnosisFields(record, this));

    // Strip transient flags before upsert
    const { _has_decay_alerts, _has_cannibalization, ...upsertData } = record;
    upsertData.last_refreshed_at = db.fn.now();

    await db('seo_url_intelligence')
      .insert(upsertData)
      .onConflict('url')
      .merge();

    return upsertData;
  }

  async refreshDomain(domain) {
    const start = Date.now();
    const normalizedDomain = extractDomain(domain) || 'wavespestcontrol.com';

    // Collect all known URLs for this domain from multiple sources
    const urlSet = new Set();

    const auditUrls = await db('seo_page_audits')
      .select('url')
      .where('url', 'like', `%${normalizedDomain}%`)
      .groupBy('url');
    auditUrls.forEach((r) => urlSet.add(normalizeUrl(r.url)));

    const indexUrls = await db('content_index_status')
      .select('url')
      .where('url', 'like', `%${normalizedDomain}%`);
    indexUrls.forEach((r) => urlSet.add(normalizeUrl(r.url)));

    const gscUrls = await db('gsc_pages')
      .select('page_url')
      .where('domain', normalizedDomain)
      .groupBy('page_url');
    gscUrls.forEach((r) => urlSet.add(normalizeUrl(r.page_url)));

    const urls = [...urlSet].filter(Boolean);
    logger.info(`[UrlIntelligence] refreshDomain ${normalizedDomain}: ${urls.length} URLs found`);

    const results = await promisePool(urls, 5, (u) => this.refreshUrl(u));
    const succeeded = results.filter((r) => r.status === 'fulfilled').length;
    const failed = results.filter((r) => r.status === 'rejected').length;

    if (failed > 0) {
      const errors = results
        .filter((r) => r.status === 'rejected')
        .slice(0, 3)
        .map((r) => r.reason?.message || String(r.reason));
      logger.warn(`[UrlIntelligence] refreshDomain ${normalizedDomain}: ${failed} failures`, { errors });
    }

    return {
      domain: normalizedDomain,
      urls_refreshed: succeeded,
      urls_failed: failed,
      urls_total: urls.length,
      duration_ms: Date.now() - start,
    };
  }

  async refreshDiagnoses(domain) {
    const d = extractDomain(domain) || 'wavespestcontrol.com';
    const rows = await db('seo_url_intelligence').where('domain', d);
    let updated = 0;

    for (const row of rows) {
      const [decayCount, cannibalCount] = await Promise.all([
        db('seo_content_decay_alerts')
          .where('url', row.url)
          .where('status', 'open')
          .count('id as count')
          .first(),
        db('seo_cannibalization_flags')
          .whereRaw("urls::text LIKE ?", [`%${row.url}%`])
          .where('status', 'open')
          .count('id as count')
          .first(),
      ]);

      const diagnosisRecord = {
        ...row,
        _has_decay_alerts: parseInt(decayCount?.count) > 0,
        _has_cannibalization: parseInt(cannibalCount?.count) > 0,
      };
      const fields = applyDiagnosisFields(diagnosisRecord, this);

      await db('seo_url_intelligence')
        .where('id', row.id)
        .update({ ...fields, last_refreshed_at: db.fn.now() });
      updated++;
    }

    logger.info(`[UrlIntelligence] refreshDiagnoses ${d}: ${updated} URLs refreshed`);
    return { domain: d, diagnoses_refreshed: updated };
  }

  // ── Query methods ───────────────────────────────────────────────────

  async getUrlIntelligence(rawUrl) {
    const url = normalizeUrl(rawUrl);
    const row = await db('seo_url_intelligence').where('url', url).first();
    if (!row) return null;

    // Enrich with related data
    const decayAlerts = await db('seo_content_decay_alerts')
      .where('url', url)
      .where('status', 'open')
      .orderBy('created_at', 'desc')
      .limit(5);

    const cannibalization = await db('seo_cannibalization_flags')
      .whereRaw("urls::text LIKE ?", [`%${url}%`])
      .where('status', 'open')
      .limit(5);

    const experiments = await db('seo_url_experiments')
      .where('url', url)
      .orderBy('created_at', 'desc')
      .limit(5);

    return {
      ...row,
      decay_alerts: decayAlerts,
      cannibalization_flags: cannibalization,
      experiments,
    };
  }

  async scanByDiagnosis(diagnosis, domain, { limit = 50, offset = 0 } = {}) {
    let query = db('seo_url_intelligence')
      .orderBy('priority_score', 'desc')
      .limit(limit)
      .offset(offset);

    if (diagnosis) query = query.where('primary_diagnosis', diagnosis);
    if (domain) query = query.where('domain', extractDomain(domain));

    const urls = await query;

    let countQuery = db('seo_url_intelligence').count('id as total');
    if (diagnosis) countQuery = countQuery.where('primary_diagnosis', diagnosis);
    if (domain) countQuery = countQuery.where('domain', extractDomain(domain));
    const [{ total }] = await countQuery;

    return { urls, total: parseInt(total), limit, offset };
  }

  async getIndexationGap(domain) {
    const d = domain ? extractDomain(domain) : null;
    let baseQuery = db('seo_url_intelligence');
    if (d) baseQuery = baseQuery.where('domain', d);

    const submitted = await baseQuery.clone().where('in_sitemap', true).count('id as count').first();
    const indexed = await baseQuery.clone()
      .where('coverage_state', 'Submitted and indexed')
      .count('id as count')
      .first();

    const byCoverage = await baseQuery.clone()
      .select('coverage_state')
      .count('id as count')
      .groupBy('coverage_state')
      .orderBy('count', 'desc');

    const submittedCount = parseInt(submitted?.count) || 0;
    const indexedCount = parseInt(indexed?.count) || 0;
    const gap = submittedCount - indexedCount;
    const gapPct = submittedCount > 0 ? Math.round((gap / submittedCount) * 100) : 0;

    return {
      domain: d || 'all',
      submitted: submittedCount,
      indexed: indexedCount,
      gap,
      gap_pct: gapPct,
      by_coverage_state: byCoverage.map((r) => ({
        coverage_state: r.coverage_state || 'unknown',
        count: parseInt(r.count),
      })),
    };
  }

  async getCanonicalConflicts(domain) {
    let query = db('seo_canonical_conflicts').orderBy('created_at', 'desc');
    if (domain) {
      const d = extractDomain(domain);
      query = query.where(function () {
        this.where('spoke_domain', d).orWhere('hub_domain', d);
      });
    }
    return query;
  }

  async detectCanonicalConflicts() {
    // Find URLs where canonical_match is false and they're spoke pages
    const mismatched = await db('seo_url_intelligence')
      .where('canonical_match', false)
      .whereNotNull('google_selected_canonical')
      .whereNotNull('user_declared_canonical');

    let detected = 0;
    for (const row of mismatched) {
      const googleCanonDomain = extractDomain(row.google_selected_canonical);
      const urlDomain = extractDomain(row.url);

      // Cross-domain canonical conflict: Google chose a different domain
      if (googleCanonDomain !== urlDomain) {
        const isSpoke = classifyDomainRole(urlDomain) === 'spoke';
        const isHubCanon = classifyDomainRole(googleCanonDomain) === 'hub';

        if (isSpoke && isHubCanon) {
          // Spoke URL being canonicalized to hub — classic hub/spoke conflict
          const hubRow = await db('seo_url_intelligence')
            .where('url', normalizeUrl(row.google_selected_canonical))
            .first();

          let bodySim = null;
          if (hubRow && row.content_hash && hubRow.content_hash) {
            bodySim = row.content_hash === hubRow.content_hash ? 100 : null;
          }

          let titleSim = null;
          if (hubRow && row.title && hubRow.title) {
            titleSim = row.title.toLowerCase() === hubRow.title.toLowerCase() ? 100 : null;
          }

          await db('seo_canonical_conflicts')
            .insert({
              spoke_url: row.url,
              hub_url: normalizeUrl(row.google_selected_canonical),
              spoke_domain: urlDomain,
              hub_domain: googleCanonDomain,
              user_declared_canonical_spoke: row.user_declared_canonical,
              user_declared_canonical_hub: hubRow?.user_declared_canonical || null,
              google_selected_canonical: row.google_selected_canonical,
              body_similarity_pct: bodySim,
              title_similarity_pct: titleSim,
              recommended_fix: bodySim === 100
                ? 'Differentiate spoke content from hub — add unique local proof, neighborhoods, pest pressure.'
                : 'Verify spoke self-canonical is correct. Check if spoke content provides unique value.',
              status: 'open',
            })
            .onConflict(['spoke_url', 'hub_url'])
            .merge();

          detected++;
        }
      }
    }

    logger.info(`[UrlIntelligence] detectCanonicalConflicts: ${detected} conflicts detected`);
    return { detected };
  }

  // ── Duplicate cluster detection ─────────────────────────────────

  async buildDuplicateClusters(domain) {
    const d = extractDomain(domain) || 'wavespestcontrol.com';

    // Fetch all URLs for domain with classification
    const urls = await db('seo_url_intelligence')
      .where('domain', d)
      .whereNotNull('city')
      .select('url', 'city', 'service', 'page_type', 'content_hash');

    // Also check hub URLs that share city/service with spoke URLs
    const hubUrls = d !== 'wavespestcontrol.com'
      ? await db('seo_url_intelligence')
          .where('domain', 'wavespestcontrol.com')
          .whereIn('city', urls.map((u) => u.city).filter(Boolean))
          .select('url', 'city', 'service', 'page_type', 'content_hash')
      : [];

    const allUrls = [...urls, ...hubUrls];
    let clustersFound = 0;
    const clusterMap = new Map(); // url → cluster_id
    const similarityMap = new Map(); // url → max similarity

    // Build candidate pairs: same city+service or city+page_type
    for (let i = 0; i < allUrls.length; i++) {
      for (let j = i + 1; j < allUrls.length; j++) {
        const a = allUrls[i];
        const b = allUrls[j];
        if (a.url === b.url) continue;

        const sameCity = a.city && b.city && a.city === b.city;
        const sameService = a.service && b.service && a.service === b.service;
        const samePageType = a.page_type && b.page_type && a.page_type === b.page_type;

        if (!sameCity || (!sameService && !samePageType)) continue;

        // Quick check: if content_hash matches exactly → 100%
        if (a.content_hash && b.content_hash && a.content_hash === b.content_hash) {
          const clusterId = clusterMap.get(a.url) || clusterMap.get(b.url) || crypto.randomUUID();
          clusterMap.set(a.url, clusterId);
          clusterMap.set(b.url, clusterId);
          similarityMap.set(a.url, Math.max(similarityMap.get(a.url) || 0, 100));
          similarityMap.set(b.url, Math.max(similarityMap.get(b.url) || 0, 100));
          clustersFound++;
          continue;
        }

        // Fetch body text for Jaccard comparison
        const [auditA, auditB] = await Promise.all([
          db('seo_page_audits').whereIn('url', urlLookupVariants(a.url)).whereNotNull('body_text_5k').orderBy('audit_date', 'desc').first(),
          db('seo_page_audits').whereIn('url', urlLookupVariants(b.url)).whereNotNull('body_text_5k').orderBy('audit_date', 'desc').first(),
        ]);

        if (!auditA?.body_text_5k || !auditB?.body_text_5k) continue;

        const { similarity_pct } = computeBodySimilarity(auditA.body_text_5k, auditB.body_text_5k);

        if (similarity_pct > 80) {
          const existingCluster = clusterMap.get(a.url) || clusterMap.get(b.url);
          const clusterId = existingCluster || crypto.randomUUID();
          clusterMap.set(a.url, clusterId);
          clusterMap.set(b.url, clusterId);
          similarityMap.set(a.url, Math.max(similarityMap.get(a.url) || 0, similarity_pct));
          similarityMap.set(b.url, Math.max(similarityMap.get(b.url) || 0, similarity_pct));
          clustersFound++;

          // Hub/spoke pair with high similarity → canonical conflict
          const domA = extractDomain(a.url);
          const domB = extractDomain(b.url);
          if (domA !== domB && similarity_pct > 85) {
            const spoke = classifyDomainRole(domA) === 'spoke' ? a : b;
            const hub = spoke === a ? b : a;
            await db('seo_canonical_conflicts')
              .insert({
                spoke_url: spoke.url,
                hub_url: hub.url,
                spoke_domain: extractDomain(spoke.url),
                hub_domain: extractDomain(hub.url),
                body_similarity_pct: similarity_pct,
                recommended_fix: `Body similarity ${similarity_pct}% — differentiate spoke content with unique local proof.`,
                status: 'open',
              })
              .onConflict(['spoke_url', 'hub_url'])
              .merge({ body_similarity_pct: similarity_pct, recommended_fix: `Body similarity ${similarity_pct}% — differentiate spoke content with unique local proof.` });
          }
        }
      }
    }

    // Update seo_url_intelligence with similarity + cluster data
    for (const [url, similarity] of similarityMap) {
      const clusterId = clusterMap.get(url);
      const update = { body_similarity_max: similarity };
      if (clusterId) update.duplicate_cluster_id = clusterId;
      await db('seo_url_intelligence')
        .where('url', url)
        .update(update);
    }

    logger.info(`[UrlIntelligence] buildDuplicateClusters ${d}: ${clustersFound} duplicate pairs found`);
    return { domain: d, duplicate_pairs: clustersFound, urls_affected: similarityMap.size };
  }

  // ── Intent routing map ──────────────────────────────────────────

  async buildIntentMap(domain) {
    const d = extractDomain(domain) || 'wavespestcontrol.com';
    const since = etDateString(addETDays(new Date(), -28));

    // Get all query→page relationships from the map
    const queryPages = await db('gsc_query_page_map')
      .where('domain', d)
      .where('date_from', '>=', since)
      .select('query', 'page_url')
      .sum('clicks as clicks')
      .sum('impressions as impressions')
      .avg('position as position')
      .groupBy('query', 'page_url')
      .having(db.raw('sum(impressions) > 10'));

    // Group by query
    const queryMap = new Map();
    for (const row of queryPages) {
      if (!queryMap.has(row.query)) queryMap.set(row.query, []);
      queryMap.get(row.query).push(row);
    }

    let routesCreated = 0;
    let misroutes = 0;

    // Import classification from search-console-v2 patterns
    const intentRules = {
      transactional: ['service', 'city', 'city-service', 'landing'],
      informational: ['blog'],
      commercial: ['blog', 'landing'],
      navigational: ['homepage'],
      emergency: ['service', 'city-service'],
      service: ['service', 'city-service', 'city'],
    };

    const severityMap = {
      blog_for_transactional: 'severe',
      blog_for_emergency: 'severe',
      service_for_informational: 'mild',
      wrong_city: 'moderate',
      wrong_domain: 'moderate',
      competing_pages: 'moderate',
    };

    for (const [query, pages] of queryMap) {
      if (pages.length < 1) continue;

      // Classify query intent
      let intentType = 'service';
      if (/emergency|urgent|asap|24.?hour|same.?day/i.test(query)) intentType = 'emergency';
      else if (/cost|price|how much|cheap|affordable|best|vs|review/i.test(query)) intentType = 'commercial';
      else if (/how to|what is|diy|get rid|identify|sign/i.test(query)) intentType = 'informational';
      else if (/waves|waveguard/i.test(query)) intentType = 'navigational';

      const expectedPageTypes = intentRules[intentType] || ['service'];

      // Find winner (most impressions)
      pages.sort((a, b) => parseInt(b.impressions) - parseInt(a.impressions));
      const winner = pages[0];
      const winnerPageType = classifyPageType(winner.page_url);

      // Check for misroute
      let misrouteType = 'aligned';
      if (!expectedPageTypes.includes(winnerPageType)) {
        if (winnerPageType === 'blog' && ['transactional', 'emergency', 'service'].includes(intentType)) {
          misrouteType = 'blog_for_transactional';
        } else if (['service', 'city-service', 'city'].includes(winnerPageType) && intentType === 'informational') {
          misrouteType = 'service_for_informational';
        } else {
          misrouteType = 'competing_pages';
        }
      }

      // Check for wrong city
      const queryCity = inferCityFromUrl(query); // reuse for query text
      if (queryCity && winnerPageType !== 'blog') {
        const pageCity = inferCityFromUrl(winner.page_url);
        if (pageCity && pageCity !== queryCity) {
          misrouteType = 'wrong_city';
        }
      }

      // Check for competing pages (multiple pages, no clear winner)
      if (pages.length >= 2 && misrouteType === 'aligned') {
        const totalImpr = pages.reduce((s, p) => s + parseInt(p.impressions), 0);
        const winnerShare = parseInt(winner.impressions) / totalImpr;
        if (winnerShare < 0.7) {
          misrouteType = 'competing_pages';
        }
      }

      const severity = severityMap[misrouteType] || 'none';

      // Build cluster key: service + city from query
      const queryService = inferServiceFromUrl(query) || 'general';
      const qCity = inferCityFromUrl(query) || 'general';
      const clusterKey = `${queryService}:${qCity}:${query.substring(0, 100)}`;

      await db('seo_intent_routes')
        .insert({
          query_cluster: clusterKey,
          domain: d,
          intent_type: intentType,
          expected_page_type: expectedPageTypes[0],
          intended_url: null, // set manually later
          actual_winner_url: winner.page_url,
          actual_winner_page_type: winnerPageType,
          competing_urls: pages.length > 1 ? JSON.stringify(pages.slice(1).map((p) => p.page_url)) : null,
          misroute_type: misrouteType,
          misroute_severity: severity,
          impressions_total: pages.reduce((s, p) => s + parseInt(p.impressions), 0),
          clicks_total: pages.reduce((s, p) => s + parseInt(p.clicks), 0),
          status: 'open',
        })
        .onConflict(['query_cluster', 'domain'])
        .merge();

      routesCreated++;
      if (misrouteType !== 'aligned') misroutes++;
    }

    logger.info(`[UrlIntelligence] buildIntentMap ${d}: ${routesCreated} routes, ${misroutes} misroutes`);
    return { domain: d, routes_created: routesCreated, misroutes };
  }

  async getIntentRoutes(domain, { misrouteType, severity, limit = 50, offset = 0 } = {}) {
    let query = db('seo_intent_routes').orderBy('impressions_total', 'desc').limit(limit).offset(offset);
    if (domain) query = query.where('domain', extractDomain(domain));
    if (misrouteType) query = query.where('misroute_type', misrouteType);
    if (severity) query = query.where('misroute_severity', severity);
    return query;
  }

  // ── Internal link graph ─────────────────────────────────────────

  async buildInternalLinkGraph(domain) {
    const d = extractDomain(domain) || 'wavespestcontrol.com';

    // Get latest audit per URL with internal_link_targets
    const audits = await db('seo_page_audits')
      .where('url', 'like', `%${d}%`)
      .whereNotNull('internal_link_targets')
      .select('url', 'internal_link_targets', 'audit_date')
      .orderBy('audit_date', 'desc');

    // Dedupe to latest audit per URL
    const latestByUrl = new Map();
    for (const audit of audits) {
      if (!latestByUrl.has(audit.url)) {
        latestByUrl.set(audit.url, audit);
      }
    }

    const now = new Date();
    const edgeRows = [];
    const edgeKeys = new Set();
    for (const [sourceUrl, audit] of latestByUrl) {
      let targets;
      try {
        targets = typeof audit.internal_link_targets === 'string'
          ? JSON.parse(audit.internal_link_targets)
          : audit.internal_link_targets;
      } catch { continue; }

      if (!Array.isArray(targets)) continue;
      const normalizedSource = normalizeUrl(sourceUrl);
      if (!normalizedSource) continue;
      if (extractDomain(normalizedSource) !== d) continue;

      for (const target of targets) {
        // Resolve relative URLs against the source domain
        let resolved = target;
        if (resolved.startsWith('/')) resolved = `${d}${resolved}`;
        const normalizedTarget = normalizeUrl(resolved);
        if (!normalizedTarget) continue;
        if (extractDomain(normalizedTarget) !== d) continue;

        const edgeKey = `${normalizedSource}::${normalizedTarget}`;
        if (edgeKeys.has(edgeKey)) continue;
        edgeKeys.add(edgeKey);
        edgeRows.push({
          source_url: normalizedSource,
          target_url: normalizedTarget,
          domain: d,
          last_seen_at: now,
        });
      }
    }

    await db.transaction(async (trx) => {
      await trx('seo_internal_link_graph').where('domain', d).del();
      await trx('seo_url_intelligence').where('domain', d).update({ internal_links_in: 0 });

      for (let i = 0; i < edgeRows.length; i += 500) {
        await trx('seo_internal_link_graph').insert(edgeRows.slice(i, i + 500));
      }

      // Compute inbound counts and update seo_url_intelligence
      const inboundCounts = await trx('seo_internal_link_graph')
        .where('domain', d)
        .select('target_url')
        .count('id as inbound')
        .groupBy('target_url');

      for (const row of inboundCounts) {
        await trx('seo_url_intelligence')
          .where('url', row.target_url)
          .update({ internal_links_in: parseInt(row.inbound) });
      }
    });

    // Find orphans: in sitemap but < 2 inbound links
    const orphans = await db('seo_url_intelligence')
      .where('domain', d)
      .where('in_sitemap', true)
      .where('internal_links_in', '<', 2)
      .orderBy('priority_score', 'desc');

    logger.info(`[UrlIntelligence] buildInternalLinkGraph ${d}: ${edgeRows.length} links, ${orphans.length} orphan pages`);
    return { domain: d, links_inserted: edgeRows.length, orphan_pages: orphans.length, orphans: orphans.slice(0, 20) };
  }

  async getOrphanPages(domain) {
    const d = domain ? extractDomain(domain) : null;
    let query = db('seo_url_intelligence')
      .where('in_sitemap', true)
      .where(function () {
        this.where('internal_links_in', '<', 2).orWhereNull('internal_links_in');
      })
      .orderBy('priority_score', 'desc');
    if (d) query = query.where('domain', d);
    return query;
  }

  async getDuplicateClusters(domain) {
    const d = domain ? extractDomain(domain) : null;
    let query = db('seo_url_intelligence')
      .whereNotNull('duplicate_cluster_id')
      .where('body_similarity_max', '>', 80)
      .orderBy('body_similarity_max', 'desc');
    if (d) query = query.where('domain', d);
    return query;
  }

  async getDashboard(domain) {
    const d = domain ? extractDomain(domain) : null;
    let base = db('seo_url_intelligence');
    if (d) base = base.where('domain', d);

    const byStatus = await base.clone()
      .select('primary_status')
      .count('id as count')
      .groupBy('primary_status');

    const byDiagnosis = await base.clone()
      .select('primary_diagnosis')
      .count('id as count')
      .groupBy('primary_diagnosis')
      .orderBy('count', 'desc');

    const totalRow = await base.clone().count('id as count').first();
    const total = parseInt(totalRow?.count) || 0;

    const indexationGap = await this.getIndexationGap(domain);

    const canonicalConflictCount = await db('seo_canonical_conflicts')
      .where('status', 'open')
      .count('id as count')
      .first();

    const topIssues = await base.clone()
      .whereNot('primary_diagnosis', 'healthy')
      .whereNot('primary_diagnosis', 'unknown')
      .orderBy('priority_score', 'desc')
      .limit(10);

    // CWV failing groups by template_type
    const cwvGroups = await base.clone()
      .whereNotNull('technical_qa_score')
      .where('technical_qa_score', '<', 50)
      .select('template_type')
      .count('id as count')
      .groupBy('template_type')
      .orderBy('count', 'desc')
      .limit(5);

    return {
      domain: d || 'all',
      total_urls: total,
      by_status: byStatus.map((r) => ({
        status: r.primary_status,
        count: parseInt(r.count),
      })),
      by_diagnosis: byDiagnosis.map((r) => ({
        diagnosis: r.primary_diagnosis,
        count: parseInt(r.count),
      })),
      indexation_gap: indexationGap,
      canonical_conflicts: parseInt(canonicalConflictCount?.count) || 0,
      top_issues: topIssues,
      cwv_failing_groups: cwvGroups.map((r) => ({
        template_type: r.template_type || 'unknown',
        count: parseInt(r.count),
      })),
    };
  }
}

module.exports = new UrlIntelligence();
