const db = require('../../models/db');
const logger = require('../logger');
const SitemapManager = require('./sitemap-manager');
const { normalizeUrl, extractDomain, urlLookupVariants, NETWORK_DOMAINS } = require('../../utils/normalize-url');

function supportedSeoDomain(domain) {
  const normalizedDomain = (extractDomain(domain) || 'wavespestcontrol.com').replace(/^www\./i, '');
  if (!NETWORK_DOMAINS.includes(normalizedDomain)) {
    throw new Error(`Unsupported SEO domain: ${normalizedDomain}`);
  }
  return normalizedDomain;
}

class SitemapValidator {
  async validateDomain(domain) {
    const normalizedDomain = supportedSeoDomain(domain);
    const sitemapUrl = `https://${normalizedDomain}/sitemap.xml`;

    let rawUrls;
    try {
      rawUrls = await SitemapManager.listUrls({ sitemapUrl });
    } catch (err) {
      logger.warn(`[SitemapValidator] Failed to fetch sitemap for ${normalizedDomain}: ${err.message}`);
      return { domain: normalizedDomain, error: err.message, issues_found: 0 };
    }

    if (!rawUrls || rawUrls.length === 0) {
      return { domain: normalizedDomain, error: 'Empty sitemap', issues_found: 0 };
    }

    const issues = [];
    const seenNormalized = new Map();
    const sitemapUrlSet = new Set();

    for (const url of rawUrls) {
      const normalized = normalizeUrl(url);
      if (!normalized) continue;
      sitemapUrlSet.add(normalized);

      // Duplicate check
      if (seenNormalized.has(normalized)) {
        issues.push({
          domain: normalizedDomain,
          sitemap_url: sitemapUrl,
          page_url: normalized,
          issue_type: 'duplicate_in_sitemap',
          severity: 'warning',
          detail: `Duplicate of ${seenNormalized.get(normalized)} (same normalized URL)`,
        });
        continue;
      }
      seenNormalized.set(normalized, url);

      // Check against intelligence + audit data
      const intel = await db('seo_url_intelligence').where('url', normalized).first();
      const audit = intel
        ? null
        : await db('seo_page_audits').where('url', normalized).orderBy('audit_date', 'desc').first();

      const statusCode = intel?.status_code || audit?.status_code;
      const robotsDirective = intel?.robots_directive || audit?.robots_meta || '';
      const canonicalMatch = intel?.canonical_match ?? (audit ? !audit.canonical_mismatch : null);

      if (statusCode >= 300 && statusCode < 400) {
        issues.push({
          domain: normalizedDomain,
          sitemap_url: sitemapUrl,
          page_url: normalized,
          issue_type: 'redirect_in_sitemap',
          severity: 'critical',
          detail: `Returns ${statusCode} redirect${intel?.redirect_target ? ` → ${intel.redirect_target}` : ''}`,
        });
      }

      if (statusCode >= 400 && statusCode < 500) {
        issues.push({
          domain: normalizedDomain,
          sitemap_url: sitemapUrl,
          page_url: normalized,
          issue_type: '4xx_in_sitemap',
          severity: 'critical',
          detail: `Returns ${statusCode}`,
        });
      }

      if (statusCode >= 500) {
        issues.push({
          domain: normalizedDomain,
          sitemap_url: sitemapUrl,
          page_url: normalized,
          issue_type: '5xx_in_sitemap',
          severity: 'critical',
          detail: `Returns ${statusCode} server error`,
        });
      }

      if (/noindex/i.test(robotsDirective)) {
        issues.push({
          domain: normalizedDomain,
          sitemap_url: sitemapUrl,
          page_url: normalized,
          issue_type: 'noindex_in_sitemap',
          severity: 'critical',
          detail: `Has noindex directive: ${robotsDirective}`,
        });
      }

      if (canonicalMatch === false) {
        issues.push({
          domain: normalizedDomain,
          sitemap_url: sitemapUrl,
          page_url: normalized,
          issue_type: 'canonical_mismatch_in_sitemap',
          severity: 'warning',
          detail: intel?.google_selected_canonical
            ? `Google selected: ${intel.google_selected_canonical}`
            : 'Canonical does not match URL',
        });
      }
    }

    await this.syncSitemapPresence(normalizedDomain, sitemapUrlSet);

    // Upsert issues
    for (const issue of issues) {
      await db('seo_sitemap_issues')
        .insert({ ...issue, last_checked_at: db.fn.now() })
        .onConflict(['domain', 'page_url', 'issue_type'])
        .merge({ detail: issue.detail, severity: issue.severity, last_checked_at: db.fn.now(), status: 'open' });
    }

    // Auto-resolve issues no longer present
    const currentIssueKeys = new Set(issues.map((i) => `${i.page_url}::${i.issue_type}`));
    const existingOpen = await db('seo_sitemap_issues')
      .where('domain', normalizedDomain)
      .where('status', 'open');

    for (const existing of existingOpen) {
      const key = `${existing.page_url}::${existing.issue_type}`;
      if (!currentIssueKeys.has(key)) {
        await db('seo_sitemap_issues')
          .where('id', existing.id)
          .update({ status: 'resolved', resolved_at: db.fn.now() });
      }
    }

    logger.info(`[SitemapValidator] ${normalizedDomain}: ${rawUrls.length} URLs checked, ${issues.length} issues found`);
    return { domain: normalizedDomain, urls_checked: rawUrls.length, issues_found: issues.length };
  }

  async syncSitemapPresence(domain, sitemapUrlSet) {
    const urls = [...sitemapUrlSet].filter(Boolean);
    const urlVariants = [...new Set(urls.flatMap(urlLookupVariants))];
    const now = new Date();

    if (urls.length > 0) {
      await db('content_index_status')
        .where('url', 'like', `%${domain}%`)
        .whereIn('url', urlVariants)
        .update({ sitemap_checked_at: now, in_sitemap: true, updated_at: now });

      await db('content_index_status')
        .where('url', 'like', `%${domain}%`)
        .whereNotIn('url', urlVariants)
        .update({ sitemap_checked_at: now, in_sitemap: false, updated_at: now });

      await db('seo_url_intelligence')
        .where('domain', domain)
        .whereIn('url', urls)
        .update({ in_sitemap: true, last_refreshed_at: now, updated_at: now });

      await db('seo_url_intelligence')
        .where('domain', domain)
        .whereNotIn('url', urls)
        .update({ in_sitemap: false, last_refreshed_at: now, updated_at: now });
    } else {
      await db('content_index_status')
        .where('url', 'like', `%${domain}%`)
        .update({ sitemap_checked_at: now, in_sitemap: false, updated_at: now });

      await db('seo_url_intelligence')
        .where('domain', domain)
        .update({ in_sitemap: false, last_refreshed_at: now, updated_at: now });
    }

    return { domain, urls_marked_in_sitemap: urls.length };
  }

  async validateAllDomains() {
    const results = [];
    for (const domain of NETWORK_DOMAINS) {
      try {
        const result = await this.validateDomain(domain);
        results.push(result);
      } catch (err) {
        logger.warn(`[SitemapValidator] ${domain} failed: ${err.message}`);
        results.push({ domain, error: err.message });
      }
    }
    return results;
  }

  async getSummary(domain) {
    const d = domain ? extractDomain(domain) : null;
    let base = db('seo_sitemap_issues').where('status', 'open');
    if (d) base = base.where('domain', d);

    const byType = await base.clone()
      .select('issue_type')
      .count('id as count')
      .groupBy('issue_type')
      .orderBy('count', 'desc');

    const bySeverity = await base.clone()
      .select('severity')
      .count('id as count')
      .groupBy('severity');

    const totalRow = await base.clone().count('id as count').first();

    return {
      domain: d || 'all',
      total_issues: parseInt(totalRow?.count) || 0,
      by_type: byType.map((r) => ({ type: r.issue_type, count: parseInt(r.count) })),
      by_severity: bySeverity.map((r) => ({ severity: r.severity, count: parseInt(r.count) })),
    };
  }

  async getIssues(domain, { issueType, status, limit = 50, offset = 0 } = {}) {
    let query = db('seo_sitemap_issues').orderBy('created_at', 'desc').limit(limit).offset(offset);
    if (domain) query = query.where('domain', extractDomain(domain));
    if (issueType) query = query.where('issue_type', issueType);
    if (status) query = query.where('status', status);
    else query = query.where('status', 'open');
    return query;
  }
}

module.exports = new SitemapValidator();
module.exports._internals = { supportedSeoDomain };
